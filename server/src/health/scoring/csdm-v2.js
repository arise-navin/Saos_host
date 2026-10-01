import { scorePackV2 } from './pack-v2.js';

/**
 * CSDM QUALITY v2 — the promoted model (D-016) applied to the CSDM catalogue (Health
 * Assist Phase 9, D-029). CSDM had no score before this phase (its sheet was a
 * placeholder). It is scored from its catalogue over the seven scored groups (taxonomy,
 * lifecycle, ownership, environment, relationships, offerings, maturity) with equal
 * weights, not reviewed — CSDM-072 names configurable weights and gives none. The
 * cross-domain group is correlation and is not scored. This score IS CSDM-072, the
 * maturity composite; its Foundation / Crawl / Walk / Run bands are not given, so no
 * band is placed. Its validity carries the calibrated coverage floor.
 */

export const CSDM_MODEL_V2 = 'csdm-quality/2';

export const CSDM_TEXT = Object.freeze({
  areas: 'CSDM groups',
  definition: 'Each CSDM group (taxonomy, lifecycle, ownership, environment, relationships, offerings, maturity) starts at 100 and loses each failing catalogue rule\'s severity weight (Systemic 100 · Critical 40 · High 15 · Moderate 5 · Low 1), a rate rule by how far it misses its own threshold; the module is the mean of the groups measured. A rule gated by a failed prerequisite (no lifecycle model, no environment values, no offering layer) is not measured, and the prerequisite\'s own finding carries it. Rules that could not be judged are coverage gaps, never health.',
  withheld: 'No CSDM catalogue rule reached a pass or fail verdict on this run, so there is nothing to score.',
  legacy: 'The three hard-coded CSDM checks (CSDM-OWNER, CSDM-LIFECYCLE, CSDM-OFFERING) stay in CMDB, unchanged.',
});

export function scoreCsdmV2(args) {
  return scorePackV2({ ...args, model: CSDM_MODEL_V2, text: CSDM_TEXT });
}
