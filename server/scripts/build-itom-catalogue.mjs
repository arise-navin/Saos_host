/**
 * HEALTH ASSIST PHASE 5 — generate the ITOM pack's data from its decision table.
 *
 *   node scripts/build-itom-catalogue.mjs [--check]
 *
 * The ITOM entry to the generic pack builder (scripts/build-workbook-pack.mjs --pack
 * itom). `outputs()` is what the ITOM suite compares against the committed files.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packOutputs, run } from './build-workbook-pack.mjs';

export const outputs = () => packOutputs('itom');

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stale = await run('itom', { check: process.argv.includes('--check') });
  if (process.argv.includes('--check') && stale) process.exit(1);
}
