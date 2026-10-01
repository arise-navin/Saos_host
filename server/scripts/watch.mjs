/**
 * `npm run dev` for the API: restart when a file in server/src CHANGES, and on nothing else.
 *
 * WHY NOT `node --watch` — measured on this machine (Windows 11, Node 24.18, 2026-09-25):
 *
 *   `node --watch` restarts on ANY file-system event for a file the server has
 *   loaded. With NTFS last-access updates on (DisableLastAccess = 2, the Windows
 *   default), merely READING a file whose last access is over an hour old fires
 *   such an event. The flow tools load ts-morph and several modules lazily, so
 *   the first flow preview or edit in an hour restarted the server mid-request:
 *   T5, 2026-09-25 09:14:11 UTC, 21 s into "add a step to NowForge Edit Test…",
 *   before its approval card was ever shown. Reproduced in isolation: a process
 *   that require()s a module nobody had read for two hours, under --watch,
 *   printed "Restarting" the instant it loaded it. Reading the same file again a
 *   minute later fired nothing (NTFS persists last-access at most hourly), which
 *   is why the restarts looked random.
 *
 * WHAT THIS DOES INSTEAD
 *   - watches server/src only: never fluent-workspace, data/, node_modules, or
 *     the backups, journals and timings that flow work writes;
 *   - on any event, rescans src/ and restarts only if a file was added, removed,
 *     or changed size or modification time. A read or attribute event changes
 *     neither, so it is ignored.
 *
 * For flow work, use `npm start` in the repo root instead: no watcher at all.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(SERVER_ROOT, 'src');
const ENTRY = path.join(SRC, 'index.js');
const DEBOUNCE_MS = 250;

/** Size and modification time of every file under `dir`. */
export function scan(dir) {
  const out = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const st = fs.statSync(p);
        out.set(p, { size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  };
  walk(dir);
  return out;
}

/** Files whose CONTENT changed between two scans: added, removed, or a different size or mtime. */
export function contentChanges(before, after) {
  const changed = [];
  for (const [p, a] of after) {
    const b = before.get(p);
    if (!b || b.size !== a.size || b.mtimeMs !== a.mtimeMs) changed.push(p);
  }
  for (const p of before.keys()) if (!after.has(p)) changed.push(p);
  return changed;
}

function run() {
  const log = (m) => process.stdout.write(`[watch] ${m}\n`);
  let known = scan(SRC);
  let child = null;
  let timer = null;
  let restarting = false;

  const start = () => {
    const me = spawn(process.execPath, [ENTRY], { cwd: SERVER_ROOT, stdio: 'inherit', env: process.env });
    child = me;
    me.on('exit', (code, signal) => {
      if (me !== child || restarting) return;
      child = null;
      log(`the server exited (${signal ?? `code ${code}`}); it starts again on the next change in server/src.`);
    });
  };

  const restart = async (changed) => {
    restarting = true;
    log(`${changed.map((p) => path.relative(SERVER_ROOT, p)).join(', ')} changed — restarting the server`);
    const old = child;
    if (old && old.exitCode === null) {
      const gone = new Promise((r) => old.once('exit', r));
      old.kill();
      await gone;
    }
    restarting = false;
    start();
  };

  fs.watch(SRC, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      let now;
      try { now = scan(SRC); } catch { return; }
      const changed = contentChanges(known, now);
      known = now;
      if (changed.length) restart(changed);
    }, DEBOUNCE_MS);
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { if (child && child.exitCode === null) child.kill(); process.exit(0); });
  }
  log('watching server/src — the server restarts when a source file changes (reads are ignored)');
  start();
}

/* Run only as a script: the tests import scan() and contentChanges(). */
const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === self.toLowerCase()) run();
