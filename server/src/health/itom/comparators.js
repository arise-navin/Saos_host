import { declareRequirement } from '../itsm/data-access.js';
import { fromSnowTime, shiftDate, parseWindow } from '../itsm/run-context.js';
import { ipToInt, rangeBounds } from '../cmdb-freshness.js';

/**
 * HEALTH ASSIST PHASE 5 — the ITOM comparators.
 *
 * Named callbacks for the configuration engine (`compare: { name, args }`), in the
 * same contract as the ITSM ones (itsm/comparators.js): given the rows the rule's
 * reader returned, answer `{ offenders, observed, expected, absent, population }`,
 * or `{ unavailable: reason }` when something the judgement needs could not be
 * read. They are merged into the shared COMPARATORS library, so an ITOM rule is a
 * JSON entry like any other.
 *
 * THREE RULES EVERY COMPARATOR HERE KEEPS
 *
 *   absence needs a complete read    "no schedule covers this location", "no
 *                                    capability", "no affinity" are claims about
 *                                    rows NOT found; they are made only from a read
 *                                    that completed, otherwise the rule is
 *                                    UNAVAILABLE with the read's status.
 *   instance values come from the    run types, run states, alert states: the rule
 *   instance                         config names them by LABEL ($choice) and the
 *                                    runner resolves the value from sys_choice, so
 *                                    nothing here hard-codes a platform value.
 *   population is declared           every answer says what it judged; "no offender"
 *                                    over nothing judged is inconclusive, never a pass.
 *
 * Every table and field a comparator reads is also named in its rule's
 * `requires_tables`, so the runner has verified it exists on THIS instance
 * before the comparator runs (the DECISION 5 pipeline).
 */

const COMPLETE = 'complete';
const usable = (cov) => ['complete', 'limited', 'truncated'].includes(cov?.status);
const isEmpty = (v) => v === undefined || v === null || String(v).trim() === '';
const round1 = (n) => Number(n.toFixed(1));
const truthy = (v) => ['true', '1', 'yes'].includes(String(v).toLowerCase());
const ref = (v) => (v && typeof v === 'object' ? v.value ?? v.sys_id ?? null : v);

/** Rows of a table through the run's read cache. `complete` demands the whole table (absence claims). */
async function rowsOf(ctx, { table, fields, query = '', complete = false }) {
  const r = await ctx.reads.read(declareRequirement({ table, fields, query, strategy: 'rows' }));
  const ok = complete ? r.coverage?.status === COMPLETE : usable(r.coverage);
  if (!ok) return { unavailable: `${table} could not be read${complete ? ' completely' : ''} (${r.coverage?.status}${r.coverage?.error ? `: ${r.coverage.error}` : ''}) — no claim is made from a partial read`, coverage: r.coverage };
  return { rows: r.rows, coverage: r.coverage };
}

/** Grouped counts through the aggregate API. */
async function countsBy(ctx, { table, query = '', groupBy }) {
  const r = await ctx.reads.read(declareRequirement({ table, query, strategy: 'aggregate', groupBy }));
  if (r.coverage?.status !== COMPLETE) return { unavailable: `aggregate over ${table} failed (${r.coverage?.status})`, coverage: r.coverage };
  return { groups: r.groups, coverage: r.coverage, total: r.groups.reduce((n, g) => n + g.count, 0) };
}

/* A glide_duration is stored as an offset from the epoch ('1970-01-08 00:00:00' = 7 days). */
export function durationMs(value) {
  const d = fromSnowTime(value);
  return d ? d.getTime() : null;
}

/**
 * A schedule's interval from its run type. `intervals` maps each run-type VALUE
 * (resolved from its label) to a window ("1 days", "7 days", "1 months") or to
 * 'run_period' (the schedule's own period). A run type not listed (once, on
 * demand, after another discovery) has no interval, so it is not judged.
 */
export function scheduleInterval(schedule, intervals) {
  const hit = intervals.find((i) => String(i.value) === String(schedule.run_type));
  if (!hit) return null;
  if (hit.every === 'run_period') {
    const ms = durationMs(schedule.run_period);
    return ms && ms > 0 ? { amount: ms / 1000, unit: 'seconds' } : null;
  }
  return parseWindow(hit.every);
}
const scaled = (w, k) => ({ amount: w.amount * k, unit: w.unit });
const describeWindow = (w) => (w.unit === 'seconds' && w.amount % 86400 === 0 ? `${w.amount / 86400} days` : `${round1(w.amount)} ${w.unit}`);

const inAny = (n, ranges) => ranges.some((r) => n >= r.bounds[0] && n <= r.bounds[1]);

/*
 * THE TABLES AS A REAL INSTANCE HAS THEM (Phase 5E, techsnitchpvtltddemo2, read-only).
 * The credential affinity table is dscy_credentials_affinity (credential_id is the
 * credential's sys_id as a string). A range item reaches a schedule two ways: its
 * own `schedule` reference, or its `parent` range set linked to schedules through
 * discovery_schedule_range (dscheduler, range). On that instance 3 of 4 range items
 * were in sets — reading `schedule` alone would have judged one range in four.
 */
export const AFFINITY_TABLE = 'dscy_credentials_affinity';
const RANGE_FIELDS = ['name', 'schedule', 'parent', 'type', 'start_ip_address', 'end_ip_address', 'network_ip', 'netmask', 'active'];

/**
 * Every active range item on an active schedule, attributed to each schedule that
 * scans it: `{ bySchedule: Map(schedule → ranges[]), ranges: [...] }`, or
 * `{ unavailable }`. The schedule-to-range-set link is read when the table exists;
 * where it is not on the instance, range sets cannot be attached to a schedule and
 * the direct links are the whole answer.
 */
