import { scorePackV2 } from './pack-v2.js';

/**
 * PLATFORM QUALITY v2 — the promoted model (D-016) applied to the Platform catalogue
 * (Health Assist Phase 6). Platform had no score before this phase (score_kind
 * "none"); it is scored from its catalogue over the nine workbook areas, and its
 * validity carries the calibrated coverage floor, so a thinly assessed Platform is
 * shown and labelled, never quoted as healthy. Script and design rules judge
 * customer-authored records only (D-024).
 */

export const PLATFORM_MODEL_V2 = 'platform-quality/2';

export const PLATFORM_TEXT = Object.freeze({
  areas: 'Platform areas',
  definition: 'Each Platform area (SLA engineering, server logic, client logic, automation, jobs and events, access and security, integrations, customisation debt, performance) starts at 100 and loses each failing catalogue rule\'s severity weight (Systemic 100 · Critical 40 · High 15 · Moderate 5 · Low 1), a rate rule by how far it misses its own threshold; the module is the mean of the areas measured. Script and design rules judge the customer\'s own records (those with a customer update), not the ServiceNow baseline. Rules that could not be judged are coverage gaps, never health.',
  withheld: 'No Platform catalogue rule reached a pass or fail verdict on this run, so there is nothing to score.',
  legacy: 'The hard-coded Platform rules are not scored: they are shown as drill-down views while the catalogue rules they map to (legacy-map.json) carry the score.',
});

export function scorePlatformV2(args) {
  return scorePackV2({ ...args, model: PLATFORM_MODEL_V2, text: PLATFORM_TEXT });
}
