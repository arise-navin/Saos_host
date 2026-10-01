/**
 * SAOS LICENCE KEYS — make the signing key once, then issue keys with it.
 *
 * Run from desktop/:
 *
 *   npm run licence -- keygen
 *   npm run licence -- issue --name "Acme — Jane Doe" --hours 2
 *   npm run licence -- issue --name "Acme — Jane Doe" --days 7 --machine 1A2B-3C4D-5E6F-7A8B
 *   npm run licence -- issue --name "Acme — Jane Doe" --until 2026-10-07T17:00
 *   npm run licence -- show SAOS1-…
 *
 * A key ends at a FIXED moment: --hours / --days / --minutes count from when
 * it is issued, not from when it is first used. --machine ties it to one
 * computer (the ID its licence page shows); without it, any computer.
 *
 * The signing key is the whole secret: whoever has it can make keys. It lives
 * OUTSIDE the repository — SAOS_LICENCE_SIGNING_KEY, or
 * ~/.saos-licence/signing-key.pem — and never reaches an installer (stage.mjs
 * refuses a payload with a private key in it). Back it up. Lose it and a new
 * keygen means every installer already given out rejects the new keys (they
 * carry the old public half) until it is replaced with a new build.
 *
 * Every issued key is recorded in issued.csv beside the signing key.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LICENCE_SRC = path.join(REPO, 'server', 'src', 'licence');
const PUBLIC_KEY_FILE = path.join(LICENCE_SRC, 'public-key.js');
const SIGNING_KEY = path.resolve(process.env.SAOS_LICENCE_SIGNING_KEY || path.join(os.homedir(), '.saos-licence', 'signing-key.pem'));
const ISSUED_LOG = path.join(path.dirname(SIGNING_KEY), 'issued.csv');

const lib = (name) => import(pathToFileURL(path.join(LICENCE_SRC, name)).href);
const fail = (msg) => { console.error(`licence: ${msg}`); process.exit(1); };
const local = (ms) => new Date(ms).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });

function publicKeyModule(pem) {
  return `/*
 * The PUBLIC half of the SAOS licence signing key — written by
 * \`npm run licence -- keygen\` in desktop/ (desktop/scripts/licence.mjs).
 *
 * It can check a licence key and cannot make one. Replacing it means no key
 * issued before works in any installer built afterwards.
 */
export const PUBLIC_KEY = \`${pem.trim()}
\`;
`;
}

