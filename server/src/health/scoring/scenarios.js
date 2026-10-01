import { bandRank } from './overall-candidates.js';
import { loadWorkbook, moduleDimensions } from '../workbook.js';

/**
 * THE CALIBRATION SCENARIO LIBRARY — Phase 3 (docs/HEALTH-ASSIST-APPROACH.md §10).
 *
 * Synthetic estates built from the workbook's own shapes, each with the
 * QUALITATIVE outcome a correct model must produce ("the Overall must not read
 * Healthy", "a near miss is nearly healthy"). The expectations come from the
 * decisions (D-005, D-006) and the workbook's severity semantics, not from any
 * candidate's output: a scenario is written first and a model is judged by it.
 *
 * Tiers (Method R): bc = supports a Business Critical service, core = host /
 * infrastructure / application, other, endpoint. Module dimension weights follow
 * the workbook where it states them (CMDB D-weights) and are equal otherwise.
 *
 * Recorded PDI runs are not in the library yet: a run stores rule outcomes but
 * not the per-rule measured values Method C needs (Phase 4 records them).
 */

/* ── builders ─────────────────────────────────────────────────────────── */

const clean = (tier, count) => ({ tier, count, charges: [] });
const charged = (tier, count, ...bands) => ({ tier, count, charges: bands.map((band, i) => ({ key: `d${i}`, band })) });
const pass = (id, base) => ({ id, base, form: 'binary', value: { passed: true } });
const fail = (id, base, over = {}) => ({ id, base, form: 'binary', value: { passed: false }, ...over });
const share = (id, base, measured, target) => ({ id, base, form: 'good_share', value: { measured, target } });
const rate = (id, base, measured, limit) => ({ id, base, form: 'bad_rate', value: { measured, limit } });

/** A C dimension of n healthy controls across the bands, plus extras. */
const controls = (key, extras = [], weight = 1) => ({
  key, weight,
  rules: [
    pass(`${key}-s1`, 'Systemic'), pass(`${key}-c1`, 'Critical'), pass(`${key}-c2`, 'Critical'),
    pass(`${key}-h1`, 'High'), pass(`${key}-h2`, 'High'), pass(`${key}-m1`, 'Moderate'), pass(`${key}-l1`, 'Low'),
    ...extras,
  ],
});

const CMDB_WEIGHTS = { D1: 12, D2: 12, D3: 14, D4: 12, D5: 8, D6: 16, D7: 10, D8: 6, D9: 6, D10: 4 };
const DIM_KIND = { D1: 'record', D2: 'record', D3: 'record', D4: 'mixed', D5: 'mixed', D6: 'mixed', D7: 'mixed', D8: 'record', D9: 'record', D10: 'estate' };

/** A CMDB of `n` clean records per tier in every dimension, with per-dimension overrides. */
function cmdb(overrides = {}, estate = { bc: 20, core: 200, other: 300, endpoint: 2000 }) {
  return {
    method: 'R',
    dims: Object.keys(CMDB_WEIGHTS).map((key) => ({
      key, weight: CMDB_WEIGHTS[key], kind: DIM_KIND[key],
      records: overrides[key]?.records ?? Object.entries(estate).map(([tier, n]) => clean(tier, n)),
      rules: overrides[key]?.rules ?? [],
    })),
  };
}
const itsm = (over = {}) => ({ method: 'C', dims: ['incident', 'problem', 'change', 'cross_process'].map((k) => over[k] ?? controls(k)) });
const itom = (over = {}) => ({ method: 'C', dims: ['discovery', 'mid_server', 'service_mapping', 'event_management', 'cloud'].map((k) => over[k] ?? controls(k)) });
const platform = (over = {}, coverage = 1) => ({ method: 'C', coverage, dims: ['sla_engineering', 'server_logic', 'access_security', 'integrations'].map((k) => over[k] ?? controls(k)) });

const healthy = () => ({ cmdb: cmdb(), itsm: itsm(), itom: itom(), platform: platform() });
const rank = (s) => bandRank(s);

/* ── the library ──────────────────────────────────────────────────────── */

