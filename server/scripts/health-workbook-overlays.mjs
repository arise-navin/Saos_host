/**
 * HEALTH ASSIST PHASE 0 — create or merge the engineering overlays and the
 * parameter skeletons for every workbook sheet.
 *
 *   node scripts/health-workbook-overlays.mjs [--refresh-proposals]
 *
 * Reads the imported workbook (src/health/rules/workbook/sheets/*.json), the
 * module profiles, the ownership proposals and the legacy map, plus the
 * implementation's own facts (CMDB catalogue, ITSM rule configurations and
 * status matrix). It writes:
 *
 *   overlays/<sheet>.json   one entry per workbook rule: module, dimension, kind,
 *                           attainment, systemic role, ownership, equivalence,
 *                           implementation state (docs/HEALTH-ASSIST-APPROACH.md §3.1)
 *   params/<sheet>.json     one entry per workbook rule: the workbook's threshold
 *                           text and the declaration status
 *
 * THE OVERLAYS ARE HAND-MAINTAINED. This script only seeds and merges:
 *   - a rule with no entry gets one;
 *   - an entry marked `"reviewed": true` is never modified;
 *   - an unreviewed entry keeps its values; `--refresh-proposals` re-derives them;
 *   - `implementation` is a FACT about the code and is always refreshed;
 *   - an entry whose rule left the workbook is kept and marked `"orphan": true`.
 *
 * EVERY PROPOSED VALUE NAMES ITS BASIS in `proposed`. A value derived from the
 * implementation says so, and so does one read from the threshold wording. A
 * value with no defensible basis stays null and counts as pending review.
 * Nothing here is an engineering decision until a person marks it reviewed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HEALTH = path.resolve(HERE, '../src/health');
const WB = path.join(HEALTH, 'rules/workbook');
const refresh = process.argv.includes('--refresh-proposals');

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const exists = (f) => fs.existsSync(f);

const profiles = readJson(path.join(WB, 'profiles.json'));
const ownership = readJson(path.join(WB, 'ownership.json'));
const legacyMap = readJson(path.join(WB, 'legacy-map.json'));
const dependencies = readJson(path.join(WB, 'dependencies.json'));
const cmdbImpl = readJson(path.join(HEALTH, 'catalogue/cmdb.json'));
const itsmMatrix = readJson(path.join(HEALTH, 'rules/itsm/phase5-status-matrix.json'));
const itsmParams = readJson(path.join(HEALTH, 'rules/itsm/parameters.json'));

/* ITSM rule → engine, from the one config file that defines it. */
const itsmEngine = {};
for (const f of fs.readdirSync(path.join(HEALTH, 'itsm/rules')).filter((x) => x.endsWith('.json'))) {
  const j = readJson(path.join(HEALTH, 'itsm/rules', f));
  for (const id of Object.keys(j.rules || {})) itsmEngine[id] = j.rules[id]?.engine || j.engine;
}
const itsmClass = Object.fromEntries(itsmMatrix.rows.map((r) => [r.rule_id, r.classification]));

/* ITOM (Health Assist Phase 5): the pack's architecture map records each rule's state and engine. */
/* Phase 6: the same for every workbook pack (ITOM, Platform). */
/* Phase 9: CSDM is a pack over its whole sheet. */
/* Phase 10: ITIL is a pack over its whole sheet. */
const PACK_SHEETS = ['itom', 'platform', 'csdm', 'itil'];
/* Phase 7: Enterprise DQ is a pack over a RANGE of the data-quality sheet (its Enterprise Data Quality rows). */
const packEntry = Object.fromEntries([...PACK_SHEETS, 'enterprise_dq'].map((k) => {
  const f = path.join(HEALTH, `rules/${k}/architecture-map.json`);
  return [k, exists(f) ? Object.fromEntries(readJson(f).entries.map((e) => [e.rule_id, e])) : {}];
}));

const cmdbById = new Map(cmdbImpl.rules.map((r) => [r.id, r]));
const cmdbByDq = new Map(cmdbImpl.rules.filter((r) => r.dq).map((r) => [r.dq, r]));

