import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { publicAccess } from '../src/publicAccess.js';

test('public access requires a password and protects API routes', async () => {
  assert.throws(() => publicAccess({}), /SAOS_ACCESS_PASSWORD/);
  const app = express();
  app.use(publicAccess({ SAOS_ACCESS_PASSWORD: 'test-secret', FRONTEND_ORIGIN: 'https://example.com' }));
  app.get('/api/private', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const denied = await fetch(`${base}/api/private`);
    assert.equal(denied.status, 401);
    const wrong = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    assert.equal(wrong.status, 401);
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
      body: JSON.stringify({ password: 'test-secret' }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${base}/api/private`, { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(`${base}/api/private`, { headers: { Cookie: cookie, Origin: 'https://other.com' } })).status, 403);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
