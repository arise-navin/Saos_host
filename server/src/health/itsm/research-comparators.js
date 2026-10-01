import { declareRequirement } from './data-access.js';
import { fromSnowTime } from './run-context.js';

/**
 * D-033 — the ITSM comparators the documentation research made buildable
 * (docs/HEALTH-ASSIST-RULE-RESEARCH.md, categories A and B).
 *
 * Same contract as every comparator (comparators.js): `{ offenders, observed,
 * expected, absent, population, kpi? }`, or `{ unavailable }` when a read the
 * judgement needs failed. Every value a comparator judges by is ServiceNow's own —
 * a system property, the instance's change state models, its approval records —
 * or a workbook default passed in as a parameter. None is coined here.
 *
 * STORED CONDITIONS ARE EVALUATED BY THE INSTANCE. An assignment rule's condition
 * is an encoded query; the Table API evaluates the same string, so "which incidents
 * does this rule match" is one read with the condition as its query (ITSM-004).
 */

const COMPLETE = 'complete';
const usable = (cov) => ['complete', 'limited', 'truncated'].includes(cov?.status);
const isEmpty = (v) => v === undefined || v === null || String(v).trim() === '';
const ref = (v) => (v && typeof v === 'object' ? v.value ?? v.sys_id ?? null : v);
const chunks = (xs, n = 100) => { const out = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };
const round1 = (n) => Number(n.toFixed(1));
const DAY_MS = 86400000;

