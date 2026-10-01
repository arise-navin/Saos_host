import crypto from 'node:crypto';
import { methodC, moduleScore, attainment, bandWeight } from './kernel.js';

/**
 * ITSM QUALITY v2 — the promoted model (decision D-016) applied to a real scan.
 *
 * PURE. The ITSM catalogue's normalised rule rows in (manifest.itsm.rules), one
 * score out, over the workbook's process dimensions: Incident, Problem, Change,
 * Cross-process (equal weights, "not reviewed" — D-012).
 *
 * A dimension is scored by the workbook deduction (C3): it starts at 100 and
 * loses each failing rule's severity weight × (1 − attainment). A failure costs
 * what its severity says, however many rules pass beside it (calibration S02F).
 *
 *   attainment  a pass is 1. A failure is 0 — unless the rule is a rate with a
 *               stated threshold (the aggregate engine's `threshold {op, $param}`),
 *               where it is the measured rate against that threshold on the convex
 *               curve: 9% reopens against an 8% limit is nearly met; 60% is not.
 *   what counts rules the runner EVALUATED with a pass or fail verdict. Inconclusive,
 *               unavailable, unconfigured and errored rules are coverage gaps, never
 *               health. Correlation, trend and context rules (the overlays) explain
 *               or report and are not scored. The eleven hard-coded ITSM rules are
 *               retired from scoring (legacy-map: retire_from_scoring): they charge
 *               individual records for conditions the workbook defines as rates.
 *
 * Phase 5: the body is `scoreCatalogueControls`, shared with ITOM (itom-v2.js);
 * ITSM's output is unchanged.
 *
 * 29 Sep 2026 — SYSTEMIC IS POSTURE, AND AN AREA NO LONGER COLLAPSES (ITSM and ITOM
 * only, CONTROL_POLICY below). Under the deduction every area lost several times its
 * 100 points (Incident −840 on techsnitchpvtltddemo2), so ITSM read 0 and ITOM 1.3 on
 * every instance scanned, whatever its health. Two changes, both opt-in so Platform,
 * Enterprise DQ, CSDM and ITIL keep their arithmetic and their scoring keys:
 *   - a base-Systemic rule is posture — reported, never deducted — as CMDB already
 *     treats Systemic outside its trust gate;
 *   - an area is the severity-weighted share of its judged rules that pass
 *     (`weight_share`), so it reflects how much of the area fails, not whether the
 *     failures add up past 100.
 */

export const ITSM_MODEL_V2 = 'itsm-quality/2';
const NOT_SCORED_KINDS = new Set(['correlation', 'trend', 'context']);
const round1 = (x) => (x == null ? null : Number(x.toFixed(1)));
const isSystemic = (band) => String(band ?? '').toUpperCase() === 'SYSTEMIC';

/**
 * The control policy ITSM and ITOM score under. `null` (the default for every other
 * pack) leaves the promoted configuration exactly as it was.
 */
export const CONTROL_POLICY = Object.freeze({ aggregation: 'weight_share', systemic: 'posture' });

/*
 * `weights`: 'equal', or — Phase 7, where the workbook states them (Enterprise DQ Q1–Q7) — the workbook's weights by dimension.
 * `policy` joins the key only when set, so a pack without one keeps the key it had and its trend stays joined.
 */
function catalogueScoringKey(model, config, dimensions, weights = 'equal', policy = null) {
  return crypto.createHash('sha256').update(JSON.stringify({
    model, curve: config.curve, control: config.control, dimensions: dimensions.map((d) => d.key), weights,
    ...(policy ? { policy } : {}),
  })).digest('hex').slice(0, 16);
}

export function itsmScoringKeyV2(config, dimensions) {
  return catalogueScoringKey(ITSM_MODEL_V2, config, dimensions, 'equal', CONTROL_POLICY);
}

/** The estate-level measurement of a rate rule: the `estate` variant, or the only one. */
function estateKpi(row) {
  const ks = (row.kpis || []).filter((k) => Number.isFinite(k.pass_pct));
  return ks.find((k) => k.variant === 'estate') ?? (ks.length === 1 ? ks[0] : ks.find((k) => !k.variant) ?? null);
}

