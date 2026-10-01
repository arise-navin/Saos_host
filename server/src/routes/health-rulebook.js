import { Router } from 'express';
import { log } from '../logging.js';
import { currentActor } from '../memory/audit.js';
import { getDb } from '../memory/db.js';
import { table as snowTable } from '../servicenow/client.js';
import { boundInstance } from '../servicenow/instance-binding.js';
import { workbookIndex } from '../health/modules.js';
import { CUSTOM_MODULES, CustomRuleError, validateCustomRule, evaluateCustomRule } from '../health/custom-rules.js';
import { listCustomRules, createCustomRule, updateCustomRule, deleteCustomRule } from '../health/custom-rules-store.js';
import { suggestCustomRule, CustomAssistError } from '../health/custom-rules-assist.js';
import {
  RULEBOOK_TABS, ruleStatus, rulebook, workbookRule, effectiveRulebook, effectiveRule, parametersByRule, finishedScans,
} from '../health/rulebook.js';
import {
  RuleOverrideError, getRuleOverride, patchRule, removeRule, restoreRule, resetRule, setRuleCheck, clearRuleCheck,
  validateRuleCheck, pendingRuleChanges, listRuleChanges, logRuleChange, TAB_MODULE, bandOf,
} from '../health/rule-overrides.js';
import { buildRulebookWorkbook } from '../health/rulebook-export.js';
import { buildParameterRegistry } from '../health/index.js';
import { findDeclaration, validateParameterValue } from '../health/parameter-registry.js';
import { setItsmParameterOverride, clearItsmParameterOverride, setParameterOverride, clearParameterOverride } from '../health/store.js';

/**
 * THE RULEBOOK (D-038, Job HC-1) — every Health Assist rule, module by module, as
 * the master workbook states it, with what the product does with it today, what a
 * person changed on top of it, and the CUSTOM RULES a person adds.
 *
 *   GET    /api/health/rulebook                        tabs, rules per tab (changes applied), custom rules, areas per module
 *   GET    /api/health/rulebook/export.xlsx            the rulebook as an Excel workbook (?tab=all|<key>, ?q, ?severity, ?status)
 *   GET    /api/health/rulebook/changes                changes no finished scan has reflected yet, and the latest ones
 *   GET    /api/health/rulebook/rules/:id              one rule: its changes, its thresholds, its own check's last result
 *   PATCH  /api/health/rulebook/rules/:id              { active?, severity?, fields? }
 *   DELETE /api/health/rulebook/rules/:id              remove it (from the rulebook and every scan)
 *   POST   /api/health/rulebook/rules/:id/restore      bring a removed rule back
 *   POST   /api/health/rulebook/rules/:id/reset        drop every change: the workbook's rule again
 *   PUT    /api/health/rulebook/rules/:id/check        a check of its own, for a rule the product does not run
 *   DELETE /api/health/rulebook/rules/:id/check
 *   POST   /api/health/rulebook/rules/:id/check/preview   run a check read-only on the instance, save nothing
 *   POST   /api/health/rulebook/rules/:id/check/suggest   AI proposal from the rule's own text, save nothing
 *   PUT    /api/health/rulebook/rules/:id/parameters/:module/:scope/:key   set a threshold { value }
 *   DELETE /api/health/rulebook/rules/:id/parameters/:module/:scope/:key   back to its default
 *   GET    /api/health/custom-rules                     custom rules with their latest result
 *   POST   /api/health/custom-rules                     create (validated)
 *   PATCH  /api/health/custom-rules/:id                 edit / switch on or off / count in score
 *   DELETE /api/health/custom-rules/:id
 *   POST   /api/health/custom-rules/preview             run a definition read-only on the instance, save nothing
 *   POST   /api/health/custom-rules/suggest             AI proposal from a description, save nothing
 *
 * Nothing here writes to ServiceNow: every change is stored locally and applied by
 * the next scan. The workbook files are never edited.
 */

export { RULEBOOK_TABS, ruleStatus, rulebook };

export const healthRulebookRouter = Router();

/* The latest result of each custom rule and own check: from the newest stored run that evaluated it. */
function latestCustomResults() {
  const out = {};
  const rows = getDb().prepare("SELECT id, started_at, manifest_json FROM health_runs WHERE status IN ('completed','partial') ORDER BY started_at DESC LIMIT 20").all();
  for (const r of rows) {
    let m = null; try { m = JSON.parse(r.manifest_json); } catch { continue; }
    for (const c of m?.custom_rules || []) if (!out[c.rule_id]) out[c.rule_id] = { ...c, run_id: r.id, checked_at: r.started_at };
  }
  return out;
}

