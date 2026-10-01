import { declareRequirement } from '../itsm/data-access.js';
import { fromSnowTime } from '../itsm/run-context.js';
import { trend } from '../itsm/engines/aggregate.js';
import { lex, SCRIPT_CHECKS } from './comparators.js';
import { authored, currentFlows, decodeInputs } from './research-comparators.js';
import { ancestors } from '../csdm/comparators.js';

/**
 * D-037 — the Platform rules that needed code analysis, schedule-aware SLA state or a
 * trend: script queries, rule ordering and recursion, script-include usage, client
 * scripts against form layouts and server enforcement, flow error handling and
 * hard-coded values, stuck SLA timers, commitment durations, and three trends.
 * Same contract as every comparator.
 *
 * SCOPE: script and flow rules judge CUSTOMER-authored records, as the other script
 * rules do (D-024: a sys_update_xml row names the record; flows: author "Custom" in
 * sys_metadata_customization, as PLT-102). Script analysis is lexical (comments
 * removed, strings kept apart — `lex`), not a parser: what it cannot see (a table name
 * built at run time, a call through a variable) is not judged, and each rule says so.
 *
 * TRENDS read this instance's earlier readings of the same rule under the same
 * configuration (`history`, D-037) and use the engine's own trend (least-squares
 * direction over the readings, aggregate.js).
 */

const COMPLETE = 'complete';
const usable = (cov) => ['complete', 'limited', 'truncated'].includes(cov?.status);
const isEmpty = (v) => v === undefined || v === null || String(v).trim() === '';
const ref = (v) => (v && typeof v === 'object' ? v.value ?? v.sys_id ?? null : v);
const truthy = (v) => ['true', '1', 'yes'].includes(String(v).toLowerCase());
const chunks = (xs, n = 100) => { const out = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };
const round1 = (n) => Number(n.toFixed(1));
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pop = (total, judged, unit, basis, extra = {}) => ({ total, judged, unit, basis, ...extra });
const offender = (sys_id, field, value) => ({ sys_id, field, value });

async function rowsOf(ctx, { table, fields, query = '', complete = false }) {
  const r = await ctx.reads.read(declareRequirement({ table, fields, query, strategy: 'rows' }));
  if (!(complete ? r.coverage?.status === COMPLETE : usable(r.coverage))) return { unavailable: `${table} could not be read${complete ? ' completely' : ''} (${r.coverage?.status}${r.coverage?.error ? `: ${r.coverage.error}` : ''}) — no claim is made from a partial read`, coverage: r.coverage };
  const unread = r.coverage?.totalKnown != null ? Math.max(0, r.coverage.totalKnown - (r.coverage.rowsFetched ?? r.rows.length)) : 0;
  return { rows: r.rows, unread };
}
async function countsBy(ctx, { table, query = '', groupBy }) {
  const r = await ctx.reads.read(declareRequirement({ table, query, strategy: 'aggregate', groupBy }));
  if (r.coverage?.status !== COMPLETE) return { unavailable: `aggregate over ${table} failed (${r.coverage?.status})` };
  return { groups: r.groups, total: r.groups.reduce((n, g) => n + g.count, 0) };
}
async function countOf(ctx, { table, query = '' }) {
  const r = await ctx.reads.read(declareRequirement({ table, query, strategy: 'exists' }));
  if (r.count == null) return { unavailable: `count over ${table} failed (${r.coverage?.status})` };
  return { count: r.count };
}
async function inChunks(ctx, { table, fields, field, ids, extra = '', complete = false }) {
  const out = []; let unread = 0;
  for (const c of chunks([...new Set(ids)].filter(Boolean))) {
    const r = await rowsOf(ctx, { table, fields, query: `${field}IN${c.join(',')}${extra ? `^${extra}` : ''}`, complete });
    if (r.unavailable) return r;
    out.push(...r.rows); unread += r.unread;
  }
  return { rows: out, unread };
}
const shared = (ctx, key, build) => (ctx.shared?.getOrBuild ? ctx.shared.getOrBuild(key, build) : build());

/** The customer-authored sys_ids of `table` (D-024: sys_update_xml rows named `<table>_<sys_id>`), one aggregate. */
async function customerIds(ctx, table) {
  return shared(ctx, `plt:customer:${table}`, async () => {
    const g = await countsBy(ctx, { table: 'sys_update_xml', query: `nameSTARTSWITH${table}_`, groupBy: ['name'] });
    if (g.unavailable) return g;
    const re = new RegExp(`^${table}_([0-9a-f]{32})$`);
    return { ids: new Set(g.groups.map((x) => re.exec(String(x.group.name))?.[1]).filter(Boolean)) };
  });
}
/** The customer-authored records of `table` with `fields`, narrowed by `query`. */
async function customerRecords(ctx, table, fields, query = 'active=true') {
  const own = await customerIds(ctx, table); if (own.unavailable) return own;
  const r = await inChunks(ctx, { table, fields, field: 'sys_id', ids: [...own.ids], extra: query });
  if (r.unavailable) return r;
  return { rows: r.rows, customer: own.ids.size, unread: r.unread };
}

/* ── script analysis ─────────────────────────────────────────────────────── */

/** Methods that narrow or bound a GlideRecord query (a query with any of them is not "unbounded"). */
const BOUNDING = ['setLimit', 'get', 'addQuery', 'addEncodedQuery', 'addActiveQuery', 'addInactiveQuery', 'addNullQuery', 'addNotNullQuery', 'addJoinQuery', 'chooseWindow', 'addDomainQuery'];
/**
 * GlideRecord queries in a script that name their table as a literal and are run with
 * no bound or condition at all: `[{ variable, table }]`. A query built on a variable
 * table, or narrowed in any way, is not reported.
 */
