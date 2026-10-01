'use strict';

/*
 * SAOS DESKTOP — the Electron shell around the app.
 *
 * It does four things and nothing else:
 *
 *   1. Keeps the user's files OUT of the program folder, which every upgrade
 *      and uninstall replaces: data (settings, the database, attachments…) in
 *      %APPDATA%\SAOS\data, and the Fluent workspaces the agent writes in
 *      %APPDATA%\SAOS\workspaces. The server is told both (SAOS_DATA_DIR,
 *      SAOS_WORKSPACES_DIR — server/src/config/paths.js).
 *   2. Starts the bundled server as a child process on the BUNDLED Node
 *      runtime (payload/runtime) — the exact Node its native modules were
 *      installed with. The ServiceNow SDK then runs on it too, because the
 *      server spawns process.execPath for it. Not Electron's own Node: measured
 *      2026-09-29, the SDK's command-line parser takes Electron-as-Node for a
 *      packaged Electron app and drops an argument ("Unknown command" on every
 *      build), and libxmljs2 was compiled for Node's ABI (137), not Electron's (149).
 *   3. Opens a window on that server's own origin once it answers. The server
 *      serves the built UI itself (SAOS_CLIENT_DIR), so /api stays same-origin.
 *   4. Stops the server when the app quits (asked over IPC, killed if it does
 *      not go), and restarts it if it dies underneath an open window.
 *   5. Keeps the window honest about the licence (SAOS_LICENCE=required): the
 *      server refuses everything once it has ended; this side moves the window
 *      to the licence page when that happens, warns ten minutes before, and
 *      shows the time left in the title bar in the last week.
 *
 * The server binds loopback only and is never reachable from another machine.
 */

const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { startingPage, failedPage } = require('./splash.js');

/* A fixed port keeps the origin stable, so per-browser preferences (theme,
   the setup step) survive a restart. Another free port only if it is taken. */
const PREFERRED_PORT = 47831;
const START_TIMEOUT_MS = 90_000;
const STOP_GRACE_MS = 4_000;
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LICENCE_CHECK_MS = 30_000;
const LICENCE_WARN_MS = 10 * 60_000;
const LICENCE_TITLE_MS = 7 * 24 * 3600_000;

const PAYLOAD = app.isPackaged
  ? path.join(process.resourcesPath, 'payload')
  : path.join(__dirname, 'stage', 'payload');
/* For trying a build without touching the real profile: SAOS_USER_DIR=<folder>. */
if (process.env.SAOS_USER_DIR) app.setPath('userData', path.resolve(process.env.SAOS_USER_DIR));
const USER_DIR = app.getPath('userData');            // %APPDATA%\SAOS · ~/Library/Application Support/SAOS
const IS_WIN = process.platform === 'win32';
const NODE = path.join(PAYLOAD, 'runtime', IS_WIN ? 'node.exe' : 'node');
const DATA_DIR = path.join(USER_DIR, 'data');
const WORKSPACES_DIR = path.join(USER_DIR, 'workspaces');
const LOG_DIR = path.join(USER_DIR, 'logs');
const SERVER_LOG = path.join(LOG_DIR, 'server.log');

let win = null;
let server = null;        // the child process
let port = null;
let quitting = false;
let licence = null;       // the server's last answer to GET /api/licence
let licenceTimer = null;
let warnedFor = null;     // the key the ten-minute warning was shown for
let pageTitle = 'SAOS';

/* ── files ────────────────────────────────────────────────────────────────── */

const stripLongPrefix = (p) => String(p).replace(/^\\\\\?\\/, '');

/**
 * The Fluent workspace lives with the user's files so an upgrade never loses
 * the sources the agent wrote. First run copies the shipped workspace (never
 * over anything already there); its 300 MB of SDK dependencies are NOT copied
 * but joined in with a directory junction to the installed copy, re-pointed on
 * every start in case the app was moved or upgraded.
 */
function prepareWorkspace() {
  const shipped = path.join(PAYLOAD, 'server', 'fluent-workspace');
  const target = path.join(WORKSPACES_DIR, 'fluent-workspace');
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(shipped, target, {
    recursive: true,
    force: false,
    errorOnExist: false,
    filter: (src) => path.relative(shipped, src).split(path.sep)[0] !== 'node_modules',
  });
  const real = path.join(shipped, 'node_modules');
  const link = path.join(target, 'node_modules');
  let stat = null;
  try { stat = fs.lstatSync(link); } catch { /* not there yet */ }
  if (stat && !stat.isSymbolicLink()) return;       // a real folder someone installed into: leave it
  if (stat) {
    let current = null;
    try { current = path.resolve(stripLongPrefix(fs.readlinkSync(link))); } catch { /* unreadable: replace */ }
    if (current && current.toLowerCase() === path.resolve(real).toLowerCase()) return;
    try { fs.unlinkSync(link); } catch { fs.rmdirSync(link); }
  }
  fs.symlinkSync(real, link, 'junction');
}

