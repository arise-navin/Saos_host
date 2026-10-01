/**
 * HEALTH ASSIST PHASE 10 — transcribe the ITIL rule catalogue into the workbook's ITIL sheet.
 *
 *   node scripts/import-itil-catalogue.mjs --supplement <ITIL.xlsx>   keep the supplied file's rows verbatim
 *   node scripts/import-itil-catalogue.mjs                            transcribe (check)
 *   node scripts/import-itil-catalogue.mjs --write-workbook <xlsx>    add the ITIL sheet to the master workbook
 *
 * The product owner supplied the 148 ITIL rules as a workbook of their own (ITIL.xlsx: Rule
 * ID, Group, Rule, Base Severity, Implementation Status, Implementation Notes, Validation
 * Status, Validation Notes, Owner, Remarks). Its cell text is kept VERBATIM at
 * rules/workbook/supplements/itil-rules.json. The rule content is in "Implementation
 * Notes" as one paragraph; this script transcribes it into the master sheets' 20-column
 * shape — a TRANSCRIPTION, NOT AN INTERPRETATION:
 *
 *   What It Means          the paragraph before "*Detect:*", first sentence
 *   Why It Matters         the rest of that paragraph
 *   Detection Logic        "*Detect:* …"
 *   Confidence Basis       "*Confidence:* …"
 *   False-Positive Guard   "*Guard:* …"
 *   Remediation Lane       the italic "*Lane …*"
 *   Cross-Domain Link      what follows the lane ("Joins …")
 *
 * The supplied file states no source tables, threshold or evidence column; those cells
 * say so. Implementation / Validation Status, Owner and Remarks are carried as supplied.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '../src/health/rules/workbook');
export const SUPPLEMENT = path.join(WB, 'supplements/itil-rules.json');
export const SUPPLIED_ON = '2026-09-25';
const SEVERITY_WORDS = ['Systemic', 'Critical', 'High', 'Moderate', 'Low'];
const NOT_STATED = {
  source_tables_fields: 'Not stated in the supplied ITIL workbook — see Detection Logic.',
  threshold_parameter: 'Not stated separately in the supplied ITIL workbook — see Detection Logic.',
  evidence_to_show: 'Not stated in the supplied ITIL workbook.',
  why_it_matters: 'Not stated separately in the supplied ITIL workbook — see What It Means.',
  cross_domain_link: 'None stated.',
};
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
class TranscriptionError extends Error {}
const fail = (m) => { throw new TranscriptionError(m); };
const firstSentence = (s) => { const m = /^(.+?[.!?])\s+(?=["“A-Z0-9])/.exec(s); return m ? [m[1], s.slice(m[0].length)] : [s, '']; };

/** The supplied workbook's rows, verbatim (cell text). */
export async function readSupplied(xlsxPath) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const ws = wb.getWorksheet('ITIL') ?? wb.worksheets[0];
  const text = (v) => (v && typeof v === 'object' && v.richText ? v.richText.map((t) => t.text).join('') : v == null ? '' : String(v));
  const header = ws.getRow(1).values.slice(1).map(text);
  const rows = [];
  ws.eachRow((r, i) => { if (i > 1 && text(r.getCell(1).value)) rows.push(header.map((_, c) => text(r.getCell(c + 1).value))); });
  return { sheet: ws.name, header, rows, sha256: crypto.createHash('sha256').update(fs.readFileSync(xlsxPath)).digest('hex'), bytes: fs.statSync(xlsxPath).size };
}

