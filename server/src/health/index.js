import { evaluateCustomRule, customScoreRow } from './custom-rules.js';
import { TABLES, resolveTables, specHash } from './tables.js';
import { extractEstate, extractCmdbMeta, cmdbMetaSources, instanceClient, FAILED_READ_STATUSES } from './extract.js';
import { planScan, engineKeys, stampSources, stampingClient } from './incremental.js';
import { CONFIG_ONLY_RULES } from './cmdb-identification.js';
import { EstateRules, RULE_VERSION, AGENTS, isComplete, IMPLEMENTED_CATALOGUE_RULES } from './rules.js';
import { scoreCmdbQuality, CMDB_CATALOGUE, withCatalogueOverrides } from './cmdb-quality.js';
import { EMPTY_OVERRIDES, applyToNormalized, overrideFingerprints } from './rule-overrides.js';
import { cmdbInScope } from './cmdb-gate.js';
import { explainFindings } from './explain.js';
import { digest } from './digest.js';
import { summariseScopes, normaliseModules, moduleTables, MODULE_KEYS, scopeOfRule, overallScope } from './scopes.js';
import { OVERALL_WEIGHT_DEFAULTS } from './overall-health.js';
import { ITSM_TABLES } from './itsm-quality.js';
import { DQ_INACTIVE_INSTALL_STATUS, intentMisTags } from './cmdb-signals.js';
import { trackMisroutes } from './cmdb-csdm.js';
import { CONSUMPTION_TRACKS } from './cmdb-consumption.js';
import { SCALE_TRACKS } from './cmdb-scale.js';
import { DRIFT_TRACKS, cmdbScoreTrend } from './cmdb-drift.js';
import { createEvaluationContext } from './itsm/context.js';
import { runITSMRules } from './itsm/runner.js';
import { normalizeITSMRun, countingClient, itsmPerformance } from './itsm/integration.js';
import { ITSM_PARAMETERS } from './itsm/parameters.js';
import { ITSM_RULE_CONFIGS } from './itsm/rules/index.js';
import { hasITSMRule, getAllITSMRules } from './itsm/catalogue.js';
import { adaptRule } from './itsm/adapter.js';
import { collectMeasures, historyForScan, historyFromRuns } from './itsm/measure-history.js';
import { undeterminedOf } from './itsm/engines/result.js';
import { registerItsmCatalogue } from './remediation.js';
import { registerItsmCatalogueRules, LEGACY_RULE_ORIGIN } from './rule-catalogue.js';
import { evaluateLinks } from './cross-domain/links.js';
import { buildRuleResults, summariseRuleResults, RULE_RESULT_VERSION } from './rule-results.js';
import { workbookIndex, moduleRegistry } from './modules.js';
import { promotedConfig, promotion } from './scoring/promotion.js';
import { scoreCmdbV2 } from './scoring/cmdb-v2.js';
import { scoreItsmV2 } from './scoring/itsm-v2.js';
import { SCAN_PACKS } from './packs.js';
import { assessApplicability } from './applicability.js';
import { assessSystemic } from './systemic.js';
import { assessCoverage } from './coverage-measures.js';
import { moduleValidity, overallValidity } from './validity.js';

/* The remediation layer's ITSM catalogue guidance — registered here, the one facade over health/itsm. */
registerItsmCatalogue((ruleId) => (hasITSMRule(ruleId) ? adaptRule(ruleId) : null));
/* The category layer's rule catalogue (rule-catalogue.js) gets the ITSM rules
   the same way — injected here, so it never imports health/itsm itself. */
registerItsmCatalogueRules(getAllITSMRules);

/**
 * Health Assist — the run.
 *
 * extract → deterministic rules → synthesis → manifest, with an optional
 * plain-language pass over the findings that is never allowed to become the
 * findings themselves.
 *
 * The manifest is the point of this module. A health check that returns a list
 * of problems and nothing else cannot be audited: you cannot tell a clean
 * estate from an extraction that read three rows, and you cannot tell a rule
 * that found nothing from a rule that never ran. So every run carries its
 * coverage, its skipped rules with reasons, its rule-pack version, its input
 * hash and its cutoff — and the score is withheld entirely unless the two
 * tables it is computed from were read completely.
 */

export const MANIFEST_VERSION = '5.0.0';

/*
 * A run STORES every finding it detected. There is no storage cap.
 *
 * There were two. At 1,000, the counts were taken from the stored slice, and
 * on techsnitchpvtltddemo2 — 12,194 detected — the page said "1000 things
 * found", "989 Moderate" and "0 Low". The counts were then moved to the full
 * detected set and the cap raised to 25,000 as a "memory guard", which made
 * the same defect the other way round: on an instance with 29,177 findings
 * the ITSM view counted 56 Low and 280 Moderate from the full set, while the
 * stored slice — the 25,000 highest priority_score rows ACROSS ALL MODULES,
 * cut at 3.0 — held 0 Low and 33 Moderate. Selecting Low listed nothing;
 * the score, the chips and the donut all described rows that did not exist.
 *
 * A finding that is counted but not stored cannot be listed, searched,
 * opened, exported, muted or acknowledged, so the rows and the counts must be
 * one population. The slice guarded no memory — `all` is built in full before
 * it, with its evidence — and database growth is bounded by
 * KEEP_FINDINGS_FOR_RUNS pruning in store.js, not by the size of one run.
 * `findings_detected`, `findings_stored` and `findings_truncated` stay in the
 * manifest so that runs recorded under a cap still say so.
 */
const DEFAULT_STALE_DAYS = 90;

export { digest };

/**
 * The CMDB quality score, or null.
 *
 * Percent of extracted CIs with no CMDB rule against them. It is withheld
 * unless BOTH cmdb_ci and cmdb_rel_ci came back complete, because a partial
 * relationship read inflates CMDB-UNRELATED and would push the score down for
 * a reason that is about our access, not their data. A number that is
 * sometimes about the estate and sometimes about the reader is worse than no
 * number, so the UI gets `null` and prints why.
 */
export function qualityScore(estate, coverage, findings) {
  const ciCount = (estate.cmdb_ci || []).length;
  /* Every CI ROW and every relationship ROW. A missing optional column such as
     `business_criticality` does not change which CIs exist, so it no longer
     withholds the score. */
  const ciComplete = isComplete(coverage, 'cmdb_ci');
  const relComplete = isComplete(coverage, 'cmdb_rel_ci', ['parent', 'child']);
  if (!ciCount || !ciComplete || !relComplete) return null;
  const affected = new Set();
  for (const f of findings) {
    if (f.domain === 'CMDB') for (const id of f.target_ids) affected.add(id);
  }
  return Number((100 * (1 - affected.size / ciCount)).toFixed(1));
}

