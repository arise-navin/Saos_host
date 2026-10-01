import { methodR, methodC, attainment } from './kernel.js';
import { evaluateScenario, dimensionScore } from './evaluate.js';
import { overallScore, bandRank, OVERALL_CANDIDATES } from './overall-candidates.js';
import { ALL_SCENARIOS as SCENARIOS, scenarioBuilders as B } from './scenarios.js';

/**
 * THE CALIBRATION HARNESS — Phase 3 of docs/HEALTH-ASSIST-APPROACH.md (§10).
 *
 * Decision D-008: no weight, tier, curve, blend or floor becomes a default until
 * it passes scenario and sensitivity testing. This module is that test. It is
 * PURE and DETERMINISTIC (no clock, no randomness), so the committed report is
 * reproducible and the suite fails if it goes stale.
 *
 * It calibrates one AXIS at a time — record aggregation, attainment curve,
 * Overall aggregation, coverage floor — holding the others at their stated
 * baseline, because the axes answer independent questions. For every option it
 * runs the acceptance properties relevant to that axis, every scenario's
 * expectations, and a ±perturbation sweep of the option's own numbers. It then
 * names a LEADER per axis and runs everything again on the combined leaders.
 *
 * It PROMOTES NOTHING. The report says `promoted: false`; Phase 4/8 promote a
 * model only by decision, from a report that passes.
 *
 * ═══ THE EIGHT ACCEPTANCE PROPERTIES ═══
 *   P1 monotonicity         fixing a defect never lowers a score; adding one never raises it
 *   P2 severity ordering    one Systemic failure costs more than one Critical, > High > Moderate > Low
 *   P3 no masking           one materially unhealthy module shows in the Overall's band AND number
 *   P4 dilution resistance  growing a clean low-consequence tail does not lift a defective core
 *   P5 authoring invariance restating one condition as two rules (one family / one key) changes nothing
 *   P6 coverage honesty     an unevaluated rule never scores better than the same rule passing
 *   P7 applicability neutral an excluded (not-in-use) dimension equals an absent one
 *   P8 stability            ±perturbation of the option's numbers moves no score by more than the tolerance
 */

export const CALIBRATION_VERSION = 'calibration/2';
const EPS = 1e-6;
const BANDS = ['Systemic', 'Critical', 'High', 'Moderate', 'Low'];
const clone = (x) => JSON.parse(JSON.stringify(x));

/* ── configurations ───────────────────────────────────────────────────── */

function optionById(candidates, axis, id) {
  const o = candidates.axes[axis].options.find((x) => x.id === id);
  if (!o) throw new Error(`no ${axis} option ${id}`);
  return o;
}

/** A full configuration: the baseline with the given axis options substituted. */
export function configFrom(candidates, picks = {}) {
  const base = candidates.held_constant_while_other_axes_vary;
  const ids = { record_aggregation: base.record_aggregation, attainment_curve: base.attainment_curve, overall: base.overall, systemic_treatment: base.systemic_treatment, control_aggregation: base.control_aggregation, coverage_floor: base.coverage_floor, ...picks };
  const r = optionById(candidates, 'record_aggregation', ids.record_aggregation);
  const a = optionById(candidates, 'attainment_curve', ids.attainment_curve);
  const o = optionById(candidates, 'overall', ids.overall);
  const f = optionById(candidates, 'coverage_floor', ids.coverage_floor);
  const t = optionById(candidates, 'systemic_treatment', ids.systemic_treatment);
  const ca = optionById(candidates, 'control_aggregation', ids.control_aggregation);
  return {
    ids,
    record: { aggregation: r.aggregation, tier_weights: r.tier_weights || {} },
    curve: a.curve,
    control: { aggregation: ca.aggregation },
    blends: { ...base.blends },
    overall: { kind: o.kind, params: { ...o.params } },
    floor: f.floor,
    systemic: t.cap ? { ...t.cap } : null,
  };
}

const moduleScoreOf = (mod, config) => evaluateScenario({ modules: { m: mod } }, { ...config, floor: 0 }).modules.m.score;

