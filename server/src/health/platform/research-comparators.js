import { gunzipSync } from 'node:zlib';
import { declareRequirement } from '../itsm/data-access.js';
import { fromSnowTime } from '../itsm/run-context.js';
import { durationMs } from '../itom/comparators.js';
import { personalFields, ancestors } from '../csdm/comparators.js';

/**
 * D-033 — the Platform comparators the documentation research made buildable
 * (docs/HEALTH-ASSIST-RULE-RESEARCH.md). Same contract as every comparator.
 *
 * THE OUT-OF-BOX BASELINE is ServiceNow's own customization register,
 * sys_metadata_customization (Washington DC onward): one row per customized metadata
 * record, named by its update name (`<table>_<sys_id>`), with `author_type` — "Custom"
 * for a record the customer created, "ServiceNow" for a ServiceNow record the customer
 * modified. So "an OOB record" is one not authored "Custom".
 *
 * Script timing is ServiceNow's Slow Scripts log, sys_script_pattern (count, average,
 * total per script, keyed by the script record and its table). Personal data is the
 * instance's own field classification (m2m_dictionary_dataclass, D-032). Stored
 * conditions are evaluated by the instance through the Table API.
 */

const COMPLETE = 'complete';
const usable = (cov) => ['complete', 'limited', 'truncated'].includes(cov?.status);
const isEmpty = (v) => v === undefined || v === null || String(v).trim() === '';
const ref = (v) => (v && typeof v === 'object' ? v.value ?? v.sys_id ?? null : v);
const truthy = (v) => ['true', '1', 'yes'].includes(String(v).toLowerCase());
const chunks = (xs, n = 100) => { const out = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };
const round1 = (n) => Number(n.toFixed(1));
const clean = (q) => String(q || '').replace(/\^EQ$/, '');
const CUSTOM_TABLE = /^(u_|x_)/;

async function rowsOf(ctx, { table, fields, query = '', complete = false }) {
  const r = await ctx.reads.read(declareRequirement({ table, fields, query, strategy: 'rows' }));
  if (!(complete ? r.coverage?.status === COMPLETE : usable(r.coverage))) return { unavailable: `${table} could not be read${complete ? ' completely' : ''} (${r.coverage?.status}${r.coverage?.error ? `: ${r.coverage.error}` : ''}) — no claim is made from a partial read`, coverage: r.coverage };
  const unread = r.coverage?.totalKnown != null ? Math.max(0, r.coverage.totalKnown - (r.coverage.rowsFetched ?? r.rows.length)) : 0;
  return { rows: r.rows, coverage: r.coverage, unread };
}
async function countOf(ctx, { table, query = '' }) {
  const r = await ctx.reads.read(declareRequirement({ table, query, strategy: 'exists' }));
  if (r.count == null) return { unavailable: `count over ${table} failed (${r.coverage?.status})`, coverage: r.coverage };
  return { count: r.count };
}
async function countsBy(ctx, { table, query = '', groupBy }) {
  const r = await ctx.reads.read(declareRequirement({ table, query, strategy: 'aggregate', groupBy }));
  if (r.coverage?.status !== COMPLETE) return { unavailable: `aggregate over ${table} failed (${r.coverage?.status})`, coverage: r.coverage };
  return { groups: r.groups, total: r.groups.reduce((n, g) => n + g.count, 0) };
}
async function inChunks(ctx, { table, fields, field, ids, extra = '', complete = true }) {
  const out = []; let unread = 0;
  for (const c of chunks([...new Set(ids)])) {
    const r = await rowsOf(ctx, { table, fields, query: `${field}IN${c.join(',')}${extra ? `^${extra}` : ''}`, complete });
    if (r.unavailable) return r;
    out.push(...r.rows); unread += r.unread;
  }
  return { rows: out, unread };
}
/** The sys_ids of `table` records in the customization register authored by `author` ("Custom" | "ServiceNow"). */
export async function authored(ctx, table, author) {
  const r = await rowsOf(ctx, { table: 'sys_metadata_customization', fields: ['sys_update_name', 'author_type'], query: `author_type=${author}^sys_update_nameSTARTSWITH${table}_`, complete: true });
  if (r.unavailable) return r;
  const re = new RegExp(`^${table}_([0-9a-f]{32})$`);
  return { ids: new Set(r.rows.map((x) => re.exec(String(x.sys_update_name))?.[1]).filter(Boolean)) };
}
const pop = (total, judged, unit, basis) => ({ total, judged, unit, basis });
const offender = (r, field, value) => ({ sys_id: r.sys_id, field, value });