const dimensionsByModule = () => Object.fromEntries(Object.keys(CUSTOM_MODULES).map((m) => [m, workbookIndex().dimensions(m).filter((d) => d.scored !== false).map((d) => ({ key: d.key, label: d.label }))]));
const actor = () => currentActor().actor ?? null;

function fail(res, next, err) {
  if (err instanceof CustomRuleError || err instanceof CustomAssistError || err instanceof RuleOverrideError) {
    if (err.status >= 500) log.warn('health', `rulebook: ${err.message}`);
    return res.status(err.status).json({ message: err.message });
  }
  return next(err);
}

/** A built-in rule by id, or a 404. */
function ruleOr404(id) {
  const rule = workbookRule(id);
  if (!rule) throw new RuleOverrideError(`No rule ${id} in the rulebook.`, 404);
  return rule;
}

/** One rule as the Rulebook shows it now, with its thresholds and its own check's latest result. */
function ruleView(id) {
  const base = ruleOr404(id);
  const params = parametersByRule().get(base.id) ?? [];
  const rule = effectiveRule(base, getRuleOverride(base.id), params);
  return { rule, parameters: params, last: latestCustomResults()[base.id] ?? null };
}

/** What changed that no finished scan has reflected yet (this instance's scans). */
const pendingNow = () => {
  const runs = finishedScans();
  return { ...pendingRuleChanges({ runs }), last_scan: runs[0]?.started_at ?? null };
};

healthRulebookRouter.get('/rulebook', (req, res, next) => {
  try {
    const book = effectiveRulebook();
    const custom = listCustomRules();
    const last = latestCustomResults();
    for (const list of Object.values(book.rules)) for (const r of list) if (r.changes?.check) r.last = last[r.id] ?? null;
    const tabs = RULEBOOK_TABS.map((t) => ({ key: t.key, label: t.label, module: TAB_MODULE[t.key] ?? null, count: t.key === 'custom' ? custom.length : book.rules[t.key].filter((r) => r.status.key !== 'removed').length }));
    res.json({
      tabs, columns: book.columns, rules: book.rules, custom: custom.map((c) => ({ ...c, last: last[c.rule_id] ?? null })),
      modules: Object.fromEntries(Object.entries(CUSTOM_MODULES).map(([k, v]) => [k, v.label])), dimensions: dimensionsByModule(), pending: pendingNow(),
    });
  } catch (err) { next(err); }
});

