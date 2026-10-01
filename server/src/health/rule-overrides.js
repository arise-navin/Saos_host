import crypto from 'node:crypto';
import { getDb } from '../memory/db.js';
import { CUSTOM_MODULES, CUSTOM_SEVERITIES, CustomRuleError, validateCustomRule } from './custom-rules.js';
import { scopeOfRule } from './scopes.js';

/**
 * RULEBOOK CHANGES TO THE BUILT-IN RULES (Job HC-1).
 *
 * The workbook stays the source of truth and is never edited. A person's change
 * is stored beside it, one row per rule, and every scan applies it:
 *
 *   switched off   the rule runs no more: its findings, measurements and skips
 *                  are dropped and it leaves its module's score (not a gap)
 *   removed        the same, and the Rulebook hides it until it is restored
 *   severity       a new base band: its findings move by the same number of
 *                  bands (an escalation the engine made is kept), and the score
 *                  weighs it at the new band
 *   wording        what the Rulebook, the export and the findings call it
 *   own check      for a rule the product never built: a record, rate or age
 *                  check (the custom-rule engine, custom-rules.js) run under the
 *                  rule's OWN id and scored in its module
 *
 * Resetting a rule deletes its row: it is the workbook's again.
 *
 * Every change to any rule — built-in or custom, thresholds included — is logged
 * in health_rule_history, so the Rulebook can say which changes no scan has
 * reflected yet ("run a full scan").
 */

export const EDITABLE_FIELDS = Object.freeze(['rule', 'group', 'what_it_means', 'why_it_matters', 'source_tables_fields', 'detection_logic',
  'threshold_parameter', 'false_positive_guard', 'remediation_lane', 'cross_domain_link']);
export const FIELD_LABEL = Object.freeze({
  rule: 'Rule wording', group: 'Group', what_it_means: 'What it means', why_it_matters: 'Why it matters', source_tables_fields: 'Source tables / fields',
  detection_logic: 'Detection logic', threshold_parameter: 'Threshold / parameter', false_positive_guard: 'False-positive guard',
  remediation_lane: 'Remediation lane', cross_domain_link: 'Cross-domain link',
});
const RULE_MAX = 300;
const FIELD_MAX = 4000;

/** Which module's scan runs a tab's rules. Data Quality DQ-001…083 are the CMDB module's. */
export const TAB_MODULE = Object.freeze({ cmdb: 'cmdb', data_quality: 'cmdb', itsm: 'itsm', itom: 'itom', platform: 'platform', enterprise_dq: 'enterprise_dq', csdm: 'csdm', itil: 'itil' });

