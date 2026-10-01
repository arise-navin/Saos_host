import { declareRequirement } from '../itsm/data-access.js';
import { fromSnowTime } from '../itsm/run-context.js';
import { personalFields, ancestors } from '../csdm/comparators.js';

/**
 * HEALTH ASSIST PHASE 7 — the Enterprise Data Quality comparators.
 *
 * Named callbacks for the configuration engine, in the contract every pack keeps
 * (itsm/comparators.js): `{ offenders, observed, expected, absent, population }`, or
 * `{ unavailable }` when a read the judgement needs failed. Merged into the shared
 * library; a name is defined once.
 *
 * They judge master and reference data (users, groups, locations, models, assets,
 * catalog items). Each declares the population it judged, and where the workbook
 * makes the rule apply only to an estate that uses a practice ("estates that do
 * not use group typing", "fires only on multi-company instances") an estate that
 * does not is a determinate empty population, never a finding.
 */

const COMPLETE = 'complete';
const usable = (cov) => ['complete', 'limited', 'truncated'].includes(cov?.status);
const isEmpty = (v) => v === undefined || v === null || String(v).trim() === '';
const truthy = (v) => ['true', '1', 'yes'].includes(String(v).toLowerCase());
const ref = (v) => (v && typeof v === 'object' ? v.value ?? v.sys_id ?? null : v);
const list = (v) => String(ref(v) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const chunks = (xs, n = 100) => { const out = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };
/** Case, spacing and punctuation set aside — the only normalisation the rules apply. */
export const normalise = (v) => String(v ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
/** A permissive address check (the workbook's guard): one @, a non-empty local part, a dotted domain, no spaces. */
export const emailValid = (v) => /^[^\s@]+@[^\s@]+\.[^\s@.]+$/.test(String(v ?? '').trim());

/* `complete`: where an ABSENT row would be read as a defect (a missing target, a link not returned), only a complete read may be used. */
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
/** The rows of `table` with these sys_ids, read in batches and completely (an absent id is a claim): Map(sys_id → row). */
async function byIds(ctx, table, ids, fields) {
  const out = new Map();
  for (const c of chunks([...new Set(ids)])) {
    const r = await rowsOf(ctx, { table, fields, query: `sys_idIN${c.join(',')}`, complete: true });
    if (r.unavailable) return r;
    for (const x of r.rows) out.set(x.sys_id, x);
  }
  return { rows: out };
}
/** Active-member counts of these groups: Map(group → n). */
async function activeMembers(ctx, groups) {
  const out = new Map(groups.map((g) => [g, 0]));
  for (const c of chunks([...new Set(groups)])) {
    const g = await countsBy(ctx, { table: 'sys_user_grmember', query: `groupIN${c.join(',')}^user.active=true`, groupBy: ['group'] });
    if (g.unavailable) return g;
    for (const x of g.groups) out.set(String(ref(x.group.group)), x.count);
  }
  return { counts: out };
}

/**
 * The records on a reference cycle: following `field` from a record comes back to
 * it. Each record is visited once (iterative walk with colours), so no depth bound
 * is needed. Returns the cycles, each a list of sys_ids in order.
 */
export function referenceCycles(rows, field, { selfLoops = true } = {}) {
  const next = new Map(rows.map((r) => [r.sys_id, ref(r[field]) || null]));
  const state = new Map();   // 1 = on the current path, 2 = done
  const cycles = [];
  for (const start of next.keys()) {
    if (state.has(start)) continue;
    const path = [];
    let n = start;
    while (n && next.has(n) && !state.has(n)) { state.set(n, 1); path.push(n); n = next.get(n); }
    if (n && state.get(n) === 1) {
      const cycle = path.slice(path.indexOf(n));
      if (cycle.length > 1 || selfLoops) cycles.push(cycle);
    }
    for (const p of path) state.set(p, 2);
  }
  return cycles;
}

export const DQ_COMPARATORS = Object.freeze({
  /** DQ-090 — records with `field` empty, where the estate uses the field at all. `rows` are the records in scope. */
  dq_empty_where_used: ({ field, label = 'name', unit, practice }) => async (rows) => {
    const used = rows.some((r) => !isEmpty(ref(r[field])));
    if (!used) {
      return { offenders: [], observed: { records: rows.length, populated: 0 }, expected: 0, absent: false,
        population: { total: 0, judged: 0, unit, basis: `the estate does not use ${practice} (no ${unit.replace(/^active /, '')} carries a ${field})`, determinate_when_empty: `the estate does not use ${practice}` } };
    }
    const offenders = rows.filter((r) => isEmpty(ref(r[field]))).map((r) => ({ sys_id: r.sys_id, field, value: `${r[label] ?? r.sys_id}: no ${field}` }));
    return { offenders, observed: { records: rows.length, populated: rows.length - offenders.length, empty: offenders.length }, expected: 0, absent: false,
      population: { total: rows.length, judged: rows.length, unit, basis: `${unit}, where ${practice} is in use` } };
  },

  /** DQ-103 / DQ-104 — records whose `field` chain loops back to them. `rows` are the records with the reference set. */
  dq_reference_cycles: ({ field, label = 'name', unit, selfLoops = true }) => async (rows) => {
    const names = new Map(rows.map((r) => [r.sys_id, r[label] ?? r.sys_id]));
    const cycles = referenceCycles(rows, field, { selfLoops });
    const offenders = cycles.flatMap((c) => c.map((id) => ({ sys_id: id, field, value: `loop of ${c.length}: ${c.map((x) => names.get(x)).join(' → ')} → ${names.get(c[0])}` })));
    return { offenders, observed: { records: rows.length, loops: cycles.length, on_a_loop: offenders.length }, expected: 0, absent: false,
      population: { total: rows.length, judged: rows.length, unit, basis: `every ${field} chain followed to its end` } };
  },

  /** DQ-105 — users whose department belongs to another company. `rows` are active users with both set. */
  dq_department_company: () => async (rows, ctx) => {
    const companies = new Set(rows.map((u) => ref(u.company)).filter(Boolean));
    if (companies.size <= 1) {
      return { offenders: [], observed: { users: rows.length, companies: companies.size }, expected: 0, absent: false,
        population: { total: 0, judged: 0, unit: 'users', basis: `a single-company instance (${companies.size} company across active users)`, determinate_when_empty: 'the instance is not multi-company' } };
    }
    const depts = await byIds(ctx, 'cmn_department', rows.map((u) => ref(u.department)), ['name', 'company']);
    if (depts.unavailable) return depts;
    const judged = rows.filter((u) => !isEmpty(ref(depts.rows.get(ref(u.department))?.company)));
    const offenders = judged.filter((u) => ref(depts.rows.get(ref(u.department)).company) !== ref(u.company))
      .map((u) => ({ sys_id: u.sys_id, field: 'department', value: `${u.user_name}: department ${depts.rows.get(ref(u.department)).name ?? ref(u.department)} belongs to another company` }));
    return { offenders, observed: { users: rows.length, companies: companies.size, judged: judged.length, mismatched: offenders.length }, expected: 0, absent: false,
      population: { total: rows.length, judged: judged.length, unit: 'active users with a company and a department', basis: 'the user\'s company against their department\'s company' } };
  },

  /** DQ-107 — assets assigned to one user whose linked CI is assigned to another. `rows` are assets with a CI and an assignee. */
  dq_asset_ci_assignee: () => async (rows, ctx) => {
    const cis = await byIds(ctx, 'cmdb_ci', rows.map((a) => ref(a.ci)), ['assigned_to']);
    if (cis.unavailable) return cis;
    const judged = rows.filter((a) => !isEmpty(ref(cis.rows.get(ref(a.ci))?.assigned_to)));
    const offenders = judged.filter((a) => ref(cis.rows.get(ref(a.ci)).assigned_to) !== ref(a.assigned_to))
      .map((a) => ({ sys_id: a.sys_id, field: 'assigned_to', value: `${a.display_name ?? a.sys_id}: the asset and its CI are assigned to different users` }));
    return { offenders, observed: { assets: rows.length, judged: judged.length, differing: offenders.length }, expected: 0, absent: false,
      population: { total: rows.length, judged: judged.length, unit: 'assets linked to a CI, both assigned', basis: 'asset assigned_to against its CI\'s assigned_to, both populated' } };
  },

  /** DQ-111 — users sharing an email or an employee number. Active-active groups are charged; active-inactive are observed. */
  dq_duplicate_users: () => async (rows) => {
    const groups = new Map();
    const add = (kind, v, u) => { const k = kind === 'email' ? String(v).trim().toLowerCase() : String(v).trim(); if (!k) return; const key = `${kind}:${k}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(u); };
    for (const u of rows) { if (!isEmpty(u.email)) add('email', u.email, u); if (!isEmpty(u.employee_number)) add('employee number', u.employee_number, u); }
    const charged = new Map();
    let supersession = 0;
    for (const [key, us] of groups) {
      if (us.length < 2) continue;
      const active = us.filter((u) => truthy(u.active));
      if (active.length >= 2) for (const u of active) charged.set(u.sys_id, `${u.user_name}: shares ${key.replace(':', ' ')} with ${active.length - 1} other active user(s)`);
      else if (active.length === 1) supersession += 1;
    }
    const offenders = [...charged].map(([sys_id, value]) => ({ sys_id, field: 'email', value }));
    return { offenders, observed: { users: rows.length, active_duplicates: offenders.length, active_inactive_groups: supersession }, expected: 0, absent: false,
      population: { total: rows.length, judged: rows.length, unit: 'users', basis: 'users grouped by lower-cased email and by employee number (an empty value groups nothing)' } };
  },

  /** DQ-112 — pairs of groups whose active memberships overlap by `overlap`% or more (Jaccard), each with ≥ `min_members`. `rows` are active memberships. A rate. */
  dq_duplicate_groups: ({ overlap, min_members }) => async (rows) => {
    const members = new Map();
    for (const r of rows) { const g = ref(r.group); const u = ref(r.user); if (!g || !u) continue; if (!members.has(g)) members.set(g, new Set()); members.get(g).add(u); }
    const judged = [...members].filter(([, s]) => s.size >= min_members);
    const inPair = new Map();
    for (let i = 0; i < judged.length; i += 1) {
      const [ga, a] = judged[i];
      for (let j = i + 1; j < judged.length; j += 1) {
        const [gb, b] = judged[j];
        const small = a.size <= b.size ? a : b; const large = small === a ? b : a;
        if ((100 * small.size) / large.size < overlap) continue;   // Jaccard ≤ |small| / |large|
        let shared = 0; for (const u of small) if (large.has(u)) shared += 1;
        const jaccard = (100 * shared) / (a.size + b.size - shared);
        if (jaccard < overlap) continue;
        for (const [g, o] of [[ga, gb], [gb, ga]]) if (!inPair.has(g)) inPair.set(g, `${Math.round(jaccard)}% of active members shared with group ${o}`);
      }
    }
    const offenders = [...inPair].map(([sys_id, value]) => ({ sys_id, field: 'members', value }));
    return { offenders, observed: { groups_judged: judged.length, in_a_duplicate_pair: offenders.length }, expected: `< ${overlap}% overlap`, absent: false,
      kpi: { numerator: judged.length - offenders.length, denominator: judged.length, basis: `groups with ≥ ${min_members} active members, not in a pair overlapping ≥ ${overlap}%` },
      population: { total: members.size, judged: judged.length, unit: 'active groups with active members', basis: `groups with at least ${min_members} active members, compared pairwise` } };
  },

  /** DQ-113 … DQ-116 — records sharing the normalised value of `fields`; every `require`d field must be present. */
  dq_duplicate_by: ({ fields, require = fields, label = 'name', unit }) => async (rows) => {
    const judged = rows.filter((r) => require.every((f) => !isEmpty(ref(r[f]))));
    const groups = new Map();
    for (const r of judged) { const k = fields.map((f) => normalise(ref(r[f]))).join('|'); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    const offenders = [...groups.values()].filter((g) => g.length > 1).flatMap((g) => g.map((r) => ({ sys_id: r.sys_id, field: fields[0], value: `${r[label] ?? r.sys_id}: ${g.length} records match on ${fields.join(' + ')}` })));
    return { offenders, observed: { records: rows.length, judged: judged.length, duplicate_sets: [...groups.values()].filter((g) => g.length > 1).length, in_a_duplicate_set: offenders.length }, expected: 0, absent: false,
      population: { total: rows.length, judged: judged.length, unit, basis: `${fields.join(' + ')}, compared after case, spacing and punctuation are normalised` } };
  },

  /** DQ-097 — invalid emails on users and groups named by active notifications. `rows` are the notifications. */
  dq_notification_email_format: () => async (rows, ctx) => {
    const userIds = [...new Set(rows.flatMap((n) => list(n.recipient_users)))];
    const groupIds = [...new Set(rows.flatMap((n) => list(n.recipient_groups)))];
    const users = await byIds(ctx, 'sys_user', userIds, ['user_name', 'email', 'active']);
    if (users.unavailable) return users;
    const groups = await byIds(ctx, 'sys_user_group', groupIds, ['name', 'email', 'active']);
    if (groups.unavailable) return groups;
    const judged = [...[...users.rows.values()].filter((u) => truthy(u.active) && !isEmpty(u.email)).map((u) => ({ r: u, name: u.user_name })),
      ...[...groups.rows.values()].filter((g) => truthy(g.active) && !isEmpty(g.email)).map((g) => ({ r: g, name: g.name }))];
    const offenders = judged.filter(({ r }) => !emailValid(r.email)).map(({ r, name }) => ({ sys_id: r.sys_id, field: 'email', value: `${name}: "${String(r.email).trim()}" is not an email address` }));
    return { offenders, observed: { notifications: rows.length, recipients: userIds.length + groupIds.length, with_email: judged.length, invalid: offenders.length }, expected: 0, absent: false,
      population: { total: userIds.length + groupIds.length, judged: judged.length, unit: 'notification recipients with an email', basis: 'active users and groups named on active notifications' } };
  },

  /** DQ-120 — active groups whose membership has not changed for `max_age`: newest membership and the group itself older. `rows` are active groups. */
  dq_stale_membership: ({ max_age }) => async (rows, ctx) => {
    const cutoff = ctx.run.window(max_age).start;
    const old = rows.filter((g) => (fromSnowTime(g.sys_created_on) ?? cutoff) < cutoff);
    const newest = new Map();
    const members = new Map();
    for (const c of chunks(old.map((g) => g.sys_id))) {
      const r = await rowsOf(ctx, { table: 'sys_user_grmember', fields: ['group', 'sys_created_on'], query: `groupIN${c.join(',')}^user.active=true` });
      if (r.unavailable) return r;
      for (const m of r.rows) {
        const g = String(ref(m.group)); const t = fromSnowTime(m.sys_created_on);
        members.set(g, (members.get(g) || 0) + 1);
        if (t && (!newest.has(g) || t > newest.get(g))) newest.set(g, t);
      }
    }
    const judged = old.filter((g) => members.get(g.sys_id) > 0 && newest.has(g.sys_id));
    const offenders = judged.filter((g) => newest.get(g.sys_id) < cutoff).map((g) => ({ sys_id: g.sys_id, field: 'members', value: `${g.name}: no member added since ${newest.get(g.sys_id).toISOString().slice(0, 10)}` }));
    return { offenders, observed: { active_groups: rows.length, older_than_threshold: old.length, judged: judged.length, unchanged: offenders.length }, expected: 0, absent: false,
      population: { total: rows.length, judged: judged.length, unit: 'active groups with active members', basis: `groups older than ${max_age}, by their newest active membership` } };
  },

  /** DQ-123 — active requestable items older than `min_age` never ordered. `rows` are the items. */
  dq_never_ordered: ({ min_age }) => async (rows, ctx) => {
    const cutoff = ctx.run.window(min_age).start;
    const old = rows.filter((r) => (fromSnowTime(r.sys_created_on) ?? cutoff) < cutoff);
    const g = await countsBy(ctx, { table: 'sc_req_item', query: 'cat_itemISNOTEMPTY', groupBy: ['cat_item'] });
    if (g.unavailable) return g;
    const ordered = new Set(g.groups.filter((x) => x.count > 0).map((x) => String(ref(x.group.cat_item))));
    const offenders = old.filter((r) => !ordered.has(r.sys_id)).map((r) => ({ sys_id: r.sys_id, field: 'orders', value: `${r.name}: never ordered` }));
    return { offenders, observed: { items: rows.length, older_than_threshold: old.length, never_ordered: offenders.length }, expected: 0, absent: false, coverage: g.coverage,
      population: { total: rows.length, judged: old.length, unit: 'active requestable items', basis: `items older than ${min_age}, against their requested items` } };
  },

  /** DQ-124 — locations no CI and no user references, that are no other location's parent. `rows` are the locations. */
  dq_unreferenced_locations: () => async (rows, ctx) => {
    const used = new Set();
    for (const [table, field] of [['cmdb_ci', 'location'], ['sys_user', 'location'], ['cmn_location', 'parent']]) {
      const g = await countsBy(ctx, { table, query: `${field}ISNOTEMPTY`, groupBy: [field] });
      if (g.unavailable) return g;
      for (const x of g.groups) if (x.count > 0) used.add(String(ref(x.group[field])));
    }
    const offenders = rows.filter((r) => !used.has(r.sys_id)).map((r) => ({ sys_id: r.sys_id, field: 'location', value: `${r.name}: no CI, no user, no child location` }));
    return { offenders, observed: { locations: rows.length, unreferenced: offenders.length }, expected: 0, absent: false,
      population: { total: rows.length, judged: rows.length, unit: 'locations', basis: 'every location, against the CIs and users located there and the locations under it' } };
  },

  /** DQ-127 — active catalog items whose workflow or variable set no longer exists. `rows` are the items. */
  dq_catalog_references: () => async (rows, ctx) => {
    const wfIds = rows.map((r) => ref(r.workflow)).filter(Boolean);
    const wfs = await byIds(ctx, 'wf_workflow', wfIds, ['name']);
    if (wfs.unavailable) return wfs;
    const links = [];
    for (const c of chunks(rows.map((r) => r.sys_id))) {
      const r = await rowsOf(ctx, { table: 'io_set_item', fields: ['sc_cat_item', 'variable_set'], query: `sc_cat_itemIN${c.join(',')}^variable_setISNOTEMPTY` });
      if (r.unavailable) return r;
      links.push(...r.rows);
    }
    const sets = await byIds(ctx, 'item_option_new_set', links.map((l) => ref(l.variable_set)), ['name']);
    if (sets.unavailable) return sets;
    const bad = new Map();
    for (const r of rows) if (ref(r.workflow) && !wfs.rows.has(ref(r.workflow))) bad.set(r.sys_id, `${r.name}: its workflow no longer exists`);
    const names = new Map(rows.map((r) => [r.sys_id, r.name]));
    for (const l of links) {
      const item = String(ref(l.sc_cat_item));
      if (!sets.rows.has(ref(l.variable_set))) bad.set(item, `${bad.has(item) ? `${bad.get(item)}; ` : `${names.get(item)}: `}a variable set no longer exists`);
    }
    const offenders = [...bad].map(([sys_id, value]) => ({ sys_id, field: 'references', value }));
    return { offenders, observed: { items: rows.length, with_workflow: wfIds.length, variable_set_links: links.length, broken: offenders.length }, expected: 0, absent: false,
      population: { total: rows.length, judged: rows.length, unit: 'active catalog items', basis: 'each item\'s workflow and variable-set references, against their targets' } };
  },

  /** DQ-129 — asset → CI links not returned by the CI, and CI → asset links not returned by the asset. `rows` are assets with a CI. */
  dq_asset_ci_links: () => async (_rows, ctx) => {
    /* Both sides complete: a link missing from a partial read would be charged as one-directional. */
    const assets = await rowsOf(ctx, { table: 'alm_asset', fields: ['display_name', 'ci'], query: 'ciISNOTEMPTY', complete: true });
    if (assets.unavailable) return assets;
    const rows = assets.rows;
    const ci = await rowsOf(ctx, { table: 'cmdb_ci', fields: ['asset'], query: 'assetISNOTEMPTY', complete: true });
    if (ci.unavailable) return ci;
    const assetOf = new Map(ci.rows.map((c) => [c.sys_id, String(ref(c.asset))]));
    const ciOf = new Map(rows.map((a) => [a.sys_id, String(ref(a.ci))]));
    const offenders = [];
    for (const a of rows) if (assetOf.get(ciOf.get(a.sys_id)) !== a.sys_id) offenders.push({ sys_id: a.sys_id, field: 'ci', value: `asset ${a.display_name ?? a.sys_id} → CI ${ciOf.get(a.sys_id)}: the CI does not point back` });
    const backward = ci.rows.filter((c) => ciOf.get(assetOf.get(c.sys_id)) !== c.sys_id);
    for (const c of backward) offenders.push({ sys_id: c.sys_id, field: 'asset', value: `CI ${c.sys_id} → asset ${assetOf.get(c.sys_id)}: the asset does not point back` });
    return { offenders, observed: { asset_to_ci: rows.length, ci_to_asset: ci.rows.length, asset_side_only: offenders.length - backward.length, ci_side_only: backward.length }, expected: 0, absent: false, coverage: ci.coverage,
      population: { total: rows.length + ci.rows.length, judged: rows.length + ci.rows.length, unit: 'asset–CI links', basis: 'alm_asset.ci and cmdb_ci.asset, each checked for its return link' } };
  },

  /**
   * DQ-130 — active notifications whose NAMED recipients resolve to nobody: every
   * user named is inactive or gone and every group named has no active member,
   * with nothing that resolves per record (recipient fields, event parameters,
   * subscriptions). A notification naming no one is not judged: a mail script in
   * its message can add recipients (measured, Phase 7: 51 of 73 such notifications
   * on the validation instance name no one). `rows` are the notifications.
   */
  dq_notification_no_recipients: () => async (rows, ctx) => {
    const perRecord = (n) => !isEmpty(n.recipient_fields) || truthy(n.event_parm_1) || truthy(n.event_parm_2) || truthy(n.subscribable);
    const fixed = rows.filter((n) => !perRecord(n));
    const judged = fixed.filter((n) => list(n.recipient_users).length || list(n.recipient_groups).length);
    const users = await byIds(ctx, 'sys_user', judged.flatMap((n) => list(n.recipient_users)), ['active']);
    if (users.unavailable) return users;
    const groups = await activeMembers(ctx, judged.flatMap((n) => list(n.recipient_groups)));
    if (groups.unavailable) return groups;
    const offenders = judged.filter((n) => !list(n.recipient_users).some((u) => truthy(users.rows.get(u)?.active)) && !list(n.recipient_groups).some((g) => groups.counts.get(g) > 0))
      .map((n) => ({ sys_id: n.sys_id, field: 'recipients', value: `${n.collection ?? ''} notification: every named recipient is inactive or has no active member` }));
    return { offenders, observed: { notifications: rows.length, resolved_per_record: rows.length - fixed.length, naming_no_one: fixed.length - judged.length, judged: judged.length, resolve_to_nobody: offenders.length }, expected: 0, absent: false,
      population: { total: rows.length, judged: judged.length, unit: 'active notifications', basis: 'notifications that name their recipients (users, groups) and nothing resolved per record, resolved now' } };
  },

  /**
   * DQ-134 (D-032) — personal-data fields (the instance's own field classification,
   * m2m_dictionary_dataclass, restricted to `classes`) that no restrictive READ ACL protects —
   * neither on the field nor on its table (ancestors included, as the platform evaluates
   * them). An ACL is permissive when it requires no role, has no condition and no advanced
   * script. `rows` are unused.
   */
  dq_personal_field_acl: ({ classes }) => async (_rows, ctx) => {
    const pf = await personalFields(ctx, classes); if (pf.unavailable) return pf;
    if (!pf.fields.length) return { offenders: [], observed: { personal_fields: 0 }, expected: 0, absent: false, population: { total: 0, judged: 0, unit: 'personal-data fields', basis: 'no field is classified as personal data', determinate_when_empty: 'no field is classified as personal data' } };
    const ch = await ancestors(ctx, pf.fields.map((f) => f.table)); if (ch.unavailable) return ch;
    const names = [...new Set(pf.fields.flatMap((f) => (ch.chains.get(f.table) || [f.table]).flatMap((t) => [t, `${t}.*`, `${t}.${f.element}`])))];
    const acls = [];
    for (const c of chunks(names)) {
      const r = await rowsOf(ctx, { table: 'sys_security_acl', fields: ['name', 'condition', 'script', 'advanced'], query: `active=true^operation.name=read^nameIN${c.join(',')}`, complete: true });
      if (r.unavailable) return r;
      acls.push(...r.rows);
    }
    const withRole = new Set();
    for (const c of chunks(acls.map((a) => a.sys_id))) {
      const g = await countsBy(ctx, { table: 'sys_security_acl_role', query: `sys_security_aclIN${c.join(',')}`, groupBy: ['sys_security_acl'] });
      if (g.unavailable) return g;
      for (const x of g.groups) if (x.count > 0) withRole.add(String(ref(x.group.sys_security_acl)));
    }
    const restrictive = new Set(acls.filter((a) => withRole.has(a.sys_id) || !isEmpty(a.condition) || (truthy(a.advanced) && !isEmpty(a.script))).map((a) => a.name));
    const offenders = pf.fields.filter((f) => !(ch.chains.get(f.table) || [f.table]).some((t) => restrictive.has(`${t}.${f.element}`) || restrictive.has(t) || restrictive.has(`${t}.*`)))
      .map((f) => ({ sys_id: f.sys_id, field: 'acl', value: `${f.table}.${f.element}: no restrictive read ACL on the field or its table` }));
    return { offenders, observed: { personal_fields: pf.fields.length, tables: new Set(pf.fields.map((f) => f.table)).size, read_acls: acls.length, unprotected: offenders.length }, expected: 0, absent: false,
      population: { total: pf.fields.length, judged: pf.fields.length, unit: 'personal-data fields', basis: 'fields classified as personal data, against the read ACLs on the field and its table (ancestors included)' } };
  },
});
