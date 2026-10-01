import { fork } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { DATA_DIR, SERVER_ROOT } from '../config/paths.js';
import { accountStore, readAccount } from './store.js';
import { authenticateAccount } from './identity.js';
import { clientApp } from '../client-app.js';

export const multiUser = !process.env.SAOS_USER_ID && process.env.SAOS_DESKTOP !== '1';
const COOKIE = 'saos_session';
const hash = value => createHash('sha256').update(value).digest('hex');
const lifetime = 7 * 24 * 60 * 60 * 1000;
const workers = new Map();
const attempts = new Map();

function token(req) {
  return (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || '';
}

function accountFor(req) {
  const value = token(req);
  if (!/^[a-f0-9]{64}$/.test(value)) return null;
  const session = accountStore().prepare('SELECT account FROM saos_login_sessions WHERE token = ? AND expires > ?').get(hash(value), Date.now());
  return session ? readAccount(session.account) : null;
}

function workerFor(id) {
  if (workers.has(id)) return workers.get(id).ready;
  const secret = randomBytes(32).toString('hex');
  const root = process.env.SAOS_ACCOUNTS_DIR || DATA_DIR;
  const workspaceRoot = path.join(root, 'users', id, 'workspaces');
  const workspace = path.join(workspaceRoot, 'fluent-workspace');
  fs.mkdirSync(path.join(workspace, 'src', 'fluent'), { recursive: true });
  for (const file of ['package.json', 'now.config.template.json', 'tsconfig.json']) {
    const target = path.join(workspace, file);
    const template = path.join(SERVER_ROOT, 'fluent-workspace', file);
    if (!fs.existsSync(target) && fs.existsSync(template)) fs.copyFileSync(template, target);
  }
  const env = {
    ...process.env, SAOS_USER_ID: id, SAOS_ACCOUNTS_DIR: root,
    SAOS_DATA_DIR: path.join(root, 'users', id),
    SAOS_WORKSPACES_DIR: workspaceRoot,
    HOST: '127.0.0.1', PORT: '0', SAOS_WORKER_SECRET: secret,
  };
  delete env.SAOS_CLIENT_DIR;
  for (const name of ['LLM_PROVIDER', 'OLLAMA_API_KEY', 'OLLAMA_BASE_URL', 'OLLAMA_MODEL']) delete env[name];
  const child = fork(path.join(SERVER_ROOT, 'src', 'index.js'), [], { env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const entry = { child, lastUsed: Date.now(), active: 0 };
  entry.ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Your workspace did not start. Please retry.')); }, 60000);
    child.once('message', message => {
      if (message?.port) {
        clearTimeout(timer);
        resolve({ ...entry, port: message.port, authorization: `Basic ${Buffer.from(`worker:${secret}`).toString('base64')}` });
      }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); workers.delete(id); reject(new Error('Your workspace stopped. Please retry.')); });
  });
  workers.set(id, entry);
  return entry.ready;
}

export async function stopAccountWorkers() {
  await Promise.all([...workers.values()].map(entry => new Promise(resolve => {
    entry.child.once('exit', resolve);
    entry.child.kill();
  })));
}

