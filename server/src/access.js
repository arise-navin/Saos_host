import { createHash, timingSafeEqual } from 'node:crypto';

export const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export function accessGuard(env = process.env) {
  const publicHost = !LOOPBACK.has(env.HOST || '127.0.0.1');
  const username = env.SAOS_AUTH_USER;
  const password = env.SAOS_AUTH_PASSWORD;
  if ((publicHost || username || password) && (!username || !password)) {
    throw new Error('Set SAOS_AUTH_USER and SAOS_AUTH_PASSWORD before exposing the backend.');
  }
  const digest = (value) => createHash('sha256').update(value).digest();
  const expected = username && password ? digest(`Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`) : null;
  let frontendOrigin;
  try { frontendOrigin = new URL(env.FRONTEND_ORIGIN).origin; } catch { frontendOrigin = null; }
  return (req, res, next) => {
    if (req.method === 'GET' && req.path === '/healthz') return res.json({ ok: true });
    if (!expected) return next();
    res.set('Cache-Control', 'no-store');
    const origin = req.get('Origin');
    if (origin && origin !== frontendOrigin) return res.status(403).json({ error: 'Origin not allowed', message: 'Origin not allowed. Set FRONTEND_ORIGIN on the backend to the browser site URL, then restart the backend.' });
    if (!timingSafeEqual(digest(req.get('Authorization') || ''), expected)) {
      res.set('WWW-Authenticate', 'Basic realm="SAOS", charset="UTF-8"');
      return res.status(401).json({ error: 'Authentication required' });
    }
    return next();
  };
}
