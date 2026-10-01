#!/usr/bin/env node
/**
 * HEALTH ASSIST PHASES 5E / 6D / 7 — READ-ONLY validation of a workbook pack against the
 * configured ServiceNow instance (Dashboard → Connection). Writes nothing to the
 * instance.
 *
 *   node scripts/pack-instance-validation.mjs --pack itom|platform|enterprise_dq|csdm|itil   → src/health/rules/<pack>/instance-validation.json
 *
 * What it records (metadata and counts only — never record contents):
 *   1. every table the pack's decision table names — in a rule's requires_tables,
 *      as a candidate, or as a placeholder's candidate: exists / readable / rows
 *   2. every field a rule's requires_tables names, per table (inheritance included)
 *   3. every choice label a rule resolves ($choice): is it on the instance, which
 *      value, and the labels the instance does have for that field
 *   4. one full run of the pack through the shared runner: status, verdict,
 *      blocker kind and step per rule, with timing and request counts
 *
 * The result tells which decisions hold on a real release and which must change;
 * it changes no decision by itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const KEY = process.argv[process.argv.indexOf('--pack') + 1];
if (!['itom', 'platform', 'enterprise_dq', 'csdm', 'itil'].includes(KEY)) throw new Error('usage: --pack itom|platform|enterprise_dq|csdm|itil');
const OUT = path.join(HERE, '..', `src/health/rules/${KEY}/instance-validation.json`);

const { table: client } = await import('../src/servicenow/client.js');
const { getSettings } = await import('../src/config/store.js');
const { createEvaluationContext } = await import('../src/health/itsm/context.js');
const { createProbes } = await import('../src/health/itsm/capability.js');
const { runITSMRules } = await import('../src/health/itsm/runner.js');
const { packFor } = await import('../src/health/packs.js');
const PACK = packFor(KEY).pack;
const decisions = await import(`./lib/${KEY}-decisions.mjs`);
const RULES = decisions.RULES;
const PLACEHOLDERS = decisions.PLACEHOLDERS ?? decisions.PLACEHOLDERS ?? {};

const instance = new URL(getSettings().connection.instanceUrl).host;
const started = Date.now();
const out = { pack: KEY, instance, generated: new Date().toISOString(), read_only: true, contents_recorded: false };

const calls = { query: 0, count: 0, aggregate: 0, byTable: {} };
const bump = (k, t) => { calls[k] += 1; calls.byTable[t] = (calls.byTable[t] || 0) + 1; };
const counting = {
  async query(t, o) { bump('query', t); return client.query(t, o); },
  async count(t, q) { bump('count', t); return client.count(t, q); },
  async aggregate(t, o) { bump('aggregate', t); return client.aggregate(t, o); },
  async countBy(t, q, g) { bump('aggregate', t); return client.countBy(t, q, g); },
  async changeStamp(t, q) { bump('count', t); return client.changeStamp ? client.changeStamp(t, q) : { count: await client.count(t, q), maxUpdated: null }; },
};
const probes = createProbes({ client: counting });

/* What the decision table names. */
const walk = (node, fn) => { if (Array.isArray(node)) node.forEach((x) => walk(x, fn)); else if (node && typeof node === 'object') { fn(node); Object.values(node).forEach((x) => walk(x, fn)); } };
const fieldsByTable = {};
const choices = new Map();
const tables = new Set();
for (const d of Object.values(RULES)) {
  for (const t of d.cand || []) tables.add(t);
  walk(d.config || {}, (n) => {
    if (Array.isArray(n.requires_tables)) for (const t of n.requires_tables) { tables.add(t.table); (fieldsByTable[t.table] ||= new Set()); t.fields.forEach((f) => fieldsByTable[t.table].add(f)); }
    if (n.$choice) choices.set(`${n.$choice.table}.${n.$choice.element}.${n.$choice.label}`, n.$choice);
  });
}
for (const p of Object.values(PLACEHOLDERS)) if (p.candidate) { tables.add(p.candidate); (fieldsByTable[p.candidate] ||= new Set()); (p.expected_fields || []).forEach((f) => fieldsByTable[p.candidate].add(f)); }

