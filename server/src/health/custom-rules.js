import { recordFinding, aggregateFinding } from './itsm/findings.js';

/**
 * CUSTOM RULES — a check a user describes and saves, run read-only in the scans of
 * its module and scored with that module's own arithmetic (decision D-038).
 *
 * THREE KINDS, each a stored condition the instance itself evaluates (Table API):
 *   record  records of `table` (within `scope`) matching `conditions` are findings
 *   rate    the share of `table` (within `scope`) matching `conditions`, failing
 *           above `threshold.max_share` %
 *   age     records (within `scope`, matching `conditions`) whose `age.field` is
 *           older than `age.days` days are findings
 *
 * SAFETY. A rule is DATA, never code: a table name, fields and operators from a
 * fixed list, and values that cannot carry a query separator. The table and every
 * field are verified on the instance (the dictionary, inheritance resolved) before
 * anything is read, and nothing is ever written. A rule that cannot be verified is
 * reported unavailable, never as a pass.
 *
 * IDS carry the module (CUSTOM-ITSM-001 …) so a finding routes to its module by
 * prefix, exactly as a built-in rule's does (modules.js).
 */

export const CUSTOM_MODULES = Object.freeze({
  cmdb: { tag: 'CMDB', label: 'CMDB', domain: 'CMDB', agent: 'cmdb_agent' },
  itsm: { tag: 'ITSM', label: 'ITSM', domain: 'ITSM', agent: 'itsm_agent' },
  itom: { tag: 'ITOM', label: 'ITOM', domain: 'ITOM', agent: 'itom_agent' },
  platform: { tag: 'PLT', label: 'Platform', domain: 'PLATFORM', agent: 'platform_agent' },
  enterprise_dq: { tag: 'EDQ', label: 'Enterprise Data Quality', domain: 'ENTERPRISE_DQ', agent: 'enterprise_dq_agent' },
  csdm: { tag: 'CSDM', label: 'CSDM', domain: 'CSDM_MODEL', agent: 'csdm_model_agent' },
  itil: { tag: 'ITIL', label: 'ITIL', domain: 'ITIL_PRACTICE', agent: 'itil_practice_agent' },
});
export const CUSTOM_PREFIX = 'CUSTOM-';
export const customPrefixOf = (module) => `${CUSTOM_PREFIX}${CUSTOM_MODULES[module].tag}-`;
export const moduleOfCustomId = (id) => Object.entries(CUSTOM_MODULES).find(([m]) => String(id).startsWith(customPrefixOf(m)))?.[0] ?? null;

