import { declareRequirement } from '../itsm/data-access.js';
import { fromSnowTime, shiftDate } from '../itsm/run-context.js';
import { durationMs, scheduleInterval } from './comparators.js';
import { traverseServices, criticalWithoutImpact } from '../csdm/research-comparators.js';

/**
 * D-033 — the ITOM comparators the documentation research made buildable
 * (docs/HEALTH-ASSIST-RULE-RESEARCH.md). Same contract as every comparator.
 *
 * Stored conditions — an alert rule's alert_filter, an event rule's filter, a
 * notification's condition — are encoded queries, so the instance evaluates them:
 * "which alerts does this rule match" is one read with the filter as its query.
 * Staleness is ServiceNow's own CMDB Health staleness rules (cmdb_health_staleness_rule).
 */

const COMPLETE = 'complete';
const usable = (cov) => ['complete', 'limited', 'truncated'].includes(cov?.status);
const isEmpty = (v) => v === undefined || v === null || String(v).trim() === '';
const ref = (v) => (v && typeof v === 'object' ? v.value ?? v.sys_id ?? null : v);
const chunks = (xs, n = 100) => { const out = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };
const round1 = (n) => Number(n.toFixed(1));
const clean = (q) => String(q || '').replace(/\^EQ$/, '');
const and = (...qs) => qs.map(clean).filter(Boolean).join('^');

