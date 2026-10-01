import { gunzipSync } from 'node:zlib';
import { declareRequirement } from '../itsm/data-access.js';
import { fromSnowTime } from '../itsm/run-context.js';

/**
 * HEALTH ASSIST PHASE 10 — the ITIL comparators (D-034). Same contract as every
 * comparator (itsm/comparators.js): `{ offenders, observed, expected, absent, population }`,
 * or `{ unavailable }` when a read the judgement needs failed. Merged into the shared
 * library; a name is defined once.
 *
 * Every value a comparator judges by is ServiceNow's own: SLA-definition types (SLA, OLA,
 * Underpinning contract), commitment types (Availability, SLA, Recovery time objective,
 * Recovery point objective), the change task type Testing, the sla_manager and
 * portfolio_manager roles, the "Knowledge - Instant Publish" flow, the fulfilment task
 * state Closed Complete (3).
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
  return { groups: r.groups, total: r.groups.reduce((n, g) => n + g.count, 0) };
}
async function countOf(ctx, { table, query = '' }) {
  const r = await ctx.reads.read(declareRequirement({ table, query, strategy: 'exists' }));
  if (r.count == null) return { unavailable: `count over ${table} failed (${r.coverage?.status})`, coverage: r.coverage };
  return { count: r.count };
}
/** How many rows of `table` reference each id (aggregate, chunked). */
async function countsIn(ctx, { table, field, ids, extra = '' }) {
  const out = new Map();
  for (const c of chunks([...new Set(ids)])) {
    const g = await countsBy(ctx, { table, query: `${field}IN${c.join(',')}${extra ? `^${extra}` : ''}`, groupBy: [field] });
    if (g.unavailable) return g;
    for (const x of g.groups) out.set(String(x.group[field]), (out.get(String(x.group[field])) || 0) + x.count);
  }
  return { counts: out };
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
/** Groups (of `ids`) with at least one active member. */
async function groupsWithActiveMembers(ctx, ids) {
  const m = await inChunks(ctx, { table: 'sys_user_grmember', fields: ['group', 'user'], field: 'group', ids });
  if (m.unavailable) return m;
  const users = await inChunks(ctx, { table: 'sys_user', fields: ['active'], field: 'sys_id', ids: m.rows.map((x) => String(ref(x.user))) });
  if (users.unavailable) return users;
  const active = new Set(users.rows.filter((u) => String(u.active) === 'true').map((u) => u.sys_id));
  return { groups: new Set(m.rows.filter((x) => active.has(String(ref(x.user)))).map((x) => String(ref(x.group)))) };
}
const pop = (total, judged, unit, basis) => ({ total, judged, unit, basis });
const offender = (r, field, value) => ({ sys_id: r.sys_id, field, value });

export const ITIL_COMPARATORS = Object.freeze({
  /** ITIL-007 — closed request items with no close notes and no fulfilment task in Closed Complete. */
  itil_requests_without_evidence: ({ complete_state = '3' } = {}) => async (rows, ctx) => {
    const done = await countsIn(ctx, { table: 'sc_task', field: 'request_item', ids: rows.map((r) => r.sys_id), extra: `state=${complete_state}` });
    if (done.unavailable) return done;
    const offenders = rows.filter((r) => !done.counts.get(r.sys_id)).map((r) => offender(r, 'close_notes', `${r.number}: closed with no close notes and no completed fulfilment task`));
    return { offenders, observed: { closed_without_notes: rows.length, without_evidence: offenders.length }, expected: 0, absent: false,
      population: pop(rows.length, rows.length, 'closed request items with no close notes', 'fulfilment tasks (sc_task) in Closed Complete') };
  },

  /** ITIL-012 — fulfilment groups (catalog item groups, open fulfilment task groups) with zero active members. */
  itil_fulfilment_groups_empty: () => async (rows, ctx) => {
    const tasks = await countsBy(ctx, { table: 'sc_task', query: 'active=true^assignment_groupISNOTEMPTY', groupBy: ['assignment_group'] });
    if (tasks.unavailable) return tasks;
    const ids = [...new Set([...rows.map((r) => String(ref(r.group))), ...tasks.groups.map((g) => String(g.group.assignment_group))].filter(Boolean))];
    const live = await groupsWithActiveMembers(ctx, ids); if (live.unavailable) return live;
    const offenders = ids.filter((g) => !live.groups.has(g)).map((g) => ({ sys_id: g, field: 'group', value: `${g}: a fulfilment group with no active member` }));
    return { offenders, observed: { fulfilment_groups: ids.length, empty: offenders.length }, expected: 0, absent: false,
      population: pop(ids.length, ids.length, 'fulfilment groups', 'catalog item groups and assignment groups of open fulfilment tasks, by active membership') };
  },

  /** ITIL-021 — items with no "Available for" user criteria and no roles, judged only where some item has criteria. */
  itil_items_without_criteria: () => async (rows, ctx) => {
    const crit = await countsBy(ctx, { table: 'sc_cat_item_user_criteria_mtom', groupBy: ['sc_cat_item'] });
    if (crit.unavailable) return crit;
    const has = new Set(crit.groups.map((g) => String(g.group.sc_cat_item)));
    if (!rows.some((r) => has.has(r.sys_id))) return { offenders: [], observed: { items: rows.length, with_criteria: 0 }, expected: 0, absent: false, population: { total: rows.length, judged: 0, unit: 'active catalog items', basis: 'no item uses user criteria — entitlement is not differentiated anywhere (the guard)', determinate_when_empty: 'no entitlement differentiation exists' } };
    const offenders = rows.filter((r) => !has.has(r.sys_id) && isEmpty(r.roles)).map((r) => offender(r, 'user_criteria', `${r.name}: visible to everyone (no user criteria, no roles)`));
    return { offenders, observed: { items: rows.length, with_criteria: rows.filter((r) => has.has(r.sys_id)).length, open_to_all: offenders.length }, expected: 0, absent: false,
      population: pop(rows.length, rows.length, 'active catalog items', 'sc_cat_item_user_criteria_mtom and roles') };
  },

  /** ITIL-030 — published articles with no ownership group, or a group with no active member. */
  itil_articles_without_owner: () => async (rows, ctx) => {
    const ids = [...new Set(rows.map((r) => String(ref(r.ownership_group))).filter((x) => x && x !== 'null'))];
    const live = ids.length ? await groupsWithActiveMembers(ctx, ids) : { groups: new Set() };
    if (live.unavailable) return live;
    const offenders = rows.filter((r) => isEmpty(ref(r.ownership_group)) || !live.groups.has(String(ref(r.ownership_group))))
      .map((r) => offender(r, 'ownership_group', `${r.number}: ${isEmpty(ref(r.ownership_group)) ? 'no ownership group' : 'ownership group has no active member'}`));
    return { offenders, observed: { published: rows.length, without_owner: offenders.length }, expected: 0, absent: false,
      population: pop(rows.length, rows.length, 'published articles', 'ownership group and its active membership') };
  },

  /** ITIL-034 — feedback (flagged, not useful, or commented) on an article not updated since. */
  itil_feedback_not_actioned: () => async (rows, ctx) => {
    const arts = await inChunks(ctx, { table: 'kb_knowledge', fields: ['number', 'sys_updated_on'], field: 'sys_id', ids: rows.map((r) => String(ref(r.article))).filter(Boolean) });
    if (arts.unavailable) return arts;
    const updated = new Map(arts.rows.map((a) => [a.sys_id, a]));
    const judged = rows.filter((f) => updated.has(String(ref(f.article))));
    const offenders = judged.filter((f) => fromSnowTime(updated.get(String(ref(f.article))).sys_updated_on) < fromSnowTime(f.sys_created_on))
      .map((f) => offender(f, 'article', `${updated.get(String(ref(f.article))).number}: feedback of ${String(f.sys_created_on).slice(0, 10)} with no article update since`));
    return { offenders, observed: { feedback: rows.length, judged: judged.length, not_actioned: offenders.length }, expected: 0, absent: false,
      population: pop(rows.length, judged.length, 'actionable feedback', 'flagged, not useful, or commented kb_feedback against the article\'s last update') };
  },

  /** ITIL-038 — active knowledge bases publishing through "Knowledge - Instant Publish" (no approval). */
  itil_kb_without_publish_approval: ({ instant = 'Knowledge - Instant Publish' } = {}) => async (rows, ctx) => {
    const flows = await inChunks(ctx, { table: 'sys_hub_flow', fields: ['name'], field: 'sys_id', ids: rows.map((r) => String(ref(r.kb_publish_flow))).filter(Boolean) });
    if (flows.unavailable) return flows;
    const wfs = await inChunks(ctx, { table: 'wf_workflow', fields: ['name'], field: 'sys_id', ids: rows.map((r) => String(ref(r.workflow))).filter(Boolean) });
    if (wfs.unavailable) return wfs;
    const name = new Map([...flows.rows, ...wfs.rows].map((x) => [x.sys_id, x.name]));
    const via = (r) => name.get(String(ref(r.kb_publish_flow))) ?? name.get(String(ref(r.workflow))) ?? null;
    const judged = rows.filter((r) => via(r));
    const offenders = judged.filter((r) => via(r) === instant).map((r) => offender(r, 'kb_publish_flow', `${r.title}: publishes through "${instant}" — no approval`));
    return { offenders, observed: { knowledge_bases: rows.length, judged: judged.length, instant_publish: offenders.length }, expected: 0, absent: false,
      population: pop(rows.length, judged.length, 'active knowledge bases', 'the publish flow or workflow each knowledge base names') };
  },

  /** ITIL-044 / 045 — SLA definitions of type `base` in use and none of type `missing`. */
  itil_agreement_type_absent: ({ base, missing }) => async (rows) => {
    const n = (t) => rows.filter((r) => String(r.type) === t).length;
    return { offenders: [], absent: n(base) > 0 && n(missing) === 0, observed: { [base]: n(base), [missing]: n(missing) }, expected: `≥ 1 ${missing} definition where ${base}s are in use`,
      population: n(base) ? pop(1, 1, 'presence check', `active SLA definitions by ServiceNow's own type (${base}, ${missing})`) : pop(0, 0, `active ${base} definitions`, `no ${base} is in use`) };
  },

  /** ITIL-047 — scheduled reports on SLA / availability tables with no external address. */
  itil_service_reports_without_distribution: ({ tables }) => async (rows, ctx) => {
    const reps = await inChunks(ctx, { table: 'sys_report', fields: ['title', 'table'], field: 'sys_id', ids: rows.map((r) => String(ref(r.report))).filter(Boolean) });
    if (reps.unavailable) return reps;
    const rep = new Map(reps.rows.map((r) => [r.sys_id, r]));
    const judged = rows.filter((r) => tables.includes(rep.get(String(ref(r.report)))?.table));
    const offenders = judged.filter((r) => isEmpty(r.address_list)).map((r) => offender(r, 'address_list', `${r.name}: a scheduled service report with no external distribution`));
    return { offenders, observed: { scheduled_reports: rows.length, service_reports: judged.length, internal_only: offenders.length }, expected: 0, absent: false,
      population: pop(judged.length, judged.length, 'scheduled service reports', `scheduled reports on ${tables.join(', ')}`) };
  },

  /** ITIL-049 / 134 — ServiceNow's own role for the practice, held by no active user. */
  itil_role_unheld: ({ role }) => async (rows, ctx) => {
    const r = rows.find((x) => x.name === role);
    if (!r) return { offenders: [], observed: { role: 'not on the instance' }, expected: 'the role exists', absent: false, population: { total: 0, judged: 0, unit: 'roles', basis: `the ${role} role is not on this instance` } };
    const holders = await rowsOf(ctx, { table: 'sys_user_has_role', fields: ['user'], query: `role=${r.sys_id}`, complete: true }); if (holders.unavailable) return holders;
    const users = await inChunks(ctx, { table: 'sys_user', fields: ['active'], field: 'sys_id', ids: holders.rows.map((h) => String(ref(h.user))) }); if (users.unavailable) return users;
    const active = users.rows.filter((u) => String(u.active) === 'true').length;
    return { offenders: [], absent: active === 0, observed: { role, active_holders: active }, expected: '≥ 1 active holder', population: pop(1, 1, 'presence check', `active users holding ${role}`) };
  },

  /** ITIL-050 — an active survey that has sent assessments. */
  itil_surveys_in_use: () => async (rows, ctx) => {
    if (!rows.length) return { offenders: [], absent: true, observed: { active_surveys: 0 }, expected: 'an active satisfaction survey', population: pop(1, 1, 'presence check', 'active surveys (asmt_metric_type, evaluation method survey)') };
    const sent = await countsIn(ctx, { table: 'asmt_assessment_instance', field: 'metric_type', ids: rows.map((r) => r.sys_id) });
    if (sent.unavailable) return sent;
    const used = rows.filter((r) => sent.counts.get(r.sys_id));
    return { offenders: [], absent: used.length === 0, observed: { active_surveys: rows.length, with_assessments: used.length }, expected: 'an active survey that has been sent', population: pop(1, 1, 'presence check', 'active surveys and their assessment instances') };
  },

  /** ITIL-063 — records with no approval record at all. */
  itil_records_without_approval: () => async (rows, ctx) => {
    const appr = await countsIn(ctx, { table: 'sysapproval_approver', field: 'sysapproval', ids: rows.map((r) => r.sys_id) });
    if (appr.unavailable) return appr;
    const offenders = rows.filter((r) => !appr.counts.get(r.sys_id)).map((r) => offender(r, 'approval', `${r.number}: no approval recorded`));
    return { offenders, observed: { records: rows.length, without_approval: offenders.length }, expected: 0, absent: false, population: pop(rows.length, rows.length, 'releases', 'sysapproval_approver on the release') };
  },

  /** ITIL-067 — closed changes with no test plan and no Testing task. */
  itil_changes_without_test_evidence: ({ task_type = 'testing' } = {}) => async (rows, ctx) => {
    const tested = await countsIn(ctx, { table: 'change_task', field: 'change_request', ids: rows.map((r) => r.sys_id), extra: `change_task_type=${task_type}` });
    if (tested.unavailable) return tested;
    const offenders = rows.filter((r) => !tested.counts.get(r.sys_id)).map((r) => offender(r, 'test_plan', `${r.number}: closed with no test plan and no Testing task`));
    return { offenders, observed: { closed_without_test_plan: rows.length, without_testing_task: offenders.length }, expected: 0, absent: false,
      population: pop(rows.length, rows.length, 'closed changes with no test plan', 'change tasks of type Testing') };
  },

  /** ITIL-071 — platform upgrades with no ATF result recorded after them. */
  itil_upgrades_without_regression: () => async (rows, ctx) => {
    const offenders = []; let judged = 0;
    const sorted = [...rows].filter((r) => fromSnowTime(r.upgrade_started)).sort((a, b) => fromSnowTime(a.upgrade_started) - fromSnowTime(b.upgrade_started));
    for (let i = 0; i < sorted.length; i += 1) {
      const from = sorted[i].upgrade_started; const to = sorted[i + 1]?.upgrade_started;
      const q = `start_time>=${from}${to ? `^start_time<${to}` : ''}`;
      const s = await countOf(ctx, { table: 'sys_atf_test_suite_result', query: q }); if (s.unavailable) return s;
      const t = await countOf(ctx, { table: 'sys_atf_test_result', query: q }); if (t.unavailable) return t;
      judged += 1;
      if (!s.count && !t.count) offenders.push(offender(sorted[i], 'to_version', `upgrade of ${String(from).slice(0, 10)} to ${String(sorted[i].to_version).replace(/\.zip$/, '').slice(0, 60)}: no ATF result before the next upgrade`));
    }
    return { offenders, observed: { platform_upgrades: rows.length, judged, without_regression: offenders.length }, expected: 0, absent: false,
      population: pop(rows.length, judged, 'platform upgrades', 'ATF suite and test results between an upgrade and the next') };
  },

  /**
   * ITIL-087 / 096 — services whose offerings carry no commitment of `types`
   * (`all`: every type required, else any one).
   */
  itil_services_without_commitment: ({ types, all = false }) => async (rows, ctx) => {
    const offs = await inChunks(ctx, { table: 'service_offering', fields: ['parent'], field: 'parent', ids: rows.map((s) => s.sys_id) }); if (offs.unavailable) return offs;
    const links = await inChunks(ctx, { table: 'service_offering_commitment', fields: ['service_offering', 'service_commitment'], field: 'service_offering', ids: offs.rows.map((o) => o.sys_id) }); if (links.unavailable) return links;
    const commits = await inChunks(ctx, { table: 'service_commitment', fields: ['type'], field: 'sys_id', ids: links.rows.map((l) => String(ref(l.service_commitment))) }); if (commits.unavailable) return commits;
    const typeOf = new Map(commits.rows.map((c) => [c.sys_id, String(c.type)]));
    const offOf = new Map(offs.rows.map((o) => [o.sys_id, String(ref(o.parent))]));
    const has = new Map();
    for (const l of links.rows) { const svc = offOf.get(String(ref(l.service_offering))); const t = typeOf.get(String(ref(l.service_commitment))); if (!svc || !t) continue; if (!has.has(svc)) has.set(svc, new Set()); has.get(svc).add(t); }
    const ok = (s) => { const h = has.get(s.sys_id) || new Set(); return all ? types.every((t) => h.has(t)) : types.some((t) => h.has(t)); };
    const offenders = rows.filter((s) => !ok(s)).map((s) => offender(s, 'service_commitment', `${s.name}: no ${types.join(all ? ' and ' : ' or ')} commitment on its offerings`));
    return { offenders, observed: { services: rows.length, without: offenders.length }, expected: 0, absent: false,
      kpi: rows.length ? { numerator: rows.length - offenders.length, denominator: rows.length, basis: `services whose offerings carry ${types.join(all ? ' and ' : ' or ')}` } : undefined,
      population: pop(rows.length, rows.length, 'services', `commitments (${types.join(', ')}) on the service's offerings (service_offering_commitment)`) };
  },

  /** ITIL-106 — active contracts linked to no CI (contract_rel_ci.ci_item) and no asset (clm_m2m_contract_asset, where present). */
  itil_contracts_unlinked: () => async (rows, ctx) => {
    const ids = rows.map((r) => r.sys_id);
    const links = await countsIn(ctx, { table: 'contract_rel_ci', field: 'contract', ids });
    if (links.unavailable) return links;
    const assets = await countsIn(ctx, { table: 'clm_m2m_contract_asset', field: 'contract', ids });
    const linked = (id) => links.counts.get(id) || (!assets.unavailable && assets.counts.get(id));
    const offenders = rows.filter((r) => !linked(r.sys_id)).map((r) => offender(r, 'contract_rel_ci', `${r.number}: an active contract linked to no CI, service or asset`));
    return { offenders, observed: { active_contracts: rows.length, unlinked: offenders.length, asset_links_read: !assets.unavailable }, expected: 0, absent: false,
      population: pop(rows.length, rows.length, 'active contracts', assets.unavailable ? 'contract_rel_ci rows naming the contract (asset links not readable)' : 'contract_rel_ci and clm_m2m_contract_asset rows naming the contract') };
  },

  /**
   * ITIL-120 — active on-call rotas whose escalation has no defined path or resolves to
   * nobody. A custom escalation (use_custom_escalation) is its active escalation sets'
   * step definitions (cmn_rota_esc_step_def): each step reaches its users, its groups'
   * members, its rosters' members and, when group_manager is set, the rota group's manager.
   * The default escalation walks the rota's active rosters' members. Only active users count.
   */
  itil_escalation_unresolved: () => async (rows, ctx) => {
    if (!rows.length) return { offenders: [], observed: { active_rotas: 0 }, expected: 0, absent: false, population: pop(0, 0, 'active on-call rotas', 'no active rota') };
    const list = (v) => String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const ids = rows.map((r) => r.sys_id);
    const sets = await inChunks(ctx, { table: 'cmn_rota_escalation_set', fields: ['cmn_rota'], field: 'cmn_rota', ids, extra: 'active=true' }); if (sets.unavailable) return sets;
    const steps = sets.rows.length ? await inChunks(ctx, { table: 'cmn_rota_esc_step_def', fields: ['escalation_set', 'sys_users', 'sys_user_groups', 'cmn_rota_rosters', 'group_manager'], field: 'escalation_set', ids: sets.rows.map((s) => s.sys_id) }) : { rows: [] };
    if (steps.unavailable) return steps;
    const rosters = await inChunks(ctx, { table: 'cmn_rota_roster', fields: ['rota'], field: 'rota', ids, extra: 'active=true' }); if (rosters.unavailable) return rosters;
    const rosterIds = [...new Set([...rosters.rows.map((x) => x.sys_id), ...steps.rows.flatMap((s) => list(s.cmn_rota_rosters))])];
    const members = rosterIds.length ? await inChunks(ctx, { table: 'cmn_rota_member', fields: ['roster', 'member'], field: 'roster', ids: rosterIds }) : { rows: [] };
    if (members.unavailable) return members;
    const groupIds = [...new Set(steps.rows.flatMap((s) => list(s.sys_user_groups)))];
    const liveGroups = groupIds.length ? await groupsWithActiveMembers(ctx, groupIds) : { groups: new Set() }; if (liveGroups.unavailable) return liveGroups;
    const rotaGroups = [...new Set(rows.map((r) => String(ref(r.group) ?? '')).filter(Boolean))];
    const managers = rotaGroups.length ? await inChunks(ctx, { table: 'sys_user_group', fields: ['manager'], field: 'sys_id', ids: rotaGroups }) : { rows: [] }; if (managers.unavailable) return managers;
    const managerOf = new Map(managers.rows.map((g) => [g.sys_id, String(ref(g.manager) ?? '')]));
    const userIds = [...new Set([...members.rows.map((m) => String(ref(m.member))), ...steps.rows.flatMap((s) => list(s.sys_users)), ...managerOf.values()].filter(Boolean))];
    const users = userIds.length ? await inChunks(ctx, { table: 'sys_user', fields: ['active'], field: 'sys_id', ids: userIds }) : { rows: [] }; if (users.unavailable) return users;
    const active = new Set(users.rows.filter((u) => String(u.active) === 'true').map((u) => u.sys_id));
    const liveRosters = new Set(members.rows.filter((m) => active.has(String(ref(m.member)))).map((m) => String(ref(m.roster))));
    const setsOf = (rota) => sets.rows.filter((s) => String(ref(s.cmn_rota)) === rota).map((s) => s.sys_id);
    const offenders = [];
    for (const r of rows) {
      let why = null;
      if (String(r.use_custom_escalation) === 'true') {
        const own = setsOf(r.sys_id);
        const st = steps.rows.filter((s) => own.includes(String(ref(s.escalation_set))));
        const reaches = (s) => list(s.sys_users).some((u) => active.has(u)) || list(s.sys_user_groups).some((g) => liveGroups.groups.has(g))
          || list(s.cmn_rota_rosters).some((x) => liveRosters.has(x)) || (String(s.group_manager) === 'true' && active.has(managerOf.get(String(ref(r.group))) ?? ''));
        if (!own.length) why = 'custom escalation with no active escalation set';
        else if (!st.length) why = 'custom escalation sets with no escalation step';
        else if (!st.some(reaches)) why = 'every escalation step resolves to inactive users, empty groups or empty rosters';
      } else {
        const own = rosters.rows.filter((x) => String(ref(x.rota)) === r.sys_id).map((x) => x.sys_id);
        if (!own.length) why = 'no active roster to escalate through';
        else if (!own.some((x) => liveRosters.has(x))) why = 'every roster resolves to no active member';
      }
      if (why) offenders.push(offender(r, 'escalation', `${r.name}: ${why}`));
    }
    return { offenders, observed: { active_rotas: rows.length, unresolved: offenders.length }, expected: 0, absent: false,
      population: pop(rows.length, rows.length, 'active on-call rotas', 'escalation sets and steps (custom) or rosters (default), resolved to active users') };
  },

  /**
   * ITIL-128 / 131 — service cost attribution (fm_expense_line.ci). A service's supporting
   * CIs are its direct children in cmdb_rel_ci. 'unattributed': an operational service with
   * no expense line of its own while a supporting CI carries some. 'retired': a retired
   * service with an operational supporting CI that carries expense lines.
   */
  itil_service_cost: ({ mode }) => async (rows, ctx) => {
    if (!rows.length) return { offenders: [], observed: { services: 0 }, expected: 0, absent: false, population: pop(0, 0, mode === 'retired' ? 'retired services' : 'operational services', 'none on the instance') };
    const rels = await inChunks(ctx, { table: 'cmdb_rel_ci', fields: ['parent', 'child'], field: 'parent', ids: rows.map((r) => r.sys_id) }); if (rels.unavailable) return rels;
    let children = [...new Set(rels.rows.map((x) => String(ref(x.child))))];
    if (mode === 'retired' && children.length) {
      const live = await inChunks(ctx, { table: 'cmdb_ci', fields: ['operational_status'], field: 'sys_id', ids: children, extra: 'operational_status=1' }); if (live.unavailable) return live;
      children = live.rows.map((x) => x.sys_id);
    }
    const cost = children.length ? await countsIn(ctx, { table: 'fm_expense_line', field: 'ci', ids: children }) : { counts: new Map() }; if (cost.unavailable) return cost;
    const costed = (svc) => rels.rows.filter((x) => String(ref(x.parent)) === svc && cost.counts.get(String(ref(x.child))));
    if (mode === 'retired') {
      const offenders = rows.filter((r) => costed(r.sys_id).length).map((r) => offender(r, 'cost', `${r.name}: retired, with ${costed(r.sys_id).length} operational supporting CI(s) carrying cost`));
      return { offenders, observed: { retired_services: rows.length, still_costing: offenders.length }, expected: 0, absent: false,
        population: pop(rows.length, rows.length, 'retired services', 'direct supporting CIs in an operational state with expense lines') };
    }
    const judged = rows.filter((r) => costed(r.sys_id).length);
    const own = judged.length ? await countsIn(ctx, { table: 'fm_expense_line', field: 'ci', ids: judged.map((r) => r.sys_id) }) : { counts: new Map() }; if (own.unavailable) return own;
    const offenders = judged.filter((r) => !own.counts.get(r.sys_id)).map((r) => offender(r, 'cost', `${r.name}: no cost attributed, while ${costed(r.sys_id).length} supporting CI(s) carry cost`));
    return { offenders, observed: { operational_services: rows.length, with_costed_supporting_cis: judged.length, unattributed: offenders.length }, expected: 0, absent: false,
      population: { total: rows.length, judged: judged.length, unit: 'operational services', basis: 'services whose direct supporting CIs carry expense lines; a service with no cost data below it is not judged', determinate_when_empty: 'no supporting CI carries cost data' } };
  },

  /**
   * ITIL-148 — Performance Analytics indicators collected by an active job with neither an
   * active threshold (pa_thresholds) nor an active target (pa_targets): the indicator has
   * no action threshold and, since owners are held on thresholds and targets, no owner.
   */
  itil_indicators_ungoverned: () => async (rows, ctx) => {
    const collected = [...new Set(rows.map((r) => String(ref(r.indicator))).filter(Boolean))];
    if (!collected.length) return { offenders: [], observed: { collected_indicators: 0 }, expected: 0, absent: false, population: pop(0, 0, 'collected indicators', 'no indicator is collected by an active job') };
    const th = await rowsOf(ctx, { table: 'pa_thresholds', fields: ['indicator', 'owner'], query: 'active=true', complete: true }); if (th.unavailable) return th;
    const tg = await rowsOf(ctx, { table: 'pa_targets', fields: ['indicator', 'owner'], query: 'active=true', complete: true }); if (tg.unavailable) return tg;
    const governed = new Set([...th.rows, ...tg.rows].map((x) => String(ref(x.indicator))));
    const ownerless = new Set([...th.rows, ...tg.rows].filter((x) => isEmpty(ref(x.owner))).map((x) => String(ref(x.indicator))));
    const names = await inChunks(ctx, { table: 'pa_indicators', fields: ['name'], field: 'sys_id', ids: collected }); if (names.unavailable) return names;
    const nameOf = new Map(names.rows.map((x) => [x.sys_id, x.name]));
    const offenders = collected.filter((i) => !governed.has(i)).map((i) => ({ sys_id: i, field: 'threshold', value: `${nameOf.get(i) ?? i}: collected, with no active threshold or target (no owner, no action threshold)` }));
    return { offenders, observed: { collected_indicators: collected.length, ungoverned: offenders.length, governed_without_owner: [...governed].filter((i) => collected.includes(i) && ownerless.has(i)).length }, expected: 0, absent: false,
      population: pop(collected.length, collected.length, 'collected indicators', 'indicators of active PA jobs, against active thresholds and targets') };
  },

  /**
   * ITIL-082 — subscription consumption against entitlement, by Subscription Management's own
   * status on the latest calculation: Over-allocated is charged; Near capacity is reported.
   * No calculation at all means consumption is not monitored.
   */
  itil_subscriptions_over: () => async (rows) => {
    if (!rows.length) return { offenders: [], absent: true, observed: { subscriptions: 0 }, expected: 'subscription consumption calculated against entitlement', population: pop(1, 1, 'presence check', 'latest Subscription Management calculations (subscription_detail)') };
    const offenders = rows.filter((r) => r.status === 'over').map((r) => offender(r, 'status', `${r.subscription_name}: over-allocated (${r.allocated_count} allocated)`));
    return { offenders, observed: { subscriptions: rows.length, over_allocated: offenders.length, near_capacity: rows.filter((r) => r.status === 'near').length }, expected: 0, absent: false,
      population: pop(rows.length, rows.length, 'subscriptions', 'status of the latest calculation (Over-allocated / Near capacity are ServiceNow\'s own)') };
  },

  /**
   * ITIL-145 — a measure: the four loop ratios reported together, never judged. Recurrence:
   * incidents on a problem that has more than one incident. Problem creation: incidents
   * linked to a problem. Known-error publication: known errors that are the source of a
   * published article (as ITSM-066). Article consumption: incidents with an article
   * attached (m2m_kb_task, as ITIL-027).
   */
  itil_loop_ratios: () => async (_rows, ctx) => {
    const inc = await countOf(ctx, { table: 'incident' }); if (inc.unavailable) return inc;
    const byProblem = await countsBy(ctx, { table: 'incident', query: 'problem_idISNOTEMPTY', groupBy: ['problem_id'] }); if (byProblem.unavailable) return byProblem;
    const ke = await rowsOf(ctx, { table: 'problem', fields: ['number'], query: 'known_error=true', complete: true }); if (ke.unavailable) return ke;
    const published = ke.rows.length ? await countsIn(ctx, { table: 'kb_knowledge', field: 'source', ids: ke.rows.map((r) => r.sys_id), extra: 'workflow_state=published' }) : { counts: new Map() };
    if (published.unavailable) return published;
    const withArticle = await countsBy(ctx, { table: 'm2m_kb_task', query: 'task.sys_class_name=incident', groupBy: ['task'] }); if (withArticle.unavailable) return withArticle;
    const share = (n, d) => (d ? round1((100 * n) / d) : null);
    const linked = byProblem.total;
    const recurring = byProblem.groups.filter((g) => g.count > 1).reduce((n, g) => n + g.count, 0);
    const observed = {
      incidents: inc.count,
      incident_recurrence_pct: share(recurring, linked),
      problem_creation_pct: share(linked, inc.count),
      known_error_publication_pct: share(ke.rows.filter((r) => published.counts.get(r.sys_id)).length, ke.rows.length),
      article_consumption_pct: share(withArticle.groups.length, inc.count),
    };
    return { offenders: [], absent: false, observed, expected: 'reported, not judged (no threshold is given)',
      population: pop(4, 0, 'loop ratios', 'a measure: recurrence, problem creation, known-error publication, article consumption') };
  },

  /** ITIL-115 — a measure: the contact type (channel) distribution of each table, never judged. */
  itil_channel_distribution: ({ tables }) => async (_rows, ctx) => {
    const observed = {};
    for (const t of tables) {
      const g = await countsBy(ctx, { table: t, groupBy: ['contact_type'] }); if (g.unavailable) return g;
      const total = g.total || 0;
      observed[t] = { records: total, channels: Object.fromEntries(g.groups.map((x) => [String(x.group.contact_type || '(empty)'), round1((100 * x.count) / (total || 1))])) };
    }
    return { offenders: [], absent: false, observed, expected: 'reported, not judged (no threshold is given)',
      population: pop(tables.length, 0, 'tables', 'a measure: contact_type shares per table') };
  },
});

/* ══ D-037 — fulfilment use of catalog variables; test coverage of customisation hotspots ══ */

/* Variable types that collect no input (label, break, macro, UI page, containers, rich-text label) and Requested for (read by the platform itself). */
const NON_INPUT = new Set(['11', '12', '14', '15', '17', '19', '20', '24', '31', '32']);
const wordIn = (text, w) => new RegExp(`(^|[^\\w])${String(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w]|$)`).test(text);
function decodeValues(raw) {
  if (isEmpty(raw)) return '';
  const s = String(raw).trim();
  if (s.startsWith('[') || s.startsWith('{')) return s;
  try { return gunzipSync(Buffer.from(s, 'base64')).toString('utf8'); } catch { return s; }
}
/** Rows of `table` for `ids`, read in batches that fit one page (step tables refuse paging). */
async function onePage(ctx, { table, fields, field, ids, per = 10, page = 1000 }) {
  const out = [];
  for (const c of chunks([...new Set(ids)].filter(Boolean), per)) {
    const r = await ctx.reads.read(declareRequirement({ table, fields, query: `${field}IN${c.join(',')}`, strategy: 'rows', pageSize: page, maxRows: page }));
    if (!usable(r.coverage)) return { unavailable: `${table} could not be read (${r.coverage?.status})` };
    if (r.rows.length >= page) return { unavailable: `${table}: more than one page for ${c.length} records, which the table does not allow` };
    out.push(...r.rows);
  }
  return { rows: out };
}

export const ITIL_TRACE_COMPARATORS = Object.freeze({
  /**
   * ITIL-011 — catalog variables their item's fulfilment never reads: not named (or pointed
   * to by sys_id) in the current version of the item's flow — action and logic step inputs —
   * or in its published workflow's activity settings.
   */
  itil_variables_unused: () => async (rows, ctx) => {
    const items = rows.filter((r) => !isEmpty(ref(r.flow_designer_flow)) || !isEmpty(ref(r.workflow)));
    if (!items.length) return { offenders: [], observed: { items: 0 }, expected: 0, absent: false, population: pop(0, 0, 'items fulfilled by a flow or workflow', 'none') };
    const ids = items.map((i) => i.sys_id);
    const own = await inChunks(ctx, { table: 'item_option_new', fields: ['name', 'type', 'cat_item'], field: 'cat_item', ids, extra: 'active=true' }); if (own.unavailable) return own;
    const sets = await inChunks(ctx, { table: 'io_set_item', fields: ['sc_cat_item', 'variable_set'], field: 'sc_cat_item', ids }); if (sets.unavailable) return sets;
    const setVars = sets.rows.length ? await inChunks(ctx, { table: 'item_option_new', fields: ['name', 'type', 'variable_set'], field: 'variable_set', ids: sets.rows.map((x) => String(ref(x.variable_set))), extra: 'active=true' }) : { rows: [] };
    if (setVars.unavailable) return setVars;
    const varsOf = (item) => [
      ...own.rows.filter((v) => String(ref(v.cat_item)) === item),
      ...setVars.rows.filter((v) => sets.rows.some((x) => String(ref(x.sc_cat_item)) === item && String(ref(x.variable_set)) === String(ref(v.variable_set)))),
    ].filter((v) => !NON_INPUT.has(String(v.type)) && !isEmpty(v.name));
    /* the flows' current versions */
    const flowIds = [...new Set(items.map((i) => String(ref(i.flow_designer_flow) ?? '')).filter(Boolean))];
    const flows = flowIds.length ? await inChunks(ctx, { table: 'sys_hub_flow', fields: ['master_snapshot'], field: 'sys_id', ids: flowIds }) : { rows: [] }; if (flows.unavailable) return flows;
    const snapOf = new Map(flows.rows.map((f) => [f.sys_id, String(ref(f.master_snapshot) ?? '')]));
    const snaps = [...new Set([...snapOf.values()].filter(Boolean))];
    const text = new Map();
    const addText = (key, t) => text.set(key, `${text.get(key) ?? ''}\n${t}`);
    for (const [table, field] of [['sys_hub_action_instance_v2', 'values'], ['sys_hub_flow_logic_instance_v2', 'values']]) {
      const r = snaps.length ? await onePage(ctx, { table, fields: ['flow', field], field: 'flow', ids: snaps }) : { rows: [] }; if (r.unavailable) return r;
      for (const x of r.rows) addText(`snap:${String(ref(x.flow))}`, decodeValues(x[field]));
    }
    /* the workflows' published versions and their activities' settings */
    const wfIds = [...new Set(items.map((i) => String(ref(i.workflow) ?? '')).filter(Boolean))];
    const versions = wfIds.length ? await inChunks(ctx, { table: 'wf_workflow_version', fields: ['workflow'], field: 'workflow', ids: wfIds, extra: 'published=true' }) : { rows: [] }; if (versions.unavailable) return versions;
    const acts = versions.rows.length ? await inChunks(ctx, { table: 'wf_activity', fields: ['workflow_version'], field: 'workflow_version', ids: versions.rows.map((v) => v.sys_id) }) : { rows: [] }; if (acts.unavailable) return acts;
    const vals = acts.rows.length ? await inChunks(ctx, { table: 'sys_variable_value', fields: ['document_key', 'value'], field: 'document_key', ids: acts.rows.map((a) => a.sys_id), extra: 'document=wf_activity' }) : { rows: [] }; if (vals.unavailable) return vals;
    const wfOfVersion = new Map(versions.rows.map((v) => [v.sys_id, String(ref(v.workflow))]));
    const wfOfAct = new Map(acts.rows.map((a) => [a.sys_id, wfOfVersion.get(String(ref(a.workflow_version)))]));
    for (const v of vals.rows) addText(`wf:${wfOfAct.get(String(ref(v.document_key)))}`, String(v.value ?? ''));
    /* A flow or workflow shared by several items is generic fulfilment: it cannot name one item's
       variables, and its fulfillers read them on the task form (the workbook's guard) — not judged. */
    const users = new Map();
    for (const i of items) for (const k of [`f:${String(ref(i.flow_designer_flow) ?? '')}`, `w:${String(ref(i.workflow) ?? '')}`]) if (!/:$/.test(k)) users.set(k, (users.get(k) || 0) + 1);
    const shared = (i) => (users.get(`f:${String(ref(i.flow_designer_flow) ?? '')}`) || 0) > 1 || (users.get(`w:${String(ref(i.workflow) ?? '')}`) || 0) > 1;
    const offenders = []; let judged = 0; let variables = 0; let generic = 0;
    for (const item of items) {
      if (shared(item)) { generic += 1; continue; }
      const vs = varsOf(item.sys_id); if (!vs.length) continue;
      const t = [text.get(`snap:${snapOf.get(String(ref(item.flow_designer_flow) ?? ''))}`) ?? '', text.get(`wf:${String(ref(item.workflow) ?? '')}`) ?? ''].join('\n');
      if (!t.trim()) continue;
      judged += 1; variables += vs.length;
      const unused = vs.filter((v) => !wordIn(t, v.name) && !t.includes(v.sys_id));
      if (unused.length) offenders.push(offender(item, 'variables', `${item.name}: ${unused.length} of ${vs.length} variables never read by its fulfilment (${unused.slice(0, 6).map((v) => v.name).join(', ')}${unused.length > 6 ? ', …' : ''})`));
    }
    return { offenders, observed: { items: items.length, generic_fulfilment: generic, judged, variables, items_with_unused: offenders.length }, expected: 0, absent: false,
      population: pop(items.length, judged, 'items fulfilled by a flow or workflow', 'items with their own flow or workflow (one shared by several items is generic and not judged); input variables named or referenced by sys_id in its current version or activity settings') };
  },

  /**
   * ITIL-072 — customisation hotspots (PLT-164's: more than `max` customer versions in the
   * window) with no active automated test: no ATF step on the object's table and no step
   * input naming the object, its sys_id, or the catalog item it belongs to.
   */
  itil_hotspots_untested: ({ max, window }) => async (_rows, ctx) => {
    const g = await countsBy(ctx, { table: 'sys_update_version', query: `source_table=sys_update_set^sys_created_on>=${ctx.run.window(window).start_snow}`, groupBy: ['name'] }); if (g.unavailable) return g;
    const hot = g.groups.filter((x) => x.count > max).map((x) => { const m = /^(.+)_([0-9a-f]{32})$/.exec(String(x.group.name)); return m ? { table: m[1], id: m[2], versions: x.count } : null; }).filter(Boolean);
    if (!hot.length) return { offenders: [], observed: { hotspots: 0 }, expected: 0, absent: false, population: { total: 0, judged: 0, unit: 'customisation hotspots', basis: `objects with more than ${max} customer versions`, determinate_when_empty: 'no hotspot' } };
    const TABLE_FIELD = { sys_script: 'collection', sys_script_client: 'table', sys_ui_policy: 'table', sys_ui_action: 'table', sys_data_policy2: 'model_table', sys_dictionary: 'name', catalog_script_client: 'cat_item', catalog_ui_policy: 'catalog_item' };
    const detail = new Map();
    for (const t of [...new Set(hot.map((h) => h.table))]) {
      const f = TABLE_FIELD[t];
      const r = await inChunks(ctx, { table: t, fields: ['sys_name', ...(f ? [f] : [])], field: 'sys_id', ids: hot.filter((h) => h.table === t).map((h) => h.id) });
      if (r.unavailable) continue;
      for (const x of r.rows) detail.set(x.sys_id, { name: x.sys_name, link: f ? String(ref(x[f]) ?? '') : '' });
    }
    const tests = await countsBy(ctx, { table: 'sys_atf_step', query: 'test.active=true^active=true', groupBy: ['table'] }); if (tests.unavailable) return tests;
    const testedTables = new Set(tests.groups.map((x) => String(x.group.table || '')).filter(Boolean));
    const needles = [...new Set(hot.flatMap((h) => [h.id, detail.get(h.id)?.link].filter((x) => /^[0-9a-f]{32}$/.test(String(x)))))];
    const mentioned = new Set();
    for (const c of chunks(needles, 15)) {
      const r = await countsBy(ctx, { table: 'sys_variable_value', query: `document=sys_atf_step^${c.map((n) => `valueLIKE${n}`).join('^OR')}`, groupBy: ['value'] }); if (r.unavailable) return r;
      for (const x of r.groups) for (const n of c) if (String(x.group.value).includes(n)) mentioned.add(n);
    }
    const offenders = [];
    for (const h of hot) {
      const d = detail.get(h.id);
      const covered = mentioned.has(h.id) || (d?.link && (testedTables.has(d.link) || mentioned.has(d.link)));
      if (!covered) offenders.push({ sys_id: h.id, field: 'test', value: `${d?.name || `${h.table}_${h.id}`} (${h.table}): ${h.versions} customer versions, no active automated test on it${d?.link && !/^[0-9a-f]{32}$/.test(d.link) ? ` or on ${d.link}` : ''}` });
    }
    return { offenders, observed: { hotspots: hot.length, untested: offenders.length, tables_with_tests: testedTables.size }, expected: 0, absent: false,
      population: pop(hot.length, hot.length, 'customisation hotspots', `objects with more than ${max} customer versions in the window (PLT-164's definition), against active ATF steps and their inputs`) };
  },
});
