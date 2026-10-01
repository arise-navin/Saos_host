import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataPath } from '../config/paths.js';
import { log } from '../logging.js';
import { probeInstanceTime } from '../servicenow/client.js';
import { readKey } from './key.js';
import { PUBLIC_KEY } from './public-key.js';
import { machineId as thisMachine, normalizeMachineId } from './machine.js';
import { trustedTime } from './clock.js';

/*
 * THE LICENCE — whether this copy of SAOS may be used right now.
 *
 * Only the installed desktop app needs one (desktop/main.js sets
 * SAOS_LICENCE=required). Run from the repository, nothing here is enforced.
 *
 * A licence is a signed key (key.js) with a fixed end time. Once that moment
 * passes, licenceGate() refuses every request except the licence's own and
 * the health probe, and sends the window to /licence to enter a new key.
 * Nothing the person made is touched: chats, settings and projects stay in the
 * data folder and are all there again under a new key.
 *
 * WHAT TIME IT IS. The latest of:
 *   - this computer's clock;
 *   - the real time, from the last ServiceNow reply (clock.js) — so turning
 *     the clock back does not help once the app has talked to the instance;
 *   - the latest time this app has ever seen (licence.json `highWater`), so it
 *     does not help across a restart either, before the instance answers.
 * While the ServiceNow time is fresh the stored mark is not needed and follows
 * it, down too — a clock that ran ahead once must not end a licence for good.
 *
 * This deters; it does not stop someone who edits the installed files. See
 * the job report (job-lic-1-trial-lock) for what it does and does not cover.
 */

const FRESH_MS = 15 * 60_000;       // a ServiceNow time this recent IS the time
const PROBE_EVERY_MS = 60_000;      // ask the instance at most this often when it is not
const PERSIST_STEP_MS = 60_000;     // write the high-water mark when it moves this far

export function licenceRequired(env = process.env) {
  return env.SAOS_LICENCE === 'required' || env.SAOS_DESKTOP === '1';
}

const when = (ms) => new Date(ms).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

const REFUSED = {
  format: 'That is not a SAOS licence key. Paste the whole key — it starts with SAOS1-.',
  signature: 'That key is not valid: it was changed, or it was not issued for SAOS.',
};