/* ── the properties ───────────────────────────────────────────────────── */

function p1Monotonic(config, which) {
  const violations = [];
  for (const sc of SCENARIOS) {
    for (const [mk, mod] of Object.entries(sc.modules)) {
      const base = moduleScoreOf(mod, config);
      mod.dims.forEach((dim, di) => {
        if ((which === 'C' || which === 'all') && dim.rules) {
          dim.rules.forEach((rule, ri) => {
            const a = attainment(rule.form, rule.value, config.curve);
            /* Deterministic sampling on the large catalogue dimensions: every failing rule, every 25th passing one. */
            if (dim.rules.length > 30 && a >= 1 && ri % 25 !== 0) return;
            const variant = clone(mod);
            const target = variant.dims[di].rules[ri];
            if (a < 1) {
              target.form = 'binary'; target.value = { passed: true };
              if (moduleScoreOf(variant, config) < base - EPS) violations.push(`${sc.id} ${mk}.${dim.key}: fixing ${rule.id} lowered the score`);
            } else {
              target.form = 'binary'; target.value = { passed: false };
              if (moduleScoreOf(variant, config) > base + EPS) violations.push(`${sc.id} ${mk}.${dim.key}: failing ${rule.id} raised the score`);
            }
          });
        }
        if ((which === 'R' || which === 'all') && dim.records && mod.method === 'R') {
          dim.records.forEach((grp, gi) => {
            if ((grp.count ?? 1) < 1) return;
            const variant = clone(mod);
            const recs = variant.dims[di].records;
            recs[gi].count = (grp.count ?? 1) - 1;
            if (grp.charges.length) {
              recs.push({ tier: grp.tier, count: 1, charges: [] });
              if (moduleScoreOf(variant, config) < base - EPS) violations.push(`${sc.id} ${mk}.${dim.key}: fixing one ${grp.tier} record lowered the score`);
            } else {
              recs.push({ tier: grp.tier, count: 1, charges: [{ key: 'new', band: 'LOW' }] });
              if (moduleScoreOf(variant, config) > base + EPS) violations.push(`${sc.id} ${mk}.${dim.key}: a new defect on a ${grp.tier} record raised the score`);
            }
          });
        }
      });
    }
    if (which === 'overall' || which === 'all') {
      const res = evaluateScenario(sc, config);
      const mods = Object.entries(res.modules).filter(([, m]) => m.participates).map(([key, m]) => ({ key, score: m.score, weight: m.weight }));
      const base = res.overall.score;
      for (const m of mods) {
        const up = overallScore(mods.map((x) => (x.key === m.key ? { ...x, score: Math.min(100, x.score + 5) } : x)), config.overall).score;
        const down = overallScore(mods.map((x) => (x.key === m.key ? { ...x, score: Math.max(0, x.score - 5) } : x)), config.overall).score;
        if (up < base - EPS) violations.push(`${sc.id}: raising ${m.key} lowered the Overall`);
        if (down > base + EPS) violations.push(`${sc.id}: lowering ${m.key} raised the Overall`);
      }
    }
  }
  return { pass: violations.length === 0, violations: violations.slice(0, 10), violation_count: violations.length };
}

function p2SeverityOrdering(config, which) {
  const scores = {};
  for (const band of BANDS) {
    if (which === 'C') scores[band] = moduleScoreOf({ method: 'C', dims: [B.controls('x', [B.fail('probe', band)])] }, config);
    else scores[band] = methodR([B.clean('other', 99), B.charged('other', 1, { Systemic: 'SYSTEMIC', Critical: 'CRITICAL', High: 'HIGH', Moderate: 'MEDIUM', Low: 'LOW' }[band])], { aggregation: config.record.aggregation, tierWeights: config.record.tier_weights }).score;
  }
  const ordered = BANDS.slice(1).every((b, i) => scores[b] > scores[BANDS[i]] + EPS);
  return { pass: ordered, scores };
}