export const SCENARIOS = Object.freeze([
  {
    id: 'S01-healthy',
    title: 'A healthy estate',
    modules: healthy(),
    expect: [
      { id: 'every module Healthy', check: (r) => Object.values(r.modules).every((m) => m.score >= 90) },
      { id: 'Overall Healthy', check: (r) => r.overall.band === 'healthy' },
    ],
  },
  {
    id: 'S02-one-module-failing',
    title: 'ITSM broken across its processes; everything else healthy',
    modules: {
      ...healthy(),
      itsm: itsm({
        incident: controls('incident', [fail('i-x1', 'Systemic'), fail('i-x2', 'Critical'), fail('i-x3', 'Critical')]),
        problem: controls('problem', [fail('p-x1', 'Systemic'), fail('p-x2', 'Critical')]),
        change: controls('change', [fail('c-x1', 'Systemic'), fail('c-x2', 'Critical')]),
      }),
    },
    expect: [
      { id: 'ITSM materially unhealthy', check: (r, acc) => r.modules.itsm.score < acc.unhealthy_below },
      { id: 'Overall not Healthy and not Mostly healthy', check: (r) => rank(r.overall.score) >= 2 && r.overall.band_rank >= 2 },
    ],
  },
  {
    id: 'S03-single-systemic-defect',
    title: 'One Systemic credential failure in Discovery; the rest of ITOM clean',
    modules: { ...healthy(), itom: itom({ discovery: controls('discovery', [fail('ITOM-015', 'Systemic')]) }) },
    expect: [
      { id: 'the Discovery dimension is not Healthy', check: (r) => r.modules.itom.dims.discovery < 90 },
      { id: 'ITOM is not Healthy while a Systemic defect stands', check: (r) => r.modules.itom.score < 90 },
    ],
  },
  {
    id: 'S04-thin-coverage',
    title: 'Platform barely assessed (20% coverage) and scoring badly on what was read',
    modules: { ...healthy(), platform: platform({ access_security: controls('access_security', [fail('pl-1', 'Systemic'), fail('pl-2', 'Systemic')]) }, 0.2) },
    expect: [
      { id: 'Platform leaves the Overall below the floor', check: (r) => r.modules.platform.participates === false },
      { id: 'the Overall is what the assessed modules say', check: (r) => r.overall.band === 'healthy' },
    ],
  },
  {
    id: 'S05-product-not-in-use',
    title: 'Event Management reliably not in use; its dimension excluded',
    modules: { ...healthy(), itom: itom({ event_management: { ...controls('event_management', [fail('e-1', 'Systemic')]), applicable: false } }) },
    expect: [
      { id: 'an excluded dimension neither rewards nor penalises', check: (r) => r.modules.itom.score >= 99.9 },
    ],
  },
  {
    id: 'S06-defective-core-clean-tail',
    title: 'Every Business Critical and core CI carries a Critical defect; 20,000 clean endpoints',
    modules: {
      ...healthy(),
      cmdb: cmdb({
        D6: { records: [charged('bc', 20, 'CRITICAL'), charged('core', 200, 'CRITICAL'), clean('other', 300), clean('endpoint', 20000)] },
        D9: { records: [charged('bc', 20, 'CRITICAL'), charged('core', 200, 'CRITICAL'), clean('other', 300), clean('endpoint', 20000)] },
      }),
    },
    /*
     * WITHDRAWN AS A TEST, KEPT AS EVIDENCE (Phase 3 investigation). This stylised
     * estate breaks the workbook's own semantics twice: a Critical defect on a CI
     * that supports a Business Critical service must ESCALATE one band (Schema,
     * "Escalate one band … Supports a Business Critical service"), and an estate
     * whose every principal CI has no edge cannot also pass its D6 reachability KPI
     * (CMDB-057) or its D10 impact-analysis KPI (DQ-077). Its expectation failed
     * for the estate's fault, not the model's. S06F is the faithful version.
     */
    informational: true,
    note: 'Unfaithful to the Schema: no severity escalation on Business Critical CIs, and no D6/D10 KPIs. Replaced by S06F; scores still reported.',
    expect: [],
  },
  {
    id: 'S07-low-severity-noise',
    title: '40% of records carry one Low hygiene defect',
    modules: { ...healthy(), cmdb: cmdb({ D1: { records: [charged('other', 1000, 'LOW'), clean('other', 1500)] } }) },
    expect: [
      { id: 'hygiene noise does not sink the dimension', check: (r) => r.modules.cmdb.dims.D1 >= 95 },
    ],
  },
  {
    id: 'S08-escalated-to-systemic',
    title: 'The same missing-owner defect on Business Critical CIs, escalated to Systemic by context',
    modules: {
      ...healthy(),
      cmdb: cmdb({ D9: { records: [charged('bc', 20, 'SYSTEMIC'), clean('core', 200), clean('other', 300), clean('endpoint', 2000)] } }),
    },
    compare: {
      with: { ...healthy(), cmdb: cmdb({ D9: { records: [charged('bc', 20, 'HIGH'), clean('core', 200), clean('other', 300), clean('endpoint', 2000)] } }) },
      id: 'escalation lowers the dimension',
      check: (r, base) => r.modules.cmdb.dims.D9 < base.modules.cmdb.dims.D9,
    },
    expect: [],
  },
  {
    id: 'S09-recovery',
    title: 'After remediation: the S06 core defects fixed',
    modules: healthy(),
    expect: [
      { id: 'the CMDB is Healthy again', check: (r) => r.modules.cmdb.score >= 90 },
    ],
  },
  {
    id: 'S10-near-miss-and-collapse',
    title: 'Discovery coverage 84% against 85% (a near miss); Service Mapping coverage 20% against 60% (a collapse)',
    modules: {
      ...healthy(),
      itom: itom({
        discovery: controls('discovery', [share('ITOM-002', 'Systemic', 0.84, 0.85)]),
        service_mapping: controls('service_mapping', [share('ITOM-068', 'Systemic', 0.2, 0.6)]),
      }),
    },
    expect: [
      { id: 'a near miss is nearly healthy', check: (r) => r.modules.itom.dims.discovery >= 95 },
      { id: 'a collapse is not Healthy', check: (r) => r.modules.itom.dims.service_mapping < 75 },
    ],
  },
  {
    id: 'S11-rate-just-over-limit',
    title: 'Reopen rate 9% against an 8% limit; change failure 60% against 10%',
    modules: {
      ...healthy(),
      itsm: itsm({
        incident: controls('incident', [rate('ITSM-030', 'Systemic', 0.09, 0.08)]),
        change: controls('change', [rate('ITSM-113', 'Critical', 0.6, 0.1)]),
      }),
    },
    expect: [
      { id: 'just over the limit is nearly healthy', check: (r) => r.modules.itsm.dims.incident >= 95 },
      { id: 'far over the limit is not Healthy', check: (r) => r.modules.itsm.dims.change < 90 },
    ],
  },
  {
    id: 'S12-four-modules-one-unhealthy',
    title: 'Three modules Healthy, Platform materially unhealthy (fully assessed)',
    modules: {
      ...healthy(),
      platform: platform({
        access_security: controls('access_security', [fail('pl-a', 'Systemic'), fail('pl-b', 'Systemic'), fail('pl-c', 'Critical')]),
        integrations: controls('integrations', [fail('pl-d', 'Systemic'), fail('pl-e', 'Systemic')]),
        server_logic: controls('server_logic', [fail('pl-f', 'Systemic'), fail('pl-g', 'Critical')]),
        sla_engineering: controls('sla_engineering', [fail('pl-h', 'Systemic'), fail('pl-i', 'Critical'), fail('pl-j', 'Critical')]),
      }),
    },
    expect: [
      { id: 'Platform materially unhealthy', check: (r, acc) => r.modules.platform.score < acc.unhealthy_below },
      { id: 'the Overall does not hide it (band at most one better, number inside its band)', check: (r) => r.overall.band_rank >= 2 && rank(r.overall.score) === r.overall.band_rank },
    ],
  },
]);