/**
 * Group findings that share a rule.
 *
 * Explicitly NOT root-cause analysis. Findings sharing a rule share a PATTERN;
 * whether they share a cause is a question this system has no evidence for, and
 * the note travels with the cluster so a reader cannot mistake the one for the
 * other.
 */
export function clusterByRule(findings) {
  const groups = new Map();
  for (const f of findings) {
    if (!groups.has(f.rule_id)) groups.set(f.rule_id, []);
    groups.get(f.rule_id).push(f.fingerprint);
  }
  return [...groups.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([rule, ids]) => ({
      rule_id: rule,
      finding_fingerprints: ids,
      title: `Shared rule pattern: ${rule}`,
      type: 'symptom_cluster',
      note: 'Correlation by deterministic rule; a common causal mechanism has not been proven.',
    }));
}

/**
 * Run a health check.
 *
 * `onProgress` receives coarse stages so the UI can stream them. It is optional
 * and awaited — a slow consumer slows the run rather than dropping frames,
 * which keeps the stream an accurate account of what happened.
 *
 * `ruleOverrides` (Job HC-1) are the Rulebook's changes to the built-in rules
 * (rule-overrides.js scanRuleOverrides): a CMDB rule's new band or wording is in
 * force in the catalogue for the whole scan, so every reader sees one catalogue.
 */
export async function runHealthCheck(options = {}) {
  const ov = options.ruleOverrides ?? EMPTY_OVERRIDES;
  return withCatalogueOverrides({ severity: ov.severity, titles: ov.titles }, () => runScan(options));
}