/* Measurement dependencies the workbook states (dependencies.json): blocker → what it makes provisional. */
const blocksOf = {};
for (const d of dependencies.dependencies) (blocksOf[d.blocker] ||= []).push({ targets: d.blocks, basis: `${d.id}: ${d.source_rule} ${d.field} "${d.quote}"` });

const ownershipOf = {};
for (const c of ownership.conditions) for (const m of c.members) (ownershipOf[m] ||= []).push(c.id);

const interimLegacy = {};
for (const [legacy, m] of Object.entries(legacyMap.rules)) {
  if (m.disposition !== 'replace_when_built') continue;
  for (const w of m.workbook) (interimLegacy[w] ||= []).push(legacy);
}

/* ── proposals from the workbook wording ─────────────────────────────── */

const TREND_TEXT = /\b(trend(?:ing)?|rising|growing|growth|run over run)\b/i;
const TREND_REQ = /Requires at least \d+ (runs|snapshots|observation points|windows)/i;
const RATE_TITLE = /^(Percentage|Proportion)\b|\b(ratio|rate|share)\b/i;
const RATE_THRESHOLD = /Default (threshold )?\d+(\.\d+)?\s?%/i;
const BINARY_THRESHOLD = /^(Any occurrence|Any cycle|Fixed:|Both (fields )?(empty|absent)|All three absent|Any (unconfigured|unrestricted|disabled|unscheduled|exclusion|defined-but-unenforced|path|non-empty|band|definition|insert-only|unreviewed|empty))/i;

function wordingProposal(rule) {
  const title = rule.rule || '';
  const threshold = (rule.threshold_parameter || '').trim();
  if (TREND_REQ.test(threshold) || TREND_TEXT.test(title)) {
    return { kind: 'trend', attainment: 'none', basis: 'wording: a trend (\"' + (TREND_REQ.exec(threshold)?.[0] || TREND_TEXT.exec(title)[0]) + '\") — shown, not scored unless Systemic (approach §8.1)' };
  }
  if (RATE_TITLE.test(title) || RATE_THRESHOLD.test(threshold)) {
    return { kind: 'rate', attainment: null, basis: 'wording: a percentage/rate with a stated threshold; attainment direction (good_share vs bad_rate) needs review' };
  }
  if (BINARY_THRESHOLD.test(threshold)) {
    return { kind: null, attainment: 'binary', basis: `wording: threshold "${threshold.slice(0, 60)}" — pass/fail (approach §8.1)` };
  }
  return { kind: null, attainment: null, basis: null };
}

/* ── one entry per rule, per sheet ───────────────────────────────────── */

const moduleByKey = Object.fromEntries(profiles.modules.map((m) => [m.key, m]));
const dimensionForGroup = (moduleKey, group) => moduleByKey[moduleKey]?.dimensions?.find((d) => d.groups.includes(group)) ?? null;

const ITSM_KIND_BY_ENGINE = {
  aggregate: 'rate', configuration: 'configuration', record_predicate: 'record', linkage: 'record',
  reference_integrity: 'record', audit_history: 'record', relationship_graph: 'record', text_analysis: 'record',
  /* temporal_correlation and composite rules are mostly process measures (ITSM-106,
     ITSM-123 …), not causal explanations: kind is proposed from the wording instead. */
};
/* A cross-domain rule whose title attributes a cause explains other findings rather than measuring health. */
const CAUSAL_TITLE = /\b(causing|caused|traced to|because|jointly producing|attributed|correlating with)\b/i;
const CROSS_DOMAIN_GROUP = /^Cross-/;
const CMDB_KIND = { record: 'record', kpi: 'rate', trend: 'trend', context: 'context' };
const CMDB_ROLE = { config_absence: 'blocker', measured_kpi: 'blocker', posture: 'posture', derived: 'derived' };

