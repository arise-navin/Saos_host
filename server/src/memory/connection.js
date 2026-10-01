import { DatabaseSync } from 'node:sqlite';
import LibsqlDatabase from 'libsql';

export function adaptLibsqlDatabase(db, { remote = false } = {}) {
  const versionTable = 'saos_schema_version';
  let inTransaction = false;
  if (remote) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${versionTable} (id INTEGER PRIMARY KEY CHECK (id = 1), user_version INTEGER NOT NULL)`);
    db.exec(`INSERT OR IGNORE INTO ${versionTable} (id, user_version) VALUES (1, 0)`);
  }
  return {
    exec(sql) {
      const version = remote && /^\s*PRAGMA\s+user_version\s*=\s*(\d+)\s*;?\s*$/i.exec(sql);
      if (version) return db.prepare(`UPDATE ${versionTable} SET user_version = ? WHERE id = 1`).run(Number(version[1]));
      const result = db.exec(sql);
      if (/^\s*BEGIN\b/i.test(sql)) inTransaction = true;
      if (/^\s*(COMMIT|ROLLBACK)\b/i.test(sql)) inTransaction = false;
      return result;
    },
    close: () => db.close(),
    prepare(sql) {
      if (remote && /^\s*PRAGMA\s+user_version\s*;?\s*$/i.test(sql)) {
        sql = `SELECT user_version FROM ${versionTable} WHERE id = 1`;
      }
      let statement;
      try { statement = db.prepare(sql); }
      catch (error) {
        if (!remote || inTransaction || !/^\s*SELECT\b/i.test(sql) || !/connection closed before message completed/i.test(error.message)) throw error;
        statement = db.prepare(sql);
      }
      const bind = (args) => args.map((value) => value instanceof Uint8Array ? Buffer.from(value) : value);
      return {
        run: (...args) => statement.run(bind(args)),
        get: (...args) => statement.get(bind(args)),
        all: (...args) => statement.all(bind(args)),
        iterate: (...args) => statement.iterate(bind(args)),
      };
    },
  };
}

export function openDatabase(file, env = process.env) {
  const url = env.TURSO_DATABASE_URL;
  const authToken = env.TURSO_AUTH_TOKEN;
  if (!url && !authToken) return new DatabaseSync(file);
  if (!url || !authToken) throw new Error('Set both TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.');
  const target = new URL(url);
  if (!['libsql:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash || !['', '/'].includes(target.pathname)) {
    throw new Error('TURSO_DATABASE_URL must be a libsql:// or https:// database origin.');
  }
  return adaptLibsqlDatabase(new LibsqlDatabase(url, { authToken }), { remote: true });
}
