import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The promoted scoring configuration (decision D-016), written by
 * scripts/health-promote.mjs from a passing calibration report. The running scan
 * reads its CMDB and ITSM model settings from here — never from candidates.json,
 * which holds options, not decisions.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
let cached = null;

export function promotion() {
  if (!cached) cached = Object.freeze(JSON.parse(fs.readFileSync(path.join(HERE, 'promotion.json'), 'utf8')));
  return cached;
}

export const promotedConfig = () => promotion().config;