/** One log per run history, rotated when it grows past a few MB. */
function openLog() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  try {
    if (fs.statSync(SERVER_LOG).size > LOG_MAX_BYTES) fs.renameSync(SERVER_LOG, `${SERVER_LOG}.1`);
  } catch { /* no log yet */ }
  const fd = fs.openSync(SERVER_LOG, 'a');
  fs.writeSync(fd, `\n===== SAOS ${app.getVersion()} starting ${new Date().toISOString()} =====\n`);
  return fd;
}

/**
 * Is everything the installer was meant to write actually here? Windows skips
 * any file whose full path reaches 260 characters — silently — so an install in
 * a deep folder comes up looking fine and fails later, mid flow build (measured
 * 2026-09-29). The payload names its longest files; all of them must exist.
 */
function verifyPayload() {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(PAYLOAD, 'payload.json'), 'utf8')); } catch { return; }
  const missing = (manifest.longest || []).filter((rel) => !fs.existsSync(path.join(PAYLOAD, rel)));
  if (missing.length) {
    throw new Error(`SAOS is not fully installed: ${missing.length} of its longest files are missing. `
      + `Windows cannot write files whose full path is 260 characters or more, and "${app.getAppPath().replace(/[\\/]resources[\\/].*$/, '')}" `
      + 'is too deep a folder. Uninstall SAOS and install it again in its default folder.');
  }
}

/* ── the server ───────────────────────────────────────────────────────────── */

function portFree(p) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(p, '127.0.0.1');
  });
}

function anyFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port: p } = probe.address();
      probe.close(() => resolve(p));
    });
  });
}

function healthy(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: p, path: '/api/system/health', timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function startServer() {
  if (!fs.existsSync(NODE)) throw new Error(`The bundled Node runtime is missing (${NODE}). Reinstall SAOS.`);
  const logFd = openLog();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;               // a plain Node child; nothing Electron about it
  const child = spawn(NODE, [path.join(PAYLOAD, 'server', 'src', 'index.js')], {
    cwd: path.join(PAYLOAD, 'server'),
    env: {
      ...env,
      PORT: String(port),
      HOST: '127.0.0.1',
      SAOS_DATA_DIR: DATA_DIR,
      SAOS_WORKSPACES_DIR: WORKSPACES_DIR,
      SAOS_CLIENT_DIR: path.join(PAYLOAD, 'client'),
      SAOS_DESKTOP: '1',
      SAOS_LICENCE: 'required',
      NO_COLOR: '1',
    },
    stdio: ['ignore', logFd, logFd, 'ipc'],
    windowsHide: true,
  });
  fs.closeSync(logFd);
  child.on('exit', (code, signal) => {
    if (server === child) server = null;
    if (!quitting) onServerDied(code, signal);
  });
  return child;
}

async function waitUntilUp(child) {
  const until = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`The local service stopped while starting (exit code ${child.exitCode}).`);
    if (await healthy(port)) return;
    await new Promise((r) => { setTimeout(r, 300); });
  }
  throw new Error(`The local service did not answer within ${START_TIMEOUT_MS / 1000} seconds.`);
}

function stopServer() {
  const child = server;
  server = null;
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); resolve(); };
    child.once('exit', done);
    try { child.send('shutdown'); } catch { /* channel already closed */ }
    /* Did not go: end it and anything it started (the SDK) — on Windows /T is the tree. */
    const timer = setTimeout(() => {
      if (IS_WIN) execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => resolve());
      else { try { child.kill('SIGKILL'); } catch { /* already gone */ } resolve(); }
    }, STOP_GRACE_MS);
  });
}

async function launch() {
  try {
    verifyPayload();
    prepareWorkspace();
    port = (await portFree(PREFERRED_PORT)) ? PREFERRED_PORT : await anyFreePort();
    server = startServer();
    await waitUntilUp(server);
    if (win && !win.isDestroyed()) await win.loadURL(`http://127.0.0.1:${port}/`);
    checkLicence();
  } catch (err) {
    if (win && !win.isDestroyed()) win.loadURL(failedPage(err.message, SERVER_LOG));
  }
}