export const PLATFORM_RESEARCH_COMPARATORS = Object.freeze({
  /**
   * PLT-063 / PLT-074 — customer-created records (author "Custom") that share the
   * identity of a ServiceNow record: same name and, where given, same `also` field
   * (the table a business rule runs on). The OOB record is the one not authored "Custom".
   */
  plt_custom_shadowing_oob: ({ table, name_field = 'name', also = null }) => async (_rows, ctx) => {
    const own = await authored(ctx, table, 'Custom'); if (own.unavailable) return own;
    const mine = await inChunks(ctx, { table, fields: [name_field, ...(also ? [also] : [])], field: 'sys_id', ids: [...own.ids] }); if (mine.unavailable) return mine;
    const names = [...new Set(mine.rows.map((r) => r[name_field]).filter((n) => !isEmpty(n)))];
    const twins = [];
    for (const c of chunks(names, 50)) {
      const r = await rowsOf(ctx, { table, fields: [name_field, ...(also ? [also] : [])], query: `${name_field}IN${c.join(',')}`, complete: true });
      if (r.unavailable) return r;
      twins.push(...r.rows.filter((x) => !own.ids.has(x.sys_id)));
    }
    const key = (r) => `${r[name_field]}|${also ? r[also] ?? '' : ''}`;
    const oob = new Set(twins.map(key));
    const offenders = mine.rows.filter((r) => oob.has(key(r))).map((r) => offender(r, name_field, `${r[name_field]}${also ? ` on ${r[also]}` : ''}: a customer record with the name of a ServiceNow record`));
    return { offenders, observed: { customer_records: mine.rows.length, shadowing: offenders.length }, expected: 0, absent: false,
      population: pop(mine.rows.length, mine.rows.length, `customer-created ${table} records`, `author_type "Custom" in sys_metadata_customization; matched on ${name_field}${also ? ` and ${also}` : ''}`) };
  },

  /** PLT-059 — customer-created business rules in the global scope on tables that are not custom (u_ / x_). */
  plt_custom_rules_on_oob_tables: () => async (_rows, ctx) => {
    const own = await authored(ctx, 'sys_script', 'Custom'); if (own.unavailable) return own;
    const mine = await inChunks(ctx, { table: 'sys_script', fields: ['name', 'collection', 'sys_scope'], field: 'sys_id', ids: [...own.ids], extra: 'active=true' }); if (mine.unavailable) return mine;
    const offenders = mine.rows.filter((r) => String(ref(r.sys_scope)) === 'global' && !isEmpty(r.collection) && !CUSTOM_TABLE.test(String(r.collection)))
      .map((r) => offender(r, 'sys_scope', `${r.name} on ${r.collection}: global scope, ServiceNow table`));
    return { offenders, observed: { customer_rules: mine.rows.length, global_on_oob_tables: offenders.length }, expected: 0, absent: false,
      population: pop(mine.rows.length, mine.rows.length, 'active customer-created business rules', 'author_type "Custom"; a table is the customer\'s when its name starts u_ or x_') };
  },

  /**
   * PLT-135 — a customer-created ACL on the same object and operation as a ServiceNow
   * ACL, but weaker: no role, no condition and no script, where the ServiceNow one has at least one.
   */
  plt_custom_acl_weaker_than_oob: () => async (_rows, ctx) => {
    const own = await authored(ctx, 'sys_security_acl', 'Custom'); if (own.unavailable) return own;
    const mine = await inChunks(ctx, { table: 'sys_security_acl', fields: ['name', 'operation', 'condition', 'script', 'advanced'], field: 'sys_id', ids: [...own.ids], extra: 'active=true' }); if (mine.unavailable) return mine;
    const names = [...new Set(mine.rows.map((r) => r.name).filter(Boolean))];
    const twins = [];
    for (const c of chunks(names, 50)) {
      const r = await rowsOf(ctx, { table: 'sys_security_acl', fields: ['name', 'operation', 'condition', 'script', 'advanced'], query: `active=true^nameIN${c.join(',')}`, complete: true });
      if (r.unavailable) return r;
      twins.push(...r.rows.filter((x) => !own.ids.has(x.sys_id)));
    }
    const all = [...mine.rows, ...twins];
    const roles = new Set();
    for (const c of chunks(all.map((a) => a.sys_id))) {
      const g = await countsBy(ctx, { table: 'sys_security_acl_role', query: `sys_security_aclIN${c.join(',')}`, groupBy: ['sys_security_acl'] });
      if (g.unavailable) return g;
      for (const x of g.groups) if (x.count > 0) roles.add(String(ref(x.group.sys_security_acl)));
    }
    const guarded = (a) => roles.has(a.sys_id) || !isEmpty(a.condition) || (truthy(a.advanced) && !isEmpty(a.script));
    const offenders = mine.rows.filter((a) => !guarded(a) && twins.some((t) => t.name === a.name && String(ref(t.operation)) === String(ref(a.operation)) && guarded(t)))
      .map((a) => offender(a, 'name', `${a.name}: no role, condition or script, where the ServiceNow ACL on the same object has one`));
    return { offenders, observed: { customer_acls: mine.rows.length, weaker: offenders.length }, expected: 0, absent: false,
      population: pop(mine.rows.length, mine.rows.length, 'active customer-created ACLs', 'author_type "Custom", against the ServiceNow ACL with the same name and operation') };
  },

  /** PLT-155 — the customized ServiceNow records, counted by object type. A measure: reported, never judged. */
  plt_oob_modifications_by_type: () => async (_rows, ctx) => {
    const r = await rowsOf(ctx, { table: 'sys_metadata_customization', fields: ['sys_update_name'], query: 'author_type=ServiceNow', complete: true });
    if (r.unavailable) return r;
    const byType = {};
    for (const x of r.rows) { const m = /^(.+)_[0-9a-f]{32}$/.exec(String(x.sys_update_name)); if (m) byType[m[1]] = (byType[m[1]] || 0) + 1; }
    const top = Object.fromEntries(Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 25));
    return { offenders: [], absent: false, observed: { modified_servicenow_records: r.rows.length, object_types: Object.keys(byType).length, by_type: top }, expected: 'reported, not judged (the workbook gives no threshold)',
      population: pop(r.rows.length, 0, 'modified ServiceNow records', 'a measure: sys_metadata_customization author_type "ServiceNow", by object type — no threshold, so nothing is judged') };
  },

  /**
   * PLT-052 / PLT-173 — scripts from the Slow Scripts log (sys_script_pattern), ranked by
   * total time. `percentile`: charge the scripts of `source_table` whose total is at or
   * above that percentile of all scripts; without it, report the ranking (a measure).
   */
  plt_slow_scripts: ({ source_table = null, percentile = null, top = 20 }) => async (_rows, ctx) => {
    /* Every row is needed for the percentile; a row whose script_source the API omits still counts toward it. */
    const rr = await ctx.reads.read(declareRequirement({ table: 'sys_script_pattern', fields: ['script_source', 'script_source_table', 'count', 'average', 'total'], query: '', strategy: 'rows' }));
    if (!rr.coverage?.rowsComplete) return { unavailable: `sys_script_pattern could not be read completely (${rr.coverage?.status})`, coverage: rr.coverage };
    const r = { rows: rr.rows };
    const all = r.rows.map((x) => ({ ...x, ms: durationMs(x.total) ?? 0 })).sort((a, b) => b.ms - a.ms);
    if (!all.length) return { offenders: [], observed: { scripts: 0 }, expected: 0, absent: false, population: pop(0, 0, 'scripts in the Slow Scripts log', 'sys_script_pattern') };
    const scoped = source_table ? all.filter((x) => x.script_source_table === source_table) : all;
    const ranking = scoped.slice(0, top).map((x) => ({ table: x.script_source_table, script: String(ref(x.script_source)), count: Number(x.count), average_ms: Number(x.average), total_s: round1(x.ms / 1000) }));
    if (percentile == null) {
      return { offenders: [], absent: false, observed: { scripts: all.length, ranking }, expected: 'reported, not judged',
        population: pop(all.length, 0, 'scripts in the Slow Scripts log', 'a measure: the ranking by total time and by frequency (the workbook gives no threshold)') };
    }
    const cut = all[Math.max(0, Math.ceil(((100 - percentile) / 100) * all.length) - 1)].ms;
    const offenders = scoped.filter((x) => x.ms >= cut && x.ms > 0).map((x) => ({ sys_id: String(ref(x.script_source)), field: 'total', value: `${x.script_source_table} ${ref(x.script_source)}: ${round1(x.ms / 1000)} s total over ${x.count} runs (at or above the ${percentile}th percentile, ${round1(cut / 1000)} s)` }));
    return { offenders, observed: { scripts: all.length, [source_table ?? 'scripts']: scoped.length, percentile_cut_s: round1(cut / 1000), ranking }, expected: 0, absent: false,
      population: pop(scoped.length, scoped.length, `${source_table ?? 'all'} scripts in the Slow Scripts log`, `sys_script_pattern total time against the ${percentile}th percentile of every script`) };
  },

  /**
   * PLT-007 — an active SLA definition whose stop condition does not stop at a terminal
   * state its table has: for each terminal value with records, the instance counts the
   * records in that state that the stop condition matches; none matched is the gap.
   */
  plt_stop_condition_terminal_states: ({ terminal }) => async (rows, ctx) => {
    const offenders = []; let judged = 0;
    for (const d of rows.filter((x) => terminal[x.collection] && !isEmpty(x.stop_condition))) {
      const missing = [];
      for (const v of terminal[d.collection]) {
        const n = await countOf(ctx, { table: d.collection, query: `state=${v}` }); if (n.unavailable) return n;
        if (!n.count) continue;
        const m = await countOf(ctx, { table: d.collection, query: `state=${v}^${clean(d.stop_condition)}` }); if (m.unavailable) return m;
        if (!m.count) missing.push(v);
      }
      judged += 1;
      if (missing.length) offenders.push(offender(d, 'stop_condition', `${d.name} (${d.collection}): the stop condition matches no record in state ${missing.join(', ')}`));
    }
    return { offenders, observed: { definitions_judged: judged, not_covering: offenders.length }, expected: 0, absent: false,
      population: pop(rows.length, judged, 'active SLA definitions on incident, problem and change', 'each terminal state with records, against the stop condition evaluated by the instance') };
  },

  /**
   * PLT-126 / PLT-127 / PLT-128 — the ACLs on the tables and fields the instance
   * classifies as personal data (D-032).
   *   'write_absent'  a table with a read ACL and no write ACL (126)
   *   'field_absent'  a classified field with no ACL of its own, any operation (127)
   *   'broad_read'    a table-level read ACL open to snc_internal / public / no role, no condition, no script (128)
   */
  plt_personal_data_acls: ({ classes, mode, broad_roles = ['snc_internal', 'public'] }) => async (_rows, ctx) => {
    const pf = await personalFields(ctx, classes); if (pf.unavailable) return pf;
    if (!pf.fields.length) return { offenders: [], observed: { personal_fields: 0 }, expected: 0, absent: false, population: { total: 0, judged: 0, unit: 'personal-data fields', basis: 'no field is classified as personal data', determinate_when_empty: 'no field is classified as personal data' } };
    const tables = [...new Set(pf.fields.map((f) => f.table))];
    const names = mode === 'field_absent' ? pf.fields.map((f) => `${f.table}.${f.element}`) : tables.flatMap((t) => [t, `${t}.*`]);
    const acls = [];
    for (const c of chunks(names)) {
      const r = await rowsOf(ctx, { table: 'sys_security_acl', fields: ['name', 'operation', 'condition', 'script', 'advanced'], query: `active=true^nameIN${c.join(',')}`, complete: true });
      if (r.unavailable) return r;
      acls.push(...r.rows);
    }
    const opName = async () => {
      const ids = [...new Set(acls.map((a) => String(ref(a.operation))).filter(Boolean))];
      const ops = await inChunks(ctx, { table: 'sys_security_operation', fields: ['name'], field: 'sys_id', ids });
      return ops.unavailable ? ops : { byId: new Map(ops.rows.map((o) => [o.sys_id, o.name])) };
    };
    if (mode === 'field_absent') {
      const has = new Set(acls.map((a) => a.name));
      const offenders = pf.fields.filter((f) => !has.has(`${f.table}.${f.element}`)).map((f) => ({ sys_id: f.sys_id, field: 'acl', value: `${f.table}.${f.element}: classified personal data with no field-level ACL` }));
      return { offenders, observed: { personal_fields: pf.fields.length, without_field_acl: offenders.length }, expected: 0, absent: false,
        population: pop(pf.fields.length, pf.fields.length, 'personal-data fields', 'fields classified as personal data (m2m_dictionary_dataclass), against ACLs named table.field') };
    }
    const ops = await opName(); if (ops.unavailable) return ops;
    const op = (a) => ops.byId.get(String(ref(a.operation))) ?? String(ref(a.operation));
    if (mode === 'write_absent') {
      const offenders = tables.filter((t) => acls.some((a) => [t, `${t}.*`].includes(a.name) && op(a) === 'read') && !acls.some((a) => [t, `${t}.*`].includes(a.name) && op(a) === 'write'))
        .map((t) => ({ sys_id: t, field: 'acl', value: `${t}: a read ACL and no write ACL on a table holding personal data` }));
      return { offenders, observed: { tables: tables.length, read_without_write: offenders.length }, expected: 0, absent: false,
        population: pop(tables.length, tables.length, 'tables holding classified personal data', 'table-level (table, table.*) read and write ACLs; inherited ACLs are not credited') };
    }
    const reads = acls.filter((a) => op(a) === 'read');
    const roleRows = await inChunks(ctx, { table: 'sys_security_acl_role', fields: ['sys_security_acl', 'sys_user_role'], field: 'sys_security_acl', ids: reads.map((a) => a.sys_id) });
    if (roleRows.unavailable) return roleRows;
    const roleIds = [...new Set(roleRows.rows.map((r) => String(ref(r.sys_user_role))))];
    const roleNames = await inChunks(ctx, { table: 'sys_user_role', fields: ['name'], field: 'sys_id', ids: roleIds }); if (roleNames.unavailable) return roleNames;
    const nameOf = new Map(roleNames.rows.map((r) => [r.sys_id, r.name]));
    const rolesOf = (a) => roleRows.rows.filter((r) => String(ref(r.sys_security_acl)) === a.sys_id).map((r) => nameOf.get(String(ref(r.sys_user_role))));
    const broad = reads.filter((a) => isEmpty(a.condition) && !(truthy(a.advanced) && !isEmpty(a.script)) && (rolesOf(a).length === 0 || rolesOf(a).every((n) => broad_roles.includes(n))));
    const offenders = broad.map((a) => offender(a, 'roles', `${a.name}: read open to ${rolesOf(a).length ? rolesOf(a).join(', ') : 'any authenticated user (no role)'} on a table holding personal data`));
    return { offenders, observed: { tables: tables.length, table_read_acls: reads.length, broad: offenders.length }, expected: 0, absent: false,
      population: pop(reads.length, reads.length, 'table-level read ACLs on tables holding personal data', `read ACLs with no condition or script whose roles are none or only ${broad_roles.join(' / ')}`) };
  },

  /** PLT-136 — impersonation in use: impersonation.start events (parm1 = impersonator), by impersonator. */
  plt_impersonation_by_user: () => async (rows) => {
    const by = new Map();
    for (const e of rows) { const k = String(e.parm1 ?? ''); if (!k) continue; if (!by.has(k)) by.set(k, { n: 0, whom: new Set() }); const x = by.get(k); x.n += 1; if (e.parm2) x.whom.add(String(e.parm2)); }
    const offenders = [...by].map(([u, x]) => ({ sys_id: u, field: 'parm1', value: `${u}: ${x.n} impersonation(s) of ${[...x.whom].slice(0, 5).join(', ')}${x.whom.size > 5 ? '…' : ''}` }));
    return { offenders, observed: { impersonations: rows.length, impersonators: by.size }, expected: 0, absent: false,
      population: pop(rows.length, rows.length, 'impersonation.start events', 'sysevent as retained (rotated, about 7 days) — whether each was reviewed is not recorded') };
  },

  /** PLT-180 — transactions the platform cancelled (syslog_cancellation), by URL. */
  plt_cancelled_transactions: () => async (rows) => {
    const by = new Map();
    for (const r of rows) { const u = String(r.url ?? '').replace(/^CANCELLED:\s*/, '').split('?')[0]; by.set(u, (by.get(u) || 0) + 1); }
    const offenders = [...by].sort((a, b) => b[1] - a[1]).map(([u, n]) => ({ sys_id: u, field: 'url', value: `${u}: ${n} cancelled` }));
    return { offenders, observed: { cancelled: rows.length, distinct: by.size }, expected: 0, absent: false,
      population: pop(rows.length, rows.length, 'cancelled transactions', 'syslog_cancellation as retained') };
  },

  /**
   * PLT-020 — records an active SLA definition's start condition matches (evaluated by
   * the instance, over ACTIVE records) that carry no SLA of that definition.
   */
  plt_records_missing_sla: () => async (rows, ctx) => {
    const offenders = []; let judged = 0;
    for (const d of rows.filter((x) => !isEmpty(x.collection) && !isEmpty(x.start_condition))) {
      const recs = await rowsOf(ctx, { table: d.collection, fields: ['number'], query: `active=true^${clean(d.start_condition)}`, complete: true });
      if (recs.unavailable) continue;
      if (!recs.rows.length) continue;
      const have = await inChunks(ctx, { table: 'task_sla', fields: ['task'], field: 'task', ids: recs.rows.map((r) => r.sys_id), extra: `sla=${d.sys_id}` });
      if (have.unavailable) return have;
      const got = new Set(have.rows.map((t) => String(ref(t.task))));
      judged += recs.rows.length;
      for (const r of recs.rows) if (!got.has(r.sys_id)) offenders.push(offender(r, 'sla', `${r.number ?? r.sys_id}: matches "${d.name}" and has no SLA of it`));
    }
    return { offenders, observed: { definitions: rows.length, records_judged: judged, missing: offenders.length }, expected: 0, absent: false,
      population: pop(judged, judged, 'active records a start condition matches', 'each active definition\'s start condition evaluated by the instance; its task_sla rows') };
  },

  /** PLT-031 — Business Critical services on whose tasks no SLA has ever run. */
  plt_critical_services_without_sla: ({ critical_values }) => async (rows, ctx) => {
    const crit = rows.filter((s) => critical_values.includes(String(s.busines_criticality)));
    if (!crit.length) return { offenders: [], observed: { critical_services: 0 }, expected: 0, absent: false, population: pop(0, 0, 'Business Critical services', 'busines_criticality "1 - most critical"') };
    const g = await countsBy(ctx, { table: 'task_sla', query: 'task.business_serviceISNOTEMPTY', groupBy: ['task.business_service'] }); if (g.unavailable) return g;
    const covered = new Set(g.groups.filter((x) => x.count > 0).map((x) => String(x.group['task.business_service'])));
    const offenders = crit.filter((s) => !covered.has(s.sys_id)).map((s) => offender(s, 'business_service', `${s.name}: Business Critical, no SLA has run on any of its tasks`));
    return { offenders, observed: { critical_services: crit.length, without_sla: offenders.length }, expected: 0, absent: false,
      population: pop(crit.length, crit.length, 'Business Critical services', 'task_sla rows by the task\'s business service') };
  },

  /** PLT-116 — registered events that fire and that no script action or notification consumes. */
  plt_events_unconsumed: () => async (rows, ctx) => {
    const fired = await countsBy(ctx, { table: 'sysevent', groupBy: ['name'] }); if (fired.unavailable) return fired;
    const vol = new Map(fired.groups.map((g) => [String(g.group.name), g.count]));
    const sa = await countsBy(ctx, { table: 'sysevent_script_action', query: 'active=true', groupBy: ['event_name'] }); if (sa.unavailable) return sa;
    const na = await countsBy(ctx, { table: 'sysevent_email_action', query: 'active=true', groupBy: ['event_name'] }); if (na.unavailable) return na;
    const consumed = new Set([...sa.groups, ...na.groups].map((g) => String(g.group.event_name)));
    const live = rows.filter((e) => (vol.get(e.event_name) || 0) > 0);
    const offenders = live.filter((e) => !consumed.has(e.event_name)).map((e) => offender(e, 'event_name', `${e.event_name}: fired ${vol.get(e.event_name)} times (as retained), no script action or notification`));
    return { offenders, observed: { registered: rows.length, fired: live.length, unconsumed: offenders.length }, expected: 0, absent: false,
      population: pop(live.length, live.length, 'registered events that fired', 'sysevent (rotated) by name, against active script actions and notifications on the event') };
  },

  /** PLT-119 — async jobs (sys_trigger "ASYNC: …", ready) whose next action is further in the past than `max_lag` minutes. */
  plt_async_lag: ({ max_lag }) => async (rows, ctx) => {
    const now = new Date(ctx.run.run_started_at).getTime();
    const late = rows.filter((r) => { const t = fromSnowTime(r.next_action); return t && now - t > max_lag * 60000; });
    return { offenders: late.map((r) => offender(r, 'next_action', `${r.name}: due ${r.next_action}, ${round1((now - fromSnowTime(r.next_action)) / 60000)} minutes ago`)),
      observed: { queued: rows.length, late: late.length, max_lag_minutes: max_lag }, expected: 0, absent: false,
      population: pop(rows.length, rows.length, 'queued async jobs', 'sys_trigger rows named "ASYNC: …" in state ready') };
  },

  /** PLT-122 — custom tables (u_ / x_) with no table-level ACL on themselves or any ancestor. */
  plt_tables_without_acl: () => async (rows, ctx) => {
    const custom = rows.filter((t) => CUSTOM_TABLE.test(String(t.name)));
    const ch = await ancestors(ctx, custom.map((t) => t.name)); if (ch.unavailable) return ch;
    const names = [...new Set(custom.flatMap((t) => (ch.chains.get(t.name) || [t.name]).flatMap((x) => [x, `${x}.*`])))];
    const has = new Set();
    for (const c of chunks(names)) { const r = await rowsOf(ctx, { table: 'sys_security_acl', fields: ['name'], query: `active=true^nameIN${c.join(',')}`, complete: true }); if (r.unavailable) return r; for (const a of r.rows) has.add(a.name); }
    const offenders = custom.filter((t) => !(ch.chains.get(t.name) || [t.name]).some((x) => has.has(x) || has.has(`${x}.*`))).map((t) => offender(t, 'acl', `${t.name}: no table-level ACL on it or any table it extends`));
    return { offenders, observed: { custom_tables: custom.length, without_acl: offenders.length }, expected: 0, absent: false,
      population: pop(custom.length, custom.length, 'custom tables', 'tables named u_ / x_, with the ACLs of every table they extend (inheritance resolved)') };
  },

  /** PLT-142 — outbound integration failure rate by host (sys_outbound_http_log as retained). */
  plt_outbound_failure_rate: ({ rate }) => async (rows) => {
    const by = new Map();
    for (const r of rows) { const h = String(r.hostname || (String(r.url ?? '').split('/')[2] ?? '')); if (!h) continue; if (!by.has(h)) by.set(h, { n: 0, f: 0 }); const x = by.get(h); x.n += 1; const s = Number(r.response_status); if (!Number.isFinite(s) || s <= 0 || s >= 400) x.f += 1; }
    const offenders = [...by].filter(([, x]) => (100 * x.f) / x.n > rate).map(([h, x]) => ({ sys_id: h, field: 'response_status', value: `${h}: ${x.f} of ${x.n} calls failed (${round1((100 * x.f) / x.n)}%)` }));
    const calls = rows.length; const failed = [...by.values()].reduce((a, x) => a + x.f, 0);
    return { offenders, observed: { calls, failed, hosts: by.size }, expected: `≤ ${rate}% per integration`, absent: false,
      kpi: calls ? { numerator: calls - failed, denominator: calls, basis: 'outbound calls answered below HTTP 400' } : undefined,
      population: pop(by.size, by.size, 'integrations (outbound hosts)', 'sys_outbound_http_log as retained; a failure is no status or HTTP ≥ 400') };
  },

  /** PLT-160 — custom fields (u_) on ServiceNow tables populated on fewer than `min_population`% of rows. */
  plt_custom_field_population: ({ min_population }) => async (rows, ctx) => {
    const fields = rows.filter((d) => String(d.element).startsWith('u_') && !CUSTOM_TABLE.test(String(d.name)));
    /* One row count per table, then one population count per field on tables that have rows. */
    const totals = new Map();
    for (const t of [...new Set(fields.map((f) => f.name))]) { const n = await countOf(ctx, { table: t }); totals.set(t, n.unavailable ? null : n.count); }
    const offenders = []; let judged = 0;
    for (const f of fields) {
      const all = { count: totals.get(f.name) };
      if (!all.count) continue;
      const set = await countOf(ctx, { table: f.name, query: `${f.element}ISNOTEMPTY` }); if (set.unavailable) continue;
      judged += 1;
      const pct = (100 * set.count) / all.count;
      if (pct < min_population) offenders.push(offender(f, 'element', `${f.name}.${f.element}: populated on ${round1(pct)}% of ${all.count} rows`));
    }
    return { offenders, observed: { custom_fields: fields.length, judged, below: offenders.length }, expected: `≥ ${min_population}%`, absent: false,
      population: pop(fields.length, judged, 'custom fields on ServiceNow tables', 'u_ fields on tables not named u_ / x_; population counted by the instance') };
  },

  /** PLT-169 — custom tables with at most `max_rows` rows, created more than `min_age` days ago. */
  plt_sparse_custom_tables: ({ max_rows, min_age }) => async (rows, ctx) => {
    const now = new Date(ctx.run.run_started_at).getTime();
    const custom = rows.filter((t) => CUSTOM_TABLE.test(String(t.name)) && fromSnowTime(t.sys_created_on) && now - fromSnowTime(t.sys_created_on) > min_age * 86400000);
    const offenders = []; let judged = 0;
    for (const t of custom) {
      const n = await countOf(ctx, { table: t.name }); if (n.unavailable) continue;
      judged += 1;
      if (n.count <= max_rows) offenders.push(offender(t, 'rows', `${t.name}: ${n.count} rows, created ${String(t.sys_created_on).slice(0, 10)}`));
    }
    return { offenders, observed: { custom_tables_older: custom.length, judged, near_empty: offenders.length }, expected: `> ${max_rows} rows`, absent: false,
      population: pop(custom.length, judged, `custom tables older than ${min_age} days`, 'tables named u_ / x_, rows counted by the instance') };
  },

  /**
   * PLT-085 — contradictory UI policy actions on the same field across active policies:
   * visible vs hidden, and mandatory vs read-only. Two policies meet when they apply to
   * the same table, UI type (desktop 0, mobile 1, both 10) and view (a global policy meets
   * every view) and hold together: equal conditions, or either unconditioned.
   */
  plt_ui_policy_conflicts: () => async (rows, ctx) => {
    const pol = new Map(rows.map((p) => [p.sys_id, p]));
    const acts = await rowsOf(ctx, { table: 'sys_ui_policy_action', fields: ['ui_policy', 'table', 'field', 'visible', 'mandatory', 'disabled'], query: 'ui_policy.active=true' }); if (acts.unavailable) return acts;
    const byField = new Map();
    for (const a of acts.rows) {
      const p = pol.get(String(ref(a.ui_policy))); if (!p || isEmpty(a.field)) continue;
      const key = `${p.table}.${a.field}`;
      if (!byField.has(key)) byField.set(key, []);
      byField.get(key).push({ a, p });
    }
    const meet = (x, y) => x.p.sys_id !== y.p.sys_id && (String(x.p.ui_type) === String(y.p.ui_type) || [x.p.ui_type, y.p.ui_type].map(String).includes('10'))
      && (truthy(x.p.global) || truthy(y.p.global) || String(ref(x.p.view) ?? '') === String(ref(y.p.view) ?? ''))
      && (isEmpty(x.p.conditions) || isEmpty(y.p.conditions) || clean(x.p.conditions) === clean(y.p.conditions));
    const offenders = [];
    for (const [key, list] of byField) {
      const clash = [];
      for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) {
        const [x, y] = [list[i], list[j]]; if (!meet(x, y)) continue;
        const v = [String(x.a.visible), String(y.a.visible)];
        if (v.includes('true') && v.includes('false')) clash.push(`"${x.p.short_description}" / "${y.p.short_description}": visible vs hidden`);
        if ((String(x.a.mandatory) === 'true' && String(y.a.disabled) === 'true') || (String(y.a.mandatory) === 'true' && String(x.a.disabled) === 'true')) clash.push(`"${x.p.short_description}" / "${y.p.short_description}": mandatory vs read-only`);
      }
      if (clash.length) offenders.push({ sys_id: list[0].a.sys_id, field: 'field', value: `${key}: ${clash.slice(0, 3).join('; ')}${clash.length > 3 ? ` (+${clash.length - 3} more)` : ''}` });
    }
    return { offenders, observed: { active_policies: rows.length, fields_with_actions: byField.size, conflicting_fields: offenders.length, unreadable_actions: acts.unread }, expected: 0, absent: false,
      population: pop(byField.size, byField.size, 'fields with active UI policy actions', 'actions of active policies that meet on table, UI type and view, with equal conditions or either unconditioned') };
  },

  /** PLT-093 — tables where an active record-triggered flow and an active workflow both start, on the same condition or with either unconditioned. */
  plt_flow_workflow_overlap: () => async (rows, ctx) => {
    const wf = rows.filter((w) => !isEmpty(w.table));
    if (!wf.length) return { offenders: [], observed: { active_workflows: 0 }, expected: 0, absent: false, population: pop(0, 0, 'active workflows on a table', 'no active published workflow version') };
    const flows = await currentFlows(ctx); if (flows.unavailable) return flows;
    const trig = await triggersOn(ctx, [...flows.masterOf.keys()]); if (trig.unavailable) return trig;
    const offenders = [];
    for (const w of wf) {
      const hit = trig.rows.filter((t) => t.table === w.table && (isEmpty(t.condition) || isEmpty(w.condition) || clean(t.condition) === clean(w.condition)));
      if (hit.length) offenders.push(offender(w, 'table', `${w.name} (${w.table}): also started by flow${hit.length > 1 ? 's' : ''} ${[...new Set(hit.map((t) => flows.byId.get(flows.masterOf.get(t.flow) ?? t.flow)?.name ?? t.flow))].slice(0, 5).join(', ')}`));
    }
    return { offenders, observed: { active_workflows: wf.length, record_triggers: trig.rows.length, overlapping: offenders.length, unreadable_rows: flows.unread }, expected: 0, absent: false,
      population: pop(wf.length, wf.length, 'active workflows on a table', 'record triggers of active flows (current snapshot), decoded; equal conditions or either unconditioned overlap') };
  },

  /** PLT-099 — cycles in the subflow call graph of active flows (current snapshots). */
  plt_subflow_cycles: () => async (_rows, ctx) => {
    const flows = await currentFlows(ctx); if (flows.unavailable) return flows;
    const edges = await subflowEdges(ctx, flows); if (edges.unavailable) return edges;
    const next = new Map();
    for (const e of edges.edges) { if (!next.has(e.from)) next.set(e.from, new Set()); next.get(e.from).add(e.to); }
    /* Tarjan's strongly connected components: a component of two or more, or a self-call, is a cycle. */
    let index = 0; const idx = new Map(); const low = new Map(); const stack = []; const on = new Set(); const cycles = [];
    const visit = (v) => {
      idx.set(v, index); low.set(v, index); index += 1; stack.push(v); on.add(v);
      for (const w of next.get(v) || []) {
        if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
      }
      if (low.get(v) === idx.get(v)) {
        const comp = []; let w; do { w = stack.pop(); on.delete(w); comp.push(w); } while (w !== v);
        if (comp.length > 1 || next.get(v)?.has(v)) cycles.push(comp);
      }
    };
    for (const v of next.keys()) if (!idx.has(v)) visit(v);
    const name = (id) => flows.byId.get(id)?.name ?? id;
    const offenders = cycles.map((c) => ({ sys_id: c[0], field: 'subflow', value: `cycle: ${c.map(name).join(' → ')} → ${name(c[0])}` }));
    return { offenders, observed: { flows: flows.byId.size, calls: edges.edges.length, cycles: cycles.length, unreadable_rows: flows.unread + edges.unread }, expected: 0, absent: false,
      population: pop(next.size, next.size, 'flows that call a subflow', 'subflow instances of each active flow\'s current snapshot, callees resolved to their flow') };
  },

  /**
   * PLT-102 — customer-created active flows and subflows (author "Custom") with no trigger
   * and no caller: no trigger instance, no subflow instance in an active flow, no SLA
   * definition or catalog item naming it, and no script naming it (script includes,
   * business rules, UI actions, scheduled jobs, scripted REST resources).
   */
  plt_flow_orphans: () => async (_rows, ctx) => {
    const own = await authored(ctx, 'sys_hub_flow', 'Custom'); if (own.unavailable) return own;
    const flows = await currentFlows(ctx); if (flows.unavailable) return flows;
    const mine = [...flows.byId.values()].filter((f) => own.ids.has(f.sys_id));
    if (!mine.length) return { offenders: [], observed: { customer_flows: 0 }, expected: 0, absent: false, population: pop(0, 0, 'customer-created active flows', 'none') };
    const trig = await triggerFlows(ctx); if (trig.unavailable) return trig;
    const edges = await subflowEdges(ctx, flows); if (edges.unavailable) return edges;
    const called = new Set(edges.edges.map((e) => e.to));
    const named = new Set();
    for (const [table, field] of [['contract_sla', 'flow'], ['sc_cat_item', 'flow_designer_flow']]) {
      const g = await countsBy(ctx, { table, query: `${field}ISNOTEMPTY`, groupBy: [field] }); if (g.unavailable) return g;
      for (const x of g.groups) named.add(String(x.group[field]));
    }
    let left = mine.filter((f) => !trig.has(f.sys_id) && !trig.has(String(ref(f.master_snapshot))) && !called.has(f.sys_id) && !named.has(f.sys_id));
    const scripted = new Set();
    for (const table of ['sys_script_include', 'sys_script', 'sys_ui_action', 'sysauto_script', 'sys_ws_operation']) {
      const field = table === 'sys_ws_operation' ? 'operation_script' : 'script';
      for (const c of chunks(left.filter((f) => !isEmpty(f.internal_name)), 20)) {
        const r = await rowsOf(ctx, { table, fields: [field], query: c.map((f) => `${field}LIKE${f.internal_name}`).join('^OR'), complete: true }); if (r.unavailable) return r;
        for (const f of c) if (r.rows.some((x) => String(x[field] ?? '').includes(f.internal_name))) scripted.add(f.sys_id);
      }
    }
    left = left.filter((f) => !scripted.has(f.sys_id));
    const offenders = left.map((f) => offender(f, 'trigger', `${f.name} (${f.type || 'flow'}): no trigger and no caller`));
    return { offenders, observed: { customer_flows: mine.length, orphaned: offenders.length, unreadable_rows: flows.unread + edges.unread }, expected: 0, absent: false,
      population: pop(mine.length, mine.length, 'customer-created active flows and subflows', 'triggers, subflow calls from active flows, SLA definitions, catalog items and scripts naming the flow') };
  },

  /**
   * PLT-095 — active flows whose current snapshot calls an action or subflow that no longer
   * exists or is inactive: an action instance's action snapshot, its action definition
   * (sys_hub_action_type_definition.active), a subflow instance's snapshot and its flow.
   */
  plt_flow_dead_references: () => async (_rows, ctx) => {
    const flows = await currentFlows(ctx); if (flows.unavailable) return flows;
    const masters = [...flows.masterOf.keys()];
    const acts = []; let unread = flows.unread;
    for (const table of ['sys_hub_action_instance_v2', 'sys_hub_action_instance']) {
      const r = await inChunks(ctx, { table, fields: ['flow', 'action_type'], field: 'flow', ids: masters, complete: false });
      if (r.unavailable) { if (table === 'sys_hub_action_instance') continue; return r; }
      acts.push(...r.rows); unread += r.unread;
    }
    const snaps = await inChunks(ctx, { table: 'sys_hub_action_type_snapshot', fields: ['parent_action'], field: 'sys_id', ids: acts.map((a) => String(ref(a.action_type))).filter(Boolean), complete: false }); if (snaps.unavailable) return snaps;
    const parentOf = new Map(snaps.rows.map((s) => [s.sys_id, String(ref(s.parent_action) ?? '')]));
    const parents = [...new Set(parentOf.values())].filter(Boolean);
    const base = await inChunks(ctx, { table: 'sys_hub_action_type_base', fields: ['sys_class_name'], field: 'sys_id', ids: parents, complete: false }); if (base.unavailable) return base;
    const defs = await inChunks(ctx, { table: 'sys_hub_action_type_definition', fields: ['active'], field: 'sys_id', ids: parents, complete: false }); if (defs.unavailable) return defs;
    const liveDef = new Map(base.rows.map((d) => [d.sys_id, true]));
    for (const d of defs.rows) liveDef.set(d.sys_id, truthy(d.active));
    const edges = await subflowEdges(ctx, flows, true); if (edges.unavailable) return edges;
    const bad = new Map();
    const note = (flow, why) => { if (!bad.has(flow)) bad.set(flow, new Set()); bad.get(flow).add(why); };
    for (const a of acts) {
      const flow = flows.masterOf.get(String(ref(a.flow))); const snap = String(ref(a.action_type) ?? '');
      if (!snap) continue;
      if (!parentOf.has(snap)) note(flow, 'an action that no longer exists');
      else if (parentOf.get(snap) && liveDef.get(parentOf.get(snap)) === false) note(flow, 'an inactive action');
      else if (parentOf.get(snap) && !liveDef.has(parentOf.get(snap))) note(flow, 'an action whose definition was deleted');
    }
    for (const e of edges.edges) {
      if (e.to == null) note(e.from, 'a subflow that no longer exists');
      else if (!edges.active.has(e.to)) note(e.from, 'a subflow that is inactive or deleted');
    }
    const offenders = [...bad].map(([id, why]) => ({ sys_id: id, field: 'step', value: `${flows.byId.get(id)?.name ?? id}: calls ${[...why].join(', ')}` }));
    return { offenders, observed: { active_flows: flows.byId.size, action_steps: acts.length, subflow_steps: edges.edges.length, flows_with_dead_references: offenders.length, unreadable_rows: unread + snaps.unread + edges.unread }, expected: 0, absent: false,
      population: pop(flows.byId.size, flows.byId.size, 'active flows', 'action and subflow steps of each current snapshot, resolved to their definitions') };
  },
});

