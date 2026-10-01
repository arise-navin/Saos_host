/**
 * Assemble what the installer ships: desktop/stage/payload/
 *
 *   client/                        the built UI (npm run build in client/)
 *   server/src, package*.json      the API
 *   server/node_modules            its dependencies, as installed here
 *   server/fluent-workspace/       the workspace's TRACKED files + its SDK deps
 *   docs/fluent-flow-cheatsheet.md read by the flow tools
 *   package.json                   the repo's (the Node range the workspace check reads)
 *   runtime/node(.exe)             the Node that runs the server and the SDK: THIS one,
 *                                  the one the dependencies above were installed with,
 *                                  so every native module matches its ABI
 *   payload.json                   what was built, from which commit, on which Node
 *
 * Build on the platform you are building for: the dependencies carry native
 * binaries for this OS and CPU (canvas, swc, rollup, keyring, libxmljs2…), so
 * a Windows payload is staged on Windows and a macOS one on a Mac.
 *
 * An ALLOW-LIST, not a copy-then-delete: server/data holds settings.json with
 * instance credentials and API keys, the database holds every chat, and none
 * of it may ever reach an installer. After copying, the payload is scanned and
 * the build stops if anything that looks like user data got in anyway.
 *
 * Run from desktop/: npm run stage
 */
import { execFileSync, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(DESKTOP, '..');
const OUT = path.join(DESKTOP, 'stage', 'payload');

const step = (msg) => console.log(`\n▸ ${msg}`);
const rel = (p) => path.relative(REPO, p).replace(/\\/g, '/');

function copyDir(from, to, { skip = () => false } = {}) {
  fs.cpSync(from, to, { recursive: true, filter: (src) => !skip(path.relative(from, src).replace(/\\/g, '/')) });
}

function git(args) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' });
}

/* ── the licence key the app checks against ── */

step('checking the licence public key is in place');
{
  /* Without it the installed app can accept no key at all and stays locked. */
  const { PUBLIC_KEY } = await import(pathToFileURL(path.join(REPO, 'server', 'src', 'licence', 'public-key.js')).href);
  let type = null;
  try { type = crypto.createPublicKey(PUBLIC_KEY).asymmetricKeyType; } catch { /* none */ }
  if (type !== 'ed25519') throw new Error('server/src/licence/public-key.js holds no Ed25519 public key — run `npm run licence -- keygen` in desktop/ first.');
}

/* ── build ── */

step(`clearing ${rel(OUT)}`);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

step('building the client (vite build)');
execSync('npm run build', { cwd: path.join(REPO, 'client'), stdio: 'inherit' });
copyDir(path.join(REPO, 'client', 'dist'), path.join(OUT, 'client'));

step('copying the server (src, package files, node_modules)');
const serverOut = path.join(OUT, 'server');
copyDir(path.join(REPO, 'server', 'src'), path.join(serverOut, 'src'));
for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(REPO, 'server', f), path.join(serverOut, f));
copyDir(path.join(REPO, 'server', 'node_modules'), path.join(serverOut, 'node_modules'), {
  skip: (p) => p === '.cache' || p.startsWith('.cache/'),
});

step('copying the Fluent workspace (tracked files only) and its SDK dependencies');
const wsIn = path.join(REPO, 'server', 'fluent-workspace');
const wsOut = path.join(serverOut, 'fluent-workspace');
const tracked = git(['ls-files', '-z', 'server/fluent-workspace']).split('\0').filter(Boolean);
for (const file of tracked) {
  const src = path.join(REPO, file);
  if (!fs.existsSync(src)) continue;          // deleted in the working tree
  const dest = path.join(wsOut, path.relative(wsIn, src));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}
if (!fs.existsSync(path.join(wsIn, 'node_modules', '@servicenow', 'sdk'))) {
  throw new Error('server/fluent-workspace/node_modules has no @servicenow/sdk — run npm install --prefix server/fluent-workspace first.');
}
copyDir(path.join(wsIn, 'node_modules'), path.join(wsOut, 'node_modules'));

step('copying docs and the repo package.json');
fs.mkdirSync(path.join(OUT, 'docs'), { recursive: true });
fs.copyFileSync(path.join(REPO, 'docs', 'fluent-flow-cheatsheet.md'), path.join(OUT, 'docs', 'fluent-flow-cheatsheet.md'));
fs.copyFileSync(path.join(REPO, 'package.json'), path.join(OUT, 'package.json'));