function seed(sheetKey, rule) {
  const e = {
    module: null, dimension: null, kind: null, attainment: null,
    systemic_role: null, blocks: [], applicability: null,
    ownership: ownershipOf[rule.id] ?? [], equivalent_of: null,
    proposed: {}, reviewed: false,
  };
  const note = (field, basis) => { e.proposed[field] = basis; };
  const words = wordingProposal(rule);

  if (sheetKey === 'cmdb') {
    const impl = cmdbById.get(rule.id);
    e.module = 'cmdb';
    if (impl) {
      e.dimension = impl.dimension; note('dimension', impl.dimension ? `implementation: catalogue/cmdb.json dimension ${impl.dimension}` : `implementation: track "${impl.track}" (not a scored dimension)`);
      e.track = impl.track; note('track', 'implementation: catalogue/cmdb.json');
      e.kind = CMDB_KIND[impl.kind] ?? null; note('kind', `implementation: kind "${impl.kind}"`);
      e.attainment = impl.kind === 'record' ? 'record_deduction' : (['trend', 'context'].includes(impl.kind) ? 'none' : null);
      note('attainment', impl.kind === 'record' ? 'implementation: record rule → per-record deduction (Method R)' : impl.kind === 'kpi' ? 'implementation: KPI — direction needs review' : `implementation: ${impl.kind} → not scored`);
      if (rule.base_severity === 'Systemic') {
        e.systemic_role = CMDB_ROLE[impl.systemicKind] ?? null;
        note('systemic_role', `implementation: systemicKind "${impl.systemicKind}"${impl.systemicKind === 'measured_kpi' ? ' → blocker that also scores in its dimension' : ''}`);
      }
      if (impl.dq) { e.equivalent_of = impl.dq; note('equivalent_of', 'implementation: catalogue/cmdb.json `dq` link (the workbook itself does not link DQ rows to CMDB ids)'); }
    }
  } else if (sheetKey === 'data-quality') {
    const cmdbModel = rule.model === 'CMDB Quality';
    e.module = cmdbModel ? 'cmdb' : 'enterprise_dq';
    e.dimension = (/^([A-Z]\d+)\./.exec(rule.group) || [])[1] ?? null;
    note('dimension', 'workbook: data-quality "Dimension / Group"');
    if (cmdbModel) {
      const impl = cmdbByDq.get(rule.id);
      e.equivalent_of = impl?.id ?? null;
      note('equivalent_of', impl ? 'implementation: catalogue/cmdb.json `dq` link' : 'no implemented CMDB rule carries this DQ id');
    } else {
      e.kind = words.kind ?? 'record'; e.attainment = words.kind ? words.attainment : 'record_deduction';
      note('kind', words.kind ? words.basis : 'module profile: Enterprise DQ rules judge records (Method R, approach §8.2) — review configuration-type rules');
      if (e.attainment != null) note('attainment', words.kind ? words.basis : 'module profile: record rule → per-record deduction (Method R)');
      if (rule.base_severity === 'Systemic') { e.systemic_role = 'defect'; note('systemic_role', 'approach §5 default; blocker candidates identified in review'); }
    }
  } else {
    e.module = sheetKey;
    const dim = dimensionForGroup(sheetKey, rule.group);
    e.dimension = dim?.key ?? null;
    note('dimension', dim ? `profile: group "${rule.group}"` : `NO profile dimension for group "${rule.group}"`);
    if (dim?.applicability) { e.applicability = dim.applicability; note('applicability', `profile: dimension ${dim.key}`); }
    if (dim && dim.scored === false) {
      e.kind = 'correlation'; e.attainment = 'none';
      note('kind', `profile: dimension ${dim.key} is not scored`);
      note('attainment', `profile: dimension ${dim.key} is not scored — correlation feeds root-cause links, not the score`);
    } else if (CROSS_DOMAIN_GROUP.test(rule.group || '') && CAUSAL_TITLE.test(rule.rule || '')) {
      e.kind = 'correlation'; e.attainment = 'none';
      note('kind', `wording: a cross-domain rule that attributes a cause ("${CAUSAL_TITLE.exec(rule.rule)[0]}") — explains other findings, not scored (approach §8.2)`);
      note('attainment', 'correlation: not scored');
    } else if (sheetKey === 'itsm' && itsmEngine[rule.id]) {
      const eng = itsmEngine[rule.id];
      const byEngine = ITSM_KIND_BY_ENGINE[eng] ?? null;
      e.kind = words.kind === 'trend' ? 'trend' : (byEngine ?? words.kind ?? null);
      note('kind', words.kind === 'trend' ? words.basis : byEngine ? `implementation: engine "${eng}"` : (words.kind ? words.basis : `engine "${eng}" does not decide the kind; pending review`));
      e.attainment = words.attainment; if (words.basis) note('attainment', words.basis);
    } else {
      e.kind = words.kind; e.attainment = words.attainment;
      if (words.basis) { note('kind', words.basis); note('attainment', words.basis); }
    }
    if (rule.base_severity === 'Systemic') {
      e.systemic_role = e.kind === 'correlation' ? null : 'defect';
      note('systemic_role', e.kind === 'correlation' ? 'correlation rule: role decided in review' : 'approach §5 default; blocker candidates identified in review');
    }
  }
  /* Blocks: the workbook's stated dependencies, and CMDB's gating kinds (the trust gate, whole module). */
  const blocks = [];
  const blockBasis = [];
  if (sheetKey === 'cmdb') {
    const impl = cmdbById.get(rule.id);
    if (impl && rule.base_severity === 'Systemic' && ['config_absence', 'measured_kpi'].includes(impl.systemicKind)) {
      blocks.push('cmdb'); blockBasis.push(`implementation: systemicKind "${impl.systemicKind}" gates the CMDB composite (cmdb-quality.js GATING_KINDS)`);
    }
  }
  for (const d of blocksOf[rule.id] || []) { blocks.push(...d.targets); blockBasis.push(d.basis); }
  e.blocks = [...new Set(blocks)];
  if (e.blocks.length) note('blocks', blockBasis.join('; '));
  return e;
}