/* 1. tables */
out.tables = {};
for (const t of [...tables].sort()) {
  const exists = await probes.tableExists(t);
  const readable = exists.state === 'AVAILABLE' ? await probes.readable(t) : null;
  let rows = null;
  if (readable?.state === 'AVAILABLE') { try { rows = await counting.count(t, ''); } catch (err) { rows = `count failed: ${err.message}`; } }
  out.tables[t] = { exists: exists.state, readable: readable?.state ?? null, rows, reason: exists.state === 'AVAILABLE' ? (readable?.state === 'AVAILABLE' ? null : readable?.reason ?? null) : exists.reason };
}

/* 2. fields */
out.fields = {};
for (const [t, set] of Object.entries(fieldsByTable).sort()) {
  if (out.tables[t]?.exists !== 'AVAILABLE') { out.fields[t] = { checked: false, reason: 'table not on this instance' }; continue; }
  const v = await probes.fieldsExist(t, [...set].sort());
  out.fields[t] = { checked: true, state: v.state, missing: v.missing ?? [], wanted: [...set].sort() };
}

/* 3. choice labels */
out.choices = {};
const listed = new Map();
for (const [key, c] of [...choices.entries()].sort()) {
  const lk = `${c.table}.${c.element}`;
  if (!listed.has(lk)) {
    /* As the runner does: the choice list lives on the table that DEFINES the field — walk the super classes. */
    let list = null; let owner = null;
    try {
      for (let t = c.table, i = 0; t && i < 8; i++) {
        const rows = await counting.query('sys_choice', { query: `name=${t}^element=${c.element}^inactive=false^language=en^ORDERBYsequence`, fields: 'label,value', limit: 200, display: 'false' });
        if (rows.length) { list = rows.map((r) => ({ label: r.label, value: r.value })); owner = t; break; }
        t = (await counting.query('sys_db_object', { query: `name=${t}`, fields: 'super_class.name', limit: 1, display: 'false' }))[0]?.['super_class.name'] || null;
      }
    } catch (err) { list = { error: err.message }; }
    listed.set(lk, { list: list ?? [], owner });
  }
  const { list, owner } = listed.get(lk);
  const labels = (Array.isArray(c.label) ? c.label : [c.label]).map((l) => String(l).toLowerCase());
  const hits = Array.isArray(list) ? list.filter((x) => labels.includes(String(x.label).trim().toLowerCase())) : [];
  const values = [...new Set(hits.map((h) => h.value))];
  out.choices[key] = { found: values.length === 1, value: values.length === 1 ? values[0] : null, defined_on: owner, available_labels: Array.isArray(list) ? list.map((x) => x.label) : list };
}

/* 4. one full run */
const t0 = Date.now();
const ctx = createEvaluationContext({ client: counting, now: new Date(), parameters: PACK.parameters, pack: PACK.pack });
const run = await runITSMRules(ctx, { configs: PACK.configs });
out.run = {
  elapsed_ms: Date.now() - t0, summary: run.summary, verdicts: run.verdicts,
  rules: Object.fromEntries([...run.results.entries()].sort().map(([id, r]) => [id, {
    status: r.status, verdict: r.verdict ?? null, findings: r.findings.length,
    blocker: r.blocker ? { kind: r.blocker.kind, step: r.blocker.step ?? null, table: r.blocker.table ?? r.blocker.candidate_table ?? null, fields: r.blocker.fields ?? null, parameters: r.blocker.parameters ?? null } : null,
    population: r.population ? { total: r.population.total ?? null, judged: r.population.judged ?? null, unit: r.population.unit ?? null } : null,
    undetermined: r.undetermined?.kind ?? null, ms: run.timing[id] ?? null,
  }])),
};
out.requests = calls;
out.elapsed_ms = Date.now() - started;

fs.writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
const exists = Object.values(out.tables).filter((x) => x.exists === 'AVAILABLE').length;
const missingChoices = Object.entries(out.choices).filter(([, c]) => !c.found).map(([k]) => k);
process.stdout.write(`${instance}: ${exists}/${Object.keys(out.tables).length} tables exist; ${missingChoices.length} choice label(s) not found; run ${JSON.stringify(run.summary)} ${JSON.stringify(run.verdicts)} in ${out.run.elapsed_ms} ms → ${path.relative(process.cwd(), OUT)}\n`);
