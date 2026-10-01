import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../memory/connection.js';
import { DATA_DIR } from '../config/paths.js';

let db;
export function accountStore() {
  if (db) return db;
  const root = process.env.SAOS_ACCOUNTS_DIR || DATA_DIR;
  fs.mkdirSync(root, { recursive: true });
  db = openDatabase(path.join(root, 'accounts.db'), { ...process.env, SAOS_USER_ID: '' });
  db.exec(`CREATE TABLE IF NOT EXISTS saos_accounts (
    id TEXT PRIMARY KEY, instance TEXT NOT NULL, username TEXT NOT NULL, settings TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS saos_login_sessions (
    token TEXT PRIMARY KEY, account TEXT NOT NULL, expires INTEGER NOT NULL
  );`);
  return db;
}

export function readAccount(id) {
  return accountStore().prepare('SELECT * FROM saos_accounts WHERE id = ?').get(id);
}

export function saveAccountSettings(settings) {
  if (!process.env.SAOS_USER_ID) return;
  accountStore().prepare('UPDATE saos_accounts SET settings = ? WHERE id = ?')
    .run(JSON.stringify(settings), process.env.SAOS_USER_ID);
}