async function onServerDied(code) {
  if (!win || win.isDestroyed()) return;
  const { response } = await dialog.showMessageBox(win, {
    type: 'error',
    title: 'SAOS',
    message: 'The SAOS local service stopped unexpectedly.',
    detail: `Exit code ${code}. Nothing on your ServiceNow instance is affected by this.\n\nDetails: ${SERVER_LOG}`,
    buttons: ['Restart it', 'Quit SAOS'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) {
    win.loadURL(startingPage());
    launch();
  } else {
    app.quit();
  }
}

/* ── the licence ──────────────────────────────────────────────────────────── */

function getJson(pathname) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 5000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(body) : null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function timeLeft(ms) {
  const min = Math.max(1, Math.ceil(ms / 60_000));
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) return `${Math.floor(min / 60)} h ${min % 60} min`;
  return `${Math.floor(min / 1440)} days`;
}

function showTitle() {
  if (!win || win.isDestroyed()) return;
  const l = licence;
  const ending = l?.required && l.state === 'active' && l.remainingMs <= LICENCE_TITLE_MS;
  win.setTitle(ending ? `${pageTitle} — licence ends in ${timeLeft(l.remainingMs)}` : pageTitle);
}

const licencePage = () => `http://127.0.0.1:${port}/licence`;

/**
 * Ask the server where the licence stands: every 30 s, and exactly at its end.
 * Once it has ended, the window goes to the licence page (a chat still working
 * is stopped, as closing the window would). The server has already refused
 * every request since that moment; this only stops the window showing a dead app.
 */
async function checkLicence() {
  clearTimeout(licenceTimer);
  const status = port ? await getJson('/api/licence') : null;
  if (status) licence = status;
  if (status && win && !win.isDestroyed()) {
    const url = win.webContents.getURL();
    const inApp = url.startsWith(`http://127.0.0.1:${port}/`);
    if (status.required && status.state !== 'active' && inApp && new URL(url).pathname !== '/licence') {
      win.loadURL(licencePage());
    }
    if (status.required && status.state === 'active' && status.remainingMs <= LICENCE_WARN_MS && warnedFor !== status.keyId) {
      warnedFor = status.keyId;
      const at = new Date(Date.now() + status.remainingMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      dialog.showMessageBox(win, {
        type: 'warning',
        title: 'SAOS',
        message: `Your SAOS licence ends in ${timeLeft(status.remainingMs)}.`,
        detail: `At ${at} SAOS locks until a new key is entered (Help → Licence). Your chats, settings and projects are kept; a chat still working at that moment is stopped.`,
      }).catch(() => { /* the window went away under it */ });
    }
    showTitle();
  }
  const next = status?.state === 'active' ? Math.min(LICENCE_CHECK_MS, status.remainingMs + 1000) : LICENCE_CHECK_MS;
  licenceTimer = setTimeout(checkLicence, Math.max(1000, next));
}

/* ── the window ───────────────────────────────────────────────────────────── */

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 380,
    minHeight: 560,
    backgroundColor: '#0e1116',
    title: 'SAOS',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
  /* The page names itself; the licence adds the time left (showTitle). */
  win.on('page-title-updated', (event, title) => {
    event.preventDefault();
    pageTitle = title || 'SAOS';
    showTitle();
  });

  /* Links out of the app ("Get a key", docs) open in the person's browser. */
  const isApp = (url) => port && url.startsWith(`http://127.0.0.1:${port}/`);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !isApp(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isApp(url) || url.startsWith('data:')) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  win.loadURL(startingPage());
}

function buildMenu() {
  return Menu.buildFromTemplate([
    /* macOS: the app menu comes first (About, Hide, Quit ⌘Q). */
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open data folder', click: () => shell.openPath(USER_DIR) },
        { label: 'Open server log', click: () => shell.openPath(SERVER_LOG) },
        { type: 'separator' },
        { role: 'quit', label: 'Quit SAOS' },
      ],
    },
    /* Without an Edit menu, copy and paste shortcuts do nothing on macOS. */
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [{
        label: 'Licence…',
        click: () => { if (port && win && !win.isDestroyed()) win.loadURL(licencePage()); },
      }, {
        label: 'About SAOS',
        click: () => dialog.showMessageBox(win, {
          type: 'info',
          title: 'About SAOS',
          message: `SAOS ${app.getVersion()}`,
          detail: `Agentic ServiceNow studio.\n\n${licence?.expiresAt ? `Licensed to ${licence.name} until ${new Date(licence.expiresAt).toLocaleString()}` : 'No licence entered'}\nYour data: ${USER_DIR}\nLocal service: http://127.0.0.1:${port ?? '—'} (this computer only)\nWindow: Electron ${process.versions.electron}`,
        }),
      }],
    },
  ]);
}

/* ── lifecycle ────────────────────────────────────────────────────────────── */

if (!app.requestSingleInstanceLock()) {
  /* One SAOS per user: a second launch brings the open one forward instead
     of starting a second server against the same database. */
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  if (IS_WIN) app.setAppUserModelId('com.saos.studio');   // Windows notifications need it

  app.whenReady().then(() => {
    Menu.setApplicationMenu(buildMenu());
    createWindow();
    launch();
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', (event) => {
    clearTimeout(licenceTimer);
    if (quitting || !server) return;
    event.preventDefault();
    quitting = true;
    stopServer().finally(() => app.quit());
  });
}
