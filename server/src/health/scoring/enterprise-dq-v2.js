import { scorePackV2 } from './pack-v2.js';

/**
 * ENTERPRISE DATA QUALITY v2 — the promoted model (D-016) applied to the Enterprise
 * Data Quality catalogue (Health Assist Phase 7, DQ-084 … DQ-139). The module had
 * no score before this phase (it was planned). It is scored from its catalogue over
 * the workbook's seven dimensions (Q1–Q7), whose workbook weights (18 · 15 · 15 ·
 * 12 · 12 · 18 · 10) the shared arithmetic applies; its validity carries the
 * calibrated coverage floor, so a thinly assessed module is shown and labelled,
 * never quoted as healthy.
 */

export const ENTERPRISE_DQ_MODEL_V2 = 'enterprise-dq-quality/2';

export const ENTERPRISE_DQ_TEXT = Object.freeze({
  areas: 'data-quality dimensions',
  definition: 'Each Enterprise Data Quality dimension (completeness, validity, consistency, uniqueness, timeliness, referential integrity, sensitive data exposure) starts at 100 and loses each failing catalogue rule\'s severity weight (Systemic 100 · Critical 40 · High 15 · Moderate 5 · Low 1), a rate rule by how far it misses its own threshold; the module combines the dimensions measured by their workbook weights. Rules that could not be judged are coverage gaps, never health.',
  withheld: 'No Enterprise Data Quality catalogue rule reached a pass or fail verdict on this run, so there is nothing to score.',
  legacy: 'Enterprise Data Quality has no earlier rules: the catalogue is its first score.',
});

export function scoreEnterpriseDqV2(args) {
  return scorePackV2({ ...args, model: ENTERPRISE_DQ_MODEL_V2, text: ENTERPRISE_DQ_TEXT });
}
