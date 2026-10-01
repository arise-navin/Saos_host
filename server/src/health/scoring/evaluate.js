import { methodR, methodC, blend, moduleScore, attainment } from './kernel.js';
import { overallScore } from './overall-candidates.js';

/**
 * Score one calibration scenario under one configuration — Phase 3.
 *
 * A SCENARIO is an estate described at the kernel's level (records with tiers
 * and charges; rules with base band, threshold form and measured value):
 *
 *   { modules: { <key>: { method: 'R'|'C', weight?, coverage?, dims: [ DIM ] } } }
 *   DIM (R): { key, weight, kind: 'record'|'mixed'|'estate', records: [{ tier, count?, charges }], rules?: [ RULE ], applicable? }
 *   DIM (C): { key, weight, rules: [ RULE ], applicable? }
 *   RULE:    { id, base, effective?, form, value, family?, evaluated? }
 *
 * A CONFIGURATION picks one option per calibrated axis:
 *   { record: { aggregation, tier_weights }, curve, blends: { record, mixed, estate }, overall: { kind, params }, floor }
 *
 * Module weights in the Overall are equal unless a scenario says otherwise: the
 * workbook defines none, and decision D-004 makes equal the provisional start.
 */

function ruleAttainments(rules = [], curve) {
  return rules.map((r) => ({ ...r, attainment: r.evaluated === false ? null : attainment(r.form, r.value, curve) }));
}

/** Does a Systemic defect stand in this dimension? A base-Systemic rule below full attainment, or an effective-Systemic charge on a record. */
export function systemicStands(dim, config) {
  if (dim.applicable === false) return false;
  const rule = (dim.rules || []).some((r) => r.base === 'Systemic' && r.evaluated !== false && attainment(r.form, r.value, config.curve) < 1);
  const record = (dim.records || []).some((g) => (g.count ?? 1) > 0 && (g.charges || []).some((c) => c.band === 'SYSTEMIC'));
  return rule || record;
}

const capAt = (score, cap) => (score == null || cap == null ? score : Math.min(score, cap));

export function dimensionScore(dim, module, config) {
  if (dim.applicable === false) return null;
  const c = dim.rules?.length ? methodC(ruleAttainments(dim.rules, config.curve), { aggregation: config.control?.aggregation ?? 'weight_share' }).score : null;
  let s;
  if (module.method === 'C') s = c;
  else {
    const r = dim.records?.length
      ? methodR(dim.records, { aggregation: config.record.aggregation, tierWeights: config.record.tier_weights || {} }).score
      : null;
    s = blend(r, c, config.blends[dim.kind || 'record'] ?? config.blends.record);
  }
  const cap = config.systemic?.level === 'dimension' && systemicStands(dim, config) ? config.systemic.at : null;
  return capAt(s, cap);
}

export function evaluateScenario(scenario, config) {
  const modules = {};
  for (const [key, mod] of Object.entries(scenario.modules)) {
    const dims = mod.dims.map((d) => ({ key: d.key, weight: d.weight, applicable: d.applicable !== false, score: dimensionScore(d, mod, config) }));
    const s = moduleScore(dims);
    const moduleCap = config.systemic?.level === 'module' && mod.dims.some((d) => systemicStands(d, config)) ? config.systemic.at : null;
    const coverage = mod.coverage ?? 1;
    modules[key] = {
      score: capAt(s.score, moduleCap),
      dims: Object.fromEntries(dims.map((d) => [d.key, d.score])),
      coverage,
      participates: s.score != null && coverage >= config.floor,
      weight: mod.weight ?? 1,
    };
  }
  const overall = overallScore(
    Object.entries(modules).filter(([, m]) => m.participates).map(([key, m]) => ({ key, score: m.score, weight: m.weight })),
    config.overall,
  );
  return { modules, overall };
}
