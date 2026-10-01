import { declareRequirement } from '../itsm/data-access.js';
import { fromSnowTime } from '../itsm/run-context.js';
import { ancestors, layerFn, CSDM_COMPARATORS } from './comparators.js';

/**
 * D-033 — the CSDM comparators the documentation research made buildable
 * (docs/HEALTH-ASSIST-RULE-RESEARCH.md). Same contract as every comparator.
 *
 *   CSDM-020  the platform's own life cycle mapping (life_cycle_mapping: a legacy field
 *             value of a class → a life_cycle_control, i.e. a stage and status)
 *   CSDM-025 / 039  field history from sys_audit, judged only for records whose class
 *             table the dictionary says is audited — otherwise "no entry" proves nothing
 *   CSDM-045 / 067  SLA definitions scoped to a service by naming it in a condition
 */

const COMPLETE = 'complete';
const usable = (cov) => ['complete', 'limited', 'truncated'].includes(cov?.status);
const isEmpty = (v) => v === undefined || v === null || String(v).trim() === '';
const ref = (v) => (v && typeof v === 'object' ? v.value ?? v.sys_id ?? null : v);
const chunks = (xs, n = 100) => { const out = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };
const DAY_MS = 86400000;

async function rowsOf(ctx, { table, fields, query = '', complete = false }) {
  const r = await ctx.reads.read(declareRequirement({ table, fields, query, strategy: 'rows' }));
  if (!(complete ? r.coverage?.status === COMPLETE : usable(r.coverage))) return { unavailable: `${table} could not be read${complete ? ' completely' : ''} (${r.coverage?.status}${r.coverage?.error ? `: ${r.coverage.error}` : ''}) — no claim is made from a partial read`, coverage: r.coverage };
  return { rows: r.rows, coverage: r.coverage };
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
const pop = (total, judged, unit, basis) => ({ total, judged, unit, basis });
const offender = (r, field, value) => ({ sys_id: r.sys_id, field, value });
/** Service sys_ids a definition's conditions name (business_service / cmdb_ci / service_offering = <sys_id>). */
const namedIds = (d) => {
  const out = new Set();
  const text = [d.start_condition, d.pause_condition, d.stop_condition].join('^');
  for (const m of text.matchAll(/(?:^|\^|OR)(?:business_service|cmdb_ci|service_offering)(?:=|IN)([0-9a-f,]{32,})/g)) for (const id of m[1].split(',')) if (/^[0-9a-f]{32}$/.test(id)) out.add(id);
  return out;
};

export const CSDM_RESEARCH_COMPARATORS = Object.freeze({
  /**
   * CSDM-020 — services whose life cycle stage / status is not the one the platform's
   * life cycle mapping gives for their operational_status (their class or an ancestor).
   */
  csdm_lifecycle_vs_operational: ({ classification, legacy_field = 'operational_status' }) => async (rows, ctx) => {
    const L = await layerFn(ctx, classification); if (L.unavailable) return L;
    const services = rows.filter((r) => L.fn(r) && !isEmpty(r[legacy_field]) && !isEmpty(ref(r.life_cycle_stage)));
    const maps = await rowsOf(ctx, { table: 'life_cycle_mapping', fields: ['table', 'legacy_field_name', 'legacy_field_value', 'life_cycle_control', 'active'], query: `active=true^legacy_field_name=${legacy_field}`, complete: true });
    if (maps.unavailable) return maps;
    const controls = await inChunks(ctx, { table: 'life_cycle_control', fields: ['life_cycle_stage', 'life_cycle_stage_status'], field: 'sys_id', ids: maps.rows.map((m) => String(ref(m.life_cycle_control))) });
    if (controls.unavailable) return controls;
    const ctl = new Map(controls.rows.map((c) => [c.sys_id, c]));
    const ch = await ancestors(ctx, services.map((s) => s.sys_class_name)); if (ch.unavailable) return ch;
    const offenders = []; let judged = 0;
    for (const s of services) {
      const chain = ch.chains.get(s.sys_class_name) || [s.sys_class_name];
      const hits = maps.rows.filter((m) => chain.includes(m.table) && String(m.legacy_field_value) === String(s[legacy_field])).map((m) => ctl.get(String(ref(m.life_cycle_control)))).filter(Boolean);
      if (!hits.length) continue;
      judged += 1;
      const ok = hits.some((c) => String(ref(c.life_cycle_stage)) === String(ref(s.life_cycle_stage)) && (isEmpty(ref(c.life_cycle_stage_status)) || isEmpty(ref(s.life_cycle_stage_status)) || String(ref(c.life_cycle_stage_status)) === String(ref(s.life_cycle_stage_status))));
      if (!ok) offenders.push(offender(s, 'life_cycle_stage', `${s.name}: ${legacy_field} ${s[legacy_field]} maps to another life cycle stage than the one set`));
    }
    return { offenders, observed: { services: services.length, judged, contradicting: offenders.length }, expected: 0, absent: false,
      population: pop(services.length, judged, 'CSDM services with both fields set', `life_cycle_mapping for ${legacy_field} on the service class or an ancestor → life_cycle_control`) };
  },

  /**
   * CSDM-025 / CSDM-039 — CSDM services older than `min_age` days with no sys_audit
   * entry for `fields` since creation. Only services whose class table is audited
   * (sys_dictionary collection row, audit=true) are judged.
   */
  csdm_fields_never_changed: ({ classification, fields, min_age }) => async (rows, ctx) => {
    const L = await layerFn(ctx, classification); if (L.unavailable) return L;
    const now = new Date(ctx.run.run_started_at).getTime();
    const old = rows.filter((r) => L.fn(r) && fromSnowTime(r.sys_created_on) && now - fromSnowTime(r.sys_created_on) > min_age * DAY_MS);
    const tables = [...new Set(old.map((r) => r.sys_class_name))];
    const aud = await rowsOf(ctx, { table: 'sys_dictionary', fields: ['name', 'audit'], query: `nameIN${tables.join(',')}^internal_type=collection`, complete: true });
    if (aud.unavailable) return aud;
    const audited = new Set(aud.rows.filter((d) => String(d.audit) === 'true').map((d) => d.name));
    const judged = old.filter((r) => audited.has(r.sys_class_name));
    const changed = new Set();
    for (const c of chunks(judged.map((r) => r.sys_id))) {
      const a = await rowsOf(ctx, { table: 'sys_audit', fields: ['documentkey', 'fieldname'], query: `documentkeyIN${c.join(',')}^fieldnameIN${fields.join(',')}`, complete: true });
      if (a.unavailable) return a;
      for (const x of a.rows) changed.add(String(x.documentkey));
    }
    const offenders = judged.filter((r) => !changed.has(r.sys_id)).map((r) => offender(r, fields[0], `${r.name}: created ${String(r.sys_created_on).slice(0, 10)}, ${fields.join(' / ')} never changed`));
    return { offenders, observed: { services_older: old.length, audited_class_tables: [...audited], judged: judged.length, never_changed: offenders.length }, expected: 0, absent: false,
      population: pop(old.length, judged.length, `CSDM services older than ${min_age} days`, `sys_audit on ${fields.join(', ')}; a service whose class table is not audited is not judged`) };
  },

  /**
   * CSDM-045 — non-production services an active SLA definition names.
   * CSDM-067 (`with_offerings`) — services an SLA names although offerings exist beneath them.
   */
  csdm_sla_named_services: ({ mode, production }) => async (rows, ctx) => {
    const named = new Map();
    for (const d of rows) for (const id of namedIds(d)) { if (!named.has(id)) named.set(id, []); named.get(id).push(d); }
    const svc = await inChunks(ctx, { table: 'cmdb_ci_service', fields: ['name', 'used_for'], field: 'sys_id', ids: [...named.keys()] }); if (svc.unavailable) return svc;
    let offenders;
    if (mode === 'non_production') {
      offenders = svc.rows.filter((s) => !isEmpty(s.used_for) && String(s.used_for) !== String(production))
        .map((s) => offender(s, 'used_for', `${s.name} (${s.used_for}): a non-production service named by SLA ${named.get(s.sys_id).map((d) => d.name).join(', ')}`));
    } else {
      const offs = await inChunks(ctx, { table: 'service_offering', fields: ['parent'], field: 'parent', ids: svc.rows.map((s) => s.sys_id) }); if (offs.unavailable) return offs;
      const hasOffering = new Set(offs.rows.map((o) => String(ref(o.parent))));
      offenders = svc.rows.filter((s) => hasOffering.has(s.sys_id)).map((s) => offender(s, 'service_offering', `${s.name}: SLA ${named.get(s.sys_id).map((d) => d.name).join(', ')} names the service, which has offerings`));
    }
    return { offenders, observed: { definitions: rows.length, services_named: svc.rows.length, offenders: offenders.length }, expected: 0, absent: false,
      population: pop(svc.rows.length, svc.rows.length, 'services an SLA definition names', 'service sys_ids written in active SLA conditions') };
  },
});

/* ══ D-037 — traversal of the service model, and the maturity trend ═══════════════════ */

const LAYER_ORDER = ['business', 'technical', 'offering', 'application', 'infrastructure'];
/**
 * Walk each service DOWN its model (D-037): a service's offerings (service_offering.parent),
 * its outgoing relationships (cmdb_rel_ci parent → child) and, for an application service,
 * its mapped CIs (svc_ci_assoc), to the platform's impact depth (10, as CSDM-058). Each node's
 * layer comes from its class (layerFn); a CI that is no service layer is infrastructure.
 * Returns, per start service: the deepest layer reached, the layers seen and the leaves.
 */
export async function traverseServices(ctx, starts, classification, { depth = 10 } = {}) {
  const L = await layerFn(ctx, classification); if (L.unavailable) return L;
  const nodes = new Map();
  const readNodes = async (ids) => {
    const want = ids.filter((id) => !nodes.has(id));
    if (!want.length) return null;
    /* Services (offerings included) from their own table, with their classification; everything else from cmdb_ci. */
    const svc = await inChunks(ctx, { table: 'cmdb_ci_service', fields: ['name', 'sys_class_name', 'service_classification'], field: 'sys_id', ids: want }); if (svc.unavailable) return svc;
    for (const x of svc.rows) nodes.set(x.sys_id, { ...x, layer: L.fn(x) ?? 'infrastructure' });
    const rest = want.filter((id) => !nodes.has(id));
    const r = rest.length ? await inChunks(ctx, { table: 'cmdb_ci', fields: ['name', 'sys_class_name', 'discovery_source'], field: 'sys_id', ids: rest }) : { rows: [] }; if (r.unavailable) return r;
    for (const x of r.rows) nodes.set(x.sys_id, { ...x, layer: L.fn(x) ?? 'infrastructure' });
    for (const id of want) if (!nodes.has(id)) nodes.set(id, { sys_id: id, layer: 'infrastructure', missing: true });
    return null;
  };
  const children = new Map();
  let frontier = [...new Set(starts)];
  const e0 = await readNodes(frontier); if (e0?.unavailable) return e0;
  for (let d = 0; d < depth && frontier.length; d += 1) {
    const off = await inChunks(ctx, { table: 'service_offering', fields: ['parent'], field: 'parent', ids: frontier }); if (off.unavailable) return off;
    const rel = await inChunks(ctx, { table: 'cmdb_rel_ci', fields: ['parent', 'child'], field: 'parent', ids: frontier }); if (rel.unavailable) return rel;
    const apps = frontier.filter((id) => nodes.get(id)?.layer === 'application');
    const assoc = apps.length ? await inChunks(ctx, { table: 'svc_ci_assoc', fields: ['service_id', 'ci_id'], field: 'service_id', ids: apps }) : { rows: [] }; if (assoc.unavailable) return assoc;
    const add = (p, c) => { if (!p || !c || p === c) return; if (!children.has(p)) children.set(p, new Set()); children.get(p).add(c); };
    for (const o of off.rows) add(String(ref(o.parent)), o.sys_id);
    for (const e of rel.rows) add(String(ref(e.parent)), String(ref(e.child)));
    for (const a of assoc.rows) add(String(ref(a.service_id)), String(ref(a.ci_id)));
    const next = [...new Set(frontier.flatMap((id) => [...(children.get(id) || [])]))].filter((id) => !nodes.has(id));
    const e = await readNodes(next); if (e?.unavailable) return e;
    frontier = next;
  }
  const out = new Map();
  for (const s of new Set(starts)) {
    const seen = new Set([s]); const stack = [s]; const leaves = [];
    while (stack.length) { const v = stack.pop(); const ch = [...(children.get(v) || [])]; if (!ch.length && v !== s) leaves.push(v); for (const c of ch) if (!seen.has(c)) { seen.add(c); stack.push(c); } }
    const layers = new Set([...seen].map((id) => nodes.get(id)?.layer).filter(Boolean));
    const deepest = LAYER_ORDER.filter((l) => layers.has(l)).pop() ?? null;
    out.set(s, { start: nodes.get(s), deepest, layers: [...layers], leaves: leaves.map((id) => nodes.get(id)).filter(Boolean), size: seen.size - 1 });
  }
  return { byService: out, nodes };
}
export const endsAt = (t) => (t.size === 0 ? `${t.start?.layer ?? 'service'} (nothing below it)` : t.deepest === 'offering' ? 'offering (no application service below)' : t.deepest === 'application' ? 'application service (no infrastructure CI below)' : t.deepest);

/** Business Critical services with no impact tree (em_impact_graph); `not_in_use` when no impact tree exists at all. */
export async function criticalWithoutImpact(ctx, critical) {
  const all = await ctx.reads.read(declareRequirement({ table: 'em_impact_graph', strategy: 'exists' }));
  if (all.count == null) return { unavailable: `em_impact_graph could not be counted (${all.coverage?.status})` };
  if (all.count === 0) return { not_in_use: true };
  const crit = await rowsOf(ctx, { table: 'cmdb_ci_service', fields: ['name', 'sys_class_name'], query: `busines_criticalityIN${critical.join(',')}`, complete: true }); if (crit.unavailable) return crit;
  if (!crit.rows.length) return { critical: [], empty: [] };
  const g = await ctx.reads.read(declareRequirement({ table: 'em_impact_graph', query: `business_serviceIN${crit.rows.map((r) => r.sys_id).join(',')}`, strategy: 'aggregate', groupBy: ['business_service'] }));
  if (g.coverage?.status !== COMPLETE) return { unavailable: `em_impact_graph could not be read (${g.coverage?.status})` };
  const has = new Set(g.groups.map((x) => String(x.group.business_service)));
  return { critical: crit.rows, empty: crit.rows.filter((r) => !has.has(r.sys_id)) };
}
const NOT_IN_USE = { offenders: [], observed: { impact_graph: 0 }, expected: 0, absent: false, population: { total: 0, judged: 0, unit: 'Business Critical services', basis: 'no impact tree exists on the instance: impact calculation is not in use', determinate_when_empty: 'impact calculation is not in use' } };

export const CSDM_TRAVERSAL_COMPARATORS = Object.freeze({
  /** CSDM-075 — Business Critical services with no impact tree, and the CSDM layer where their model ends. */
  csdm_critical_impact_break: ({ classification, critical }) => async (_rows, ctx) => {
    const c = await criticalWithoutImpact(ctx, critical); if (c.unavailable) return c;
    if (c.not_in_use) return NOT_IN_USE;
    const t = await traverseServices(ctx, c.empty.map((s) => s.sys_id), classification); if (t.unavailable) return t;
    const offenders = [];
    for (const s of c.empty) { const x = t.byService.get(s.sys_id); if (x && x.deepest !== 'infrastructure') offenders.push(offender(s, 'impact', `${s.name}: no impact tree — its model ends at the ${endsAt(x)}`)); }
    return { offenders, observed: { critical: c.critical.length, without_impact_tree: c.empty.length, ended_above_infrastructure: offenders.length }, expected: 0, absent: false,
      population: pop(c.critical.length, c.critical.length, 'Business Critical services', 'impact trees (em_impact_graph); for those without one, the model walked down its layers to where it ends') };
  },

  /** CSDM-078 — service models that stop above infrastructure, or at CI classes, while discovery fails for that tier. */
  csdm_traversal_vs_discovery: ({ classification }) => async (rows, ctx) => {
    const services = rows.filter((r) => r.sys_class_name !== 'service_offering').map((r) => r.sys_id);
    const t = await traverseServices(ctx, services, classification); if (t.unavailable) return t;
    const fail = await ctx.reads.read(declareRequirement({ table: 'discovery_device_history', query: "issues>0^ORlast_stateLIKEcouldn't classify", strategy: 'aggregate', groupBy: ['classified_as'] }));
    if (fail.coverage?.status !== COMPLETE) return { unavailable: `discovery_device_history could not be read (${fail.coverage?.status})` };
    const failed = new Map(fail.groups.map((x) => [String(x.group.classified_as || ''), x.count]));
    const unclassified = failed.get('') ?? 0;
    const capped = [...t.byService.values()].filter((x) => x.size && x.deepest === 'application');
    const byClass = new Map();
    for (const x of t.byService.values()) if (x.deepest === 'infrastructure') for (const l of x.leaves) if (failed.get(l.sys_class_name)) byClass.set(l.sys_class_name, (byClass.get(l.sys_class_name) || 0) + 1);
    const offenders = [];
    if (capped.length && unclassified) offenders.push({ sys_id: null, field: 'application', value: `${capped.length} service model(s) end at the application tier with no infrastructure below, while discovery could not classify ${unclassified} device(s)` });
    for (const [cls, n] of byClass) offenders.push({ sys_id: null, field: cls, value: `${n} service model leaf CI(s) of class ${cls}, a class discovery failed on ${failed.get(cls)} time(s)` });
    return { offenders, observed: { services: services.length, ended_at_application: capped.length, discovery_failures: fail.groups.reduce((n, x) => n + x.count, 0), unclassified_devices: unclassified }, expected: 0, absent: false,
      population: pop(services.length, services.length, 'services', 'each service model walked to where it ends; discovery failures (issues, or devices it could not classify) by class') };
  },

  /** CSDM-073 — the CSDM stage reached (CSDM-072's) against this instance's previous scan; a decline names the stages lost. */
  csdm_maturity_trend: ({ classification, foundation }) => async (rows, ctx, run) => {
    const now = await CSDM_COMPARATORS.csdm_maturity_stage({ classification, foundation })(rows, ctx); if (now.unavailable) return now;
    const flags = now.observed.stages;
    const names = Object.keys(flags);
    let reached = 0; for (const n of names) { if (!flags[n]) break; reached += 1; }
    const prev = (run?.history?.('') ?? []).slice(-1)[0];
    const lost = prev ? names.filter((n) => flags[n] === false && run.history(n).slice(-1)[0]?.value === 1) : [];
    const offenders = prev && reached < prev.value ? [{ sys_id: null, field: 'stage', value: `stage fell from ${names[prev.value - 1] ?? 'below Foundation'} to ${names[reached - 1] ?? 'below Foundation'}${lost.length ? ` — lost: ${lost.join(', ')}` : ''}` }] : [];
    return { offenders, measures: { '': { value: reached }, ...Object.fromEntries(names.map((n) => [n, { value: flags[n] ? 1 : 0 }])) },
      observed: { stage: now.observed.stage, previous: prev ? (names[prev.value - 1] ?? 'below Foundation') : null, scans_compared: prev ? 2 : 1 }, expected: 'no decline', absent: false,
      population: { total: 1, judged: prev ? 1 : 0, unit: 'estate', basis: 'the CSDM stage (CSDM-072), against this instance\'s previous scan under the same rule configuration', determinate_when_empty: 'no earlier scan to compare with' } };
  },
});