export function createLicence({
  file,
  publicKey,
  machineId = thisMachine,
  clock = Date.now,
  trusted = trustedTime,
  probe = null,
  required = licenceRequired,
  mono = () => performance.now(),
}) {
  let pub = null;
  try {
    pub = publicKey instanceof crypto.KeyObject && publicKey.type === 'public' ? publicKey : crypto.createPublicKey(publicKey);
  } catch { /* no key built in: every licence reads as invalid */ }
  let saved = load();
  let read = null;            // readKey() of saved.key, kept until the key changes
  let lastProbe = -Infinity;

  function load() {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) ?? {}; } catch { return {}; }
  }

  function save(next) {
    saved = next;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(saved, null, 2));
      fs.renameSync(`${file}.tmp`, file);
    } catch (err) {
      log.warn('licence', `could not save ${file}: ${err.message}`);
    }
  }

  function now() {
    const local = clock();
    const t = trusted();
    if (t && t.ageMs < FRESH_MS) return { ms: Math.max(local, t.now), source: 'servicenow', skewMs: local - t.now };
    return { ms: Math.max(local, t?.now ?? 0, saved.highWater ?? 0), source: 'computer', skewMs: null };
  }

  /** Ask the instance for the time, in the background, when the last answer is stale. */
  function refreshTime() {
    if (!probe || !required()) return;
    const t = trusted();
    if (t && t.ageMs < FRESH_MS) return;
    if (mono() - lastProbe < PROBE_EVERY_MS) return;
    lastProbe = mono();
    Promise.resolve().then(probe).catch(() => { /* offline, or no instance yet: the computer's time stands */ });
  }

  function current() {
    if (!saved.key) return null;
    if (read?.key !== saved.key) read = { key: saved.key, ...readKey(saved.key, pub) };
    return read;
  }

  function status() {
    refreshTime();
    const t = now();
    const base = { required: required(), machineId: machineId(), timeSource: t.source, clockSkewMs: t.skewMs };
    const r = current();
    if (!r) return { ...base, state: 'none' };
    if (!r.ok) return { ...base, state: 'invalid', reason: r.reason };
    const p = r.payload;
    const info = {
      name: p.name,
      keyId: p.id ?? null,
      issuedAt: new Date(p.iat * 1000).toISOString(),
      expiresAt: new Date(p.exp * 1000).toISOString(),
      boundTo: p.mid ? normalizeMachineId(p.mid) : null,
    };
    if (info.boundTo && info.boundTo !== base.machineId) return { ...base, ...info, state: 'wrong-machine' };
    /* Before the key was issued is not a time it can be: that clock is behind. */
    const at = Math.max(t.ms, p.iat * 1000);
    const mark = saved.highWater ?? 0;
    /* Written as it moves, and at once when the licence ends: an end already seen stays seen. */
    if (Math.abs(at - mark) >= PERSIST_STEP_MS || (at >= p.exp * 1000 && mark < p.exp * 1000)) save({ ...saved, highWater: at });
    const remainingMs = p.exp * 1000 - at;
    return { ...base, ...info, state: remainingMs > 0 ? 'active' : 'expired', remainingMs: Math.max(0, remainingMs) };
  }

  /** Check a pasted key and, if it works here and now, keep it (replacing any earlier one). */
  function activate(text) {
    const r = readKey(text, pub);
    if (!r.ok) return { ok: false, message: REFUSED[r.reason] };
    const p = r.payload;
    const bound = p.mid ? normalizeMachineId(p.mid) : null;
    if (bound && bound !== machineId()) {
      return { ok: false, message: `That key is for another computer (ID ${bound}). This computer's ID is ${machineId()} — ask for a key for it.` };
    }
    const at = Math.max(now().ms, p.iat * 1000);
    if (p.exp * 1000 <= at) return { ok: false, message: `That key already ended, on ${when(p.exp * 1000)}. Ask for a new one.` };
    save({ ...saved, key: r.key, activatedAt: new Date(clock()).toISOString(), highWater: Math.max(saved.highWater ?? 0, at) });
    log.info('licence', `key ${p.id ?? '?'} for "${p.name}" activated — ends ${new Date(p.exp * 1000).toISOString()}`);
    return { ok: true, status: status() };
  }

  return { status, activate };
}

/** One line for a refused request, and for the log. */
export function lockedMessage(s) {
  switch (s.state) {
    case 'none': return 'SAOS needs a licence key. Open Help → Licence to enter one.';
    case 'expired': return `Your SAOS licence ended on ${when(Date.parse(s.expiresAt))}. Open Help → Licence to enter a new key.`;
    case 'wrong-machine': return `This SAOS licence key is for another computer. Open Help → Licence to enter one for this computer (${s.machineId}).`;
    default: return 'The saved SAOS licence key is not valid. Open Help → Licence to enter it again.';
  }
}

export const licence = createLicence({
  file: dataPath('licence.json'),
  publicKey: PUBLIC_KEY,
  probe: probeInstanceTime,
});

/* What stays reachable while locked: the licence itself, and the probe the window and the desktop app poll. */
const OPEN = [/^\/api\/licence(\/|$)/, /^\/licence\/?$/, /^\/api\/system\/health(\/|$)/];

export function licenceGate({ store = licence, required = licenceRequired } = {}) {
  return (req, res, next) => {
    if (!required()) return next();
    if (OPEN.some((re) => re.test(req.path))) return next();
    const s = store.status();
    if (s.state === 'active') return next();
    if (!/^\/api(\/|$)/.test(req.path) && (req.method === 'GET' || req.method === 'HEAD')) return res.redirect(302, '/licence');
    return res.status(403).json({ code: 'licence', state: s.state, message: lockedMessage(s) });
  };
}
