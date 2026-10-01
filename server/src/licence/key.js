import crypto from 'node:crypto';

/*
 * SAOS LICENCE KEYS — what one is, and how it is read.
 *
 * A key is `SAOS1-<payload>.<signature>`, both base64url:
 *
 *   payload    JSON { v: 1, id, name, iat, exp, mid? }
 *                id    8 hex characters, for the issuer's records
 *                name  who it was issued to — shown in the app
 *                iat   issued at, unix seconds
 *                exp   ends at, unix seconds — the app locks at this moment
 *                mid   optional: the one computer it works on (machine.js)
 *   signature  Ed25519 over the payload bytes, made with the private signing
 *              key, which never leaves the issuer's computer. The app ships
 *              only the public half (public-key.js): it can check a key and
 *              cannot make one.
 *
 * Shared by the server (checking) and desktop/scripts/licence.mjs (issuing),
 * so the two can never disagree on the format.
 */

export const KEY_PREFIX = 'SAOS1-';

/** Line breaks and spaces a mail client or a chat window puts inside a pasted key are not part of it. */
export function normalizeKey(text) {
  return String(text ?? '').replace(/\s+/g, '');
}

export function signKey(payload, privateKey) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = crypto.sign(null, body, privateKey);
  return `${KEY_PREFIX}${body.toString('base64url')}.${signature.toString('base64url')}`;
}

/**
 * { ok: true, key, payload } — or { ok: false, reason } where reason is
 * 'format' (not a SAOS key at all) or 'signature' (changed, or not made with
 * our signing key).
 */
export function readKey(text, publicKey) {
  const key = normalizeKey(text);
  if (!key.startsWith(KEY_PREFIX)) return { ok: false, reason: 'format' };
  const parts = key.slice(KEY_PREFIX.length).split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'format' };
  const body = Buffer.from(parts[0], 'base64url');
  const signature = Buffer.from(parts[1], 'base64url');
  let valid = false;
  try { valid = Boolean(publicKey) && crypto.verify(null, body, publicKey, signature); } catch { valid = false; }
  if (!valid) return { ok: false, reason: 'signature' };
  let payload;
  try { payload = JSON.parse(body.toString('utf8')); } catch { return { ok: false, reason: 'format' }; }
  if (payload?.v !== 1 || typeof payload.name !== 'string'
    || !Number.isFinite(payload.iat) || !Number.isFinite(payload.exp) || payload.exp <= payload.iat) {
    return { ok: false, reason: 'format' };
  }
  return { ok: true, key, payload };
}