async function rowsOf(ctx, { table, fields, query = '', complete = false }) {
  const r = await ctx.reads.read(declareRequirement({ table, fields, query, strategy: 'rows' }));
  if (!(complete ? r.coverage?.status === COMPLETE : usable(r.coverage))) return { unavailable: `${table} could not be read${complete ? ' completely' : ''} (${r.coverage?.status}${r.coverage?.error ? `: ${r.coverage.error}` : ''}) — no claim is made from a partial read`, coverage: r.coverage };
  return { rows: r.rows, coverage: r.coverage };
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
/** Ids of `table` rows matching each condition, united — the instance evaluates every condition. */
async function matchedBy(ctx, { table, scope, conditions }) {
  const ids = new Set();
  for (const cond of conditions) {
    if (isEmpty(clean(cond))) return { all: true, ids };
    const r = await rowsOf(ctx, { table, fields: ['number'], query: and(scope, cond), complete: true });
    if (r.unavailable) return r;
    for (const x of r.rows) ids.add(x.sys_id);
  }
  return { all: false, ids };
}
/** A class and every ancestor, from sys_db_object (walked up; cached per run). */
async function ancestors(ctx, cls) {
  const key = `itom:ancestors:${cls}`;
  const build = async () => {
    const out = new Set(); let cur = cls;
    for (let depth = 0; cur && depth < 15 && !out.has(cur); depth += 1) {
      out.add(cur);
      const r = await rowsOf(ctx, { table: 'sys_db_object', fields: ['name', 'super_class.name'], query: `name=${cur}`, complete: true });
      if (r.unavailable) return r;
      cur = r.rows[0]?.['super_class.name'] || null;
    }
    return { classes: out };
  };
  return ctx.shared?.getOrBuild ? ctx.shared.getOrBuild(key, build) : build();
}
const pop = (total, judged, unit, basis) => ({ total, judged, unit, basis });
const offender = (r, field, value) => ({ sys_id: r.sys_id, field, value });

export const ITOM_RESEARCH_COMPARATORS = Object.freeze({
  /**
   * ITOM-007 — a schedule's run interval longer than the tightest CMDB Health
   * staleness duration among the classes present on the instance.
   */
  itom_interval_beyond_staleness: ({ intervals }) => async (rows, ctx) => {
    const rules = await rowsOf(ctx, { table: 'cmdb_health_staleness_rule', fields: ['applies_to', 'duration'], complete: true });
    if (rules.unavailable) return rules;
    const present = [];
    for (const r of rules.rows) {
      const ms = durationMs(r.duration); const cls = String(ref(r.applies_to) ?? '');
      if (!ms || !cls) continue;
      const n = await countOf(ctx, { table: 'cmdb_ci', query: `sys_class_name=${cls}` });
      if (n.unavailable) return n;
      if (n.count > 0) present.push({ cls, ms });
    }
    if (!present.length) return { offenders: [], observed: { staleness_rules: rules.rows.length, classes_present: 0 }, expected: 'interval ≤ the tightest staleness duration', absent: false, population: pop(rows.length, 0, 'schedules', 'no staleness rule applies to a class with CIs') };
    const tightest = present.reduce((a, b) => (b.ms < a.ms ? b : a));
    const now = new Date(ctx.run.run_started_at);
    const offenders = []; let judged = 0;
    for (const s of rows) {
      const w = scheduleInterval(s, intervals); if (!w) continue;
      judged += 1;
      const ms = shiftDate(now, w, +1).getTime() - now.getTime();
      if (ms > tightest.ms) offenders.push(offender(s, 'run_type', `${s.name}: runs every ${round1(ms / 86400000)} days; ${tightest.cls} goes stale after ${round1(tightest.ms / 86400000)} days`));
    }
    return { offenders, observed: { schedules: rows.length, periodic: judged, tightest_class: tightest.cls, tightest_days: round1(tightest.ms / 86400000) }, expected: 0, absent: false,
      population: pop(rows.length, judged, 'schedules', 'active recurring schedules against the tightest CMDB Health staleness duration among the classes with CIs') };
  },

  /** ITOM-112 — active alert management rules that have fired but have no configured action. */
  itom_alert_rules_without_action: () => async (rows, ctx) => {
    const live = rows.filter((r) => String(r.active) !== 'false');
    const acts = await countsBy(ctx, { table: 'em_alert_management_action', query: 'active=true', groupBy: ['management_rule'] });
    if (acts.unavailable) return acts;
    const fired = await countsBy(ctx, { table: 'em_alert_management_execution', groupBy: ['management_rule'] });
    if (fired.unavailable) return fired;
    const hasAction = new Set(acts.groups.map((g) => String(g.group.management_rule)));
    const fires = new Map(fired.groups.map((g) => [String(g.group.management_rule), g.count]));
    const judged = live.filter((r) => (fires.get(r.sys_id) || 0) > 0);
    const offenders = judged.filter((r) => !hasAction.has(r.sys_id)).map((r) => offender(r, 'management_rule', `${r.name}: fired ${fires.get(r.sys_id)} times, no active action`));
    return { offenders, observed: { active_rules: live.length, fired: judged.length, without_action: offenders.length }, expected: 0, absent: false,
      population: pop(live.length, judged.length, 'active alert management rules that fired', 'executions (em_alert_management_execution) and actions (em_alert_management_action) per rule') };
  },

  /**
   * ITOM-113 — deduplication: alerts ÷ the events they absorbed (em_alert.event_count),
   * over the alerts retained. A ratio above `ratio` means alerts track events one to one.
   */
  itom_alert_event_ratio: ({ ratio }) => async (rows) => {
    const alerts = rows.filter((a) => Number(a.event_count) > 0);
    const events = alerts.reduce((n, a) => n + Number(a.event_count), 0);
    if (!alerts.length) return { offenders: [], observed: { alerts: 0 }, expected: `≤ ${ratio}`, absent: false, population: pop(0, 0, 'alerts', 'alerts with an event count') };
    const r = round1((100 * alerts.length) / events) / 100;
    return { offenders: [], absent: r > ratio, observed: { alerts: alerts.length, events_absorbed: events, alerts_per_event: r }, expected: `≤ ${ratio} alerts per event`,
      population: pop(alerts.length, alerts.length, 'alerts', 'em_alert.event_count: the events deduplicated into each alert') };
  },

  /**
   * ITOM-111 — alerts no active alert management rule's filter matches;
   * ITOM-116 (`severity`, `rule_type`) — Critical alerts no incident-type rule matches.
   */
  itom_alerts_unmatched: ({ scope = '', rule_type = null }) => async (rows, ctx) => {
    const rules = rows.filter((r) => String(r.active) !== 'false' && (!rule_type || r.type === rule_type));
    const alerts = await rowsOf(ctx, { table: 'em_alert', fields: ['number', 'severity'], query: scope, complete: true });
    if (alerts.unavailable) return alerts;
    if (!alerts.rows.length) return { offenders: [], observed: { alerts: 0, rules: rules.length }, expected: 0, absent: false, population: pop(0, 0, 'alerts', `em_alert where ${scope || 'any'}`) };
    const m = await matchedBy(ctx, { table: 'em_alert', scope, conditions: rules.map((r) => r.alert_filter) });
    if (m.unavailable) return m;
    const unmatched = m.all ? [] : alerts.rows.filter((a) => !m.ids.has(a.sys_id));
    return { offenders: unmatched.map((a) => offender(a, 'alert_filter', `${a.number}: no ${rule_type ? `${rule_type}-type ` : ''}alert rule matches`)),
      observed: { alerts: alerts.rows.length, rules: rules.length, unmatched: unmatched.length }, expected: 0, absent: false,
      kpi: { numerator: alerts.rows.length - unmatched.length, denominator: alerts.rows.length, basis: 'alerts an active rule\'s alert_filter matches (evaluated by the instance)' },
      population: pop(alerts.rows.length, alerts.rows.length, 'alerts', `em_alert where ${scope || 'any'} — each rule's alert_filter run by the instance as the query`) };
  },

  /**
   * ITOM-108 — alerts with no assignment and no notification whose condition matches.
   * `rows` are the active notifications on em_alert.
   */
  itom_alerts_without_path: () => async (rows, ctx) => {
    const alerts = await rowsOf(ctx, { table: 'em_alert', fields: ['number'], query: 'assignment_groupISEMPTY^assigned_toISEMPTY', complete: true });
    if (alerts.unavailable) return alerts;
    const m = await matchedBy(ctx, { table: 'em_alert', scope: 'assignment_groupISEMPTY^assigned_toISEMPTY', conditions: rows.map((n) => n.condition) });
    if (m.unavailable) return m;
    const offenders = (m.all ? [] : alerts.rows.filter((a) => !m.ids.has(a.sys_id))).map((a) => offender(a, 'assignment_group', `${a.number}: unassigned and no notification matches`));
    return { offenders, observed: { unassigned_alerts: alerts.rows.length, notifications: rows.length, without_path: offenders.length }, expected: 0, absent: false,
      population: pop(alerts.rows.length, alerts.rows.length, 'unassigned alerts', 'each active em_alert notification\'s condition run by the instance as the query') };
  },

  /**
   * ITOM-094 / ITOM-105 — event rules by the CI class they apply to (ci_type, with
   * subclasses). 'uncovered': classes receiving events that no active rule covers.
   * 'disabled_live': disabled rules whose class still receives events.
   */
  itom_event_rule_classes: ({ mode }) => async (rows, ctx) => {
    const vol = await countsBy(ctx, { table: 'em_event', query: 'cmdb_ciISNOTEMPTY', groupBy: ['cmdb_ci.sys_class_name'] });
    if (vol.unavailable) return vol;
    const receiving = new Map(vol.groups.map((g) => [String(g.group['cmdb_ci.sys_class_name']), g.count]).filter(([c]) => c));
    /* A rule covers its ci_type and every subclass: walk UP from each class that receives events (few), never down the tree. */
    const lineage = new Map();
    for (const cls of receiving.keys()) { const a = await ancestors(ctx, cls); if (a.unavailable) return a; lineage.set(cls, a.classes); }
    const covers = (r, cls) => isEmpty(r.ci_type) || lineage.get(cls).has(String(r.ci_type));
    if (mode === 'uncovered') {
      const active = rows.filter((x) => String(x.active) !== 'false');
      const offenders = [...receiving].filter(([c]) => !active.some((r) => covers(r, c))).map(([c, n]) => ({ sys_id: c, field: 'ci_type', value: `${c}: ${n} events, no active event rule covers the class` }));
      return { offenders, observed: { classes_receiving_events: receiving.size, uncovered: offenders.length }, expected: 0, absent: false,
        population: pop(receiving.size, receiving.size, 'CI classes receiving events', 'em_event by the class of the bound CI; a rule covers its ci_type and every subclass (a rule with no ci_type covers all)') };
    }
    const disabled = rows.filter((x) => String(x.active) === 'false');
    const offenders = [];
    for (const r of disabled) {
      const n = [...receiving].filter(([c]) => covers(r, c)).reduce((a, [, k]) => a + k, 0);
      if (n > 0) offenders.push(offender(r, 'active', `${r.name}: disabled, ${n} events in its class set`));
    }
    return { offenders, observed: { disabled_rules: disabled.length, with_live_volume: offenders.length }, expected: 0, absent: false,
      population: pop(disabled.length, disabled.length, 'disabled event rules', 'events on the ci_type of the rule and its subclasses') };
  },

  /**
   * ITOM-099 / ITOM-150 — alerts bound to a CI that IRE has flagged as a duplicate
   * (duplicate_of set). `without_relationships`: only duplicates with no relationship (150).
   */
  itom_alerts_on_duplicates: ({ without_relationships = false }) => async (rows, ctx) => {
    const ids = [...new Set(rows.map((a) => String(ref(a.cmdb_ci))).filter(Boolean))];
    const dups = new Set();
    for (const c of chunks(ids)) {
      const r = await rowsOf(ctx, { table: 'cmdb_ci', fields: ['duplicate_of'], query: `sys_idIN${c.join(',')}^duplicate_ofISNOTEMPTY`, complete: true });
      if (r.unavailable) return r;
      for (const x of r.rows) dups.add(x.sys_id);
    }
    let bare = dups;
    if (without_relationships && dups.size) {
      const related = new Set();
      for (const c of chunks([...dups])) for (const f of ['parent', 'child']) {
        const r = await rowsOf(ctx, { table: 'cmdb_rel_ci', fields: [f], query: `${f}IN${c.join(',')}`, complete: true });
        if (r.unavailable) return r;
        for (const x of r.rows) related.add(String(ref(x[f])));
      }
      bare = new Set([...dups].filter((d) => !related.has(d)));
    }
    const offenders = rows.filter((a) => bare.has(String(ref(a.cmdb_ci)))).map((a) => offender(a, 'cmdb_ci', `${a.number}: bound to a CI IRE flagged as a duplicate${without_relationships ? ' that carries no relationships' : ''}`));
    return { offenders, observed: { alerts: rows.length, on_duplicates: offenders.length }, expected: 0, absent: false,
      kpi: rows.length ? { numerator: rows.length - offenders.length, denominator: rows.length, basis: 'alerts bound to a CI that is not a flagged duplicate' } : undefined,
      population: pop(rows.length, rows.length, 'alerts bound to a CI', 'the bound CI\'s duplicate_of (set by IRE de-duplication)') };
  },

  /** ITOM-075 — flagged duplicate CIs whose discovery source is Service Mapping, against a minimum count. */
  itom_duplicates_from_source: ({ source, minimum }) => async (rows) => {
    const dups = rows.filter((r) => !isEmpty(ref(r.duplicate_of)) && r.discovery_source === source);
    return { offenders: dups.length >= minimum ? dups.map((r) => offender(r, 'duplicate_of', `${r.name}: duplicate from ${source}`)) : [],
      observed: { cis_from_source: rows.filter((r) => r.discovery_source === source).length, duplicates: dups.length, minimum }, expected: `< ${minimum}`, absent: false,
      population: pop(rows.length, rows.length, `CIs from ${source}`, 'discovery_source and duplicate_of (IRE)') };
  },

  /**
   * ITOM-148 — relationship deletions (sys_audit_delete on cmdb_rel_ci) that fall
   * inside a discovery run that did not complete. `rows` are those runs.
   */
  itom_relationship_deletions_in_failed_runs: ({ completed_state }) => async (_rows, ctx) => {
    const failed = await rowsOf(ctx, { table: 'discovery_status', fields: ['dscheduler', 'state', 'started', 'sys_updated_on'], query: `state!=${completed_state}^startedISNOTEMPTY`, complete: true });
    if (failed.unavailable) return failed;
    const runs = failed.rows.map((r) => ({ r, a: fromSnowTime(r.started), b: fromSnowTime(r.sys_updated_on) })).filter((x) => x.a && x.b);
    if (!runs.length) return { offenders: [], observed: { failed_runs: 0 }, expected: 0, absent: false, population: pop(0, 0, 'discovery runs that did not complete', 'discovery_status started … last update') };
    const from = new Date(Math.min(...runs.map((x) => x.a))).toISOString().replace('T', ' ').slice(0, 19);
    const del = await rowsOf(ctx, { table: 'sys_audit_delete', fields: ['tablename', 'documentkey', 'sys_created_on'], query: `tablename=cmdb_rel_ci^sys_created_on>=${from}`, complete: true });
    if (del.unavailable) return del;
    const offenders = [];
    for (const x of runs) {
      const n = del.rows.filter((d) => { const t = fromSnowTime(d.sys_created_on); return t && t >= x.a && t <= x.b; }).length;
      if (n) offenders.push(offender(x.r, 'state', `${x.r.number ?? x.r.sys_id}: ${n} relationships deleted during the run (state ${x.r.state})`));
    }
    return { offenders, observed: { failed_runs: runs.length, deletions_read: del.rows.length, runs_with_deletions: offenders.length }, expected: 0, absent: false,
      population: pop(runs.length, runs.length, 'discovery runs that did not complete', 'sys_audit_delete rows for cmdb_rel_ci between the run\'s start and its last update') };
  },
});

/* ══ D-037 — impact break points and location-less schedules ══════════════════════════ */

async function idsIn(ctx, { table, fields, field, ids, extra = '' }) {
  const out = [];
  for (const c of chunks([...new Set(ids)].filter(Boolean))) {
    const r = await rowsOf(ctx, { table, fields, query: `${field}IN${c.join(',')}${extra ? `^${extra}` : ''}` });
    if (r.unavailable) return r;
    out.push(...r.rows);
  }
  return { rows: out };
}

export const ITOM_TRACE_COMPARATORS = Object.freeze({
  /**
   * ITOM-152 — Business Critical services with no impact tree whose model breaks at an ITOM
   * cause: an application service Service Mapping mapped nothing into, or break-point CIs
   * that were never discovered (no discovery source) or that discovery reported issues on.
   * A model that ends at the offering or business layer is CSDM's (CSDM-075), not ITOM's.
   */
  itom_impact_break_cause: ({ classification, critical }) => async (_rows, ctx) => {
    const c = await criticalWithoutImpact(ctx, critical); if (c.unavailable) return c;
    if (c.not_in_use) return { offenders: [], observed: { impact_graph: 0 }, expected: 0, absent: false, population: { total: 0, judged: 0, unit: 'Business Critical services', basis: 'no impact tree exists on the instance: impact calculation is not in use', determinate_when_empty: 'impact calculation is not in use' } };
    const t = await traverseServices(ctx, c.empty.map((s) => s.sys_id), classification); if (t.unavailable) return t;
    const leafIds = [...new Set([...t.byService.values()].flatMap((x) => (x.deepest === 'infrastructure' ? x.leaves.filter((l) => l.layer === 'infrastructure').map((l) => l.sys_id) : [])))];
    const issues = await idsIn(ctx, { table: 'discovery_device_history', fields: ['cmdb_ci', 'issues'], field: 'cmdb_ci', ids: leafIds, extra: 'issues>0' }); if (issues.unavailable) return issues;
    const failing = new Set(issues.rows.map((x) => String(ref(x.cmdb_ci))));
    const offenders = []; let judged = 0;
    for (const s of c.empty) {
      const x = t.byService.get(s.sys_id); if (!x) continue;
      const causes = [];
      if (x.deepest === 'application') {
        const apps = [...t.nodes.values()].filter((n) => n.layer === 'application' && n.sys_class_name === 'cmdb_ci_service_discovered');
        if (apps.length) causes.push(`Service Mapping mapped no CI into ${apps.map((a) => a.name).slice(0, 3).join(', ')}`);
      }
      if (x.deepest === 'infrastructure') {
        const infra = x.leaves.filter((l) => l.layer === 'infrastructure');
        const never = infra.filter((l) => isEmpty(l.discovery_source));
        const failed = infra.filter((l) => failing.has(l.sys_id));
        if (never.length) causes.push(`${never.length} break-point CI(s) never discovered (${never.slice(0, 3).map((l) => l.name).join(', ')})`);
        if (failed.length) causes.push(`discovery reported issues on ${failed.length} break-point CI(s)`);
      }
      if (x.deepest === 'application' || x.deepest === 'infrastructure') judged += 1;
      if (causes.length) offenders.push(offender(s, 'impact', `${s.name}: no impact tree — ${causes.join('; ')}`));
    }
    return { offenders, observed: { critical: c.critical.length, without_impact_tree: c.empty.length, reaching_itom_layers: judged, traced_to_itom: offenders.length }, expected: 0, absent: false,
      population: pop(c.empty.length, judged, 'Business Critical services with no impact tree', 'models that reach the application or infrastructure layer; their break points against Service Mapping, discovery source and discovery issues') };
  },

  /**
   * ITOM-156 — active discovery schedules with no location: the CIs their runs discovered
   * that have no location (N), and the routing and alert rules whose conditions read a
   * location (M). A schedule is charged when both are non-zero; the rules are named.
   */
  itom_schedule_location_breakage: () => async (rows, ctx) => {
    const noLoc = rows.filter((r) => isEmpty(ref(r.location)));
    const RULES = [['sysrule_assignment', 'condition', 'assignment (routing) rule'], ['em_alert_management_rule', 'alert_filter', 'alert management rule'], ['em_match_rule', 'filter', 'event rule']];
    const named = []; const unread = [];
    for (const [table, field, kind] of RULES) {
      const r = await rowsOf(ctx, { table, fields: ['name', field], query: `active=true^${field}LIKElocation` });
      if (r.unavailable) { unread.push(table); continue; }
      for (const x of r.rows) if (/(^|[.^])location(?=[^a-z_]|$)/.test(String(x[field] ?? ''))) named.push(`${x.name || x.sys_id} (${kind})`);
    }
    const offenders = []; const perSchedule = {};
    for (const s of noLoc) {
      const runs = await rowsOf(ctx, { table: 'discovery_status', fields: ['dscheduler'], query: `dscheduler=${s.sys_id}` }); if (runs.unavailable) return runs;
      const hist = runs.rows.length ? await idsIn(ctx, { table: 'discovery_device_history', fields: ['cmdb_ci'], field: 'status', ids: runs.rows.map((x) => x.sys_id), extra: 'cmdb_ciISNOTEMPTY' }) : { rows: [] };
      if (hist.unavailable) return hist;
      const cis = hist.rows.length ? await idsIn(ctx, { table: 'cmdb_ci', fields: ['location', 'sys_class_name'], field: 'sys_id', ids: hist.rows.map((x) => String(ref(x.cmdb_ci))) }) : { rows: [] };
      if (cis.unavailable) return cis;
      const n = cis.rows.filter((c) => isEmpty(ref(c.location))).length;
      perSchedule[s.name] = n;
      if (n && named.length) offenders.push(offender(s, 'location', `${s.name}: no location — ${n} CI(s) it discovered have none, and ${named.length} rule(s) read a location: ${named.slice(0, 6).join(', ')}${named.length > 6 ? ` (+${named.length - 6} more)` : ''}`));
    }
    return { offenders, observed: { active_schedules: rows.length, without_location: noLoc.length, cis_without_location: perSchedule, rules_reading_location: named.length, unread_rule_tables: unread }, expected: 0, absent: false,
      population: pop(noLoc.length, noLoc.length, 'active schedules without a location', 'CIs in the discovery history of each schedule\'s runs, by location; routing and alert rules whose conditions name a location') };
  },
});