export async function scheduleRanges(ctx, { scheduleIds = null } = {}) {
  const scheds = await rowsOf(ctx, { table: 'discovery_schedule', fields: ['name'], query: 'active=true', complete: true });
  if (scheds.unavailable) return scheds;
  const active = new Set(scheds.rows.map((r) => r.sys_id).filter((id) => !scheduleIds || scheduleIds.includes(id)));
  const items = await rowsOf(ctx, { table: 'discovery_range_item', fields: RANGE_FIELDS, query: 'active=true', complete: true });
  if (items.unavailable) return items;
  const setsOf = new Map();
  const link = await ctx.probes.tableExists('discovery_schedule_range');
  if (link.state === 'AVAILABLE') {
    const m2m = await rowsOf(ctx, { table: 'discovery_schedule_range', fields: ['dscheduler', 'range'], complete: true });
    if (m2m.unavailable) return m2m;
    for (const r of m2m.rows) { const set = ref(r.range); const sch = ref(r.dscheduler); if (set && sch) { if (!setsOf.has(set)) setsOf.set(set, new Set()); setsOf.get(set).add(sch); } }
  } else if (link.state !== 'UNAVAILABLE') {
    return { unavailable: `discovery_schedule_range could not be confirmed (${link.state}): range sets cannot be attributed to schedules` };
  }
  /*
   * An "IP Address List" range item carries no bounds of its own: its addresses are
   * rows of discovery_range_item_ip (ip_address, item_parent) — found on a real
   * instance in Phase 5E. Each listed address is a one-address range of its item.
   */
  const listed = new Map();
  const lists = items.rows.filter((r) => !rangeBounds(r)).map((r) => r.sys_id);
  if (lists.length) {
    const ipTable = await ctx.probes.tableExists('discovery_range_item_ip');
    if (ipTable.state === 'AVAILABLE') {
      const ips = await rowsOf(ctx, { table: 'discovery_range_item_ip', fields: ['ip_address', 'item_parent'], query: `item_parentIN${lists.join(',')}`, complete: true });
      if (ips.unavailable) return ips;
      for (const x of ips.rows) { const n = ipToInt(x.ip_address); const parent = ref(x.item_parent); if (n == null || !parent) continue; if (!listed.has(parent)) listed.set(parent, []); listed.get(parent).push([n, n]); }
    } else if (ipTable.state !== 'UNAVAILABLE') {
      return { unavailable: `discovery_range_item_ip could not be confirmed (${ipTable.state}): address-list ranges cannot be read` };
    }
  }
  const bySchedule = new Map();
  for (const r of items.rows) {
    const b = rangeBounds(r);
    const spans = b ? [b] : (listed.get(r.sys_id) || []);
    if (!spans.length) continue;
    const owners = new Set([ref(r.schedule), ...(setsOf.get(ref(r.parent)) || [])].filter((x) => x && active.has(x)));
    for (const sch of owners) {
      if (!bySchedule.has(sch)) bySchedule.set(sch, []);
      spans.forEach((bounds, i) => bySchedule.get(sch).push({ id: spans.length > 1 ? `${r.sys_id}#${i}` : r.sys_id, item: r.sys_id, bounds, label: r.name || r.summary || `${r.start_ip_address || r.network_ip}/${r.netmask || ''}`, row: r }));
    }
  }
  const unparsed = items.rows.filter((r) => !rangeBounds(r) && !listed.has(r.sys_id)).length;
  return { bySchedule, ranges: [...new Map([...bySchedule.values()].flat().map((x) => [x.id, x])).values()], unparsed, coverage: items.coverage };
}

/**
 * THE AFFINITY GUARD (Phase 5E). The platform writes a credential affinity on a
 * successful authentication — so "no affinity" reads as "never used" only where
 * affinities are recorded at all. Measured on a real instance: 69 completed
 * discovery runs, CIs discovered, and ZERO affinity rows. An empty affinity table
 * beside successful discoveries is a table not being written, not thirty unused
 * credentials; the rule says so instead of charging every credential.
 */
async function affinities(ctx, fields) {
  const aff = await rowsOf(ctx, { table: AFFINITY_TABLE, fields, complete: true });
  if (aff.unavailable) return aff;
  if (aff.rows.length) return aff;
  /*
   * Evidence that Discovery authenticated somewhere: CIs it discovered
   * (last_discovered set). NOT device history's cmdb_ci — on a real instance
   * (Phase 5E) 0 of 58 history rows carried one while 357 CIs came from Discovery.
   */
  const discovered = await countsBy(ctx, { table: 'cmdb_ci', query: 'last_discoveredISNOTEMPTY', groupBy: [] });
  if (discovered.unavailable) return discovered;
  if (discovered.total > 0) return { unavailable: `${AFFINITY_TABLE} is empty while Discovery has discovered ${discovered.total} CI(s) — this instance is not recording credential affinities, so a credential's use cannot be read from them` };
  return aff;
}
const overlaps = (a, b) => a.bounds[0] <= b.bounds[1] && b.bounds[0] <= a.bounds[1];

