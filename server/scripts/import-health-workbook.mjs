/**
 * HEALTH ASSIST PHASE 0 — import the SAOS master rule workbook.
 *
 *   node scripts/import-health-workbook.mjs <path-to-SAOS_Health_Rules_Tracker_v2_9574.xlsx>
 *
 * The master workbook is the source of truth for WHAT Health Assist measures
 * (docs/HEALTH-ASSIST-APPROACH.md §3). This importer transcribes every sheet
 * into src/health/rules/workbook/:
 *
 *   source.json            workbook name, sha256, sheets, rule counts
 *   schema.json            the Schema sheet: fields, severity bands, modifiers, worked examples
 *   sheets/<key>.json      one per rule sheet, every row verbatim (cmdb, itsm, itom, platform, data-quality, csdm, itil)
 *   traceability.json      rule id → sheet, Excel row
 *   import-report.json     what changed against the previous import (added / removed / changed fields)
 *
 * A TRANSCRIPTION, NOT AN INTERPRETATION. Cells are carried as the strings the
 * workbook holds. The only values parsed are ones the workbook itself states as
 * numbers in prose: the severity weights ("Weight 100.") and the data-quality
 * dimension weights ("D1. Completeness (weight 12)"). There the prose is kept
 * beside the number. Every engineering decision (kind, attainment, systemic
 * role, dimension mapping, ownership) lives in the hand-maintained overlays, not
 * here.
 *
 * WHY src/health/rules/workbook/ AND NOT src/health/catalogue/. `incremental.js`
 * hashes every `*.json` directly under `catalogue/` into every module's engine
 * key. A file there would force a full re-read of every module on the next scan,
 * which is a behaviour change to the running checker. `rules/workbook/` is
 * outside that hash (the same reasoning as `rules/itsm/`). Phase 0 changes
 * nothing that runs.
 *
 * The importer REFUSES rather than adapts. It stops with the row named on any of
 * these: an unexpected header, an ID out of sequence, a duplicate ID, a value
 * outside the header, an unknown severity word, a dimension label that does not
 * parse, or a new or missing sheet.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openWorkbook } from './lib/xlsx-lite.mjs';
import { transcribe as transcribeCsdm, SUPPLEMENT_DOC as CSDM_SUPPLEMENT } from './import-csdm-catalogue.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* `--out <dir>` writes elsewhere; the test suite uses it to re-import into a temp dir and compare. */
const outFlag = process.argv.indexOf('--out');
const OUT_DIR = outFlag > 0 ? path.resolve(process.argv[outFlag + 1]) : path.resolve(HERE, '../src/health/rules/workbook');
const IMPORT_VERSION = '1.0.0';

const SEVERITY_WORDS = Object.freeze(['Systemic', 'Critical', 'High', 'Moderate', 'Low']);
/*
 * Phase 9: a Base Severity the source states that is NOT a band. CSDM-072 is "Composite" —
 * the module's composite score. It is carried as base_severity null and declared on the
 * sheet (`severity_exempt`) with the workbook's word; any other word is still refused.
 */
const SEVERITY_EXEMPT_WORDS = Object.freeze(['Composite']);

/* The twenty columns every rule sheet but "data quality" carries, in order. */
const RULE_COLUMNS = Object.freeze([
  ['A', 'Rule ID', 'id'],
  ['B', 'Group', 'group'],
  ['C', 'Rule (Exact Wording)', 'rule'],
  ['D', 'Base Severity', 'base_severity'],
  ['E', 'What It Means', 'what_it_means'],
  ['F', 'Why It Matters', 'why_it_matters'],
  ['G', 'Source Tables / Fields', 'source_tables_fields'],
  ['H', 'Detection Logic', 'detection_logic'],
  ['I', 'Threshold / Parameter', 'threshold_parameter'],
  ['J', 'Confidence Basis', 'confidence_basis'],
  ['K', 'Evidence to Show', 'evidence_to_show'],
  ['L', 'False Positive Guard', 'false_positive_guard'],
  ['M', 'Remediation Lane', 'remediation_lane'],
  ['N', 'Cross-Domain Link', 'cross_domain_link'],
  ['O', 'Implementation Status', 'implementation_status'],
  ['P', 'Implementation Notes', 'implementation_notes'],
  ['Q', 'Validation Status', 'validation_status'],
  ['R', 'Validation Notes', 'validation_notes'],
  ['S', 'Owner', 'owner'],
  ['T', 'Remarks', 'remarks'],
].map(([column, header, field]) => Object.freeze({ column, header, field })));

