import { scorePackV2 } from './pack-v2.js';

/**
 * ITIL QUALITY v2 — the promoted model (D-016) applied to the ITIL catalogue (Health Assist
 * Phase 10, D-034). Scored from the catalogue over its fourteen practice groups (request
 * fulfilment … cross-practice) with equal weights, not reviewed — the supplied ITIL
 * workbook gives none. The per-group scores ARE ITIL-147, the practice maturity profile.
 * Rules that restate another module's rule are equivalents and are counted there, once.
 */

export const ITIL_MODEL_V2 = 'itil-quality/2';

export const ITIL_TEXT = Object.freeze({
  areas: 'ITIL practice groups',
  definition: 'Each ITIL practice group starts at 100 and loses each failing catalogue rule\'s severity weight (Systemic 100 · Critical 40 · High 15 · Moderate 5 · Low 1), a rate rule by how far it misses its own threshold; the module is the mean of the groups measured. A rule that restates another module\'s rule is counted in that module, once. Rules that could not be judged — a product not in use, a value the customer has not given — are coverage gaps, never health.',
  withheld: 'No ITIL catalogue rule reached a pass or fail verdict on this run, so there is nothing to score.',
  legacy: 'ITIL had no score before Phase 10.',
});

export function scoreItilV2(args) {
  return scorePackV2({ ...args, model: ITIL_MODEL_V2, text: ITIL_TEXT });
}
