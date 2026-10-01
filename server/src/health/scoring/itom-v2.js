import { scorePackV2, packThresholdOf } from './pack-v2.js';
import { CONTROL_POLICY } from './itsm-v2.js';

/**
 * ITOM QUALITY v2 — the promoted model (D-016) applied to the ITOM catalogue
 * (Health Assist Phase 5), through the shared pack scorer (pack-v2.js): each ITOM
 * product area — Discovery, MID Server, Service Mapping, Event Management, Cloud —
 * scores the severity-weighted share of its judged catalogue rules that pass, a rate
 * rule by how far it misses its own threshold; the module is the mean of the areas
 * measured. Base-Systemic rules are posture, never deducted (CONTROL_POLICY, 29 Sep
 * 2026 — see itsm-v2.js). Cross-domain correlation rules explain and are not scored;
 * ITOM-001 / 002 are counted in CMDB (D-023); the eighteen hard-coded ITOM rules are
 * drill-down views.
 */

export const ITOM_MODEL_V2 = 'itom-quality/2';

export const ITOM_TEXT = Object.freeze({
  areas: 'ITOM product areas',
  definition: 'Each ITOM product area (Discovery, MID Server, Service Mapping, Event Management, Cloud) scores the severity-weighted share of its judged catalogue rules that pass (Critical 40 · High 15 · Moderate 5 · Low 1), a rate rule by how far it misses its own threshold; the module is the mean of the areas measured. Systemic rules are posture: their findings are reported and they are not deducted. Rules that could not be judged — an object this instance lacks, a threshold not yet set, a detection the workbook leaves undefined — are coverage gaps, never health.',
  withheld: 'No ITOM catalogue rule reached a pass or fail verdict on this run, so there is nothing to score.',
  legacy: 'The eighteen hard-coded ITOM rules are not scored: they are shown as drill-down views while the catalogue rules they map to (legacy-map.json) carry the score.',
});

export const itomThresholdOf = packThresholdOf;

export function scoreItomV2(args) {
  return scorePackV2({ ...args, model: ITOM_MODEL_V2, text: ITOM_TEXT, policy: CONTROL_POLICY });
}
