import { createHmac, timingSafeEqual } from 'node:crypto';
import express from 'express';

const COOKIE = 'saos_access';
const LIMIT_MS = 60_000;

export function publicAccess(env = process.env) {
  const password = env.SAOS_ACCESS_PASSWORD;
  if (!password) throw new Error('Public binding requires SAOS_ACCESS_PASSWORD.');
  const expected = createHmac('sha256', password).update('saos-access-session').digest('hex');
  const attempts = new Map();
  const router = express.Router();
  const allowedOrigin = env.FRONTEND_ORIGIN ? new URL(env.FRONTEND_ORIGIN).origin : null;
  const authenticated = req => {
    const value = (req.headers.cookie || '').split(';').map(part => part.trim())
      .find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || '';
    return /^[a-f0-9]{64}$/.test(value) && timingSafeEqual(Buffer.from(value), Buffer.from(expected));
  };
  const allowed = req => {
    const origin = req.get('Origin');
    if (!origin) return true;
    const own = `${req.get('X-Forwarded-Proto') || req.protocol}://${req.get('Host')}`;
    return origin === allowedOrigin || origin === own;
  };

  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/api/auth/session', (req, res) => res.json({ enabled: true, authenticated: authenticated(req) }));
  router.post('/api/auth/login', express.json({ limit: '2kb' }), (req, res) => {
    if (!allowed(req)) return res.status(403).json({ message: 'Origin not allowed.' });
    const key = req.ip;
    const now = Date.now();
    const prior = attempts.get(key);
    const entry = prior?.until > now ? prior : { count: 0, until: now + LIMIT_MS };
    if (entry.count >= 5) return res.status(429).json({ message: 'Too many attempts. Try again in a minute.' });
    const submitted = req.body?.password;
    const valid = typeof submitted === 'string' && submitted.length <= 1024 &&
      timingSafeEqual(createHmac('sha256', password).update(submitted).digest(),
        createHmac('sha256', password).update(password).digest());
    if (!valid) {
      entry.count += 1;
      attempts.set(key, entry);
      return res.status(401).json({ message: 'Incorrect password.' });
    }
    attempts.delete(key);
    res.cookie(COOKIE, expected, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 7 * 24 * 60 * 60 * 1000 });
    return res.json({ enabled: true, authenticated: true });
  });
  router.use('/api', (req, res, next) => {
    if (!allowed(req)) return res.status(403).json({ message: 'Origin not allowed.' });
    if (!authenticated(req)) return res.status(401).json({ message: 'Enter the deployment password.' });
    next();
  });
  return router;
}
