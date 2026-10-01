import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSettings, saveSetup, settingsFileExists, publicSettings, DATA_DIR } from './store.js';
import { log } from '../logging.js';

/*
 * SETUP — does this install owe the person a first-run wizard, and why.
 *
 * Three ways to arrive here with setup owed, and the wizard says which:
 *
 *   first-run    nothing is configured: a fresh clone (settings.json is
 *                gitignored), or a wiped data folder
 *   new-machine  the data folder was copied from another computer: the
 *                record is complete, but it was completed somewhere else. The
 *                settings came along, so the wizard pre-fills and confirms
 *                them instead of starting from nothing
 *   reset        someone pressed "Re-run setup" in Settings
 *
 * An install configured BEFORE the wizard existed is not asked to set up
 * again. It has a connection or a model but no record, so it is adopted on
 * this machine the first time it is read, and a later move is still caught.
 */

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** The backend's version, from its own package.json. */
export const BACKEND_VERSION = readJson(path.join(SERVER_ROOT, 'package.json'))?.version || '0.0.0';

/** The Node range the repo declares, e.g. ">=22.5.0". */
const NODE_RANGE = readJson(path.join(REPO_ROOT, 'package.json'))?.engines?.node || '>=22.5.0';

/**
 * This computer, as a stable fingerprint. Hashed: the record only needs to
 * tell "same machine" from "different machine", not to name the user.
 */
export function thisMachine() {
  let user = '';
  try { user = os.userInfo().username; } catch { /* some sandboxes refuse it */ }
  const host = os.hostname();
  const id = crypto.createHash('sha256')
    .update([host, user, os.platform(), os.arch()].join('|'))
    .digest('hex')
    .slice(0, 16);
  return { id, host };
}

/** Anything a person would have typed in before the wizard existed. The provider default alone is not a choice. */
function hasConfiguration(s) {
  return Boolean(s.connection.instanceUrl || s.llm.apiKey || s.llm.baseUrl || s.llm.model);
}

/**
 * Pure decision, so the offline suite can assert it without a data folder.
 *
 * `begin` asks the caller to record that a first run has started, so what the
 * wizard saves along the way (a name, a model, a connection) is never mistaken
 * for a configuration made before the wizard existed.
 *
 * @returns {{ required: boolean, reason: 'first-run'|'new-machine'|'reset'|null, adopt: boolean, begin: boolean }}
 */
export function decideSetup({ onboarding, configured, machineId }) {
  if (!onboarding.completedAt) {
    if (onboarding.resetAt) return { required: true, reason: 'reset', adopt: false, begin: false };
    if (onboarding.startedAt) return { required: true, reason: 'first-run', adopt: false, begin: false };
    if (!configured) return { required: true, reason: 'first-run', adopt: false, begin: true };
    return { required: false, reason: null, adopt: true, begin: false };
  }
  if (onboarding.machineId && onboarding.machineId !== machineId) {
    return { required: true, reason: 'new-machine', adopt: false, begin: false };
  }
  return { required: false, reason: null, adopt: false, begin: false };
}

export function setupStatus() {
  const s = getSettings();
  const here = thisMachine();
  const decision = decideSetup({
    onboarding: s.onboarding,
    configured: settingsFileExists() && hasConfiguration(s),
    machineId: process.env.SAOS_USER_ID ? s.onboarding.machineId || here.id : here.id,
  });

  if (decision.adopt) {
    // Once: from here on a move to another machine is detectable.
    saveSetup({ onboarding: { completedAt: new Date().toISOString(), machineId: here.id, host: here.host, version: BACKEND_VERSION } });
    log.info('setup', `configured install adopted on ${here.host} — no wizard owed`);
  }
  if (decision.begin) {
    saveSetup({ onboarding: { startedAt: new Date().toISOString() } });
    log.info('setup', `first run on ${here.host} — setup wizard owed`);
  }

  const ob = getSettings().onboarding;
  return {
    userId: process.env.SAOS_USER_ID || null,
    required: decision.required,
    reason: decision.reason,
    version: BACKEND_VERSION,
    machine: { host: here.host, previousHost: decision.reason === 'new-machine' ? ob.host : null },
    completedAt: ob.completedAt,
    migration: ob.migration,
    settings: publicSettings(),
  };
}

export const NAME_MAX = 60;

/** A display name: trimmed, single-line, bounded. Empty is allowed — the name is optional. Null = refuse. */
export function cleanName(value) {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const name = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return name.length > NAME_MAX ? null : name;
}

