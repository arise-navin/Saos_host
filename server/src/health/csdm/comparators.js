import { declareRequirement } from '../itsm/data-access.js';

/**
 * HEALTH ASSIST PHASE 9 — the CSDM comparators.
 *
 * Named callbacks for the configuration engine, in the contract every pack keeps
 * (itsm/comparators.js): `{ offenders, observed, expected, absent, population }`, or
 * `{ unavailable }` when a read the judgement needs failed. Merged into the shared
 * library; a name is defined once.
 *
 * THE LAYERS. A service record's CSDM layer comes from its class — the CSDM 4 classes
 * (cmdb_ci_service_business, cmdb_ci_service_technical, the application-service tree
 * under cmdb_ci_service_auto, service_offering) — or, for a record of the base class
 * cmdb_ci_service, from its service_classification (the CSDM 3 way, still in use:
 * measured on the validation instance, 110 base-class records, 128 classified Business
 * Service). A base-class record with no classification has no layer. The classification
 * values come from the instance's choice list by label ($choice), never literals.
 *
 * Every comparator that could charge a record for a link it did not see requires a
 * complete read; the ones that only group or count accept a partial one.
 */

const COMPLETE = 'complete';
const usable = (cov) => ['complete', 'limited', 'truncated'].includes(cov?.status);
const isEmpty = (v) => v === undefined || v === null || String(v).trim() === '';
const ref = (v) => (v && typeof v === 'object' ? v.value ?? v.sys_id ?? null : v);
const chunks = (xs, n = 100) => { const out = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };
const round1 = (n) => Number(n.toFixed(1));

async function rowsOf(ctx, { table, fields, query = '', complete = false }) {
  const r = await ctx.reads.read(declareRequirement({ table, fields, query, strategy: 'rows' }));
  if (!(complete ? r.coverage?.status === COMPLETE : usable(r.coverage))) return { unavailable: `${table} could not be read${complete ? ' completely' : ''} (${r.coverage?.status}${r.coverage?.error ? `: ${r.coverage.error}` : ''}) — no claim is made from a partial read`, coverage: r.coverage };
  return { rows: r.rows, coverage: r.coverage };
}
async function countsBy(ctx, { table, query = '', groupBy }) {
  const r = await ctx.reads.read(declareRequirement({ table, query, strategy: 'aggregate', groupBy }));
  if (r.coverage?.status !== COMPLETE) return { unavailable: `aggregate over ${table} failed (${r.coverage?.status})`, coverage: r.coverage };
  return { groups: r.groups, coverage: r.coverage };
}
async function inChunks(ctx, { table, fields, field, ids, extra = '' }) {
  const out = [];
  for (const c of chunks([...new Set(ids)])) {
    const r = await rowsOf(ctx, { table, fields, query: `${field}IN${c.join(',')}${extra ? `^${extra}` : ''}`, complete: true });
    if (r.unavailable) return r;
    out.push(...r.rows);
  }
  return { rows: out };
}
const shared = (ctx, key, build) => (ctx.shared?.getOrBuild ? ctx.shared.getOrBuild(key, build) : build());

/* ── the layers ─────────────────────────────────────────────────────────── */

/** The classes under `root` (itself included), from sys_db_object, walked level by level. */
export async function subclasses(ctx, root) {
  return shared(ctx, `csdm:subclasses:${root}`, async () => {
    const all = new Set([root]);
    let frontier = [root];
    for (let depth = 0; frontier.length && depth < 8; depth += 1) {
      const next = [];
      for (const c of chunks(frontier)) {
        const r = await rowsOf(ctx, { table: 'sys_db_object', fields: ['name', 'super_class.name'], query: `super_class.nameIN${c.join(',')}`, complete: true });
        if (r.unavailable) return r;
        for (const x of r.rows) if (x.name && !all.has(x.name)) { all.add(x.name); next.push(x.name); }
      }
      frontier = next;
    }
    return { classes: all };
  });
}

/**
 * The layer function for this instance: `row → 'business' | 'technical' | 'application' | 'offering' | null`.
 * `classification` holds the instance values of the three classification labels.
 */
export async function layerFn(ctx, classification) {
  const app = await subclasses(ctx, 'cmdb_ci_service_auto');
  if (app.unavailable) return app;
  const byValue = new Map(Object.entries(classification || {}).map(([layer, v]) => [String(v), layer]));
  const fn = (row) => {
    const cls = row.sys_class_name;
    if (cls === 'service_offering') return 'offering';
    if (cls === 'cmdb_ci_service_business') return 'business';
    if (cls === 'cmdb_ci_service_technical') return 'technical';
    if (app.classes.has(cls)) return 'application';
    if (cls === 'cmdb_ci_service') return byValue.get(String(row.service_classification ?? '')) ?? null;
    return null;
  };
  return { fn };
}

/** The relationship edges touching any of `ids` (either end), read completely, de-duplicated. */
async function edgesTouching(ctx, ids) {
  const byId = new Map();
  for (const field of ['parent', 'child']) {
    const r = await inChunks(ctx, { table: 'cmdb_rel_ci', fields: ['parent', 'child', 'type'], field, ids });
    if (r.unavailable) return r;
    for (const e of r.rows) byId.set(e.sys_id, { sys_id: e.sys_id, parent: String(ref(e.parent)), child: String(ref(e.child)), type: String(ref(e.type) ?? '') });
  }
  return { edges: [...byId.values()] };
}
const neighbours = (edges) => {
  const n = new Map();
  const add = (a, b) => { if (!n.has(a)) n.set(a, new Set()); n.get(a).add(b); };
  for (const e of edges) { add(e.parent, e.child); add(e.child, e.parent); }
  return n;
};
/** The CIs supporting each service: svc_ci_assoc and the service's outgoing relationship edges. */
async function supportingCis(ctx, serviceIds, edges) {
  const assoc = await inChunks(ctx, { table: 'svc_ci_assoc', fields: ['service_id', 'ci_id'], field: 'service_id', ids: serviceIds });
  if (assoc.unavailable) return assoc;
  const by = new Map(serviceIds.map((s) => [s, new Set()]));
  for (const a of assoc.rows) by.get(String(ref(a.service_id)))?.add(String(ref(a.ci_id)));
  for (const e of edges) if (by.has(e.parent)) by.get(e.parent).add(e.child);
  return { by };
}

const estate = (unit, basis) => ({ total: 1, judged: 1, unit, basis });
const judgedPop = (total, judged, unit, basis, determinate) => ({ total, judged, unit, basis, ...(determinate ? { determinate_when_empty: determinate } : {}) });
const offender = (r, field, value) => ({ sys_id: r.sys_id, field, value: `${r.name ?? r.sys_id}: ${value}` });