export const ITOM_COMPARATORS = Object.freeze({
  /**
   * ITOM-003 — locations holding at least `ci_threshold` CIs that no ACTIVE
   * schedule targets. Rows are the active schedules (location read); CI counts per
   * location come from the aggregate API.
   */
  itom_locations_without_schedule: ({ ci_threshold }) => async (rows, ctx) => {
    const counts = await countsBy(ctx, { table: 'cmdb_ci', query: 'locationISNOTEMPTY', groupBy: ['location'] });
    if (counts.unavailable) return counts;
    const targeted = new Set(rows.map((s) => ref(s.location)).filter((x) => !isEmpty(x)));
    const heavy = counts.groups.filter((g) => g.count >= ci_threshold);
    const offenders = heavy.filter((g) => !targeted.has(ref(g.group.location))).map((g) => ({ sys_id: ref(g.group.location), field: 'location', value: `${g.count} CIs, no active schedule` }));
    /* Every location holding CIs was judged; only one at or over the threshold can offend. */
    return { offenders, observed: { locations: counts.groups.length, locations_over_threshold: heavy.length, untargeted: offenders.length, active_schedules: rows.length }, expected: 0, absent: false, coverage: counts.coverage,
      population: { total: counts.groups.length, judged: counts.groups.length, unit: 'locations', basis: `locations holding CIs, tested against a ${ci_threshold}-CI threshold` } };
  },

  /**
   * ITOM-006 / ITOM-124 — an active periodic schedule whose last COMPLETED run is
   * older than its interval × tolerance, or which has never completed. Rows are
   * the schedules; completions come from discovery_status.
   */
  itom_schedule_overdue: ({ intervals, completed_state, tolerance }) => async (rows, ctx) => {
    const runs = await rowsOf(ctx, { table: 'discovery_status', fields: ['dscheduler', 'state', 'completed'], query: `state=${completed_state}^completedISNOTEMPTY` });
    if (runs.unavailable) return runs;
    const last = new Map();
    for (const r of runs.rows) {
      const s = ref(r.dscheduler); const t = fromSnowTime(r.completed);
      if (!s || !t) continue;
      if (!last.has(s) || last.get(s) < t) last.set(s, t);
    }
    const now = ctx.run.now ?? new Date(ctx.run.run_started_at);
    const offenders = []; let judged = 0;
    for (const s of rows) {
      const w = scheduleInterval(s, intervals);
      if (!w) continue;
      judged += 1;
      const lastRun = last.get(s.sys_id);
      if (!lastRun) { offenders.push({ sys_id: s.sys_id, field: 'last_completed', value: `${s.name}: never completed (interval ${describeWindow(w)})` }); continue; }
      const due = shiftDate(lastRun, scaled(w, tolerance), +1);
      if (now > due) offenders.push({ sys_id: s.sys_id, field: 'last_completed', value: `${s.name}: last completed ${lastRun.toISOString().slice(0, 16)} — interval ${describeWindow(w)} × ${tolerance}` });
    }
    return { offenders, observed: { schedules: rows.length, periodic: judged, overdue: offenders.length }, expected: 0, absent: false, coverage: runs.coverage,
      population: { total: rows.length, judged, unit: 'schedules', basis: 'active schedules with a recurring run type' } };
  },

  /**
   * ITOM-009 — ranges on active schedules with no successful device discovery in
   * the window AND no subnet in current CI IP data. `rows` are range items.
   */
  itom_dead_ranges: ({ window, success_query }) => async (_rows, ctx) => {
    const sr = await scheduleRanges(ctx);
    if (sr.unavailable) return sr;
    const spansOf = new Map();
    for (const x of sr.ranges) { const k = x.item ?? x.id; if (!spansOf.has(k)) spansOf.set(k, { row: x.row, spans: [] }); spansOf.get(k).spans.push(x.bounds); }
    const rows = [...spansOf.values()].map((v) => v.row);
    const since = `sys_created_on>=${ctx.run.window(window).start_snow}`;
    const found = await rowsOf(ctx, { table: 'discovery_device_history', fields: ['source'], query: [since, success_query].filter(Boolean).join('^') });
    if (found.unavailable) return found;
    const cis = await rowsOf(ctx, { table: 'cmdb_ci', fields: ['ip_address'], query: 'ip_addressISNOTEMPTY', complete: true });
    if (cis.unavailable) return cis;
    const hits = found.rows.map((r) => ipToInt(r.source)).filter((n) => n != null);
    const ciIps = cis.rows.map((r) => ipToInt(r.ip_address)).filter((n) => n != null);
    const offenders = []; let judged = 0;
    for (const r of rows) {
      const spans = spansOf.get(r.sys_id).spans;
      judged += 1;
      const inside = (n) => spans.some((b) => n >= b[0] && n <= b[1]);
      if (!hits.some(inside) && !ciIps.some(inside)) offenders.push({ sys_id: r.sys_id, field: 'range', value: r.name || `${r.start_ip_address || r.network_ip}` });
    }
    return { offenders, observed: { ranges: judged, dead: offenders.length }, expected: 0, absent: false, coverage: cis.coverage,
      population: { total: rows.length, judged, unit: 'discovery ranges', basis: `ranges on active schedules (directly or through a range set), over a ${window} window` } };
  },

  /** ITOM-010 — pairs of ranges on DIFFERENT active schedules whose CIDR bounds overlap. `rows` are range items with their schedule. */
  itom_overlapping_ranges: () => async (_rows, ctx) => {
    const sr = await scheduleRanges(ctx);
    if (sr.unavailable) return sr;
    const bySchedule = sr.bySchedule;
    const flat = [...bySchedule.entries()].flatMap(([s, rs]) => rs.map((r) => ({ ...r, schedule: s })));
    const offenders = [];
    for (let i = 0; i < flat.length; i++) {
      for (let j = i + 1; j < flat.length; j++) {
        const a = flat[i]; const b = flat[j];
        if (a.schedule !== b.schedule && (a.item ?? a.id) !== (b.item ?? b.id) && overlaps(a, b)) offenders.push({ sys_id: a.id, field: 'overlaps', value: `${a.label} ↔ ${b.label} (${b.id})` });
      }
    }
    return { offenders, observed: { ranges: flat.length, schedules: bySchedule.size, overlapping_pairs: offenders.length }, expected: 0, absent: false,
      population: { total: flat.length, judged: flat.length, unit: 'ranges on active schedules', basis: 'every pair of ranges belonging to different schedules' } };
  },

  /**
   * ITOM-011 — active schedules that run on ONE MID which belongs to no cluster.
   * `rows` are schedules (mid_select_method, mid_server); `specific_mid` is the
   * select-method value meaning "a specific MID".
   */
  itom_schedule_single_mid: ({ specific_mid }) => async (rows, ctx) => {
    const members = await rowsOf(ctx, { table: 'ecc_agent_cluster_member_m2m', fields: ['agent', 'cluster'], complete: true });
    if (members.unavailable) return members;
    const clustered = new Set(members.rows.map((m) => ref(m.agent)).filter(Boolean));
    const pinned = rows.filter((s) => String(s.mid_select_method) === String(specific_mid) && !isEmpty(ref(s.mid_server)));
    const offenders = pinned.filter((s) => !clustered.has(ref(s.mid_server))).map((s) => ({ sys_id: s.sys_id, field: 'mid_server', value: `${s.name}: single MID ${ref(s.mid_server)}, no cluster` }));
    return { offenders, observed: { schedules: rows.length, pinned_to_one_mid: pinned.length, unclustered: offenders.length }, expected: 0, absent: false, coverage: members.coverage,
      population: { total: rows.length, judged: rows.length, unit: 'active schedules', basis: 'active schedules and how they select their MID' } };
  },

  /**
   * ITOM-019 — per range: successfully discovered devices with a credential
   * affinity ÷ successfully discovered devices, below `min_coverage`%.
   */
  itom_affinity_coverage: ({ window, success_query, min_coverage }) => async (rows, ctx) => {
    const since = `sys_created_on>=${ctx.run.window(window).start_snow}`;
    const found = await rowsOf(ctx, { table: 'discovery_device_history', fields: ['source'], query: [since, success_query].filter(Boolean).join('^') });
    if (found.unavailable) return found;
    const aff = await affinities(ctx, ['ip_address']);
    if (aff.unavailable) return aff;
    const affine = new Set(aff.rows.map((a) => ipToInt(a.ip_address)).filter((n) => n != null));
    const devices = [...new Set(found.rows.map((r) => ipToInt(r.source)).filter((n) => n != null))];
    const offenders = []; let judged = 0;
    for (const r of rows) {
      const b = rangeBounds(r);
      if (!b) continue;
      const inRange = devices.filter((n) => n >= b[0] && n <= b[1]);
      if (!inRange.length) continue;
      judged += 1;
      const covered = inRange.filter((n) => affine.has(n)).length;
      const pct = round1((100 * covered) / inRange.length);
      if (pct < min_coverage) offenders.push({ sys_id: r.sys_id, field: 'affinity_coverage', value: `${r.name || r.start_ip_address || r.network_ip}: ${covered}/${inRange.length} (${pct}%)` });
    }
    return { offenders, observed: { ranges_with_successes: judged, below: offenders.length }, expected: `≥ ${min_coverage}%`, absent: false, coverage: aff.coverage,
      population: { total: rows.length, judged, unit: 'ranges with successful discoveries', basis: `successful discoveries in the last ${window}` } };
  },

  /**
   * ITOM-020 / ITOM-027 — credentials older than `min_age` with no credential
   * affinity (the platform writes one on each successful authentication).
   * `recent_window` (027) limits "use" to affinities touched in that window.
   */
  itom_credential_unused: ({ min_age, recent_window = null }) => async (rows, ctx) => {
    const aff = await affinities(ctx, ['credential_id', 'sys_updated_on']);
    if (aff.unavailable) return aff;
    const since = recent_window ? ctx.run.window(recent_window).start : null;
    const used = new Set(aff.rows.filter((a) => !since || (fromSnowTime(a.sys_updated_on) ?? 0) >= since).map((a) => ref(a.credential_id)).filter(Boolean));
    const cutoff = ctx.run.window(min_age).start;
    const old = rows.filter((c) => (fromSnowTime(c.sys_created_on) ?? cutoff) < cutoff);
    const offenders = old.filter((c) => !used.has(c.sys_id)).map((c) => ({ sys_id: c.sys_id, field: 'successful_uses', value: `${c.name}: no successful use${recent_window ? ` in ${recent_window}` : ' since creation'}` }));
    return { offenders, observed: { credentials: rows.length, older_than_threshold: old.length, unused: offenders.length }, expected: 0, absent: false, coverage: aff.coverage,
      population: { total: rows.length, judged: old.length, unit: 'credentials', basis: `active credentials older than ${min_age}` } };
  },

  /**
   * ITOM-029 — per schedule with at least `min_runs` completed runs: the linear
   * trend of run duration, projected forward; a positive trend that reaches the
   * schedule's max run window within `horizon` is the finding.
   */
  itom_run_duration_trend: ({ completed_state, min_runs, horizon }) => async (rows, ctx) => {
    const runs = await rowsOf(ctx, { table: 'discovery_status', fields: ['dscheduler', 'state', 'started', 'completed'], query: `state=${completed_state}^startedISNOTEMPTY^completedISNOTEMPTY` });
    if (runs.unavailable) return runs;
    const bySchedule = new Map();
    for (const r of runs.rows) {
      const s = ref(r.dscheduler); const a = fromSnowTime(r.started); const b = fromSnowTime(r.completed);
      if (!s || !a || !b || b < a) continue;
      if (!bySchedule.has(s)) bySchedule.set(s, []);
      bySchedule.get(s).push({ t: a.getTime(), d: b.getTime() - a.getTime() });
    }
    const horizonMs = shiftDate(new Date(0), horizon, +1).getTime();
    const offenders = []; let judged = 0;
    for (const s of rows) {
      const limit = durationMs(s.max_run);
      const pts = (bySchedule.get(s.sys_id) || []).sort((x, y) => x.t - y.t);
      if (!limit || pts.length < min_runs) continue;
      judged += 1;
      const n = pts.length; const mt = pts.reduce((k, p) => k + p.t, 0) / n; const md = pts.reduce((k, p) => k + p.d, 0) / n;
      const sxx = pts.reduce((k, p) => k + (p.t - mt) ** 2, 0);
      if (!sxx) continue;
      const slope = pts.reduce((k, p) => k + (p.t - mt) * (p.d - md), 0) / sxx;   // ms of duration per ms of time
      if (slope <= 0) continue;
      const lastT = pts[n - 1].t;
      const projected = md + slope * (lastT + horizonMs - mt);
      if (projected >= limit) offenders.push({ sys_id: s.sys_id, field: 'run_duration', value: `${s.name}: rising over ${n} runs; projected ${round1(projected / 60000)} min against a ${round1(limit / 60000)} min window within ${horizon}` });
    }
    return { offenders, observed: { schedules_with_history: judged, projected_overrun: offenders.length }, expected: 0, absent: false, coverage: runs.coverage,
      population: { total: rows.length, judged, unit: 'schedules', basis: `schedules with a max run window and at least ${min_runs} completed runs` } };
  },

  /** ITOM-032 — completed runs where distinct devices logging an error exceed `error_share`% of the devices the run touched. */
  itom_run_error_rate: ({ completed_state, error_level, error_share, window }) => async (rows, ctx) => {
    const since = `sys_created_on>=${ctx.run.window(window).start_snow}`;
    const runs = rows.filter((r) => String(r.state) === String(completed_state) && (fromSnowTime(r.sys_created_on) ?? 0) >= ctx.run.window(window).start);
    const devices = await countsBy(ctx, { table: 'discovery_device_history', query: since, groupBy: ['status'] });
    if (devices.unavailable) return devices;
    const errs = await rowsOf(ctx, { table: 'discovery_log', fields: ['status', 'source', 'level'], query: `${since}^level=${error_level}` });
    if (errs.unavailable) return errs;
    const perRun = new Map(devices.groups.map((g) => [ref(g.group.status), g.count]));
    const errorDevices = new Map();
    for (const e of errs.rows) {
      const s = ref(e.status); if (!s || isEmpty(e.source)) continue;
      if (!errorDevices.has(s)) errorDevices.set(s, new Set());
      errorDevices.get(s).add(String(e.source));
    }
    const offenders = []; let judged = 0;
    for (const r of runs) {
      const n = perRun.get(r.sys_id) ?? 0;
      if (!n) continue;
      judged += 1;
      const bad = errorDevices.get(r.sys_id)?.size ?? 0;
      const pct = round1((100 * bad) / n);
      if (pct > error_share) offenders.push({ sys_id: r.sys_id, field: 'error_share', value: `${bad}/${n} devices with errors (${pct}%)` });
    }
    return { offenders, observed: { runs: judged, over_threshold: offenders.length }, expected: `≤ ${error_share}%`, absent: false, coverage: errs.coverage,
      population: { total: runs.length, judged, unit: 'completed runs', basis: `completed runs in the last ${window} that touched at least one device` } };
  },

  /**
   * ITOM-033 — runs that ended cancelled, or whose duration exceeded their
   * schedule's max run window. `rows` are runs in the window.
   */
  itom_runs_not_completing: ({ cancelled_state }) => async (rows, ctx) => {
    const scheds = await rowsOf(ctx, { table: 'discovery_schedule', fields: ['name', 'max_run'] });
    if (scheds.unavailable) return scheds;
    const limit = new Map(scheds.rows.map((s) => [s.sys_id, durationMs(s.max_run)]));
    const offenders = [];
    for (const r of rows) {
      if (String(r.state) === String(cancelled_state)) { offenders.push({ sys_id: r.sys_id, field: 'state', value: 'cancelled' }); continue; }
      const a = fromSnowTime(r.started); const b = fromSnowTime(r.completed); const l = limit.get(ref(r.dscheduler));
      if (a && b && l && b - a > l) offenders.push({ sys_id: r.sys_id, field: 'duration', value: `${round1((b - a) / 60000)} min against a ${round1(l / 60000)} min window` });
    }
    return { offenders, observed: { runs: rows.length, not_completing: offenders.length }, expected: 0, absent: false, coverage: scheds.coverage,
      population: { total: rows.length, judged: rows.length, unit: 'discovery runs', basis: 'runs in the window' } };
  },

  /** ITOM-039 — cancelled runs whose schedule has no completed run after the cancellation. */
  itom_cancelled_not_rerun: ({ cancelled_state, completed_state }) => async (rows) => {
    const cancelled = rows.filter((r) => String(r.state) === String(cancelled_state));
    const completedAfter = (s, t) => rows.some((r) => ref(r.dscheduler) === s && String(r.state) === String(completed_state) && (fromSnowTime(r.completed) ?? 0) > t);
    const offenders = cancelled.filter((r) => {
      const t = fromSnowTime(r.sys_updated_on) ?? fromSnowTime(r.sys_created_on);
      return ref(r.dscheduler) && t && !completedAfter(ref(r.dscheduler), t);
    }).map((r) => ({ sys_id: r.sys_id, field: 'rerun', value: `schedule ${ref(r.dscheduler)}: no completed run since` }));
    return { offenders, observed: { cancelled: cancelled.length, never_rerun: offenders.length }, expected: 0, absent: false,
      population: { total: cancelled.length, judged: cancelled.length, unit: 'cancelled runs', basis: 'cancelled runs of a schedule', determinate_when_empty: 'no run was cancelled' } };
  },

  /**
   * ITOM-051 — ITOM-011's single-MID schedules whose ranges contain a CI that
   * supports a Business Critical service (via service-CI associations).
   */
  itom_single_mid_critical: ({ specific_mid, critical_values }) => async (rows, ctx) => {
    const members = await rowsOf(ctx, { table: 'ecc_agent_cluster_member_m2m', fields: ['agent'], complete: true });
    if (members.unavailable) return members;
    const clustered = new Set(members.rows.map((m) => ref(m.agent)).filter(Boolean));
    const single = rows.filter((s) => String(s.mid_select_method) === String(specific_mid) && ref(s.mid_server) && !clustered.has(ref(s.mid_server)));
    if (!single.length) return { offenders: [], observed: { single_mid_schedules: 0 }, expected: 0, absent: false, population: { total: rows.length, judged: rows.length, unit: 'active schedules', basis: 'no schedule runs on a single unclustered MID, so none can carry a critical range alone' } };
    const sr = await scheduleRanges(ctx, { scheduleIds: single.map((s) => s.sys_id) });
    if (sr.unavailable) return sr;
    const services = await rowsOf(ctx, { table: 'cmdb_ci_service', fields: ['name', 'busines_criticality'], query: `busines_criticalityIN${critical_values.join(',')}`, complete: true });
    if (services.unavailable) return services;
    if (!services.rows.length) return { offenders: [], observed: { critical_services: 0 }, expected: 0, absent: false, population: { total: single.length, judged: 0, unit: 'single-MID schedules', basis: 'no Business Critical service is recorded, so criticality cannot be attributed' } };
    const assoc = await rowsOf(ctx, { table: 'svc_ci_assoc', fields: ['service_id', 'ci_id'], query: `service_idIN${services.rows.map((s) => s.sys_id).join(',')}` });
    if (assoc.unavailable) return assoc;
    const ciIds = [...new Set(assoc.rows.map((a) => ref(a.ci_id)).filter(Boolean))];
    const cis = ciIds.length ? await rowsOf(ctx, { table: 'cmdb_ci', fields: ['ip_address'], query: `sys_idIN${ciIds.join(',')}` }) : { rows: [] };
    if (cis.unavailable) return cis;
    const critIps = cis.rows.map((c) => ipToInt(c.ip_address)).filter((n) => n != null);
    const bySchedule = sr.bySchedule;
    const offenders = single.filter((s) => critIps.some((n) => inAny(n, bySchedule.get(s.sys_id) || []))).map((s) => ({ sys_id: s.sys_id, field: 'mid_server', value: `${s.name}: sole MID ${ref(s.mid_server)} carries a range with Business Critical CIs` }));
    return { offenders, observed: { single_mid_schedules: single.length, critical: offenders.length }, expected: 0, absent: false, coverage: assoc.coverage,
      population: { total: single.length, judged: single.length, unit: 'single-MID schedules', basis: 'schedules on one unclustered MID, tested for Business Critical CIs in their ranges' } };
  },

  /** ITOM-052 — clusters of two or more MIDs whose members all report the same host (the workbook's fallback: compare host identifiers). */
  itom_cluster_same_host: () => async (rows, ctx) => {
    const agents = await rowsOf(ctx, { table: 'ecc_agent', fields: ['name', 'host_name'] });
    if (agents.unavailable) return agents;
    const host = new Map(agents.rows.map((a) => [a.sys_id, String(a.host_name || '').trim().toLowerCase()]));
    const byCluster = new Map();
    for (const m of rows) { const c = ref(m.cluster); const a = ref(m.agent); if (!c || !a) continue; if (!byCluster.has(c)) byCluster.set(c, new Set()); byCluster.get(c).add(a); }
    const offenders = []; let judged = 0;
    for (const [c, set] of byCluster) {
      if (set.size < 2) continue;
      const hosts = [...set].map((a) => host.get(a)).filter(Boolean);
      if (hosts.length !== set.size) continue;
      judged += 1;
      if (new Set(hosts).size === 1) offenders.push({ sys_id: c, field: 'host_name', value: `${set.size} MIDs all on ${hosts[0]}` });
    }
    return { offenders, observed: { multi_member_clusters: judged, same_host: offenders.length }, expected: 0, absent: false, coverage: agents.coverage,
      population: { total: byCluster.size, judged, unit: 'MID clusters', basis: 'clusters of two or more MIDs whose host names are all known' } };
  },

  /** ITOM-054 — MIDs whose version is not the instance's MID version (sys_properties `mid.version`). */
  itom_mid_version_mismatch: ({ property = 'mid.version' }) => async (rows, ctx) => {
    const p = await rowsOf(ctx, { table: 'sys_properties', fields: ['name', 'value'], query: `name=${property}` });
    if (p.unavailable) return p;
    const expected = String(p.rows[0]?.value ?? '').trim();
    if (!expected) return { unavailable: `the instance property ${property} is empty or absent, so there is no version to compare against` };
    const judged = rows.filter((m) => !isEmpty(m.version));
    const offenders = judged.filter((m) => String(m.version).trim() !== expected).map((m) => ({ sys_id: m.sys_id, field: 'version', value: `${m.name}: ${m.version} (instance expects ${expected})` }));
    return { offenders, observed: { mids: rows.length, with_version: judged.length, behind: offenders.length }, expected, absent: false, coverage: p.coverage,
      population: { total: rows.length, judged: judged.length, unit: 'MID servers', basis: `MIDs reporting a version, against ${property}` } };
  },

  /** ITOM-058 — within each cluster, a MID holding more than `factor` × the cluster's mean ECC volume. */
  itom_mid_load_share: ({ factor }) => async (rows, ctx) => {
    const vol = await countsBy(ctx, { table: 'ecc_queue', groupBy: ['agent'] });
    if (vol.unavailable) return vol;
    /* ecc_queue.agent names the MID as `mid.server.<MID name>`, not by sys_id. */
    const agents = await rowsOf(ctx, { table: 'ecc_agent', fields: ['name'] });
    if (agents.unavailable) return agents;
    const nameOf = new Map(agents.rows.map((a) => [a.sys_id, String(a.name)]));
    const byAgent = new Map(vol.groups.map((g) => [String(g.group.agent ?? ''), g.count]));
    const byCluster = new Map();
    for (const m of rows) { const c = ref(m.cluster); const a = ref(m.agent); if (!c || !a) continue; if (!byCluster.has(c)) byCluster.set(c, []); byCluster.get(c).push(a); }
    const agentName = (a) => nameOf.get(a) ?? a;
    const offenders = []; let judged = 0;
    for (const [c, members] of byCluster) {
      if (members.length < 2) continue;
      if (members.some((a) => !nameOf.has(a))) continue;
      const loads = members.map((a) => ({ a, n: byAgent.get(`mid.server.${nameOf.get(a)}`) ?? 0 }));
      const total = loads.reduce((k, l) => k + l.n, 0);
      if (!total) continue;
      judged += 1;
      const mean = total / loads.length;
      for (const l of loads) if (l.n > factor * mean) offenders.push({ sys_id: l.a, field: 'ecc_volume', value: `${agentName(l.a)} in cluster ${c}: ${l.n} of ${total} (mean ${round1(mean)})` });
    }
    return { offenders, observed: { clusters_with_load: judged, overloaded: offenders.length }, expected: `≤ ${factor}× cluster mean`, absent: false, coverage: vol.coverage,
      population: { total: byCluster.size, judged, unit: 'MID clusters', basis: 'clusters of two or more MIDs with ECC volume' } };
  },

  /** ITOM-062 — MIDs with no capability that an active schedule assigns work to. `rows` are active schedules. */
  itom_mid_no_capability: () => async (rows, ctx) => {
    const caps = await rowsOf(ctx, { table: 'ecc_agent_capability_m2m', fields: ['agent'], complete: true });
    if (caps.unavailable) return caps;
    const capable = new Set(caps.rows.map((c) => ref(c.agent)).filter(Boolean));
    const referenced = new Map();
    for (const s of rows) { const m = ref(s.mid_server); if (m) { if (!referenced.has(m)) referenced.set(m, []); referenced.get(m).push(s.name); } }
    const offenders = [...referenced.entries()].filter(([m]) => !capable.has(m)).map(([m, names]) => ({ sys_id: m, field: 'capabilities', value: `no capability; referenced by ${names.slice(0, 3).join(', ')}${names.length > 3 ? ' …' : ''}` }));
    return { offenders, observed: { referenced_mids: referenced.size, without_capability: offenders.length }, expected: 0, absent: false, coverage: caps.coverage,
      population: { total: referenced.size, judged: referenced.size, unit: 'MIDs referenced by active schedules', basis: 'MIDs an active schedule names' } };
  },

  /** ITOM-063 (the half the workbook defines) — a MID's instance user account holding the admin role. */
  itom_mid_admin_account: ({ role = 'admin' }) => async (rows, ctx) => {
    const names = [...new Set(rows.map((m) => String(m.user_name || '').trim()).filter(Boolean))];
    if (!names.length) return { offenders: [], observed: { mids: rows.length, accounts: 0 }, expected: 0, absent: false, population: { total: rows.length, judged: 0, unit: 'MID accounts', basis: 'no MID reports its instance user name' } };
    const users = await rowsOf(ctx, { table: 'sys_user', fields: ['user_name'], query: `user_nameIN${names.join(',')}` });
    if (users.unavailable) return users;
    const idByName = new Map(users.rows.map((u) => [String(u.user_name), u.sys_id]));
    const ids = [...idByName.values()];
    const roles = ids.length ? await rowsOf(ctx, { table: 'sys_user_has_role', fields: ['user', 'role.name'], query: `userIN${ids.join(',')}^role.name=${role}` }) : { rows: [] };
    if (roles.unavailable) return roles;
    const admins = new Set(roles.rows.map((r) => ref(r.user)));
    const offenders = rows.filter((m) => admins.has(idByName.get(String(m.user_name || '').trim()))).map((m) => ({ sys_id: m.sys_id, field: 'user_name', value: `${m.name}: account ${m.user_name} holds ${role}` }));
    return { offenders, observed: { accounts: names.length, resolved: ids.length, admin: offenders.length }, expected: 0, absent: false, coverage: users.coverage,
      population: { total: names.length, judged: ids.length, unit: 'MID accounts', basis: 'MID instance accounts resolved to a user record' } };
  },

  /** ITOM-066 — MIDs silent beyond `silence` whose host has no live CI (absent, or retired). */
  itom_orphan_mid: ({ silence, retired_values }) => async (rows, ctx) => {
    const cutoff = ctx.run.window(silence).start;
    const silent = rows.filter((m) => { const t = fromSnowTime(m.last_refreshed); return !t || t < cutoff; });
    const hosts = [...new Set(silent.map((m) => String(m.host_name || '').trim()).filter(Boolean))];
    /* Every MID was judged on its heartbeat; only a silent one can be orphaned. */
    const population = { total: rows.length, judged: rows.length, unit: 'MID servers', basis: `MIDs, tested for no heartbeat in ${silence} and a live host CI` };
    if (!hosts.length) return { offenders: [], observed: { silent: silent.length }, expected: 0, absent: false, population };
    const cis = await rowsOf(ctx, { table: 'cmdb_ci', fields: ['name', 'install_status'], query: `nameIN${hosts.join(',')}`, complete: true });
    if (cis.unavailable) return cis;
    const live = new Set(cis.rows.filter((c) => !retired_values.map(String).includes(String(c.install_status))).map((c) => String(c.name).toLowerCase()));
    const offenders = silent.filter((m) => !live.has(String(m.host_name || '').trim().toLowerCase())).map((m) => ({ sys_id: m.sys_id, field: 'last_refreshed', value: `${m.name}: silent since ${m.last_refreshed || 'never'}; host ${m.host_name || 'unknown'} has no live CI` }));
    return { offenders, observed: { silent: silent.length, orphaned: offenders.length }, expected: 0, absent: false, coverage: cis.coverage, population };
  },

  /**
   * ITOM-067 — Business Critical services with no map (no service-CI association),
   * as a share of Business Critical services. `rows` are the BC services.
   */
  itom_services_unmapped: ({ threshold = null }) => async (rows, ctx) => {
    if (!rows.length) return { offenders: [], observed: { services: 0 }, expected: 0, absent: false, population: { total: 0, judged: 0, unit: 'services', basis: 'services in scope' } };
    const assoc = await countsBy(ctx, { table: 'svc_ci_assoc', query: `service_idIN${rows.map((s) => s.sys_id).join(',')}`, groupBy: ['service_id'] });
    if (assoc.unavailable) return assoc;
    const mapped = new Set(assoc.groups.filter((g) => g.count > 0).map((g) => String(ref(g.group.service_id))));
    const unmapped = rows.filter((s) => !mapped.has(s.sys_id));
    const pct = round1((100 * unmapped.length) / rows.length);
    const breach = threshold == null ? unmapped.length > 0 : pct > threshold;
    return { offenders: breach ? unmapped.map((s) => ({ sys_id: s.sys_id, field: 'map', value: `${s.name}: no mapped CI` })) : [], observed: { services: rows.length, unmapped: unmapped.length, unmapped_pct: pct }, expected: threshold == null ? 0 : `≤ ${threshold}%`, absent: false, coverage: assoc.coverage,
      kpi: { numerator: rows.length - unmapped.length, denominator: rows.length }, population: { total: rows.length, judged: rows.length, unit: 'services', basis: 'services in scope and their service-CI associations' } };
  },

  /** ITOM-077 — mapped services whose map holds no network-class CI; the estate ratio is the observation. */
  itom_maps_without_network_tier: ({ network_root = 'cmdb_ci_netgear' }) => async (rows, ctx) => {
    if (!rows.length) return { offenders: [], observed: { mapped_services: 0 }, expected: 0, absent: false, population: { total: 0, judged: 0, unit: 'mapped services', basis: 'services with at least one mapped CI' } };
    const assoc = await rowsOf(ctx, { table: 'svc_ci_assoc', fields: ['service_id', 'ci_id', 'ci_id.sys_class_name'], query: `service_idIN${rows.map((s) => s.sys_id).join(',')}` });
    if (assoc.unavailable) return assoc;
    const classes = await rowsOf(ctx, { table: 'sys_db_object', fields: ['name', 'super_class.name'], query: 'nameSTARTSWITHcmdb_ci', complete: true });
    if (classes.unavailable) return classes;
    const parent = new Map(classes.rows.map((c) => [c.name, c['super_class.name']]));
    const isNetwork = (cls) => { for (let c = cls, i = 0; c && i < 20; c = parent.get(c), i++) if (c === network_root) return true; return false; };
    const byService = new Map();
    for (const a of assoc.rows) { const s = ref(a.service_id); if (!s) continue; if (!byService.has(s)) byService.set(s, []); byService.get(s).push(a['ci_id.sys_class_name']); }
    const mapped = rows.filter((s) => (byService.get(s.sys_id) || []).length);
    const offenders = mapped.filter((s) => !(byService.get(s.sys_id) || []).some(isNetwork)).map((s) => ({ sys_id: s.sys_id, field: 'network_tier', value: `${s.name}: ${(byService.get(s.sys_id) || []).length} mapped CIs, none in the network tier` }));
    return { offenders, observed: { mapped_services: mapped.length, without_network: offenders.length, share_pct: mapped.length ? round1((100 * offenders.length) / mapped.length) : null }, expected: 0, absent: false, coverage: assoc.coverage,
      kpi: { numerator: mapped.length - offenders.length, denominator: mapped.length }, population: { total: rows.length, judged: mapped.length, unit: 'mapped services', basis: 'services with at least one mapped CI' } };
  },

  /** ITOM-096 — alerts whose bound CI has no relationship, as a share of alerts with a bound CI. `rows` are alerts with a CI. */
  itom_alerts_on_isolated_cis: ({ threshold, escalate_at = null }) => async (rows, ctx) => {
    const ciIds = [...new Set(rows.map((a) => ref(a.cmdb_ci)).filter(Boolean))];
    if (!ciIds.length) return { offenders: [], observed: { alerts: 0 }, expected: `≤ ${threshold}%`, absent: false, population: { total: 0, judged: 0, unit: 'alerts with a bound CI', basis: 'alerts bound to a CI' } };
    const withEdges = new Set();
    for (let i = 0; i < ciIds.length; i += 50) {
      const chunk = ciIds.slice(i, i + 50).join(',');
      for (const side of ['parent', 'child']) {
        const g = await countsBy(ctx, { table: 'cmdb_rel_ci', query: `${side}IN${chunk}`, groupBy: [side] });
        if (g.unavailable) return g;
        for (const x of g.groups) if (x.count > 0) withEdges.add(String(ref(x.group[side])));
      }
    }
    const isolated = rows.filter((a) => !withEdges.has(String(ref(a.cmdb_ci))));
    const pct = round1((100 * isolated.length) / rows.length);
    const breach = pct > threshold;
    return { offenders: breach ? isolated.map((a) => ({ sys_id: a.sys_id, field: 'cmdb_ci', value: `${a.number || a.sys_id}: bound CI ${ref(a.cmdb_ci)} has no relationship` })) : [],
      observed: { alerts: rows.length, isolated: isolated.length, isolated_pct: pct, escalated: escalate_at != null && pct > escalate_at }, expected: `≤ ${threshold}%`, absent: false,
      kpi: { numerator: rows.length - isolated.length, denominator: rows.length }, population: { total: rows.length, judged: rows.length, unit: 'alerts with a bound CI', basis: 'alerts bound to a CI, and that CI\'s relationships' } };
  },

  /** ITOM-117 — open alerts after which a CLEAR event with the same message key arrived. `rows` are open alerts. */
  itom_alerts_open_after_clear: ({ clear_severity }) => async (rows, ctx) => {
    const keys = [...new Set(rows.map((a) => String(a.message_key || '').trim()).filter(Boolean))];
    if (!keys.length) return { offenders: [], observed: { open_alerts: rows.length, with_key: 0 }, expected: 0, absent: false, population: { total: rows.length, judged: 0, unit: 'open alerts', basis: 'open alerts carrying a message key' } };
    const clears = [];
    for (let i = 0; i < keys.length; i += 50) {
      const r = await rowsOf(ctx, { table: 'em_event', fields: ['message_key', 'severity', 'time_of_event', 'sys_created_on'], query: `message_keyIN${keys.slice(i, i + 50).join(',')}^severity=${clear_severity}` });
      if (r.unavailable) return r;
      clears.push(...r.rows);
    }
    const lastClear = new Map();
    for (const e of clears) { const t = fromSnowTime(e.time_of_event) ?? fromSnowTime(e.sys_created_on); const k = String(e.message_key); if (t && (!lastClear.has(k) || lastClear.get(k) < t)) lastClear.set(k, t); }
    const judged = rows.filter((a) => !isEmpty(a.message_key));
    const offenders = judged.filter((a) => { const c = lastClear.get(String(a.message_key).trim()); const t = fromSnowTime(a.sys_created_on); return c && t && c > t; })
      .map((a) => ({ sys_id: a.sys_id, field: 'state', value: `${a.number || a.sys_id}: still open after a clear event for ${a.message_key}` }));
    return { offenders, observed: { open_alerts: rows.length, with_key: judged.length, open_after_clear: offenders.length }, expected: 0, absent: false,
      population: { total: rows.length, judged: judged.length, unit: 'open alerts', basis: 'open alerts carrying a message key' } };
  },

  /** ITOM-125 — CIs of the configured cloud classes with no service association and no relationship to a service. `rows` are those CIs. */
  itom_cloud_ci_unlinked: () => async (rows, ctx) => {
    if (!rows.length) return { offenders: [], observed: { cloud_cis: 0 }, expected: 0, absent: false, population: { total: 0, judged: 0, unit: 'cloud CIs', basis: 'CIs of the configured cloud classes' } };
    const linked = new Set();
    const ids = rows.map((c) => c.sys_id);
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50).join(',');
      const a = await countsBy(ctx, { table: 'svc_ci_assoc', query: `ci_idIN${chunk}`, groupBy: ['ci_id'] });
      if (a.unavailable) return a;
      for (const g of a.groups) if (g.count > 0) linked.add(String(ref(g.group.ci_id)));
    }
    const offenders = rows.filter((c) => !linked.has(c.sys_id)).map((c) => ({ sys_id: c.sys_id, field: 'service', value: `${c.name || c.sys_id} (${c.sys_class_name}): no service association` }));
    return { offenders, observed: { cloud_cis: rows.length, unlinked: offenders.length }, expected: 0, absent: false,
      population: { total: rows.length, judged: rows.length, unit: 'cloud CIs', basis: 'CIs of the configured cloud classes and their service associations' } };
  },

  /* ── Phase 5E: readers over objects verified on a real instance ─────────── */

  /** ITOM-074 — application services with an entry point (sa_m2m_service_entry_point) and no mapped CI (svc_ci_assoc). `rows` are the entry-point links. */
  itom_entry_point_unmapped: () => async (rows, ctx) => {
    const services = [...new Set(rows.map((r) => ref(r.cmdb_ci_service)).filter(Boolean))];
    if (!services.length) return { offenders: [], observed: { services_with_entry_points: 0 }, expected: 0, absent: false, population: { total: 0, judged: 0, unit: 'services with an entry point', basis: 'application services with at least one entry point' } };
    const assoc = await countsBy(ctx, { table: 'svc_ci_assoc', query: `service_idIN${services.join(',')}`, groupBy: ['service_id'] });
    if (assoc.unavailable) return assoc;
    const mapped = new Set(assoc.groups.filter((g) => g.count > 0).map((g) => String(ref(g.group.service_id))));
    const offenders = services.filter((s) => !mapped.has(s)).map((s) => ({ sys_id: s, field: 'mapped_cis', value: 'entry point defined, zero mapped CIs' }));
    return { offenders, observed: { services_with_entry_points: services.length, unmapped: offenders.length }, expected: 0, absent: false, coverage: assoc.coverage,
      population: { total: services.length, judged: services.length, unit: 'services with an entry point', basis: 'application services with at least one entry point, and their mapped CIs' } };
  },

  /** ITOM-083 — one entry point linked to more than one application service. `rows` are the entry-point links. */
  itom_entry_point_shared: () => async (rows) => {
    const byEndpoint = new Map();
    for (const r of rows) { const e = ref(r.cmdb_ci_endpoint); const s = ref(r.cmdb_ci_service); if (!e || !s) continue; if (!byEndpoint.has(e)) byEndpoint.set(e, new Set()); byEndpoint.get(e).add(s); }
    const offenders = [...byEndpoint.entries()].filter(([, s]) => s.size > 1).map(([e, s]) => ({ sys_id: e, field: 'cmdb_ci_service', value: `entry point on ${s.size} services` }));
    return { offenders, observed: { entry_points: byEndpoint.size, shared: offenders.length }, expected: 0, absent: false,
      population: { total: byEndpoint.size, judged: byEndpoint.size, unit: 'entry points', basis: 'entry-point records and the services that name them' } };
  },

  /**
   * ITOM-084 / ITOM-086 — active connectors (em_connector_instance) whose last run
   * is older than `tolerance` × their own interval (`schedule`, seconds), or which
   * never ran; ITOM-084 also charges a connector whose last status is the error
   * value. `healthy_only` (086) judges only connectors whose status is not the error.
   */
  itom_connector_stale: ({ error_status, tolerance, healthy_only = false }) => async (rows, ctx) => {
    const now = ctx.run.now ?? new Date(ctx.run.run_started_at);
    const offenders = []; let judged = 0;
    for (const c of rows) {
      const erred = String(c.last_status) === String(error_status);
      if (healthy_only && erred) continue;
      const interval = Number(c.schedule);
      if (!erred && !(interval > 0)) continue;
      judged += 1;
      if (!healthy_only && erred) { offenders.push({ sys_id: c.sys_id, field: 'last_status', value: `${c.name}: last run ended in error${c.last_error_message ? ` — ${String(c.last_error_message).slice(0, 120)}` : ''}` }); continue; }
      const last = fromSnowTime(c.last_run_time);
      if (!last) { offenders.push({ sys_id: c.sys_id, field: 'last_run_time', value: `${c.name}: has never run (interval ${interval}s)` }); continue; }
      if (now.getTime() - last.getTime() > tolerance * interval * 1000) offenders.push({ sys_id: c.sys_id, field: 'last_run_time', value: `${c.name}: last ran ${c.last_run_time} — interval ${interval}s × ${tolerance}` });
    }
    return { offenders, observed: { connectors: rows.length, judged, overdue_or_erroring: offenders.length }, expected: 0, absent: false,
      population: { total: rows.length, judged, unit: 'active connectors', basis: healthy_only ? 'active connectors not in error, with an interval' : 'active connectors with an interval, or in error' } };
  },

  /**
   * ITOM-106 — Critical alerts bound to a CI whose impact tree names no business
   * service (em_impact_status: element_id → business_service), as a share of
   * Critical alerts with a bound CI. `rows` are those alerts.
   */
  itom_impact_without_service: ({ threshold, escalate_at = null }) => async (rows, ctx) => {
    const cis = [...new Set(rows.map((a) => ref(a.cmdb_ci)).filter(Boolean))];
    if (!cis.length) return { offenders: [], observed: { critical_alerts: 0 }, expected: `≤ ${threshold}%`, absent: false, population: { total: 0, judged: 0, unit: 'Critical alerts with a bound CI', basis: 'Critical alerts bound to a CI' } };
    const withService = new Set();
    for (let i = 0; i < cis.length; i += 50) {
      const g = await countsBy(ctx, { table: 'em_impact_status', query: `element_idIN${cis.slice(i, i + 50).join(',')}^business_serviceISNOTEMPTY`, groupBy: ['element_id'] });
      if (g.unavailable) return g;
      for (const x of g.groups) if (x.count > 0) withService.add(String(ref(x.group.element_id)));
    }
    const empty = rows.filter((a) => !withService.has(String(ref(a.cmdb_ci))));
    const pct = round1((100 * empty.length) / rows.length);
    return { offenders: pct > threshold ? empty.map((a) => ({ sys_id: a.sys_id, field: 'impact', value: `${a.number || a.sys_id}: no affected business service` })) : [],
      observed: { critical_alerts: rows.length, without_service: empty.length, pct, escalated: escalate_at != null && pct > escalate_at }, expected: `≤ ${threshold}%`, absent: false,
      kpi: { numerator: rows.length - empty.length, denominator: rows.length }, population: { total: rows.length, judged: rows.length, unit: 'Critical alerts with a bound CI', basis: 'Critical alerts bound to a CI, and the business services its impact tree names' } };
  },

  /** ITOM-107 — alerts exist, and no impact record names any business service: impact is never populated. `rows` are alerts. */
  itom_impact_never_populated: () => async (rows, ctx) => {
    if (!rows.length) return { offenders: [], observed: { alerts: 0 }, expected: '> 0', absent: false, population: { total: 0, judged: 0, unit: 'alerts', basis: 'alerts in scope' } };
    const g = await countsBy(ctx, { table: 'em_impact_status', query: 'business_serviceISNOTEMPTY', groupBy: [] });
    if (g.unavailable) return g;
    return { offenders: [], observed: { alerts: rows.length, impact_rows_with_service: g.total }, expected: '> 0', absent: g.total === 0, coverage: g.coverage,
      population: { total: rows.length, judged: rows.length, unit: 'alerts', basis: 'the whole alert population against impact records naming a business service' } };
  },
});