/* "data quality" inserts a Model column and names the group "Dimension / Group". */
const DQ_COLUMNS = Object.freeze([
  ['A', 'Rule ID', 'id'],
  ['B', 'Model', 'model'],
  ['C', 'Dimension / Group', 'group'],
  ['D', 'Rule (Exact Wording)', 'rule'],
  ['E', 'Base Severity', 'base_severity'],
  ['F', 'What It Means', 'what_it_means'],
  ['G', 'Why It Matters', 'why_it_matters'],
  ['H', 'Source Tables / Fields', 'source_tables_fields'],
  ['I', 'Detection Logic', 'detection_logic'],
  ['J', 'Threshold / Parameter', 'threshold_parameter'],
  ['K', 'Confidence Basis', 'confidence_basis'],
  ['L', 'Evidence to Show', 'evidence_to_show'],
  ['M', 'False Positive Guard', 'false_positive_guard'],
  ['N', 'Remediation Lane', 'remediation_lane'],
  ['O', 'Cross-Domain Link', 'cross_domain_link'],
  ['P', 'Implementation Status', 'implementation_status'],
  ['Q', 'Implementation Notes', 'implementation_notes'],
  ['R', 'Validation Status', 'validation_status'],
  ['S', 'Validation Notes', 'validation_notes'],
  ['T', 'Owner', 'owner'],
  ['U', 'Remarks', 'remarks'],
].map(([column, header, field]) => Object.freeze({ column, header, field })));

/*
 * Every sheet the workbook must carry. `key` is the output file; `prefix` the ID
 * shape. A sheet may be declared `placeholderAllowed`: CSDM today holds one
 * sentence ("CSDM rules will be added when provided") and no rule, and that is a
 * legitimate state, not an import error.
 */
const RULE_SHEETS = Object.freeze([
  { sheet: 'CMDB', key: 'cmdb', prefix: 'CMDB', columns: RULE_COLUMNS },
  { sheet: 'ITSM', key: 'itsm', prefix: 'ITSM', columns: RULE_COLUMNS },
  { sheet: 'CSDM', key: 'csdm', prefix: 'CSDM', columns: RULE_COLUMNS, placeholderAllowed: true },
  { sheet: 'ITOM', key: 'itom', prefix: 'ITOM', columns: RULE_COLUMNS },
  { sheet: 'platform', key: 'platform', prefix: 'PLT', columns: RULE_COLUMNS },
  { sheet: 'data quality', key: 'data-quality', prefix: 'DQ', columns: DQ_COLUMNS, models: true },
  /* Phase 10: the ITIL practice catalogue (148 rules), supplied as ITIL.xlsx and added to the master workbook (scripts/import-itil-catalogue.mjs). */
  { sheet: 'ITIL', key: 'itil', prefix: 'ITIL', columns: RULE_COLUMNS },
]);
const SCHEMA_SHEET = 'Schema';
const EXPECTED_SHEETS = Object.freeze([SCHEMA_SHEET, ...RULE_SHEETS.map((s) => s.sheet)]);

/* Data-quality dimension labels state their weight in prose: "D6. Relationship integrity (weight 16 — highest)". */
const DIMENSION_LABEL = /^([A-Z]\d+)\.\s+(.+?)\s+\(weight\s+(\d+)(?:\s+—\s+([^)]+))?\)$/;

function fail(msg) {
  process.stderr.write(`import-health-workbook: ${msg}\n`);
  process.exit(1);
}

/* ── the Schema sheet (located by section headings, not fixed rows) ─────── */

