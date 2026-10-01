import crypto from 'node:crypto';
import { CMDB_CATALOGUE, DIMENSION_KIND, RETIRED_CATALOGUE_RULES } from '../cmdb-quality.js';
import { CLASS_TIERS, isEndpoint } from '../cmdb-signals.js';
import { CMDB_PARAMETER_PACKS } from '../parameter-registry.js';
import { methodR, methodC, blend, moduleScore, attainment } from './kernel.js';

/**
 * CMDB QUALITY v2 — the promoted model (decision D-016) applied to a real scan.
 *
 * PURE. It reads what the v1 scorer (cmdb-quality.js) was given — findings, KPI
 * measurements, the in-scope population and per-dimension scopes — plus the
 * signals the rules built, and returns a result IN THE SAME SHAPE as v1, so every
 * reader of `cmdb_quality` (the frozen page, the validity layer, stored-run views)
 * reads v2 without change. What differs is the arithmetic:
 *
 *   records   tier-stratified mean (calibration R6): the mean of each consequence
 *             tier's mean record score, weighted by tier — a clean tail of
 *             endpoints no longer dilutes a defective core. A record's score is
 *             unchanged: 100 minus the heaviest weight per distinct defect.
 *   KPIs      the workbook deduction (C3) with the convex curve (A3): each KPI
 *             starts at full and loses its severity weight × (1 − attainment²),
 *             attainment being the measured share against the rule's own threshold.
 *   blend     unchanged: the v1 per-dimension record/KPI blend (70/30, 60/40, 30/70).
 *   composite unchanged: Σ workbook weight × dimension ÷ measured weight.
 *
 * WHICH RECORDS AND CHARGES: exactly v1's (the dimension scope, the retired /
 * inactive exclusions, contradiction-charged records, one charge per defect key,
 * the per-record deduction band and multiplier). A parity test holds v2's record
 * part equal to v1's under v1's own averaging.
 *
 * The number is never hidden: the gate variant carries the composite, labelled.
 */

export const CMDB_MODEL_V2 = 'cmdb-quality/2';

/*
 * Each percentage rule's threshold, read from the SAME resolved options the pack
 * used (defaults ⊕ overrides), as the passing share it demands. Rules that flip a
 * bad rate into a pass share (single-source, manual-only, bypass …) flip their
 * threshold the same way. A KPI with no percentage threshold (CMDB-076, CMDB-123)
 * is scored on its raw share and says so.
 */
export const KPI_TARGETS = Object.freeze({
  'CMDB-021': { scope: 'completeness', key: 'defaultChoiceRatio', invert: true },
  'CMDB-141': { scope: 'completeness', key: 'impactThresholdPct' },
  'CMDB-117': { scope: 'consumption', key: 'incidentServicePct' },
  'CMDB-118': { scope: 'consumption', key: 'incidentCiPct' },
  'CMDB-070': { scope: 'freshness', key: 'discoveryCoveragePct' },
  'CMDB-074': { scope: 'freshness', key: 'singleSourcePct', invert: true },
  'CMDB-078': { scope: 'freshness', key: 'manualOnlyPct', invert: true },
  'CMDB-079': { scope: 'freshness', key: 'importOnlyPct', invert: true },
  'CMDB-091': { scope: 'governance', key: 'governanceCoveragePct' },
  'CMDB-046': { scope: 'identification', key: 'ireBypassThresholdPct', invert: true },
  'CMDB-057': { scope: 'relationships', key: 'reachThresholdPct' },
  'CMDB-067': { scope: 'relationships', key: 'depthPassPct' },
  'CMDB-112': { scope: 'csdm', key: 'capabilityReachPct' },
});

const round1 = (x) => (x == null ? null : Number(x.toFixed(1)));

/** A CI's consequence tier: bc (supports a Business Critical service), core, endpoint, other. */
export function tierOf(ci, signals) {
  if (!ci) return 'other';
  if (signals?.bcSupported?.has?.(ci.sys_id)) return 'bc';
  const lineage = signals?.hierarchyOk && signals.lineage ? signals.lineage(ci.sys_class_name || 'cmdb_ci') : [ci.sys_class_name];
  const inClasses = (_c, list) => lineage.some((l) => list.includes(l));
  if (inClasses(ci, CLASS_TIERS.infrastructure) || inClasses(ci, CLASS_TIERS.host) || inClasses(ci, CLASS_TIERS.application)
    || inClasses(ci, CLASS_TIERS.hub) || inClasses(ci, ['cmdb_ci_service'])) return 'core';
  if (isEndpoint(ci, inClasses)) return 'endpoint';
  return 'other';
}

