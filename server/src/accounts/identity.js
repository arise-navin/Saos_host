import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { accountStore } from './store.js';

export function instanceOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !/^[a-z0-9-]+\.service-now\.com$/i.test(url.hostname)
      || !['', '/'].includes(url.pathname) || url.search || url.hash) {
    throw new Error('Enter your https://<instance>.service-now.com URL.');
  }
  return url.origin;
}

export function authenticateAccount({ instanceUrl, username, password }) {
  const instance = instanceOrigin(instanceUrl);
  if (typeof username !== 'string' || !username.trim() || username.length > 200
      || /[\r\n:^]/.test(username) || typeof password !== 'string' || !password || password.length > 4096) {
    throw new Error('Enter your ServiceNow username and password.');
  }
  const login = username.trim();
  const db = accountStore();
  const previous = db.prepare('SELECT * FROM saos_accounts WHERE instance = ? AND lower(username) = ?').get(instance, login.toLowerCase());
  const id = previous?.id || createHash('sha256').update(`${instance}\n${login.toLowerCase()}`).digest('hex');
  const saved = db.prepare('SELECT salt, digest FROM saos_account_passwords WHERE account = ?').get(id);
  if (saved) {
    if (!timingSafeEqual(scryptSync(password, saved.salt, 64), Buffer.from(saved.digest, 'hex'))) {
      throw new Error('Incorrect username or password.');
    }
  } else {
    const salt = randomBytes(32).toString('hex');
    if (previous) {
      const storedPassword = JSON.parse(previous.settings).connection?.password;
      if (!storedPassword || !timingSafeEqual(scryptSync(password, salt, 64), scryptSync(storedPassword, salt, 64))) {
        throw new Error('Incorrect username or password.');
      }
    }
    db.prepare('INSERT INTO saos_account_passwords(account, salt, digest) VALUES (?, ?, ?)').run(id, salt, scryptSync(password, salt, 64).toString('hex'));
  }
  return {
    id, instance, username: previous?.username || login,
  };
}