function p3NoMasking(config, acceptance) {
  const violations = [];
  for (const n of [3, 4, 5]) {
    for (const h of [90, 95, 100]) {
      for (const u of [10, 30, acceptance.unhealthy_below - 1]) {
        const mods = Array.from({ length: n }, (_, i) => ({ key: `m${i}`, weight: 1, score: i === 0 ? u : h }));
        const o = overallScore(mods, config.overall);
        const bandOk = o.band_rank >= bandRank(u) - acceptance.masking_band_slack;
        const numberOk = bandRank(o.score) === o.band_rank;
        if (!bandOk || !numberOk) violations.push(`${n} modules, healthy at ${h}, one at ${u}: Overall ${o.score} shown as ${o.band}${numberOk ? '' : ' (the number is outside its band)'}`);
      }
    }
  }
  return { pass: violations.length === 0, violations: violations.slice(0, 6), violation_count: violations.length };
}

function p4Dilution(config, acceptance) {
  const at = (tail) => methodR([B.charged('core', 10, 'CRITICAL'), B.clean('endpoint', tail)], { aggregation: config.record.aggregation, tierWeights: config.record.tier_weights }).score;
  const small = at(10);
  const large = at(10000);
  return { pass: large - small <= acceptance.dilution_tolerance_points + EPS, core_with_10_endpoints: small, core_with_10000_endpoints: large, drift: Number((large - small).toFixed(3)) };
}

function p5Authoring(config, which) {
  if (which === 'C') {
    const one = moduleScoreOf({ method: 'C', dims: [B.controls('x', [B.fail('a', 'Critical', { family: 'F' })])] }, config);
    const two = moduleScoreOf({ method: 'C', dims: [B.controls('x', [B.fail('a', 'Critical', { family: 'F' }), B.fail('b', 'Critical', { family: 'F' })])] }, config);
    const unrelated = moduleScoreOf({ method: 'C', dims: [B.controls('x', [B.fail('a', 'Critical'), B.fail('b', 'Critical')])] }, config);
    return { pass: Math.abs(one - two) < EPS, one_rule: one, restated_same_family: two, restated_without_family: unrelated, note: 'Invariance holds only for rules declared one family (ownership / defect family); two unrelated rules are two conditions.' };
  }
  const r = (charges) => methodR([{ tier: 'other', count: 1, charges }, B.clean('other', 99)], { aggregation: config.record.aggregation, tierWeights: config.record.tier_weights }).score;
  const one = r([{ key: 'k', band: 'CRITICAL' }]);
  const two = r([{ key: 'k', band: 'CRITICAL' }, { key: 'k', band: 'CRITICAL' }]);
  return { pass: Math.abs(one - two) < EPS, one_charge: one, restated_same_key: two };
}

function p6CoverageHonesty(config) {
  const mk = (extra) => moduleScoreOf({ method: 'C', dims: [B.controls('x', [B.fail('y', 'High'), extra])] }, config);
  const failing = mk(B.fail('z', 'Critical'));
  const unevaluated = mk({ ...B.fail('z', 'Critical'), evaluated: false });
  const passing = mk(B.pass('z', 'Critical'));
  return { pass: unevaluated <= passing + EPS, failing, unevaluated, passing, note: 'An unevaluated rule leaves the denominator: it can never score better than passing. What it hides is carried by assessment coverage and validity, never by the number.' };
}

function p7Applicability(config, which) {
  const dims = which === 'C'
    ? [B.controls('a', [B.fail('f', 'High')]), B.controls('b')]
    : [{ key: 'a', weight: 1, kind: 'record', records: [B.charged('other', 10, 'HIGH'), B.clean('other', 90)] }, { key: 'b', weight: 1, kind: 'record', records: [B.clean('other', 100)] }];
  const method = which === 'C' ? 'C' : 'R';
  const extra = which === 'C' ? { ...B.controls('z', [B.fail('q', 'Systemic')]), applicable: false } : { key: 'z', weight: 1, kind: 'record', records: [B.charged('other', 50, 'CRITICAL')], applicable: false };
  const excluded = moduleScoreOf({ method, dims: [...dims, extra] }, config);
  const absent = moduleScoreOf({ method, dims }, config);
  return { pass: Math.abs(excluded - absent) < EPS, excluded, absent };
}

