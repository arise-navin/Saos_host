import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

/*
 * THIS COMPUTER'S ID — for a key issued to one computer only.
 *
 * The operating system's own identity, hashed: Windows' MachineGuid (set when
 * Windows is installed), the Mac's hardware UUID, Linux's machine-id. Renaming
 * the computer does not change it; reinstalling Windows does. Hashed so the
 * raw identifier never leaves the computer: the person reads the ID off the
 * licence page and sends it to whoever issues their key.
 *
 * Not the onboarding machineId (config/onboarding.js), which is the hostname
 * and changes with a rename.
 */

function rawMachineId() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'],
        { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      const m = /MachineGuid\s+REG_SZ\s+([0-9a-f-]+)/i.exec(out);
      if (m) return m[1].toLowerCase();
    } else if (process.platform === 'darwin') {
      const out = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 5000 });
      const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out);
      if (m) return m[1].toLowerCase();
    } else {
      for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try { const id = fs.readFileSync(file, 'utf8').trim(); if (id) return id; } catch { /* next */ }
      }
    }
  } catch { /* fall back below */ }
  return `host:${os.hostname().toLowerCase()}`;
}

/** `XXXX-XXXX-XXXX-XXXX` from any spelling of one (case, dashes, spaces), or null. */
export function normalizeMachineId(text) {
  const hex = String(text ?? '').replace(/[\s-]/g, '').toUpperCase();
  return /^[0-9A-F]{16}$/.test(hex) ? hex.match(/.{4}/g).join('-') : null;
}

let cached = null;

export function machineId() {
  if (!cached) {
    const hex = crypto.createHash('sha256').update(`saos-machine:${rawMachineId()}`).digest('hex').slice(0, 16);
    cached = normalizeMachineId(hex);
  }
  return cached;
}
