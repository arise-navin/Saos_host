import test from 'node:test';
import assert from 'node:assert/strict';
import LibsqlDatabase from 'libsql';
import { openDatabase, adaptLibsqlDatabase } from '../src/memory/connection.js';
import { migrate, _setDbForTests } from '../src/memory/db.js';
import { createSession, getSession, deleteSession } from '../src/memory/sessions.js';

test('local storage remains available and incomplete Turso configuration fails', () => {
  const db = openDatabase(':memory:', {});
  try { assert.equal(db.prepare('SELECT 1 AS ok').get().ok, 1); }
  finally { db.close(); }
  assert.throws(() => openDatabase(':memory:', { TURSO_DATABASE_URL: 'libsql://db.turso.io' }), /both TURSO/);
  assert.throws(() => openDatabase(':memory:', { TURSO_AUTH_TOKEN: 'token' }), /both TURSO/);
  for (const url of ['http://db.turso.io', 'https://user:pass@db.turso.io', 'libsql://db.turso.io/path']) {
    assert.throws(() => openDatabase(':memory:', { TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: 'token' }), /database origin/);
  }
});

test('libSQL supports existing migrations, sessions, rollback, FTS and binary embeddings', () => {
  const db = adaptLibsqlDatabase(new LibsqlDatabase(':memory:'));
  try {
    migrate(db);
    const version = db.prepare('PRAGMA user_version').get().user_version;
    assert.ok(version > 0);
    migrate(db);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, version);
    _setDbForTests(db);
    const session = createSession({ title: 'Turso integration test' });
    assert.equal(getSession(session.id).title, 'Turso integration test');
    db.exec('BEGIN');
    db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('rolled back', session.id);
    db.exec('ROLLBACK');
    assert.equal(getSession(session.id).title, 'Turso integration test');
    db.exec('CREATE VIRTUAL TABLE test_search USING fts5(text)');
    db.prepare('INSERT INTO test_search(text) VALUES (?)').run('database integration');
    assert.equal(db.prepare("SELECT count(*) AS n FROM test_search WHERE test_search MATCH 'integration'").get().n, 1);
    db.exec('CREATE TABLE test_embeddings(value BLOB)');
    const blob = new Uint8Array(new Float32Array([0.25, 0.5]).buffer);
    db.prepare('INSERT INTO test_embeddings(value) VALUES (?)').run(blob);
    assert.deepEqual(new Uint8Array(db.prepare('SELECT value FROM test_embeddings').get().value), blob);
    deleteSession(session.id);
    assert.equal(getSession(session.id), null);
  } finally {
    _setDbForTests(null);
    db.close();
  }
});

test('remote schema versions persist and roll back without PRAGMA user_version', () => {
  const raw = new LibsqlDatabase(':memory:');
  const db = adaptLibsqlDatabase({
    exec(sql) {
      assert.doesNotMatch(sql, /PRAGMA\s+user_version/i);
      return raw.exec(sql);
    },
    prepare(sql) {
      assert.doesNotMatch(sql, /PRAGMA\s+user_version/i);
      return raw.prepare(sql);
    },
    close: () => raw.close(),
  }, { remote: true });
  try {
    migrate(db);
    const version = db.prepare('PRAGMA user_version').get().user_version;
    assert.ok(version > 0);
    migrate(db);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, version);
    db.exec('BEGIN');
    db.exec('PRAGMA user_version = 0;');
    db.exec('ROLLBACK');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, version);
  } finally {
    db.close();
  }
});