export function parseRow(row, header) {
  const col = (name) => row[header.indexOf(name)] ?? '';
  const id = col('Rule ID').trim();
  if (!/^ITIL-\d{3}$/.test(id)) fail(`not a rule id: ${id}`);
  const notes = col('Implementation Notes').trim();
  const cut = (label) => { const i = notes.indexOf(`*${label}:*`); if (i < 0) fail(`${id}: no *${label}:*`); return i; };
  const d = cut('Detect'); const c = cut('Confidence'); const g = cut('Guard');
  if (!(d < c && c < g)) fail(`${id}: Detect / Confidence / Guard out of order`);
  const prose = notes.slice(0, d).trim();
  const detect = notes.slice(d + 10, c).trim();
  const confidence = notes.slice(c + 14, g).trim();
  const afterGuard = notes.slice(g + 9);
  const lm = /^([^*]*?)\s*\*((?:No lane|Lane)[^*]*)\*\s*(.*)$/s.exec(afterGuard);
  if (!lm) fail(`${id}: no italic lane after the guard`);
  const [means, matters] = firstSentence(prose);
  const severity = col('Base Severity').trim();
  if (!SEVERITY_WORDS.includes(severity)) fail(`${id}: severity "${severity}" is not a band`);
  return {
    id,
    group: col('Group').trim(),
    rule: col('Rule (Exact Wording)').trim(),
    base_severity: severity,
    what_it_means: means,
    why_it_matters: matters || NOT_STATED.why_it_matters,
    source_tables_fields: NOT_STATED.source_tables_fields,
    detection_logic: detect,
    threshold_parameter: NOT_STATED.threshold_parameter,
    confidence_basis: confidence,
    evidence_to_show: NOT_STATED.evidence_to_show,
    false_positive_guard: lm[1].trim(),
    remediation_lane: lm[2].trim(),
    cross_domain_link: lm[3].trim() || NOT_STATED.cross_domain_link,
    implementation_status: col('Implementation Status').trim() || 'Not Started',
    implementation_notes: null,
    validation_status: col('Validation Status').trim() || 'Not Tested',
    validation_notes: col('Validation Notes').trim() || null,
    owner: col('Owner').trim() || null,
    remarks: col('Remarks').trim() || null,
  };
}

/** Transcribe the kept supplement into the sheet shape (`source` / `columns`: the importer's own). */
export function transcribe(doc = read(SUPPLEMENT), { source = null, columns = null } = {}) {
  const rules = doc.rows.map((r, i) => ({ ...parseRow(r, doc.header), excel_row: i + 2 }));
  rules.forEach((r, i) => { const want = `ITIL-${String(i + 1).padStart(3, '0')}`; if (r.id !== want) fail(`${r.id} out of sequence (expected ${want})`); });
  const groups = [];
  for (const r of rules) { if (groups.at(-1)?.group !== r.group) groups.push({ group: r.group, rules: 0 }); groups.at(-1).rules += 1; }
  const master = source ?? read(path.join(WB, 'source.json'));
  const shape = columns ?? read(path.join(WB, 'sheets/csdm.json')).columns;
  return {
    source: { workbook: master.workbook, workbook_sha256: master.workbook_sha256, bytes: master.bytes },
    supplement: { file: 'supplements/itil-rules.json', title: 'ITIL (supplied workbook)', sha256: doc.sha256, bytes: doc.bytes, supplied_on: SUPPLIED_ON, supplied_by: 'product owner',
      note: 'Supplied as ITIL.xlsx; its cells are kept verbatim in the supplement and transcribed here in the master sheets\' column shape (scripts/import-itil-catalogue.mjs).' },
    sheet: 'ITIL', id_prefix: 'ITIL', rule_count: rules.length, placeholder: null, columns: shape,
    groups_observed: groups, severity_exempt: {}, notes: [],
    rules: rules.map((r) => ({ id: r.id, excel_row: r.excel_row, ...Object.fromEntries(Object.entries(r).filter(([k]) => !['id', 'excel_row'].includes(k))) })),
  };
}

const xmlEscape = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const COLUMNS = ['id', 'group', 'rule', 'base_severity', 'what_it_means', 'why_it_matters', 'source_tables_fields', 'detection_logic', 'threshold_parameter', 'confidence_basis', 'evidence_to_show', 'false_positive_guard', 'remediation_lane', 'cross_domain_link', 'implementation_status', 'implementation_notes', 'validation_status', 'validation_notes', 'owner', 'remarks'];
const LETTERS = 'ABCDEFGHIJKLMNOPQRST'.split('');
const SEVERITY_STYLE = { Systemic: 5, Critical: 6, High: 7, Moderate: 8, Low: 9 };
const TEXT_STYLE = 3;

/**
 * Add an ITIL sheet to the master workbook, in the shape of its CSDM sheet (the same
 * header row, column widths and cell styles): a new worksheet part, its workbook entry,
 * relationship and content type. Every other part is carried over as it was. Refuses when
 * an ITIL sheet already exists. A copy of the file as it was is written beside it first.
 */
