import { declareRequirement } from '../itsm/data-access.js';
import { fromSnowTime } from '../itsm/run-context.js';

/**
 * HEALTH ASSIST PHASE 6 — the Platform comparators.
 *
 * Named callbacks for the configuration engine, in the contract every pack keeps
 * (itsm/comparators.js): `{ offenders, observed, expected, absent, population }`, or
 * `{ unavailable }` when a read the judgement needs failed. Merged into the shared
 * library; a name is defined once.
 *
 * CUSTOMER-AUTHORED SCOPE (D-024). The script and design rules judge the records the
 * CUSTOMER created or changed — the records with a customer update (sys_update_xml,
 * the platform's own "Customer Updates", matched by sys_update_name) — not the
 * ServiceNow baseline. Measured on a real instance (Phase 6): 14,654 business rules,
 * 12,897 of them created by "admin" and nearly all out of the box; 320 carried a
 * customer update. Charging the customer for ServiceNow's own code would be wrong,
 * and sys_created_by cannot tell the two apart.
 *
 * SCRIPT ANALYSIS is static and lexical: comments are removed and string literals
 * are kept apart before any pattern is tested, so a pattern in a comment never
 * fires and a credential pattern is looked for only inside literals. Each check is
 * a named pure function (SCRIPT_CHECKS), tested on its own.
 */

const COMPLETE = 'complete';
const usable = (cov) => ['complete', 'limited', 'truncated'].includes(cov?.status);
const isEmpty = (v) => v === undefined || v === null || String(v).trim() === '';
const round1 = (n) => Number(n.toFixed(1));
const truthy = (v) => ['true', '1', 'yes'].includes(String(v).toLowerCase());
const ref = (v) => (v && typeof v === 'object' ? v.value ?? v.sys_id ?? null : v);

async function rowsOf(ctx, { table, fields, query = '', complete = false }) {
  const r = await ctx.reads.read(declareRequirement({ table, fields, query, strategy: 'rows' }));
  const ok = complete ? r.coverage?.status === COMPLETE : usable(r.coverage);
  if (!ok) return { unavailable: `${table} could not be read${complete ? ' completely' : ''} (${r.coverage?.status}${r.coverage?.error ? `: ${r.coverage.error}` : ''}) — no claim is made from a partial read`, coverage: r.coverage };
  return { rows: r.rows, coverage: r.coverage };
}
async function countsBy(ctx, { table, query = '', groupBy }) {
  const r = await ctx.reads.read(declareRequirement({ table, query, strategy: 'aggregate', groupBy }));
  if (r.coverage?.status !== COMPLETE) return { unavailable: `aggregate over ${table} failed (${r.coverage?.status})`, coverage: r.coverage };
  return { groups: r.groups, coverage: r.coverage, total: r.groups.reduce((n, g) => n + g.count, 0) };
}
const chunks = (xs, n = 100) => { const out = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };

/* ── customer-authored records ─────────────────────────────────────────── */

/**
 * The sys_ids of `table` records that carry a customer update: sys_update_xml rows
 * named `<table>_<sys_id>`. `rows` are those sys_update_xml rows (the reader's).
 */
export function customerIds(rows, table) {
  const re = new RegExp(`^${table}_([0-9a-f]{32})$`);
  const out = new Set();
  for (const r of rows) { const m = re.exec(String(r.name ?? '')); if (m) out.add(m[1]); }
  return out;
}

/** The customer-authored sys_ids of `table`, read through the aggregate API (one request). */
async function customerIdSet(ctx, table) {
  const g = await countsBy(ctx, { table: 'sys_update_xml', query: `nameSTARTSWITH${table}_`, groupBy: ['name'] });
  if (g.unavailable) return g;
  return { ids: customerIds(g.groups.map((x) => ({ name: x.group.name })), table) };
}

/** The customer-authored records of `table`, with `fields`, filtered by `query` (active=true …). */
async function customerRecords(ctx, rows, { table, fields, query = '' }) {
  const ids = [...customerIds(rows, table)];
  const out = [];
  for (const c of chunks(ids)) {
    const r = await rowsOf(ctx, { table, fields, query: [query, `sys_idIN${c.join(',')}`].filter(Boolean).join('^') });
    if (r.unavailable) return r;
    out.push(...r.rows);
  }
  return { records: out, customer: ids.length };
}

/* ── lexical preparation ───────────────────────────────────────────────── */

/**
 * Split a script into CODE (comments removed, string contents blanked to keep
 * positions) and its string LITERALS. A small state machine over the characters —
 * enough for patterns, not a parser: regex literals are not recognised, which can
 * only make a pattern inside one look like code (reported as the checks' stated risk).
 */
export function lex(src) {
  const s = String(src ?? '');
  let code = ''; const literals = []; let comments = 0;
  for (let i = 0; i < s.length;) {
    const c = s[i]; const n = s[i + 1];
    if (c === '/' && n === '/') { const e = s.indexOf('\n', i); const end = e < 0 ? s.length : e; comments += 1; code += ' '.repeat(end - i); i = end; continue; }
    if (c === '/' && n === '*') { const e = s.indexOf('*/', i + 2); const end = e < 0 ? s.length : e + 2; comments += 1; code += s.slice(i, end).replace(/[^\n]/g, ' '); i = end; continue; }
    if (c === '"' || c === '\'' || c === '`') {
      let j = i + 1; let lit = '';
      while (j < s.length && s[j] !== c) { if (s[j] === '\\') { lit += s[j] + (s[j + 1] ?? ''); j += 2; continue; } lit += s[j]; j += 1; }
      literals.push(lit); code += c + ' '.repeat(Math.max(0, j - i - 1)) + (j < s.length ? c : ''); i = j + 1; continue;
    }
    code += c; i += 1;
  }
  return { code, literals, comments };
}