async function runScan({
  tables,
  /* Which modules to check — CMDB, ITOM, ITSM, Platform. Nothing means all. */
  modules,
  /* Skip a module whose inputs have not changed since its last result. */
  reuse = true,
  /* Per module, what its current result was computed from (store.moduleBaselines). */
  baselines = {},
  /* Per table, the incremental settings (store.tableSettings). */
  tableSettings = {},
  /* The connected account — a different one may see different rows. */
  user = null,
  staleDays = DEFAULT_STALE_DAYS,
  explain = true,
  limit,
  onProgress = null,
  client,
  signal = null,
  now = new Date(),
  /* Fingerprints a person marked "accepted risk" — the approved-exception
     de-escalator. Passed in, because the rule pack never reads the database. */
  acceptedFingerprints = [],
  /* The same decisions with their rule ids, so each module's engine key sees only its own. */
  acceptedRules = [],
  /* D-038: the custom rules switched on (custom-rules-store.js); each runs in the scan of its module. */
  customRules = [],
  /* Job HC-1: the Rulebook's changes to built-in rules — { off, severity, titles, checks }. */
  ruleOverrides = EMPTY_OVERRIDES,
  /* Earlier runs' measures (duplicate-set membership) for the trend rules. */
  measureHistory = {},
  /*
   * The ITSM catalogue's inputs for this scan (ITSM Phase 5): `parameters` is the
   * registry — declarations plus this instance's overrides — and `runtime` the
   * per-run overrides (`{ 'ITSM-nnn': { key: value } }`), recorded on the run and
   * never part of the engine key. `configs` is injectable for the suite only.
   */
  itsm: itsmOptions = {},
  /*
   * The CMDB parameters for this scan (Health Assist Phase 1): `parameters` is
   * `resolveParameters('cmdb', { instance, runtime })` from parameter-registry.js.
   * Its `options` reach each rule pack as overrides only (the pack's defaults fill
   * the rest); its `fingerprint` (instance overrides only) joins the CMDB engine
   * key. Absent, every pack runs on its defaults exactly as before.
   */
  cmdb: cmdbOptions = {},
  /*
   * The ITOM catalogue's inputs (Health Assist Phase 5), the ITSM shape: `parameters`
   * is the registry (declarations plus this instance's overrides), `runtime` the
   * per-run overrides, `configs` injectable for the suite only.
   */
  itom: itomOptions = {},
  /* The Platform catalogue's inputs (Health Assist Phase 6), the same shape. */
  platform: platformOptions = {},
  /* The Enterprise Data Quality catalogue's inputs (Health Assist Phase 7), the same shape. */
  enterprise_dq: enterpriseDqOptions = {},
  /* The CSDM catalogue's inputs (Health Assist Phase 9), the same shape. */
  csdm: csdmOptions = {},
  /* The ITIL catalogue's inputs (Health Assist Phase 10), the same shape. */
  itil: itilOptions = {},
  /* The Overall's module weights (Health Assist Phase 8, parameter module `overall`); absent, the declared defaults. */
  overall: overallOptions = {},
} = {}) {
  /* Each workbook pack's options, by module (packs.js). */
  const packOptions = { itom: itomOptions, platform: platformOptions, enterprise_dq: enterpriseDqOptions, csdm: csdmOptions, itil: itilOptions };
  const overallWeights = overallOptions.weights ?? OVERALL_WEIGHT_DEFAULTS;
  const cmdbParameters = cmdbOptions.parameters ?? { options: {}, applied: [], rejected: [], fingerprint: null };
  /* `itsmOptions.measureHistory` — earlier scans' ITSM readings (itsm/measure-history.js historyFromRuns). */
  const startedAt = Date.now();
  const phases = {};
  const emit = async (stage, percent, detail = {}) => {
    await onProgress?.({ stage, percent, ...detail });
  };
  /* An explicit table list is the older API: every module, read in full. */
  const explicitTables = Array.isArray(tables) && tables.length > 0;
  const wanted = explicitTables ? [...MODULE_KEYS] : normaliseModules(modules);
  const keys = engineKeys({ staleDays, acceptedRules, itsmParameters: itsmOptions.parameters, packParameters: Object.fromEntries(Object.entries(packOptions).map(([m, o]) => [m, o.parameters])), cmdbParameters: cmdbParameters.fingerprint, rules: overrideFingerprints(ruleOverrides, customRules) });
  const accepted = acceptedFingerprints.length ? acceptedFingerprints : acceptedRules.map((a) => a.fingerprint);
  /*
   * Job HC-1 — THE RULEBOOK'S CHANGES. A rule switched off or removed runs no more;
   * a rule given a check of its own is evaluated by that check (with the custom
   * rules, below) and its catalogue row is replaced by the check's. The ITSM
   * catalogue and each pack apply them to their normalized result, before
   * analyze(), so priority, counts and scores all see the same rules.
   */
  const overrideOff = new Set(ruleOverrides.off || []);
  const ownChecks = ruleOverrides.checks || [];
  const applyOverrides = (normalized) => applyToNormalized(normalized, {
    off: overrideOff, replaced: new Set(ownChecks.map((c) => c.rule_id)), severity: ruleOverrides.severity || {}, titles: ruleOverrides.titles || {},
  });
  const reader = client || instanceClient;

  /*
   * THE CHANGE CHECK. One stamp per input of every module that could keep its
   * result; the modules whose inputs moved are read, the rest are verified.
   */
  let plan = null;
  if (!explicitTables) {
    await emit('checking for changes', 2);
    plan = await planScan({ modules: wanted, client: reader, baselines, tableSettings, engineKeys: keys, user, reuse, now, signal });
    phases.change_check_ms = plan.probe_ms;
  }
  const readModules = plan ? plan.read : wanted;
  const verifiedModules = plan ? plan.reuse : [];

  if (!readModules.length) {
    /* Nothing changed anywhere that was asked about. No rows are read and no
       findings are produced: each module keeps the result it already has. */
    const manifest = {
      version: MANIFEST_VERSION,
      rule_pack_version: RULE_VERSION,
      kind: 'verification',
      modules: [],
      requested_modules: wanted,
      verified_modules: verifiedModules,
      plan,
      engine_keys: keys,
      connection_user: user,
      cutoff: null,
      coverage: {},
      skipped_checks: [],
      findings_detected: 0,
      findings_stored: 0,
      findings_truncated: false,
      metrics: { visible_cis: 0, visible_relationships: 0, fetched_rows: 0, cmdb_quality_score: null },
      phases: { ...phases, total_ms: Date.now() - startedAt },
      narrative: `No changes since the last result for ${verifiedModules.join(', ')} — those results stand, verified now.`,
    };
    await emit('done', 100);
    return { status: 'completed', findings: [], manifest };
  }

  /* Read what the modules declare, plus anything their rules read last time. */
  const priorInputs = readModules.flatMap((m) => baselines[m]?.dependencies || []).filter((t) => TABLES[t]);
  const requested = explicitTables
    ? resolveTables(tables)
    : resolveTables([...new Set([...moduleTables(readModules), ...priorInputs])]);

  await emit('extracting', 5);
  let t0 = Date.now();
  const { estate, coverage, cutoff, stamps } = await extractEstate(requested, {
    limit,
    client,
    signal,
    stamps: true,
    onProgress: async ({ table: t, index, total }) => {
      /* `index` is 0-based and sent BEFORE the table is read, so this is "reading N of M". */
      await emit('extracting', 5 + Math.round((index * 55) / Math.max(1, total)), { table: t, tableIndex: index + 1, tableTotal: total });
    },
  });
  phases.extract_ms = Date.now() - t0;

  const fetchedRows = Object.values(estate).reduce((n, rows) => n + rows.length, 0);

  /* Checked between phases, not inside them. Analysis is pure and fast; the
     expensive, interruptible part is extraction, and that checks per table. */
  if (signal?.aborted) throw Object.assign(new Error('Stopped.'), { name: 'AbortError' });

  /*
   * The trust gate's bounded meta reads — class hierarchy, filter counts, job
   * triggers, execution counts. Only when CMDB is being read; each read carries
   * its own status, so a failure skips the rules that needed it. Their sources
   * are stamped FIRST, for the same reason tables are.
   */
  const readsCmdb = readModules.includes('cmdb') && requested.includes('cmdb_ci');
  let meta = {};
  let metaStamps = null;
  if (readsCmdb) {
    await emit('reading governance', 64);
    t0 = Date.now();
    metaStamps = await stampSources(reader, cmdbMetaSources(estate), { now });
    meta = await extractCmdbMeta(estate, { client, signal });
    phases.meta_ms = Date.now() - t0;
  }

  /*
   * ITSM PHASE 5 — THE 139-RULE CATALOGUE, when ITSM is read. Every slot is run
   * through the Phase 4 runner as it stands: its capability pipeline, field gate,
   * parameters and composite ordering decide each rule's state, and nothing here
   * overrides them. Its results are normalised (health/itsm/integration.js) and
   * handed to analyze(); the eleven hard-coded ITSM rules keep running beside it
   * and keep producing the ITSM score.
   */
  let itsm = null;
  if (readModules.includes('itsm')) {
    await emit('checking ITSM rules', 66);
    t0 = Date.now();
    const parameters = itsmOptions.parameters ?? ITSM_PARAMETERS;
    const runtime = itsmOptions.runtime ?? {};
    const configs = itsmOptions.configs ?? ITSM_RULE_CONFIGS;
    const counting = countingClient(reader);
    const stamping = stampingClient(counting.client, { now });
    /* Trend rules compare only with earlier readings of THIS instance under the SAME comparability key. */
    const history = historyForScan(itsmOptions.measureHistory, { configs, parameters, runtime, now });
    const ctx = createEvaluationContext({ client: stamping.client, now, signal, parameters, runtimeParameters: runtime, measureHistory: history.measureHistory });
    const run = await runITSMRules(ctx, { configs });
    const readCoverage = await ctx.reads.coverage();
    const normalized = applyOverrides(normalizeITSMRun(run, { configs, parameters, runtime, readCoverage }));
    const performance = itsmPerformance({ run, rules: normalized.rules, calls: counting.calls, readCoverage, readRequirements: ctx.reads.size(), probeCache: ctx.probes.cacheSize(), cacheStats: ctx.cacheStats() });
    itsm = { run, ctx, normalized, parameters, runtime, stamps: await stamping.stamps(), performance, history, measures: collectMeasures(run, { configs, parameters, runtime, timezone: ctx.run.timezone }) };
    phases.itsm_ms = Date.now() - t0;
    if (signal?.aborted) throw Object.assign(new Error('Stopped.'), { name: 'AbortError' });
  }

  /*
   * HEALTH ASSIST PHASES 5–6 — THE WORKBOOK CATALOGUE PACKS (ITOM, Platform), each
   * when its module is read, through the same runner as ITSM (packs.js): every table
   * a rule reads is verified on this instance first, every platform value comes from
   * sys_choice, and a rule whose object, threshold or definition is missing says
   * which — never PASS.
   */
  const packRuns = {};
  for (const entry of SCAN_PACKS) {
    if (!readModules.includes(entry.module)) continue;
    const { pack } = entry;
    const opts = packOptions[entry.module] || {};
    await emit(...entry.progress);
    t0 = Date.now();
    const parameters = opts.parameters ?? pack.parameters;
    const runtime = opts.runtime ?? {};
    const configs = opts.configs ?? pack.configs;
    const counting = countingClient(reader);
    const stamping = stampingClient(counting.client, { now });
    /* D-037: a pack's trend rules compare only with earlier readings of THIS instance under the SAME comparability key, as ITSM's do. */
    const history = historyForScan(opts.measureHistory, { configs, parameters, runtime, now });
    const ctx = createEvaluationContext({ client: stamping.client, now, signal, parameters, runtimeParameters: runtime, pack: pack.pack, measureHistory: history.measureHistory });
    const run = await runITSMRules(ctx, { configs });
    const readCoverage = await ctx.reads.coverage();
    const normalized = applyOverrides(pack.normalize(run, { configs, parameters, runtime, readCoverage }));
    const performance = itsmPerformance({ run, rules: normalized.rules, calls: counting.calls, readCoverage, readRequirements: ctx.reads.size(), probeCache: ctx.probes.cacheSize(), cacheStats: ctx.cacheStats() });
    packRuns[entry.module] = { entry, run, ctx, normalized, parameters, runtime, configs, rejected: opts.rejected ?? [], stamps: await stamping.stamps(), performance, history, measures: collectMeasures(run, { configs, parameters, runtime, timezone: ctx.run.timezone }) };
    phases[`${entry.module}_ms`] = Date.now() - t0;
    if (signal?.aborted) throw Object.assign(new Error('Stopped.'), { name: 'AbortError' });
  }

  /*
   * D-038 — CUSTOM RULES, each in the scan of its module, read-only — and (Job HC-1)
   * the checks a person gave built-in rules the product never built, run the same way
   * under the rule's own id. A failing rule's finding goes through analyze() like any
   * rule's, so it gets its priority (NOT NULL in storage); with "count in score" on,
   * its result joins its module's score in the area it names, by that module's own
   * arithmetic.
   */
  const customRun = [];
  const customHere = [...customRules.filter((c) => c.active !== false), ...ownChecks].filter((c) => readModules.includes(c.module) && !overrideOff.has(c.rule_id));
  if (customHere.length) await emit('checking custom rules', 69);
  for (const c of customHere) {
    const result = await evaluateCustomRule(c, reader, { now });
    customRun.push({ rule: c, result });
  }
  await emit('analysing', 70);
  t0 = Date.now();
  const rules = new EstateRules(estate, coverage, staleDays, now, { meta, parameters: cmdbParameters.options, acceptedFingerprints: accepted, history: measureHistory, switchedOff: overrideOff });
  const all = rules.analyze({ modules: readModules, external: { ...(itsm ? { itsm: itsm.normalized } : {}), ...Object.fromEntries(Object.entries(packRuns).map(([m, r]) => [m, r.normalized])), custom: customRun.map((c) => c.result.finding).filter(Boolean) } });
  const customScored = (m) => customRun.filter((c) => c.rule.module === m && c.rule.scored !== false);
  const customRows = (m, rows) => [...rows, ...customScored(m).map((c) => customScoreRow(c.rule, c.result))];
  const customOverlay = (m, base) => (id) => { const c = customScored(m).find((x) => x.rule.rule_id === id); return c ? { dimension: c.rule.dimension, kind: null } : base(id); };
  const customRate = (id) => { const c = customRun.find((x) => x.rule.rule_id === id); return c?.rule.kind === 'rate' ? { op: 'gt', key: 'max_share' } : null; };
  const customConfigs = (m, configs) => new Map([...configs, ...customScored(m).filter((c) => c.rule.kind === 'rate').map((c) => [c.rule.rule_id, { engine: 'aggregate', config: { threshold: { op: 'gt', value: { $param: 'max_share' } } } }])]);
  const cmdbCustom = customScored('cmdb').filter((c) => c.result.pass_pct != null);
  const cmdbCustomKpis = cmdbCustom.map((c) => ({ rule_id: c.rule.rule_id, pass_pct: c.result.pass_pct, numerator: c.result.population - c.result.matches, denominator: c.result.population, basis: `${c.result.matches} of ${c.result.population} ${c.rule.table} records match`, custom: true, target_pct: c.rule.kind === 'rate' ? 100 - c.rule.threshold.max_share : null }));
  const cmdbCustomCatalogue = Object.fromEntries(cmdbCustom.map((c) => [c.rule.rule_id, { id: c.rule.rule_id, dimension: c.rule.dimension, track: 'dimension', base: c.rule.severity, title: c.rule.name }]));
  /*
   * PHASE 6 — CROSS-DOMAIN LINKS, over THIS scan's results only (cross-domain/links.js).
   * Report-only: nothing here changes a finding, a verdict, a priority or a score.
   */
  const links = evaluateLinks({ readModules, itsmResults: itsm?.run.results ?? null, findings: all, skipped: rules.skipped, undeterminedOf });
  phases.analyse_ms = Date.now() - t0;
  /* Per rule pack, with the tables each read — see `stage` in rules.analyze. */
  phases.analyse_stages = rules.timings?.stages ?? [];
  /* `let`: CMDB-137 can add one finding after scoring, and the count is retaken then.
     `findings` IS `all`: what is stored is what is counted. */
  let detected = all.length;
  let findings = all;

  let llm = { status: 'disabled', tokens_used: 0 };
  if (explain && findings.length) {
    await emit('explaining', 88);
    t0 = Date.now();
    llm = await explainFindings(findings);
    phases.explain_ms = Date.now() - t0;
  }
  /* Progress past the summary, so the page never sits on 88% while the scores are worked out. */
  await emit('scoring', 92);

  /*
   * Every count and score below is taken from `all` — the full detected set —
   * never from the stored slice. A cap may drop rows from storage; it must not
   * change what the page says was found.
   */
  /*
   * CMDB QUALITY — the two-layer model (trust gate + record scores within
   * D1–D10). It replaces the pass rate as the CMDB number; `qualityScore` is
   * kept only so an older stored run is not reinterpreted. A scan that did not
   * check CMDB has no CMDB number at all, rather than one computed over the CIs
   * it happened to read for another module.
   */
  /*
   * THE DATA-QUALITY DIMENSIONS SCORE A NARROWER SET (decision 7 of 16 Sep 2026).
   *
   * Completeness, correctness, uniqueness, identification and reconciliation
   * judge records somebody is supposed to maintain, so retired, stolen and
   * absent CIs are out of their denominator as well as out of their findings.
   * The lifecycle dimension (D8) keeps every one of them — evaluating those
   * statuses is what it is for.
   */
  const scope = readsCmdb ? cmdbInScope(rules) : { ids: [], basis: '' };
  const inactive = new Set((estate.cmdb_ci || [])
    .filter((c) => DQ_INACTIVE_INSTALL_STATUS.includes(String(c.install_status ?? '').trim()))
    .map((c) => c.sys_id));
  const dqIds = [...scope.ids].filter((id) => !inactive.has(id));
  const dimensionScope = inactive.size
    ? { D1: dqIds, D2: dqIds, D3: dqIds, D4: dqIds, D5: dqIds }
    : {};
  t0 = Date.now();
  /* A CMDB rule switched off in the Rulebook is not built as far as any dimension is concerned (like a retired one). */
  const implementedHere = overrideOff.size ? new Set([...IMPLEMENTED_CATALOGUE_RULES].filter((id) => !overrideOff.has(id))) : IMPLEMENTED_CATALOGUE_RULES;
  const cmdbQuality = readsCmdb
    ? scoreCmdbQuality({
      findings: all, kpis: [...rules.kpis, ...cmdbCustomKpis], inScope: scope, implemented: implementedHere,
      measures: rules.measures, dimensionScope, skippedRules: rules.skipped, configRules: CONFIG_ONLY_RULES, customCatalogue: cmdbCustomCatalogue,
    })
    : null;
  /*
   * CMDB-137 needs the composite it trends, so it is evaluated only now. Its
   * finding joins the same list and is counted on the trend track; it never
   * feeds back into the score it describes.
   */
  phases.score_ms = Date.now() - t0;
  if (cmdbQuality) {
    const trend = cmdbScoreTrend(rules, cmdbQuality, cmdbParameters.options.drift);
    if (trend) {
      cmdbQuality.tracks.trend = (cmdbQuality.tracks.trend || 0) + 1;
      detected = all.length;
      findings = all;
    }
  }
  /*
   * HEALTH ASSIST PHASE 4 — the promoted model (health-quality/2, decision D-016).
   * CMDB and ITSM are scored twice: by the promoted model, which the page shows,
   * and by the previous one (v1), published beside it on every run so the change
   * of model is visible as a change of method, not of estate. ITOM and Platform
   * keep their models until their phases.
   */
  const promoted = promotedConfig();
  const wbIndex = workbookIndex();
  const cmdbQualityV2 = cmdbQuality
    ? scoreCmdbV2({
      v1: cmdbQuality, findings: all, kpis: [...rules.kpis, ...cmdbCustomKpis], inScope: scope, dimensionScope,
      cis: estate.cmdb_ci || [], signals: rules.signals, options: cmdbParameters.options, config: promoted,
    })
    : null;
  const score = cmdbQualityV2 ? cmdbQualityV2.composite.score : (readModules.includes('cmdb') ? qualityScore(estate, coverage, all) : null);
  /* ITSM Quality scores the extracted record slice (itsm-quality.js): the
     population is the rows this scan read, and the catalogue's rule rows carry
     the estate-level verdicts. Neither is stored per run — the manifest keeps
     the resulting summary, and a run recorded before the model recomputes
     from its legacy findings alone. */
  const itsmScoring = itsm ? {
    rules: itsm.normalized.rules,
    population: Object.fromEntries(ITSM_TABLES.map((t) => [t, new Set((estate[t] || []).map((r) => r.sys_id))])),
  } : null;
  /* The All scope carries the overall (overall-health.js) only when this scan
     read every scorable area; `comparability` names the CMDB model for its key. */
  const v1Scopes = summariseScopes(coverage, all, { cmdbQuality, itsm: itsmScoring, comparability: rules.comparability, overall: { modules: readModules, model: 'v1' } });
  const itsmThreshold = (id) => {
    const c = ITSM_RULE_CONFIGS.get(id);
    const t = c?.engine === 'aggregate' ? c.config?.threshold : null;
    return t?.value?.$param ? { op: t.op, key: t.value.$param } : null;
  };
  const itsmModel = itsm
    ? scoreItsmV2({
      rows: customRows('itsm', itsm.normalized.rules), overlay: customOverlay('itsm', wbIndex.overlay), threshold: (id) => customRate(id) ?? itsmThreshold(id),
      dimensions: wbIndex.dimensions('itsm'), config: promoted, coverage: v1Scopes.itsm?.itsm_quality?.coverage ?? null,
    })
    : null;
  /* Phases 5–6: each workbook pack on the promoted model, from its catalogue rows; ITOM's previous checks score beside it, Platform had none. */
  const packModels = Object.fromEntries(Object.entries(packRuns).map(([m, r]) => [m, r.entry.score({ rows: customRows(m, r.normalized.rules), overlay: customOverlay(m, wbIndex.overlay), configs: customConfigs(m, r.configs), dimensions: wbIndex.dimensions(m), config: promoted })]));
  const allScopes = summariseScopes(coverage, all, { cmdbQuality: cmdbQualityV2 ?? cmdbQuality, itsm: itsmScoring, itsmModel, itomModel: packModels.itom ?? null, platformModel: packModels.platform ?? null, enterpriseDqModel: packModels.enterprise_dq ?? null, csdmModel: packModels.csdm ?? null, itilModel: packModels.itil ?? null, comparability: rules.comparability, overall: { modules: readModules, weights: overallWeights } });
  /* Dual publication: the previous model's number beside the promoted one. */
  const modelTransition = {};
  for (const m of ['cmdb', 'itsm', 'itom', 'platform']) {
    const now = allScopes[m];
    const before = v1Scopes[m];
    if (!now || !before || !readModules.includes(m)) continue;
    now.previous_model = {
      model: before.scoring?.model ?? null, key: before.scoring?.key ?? null, score: before.score, basis: before.score_basis, withheld_because: before.score_withheld_because,
      drivers: before.score_drivers ?? null,
      /* CMDB's previous parts are stored whole as manifest.cmdb_quality_v1; ITSM's live here. */
      quality: m === 'itsm' ? (before.itsm_quality ?? null) : null,
      /* ITOM's previous model is the capability checks; kept whole beside the catalogue score. */
      checks: m === 'itom' ? (before.checks ?? null) : null,
    };
    modelTransition[m] = {
      from: now.previous_model.model, to: now.scoring?.model ?? null,
      previous_score: before.score, score: now.score,
      delta: before.score != null && now.score != null ? Number((now.score - before.score).toFixed(1)) : null,
    };
  }
  if (allScopes.all && v1Scopes.all?.score !== undefined) {
    allScopes.all.previous_model = { model: v1Scopes.all.scoring?.model ?? null, key: v1Scopes.all.scoring?.key ?? null, score: v1Scopes.all.score ?? null, note: 'overall-health/1 (equal-weight mean of CMDB, ITOM and ITSM; Platform and Enterprise DQ at weight 0) over the previous module models.' };
  }
  /* Only the modules this scan checked carry a summary; the others keep theirs in their own runs. */
  const scopes = Object.fromEntries(Object.entries(allScopes).filter(([k]) => k === 'all' || readModules.includes(k)));

  /*
   * `partial` is the run-level honesty flag, and it is deliberately eager: any
   * table that is not complete-or-deliberately-absent, any skipped rule, any
   * truncation, or an explanation pass that could not run all make the whole
   * run partial. A run is only `completed` when there is nothing to caveat.
   */
  const partial = Object.values(coverage).some((c) => !['complete', 'not_requested'].includes(c.status))
    || rules.skipped.length > 0
    || detected > findings.length
    || llm.status === 'unavailable';

  /*
   * WHICH RESULTS ARE SAFE TO KEEP.
   *
   * A scan whose reads failed still produces findings — fewer of them, because
   * the rules that needed those reads skipped. Measured on dev424910: a second
   * full scan an hour after the first came back with 68 fewer findings and a
   * CMDB score eight points higher, because the instance had slowed to the point
   * of failing governance reads. Keeping that as a module's result for a day
   * would report an improvement nobody made, so a degraded result is recorded as
   * such and is never reused: the next scan reads it again.
   *
   * `unavailable` and `limited` are NOT degradation — a table absent on this
   * instance, or rows an ACL hides, are stable facts the findings already state.
   */
  const FAILED_READ = new Set(FAILED_READ_STATUSES);
  const degraded = {};
  for (const m of readModules) {
    const why = (rules.dependencies?.[m] || [])
      .filter((t) => FAILED_READ.has(coverage[t]?.status))
      .map((t) => `${t}: ${coverage[t].status}`);
    if (m === 'cmdb') {
      for (const [k, r] of Object.entries(meta.cmdb?.reads || {})) if (r.status !== 'ok') why.push(`governance read ${k}: ${r.status}`);
    }
    /* A catalogue read that FAILED (not one the instance cannot serve) is as
       transient as a failed table read, so that ITSM result is not reused. */
    if (m === 'itsm' && itsm) why.push(...itsm.normalized.degraded.map((d) => `catalogue ${d}`));
    if (packRuns[m]) why.push(...packRuns[m].normalized.degraded.map((d) => `catalogue ${d}`));
    if (why.length) degraded[m] = why;
  }

  /*
   * HEALTH ASSIST PHASE 1 — ONE OUTCOME PER RULE (rule-results.js). For every
   * module this scan READ: every implemented CMDB catalogue rule, the ITSM
   * catalogue's rows, and the hard-coded rules, each as status, verdict, the
   * basis of that verdict, measurement and findings. Descriptive only: it reads
   * what the engine decided and changes no finding and no score. A module this
   * scan verified unchanged keeps the rule results of the run it was read in.
   */
  const index = wbIndex;
  const ruleList = [];
  if (readModules.includes('cmdb')) {
    for (const id of [...implementedHere].sort()) ruleList.push({ rule_id: id, module: 'cmdb', source: 'cmdb_catalogue', base_severity: CMDB_CATALOGUE[id]?.base ?? null });
  }
  if (itsm) for (const row of itsm.normalized.rules) ruleList.push({ rule_id: row.rule_id, module: 'itsm', source: 'itsm_catalogue', base_severity: row.base_severity });
  for (const [m, r] of Object.entries(packRuns)) for (const row of r.normalized.rules) ruleList.push({ rule_id: row.rule_id, module: m, source: `${m}_catalogue`, base_severity: row.base_severity });
  for (const id of Object.keys(LEGACY_RULE_ORIGIN)) {
    const m = scopeOfRule(id);
    if (readModules.includes(m)) ruleList.push({ rule_id: id, module: m, source: 'legacy', base_severity: null });
  }
  const ruleResults = buildRuleResults({
    rules: ruleList,
    findings: all,
    skipped: rules.skipped,
    kpis: rules.kpis,
    itsmRows: [...(itsm ? itsm.normalized.rules : []), ...Object.values(packRuns).flatMap((r) => r.normalized.rules)],
    workbookIdentity: index.identity,
    retiring: index.retiring,
  });
  /* Equivalent rules carry their owner's outcome (D-019, D-023) — known only now that every module's rules have run. */
  for (const r of Object.values(packRuns)) r.entry.pack.attachEquivalentOutcomes(r.normalized, ruleResults);

  /*
   * HEALTH ASSIST PHASE 2 — applicability, Systemic conditions and blockers,
   * the three coverage measures, and a validity block per module. ADDITIVE:
   * every existing summary field keeps its meaning; `validity` sits beside the
   * score and says how far it can be relied on. The number is never hidden.
   */
  let registry = [];
  try { registry = moduleRegistry(); } catch { registry = []; }
  const applicability = assessApplicability({ modules: readModules, estate, coverage, dimensions: index.dimensions });
  const systemic = assessSystemic({ ruleResults, findings: all, overlay: index.overlay, modules: readModules });
  for (const r of ruleResults) if (systemic.provisional_rules[r.rule_id]) r.provisional_on = systemic.provisional_rules[r.rule_id];
  const coverageMeasures = assessCoverage({ ruleResults, overlay: index.overlay, applicability, registry, modules: readModules, dimensions: index.dimensions });
  /*
   * TABLES READ, per area (D-036): the tables whose rows this area actually used — its
   * extracted tables that came back usable, and every table its rule engine queried,
   * counted or aggregated (performance.requests_by_table). A schema probe alone is not a read.
   */
  const engineTables = (perf) => Object.entries(perf?.requests_by_table || {})
    .filter(([, n]) => (n.query || 0) + (n.count || 0) + (n.aggregate || 0) + (n.countBy || 0) > 0).map(([t]) => t);
  for (const m of readModules) {
    if (!scopes[m]) continue;
    const extracted = [...new Set([...moduleTables([m]), ...(rules.dependencies?.[m] || [])])]
      .filter((t) => ['complete', 'limited', 'truncated'].includes(coverage[t]?.status));
    const engine = m === 'itsm' ? engineTables(itsm?.performance) : engineTables(packRuns[m]?.performance);
    scopes[m].tables_read = [...new Set([...extracted, ...engine])].sort();
  }
  if (scopes.all) scopes.all.tables_read = [...new Set(readModules.flatMap((m) => scopes[m]?.tables_read || []))].sort();
  for (const m of readModules) {
    /* The calibrated coverage floor applies to the modules the promoted model scores (D-016). */
    const floor = promotion().modules[m] ? promoted.floor : null;
    if (scopes[m]) scopes[m].validity = moduleValidity({ module: m, summary: scopes[m], systemic, coverage: coverageMeasures, floor });
  }
  /*
   * Phase 8: overall-health/2 takes part per module validity (the coverage floor), so the
   * Overall is recomputed now that the validities exist; its previous model stays.
   */
  if (scopes.all?.score_kind === 'overall') {
    const previous = scopes.all.previous_model;
    Object.assign(scopes.all, overallScope(Object.fromEntries(MODULE_KEYS.map((m) => [m, readModules.includes(m) ? scopes[m] : null])), coverage, { weights: overallWeights }));
    if (previous) scopes.all.previous_model = previous;
  }
  if (scopes.all) scopes.all.validity = overallValidity(Object.fromEntries(readModules.map((m) => [m, scopes[m]?.validity ?? null])), scopes.all.scoring?.participants ? { participants: scopes.all.scoring.participants } : {});

  const manifest = {
    version: MANIFEST_VERSION,
    rule_pack_version: RULE_VERSION,
    /* Whether a later run can trend against this one — see `scoringComparability`. */
    comparability: { ...rules.comparability, engine: keys.cmdb ?? null },
    kind: 'scan',
    /* What this run produced results for, and what it was asked about. */
    modules: readModules,
    requested_modules: wanted,
    verified_modules: verifiedModules,
    plan,
    /* Modules whose result was computed with reads that failed: shown, and never reused. */
    degraded,
    /* What each module's result was computed from — the next change check's baseline. */
    engine_keys: Object.fromEntries(readModules.map((m) => [m, keys[m]])),
    connection_user: user,
    dependencies: rules.dependencies,
    stamps,
    spec_hashes: Object.fromEntries(Object.keys(stamps).map((t) => [t, specHash(t)])),
    meta_stamps: metaStamps,
    /* Every table the ITSM catalogue read, stamped before its first read — the ITSM module's reuse baseline. */
    itsm_stamps: itsm ? itsm.stamps : null,
    /* D-038: each custom rule's result on this scan (what the Rulebook shows as its latest). */
    custom_rules: customRun.map((c) => ({ rule_id: c.rule.rule_id, module: c.rule.module, status: c.result.status, verdict: c.result.verdict, population: c.result.population, matches: c.result.matches, share: c.result.share, scored: c.rule.scored !== false, reason: c.result.reason, ...(c.rule.own_check ? { own_check: true } : {}) })),
    /* Job HC-1: the Rulebook's changes this scan applied, for the modules it read. */
    rule_overrides: {
      switched_off: [...overrideOff].filter((id) => readModules.includes(scopeOfRule(id))).sort(),
      severity: Object.fromEntries(Object.entries(ruleOverrides.severity || {}).filter(([id]) => readModules.includes(scopeOfRule(id)))),
      reworded: Object.keys(ruleOverrides.titles || {}).filter((id) => readModules.includes(scopeOfRule(id))).sort(),
      own_checks: ownChecks.filter((c) => readModules.includes(c.module)).map((c) => c.rule_id).sort(),
    },
    /* Every table a pack's catalogue read, stamped before its first read — that module's reuse baseline (Phases 5–6). */
    itom_stamps: packRuns.itom?.stamps ?? null,
    platform_stamps: packRuns.platform?.stamps ?? null,
    enterprise_dq_stamps: packRuns.enterprise_dq?.stamps ?? null,
    csdm_stamps: packRuns.csdm?.stamps ?? null,
    itil_stamps: packRuns.itil?.stamps ?? null,
    cutoff,
    coverage,
    skipped_checks: rules.skipped,
    /*
     * CATALOGUE INVARIANTS, checked every run rather than only in CI. A rule
     * whose subject is a dead-status population but which is tagged `quality`
     * cannot fire — the tag strips the very CIs it exists to find. Three shipped
     * that way and were caught by reading them; this is so the next one is not.
     */
    catalogue_warnings: [...intentMisTags(CMDB_CATALOGUE), ...trackMisroutes(CMDB_CATALOGUE), ...trackMisroutes(CMDB_CATALOGUE, CONSUMPTION_TRACKS), ...trackMisroutes(CMDB_CATALOGUE, SCALE_TRACKS), ...trackMisroutes(CMDB_CATALOGUE, DRIFT_TRACKS)],
    /* The promoted model (displayed), and v1 beside it (D-016). */
    cmdb_quality: cmdbQualityV2 ?? cmdbQuality,
    cmdb_quality_v1: cmdbQualityV2 ? cmdbQuality : null,
    model_transition: { promotion: promoted ? 'health-quality/2' : null, decision: 'D-016', modules: modelTransition },
    /*
     * HEALTH ASSIST PHASE 1 — the parameters this run resolved with, per module:
     * every override applied (instance or runtime, with who set it), every
     * override refused and why, and the instance fingerprint the engine key saw.
     * Defaults are not listed; a key absent here ran on its SAOS default.
     */
    parameters: {
      cmdb: readModules.includes('cmdb')
        ? { applied: cmdbParameters.applied, rejected: cmdbParameters.rejected, fingerprint: cmdbParameters.fingerprint }
        : null,
    },
    /* Phase 2: the evidence behind each module's `validity`. */
    applicability,
    systemic,
    coverage_measures: coverageMeasures,
    rule_results: {
      version: RULE_RESULT_VERSION,
      modules: readModules,
      workbook_sha256: index.workbook_sha256,
      workbook_index_error: index.error,
      summary: summariseRuleResults(ruleResults),
      rules: ruleResults,
    },
    /*
     * ITSM PHASE 5 — every catalogue slot, with BOTH status layers (design-time
     * classification and this run's status / verdict), its blocker, scope,
     * confidence, observed values and parameters; the informational aggregation;
     * and what the run resolved with. Counts only — no score is derived from it.
     */
    itsm: itsm ? {
      integration_version: '5.0.0',
      catalogue_rules: itsm.normalized.rules.length,
      anchor: itsm.ctx.run.now_snow,
      windows: itsm.ctx.run.windowsUsed(),
      run: {
        elapsed_ms: itsm.run.elapsed_ms, summary: itsm.run.summary, verdicts: itsm.run.verdicts,
        cached_reads: itsm.run.cached_reads, probe_cache: itsm.ctx.probes.cacheSize(),
      },
      parameters: { ...itsm.parameters.snapshot(), runtime: itsm.runtime, rejected_overrides: itsmOptions.rejected ?? [] },
      aggregation: itsm.normalized.aggregation,
      performance: itsm.performance,
      rules: itsm.normalized.rules,
      /* This scan's readings (the next scans' history) and what this scan compared with. */
      measures: itsm.measures,
      measure_history: { used: itsm.history.used, set_aside: itsm.history.set_aside, excluded_runs: itsm.history.excluded_runs },
    } : null,
    /*
     * HEALTH ASSIST PHASES 5–6 — every slot of each workbook pack, in the ITSM row
     * shape: both status layers, blocker, scope, observed values, parameters;
     * equivalent rules with their owner's outcome; and what the run resolved with.
     */
    itom: packRuns.itom ? packManifest(packRuns.itom) : null,
    platform: packRuns.platform ? packManifest(packRuns.platform) : null,
    enterprise_dq: packRuns.enterprise_dq ? packManifest(packRuns.enterprise_dq) : null,
    csdm: packRuns.csdm ? packManifest(packRuns.csdm) : null,
    itil: packRuns.itil ? packManifest(packRuns.itil) : null,
    links,
    meta_reads: meta.cmdb?.reads ?? null,
    findings_detected: detected,
    findings_stored: findings.length,
    findings_truncated: detected > findings.length,
    root_cause_clusters: clusterByRule(findings),
    input_hash: digest(estate),
    metrics: {
      visible_cis: (estate.cmdb_ci || []).length,
      visible_relationships: (estate.cmdb_rel_ci || []).length,
      fetched_rows: fetchedRows,
      cmdb_quality_score: score,
      score_definition: cmdbQuality
        ? cmdbQuality.composite.definition
        : 'Percent of extracted CIs without a triggered CMDB rule. A Health Assist score, not ServiceNow CMDB Health.',
      /* The SPECIFIC reason, from the same function the switch uses — the old
         text named both tables whichever one had actually failed. */
      score_withheld_because: score === null ? (scopes.cmdb?.score_withheld_because ?? 'CMDB was not part of this scan.') : null,
    },
    domains: Object.entries(AGENTS).map(([agent, [domain, label]]) => ({
      agent_id: agent,
      domain,
      label,
      version: RULE_VERSION,
      findings: all.filter((f) => f.agent_id === agent).length,
    })),
    severity_counts: all.reduce((acc, f) => {
      acc[f.severity] = (acc[f.severity] || 0) + 1;
      return acc;
    }, {}),
    priority_counts: all.reduce((acc, f) => {
      acc[f.priority] = (acc[f.priority] || 0) + 1;
      return acc;
    }, {}),
    /* Per-scope summaries: the switch reads these, so every scope's numbers are
       computed once, over everything detected, and stored with the run. */
    scopes,
    llm,
    phases: { ...phases, total_ms: Date.now() - startedAt },
    analysis_duration_ms: Date.now() - startedAt,
    consistency: 'A bounded Table REST extraction pinned to one cutoff. The Table API is not a transactionally consistent cross-table snapshot.',
    narrative: `${(estate.cmdb_ci || []).length} visible CIs examined; ${detected} deterministic findings. Review table coverage and the highest-priority evidence before acting.`,
  };

  await emit('done', 100);
  return { status: partial ? 'partial' : 'completed', findings, manifest };
}