/** The pass share a KPI demands, from the pack's resolved options; null when the rule states none. */
export function kpiTarget(ruleId, options = {}) {
  const t = KPI_TARGETS[ruleId];
  if (!t) return null;
  const v = options[t.scope]?.[t.key] ?? CMDB_PARAMETER_PACKS[t.scope]?.defaults?.[t.key];
  if (!Number.isFinite(v)) return null;
  return t.invert ? 100 - v : v;
}

export function cmdbScoringKeyV2(config) {
  return crypto.createHash('sha256').update(JSON.stringify({
    model: CMDB_MODEL_V2, record: config.record, curve: config.curve, control: config.control, blends: config.blends,
    targets: KPI_TARGETS, retired: [...RETIRED_CATALOGUE_RULES].sort(),
  })).digest('hex').slice(0, 16);
}

/**
 * @param {object} args
 * @param {object}   args.v1              scoreCmdbQuality()'s result for the same scan
 * @param {object[]} args.findings        every finding
 * @param {object[]} args.kpis            the rules' KPI measurements
 * @param {{ids: Iterable<string>}} args.inScope
 * @param {object}   args.dimensionScope  dimension → in-scope ids (D1–D5 exclude retired/stolen/absent)
 * @param {object[]} args.cis             cmdb_ci rows (for tiers)
 * @param {object}   args.signals         the rules' signals (tiers)
 * @param {object}   args.options         resolved CMDB pack options (overrides; defaults fill the rest)
 * @param {object}   args.config          the promoted configuration
 */