/** The block `{ … }` that starts at or after `from`, by brace matching over lexed code: [start, end). */
function blockAfter(code, from) {
  const open = code.indexOf('{', from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < code.length; i++) { if (code[i] === '{') depth += 1; else if (code[i] === '}') { depth -= 1; if (depth === 0) return [open, i + 1]; } }
  return [open, code.length];
}
const LOOP = /\b(for|while)\s*\(|\.forEach\s*\(|\bdo\s*\{/g;
const QUERY = /new\s+GlideRecord(Secure)?\s*\(|\.query\s*\(|new\s+GlideAggregate\s*\(/;
function loopBlocks(code) {
  const out = []; LOOP.lastIndex = 0; let m;
  while ((m = LOOP.exec(code))) { const b = blockAfter(code, m.index); if (b) out.push(b); }
  return out;
}
/** Depth of GlideRecord queries nested in loops: the deepest query counted by how many loop blocks enclose it, plus one. */
function queryDepth(code) {
  const blocks = loopBlocks(code); let max = 0; const q = /new\s+GlideRecord(Secure)?\s*\(/g; let m;
  while ((m = q.exec(code))) max = Math.max(max, 1 + blocks.filter(([a, b]) => m.index > a && m.index < b).length);
  return max;
}
const WRAPPER = /^\s*\(\s*function\s+\w*\s*\([^)]*\)\s*\{\s*\}\s*\)\s*\([^)]*\)\s*;?\s*$/;

/* ── the checks: (row, lexed, args) → null | detail string ─────────────── */

const CREDENTIAL = [
  /(^|[^a-z])(password|passwd|pwd|secret|client_secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]/i,
  /^(basic|bearer)\s+[A-Za-z0-9+/=._-]{12,}$/i,
  /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
];
const hasBase64Basic = (lit) => /^Basic\s+[A-Za-z0-9+/]{8,}={0,2}$/.test(lit.trim());

export const SCRIPT_CHECKS = Object.freeze({
  /** PLT-034 — current.update() in a before rule. */
  current_update: (row, { code }) => (/\bcurrent\s*\.\s*update\s*\(/.test(code) ? 'calls current.update()' : null),
  /** PLT-035 — a GlideRecord instantiation or query call within a loop construct. */
  query_in_loop: (row, { code }) => {
    for (const [a, b] of loopBlocks(code)) if (QUERY.test(code.slice(a, b))) return 'GlideRecord query inside a loop';
    return null;
  },
  /** PLT-040 — query nesting depth above `max_depth`. */
  query_depth: (row, { code }, { max_depth }) => { const d = queryDepth(code); return d > max_depth ? `GlideRecord nesting depth ${d}` : null; },
  /** PLT-042 — a display rule that writes. */
  writes: (row, { code }) => (/\.\s*(update|insert|deleteRecord|deleteMultiple|updateMultiple)\s*\(/.test(code) ? 'performs a database write' : null),
  /** PLT-044 — setWorkflow(false) with no comment and no description. */
  set_workflow_unjustified: (row, { code, comments }) => (/\.setWorkflow\s*\(\s*false\s*\)/.test(code) && comments === 0 && isEmpty(row.description) ? 'setWorkflow(false) with no comment or description' : null),
  /** PLT-046 — a 32-hex sys_id literal. */
  sys_id_literal: (row, { literals }) => { const n = literals.filter((l) => /^[0-9a-f]{32}$/.test(l.trim())).length; return n ? `${n} hard-coded sys_id literal(s)` : null; },
  /** PLT-047 / 072 / 100 — credential, token or embedded-credential URL in a literal or an assignment. */
  credentials: (row, { code, literals }) => {
    const hits = [];
    if (literals.some((l) => CREDENTIAL[1].test(l.trim()) || hasBase64Basic(l))) hits.push('an Authorization value');
    if (literals.some((l) => CREDENTIAL[2].test(l.trim()))) hits.push('a URL with embedded credentials');
    if (/(password|passwd|pwd|secret|client_secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["'`]/i.test(code.replace(/\s+/g, ' '))) hits.push('a credential assigned from a literal');
    if (/\.setBasicAuth\s*\(\s*["'`]/.test(code)) hits.push('setBasicAuth with a literal');
    return hits.length ? `contains ${hits.join(', ')}` : null;
  },
  /** PLT-048 — gs.sleep or a blocking wait. */
  sleep: (row, { code }) => (/\bgs\s*\.\s*sleep\s*\(|Thread\s*\.\s*sleep\s*\(/.test(code) ? 'blocking sleep' : null),
  /** PLT-049 — an outbound HTTP call in a synchronous rule. */
  outbound_http: (row, { code }) => (/new\s+sn_ws\s*\.\s*(RESTMessageV2|SOAPMessageV2)\s*\(|new\s+(RESTMessage|SOAPMessage|GlideHTTPRequest)\s*\(/.test(code) ? 'outbound HTTP call' : null),
  /** PLT-050 — empty, comment-only or bare-wrapper body. */
  empty_body: (row, { code }) => { const c = code.trim(); return !c || WRAPPER.test(c) ? 'script is empty or only comments' : null; },
  /** PLT-075 — synchronous GlideAjax, or getReference without a callback. */
  sync_ajax: (row, { code }) => (/\.getXMLWait\s*\(/.test(code) || /\.getReference\s*\(\s*["'`][^"'`]*["'`]\s*\)/.test(code) ? 'synchronous server call' : null),
  /** PLT-076 — direct DOM access or jQuery. */
  dom_access: (row, { code }) => (/\bdocument\s*\.\s*(getElementById|getElementsBy\w+|querySelector(All)?)\s*\(|\bjQuery\s*\(|\$j\s*\(|\bgel\s*\(|\$\s*\(\s*["'`]/.test(code) ? 'direct DOM access' : null),
  /** PLT-077 — an onLoad client script calling the server. */
  server_call: (row, { code }) => (/new\s+GlideAjax\s*\(|new\s+GlideRecord\s*\(|\.getReference\s*\(/.test(code) ? 'server round-trip' : null),
  /** PLT-112 — record deletion (archival is not established, so it is reported as the rule's stated risk). */
  deletes: (row, { code }) => (/\.\s*(deleteMultiple|deleteRecord)\s*\(/.test(code) ? 'deletes records' : null),
  /** PLT-070 — a script longer than `max_lines` lines. */
  too_long: (row, lexed, { max_lines }) => { const n = String(row.script ?? '').split('\n').length; return n > max_lines ? `${n} lines` : null; },
  /** PLT-125 — an ACL script whose only statement sets answer = true / returns true. */
  returns_true: (row, { code }) => {
    const c = code.replace(/\s+/g, ' ').trim().replace(/;$/, '');
    return /^(answer\s*=\s*true|return\s+true|true)$/.test(c) || /^\(?\s*function\s*\w*\s*\(\s*\)\s*\{\s*return\s+true\s*;?\s*\}\s*\)?\s*\(\s*\)$/.test(c) ? 'script always returns true' : null;
  },
});

/* ── comparators ───────────────────────────────────────────────────────── */

export const PLATFORM_COMPARATORS = Object.freeze({
  /**
   * The script rules. `rows` are sys_update_xml rows naming `table` records (the
   * customer-updated set); the records themselves are read here, with `where`
   * (field → value | [values] | null for "empty") narrowing them (the rule's own
   * scope: when = before, type = onLoad …).
   */
  plt_script_scan: ({ table, check, fields = [], query = 'active=true', where = {}, args = {} }) => async (rows, ctx) => {
    const fn = SCRIPT_CHECKS[check];
    if (!fn) return { unavailable: `no script check "${check}"` };
    const got = await customerRecords(ctx, rows, { table, fields: [...new Set(['name', 'script', 'description', ...fields, ...Object.keys(where)])], query });
    if (got.unavailable) return got;
    const inScope = got.records.filter((r) => Object.entries(where).every(([f, v]) => (v === null ? isEmpty(r[f]) : Array.isArray(v) ? v.map(String).includes(String(r[f])) : String(r[f]) === String(v))));
    const offenders = [];
    for (const r of inScope) { const d = fn(r, lex(r.script), args); if (d) offenders.push({ sys_id: r.sys_id, field: 'script', value: `${r.name || r.sys_id}: ${d}` }); }
    return { offenders, observed: { customer_records: got.customer, in_scope: inScope.length, offending: offenders.length }, expected: 0, absent: false,
      population: { total: inScope.length, judged: inScope.length, unit: `customer-authored ${table} records`, basis: `active ${table} records carrying a customer update${Object.keys(where).length ? `, where ${Object.entries(where).map(([f, v]) => `${f}=${v ?? 'empty'}`).join(', ')}` : ''}` } };
  },

  /** Customer-authored records matching `where` (field → value | [values] | null for empty): the design rules on configuration records. */
  plt_customer_where: ({ table, fields = [], query = 'active=true', where = {} }) => async (rows, ctx) => {
    const got = await customerRecords(ctx, rows, { table, fields: [...new Set(['name', ...fields, ...Object.keys(where)])], query });
    if (got.unavailable) return got;
    const test = (r) => Object.entries(where).every(([f, v]) => (v === null ? isEmpty(r[f]) : Array.isArray(v) ? v.map(String).includes(String(r[f])) : String(r[f]) === String(v)));
    const offenders = got.records.filter(test).map((r) => ({ sys_id: r.sys_id, field: Object.keys(where).join('+'), value: r.name || r.short_description || r.sys_id }));
    return { offenders, observed: { customer_records: got.customer, judged: got.records.length, offending: offenders.length }, expected: 0, absent: false,
      population: { total: got.records.length, judged: got.records.length, unit: `customer-authored ${table} records`, basis: `${query || 'all'} ${table} records carrying a customer update` } };
  },

  /** PLT-013 — active SLA definitions equal on every functional field but the name. `rows` are the definitions. */
  plt_sla_duplicates: ({ fields }) => async (rows) => {
    const key = (r) => JSON.stringify(fields.map((f) => String(ref(r[f]) ?? '').trim()));
    const groups = new Map();
    for (const r of rows) { const k = key(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    const offenders = [...groups.values()].filter((g) => g.length > 1 && new Set(g.map((r) => r.name)).size > 1).flatMap((g) => g.map((r) => ({ sys_id: r.sys_id, field: 'duplicate', value: `${r.name} = ${g.filter((x) => x !== r).map((x) => x.name).join(', ')}` })));
    return { offenders, observed: { definitions: rows.length, duplicated: offenders.length }, expected: 0, absent: false,
      population: { total: rows.length, judged: rows.length, unit: 'SLA definitions', basis: `active definitions compared on ${fields.join(', ')}` } };
  },

  /**
   * PLT-014 — SLA condition strings naming a field the target table does not have.
   * Each condition is an encoded query; its field names are verified against the
   * dictionary of the definition's table (inheritance included) through the probes.
   */
  plt_sla_condition_fields: ({ conditions }) => async (rows, ctx) => {
    const FIELD = /^(?:OR|NQ)?([a-z_][a-z0-9_]*)(?:\.[a-z0-9_.]+)?(?:=|!=|IN|NOT IN|ISEMPTY|ISNOTEMPTY|<=|>=|<|>|LIKE|NOT LIKE|STARTSWITH|ENDSWITH|ANYTHING|SAMEAS|NSAMEAS|BETWEEN|DYNAMIC|ON|NOTON|RELATIVE|VALCHANGES|CHANGESFROM|CHANGESTO|GT_FIELD|LT_FIELD|EQ_FIELD|NE_FIELD|MORETHAN|LESSTHAN|EMPTYSTRING|DATEPART)/;
    const namedBy = new Map();
    for (const r of rows) {
      const table = String(r.collection || '').trim();
      if (!table) continue;
      const named = new Set();
      for (const f of conditions) for (const clause of String(r[f] || '').split('^')) { if (!clause || clause === 'EQ' || clause.startsWith('ORDERBY')) continue; const m = FIELD.exec(clause); if (m) named.add(m[1]); }
      if (named.size) namedBy.set(r, { table, named });
    }
    /* One dictionary probe per table over every field any definition on it names. */
    const missingOn = new Map();
    for (const table of new Set([...namedBy.values()].map((x) => x.table))) {
      const fields = [...new Set([...namedBy.values()].filter((x) => x.table === table).flatMap((x) => [...x.named]))].sort();
      const v = await ctx.probes.fieldsExist(table, fields);
      missingOn.set(table, new Set(v.state === 'AVAILABLE' ? [] : (v.missing ?? [])));
    }
    const offenders = []; const judged = namedBy.size;
    for (const [r, { table, named }] of namedBy) {
      const missing = [...named].filter((f) => missingOn.get(table).has(f));
      if (missing.length) offenders.push({ sys_id: r.sys_id, field: 'conditions', value: `${r.name}: ${table} has no ${missing.join(', ')}` });
    }
    return { offenders, observed: { definitions: rows.length, with_conditions: judged, broken: offenders.length }, expected: 0, absent: false,
      population: { total: rows.length, judged, unit: 'SLA definitions', basis: `field names in ${conditions.join(', ')}, verified against the definition's table` } };
  },

  /** PLT-004 — tasks carrying more than one ACTIVE SLA of the same definition type. `rows` are active task_sla records. */
  plt_multiple_slas: () => async (rows, ctx) => {
    const defs = [...new Set(rows.map((r) => ref(r.sla)).filter(Boolean))];
    const typeOf = new Map();
    for (const c of chunks(defs)) {
      const d = await rowsOf(ctx, { table: 'contract_sla', fields: ['name', 'type'], query: `sys_idIN${c.join(',')}` });
      if (d.unavailable) return d;
      for (const x of d.rows) typeOf.set(x.sys_id, String(x.type ?? ''));
    }
    const byTask = new Map();
    for (const r of rows) { const k = `${ref(r.task)}|${typeOf.get(ref(r.sla)) ?? '?'}`; if (!byTask.has(k)) byTask.set(k, []); byTask.get(k).push(r); }
    const offenders = [...byTask.entries()].filter(([, g]) => g.length > 1).map(([k, g]) => ({ sys_id: k.split('|')[0], field: 'task_sla', value: `${g.length} active ${k.split('|')[1]} SLAs: definitions ${[...new Set(g.map((x) => ref(x.sla)))].join(', ')}` }));
    const tasks = new Set(rows.map((r) => ref(r.task))).size;
    return { offenders, observed: { active_slas: rows.length, tasks, tasks_with_duplicates: offenders.length }, expected: 0, absent: false,
      population: { total: tasks, judged: tasks, unit: 'tasks with an active SLA', basis: 'active task_sla records grouped by task and definition type' } };
  },

  /** PLT-021 — per definition: share of SLA records paused longer than they were active, above `share`%. `rows` are task_sla records. */
  plt_pause_exceeds_active: ({ share, min_volume = 1 }) => async (rows) => {
    const byDef = new Map();
    const sec = (v) => { const d = fromSnowTime(v); return d ? d.getTime() / 1000 : null; };
    for (const r of rows) {
      const p = sec(r.pause_duration); const a = sec(r.duration);
      if (p == null || a == null) continue;
      const k = String(ref(r.sla) ?? '');
      if (!byDef.has(k)) byDef.set(k, { n: 0, over: 0 });
      const g = byDef.get(k); g.n += 1; if (p > a) g.over += 1;
    }
    const offenders = [...byDef.entries()].filter(([, g]) => g.n >= min_volume && (100 * g.over) / g.n > share).map(([k, g]) => ({ sys_id: k, field: 'pause_duration', value: `${g.over}/${g.n} SLA records paused longer than active (${round1((100 * g.over) / g.n)}%)` }));
    const judged = [...byDef.values()].reduce((n, g) => n + g.n, 0);
    return { offenders, observed: { definitions: byDef.size, over_share: offenders.length }, expected: `≤ ${share}% per definition`, absent: false,
      population: { total: rows.length, judged, unit: 'SLA records', basis: 'SLA records with both a pause and an active duration, by definition' } };
  },

  /** PLT-121 — active ACLs that grant unconditionally: no role, no condition, and no script (or a script that only returns true). `rows` are customer-updated ACL names. */
  plt_open_acls: () => async (rows, ctx) => {
    const got = await customerRecords(ctx, rows, { table: 'sys_security_acl', fields: ['name', 'operation', 'condition', 'script', 'advanced'], query: 'active=true' });
    if (got.unavailable) return got;
    const ids = got.records.map((r) => r.sys_id);
    const withRole = new Set();
    for (const c of chunks(ids)) {
      const g = await countsBy(ctx, { table: 'sys_security_acl_role', query: `sys_security_aclIN${c.join(',')}`, groupBy: ['sys_security_acl'] });
      if (g.unavailable) return g;
      for (const x of g.groups) if (x.count > 0) withRole.add(String(ref(x.group.sys_security_acl)));
    }
    const open = got.records.filter((r) => !withRole.has(r.sys_id) && isEmpty(r.condition) && (isEmpty(r.script) || !truthy(r.advanced) || SCRIPT_CHECKS.returns_true(r, lex(r.script))));
    return { offenders: open.map((r) => ({ sys_id: r.sys_id, field: 'acl', value: `${r.name} (${r.operation}): no role, no condition${isEmpty(r.script) || !truthy(r.advanced) ? ', no script' : ', script returns true'}` })),
      observed: { customer_acls: got.customer, judged: got.records.length, open: open.length }, expected: 0, absent: false, coverage: got.coverage,
      population: { total: got.records.length, judged: got.records.length, unit: 'customer-authored ACLs', basis: 'active ACLs carrying a customer update, with their role requirements' } };
  },

  /** PLT-133 — groups granting an elevated-privilege role with no active member. `rows` are group-role grants. */
  plt_empty_elevated_groups: () => async (rows, ctx) => {
    const roles = [...new Set(rows.map((r) => ref(r.role)).filter(Boolean))];
    const elevated = new Set();
    for (const c of chunks(roles)) {
      const r = await rowsOf(ctx, { table: 'sys_user_role', fields: ['name', 'elevated_privilege'], query: `sys_idIN${c.join(',')}^elevated_privilege=true` });
      if (r.unavailable) return r;
      for (const x of r.rows) elevated.add(x.sys_id);
    }
    const groups = [...new Set(rows.filter((r) => elevated.has(ref(r.role))).map((r) => ref(r.group)).filter(Boolean))];
    const active = new Set();
    for (const c of chunks(groups)) {
      const g = await countsBy(ctx, { table: 'sys_user_grmember', query: `groupIN${c.join(',')}^user.active=true`, groupBy: ['group'] });
      if (g.unavailable) return g;
      for (const x of g.groups) if (x.count > 0) active.add(String(ref(x.group.group)));
    }
    const offenders = groups.filter((g) => !active.has(g)).map((g) => ({ sys_id: g, field: 'members', value: 'grants an elevated-privilege role; no active member' }));
    return { offenders, observed: { groups_granting_elevated: groups.length, empty: offenders.length }, expected: 0, absent: false,
      population: { total: groups.length, judged: groups.length, unit: 'groups granting an elevated role', basis: 'group role grants of roles flagged elevated_privilege, and the groups\' active members', determinate_when_empty: 'no group grants an elevated-privilege role' } };
  },

  /**
   * PLT-132 — customer-authored roles with no direct and no derived holder,
   * excluding roles that contain other roles (containers). `rows` are the
   * sys_update_xml rows naming sys_user_role records.
   */
  plt_roles_unheld: () => async (updateRows, ctx) => {
    const got = await customerRecords(ctx, updateRows, { table: 'sys_user_role', fields: ['name'], query: '' });
    if (got.unavailable) return got;
    const rows = got.records;
    const held = await countsBy(ctx, { table: 'sys_user_has_role', groupBy: ['role'] });
    if (held.unavailable) return held;
    const holders = new Set(held.groups.filter((g) => g.count > 0).map((g) => String(ref(g.group.role))));
    const cont = await countsBy(ctx, { table: 'sys_user_role_contains', groupBy: ['role'] });
    if (cont.unavailable) return cont;
    const containers = new Set(cont.groups.filter((g) => g.count > 0).map((g) => String(ref(g.group.role))));
    const judged = rows.filter((r) => !containers.has(r.sys_id));
    const offenders = judged.filter((r) => !holders.has(r.sys_id)).map((r) => ({ sys_id: r.sys_id, field: 'holders', value: `${r.name}: no holder` }));
    return { offenders, observed: { roles: rows.length, containers_excluded: rows.length - judged.length, unheld: offenders.length }, expected: 0, absent: false,
      population: { total: rows.length, judged: judged.length, unit: 'customer-authored roles', basis: 'roles carrying a customer update that contain no other role, and their direct or derived holders' } };
  },

  /** PLT-137 — accounts flagged as integration users holding the admin role. `rows` are those users. */
  plt_integration_admins: ({ role = 'admin' }) => async (rows, ctx) => {
    const ids = rows.map((u) => u.sys_id);
    const admins = new Set();
    for (const c of chunks(ids)) {
      const g = await countsBy(ctx, { table: 'sys_user_has_role', query: `userIN${c.join(',')}^role.name=${role}`, groupBy: ['user'] });
      if (g.unavailable) return g;
      for (const x of g.groups) if (x.count > 0) admins.add(String(ref(x.group.user)));
    }
    const offenders = rows.filter((u) => admins.has(u.sys_id)).map((u) => ({ sys_id: u.sys_id, field: 'roles', value: `${u.user_name}: integration account holding ${role}` }));
    return { offenders, observed: { integration_accounts: rows.length, admin: offenders.length }, expected: 0, absent: false,
      population: { total: rows.length, judged: rows.length, unit: 'integration accounts', basis: 'active users flagged web_service_access_only or internal_integration_user', determinate_when_empty: 'no account is flagged as an integration user' } };
  },

  /** PLT-145 — OAuth configurations whose refresh token never expires or lives longer than `max_days`. `rows` are active OAuth entities. */
  plt_oauth_lifetime: ({ max_days }) => async (rows) => {
    const limit = max_days * 86400;
    const judged = rows.filter((r) => !isEmpty(r.refresh_token_lifespan));
    const offenders = judged.filter((r) => { const s = Number(r.refresh_token_lifespan); return !(s > 0) || s > limit; })
      .map((r) => ({ sys_id: r.sys_id, field: 'refresh_token_lifespan', value: `${r.name}: refresh token ${Number(r.refresh_token_lifespan) > 0 ? `${round1(Number(r.refresh_token_lifespan) / 86400)} days` : 'never expires'}` }));
    return { offenders, observed: { oauth_entities: rows.length, judged: judged.length, excessive: offenders.length }, expected: `≤ ${max_days} days`, absent: false,
      population: { total: rows.length, judged: judged.length, unit: 'OAuth configurations', basis: 'active OAuth entities with a refresh-token lifespan' } };
  },

  /** PLT-148 — REST functions sharing a normalised endpoint and HTTP method. `rows` are REST message functions. */
  plt_duplicate_endpoints: () => async (rows) => {
    const norm = (u) => String(u || '').trim().toLowerCase().replace(/\/+$/, '').replace(/^https?:\/\//, '').replace(/\$\{[^}]+\}/g, '{}');
    const groups = new Map();
    for (const r of rows) { if (isEmpty(r.rest_endpoint)) continue; const k = `${String(r.http_method || '').toUpperCase()} ${norm(r.rest_endpoint)}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    const offenders = [...groups.entries()].filter(([, g]) => new Set(g.map((r) => ref(r.rest_message))).size > 1).flatMap(([k, g]) => g.map((r) => ({ sys_id: r.sys_id, field: 'rest_endpoint', value: `${k} — ${g.length} functions in ${new Set(g.map((x) => ref(x.rest_message))).size} messages` })));
    const judged = [...groups.values()].reduce((n, g) => n + g.length, 0);
    return { offenders, observed: { functions: rows.length, endpoints: groups.size, duplicated: offenders.length }, expected: 0, absent: false,
      population: { total: rows.length, judged, unit: 'REST message functions', basis: 'functions with an endpoint, compared on method + normalised URL across messages' } };
  },

  /** PLT-150 — active transform maps with no coalesce field. `rows` are the maps. */
  plt_transform_no_coalesce: () => async (rows, ctx) => {
    const ids = rows.map((r) => r.sys_id);
    const coalesced = new Set();
    for (const c of chunks(ids)) {
      const g = await countsBy(ctx, { table: 'sys_transform_entry', query: `mapIN${c.join(',')}^coalesce=true`, groupBy: ['map'] });
      if (g.unavailable) return g;
      for (const x of g.groups) if (x.count > 0) coalesced.add(String(ref(x.group.map)));
    }
    const offenders = rows.filter((r) => !coalesced.has(r.sys_id)).map((r) => ({ sys_id: r.sys_id, field: 'coalesce', value: `${r.name} → ${r.target_table}: no coalesce field` }));
    return { offenders, observed: { maps: rows.length, without_coalesce: offenders.length }, expected: 0, absent: false,
      population: { total: rows.length, judged: rows.length, unit: 'transform maps', basis: 'active transform maps and their coalesce entries' } };
  },

  /**
   * PLT-106 — scheduled jobs whose last run took longer than their interval.
   * `rows` are active periodic jobs (sysauto: run_type, run_period); the last run's
   * duration is the job's sys_trigger processing_duration (milliseconds).
   */
  plt_job_overrun: ({ periodic }) => async (rows, ctx) => {
    const jobs = rows.filter((r) => String(r.run_type) === String(periodic) && fromSnowTime(r.run_period));
    const ids = jobs.map((r) => r.sys_id);
    const dur = new Map();
    for (const c of chunks(ids)) {
      const t = await rowsOf(ctx, { table: 'sys_trigger', fields: ['document_key', 'processing_duration'], query: `document_keyIN${c.join(',')}` });
      if (t.unavailable) return t;
      for (const x of t.rows) { const d = Number(x.processing_duration); if (Number.isFinite(d)) dur.set(String(x.document_key), Math.max(dur.get(String(x.document_key)) ?? 0, d)); }
    }
    const judged = jobs.filter((j) => dur.has(j.sys_id));
    const offenders = judged.filter((j) => dur.get(j.sys_id) > fromSnowTime(j.run_period).getTime())
      .map((j) => ({ sys_id: j.sys_id, field: 'processing_duration', value: `${j.name}: ran ${round1(dur.get(j.sys_id) / 1000)} s against a ${round1(fromSnowTime(j.run_period).getTime() / 1000)} s interval` }));
    return { offenders, observed: { periodic_jobs: jobs.length, with_duration: judged.length, overrunning: offenders.length }, expected: 0, absent: false,
      population: { total: jobs.length, judged: judged.length, unit: 'periodic jobs', basis: 'active periodic jobs whose trigger records a processing duration' } };
  },

  /** PLT-111 — active jobs older than `min_age` with no trigger or a trigger that never ran. `rows` are active jobs. */
  plt_job_never_ran: ({ min_age }) => async (rows, ctx) => {
    const cutoff = ctx.run.window(min_age).start;
    const old = rows.filter((r) => (fromSnowTime(r.sys_created_on) ?? cutoff) < cutoff);
    const ran = new Set();
    for (const c of chunks(old.map((r) => r.sys_id))) {
      const t = await rowsOf(ctx, { table: 'sys_trigger', fields: ['document_key', 'run_count'], query: `document_keyIN${c.join(',')}` });
      if (t.unavailable) return t;
      for (const x of t.rows) if (Number(x.run_count) > 0) ran.add(String(x.document_key));
    }
    const offenders = old.filter((r) => !ran.has(r.sys_id)).map((r) => ({ sys_id: r.sys_id, field: 'executions', value: `${r.name}: no recorded execution` }));
    return { offenders, observed: { active_jobs: rows.length, older_than_threshold: old.length, never_ran: offenders.length }, expected: 0, absent: false,
      population: { total: rows.length, judged: old.length, unit: 'scheduled jobs', basis: `active jobs older than ${min_age}, against their trigger run counts` } };
  },

  /** PLT-029 — active SLA definitions no commitment traces to: none named on the definition, and no service commitment names it. `rows` are the definitions. */
  plt_sla_untraceable: () => async (rows, ctx) => {
    const named = await countsBy(ctx, { table: 'service_commitment', query: 'slaISNOTEMPTY', groupBy: ['sla'] });
    if (named.unavailable) return named;
    const traced = new Set(named.groups.filter((g) => g.count > 0).map((g) => String(ref(g.group.sla))));
    const offenders = rows.filter((r) => isEmpty(ref(r.service_commitment)) && !traced.has(r.sys_id)).map((r) => ({ sys_id: r.sys_id, field: 'service_commitment', value: `${r.name}: no commitment` }));
    return { offenders, observed: { definitions: rows.length, untraceable: offenders.length }, expected: 0, absent: false, coverage: named.coverage,
      population: { total: rows.length, judged: rows.length, unit: 'SLA definitions', basis: 'active definitions against their own commitment field and the commitments that name them' } };
  },

  /**
   * PLT-061 / 101 / 113 / 153 — customer-authored records whose CREATOR is an inactive
   * or unknown user. These tables carry no owner field (verified, Phase 6), so the
   * creator is the only accountable name the platform keeps. `rows` are sys_update_xml rows.
   */
  plt_creator_inactive: ({ table, query = 'active=true' }) => async (rows, ctx) => {
    const got = await customerRecords(ctx, rows, { table, fields: ['name', 'sys_created_by'], query });
    if (got.unavailable) return got;
    const names = [...new Set(got.records.map((r) => String(r.sys_created_by || '').trim()).filter(Boolean))];
    const active = new Set(); const known = new Set();
    for (const c of chunks(names)) {
      const u = await rowsOf(ctx, { table: 'sys_user', fields: ['user_name', 'active'], query: `user_nameIN${c.join(',')}` });
      if (u.unavailable) return u;
      for (const x of u.rows) { known.add(String(x.user_name)); if (truthy(x.active)) active.add(String(x.user_name)); }
    }
    const offenders = got.records.filter((r) => !active.has(String(r.sys_created_by || '').trim()))
      .map((r) => ({ sys_id: r.sys_id, field: 'sys_created_by', value: `${r.name || r.sys_id}: created by ${r.sys_created_by || '(none)'} — ${known.has(String(r.sys_created_by)) ? 'inactive' : 'no such user'}` }));
    return { offenders, observed: { customer_records: got.customer, judged: got.records.length, unowned: offenders.length }, expected: 0, absent: false,
      population: { total: got.records.length, judged: got.records.length, unit: `customer-authored ${table} records`, basis: `${query || 'all'} ${table} records carrying a customer update, and their creators` } };
  },

  /** PLT-065 — customer-authored client-callable Script Includes with no ACL and no role restriction. `rows` are sys_update_xml rows. */
  plt_callable_unprotected: () => async (rows, ctx) => {
    const got = await customerRecords(ctx, rows, { table: 'sys_script_include', fields: ['name', 'api_name', 'client_callable', 'access'], query: 'active=true^client_callable=true' });
    if (got.unavailable) return got;
    const names = got.records.map((r) => String(r.api_name || r.name));
    const protectedNames = new Set();
    for (const c of chunks(names)) {
      const acl = await rowsOf(ctx, { table: 'sys_security_acl', fields: ['name', 'type'], query: `active=true^nameIN${c.join(',')}` });
      if (acl.unavailable) return acl;
      for (const x of acl.rows) protectedNames.add(String(x.name));
    }
    const offenders = got.records.filter((r) => !protectedNames.has(String(r.api_name || r.name)) && !protectedNames.has(String(r.name)))
      .map((r) => ({ sys_id: r.sys_id, field: 'acl', value: `${r.api_name || r.name}: client-callable with no ACL` }));
    return { offenders, observed: { callable: got.records.length, unprotected: offenders.length }, expected: 0, absent: false,
      population: { total: got.records.length, judged: got.records.length, unit: 'customer-authored client-callable includes', basis: 'active client-callable Script Includes carrying a customer update, against ACLs named for them', determinate_when_empty: 'no customer-authored Script Include is client-callable' } };
  },

  /** PLT-079 — table + field combinations with more than one active onChange client script. `rows` are those scripts. */
  plt_duplicate_onchange: () => async (rows, ctx) => {
    /* D-024: a group of out-of-box scripts only is ServiceNow's design; a group counts when the customer authored one of them. */
    const cust = await customerIdSet(ctx, 'sys_script_client');
    if (cust.unavailable) return cust;
    const groups = new Map();
    for (const r of rows) { if (isEmpty(r.field)) continue; const k = `${r.table}.${r.field}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    const judgedGroups = [...groups.entries()].filter(([, g]) => g.some((r) => cust.ids.has(r.sys_id)));
    const offenders = judgedGroups.filter(([, g]) => g.length > 1).flatMap(([k, g]) => g.map((r) => ({ sys_id: r.sys_id, field: 'field', value: `${k}: ${g.length} onChange scripts${cust.ids.has(r.sys_id) ? ' (customer-authored)' : ''}` })));
    return { offenders, observed: { fields: groups.size, with_customer_script: judgedGroups.length, shared: judgedGroups.filter(([, g]) => g.length > 1).length }, expected: 0, absent: false,
      population: { total: judgedGroups.length, judged: judgedGroups.length, unit: 'table fields with a customer-authored onChange script', basis: 'active onChange client scripts grouped by table and field, where the customer authored at least one' } };
  },

  /**
   * PLT-084 / PLT-090 — fields made mandatory by an active UI policy with no data
   * policy making them mandatory (the API path bypasses UI policies);
   * `dictionary_optional` (090) also requires the dictionary to leave the field optional.
   * `rows` are the mandatory UI policy actions.
   */
  plt_mandatory_without_data_policy: ({ dictionary_optional = false }) => async (rows, ctx) => {
    /* D-024: an out-of-box UI policy is ServiceNow's design; the customer's own policies and actions are judged. */
    const custPolicies = await customerIdSet(ctx, 'sys_ui_policy');
    if (custPolicies.unavailable) return custPolicies;
    const custActions = await customerIdSet(ctx, 'sys_ui_policy_action');
    if (custActions.unavailable) return custActions;
    const pairs = new Map();
    for (const r of rows) {
      if (isEmpty(r.table) || isEmpty(r.field)) continue;
      if (!custActions.ids.has(r.sys_id) && !custPolicies.ids.has(String(ref(r.ui_policy)))) continue;
      pairs.set(`${r.table}.${r.field}`, r);
    }
    const dp = await rowsOf(ctx, { table: 'sys_data_policy_rule', fields: ['table', 'field', 'mandatory'], query: 'mandatory=true', complete: true });
    if (dp.unavailable) return dp;
    const enforced = new Set(dp.rows.map((x) => `${x.table}.${x.field}`));
    let candidates = [...pairs.keys()].filter((k) => !enforced.has(k));
    if (dictionary_optional && candidates.length) {
      const mandatoryInDict = new Set();
      for (const c of chunks(candidates, 50)) {
        const q = c.map((k) => { const [t, f] = k.split('.'); return `name=${t}^element=${f}^mandatory=true`; }).join('^NQ');
        const d = await rowsOf(ctx, { table: 'sys_dictionary', fields: ['name', 'element', 'mandatory'], query: q });
        if (d.unavailable) return d;
        for (const x of d.rows) mandatoryInDict.add(`${x.name}.${x.element}`);
      }
      candidates = candidates.filter((k) => !mandatoryInDict.has(k));
    }
    const offenders = candidates.map((k) => ({ sys_id: pairs.get(k).sys_id, field: 'mandatory', value: `${k}: mandatory in a UI policy only` }));
    return { offenders, observed: { mandatory_fields: pairs.size, unenforced: offenders.length }, expected: 0, absent: false, coverage: dp.coverage,
      population: { total: pairs.size, judged: pairs.size, unit: 'fields made mandatory by a customer-authored UI policy', basis: `mandatory actions of active customer-authored UI policies, against data policy rules${dictionary_optional ? ' and the dictionary' : ''}`, determinate_when_empty: 'no customer-authored UI policy makes a field mandatory' } };
  },

  /** PLT-103 — records of `table` grouped by `group_field`, a group holding more than `max` rows. `rows` are unused (the count is aggregated). */
  plt_group_count: ({ table, group_field, max }) => async (_rows, ctx) => {
    const g = await countsBy(ctx, { table, groupBy: [group_field] });
    if (g.unavailable) return g;
    const offenders = g.groups.filter((x) => x.count > max).map((x) => ({ sys_id: String(ref(x.group[group_field])), field: group_field, value: `${x.count} ${table} records` }));
    return { offenders, observed: { groups: g.groups.length, over: offenders.length }, expected: `≤ ${max}`, absent: false, coverage: g.coverage,
      population: { total: g.groups.length, judged: g.groups.length, unit: `${group_field} groups`, basis: `${table} counted per ${group_field}` } };
  },

  /** PLT-110 — jobs whose trigger failure share is above `failure_rate`%. `rows` are job triggers with run counts. */
  plt_job_failure_rate: ({ failure_rate, min_runs = 1 }) => async (rows) => {
    const judged = rows.filter((r) => Number(r.run_count) >= min_runs);
    const offenders = judged.filter((r) => (100 * Number(r.error_count || 0)) / Number(r.run_count) > failure_rate)
      .map((r) => ({ sys_id: r.sys_id, field: 'error_count', value: `${r.name}: ${r.error_count} errors in ${r.run_count} runs` }));
    return { offenders, observed: { triggers: rows.length, judged: judged.length, failing: offenders.length }, expected: `≤ ${failure_rate}%`, absent: false,
      population: { total: rows.length, judged: judged.length, unit: 'job triggers', basis: 'triggers that have run, by errors per run' } };
  },

  /** PLT-120 — active users holding the admin role (directly or inherited) above `max`. `rows` are unused. */
  plt_admin_count: ({ max, role = 'admin' }) => async (_rows, ctx) => {
    const g = await countsBy(ctx, { table: 'sys_user_has_role', query: `role.name=${role}^user.active=true^state=active`, groupBy: ['user'] });
    if (g.unavailable) return g;
    const admins = g.groups.filter((x) => x.count > 0).length;
    return { offenders: admins > max ? [{ sys_id: null, field: 'admins', value: `${admins} active users hold ${role}` }] : [], observed: { admins, max }, expected: `≤ ${max}`, absent: false, coverage: g.coverage,
      population: { total: 1, judged: 1, unit: 'estate', basis: `active users holding ${role}, directly or through nesting` } };
  },

  /** PLT-154 — skipped updates of the MOST RECENT upgrade with no resolution recorded. `rows` are upgrade history records. */
  plt_unreviewed_skips: ({ skipped_values, resolved_empty = true }) => async (rows, ctx) => {
    const latest = [...rows].sort((a, b) => String(b.upgrade_started || b.sys_created_on).localeCompare(String(a.upgrade_started || a.sys_created_on)))[0];
    if (!latest) return { offenders: [], observed: { upgrades: 0 }, expected: 0, absent: false, population: { total: 0, judged: 0, unit: 'skipped updates', basis: 'no upgrade is recorded' } };
    const log = await rowsOf(ctx, { table: 'sys_upgrade_history_log', fields: ['name', 'disposition', 'resolution_status'], query: `upgrade_history=${latest.sys_id}^dispositionIN${skipped_values.join(',')}`, complete: true });
    if (log.unavailable) return log;
    const open = log.rows.filter((r) => (resolved_empty ? isEmpty(r.resolution_status) : false));
    return { offenders: open.map((r) => ({ sys_id: r.sys_id, field: 'resolution_status', value: `${r.name}: skipped, no review recorded` })), observed: { upgrade: latest.to_version ?? latest.sys_id, skipped: log.rows.length, unreviewed: open.length }, expected: 0, absent: false, coverage: log.coverage,
      population: { total: log.rows.length, judged: log.rows.length, unit: 'skipped updates', basis: `skipped updates of the latest upgrade (${latest.to_version ?? latest.sys_id})`, determinate_when_empty: 'the latest upgrade skipped nothing' } };
  },

  /** PLT-164 — objects with more than `max` customer versions in the `window`. `rows` are unused. */
  plt_hotspots: ({ max, window }) => async (_rows, ctx) => {
    const g = await countsBy(ctx, { table: 'sys_update_version', query: `source_table=sys_update_set^sys_created_on>=${ctx.run.window(window).start_snow}`, groupBy: ['name'] });
    if (g.unavailable) return g;
    const offenders = g.groups.filter((x) => x.count > max).map((x) => ({ sys_id: null, field: 'name', value: `${x.group.name}: ${x.count} versions` }));
    return { offenders, observed: { objects_changed: g.groups.length, hotspots: offenders.length }, expected: `≤ ${max} per object`, absent: false, coverage: g.coverage,
      population: { total: g.groups.length, judged: g.groups.length, unit: 'customer-changed objects', basis: `objects with customer versions (update sets) in the last ${window}` } };
  },

  /** PLT-171 — 95th-percentile response time of interactive transactions in the window, against `max_seconds`. `rows` are the transactions (response_time in ms). */
  plt_p95_response: ({ max_seconds }) => async (rows) => {
    const max_ms = max_seconds * 1000;
    const times = rows.map((r) => Number(r.response_time)).filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
    if (!times.length) return { offenders: [], observed: { transactions: 0 }, expected: `≤ ${max_ms} ms`, absent: false, population: { total: rows.length, judged: 0, unit: 'transactions', basis: 'transactions with a response time in the window' } };
    const p95 = times[Math.min(times.length - 1, Math.ceil(0.95 * times.length) - 1)];
    const within = times.filter((t) => t <= max_ms).length;
    return { offenders: p95 > max_ms ? [{ sys_id: null, field: 'response_time', value: `p95 ${p95} ms over ${times.length} transactions` }] : [], observed: { transactions: times.length, p95_ms: p95 }, expected: `p95 ≤ ${max_ms} ms`, absent: false,
      kpi: { numerator: within, denominator: times.length }, population: { total: rows.length, judged: times.length, unit: 'transactions', basis: 'transactions with a response time in the window' } };
  },
});