/* ── Flow Designer structure (PLT-093 / 095 / 099 / 102) ──────────────────────────────
 * A flow's steps and triggers hang off its snapshots (sys_hub_flow_snapshot, parent_flow);
 * the current one is the flow's master_snapshot. A subflow step names the called subflow
 * by one of ITS snapshots. Record triggers keep table and condition in trigger_inputs,
 * gzip-compressed JSON. Verified read-only on the validation instance (D-035). */

/** Active flows and subflows: byId, and masterOf (current snapshot → flow). */
export async function currentFlows(ctx) {
  const r = await rowsOf(ctx, { table: 'sys_hub_flow', fields: ['name', 'internal_name', 'type', 'master_snapshot'], query: 'active=true' }); if (r.unavailable) return r;
  return { unread: r.unread, byId: new Map(r.rows.map((f) => [f.sys_id, f])), masterOf: new Map(r.rows.filter((f) => !isEmpty(ref(f.master_snapshot))).map((f) => [String(ref(f.master_snapshot)), f.sys_id])) };
}
/** Caller → callee flow edges from the subflow steps of current snapshots (callee null when its snapshot is gone). */
export async function subflowEdges(ctx, flows, withActive = false) {
  const inst = []; let unread = 0;
  for (const table of ['sys_hub_sub_flow_instance_v2', 'sys_hub_sub_flow_instance']) {
    const r = await inChunks(ctx, { table, fields: ['flow', 'subflow'], field: 'flow', ids: [...flows.masterOf.keys()], complete: false });
    if (r.unavailable) { if (table === 'sys_hub_sub_flow_instance') continue; return r; }
    inst.push(...r.rows); unread += r.unread;
  }
  const snaps = await inChunks(ctx, { table: 'sys_hub_flow_snapshot', fields: ['parent_flow'], field: 'sys_id', ids: inst.map((i) => String(ref(i.subflow))).filter(Boolean), complete: false }); if (snaps.unavailable) return snaps;
  const parent = new Map(snaps.rows.map((s) => [s.sys_id, String(ref(s.parent_flow) ?? '')]));
  const edges = inst.filter((i) => !isEmpty(ref(i.subflow))).map((i) => ({ from: flows.masterOf.get(String(ref(i.flow))), to: parent.get(String(ref(i.subflow))) || null }));
  return { edges, unread: unread + snaps.unread, active: withActive ? new Set(flows.byId.keys()) : null };
}
/** The flows and snapshots any trigger instance names. */
async function triggerFlows(ctx) {
  const out = new Set();
  for (const table of ['sys_hub_trigger_instance_v2', 'sys_hub_trigger_instance']) {
    const g = await countsBy(ctx, { table, groupBy: ['flow'] });
    if (g.unavailable) { if (table === 'sys_hub_trigger_instance') continue; return g; }
    for (const x of g.groups) out.add(String(x.group.flow));
  }
  return out;
}
/** Record triggers (create / update) of the given snapshots, decoded to { flow, table, condition }. */
async function triggersOn(ctx, masters) {
  const rows = [];
  for (const table of ['sys_hub_trigger_instance_v2', 'sys_hub_trigger_instance']) {
    const r = await inChunks(ctx, { table, fields: ['flow', 'trigger_type', 'trigger_inputs'], field: 'flow', ids: masters, extra: 'trigger_typeSTARTSWITHrecord_', complete: false });
    if (r.unavailable) { if (table === 'sys_hub_trigger_instance') continue; return r; }
    rows.push(...r.rows);
  }
  const out = [];
  for (const t of rows) {
    const inputs = decodeInputs(t.trigger_inputs); if (!inputs) continue;
    const val = (n) => inputs.find((x) => x?.name === n)?.value ?? '';
    out.push({ flow: String(ref(t.flow)), table: String(val('table')), condition: String(val('condition')) });
  }
  return { rows: out };
}
export function decodeInputs(raw) {
  if (isEmpty(raw)) return null;
  const s = String(raw).trim();
  try { return JSON.parse(s.startsWith('[') ? s : gunzipSync(Buffer.from(s, 'base64')).toString('utf8')); } catch { return null; }
}