function implementation(sheetKey, rule) {
  if (sheetKey === 'cmdb') {
    return cmdbById.has(rule.id) ? { state: 'built', ref: rule.id, source: 'health/catalogue/cmdb.json' } : { state: 'not_built' };
  }
  if (sheetKey === 'data-quality') {
    if (rule.model === 'CMDB Quality') {
      const impl = cmdbByDq.get(rule.id);
      return impl ? { state: 'built', ref: impl.id, source: 'health/catalogue/cmdb.json (dq link)' } : { state: 'not_built' };
    }
    return packEntry.enterprise_dq[rule.id] ? packImplementation('enterprise_dq', rule) : { state: 'not_built' };
  }
  if (sheetKey === 'itsm') {
    return itsmEngine[rule.id]
      ? { state: 'built', ref: rule.id, engine: itsmEngine[rule.id], classification: itsmClass[rule.id] ?? null, source: 'health/itsm/rules/*.json' }
      : { state: 'not_built' };
  }
  if (PACK_SHEETS.includes(sheetKey) && packEntry[sheetKey][rule.id]) return packImplementation(sheetKey, rule);
  const interim = interimLegacy[rule.id];
  return interim ? { state: 'not_built', interim_legacy: interim } : { state: 'not_built' };
}

/*
 * A workbook pack's rule (ITOM, Platform; Enterprise DQ, Phase 7). The ITSM
 * convention: a rule with a configuration is built, and its classification says
 * whether it can run. A rule whose evaluator is not written yet (build_pending) is
 * not built, whatever its classification.
 */
function packImplementation(packKey, rule) {
  const e = packEntry[packKey][rule.id];
  const interim = interimLegacy[rule.id];
  if (e.result.state === 'not_built') return { state: 'not_built', classification: 'not_built', ...(interim ? { interim_legacy: interim } : {}) };
  return {
    state: 'built', ref: e.equivalent_of ?? rule.id, engine: e.equivalent_of ? null : e.recommended_engine, classification: e.result.state,
    source: e.equivalent_of ? `equivalent of ${e.equivalent_of} (D-019)` : `health/${packKey}/rules/*.json`,
    ...(interim ? { replaces_legacy: interim } : {}),
  };
}

