/**
 * THE SCORING KERNEL — Phase 3 of docs/HEALTH-ASSIST-APPROACH.md (§8, §9, §10).
 *
 * PURE ARITHMETIC. No module, no run, no database. Every constant is an argument:
 * the kernel holds no default for anything the workbook does not state. The
 * workbook states the severity weights (Systemic 100 · Critical 40 · High 15 ·
 * Moderate 5 · Low 1), and those are the only numbers written here.
 *
 * NOT WIRED. Phase 3 builds and CALIBRATES the methods; nothing in the running
 * scan imports this folder (test/health-scoring-kernel.test.js holds that). A
 * model is promoted only in Phase 4, from a passing calibration report, by
 * decision D-008.
 *
 * ═══ THE TWO METHODS ═══
 *
 *   Method R — population health ("what share of the maintained population is in
 *   good condition?"). A record starts at 100 and loses the weight of each
 *   DISTINCT charge on it (one defect, one charge: charges sharing a key pay the
 *   heaviest once), floored at 0. The dimension aggregates record scores one of
 *   three ways — which one is exactly what calibration decides:
 *     record_mean            every record counts once (today's CMDB)
 *     consequence_weighted   Σ c(r)·score ÷ Σ c(r), c = the record's tier weight
 *     tier_stratified        the mean of each tier's mean, weighted by tier weight —
 *                            a tier's size no longer moves the number
 *
 *   Method C — control attainment ("how much of what should work does, weighted by
 *   how bad each failure is?"):
 *     C = 100 × max(0, 1 − Σ w(effective)·(1 − a) ÷ Σ w(base))
 *   over evaluated, applicable, scorable rules. Rules of one FAMILY (one condition
 *   several rules restate) count once: the heaviest base, the worst attainment.
 *
 * ═══ ATTAINMENT, from the workbook's own threshold form ═══
 *   binary       "any occurrence" / "absence": 1 pass, 0 fail
 *   good_share   a share that should reach a target (coverage 85%)
 *   bad_rate     a rate that should stay under a limit (reopen rate 8%)
 *   none         trend, correlation, context: not scored
 * with a CURVE for the graded forms — linear, step or convex — also calibrated.
 */

export const WORKBOOK_BAND_WEIGHT = Object.freeze({ SYSTEMIC: 100, CRITICAL: 40, HIGH: 15, MEDIUM: 5, LOW: 1 });
const BAND_ALIAS = Object.freeze({ Systemic: 'SYSTEMIC', Critical: 'CRITICAL', High: 'HIGH', Moderate: 'MEDIUM', Low: 'LOW' });
export const bandKey = (b) => BAND_ALIAS[b] ?? b;
export const bandWeight = (b, weights = WORKBOOK_BAND_WEIGHT) => weights[bandKey(b)] ?? 0;

export const RECORD_AGGREGATIONS = Object.freeze(['record_mean', 'consequence_weighted', 'tier_stratified']);
export const CURVES = Object.freeze(['linear', 'step', 'convex']);

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const round = (x, d = 3) => (x == null || !Number.isFinite(x) ? null : Number(x.toFixed(d)));

/* ── attainment ─────────────────────────────────────────────────────────── */

/**
 * @param {'binary'|'good_share'|'bad_rate'|'none'} form
 * @param {object} v   { passed } for binary; { measured, target } for good_share; { measured, limit } for bad_rate — all as 0..1 shares
 * @param {'linear'|'step'|'convex'} curve
 * @returns {number|null}  0..1, or null when the form is not scored
 */
export function attainment(form, v = {}, curve = 'linear') {
  if (form === 'none') return null;
  if (form === 'binary') return v.passed ? 1 : 0;
  let ratio;
  if (form === 'good_share') {
    if (!(v.target > 0)) throw new Error('good_share needs a target > 0');
    ratio = v.measured / v.target;
  } else if (form === 'bad_rate') {
    if (!(v.limit >= 0 && v.limit < 1)) throw new Error('bad_rate needs a limit in [0, 1)');
    ratio = (1 - v.measured) / (1 - v.limit);
  } else throw new Error(`unknown attainment form "${form}"`);
  if (!Number.isFinite(ratio)) return 0;
  if (curve === 'step') return ratio >= 1 ? 1 : 0;
  if (curve === 'convex') return clamp01(ratio) ** 2;
  if (curve === 'linear') return clamp01(ratio);
  throw new Error(`unknown curve "${curve}"`);
}

/* ── Method R ───────────────────────────────────────────────────────────── */

/** One record's score: 100 − Σ over DISTINCT charge keys of the heaviest weight × multiplier, floored at 0. */
export function recordScore(charges = [], weights = WORKBOOK_BAND_WEIGHT) {
  const byKey = new Map();
  charges.forEach((c, i) => {
    const w = bandWeight(c.band, weights) * (c.multiplier ?? 1);
    /* A charge with no key is its own defect. */
    const k = c.key ?? `#${i}`;
    byKey.set(k, Math.max(byKey.get(k) ?? 0, w));
  });
  let lost = 0;
  for (const w of byKey.values()) lost += w;
  return Math.max(0, 100 - lost);
}

/**
 * @param {object[]} records   [{ tier, charges: [{ key, band, multiplier? }], count? }] — `count` repeats a record shape
 * @param {object}   opts      { aggregation, tierWeights: { tier: weight } }
 */