export function unboundedQueries(raw) {
  const src = String(raw ?? '');
  const { code } = lex(src);
  const out = [];
  const re = /\b([A-Za-z_$][\w$]*)\s*=\s*new\s+GlideRecord(?:Secure)?\s*\(\s*(['"])/g;
  let m;
  while ((m = re.exec(code))) {
    const q = m.index + m[0].length - 1;
    const end = src.indexOf(src[q], q + 1);
    if (end < 0) continue;
    const table = src.slice(q + 1, end).trim();
    if (!/^[a-z0-9_]+$/.test(table)) continue;
    const call = (fn) => new RegExp(`(^|[^\\w$])${esc(m[1])}\\s*\\.\\s*${fn}\\s*\\(`).test(code);
    if (!call('query') || BOUNDING.some(call)) continue;
    out.push({ variable: m[1], table });
  }
  return out;
}

const GFORM_FIELD = /\bg_form\s*\.\s*(getValue|setValue|setMandatory|setDisplay|setVisible|setReadOnly|setDisabled|getReference|getControl|showFieldMsg|hideFieldMsg|showErrorBox|hideErrorBox|addOption|clearOptions|removeOption|getIntValue|getBooleanValue|getDecimalValue|getDisplayValue|flash|clearValue|isMandatory|getLabelOf|setLabelOf|addDecoration|removeDecoration)\s*\(\s*(['"])([\w.]+)\2/g;
const GFORM_READ = new Set(['getValue', 'getReference', 'getIntValue', 'getBooleanValue', 'getDecimalValue', 'getDisplayValue', 'showFieldMsg', 'showErrorBox', 'isMandatory']);
/** The form fields a client script names through g_form: `{ all, read }` (Sets). Variables and dot-walks are left out. */
export function clientFields(raw) {
  const all = new Set(); const read = new Set();
  const { code } = lex(raw);
  for (const m of String(raw ?? '').matchAll(GFORM_FIELD)) {
    if (!code.slice(m.index, m.index + 6).startsWith('g_form')) continue;   // inside a comment or string (lex blanks those)
    const f = m[3];
    if (f.includes('.') || f.startsWith('variables') || f.startsWith('IO:') || f.startsWith('sys_display')) continue;
    all.add(f);
    if (GFORM_READ.has(m[1])) read.add(f);
  }
  return { all, read };
}

const GR_METHOD = /^(update|insert|deleteRecord|setValue|getValue|getDisplayValue|getUniqueValue|isNewRecord|operation|setAbortAction|setWorkflow|getTableName|getElement|isValidRecord|getRecordClassName|addErrorMessage|addInfoMessage|canRead|canWrite|changes|changesTo|changesFrom|nil|getED|isValid)$/;
/** The `current` fields a business rule script reads and writes (lexical). */
export function currentFieldUse(raw) {
  const src = String(raw ?? '');
  const { code } = lex(src);
  const reads = new Set(); const writes = new Set();
  for (const m of code.matchAll(/\bcurrent\s*\.\s*([a-z_][\w]*)\b(\s*\()?/g)) {
    if (m[2] || GR_METHOD.test(m[1])) continue;
    const after = code.slice(m.index + m[0].length).match(/^\s*(=(?!=)|[.(])?/)?.[1];
    if (after === '=') writes.add(m[1]); else reads.add(m[1]);
  }
  for (const m of src.matchAll(/\bcurrent\s*\.\s*(getValue|getDisplayValue|setValue)\s*\(\s*(['"])(\w+)\2/g)) {
    if (!code.slice(m.index, m.index + 7).startsWith('current')) continue;
    (m[1] === 'setValue' ? writes : reads).add(m[3]);
  }
  return { reads, writes };
}

/** Field names in an encoded query (clauses split on ^, ^OR, ^NQ; the leading field of each). */
function conditionMentions(encoded, field) {
  return String(encoded ?? '').split(/\^(?:NQ|OR)?/).some((c) => new RegExp(`^${esc(field)}(?=[^a-z0-9_]|$)`).test(c.trim()));
}

/** Jaccard similarity of two token-shingle sets. */
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0; for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}
function shingles(raw, k = 5) {
  const toks = lex(raw).code.match(/[A-Za-z_$][\w$]*|\d+|[^\s\w]/g) || [];
  const out = new Set();
  for (let i = 0; i + k <= toks.length; i += 1) out.add(toks.slice(i, i + k).join(' '));
  return out;
}

/* ── references to script includes ───────────────────────────────────────── */

/** Where a script include can be named: every script field of the platform's script tables. */
export const REFERENCE_SOURCES = Object.freeze([
  ['sys_script', 'script'], ['sys_script_include', 'script'], ['sys_script_client', 'script'], ['sys_ui_action', 'script'],
  ['sysauto_script', 'script'], ['sys_ws_operation', 'operation_script'], ['sys_ui_page', 'processing_script'], ['sys_ui_page', 'client_script'],
  ['sys_ui_macro', 'xml'], ['sp_widget', 'script'], ['sp_widget', 'client_script'], ['sys_security_acl', 'script'], ['sys_script_fix', 'script'],
  ['sys_processor', 'script'], ['sys_transform_script', 'script'], ['sys_transform_map', 'script'], ['sysevent_script_action', 'script'],
  ['sys_ui_script', 'script'], ['catalog_script_client', 'script'],
]);

/** The customer-authored active script includes (shared by PLT-066 / 068 / 069 / 071). */
async function customerIncludes(ctx) {
  return shared(ctx, 'plt:customer-includes', () => customerRecords(ctx, 'sys_script_include', ['name', 'api_name', 'access', 'script', 'client_callable', 'sys_scope', 'sys_created_on']));
}
/**
 * Every script that names one of `includes` as a word: name → [{ table, sys_id, scope }].
 * The instance narrows by LIKE; each hit is confirmed on word boundaries. A source table
 * that cannot be read is listed in `unread_sources`, never read as "no reference".
 */
async function referencesTo(ctx, includes) {
  return shared(ctx, 'plt:include-references', async () => {
    const names = [...new Set(includes.map((i) => i.name).filter((n) => /^[A-Za-z_$][\w$]*$/.test(String(n ?? ''))))];
    const refs = new Map(names.map((n) => [n, []]));
    const unreadSources = []; let unreadRows = 0;
    for (const [table, field] of REFERENCE_SOURCES) {
      let failed = false;
      /* 50 names per query: each LIKE is a full scan of the table on the instance, so fewer queries is what costs less. */
      for (const c of chunks(names, 50)) {
        const r = await rowsOf(ctx, { table, fields: [field, 'sys_scope'], query: c.map((n) => `${field}LIKE${n}`).join('^OR') });
        if (r.unavailable) { failed = true; break; }
        unreadRows += r.unread;
        for (const row of r.rows) {
          const text = String(row[field] ?? '');
          for (const n of c) if (new RegExp(`(^|[^\\w$])${esc(n)}([^\\w$]|$)`).test(text)) refs.get(n).push({ table, sys_id: row.sys_id, scope: String(ref(row.sys_scope) ?? '') });
        }
      }
      if (failed) unreadSources.push(`${table}.${field}`);
    }
    return { refs, unread_sources: unreadSources, unread_rows: unreadRows };
  });
}
const othersOf = (refs, inc) => (refs.get(inc.name) || []).filter((x) => !(x.table === 'sys_script_include' && x.sys_id === inc.sys_id));

/* ── the comparators ─────────────────────────────────────────────────────── */

export const PLATFORM_ANALYSIS_COMPARATORS = Object.freeze({
  /**
   * PLT-039 / PLT-108 — customer scripts that query a table of at least `min_rows` rows
   * with no setLimit, no get() and no condition. `sources`: [[table, script field]].
   */
  plt_unbounded_queries: ({ sources, min_rows }) => async (_rows, ctx) => {
    const found = []; let scripts = 0; let customer = 0;
    for (const [table, field] of sources) {
      const got = await customerRecords(ctx, table, ['name', field]); if (got.unavailable) return got;
      scripts += got.rows.length; customer += got.customer;
      for (const r of got.rows) for (const q of unboundedQueries(r[field])) found.push({ source: table, row: r, ...q });
    }
    const size = new Map();
    for (const t of [...new Set(found.map((f) => f.table))]) { const n = await countOf(ctx, { table: t }); size.set(t, n.unavailable ? null : n.count); }
    const offenders = found.filter((f) => size.get(f.table) >= min_rows)
      .map((f) => offender(f.row.sys_id, 'script', `${f.row.name || f.row.sys_id} (${f.source}): queries ${f.table} (${size.get(f.table).toLocaleString('en-US')} rows) with no setLimit and no condition`));
    return { offenders, observed: { customer_scripts: scripts, unbounded_queries: found.length, on_large_tables: offenders.length, tables_counted: size.size }, expected: 0, absent: false,
      population: pop(scripts, scripts, 'active customer-authored scripts', `GlideRecord queries on a literal table, against the table's row count (≥ ${min_rows.toLocaleString('en-US')})`) };
  },

  /** PLT-041 — before rules on one table where a rule reads a `current` field that a later-ordered rule writes. */
  plt_rule_ordering: () => async (_rows, ctx) => {
    const own = await customerIds(ctx, 'sys_script'); if (own.unavailable) return own;
    const mine = await inChunks(ctx, { table: 'sys_script', fields: ['collection'], field: 'sys_id', ids: [...own.ids], extra: 'active=true^when=before' });
    if (mine.unavailable) return mine;
    const tables = [...new Set(mine.rows.map((r) => r.collection).filter(Boolean))];
    const all = await inChunks(ctx, { table: 'sys_script', fields: ['name', 'collection', 'order', 'script', 'condition', 'action_insert', 'action_update'], field: 'collection', ids: tables, extra: 'active=true^when=before' });
    if (all.unavailable) return all;
    const use = new Map(all.rows.map((r) => [r.sys_id, currentFieldUse(`${r.script ?? ''}\n${r.condition ?? ''}`)]));
    const offenders = [];
    for (const t of tables) {
      const rules = all.rows.filter((r) => r.collection === t);
      for (const a of rules) for (const b of rules) {
        if (a === b || !(own.ids.has(a.sys_id) || own.ids.has(b.sys_id))) continue;
        if (!(Number(a.order) < Number(b.order))) continue;
        if (!((truthy(a.action_insert) && truthy(b.action_insert)) || (truthy(a.action_update) && truthy(b.action_update)))) continue;
        const f = [...use.get(a.sys_id).reads].find((x) => use.get(b.sys_id).writes.has(x) && !use.get(a.sys_id).writes.has(x));
        if (f) offenders.push(offender(a.sys_id, 'order', `${t}: "${a.name}" (order ${a.order}) reads ${f} before "${b.name}" (order ${b.order}) writes it`));
      }
    }
    return { offenders, observed: { tables: tables.length, before_rules: all.rows.length, dependent_pairs_out_of_order: offenders.length }, expected: 0, absent: false,
      population: pop(tables.length, tables.length, 'tables with a customer before rule', 'active before rules on the table, current-field reads and writes (lexical), by order') };
  },

  /** PLT-045 — customer after/async update rules that call current.update() and whose own trigger their writes satisfy. */
  plt_rule_recursion: () => async (_rows, ctx) => {
    const got = await customerRecords(ctx, 'sys_script', ['name', 'collection', 'when', 'script', 'condition', 'filter_condition', 'action_update'], 'active=true^action_update=true^whenINafter,async,async_always');
    if (got.unavailable) return got;
    const offenders = [];
    for (const r of got.rows) {
      const { code } = lex(r.script);
      if (!/\bcurrent\s*\.\s*update\s*\(/.test(code) || /\.setWorkflow\s*\(\s*false\s*\)/.test(code)) continue;
      const writes = [...currentFieldUse(r.script).writes];
      const unconditioned = isEmpty(r.filter_condition) && isEmpty(r.condition);
      const hit = writes.find((f) => conditionMentions(r.filter_condition, f) || new RegExp(`\\bcurrent\\s*\\.\\s*${esc(f)}\\b`).test(String(r.condition ?? '')));
      if (unconditioned || hit) offenders.push(offender(r.sys_id, 'script', `${r.name} (${r.collection}, ${r.when}): current.update() re-fires it — ${unconditioned ? 'no condition' : `it writes ${hit}, which its condition reads`}`));
    }
    return { offenders, observed: { customer_update_rules: got.rows.length, recursive: offenders.length }, expected: 0, absent: false,
      population: pop(got.rows.length, got.rows.length, 'active customer after / async update rules', 'current.update() without setWorkflow(false), against the rule\'s own condition') };
  },

  /** PLT-066 — customer includes accessible from all scopes whose callers sit in one or two scopes. */
  plt_include_scope_callers: () => async (_rows, ctx) => {
    const inc = await customerIncludes(ctx); if (inc.unavailable) return inc;
    const refs = await referencesTo(ctx, inc.rows); if (refs.unavailable) return refs;
    const open = inc.rows.filter((i) => i.access === 'public');
    const judged = open.filter((i) => othersOf(refs.refs, i).length);
    const offenders = judged.filter((i) => new Set(othersOf(refs.refs, i).map((x) => x.scope)).size <= 2)
      .map((i) => { const s = [...new Set(othersOf(refs.refs, i).map((x) => x.scope))]; return offender(i.sys_id, 'access', `${i.name}: accessible from all application scopes, called only from ${s.length} scope${s.length === 1 ? '' : 's'} (${s.join(', ')})`); });
    return { offenders, observed: { customer_includes: inc.rows.length, all_scopes: open.length, with_callers: judged.length, confined: offenders.length, unread_sources: refs.unread_sources }, expected: 0, absent: false,
      population: pop(open.length, judged.length, 'customer includes accessible from all scopes', 'callers found in the platform\'s script fields, grouped by application scope; an include with no caller is PLT-069\'s', { determinate_when_empty: 'no all-scope include has a caller' }) };
  },

  /** PLT-068 — pairs of customer includes whose code is near-identical (token-shingle Jaccard ≥ `similarity`). */
  plt_include_similarity: ({ similarity }) => async (_rows, ctx) => {
    const inc = await customerIncludes(ctx); if (inc.unavailable) return inc;
    const bodies = inc.rows.filter((i) => !SCRIPT_CHECKS.empty_body(i, lex(i.script))).map((i) => ({ i, s: shingles(i.script) })).filter((x) => x.s.size);
    const offenders = [];
    for (let a = 0; a < bodies.length; a += 1) for (let b = a + 1; b < bodies.length; b += 1) {
      const j = jaccard(bodies[a].s, bodies[b].s);
      if (j >= similarity) offenders.push(offender(bodies[a].i.sys_id, 'script', `${bodies[a].i.name} and ${bodies[b].i.name}: ${Math.round(j * 100)}% similar`));
    }
    return { offenders, observed: { customer_includes: inc.rows.length, compared: bodies.length, near_identical_pairs: offenders.length }, expected: 0, absent: false,
      population: pop(bodies.length, bodies.length, 'customer includes with a body', `every pair, 5-token shingles, Jaccard ≥ ${similarity}`) };
  },

  /** PLT-069 — customer includes older than `min_age` days that nothing names. */
  plt_include_unreferenced: ({ min_age }) => async (_rows, ctx) => {
    const inc = await customerIncludes(ctx); if (inc.unavailable) return inc;
    const refs = await referencesTo(ctx, inc.rows); if (refs.unavailable) return refs;
    const now = new Date(ctx.run.run_started_at).getTime();
    const old = inc.rows.filter((i) => { const t = fromSnowTime(i.sys_created_on); return t && now - t > min_age * 86400000; });
    const offenders = old.filter((i) => !othersOf(refs.refs, i).length).map((i) => offender(i.sys_id, 'name', `${i.name}: no script names it (created ${String(i.sys_created_on).slice(0, 10)})`));
    return { offenders, observed: { customer_includes: inc.rows.length, older_than_threshold: old.length, unreferenced: offenders.length, unread_sources: refs.unread_sources }, expected: 0, absent: false,
      population: pop(old.length, old.length, `customer includes older than ${min_age} days`, `name searched in ${REFERENCE_SOURCES.length} script fields (static and by-name use, e.g. GlideAjax); flows and workflows are not read`) };
  },

  /** PLT-071 — cycles, or chains deeper than `max_depth`, in the customer include call graph. */
  plt_include_graph: ({ max_depth }) => async (_rows, ctx) => {
    const inc = await customerIncludes(ctx); if (inc.unavailable) return inc;
    const refs = await referencesTo(ctx, inc.rows); if (refs.unavailable) return refs;
    const ids = new Set(inc.rows.map((i) => i.sys_id));
    const name = new Map(inc.rows.map((i) => [i.sys_id, i.name]));
    const next = new Map(inc.rows.map((i) => [i.sys_id, new Set()]));
    for (const callee of inc.rows) for (const r of othersOf(refs.refs, callee)) if (r.table === 'sys_script_include' && ids.has(r.sys_id)) next.get(r.sys_id).add(callee.sys_id);
    /* Tarjan: components of two or more, or a self-call, are cycles. */
    let index = 0; const idx = new Map(); const low = new Map(); const stack = []; const on = new Set(); const comp = new Map(); const cycles = [];
    const visit = (v) => {
      idx.set(v, index); low.set(v, index); index += 1; stack.push(v); on.add(v);
      for (const w of next.get(v)) { if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w))); }
      if (low.get(v) === idx.get(v)) { const c = []; let w; do { w = stack.pop(); on.delete(w); c.push(w); comp.set(w, c); } while (w !== v); if (c.length > 1 || next.get(v).has(v)) cycles.push(c); }
    };
    for (const v of next.keys()) if (!idx.has(v)) visit(v);
    /* Longest chain (in includes) from each include, over the acyclic condensation. */
    const depth = new Map();
    const deep = (v, seen = new Set()) => {
      if (depth.has(v)) return depth.get(v);
      seen.add(v); let d = 1;
      for (const w of next.get(v)) if (!seen.has(w) && comp.get(w) !== comp.get(v)) d = Math.max(d, 1 + deep(w, seen));
      seen.delete(v); depth.set(v, d); return d;
    };
    for (const v of next.keys()) deep(v);
    const called = new Set([...next.values()].flatMap((s) => [...s]));
    const offenders = [
      ...cycles.map((c) => offender(c[0], 'script', `cycle: ${c.map((x) => name.get(x)).join(' → ')} → ${name.get(c[0])}`)),
      ...[...depth].filter(([v, d]) => d > max_depth && !called.has(v)).map(([v, d]) => offender(v, 'script', `${name.get(v)}: a call chain ${d} includes deep`)),
    ];
    return { offenders, observed: { customer_includes: ids.size, calls: [...next.values()].reduce((n, s) => n + s.size, 0), cycles: cycles.length, deepest: Math.max(0, ...depth.values()) }, expected: 0, absent: false,
      population: pop(ids.size, ids.size, 'customer includes', `calls between customer includes found in their scripts; depth > ${max_depth} or any cycle`) };
  },

  /** PLT-081 — customer client scripts naming fields that no form layout of their table shows. */
  plt_client_fields_off_form: () => async (_rows, ctx) => {
    const got = await customerRecords(ctx, 'sys_script_client', ['name', 'table', 'type', 'field', 'script']); if (got.unavailable) return got;
    const scripts = got.rows.filter((r) => !isEmpty(r.table));
    const ch = await ancestors(ctx, [...new Set(scripts.map((r) => r.table))]); if (ch.unavailable) return ch;
    const chainTables = [...new Set(scripts.flatMap((r) => ch.chains.get(r.table) || [r.table]))];
    const secs = await inChunks(ctx, { table: 'sys_ui_section', fields: ['name', 'view'], field: 'name', ids: chainTables }); if (secs.unavailable) return secs;
    /* sys_ui_element refuses paged reads (Pagination not supported): the layout is read as grouped counts. */
    const els = { rows: [], unread: 0 };
    for (const c of chunks(secs.rows.map((s) => s.sys_id))) {
      const g = await countsBy(ctx, { table: 'sys_ui_element', query: `sys_ui_sectionIN${c.join(',')}`, groupBy: ['sys_ui_section', 'element'] }); if (g.unavailable) return g;
      for (const x of g.groups) els.rows.push({ sys_ui_section: String(x.group.sys_ui_section), element: String(x.group.element) });
    }
    const secTable = new Map(secs.rows.map((s) => [s.sys_id, s.name]));
    const onForm = new Map();
    for (const e of els.rows) { const t = secTable.get(String(ref(e.sys_ui_section))); if (!onForm.has(t)) onForm.set(t, new Set()); onForm.get(t).add(e.element); }
    const layoutOf = (table) => (ch.chains.get(table) || [table]).find((t) => secs.rows.some((s) => s.name === t)) ?? null;
    const offenders = []; let judged = 0;
    for (const r of scripts) {
      const lt = layoutOf(r.table); if (!lt) continue;
      judged += 1;
      const names = clientFields(r.script).all;
      if (r.type === 'onChange' && !isEmpty(r.field)) names.add(r.field);
      const missing = [...names].filter((f) => !onForm.get(lt)?.has(f));
      if (missing.length) offenders.push(offender(r.sys_id, 'script', `${r.name} (${r.table}): ${missing.join(', ')} not on any ${lt} form view`));
    }
    return { offenders, observed: { customer_client_scripts: scripts.length, judged, off_form: offenders.length, unread_rows: (secs.unread || 0) + (els.unread || 0) }, expected: 0, absent: false,
      population: pop(scripts.length, judged, 'active customer client scripts', 'g_form field names against every view of the form layout of the script\'s table (or the nearest table it extends that has one)') };
  },

  /** PLT-083 — customer onSubmit validations (return false) whose fields have no data policy and no before rule that aborts on them. */
  plt_client_validation_unenforced: () => async (_rows, ctx) => {
    const got = await customerRecords(ctx, 'sys_script_client', ['name', 'table', 'type', 'script'], 'active=true^type=onSubmit'); if (got.unavailable) return got;
    const validations = got.rows.filter((r) => !isEmpty(r.table) && /\breturn\s+false\b/.test(lex(r.script).code) && clientFields(r.script).read.size);
    const ch = await ancestors(ctx, [...new Set(validations.map((r) => r.table))]); if (ch.unavailable) return ch;
    const tables = [...new Set(validations.flatMap((r) => ch.chains.get(r.table) || [r.table]))];
    const dp = await inChunks(ctx, { table: 'sys_data_policy_rule', fields: ['table', 'field', 'mandatory', 'disabled'], field: 'table', ids: tables }); if (dp.unavailable) return dp;
    const br = await inChunks(ctx, { table: 'sys_script', fields: ['collection', 'script'], field: 'collection', ids: tables, extra: 'active=true^when=before' }); if (br.unavailable) return br;
    const enforced = (table, f) => {
      const chain = ch.chains.get(table) || [table];
      if (dp.rows.some((d) => chain.includes(d.table) && d.field === f && (String(d.mandatory) === 'true' || String(d.disabled) === 'true'))) return true;
      return br.rows.some((b) => chain.includes(b.collection) && /setAbortAction\s*\(\s*true\s*\)/.test(String(b.script ?? '')) && new RegExp(`\\b${esc(f)}\\b`).test(String(b.script ?? '')));
    };
    const offenders = [];
    for (const r of validations) {
      const loose = [...clientFields(r.script).read].filter((f) => !enforced(r.table, f));
      if (loose.length) offenders.push(offender(r.sys_id, 'script', `${r.name} (${r.table}): validates ${loose.join(', ')} in the browser only — no data policy, no before rule that aborts`));
    }
    return { offenders, observed: { customer_onsubmit: got.rows.length, validating: validations.length, unenforced: offenders.length }, expected: 0, absent: false,
      population: pop(validations.length, validations.length, 'customer onSubmit validations', 'fields a validating script reads, against data policy rules (mandatory / read-only) and before rules that call setAbortAction(true) naming the field') };
  },

  /** PLT-094 — customer active flows whose current version has no Try / Catch or flow error handler. */
  plt_flow_error_handling: () => async (_rows, ctx) => {
    const own = await authored(ctx, 'sys_hub_flow', 'Custom'); if (own.unavailable) return own;
    const flows = await currentFlows(ctx); if (flows.unavailable) return flows;
    const mine = [...flows.byId.values()].filter((f) => own.ids.has(f.sys_id) && !isEmpty(ref(f.master_snapshot)));
    const defs = await rowsOf(ctx, { table: 'sys_hub_flow_logic_definition', fields: ['type'], query: 'typeINTRY,CATCH,TOP_LEVEL_TRY,TOP_LEVEL_CATCH' }); if (defs.unavailable) return defs;
    const handled = new Set();
    if (defs.rows.length && mine.length) {
      const li = await inChunks(ctx, { table: 'sys_hub_flow_logic_instance_v2', fields: ['flow'], field: 'flow', ids: mine.map((f) => String(ref(f.master_snapshot))), extra: `logic_definitionIN${defs.rows.map((d) => d.sys_id).join(',')}` });
      if (li.unavailable) return li;
      for (const l of li.rows) handled.add(flows.masterOf.get(String(ref(l.flow))));
    }
    const offenders = mine.filter((f) => !handled.has(f.sys_id)).map((f) => offender(f.sys_id, 'error_handling', `${f.name} (${f.type || 'flow'}): no Try / Catch and no flow error handler`));
    return { offenders, observed: { customer_flows: mine.length, with_error_handling: handled.size, without: offenders.length, unreadable_flows: flows.unread }, expected: 0, absent: false,
      population: pop(mine.length, mine.length, 'active customer-created flows and subflows', 'the current version\'s flow logic: Try, Catch, or the flow-level error handler (Top Level Try / Catch)') };
  },

  /** PLT-100 — customer active flows whose steps hold a credential, token or hard-coded endpoint. */
  plt_flow_hardcoded: () => async (_rows, ctx) => {
    const own = await authored(ctx, 'sys_hub_flow', 'Custom'); if (own.unavailable) return own;
    const flows = await currentFlows(ctx); if (flows.unavailable) return flows;
    const masters = [...flows.byId.values()].filter((f) => own.ids.has(f.sys_id) && !isEmpty(ref(f.master_snapshot))).map((f) => String(ref(f.master_snapshot)));
    const steps = [];
    /*
     * The step tables refuse paged reads of their input columns (Pagination not supported):
     * each read is a handful of flows that fits in ONE page. A page that comes back full may
     * have been cut, so the read is reported unavailable rather than judged.
     */
    const PAGE = 1000;
    for (const [table, field] of [['sys_hub_action_instance_v2', 'values'], ['sys_hub_action_instance', 'action_inputs']]) {
      let skip = false;
      for (const c of chunks(masters, 10)) {
        const r = await ctx.reads.read(declareRequirement({ table, fields: ['flow', field], query: `flowIN${c.join(',')}`, strategy: 'rows', pageSize: PAGE, maxRows: PAGE }));
        if (!usable(r.coverage)) { if (table === 'sys_hub_action_instance') { skip = true; break; } return { unavailable: `${table} could not be read (${r.coverage?.status}${r.coverage?.error ? `: ${r.coverage.error}` : ''})` }; }
        if (r.rows.length >= PAGE) return { unavailable: `${table}: ten flows hold ${PAGE}+ steps — more than one page, which the table does not allow` };
        for (const x of r.rows) steps.push({ flow: flows.masterOf.get(String(ref(x.flow))), inputs: decodeInputs(x[field]) || [] });
      }
      if (skip) continue;
    }
    const CRED_NAME = /(^|_)(password|passwd|pwd|secret|client_secret|api_?key|access_?token|auth_?token|token)$/i;
    const URL_NAME = /(^|_)(url|uri|endpoint|host|base_?url|rest_endpoint)$/i;
    const literal = (v) => !isEmpty(v) && !/\{\{[^}]*\}\}/.test(String(v));
    const hits = new Map();
    const note = (flow, what) => { if (!hits.has(flow)) hits.set(flow, new Set()); hits.get(flow).add(what); };
    for (const s of steps) {
      for (const inp of s.inputs) {
        const name = String(inp?.name ?? ''); const value = String(inp?.value ?? ''); const type = String(inp?.parameter?.type ?? '');
        if ((CRED_NAME.test(name) || /^password2?$/.test(type)) && literal(value)) note(s.flow, `a credential in "${name}"`);
        if (/^(basic|bearer)\s+[A-Za-z0-9+/=._-]{12,}$/i.test(value.trim()) || /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i.test(value.trim())) note(s.flow, `an embedded credential in "${name}"`);
        if (URL_NAME.test(name) && literal(value) && /^https?:\/\//i.test(value.trim())) note(s.flow, `a hard-coded endpoint in "${name}"`);
        if (type === 'script' && literal(value)) { const d = SCRIPT_CHECKS.credentials({}, lex(value)); if (d) note(s.flow, `a script step that ${d}`); }
      }
    }
    const offenders = [...hits].map(([id, what]) => offender(id, 'step', `${flows.byId.get(id)?.name ?? id}: ${[...what].join('; ')}`));
    return { offenders, observed: { customer_flows: masters.length, steps: steps.length, flows_with_hardcoded_values: offenders.length }, expected: 0, absent: false,
      population: pop(masters.length, masters.length, 'active customer-created flows and subflows', 'the step inputs of the current version: credential-named inputs, password inputs, Basic / Bearer values, URLs with credentials, literal endpoints, script steps') };
  },

  /**
   * PLT-017 — SLAs In progress past their planned end time and never marked breached:
   * the platform's own schedule expansion (planned_end_time, with pauses) says the
   * maximum has passed, and the timer has not recorded it. Paused SLAs are not In progress.
   */
  plt_sla_stuck: () => async (rows, ctx) => {
    const now = new Date(ctx.run.run_started_at).getTime();
    const judged = rows.filter((r) => fromSnowTime(r.planned_end_time));
    const offenders = judged.filter((r) => fromSnowTime(r.planned_end_time) < now && !truthy(r.has_breached))
      .map((r) => offender(r.sys_id, 'planned_end_time', `SLA on ${ref(r.task) ?? '?'}: planned end ${r.planned_end_time}, ${round1((now - fromSnowTime(r.planned_end_time)) / 3600000)} h ago, still In progress and not breached`));
    return { offenders, observed: { in_progress: rows.length, with_planned_end: judged.length, stuck: offenders.length }, expected: 0, absent: false,
      population: pop(rows.length, judged.length, 'SLAs in progress', 'planned_end_time is the SLA engine\'s own expansion of the definition\'s duration under its schedule; past it, the SLA must be breached') };
  },

  /**
   * PLT-030 — commitments that state their own duration, against the SLA they reference:
   * judged where both run on the same schedule (or both 24 × 7), so durations compare
   * directly. Different schedules are counted, not judged.
   */
  plt_commitment_duration: () => async (rows, ctx) => {
    const withTarget = rows.filter((c) => !isEmpty(ref(c.sla)) && !isEmpty(c.time_amount));
    const slas = await inChunks(ctx, { table: 'contract_sla', fields: ['name', 'duration', 'schedule'], field: 'sys_id', ids: withTarget.map((c) => String(ref(c.sla))) }); if (slas.unavailable) return slas;
    const byId = new Map(slas.rows.map((s) => [s.sys_id, s]));
    const ms = (d) => { const t = fromSnowTime(d); return t == null ? null : t - Date.UTC(1970, 0, 1); };
    const offenders = []; let judged = 0; let otherSchedule = 0;
    for (const c of withTarget) {
      const s = byId.get(String(ref(c.sla))); if (!s) continue;
      if (String(ref(c.schedule) ?? '') !== String(ref(s.schedule) ?? '')) { otherSchedule += 1; continue; }
      const a = ms(c.time_amount); const b = ms(s.duration); if (a == null || b == null) continue;
      judged += 1;
      if (a !== b) offenders.push(offender(c.sys_id, 'time_amount', `${c.name}: commitment ${round1(a / 3600000)} h, SLA "${s.name}" ${round1(b / 3600000)} h on the same schedule`));
    }
    return { offenders, observed: { commitments: rows.length, with_own_duration: withTarget.length, judged, different_schedules: otherSchedule, inconsistent: offenders.length }, expected: 0, absent: false,
      population: pop(withTarget.length, judged, 'commitments stating a duration for an SLA', 'same schedule (or both 24 × 7): durations compared directly; different schedules not judged', { determinate_when_empty: 'no commitment states its own duration' }) };
  },

  /** PLT-064 — customer business-rule count per table, trended over this instance's scans (≥ `min_windows`). */
  plt_rule_count_trend: ({ min_windows }) => async (_rows, ctx, run) => {
    const got = await customerRecords(ctx, 'sys_script', ['collection']); if (got.unavailable) return got;
    const per = {};
    for (const r of got.rows) if (!isEmpty(r.collection)) per[r.collection] = (per[r.collection] || 0) + 1;
    const measures = {}; const offenders = []; let judged = 0;
    for (const [t, n] of Object.entries(per)) {
      measures[t] = { value: n };
      const t2 = trend([...(run?.history?.(t) ?? []), { value: n, at: ctx.run.run_started_at }], { minWindows: min_windows });
      if (t2.status !== 'ok') continue;
      judged += 1;
      if (t2.direction === 'rising') offenders.push(offender(null, 'collection', `${t}: customer rules ${t2.first} → ${t2.last} over ${t2.windows} scans`));
    }
    return { offenders, measures, observed: { tables: Object.keys(per).length, trended: judged, growing: offenders.length }, expected: 'no table\'s rule count rising', absent: false,
      population: pop(Object.keys(per).length, judged, 'tables with customer business rules', `active customer rules per table, over at least ${min_windows} scans of this instance`, { determinate_when_empty: `fewer than ${min_windows} scans recorded` }) };
  },

  /**
   * PLT-105 — flow contexts not in a terminal state older than `max_age` days, and the
   * context table's growth since the previous scan above `growth` %.
   */
  plt_flow_context_accumulation: ({ max_age, growth }) => async (_rows, ctx, run) => {
    const total = await countOf(ctx, { table: 'sys_flow_context' }); if (total.unavailable) return total;
    const cutoff = new Date(new Date(ctx.run.run_started_at).getTime() - max_age * 86400000).toISOString().replace('T', ' ').slice(0, 19);
    const old = await countsBy(ctx, { table: 'sys_flow_context', query: `stateNOT INCOMPLETE,CANCELLED,ERROR^sys_created_on<${cutoff}`, groupBy: ['state'] }); if (old.unavailable) return old;
    const prev = (run?.history?.('') ?? []).slice(-1)[0];
    const rise = prev && prev.value > 0 ? (100 * (total.count - prev.value)) / prev.value : null;
    const offenders = [];
    if (old.total) offenders.push(offender(null, 'state', `${old.total.toLocaleString('en-US')} non-terminal contexts older than ${max_age} days (${old.groups.map((g) => `${g.group.state} ${g.count}`).join(', ')})`));
    if (rise != null && rise > growth) offenders.push(offender(null, 'sys_flow_context', `context table grew ${round1(rise)}% since the previous scan (${prev.value.toLocaleString('en-US')} → ${total.count.toLocaleString('en-US')})`));
    return { offenders, measures: { '': { value: total.count } }, observed: { contexts: total.count, old_non_terminal: old.total, growth_pct: rise == null ? null : round1(rise) }, expected: `no non-terminal context older than ${max_age} days; growth ≤ ${growth}%`, absent: false,
      population: pop(total.count, total.count, 'flow contexts', 'non-terminal state (not Complete, Cancelled or Error) by age; total count against the previous scan') };
  },

  /**
   * PLT-172 — the share of transactions slower than `max_seconds` per `period`-day window
   * over the retained transaction log, trended over at least `min_windows` windows.
   */
  plt_slow_transaction_trend: ({ max_seconds, period, min_windows }) => async (_rows, ctx) => {
    /* The oldest retained transaction: one row, ordered. */
    const oldest = await ctx.reads.read(declareRequirement({ table: 'syslog_transaction', fields: ['sys_created_on'], query: 'ORDERBYsys_created_on', strategy: 'rows', pageSize: 1, maxRows: 1 }));
    if (!usable(oldest.coverage)) return { unavailable: `syslog_transaction could not be read (${oldest.coverage?.status})` };
    const start = fromSnowTime(oldest.rows[0]?.sys_created_on);
    const end = new Date(ctx.run.run_started_at).getTime();
    if (!start) return { offenders: [], observed: { transactions: 0 }, expected: 'not rising', absent: false, population: pop(0, 0, 'windows', 'no transactions retained') };
    const snow = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);
    const points = [];
    for (let to = end; to - period * 86400000 >= start; to -= period * 86400000) {
      const from = to - period * 86400000;
      const all = await countOf(ctx, { table: 'syslog_transaction', query: `sys_created_on>=${snow(from)}^sys_created_on<${snow(to)}` }); if (all.unavailable) return all;
      const slow = await countOf(ctx, { table: 'syslog_transaction', query: `sys_created_on>=${snow(from)}^sys_created_on<${snow(to)}^response_time>${max_seconds * 1000}` }); if (slow.unavailable) return slow;
      if (all.count) points.unshift({ value: (100 * slow.count) / all.count, at: snow(to) });
    }
    const t = trend(points, { minWindows: min_windows });
    const offenders = t.status === 'ok' && t.direction === 'rising' ? [offender(null, 'response_time', `slow share (> ${max_seconds} s) rising over ${t.windows} windows of ${period} days: ${round1(t.first)}% → ${round1(t.last)}%`)] : [];
    return { offenders, observed: { windows: points.length, shares_pct: points.map((p) => round1(p.value)), direction: t.direction }, expected: 'the normalised slow share not rising', absent: false,
      population: pop(points.length, t.status === 'ok' ? points.length : 0, `${period}-day windows`, `retained syslog_transaction, slow = response time > ${max_seconds} s (PLT-171's threshold), divided by all transactions in the window`, { determinate_when_empty: `fewer than ${min_windows} windows retained` }) };
  },
});