healthRulebookRouter.get('/rulebook/export.xlsx', async (req, res, next) => {
  try {
    const tab = String(req.query.tab ?? 'all');
    if (tab !== 'all' && !RULEBOOK_TABS.some((t) => t.key === tab)) return res.status(404).json({ message: `No tab ${tab}. Tabs: all, ${RULEBOOK_TABS.map((t) => t.key).join(', ')}.` });
    const last = latestCustomResults();
    /* A module tab lists its custom rules too, so its export carries them (on the Custom sheet). */
    const customAll = listCustomRules().map((c) => ({ ...c, last: last[c.rule_id] ?? null }));
    const custom = ['all', 'custom'].includes(tab) ? customAll : customAll.filter((c) => tab !== 'data_quality' && c.module === TAB_MODULE[tab]);
    const { workbook, rows } = await buildRulebookWorkbook({
      book: effectiveRulebook(), custom,
      tabs: tab === 'all' ? 'all' : (tab !== 'custom' && custom.length ? [tab, 'custom'] : [tab]),
      filters: { q: req.query.q ? String(req.query.q) : '', severity: req.query.severity ? String(req.query.severity) : '', status: req.query.status ? String(req.query.status) : '' },
      includeRemoved: req.query.removed === '1', instance: boundInstance().url ?? null,
    });
    const stamp = new Date().toISOString().slice(0, 10);
    const label = tab === 'all' ? 'all' : RULEBOOK_TABS.find((t) => t.key === tab).label.replace(/\s+/g, '-');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="SAOS-Rulebook-${label}-${stamp}.xlsx"`);
    res.setHeader('X-Rulebook-Rows', String(rows));
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) { next(err); }
});

healthRulebookRouter.get('/rulebook/changes', (req, res, next) => {
  try { res.json({ ...pendingNow(), recent: listRuleChanges({ limit: 50 }) }); } catch (err) { next(err); }
});

healthRulebookRouter.get('/rulebook/rules/:id', (req, res, next) => {
  try { res.json(ruleView(req.params.id)); } catch (err) { fail(res, next, err); }
});

healthRulebookRouter.patch('/rulebook/rules/:id', (req, res, next) => {
  try {
    const r = patchRule(ruleOr404(req.params.id), req.body || {}, { user: actor() });
    res.json({ ...ruleView(req.params.id), summary: r.summary, pending: pendingNow() });
  } catch (err) { fail(res, next, err); }
});

healthRulebookRouter.delete('/rulebook/rules/:id', (req, res, next) => {
  try { removeRule(ruleOr404(req.params.id), { user: actor() }); res.json({ ...ruleView(req.params.id), pending: pendingNow() }); } catch (err) { fail(res, next, err); }
});

healthRulebookRouter.post('/rulebook/rules/:id/restore', (req, res, next) => {
  try { restoreRule(ruleOr404(req.params.id), { user: actor() }); res.json({ ...ruleView(req.params.id), pending: pendingNow() }); } catch (err) { fail(res, next, err); }
});

healthRulebookRouter.post('/rulebook/rules/:id/reset', (req, res, next) => {
  try { resetRule(ruleOr404(req.params.id), { user: actor() }); res.json({ ...ruleView(req.params.id), pending: pendingNow() }); } catch (err) { fail(res, next, err); }
});

/* An own check is a custom-rule definition; the rule fixes its module, name and severity. */
function checkFor(id, body) {
  const base = ruleOr404(id);
  const rule = effectiveRule(base, getRuleOverride(base.id), parametersByRule().get(base.id) ?? []);
  const module = TAB_MODULE[base.tab];
  const severity = bandOf(rule.base_severity) ?? 'MEDIUM';
  const def = validateRuleCheck(body || {}, { rule: { ...rule, status: rule.changes?.check ? { key: 'own_check' } : rule.status }, module, severity, dimensionsOf: (m) => workbookIndex().dimensions(m) });
  return { base, rule, module, severity, def };
}

healthRulebookRouter.put('/rulebook/rules/:id/check', (req, res, next) => {
  try {
    const { base, def } = checkFor(req.params.id, req.body);
    setRuleCheck(base, def, { user: actor() });
    res.json({ ...ruleView(req.params.id), pending: pendingNow() });
  } catch (err) { fail(res, next, err); }
});

healthRulebookRouter.delete('/rulebook/rules/:id/check', (req, res, next) => {
  try { clearRuleCheck(ruleOr404(req.params.id), { user: actor() }); res.json({ ...ruleView(req.params.id), pending: pendingNow() }); } catch (err) { fail(res, next, err); }
});

healthRulebookRouter.post('/rulebook/rules/:id/check/preview', async (req, res, next) => {
  try {
    const { base, module, severity, def } = checkFor(req.params.id, req.body);
    const r = await evaluateCustomRule({ ...def, rule_id: base.id, module, severity }, snowTable, { withFinding: false });
    res.json({ result: { status: r.status, verdict: r.verdict, population: r.population, matches: r.matches, share: r.share, sample: r.sample.slice(0, 10), query: r.query ?? null, reason: r.reason } });
  } catch (err) { fail(res, next, err); }
});

healthRulebookRouter.post('/rulebook/rules/:id/check/suggest', async (req, res, next) => {
  try {
    const base = ruleOr404(req.params.id);
    const module = TAB_MODULE[base.tab];
    const clean = (s) => String(s ?? '').replace(/\\([_*])/g, '$1').trim();
    const description = [
      `Rule: ${clean(base.rule)}.`, clean(base.what_it_means), base.detection_logic && `Detection logic: ${clean(base.detection_logic)}.`,
      base.source_tables_fields && `Source tables / fields: ${clean(base.source_tables_fields)}.`, base.threshold_parameter && `Threshold: ${clean(base.threshold_parameter)}.`,
      req.body?.note && `Also: ${String(req.body.note).slice(0, 500)}`,
    ].filter(Boolean).join(' ');
    res.json(await suggestCustomRule({ description, module, dimensions: dimensionsByModule()[module] ?? [] }));
  } catch (err) { fail(res, next, err); }
});

/* ── thresholds ── */

function parameterOf(id, module, scope, key) {
  const base = ruleOr404(id);
  const p = (parametersByRule().get(base.id) ?? []).find((x) => x.module === module && x.scope === scope && x.key === key);
  if (!p) throw new RuleOverrideError(`${base.id} has no threshold ${scope}.${key}.`, 404);
  return { base, p };
}
const valueWords = (v) => (Array.isArray(v) ? v.join(', ') : v == null ? 'no value' : String(v));

healthRulebookRouter.put('/rulebook/rules/:id/parameters/:module/:scope/:key', (req, res, next) => {
  try {
    const { module, scope, key } = req.params;
    const { base, p } = parameterOf(req.params.id, module, scope, key);
    if (!req.body || !('value' in req.body)) throw new RuleOverrideError('A value is required.');
    if (!p.overridable) throw new RuleOverrideError(p.not_overridable_because || `${scope}.${key} cannot be changed.`);
    const by = boundInstance().username ?? null;
    let value = req.body.value;
    if (module === 'itsm') {
      try { buildParameterRegistry([]).registry.setInstanceOverride(scope, key, value); } catch (err) { throw new RuleOverrideError(err.message); }
      setItsmParameterOverride({ ruleId: scope, key, value, by });
    } else {
      const decl = findDeclaration(module, scope, key);
      if (!decl) throw new RuleOverrideError(`${module} has no parameter ${scope}.${key}.`, 404);
      const checked = validateParameterValue(decl, value);
      if (!checked.ok) throw new RuleOverrideError(checked.reason);
      value = checked.value;
      setParameterOverride({ module, scope, key, value, by });
    }
    logRuleChange({ ruleId: base.id, module: TAB_MODULE[base.tab], action: 'threshold', summary: `threshold ${key}: ${valueWords(p.value)} → ${valueWords(value)}${p.unit ? ` ${p.unit}` : ''}`, actor: actor() });
    res.json({ ...ruleView(req.params.id), pending: pendingNow() });
  } catch (err) { fail(res, next, err); }
});

healthRulebookRouter.delete('/rulebook/rules/:id/parameters/:module/:scope/:key', (req, res, next) => {
  try {
    const { module, scope, key } = req.params;
    const { base, p } = parameterOf(req.params.id, module, scope, key);
    const removed = module === 'itsm' ? clearItsmParameterOverride({ ruleId: scope, key }) : clearParameterOverride({ module, scope, key });
    if (!removed) throw new RuleOverrideError(`${scope}.${key} has no value of yours to clear.`, 404);
    logRuleChange({ ruleId: base.id, module: TAB_MODULE[base.tab], action: 'threshold', summary: `threshold ${key}: ${valueWords(p.value)} → back to its default (${valueWords(p.default)})`, actor: actor() });
    res.json({ ...ruleView(req.params.id), pending: pendingNow() });
  } catch (err) { fail(res, next, err); }
});

/* ── custom rules ── */

healthRulebookRouter.get('/custom-rules', (req, res, next) => {
  try {
    const last = latestCustomResults();
    res.json({ rules: listCustomRules().map((c) => ({ ...c, last: last[c.rule_id] ?? null })) });
  } catch (err) { fail(res, next, err); }
});

healthRulebookRouter.post('/custom-rules/preview', async (req, res, next) => {
  try {
    const def = validateCustomRule(req.body || {}, { dimensionsOf: (m) => workbookIndex().dimensions(m) });
    const r = await evaluateCustomRule(def, snowTable, { withFinding: false });
    res.json({ result: { status: r.status, verdict: r.verdict, population: r.population, matches: r.matches, share: r.share, sample: r.sample.slice(0, 10), query: r.query ?? null, reason: r.reason } });
  } catch (err) { fail(res, next, err); }
});

healthRulebookRouter.post('/custom-rules/suggest', async (req, res, next) => {
  try {
    const module = String(req.body?.module ?? '');
    res.json(await suggestCustomRule({ description: req.body?.description, module, dimensions: dimensionsByModule()[module] ?? [] }));
  } catch (err) { fail(res, next, err); }
});

healthRulebookRouter.post('/custom-rules', (req, res, next) => {
  try { res.status(201).json({ rule: createCustomRule(req.body || {}, { user: actor() }), pending: pendingNow() }); } catch (err) { fail(res, next, err); }
});

healthRulebookRouter.patch('/custom-rules/:id', (req, res, next) => {
  try { res.json({ rule: updateCustomRule(req.params.id, req.body || {}, { user: actor() }), pending: pendingNow() }); } catch (err) { fail(res, next, err); }
});

healthRulebookRouter.delete('/custom-rules/:id', (req, res, next) => {
  try { res.json({ ...deleteCustomRule(req.params.id, { user: actor() }), pending: pendingNow() }); } catch (err) { fail(res, next, err); }
});
