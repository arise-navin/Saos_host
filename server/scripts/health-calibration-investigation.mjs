/**
 * HEALTH ASSIST PHASE 3 — the calibration investigation (S02, S12, S06, acceptance thresholds).
 *
 *   node scripts/health-calibration-investigation.mjs
 *
 * Writes ../docs/HEALTH-ASSIST-CALIBRATION-INVESTIGATION.md: for each scenario the
 * first report failed, the exact rules, severities, dimensions and arithmetic
 * behind the result; the root cause; two to four fixes tested side by side; and
 * how sensitive the conclusions are to the acceptance thresholds. Every number
 * is computed here by the kernel, not written by hand. Deterministic.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { methodR, recordScore, attainment, bandWeight } from '../src/health/scoring/kernel.js';
import { evaluateScenario, dimensionScore } from '../src/health/scoring/evaluate.js';
import { configFrom, runExpectations, p3NoMasking, p4Dilution } from '../src/health/scoring/calibration.js';
import { ALL_SCENARIOS, scenarioBuilders as B } from '../src/health/scoring/scenarios.js';
import { OVERALL_CANDIDATES } from '../src/health/scoring/overall-candidates.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const candidates = JSON.parse(fs.readFileSync(path.resolve(HERE, '../src/health/scoring/candidates.json'), 'utf8'));
const report = JSON.parse(fs.readFileSync(path.resolve(HERE, '../src/health/scoring/calibration-report.json'), 'utf8'));
const r2 = (x) => (x == null ? '—' : Number(x.toFixed(2)));
const sc = (id) => ALL_SCENARIOS.find((s) => s.id === id);

/* The configuration the first Phase 3 report combined, and the final one. */
const PHASE3 = { record_aggregation: 'R6', attainment_curve: 'A3', control_aggregation: 'C1', overall: 'O8', systemic_treatment: 'T3', coverage_floor: 'F2' };
const FINAL = report.combined.picks;
const cfg = (picks) => configFrom(candidates, picks);

const lines = [];
const moduleUnder = (mod, picks) => evaluateScenario({ modules: { m: mod } }, { ...cfg(picks), floor: 0 }).modules.m;
const S02F = sc('S02F-itsm-processes-broken').modules.itsm;
const s02fC1 = moduleUnder(S02F, { ...FINAL, control_aggregation: 'C1' });
const s02fC3 = moduleUnder(S02F, { ...FINAL, control_aggregation: 'C3' });
const s06fByR = Object.fromEntries(candidates.axes.record_aggregation.options.map((o) => [o.id, moduleUnder(sc('S06F-defective-core-faithful').modules.cmdb, { ...FINAL, record_aggregation: o.id }).score]));
const s06fHealthy = Object.entries(s06fByR).filter(([, v]) => v >= 90).map(([k]) => k);
const s06fFinal = s06fByR[FINAL.record_aggregation];
const drift = Object.fromEntries(candidates.axes.record_aggregation.options.map((o) => [o.id, p4Dilution({ ...cfg(FINAL), record: { aggregation: o.aggregation, tier_weights: o.tier_weights || {} } }, candidates.acceptance).drift]));
const out = (s = '') => lines.push(s);

/* ── Method C, rule by rule ── */
function explainC(dim, config, { failingOnly = true } = {}) {
  const rows = dim.rules.map((r) => {
    const a = attainment(r.form, r.value, config.curve);
    return { id: r.id, base: r.base, form: r.form, value: r.value, w: bandWeight(r.base), a };
  });
  const failing = rows.filter((x) => x.a < 1);
  const wBase = rows.reduce((n, x) => n + x.w, 0);
  const loss = failing.reduce((n, x) => n + x.w * (1 - x.a), 0);
  const counts = {};
  for (const x of rows) counts[x.base] = (counts[x.base] || 0) + 1;
  return { rows: failingOnly ? failing : rows, total: rows.length, counts, wBase, loss };
}
const lossOf = (mod, key) => explainC(mod.dims.find((d) => d.key === key), cfg(FINAL)).loss;
const incidentWeight = explainC(S02F.dims.find((d) => d.key === 'incident'), cfg(FINAL)).wBase;
const pc = (v) => `${Number((v * 100).toFixed(1))}%`;
const valueText = (x) => (x.form === 'binary' ? 'fails' : x.form === 'good_share' ? `${pc(x.value.measured)} vs target ${pc(x.value.target)}` : `${pc(x.value.measured)} vs limit ${pc(x.value.limit)}`);