export async function writeWorkbook(xlsxPath, { backup = true } = {}) {
  const JSZip = (await import('jszip')).default;
  const bytes = fs.readFileSync(xlsxPath);
  const zip = await JSZip.loadAsync(bytes);
  let wbXml = await zip.file('xl/workbook.xml').async('string');
  if (/<sheet name="ITIL"/.test(wbXml)) throw new TranscriptionError('the workbook already has an ITIL sheet; refusing to overwrite it');
  let rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const csdmRid = /<sheet name="CSDM" sheetId="\d+" r:id="(rId\d+)"/.exec(wbXml)?.[1];
  const csdmTarget = csdmRid && new RegExp(`<Relationship Id="${csdmRid}"[^>]*Target="([^"]+)"`).exec(rels)?.[1];
  if (!csdmTarget) throw new TranscriptionError('the workbook has no CSDM sheet to take the shape from');
  const template = await zip.file(`xl/${csdmTarget.replace(/^\/?xl\//, '')}`).async('string');
  const sst = [...(await zip.file('xl/sharedStrings.xml').async('string')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => m[1].replace(/<[^>]+>/g, ''));
  const shared = (text) => { const i = sst.indexOf(text); return i >= 0 ? i : null; };
  const cell = (ref, style, value) => {
    if (value == null || value === '') return `<c r="${ref}" s="${style}"/>`;
    const i = shared(value);
    return i != null ? `<c r="${ref}" s="${style}" t="s"><v>${i}</v></c>` : `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
  };
  const doc = transcribe();
  const rows = doc.rules.map((r) => `<row r="${r.excel_row}" spans="1:20" ht="92.1" customHeight="1">${COLUMNS.map((f, i) => cell(`${LETTERS[i]}${r.excel_row}`, f === 'base_severity' ? SEVERITY_STYLE[r.base_severity] ?? TEXT_STYLE : TEXT_STYLE, r[f])).join('')}</row>`);
  const last = doc.rules.at(-1).excel_row;
  const header = /<row r="1"[\s\S]*?<\/row>/.exec(template)[0];
  const sheetXml = template
    .replace(/<sheetData>[\s\S]*<\/sheetData>/, `<sheetData>${header}${rows.join('')}</sheetData>`)
    .replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:T${last}"/>`)
    .replace(/<autoFilter ref="A1:T\d+"/, `<autoFilter ref="A1:T${last}"`)
    .replace(/<tabColor[^>]*\/>/, '')
    .replace(/ tabSelected="1"/, '')
    .replace(/<tableParts[\s\S]*?<\/tableParts>|<tableParts[^>]*\/>/, '')
    .replace(/<legacyDrawing[^>]*\/>/, '')
    .replace(/<drawing[^>]*\/>/, '');
  const existing = Object.keys(zip.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).map((f) => Number(/(\d+)\.xml$/.exec(f)[1]));
  const n = Math.max(...existing) + 1;
  const part = `worksheets/sheet${n}.xml`;
  const rid = `rId${Math.max(...[...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]))) + 1}`;
  const sheetId = Math.max(...[...wbXml.matchAll(/sheetId="(\d+)"/g)].map((m) => Number(m[1]))) + 1;
  wbXml = wbXml.replace('</sheets>', `<sheet name="ITIL" sheetId="${sheetId}" r:id="${rid}"/></sheets>`);
  rels = rels.replace('</Relationships>', `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${part}"/></Relationships>`);
  let types = await zip.file('[Content_Types].xml').async('string');
  types = types.replace('</Types>', `<Override PartName="/xl/${part}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);
  if (backup) {
    const b = xlsxPath.replace(/\.xlsx$/i, `.before-itil-${SUPPLIED_ON}.xlsx`);
    if (!fs.existsSync(b)) fs.writeFileSync(b, bytes);
  }
  zip.file(`xl/${part}`, sheetXml);
  zip.file('xl/workbook.xml', wbXml);
  zip.file('xl/_rels/workbook.xml.rels', rels);
  zip.file('[Content_Types].xml', types);
  fs.writeFileSync(xlsxPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } }));
  return { sheet: `xl/${part}`, rules: doc.rules.length, last_row: last };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
  if (arg('--supplement')) {
    const s = await readSupplied(path.resolve(arg('--supplement')));
    fs.mkdirSync(path.dirname(SUPPLEMENT), { recursive: true });
    fs.writeFileSync(SUPPLEMENT, `${JSON.stringify({ file: path.basename(arg('--supplement')), supplied_on: SUPPLIED_ON, supplied_by: 'product owner', ...s }, null, 1)}\n`);
    process.stdout.write(`kept ${s.rows.length} rows verbatim → ${SUPPLEMENT}\n`);
  } else if (arg('--write-workbook')) {
    const r = await writeWorkbook(path.resolve(arg('--write-workbook')));
    process.stdout.write(`wrote ${r.rules} rules into a new ITIL sheet (${r.sheet}, rows 2–${r.last_row}); now re-import the workbook\n`);
  } else {
    const t = transcribe();
    process.stdout.write(`itil: ${t.rule_count} rules in ${t.groups_observed.length} groups (transcribed)\n`);
  }
}