export function scoreCmdbV2({ v1, findings = [], kpis = [], inScope = { ids: [] }, dimensionScope = {}, cis = [], signals = null, options = {}, config }) {
  if (!v1) return null;
  const scopeIds = new Set(inScope.ids || []);
  const catalogued = findings.filter((f) => CMDB_CATALOGUE[f.rule_id] && !RETIRED_CATALOGUE_RULES.has(f.rule_id));

  /* ── v1's scope and charge semantics, verbatim ── */
  const contradiction = {};
  for (const f of catalogued) {
    const rule = CMDB_CATALOGUE[f.rule_id];
    if (rule.intent !== 'contradiction' || rule.track !== 'dimension' || !rule.dimension) continue;
    if (rule.base === 'SYSTEMIC' || f.pattern || f.unscored_reason || rule.kind !== 'record') continue;
    (contradiction[rule.dimension] ||= new Set());
    for (const id of f.target_ids || []) if (scopeIds.has(id)) contradiction[rule.dimension].add(id);
  }
  const scopeFor = (dim) => {
    const base = dimensionScope[dim] ? new Set(dimensionScope[dim]) : scopeIds;
    const extra = contradiction[dim];
    return extra?.size ? new Set([...base, ...extra]) : base;
  };
  const band = (f, id) => f.deduction_by_record?.[id] ?? f.deduction_severity ?? f.severity;
  const charges = new Map();             // dim → Map(recordId → [{ key, band, multiplier }])
  for (const f of catalogued) {
    const rule = CMDB_CATALOGUE[f.rule_id];
    if (rule.base === 'SYSTEMIC' || rule.track !== 'dimension' || !rule.dimension) continue;
    if (f.unscored_reason || f.pattern || rule.kind !== 'record' || !(f.target_ids || []).length) continue;
    const inDim = scopeFor(rule.dimension);
    if (!charges.has(rule.dimension)) charges.set(rule.dimension, new Map());
    const byRecord = charges.get(rule.dimension);
    for (const id of f.target_ids) {
      if (!inDim.has(id)) continue;
      if (!byRecord.has(id)) byRecord.set(id, []);
      byRecord.get(id).push({ key: f.dedupe_key || f.fingerprint, band: band(f, id), multiplier: f.deduction_multiplier_by_record?.[id] ?? f.deduction_multiplier ?? 1 });
    }
  }

  const ciById = new Map(cis.map((c) => [c.sys_id, c]));
  const tierCache = new Map();
  const tier = (id) => { if (!tierCache.has(id)) tierCache.set(id, tierOf(ciById.get(id), signals)); return tierCache.get(id); };

  const dimensions = v1.dimensions.map((d) => {
    if (!d.measured) return { ...d };
    let recordPart = null;
    let tierMeans = null;
    if (d.record_part != null) {
      const byRecord = charges.get(d.key) || new Map();
      const records = [...scopeFor(d.key)].map((id) => ({ tier: tier(id), charges: byRecord.get(id) || [] }));
      recordPart = methodR(records, { aggregation: config.record.aggregation, tierWeights: config.record.tier_weights }).score;
      tierMeans = {};
      for (const t of ['bc', 'core', 'other', 'endpoint']) {
        const rs = records.filter((r) => r.tier === t);
        if (rs.length) tierMeans[t] = { records: rs.length, mean: round1(methodR(rs, { aggregation: 'record_mean' }).score), weight: config.record.tier_weights[t] ?? 1 };
      }
    }
    let kpiPart = null;
    let kpiRows = d.kpis || [];
    if (d.kpi_part != null && kpiRows.length) {
      kpiRows = kpiRows.map((k) => {
        /* A custom rule (D-038) carries its own target: the good share its limit implies. */
        const target = kpiTarget(k.rule_id, options) ?? (Number.isFinite(k.target_pct) ? k.target_pct : null);
        const a = attainment('good_share', { measured: k.pass_pct / 100, target: (target ?? 100) / 100 }, config.curve);
        return { ...k, target_pct: target, target_basis: target == null ? 'no percentage threshold: scored on the raw share' : 'the rule\'s resolved threshold', attainment: Number(a.toFixed(3)), base: CMDB_CATALOGUE[k.rule_id]?.base ?? k.base ?? null };
      });
      kpiPart = methodC(kpiRows.map((k) => ({ id: k.rule_id, base: k.base, attainment: k.attainment })), { aggregation: config.control.aggregation }).score;
    }
    const kind = DIMENSION_KIND[d.key] || 'mixed';
    const betas = config.blends[kind] ?? config.blends.mixed;
    const score = blend(recordPart, kpiPart, betas);
    return {
      ...d,
      score: round1(score),
      record_part: round1(recordPart),
      kpi_part: round1(kpiPart),
      blend: recordPart != null && kpiPart != null ? { record: betas, kpi: Number((1 - betas).toFixed(2)), kind } : null,
      kpis: kpiRows,
      record_tiers: tierMeans,
      v1: { score: d.score, record_part: d.record_part, kpi_part: d.kpi_part },
    };
  });

  const composite = moduleScore(dimensions.filter((d) => d.measured).map((d) => ({ key: d.key, weight: d.weight, score: d.score }))).score;
  const c1 = v1.composite;
  const gateOpen = !v1.gate?.trustworthy;
  const variants = (c1.variants || []).map((v) => (v.key === 'gate'
    ? { ...v, value: composite == null ? null : round1(composite), caveat: gateOpen ? `${v.caveat} The number is shown, never hidden (health-quality/2); read it with the blockers.` : v.caveat }
    : { ...v, value: composite == null ? null : round1(composite) }));

  return {
    ...v1,
    model: 'CMDB Quality',
    model_id: CMDB_MODEL_V2,
    scoring_key: cmdbScoringKeyV2(config),
    dimensions,
    composite: {
      ...c1,
      score: round1(composite),
      variants,
      definition: 'Σ workbook weight × dimension score over measured dimensions ÷ their weight. A dimension blends its record part — the mean of each consequence tier\'s mean record score (a record starts at 100 and loses the weight of each distinct defect on it) — with its KPI part: each percentage rule starts at full and loses its severity weight × (1 − attainment²) against its own threshold.',
    },
    method: {
      model: CMDB_MODEL_V2,
      decision: 'D-016',
      record_aggregation: config.record.aggregation,
      tier_weights: config.record.tier_weights,
      tiers_basis: signals?.hierarchyOk ? 'class hierarchy and Business Critical support' : 'class names only — the class hierarchy could not be read',
      kpi_curve: config.curve,
      kpi_aggregation: config.control.aggregation,
      blends: config.blends,
    },
  };
}