function readSchema(rows) {
  const ordered = [...rows.entries()].sort((a, b) => a[0] - b[0]);
  const rowsAfter = (heading) => {
    const i = ordered.findIndex(([, r]) => r.A === heading);
    if (i < 0) fail(`Schema sheet: heading "${heading}" not found`);
    const out = [];
    let prev = ordered[i][0];
    for (let k = i + 1; k < ordered.length; k++) {
      const [n, r] = ordered[k];
      if (n !== prev + 1) break;   // a blank row is absent from the XML: a gap ends the section
      out.push([n, r]);
      prev = n;
    }
    return out;
  };
  const bands = rowsAfter('Severity bands').map(([n, r]) => {
    const w = /Weight\s+(\d+)\./.exec(r.B || '');
    if (!SEVERITY_WORDS.includes(r.A)) fail(`Schema row ${n}: severity band "${r.A}" is not one of ${SEVERITY_WORDS.join(', ')}`);
    if (!w) fail(`Schema row ${n}: severity band "${r.A}" states no "Weight N."`);
    return { excel_row: n, band: r.A, description: r.B, weight: Number(w[1]) };
  });
  return {
    title: ordered[0]?.[1]?.A ?? null,
    preamble: ordered.find(([n]) => n === 2)?.[1]?.A ?? null,
    fields: rowsAfter('Field').map(([n, r]) => ({ excel_row: n, header: r.A, purpose: r.B ?? null, fill_rule: r.C ?? null })),
    severity_bands: bands,
    severity_modifiers: rowsAfter('Severity modifiers').map(([n, r]) => ({ excel_row: n, modifier: r.A, conditions: r.B ?? null })),
    worked_examples: rowsAfter('Worked examples of the modifier logic').map(([n, r]) => ({ excel_row: n, text: r.A })),
  };
}

/* ── one rule sheet ─────────────────────────────────────────────────────── */

function readRuleSheet(wb, spec) {
  const rows = wb.sheet(spec.sheet);
  const header = rows.get(1) || {};
  for (const c of spec.columns) {
    if (header[c.column] !== c.header) fail(`${spec.sheet} header ${c.column}1 is ${JSON.stringify(header[c.column])}, expected ${JSON.stringify(c.header)}`);
  }
  const stray = Object.keys(header).filter((col) => !spec.columns.some((c) => c.column === col));
  if (stray.length) fail(`${spec.sheet} has header columns this importer does not know: ${stray.join(', ')}`);

  const data = [...rows.entries()].filter(([n]) => n !== 1).sort((a, b) => a[0] - b[0]);
  const idPattern = new RegExp(`^${spec.prefix}-(\\d{3})$`);
  const idRows = data.filter(([, r]) => r.A != null && idPattern.test(r.A));
  const other = data.filter(([, r]) => !(r.A != null && idPattern.test(r.A)));

  let placeholder = null;
  if (!idRows.length && spec.placeholderAllowed) {
    /* Zero rules is legitimate only as a single sentence in column A and nothing else. */
    const texts = other.filter(([, r]) => Object.values(r).some((v) => v != null));
    if (texts.length > 1 || texts.some(([, r]) => Object.keys(r).some((k) => k !== 'A' && r[k] != null))) {
      fail(`${spec.sheet}: expected either rule rows or one placeholder sentence in column A`);
    }
    placeholder = texts[0]?.[1]?.A ?? null;
  } else if (other.some(([, r]) => Object.values(r).some((v) => v != null))) {
    const [n, r] = other.find(([, x]) => Object.values(x).some((v) => v != null));
    fail(`${spec.sheet} row ${n}: Rule ID ${JSON.stringify(r.A)} does not match ${spec.prefix}-nnn`);
  }

  const known = new Set(spec.columns.map((c) => c.column));
  const severityExempt = {};
  const rules = idRows.map(([excelRow, r], i) => {
    const expected = `${spec.prefix}-${String(i + 1).padStart(3, '0')}`;
    if (r.A !== expected) fail(`${spec.sheet} row ${excelRow}: Rule ID is ${r.A}, expected ${expected} (IDs must be contiguous and in order)`);
    for (const col of Object.keys(r)) if (!known.has(col)) fail(`${spec.sheet} row ${excelRow}: a value in column ${col}, outside the header`);
    const severity = r[spec.columns.find((c) => c.field === 'base_severity').column];
    const exempt = SEVERITY_EXEMPT_WORDS.includes(severity);
    if (!SEVERITY_WORDS.includes(severity) && !exempt) {
      fail(`${spec.sheet} row ${excelRow} (${r.A}): base severity is not one of ${SEVERITY_WORDS.join(', ')}`);
    }
    const entry = { id: r.A, excel_row: excelRow };
    for (const c of spec.columns) if (c.field !== 'id') entry[c.field] = r[c.column] ?? null;
    if (exempt) { entry.base_severity = null; severityExempt[r.A] = entry.remarks ?? `Severity as stated: "${severity}" — no severity band`; }
    return entry;
  });

  const groups = [];
  for (const r of rules) {
    const g = groups.find((x) => x.group === r.group && (!spec.models || x.model === r.model));
    if (g) g.rules += 1;
    else groups.push({ ...(spec.models ? { model: r.model } : {}), group: r.group, rules: 1 });
  }

  const out = {
    sheet: spec.sheet,
    id_prefix: spec.prefix,
    rule_count: rules.length,
    placeholder,
    columns: spec.columns.map((c) => ({ column: c.column, header: c.header, field: c.field })),
    groups_observed: groups,
    ...(Object.keys(severityExempt).length ? { severity_exempt: severityExempt } : {}),
  };
  if (spec.models) out.models = readModels(spec, rules);
  out.rules = rules;
  return out;
}

