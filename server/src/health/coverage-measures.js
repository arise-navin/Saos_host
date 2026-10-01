import { BAND_WEIGHT } from './cmdb-quality.js';
import { dimensionState } from './applicability.js';

/**
 * THE THREE COVERAGE MEASURES — Phase 2 of docs/HEALTH-ASSIST-APPROACH.md (§7).
 * Never inside a score; always beside it.
 *
 *   build        workbook rules implemented ÷ workbook rules (per module): how much
 *                of the SAOS model exists in this build.
 *   applicability which dimensions are in scope on this instance, with the probe's
 *                evidence (applicability.js). A dimension reliably NOT in use leaves
 *                the denominator; an unknown one stays in it.
 *   assessment   Σ base weight of assessed rules ÷ Σ base weight of applicable,
 *                built rules. "Assessed" is evaluated with a pass or fail verdict;
 *                skipped, unavailable, unconfigured, errored and inconclusive are
 *                gaps. Weighting by the workbook's own severity weights (Systemic
 *                100 … Low 1) keeps five unevaluated hygiene rules from looking as
 *                bad as one unevaluated Systemic rule.
 *
 * Counted only: rules with a workbook identity. The hard-coded interim rules and
 * the rules recorded for retirement are listed apart, never in the ratio.
 *
 * Counted only: rules the SCORE uses (Phase 5 correction). A correlation, trend or
 * context rule, or any rule of a dimension the profile does not score (ITOM's
 * cross-domain group), explains or reports and never moves the number; counting
 * it as a gap understated how much of the NUMBER was assessed, and the calibrated
 * coverage floor reads this share. Such rules are listed apart (`not_scored`).
 * An equivalent rule (D-019) is counted in the module that evaluates it.
 * A pass that rests on silence (`no_finding_population_undeclared`) is assessed,
 * and its weight share is reported separately so it can be read for what it is.
 */

export const COVERAGE_MODEL = 'coverage-measures/1';

const band = (b) => ({ Systemic: 'SYSTEMIC', Critical: 'CRITICAL', High: 'HIGH', Moderate: 'MEDIUM', Low: 'LOW' }[b] ?? b);
const weightOf = (r) => BAND_WEIGHT[band(r.severity?.base)] ?? 0;
const share = (a, b) => (b ? Number((a / b).toFixed(3)) : null);
const isAssessed = (r) => r.status === 'evaluated' && ['pass', 'fail'].includes(r.verdict);

/**
 * @param {object}   args
 * @param {object[]} args.ruleResults
 * @param {(ruleId: string) => object|null} args.overlay
 * @param {object}   args.applicability   assessApplicability() output
 * @param {object[]} args.registry        moduleRegistry() rows (build coverage)
 * @param {string[]} args.modules         the modules this run read
 */
const NOT_SCORED_KINDS = new Set(['correlation', 'trend', 'context']);

export function assessCoverage({ ruleResults = [], overlay = () => null, applicability = null, registry = [], modules = [], dimensions = () => [] }) {
  const out = {};
  for (const m of modules) {
    const reg = registry.find((x) => x.key === m);
    const rows = ruleResults.filter((r) => r.module === m);
    const notCounted = { interim_legacy: 0, retire_pending: 0, no_workbook_identity: 0, not_scored: 0, equivalent: 0 };
    const unscoredDims = new Set((dimensions(m) || []).filter((d) => d.scored === false).map((d) => d.key));
    const byDim = {};
    const excluded = [];
    let applicable = 0; let assessedW = 0; let silenceW = 0;
    const counts = { applicable: 0, assessed: 0, on_silence: 0, gaps: 0 };
    for (const r of rows) {
      if (r.source === 'legacy') { notCounted.interim_legacy += 1; continue; }
      if (r.deviation === 'retire_pending') { notCounted.retire_pending += 1; continue; }
      const ov = overlay(r.rule_id);
      if (!ov) { notCounted.no_workbook_identity += 1; continue; }
      if (r.status === 'equivalent') { notCounted.equivalent += 1; continue; }
      if (NOT_SCORED_KINDS.has(ov.kind) || unscoredDims.has(ov.dimension)) { notCounted.not_scored += 1; continue; }
      const dim = ov.dimension ?? '(none)';
      const state = ov.dimension ? dimensionState(applicability, m, ov.dimension) : 'in_use';
      if (state === 'not_in_use') { excluded.push(r.rule_id); continue; }
      const w = weightOf(r);
      const d = (byDim[dim] ||= { applicability: state, weight_applicable: 0, weight_assessed: 0, rules: 0, assessed: 0 });
      d.weight_applicable += w; d.rules += 1;
      applicable += w; counts.applicable += 1;
      if (isAssessed(r)) {
        assessedW += w; d.weight_assessed += w; d.assessed += 1; counts.assessed += 1;
        if (r.verdict_basis === 'no_finding_population_undeclared') { silenceW += w; counts.on_silence += 1; }
      } else counts.gaps += 1;
    }
    for (const d of Object.values(byDim)) d.share = share(d.weight_assessed, d.weight_applicable);
    out[m] = {
      build: reg ? { ...reg.build, share: share(reg.build.built, reg.build.workbook_rules) } : null,
      applicability: Object.fromEntries(Object.entries(applicability?.modules?.[m] || {}).map(([k, v]) => [k, { state: v.state, basis: v.basis, probe: v.probe }])),
      assessment: {
        share: share(assessedW, applicable),
        weight_applicable: applicable,
        weight_assessed: assessedW,
        on_silence_share: share(silenceW, applicable),
        rules: counts,
        excluded_not_in_use: excluded,
        not_counted: notCounted,
        by_dimension: byDim,
        basis: 'Σ workbook severity weight of assessed rules ÷ Σ weight of applicable, built rules with a workbook identity that the score uses',
      },
    };
  }
  return { model: COVERAGE_MODEL, modules: out };
}