/** A pack run as the manifest keeps it (Phases 5–6). */
function packManifest(r) {
  return {
    integration_version: '1.0.0',
    catalogue_rules: r.normalized.rules.length,
    anchor: r.ctx.run.now_snow,
    windows: r.ctx.run.windowsUsed(),
    run: { elapsed_ms: r.run.elapsed_ms, summary: r.run.summary, verdicts: r.run.verdicts, cached_reads: r.run.cached_reads, probe_cache: r.ctx.probes.cacheSize() },
    parameters: { ...r.parameters.snapshot(), runtime: r.runtime, rejected_overrides: r.rejected },
    aggregation: r.normalized.aggregation,
    performance: r.performance,
    rules: r.normalized.rules,
    measures: r.measures,
    measure_history: { used: r.history.used, set_aside: r.history.set_aside, excluded_runs: r.history.excluded_runs },
  };
}

export { TABLES, RULE_VERSION, AGENTS };
/* The ITSM catalogue's configuration surface, for the routes — the health module's
   one facade over health/itsm (the routes never import the engine directly). */
export { buildParameterRegistry, describeParameters, validateRuntimeParameters } from './itsm/integration.js';
/* The ITOM pack's per-scan registry (Health Assist Phase 5), for the routes. */
export { buildItomParameterRegistry } from './itom/integration.js';
/* The Platform pack's per-scan registry (Health Assist Phase 6), for the routes. */
export const buildPlatformParameterRegistry = (overrides) => SCAN_PACKS.find((p) => p.module === 'platform').pack.buildParameterRegistry(overrides);
/* The Enterprise Data Quality pack's (Health Assist Phase 7). */
export const buildEnterpriseDqParameterRegistry = (overrides) => SCAN_PACKS.find((p) => p.module === 'enterprise_dq').pack.buildParameterRegistry(overrides);
/* The CSDM pack's (Health Assist Phase 9). */
export const buildCsdmParameterRegistry = (overrides) => SCAN_PACKS.find((p) => p.module === 'csdm').pack.buildParameterRegistry(overrides);
/* The ITIL pack's (Health Assist Phase 10). */
export const buildItilParameterRegistry = (overrides) => SCAN_PACKS.find((p) => p.module === 'itil').pack.buildParameterRegistry(overrides);
/* ITSM measure history: the routes read the stored runs, the facade shapes them (itsm/measure-history.js). */
export const itsmMeasureHistoryFrom = historyFromRuns;