/* ══ FAITHFUL SCENARIOS: the real catalogue, real rule ids, workbook thresholds ══
 *
 * Added in the Phase 3 investigation. The stylised modules above give every
 * dimension 7 passing controls; the real catalogue gives ITSM's incident
 * dimension 51 scored rules (base weight 2,020). A model that behaves on 7 rules
 * and not on 51 is a model whose answer depends on how many rules were written.
 * These modules contain EVERY scored workbook rule of each dimension (trend,
 * correlation and context rules excluded, as the overlays classify them), all
 * passing except the named failures, each with its workbook threshold.
 */

let wbCache = null;
const wb = () => (wbCache ??= loadWorkbook());

/** A Method C module from the workbook: every scored rule of every scored dimension, passing unless named in `failures`. */
function catalogueModule(moduleKey, failures = {}, { coverage = 1 } = {}) {
  const book = wb();
  const sheet = Object.keys(book.sheets).find((k) => book.sheets[k].rules.some((r) => book.overlays[k].rules[r.id]?.module === moduleKey));
  const dims = moduleDimensions(book, moduleKey).filter((d) => d.scored !== false);
  const unused = new Set(Object.keys(failures));
  const out = dims.map((d) => ({
    key: d.key, weight: 1,
    rules: book.sheets[sheet].rules
      .filter((r) => {
        const e = book.overlays[sheet].rules[r.id];
        return e.module === moduleKey && e.dimension === d.key && !['correlation', 'trend', 'context'].includes(e.kind);
      })
      .map((r) => {
        const f = failures[r.id];
        unused.delete(r.id);
        if (!f) return pass(r.id, r.base_severity);
        if (f === 'fail') return fail(r.id, r.base_severity);
        return { id: r.id, base: r.base_severity, ...f };
      }),
  }));
  if (unused.size) throw new Error(`catalogueModule(${moduleKey}): not a scored rule of this module: ${[...unused].join(', ')}`);
  return { method: 'C', coverage, dims: out };
}

