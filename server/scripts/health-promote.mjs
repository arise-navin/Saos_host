/**
 * HEALTH ASSIST PHASE 4 — promote the calibrated model (decision D-016).
 *
 *   node scripts/health-promote.mjs
 *
 * Reads the committed calibration report and writes src/health/scoring/promotion.json:
 * the configuration the running scan now scores CMDB and ITSM with. It REFUSES
 * unless the report's combined configuration passes every property and every
 * scenario — a model is promoted from evidence, never by hand. The suite checks
 * promotion.json matches the report.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFrom } from '../src/health/scoring/calibration.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCORING = path.resolve(HERE, '../src/health/scoring');
const report = JSON.parse(fs.readFileSync(path.join(SCORING, 'calibration-report.json'), 'utf8'));
const candidates = JSON.parse(fs.readFileSync(path.join(SCORING, 'candidates.json'), 'utf8'));

if (!report.combined.passes_all) {
  process.stderr.write(`health-promote: refused — the combined configuration fails: ${report.combined.failing.join('; ')}\n`);
  process.exit(1);
}
const config = configFrom(candidates, report.combined.picks);
const promotion = {
  promotion_version: '1.0.0',
  model_family: 'health-quality/2',
  decision: 'D-016',
  calibration_version: report.calibration_version,
  candidates_version: report.candidates_version,
  picks: report.combined.picks,
  config: { record: config.record, curve: config.curve, control: config.control, blends: config.blends, overall: config.overall, floor: config.floor, systemic: config.systemic },
  /* ITOM joins in Health Assist Phase 5, scored from its 156-rule catalogue. */
  /* Platform joins in Health Assist Phase 6, scored from its 183-rule catalogue. */
  /* Enterprise Data Quality joins in Health Assist Phase 7, scored from its 56-rule catalogue. */
  /* CSDM joins in Health Assist Phase 9, scored from its 80-rule catalogue. */
  /* ITIL joins in Health Assist Phase 10, scored from its 148-rule catalogue. */
  modules: { cmdb: 'cmdb-quality/2', itsm: 'itsm-quality/2', itom: 'itom-quality/2', platform: 'platform-quality/2', enterprise_dq: 'enterprise-dq-quality/2', csdm: 'csdm-quality/2', itil: 'itil-quality/2' },
  /* Health Assist Phase 8 (D-028): the calibrated Overall (O8 min-blend) is the running Overall. */
  overall_model: 'overall-health/2',
  not_promoted: {
    coverage_floor: 'F2 = 0.4 applies to the validity of the promoted modules (CMDB, ITSM, ITOM, Platform, Enterprise DQ, CSDM, ITIL) only; each other module gets it when its own phase promotes it',
  },
};
fs.writeFileSync(path.join(SCORING, 'promotion.json'), `${JSON.stringify(promotion, null, 1)}\n`);
process.stdout.write(`promoted ${promotion.model_family}: ${JSON.stringify(promotion.picks)} → src/health/scoring/promotion.json\n`);
