import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import LibsqlDatabase from 'libsql';
import { authenticateAccount, instanceOrigin } from '../src/accounts/identity.js';
import { accountStore } from '../src/accounts/store.js';
import { adaptLibsqlDatabase } from '../src/memory/connection.js';
import { migrate, scopeAccountDatabase, _setDbForTests } from '../src/memory/db.js';
import { seedLedger } from '../src/memory/facts.js';

process.env.SAOS_ACCOUNTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'saos-accounts-'));

test('first login saves credentials without contacting ServiceNow; later login checks the saved password', () => {
  const body = { instanceUrl: 'https://dev123.service-now.com/', username: 'navin', password: 'correct-password' };
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('ServiceNow must not be contacted at login'); };
  try {
    const user = authenticateAccount(body);
    assert.match(user.id, /^[a-f0-9]{64}$/);
    assert.equal(authenticateAccount(body).id, user.id);
    assert.equal(authenticateAccount({ ...body, username: 'NAVIN' }).id, user.id);
    assert.throws(() => authenticateAccount({ ...body, password: 'wrong' }), /Incorrect/);
    assert.notEqual(authenticateAccount({ ...body, instanceUrl: 'https://dev456.service-now.com' }).id, user.id);
    const stored = accountStore().prepare('SELECT digest FROM saos_account_passwords WHERE account = ?').get(user.id);
    assert.notEqual(stored.digest, body.password);
  } finally { globalThis.fetch = original; }
  for (const url of ['http://dev123.service-now.com', 'https://localhost', 'https://dev123.service-now.com.evil.com', 'https://user:pass@dev123.service-now.com', 'https://dev123.service-now.com:444', 'https://dev123.service-now.com/path']) {
    assert.throws(() => instanceOrigin(url));
  }
});

test('two accounts share a database without sharing schema versions, chats, search, or profile data', () => {
  const raw = new LibsqlDatabase(':memory:');
  const make = id => scopeAccountDatabase(adaptLibsqlDatabase(raw, { remote: true, namespace: id }), id);
  const alice = make('a'.repeat(64));
  const bob = make('b'.repeat(64));
  try {
    migrate(alice);
    assert.equal(bob.prepare('PRAGMA user_version').get().user_version, 0);
    migrate(bob);
    alice.prepare('INSERT INTO sessions(id, title, created, updated) VALUES (?, ?, ?, ?)').run('same-id', 'Alice private', 'now', 'now');
    bob.prepare('INSERT INTO sessions(id, title, created, updated) VALUES (?, ?, ?, ?)').run('same-id', 'Bob private', 'now', 'now');
    assert.equal(alice.prepare('SELECT title FROM sessions WHERE id = ?').get('same-id').title, 'Alice private');
    assert.equal(bob.prepare('SELECT title FROM sessions WHERE id = ?').get('same-id').title, 'Bob private');
    alice.prepare('INSERT INTO chunks(id, kind, ref, session, text, ts) VALUES (?, ?, ?, ?, ?, ?)').run(1, 'message', '1', 'same-id', 'aliceprivate', 'now');
    assert.equal(alice.prepare("SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'aliceprivate'").get().n, 1);
    assert.equal(bob.prepare("SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'aliceprivate'").get().n, 0);
    alice.prepare('DELETE FROM chunks WHERE id = ?').run(1);
    assert.equal(alice.prepare("SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'aliceprivate'").get().n, 0);
    assert.ok(alice.prepare("SELECT name FROM sqlite_master WHERE name = ?").get('health_dimensions'));
    migrate(alice);
    assert.equal(bob.prepare('SELECT title FROM sessions').get().title, 'Bob private');
  } finally { raw.close(); }
});

test('seed facts use one batch and preserve confidence and provenance on repeated initialization', () => {
  const raw = new LibsqlDatabase(':memory:');
  const db = migrate(adaptLibsqlDatabase(raw));
  _setDbForTests(db);
  try {
    const first = seedLedger({ instance: 'https://dev123.service-now.com' });
    const fact = db.prepare('SELECT * FROM facts LIMIT 1').get();
    db.prepare('UPDATE facts SET confidence = ?, provenance = ? WHERE id = ?').run(0.98, 'Existing evidence', fact.id);
    seedLedger({ instance: 'https://dev123.service-now.com' });
    assert.equal(db.prepare('SELECT count(*) AS n FROM facts').get().n, first.seeded);
    const updated = db.prepare('SELECT * FROM facts WHERE id = ?').get(fact.id);
    assert.equal(updated.confidence, 0.99);
    assert.equal(updated.provenance, 'Existing evidence');
    assert.equal(updated.value, fact.value);
  } finally { _setDbForTests(null); raw.close(); }
});