/** ±perturbation of the numbers an option carries; the largest move of any module or Overall score, across every scenario. */
function p8Stability(config, axis, acceptance) {
  const f = acceptance.stability_perturbation;
  const variants = [];
  if (axis === 'record_aggregation' || axis === 'combined') {
    for (const t of Object.keys(config.record.tier_weights || {})) {
      for (const k of [1 - f, 1 + f]) {
        const c = clone(config); c.record.tier_weights[t] *= k; variants.push([`tier ${t} ×${k}`, c]);
      }
    }
    for (const b of Object.keys(config.blends)) {
      for (const d of [-0.05, 0.05]) { const c = clone(config); c.blends[b] = Math.min(1, Math.max(0, c.blends[b] + d)); variants.push([`blend ${b} ${d > 0 ? '+' : ''}${d}`, c]); }
    }
  }
  if (axis === 'overall' || axis === 'combined') {
    for (const [p, v] of Object.entries(config.overall.params)) {
      if (p === 'k') continue;
      for (const k of p === 'p' ? [-0.1, 0.1] : [1 - f, 1 + f]) {
        const c = clone(config);
        c.overall.params[p] = p === 'p' ? v + k : v * k;
        variants.push([`overall ${p} ${p === 'p' ? (k > 0 ? '+' : '') + k : `×${k}`}`, c]);
      }
    }
  }
  if (axis === 'coverage_floor' || axis === 'combined') {
    for (const d of [-0.05, 0.05]) { const c = clone(config); c.floor += d; variants.push([`floor ${d > 0 ? '+' : ''}${d}`, c]); }
  }
  const base = SCENARIOS.map((sc) => evaluateScenario(sc, config));
  const deltas = {};
  for (const [label, c] of variants) {
    let max = 0;
    SCENARIOS.forEach((sc, i) => {
      const v = evaluateScenario(sc, c);
      for (const m of Object.keys(v.modules)) max = Math.max(max, Math.abs((v.modules[m].score ?? 0) - (base[i].modules[m].score ?? 0)));
      max = Math.max(max, Math.abs((v.overall.score ?? 0) - (base[i].overall.score ?? 0)));
    });
    deltas[label] = Number(max.toFixed(3));
  }
  const worst = Math.max(0, ...Object.values(deltas));
  return { pass: worst <= acceptance.stability_tolerance_points + EPS, max_delta: worst, deltas, note: variants.length ? null : 'this option carries no tunable numbers' };
}

/* ── scenarios ────────────────────────────────────────────────────────── */

export function runExpectations(config, acceptance) {
  const out = [];
  for (const sc of SCENARIOS) {
    const r = evaluateScenario(sc, config);
    for (const e of sc.expect) out.push({ scenario: sc.id, expectation: e.id, pass: Boolean(e.check(r, acceptance)) });
    if (sc.compare) out.push({ scenario: sc.id, expectation: sc.compare.id, pass: Boolean(sc.compare.check(r, evaluateScenario({ modules: sc.compare.with }, config), acceptance)) });
  }
  return out;
}

/* ── one axis ─────────────────────────────────────────────────────────── */

const AXIS_PROPERTIES = {
  record_aggregation: (c, acc) => ({ P1: p1Monotonic(c, 'R'), P2: p2SeverityOrdering(c, 'R'), P4: p4Dilution(c, acc), P5: p5Authoring(c, 'R'), P7: p7Applicability(c, 'R'), P8: p8Stability(c, 'record_aggregation', acc) }),
  control_aggregation: (c) => ({ P1: p1Monotonic(c, 'C'), P2: p2SeverityOrdering(c, 'C'), P5: p5Authoring(c, 'C'), P6: p6CoverageHonesty(c), P7: p7Applicability(c, 'C') }),
  attainment_curve: (c) => ({ P1: p1Monotonic(c, 'C'), P2: p2SeverityOrdering(c, 'C'), P5: p5Authoring(c, 'C'), P6: p6CoverageHonesty(c), P7: p7Applicability(c, 'C') }),
  overall: (c, acc) => ({ P1: p1Monotonic(c, 'overall'), P3: p3NoMasking(c, acc), P8: p8Stability(c, 'overall', acc) }),
  systemic_treatment: (c) => ({ P1: p1Monotonic(c, 'all'), P2: { C: p2SeverityOrdering(c, 'C'), R: p2SeverityOrdering(c, 'R'), get pass() { return this.C.pass && this.R.pass; } } }),
  coverage_floor: (c, acc) => ({ P6: p6CoverageHonesty(c), P8: p8Stability(c, 'coverage_floor', acc) }),
};