const BASE_COMPARATORS = {
  /** CSDM-001 / 032 — a layer or a reference set that must exist is empty. `rows` are its records. */
  csdm_absent: ({ what, unit = 'estate' }) => async (rows) => ({
    offenders: rows.length ? [] : [{ sys_id: null, field: 'records', value: `${what}: no record` }],
    observed: { records: rows.length }, expected: '≥ 1', absent: false,
    population: estate(unit, `${what} — the records read`),
  }),

  /** CSDM-062 — no offering where business services exist. `rows` are the service records. */
  csdm_offering_layer: ({ classification }) => async (rows, ctx) => {
    const L = await layerFn(ctx, classification); if (L.unavailable) return L;
    const business = rows.filter((r) => L.fn(r) === 'business').length;
    const offerings = rows.filter((r) => L.fn(r) === 'offering').length;
    if (!business) return { offenders: [], observed: { business, offerings }, expected: 0, absent: false, population: judgedPop(0, 0, 'estate', 'no business service is modelled', 'no business service layer to offer') };
    return { offenders: offerings ? [] : [{ sys_id: null, field: 'service_offering', value: `${business} business service(s), no offering` }], observed: { business, offerings }, expected: '≥ 1 offering', absent: false, population: estate('estate', 'business services against the offering layer') };
  },

  /**
   * CSDM-017 / 018 / 033 / 036 / 043 — service records of `layers` whose `empty` fields are all
   * empty and whose `present` fields are all populated. `rows` are the service records.
   */
  csdm_services_where: ({ classification, layers = null, empty = [], present = [], unit }) => async (rows, ctx) => {
    const L = await layerFn(ctx, classification); if (L.unavailable) return L;
    const inScope = rows.filter((r) => (layers ? layers.includes(L.fn(r)) : true) && present.every((f) => !isEmpty(ref(r[f]))));
    const offenders = inScope.filter((r) => empty.every((f) => isEmpty(ref(r[f])))).map((r) => offender(r, empty[0], `no ${empty.join(' / ')}`));
    return { offenders, observed: { records: rows.length, in_scope: inScope.length, offending: offenders.length }, expected: 0, absent: false,
      kpi: { numerator: inScope.length - offenders.length, denominator: inScope.length },
      population: judgedPop(inScope.length, inScope.length, unit, `${layers ? layers.join(' / ') : 'all'} service records${present.length ? ` with ${present.join(', ')}` : ''}`) };
  },

  /**
   * CSDM-002 / 003 / 007 / 013 — records of `from` with no relationship (either direction)
   * to a record of `to`. A side is `{ table }` (its own table) or `{ layers }` (service records).
   * `rows` are the service records.
   */
  csdm_unlinked: ({ classification, from, to, unit }) => async (serviceRows, ctx) => {
    const L = await layerFn(ctx, classification); if (L.unavailable) return L;
    const side = async (s) => {
      if (s.layers) return { rows: serviceRows.filter((r) => s.layers.includes(L.fn(r))) };
      return rowsOf(ctx, { table: s.table, fields: ['name'], complete: true });
    };
    const a = await side(from); if (a.unavailable) return a;
    const b = await side(to); if (b.unavailable) return b;
    if (!a.rows.length) return { offenders: [], observed: { records: 0 }, expected: 0, absent: false, population: judgedPop(0, 0, unit, 'no record in scope') };
    const e = await edgesTouching(ctx, a.rows.map((r) => r.sys_id)); if (e.unavailable) return e;
    const targets = new Set(b.rows.map((r) => r.sys_id));
    const n = neighbours(e.edges);
    const offenders = a.rows.filter((r) => ![...(n.get(r.sys_id) || [])].some((x) => targets.has(x))).map((r) => offender(r, 'relationships', 'no relationship to the layer it should connect to'));
    return { offenders, observed: { records: a.rows.length, targets: targets.size, unlinked: offenders.length }, expected: 0, absent: false,
      kpi: { numerator: a.rows.length - offenders.length, denominator: a.rows.length },
      population: judgedPop(a.rows.length, a.rows.length, unit, 'relationships in either direction to the next layer') };
  },

  /** CSDM-004 — business services with no offering naming them as parent. `rows` are the service records. */
  csdm_no_offering: ({ classification }) => async (rows, ctx) => {
    const L = await layerFn(ctx, classification); if (L.unavailable) return L;
    const parents = new Set(rows.filter((r) => L.fn(r) === 'offering').map((r) => String(ref(r.parent))).filter((x) => x && x !== 'null'));
    const business = rows.filter((r) => L.fn(r) === 'business');
    const offenders = business.filter((r) => !parents.has(r.sys_id)).map((r) => offender(r, 'service_offering', 'no service offering'));
    return { offenders, observed: { business: business.length, without_offering: offenders.length }, expected: 0, absent: false,
      kpi: { numerator: business.length - offenders.length, denominator: business.length },
      population: judgedPop(business.length, business.length, 'business services', 'offerings whose parent is the service') };
  },

  /** CSDM-005 — offerings with no commitment and no SLA. `rows` are unused. */
  csdm_offering_no_commitment: () => async (_rows, ctx) => {
    /* The SLA field is the offering's own (not on the base service class): offerings are read from their table. */
    const o = await rowsOf(ctx, { table: 'service_offering', fields: ['name', 'sla'], complete: true }); if (o.unavailable) return o;
    const offerings = o.rows;
    const soc = await inChunks(ctx, { table: 'service_offering_commitment', fields: ['service_offering'], field: 'service_offering', ids: offerings.map((o) => o.sys_id) });
    if (soc.unavailable) return soc;
    const committed = new Set(soc.rows.map((x) => String(ref(x.service_offering))));
    const offenders = offerings.filter((o) => !committed.has(o.sys_id) && isEmpty(ref(o.sla))).map((o) => offender(o, 'commitment', 'no commitment and no SLA'));
    return { offenders, observed: { offerings: offerings.length, uncommitted: offenders.length }, expected: 0, absent: false,
      population: judgedPop(offerings.length, offerings.length, 'service offerings', 'service_offering_commitment rows and the offering\'s SLA field') };
  },

  /** CSDM-008 — a record in a CSDM class whose classification names another layer. `rows` are the service records. */
  csdm_classification_mismatch: ({ classification }) => async (rows, ctx) => {
    const L = await layerFn(ctx, classification); if (L.unavailable) return L;
    const byValue = new Map(Object.entries(classification).map(([layer, v]) => [String(v), layer]));
    const judged = rows.filter((r) => r.sys_class_name !== 'cmdb_ci_service' && r.sys_class_name !== 'service_offering' && L.fn(r) && !isEmpty(r.service_classification) && byValue.has(String(r.service_classification)));
    const offenders = judged.filter((r) => byValue.get(String(r.service_classification)) !== L.fn(r)).map((r) => offender(r, 'service_classification', `class ${r.sys_class_name} (${L.fn(r)}) classified as ${byValue.get(String(r.service_classification))}`));
    return { offenders, observed: { records: rows.length, judged: judged.length, mismatched: offenders.length }, expected: 0, absent: false,
      population: judgedPop(rows.length, judged.length, 'service records', 'records in a CSDM layer class with a classification') };
  },

  /** CSDM-011 — business services or offerings related directly to an infrastructure CI (not a service, application or capability). */
  csdm_layer_skip: ({ classification }) => async (rows, ctx) => {
    const L = await layerFn(ctx, classification); if (L.unavailable) return L;
    const top = rows.filter((r) => ['business', 'offering'].includes(L.fn(r)));
    if (!top.length) return { offenders: [], observed: { records: 0 }, expected: 0, absent: false, population: judgedPop(0, 0, 'business services and offerings', 'no record in scope') };
    const e = await edgesTouching(ctx, top.map((r) => r.sys_id)); if (e.unavailable) return e;
    const services = new Set(rows.map((r) => r.sys_id));
    const modelled = new Set(services);
    for (const t of ['cmdb_ci_business_app', 'cmdb_ci_business_capability', 'cmdb_ci_information_object']) {
      const x = await rowsOf(ctx, { table: t, fields: ['name'], complete: true }); if (x.unavailable) return x;
      for (const r of x.rows) modelled.add(r.sys_id);
    }
    const topIds = new Set(top.map((r) => r.sys_id));
    const skip = new Map();
    for (const edge of e.edges) {
      const [mine, other] = topIds.has(edge.parent) ? [edge.parent, edge.child] : [edge.child, edge.parent];
      if (topIds.has(mine) && !modelled.has(other)) skip.set(mine, (skip.get(mine) || 0) + 1);
    }
    const offenders = top.filter((r) => skip.has(r.sys_id)).map((r) => offender(r, 'relationships', `${skip.get(r.sys_id)} direct relationship(s) to infrastructure CIs`));
    return { offenders, observed: { records: top.length, with_shortcuts: offenders.length }, expected: 0, absent: false,
      population: judgedPop(top.length, top.length, 'business services and offerings', 'their relationships to records outside the service, application and capability layers') };
  },

  /** CSDM-015 — service records incidents reference that sit in no CSDM layer. `rows` are the service records. */
  csdm_unlayered_referenced: ({ classification }) => async (rows, ctx) => {
    const L = await layerFn(ctx, classification); if (L.unavailable) return L;
    const g = await countsBy(ctx, { table: 'incident', query: 'business_serviceISNOTEMPTY', groupBy: ['business_service'] });
    if (g.unavailable) return g;
    const byId = new Map(rows.map((r) => [r.sys_id, r]));
    const referenced = g.groups.map((x) => ({ id: String(ref(x.group.business_service)), n: x.count })).filter((x) => byId.has(x.id));
    const offenders = referenced.filter((x) => !L.fn(byId.get(x.id))).map((x) => offender(byId.get(x.id), 'sys_class_name', `class ${byId.get(x.id).sys_class_name}, no classification — referenced by ${x.n} incident(s)`));
    return { offenders, observed: { referenced_services: referenced.length, outside_layers: offenders.length }, expected: 0, absent: false, coverage: g.coverage,
      population: judgedPop(referenced.length, referenced.length, 'service records incidents reference', 'the business_service of incidents, against the CSDM layers') };
  },

  /** CSDM-019 — stage/status pairs no active life_cycle_control permits for the record's class (inheritance included). */
  csdm_lifecycle_combination: () => async (rows, ctx) => {
    const judged = rows.filter((r) => !isEmpty(ref(r.life_cycle_stage)) && !isEmpty(ref(r.life_cycle_stage_status)));
    const controls = await rowsOf(ctx, { table: 'life_cycle_control', fields: ['life_cycle_stage', 'life_cycle_stage_status', 'table', 'active'], query: 'active=true', complete: true });
    if (controls.unavailable) return controls;
    const tableNames = new Map();
    const tableIds = [...new Set(controls.rows.map((c) => String(ref(c.table) ?? '')).filter((x) => x && x !== 'null'))];
    if (tableIds.length) { const t = await inChunks(ctx, { table: 'sys_db_object', fields: ['name'], field: 'sys_id', ids: tableIds }); if (t.unavailable) return t; for (const x of t.rows) tableNames.set(x.sys_id, x.name); }
    const chains = new Map();
    const chainOf = async (cls) => {
      if (chains.has(cls)) return chains.get(cls);
      const chain = [cls]; let cur = cls;
      for (let i = 0; i < 12 && cur; i += 1) {
        const r = await rowsOf(ctx, { table: 'sys_db_object', fields: ['name', 'super_class.name'], query: `name=${cur}`, complete: true });
        if (r.unavailable) return r;
        cur = r.rows[0]?.['super_class.name'] || null;
        if (cur) chain.push(cur);
      }
      chains.set(cls, chain); return chain;
    };
    const offenders = [];
    for (const r of judged) {
      const chain = await chainOf(r.sys_class_name); if (chain.unavailable) return chain;
      const ok = controls.rows.some((c) => String(ref(c.life_cycle_stage)) === String(ref(r.life_cycle_stage)) && String(ref(c.life_cycle_stage_status)) === String(ref(r.life_cycle_stage_status))
        && (isEmpty(ref(c.table)) || chain.includes(tableNames.get(String(ref(c.table))))));
      if (!ok) offenders.push(offender(r, 'life_cycle_stage_status', 'stage and status not a permitted combination for its class'));
    }
    return { offenders, observed: { records: rows.length, judged: judged.length, controls: controls.rows.length, invalid: offenders.length }, expected: 0, absent: false,
      population: judgedPop(judged.length, judged.length, 'service records with a stage and status', 'the instance\'s active life_cycle_control combinations, per class and its ancestors') };
  },

  /** CSDM-021 — operational services whose supporting CIs are all retired. */
  csdm_operational_all_retired: ({ operational, retired_install, retired_operational }) => async (rows, ctx) => {
    const live = rows.filter((r) => String(r.operational_status) === String(operational) && r.sys_class_name !== 'service_offering');
    if (!live.length) return { offenders: [], observed: { operational: 0 }, expected: 0, absent: false, population: judgedPop(0, 0, 'operational services', 'no operational service') };
    const e = await edgesTouching(ctx, live.map((r) => r.sys_id)); if (e.unavailable) return e;
    const s = await supportingCis(ctx, live.map((r) => r.sys_id), e.edges); if (s.unavailable) return s;
    const ciIds = [...new Set([...s.by.values()].flatMap((x) => [...x]))];
    const cis = await inChunks(ctx, { table: 'cmdb_ci', fields: ['install_status', 'operational_status'], field: 'sys_id', ids: ciIds }); if (cis.unavailable) return cis;
    const retired = new Set(cis.rows.filter((c) => String(c.install_status) === String(retired_install) || String(c.operational_status) === String(retired_operational)).map((c) => c.sys_id));
    const judged = live.filter((r) => s.by.get(r.sys_id).size > 0);
    const offenders = judged.filter((r) => [...s.by.get(r.sys_id)].every((c) => retired.has(c))).map((r) => offender(r, 'supporting_cis', `all ${s.by.get(r.sys_id).size} supporting CI(s) retired`));
    return { offenders, observed: { operational: live.length, with_supporting_cis: judged.length, all_retired: offenders.length }, expected: 0, absent: false,
      population: judgedPop(live.length, judged.length, 'operational services with supporting CIs', 'svc_ci_assoc and outgoing relationships, against retired install or operational status') };
  },

  /** CSDM-022 / 023 / 024 — services at a named lifecycle stage, with their open incidents, commitments or live CIs. */
  /* `stage` is one stage name or a list (CSDM-029: the pre-operational stages); `exclude_statuses` are statuses not judged (Pilot). */
  csdm_stage_contradiction: ({ stage, check, operational, window, exclude_statuses = [] }) => async (rows, ctx) => {
    const names = Array.isArray(stage) ? stage : [stage];
    stage = names.join(' / ');
    const stages = await rowsOf(ctx, { table: 'life_cycle_stage', fields: ['name'], query: `nameIN${names.join(',')}`, complete: true });
    if (stages.unavailable) return stages;
    const ids = new Set(stages.rows.map((x) => x.sys_id));
    if (!ids.size) return { unavailable: `no life cycle stage named "${stage}" on this instance` };
    let skip = new Set();
    if (exclude_statuses.length) {
      const st = await rowsOf(ctx, { table: 'life_cycle_stage_status', fields: ['name'], query: `nameIN${exclude_statuses.join(',')}`, complete: true });
      if (st.unavailable) return st;
      skip = new Set(st.rows.map((x) => x.sys_id));
    }
    const at = rows.filter((r) => ids.has(String(ref(r.life_cycle_stage))) && !skip.has(String(ref(r.life_cycle_stage_status))));
    if (!at.length) return { offenders: [], observed: { at_stage: 0 }, expected: 0, absent: false, population: judgedPop(0, 0, `services at ${stage}`, `no service at the ${stage} stage`) };
    const since = window ? ctx.run.window(window).start_snow : null;
    const incidents = async (extra) => {
      const out = new Map();
      for (const c of chunks(at.map((r) => r.sys_id))) {
        const g = await countsBy(ctx, { table: 'incident', query: `business_serviceIN${c.join(',')}${extra ? `^${extra}` : ''}`, groupBy: ['business_service'] });
        if (g.unavailable) return g;
        for (const x of g.groups) out.set(String(ref(x.group.business_service)), x.count);
      }
      return { out };
    };
    let offenders = [];
    if (check === 'any_incidents') {
      const i = await incidents(''); if (i.unavailable) return i;
      offenders = at.filter((r) => (i.out.get(r.sys_id) || 0) > 0).map((r) => offender(r, 'incidents', `${i.out.get(r.sys_id)} incident(s) on a service still at ${stage}`));
    } else if (check === 'open_incidents') {
      const i = await incidents('active=true'); if (i.unavailable) return i;
      offenders = at.filter((r) => (i.out.get(r.sys_id) || 0) > 0).map((r) => offender(r, 'incidents', `${i.out.get(r.sys_id)} open incident(s) at stage ${stage}`));
    } else if (check === 'active_sla') {
      const offerings = rows.filter((r) => r.sys_class_name === 'service_offering' && at.some((a) => a.sys_id === String(ref(r.parent))));
      const soc = await inChunks(ctx, { table: 'service_offering_commitment', fields: ['service_offering', 'service_commitment'], field: 'service_offering', ids: offerings.map((o) => o.sys_id) }); if (soc.unavailable) return soc;
      const sc = await inChunks(ctx, { table: 'service_commitment', fields: ['sla'], field: 'sys_id', ids: soc.rows.map((x) => String(ref(x.service_commitment))) }); if (sc.unavailable) return sc;
      const sla = await inChunks(ctx, { table: 'contract_sla', fields: ['active'], field: 'sys_id', ids: sc.rows.map((x) => String(ref(x.sla))).filter((x) => x && x !== 'null') }); if (sla.unavailable) return sla;
      const activeSla = new Set(sla.rows.filter((x) => String(x.active) === 'true').map((x) => x.sys_id));
      const slaOfCommitment = new Map(sc.rows.map((x) => [x.sys_id, String(ref(x.sla))]));
      const parentOf = new Map(offerings.map((o) => [o.sys_id, String(ref(o.parent))]));
      const hit = new Set(soc.rows.filter((x) => activeSla.has(slaOfCommitment.get(String(ref(x.service_commitment))))).map((x) => parentOf.get(String(ref(x.service_offering)))));
      offenders = at.filter((r) => hit.has(r.sys_id)).map((r) => offender(r, 'sla', `an active SLA through its offerings' commitments at stage ${stage}`));
    } else if (check === 'live_cis_recent_incidents') {
      const i = await incidents(`sys_created_on>=${since}`); if (i.unavailable) return i;
      const e = await edgesTouching(ctx, at.map((r) => r.sys_id)); if (e.unavailable) return e;
      const s = await supportingCis(ctx, at.map((r) => r.sys_id), e.edges); if (s.unavailable) return s;
      const cis = await inChunks(ctx, { table: 'cmdb_ci', fields: ['operational_status'], field: 'sys_id', ids: [...new Set([...s.by.values()].flatMap((x) => [...x]))] }); if (cis.unavailable) return cis;
      const live = new Set(cis.rows.filter((c) => String(c.operational_status) === String(operational)).map((c) => c.sys_id));
      offenders = at.filter((r) => [...s.by.get(r.sys_id)].some((c) => live.has(c)) && (i.out.get(r.sys_id) || 0) > 0)
        .map((r) => offender(r, 'lifecycle', `stage ${stage}, operational supporting CIs, ${i.out.get(r.sys_id)} incident(s) in ${window} — contradictory evidence, hold back from bulk remediation`));
    }
    return { offenders, observed: { at_stage: at.length, contradicted: offenders.length }, expected: 0, absent: false,
      population: judgedPop(at.length, at.length, `services at ${stage}`, `services whose life cycle stage is ${stage}`) };
  },

  /** CSDM-026 — a class where one lifecycle value holds more than `share`% of records and equals the field's default. */
  csdm_default_lifecycle: ({ share }) => async (rows, ctx) => {
    const d = await rowsOf(ctx, { table: 'sys_dictionary', fields: ['name', 'element', 'default_value'], query: 'element=life_cycle_stage^nameINcmdb_ci,cmdb_ci_service', complete: true });
    if (d.unavailable) return d;
    const dflt = String(d.rows.find((x) => x.name === 'cmdb_ci_service')?.default_value ?? d.rows.find((x) => x.name === 'cmdb_ci')?.default_value ?? '');
    const byClass = new Map();
    for (const r of rows) { const k = r.sys_class_name; if (!byClass.has(k)) byClass.set(k, []); byClass.get(k).push(String(ref(r.life_cycle_stage) ?? '')); }
    const offenders = [];
    for (const [cls, values] of byClass) {
      const counts = new Map(); for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
      const [top, n] = [...counts].sort((a, b) => b[1] - a[1])[0];
      const pct = (100 * n) / values.length;
      if (pct > share && top === dflt) offenders.push({ sys_id: null, field: 'life_cycle_stage', value: `${cls}: ${round1(pct)}% of ${values.length} at the default (${dflt || 'empty'})` });
    }
    return { offenders, observed: { classes: byClass.size, default: dflt || '(empty)', at_default: offenders.length }, expected: `≤ ${share}% at the default`, absent: false,
      population: judgedPop(byClass.size, byClass.size, 'service classes', 'the life cycle stage distribution per class, against the dictionary default') };
  },

  /** CSDM-037 — business applications and their application services owned or supported by different people or groups. */
  csdm_app_ownership: ({ classification }) => async (rows, ctx) => {
    const L = await layerFn(ctx, classification); if (L.unavailable) return L;
    const apps = await rowsOf(ctx, { table: 'cmdb_ci_business_app', fields: ['name', 'owned_by', 'support_group'], complete: true }); if (apps.unavailable) return apps;
    if (!apps.rows.length) return { offenders: [], observed: { applications: 0 }, expected: 0, absent: false, population: judgedPop(0, 0, 'business applications', 'no business application') };
    const e = await edgesTouching(ctx, apps.rows.map((a) => a.sys_id)); if (e.unavailable) return e;
    const svc = new Map(rows.filter((r) => L.fn(r) === 'application').map((r) => [r.sys_id, r]));
    const n = neighbours(e.edges);
    const offenders = [];
    let judged = 0;
    for (const a of apps.rows) {
      const kids = [...(n.get(a.sys_id) || [])].map((x) => svc.get(x)).filter(Boolean);
      if (!kids.length) continue;
      judged += 1;
      const differs = kids.filter((k) => ['owned_by', 'support_group'].some((f) => !isEmpty(ref(a[f])) && !isEmpty(ref(k[f])) && String(ref(a[f])) !== String(ref(k[f]))));
      if (differs.length) offenders.push(offender(a, 'owned_by', `${differs.length} of ${kids.length} application service(s) owned or supported differently`));
    }
    return { offenders, observed: { applications: apps.rows.length, judged, divergent: offenders.length }, expected: 0, absent: false,
      population: judgedPop(apps.rows.length, judged, 'business applications with application services', 'owned_by and support_group, both populated') };
  },

  /** CSDM-038 — owners holding more than `max_share`% of the services. */
  csdm_owner_share: ({ classification, max_share }) => async (rows, ctx) => {
    const L = await layerFn(ctx, classification); if (L.unavailable) return L;
    const owned = rows.filter((r) => ['business', 'technical', 'application'].includes(L.fn(r)) && !isEmpty(ref(r.owned_by)));
    const by = new Map(); for (const r of owned) { const o = String(ref(r.owned_by)); by.set(o, (by.get(o) || 0) + 1); }
    const offenders = [...by].filter(([, n]) => (100 * n) / owned.length > max_share).map(([o, n]) => ({ sys_id: o, field: 'owned_by', value: `owns ${n} of ${owned.length} services (${round1((100 * n) / owned.length)}%)` }));
    return { offenders, observed: { services_with_owner: owned.length, owners: by.size, over: offenders.length }, expected: `≤ ${max_share}% per owner`, absent: false,
      population: judgedPop(owned.length, owned.length, 'owned services', 'owned_by across business, technical and application services') };
  },

  /** CSDM-041 — offerings owned by someone other than their parent service's owner (both populated). */
  csdm_offering_owner: () => async (rows) => {
    const byId = new Map(rows.map((r) => [r.sys_id, r]));
    const judged = rows.filter((r) => r.sys_class_name === 'service_offering' && !isEmpty(ref(r.owned_by)) && !isEmpty(ref(byId.get(String(ref(r.parent)))?.owned_by)));
    const offenders = judged.filter((r) => String(ref(r.owned_by)) !== String(ref(byId.get(String(ref(r.parent))).owned_by))).map((r) => offender(r, 'owned_by', 'owner differs from the parent service\'s owner'));
    return { offenders, observed: { judged: judged.length, differing: offenders.length }, expected: 0, absent: false,
      population: judgedPop(judged.length, judged.length, 'offerings with an owner under an owned service', 'owned_by, offering against parent') };
  },

  /** CSDM-044 — parent services whose child services span production and non-production (used_for populated). */
  csdm_mixed_environment: ({ production }) => async (rows) => {
    const kids = new Map();
    for (const r of rows) { const p = String(ref(r.parent) ?? ''); if (!p || p === 'null' || isEmpty(r.used_for)) continue; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(r); }
    const byId = new Map(rows.map((r) => [r.sys_id, r]));
    const judged = [...kids].filter(([, k]) => k.length > 1);
    const offenders = judged.filter(([, k]) => k.some((x) => String(x.used_for) === String(production)) && k.some((x) => String(x.used_for) !== String(production)))
      .map(([p, k]) => ({ sys_id: p, field: 'used_for', value: `${byId.get(p)?.name ?? p}: children in production and non-production (${k.length} children)` }));
    return { offenders, observed: { parents: judged.length, mixed: offenders.length }, expected: 0, absent: false,
      population: judgedPop(judged.length, judged.length, 'parent services with two or more classified children', 'children\'s used_for (populated only; a child without used_for is not judged here)') };
  },

  /** CSDM-046 — business services whose related application services are all non-production (used_for populated). */
  csdm_business_nonprod_only: ({ classification, production }) => async (rows, ctx) => {
    const L = await layerFn(ctx, classification); if (L.unavailable) return L;
    const business = rows.filter((r) => L.fn(r) === 'business');
    const apps = new Map(rows.filter((r) => L.fn(r) === 'application').map((r) => [r.sys_id, r]));
    if (!business.length) return { offenders: [], observed: { business: 0 }, expected: 0, absent: false, population: judgedPop(0, 0, 'business services', 'no business service') };
    const e = await edgesTouching(ctx, business.map((r) => r.sys_id)); if (e.unavailable) return e;
    const n = neighbours(e.edges);
    for (const a of apps.values()) { const p = String(ref(a.parent) ?? ''); if (p) { if (!n.has(p)) n.set(p, new Set()); n.get(p).add(a.sys_id); } }
    const judged = []; const offenders = [];
    for (const b of business) {
      const as = [...(n.get(b.sys_id) || [])].map((x) => apps.get(x)).filter(Boolean);
      if (!as.length || as.some((a) => isEmpty(a.used_for))) continue;
      judged.push(b);
      if (as.every((a) => String(a.used_for) !== String(production))) offenders.push(offender(b, 'used_for', `all ${as.length} application service(s) non-production`));
    }
    return { offenders, observed: { business: business.length, judged: judged.length, nonprod_only: offenders.length }, expected: 0, absent: false,
      population: judgedPop(business.length, judged.length, 'business services with classified application services', 'related application services, every one with used_for set') };
  },

  /** CSDM-048 — non-production services whose supporting CIs are production (the other direction is CSDM-047 ≡ CMDB-111). */
  csdm_nonprod_service_prod_cis: ({ production, ci_production }) => async (rows, ctx) => {
    const svc = rows.filter((r) => !isEmpty(r.used_for) && String(r.used_for) !== String(production) && r.sys_class_name !== 'service_offering');
    if (!svc.length) return { offenders: [], observed: { nonprod: 0 }, expected: 0, absent: false, population: judgedPop(0, 0, 'non-production services', 'no non-production service') };
    const e = await edgesTouching(ctx, svc.map((r) => r.sys_id)); if (e.unavailable) return e;
    const s = await supportingCis(ctx, svc.map((r) => r.sys_id), e.edges); if (s.unavailable) return s;
    const cis = await inChunks(ctx, { table: 'cmdb_ci', fields: ['environment'], field: 'sys_id', ids: [...new Set([...s.by.values()].flatMap((x) => [...x]))] }); if (cis.unavailable) return cis;
    const prod = new Set(cis.rows.filter((c) => String(c.environment) === String(ci_production)).map((c) => c.sys_id));
    const judged = svc.filter((r) => s.by.get(r.sys_id).size);
    const offenders = judged.filter((r) => [...s.by.get(r.sys_id)].some((c) => prod.has(c))).map((r) => offender(r, 'environment', 'non-production service supported by production CI(s)'));
    return { offenders, observed: { nonprod: svc.length, judged: judged.length, mismatched: offenders.length }, expected: 0, absent: false,
      population: judgedPop(svc.length, judged.length, 'non-production services with supporting CIs', 'the supporting CIs\' environment') };
  },

  /** CSDM-056 — cycles among service records (relationships and the parent field); symmetric peer types excluded. */
  csdm_service_cycles: () => async (rows, ctx) => {
    const ids = rows.map((r) => r.sys_id);
    const e = await edgesTouching(ctx, ids); if (e.unavailable) return e;
    const types = await rowsOf(ctx, { table: 'cmdb_rel_type', fields: ['parent_descriptor', 'child_descriptor'], complete: true }); if (types.unavailable) return types;
    const symmetric = new Set(types.rows.filter((t) => String(t.parent_descriptor) === String(t.child_descriptor)).map((t) => t.sys_id));
    const inSet = new Set(ids);
    const adj = new Map(ids.map((i) => [i, []]));
    for (const x of e.edges) if (inSet.has(x.parent) && inSet.has(x.child) && !symmetric.has(x.type)) adj.get(x.parent).push(x.child);
    for (const r of rows) { const p = String(ref(r.parent) ?? ''); if (inSet.has(p)) adj.get(p).push(r.sys_id); }
    /* Tarjan's strongly connected components: a component of two or more, or a self edge, is a cycle. */
    let index = 0; const idx = new Map(); const low = new Map(); const stack = []; const on = new Set(); const sccs = [];
    const strong = (v) => {
      const work = [[v, 0]]; idx.set(v, index); low.set(v, index); index += 1; stack.push(v); on.add(v);
      while (work.length) {
        const [n, i] = work[work.length - 1];
        const next = adj.get(n) || [];
        if (i < next.length) {
          work[work.length - 1][1] += 1;
          const w = next[i];
          if (!idx.has(w)) { idx.set(w, index); low.set(w, index); index += 1; stack.push(w); on.add(w); work.push([w, 0]); }
          else if (on.has(w)) low.set(n, Math.min(low.get(n), idx.get(w)));
        } else {
          work.pop();
          if (work.length) { const p = work[work.length - 1][0]; low.set(p, Math.min(low.get(p), low.get(n))); }
          if (low.get(n) === idx.get(n)) { const c = []; let w; do { w = stack.pop(); on.delete(w); c.push(w); } while (w !== n); sccs.push(c); }
        }
      }
    };
    for (const v of ids) if (!idx.has(v)) strong(v);
    const cycles = sccs.filter((c) => c.length > 1 || (adj.get(c[0]) || []).includes(c[0]));
    const byId = new Map(rows.map((r) => [r.sys_id, r]));
    const offenders = cycles.flatMap((c) => c.map((id) => offender(byId.get(id), 'relationships', `on a cycle of ${c.length} service record(s)`)));
    return { offenders, observed: { services: ids.length, cycles: cycles.length }, expected: 0, absent: false,
      population: judgedPop(ids.length, ids.length, 'service records', 'relationships between service records and the parent field; symmetric peer types excluded') };
  },

  /** CSDM-058 — share of services whose downward traversal (to `depth`) reaches a network-class CI; fails when none does. */
  csdm_network_reach: ({ classification, depth }) => async (rows, ctx) => {
    const L = await layerFn(ctx, classification); if (L.unavailable) return L;
    const net = await subclasses(ctx, 'cmdb_ci_netgear'); if (net.unavailable) return net;
    const services = rows.filter((r) => ['business', 'technical', 'application'].includes(L.fn(r)));
    if (!services.length) return { offenders: [], observed: { services: 0 }, expected: 0, absent: false, population: judgedPop(0, 0, 'services', 'no service') };
    const reach = new Map(services.map((s) => [s.sys_id, new Set([s.sys_id])]));
    let frontier = new Map(services.map((s) => [s.sys_id, [s.sys_id]]));
    const classOf = new Map();
    for (let d = 0; d < depth; d += 1) {
      const ids = [...new Set([...frontier.values()].flat())];
      if (!ids.length) break;
      const edges = await inChunks(ctx, { table: 'cmdb_rel_ci', fields: ['parent', 'child'], field: 'parent', ids }); if (edges.unavailable) return edges;
      const kids = new Map(); for (const e of edges.rows) { const p = String(ref(e.parent)); if (!kids.has(p)) kids.set(p, []); kids.get(p).push(String(ref(e.child))); }
      const next = new Map();
      for (const [s, f] of frontier) { const n = f.flatMap((x) => kids.get(x) || []).filter((x) => !reach.get(s).has(x)); n.forEach((x) => reach.get(s).add(x)); next.set(s, n); }
      frontier = next;
    }
    const all = [...new Set([...reach.values()].flatMap((x) => [...x]))].filter((x) => !classOf.has(x));
    const cis = await inChunks(ctx, { table: 'cmdb_ci', fields: ['sys_class_name'], field: 'sys_id', ids: all }); if (cis.unavailable) return cis;
    for (const c of cis.rows) classOf.set(c.sys_id, c.sys_class_name);
    const reaching = services.filter((s) => [...reach.get(s.sys_id)].some((x) => net.classes.has(classOf.get(x))));
    return { offenders: reaching.length ? [] : [{ sys_id: null, field: 'relationships', value: `no service of ${services.length} reaches a network CI within ${depth} level(s)` }],
      observed: { services: services.length, reaching_network: reaching.length, depth }, expected: '≥ 1 service reaching the network tier', absent: false,
      kpi: { numerator: reaching.length, denominator: services.length, basis: `services whose downward traversal reaches a network CI within ${depth} level(s)` },
      population: estate('estate', `downward traversal from every service to depth ${depth}`) };
  },

  /** CSDM-060 — relationships of one type repeated between the same pair of service records. */
  csdm_duplicate_edges: () => async (rows, ctx) => {
    const ids = new Set(rows.map((r) => r.sys_id));
    const e = await edgesTouching(ctx, [...ids]); if (e.unavailable) return e;
    const between = e.edges.filter((x) => ids.has(x.parent) && ids.has(x.child));
    const groups = new Map(); for (const x of between) { const k = `${x.parent}|${x.child}|${x.type}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); }
    const offenders = [...groups.values()].filter((g) => g.length > 1).flatMap((g) => g.slice(1).map((x) => ({ sys_id: x.sys_id, field: 'type', value: `duplicate of ${g[0].sys_id} (${g.length} edges of one type between one pair)` })));
    return { offenders, observed: { edges: between.length, duplicate_sets: [...groups.values()].filter((g) => g.length > 1).length }, expected: 0, absent: false,
      population: judgedPop(between.length, between.length, 'relationships between service records', 'grouped by parent, child and type') };
  },
};

/* ── Phase 9 follow-up (D-032): the rules unblocked from the ServiceNow documentation ── */

/** Each class and its ancestors (sys_db_object super_class), walked once per class: Map(class → [class, parent, …]). */
export async function ancestors(ctx, classes) {
  const out = new Map();
  for (const cls of [...new Set(classes)].filter(Boolean)) {
    const chain = await shared(ctx, `csdm:chain:${cls}`, async () => {
      const c = [cls]; let cur = cls;
      for (let i = 0; i < 12 && cur; i += 1) {
        const r = await rowsOf(ctx, { table: 'sys_db_object', fields: ['name', 'super_class.name'], query: `name=${cur}`, complete: true });
        if (r.unavailable) return r;
        cur = r.rows[0]?.['super_class.name'] || null;
        if (cur) c.push(cur);
      }
      return c;
    });
    if (chain.unavailable) return chain;
    out.set(cls, chain);
  }
  return { chains: out };
}
/** The personal-data fields: dictionary entries tagged (m2m_dictionary_dataclass) with one of `classes` (data_classification names). */
export async function personalFields(ctx, classes) {
  const dc = await rowsOf(ctx, { table: 'data_classification', fields: ['name'], complete: true });
  if (dc.unavailable) return dc;
  const wanted = new Set(dc.rows.filter((r) => classes.includes(r.name)).map((r) => r.sys_id));
  const m2m = await rowsOf(ctx, { table: 'm2m_dictionary_dataclass', fields: ['data_class', 'sys_dictionary'], complete: true });
  if (m2m.unavailable) return m2m;
  const ids = [...new Set(m2m.rows.filter((r) => wanted.has(String(ref(r.data_class)))).map((r) => String(ref(r.sys_dictionary))))];
  const d = await inChunks(ctx, { table: 'sys_dictionary', fields: ['name', 'element'], field: 'sys_id', ids });
  if (d.unavailable) return d;
  return { fields: d.rows.filter((x) => !isEmpty(x.name) && !isEmpty(x.element)).map((x) => ({ sys_id: x.sys_id, table: x.name, element: x.element })), classes_found: [...wanted].length };
}

const CSDM_EXTRA = {
  /**
   * CSDM-058 — share of services whose downward traversal reaches a network-class CI; fails when none
   * does. The depth is the instance's own impact depth: the `glide.relationship.max_depth` property,
   * or ServiceNow's documented default (10) when the property is not set.
   */
  csdm_network_reach_platform_depth: ({ classification, property, platform_default }) => async (rows, ctx) => {
    const p = await rowsOf(ctx, { table: 'sys_properties', fields: ['name', 'value'], query: `name=${property}`, complete: true });
    if (p.unavailable) return p;
    const set = Number(p.rows[0]?.value);
    const depth = Number.isFinite(set) && set > 0 ? set : platform_default;
    const res = await BASE_COMPARATORS.csdm_network_reach({ classification, depth })(rows, ctx);
    if (res.observed) res.observed.depth_source = Number.isFinite(set) && set > 0 ? `${property} = ${set}` : `${property} not set — ServiceNow default ${platform_default}`;
    return res;
  },

  /** CSDM-028 — a parent service at `parent_stage` with a child (parent field) at `child_stage`. */
  csdm_parent_child_lifecycle: ({ parent_stage, child_stage }) => async (rows, ctx) => {
    const st = await rowsOf(ctx, { table: 'life_cycle_stage', fields: ['name'], query: `nameIN${parent_stage},${child_stage}`, complete: true });
    if (st.unavailable) return st;
    const id = (n) => st.rows.find((x) => x.name === n)?.sys_id;
    if (!id(parent_stage) || !id(child_stage)) return { unavailable: `life cycle stage "${!id(parent_stage) ? parent_stage : child_stage}" is not on this instance` };
    const byId = new Map(rows.map((r) => [r.sys_id, r]));
    const judged = rows.filter((r) => byId.has(String(ref(r.parent))) && !isEmpty(ref(r.life_cycle_stage)) && !isEmpty(ref(byId.get(String(ref(r.parent))).life_cycle_stage)));
    const offenders = judged.filter((r) => String(ref(r.life_cycle_stage)) === id(child_stage) && String(ref(byId.get(String(ref(r.parent))).life_cycle_stage)) === id(parent_stage))
      .map((r) => offender(r, 'life_cycle_stage', `${child_stage} under a parent at ${parent_stage} (${byId.get(String(ref(r.parent))).name})`));
    return { offenders, observed: { pairs_judged: judged.length, conflicting: offenders.length }, expected: 0, absent: false,
      population: judgedPop(judged.length, judged.length, 'parent-child service pairs with both stages set', `the parent field; the one conflict judged: parent ${parent_stage}, child ${child_stage}`) };
  },

  /**
   * CSDM-051 / CSDM-055 — relationships the instance's OWN suggested-relationship list does not
   * allow (cmdb_rel_type_suggest, CI Class Manager: base class, dependent class, type, direction;
   * ancestors included). A class pair the list says nothing about is not judged ("check whether
   * type scoping is configured at all").
   *   mode 'types'       edges between CSDM-layer records whose TYPE is not suggested for the pair
   *   mode 'containment' application services' outgoing edges to CIs whose CLASS is not a suggested
   *                      dependent class of the application-service class
   */
  csdm_suggested_relationships: ({ classification, mode }) => async (rows, ctx) => {
    const L = await layerFn(ctx, classification); if (L.unavailable) return L;
    const services = new Map(rows.map((r) => [r.sys_id, r]));
    const extra = new Map();
    for (const t of ['cmdb_ci_business_app', 'cmdb_ci_business_capability', 'cmdb_ci_information_object']) {
      /* Business application, capability and information object: their own tables are their classes. */
      const x = await rowsOf(ctx, { table: t, fields: ['name'], complete: true }); if (x.unavailable) return x;
      for (const r of x.rows) extra.set(r.sys_id, { ...r, sys_class_name: t });
    }
    const layered = new Map([...rows.filter((r) => L.fn(r)).map((r) => [r.sys_id, r]), ...extra]);
    const layerOf = (r) => (extra.has(r.sys_id) ? r.sys_class_name : L.fn(r));
    const from = mode === 'containment' ? rows.filter((r) => L.fn(r) === 'application') : [...layered.values()];
    if (!from.length) return { offenders: [], observed: { records: 0 }, expected: 0, absent: false, population: judgedPop(0, 0, mode === 'containment' ? 'application services' : 'CSDM-layer records', 'no record in scope') };
    const e = await edgesTouching(ctx, from.map((r) => r.sys_id)); if (e.unavailable) return e;
    const edges = mode === 'containment'
      ? e.edges.filter((x) => from.some((r) => r.sys_id === x.parent) && !services.has(x.child) && !extra.has(x.child))
      /* Between LAYERS: both ends in a CSDM layer, and not the same layer (a service hierarchy is not a layer pair). */
      : e.edges.filter((x) => layered.has(x.parent) && layered.has(x.child) && layerOf(layered.get(x.parent)) !== layerOf(layered.get(x.child)));
    const otherIds = [...new Set(edges.map((x) => x.child).filter((id) => !layered.has(id) && !services.has(id)))];
    const cis = await inChunks(ctx, { table: 'cmdb_ci', fields: ['name', 'sys_class_name'], field: 'sys_id', ids: otherIds }); if (cis.unavailable) return cis;
    const recOf = new Map([...layered, ...services, ...cis.rows.map((c) => [c.sys_id, c])]);
    const sug = await rowsOf(ctx, { table: 'cmdb_rel_type_suggest', fields: ['base_class', 'dependent_class', 'cmdb_rel_type', 'parent', 'child'], complete: true }); if (sug.unavailable) return sug;
    /* As parent → child: a row whose base is the parent side with parent=true, or whose base is the child side with child=true. */
    const pairs = new Map();
    const add = (p, c, type) => { const k = `${p}|${c}`; if (!pairs.has(k)) pairs.set(k, new Set()); pairs.get(k).add(type); };
    for (const s of sug.rows) {
      const type = String(ref(s.cmdb_rel_type));
      if (String(s.parent) === 'true') add(s.base_class, s.dependent_class, type);
      if (String(s.child) === 'true') add(s.dependent_class, s.base_class, type);
    }
    const ch = await ancestors(ctx, [...new Set(edges.flatMap((x) => [recOf.get(x.parent)?.sys_class_name, recOf.get(x.child)?.sys_class_name]))]); if (ch.unavailable) return ch;
    const offenders = []; let judged = 0;
    for (const x of edges) {
      const pc = ch.chains.get(recOf.get(x.parent)?.sys_class_name) || []; const cc = ch.chains.get(recOf.get(x.child)?.sys_class_name) || [];
      const allowed = new Set(pc.flatMap((a) => cc.flatMap((b) => [...(pairs.get(`${a}|${b}`) || [])])));
      if (mode === 'containment') {
        const scoped = pc.some((a) => [...pairs.keys()].some((k) => k.startsWith(`${a}|`)));
        if (!scoped) continue;
        judged += 1;
        if (!allowed.size) offenders.push({ sys_id: x.sys_id, field: 'child', value: `${recOf.get(x.parent)?.name}: directly relates a ${recOf.get(x.child)?.sys_class_name}, not a suggested dependent class` });
      } else if (mode === 'direction') {
        /* CSDM-052 (D-033): the pair is suggested only the other way round — child → parent. */
        const reverse = new Set(cc.flatMap((b) => pc.flatMap((a) => [...(pairs.get(`${b}|${a}`) || [])])));
        if (!allowed.size && !reverse.size) continue;
        judged += 1;
        if (!allowed.size) offenders.push({ sys_id: x.sys_id, field: 'parent', value: `${recOf.get(x.parent)?.name} → ${recOf.get(x.child)?.name}: the instance suggests ${recOf.get(x.child)?.sys_class_name} → ${recOf.get(x.parent)?.sys_class_name}, the reverse` });
      } else {
        if (!allowed.size) continue;
        judged += 1;
        if (!allowed.has(x.type)) offenders.push({ sys_id: x.sys_id, field: 'type', value: `${recOf.get(x.parent)?.name} → ${recOf.get(x.child)?.name}: type not suggested for ${recOf.get(x.parent)?.sys_class_name} → ${recOf.get(x.child)?.sys_class_name}` });
      }
    }
    return { offenders, observed: { edges: edges.length, judged, not_suggested: offenders.length, suggestions: sug.rows.length }, expected: 0, absent: false,
      population: judgedPop(edges.length, judged, mode === 'containment' ? 'application-service relationships to CIs' : 'relationships between CSDM-layer records', 'the instance\'s suggested relationships (cmdb_rel_type_suggest), class ancestors included; a pair the list does not cover is not judged') };
  },

  /** CSDM-014 — personal data is classified on the instance but no information object exists. */
  csdm_information_object_layer: ({ classes }) => async (_rows, ctx) => {
    const pf = await personalFields(ctx, classes); if (pf.unavailable) return pf;
    if (!pf.fields.length) return { offenders: [], observed: { personal_fields: 0 }, expected: 0, absent: false, population: judgedPop(0, 0, 'estate', 'no field is classified as personal data', 'no personal data holding is classified') };
    const io = await rowsOf(ctx, { table: 'cmdb_ci_information_object', fields: ['name'], complete: true }); if (io.unavailable) return io;
    const tables = [...new Set(pf.fields.map((f) => f.table))];
    return { offenders: io.rows.length ? [] : [{ sys_id: null, field: 'cmdb_ci_information_object', value: `${pf.fields.length} personal-data field(s) on ${tables.length} table(s); no information object` }],
      observed: { personal_fields: pf.fields.length, tables: tables.length, information_objects: io.rows.length }, expected: '≥ 1 information object', absent: false,
      population: estate('estate', 'dictionary fields classified as personal data, against the information object layer') };
  },

  /**
   * CSDM-072 — the CSDM maturity stage the estate has reached, by ServiceNow's own staged approach
   * (CSDM 5 white paper): Foundation (referential data), Crawl (business applications and
   * application services), Walk (technology management services and their offerings), Run
   * (business services and their offerings), Fly (business capabilities and information objects).
   * A stage counts as reached when its tables are populated and every earlier stage is; ServiceNow
   * gives no percentage thresholds. Reported, never scored (the score is csdm-quality/2).
   */
  csdm_maturity_stage: ({ classification, foundation }) => async (rows, ctx) => {
    const L = await layerFn(ctx, classification); if (L.unavailable) return L;
    const count = async (t) => { const r = await ctx.reads.read(declareRequirement({ table: t, strategy: 'exists' })); return r.count == null ? { unavailable: `count over ${t} failed (${r.coverage?.status})` } : { n: r.count }; };
    const has = {};
    for (const t of [...foundation, 'cmdb_ci_business_app', 'cmdb_ci_business_capability', 'cmdb_ci_information_object']) { const c = await count(t); if (c.unavailable) return c; has[t] = c.n; }
    const n = (layer, cls) => rows.filter((r) => L.fn(r) === layer && (!cls || String(r.service_classification) === String(cls))).length;
    const offerings = (cls) => rows.filter((r) => L.fn(r) === 'offering' && String(r.service_classification) === String(cls)).length;
    const stages = [
      ['Foundation', foundation.every((t) => has[t] > 0), foundation.filter((t) => !(has[t] > 0)).map((t) => `${t} empty`)],
      ['Crawl', has.cmdb_ci_business_app > 0 && n('application') > 0, [has.cmdb_ci_business_app ? null : 'no business application', n('application') ? null : 'no application service'].filter(Boolean)],
      ['Walk', n('technical') > 0 && offerings(classification.technical) > 0, [n('technical') ? null : 'no technology management service', offerings(classification.technical) ? null : 'no technical service offering'].filter(Boolean)],
      ['Run', n('business') > 0 && offerings(classification.business) > 0, [n('business') ? null : 'no business service', offerings(classification.business) ? null : 'no business service offering'].filter(Boolean)],
      ['Fly', has.cmdb_ci_business_capability > 0 && has.cmdb_ci_information_object > 0, [has.cmdb_ci_business_capability ? null : 'no business capability', has.cmdb_ci_information_object ? null : 'no information object'].filter(Boolean)],
    ];
    let reached = null;
    for (const [name, ok] of stages) { if (!ok) break; reached = name; }
    const next = stages.find(([name, ok]) => !ok);
    return { offenders: [], observed: { stage: reached ?? 'below Foundation', next_stage: next ? next[0] : null, missing_for_next: next ? next[2] : [], stages: Object.fromEntries(stages.map(([name, ok]) => [name, ok])) },
      expected: 'reported, not scored', absent: false,
      population: estate('estate', 'the CSDM stage tables, in ServiceNow\'s order: Foundation → Crawl → Walk → Run → Fly') };
  },
};

export const CSDM_COMPARATORS = Object.freeze({ ...BASE_COMPARATORS, ...CSDM_EXTRA });