test('API requires an authenticated cookie, creates blank user setup, remembers identities, and revokes logout', async () => {
  process.env.SAOS_MULTI_USER = 'true';
  const { accountGateway, stopAccountWorkers } = await import('../src/accounts/gateway.js');
  const { readAccount } = await import('../src/accounts/store.js');
  const app = express();
  app.use(accountGateway());
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, cookie) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify({ instanceUrl: 'https://dev123.service-now.com', ...body }) });
  try {
    assert.equal((await fetch(base + '/api/onboarding')).status, 401);
    const alice = await post('/api/auth/login', { username: 'alice', password: 'valid' });
    assert.equal(alice.status, 200);
    assert.equal((await post('/api/auth/login', { username: 'alice', password: 'bad' })).status, 401);
    const cookie = alice.headers.get('set-cookie').split(';')[0];
    assert.match(alice.headers.get('set-cookie'), /HttpOnly/i);
    assert.match(alice.headers.get('set-cookie'), /SameSite=Lax/i);
    const session = await (await fetch(base + '/api/auth/session', { headers: { Cookie: cookie } })).json();
    assert.equal(session.user.username, 'alice');
    assert.equal(JSON.parse(readAccount(session.user.id).settings).profile.name, '');
    const get = (route, authCookie) => fetch(base + route, { headers: { Cookie: authCookie } });
    const setup = await (await get('/api/onboarding', cookie)).json();
    assert.equal(setup.required, true);
    assert.equal(setup.settings.profile.name, '');
    assert.equal(setup.settings.connection.username, 'alice');
    assert.equal(fs.existsSync(path.join(process.env.SAOS_ACCOUNTS_DIR, 'users', session.user.id, 'nowhelpassist.db')), false);
    await post('/api/onboarding/profile', { name: 'Alice' }, cookie);
    assert.equal((await (await post('/api/onboarding/complete', { name: 'Alice' }, cookie)).json()).required, false);
    await post('/api/agent/sessions', { id: 'private-chat', title: 'Alice only' }, cookie);
    const bobResponse = await post('/api/auth/login', { username: 'bob', password: 'valid' });
    const bobCookie = bobResponse.headers.get('set-cookie').split(';')[0];
    const bob = await bobResponse.json();
    assert.notEqual(bob.user.id, session.user.id);
    assert.equal(JSON.parse(readAccount(bob.user.id).settings).profile.name, '');
    const bobSetup = await (await get('/api/onboarding', bobCookie)).json();
    assert.equal(bobSetup.settings.profile.name, '');
    assert.equal(bobSetup.required, true);
    assert.equal(bobSetup.settings.connection.username, 'bob');
    assert.deepEqual(await (await get('/api/agent/sessions', bobCookie)).json(), []);
    assert.equal((await get('/api/agent/sessions/private-chat', bobCookie)).status, 404);
    assert.equal((await (await get('/api/onboarding', cookie)).json()).settings.profile.name, 'Alice');
    const again = await (await post('/api/auth/login', { username: 'alice', password: 'valid' })).json();
    assert.equal(again.user.id, session.user.id);
    assert.equal(JSON.parse(readAccount(again.user.id).settings).profile.name, 'Alice');
    assert.equal((await (await get('/api/onboarding', cookie)).json()).required, false);
    await post('/api/auth/logout', {}, cookie);
    assert.equal((await (await fetch(base + '/api/auth/session', { headers: { Cookie: cookie } })).json()).user, null);
    assert.equal((await fetch(base + '/api/system/settings', { headers: { Cookie: cookie } })).status, 401);
    const blocked = await fetch(base + '/api/auth/session', { headers: { Origin: 'https://untrusted.example' } });
    assert.equal(blocked.status, 403);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await stopAccountWorkers();
    delete process.env.SAOS_MULTI_USER;
  }
});