export const CUSTOM_KINDS = Object.freeze(['record', 'rate', 'age']);
export const CUSTOM_SEVERITIES = Object.freeze(['SYSTEMIC', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
export const CUSTOM_OPERATORS = Object.freeze(['=', '!=', 'ISEMPTY', 'ISNOTEMPTY', 'IN', 'NOT IN', 'LIKE', 'NOT LIKE', 'STARTSWITH', '>', '<', '>=', '<=']);
const VALUELESS = new Set(['ISEMPTY', 'ISNOTEMPTY']);
const NAME_MAX = 120;
const DESCRIPTION_MAX = 2000;
const CONDITIONS_MAX = 10;
const TABLE_RE = /^[a-z][a-z0-9_]{1,79}$/;
const FIELD_RE = /^[a-z][a-z0-9_]{0,79}(\.[a-z][a-z0-9_]{0,79}){0,2}$/;
/** How many matching records a finding names (evidence); the count is always the instance's full count. */
export const EVIDENCE_LIMIT = 200;

export class CustomRuleError extends Error {
  constructor(message, status = 422) { super(message); this.name = 'CustomRuleError'; this.status = status; }
}

const str = (v) => (v == null ? '' : String(v)).trim();

function normaliseConditions(list, label, { required }) {
  const raw = Array.isArray(list) ? list : [];
  if (raw.length > CONDITIONS_MAX) throw new CustomRuleError(`${label}: at most ${CONDITIONS_MAX} conditions.`);
  const out = raw.map((c, i) => {
    const field = str(c?.field).toLowerCase();
    const op = str(c?.op).toUpperCase();
    const value = str(c?.value);
    if (!FIELD_RE.test(field)) throw new CustomRuleError(`${label} ${i + 1}: "${c?.field ?? ''}" is not a field name (letters, digits, underscores; a dot-walk of up to three levels).`);
    if (!CUSTOM_OPERATORS.includes(op)) throw new CustomRuleError(`${label} ${i + 1}: operator "${c?.op ?? ''}" is not one of ${CUSTOM_OPERATORS.join(', ')}.`);
    if (!VALUELESS.has(op) && !value) throw new CustomRuleError(`${label} ${i + 1}: ${field} ${op} needs a value.`);
    /* A value can never carry a query separator or a script: it is data, not a query. */
    if (/[\^\n\r]/.test(value) || /^javascript:/i.test(value)) throw new CustomRuleError(`${label} ${i + 1}: the value may not contain "^", a line break or a script.`);
    return Object.freeze({ field, op, value: VALUELESS.has(op) ? '' : value });
  });
  if (required && !out.length) throw new CustomRuleError(`${label}: add at least one condition.`);
  return Object.freeze(out);
}

/**
 * Validate and normalise a rule definition. Returns the canonical definition;
 * throws CustomRuleError naming the first problem. `dimensionsOf(module)` gives the
 * module's scored areas (the workbook profile), one of which the rule joins.
 */
export function validateCustomRule(input, { dimensionsOf = () => [] } = {}) {
  const name = str(input?.name);
  const description = str(input?.description);
  const module = str(input?.module);
  const kind = str(input?.kind);
  const table = str(input?.table).toLowerCase();
  const severity = str(input?.severity).toUpperCase();
  if (!name) throw new CustomRuleError('Give the rule a name.');
  if (name.length > NAME_MAX) throw new CustomRuleError(`A rule name is at most ${NAME_MAX} characters.`);
  if (description.length > DESCRIPTION_MAX) throw new CustomRuleError(`A description is at most ${DESCRIPTION_MAX} characters.`);
  if (!CUSTOM_MODULES[module]) throw new CustomRuleError(`Choose the module the rule belongs to (${Object.keys(CUSTOM_MODULES).join(', ')}).`);
  if (!CUSTOM_KINDS.includes(kind)) throw new CustomRuleError('Choose the kind of check: record, rate or age.');
  if (!TABLE_RE.test(table)) throw new CustomRuleError(`"${input?.table ?? ''}" is not a table name.`);
  if (!CUSTOM_SEVERITIES.includes(severity)) throw new CustomRuleError(`Choose a severity (${CUSTOM_SEVERITIES.join(', ')}).`);
  const dims = dimensionsOf(module).filter((d) => d.scored !== false);
  const dimension = str(input?.dimension);
  if (!dims.some((d) => d.key === dimension)) throw new CustomRuleError(`Choose the ${CUSTOM_MODULES[module].label} area the rule is scored in (${dims.map((d) => d.label).join(', ') || 'none available'}).`);
  const scope = normaliseConditions(input?.scope, 'Applies to', { required: false });
  const conditions = normaliseConditions(input?.conditions, 'Condition', { required: kind !== 'age' });
  let threshold = null;
  let age = null;
  if (kind === 'rate') {
    const max = Number(input?.threshold?.max_share);
    if (!Number.isFinite(max) || max <= 0 || max >= 100) throw new CustomRuleError('A rate check needs its limit: the share (above 0 and below 100 %) above which it fails.');
    threshold = Object.freeze({ max_share: max });
  }
  if (kind === 'age') {
    const field = str(input?.age?.field).toLowerCase();
    const days = Number(input?.age?.days);
    if (!/^[a-z][a-z0-9_]{0,79}$/.test(field)) throw new CustomRuleError('An age check needs the date field it measures (for example sys_created_on).');
    if (!Number.isFinite(days) || days <= 0 || days > 3650) throw new CustomRuleError('An age check needs its limit in days (more than 0, at most 3650).');
    age = Object.freeze({ field, days });
  }
  return Object.freeze({
    name, description, module, dimension, kind, table, scope, conditions, threshold, age, severity,
    scored: input?.scored !== false, active: input?.active !== false,
  });
}

const clauseOf = (c) => (VALUELESS.has(c.op) ? `${c.field}${c.op}` : `${c.field}${c.op}${c.value}`);
const snowTime = (d) => d.toISOString().replace('T', ' ').slice(0, 19);

/** The encoded queries the rule runs: its population and its matches. */
export function customQueries(rule, now = new Date()) {
  const scope = rule.scope.map(clauseOf).join('^');
  const match = [...rule.scope.map(clauseOf), ...rule.conditions.map(clauseOf)];
  if (rule.kind === 'age') match.push(`${rule.age.field}<${snowTime(new Date(now.getTime() - rule.age.days * 86400000))}`, `${rule.age.field}ISNOTEMPTY`);
  return { population: scope, matches: match.join('^') };
}

/** Every field a rule names (the first segment of a dot-walk is what the table must have). */
export function fieldsOf(rule) {
  return [...new Set([...rule.scope, ...rule.conditions].map((c) => c.field.split('.')[0]).concat(rule.age ? [rule.age.field] : []))];
}

/**
 * Verify the table exists and carries every field the rule names (its own or an
 * ancestor's). `client` is the Table API client. `{ ok, missing, reason }`.
 */
export async function verifyCustomRule(rule, client) {
  const chain = [];
  let cur = rule.table;
  for (let i = 0; i < 12 && cur; i += 1) {
    const rows = await client.query('sys_db_object', { query: `name=${cur}`, fields: 'name,super_class.name', limit: 1, display: 'false' });
    if (!rows.length) { if (i === 0) return { ok: false, reason: `table ${rule.table} is not on this instance` }; break; }
    chain.push(cur);
    cur = rows[0]['super_class.name'] || null;
  }
  const wanted = fieldsOf(rule);
  const dict = await client.query('sys_dictionary', { query: `nameIN${chain.join(',')}^elementIN${wanted.join(',')}`, fields: 'element', limit: 500, display: 'false' });
  const have = new Set(dict.map((d) => d.element).concat(['sys_id', 'sys_created_on', 'sys_updated_on', 'sys_created_by', 'sys_updated_by', 'sys_class_name', 'sys_mod_count']));
  const missing = wanted.filter((f) => !have.has(f));
  return missing.length ? { ok: false, missing, reason: `${rule.table} has no field ${missing.join(', ')}` } : { ok: true, missing: [], chain };
}

const LABEL_FIELDS = ['number', 'name', 'short_description', 'u_name', 'user_name', 'title'];

/**
 * Evaluate one rule, read-only. `client` is the Table API client (query, count).
 * Returns `{ rule_id, status, verdict, population, matches, share, pass_pct, sample, finding, reason }`:
 *   status   evaluated | unavailable
 *   verdict  pass | fail | inconclusive (nothing in the population to judge)
 */
export async function evaluateCustomRule(stored, client, { now = new Date(), withFinding = true } = {}) {
  const rule = stored;
  const base = { rule_id: stored.rule_id ?? null, status: 'unavailable', verdict: null, population: null, matches: null, share: null, pass_pct: null, sample: [], finding: null, reason: null };
  try {
    const v = await verifyCustomRule(rule, client);
    if (!v.ok) return { ...base, reason: v.reason };
    const q = customQueries(rule, now);
    const population = await client.count(rule.table, q.population);
    const matches = await client.count(rule.table, q.matches);
    const share = population ? (100 * matches) / population : null;
    const pass_pct = population ? 100 - share : null;
    let verdict;
    if (!population) verdict = 'inconclusive';
    else if (rule.kind === 'rate') verdict = share > rule.threshold.max_share ? 'fail' : 'pass';
    else verdict = matches > 0 ? 'fail' : 'pass';
    let sample = [];
    if (matches > 0) {
      const probe = await client.query(rule.table, { query: q.matches, fields: ['sys_id', ...LABEL_FIELDS, ...fieldsOf(rule)].join(','), limit: EVIDENCE_LIMIT, display: 'false' });
      sample = probe.map((r) => ({ sys_id: r.sys_id, label: LABEL_FIELDS.map((f) => r[f]).find((x) => x) ?? r.sys_id, fields: Object.fromEntries(fieldsOf(rule).map((f) => [f, r[f] ?? null])) }));
    }
    const out = { ...base, status: 'evaluated', verdict, population, matches, share: share == null ? null : Number(share.toFixed(2)), pass_pct: pass_pct == null ? null : Number(pass_pct.toFixed(2)), sample, query: q.matches };
    if (withFinding && verdict === 'fail' && stored.rule_id) out.finding = customFinding(stored, out, now);
    return out;
  } catch (err) {
    return { ...base, reason: `the instance refused the read: ${err?.message || err}` };
  }
}

/** The finding a failing custom rule reports, in the engine's own shape. */
export function customFinding(stored, result, now = new Date()) {
  const m = CUSTOM_MODULES[stored.module];
  const rule = { id: stored.rule_id, base: stored.severity, title: stored.name, domain: m.domain, agent: m.agent };
  const description = stored.description || stored.name;
  const common = { rule, table: stored.table, title: stored.name, description, severity: stored.severity, confidence: 1.0, recommendation: null, collected_at: now.toISOString(), agent_id: m.agent };
  if (stored.kind === 'rate') {
    return { ...aggregateFinding({ ...common, metric: { measure: `${stored.rule_id}:share`, observed: result.share, threshold: stored.threshold.max_share, breached: true, population: result.population, count: result.matches, percentage: result.share, unit: '%', basis: `${result.matches} of ${result.population} ${stored.table} records match` } }), custom: true };
  }
  const records = result.sample.map((s) => ({ sys_id: s.sys_id, ...s.fields, display: s.label }));
  return { ...recordFinding({ ...common, records, fields: ['display', ...fieldsOf(stored)] }), custom: true, population: result.population, match_count: result.matches };
}

/** The catalogue row a custom rule contributes to its module's score (the same shape the packs' rows have). */
export function customScoreRow(stored, result) {
  return {
    rule_id: stored.rule_id, title: stored.name, base_severity: stored.severity, status: result.status, verdict: ['pass', 'fail'].includes(result.verdict) ? result.verdict : null,
    kpis: result.pass_pct == null ? [] : [{ pass_pct: result.pass_pct, numerator: (result.population ?? 0) - (result.matches ?? 0), denominator: result.population, variant: 'estate' }],
    parameters: stored.kind === 'rate' ? { max_share: { value: stored.threshold.max_share } } : {},
    custom: true,
  };
}
