import crypto from 'node:crypto';
import { createWorkbookCatalogue } from './workbook-catalogue.js';
import { adaptWorkbookRule } from './adapter.js';
import { ParameterRegistry, loadParameterDeclarations } from './parameters.js';
import { loadRuleConfigs, ruleConfigFingerprint, dependencyEdges } from './rules/index.js';
import { normalizeITSMRun, aggregateITSMRules } from './integration.js';
import { itsmSourceHash } from './engine-key.js';
import { ITSM_ENGINE_REGISTRY, REGISTRY_VERSION } from './registry.js';

/**
 * HEALTH ASSIST PHASE 6 — a WORKBOOK CATALOGUE PACK, from its data.
 *
 * Phase 5 built ITOM as the first pack on the shared rule engine; Phase 6 makes the
 * pack a factory so every further workbook module (Platform, Enterprise DQ) is DATA —
 * a sheet, an architecture map, parameter declarations, rule files and equivalents —
 * not another copy of the wiring. One pack gives:
 *
 *   catalogue        the sheet joined slot for slot to its architecture map, validated
 *   pack             { key, domain, get, has, all, adapt } — what the runner needs (ctx.pack)
 *   parameters       the declarations in the shared ParameterRegistry (+ a fresh-registry factory)
 *   configs          the rule files, validated exactly as ITSM's
 *   normalize()      the ITSM normalisation over this pack; equivalent rules are rows of
 *                    their own (D-019), never "not run", with no finding or skip
 *   engineKey()      what besides the rows decides this module's results
 *
 * Every slot must be configured or equivalent — a pack with a silent gap fails at load.
 */