function paramsEntry(sheetKey, rule) {
  const base = { workbook_text: rule.threshold_parameter ?? null };
  if (sheetKey === 'itsm') {
    const d = itsmParams.declarations[rule.id];
    return { ...base, status: d ? 'DECLARED' : 'UNDECLARED', declared_in: d ? 'health/rules/itsm/parameters.json' : null, parameters: d ? d.parameters.map((p) => p.key) : null };
  }
  if (sheetKey === 'cmdb' && cmdbById.has(rule.id)) {
    return { ...base, status: 'UNDECLARED', note: 'Tunables live as code defaults in the owning cmdb-*.js pack (*_DEFAULTS); declared here in Phase 1.' };
  }
  return { ...base, status: 'UNDECLARED' };
}

/* ── merge and write ─────────────────────────────────────────────────── */

const summary = [];
for (const file of fs.readdirSync(path.join(WB, 'sheets')).filter((f) => f.endsWith('.json')).sort()) {
  const sheetKey = file.replace(/\.json$/, '');
  const sheet = readJson(path.join(WB, 'sheets', file));
  const header = { sheet: sheet.sheet, workbook_sha256: sheet.source.workbook_sha256 };

  const ovFile = path.join(WB, 'overlays', file);
  const old = exists(ovFile) ? readJson(ovFile) : { rules: {} };
  const rules = {};
  let added = 0; let kept = 0;
  for (const r of sheet.rules) {
    const prev = old.rules[r.id];
    let entry;
    if (!prev) { entry = seed(sheetKey, r); added += 1; }
    else if (prev.reviewed) entry = { ...prev };
    else { entry = refresh ? seed(sheetKey, r) : { ...prev }; kept += 1; }
    entry.implementation = implementation(sheetKey, r);
    delete entry.orphan;
    rules[r.id] = entry;
  }
  let orphans = 0;
  for (const [id, prev] of Object.entries(old.rules)) {
    if (!rules[id]) { rules[id] = { ...prev, orphan: true }; orphans += 1; }
  }
  fs.mkdirSync(path.dirname(ovFile), { recursive: true });
  fs.writeFileSync(ovFile, `${JSON.stringify({
    overlay_version: '0.1.0',
    ...header,
    note: 'Hand-maintained engineering overlay (decision D-007). Seeded by server/scripts/health-workbook-overlays.mjs. `proposed` names the basis of every auto-proposed value; nothing is an engineering decision until `reviewed` is true.',
    rules,
  }, null, 1)}\n`);

  const pFile = path.join(WB, 'params', file);
  const oldP = exists(pFile) ? readJson(pFile) : { rules: {} };
  const params = {};
  for (const r of sheet.rules) {
    const prev = oldP.rules[r.id];
    params[r.id] = prev?.reviewed ? prev : { ...paramsEntry(sheetKey, r), ...(prev?.parameters_declared ? { parameters_declared: prev.parameters_declared } : {}) };
  }
  fs.mkdirSync(path.dirname(pFile), { recursive: true });
  fs.writeFileSync(pFile, `${JSON.stringify({
    params_version: '0.1.0',
    ...header,
    note: 'Parameter declaration skeleton, one entry per workbook rule. The typed declarations (type, unit, default, status DEFINED/UNDEFINED) are written in Phase 1 with the generalised registry; ITSM already has them in health/rules/itsm/parameters.json.',
    rules: params,
  }, null, 1)}\n`);

  summary.push(`${sheetKey}: ${sheet.rules.length} rules (+${added} new, ${kept} kept${refresh ? ' and re-proposed' : ''}, ${orphans} orphaned)`);
}
process.stdout.write(`${summary.join('\n')}\n`);
