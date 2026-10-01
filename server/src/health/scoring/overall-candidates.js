
/**
 * CANDIDATE OVERALL AGGREGATIONS — Phase 3 (docs/HEALTH-ASSIST-APPROACH.md §9).
 *
 * Decision D-006: the Overall is a configurable model, chosen only after scenario
 * testing, and it must never hide a materially unhealthy module — in the number
 * or in the word. Each candidate below is one answer to that; calibration
 * (calibration.js) decides which survive. None is the default: the running Overall
 * is still overall-health/1 (equal-weight mean) until Phase 8 promotes one.
 *
 * The bands are the vocabulary the calibration was run under (Phase 3, D-028):
 * Healthy ≥ 90, Mostly healthy ≥ 75, Needs attention ≥ 50, Needs work < 50. They are
 * kept here so the committed calibration stays reproducible; the product shows three
 * bands since D-036 (overall-health.js HEALTH_BANDS). Band rank 0 is best.
 *
 * Every candidate takes `modules: [{ key, score, weight }]` over the PARTICIPATING
 * modules (scored, applicable, above the coverage floor) and returns
 * `{ score, band, band_rank }`.
 */

const round = (x) => (x == null || !Number.isFinite(x) ? null : Number(x.toFixed(3)));
const weightedMean = (mods) => {
  const w = mods.reduce((n, m) => n + m.weight, 0);
  return w ? mods.reduce((n, m) => n + m.weight * m.score, 0) / w : null;
};
export const CALIBRATION_BANDS = Object.freeze([
  { key: 'healthy', min: 90 }, { key: 'mostly_healthy', min: 75 }, { key: 'needs_attention', min: 50 }, { key: 'needs_work', min: 0 },
]);
const rankOf = (score) => (score == null || !Number.isFinite(score) ? null : Math.max(0, CALIBRATION_BANDS.findIndex((b) => score >= b.min)));
const bandAt = (rank) => CALIBRATION_BANDS[rank]?.key ?? null;
const result = (score, rank = rankOf(score)) => ({ score: round(score), band: score == null ? null : bandAt(rank), band_rank: score == null ? null : rank });

export const OVERALL_CANDIDATES = Object.freeze({
  /** Today's shape (overall-health/1): the weighted mean, no protection. */
  weighted_mean: {
    params: [],
    describe: () => 'weighted mean',
    compute: (mods) => result(weightedMean(mods)),
  },
  /** The number stays the mean; the WORD is capped at k bands better than the worst module. */
  band_cap: {
    params: ['k'],
    describe: (p) => `weighted mean, band capped at ${p.k} band(s) better than the worst module`,
    compute: (mods, p) => {
      const mean = weightedMean(mods);
      if (mean == null) return result(null);
      const worst = Math.max(...mods.map((m) => rankOf(m.score)));
      return result(mean, Math.max(rankOf(mean), worst - p.k));
    },
  },
  /** The mean, minus λ × the weighted shortfall of modules below the unhealthy level. */
  penalised_mean: {
    params: ['lambda', 'threshold'],
    describe: (p) => `weighted mean − ${p.lambda} × weighted shortfall below ${p.threshold}`,
    compute: (mods, p) => {
      const mean = weightedMean(mods);
      if (mean == null) return result(null);
      const w = mods.reduce((n, m) => n + m.weight, 0);
      const shortfall = mods.reduce((n, m) => n + m.weight * Math.max(0, p.threshold - m.score), 0) / w;
      return result(Math.max(0, mean - p.lambda * shortfall));
    },
  },
  /** The generalised mean (Σ w·s^p ÷ Σ w)^(1/p); p < 1 gives low scores more pull; p = 0 is geometric. */
  power_mean: {
    params: ['p'],
    describe: (q) => (q.p === 0 ? 'weighted geometric mean' : `weighted power mean, p = ${q.p}`),
    compute: (mods, q) => {
      const w = mods.reduce((n, m) => n + m.weight, 0);
      if (!w) return result(null);
      if (mods.some((m) => m.score <= 0)) return result(q.p <= 0 ? 0 : (mods.reduce((n, m) => n + m.weight * m.score ** q.p, 0) / w) ** (1 / q.p));
      if (q.p === 0) return result(Math.exp(mods.reduce((n, m) => n + m.weight * Math.log(m.score), 0) / w));
      return result((mods.reduce((n, m) => n + m.weight * m.score ** q.p, 0) / w) ** (1 / q.p));
    },
  },
  /** λ·mean + (1 − λ)·min — the weakest module always pulls. */
  min_blend: {
    params: ['lambda'],
    describe: (p) => `${p.lambda} × weighted mean + ${round(1 - p.lambda)} × weakest module`,
    compute: (mods, p) => {
      const mean = weightedMean(mods);
      if (mean == null) return result(null);
      return result(p.lambda * mean + (1 - p.lambda) * Math.min(...mods.map((m) => m.score)));
    },
  },
});

/** Run one candidate: `{ kind, params }`. */
export function overallScore(modules, candidate) {
  const c = OVERALL_CANDIDATES[candidate.kind];
  if (!c) throw new Error(`unknown overall candidate "${candidate.kind}"`);
  for (const p of c.params) if (candidate.params?.[p] == null) throw new Error(`${candidate.kind} needs parameter ${p}`);
  const mods = modules.filter((m) => m.score != null && m.weight > 0);
  return { ...c.compute(mods, candidate.params || {}), candidate: candidate.kind, describe: c.describe(candidate.params || {}) };
}

export const bandRank = rankOf;
export const bandKeyAt = bandAt;