/**
 * The data-quality sheet defines scoring MODELS: each model's dimensions carry
 * their weight in the label. Parsed strictly. A label that does not parse is an
 * import error, because it is the workbook's own statement of a weight.
 */
function readModels(spec, rules) {
  const models = [];
  for (const r of rules) {
    const m = DIMENSION_LABEL.exec(r.group || '');
    if (!m) fail(`${spec.sheet} ${r.id}: dimension label ${JSON.stringify(r.group)} does not read "<Key>. <Label> (weight N[ — note])"`);
    let model = models.find((x) => x.model === r.model);
    if (!model) models.push(model = { model: r.model, dimensions: [] });
    let dim = model.dimensions.find((d) => d.key === m[1]);
    if (!dim) {
      model.dimensions.push(dim = { key: m[1], label: m[2], weight: Number(m[3]), weight_note: m[4] ?? null, workbook_label: r.group, rules: [] });
    } else if (dim.workbook_label !== r.group) {
      fail(`${spec.sheet} ${r.id}: dimension ${m[1]} is labelled two ways: ${JSON.stringify(dim.workbook_label)} and ${JSON.stringify(r.group)}`);
    }
    dim.rules.push(r.id);
  }
  for (const model of models) {
    model.weight_total = model.dimensions.reduce((n, d) => n + d.weight, 0);
    if (model.weight_total !== 100) fail(`${spec.sheet}: model "${model.model}" dimension weights sum to ${model.weight_total}, not 100`);
  }
  return models;
}

/* ── the change report against the previous import ─────────────────────── */

function diffSheets(previous, current) {
  const report = {};
  for (const [key, cur] of Object.entries(current)) {
    const prev = previous[key];
    const before = new Map((prev?.rules || []).map((r) => [r.id, r]));
    const after = new Map(cur.rules.map((r) => [r.id, r]));
    const changed = [];
    for (const [id, r] of after) {
      const o = before.get(id);
      if (!o) continue;
      const fields = Object.keys(r).filter((f) => f !== 'excel_row' && (r[f] ?? null) !== (o[f] ?? null));
      if (fields.length) changed.push({ id, fields });
    }
    report[key] = {
      previous_rules: prev ? prev.rules.length : null,
      rules: cur.rules.length,
      added: [...after.keys()].filter((id) => !before.has(id)),
      removed: [...before.keys()].filter((id) => !after.has(id)),
      changed,
    };
  }
  return report;
}

/* ── main ───────────────────────────────────────────────────────────────── */

const workbookPath = process.argv[2];
if (!workbookPath || workbookPath === '--out') fail('usage: node scripts/import-health-workbook.mjs <SAOS_Health_Rules_Tracker_v2_9574.xlsx> [--out <dir>]');
if (!fs.existsSync(workbookPath)) fail(`no such file: ${workbookPath}`);

const bytes = fs.readFileSync(workbookPath);
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
const wb = openWorkbook(bytes);

const missing = EXPECTED_SHEETS.filter((s) => !wb.sheetNames.includes(s));
const unknown = wb.sheetNames.filter((s) => !EXPECTED_SHEETS.includes(s));
if (missing.length) fail(`the workbook is missing sheet(s): ${missing.join(', ')}`);
if (unknown.length) fail(`the workbook has sheet(s) this importer does not know: ${unknown.join(', ')}. Add them to RULE_SHEETS deliberately.`);

