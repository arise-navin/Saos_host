import { DatabaseSync } from 'node:sqlite';
import LibsqlDatabase from 'libsql';

export function adaptLibsqlDatabase(db) {
  return {
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
    prepare(sql) {
      const statement = db.prepare(sql);
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
  return adaptLibsqlDatabase(new LibsqlDatabase(url, { authToken }));
}