/**
 * The attainment of one evaluated rule, and how it was reached.
 * @param {object} row        a normalised catalogue rule row
 * @param {object|null} thr   { op, key, complement? } from the rule's configuration, or null
 */
export function ruleAttainment(row, thr, curve) {
  if (row.verdict === 'pass') return { a: 1, basis: 'pass' };
  const kpi = estateKpi(row);
  /* `complement`: the workbook states the GOOD share ("binding ≥ 85%"); the engine measures the bad one. */
  const raw = thr ? Number(row.parameters?.[thr.key]?.value) : NaN;
  const limit = thr?.complement ? 100 - raw : raw;
  if (thr && kpi && Number.isFinite(limit) && limit > 0 && limit < 100) {
    const measured = (100 - kpi.pass_pct) / 100;
    const form = thr.op === 'gt' || thr.op === 'gte' ? 'bad_rate' : thr.op === 'lt' || thr.op === 'lte' ? 'good_share' : null;
    if (form) {
      const a = form === 'bad_rate'
        ? attainment('bad_rate', { measured, limit: limit / 100 }, curve)
        : attainment('good_share', { measured, target: limit / 100 }, curve);
      /* A failing verdict is never scored as met: a per-group breach can fail a rule whose estate rate is inside the limit. */
      if (a < 1) return { a, basis: `${form === 'bad_rate' ? 'rate' : 'share'} ${round1(measured * 100)}% against ${thr.op} ${round1(limit)}% (${curve})` };
    }
  }
  return { a: 0, basis: 'fail' };
}

const ITSM_TEXT = Object.freeze({
  areas: 'process areas',
  definition: 'Each process area (Incident, Problem, Change, Cross-process) scores the severity-weighted share of its judged catalogue rules that pass (Critical 40 · High 15 · Moderate 5 · Low 1), a rate rule by how far it misses its own threshold; the module is the mean of the areas measured. Systemic rules are posture: their findings are reported and they are not deducted. Rules that could not be judged are coverage gaps, never health.',
  withheld: 'No ITSM catalogue rule reached a pass or fail verdict on this run, so there is nothing to score.',
  legacy: 'The eleven hard-coded ITSM rules are not scored (retire_from_scoring): the workbook defines their conditions as rates, which the catalogue rules measure.',
});

/**
 * @param {object}   args
 * @param {object[]} args.rows        manifest.itsm.rules
 * @param {(ruleId: string) => object|null} args.overlay     the rule's overlay (dimension, kind)
 * @param {(ruleId: string) => {op: string, key: string}|null} args.threshold
 * @param {{key: string, label: string}[]} args.dimensions  the ITSM profile's dimensions
 * @param {object}   args.config      the promoted configuration
 * @param {object}   [args.coverage]  v1's ITSM coverage block (rules with a verdict ÷ rules that could run)
 */
export function scoreItsmV2(args) {
  return scoreCatalogueControls({ ...args, model: ITSM_MODEL_V2, text: ITSM_TEXT, policy: CONTROL_POLICY });
}

/**
 * The catalogue control score for any workbook pack (ITSM, ITOM): dimensions from
 * the workbook profile, rules from the pack's normalised rows, the promoted C3
 * deduction and curve. `exclude(row)` drops rows that are neither health nor a
 * coverage gap (ITOM's equivalent rules, counted in their own module).
 *
 * `policy` (CONTROL_POLICY, ITSM and ITOM only) overrides the aggregation and makes
 * a judged base-Systemic rule posture: listed with its verdict, never scored.
 */
