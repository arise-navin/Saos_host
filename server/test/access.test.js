import test from 'node:test';
import assert from 'node:assert/strict';
import { accessGuard } from '../src/access.js';

const env = { HOST: '127.0.0.1', SAOS_USER_ID: 'a'.repeat(64), SAOS_WORKER_SECRET: 'test-password', FRONTEND_ORIGIN: 'https://saos.example' };
const authorization = `Basic ${Buffer.from('worker:test-password').toString('base64')}`;

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

test('workspace servers require loopback and a private secret; local desktop remains accessible', () => {
  assert.throws(() => accessGuard({ HOST: '0.0.0.0' }), /worker secret/);
  assert.throws(() => accessGuard({ SAOS_USER_ID: env.SAOS_USER_ID }), /worker secret/);
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

test('backend normalizes the configured frontend URL and explains origin rejection', () => {
  const guard = accessGuard({ ...env, FRONTEND_ORIGIN: 'https://saos.example/' });
  assert.equal(request(guard, { Authorization: authorization, Origin: env.FRONTEND_ORIGIN }).allowed, true);
  const denied = request(guard, { Authorization: authorization, Origin: 'https://other.example' });
  assert.equal(denied.status, 403);
  assert.match(denied.body.message, /FRONTEND_ORIGIN/);
  assert.equal(request(accessGuard({ ...env, FRONTEND_ORIGIN: undefined }), {
    Authorization: authorization, Origin: env.FRONTEND_ORIGIN,
  }).status, 403);
});

test('legacy shared frontend/backend credentials do not create a browser challenge', () => {
  const guard = accessGuard({ SAOS_AUTH_USER: 'admin', SAOS_AUTH_PASSWORD: 'admin' });
  assert.equal(request(guard).allowed, true);
  assert.equal(request(guard).headers['WWW-Authenticate'], undefined);
});
