/**
 * HEALTH ASSIST PHASE 1 — seed / merge the CMDB parameter declarations.
 *
 *   node scripts/health-cmdb-parameters.mjs [--refresh-proposals]
 *
 * The CMDB rule packs keep their defaults in code (`*_DEFAULTS` in cmdb-*.js):
 * the code is the single source of the DEFAULT VALUE. This script writes the
 * metadata a person reviews beside it, one entry per pack key:
 *
 *   src/health/rules/workbook/params/cmdb-packs.json
 *     type, unit, min/max, class, overridable (and why not), the catalogue rules
 *     it tunes, and a snapshot of the default so a silent change to a code
 *     default fails the suite until someone looks at it.
 *
 * Same merge contract as the overlays: a `reviewed: true` entry is never
 * touched; an unreviewed one keeps its values unless --refresh-proposals; a key
 * that left the code is kept and marked `orphan`. `default` is always refreshed
 * from the code, and the test suite compares it with the reviewed snapshot.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HEALTH = path.resolve(HERE, '../src/health');
const OUT = path.join(HEALTH, 'rules/workbook/params/cmdb-packs.json');
const refresh = process.argv.includes('--refresh-proposals');

const { CMDB_PARAMETER_PACKS, describeDefault } = await import(pathToFileURL(path.join(HEALTH, 'parameter-registry.js')).href);

/* Keys whose value is a fact about THIS customer's estate, not a SAOS threshold. */
const ESTATE_FACTS = new Set([
  'productionCidrs', 'productionDiscoverySources', 'vipCidrs', 'permittedClassPairs', 'independentKeySpaces',
  'discoveryMaintainedTypes', 'scriptAccountSeed', 'manualSourceValues', 'retentionDays', 'healthJobName',
  'nonProduction', 'liveStages', 'deadStages', 'genericNames', 'placeholders', 'placeholderPrefixes',
  'dqInactiveInstallStatus', 'inactiveInstallStatus', 'bcCriticality', 'retiring',
]);
/* Constants that compute a finding's confidence, not whether it fires. */
const MODEL_CONSTANTS = /Confidence$/;
const FRACTION = /Confidence|Share|Decile|fuzzyThreshold|signatureBestMin|signatureCurrentMax|minRelatedShare/;

function typeOf(key, value) {
  if (value instanceof RegExp) return { type: 'regex' };
  if (Array.isArray(value)) {
    if (value.length && value.every((x) => x instanceof RegExp)) return { type: 'regex_list' };
    if (/Cidrs$/.test(key)) return { type: 'cidr_list' };
    if (value.length && value.every((x) => Array.isArray(x))) return { type: 'map' };
    return { type: 'list' };
  }
  if (value === null) return /Days$/.test(key) ? { type: 'duration', unit: 'days', nullable: true } : { type: 'number', nullable: true };
  if (typeof value === 'boolean') return { type: 'boolean' };
  if (typeof value === 'string') return { type: 'string' };
  if (typeof value === 'number') {
    if (/Pct$/.test(key)) return { type: 'percent', unit: '%', min: 0, max: 100 };
    if (/Days$/.test(key)) return { type: 'duration', unit: 'days', min: 0 };
    if (/Hours$/.test(key)) return { type: 'duration', unit: 'hours', min: 0 };
    if (/Ms$/.test(key)) return { type: 'duration', unit: 'ms', min: 0 };
    return FRACTION.test(key) ? { type: 'number', min: 0, max: 1 } : { type: 'number', min: 0 };
  }
  if (typeof value === 'object') {
    return Object.values(value).every((v) => typeof v === 'number') ? { type: 'number_map' } : { type: 'map' };
  }
  return { type: 'unknown' };
}

const NOT_OVERRIDABLE = {
  regex: 'A pattern override is a code-execution surface (catastrophic backtracking) and needs its own review; not overridable in Phase 1.',
  regex_list: 'A pattern override is a code-execution surface (catastrophic backtracking) and needs its own review; not overridable in Phase 1.',
  map: 'A nested structure (class tiers, ranges, seeds): not overridable until it has a typed shape.',
  unknown: 'Unrecognised shape.',
};