const faithfulHealthy = () => ({ cmdb: cmdb(), itsm: catalogueModule('itsm'), itom: catalogueModule('itom'), platform: catalogueModule('platform') });

export const FAITHFUL_SCENARIOS = Object.freeze([
  {
    id: 'S01F-healthy-catalogue',
    title: 'Every scored workbook rule passes (ITSM 136, ITOM 143, Platform 174)',
    modules: faithfulHealthy(),
    expect: [
      { id: 'every module Healthy', check: (r) => Object.values(r.modules).every((m) => m.score >= 90) },
      { id: 'Overall Healthy', check: (r) => r.overall.band === 'healthy' },
    ],
  },
  {
    id: 'S02F-itsm-processes-broken',
    title: 'Incident: ITSM-016 (55% of incidents with no CI or service, limit 40%), ITSM-030 (reopen rate 15%, limit 8%), ITSM-037 backlog ageing. Problem: ITSM-056 never progressed, ITSM-061 no state change. Change: ITSM-094 (50% of changes with no CI, limit 30%), ITSM-113 (success 70%, target 90%). Cross-process clean.',
    modules: {
      ...faithfulHealthy(),
      itsm: catalogueModule('itsm', {
        'ITSM-016': { form: 'bad_rate', value: { measured: 0.55, limit: 0.4 } },
        'ITSM-030': { form: 'bad_rate', value: { measured: 0.15, limit: 0.08 } },
        'ITSM-037': 'fail',
        'ITSM-056': 'fail',
        'ITSM-061': 'fail',
        'ITSM-094': { form: 'bad_rate', value: { measured: 0.5, limit: 0.3 } },
        'ITSM-113': { form: 'good_share', value: { measured: 0.7, target: 0.9 } },
      }),
    },
    rationale: 'Schema: Systemic = "the governance mechanism that should prevent defects is itself broken". Each of the three processes carries a standing Systemic defect and a Critical one; a module in that state is materially unhealthy.',
    expect: [
      { id: 'ITSM materially unhealthy', check: (r, acc) => r.modules.itsm.score < acc.unhealthy_below },
      { id: 'Overall not Healthy and not Mostly healthy', check: (r) => r.overall.band_rank >= 2 && bandRank(r.overall.score) >= 2 },
    ],
  },
  {
    id: 'S03F-credential-failure',
    title: 'Discovery: ITOM-015 credential failure rate 80% sustained (limit 70%). Every other ITOM rule passes.',
    modules: { ...faithfulHealthy(), itom: catalogueModule('itom', { 'ITOM-015': { form: 'bad_rate', value: { measured: 0.8, limit: 0.7 } } }) },
    rationale: 'A standing Systemic defect: the mechanism that keeps the CMDB true is failing on the ranges it scans.',
    expect: [
      { id: 'Discovery is not Healthy', check: (r) => r.modules.itom.dims.discovery < 90 },
      { id: 'ITOM is not Healthy while a Systemic defect stands', check: (r) => r.modules.itom.score < 90 },
    ],
  },
  {
    id: 'S06F-defective-core-faithful',
    title: 'CMDB-058 (Critical) on every Business Critical and core CI — escalated to Systemic on Business Critical CIs; CMDB-105 (High) likewise, escalated to Critical; CMDB-057 reachability 5% (threshold 60%); DQ-077 impact analysis 10% (threshold 70%). 2,300 clean other and endpoint CIs.',
    modules: {
      ...faithfulHealthy(),
      cmdb: cmdb({
        D6: {
          records: [charged('bc', 20, 'SYSTEMIC'), charged('core', 200, 'CRITICAL'), clean('other', 300), clean('endpoint', 2000)],
          rules: [{ id: 'CMDB-057', base: 'Systemic', form: 'good_share', value: { measured: 0.05, target: 0.6 } }],
        },
        D9: { records: [charged('bc', 20, 'CRITICAL'), charged('core', 200, 'HIGH'), clean('other', 300), clean('endpoint', 2000)] },
        D10: { rules: [{ id: 'DQ-077', base: 'Systemic', form: 'good_share', value: { measured: 0.1, target: 0.7 } }] },
      }),
    },
    rationale: 'Schema escalators: a CI supporting a Business Critical service escalates one band. Workbook D6 and D10 KPIs measure the same broken estate at the population level.',
    expect: [
      { id: 'the relationship dimension is not Healthy', check: (r) => r.modules.cmdb.dims.D6 < 75 },
      { id: 'CMDB is not Healthy when its core is defective', check: (r) => r.modules.cmdb.score < 90 },
    ],
  },
  {
    id: 'S12F-platform-four-areas-broken',
    title: 'Platform: PLT-121/122 (ACLs) + PLT-129; PLT-138/139 (basic auth, vault) + PLT-144; PLT-034/047 (current.update, hard-coded credentials) + PLT-045; PLT-002 (no SLA for a band) + PLT-007/020. Five other Platform areas clean.',
    modules: {
      ...faithfulHealthy(),
      platform: catalogueModule('platform', Object.fromEntries(['PLT-121', 'PLT-122', 'PLT-129', 'PLT-138', 'PLT-139', 'PLT-144', 'PLT-034', 'PLT-047', 'PLT-045', 'PLT-002', 'PLT-007', 'PLT-020'].map((id) => [id, 'fail']))),
    },
    rationale: 'Four of nine Platform areas each carry two standing Systemic defects. With equal (provisional, D-004) area weights, whether that reads "Needs work" or "Needs attention" is decided by weights the workbook does not define — so the expectation is the one the semantics do fix: not Healthy, not Mostly healthy, and not hidden by the Overall.',
    expect: [
      { id: 'Platform reads Needs attention or worse', check: (r) => r.modules.platform.score < 75 },
      { id: 'the Overall does not hide it (band at most one better, number inside its band)', check: (r) => r.overall.band_rank >= bandRank(r.modules.platform.score) - 1 && bandRank(r.overall.score) === r.overall.band_rank },
    ],
  },
  {
    id: 'S13F-hygiene-only',
    title: 'Every Moderate incident rule fails (7 of 51); nothing more severe',
    modules: { ...faithfulHealthy(), itsm: catalogueModule('itsm', Object.fromEntries(wb().sheets.itsm.rules.filter((r) => r.base_severity === 'Moderate' && wb().overlays.itsm.rules[r.id].dimension === 'incident' && !['correlation', 'trend', 'context'].includes(wb().overlays.itsm.rules[r.id].kind)).map((r) => [r.id, 'fail']))) },
    rationale: 'Schema: Moderate = "real defect, contained blast radius … no immediate operational consequence"; Low = "matters in aggregate". Every Moderate control failing is an aggregate defect (not Healthy) with no immediate consequence (not materially unhealthy).',
    expect: [
      { id: 'the incident dimension is not Healthy', check: (r) => r.modules.itsm.dims.incident < 90 },
      { id: 'the incident dimension is not materially unhealthy', check: (r, acc) => r.modules.itsm.dims.incident >= acc.unhealthy_below },
    ],
  },
]);

export const ALL_SCENARIOS = Object.freeze([...SCENARIOS, ...FAITHFUL_SCENARIOS]);

export const scenarioBuilders = Object.freeze({ clean, charged, pass, fail, share, rate, controls, cmdb, itsm, itom, platform, healthy, catalogueModule });
