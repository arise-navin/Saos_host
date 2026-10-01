/**
 * A minimal, dependency-free .xlsx reader for the Health Assist workbook importers.
 *
 * An .xlsx is a zip of XML. Node has `zlib.inflateRawSync`, so ~80 lines read the
 * central directory, the shared-string table and a named sheet. The approach is
 * the same as `import-itsm-catalogue.mjs`, factored here so the master-workbook
 * importer does not duplicate it again. The ITSM importer keeps its own copy and
 * is unchanged.
 *
 * Values come back as the verbatim strings the workbook holds. An empty cell is
 * `null`. Nothing is parsed into a number, code or enum.
 */
import zlib from 'node:zlib';

/** name → () => string, for every entry in the zip. */
export function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`corrupt local header for ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    entries.set(name, () => {
      if (method === 8) return zlib.inflateRawSync(raw).toString('utf8');
      if (method === 0) return raw.toString('utf8');
      throw new Error(`unsupported zip method ${method} for ${name}`);
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

const textRuns = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1])).join('');

function sharedStrings(entries) {
  const xml = entries.get('xl/sharedStrings.xml')?.() ?? '';
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textRuns(m[1]));
}

/** Sheet name → worksheet part path, in workbook order. */
function sheetParts(entries) {
  const wb = entries.get('xl/workbook.xml')();
  const rels = entries.get('xl/_rels/workbook.xml.rels')();
  const targets = Object.fromEntries([...rels.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g)].map((m) => [m[1], m[2]]));
  const out = {};
  for (const m of wb.matchAll(/<sheet\b[^>]*\bname="([^"]+)"[^>]*\br:id="([^"]+)"/g)) {
    out[decodeXml(m[1])] = `xl/${targets[m[2]].replace(/^\/?xl\//, '')}`;
  }
  return out;
}

/** rows: Map<rowNumber, { [columnLetter]: string | null }>. */
function readSheet(entries, part, sst) {
  const xml = entries.get(part)();
  const rows = new Map();
  for (const m of xml.matchAll(/<c r="([A-Z]+)(\d+)"(?:[^>]*?\bt="([a-zA-Z]+)")?[^>]*?(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const [, col, rowStr, type, inner] = m;
    let value = null;
    if (inner != null) {
      if (type === 's') { const v = /<v>(\d+)<\/v>/.exec(inner); value = v ? sst[Number(v[1])] : null; }
      else if (type === 'inlineStr') value = textRuns(inner);
      else { const v = /<v>([\s\S]*?)<\/v>/.exec(inner); value = v ? decodeXml(v[1]) : null; }
    }
    if (value === '') value = null;
    const r = Number(rowStr);
    if (!rows.has(r)) rows.set(r, {});
    rows.get(r)[col] = value;
  }
  return rows;
}

/** Open a workbook buffer: { sheetNames, sheet(name) → rows Map }. */
export function openWorkbook(buf) {
  const entries = zipEntries(buf);
  const sst = sharedStrings(entries);
  const parts = sheetParts(entries);
  return {
    sheetNames: Object.keys(parts),
    sheet(name) {
      if (!parts[name]) throw new Error(`the workbook has no sheet named "${name}" (sheets: ${Object.keys(parts).join(', ')})`);
      return readSheet(entries, parts[name], sst);
    },
  };
}