const schema = readSchema(wb.sheet(SCHEMA_SHEET));
const schemaHeaders = schema.fields.map((f) => f.header);
const expectedSchema = ['Rule ID', 'Group', 'Rule (Exact Wording)', 'Base Severity', 'What It Means', 'Why It Matters',
  'Source Tables / Fields', 'Detection Logic', 'Threshold / Parameter', 'Confidence Basis', 'Evidence to Show',
  'False Positive Guard', 'Remediation Lane', 'Cross-Domain Link', 'Implementation Status', 'Validation Status'];
if (JSON.stringify(schemaHeaders) !== JSON.stringify(expectedSchema)) {
  fail(`the Schema sheet's field list changed.\n  sheet:    ${schemaHeaders.join(' | ')}\n  expected: ${expectedSchema.join(' | ')}`);
}

const generated = new Date().toISOString().slice(0, 10);
const source = { workbook: path.basename(workbookPath), workbook_sha256: sha256, bytes: bytes.length };

const sheets = {};
for (const spec of RULE_SHEETS) sheets[spec.key] = { source, ...readRuleSheet(wb, spec) };

const previous = {};
for (const spec of RULE_SHEETS) {
  const f = path.join(OUT_DIR, 'sheets', `${spec.key}.json`);
  if (fs.existsSync(f)) previous[spec.key] = JSON.parse(fs.readFileSync(f, 'utf8'));
}
/*
 * HEALTH ASSIST PHASE 9: a placeholder sheet whose rules were supplied as a document
 * (CSDM — supplements/, scripts/import-csdm-catalogue.mjs) keeps that transcription
 * while the workbook sheet is still a placeholder. When the workbook carries the rules,
 * the workbook wins.
 */
if (!sheets.csdm.rule_count && fs.existsSync(CSDM_SUPPLEMENT)) {
  sheets.csdm = transcribeCsdm(fs.readFileSync(CSDM_SUPPLEMENT, 'utf8'), { source, columns: sheets.csdm.columns });
  process.stdout.write(`  csdm: the workbook sheet is a placeholder — transcribed ${sheets.csdm.supplement.file} (${sheets.csdm.rule_count} rules)\n`);
}
const previousSource = fs.existsSync(path.join(OUT_DIR, 'source.json'))
  ? JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'source.json'), 'utf8')) : null;

const report = {
  generated,
  workbook: source,
  previous_workbook_sha256: previousSource?.workbook_sha256 ?? null,
  unchanged: previousSource?.workbook_sha256 === sha256,
  sheets: diffSheets(previous, sheets),
};

const sourceJson = {
  import_version: IMPORT_VERSION,
  ...source,
  generated,
  generator: 'server/scripts/import-health-workbook.mjs',
  sheets: Object.fromEntries(RULE_SHEETS.map((s) => [s.key, {
    sheet: s.sheet,
    file: `sheets/${s.key}.json`,
    rules: sheets[s.key].rule_count,
    id_range: sheets[s.key].rule_count ? [sheets[s.key].rules[0].id, sheets[s.key].rules.at(-1).id] : null,
    placeholder: sheets[s.key].placeholder,
    ...(sheets[s.key].supplement ? { supplement: sheets[s.key].supplement.file } : {}),
  }])),
  schema_sheet: SCHEMA_SHEET,
};

const traceability = {
  workbook: source,
  entries: RULE_SHEETS.flatMap((s) => sheets[s.key].rules.map((r) => ({ rule_id: r.id, sheet: s.sheet, excel_row: r.excel_row, file: `sheets/${s.key}.json`, ...(sheets[s.key].supplement ? { supplement: sheets[s.key].supplement.file } : {}) }))),
};

const write = (rel, obj) => {
  const f = path.join(OUT_DIR, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `${JSON.stringify(obj, null, 1)}\n`);
};
write('source.json', sourceJson);
write('schema.json', { source, ...schema });
for (const s of RULE_SHEETS) write(`sheets/${s.key}.json`, sheets[s.key]);
write('traceability.json', traceability);
write('import-report.json', report);

const line = RULE_SHEETS.map((s) => `${s.sheet} ${sheets[s.key].rule_count}`).join(' · ');
process.stdout.write(`imported ${source.workbook} (sha256 ${sha256.slice(0, 12)}…): ${line}\n`);
for (const [k, r] of Object.entries(report.sheets)) {
  if (r.added.length || r.removed.length || r.changed.length) {
    process.stdout.write(`  ${k}: +${r.added.length} −${r.removed.length} ~${r.changed.length}\n`);
  }
}
