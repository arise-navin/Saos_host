import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { getDb } from '../memory/db.js';
import { boundInstance } from '../servicenow/instance-binding.js';
import { buildParameterRegistry, describeParameters } from './index.js';
import { describeModuleParameters, PARAMETER_MODULES } from './parameter-registry.js';
import { itsmParameterOverrides, parameterOverrides } from './store.js';
import { MODULE_KEYS } from './scopes.js';
import { listRuleOverrides, scanRuleOverrides, TAB_MODULE, BAND_WORD, bandOf, EDITABLE_FIELDS } from './rule-overrides.js';

/**
 * THE RULEBOOK (D-038, Job HC-1) — every Health Assist rule, module by module, as
 * the master workbook states it; what the product does with it today; and what a
 * person changed on top of it (rule-overrides.js). The workbook files are read,
 * never written.
 */

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const WB = path.join(HERE, 'rules', 'workbook');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/* The tabs, in the order the product owner asked for. Data Quality is the CMDB Quality half of the data-quality sheet (DQ-001 … DQ-083); Enterprise DQ is DQ-084 … DQ-139. */
const dqNumber = (id) => Number(String(id).slice(3));
export const RULEBOOK_TABS = Object.freeze([
  { key: 'cmdb', label: 'CMDB', sheet: 'cmdb' },
  { key: 'data_quality', label: 'Data Quality', sheet: 'data-quality', keep: (id) => dqNumber(id) <= 83 },
  { key: 'itsm', label: 'ITSM', sheet: 'itsm' },
  { key: 'itom', label: 'ITOM', sheet: 'itom' },
  { key: 'platform', label: 'Platform', sheet: 'platform' },
  { key: 'enterprise_dq', label: 'Enterprise DQ', sheet: 'data-quality', keep: (id) => dqNumber(id) >= 84 },
  { key: 'csdm', label: 'CSDM', sheet: 'csdm' },
  { key: 'itil', label: 'ITIL', sheet: 'itil' },
  { key: 'custom', label: 'Custom' },
]);

/* What the product does with a rule today, from the overlay's implementation state. */
export function ruleStatus(impl, equivalentOf = null) {
  const c = String(impl?.classification ?? '').toLowerCase();
  if (impl?.state === 'not_built') return { key: 'needs_answer', label: 'Waiting on an answer' };
  if (c === 'equivalent' || equivalentOf) return { key: 'counted_elsewhere', label: equivalentOf ? `Counted in ${equivalentOf}` : 'Counted in another module' };
  if (c === 'derived') return { key: 'counted_elsewhere', label: 'The module score itself' };
  if (c === '' || c === 'executable') return { key: 'runs', label: 'Runs' };
  if (c === 'unconfigured') return { key: 'needs_value', label: 'Built, waiting for a value' };
  return { key: 'needs_answer', label: 'Waiting on an answer' };
}

export const RULE_FIELDS = Object.freeze(['group', 'rule', 'base_severity', 'what_it_means', 'why_it_matters', 'source_tables_fields', 'detection_logic', 'threshold_parameter', 'false_positive_guard', 'remediation_lane', 'cross_domain_link']);

let cached = null;
/** The workbook as it stands, per tab (cached: the files do not change while the server runs). */
export function rulebook() {
  if (cached) return cached;
  const sheets = {}; const overlays = {};
  for (const t of RULEBOOK_TABS) if (t.sheet && !sheets[t.sheet]) {
    sheets[t.sheet] = readJson(path.join(WB, 'sheets', `${t.sheet}.json`));
    overlays[t.sheet] = readJson(path.join(WB, 'overlays', `${t.sheet}.json`)).rules || {};
  }
  /* Which rule an equivalent points to: each pack's own equivalents register (the overlay does not carry it). */
  const equivalentOf = {};
  for (const pack of ['itom', 'platform', 'enterprise_dq', 'csdm', 'itil']) {
    const file = path.join(HERE, 'rules', pack, 'equivalents.json');
    if (fs.existsSync(file)) for (const [id, e] of Object.entries(readJson(file).rules || {})) if (e?.equivalent_of) equivalentOf[id] = e.equivalent_of;
  }
  const rules = {};
  for (const t of RULEBOOK_TABS) {
    if (!t.sheet) continue;
    rules[t.key] = sheets[t.sheet].rules.filter((r) => !t.keep || t.keep(r.id)).map((r) => {
      const ov = overlays[t.sheet][r.id] || {};
      return Object.freeze({
        id: r.id, tab: t.key, ...Object.fromEntries(RULE_FIELDS.map((f) => [f, r[f] ?? ''])),
        status: ruleStatus(ov.implementation, ov.equivalent_of ?? equivalentOf[r.id] ?? null),
        dimension: ov.dimension ?? null,
      });
    });
  }
  const columns = sheets.cmdb.columns.filter((c) => ['id', ...RULE_FIELDS].includes(c.field)).map((c) => ({ field: c.field, header: c.header }));
  const byId = new Map(Object.values(rules).flat().map((r) => [r.id, r]));
  cached = { columns, rules, byId };
  return cached;
}

export const workbookRule = (id) => rulebook().byId.get(String(id)) ?? null;

/* ── thresholds ─────────────────────────────────────────────────────────── */