step(`bundling the Node runtime (${process.version} from ${process.execPath})`);
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  throw new Error(`Node ${process.version} is too old to ship — the server needs 22.5 or newer (node:sqlite). Build with a newer Node.`);
}
const runtimeOut = path.join(OUT, 'runtime');
fs.mkdirSync(runtimeOut, { recursive: true });
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
fs.copyFileSync(process.execPath, path.join(runtimeOut, nodeName));
if (process.platform !== 'win32') fs.chmodSync(path.join(runtimeOut, nodeName), 0o755);
/* Node's licence travels with it. Where it sits depends on how Node was installed. */
const licence = [
  path.join(path.dirname(process.execPath), 'LICENSE'),
  path.join(path.dirname(process.execPath), '..', 'LICENSE'),
  path.join(path.dirname(process.execPath), '..', 'share', 'doc', 'node', 'LICENSE'),
].find((p) => fs.existsSync(p));
if (licence) fs.copyFileSync(licence, path.join(runtimeOut, 'LICENSE.node.txt'));
else fs.writeFileSync(path.join(runtimeOut, 'LICENSE.node.txt'), `Node.js ${process.version} — MIT licence: https://github.com/nodejs/node/blob/main/LICENSE\n`);

/* ── the user-data guard ── */

step('checking the payload holds no user data');
const FORBIDDEN = [
  /(^|\/)settings\.json$/i,
  /\.db(-wal|-shm)?$/i,
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)now\.config\.json$/i,          // instance-specific; generated per instance from the template
  /(^|\/)fluent-state\.json$/i,
  /(^|\/)flow-edit-journal\./i,
  /(^|\/)flow-backups\//i,
  /(^|\/)licence\.json$/i,              // a person's activated licence
  /\.pem$/i,                            // key files — the licence signing key above all
  /^server\/data(\/|$)/i,               // the whole data directory: never copied, and checked anyway
];
const offenders = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;   // third-party code, not ours
    const p = path.join(dir, e.name);
    const r = path.relative(OUT, p).replace(/\\/g, '/');
    if (e.isDirectory()) { if (FORBIDDEN.some((re) => re.test(`${r}/`))) offenders.push(r); else walk(p); continue; }
    if (FORBIDDEN.some((re) => re.test(r))) offenders.push(r);
  }
}(OUT));
/* The licence SIGNING key would let anyone make keys: no file of ours may carry one. */
(function scan(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'runtime') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { scan(p); continue; }
    if (fs.statSync(p).size > 8 * 1024 * 1024) continue;
    if (fs.readFileSync(p).includes('PRIVATE KEY-----')) offenders.push(`${path.relative(OUT, p).replace(/\\/g, '/')} (holds a private key)`);
  }
}(OUT));
if (offenders.length) {
  throw new Error(`the payload contains user data and must not be shipped:\n  ${offenders.join('\n  ')}`);
}

/* ── what was built ── */

const version = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8')).version;
const commit = git(['rev-parse', '--short', 'HEAD']).trim();
const dirty = git(['status', '--porcelain']).trim().length > 0;
let files = 0;
let bytes = 0;
const all = [];
(function count(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) count(p); else { files += 1; bytes += fs.statSync(p).size; all.push(path.relative(OUT, p).replace(/\\/g, '/')); }
  }
}(OUT));
/*
 * The LONGEST paths are the ones Windows drops first: an installer cannot
 * write a file whose full path reaches 260 characters, and it skips it without
 * failing (measured 2026-09-29 — 1,367 files lost installing into a deep
 * folder, the ServiceNow SDK among them). The app checks these exist at start.
 */
const longest = all.sort((a, b) => b.length - a.length).slice(0, 50);
fs.writeFileSync(path.join(OUT, 'payload.json'), JSON.stringify({
  version, commit, dirty, builtAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, node: process.version,
  files, longest,
}, null, 2));
step(`payload ready: ${files.toLocaleString()} files, ${(bytes / 1024 / 1024).toFixed(0)} MB, commit ${commit}${dirty ? ' (uncommitted changes)' : ''}`);