function describeOption(axis, o) {
  if (axis === 'record_aggregation') return `${o.aggregation}${o.tier_weights ? ` (bc ${o.tier_weights.bc} · core ${o.tier_weights.core} · other ${o.tier_weights.other} · endpoint ${o.tier_weights.endpoint})` : ''}`;
  if (axis === 'attainment_curve') return `${o.curve} curve`;
  if (axis === 'control_aggregation') return o.aggregation.replace(/_/g, ' ');
  if (axis === 'overall') return OVERALL_CANDIDATES[o.kind].describe(o.params);
  if (axis === 'systemic_treatment') return o.cap ? `${o.cap.level} capped at ${o.cap.at} while a Systemic defect stands` : 'no Systemic cap';
  return `floor ${o.floor}`;
}

function calibrateAxis(candidates, axis, held = {}) {
  const acc = candidates.acceptance;
  const options = candidates.axes[axis].options.map((o) => {
    const config = configFrom(candidates, { ...held, [axis]: o.id });
    const properties = AXIS_PROPERTIES[axis](config, acc);
    const expectations = runExpectations(config, acc);
    const propFails = Object.entries(properties).filter(([, v]) => !v.pass).map(([k]) => k);
    const expFails = expectations.filter((e) => !e.pass).map((e) => `${e.scenario}: ${e.expectation}`);
    return {
      id: o.id, describe: describeOption(axis, o), note: o.note ?? null, mechanism: Boolean(o.mechanism), preferred: o.preferred ?? null,
      properties, property_failures: propFails,
      expectations_passed: expectations.filter((e) => e.pass).length, expectations_total: expectations.length, expectation_failures: expFails,
      passes_all: propFails.length === 0 && expFails.length === 0,
      stability: properties.P8?.max_delta ?? null,
    };
  });
  /*
   * An axis is judged on what DISTINGUISHES its options. A scenario that every
   * option on the axis fails is not this axis's doing — the other axes sit at
   * their baseline while this one varies — so it is reported as shared and does
   * not count against any option here. It is judged again on the combined leaders.
   */
  const shared = options.map((o) => new Set(o.expectation_failures)).reduce((acc, s) => new Set([...acc].filter((x) => s.has(x))));
  for (const o of options) {
    o.distinguishing_failures = o.expectation_failures.filter((f) => !shared.has(f));
    o.passes_axis = o.property_failures.length === 0 && o.distinguishing_failures.length === 0;
  }
  /* Leader (candidates.tie_break): passes the axis; fewest failures; no added mechanism; the option already held; most scenarios passed; most stable; list order. */
  const key = (o) => [o.passes_axis ? 0 : 1, o.property_failures.length + o.distinguishing_failures.length, o.mechanism ? 1 : 0, o.preferred ? 0 : 1, o.id === held[axis] ? 0 : 1, -o.expectations_passed, o.stability ?? 0];
  const ranked = [...options].sort((a, b) => { const x = key(a); const y = key(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; });
  const leader = ranked[0];
  const passing = ranked.filter((o) => o.passes_axis);
  return {
    question: candidates.axes[axis].question,
    options,
    shared_failures: [...shared],
    leader: leader.id,
    leader_passes_all: leader.passes_axis,
    options_passing_axis: passing.map((o) => o.id),
    leader_note: leader.passes_axis
      ? `${passing.length} option(s) pass every property and every scenario this axis decides: ${passing.map((o) => o.id).join(', ')}. ${leader.id} leads${passing.length > 1 ? ' by the tie-break (no added mechanism, then a recorded preference, then the option already held, then scenarios passed, then stability)' : ''}.`
      : `No option passes everything this axis decides; ${leader.id} fails the fewest (${[...leader.property_failures, ...leader.distinguishing_failures].join('; ')}).`,
  };
}

export { p1Monotonic, p2SeverityOrdering, p3NoMasking, p4Dilution, p5Authoring, p6CoverageHonesty, p7Applicability, p8Stability };

/* ── the whole calibration ────────────────────────────────────────────── */

export function runCalibration(candidates) {
  /*
   * COORDINATE DESCENT. Each axis is judged with every other axis at its current
   * leader, and the passes repeat until no leader changes. The first pass holds
   * the others at the stated baseline; a leader chosen against a baseline another
   * axis later replaces is re-examined against the replacement. (Phase 3's first
   * report judged every axis against the baseline only, which chose a Systemic cap
   * under the weight-share method the investigation then replaced.)
   */
  const base = candidates.held_constant_while_other_axes_vary;
  let picks = Object.fromEntries(Object.keys(candidates.axes).map((k) => [k, base[k]]));
  let axes = {};
  const convergence = [];
  for (let pass = 1; pass <= 6; pass++) {
    axes = {};
    for (const axis of Object.keys(candidates.axes)) axes[axis] = calibrateAxis(candidates, axis, picks);
    const next = Object.fromEntries(Object.entries(axes).map(([k, v]) => [k, v.leader]));
    convergence.push({ pass, held: { ...picks }, leaders: { ...next } });
    const stable = Object.keys(next).every((k) => next[k] === picks[k]);
    picks = next;
    if (stable) break;
  }
  const combined = configFrom(candidates, picks);
  const acc = candidates.acceptance;
  const properties = {
    P1: p1Monotonic(combined, 'all'), P2: { C: p2SeverityOrdering(combined, 'C'), R: p2SeverityOrdering(combined, 'R'), pass: p2SeverityOrdering(combined, 'C').pass && p2SeverityOrdering(combined, 'R').pass },
    P3: p3NoMasking(combined, acc), P4: p4Dilution(combined, acc), P5: { C: p5Authoring(combined, 'C'), R: p5Authoring(combined, 'R') },
    P6: p6CoverageHonesty(combined), P7: { C: p7Applicability(combined, 'C'), R: p7Applicability(combined, 'R') }, P8: p8Stability(combined, 'combined', acc),
  };
  properties.P5.pass = properties.P5.C.pass && properties.P5.R.pass;
  properties.P7.pass = properties.P7.C.pass && properties.P7.R.pass;
  const expectations = runExpectations(combined, acc);
  const scenarios = SCENARIOS.map((sc) => {
    const r = evaluateScenario(sc, combined);
    return {
      id: sc.id, title: sc.title,
      modules: Object.fromEntries(Object.entries(r.modules).map(([k, m]) => [k, { score: m.score, participates: m.participates, coverage: m.coverage }])),
      overall: { score: r.overall.score, band: r.overall.band },
      expectations: expectations.filter((e) => e.scenario === sc.id).map(({ expectation, pass }) => ({ expectation, pass })),
    };
  });
  const failing = [...Object.entries(properties).filter(([, v]) => !v.pass).map(([k]) => k), ...expectations.filter((e) => !e.pass).map((e) => `${e.scenario}: ${e.expectation}`)];
  return {
    calibration_version: CALIBRATION_VERSION,
    convergence,
    candidates_version: candidates.candidates_version,
    promoted: false,
    promotion_rule: 'Decision D-008: a model is promoted only by decision, from a report whose combined configuration passes every property and scenario.',
    acceptance: acc,
    axes,
    combined: {
      picks,
      configuration: combined,
      properties,
      expectations_passed: expectations.filter((e) => e.pass).length,
      expectations_total: expectations.length,
      passes_all: failing.length === 0,
      failing,
    },
    scenarios,
  };
}