export const BAND_RANK = Object.freeze({ LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4, SYSTEMIC: 5 });
const BANDS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'SYSTEMIC'];
const WORD_BAND = Object.freeze({ systemic: 'SYSTEMIC', critical: 'CRITICAL', high: 'HIGH', moderate: 'MEDIUM', medium: 'MEDIUM', low: 'LOW' });
export const BAND_WORD = Object.freeze({ SYSTEMIC: 'Systemic', CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Moderate', LOW: 'Low' });

/** A workbook word ("Moderate") or an engine band ("MEDIUM") as the engine band; null for anything else. */
export const bandOf = (s) => (s == null ? null : WORD_BAND[String(s).trim().toLowerCase()] ?? null);

export class RuleOverrideError extends Error {
  constructor(message, status = 422) { super(message); this.name = 'RuleOverrideError'; this.status = status; }
}

const nowIso = () => new Date().toISOString();
const str = (v) => (v == null ? '' : String(v)).trim();

function rowToOverride(r) {
  if (!r) return null;
  let fields = {};
  let check = null;
  try { fields = JSON.parse(r.fields_json || '{}'); } catch { fields = {}; }
  try { check = r.check_json ? JSON.parse(r.check_json) : null; } catch { check = null; }
  return {
    rule_id: r.rule_id, tab: r.tab, active: Boolean(r.active), deleted: Boolean(r.deleted), severity: r.severity || null,
    fields, check, updated_by: r.updated_by ?? null, created_at: r.created_at, updated_at: r.updated_at,
  };
}

export function listRuleOverrides() {
  return getDb().prepare('SELECT * FROM health_rule_overrides ORDER BY rule_id').all().map(rowToOverride);
}

export function getRuleOverride(ruleId) {
  return rowToOverride(getDb().prepare('SELECT * FROM health_rule_overrides WHERE rule_id = ?').get(String(ruleId)));
}

/* ── the change log ─────────────────────────────────────────────────────── */

export function logRuleChange({ ruleId, module = null, action, summary, actor = null, at = nowIso() }) {
  getDb().prepare('INSERT INTO health_rule_history (rule_id, module, action, summary, actor, at) VALUES (?,?,?,?,?,?)')
    .run(String(ruleId), module ?? moduleOfRule(ruleId), action, summary, actor, at);
}

export function listRuleChanges({ since = null, limit = 200 } = {}) {
  const rows = since
    ? getDb().prepare('SELECT * FROM health_rule_history WHERE at > ? ORDER BY at DESC, id DESC LIMIT ?').all(since, limit)
    : getDb().prepare('SELECT * FROM health_rule_history ORDER BY at DESC, id DESC LIMIT ?').all(limit);
  return rows.map((r) => ({ id: r.id, rule_id: r.rule_id, module: r.module, action: r.action, summary: r.summary, actor: r.actor, at: r.at }));
}

/** The module whose scan runs a rule — by its id's prefix, as findings route. */
export function moduleOfRule(ruleId) {
  const id = String(ruleId);
  /* DQ-001…083 are the CMDB Quality half of the data-quality sheet (run as CMDB rules); 084 on is Enterprise DQ. */
  const dq = /^DQ-(\d+)$/.exec(id);
  if (dq) return Number(dq[1]) <= 83 ? 'cmdb' : 'enterprise_dq';
  /* scopeOfRule sends an unknown prefix to Platform; a change log names no module it cannot place. */
  if (!/^(CUSTOM-[A-Z]+-|CMDB-|ITSM-|ITOM-|PLT-|CSDM-|ITIL-)/.test(id)) return null;
  return scopeOfRule(id);
}

/**
 * The changes no finished scan has reflected yet. A change is reflected once a
 * scan that READ its module (not merely verified it) finished after it — the
 * engine key carries every change, so the next scan of that module re-reads it.
 * `runs` is newest first: `{ started_at, status, modules }` (modules null = all).
 */
export function pendingRuleChanges({ runs = [], limit = 200 } = {}) {
  const done = runs.filter((r) => ['completed', 'partial'].includes(r.status));
  const changes = listRuleChanges({ limit });
  const covered = (c) => done.some((r) => r.started_at > c.at && (r.modules == null || !c.module || r.modules.includes(c.module)));
  const pending = changes.filter((c) => !covered(c));
  const full = done.find((r) => r.modules == null || r.full);
  return { pending, modules: [...new Set(pending.map((c) => c.module).filter(Boolean))].sort(), last_full_scan: full ? full.started_at : null };
}

/* ── validation ─────────────────────────────────────────────────────────── */

/**
 * Validate a patch to one built-in rule. `rule` is its workbook row (with `tab`
 * and `status`), `current` its stored override or null. Returns the canonical
 * patch `{ active?, deleted?, severity?, fields? }`; throws naming the first problem.
 */
export function validateRulePatch(input, { rule, current = null }) {
  if (!rule) throw new RuleOverrideError('No such rule.', 404);
  const out = {};
  const countedElsewhere = rule.status?.key === 'counted_elsewhere';
  if ('active' in (input || {})) {
    if (typeof input.active !== 'boolean') throw new RuleOverrideError('"active" is true or false.');
    if (countedElsewhere && input.active === false) throw new RuleOverrideError(`${rule.id} is ${lowerFirst(rule.status.label)}: switch that rule off instead — this one adds nothing to a scan of its own.`);
    out.active = input.active;
  }
  if ('severity' in (input || {})) {
    if (input.severity == null || input.severity === '') out.severity = null;
    else {
      const band = bandOf(input.severity);
      if (!band || !CUSTOM_SEVERITIES.includes(band)) throw new RuleOverrideError(`Choose a severity (${Object.values(BAND_WORD).join(', ')}).`);
      if (countedElsewhere) throw new RuleOverrideError(`${rule.id} is ${lowerFirst(rule.status.label)}: change that rule's severity — this one is not scored on its own.`);
      out.severity = band === bandOf(rule.base_severity) ? null : band;
    }
  }
  if (input?.fields != null) {
    if (typeof input.fields !== 'object' || Array.isArray(input.fields)) throw new RuleOverrideError('"fields" is an object of the rule\'s columns.');
    const fields = { ...(current?.fields || {}) };
    for (const [k, v] of Object.entries(input.fields)) {
      if (!EDITABLE_FIELDS.includes(k)) throw new RuleOverrideError(`"${k}" is not an editable column (${EDITABLE_FIELDS.join(', ')}).`);
      const text = str(v);
      if (k === 'rule' && !text) throw new RuleOverrideError('The rule wording cannot be empty — reset the rule to go back to the workbook\'s.');
      if (text.length > (k === 'rule' ? RULE_MAX : FIELD_MAX)) throw new RuleOverrideError(`${FIELD_LABEL[k]} is at most ${k === 'rule' ? RULE_MAX : FIELD_MAX} characters.`);
      /* The workbook's own text again is no change. */
      if (text === str(rule[k])) delete fields[k]; else fields[k] = text;
    }
    out.fields = fields;
  }
  return out;
}

const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);

/**
 * Validate a check for a built-in rule the product does not run. It is a custom
 * rule definition (custom-rules.js), minus what the rule itself fixes: its module,
 * name and severity come from the rule.
 */
export function validateRuleCheck(input, { rule, module, severity, dimensionsOf }) {
  if (!rule) throw new RuleOverrideError('No such rule.', 404);
  if (!['needs_answer', 'needs_value', 'own_check'].includes(rule.base_status?.key ?? rule.status?.key)) {
    throw new RuleOverrideError(`${rule.id} already runs in the product — edit its severity, wording or thresholds instead of giving it a check.`);
  }
  if (!CUSTOM_MODULES[module]) throw new RuleOverrideError(`${rule.id} belongs to no module a scan reads.`);
  try {
    const def = validateCustomRule({ ...input, name: str(input?.name) || str(rule.rule), module, severity }, { dimensionsOf });
    const { active, module: _m, severity: _s, ...rest } = def;
    return rest;
  } catch (err) {
    if (err instanceof CustomRuleError) throw new RuleOverrideError(err.message, err.status);
    throw err;
  }
}

/* ── writes ─────────────────────────────────────────────────────────────── */

function write(ruleId, tab, next, { user }) {
  const db = getDb();
  const at = nowIso();
  const cur = getRuleOverride(ruleId);
  const merged = {
    active: next.active ?? cur?.active ?? true,
    deleted: next.deleted ?? cur?.deleted ?? false,
    severity: 'severity' in next ? next.severity : (cur?.severity ?? null),
    fields: next.fields ?? cur?.fields ?? {},
    check: 'check' in next ? next.check : (cur?.check ?? null),
  };
  /* Nothing left that differs from the workbook: the row goes. */
  if (merged.active && !merged.deleted && !merged.severity && !Object.keys(merged.fields).length && !merged.check) {
    db.prepare('DELETE FROM health_rule_overrides WHERE rule_id = ?').run(ruleId);
    return null;
  }
  db.prepare(`
    INSERT INTO health_rule_overrides (rule_id, tab, active, deleted, severity, fields_json, check_json, updated_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(rule_id) DO UPDATE SET tab = excluded.tab, active = excluded.active, deleted = excluded.deleted, severity = excluded.severity,
      fields_json = excluded.fields_json, check_json = excluded.check_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `).run(ruleId, tab, merged.active ? 1 : 0, merged.deleted ? 1 : 0, merged.severity, JSON.stringify(merged.fields),
    merged.check ? JSON.stringify(merged.check) : null, user, cur?.created_at ?? at, at);
  return getRuleOverride(ruleId);
}

/** What a patch changes, in words, for the change log. Empty when it changes nothing. */
export function describePatch(rule, cur, patch) {
  const parts = [];
  const was = { active: cur?.active ?? true, severity: cur?.severity ?? null, fields: cur?.fields ?? {} };
  if ('active' in patch && patch.active !== was.active) parts.push(patch.active ? 'switched on' : 'switched off');
  if ('severity' in patch && patch.severity !== was.severity) {
    const from = BAND_WORD[was.severity ?? bandOf(rule.base_severity)] ?? rule.base_severity;
    const to = BAND_WORD[patch.severity ?? bandOf(rule.base_severity)] ?? rule.base_severity;
    if (from !== to) parts.push(`severity ${from} → ${to}`);
  }
  if (patch.fields) {
    const keys = new Set([...Object.keys(was.fields), ...Object.keys(patch.fields)]);
    const changed = [...keys].filter((k) => (was.fields[k] ?? null) !== (patch.fields[k] ?? null));
    if (changed.length) parts.push(`${changed.map((k) => FIELD_LABEL[k].toLowerCase()).join(', ')} edited`);
  }
  return parts.join('; ');
}

export function patchRule(rule, input, { user = null } = {}) {
  const cur = getRuleOverride(rule.id);
  if (cur?.deleted) throw new RuleOverrideError(`${rule.id} is removed — restore it first.`, 409);
  const patch = validateRulePatch(input, { rule, current: cur });
  const summary = describePatch(rule, cur, patch);
  const saved = write(rule.id, rule.tab, patch, { user });
  if (summary) logRuleChange({ ruleId: rule.id, module: TAB_MODULE[rule.tab], action: 'edited', summary, actor: user });
  return { override: saved, summary };
}

export function removeRule(rule, { user = null } = {}) {
  const cur = getRuleOverride(rule.id);
  if (cur?.deleted) throw new RuleOverrideError(`${rule.id} is already removed.`, 409);
  const saved = write(rule.id, rule.tab, { deleted: true }, { user });
  logRuleChange({ ruleId: rule.id, module: TAB_MODULE[rule.tab], action: 'removed', summary: 'removed from the rulebook and from every scan', actor: user });
  return { override: saved };
}

export function restoreRule(rule, { user = null } = {}) {
  const cur = getRuleOverride(rule.id);
  if (!cur?.deleted) throw new RuleOverrideError(`${rule.id} is not removed.`, 409);
  const saved = write(rule.id, rule.tab, { deleted: false }, { user });
  logRuleChange({ ruleId: rule.id, module: TAB_MODULE[rule.tab], action: 'restored', summary: 'restored', actor: user });
  return { override: saved };
}

export function resetRule(rule, { user = null } = {}) {
  const cur = getRuleOverride(rule.id);
  if (!cur) throw new RuleOverrideError(`${rule.id} has no changes to reset.`, 409);
  getDb().prepare('DELETE FROM health_rule_overrides WHERE rule_id = ?').run(rule.id);
  logRuleChange({ ruleId: rule.id, module: TAB_MODULE[rule.tab], action: 'reset', summary: 'reset to the workbook', actor: user });
  return { override: null };
}

export function setRuleCheck(rule, check, { user = null } = {}) {
  const cur = getRuleOverride(rule.id);
  if (cur?.deleted) throw new RuleOverrideError(`${rule.id} is removed — restore it first.`, 409);
  const saved = write(rule.id, rule.tab, { check }, { user });
  logRuleChange({ ruleId: rule.id, module: TAB_MODULE[rule.tab], action: cur?.check ? 'check_edited' : 'check_added', summary: `${cur?.check ? 'check edited' : 'given a check of its own'}: ${check.kind} check on ${check.table}`, actor: user });
  return { override: saved };
}

export function clearRuleCheck(rule, { user = null } = {}) {
  const cur = getRuleOverride(rule.id);
  if (!cur?.check) throw new RuleOverrideError(`${rule.id} has no check of its own.`, 409);
  const saved = write(rule.id, rule.tab, { check: null }, { user });
  logRuleChange({ ruleId: rule.id, module: TAB_MODULE[rule.tab], action: 'check_removed', summary: 'its own check removed', actor: user });
  return { override: saved };
}

/* ── what a scan applies ────────────────────────────────────────────────── */

/**
 * The overrides a scan applies, as plain data (the scan never reads the
 * database). `rules` maps a rule id to its workbook row (for a check's name,
 * severity and dimension); pass the Rulebook's.
 *
 *   off        ids switched off or removed
 *   severity   id → engine band
 *   titles     id → wording
 *   checks     own checks, as custom-rule definitions under the rule's own id
 */
export function scanRuleOverrides({ overrides = listRuleOverrides(), rules = {} } = {}) {
  const off = [];
  const severity = {};
  const titles = {};
  const checks = [];
  for (const o of overrides) {
    if (!o.active || o.deleted) { off.push(o.rule_id); continue; }
    if (o.severity) severity[o.rule_id] = o.severity;
    if (o.fields?.rule) titles[o.rule_id] = o.fields.rule;
    if (o.check) {
      const base = rules[o.rule_id];
      const module = TAB_MODULE[o.tab];
      if (!module || !CUSTOM_MODULES[module]) continue;
      checks.push(Object.freeze({
        ...o.check, rule_id: o.rule_id, module, name: o.fields?.rule || base?.rule || o.check.name || o.rule_id,
        severity: o.severity || bandOf(base?.base_severity) || 'MEDIUM', scored: o.check.scored !== false, active: true, own_check: true,
      }));
    }
  }
  return { off: off.sort(), severity, titles, checks };
}

export const EMPTY_OVERRIDES = Object.freeze({ off: [], severity: {}, titles: {}, checks: [] });

/**
 * Per module, a fingerprint of everything a person changed that decides its
 * result: the overrides of its rules and its custom rules. It joins that
 * module's engine key ONLY when there is something, so a deployment with no
 * change keeps its keys — and a change makes the next scan re-read the module.
 */
export function overrideFingerprints(ov = EMPTY_OVERRIDES, customRules = []) {
  const per = {};
  const add = (m, item) => { if (m) (per[m] ||= []).push(item); };
  for (const id of ov.off || []) add(moduleOfRule(id), ['off', id]);
  for (const [id, band] of Object.entries(ov.severity || {})) add(moduleOfRule(id), ['severity', id, band]);
  for (const [id, t] of Object.entries(ov.titles || {})) add(moduleOfRule(id), ['title', id, t]);
  for (const c of ov.checks || []) add(c.module, ['check', c.rule_id, c]);
  for (const c of customRules || []) if (c.active !== false) add(c.module, ['custom', c.rule_id, c]);
  return Object.fromEntries(Object.entries(per).map(([m, items]) => [m, crypto.createHash('sha256')
    .update(JSON.stringify(items.map((i) => JSON.stringify(i)).sort())).digest('hex').slice(0, 16)]));
}

/** Move a band by `delta` bands, within Low … Systemic. */
export function shiftBand(band, delta) {
  const r = BAND_RANK[band];
  if (!r || !delta) return band;
  return BANDS[Math.max(0, Math.min(BANDS.length - 1, r - 1 + delta))];
}

/**
 * Apply the overrides to one module's normalized catalogue result (the ITSM
 * catalogue or a workbook pack): drop what is switched off or replaced by an
 * own check, re-band the rest. Returns a NEW object; the input is not touched.
 */
export function applyToNormalized(normalized, { off = new Set(), replaced = new Set(), severity = {}, titles = {} } = {}) {
  if (!normalized) return normalized;
  const drop = (id) => off.has(id) || replaced.has(id);
  const rowBase = new Map((normalized.rules || []).map((r) => [r.rule_id, bandOf(r.base_severity)]));
  const rules = (normalized.rules || []).filter((r) => !drop(r.rule_id)).map((r) => {
    const band = severity[r.rule_id];
    const title = titles[r.rule_id];
    if (!band && !title) return r;
    return { ...r, ...(band ? { base_severity: BAND_WORD[band], workbook_severity: r.base_severity } : {}), ...(title ? { title, workbook_title: r.title } : {}) };
  });
  const findings = (normalized.findings || []).filter((f) => !drop(f.rule_id)).map((f) => {
    const band = severity[f.rule_id];
    const title = titles[f.rule_id];
    if (!band && !title) return f;
    const next = { ...f };
    if (band) {
      const was = bandOf(f.base_severity) ?? rowBase.get(f.rule_id) ?? bandOf(f.severity);
      const delta = (BAND_RANK[band] ?? 0) - (BAND_RANK[was] ?? 0);
      next.severity = shiftBand(f.severity, delta);
      next.base_severity = band;
      next.severity_override = { from: was, to: band };
    }
    if (title && f.title === normalized.rules?.find((r) => r.rule_id === f.rule_id)?.title) next.title = title;
    return next;
  });
  const skipped = (normalized.skipped || []).filter((s) => !drop(s.rule));
  return { ...normalized, rules, findings, skipped };
}
