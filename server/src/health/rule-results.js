/* The engine's severity order (rules.js SEVERITY_RANK), for picking the worst reported band. */
const SEVERITY_RANK = Object.freeze({ SYSTEMIC: 6, CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, INFO: 1 });

/**
 * RULE RESULTS — one outcome per rule per run, for every module.
 * Phase 1 of docs/HEALTH-ASSIST-APPROACH.md (§4.2).
 *
 * PURE. The run's findings, skipped checks, KPI measurements and the ITSM
 * runner's normalised rows in; one row per rule out. Nothing here changes a
 * finding or a score: the rows DESCRIBE what the engine already decided, in one
 * shape, so coverage, applicability and scoring can later read one structure
 * (Phase 2 and 3) and a stored run can be re-scored under a newer model.
 *
 * ═══ WHAT A ROW CAN HONESTLY SAY, PER SOURCE ═══
 *
 *   itsm_catalogue   the runner already declares status, verdict, the population
 *                    judged, blockers and undetermined states. Carried as they are.
 *   cmdb_catalogue   the packs report findings, KPI measurements and skips. They
 *   and legacy       do not declare the population a clean result judged. So a
 *                    rule with no finding and no skip is `evaluated / pass`, and
 *                    its `verdict_basis` says `no_finding_population_undeclared`:
 *                    a pass that rests on silence, marked as such, never presented
 *                    as a judged population. Declaring populations in the packs is
 *                    later work; until then the basis keeps the claim honest.
 *
 * A skip entry does not always mean the rule did not run. Some packs log a
 * partial-scope note (e.g. "N retired CIs are outside this dimension") and still
 * evaluate the rest. So: a finding or a measurement makes a rule `evaluated`
 * whatever its skips say; with neither, a skip makes it `skipped`. This is the
 * same reading cmdb-quality.js applies to decide whether a dimension was measured.
 */

export const RULE_RESULT_VERSION = '1.0.0';
/* `equivalent` (Phase 5, D-019): the rule is another module's rule's condition, evaluated there and counted there. */
export const RESULT_STATUSES = Object.freeze(['evaluated', 'skipped', 'unavailable', 'unconfigured', 'not_configured', 'error', 'not_run', 'equivalent']);
export const VERDICTS = Object.freeze(['pass', 'fail', 'inconclusive']);
export const VERDICT_BASES = Object.freeze({
  finding: 'at least one finding was raised',
  population_judged: 'a measured population with a stated denominator',
  no_finding_population_undeclared: 'no finding and no skip; the rule does not declare the population it judged',
  itsm_runner: 'the ITSM runner\'s own verdict over its declared population',
  catalogue_runner: 'the shared rule engine\'s own verdict over its declared population (ITOM pack)',
});

const worst = (severities) => severities.reduce((w, s) => ((SEVERITY_RANK[s] ?? 0) > (SEVERITY_RANK[w] ?? 0) ? s : w), null);
const countBy = (xs) => xs.reduce((a, x) => { a[x] = (a[x] || 0) + 1; return a; }, {});

/**
 * @param {object}   args
 * @param {object[]} args.rules       the rules to report: { rule_id, module, source, base_severity? } — one per rule
 * @param {object[]} args.findings    every finding the run detected
 * @param {object[]} args.skipped     the engine's skipped checks ({ rule, table, reason })
 * @param {object[]} args.kpis        CMDB KPI measurements ({ rule_id, pass_pct, numerator, denominator, basis })
 * @param {object[]} [args.itsmRows]  the ITSM runner's normalised rule rows (manifest.itsm.rules)
 * @param {(ruleId: string) => ({ sheet: string, id: string } | null)} [args.workbookIdentity]
 * @param {Set<string>} [args.retiring]  code rules recorded for retirement (deviations register)
 */