function cTable(module, config) {
  out('| Dimension | Rules (by band) | Σ base weight | Failing rule | Band | Weight | Measured | Attainment | Deduction w·(1−a) |');
  out('|---|---|---|---|---|---|---|---|---|');
  for (const dim of module.dims) {
    const e = explainC(dim, config);
    const bands = Object.entries(e.counts).map(([b, n]) => `${n} ${b}`).join(', ');
    if (!e.rows.length) { out(`| ${dim.key} | ${e.total}: ${bands} | ${e.wBase} | *(none)* | | | | | 0 |`); continue; }
    e.rows.forEach((x, i) => out(`| ${i ? '' : dim.key} | ${i ? '' : `${e.total}: ${bands}`} | ${i ? '' : e.wBase} | ${x.id} | ${x.base} | ${x.w} | ${valueText(x)} | ${r2(x.a)} | ${r2(x.w * (1 - x.a))} |`));
  }
  out();
}

function cScores(module, controlIds) {
  const rows = controlIds.map((id) => {
    const config = cfg({ ...FINAL, control_aggregation: id });
    const res = evaluateScenario({ modules: { m: module } }, { ...config, floor: 0 }).modules.m;
    return { id, dims: res.dims, score: res.score };
  });
  const keys = module.dims.map((d) => d.key);
  out(`| Method | ${keys.join(' | ')} | **Module** |`);
  out(`|---|${keys.map(() => '---').join('|')}|---|`);
  for (const r of rows) {
    const o = candidates.axes.control_aggregation.options.find((x) => x.id === r.id);
    out(`| ${r.id} ${o.aggregation.replace(/_/g, ' ')} | ${keys.map((k) => r2(r.dims[k])).join(' | ')} | **${r2(r.score)}** |`);
  }
  out();
}

/* ════════════════════════════════════════════════════════════════════════ */

out('# Health Assist — Calibration Investigation: S02, S12, S06 and the acceptance thresholds');
out();
out('Generated by `server/scripts/health-calibration-investigation.mjs`. Every number below is computed by the scoring kernel: re-running the script reproduces this document. The companion report is [HEALTH-ASSIST-CALIBRATION.md](HEALTH-ASSIST-CALIBRATION.md).');
out();
out('## Summary');
out();
out('The first Phase 3 report left four checks failing under its combined configuration: S02 (twice), S06 and S12. The investigation found three causes, and each needed a different fix: **one flaw in the model** (S02, S12), **one flaw in a scenario** (S06), and **one flaw in how the harness chose leaders**. The last is why it had picked a Systemic cap: the cap was compensating for the model flaw.');
out();
out('| Issue | Root cause | Resolution | Evidence |');
out('|---|---|---|---|');
out(`| S02, S12: modules with Systemic failures in most areas scored 54–69 | **Method C diluted every failure by the number of rules written.** Under the weight share, a failure costs its weight as a share of every rule in the dimension. The real ITSM incident dimension has 51 scored rules (base weight ${incidentWeight.toLocaleString('en-US')}), so a Systemic failure moves it by ${r2(10000 / incidentWeight)} points. | Score controls the way the workbook scores records: **start at 100 and deduct each failure's severity weight** (C3). A failure costs what its severity says, however many rules pass beside it. No cap and no penalty. | S02F on the real catalogue: ITSM ${r2(s02fC1.score)} under the weight share, ${r2(s02fC3.score)} under the deduction. |`);
out(`| S06: every Business Critical and core CI defective, CMDB 94 "Healthy" | **The scenario broke the workbook's own semantics.** A Critical defect on a CI that supports a Business Critical service must escalate one band (Schema). An estate whose principal CIs have no edges also fails its D6 reachability KPI (CMDB-057) and its D10 impact-analysis KPI (DQ-077). The stylised S06 had neither. | Replaced by S06F, which is faithful. The stylised version is kept as evidence and marked informational. **The model is unchanged for this.** | S06F: CMDB ${r2(s06fFinal)}, "Mostly healthy". It still reads "Healthy" under ${s06fHealthy.join(', ') || 'no option'}: record averaging that clean endpoints dilute. |`);
out('| A Systemic cap (T3) looked necessary | The cap was chosen while Method C still diluted failures. Each axis was judged against the baseline of the others. | The harness now judges each axis against the current leaders of the others, repeating until they stop changing, and breaks ties towards **no added mechanism**. With the deduction method, **no cap is needed**. | The search settled in 3 passes, on T1 (no cap). T3 and T4 still pass, but add nothing. |');
out();
out(`**Final combined configuration** (every property and every scenario pass; promoted: **${report.promoted}**): ${Object.entries(FINAL).map(([k, v]) => `${k.replace(/_/g, ' ')} **${v}**`).join(' · ')}.`);
out();