/* The catalogue rule ids a pack key names in the comment on its own line. */
function ruleComments(file) {
  const src = fs.readFileSync(path.join(HEALTH, file), 'utf8');
  const out = {};
  for (const line of src.split('\n')) {
    const m = /^\s{2}([A-Za-z]+):\s.*?\/\/\s*(.*)$/.exec(line);
    if (!m) continue;
    const ids = m[2].match(/CMDB-\d{3}/g);
    out[m[1]] = { rules: ids ? [...new Set(ids)] : [], note: m[2].trim() };
  }
  return out;
}

function seed(scope, pack, key, value) {
  const t = typeOf(key, value);
  const comment = ruleComments(pack.file)[key];
  const cls = ESTATE_FACTS.has(key) ? 'estate_fact'
    : MODEL_CONSTANTS.test(key) ? 'model_constant'
      : ['number', 'percent', 'duration', 'number_map'].includes(t.type) ? 'rule_threshold' : 'rule_scope';
  const overridable = !NOT_OVERRIDABLE[t.type];
  return {
    ...t,
    class: cls,
    overridable,
    ...(overridable ? {} : { not_overridable_because: NOT_OVERRIDABLE[t.type] }),
    rules: comment?.rules ?? [],
    note: comment?.note ?? null,
    proposed: {
      type: `inferred from the default value${t.unit ? ` and the key suffix (${t.unit})` : ''}`,
      class: ESTATE_FACTS.has(key) ? 'a fact about the customer estate (approach §4.3)' : MODEL_CONSTANTS.test(key) ? 'a confidence constant' : 'default by type',
      rules: comment?.rules?.length ? `the code comment on this key: "${comment.note}"` : 'no rule named in the code; pending review',
    },
    reviewed: false,
  };
}

const old = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { scopes: {} };
const scopes = {};
let added = 0; let orphans = 0;
for (const [scope, pack] of Object.entries(CMDB_PARAMETER_PACKS)) {
  scopes[scope] = { label: pack.label, file: pack.file, keys: {} };
  for (const [key, value] of Object.entries(pack.defaults)) {
    const prev = old.scopes?.[scope]?.keys?.[key];
    let entry;
    if (!prev) { entry = seed(scope, pack, key, value); added += 1; }
    else if (prev.reviewed || !refresh) entry = { ...prev };
    else entry = seed(scope, pack, key, value);
    entry.default = describeDefault(value);
    delete entry.orphan;
    scopes[scope].keys[key] = entry;
  }
  for (const [key, prev] of Object.entries(old.scopes?.[scope]?.keys || {})) {
    if (!(key in pack.defaults)) { scopes[scope].keys[key] = { ...prev, orphan: true }; orphans += 1; }
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify({
  declarations_version: '0.1.0',
  module: 'cmdb',
  note: 'CMDB parameter declarations (docs/HEALTH-ASSIST-APPROACH.md §4.3). The DEFAULT VALUE lives in code (the pack\'s *_DEFAULTS); this file declares its type, unit, bounds, class and the rules it tunes. `default` is a snapshot the test suite compares with the code. These are SAOS defaults, not workbook values, unless a rule\'s workbook threshold states the same number.',
  classes: {
    rule_threshold: 'a number a rule compares against; engine key',
    rule_scope: 'which classes, fields, types or values a rule judges; engine key',
    estate_fact: 'a fact about this customer\'s estate; no customer-specific default is assumed; engine key',
    model_constant: 'a constant that computes confidence, not whether a rule fires; engine key',
  },
  scopes,
}, null, 1)}\n`);
process.stdout.write(`cmdb parameters: ${Object.values(scopes).reduce((n, s) => n + Object.keys(s.keys).length, 0)} keys in ${Object.keys(scopes).length} scopes (+${added} new, ${orphans} orphaned) → ${path.relative(process.cwd(), OUT)}\n`);