export function scoreCatalogueControls({ rows = [], overlay = () => null, threshold = () => null, dimensions = [], config, coverage = null, model, text, exclude = () => false, policy = null }) {
  const aggregation = policy?.aggregation ?? config.control.aggregation;
  const systemicPosture = policy?.systemic === 'posture';
  const dims = dimensions.filter((d) => d.scored !== false);
  /* The workbook's own dimension weights when it states one for every dimension (Enterprise DQ); otherwise equal, not reviewed. */
  const workbookWeights = dims.length > 0 && dims.every((d) => Number.isFinite(d.weight) && d.weight > 0);
  const byDim = Object.fromEntries(dims.map((d) => [d.key, { rules: [], failing: [], posture: [], gaps: 0, excluded: 0 }]));
  for (const row of rows) {
    const ov = overlay(row.rule_id);
    const slot = byDim[ov?.dimension];
    if (!slot || exclude(row)) continue;
    if (NOT_SCORED_KINDS.has(ov.kind)) { slot.excluded += 1; continue; }
    if (row.status !== 'evaluated' || !['pass', 'fail'].includes(row.verdict)) { slot.gaps += 1; continue; }
    /* After the gap check, so a Systemic rule that could not run is still a coverage gap. */
    if (systemicPosture && isSystemic(row.base_severity)) {
      slot.posture.push({ rule_id: row.rule_id, title: row.title ?? null, verdict: row.verdict });
      continue;
    }
    const { a, basis } = ruleAttainment(row, threshold(row.rule_id), config.curve);
    slot.rules.push({ id: row.rule_id, base: row.base_severity, attainment: a });
    if (a < 1) slot.failing.push({ rule_id: row.rule_id, title: row.title ?? null, severity: row.base_severity, attainment: Number(a.toFixed(3)), deduction: Number((bandWeight(row.base_severity) * (1 - a)).toFixed(2)), basis });
  }
  const dimResults = dims.map((d) => {
    const s = byDim[d.key];
    const score = s.rules.length ? methodC(s.rules, { aggregation }).score : null;
    return {
      key: d.key, label: d.label, weight: workbookWeights ? d.weight : 1, score: round1(score), measured: score != null,
      rules_judged: s.rules.length, failing: s.failing.sort((x, y) => y.deduction - x.deduction), gaps: s.gaps, not_scored: s.excluded,
      ...(systemicPosture ? { posture: s.posture } : {}),
    };
  });
  const module = moduleScore(dimResults.map((d) => ({ key: d.key, weight: d.weight, score: d.score })));
  const judged = dimResults.reduce((n, d) => n + d.rules_judged, 0);
  const failing = dimResults.flatMap((d) => d.failing.map((f) => ({ ...f, dimension: d.key })));
  const drivers = failing.sort((x, y) => y.deduction - x.deduction).slice(0, 8)
    .map((f) => ({ rule_id: f.rule_id, label: f.title ?? f.rule_id, severity: f.severity, deduction: f.deduction, dimension: f.dimension, records: null, share: null }));
  const measured = dimResults.filter((d) => d.measured);
  const key = catalogueScoringKey(model, config, dimResults, workbookWeights ? Object.fromEntries(dimResults.map((d) => [d.key, d.weight])) : 'equal', policy);
  const posture = systemicPosture ? dimResults.flatMap((d) => d.posture.map((p) => ({ ...p, dimension: d.key }))) : null;
  const postureNote = posture ? ` ${posture.length} Systemic rule(s) judged as posture, not scored (${posture.filter((p) => p.verdict === 'fail').length} failing).` : '';
  return {
    score: round1(module.score),
    basis: module.score == null ? null
      : `${judged} catalogue rules judged across ${measured.length} of ${dimResults.length} ${text.areas} (${measured.map((d) => `${d.label} ${d.score}`).join(' · ')}); ${failing.length} failing.${postureNote} ${workbookWeights ? 'Workbook weights.' : 'Equal area weights, not reviewed.'}`,
    definition: text.definition,
    withheld: module.score == null ? text.withheld : null,
    drivers,
    scoring: { model, key },
    quality: {
      model,
      scoring: { model, key },
      decision: 'D-016',
      dimensions: dimResults,
      weights_status: workbookWeights ? 'the workbook\'s dimension weights' : 'undefined in the workbook — equal and not reviewed (D-004, D-012)',
      method: { aggregation, curve: config.curve, ...(systemicPosture ? { systemic: 'posture' } : {}) },
      rules: { judged, failing: failing.length, gaps: dimResults.reduce((n, d) => n + d.gaps, 0), not_scored: dimResults.reduce((n, d) => n + d.not_scored, 0), ...(posture ? { posture: posture.length } : {}) },
      ...(posture ? { posture } : {}),
      legacy_rules: text.legacy,
      coverage,
    },
  };
}