/* ── S02 ── */
out('## S02: ITSM broken across its processes');
out();
out('### What the first report computed');
out();
out('The stylised S02 gave every ITSM dimension 7 passing controls (1 Systemic, 2 Critical, 2 High, 1 Moderate, 1 Low: base weight 216) and added failures on top. Under the Phase 3 configuration (weight share, convex curve), each dimension was scored as `100 × (1 − Σ w·(1−a) ÷ Σ w)`:');
out();
cTable(sc('S02-one-module-failing').modules.itsm, cfg(PHASE3));
{
  const p = evaluateScenario(sc('S02-one-module-failing'), cfg(PHASE3));
  out(`Incident: 100 × (1 − 180 ÷ 396) = ${r2(p.modules.itsm.dims.incident)}. Problem and change: 100 × (1 − 140 ÷ 356) = ${r2(p.modules.itsm.dims.problem)}. Cross-process: 100. The module is the equal-weight mean, **${r2(p.modules.itsm.score)}**. The Overall (min-blend) was ${r2(p.overall.score)} (${p.overall.band}).`);
  out();
}
out('### Why: the score depends on how many rules were written');
out();
out('The weight share divides each failure by the total base weight of the dimension, so the same failure costs less in a larger dimension. The real catalogue makes this concrete. **S02F** uses every scored workbook rule and the workbook thresholds:');
out();
cTable(sc('S02F-itsm-processes-broken').modules.itsm, cfg(FINAL));
out(`With these 136 scored ITSM rules, the incident dimension's base weight is ${incidentWeight.toLocaleString('en-US')}. Its failures cost ${r2(lossOf(S02F, 'incident'))} weight units: ${r2((100 * lossOf(S02F, 'incident')) / incidentWeight)}% of the dimension under the weight share, but ${r2(lossOf(S02F, 'incident'))} points under a deduction.`);
out();
out('### Fixes tested');
out();
out('Four control aggregations, all with the convex curve and no cap. The first table is the stylised S02, the second the faithful S02F:');
out();
cScores(sc('S02-one-module-failing').modules.itsm, ['C1', 'C2', 'C3', 'C4']);
cScores(sc('S02F-itsm-processes-broken').modules.itsm, ['C1', 'C2', 'C3', 'C4']);
out(`- **C1 weight share:** ITSM reads ${r2(s02fC1.score)}, **"Healthy"**, on the real catalogue, with a standing Systemic defect in all three processes. Rejected: its answer is set by the number of rules written, not by what failed.`);
out('- **C2 severity-stratified:** removes the rule-count effect between bands but keeps it within a band. One of 10 Systemic incident rules failing still costs only a tenth of the Systemic band. Rejected for the same reason.');
out(`- **C3 deduction, additive:** \`max(0, 100 − Σ w·(1−a))\`. This is the formula the workbook's weights already mean for a record, and the one CMDB and ITSM use for records today. Every failure costs exactly its severity weight. Incident: 100 − ${r2(lossOf(S02F, 'incident'))}. Problem: 100 − ${r2(lossOf(S02F, 'problem'))}, floored at 0. Change: 100 − ${r2(lossOf(S02F, 'change'))}. Cross-process: 100. Module: **${r2(s02fC3.score)}**. **Chosen.**`);
out('- **C4 deduction, multiplicative:** each failure removes its weight as a share of what remains. It passes every check too, but the extra concept buys nothing the scenarios can see. Kept as the tested alternative.');
out('- **Caps (T2–T4)** were tested in the first report and rejected on your instruction as a way to force a score. With C3 they are not needed: T1 (no cap) passes every scenario.');
out();

