import test from 'node:test';
import assert from 'node:assert/strict';
import { accessGuard } from '../src/access.js';
import middleware from '../../client/middleware.js';

const env = { HOST: '0.0.0.0', SAOS_AUTH_USER: 'admin', SAOS_AUTH_PASSWORD: 'test-password', FRONTEND_ORIGIN: 'https://saos.example' };
const authorization = `Basic ${Buffer.from('admin:test-password').toString('base64')}`;

function request(guard, headers = {}, path = '/api/system/settings') {
  const result = { status: 200, headers: {}, allowed: false };
  const res = {
    set(key, value) { result.headers[key] = value; return this; },
    status(code) { result.status = code; return this; },
    json(body) { result.body = body; return this; },
  };
  guard({ method: 'GET', path, get: (key) => headers[key] }, res, () => { result.allowed = true; });
  return result;
}

test('public binding requires credentials; local development remains accessible', () => {
  assert.throws(() => accessGuard({ HOST: '0.0.0.0' }), /SAOS_AUTH_USER/);
  assert.throws(() => accessGuard({ SAOS_AUTH_USER: 'admin' }), /SAOS_AUTH_PASSWORD/);
  assert.equal(request(accessGuard({})).allowed, true);
});

test('backend protects API, rejects wrong credentials and disallowed origins', () => {
  const guard = accessGuard(env);
  assert.equal(request(guard).status, 401);
  assert.equal(request(guard, { Authorization: 'Basic wrong' }).status, 401);
  assert.equal(request(guard, { Authorization: authorization }).allowed, true);
  assert.equal(request(guard, { Authorization: authorization, Origin: env.FRONTEND_ORIGIN }).allowed, true);
  assert.equal(request(guard, { Authorization: authorization, Origin: 'https://other.example' }).status, 403);
  assert.deepEqual(request(guard, {}, '/healthz').body, { ok: true });
  assert.equal(request(guard, {}, '/api/system/health').status, 401);
});

test('Vercel challenges browser requests and fails closed without configured login', async () => {
  const previous = { user: process.env.SAOS_AUTH_USER, password: process.env.SAOS_AUTH_PASSWORD };
  try {
    delete process.env.SAOS_AUTH_USER;
    delete process.env.SAOS_AUTH_PASSWORD;
    assert.equal((await middleware(new Request('https://saos.example'))).status, 503);
    process.env.SAOS_AUTH_USER = env.SAOS_AUTH_USER;
    process.env.SAOS_AUTH_PASSWORD = env.SAOS_AUTH_PASSWORD;
    const denied = await middleware(new Request('https://saos.example'));
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get('www-authenticate'), /Basic/);
    const allowed = await middleware(new Request('https://saos.example/api/system/settings', { headers: { authorization } }));
    assert.equal(allowed.headers.get('x-middleware-next'), '1');
    assert.equal(allowed.headers.get('cache-control'), 'no-store');
  } finally {
    if (previous.user === undefined) delete process.env.SAOS_AUTH_USER;
    else process.env.SAOS_AUTH_USER = previous.user;
    if (previous.password === undefined) delete process.env.SAOS_AUTH_PASSWORD;
    else process.env.SAOS_AUTH_PASSWORD = previous.password;
  }
});
