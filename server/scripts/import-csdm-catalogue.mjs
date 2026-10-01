/**
 * HEALTH ASSIST PHASE 9 — transcribe the CSDM rule catalogue into the workbook's CSDM sheet.
 *
 *   node scripts/import-csdm-catalogue.mjs [--check]
 *
 * The master workbook's CSDM sheet is still a placeholder ("CSDM rules will be added
 * when provided"). The product owner supplied the 80 rules as a document, the CSDM KPI
 * Articulation, kept VERBATIM at rules/workbook/supplements/csdm-kpi-articulation.md.
 * This script transcribes it into sheets/csdm.json in the CSDM sheet's own 20-column
 * shape (A Rule ID … T Remarks), so every consumer reads it exactly as it reads a
 * workbook sheet. Like the workbook importer, it is a TRANSCRIPTION, NOT AN
 * INTERPRETATION:
 *
 *   Rule (Exact Wording)   the title after "CSDM-nnn —"
 *   Base Severity          the severity sentence's first word; the sentence itself is
 *                          kept in Remarks when it says more ("Systemic below threshold")
 *   What It Means          the first sentence of the prose
 *   Why It Matters         the rest of the prose
 *   Detection Logic        "Detect: …"
 *   Confidence Basis       "Confidence: …"
 *   False-Positive Guard   "Guard: …"
 *   Remediation Lane       "Lane …" / "No lane …"
 *   Cross-Domain Link      what follows the lane ("Joins …", "Feeds …", "The CSDM-side twin of …")
 *
 * The document states no source tables, threshold or evidence column; those cells say
 * so rather than being filled. CSDM-072's severity is "Composite" — no band — and is
 * recorded as such (`severity_exempt`): it is the module's composite score, not a rule
 * with a band. The sheet row a rule occupies is its position in the CSDM sheet layout
 * (CSDM-001 on row 2), the row it takes when the rules are entered in the workbook.
 *
 * The workbook importer (import-health-workbook.mjs) runs this same transcription while the
 * workbook's CSDM sheet is a placeholder; when the workbook carries the rules, the workbook wins.
 *
 * Phase 9 follow-up (D-031): `--write-workbook <xlsx>` writes these rows INTO the master
 * workbook's CSDM sheet, in the shape of the other rule sheets; from then on the workbook
 * importer reads them from the workbook, and this transcription is the check that the
 * workbook still says what the supplied document says.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '../src/health/rules/workbook');
const DOC = path.join(WB, 'supplements/csdm-kpi-articulation.md');
export const SUPPLIED_ON = '2026-09-25';
export const SUPPLEMENT_DOC = DOC;
const SEVERITY_WORDS = ['Systemic', 'Critical', 'High', 'Moderate', 'Low'];
const NOT_STATED = {
  source_tables_fields: 'Not stated in the CSDM KPI Articulation — see Detection Logic.',
  threshold_parameter: 'Not stated separately in the CSDM KPI Articulation — see Detection Logic.',
  evidence_to_show: 'Not stated in the CSDM KPI Articulation.',
  why_it_matters: 'Not stated separately in the CSDM KPI Articulation — see What It Means.',
  cross_domain_link: 'None stated.',
};
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

class TranscriptionError extends Error {}
const fail = (m) => { throw new TranscriptionError(m); };

/** Split at the first sentence end (". " followed by a capital, a quote or a digit). */
const firstSentence = (s) => { const m = /^(.+?[.!?])\s+(?=["“A-Z0-9])/.exec(s); return m ? [m[1], s.slice(m[0].length)] : [s, '']; };

export function parseRule(line, group) {
  const m = /^(CSDM-\d{3}) — (.+)$/.exec(line);
  if (!m) fail(`not a rule line: ${line.slice(0, 60)}`);
  const [, id, body] = m;
  const [titleWithDot, afterTitle] = firstSentence(body);
  const [severitySentence, afterSeverity] = firstSentence(afterTitle);
  const severityWord = severitySentence.replace(/[.,].*$/, '').split(/\s+/)[0];
  const cut = (text, label, next) => {
    const i = text.indexOf(`${label}: `);
    if (i < 0) fail(`${id}: no "${label}:"`);
    const rest = text.slice(i + label.length + 2);
    const j = next.map((n) => rest.search(n)).filter((x) => x >= 0).sort((a, b) => a - b)[0];
    return [text.slice(0, i).trim(), j == null ? rest.trim() : rest.slice(0, j).trim(), j == null ? '' : rest.slice(j).trim()];
  };
  const [prose, detect, r1] = cut(afterSeverity, 'Detect', [/ Confidence: /]);
  const [, confidence, r2] = cut(`Confidence: ${r1.replace(/^Confidence: /, '')}`, 'Confidence', [/ Guard: /]);
  const [, guard, r3] = cut(`Guard: ${r2.replace(/^Guard: /, '')}`, 'Guard', [/ (No lane|Lane \d)/]);
  if (!/^(No lane|Lane \d)/.test(r3)) fail(`${id}: no remediation lane`);
  /* The lane is its sentence; anything after it is the cross-domain link. */
  const lm = /^((?:No lane|Lane \d)[^]*?\.)(?:\s+(.*))?$/.exec(r3);
  const lane = lm[1].trim();
  const link = (lm[2] || '').trim();
  const [means, matters] = firstSentence(prose);
  const exempt = !SEVERITY_WORDS.includes(severityWord);
  return {
    id,
    group,
    rule: titleWithDot.replace(/\.$/, ''),
    base_severity: exempt ? null : severityWord,
    what_it_means: means,
    why_it_matters: matters || NOT_STATED.why_it_matters,
    source_tables_fields: NOT_STATED.source_tables_fields,
    detection_logic: detect,
    threshold_parameter: NOT_STATED.threshold_parameter,
    confidence_basis: confidence,
    evidence_to_show: NOT_STATED.evidence_to_show,
    false_positive_guard: guard,
    remediation_lane: lane,
    cross_domain_link: link || NOT_STATED.cross_domain_link,
    implementation_status: 'Not Started',
    implementation_notes: null,
    validation_status: 'Not Tested',
    validation_notes: null,
    owner: null,
    remarks: exempt
      ? `Severity as supplied: "${severitySentence}" — no severity band; the module's composite score, not a banded rule`
      : severitySentence.replace(/\.$/, '') === severityWord ? null : `Severity as supplied: "${severitySentence}"`,
  };
}

/** `source` / `columns`: the workbook import's own (the importer passes them); by default the committed ones. */
export function transcribe(text = fs.readFileSync(DOC, 'utf8'), { source = null, columns = null } = {}) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const rules = [];
  const groups = [];
  const notes = [];
  let group = null;
  for (const l of lines) {
    if (/^Group \d+ — /.test(l)) { group = l.trim(); groups.push({ group, rules: 0 }); continue; }
    if (/^CSDM-\d{3} — /.test(l)) {
      if (!group) fail('a rule before any group');
      const r = parseRule(l.trim(), group);
      const expected = `CSDM-${String(rules.length + 1).padStart(3, '0')}`;
      if (r.id !== expected) fail(`${r.id} out of sequence (expected ${expected})`);
      rules.push({ ...r, excel_row: rules.length + 2 });
      groups.at(-1).rules += 1;
      continue;
    }
    notes.push({ after: rules.at(-1)?.id ?? null, group, text: l.trim() });
  }
  const sha = crypto.createHash('sha256').update(text).digest('hex');
  const master = source ?? read(path.join(WB, 'source.json'));
  const shape = columns ? { columns } : read(path.join(WB, 'sheets/csdm.json'));
  return {
    source: { workbook: master.workbook, workbook_sha256: master.workbook_sha256, bytes: master.bytes },
    supplement: {
      file: 'supplements/csdm-kpi-articulation.md', title: 'CSDM KPI Articulation', sha256: sha, bytes: Buffer.byteLength(text),
      supplied_on: SUPPLIED_ON, supplied_by: 'product owner',
      note: 'The workbook CSDM sheet is a placeholder; its rules were supplied as this document and are transcribed here in the sheet\'s column shape (scripts/import-csdm-catalogue.mjs).',
    },
    sheet: 'CSDM',
    id_prefix: 'CSDM',
    rule_count: rules.length,
    placeholder: null,
    columns: shape.columns,
    groups_observed: groups,
    severity_exempt: Object.fromEntries(rules.filter((r) => r.base_severity == null).map((r) => [r.id, r.remarks])),
    notes,
    rules: rules.map((r) => ({ id: r.id, excel_row: r.excel_row, ...Object.fromEntries(Object.entries(r).filter(([k]) => !['id', 'excel_row'].includes(k))) })),
  };
}

const xmlEscape = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const COLUMNS = ['id', 'group', 'rule', 'base_severity', 'what_it_means', 'why_it_matters', 'source_tables_fields', 'detection_logic', 'threshold_parameter', 'confidence_basis', 'evidence_to_show', 'false_positive_guard', 'remediation_lane', 'cross_domain_link', 'implementation_status', 'implementation_notes', 'validation_status', 'validation_notes', 'owner', 'remarks'];
const LETTERS = 'ABCDEFGHIJKLMNOPQRST'.split('');
/* The workbook's own cell styles (measured on its CMDB, ITSM, ITOM, platform and data-quality sheets): text 3, severity bands 5–9. */
const SEVERITY_STYLE = { Systemic: 5, Critical: 6, High: 7, Moderate: 8, Low: 9 };
const TEXT_STYLE = 3;

/**
 * PHASE 9 (D-031) — write the transcribed rules INTO the master workbook's CSDM sheet, in
 * the shape every other rule sheet has: one row per rule (height 92.1), text cells in the
 * workbook's text style, the Base Severity cell in its band's style, "Not Started" /
 * "Not Tested" from the workbook's own shared strings. Only xl/worksheets/<CSDM>.xml
 * changes; every other part of the file is carried over as it was. A copy of the file as
 * it was is written beside it first.
 */
export async function writeWorkbook(xlsxPath, { backup = true } = {}) {
  const JSZip = (await import('jszip')).default;
  const bytes = fs.readFileSync(xlsxPath);
  const zip = await JSZip.loadAsync(bytes);
  const wbXml = await zip.file('xl/workbook.xml').async('string');
  const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const rid = /<sheet name="CSDM" sheetId="\d+" r:id="(rId\d+)"/.exec(wbXml)?.[1];
  const target = rid && new RegExp(`<Relationship Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels)?.[1];
  if (!target) throw new TranscriptionError('the workbook has no CSDM sheet');
  const partName = `xl/${target.replace(/^\/?xl\//, '')}`;
  const xml = await zip.file(partName).async('string');
  if (!/<row r="2"[^>]*><c r="A2"[^>]*t="s"><v>\d+<\/v><\/c>/.test(xml) || /<row r="3"/.test(xml)) throw new TranscriptionError('the CSDM sheet is not the one-sentence placeholder; refusing to overwrite rules');
  const sst = [...(await zip.file('xl/sharedStrings.xml').async('string')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => m[1].replace(/<[^>]+>/g, ''));
  const shared = (text) => { const i = sst.indexOf(text); return i >= 0 ? i : null; };
  const doc = transcribe();
  const cell = (ref, style, value) => {
    if (value == null || value === '') return `<c r="${ref}" s="${style}"/>`;
    const i = shared(value);
    return i != null ? `<c r="${ref}" s="${style}" t="s"><v>${i}</v></c>` : `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
  };
  const rows = doc.rules.map((r) => {
    const n = r.excel_row;
    const cells = COLUMNS.map((f, i) => {
      if (f === 'base_severity') {
        const word = r.base_severity ?? /Severity as supplied: "([^".]+)/.exec(r.remarks)?.[1];
        return cell(`D${n}`, SEVERITY_STYLE[r.base_severity] ?? TEXT_STYLE, word);
      }
      return cell(`${LETTERS[i]}${n}`, TEXT_STYLE, r[f]);
    });
    return `<row r="${n}" spans="1:20" ht="92.1" customHeight="1">${cells.join('')}</row>`;
  });
  const last = doc.rules.at(-1).excel_row;
  const header = /<row r="1"[\s\S]*?<\/row>/.exec(xml)[0];
  const out = xml
    .replace(/<sheetData>[\s\S]*<\/sheetData>/, `<sheetData>${header}${rows.join('')}</sheetData>`)
    .replace(/<dimension ref="A1:T\d+"\/>/, `<dimension ref="A1:T${last}"/>`)
    .replace(/<autoFilter ref="A1:T\d+"/, `<autoFilter ref="A1:T${last}"`);
  if (backup) {
    const b = xlsxPath.replace(/\.xlsx$/i, `.before-csdm-${SUPPLIED_ON}.xlsx`);
    if (!fs.existsSync(b)) fs.writeFileSync(b, bytes);
  }
  zip.file(partName, out);
  const next = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  fs.writeFileSync(xlsxPath, next);
  return { sheet: partName, rules: doc.rules.length, last_row: last };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--write-workbook');
  if (i < 0 || !process.argv[i + 1]) {
    const t = transcribe();
    process.stdout.write(`csdm: ${t.rule_count} rules in ${t.groups_observed.length} groups (transcribed; pass --write-workbook <xlsx> to write them into the CSDM sheet)\n`);
  } else {
    const r = await writeWorkbook(path.resolve(process.argv[i + 1]));
    process.stdout.write(`wrote ${r.rules} rules into ${r.sheet} (rows 2–${r.last_row}); now re-import the workbook\n`);
  }
}