export function createWorkbookPack({ key, prefix, count, first = 1, domain, agent, sheet, architecture, equivalents = { rules: {} }, parametersDoc, ruleFiles, sourceDir }) {
  const catalogue = createWorkbookCatalogue({ prefix, count, first, catalogue: sheet, architecture });
  const get = (id) => catalogue.get(id);
  const has = (id) => catalogue.has(id);
  const all = () => catalogue.all();
  const adapt = (idOrRule) => adaptWorkbookRule(typeof idOrRule === 'string' ? get(idOrRule) : idOrRule, { domain, agent });
  const EQUIVALENTS = Object.freeze(Object.fromEntries(Object.entries(equivalents.rules || {}).map(([id, e]) => [id, Object.freeze({ ...e })])));

  const newParameterRegistry = () => loadParameterDeclarations(
    new ParameterRegistry({ version: parametersDoc.version ?? '1.0.0', ruleExists: has, workbookTextFor: (id) => get(id).threshold_parameter }),
    parametersDoc,
  );
  const parameters = newParameterRegistry();
  const configs = loadRuleConfigs(ruleFiles, { parameters, catalogue: { has, get } });
  const unaccounted = all().map((r) => r.id).filter((id) => !configs.has(id) && !EQUIVALENTS[id]);
  if (unaccounted.length) throw new Error(`${prefix} rules with neither a configuration nor an equivalent: ${unaccounted.join(', ')}`);

  const pack = Object.freeze({ key, domain, get, has, all, adapt });
  const spec = Object.freeze({ all, get, source: `${key}_catalogue`, trace: key });

  /*
   * Phase 9: a DERIVED row (`derived: true`) is a measure the module's own score is — CSDM-072,
   * the CSDM maturity composite, IS csdm-quality/2. Shown as a row of its own, never scored twice.
   */
  const equivalentRow = (id) => {
    const rule = get(id);
    const e = EQUIVALENTS[id];
    if (e.derived) {
      return {
        rule_id: id, slot: rule.slot, title: rule.rule, group: rule.group, engine: null, base_severity: rule.base_severity,
        classification: 'DERIVED', implemented: true, executable: false, configured: false,
        status: 'equivalent', verdict: null, evaluated: false, empty_population_evidence: false, population: null, population_empty: false, undetermined: null,
        blocker: { kind: 'derived', derived_from: e.equivalent_of, reason: `this measure is the module score (${e.equivalent_of}): ${e.note}` },
        scope: { partial: false }, confidence: null, findings: 0, kpis: [], parameters: {}, unresolved_parameters: [], dependencies: [], variants: [], evidence_missing: [],
        reason: `the module score (${e.equivalent_of})`, error: null, ms: null,
        equivalent_of: e.equivalent_of, derived: true, equivalent_outcome: null,
      };
    }
    return {
      rule_id: id, slot: rule.slot, title: rule.rule, group: rule.group, engine: null, base_severity: rule.base_severity,
      classification: 'EQUIVALENT', implemented: true, executable: false, configured: false,
      status: 'equivalent', verdict: null, evaluated: false, empty_population_evidence: false, population: null, population_empty: false, undetermined: null,
      blocker: { kind: 'equivalent', equivalent_of: e.equivalent_of, reason: `evaluated by ${e.equivalent_of} — the same condition (${e.note})` },
      scope: { partial: false }, confidence: null, findings: 0, kpis: [], parameters: {}, unresolved_parameters: [], dependencies: [], variants: [], evidence_missing: [],
      reason: `evaluated by ${e.equivalent_of}`, error: null, ms: null,
      equivalent_of: e.equivalent_of, equivalent_outcome: null,
    };
  };

  /** The run, normalised; equivalent slots are rows of their own, never "not run". */
  const normalize = (run, { configs: c = configs, parameters: p = parameters, runtime = {}, readCoverage = [] } = {}) => {
    const out = normalizeITSMRun(run, { configs: c, parameters: p, runtime, readCoverage, pack: spec });
    const eq = new Set(Object.keys(EQUIVALENTS));
    out.rules = out.rules.map((row) => (eq.has(row.rule_id) ? equivalentRow(row.rule_id) : row));
    out.skipped = out.skipped.filter((s) => !eq.has(s.rule));
    out.aggregation = aggregateITSMRules(out.rules, out.findings, { catalogue: all().map((r) => r.id).sort() });
    return out;
  };

  /** Each equivalent rule's outcome, from the scan's rule results (after the owning module has run). */
  const attachEquivalentOutcomes = (normalized, ruleResults = []) => {
    const byId = new Map(ruleResults.map((r) => [r.rule_id, r]));
    for (const row of normalized.rules) {
      if (!row.equivalent_of || row.derived) continue;
      const r = byId.get(row.equivalent_of);
      row.equivalent_outcome = r
        ? { rule_id: r.rule_id, status: r.status, verdict: r.verdict ?? null, findings: r.findings?.count ?? 0 }
        : { rule_id: row.equivalent_of, status: 'not_run', verdict: null, reason: `the module of ${row.equivalent_of} was not read on this scan` };
    }
    return normalized;
  };

  /** The registry a scan resolves with: declarations plus THIS instance's stored overrides; refusals are reported, never applied. */
  const buildParameterRegistry = (overrides = []) => {
    const registry = newParameterRegistry();
    const applied = []; const rejected = [];
    for (const o of overrides) {
      try { registry.setInstanceOverride(o.rule_id, o.key, o.value); applied.push({ rule_id: o.rule_id, key: o.key, value: o.value }); }
      catch (err) { rejected.push({ rule_id: o.rule_id, key: o.key, value: o.value, reason: err.message }); }
    }
    return { registry, applied, rejected };
  };

  const sharedSource = itsmSourceHash();
  const ownSource = sourceDir ? itsmSourceHash(sourceDir) : null;
  const defaultFingerprint = ruleConfigFingerprint(configs);
  /** The module's engine key: workbook, map, parameters, configurations, shared engines and the pack's own source. */
  const engineKey = ({ parameters: p = parameters, configs: c = configs } = {}) => {
    const inputs = {
      workbook_sha256: catalogue.meta.workbook_sha256,
      map_version: catalogue.meta.map_version,
      parameters: p.fingerprint(),
      engine_version: REGISTRY_VERSION,
      engine_versions: Object.fromEntries(Object.entries(ITSM_ENGINE_REGISTRY).map(([k, e]) => [k, e.version])),
      configuration: c === configs ? defaultFingerprint : ruleConfigFingerprint(c),
      dependencies: crypto.createHash('sha256').update(JSON.stringify(dependencyEdges(c, { getRule: get }))).digest('hex').slice(0, 16),
      shared_source: sharedSource,
      source: ownSource,
    };
    return Object.freeze({ key: crypto.createHash('sha256').update(JSON.stringify(inputs)).digest('hex').slice(0, 16), inputs: Object.freeze(inputs) });
  };

  return Object.freeze({
    key, prefix, domain, agent, catalogue, meta: catalogue.meta, pack, get, has, all, adapt, equivalents: EQUIVALENTS,
    newParameterRegistry, parameters, configs, normalize, attachEquivalentOutcomes, buildParameterRegistry, engineKey,
  });
}
