#!/usr/bin/env node
/**
 * HEALTH ASSIST PHASE 5E — READ-ONLY validation of the ITOM pack against the
 * configured instance. The generic script is pack-instance-validation.mjs; this
 * entry runs it for ITOM:  node scripts/itom-instance-validation.mjs
 */
process.argv.push('--pack', 'itom');
await import('./pack-instance-validation.mjs');