/**
 * Every threshold parameter that tunes a rule, in one shape for all modules:
 * `{ module, scope, key, type, unit, min, max, value, default, source, resolved, blocks, workbook_text, note, overridable }`.
 * ITSM's registry is per rule; the others' are per scope (a rule id, or a CMDB pack) with the rules each tunes.
 */
export function parametersByRule() {
  const out = new Map();
  const add = (id, p) => { if (!out.has(id)) out.set(id, []); out.get(id).push(p); };
  try {
    for (const p of describeParameters(buildParameterRegistry(itsmParameterOverrides()).registry)) {
      add(p.rule_id, {
        module: 'itsm', scope: p.rule_id, key: p.key, type: p.type, unit: p.unit ?? null, min: null, max: null, value: p.value, default: p.workbook_default,
        source: p.source, resolved: p.status === 'RESOLVED', blocks: Boolean(p.blocks_rule), workbook_text: p.workbook_text ?? null, note: null, overridable: true, rules: [p.rule_id],
      });
    }
  } catch { /* no ITSM registry: its rules show no thresholds */ }
  for (const m of PARAMETER_MODULES) {
    if (m === 'overall') continue;
    let d;
    try { d = describeModuleParameters(m, parameterOverrides(m)); } catch { continue; }
    for (const p of d.parameters) {
      const resolved = p.value != null || p.nullable;
      for (const id of p.rules || []) {
        add(id, {
          module: m, scope: p.scope, key: p.key, type: p.type, unit: p.unit ?? null, min: p.min ?? null, max: p.max ?? null, value: p.value, default: p.default,
          source: p.source, resolved, blocks: !resolved, workbook_text: p.workbook_text ?? null, note: p.note ?? null,
          overridable: p.overridable !== false, not_overridable_because: p.not_overridable_because ?? null, scope_label: p.scope_label ?? p.scope,
          /* A CMDB pack parameter often tunes several rules: changing it changes them all. */
          rules: p.rules || [],
        });
      }
    }
  }
  return out;
}

/* ── the rulebook with a person's changes ───────────────────────────────── */

/**
 * The status a rule has NOW: a person's change first (removed, switched off, an
 * own check), then values that unblocked a rule waiting for them, then the
 * workbook's.
 */
export function effectiveStatus(base, ov, params = []) {
  if (ov?.deleted) return { key: 'removed', label: 'Removed' };
  if (ov && !ov.active) return { key: 'off', label: 'Switched off' };
  if (ov?.check) return { key: 'runs', label: 'Runs — your check', own: 'check' };
  if (base.status.key === 'needs_value' && params.length && params.every((p) => !p.blocks)) return { key: 'runs', label: 'Runs — your values', own: 'values' };
  return base.status;
}

/** One rule as the Rulebook shows it: effective columns, the workbook's where they differ, and what was changed. */
export function effectiveRule(base, ov = null, params = []) {
  const fields = ov?.fields || {};
  const severity = ov?.severity ? BAND_WORD[ov.severity] : base.base_severity;
  const edited = EDITABLE_FIELDS.filter((f) => f in fields);
  return {
    ...base,
    ...fields,
    base_severity: severity,
    status: effectiveStatus(base, ov, params),
    base_status: base.status,
    workbook: {
      ...Object.fromEntries(edited.map((f) => [f, base[f]])),
      ...(ov?.severity ? { base_severity: base.base_severity } : {}),
    },
    changes: ov ? {
      active: ov.active, deleted: ov.deleted, severity: Boolean(ov.severity), edited,
      check: ov.check ?? null, updated_by: ov.updated_by, updated_at: ov.updated_at,
    } : null,
    thresholds: params.length ? { count: params.length, unresolved: params.filter((p) => p.blocks).length, own: params.filter((p) => p.source === 'instance').length } : null,
    module: TAB_MODULE[base.tab] ?? null,
  };
}

/** The whole rulebook with every stored change applied: `{ columns, rules: { tab: [rule…] } }`. */
export function effectiveRulebook({ overrides = listRuleOverrides(), parameters = parametersByRule() } = {}) {
  const book = rulebook();
  const ovById = new Map(overrides.map((o) => [o.rule_id, o]));
  const rules = Object.fromEntries(Object.entries(book.rules).map(([tab, list]) => [tab, list.map((r) => effectiveRule(r, ovById.get(r.id) ?? null, parameters.get(r.id) ?? []))]));
  return { columns: book.columns, rules };
}

/** What a scan applies (rule-overrides.js), with each check named and banded from its rule. */
export function rulebookScanOverrides() {
  const book = rulebook();
  return scanRuleOverrides({ overrides: listRuleOverrides(), rules: Object.fromEntries(book.byId) });
}

/* ── what the scans have seen ───────────────────────────────────────────── */

/** This instance's finished scans, newest first: `{ started_at, status, modules, full }` (modules null = every module; full = it read every module). */
export function finishedScans({ limit = 200 } = {}) {
  const key = boundInstance().key || 'unbound';
  return getDb().prepare(`SELECT started_at, completed_at, status, modules_json FROM health_runs
    WHERE instance_key = ? AND status IN ('completed','partial') ORDER BY started_at DESC LIMIT ?`).all(key, limit)
    .map((r) => {
      let modules = null;
      try { modules = r.modules_json ? JSON.parse(r.modules_json) : null; } catch { modules = null; }
      return { started_at: r.started_at, completed_at: r.completed_at, status: r.status, modules, full: modules == null || MODULE_KEYS.every((m) => modules.includes(m)) };
    });
}

export { bandOf };