export function methodR(records = [], { aggregation = 'record_mean', tierWeights = {}, weights = WORKBOOK_BAND_WEIGHT } = {}) {
  if (!RECORD_AGGREGATIONS.includes(aggregation)) throw new Error(`unknown record aggregation "${aggregation}"`);
  const tw = (t) => (aggregation === 'record_mean' ? 1 : (tierWeights[t] ?? 1));
  let n = 0;
  if (aggregation !== 'tier_stratified') {
    let num = 0; let den = 0;
    for (const r of records) {
      const count = r.count ?? 1;
      const s = recordScore(r.charges, weights);
      num += tw(r.tier) * s * count; den += tw(r.tier) * count; n += count;
    }
    return { score: den ? round(num / den, 3) : null, records: n };
  }
  const tiers = new Map();
  for (const r of records) {
    const count = r.count ?? 1;
    const t = tiers.get(r.tier) ?? { sum: 0, n: 0 };
    t.sum += recordScore(r.charges, weights) * count; t.n += count; n += count;
    tiers.set(r.tier, t);
  }
  let num = 0; let den = 0;
  for (const [tier, t] of tiers) { if (!t.n) continue; num += tw(tier) * (t.sum / t.n); den += tw(tier); }
  return { score: den ? round(num / den, 3) : null, records: n };
}

/* ── Method C ───────────────────────────────────────────────────────────── */

/**
 * HOW A DIMENSION'S CONTROLS AGGREGATE — the candidates calibration compares
 * (added after Phase 3 found the weight share diluted by rule count):
 *
 *   weight_share              100 × (1 − Σ w_eff·(1−a) ÷ Σ w_base). A failure costs its weight's SHARE of
 *                             every rule written: the more passing rules a dimension has, the less any failure
 *                             counts. The real ITSM incident dimension weighs 2,020, so one Systemic failure
 *                             moves it 5 points.
 *   severity_stratified       Σ_b w_b · (mean attainment in band b) ÷ Σ_b w_b over the bands present — rule
 *                             COUNT per band no longer matters, but the share of a band that fails still does.
 *   deduction_additive        max(0, 100 − Σ w_eff·(1−a)) — the workbook's own semantics, exactly as a record
 *                             is scored: a dimension starts at 100 and loses each failure's severity weight. A
 *                             failure costs what its severity says, however many rules pass beside it.
 *   deduction_multiplicative  100 × Π (1 − min(1, w_eff/100)·(1−a)) — the same weights, each failure removing its
 *                             weight as a share of the health that REMAINS: a Systemic failure still zeroes the
 *                             dimension, lesser failures never reach 0 on their own, and every further failure
 *                             still lowers the score.
 * Passing rules never raise a deduction score; unevaluated and inapplicable rules leave every method.
 */
export const CONTROL_AGGREGATIONS = Object.freeze(['weight_share', 'severity_stratified', 'deduction_additive', 'deduction_multiplicative']);

/**
 * @param {object[]} rules  [{ id, base, effective?, attainment (0..1|null), family?, evaluated?, applicable? }]
 * @returns {{ score: number|null, weight_base: number, loss: number, rules: number }}
 */
export function methodC(rules = [], { weights = WORKBOOK_BAND_WEIGHT, aggregation = 'weight_share' } = {}) {
  if (!CONTROL_AGGREGATIONS.includes(aggregation)) throw new Error(`unknown control aggregation "${aggregation}"`);
  const groups = new Map();
  for (const r of rules) {
    if (r.applicable === false || r.evaluated === false || r.attainment == null) continue;
    const key = r.family ?? r.id;
    const cur = groups.get(key);
    const base = bandWeight(r.base, weights);
    const eff = bandWeight(r.effective ?? r.base, weights);
    if (!cur) groups.set(key, { base, eff, a: r.attainment });
    else groups.set(key, { base: Math.max(cur.base, base), eff: Math.max(cur.eff, eff), a: Math.min(cur.a, r.attainment) });
  }
  let den = 0; let loss = 0;
  for (const g of groups.values()) { den += g.base; loss += g.eff * (1 - g.a); }
  const out = (score) => ({ score: groups.size ? round(score, 3) : null, weight_base: den, loss: round(loss, 3), rules: groups.size });
  if (!groups.size) return out(null);
  if (aggregation === 'weight_share') return out(den ? 100 * Math.max(0, 1 - loss / den) : null);
  if (aggregation === 'deduction_additive') return out(Math.max(0, 100 - loss));
  if (aggregation === 'deduction_multiplicative') {
    let keep = 1;
    for (const g of groups.values()) keep *= 1 - Math.min(1, g.eff / 100) * (1 - g.a);
    return out(100 * keep);
  }
  /* severity_stratified: each band present weighs its band weight once, whatever its rule count. */
  const bands = new Map();
  for (const g of groups.values()) {
    const b = bands.get(g.base) ?? { sum: 0, n: 0, eff: 0 };
    b.sum += g.a; b.n += 1; bands.set(g.base, b);
  }
  let num = 0; let wsum = 0;
  for (const [w, b] of bands) { num += w * (b.sum / b.n); wsum += w; }
  return out(wsum ? (100 * num) / wsum : null);
}

/** β·R + (1 − β)·C; either alone when the other is absent. */
export function blend(r, c, beta) {
  if (r == null) return c;
  if (c == null) return r;
  return round(beta * r + (1 - beta) * c, 3);
}

/**
 * Σ W_d·S_d ÷ Σ W_d over dimensions that are applicable and measured. A missing
 * dimension is renormalised away — never 0, never 100.
 * @param {object[]} dims  [{ key, weight, score|null, applicable? }]
 */
export function moduleScore(dims = []) {
  const used = dims.filter((d) => d.applicable !== false && d.score != null && d.weight > 0);
  const w = used.reduce((n, d) => n + d.weight, 0);
  return { score: w ? round(used.reduce((n, d) => n + d.weight * d.score, 0) / w, 3) : null, measured_weight: w, dimensions: used.length };
}