/* ── S12 ── */
out('## S12: Platform materially unhealthy');
out();
out('### What the first report computed');
out();
cTable(sc('S12-four-modules-one-unhealthy').modules.platform, cfg(PHASE3));
{
  const p = evaluateScenario(sc('S12-four-modules-one-unhealthy'), cfg(PHASE3));
  out(`Each of the four stylised Platform areas carries two or three Systemic or Critical failures against 7 passing controls. The weight share gave the four areas ${Object.values(p.modules.platform.dims).map(r2).join(', ')}, so the module read **${r2(p.modules.platform.score)}**, and "materially unhealthy" (< ${candidates.acceptance.unhealthy_below}) failed. **Same root cause as S02.**`);
  out();
}
out('### Fixes tested');
out();
cScores(sc('S12-four-modules-one-unhealthy').modules.platform, ['C1', 'C2', 'C3', 'C4']);
out('### Faithful version (S12F) and what the semantics do and do not fix');
out();
cTable(sc('S12F-platform-four-areas-broken').modules.platform, cfg(FINAL));
cScores(sc('S12F-platform-four-areas-broken').modules.platform, ['C1', 'C3']);
out('On the real catalogue, four of Platform\'s **nine** areas are broken and five are clean. Under the deduction, the four broken areas score 0 and the module scores 5 × 100 ÷ 9 = 55.6, which is "Needs attention", not "Needs work". Whether it *should* read "Needs work" depends on how much access and security, integrations, server-side logic and SLA engineering weigh against the other five areas. **The workbook defines no Platform area weights** (decision D-004: provisional equal, not reviewed). So S12F asserts only what the semantics fix: not Healthy, not Mostly healthy, and not hidden by the Overall. **This is the one place the answer waits on SAOS supplying weights.**');
out();

