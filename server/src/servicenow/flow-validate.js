import fs from 'node:fs';
import path from 'node:path';

import { WORKSPACE } from './fluent.js';
import { tableExists, getSchema } from './schema.js';
import { table as tableApi, SnowError } from './client.js';

/**
 * JOB 1.2b — NAMES THE BUILD DOES NOT CHECK, checked before the build.
 *
 * MEASURED in Job 1.2 on dev366630: `now-sdk build` compiled and installed
 *   - `table_name: 'x_not_a_real_table_zz'`  (any string is accepted), and
 *   - `wfa.dataPill(step.NoSuchOutput, …)`   (outputs are typed "with dotwalk").
 * Both reached the instance and would only fail when the flow ran. So every
 * table, field, choice value and step output a flow source names is checked
 * against the live instance (schema reads are cached per process) in seconds,
 * before anything is built or installed.
 *
 * Pure over the source text plus two lookups, so a test can pin it down.
 */

const ACTIONS_DIR = path.join(WORKSPACE, 'node_modules/@servicenow/sdk-core/dist/external/flow/built-ins/actions/core');
let outputsCache = null;

/** Top-level keys of the `OutputsWithDotwalk<{ … }>` type in an action's typings. */
function outputKeys(text) {
  const at = text.indexOf('OutputsWithDotwalk<{');
  if (at < 0) return null;
  const keys = [];
  let depth = 0;
  for (let i = at + 'OutputsWithDotwalk<'.length; i < text.length; i += 1) {
    const c = text[i];
    if ('{<(['.includes(c)) depth += 1;
    else if ('}>)]'.includes(c)) { depth -= 1; if (depth === 0) break; } else if (depth === 1 && /[\s{;,]/.test(text[i - 1])) {
      const m = /^([A-Za-z_$][\w$]*)\??:/.exec(text.slice(i));
      if (m) { keys.push(m[1]); i += m[0].length - 1; }
    }
  }
  return keys;
}

/** action.core id → its output names, read off the installed SDK (null = dynamic outputs). */
export function actionOutputs() {
  if (outputsCache) return outputsCache;
  const map = new Map();
  try {
    for (const f of fs.readdirSync(ACTIONS_DIR).filter((x) => x.endsWith('.now.d.ts'))) {
      map.set(f.replace('.now.d.ts', ''), outputKeys(fs.readFileSync(path.join(ACTIONS_DIR, f), 'utf8')));
    }
  } catch { /* no SDK: nothing to check against, and the caller says so */ }
  outputsCache = map;
  return map;
}

/**
 * JOB 1.2b follow-up — the allowed values of each built-in action's choice inputs,
 * read off the installed SDK: `log_level: Typed<"info" | "error" | "warn", {
 * choices: { warn: { label: "Warning" } … } }>`. Map: action id → input → { values, labels }.
 */
let choicesCache = null;
export function actionInputChoices() {
  if (choicesCache) return choicesCache;
  const map = new Map();
  try {
    for (const f of fs.readdirSync(ACTIONS_DIR).filter((x) => x.endsWith('.now.d.ts'))) {
      const text = fs.readFileSync(path.join(ACTIONS_DIR, f), 'utf8');
      const inputs = new Map();
      const re = /(\w+): import\("@servicenow\/sdk-core\/runtime\/db"\)\.Typed<((?:"[^"]*"\s*\|\s*)*"[^"]*"),\s*\{/g;
      let m;
      while ((m = re.exec(text))) {
        if (inputs.has(m[1])) continue; // the same input repeats in each overload
        const values = [...m[2].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
        const rest = text.slice(re.lastIndex, re.lastIndex + 4000);
        const block = rest.slice(0, rest.indexOf('}>') >= 0 ? rest.indexOf('}>') : rest.length);
        const labels = new Map();
        for (const c of block.matchAll(/readonly (\w+): \{\s*readonly label: "([^"]*)"/g)) {
          if (values.includes(c[1])) labels.set(c[2].toLowerCase(), c[1]);
        }
        inputs.set(m[1], { values, labels });
      }
      if (inputs.size) map.set(f.replace('.now.d.ts', ''), inputs);
    }
  } catch { /* no SDK: nothing to check against */ }
  choicesCache = map;
  return map;
}

/**
 * JOB 1.2b follow-up — a choice input given as its LABEL or in the wrong case is
 * read as its value; anything else is refused before the build.
 *
 * MEASURED 2026-09-25: get_flow shows `log_level` by its label ("Info"), the
 * model copied it into edit_flow, and `now-sdk build` rejected "Info" (TS2769)
 * after 5.6 minutes — nothing was loaded, the edit simply failed. Mutates
 * `inputs`; returns notes for the preview. Pills are left alone.
 */
export function normalizeChoiceInputs(action, inputs, choices = actionInputChoices()) {
  const notes = [];
  const known = choices.get(action);
  if (!known || !inputs || typeof inputs !== 'object') return { inputs, notes };
  for (const [name, spec] of known) {
    const v = inputs[name];
    if (typeof v !== 'string' || v.includes('{{') || spec.values.includes(v)) continue;
    const lower = v.trim().toLowerCase();
    const hit = spec.values.find((x) => x.toLowerCase() === lower) ?? spec.labels.get(lower);
    if (hit) {
      inputs[name] = hit;
      notes.push(`${name} "${v}" is stored as "${hit}"`);
      continue;
    }
    const valid = spec.values.map((x) => {
      const label = [...spec.labels].find(([, val]) => val === x)?.[0];
      return label && label !== x ? `${x} (${label})` : x;
    }).join(', ');
    throw new SnowError(`"${v}" is not a valid ${name} for ${action}. Valid: ${valid}.`, 400);
  }
  return { inputs, notes };
}

/**
 * Which fields have a STRICT choice list. MEASURED: task.short_description has
 * choices but dictionary `choice=2` (a suggestion list: free text is fine),
 * while task.state is `choice=3` (dropdown). Only 1 and 3 restrict the value.
 */
const strictCache = new Map();
export async function strictChoiceFields(schema, query = null) {
  const key = schema?.table;
  if (!key) return new Set();
  const cacheable = !query;
  if (cacheable && strictCache.has(key)) return strictCache.get(key);
  query = query ?? ((t, o) => tableApi.query(t, o));
  const chain = schema.hierarchy?.length ? schema.hierarchy : [key];
  /* Fail CLOSED: if the dictionary cannot be read this throws, and the caller reports it. */
  const rows = await query('sys_dictionary', { query: `nameIN${chain.join(',')}^elementISNOTEMPTY`, fields: 'name,element,choice', limit: 2000, display: 'false' });
  const best = new Map();
  for (const r of rows) {
    const rank = chain.indexOf(r.name);
    const cur = best.get(r.element);
    if (!cur || rank < cur.rank) best.set(r.element, { rank, choice: String(r.choice ?? '') });
  }
  const strict = new Set([...best].filter(([, v]) => v.choice === '1' || v.choice === '3').map(([k]) => k));
  if (cacheable) strictCache.set(key, strict);
  return strict;
}

const TABLE_INPUTS = ['table_name', 'table', 'task_table'];
const VALUE_INPUTS = ['values', 'field_values', 'fields'];

/** Field names at the start of each clause of an encoded query (`a=1^ORb.c!=2^NQd`). */
export function queryFields(query) {
  return String(query ?? '')
    .split(/\^NQ|\^OR|\^/)
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith('ORDERBY') && !c.startsWith('{{') && !c.startsWith('$'))
    /* field names are lower-case; operators (LIKE, ISEMPTY, IN, STARTSWITH, …) are upper-case and glued on */
    .map((c) => /^([a-z0-9_][a-z0-9_.]*)/.exec(c)?.[1])
    .filter(Boolean);
}

const literal = (node, SK) => {
  if (!node) return null;
  const k = node.getKind();
  if (k === SK.StringLiteral || k === SK.NoSubstitutionTemplateLiteral) return node.getLiteralText();
  if (k === SK.NumericLiteral) return node.getText();
  if (k === SK.TrueKeyword || k === SK.FalseKeyword) return node.getText();
  return null;
};

/**
 * Check one parsed flow (from flow-edit's parseFlowSource). Returns a list of
 * problems, each naming the step and the exact fix; empty means every name the
 * source uses exists on the instance.
 */
export async function validateFlowNames(parsed, { exists = tableExists, schemaOf = getSchema, choiceRows = null } = {}) {
  const { SK } = parsed;
  const problems = [];
  const outputs = actionOutputs();
  const schemaCache = new Map();
  /* Fail CLOSED: a table whose fields cannot be read is a problem, never a pass. */
  const schema = async (t) => {
    if (!schemaCache.has(t)) {
      let s = null;
      try { s = await schemaOf(t); } finally { schemaCache.set(t, s); }
      if (!s) problems.push(`the fields of ${t} could not be read, so the names used on it cannot be checked.`);
    }
    return schemaCache.get(t);
  };
  const checkTable = async (t, where) => {
    if (!t || t.includes('{{') || t.includes('${')) return false;
    const found = await exists(t);
    if (!found) problems.push(`${where}: there is no table "${t}" on this instance.`);
    return found;
  };
  const checkFields = async (t, fields, where) => {
    const s = await schema(t);
    if (!s) return;
    const names = new Set(s.fields.map((f) => f.name));
    for (const f of fields) {
      const first = f.split('.')[0];
      if (!names.has(first)) problems.push(`${where}: ${t} has no field "${first}".`);
    }
  };

  /* the trigger: its table, and the fields its condition names */
  let triggerTable = null;
  if (parsed.triggerCall) {
    const obj = parsed.triggerCall.getArguments()[2];
    const t = obj?.getKind() === SK.ObjectLiteralExpression ? literal(obj.getProperty('table')?.getInitializer?.(), SK) : null;
    if (t && (await checkTable(t, 'the trigger'))) {
      triggerTable = t;
      const cond = literal(obj.getProperty('condition')?.getInitializer?.(), SK);
      if (cond) await checkFields(t, queryFields(cond), 'the trigger condition');
    }
  }

  /* each action: its table, the fields and choice values it sets */
  const varAction = new Map();
  for (const n of parsed.all) {
    if (n.callee !== 'wfa.action') continue;
    const id = /action\.core\.(\w+)/.exec(n.call.getArguments()[0]?.getText() ?? '')?.[1] ?? null;
    if (n.varName && id) varAction.set(n.varName, id);
    const obj = n.call.getArguments()[2];
    if (obj?.getKind() !== SK.ObjectLiteralExpression) continue;
    const where = `step ${n.key}${id ? ` (${id})` : ''}`;
    let t = null;
    for (const k of TABLE_INPUTS) {
      const v = literal(obj.getProperty(k)?.getInitializer?.(), SK);
      if (v && (await checkTable(v, where))) t = v;
    }
    if (!t) continue;
    for (const k of VALUE_INPUTS) {
      const init = obj.getProperty(k)?.getInitializer?.();
      if (!init || init.getKind() !== SK.CallExpression || init.getExpression().getText() !== 'TemplateValue') continue;
      const tv = init.getArguments()[0];
      if (tv?.getKind() !== SK.ObjectLiteralExpression) continue;
      const s = await schema(t);
      const byName = new Map((s?.fields ?? []).map((f) => [f.name, f]));
      const strict = await strictChoiceFields(s, choiceRows);
      for (const p of tv.getProperties()) {
        const name = p.getName?.()?.replace(/^['"]|['"]$/g, '');
        if (!name) continue;
        const f = byName.get(name);
        if (!f) { if (s) problems.push(`${where}: ${t} has no field "${name}".`); continue; }
        const v = literal(p.getInitializer?.(), SK);
        if (v !== null && strict.has(name) && f.choices?.length && !f.choices.some((c) => c.value === String(v))) {
          problems.push(`${where}: "${v}" is not a valid ${t}.${name}. Valid: ${f.choices.map((c) => `${c.value} = ${c.label}`).join(', ')}.`);
        }
      }
    }
  }

  /* every data pill: a step output that exists, or a field of the trigger record */
  for (const call of parsed.body.getDescendantsOfKind(SK.CallExpression)) {
    if (call.getExpression().getText() !== 'wfa.dataPill') continue;
    const expr = call.getArguments()[0]?.getText() ?? '';
    const parts = expr.split('.');
    if (varAction.has(parts[0])) {
      const id = varAction.get(parts[0]);
      const allowed = outputs.get(id);
      if (Array.isArray(allowed) && parts[1] && !allowed.includes(parts[1])) {
        problems.push(`data pill ${expr}: ${id} has no output "${parts[1]}". Its outputs are: ${allowed.join(', ') || 'none'}.`);
      }
    } else if (parts[1] === 'trigger' && parts[2] === 'current' && parts[3] && triggerTable) {
      await checkFields(triggerTable, [parts.slice(3).join('.')], `data pill ${expr}`);
    }
  }
  return problems;
}