export function buildRuleResults({ rules, findings = [], skipped = [], kpis = [], itsmRows = [], workbookIdentity = () => null, retiring = new Set() }) {
  const byRule = new Map();
  for (const f of findings) {
    if (!byRule.has(f.rule_id)) byRule.set(f.rule_id, []);
    byRule.get(f.rule_id).push(f);
  }
  const skipsByRule = new Map();
  for (const s of skipped) {
    if (!s?.rule) continue;
    if (!skipsByRule.has(s.rule)) skipsByRule.set(s.rule, []);
    skipsByRule.get(s.rule).push(s);
  }
  const kpiByRule = new Map(kpis.filter((k) => k?.rule_id).map((k) => [k.rule_id, k]));
  const itsmById = new Map(itsmRows.map((r) => [r.rule_id, r]));

  return rules.map((r) => {
    const found = byRule.get(r.rule_id) || [];
    const base = {
      rule_id: r.rule_id,
      module: r.module,
      source: r.source,
      workbook: workbookIdentity(r.rule_id),
      ...(retiring.has(r.rule_id) ? { deviation: 'retire_pending' } : {}),
      findings: { count: found.length, by_severity: countBy(found.map((f) => f.severity)) },
      severity: { base: r.base_severity ?? null, worst_reported: worst(found.map((f) => f.severity)) },
    };

    if (['itsm_catalogue', 'itom_catalogue', 'platform_catalogue', 'enterprise_dq_catalogue', 'csdm_catalogue', 'itil_catalogue'].includes(r.source)) {
      const row = itsmById.get(r.rule_id);
      const runner = r.source === 'itsm_catalogue' ? 'itsm_runner' : 'catalogue_runner';
      if (!row) return { ...base, status: 'not_run', verdict: null, verdict_basis: null, population: null, measure: null, blocker: { kind: 'not_run', reason: `the ${r.module.toUpperCase()} runner produced no row for this rule` }, undetermined: null, skip_reasons: [] };
      const kpi = row.kpis?.find((k) => k.pass_pct != null) ?? null;
      return {
        ...base,
        severity: { ...base.severity, base: row.base_severity ?? base.severity.base },
        status: RESULT_STATUSES.includes(row.status) ? row.status : 'error',
        verdict: row.status === 'evaluated' ? (row.verdict ?? 'inconclusive') : null,
        verdict_basis: row.status === 'evaluated' ? runner : null,
        ...(row.equivalent_of ? { equivalent_of: row.equivalent_of } : {}),
        population: row.population ?? null,
        measure: kpi ? { value: kpi.pass_pct, unit: '%', numerator: kpi.numerator, denominator: kpi.denominator, basis: kpi.basis } : null,
        blocker: row.blocker ?? null,
        undetermined: row.undetermined ?? null,
        engine: row.engine ?? null,
        skip_reasons: [],
      };
    }

    const skips = skipsByRule.get(r.rule_id) || [];
    const kpi = kpiByRule.get(r.rule_id) ?? null;
    const measure = kpi ? { value: kpi.pass_pct, unit: '%', numerator: kpi.numerator ?? null, denominator: kpi.denominator ?? null, basis: kpi.basis ?? null } : null;
    const skipReasons = skips.map((s) => ({ table: s.table ?? null, reason: s.reason ?? null }));
    if (found.length) {
      return { ...base, status: 'evaluated', verdict: 'fail', verdict_basis: 'finding', population: null, measure, blocker: null, undetermined: null, skip_reasons: skipReasons };
    }
    if (kpi) {
      const judged = Number(kpi.denominator) > 0;
      return {
        ...base, status: 'evaluated',
        verdict: judged ? 'pass' : 'inconclusive',
        verdict_basis: judged ? 'population_judged' : null,
        population: { total: kpi.denominator ?? null, judged: kpi.denominator ?? null, unit: null, basis: kpi.basis ?? null },
        measure, blocker: null,
        undetermined: judged ? null : { kind: 'empty_population', reason: 'the measurement had no denominator', health: 'not established' },
        skip_reasons: skipReasons,
      };
    }
    if (skips.length) {
      return { ...base, status: 'skipped', verdict: null, verdict_basis: null, population: null, measure: null, blocker: { kind: 'skipped', reason: skips[0].reason ?? null }, undetermined: null, skip_reasons: skipReasons };
    }
    return { ...base, status: 'evaluated', verdict: 'pass', verdict_basis: 'no_finding_population_undeclared', population: null, measure: null, blocker: null, undetermined: null, skip_reasons: [] };
  });
}

/** Counts for the manifest: by module, status, verdict and verdict basis. */
export function summariseRuleResults(results) {
  const out = {};
  for (const r of results) {
    const m = (out[r.module] ||= { rules: 0, status: {}, verdict: {}, verdict_basis: {} });
    m.rules += 1;
    m.status[r.status] = (m.status[r.status] || 0) + 1;
    if (r.verdict) m.verdict[r.verdict] = (m.verdict[r.verdict] || 0) + 1;
    if (r.verdict_basis) m.verdict_basis[r.verdict_basis] = (m.verdict_basis[r.verdict_basis] || 0) + 1;
  }
  return out;
}
