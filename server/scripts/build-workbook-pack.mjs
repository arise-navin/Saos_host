/**
 * HEALTH ASSIST — generate a workbook catalogue pack's data from its decision table.
 *
 *   node scripts/build-workbook-pack.mjs --pack itom|platform|enterprise_dq|csdm|itil [--check]
 *
 * For one pack, reads the master workbook's sheet (rules/workbook/sheets/<sheet>.json),
 * its overlay, and the pack's decision table (scripts/lib/<pack>-decisions.mjs), and
 * writes:
 *
 *   src/health/rules/<pack>/architecture-map.json   one classification per slot
 *   src/health/rules/<pack>/parameters.json         every threshold, typed; the workbook
 *                                                   default or UNDEFINED
 *   src/health/rules/<pack>/equivalents.json        rules evaluated by another module's rule
 *   src/health/rules/<pack>/placeholders.json       platform objects the configs name
 *   src/health/<pack>/rules/<engine>.json           the rule configurations
 *
 * Deterministic: the same inputs write byte-identical files. `--check` writes nothing
 * and exits 1 when a committed file differs (the suites run the same comparison).
 * Phase 5 wrote this for ITOM; Phase 6 made it generic for Platform; Phase 7 lets a
 * pack be a contiguous RANGE of a sheet (`select`, `first`) for Enterprise DQ.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..');
const WB = path.join(SERVER, 'src/health/rules/workbook');
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

export const PACKS = Object.freeze({
  itom: {
    sheet: 'itom', decisions: './lib/itom-decisions.mjs', phase: 'Health Assist Phase 5', decision: 'D-019',
    productOf: (ov) => ov?.applicability ?? 'cross_domain',
    products: {
      discovery: 'Discovery (schedules, credentials, execution, patterns)',
      mid_server: 'MID Server',
      service_mapping: 'Service Mapping',
      event_management: 'Event Management (connectors, binding, alerts, impact)',
      cloud: 'Cloud discovery, provisioning and governance',
      cross_domain: 'Cross-domain ITOM correlation (not scored)',
    },
    productNote: 'from the workbook overlay (applicability): the ITOM product whose presence the rule assumes',
  },
  platform: {
    sheet: 'platform', decisions: './lib/platform-decisions.mjs', phase: 'Health Assist Phase 6', decision: 'D-024',
    productOf: (ov) => ov?.dimension ?? null,
    products: {
      sla_engineering: 'SLA engineering (definitions, runtime, commitment linkage)',
      server_logic: 'Server-side logic (business rules, script includes)',
      client_logic: 'Client and form logic (client scripts, UI and data policies)',
      automation: 'Flows, workflows and automation',
      jobs_events: 'Scheduled jobs and events',
      access_security: 'ACLs, roles and access',
      integrations: 'Integrations and inbound',
      customisation_debt: 'Customisation and upgrade debt',
      performance: 'Performance and platform health',
    },
    productNote: 'from the workbook overlay: the Platform area (profile dimension) the rule scores in',
  },
  enterprise_dq: {
    sheet: 'data-quality', decisions: './lib/enterprise_dq-decisions.mjs', phase: 'Health Assist Phase 7', decision: 'D-026',
    /* DQ-084 … DQ-139: the sheet's Enterprise Data Quality model (DQ-001 … DQ-083 restate CMDB rules). */
    select: (r) => r.model === 'Enterprise Data Quality', first: 84,
    productOf: (ov) => ov?.dimension ?? null,
    products: {
      Q1: 'Completeness',
      Q2: 'Validity',
      Q3: 'Consistency',
      Q4: 'Uniqueness',
      Q5: 'Timeliness',
      Q6: 'Referential integrity',
      Q7: 'Sensitive data exposure',
    },
    productNote: 'from the workbook overlay: the Enterprise DQ dimension (Q1–Q7) the rule scores in',
  },
  csdm: {
    sheet: 'csdm', decisions: './lib/csdm-decisions.mjs', phase: 'Health Assist Phase 9', decision: 'D-029',
    productOf: (ov) => ov?.dimension ?? null,
    products: {
      taxonomy: 'Taxonomy conformance',
      lifecycle: 'Lifecycle integrity',
      ownership: 'Ownership',
      environment: 'Environment discipline',
      relationships: 'Relationship correctness',
      offerings: 'Offering and commitment structure',
      maturity: 'Maturity and adoption',
      cross_domain: 'Cross-domain (correlation, not scored)',
    },
    productNote: 'from the workbook overlay: the CSDM group (profile dimension) the rule scores in',
  },
  itil: {
    sheet: 'itil', decisions: './lib/itil-decisions.mjs', phase: 'Health Assist Phase 10', decision: 'D-034',
    productOf: (ov) => ov?.dimension ?? null,
    products: {
      request: 'Request Fulfilment', catalogue: 'Service Catalogue Management', knowledge: 'Knowledge Management',
      service_level: 'Service Level Management as a Practice', release: 'Release and Deployment Management', testing: 'Service Validation and Testing',
      capacity: 'Capacity and Performance Management', availability: 'Availability Management', continuity: 'Service Continuity Management',
      supplier: 'Supplier Management', service_desk: 'Service Desk', portfolio: 'Portfolio, Demand and Financial Management',
      improvement: 'Continual Improvement', cross_practice: 'Cross-Practice',
    },
    productNote: 'from the workbook overlay: the ITIL practice group (profile dimension) the rule scores in',
  },
});