async function rowsOf(ctx, { table, fields, query = '', complete = false }) {
  const r = await ctx.reads.read(declareRequirement({ table, fields, query, strategy: 'rows' }));
  if (!(complete ? r.coverage?.status === COMPLETE : usable(r.coverage))) return { unavailable: `${table} could not be read${complete ? ' completely' : ''} (${r.coverage?.status}${r.coverage?.error ? `: ${r.coverage.error}` : ''}) — no claim is made from a partial read`, coverage: r.coverage };
  return { rows: r.rows, coverage: r.coverage };
}
async function countsBy(ctx, { table, query = '', groupBy }) {
  const r = await ctx.reads.read(declareRequirement({ table, query, strategy: 'aggregate', groupBy }));
  if (r.coverage?.status !== COMPLETE) return { unavailable: `aggregate over ${table} failed (${r.coverage?.status})`, coverage: r.coverage };
  return { groups: r.groups, coverage: r.coverage, total: r.groups.reduce((n, g) => n + g.count, 0) };
}
/** How many rows of `table` reference each id (aggregate API, chunked) — approvals are counted, not paged. */
async function countsIn(ctx, { table, field, ids }) {
  const out = new Map();
  for (const c of chunks([...new Set(ids)])) {
    const g = await countsBy(ctx, { table, query: `${field}IN${c.join(',')}`, groupBy: [field] });
    if (g.unavailable) return g;
    for (const x of g.groups) out.set(String(x.group[field]), (out.get(String(x.group[field])) || 0) + x.count);
  }
  return { counts: out, total: [...out.values()].reduce((a, b) => a + b, 0) };
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
async function property(ctx, name) {
  const r = await rowsOf(ctx, { table: 'sys_properties', fields: ['name', 'value'], query: `name=${name}`, complete: true });
  if (r.unavailable) return r;
  return { value: r.rows[0]?.value ?? null };
}
/** Choice values by label (the instance's own list), e.g. change risk "High" → "2". */
async function choiceValues(ctx, { table, element, labels }) {
  const r = await rowsOf(ctx, { table: 'sys_choice', fields: ['label', 'value'], query: `name=${table}^element=${element}^inactive=false`, complete: true });
  if (r.unavailable) return r;
  return { values: r.rows.filter((c) => labels.includes(c.label)).map((c) => String(c.value)) };
}
const pop = (total, judged, unit, basis) => ({ total, judged, unit, basis });
const offender = (r, field, value) => ({ sys_id: r.sys_id, field, value });

export const ITSM_RESEARCH_COMPARATORS = Object.freeze({
  /**
   * ITSM-004 — records no active assignment rule matches. Each rule's condition is
   * run by the instance as the query; a rule with no condition matches everything.
   */
  records_unmatched_by_conditions: ({ table, scope = '' }) => async (rows, ctx) => {
    const population = await rowsOf(ctx, { table, fields: ['number'], query: scope, complete: true });
    if (population.unavailable) return population;
    const rules = rows.filter((r) => String(r.active) !== 'false' && (isEmpty(r.table) || r.table === table));
    if (!population.rows.length) return { offenders: [], observed: { records: 0, rules: rules.length }, expected: 0, absent: false, population: pop(0, 0, `${table} records`, `${table} where ${scope || 'any'}`) };
    const matched = new Set();
    let unconditional = false;
    for (const r of rules) {
      if (isEmpty(r.condition)) { unconditional = true; break; }
      const hit = await rowsOf(ctx, { table, fields: ['number'], query: [scope, String(r.condition).replace(/\^EQ$/, '')].filter(Boolean).join('^'), complete: true });
      if (hit.unavailable) return hit;
      for (const x of hit.rows) matched.add(x.sys_id);
    }
    const unmatched = unconditional ? [] : population.rows.filter((x) => !matched.has(x.sys_id));
    const n = population.rows.length;
    return {
      offenders: unmatched.map((x) => offender(x, 'assignment_rule', `${x.number ?? x.sys_id}: no active assignment rule matches`)),
      observed: { records: n, active_rules: rules.length, matched: n - unmatched.length, unmatched: unmatched.length, unmatched_pct: round1((100 * unmatched.length) / n) },
      expected: 'every record matched by an assignment rule', absent: false,
      kpi: { numerator: n - unmatched.length, denominator: n, basis: `${table} records an active assignment rule's condition matches (evaluated by the instance)` },
      population: pop(n, n, `${table} records`, `${table} where ${scope || 'any'} — each active rule's condition run by the instance as the query`),
    };
  },

  /**
   * ITSM-007 — a system property holding a number of days, at least `minimum`.
   * 0 or unset disables the feature (the OOB "incident autoclose" business rule acts only when > 0).
   */
  property_days_at_least: ({ property: name, minimum, volume_table = null, volume_query = '' }) => async (rows, ctx) => {
    /* A setting matters only where there are records it acts on: none, and nothing is judged. */
    if (volume_table) {
      const v = await ctx.reads.read(declareRequirement({ table: volume_table, query: volume_query, strategy: 'exists' }));
      if (v.count == null) return { unavailable: `count over ${volume_table} failed (${v.coverage?.status})`, coverage: v.coverage };
      if (!v.count) return { offenders: [], observed: { [volume_table]: 0 }, expected: `≥ ${minimum} days`, absent: false, population: pop(0, 0, `${volume_table} records`, `the setting acts on ${volume_table} where ${volume_query || 'any'} — there are none`) };
    }
    const row = rows.find((r) => r.name === name);
    const days = Number(row?.value);
    if (!row || !Number.isFinite(days) || days <= 0) {
      return { offenders: [], observed: { [name]: row?.value ?? 'not set', auto_close: 'disabled' }, expected: `≥ ${minimum} days, or disabled`, absent: false, population: pop(1, 1, 'system property', `${name} — 0 or unset disables auto-close`) };
    }
    const offenders = days < minimum ? [offender(row, 'value', `${name} = ${days} days (minimum ${minimum})`)] : [];
    return { offenders, observed: { [name]: days }, expected: `≥ ${minimum} days`, absent: false, population: pop(1, 1, 'system property', name) };
  },

  /**
   * ITSM-031 — the share of closures the auto-close job performed. The OOB business
   * rule "incident autoclose" closes a Resolved incident N days (glide.ui.autoclose.time)
   * after its last update and sets closed_by = resolved_by; so an auto-closure is a
   * closure by the resolver at least N days after resolution.
   */
  autoclose_share: ({ property: name, threshold }) => async (rows, ctx) => {
    const p = await property(ctx, name);
    if (p.unavailable) return p;
    const days = Number(p.value);
    const closed = rows.filter((r) => !isEmpty(r.closed_at) && !isEmpty(r.resolved_at));
    if (!closed.length) return { offenders: [], observed: { closed: 0 }, expected: `≤ ${threshold}%`, absent: false, population: pop(0, 0, 'closed incidents', 'incidents with both resolved_at and closed_at') };
    const auto = !Number.isFinite(days) || days <= 0 ? [] : closed.filter((r) => {
      const gap = fromSnowTime(r.closed_at) - fromSnowTime(r.resolved_at);
      return !isEmpty(r.closed_by) && String(ref(r.closed_by)) === String(ref(r.resolved_by)) && gap >= days * DAY_MS;
    });
    const share = round1((100 * auto.length) / closed.length);
    return {
      offenders: share > threshold ? auto.map((r) => offender(r, 'closed_by', `${r.number ?? r.sys_id}: closed by the resolver ${Math.floor((fromSnowTime(r.closed_at) - fromSnowTime(r.resolved_at)) / DAY_MS)} days after resolution`)) : [],
      observed: { closed: closed.length, auto_closed: auto.length, auto_closed_pct: share, [name]: Number.isFinite(days) ? days : 'not set' },
      expected: `≤ ${threshold}%`, absent: false,
      kpi: { numerator: closed.length - auto.length, denominator: closed.length, basis: 'closures not performed by the auto-close job' },
      population: pop(closed.length, closed.length, 'closed incidents', `closed_by = resolved_by at least ${name} days after resolution marks the OOB auto-close job`),
    };
  },

  /**
   * ITSM-081 / ITSM-091 — change types with volume that no approval ever reached:
   * no approval record (sysapproval_approver) and no applied change policy
   * (chg_policy_applied) on any change of the type. Standard changes are pre-approved
   * by definition and are not judged. `only_custom` limits the judgement to types
   * outside ServiceNow's own set (ITSM-091).
   */
  change_types_without_approval: ({ exclude_types = ['standard'], standard_types = [], only_custom = false }) => async (rows, ctx) => {
    const vol = await countsBy(ctx, { table: 'change_request', groupBy: ['type'] });
    if (vol.unavailable) return vol;
    const types = vol.groups.map((g) => ({ type: String(g.group.type ?? ''), count: g.count }))
      .filter((t) => t.type && t.count > 0 && !exclude_types.includes(t.type) && (!only_custom || !standard_types.includes(t.type)));
    const offenders = [];
    for (const t of types) {
      const chg = await rowsOf(ctx, { table: 'change_request', fields: ['number'], query: `type=${t.type}`, complete: true });
      if (chg.unavailable) return chg;
      const ids = chg.rows.map((c) => c.sys_id);
      const appr = await countsIn(ctx, { table: 'sysapproval_approver', field: 'sysapproval', ids });
      if (appr.unavailable) return appr;
      const applied = await countsIn(ctx, { table: 'chg_policy_applied', field: 'change_request', ids });
      if (applied.unavailable) return applied;
      if (!appr.total && !applied.total) offenders.push({ sys_id: t.type, field: 'type', value: `${t.type}: ${t.count} changes, none ever reached an approval or a change policy` });
    }
    return { offenders, observed: { types_judged: types.length, without_approval: offenders.length }, expected: 0, absent: false,
      population: pop(types.length, types.length, 'change types with volume', `${only_custom ? 'types outside ServiceNow\'s set' : 'every type'} with changes, standard excluded (pre-approved) — judged by the approvals and applied policies recorded`) };
  },

  /**
   * ITSM-086 — emergency approval not lighter than normal: approvals recorded per
   * emergency change ≥ approvals per normal change. "Materially lighter" is not
   * defined; only "not lighter at all" is judged.
   */
  emergency_approval_burden: () => async (rows, ctx) => {
    const per = {};
    for (const type of ['emergency', 'normal']) {
      const chg = await rowsOf(ctx, { table: 'change_request', fields: ['number'], query: `type=${type}`, complete: true });
      if (chg.unavailable) return chg;
      const appr = await countsIn(ctx, { table: 'sysapproval_approver', field: 'sysapproval', ids: chg.rows.map((c) => c.sys_id) });
      if (appr.unavailable) return appr;
      per[type] = { changes: chg.rows.length, approvals: appr.total, per_change: chg.rows.length ? round1(appr.total / chg.rows.length) : null };
    }
    const judged = per.emergency.changes > 0 && per.normal.changes > 0;
    const heavier = judged && per.emergency.per_change >= per.normal.per_change;
    return { offenders: heavier ? [{ sys_id: 'emergency', field: 'type', value: `${per.emergency.per_change} approvals per emergency change vs ${per.normal.per_change} per normal change` }] : [],
      observed: per, expected: 'fewer approvals per emergency change than per normal change', absent: false,
      population: pop(judged ? 2 : 0, judged ? 2 : 0, 'change types (emergency, normal)', 'approval records per change, by type — judged only when both types have changes') };
  },

  /**
   * ITSM-087 — a change model whose state model reaches Closed without passing any of
   * its implementation states (chg_model.implementation_states), walked over the
   * model's own transitions (sttrm_state / sttrm_state_transition).
   */
  models_closing_without_implementation: ({ closed_label = 'Closed' }) => async (rows, ctx) => {
    const models = rows.filter((m) => String(m.active) !== 'false');
    if (!models.length) return { offenders: [], observed: { models: 0 }, expected: 0, absent: false, population: pop(0, 0, 'change models', 'active change models') };
    const states = await inChunks(ctx, { table: 'sttrm_state', fields: ['sttrm_model', 'state_label', 'state_value', 'initial_state'], field: 'sttrm_model', ids: models.map((m) => m.sys_id) });
    if (states.unavailable) return states;
    const trans = await inChunks(ctx, { table: 'sttrm_state_transition', fields: ['from_state', 'to_state'], field: 'from_state', ids: states.rows.map((s) => s.sys_id) });
    if (trans.unavailable) return trans;
    const next = new Map();
    for (const t of trans.rows) { const f = String(ref(t.from_state)); if (!next.has(f)) next.set(f, []); next.get(f).push(String(ref(t.to_state))); }
    const offenders = []; let judged = 0;
    for (const m of models) {
      const own = states.rows.filter((s) => String(ref(s.sttrm_model)) === m.sys_id);
      const starts = own.filter((s) => String(s.initial_state) === 'true');
      const closed = new Set(own.filter((s) => s.state_label === closed_label).map((s) => s.sys_id));
      if (!starts.length || !closed.size) continue;
      judged += 1;
      const impl = new Set(String(m.implementation_states || '').split(',').filter(Boolean));
      const seen = new Set(); const queue = starts.map((s) => s.sys_id).filter((id) => !impl.has(id));
      let reaches = false;
      while (queue.length && !reaches) {
        const id = queue.shift(); if (seen.has(id)) continue; seen.add(id);
        if (closed.has(id)) { reaches = true; break; }
        for (const n of next.get(id) || []) if (!impl.has(n) && !seen.has(n)) queue.push(n);
      }
      if (reaches) offenders.push(offender(m, 'implementation_states', `${m.name}: Closed is reachable without passing an implementation state${impl.size ? '' : ' (the model declares none)'}`));
    }
    return { offenders, observed: { models_judged: judged, closing_without_implementation: offenders.length }, expected: 0, absent: false,
      population: pop(models.length, judged, 'active change models', 'models with an initial and a Closed state, walked over their own transitions') };
  },

  /** ITSM-089 — active standard change templates whose current version is older than the review period. */
  template_version_older_than: ({ months }) => async (rows, ctx) => {
    const live = rows.filter((r) => String(r.active) !== 'false' && String(r.retired) !== 'true' && !isEmpty(ref(r.current_version)));
    const v = await inChunks(ctx, { table: 'std_change_producer_version', fields: ['version', 'sys_created_on'], field: 'sys_id', ids: live.map((r) => String(ref(r.current_version))) });
    if (v.unavailable) return v;
    const cutoff = new Date(ctx.run.run_started_at); cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
    const byId = new Map(v.rows.map((x) => [x.sys_id, x]));
    const offenders = live.filter((r) => { const x = byId.get(String(ref(r.current_version))); return x && fromSnowTime(x.sys_created_on) < cutoff.getTime(); })
      .map((r) => offender(r, 'current_version', `${r.name}: current version dated ${byId.get(String(ref(r.current_version))).sys_created_on.slice(0, 10)}`));
    return { offenders, observed: { templates: live.length, not_reviewed: offenders.length, review_period_months: months }, expected: 0, absent: false,
      population: pop(live.length, live.length, 'active standard change templates', `the date of each template's current version (the platform has no review-date field) against ${months} months`) };
  },

  /**
   * ITSM-092 / ITSM-122 — closed high-risk changes with no post-implementation
   * review (review_status empty). `process`: the step is absent when NONE of them
   * carries a review (ITSM-092); otherwise each unreviewed change offends (ITSM-122).
   */
  high_risk_without_review: ({ risk_labels, process = false }) => async (rows, ctx) => {
    const cv = await choiceValues(ctx, { table: 'change_request', element: 'risk', labels: risk_labels });
    if (cv.unavailable) return cv;
    const high = rows.filter((r) => cv.values.includes(String(r.risk)));
    const unreviewed = high.filter((r) => isEmpty(r.review_status));
    const base = { observed: { closed_high_risk: high.length, without_review: unreviewed.length, risk_values: cv.values }, expected: process ? 'a review recorded on high-risk changes' : 0,
      population: pop(high.length, high.length, 'closed high-risk changes', `risk ${risk_labels.join(' / ')} (the platform's own values), review_status as the review record`) };
    if (process) return { ...base, offenders: [], absent: high.length > 0 && unreviewed.length === high.length };
    return { ...base, absent: false, offenders: unreviewed.map((r) => offender(r, 'review_status', `${r.number}: closed with no post-implementation review`)),
      kpi: high.length ? { numerator: high.length - unreviewed.length, denominator: high.length, basis: 'closed high-risk changes with a review' } : undefined };
  },

  /**
   * ITSM-084 — conflict detection not running: of the changes it applies to (a CI and
   * planned dates), every one is still "Not Run" / empty.
   */
  conflict_detection_running: () => async (rows, ctx) => {
    const eligible = await countsBy(ctx, { table: 'change_request', query: 'cmdb_ciISNOTEMPTY^start_dateISNOTEMPTY^end_dateISNOTEMPTY', groupBy: ['conflict_status'] });
    if (eligible.unavailable) return eligible;
    const ran = eligible.groups.filter((g) => ['Conflict', 'No Conflict'].includes(String(g.group.conflict_status))).reduce((n, g) => n + g.count, 0);
    const props = Object.fromEntries(rows.map((r) => [r.name, r.value]));
    return { offenders: [], absent: eligible.total > 0 && ran === 0,
      observed: { eligible_changes: eligible.total, checked: ran, properties: props }, expected: 'conflict detection has run on eligible changes',
      population: pop(eligible.total, eligible.total, 'changes with a CI and planned dates', 'conflict_status on the changes conflict detection applies to; change.conflict.* reported') };
  },

  /**
   * ITSM-138 — changes checked as "No Conflict" whose CI has no relationship at all:
   * conflict detection could not see any dependency.
   */
  no_conflict_without_relationships: () => async (rows, ctx) => {
    const ids = [...new Set(rows.map((r) => String(ref(r.cmdb_ci))).filter(Boolean))];
    const parents = await inChunks(ctx, { table: 'cmdb_rel_ci', fields: ['parent'], field: 'parent', ids });
    if (parents.unavailable) return parents;
    const children = await inChunks(ctx, { table: 'cmdb_rel_ci', fields: ['child'], field: 'child', ids });
    if (children.unavailable) return children;
    const related = new Set([...parents.rows.map((r) => String(ref(r.parent))), ...children.rows.map((r) => String(ref(r.child)))]);
    const offenders = rows.filter((r) => !related.has(String(ref(r.cmdb_ci)))).map((r) => offender(r, 'cmdb_ci', `${r.number}: "No Conflict" on a CI with no relationships`));
    return { offenders, observed: { no_conflict_changes: rows.length, ci_without_relationships: offenders.length }, expected: 0, absent: false,
      population: pop(rows.length, rows.length, 'changes checked as No Conflict', 'the change CI\'s relationships in cmdb_rel_ci, either direction') };
  },

  /**
   * ITSM-034 — assignment groups whose SLA cancel or pause share is above `multiple`
   * × the estate mean (task_sla.stage, grouped by the task's assignment group).
   */
  sla_stage_share_by_group: ({ stages = ['cancelled', 'paused'], multiple }) => async (rows, ctx) => {
    const agg = await countsBy(ctx, { table: 'task_sla', query: 'task.assignment_groupISNOTEMPTY', groupBy: ['task.assignment_group', 'stage'] });
    if (agg.unavailable) return agg;
    const groups = new Map();
    for (const g of agg.groups) {
      const k = String(g.group['task.assignment_group']);
      if (!groups.has(k)) groups.set(k, { total: 0 });
      const e = groups.get(k); e.total += g.count; e[g.group.stage] = (e[g.group.stage] || 0) + g.count;
    }
    const total = agg.total;
    const offenders = []; const means = {};
    for (const st of stages) {
      const all = [...groups.values()].reduce((n, e) => n + (e[st] || 0), 0);
      means[st] = total ? round1((100 * all) / total) : 0;
      if (!all) continue;
      for (const [k, e] of groups) {
        const share = (100 * (e[st] || 0)) / e.total;
        if (share > multiple * means[st]) offenders.push({ sys_id: k, field: `stage=${st}`, value: `${round1(share)}% ${st} (estate ${means[st]}%, ${e.total} SLA records)` });
      }
    }
    return { offenders, observed: { groups: groups.size, sla_records: total, estate_share_pct: means, multiple }, expected: `≤ ${multiple}× the estate share`, absent: false,
      population: pop(groups.size, groups.size, 'assignment groups with SLA records', 'task_sla stage share per task assignment group against the estate share') };
  },

  /**
   * ITSM-137 — active SLA definitions whose conditions name a service that has no
   * offering (no service_offering whose parent is the service).
   */
  sla_on_service_without_offering: ({ fields = ['business_service', 'cmdb_ci', 'service_offering'] }) => async (rows, ctx) => {
    const named = new Map();
    for (const d of rows) {
      const text = [d.start_condition, d.pause_condition, d.stop_condition].join('^');
      for (const f of fields) for (const m of text.matchAll(new RegExp(`(?:^|\\^|OR)${f}(?:=|IN)([0-9a-f,]{32,})`, 'g'))) for (const id of m[1].split(',')) if (/^[0-9a-f]{32}$/.test(id)) { if (!named.has(d.sys_id)) named.set(d.sys_id, new Set()); named.get(d.sys_id).add(id); }
    }
    const ids = [...new Set([...named.values()].flatMap((s) => [...s]))];
    if (!ids.length) return { offenders: [], observed: { definitions: rows.length, naming_a_record: 0 }, expected: 0, absent: false, population: pop(0, 0, 'SLA definitions naming a service', 'service references (sys_ids) in start / pause / stop conditions') };
    const svc = await inChunks(ctx, { table: 'cmdb_ci_service', fields: ['name'], field: 'sys_id', ids });
    if (svc.unavailable) return svc;
    const offs = await inChunks(ctx, { table: 'service_offering', fields: ['parent'], field: 'parent', ids: svc.rows.map((s) => s.sys_id) });
    if (offs.unavailable) return offs;
    const withOffering = new Set(offs.rows.map((o) => String(ref(o.parent))));
    const services = new Map(svc.rows.map((s) => [s.sys_id, s]));
    const judged = rows.filter((d) => [...(named.get(d.sys_id) || [])].some((id) => services.has(id)));
    const offenders = judged.filter((d) => [...named.get(d.sys_id)].some((id) => services.has(id) && !withOffering.has(id)))
      .map((d) => offender(d, 'start_condition', `${d.name}: names ${[...named.get(d.sys_id)].filter((id) => services.has(id) && !withOffering.has(id)).map((id) => services.get(id).name).join(', ')}, which has no offering`));
    return { offenders, observed: { definitions: rows.length, naming_a_service: judged.length, service_without_offering: offenders.length }, expected: 0, absent: false,
      population: pop(judged.length, judged.length, 'SLA definitions naming a service', 'service sys_ids written in the conditions; a service\'s offerings are service_offering rows whose parent it is') };
  },
});