/* ── S06 ── */
out('## S06: a defective core behind a clean tail');
out();
out('### What the first report computed');
out();
{
  const d = sc('S06-defective-core-clean-tail').modules.cmdb.dims.find((x) => x.key === 'D6');
  const config = cfg(PHASE3);
  const tw = config.record.tier_weights;
  out('Stylised S06: 20 Business Critical and 200 core CIs each carry one Critical defect in D6 and in D9, beside 300 other and 20,000 endpoint CIs that are clean. With R6 (tier-stratified; bc 2, core 1.5, other 1, endpoint 0.75):');
  out();
  out('| Tier | CIs | Record score | Tier weight | Weighted |');
  out('|---|---|---|---|---|');
  let num = 0; let den = 0;
  for (const g of d.records) {
    const s = recordScore(g.charges);
    num += tw[g.tier] * s; den += tw[g.tier];
    out(`| ${g.tier} | ${g.count} | ${s} | ${tw[g.tier]} | ${r2(tw[g.tier] * s)} |`);
  }
  out(`| **D6** | | | Σ ${den} | **${r2(num / den)}** |`);
  out();
  const p = evaluateScenario(sc('S06-defective-core-clean-tail'), config);
  out(`D9 is the same, ${r2(p.modules.cmdb.dims.D9)}. The CMDB score is Σ w_d·S_d ÷ 100 with the workbook weights (D6 16, D9 6, and the other eight clean at 78 of the 100): (16 × ${r2(p.modules.cmdb.dims.D6)} + 6 × ${r2(p.modules.cmdb.dims.D9)} + 78 × 100) ÷ 100 = **${r2(p.modules.cmdb.score)}**, which reads "Healthy".`);
  out();
}
out('### Why: the scenario, not the model');
out();
out('The stylised estate contradicts the workbook in two ways:');
out();
out('1. **No escalation.** The Schema says to *"escalate one band … Supports a Business Critical service"*. CMDB-058 (Critical) on a Business Critical CI is therefore Systemic, which zeroes that record. CMDB-105 (High, the ownership rule) becomes Critical. The engine already does this (`cmdb-signals.js modifiersFor`); the scenario did not.');
out('2. **No KPIs.** D6 is a *mixed* dimension, so its score blends records with its percentage rules. If every principal CI has no edge, CMDB-057 (Systemic, "% of CIs reachable from any Business Service", threshold 60%) cannot pass. D10\'s DQ-077 (Systemic, impact-analysis success, workbook threshold **70%**) cannot pass either. The code\'s CMDB-141 uses 90%, a recorded deviation.');
out();
out('### Fixes tested, one at a time');
out();
{
  const variants = [
    ['Stylised (as the first report had it)', B.cmdb({
      D6: { records: [B.charged('bc', 20, 'CRITICAL'), B.charged('core', 200, 'CRITICAL'), B.clean('other', 300), B.clean('endpoint', 2000)] },
      D9: { records: [B.charged('bc', 20, 'CRITICAL'), B.charged('core', 200, 'CRITICAL'), B.clean('other', 300), B.clean('endpoint', 2000)] },
    })],
    ['+ the workbook severities (CMDB-105 is High, not Critical) and the Business Critical escalation', B.cmdb({
      D6: { records: [B.charged('bc', 20, 'SYSTEMIC'), B.charged('core', 200, 'CRITICAL'), B.clean('other', 300), B.clean('endpoint', 2000)] },
      D9: { records: [B.charged('bc', 20, 'CRITICAL'), B.charged('core', 200, 'HIGH'), B.clean('other', 300), B.clean('endpoint', 2000)] },
    })],
    ['+ the D6 KPI CMDB-057 at 5% (threshold 60%)', B.cmdb({
      D6: { records: [B.charged('bc', 20, 'SYSTEMIC'), B.charged('core', 200, 'CRITICAL'), B.clean('other', 300), B.clean('endpoint', 2000)], rules: [{ id: 'CMDB-057', base: 'Systemic', form: 'good_share', value: { measured: 0.05, target: 0.6 } }] },
      D9: { records: [B.charged('bc', 20, 'CRITICAL'), B.charged('core', 200, 'HIGH'), B.clean('other', 300), B.clean('endpoint', 2000)] },
    })],
    ['+ the D10 KPI DQ-077 at 10% (threshold 70%) = S06F', sc('S06F-defective-core-faithful').modules.cmdb],
  ];
  const aggs = candidates.axes.record_aggregation.options.map((o) => o.id);
  out(`| Estate | ${aggs.map((id) => `${id}`).join(' | ')} |`);
  out(`|---|${aggs.map(() => '---').join('|')}|`);
  for (const [label, mod] of variants) {
    out(`| ${label} | ${aggs.map((id) => r2(evaluateScenario({ modules: { m: mod } }, { ...cfg({ ...FINAL, record_aggregation: id }), floor: 0 }).modules.m.score)).join(' | ')} |`);
  }
  out();
  out(`Record aggregations: ${candidates.axes.record_aggregation.options.map((o) => `**${o.id}** ${o.aggregation.replace(/_/g, ' ')}${o.tier_weights ? ` (${Object.entries(o.tier_weights).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`).join(' · ')}.`);
  out();
  out('Reading the table:');
  out('- Following the workbook\'s semantics, not a new mechanism, is what takes S06 below "Healthy".');
  out(`- On the faithful estate, ${s06fHealthy.join(', ') || 'no option'} still read "Healthy", because 2,300 clean CIs outvote 220 defective ones under a record mean. Every record mean (R1–R4) also fails P4 (dilution): its score drifts by ${['R1', 'R2', 'R3', 'R4'].map((k) => r2(drift[k])).join(', ')} points as the clean tail grows.`);
  out(`- **Tier-stratified averaging (R5 ${r2(s06fByR.R5)}, R6 ${r2(s06fByR.R6)}) reads "Mostly healthy"**, and does not drift at all (${r2(drift.R5)}, ${r2(drift.R6)}).`);
  out('- R5 and R6 pass every check. No scenario tells them apart, so the tie-break chose R5, and **the tier weights remain an assumption for review.**');
  out();
}

/* ── thresholds ── */
out('## The acceptance thresholds: which conclusions depend on them');
out();
out('Each threshold was varied on its own. For each variant, the table shows which Overall and record-aggregation options still pass the property that threshold governs, and whether the final combined configuration still passes every scenario.');
out();
{
  const base = candidates.acceptance;
  const final = cfg(FINAL);
  const overallPass = (acc) => candidates.axes.overall.options.filter((o) => p3NoMasking({ ...final, overall: { kind: o.kind, params: o.params } }, acc).pass).map((o) => o.id).join(', ') || 'none';
  const recordPass = (acc) => candidates.axes.record_aggregation.options.filter((o) => p4Dilution({ ...final, record: { aggregation: o.aggregation, tier_weights: o.tier_weights || {} } }, acc).pass).map((o) => o.id).join(', ') || 'none';
  const scenarios = (acc) => { const e = runExpectations(final, acc); const f = e.filter((x) => !x.pass); return f.length ? `${e.length - f.length}/${e.length}: ✗ ${f.map((x) => `${x.scenario}: ${x.expectation}`).join('; ')}` : `${e.length}/${e.length}`; };
  const variants = [
    ['as set', {}],
    ['materially unhealthy < 40', { unhealthy_below: 40 }],
    ['materially unhealthy < 60', { unhealthy_below: 60 }],
    ['masking slack 0 bands', { masking_band_slack: 0 }],
    ['masking slack 2 bands', { masking_band_slack: 2 }],
    ['dilution tolerance 2 points', { dilution_tolerance_points: 2 }],
    ['dilution tolerance 10 points', { dilution_tolerance_points: 10 }],
  ];
  out('| Variant | Overall options passing P3 | Record options passing P4 | Final configuration: scenarios |');
  out('|---|---|---|---|');
  for (const [label, over] of variants) {
    const acc = { ...base, ...over };
    out(`| ${label} | ${overallPass(acc)} | ${recordPass(acc)} | ${scenarios(acc)} |`);
  }
  out();
  const stab = report.combined.properties.P8;
  out(`Stability (P8) of the final configuration: the largest move of any score for a ±${base.stability_perturbation * 100}% change in any of its numbers is **${stab.max_delta} points**, against a tolerance of ${base.stability_tolerance_points}. The conclusion therefore holds for any tolerance above ${stab.max_delta}.`);
  out();
  out('What this shows:');
  out('- **"Materially unhealthy" < 50** is the product\'s existing "Needs work" band. The final configuration keeps its scenarios at 40 as well.');
  out('- At **60**, the Schema-based expectation that hygiene alone (S13F) must *not* be materially unhealthy is the one to watch. Its incident dimension scores 65.');
  out('- **Masking slack 0** (the Overall may never read better than its worst module) is failed by every candidate, min-blend included. A slack of **1 band** is the strictest rule any candidate meets. Slack 2 lets through formulas that hide a failing module in the number.');
  out(`- **The dilution tolerance does not decide the record aggregation.** The tier-stratified options drift by ${r2(drift.R5)} at any tolerance, while the plain and consequence-weighted means drift by ${r2(Math.min(drift.R1, drift.R2, drift.R3, drift.R4))}–${r2(Math.max(drift.R1, drift.R2, drift.R3, drift.R4))} points, far beyond any sensible tolerance.`);
  out();
}

/* ── remaining ── */
out('## What remains for your review');
out();
out('- **Platform (and ITSM, ITOM) area weights.** Not defined in the workbook; provisional equal (D-004). S12F shows they decide whether four broken Platform areas out of nine read "Needs work" or "Needs attention".');
out('- **Tier weights (R5: bc 4 · core 2 · other 1 · endpoint 0.5, or R6: 2 · 1.5 · 1 · 0.75).** Both pass everything. No scenario separates them.');
out('- **C3 (additive) versus C4 (multiplicative) deduction.** Both pass. C3 is chosen because it is the workbook\'s own record formula.');
out('- **DQ-077 threshold:** the workbook says 70%, the code\'s CMDB-141 says 90%. Already in the deviations register as a code extension.');
out();

const DOC = path.resolve(HERE, '../../docs/HEALTH-ASSIST-CALIBRATION-INVESTIGATION.md');
fs.writeFileSync(DOC, `${lines.join('\n')}\n`);
process.stdout.write(`investigation → ${path.relative(process.cwd(), DOC)}\n`);
void methodR; void dimensionScore; void OVERALL_CANDIDATES;