export function saveProfileName(name) {
  saveSetup({ profile: { name } });
}

/** Finishing the wizard: this machine is now the one the record belongs to. */
export function completeSetup({ name } = {}) {
  const s = getSettings();
  const here = thisMachine();
  const moved = Boolean(s.onboarding.machineId && s.onboarding.machineId !== here.id);
  saveSetup({
    profile: typeof name === 'string' ? { name } : undefined,
    onboarding: {
      completedAt: new Date().toISOString(),
      machineId: here.id,
      host: here.host,
      version: BACKEND_VERSION,
      resetAt: null,
      migration: moved ? { fromHost: s.onboarding.host || 'another computer', at: new Date().toISOString() } : s.onboarding.migration,
    },
  });
  log.info('setup', moved ? `setup finished after a move from ${s.onboarding.host}` : 'setup finished');
  return setupStatus();
}

/** "Re-run setup". Nothing configured is cleared — the wizard pre-fills it. */
export function resetSetup() {
  saveSetup({ onboarding: { completedAt: null, resetAt: new Date().toISOString() } });
  return setupStatus();
}

/* ── the workspace checks ─────────────────────────────────────────────────── */

const parseVersion = (v) => String(v || '').replace(/^[^0-9]*/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);

/** a >= b, both "x.y.z". */
export function versionAtLeast(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return true;
}

/** Same major and minor: the interface and the backend ship together. */
export function sameRelease(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  return x[0] === y[0] && x[1] === y[1];
}

function storageWritable() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.accessSync(DATA_DIR, fs.constants.W_OK);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Fast, local, read-only: every check answers from this machine in
 * milliseconds. Nothing here reaches an instance or a model — those have their
 * own steps, each with its own test.
 *
 * `blocking` is the line between "SAOS cannot work" and "one feature waits".
 */
export async function workspaceChecks({ clientVersion = null, sdkEntry = null, db = null } = {}) {
  const checks = [];

  checks.push({
    id: 'backend',
    label: `SAOS backend ${BACKEND_VERSION}`,
    detail: `Local service · running on ${os.hostname()}`,
    state: 'ok',
    blocking: true,
  });

  const minNode = NODE_RANGE.replace(/^[^0-9]*/, '');
  const nodeOk = versionAtLeast(process.versions.node, minNode);
  checks.push({
    id: 'runtime',
    label: 'Node.js runtime',
    detail: nodeOk
      ? `v${process.versions.node} · ${minNode} or newer is required`
      : `v${process.versions.node} is too old — install Node ${minNode} or newer, then restart SAOS`,
    state: nodeOk ? 'ok' : 'fail',
    blocking: true,
  });

  const store = storageWritable();
  let dbOk = store.ok;
  let dbError = store.error;
  if (store.ok && db) {
    try { db().prepare('SELECT 1').get(); } catch (err) { dbOk = false; dbError = err.message; }
  }
  checks.push({
    id: 'storage',
    label: 'Local data store',
    detail: dbOk
      ? `Settings, chats and history stay on this machine (${process.env.SAOS_DATA_DIR ? DATA_DIR : 'server/data'})`
      : `${process.env.SAOS_DATA_DIR ? DATA_DIR : 'server/data'} is not usable: ${dbError}`,
    state: dbOk ? 'ok' : 'fail',
    blocking: true,
  });

  const entry = sdkEntry ? sdkEntry() : null;
  const sdkVersion = entry ? readJson(path.resolve(path.dirname(entry), '..', 'package.json'))?.version : null;
  checks.push({
    id: 'sdk',
    label: 'ServiceNow SDK',
    detail: entry
      ? `${sdkVersion ? `now-sdk ${sdkVersion}` : 'Installed'} · used for Fluent flow authoring`
      : 'Not installed yet — SAOS installs it the first time flow authoring needs it',
    state: entry ? 'ok' : 'warn',
    blocking: false,
  });

  if (clientVersion) {
    const compatible = sameRelease(clientVersion, BACKEND_VERSION);
    checks.push({
      id: 'compat',
      label: 'Version compatible',
      detail: compatible
        ? `Interface ${clientVersion} · backend ${BACKEND_VERSION}`
        : `Interface ${clientVersion} does not match backend ${BACKEND_VERSION} — reinstall both from the same copy`,
      state: compatible ? 'ok' : 'warn',
      blocking: false,
    });
  }

  return {
    checks,
    ready: checks.every((c) => !c.blocking || c.state === 'ok'),
    checkedAt: new Date().toISOString(),
  };
}