const dirsOf = (key) => ({ data: path.join(SERVER, 'src/health/rules', key), rules: path.join(SERVER, 'src/health', key, 'rules') });

export async function buildPack(key) {
  const spec = PACKS[key];
  if (!spec) throw new Error(`no pack "${key}" (${Object.keys(PACKS).join(', ')})`);
  const mod = await import(pathToFileURL(path.join(HERE, spec.decisions)).href);
  const RULES = mod.RULES;
  const PLACEHOLDERS = mod.PLACEHOLDERS ?? mod.ITOM_PLACEHOLDERS ?? {};
  const { data } = dirsOf(key);
  const whole = read(path.join(WB, `sheets/${spec.sheet}.json`));
  const sheet = spec.select ? { ...whole, rules: whole.rules.filter(spec.select) } : whole;
  const first = spec.first ?? 1;
  const overlay = read(path.join(WB, `overlays/${spec.sheet}.json`)).rules;
  const itsmMap = read(path.join(SERVER, 'src/health/rules/itsm/architecture-map.json'));
  const toEngine = itsmMap.vocabularies.archetype_to_engine;
  /* The tables a read-only instance validation found (rules/<pack>/instance-validation.json). */
  const validationFile = path.join(data, 'instance-validation.json');
  const validation = fs.existsSync(validationFile) ? read(validationFile) : null;
  const verified = new Set(Object.entries(validation?.tables || {}).filter(([, t]) => t.exists === 'AVAILABLE' && t.readable === 'AVAILABLE').map(([t]) => t));

  const ids = sheet.rules.map((r) => r.id);
  const missing = ids.filter((id) => !RULES[id]);
  const extra = Object.keys(RULES).filter((id) => !ids.includes(id));
  if (missing.length || extra.length) throw new Error(`decision table and workbook disagree — missing ${missing.join(', ') || 'none'}; extra ${extra.join(', ') || 'none'}`);

  const stateOf = (d) => {
    if (d.derived_from) return 'derived';
    if (d.equivalent_of) return 'equivalent';
    const c = d.config;
    if (c.undefined_dependencies) return 'undefined';
    if (c.specification_gap) return 'specification_gap';
    if (c.build_pending) return 'not_built';
    if (c.requires_objects && !c.reader && !c.table) return 'object_unverified';
    return d.params.some((p) => p.default === null && JSON.stringify(c).includes(`"${p.key}"`)) ? 'unconfigured' : 'executable';
  };

  const entries = sheet.rules.map((r, i) => {
    const d = RULES[r.id];
    const engine = d.config?.engine ?? toEngine[d.a];
    if (!engine) throw new Error(`${r.id}: archetype ${d.a} has no engine`);
    if (d.config?.engine && d.config.engine !== toEngine[d.a] && !(d.also || []).includes(d.config.engine)) throw new Error(`${r.id}: engine ${d.config.engine} is neither ${toEngine[d.a]} nor supporting`);
    const fields = [...new Set((d.config?.requires_tables || []).flatMap((t) => t.fields.map((f) => `${t.table}.${f}`)))].sort();
    return {
      slot: first + i, rule_id: r.id, excel_row: r.excel_row, group: r.group, base_severity: r.base_severity, rule: r.rule,
      archetype: d.a, recommended_engine: toEngine[d.a], also_requires: d.also || [],
      product: spec.productOf(overlay[r.id]),
      tables: [...new Set(d.cand)].filter((t) => verified.has(t)).sort(), candidate_tables: [...new Set(d.cand)].sort(), tables_undefined: d.cand.length === 0, fields,
      dependencies: { consumes_output_of: [], interpret_with: d.deps?.interpret || [], related: d.deps?.related || [], external: [] },
      result: { state: stateOf(d) },
      equivalent_of: d.equivalent_of ?? d.derived_from ?? null,
      notes: d.note ?? null,
    };
  });

  const vocabularies = {
    archetypes: itsmMap.vocabularies.archetypes,
    engines: itsmMap.vocabularies.engines,
    archetype_to_engine: toEngine,
    products: spec.products,
    states: {
      executable: 'runs once its tables are verified on the instance',
      unconfigured: 'runs once a threshold the workbook leaves open is set',
      undefined: 'the workbook leaves part of the detection undefined',
      specification_gap: 'the workbook does not say enough to evaluate deterministically',
      object_unverified: 'needs a platform object whose table is not established',
      not_built: 'fully defined; evaluator not built in this stage',
      equivalent: 'the same condition as another module\'s rule, evaluated there',
      derived: 'the measure IS the module score (Phase 9, CSDM-072)',
    },
  };
  const map = {
    map_version: '1.0.0', phase: spec.phase, catalogue: key, workbook_sha256: sheet.source.workbook_sha256,
    rule_count: entries.length, vocabularies,
    conventions: {
      tables: `the candidate tables a read-only instance validation found present and readable (rules/${key}/instance-validation.json). Every table a config reads is also in its requires_tables, which the runner verifies on EACH instance before any read.`,
      verified_on: validation ? `${validation.instance} ${validation.generated.slice(0, 10)}` : null,
      product: spec.productNote,
    },
    entries,
  };
  /* ITOM's committed map predates the generic builder: keep its wording byte for byte. */
  if (key === 'itom') map.conventions.tables = 'the candidate tables a read-only instance validation found present and readable (Phase 5E, rules/itom/instance-validation.json). Every table a config reads is also in its requires_tables, which the runner verifies on EACH instance before any read.';

  const declarations = {};
  for (const r of sheet.rules) {
    const d = RULES[r.id];
    declarations[r.id] = {
      workbook_text: r.threshold_parameter,
      parameters: d.params.map((p) => ({ key: p.key, type: p.type, unit: p.unit, default: p.default, description: p.description, status: p.default === null ? 'UNDEFINED' : 'DEFINED', ...(p.source ? { source: p.source } : {}) })),
    };
  }
  const parameters = { version: '1.0.0', phase: spec.phase, source: sheet.source, rule_count: sheet.rules.length,
    conventions: { default: 'the workbook\'s stated default, or null with status UNDEFINED — never an invented value (DECISION 3)' }, declarations };

  const byEngine = {};
  for (const r of sheet.rules) {
    const d = RULES[r.id];
    if (d.equivalent_of || d.derived_from) continue;
    const engine = d.config.engine ?? toEngine[d.a];
    (byEngine[engine] ||= {})[r.id] = d.config;
  }
  const ruleFiles = Object.fromEntries(Object.entries(byEngine).sort(([a], [b]) => a.localeCompare(b)).map(([engine, rules]) => [engine, { engine, rules }]));
  const equivalents = { version: '1.0.0', decision: spec.decision, rules: Object.fromEntries(Object.entries(RULES).filter(([, d]) => d.equivalent_of || d.derived_from).map(([id, d]) => [id, d.derived_from ? { equivalent_of: d.derived_from, derived: true, note: d.note } : { equivalent_of: d.equivalent_of, note: d.note }])) };
  const placeholders = { version: '1.0.0', objects: PLACEHOLDERS };
  return { map, parameters, ruleFiles, equivalents, placeholders };
}