export function accountGateway() {
  const router = express.Router();
  if (!multiUser) {
    router.get('/api/auth/session', (_req, res) => res.json({ enabled: false }));
    return router;
  }
  const auth = express.json({ limit: '16kb' });
  router.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const origin = req.get('Origin');
    let allowed;
    try { allowed = new URL(process.env.FRONTEND_ORIGIN).origin; } catch {}
    const own = `${req.get('X-Forwarded-Proto') || req.protocol}://${req.get('Host')}`;
    if (origin && origin !== allowed && origin !== own) return res.status(403).json({ message: 'Origin not allowed.' });
    next();
  });
  router.get('/healthz', (_req, res) => res.json({ ok: true }));
  router.get('/api/auth/session', (req, res) => {
    const account = accountFor(req);
    res.json({ enabled: true, user: account ? { id: account.id, username: account.username, instanceUrl: account.instance } : null });
  });
  router.post('/api/auth/login', auth, async (req, res) => {
    const key = req.socket.remoteAddress;
    const now = Date.now();
    const rate = attempts.get(key);
    if (rate && rate.until > now && rate.count >= 10) return res.status(429).json({ message: 'Too many sign-in attempts. Try again in a minute.' });
    attempts.set(key, { until: rate?.until > now ? rate.until : now + 60000, count: rate?.until > now ? rate.count + 1 : 1 });
    try {
      const identity = authenticateAccount(req.body || {});
      const db = accountStore();
      const previous = readAccount(identity.id);
      const settings = previous ? JSON.parse(previous.settings) : { profile: { name: '' }, onboarding: { startedAt: new Date().toISOString() } };
      settings.connection = { instanceUrl: identity.instance, authType: 'basic', username: identity.username, password: req.body.password };
      const running = workers.get(identity.id);
      if (running && JSON.parse(previous.settings).connection?.password !== req.body.password) {
        if (running.active) return res.status(409).json({ message: 'This account is busy. Retry after its current request finishes.' });
        await new Promise(resolve => { running.child.once('exit', resolve); running.child.kill(); });
      }
      db.prepare('INSERT INTO saos_accounts(id, instance, username, settings) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET settings = excluded.settings, username = excluded.username')
        .run(identity.id, identity.instance, identity.username, JSON.stringify(settings));
      const value = randomBytes(32).toString('hex');
      db.prepare('DELETE FROM saos_login_sessions WHERE expires <= ?').run(now);
      db.prepare('INSERT INTO saos_login_sessions(token, account, expires) VALUES (?, ?, ?)').run(hash(value), identity.id, now + lifetime);
      res.cookie(COOKIE, value, { httpOnly: true, sameSite: 'lax', secure: req.secure || req.get('X-Forwarded-Proto') === 'https', maxAge: lifetime, path: '/' });
      return res.json({ user: { id: identity.id, username: identity.username, instanceUrl: identity.instance } });
    } catch (error) {
      return res.status(401).json({ message: error.message.startsWith('Incorrect ') || error.message.startsWith('Enter ') ? error.message : 'Sign-in failed. Please try again.' });
    }
  });
  router.post('/api/auth/logout', (req, res) => {
    accountStore().prepare('DELETE FROM saos_login_sessions WHERE token = ?').run(hash(token(req)));
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });
  router.use('/api', async (req, res) => {
    const account = accountFor(req);
    if (!account) return res.status(401).json({ message: 'Sign in with your ServiceNow account.' });
    let entry;
    try {
      const worker = await workerFor(account.id);
      entry = workers.get(account.id);
      entry.active += 1;
      entry.lastUsed = Date.now();
      const headers = { ...req.headers, authorization: worker.authorization, host: `127.0.0.1:${worker.port}` };
      delete headers.cookie;
      delete headers.origin;
      const upstream = http.request({ hostname: '127.0.0.1', port: worker.port, path: req.originalUrl, method: req.method, headers }, response => {
        res.writeHead(response.statusCode, { ...response.headers, 'cache-control': 'no-store' });
        response.pipe(res);
      });
      let released = false;
      const release = () => { if (!released) { released = true; entry.active -= 1; entry.lastUsed = Date.now(); } };
      res.once('close', () => { release(); upstream.destroy(); });
      upstream.once('error', () => {
        release();
        if (!res.headersSent) res.status(502).json({ message: 'Your workspace is unavailable. Please retry.' });
        else res.destroy();
      });
      req.pipe(upstream);
    } catch {
      if (!res.headersSent) res.status(503).json({ message: 'Your workspace could not start. Please retry.' });
    }
  });
  if (process.env.SAOS_CLIENT_DIR) router.use(clientApp(process.env.SAOS_CLIENT_DIR));
  const cleanup = setInterval(() => {
    for (const [key, rate] of attempts) if (rate.until <= Date.now()) attempts.delete(key);
    for (const entry of workers.values()) if (!entry.active && Date.now() - entry.lastUsed > 15 * 60000) entry.child.kill();
  }, 60000);
  cleanup.unref();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { for (const entry of workers.values()) entry.child.kill(); });
  return router;
}