function keygen() {
  if (fs.existsSync(SIGNING_KEY)) {
    fail(`a signing key already exists at ${SIGNING_KEY}.\n`
      + 'Making a new one would stop every key issued with it from working in the next build. '
      + 'If that is really what you want, move that file away first.');
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(path.dirname(SIGNING_KEY), { recursive: true });
  fs.writeFileSync(SIGNING_KEY, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(PUBLIC_KEY_FILE, publicKeyModule(publicKey.export({ type: 'spki', format: 'pem' })));
  console.log(`Signing key (PRIVATE — back it up, never commit or share it):\n  ${SIGNING_KEY}`);
  console.log(`Public key written into the app:\n  ${path.relative(REPO, PUBLIC_KEY_FILE)}  — commit it; installers built from now on accept keys made with this signing key.`);
}

async function loadSigningKey() {
  let privateKey;
  try { privateKey = crypto.createPrivateKey(fs.readFileSync(SIGNING_KEY)); } catch (err) {
    fail(`no signing key at ${SIGNING_KEY} (${err.code || err.message}). Run: npm run licence -- keygen`);
  }
  const { PUBLIC_KEY } = await lib('public-key.js');
  const ours = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  let shipped = null;
  try { shipped = crypto.createPublicKey(PUBLIC_KEY).export({ type: 'spki', format: 'der' }); } catch { /* none */ }
  if (!shipped || !ours.equals(shipped)) {
    fail(`the signing key at ${SIGNING_KEY} does not match the public key in ${path.relative(REPO, PUBLIC_KEY_FILE)} — `
      + 'keys made with it would not work in the app. Use the signing key that keygen made for this repository.');
  }
  return privateKey;
}

function endTime(values, issuedMs) {
  const given = ['minutes', 'hours', 'days', 'until'].filter((k) => values[k] !== undefined);
  if (given.length !== 1) fail('say how long it lasts with exactly one of --hours, --days, --minutes or --until.');
  const [k] = given;
  if (k === 'until') {
    const ms = Date.parse(values.until);
    if (!Number.isFinite(ms)) fail(`--until "${values.until}" is not a date (e.g. 2026-10-07T17:00, read as this computer's local time).`);
    return ms;
  }
  const n = Number(values[k]);
  if (!(n > 0)) fail(`--${k} needs a number greater than 0.`);
  return issuedMs + n * { minutes: 60_000, hours: 3_600_000, days: 86_400_000 }[k];
}

async function issue(args) {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: 'string' },
      minutes: { type: 'string' },
      hours: { type: 'string' },
      days: { type: 'string' },
      until: { type: 'string' },
      machine: { type: 'string' },
    },
  });
  const name = (values.name ?? '').trim();
  if (!name) fail('--name is required: who the key is for (it is shown in their app).');
  const { normalizeMachineId } = await lib('machine.js');
  const machine = values.machine === undefined ? null : normalizeMachineId(values.machine);
  if (values.machine !== undefined && !machine) fail(`--machine "${values.machine}" is not a computer ID (16 hex characters, e.g. 1A2B-3C4D-5E6F-7A8B).`);
  const privateKey = await loadSigningKey();
  const issuedMs = Date.now();
  const endsMs = endTime(values, issuedMs);
  if (endsMs <= issuedMs + 60_000) fail(`that key would end at ${local(endsMs)}, which is not in the future.`);

  const { signKey, readKey } = await lib('key.js');
  const payload = {
    v: 1,
    id: crypto.randomBytes(4).toString('hex'),
    name,
    iat: Math.floor(issuedMs / 1000),
    exp: Math.floor(endsMs / 1000),
    ...(machine ? { mid: machine } : {}),
  };
  const key = signKey(payload, privateKey);
  if (!readKey(key, crypto.createPublicKey(privateKey)).ok) fail('the key did not verify after signing — nothing was issued.');

  const csv = (v) => `"${String(v).replace(/"/g, '""')}"`;
  if (!fs.existsSync(ISSUED_LOG)) fs.writeFileSync(ISSUED_LOG, 'issued_at,key_id,name,ends_at,machine\n');
  fs.appendFileSync(ISSUED_LOG, `${[new Date(issuedMs).toISOString(), payload.id, csv(name), new Date(endsMs).toISOString(), machine ?? 'any'].join(',')}\n`);

  console.log(`Licence key for ${name}`);
  console.log(`  ends       ${local(endsMs)}  (${new Date(endsMs).toISOString()})`);
  console.log(`  computer   ${machine ?? 'any'}`);
  console.log(`  key id     ${payload.id}   (recorded in ${ISSUED_LOG})`);
  console.log(`\n${key}\n`);
}

async function show(args) {
  const text = args.join('');
  if (!text) fail('paste the key after "show".');
  const { readKey } = await lib('key.js');
  const { PUBLIC_KEY } = await lib('public-key.js');
  const r = readKey(text, crypto.createPublicKey(PUBLIC_KEY));
  if (!r.ok) fail(r.reason === 'signature' ? 'not valid: changed, or not made with this repository\'s signing key.' : 'not a SAOS licence key.');
  const p = r.payload;
  const left = p.exp * 1000 - Date.now();
  console.log(`Valid key ${p.id ?? '?'} for ${p.name}`);
  console.log(`  issued     ${local(p.iat * 1000)}`);
  console.log(`  ends       ${local(p.exp * 1000)}  — ${left > 0 ? `${Math.round(left / 60_000)} min from now` : 'already ended'}`);
  console.log(`  computer   ${p.mid ?? 'any'}`);
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'keygen') keygen();
else if (command === 'issue') await issue(rest);
else if (command === 'show') await show(rest);
else {
  console.log('Usage (from desktop/):\n'
    + '  npm run licence -- keygen\n'
    + '  npm run licence -- issue --name "<who>" (--hours N | --days N | --minutes N | --until <date>) [--machine <computer ID>]\n'
    + '  npm run licence -- show <key>');
  process.exit(command ? 1 : 0);
}