const json = (x) => `${JSON.stringify(x, null, 1)}\n`;

export async function packOutputs(key) {
  const b = await buildPack(key);
  const { data, rules } = dirsOf(key);
  const out = {
    [path.join(data, 'architecture-map.json')]: json(b.map),
    [path.join(data, 'parameters.json')]: json(b.parameters),
    [path.join(data, 'equivalents.json')]: json(b.equivalents),
    [path.join(data, 'placeholders.json')]: json(b.placeholders),
  };
  for (const [engine, file] of Object.entries(b.ruleFiles)) out[path.join(rules, `${engine}.json`)] = json(file);
  /* An engine that no longer has a rule keeps its (imported) file, emptied — never a stale copy of rules now configured elsewhere. */
  for (const f of fs.existsSync(rules) ? fs.readdirSync(rules).filter((x) => x.endsWith('.json')) : []) {
    const p = path.join(rules, f);
    if (!(p in out)) out[p] = json({ engine: f.replace(/\.json$/, ''), rules: {} });
  }
  return out;
}

export async function run(key, { check = false } = {}) {
  const files = await packOutputs(key);
  let stale = 0;
  for (const [f, text] of Object.entries(files)) {
    const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
    if (cur === text) continue;
    stale += 1;
    if (check) { process.stdout.write(`stale: ${path.relative(SERVER, f)}\n`); continue; }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  const b = await buildPack(key);
  const states = {};
  for (const e of b.map.entries) states[e.result.state] = (states[e.result.state] || 0) + 1;
  process.stdout.write(`${key}: ${check ? (stale ? 'STALE' : 'current') : `wrote ${stale} file(s)`} — ${b.map.entries.length} rules: ${JSON.stringify(states)}\n`);
  return stale;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--pack');
  const keys = i > 0 ? [process.argv[i + 1]] : Object.keys(PACKS);
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const k of keys) stale += await run(k, { check });
  if (check && stale) process.exit(1);
}
