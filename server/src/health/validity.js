/**
 * VALIDITY — can a module's number be quoted, and if not, why not?
 * Phase 2 of docs/HEALTH-ASSIST-APPROACH.md (§5, §7); decisions D-006 and D-008.
 *
 * PURE and ADDITIVE. It reads a module's stored summary, the run's Systemic
 * effects and its coverage measures, and returns a `validity` block that sits
 * BESIDE the existing fields: no score, gate or assessment field the page reads
 * changes meaning. The number is never hidden: `score` is the module's score as
 * it stands; the state and label say how far it can be relied on.
 *
 *   assessed                 nothing undermines it
 *   provisional_blocked      a blocker FAILED (its precondition is known to be broken)
 *   provisional_unverified   a blocker could not be assessed (its precondition was
 *                            not established)
 *   withheld                 the module has no number on this run, with the reason
 *   not_scored               the module has no score model yet (Platform today)
 *
 *   insufficient_coverage    fewer applicable rules were assessed than the calibrated
 *                            floor (Phase 3: F2 = 0.4 of applicable severity weight):
 *                            the number describes too little of the module to rely on
 *
 * THE COVERAGE FLOOR is calibrated (Phase 3, F2) and applies to modules scored by
 * the promoted model (health-quality/2: CMDB and ITSM, decision D-016). A module
 * still on its previous model gets no floor until its own phase; its coverage is
 * reported and `coverage_floor` says why no state depends on it.
 */

export const VALIDITY_MODEL = 'validity/1';

const LABEL = Object.freeze({
  assessed: 'Assessed',
  provisional_blocked: 'Provisional — blocked',
  provisional_unverified: 'Provisional — a precondition was not verified',
  insufficient_coverage: 'Insufficient coverage',
  withheld: 'Score withheld',
  not_scored: 'Not scored',
});
const RANK = Object.freeze({ assessed: 0, provisional_unverified: 1, provisional_blocked: 2, insufficient_coverage: 3, withheld: 4, not_scored: -1 });
const NO_FLOOR = Object.freeze({ value: null, status: 'not_applied', note: 'This module is still on its previous model; the calibrated floor applies from its own phase (D-016).' });
const floorOf = (floor) => (floor == null ? NO_FLOOR : { value: floor, status: 'calibrated', note: 'Phase 3 calibration (F2): below this share of applicable severity weight assessed, the number describes too little of the module to rely on.' });

/**
 * @param {object} args
 * @param {string} args.module
 * @param {object} args.summary       the module's scope summary (manifest.scopes[m])
 * @param {object} args.systemic      assessSystemic() output
 * @param {object} args.coverage      assessCoverage() output
 */
export function moduleValidity({ module, summary, systemic, coverage, floor = null }) {
  const marks = systemic?.provisional_modules?.[module] || [];
  const blocked = marks.filter((x) => x.state === 'blocked');
  const unverified = marks.filter((x) => x.state === 'unverified');
  const lists = systemic?.modules?.[module] || {};
  const cov = coverage?.modules?.[module] ?? null;

  let state;
  if (summary?.score_kind === 'none') state = 'not_scored';
  else if (summary?.score == null) state = 'withheld';
  else if (floor != null && cov?.assessment?.share != null && cov.assessment.share < floor) state = 'insufficient_coverage';
  else if (blocked.length) state = 'provisional_blocked';
  else if (unverified.length) state = 'provisional_unverified';
  else state = 'assessed';

  const reasons = [];
  if (state === 'withheld') reasons.push(summary?.score_withheld_because || 'No score on this run.');
  if (state === 'not_scored') reasons.push(summary?.score_withheld_because || 'This module has no score model yet.');
  if (state === 'insufficient_coverage') reasons.push(`Only ${Math.round(cov.assessment.share * 100)}% of the applicable rule weight was assessed on this run (floor ${Math.round(floor * 100)}%): the number describes too little of the module to rely on.`);
  for (const b of blocked) reasons.push(`Blocked: ${b.reason}${b.scope !== module ? ` (affects ${b.scope})` : ''}`);
  for (const u of unverified) reasons.push(`Not verified: ${u.reason}${u.scope !== module ? ` (affects ${u.scope})` : ''}`);

  return {
    model: VALIDITY_MODEL,
    state,
    label: LABEL[state],
    score: summary?.score ?? null,
    reasons,
    blocked_by: blocked,
    unverified_by: unverified,
    systemic: {
      blockers: (lists.blockers || []).length,
      defects: (lists.defects || []).length,
      posture: (lists.posture || []).length,
      escalated: (lists.escalated || []).length,
      explanatory: (lists.explanatory || []).length,
      unclassified: (lists.unclassified || []).length,
    },
    coverage: cov ? { build: cov.build?.share ?? null, assessment: cov.assessment?.share ?? null, on_silence: cov.assessment?.on_silence_share ?? null } : null,
    coverage_floor: floorOf(floor),
  };
}

/**
 * The Overall's validity: the worst state among the SCORED modules it covers,
 * with every module's blockers named. A module that is not scored cannot make the
 * Overall provisional, but its blockers are still listed.
 *
 * Phase 8 (overall-health/2): with `participants`, the worst state among the modules
 * TAKING PART — a module left out (below the coverage floor, withheld) cannot make
 * the Overall's number less reliable; it is listed under `excluded`.
 */
export function overallValidity(validities = {}, { participants = null } = {}) {
  const entries = Object.entries(validities).filter(([, v]) => v);
  const scored = entries.filter(([k, v]) => v.state !== 'not_scored' && (!participants || participants.includes(k)));
  const worst = scored.reduce((w, [, v]) => (RANK[v.state] > RANK[w] ? v.state : w), 'assessed');
  const state = scored.length ? worst : 'not_scored';
  return {
    model: VALIDITY_MODEL,
    state,
    label: LABEL[state],
    modules: Object.fromEntries(entries.map(([k, v]) => [k, v.state])),
    ...(participants ? { participants: [...participants], excluded: entries.map(([k]) => k).filter((k) => !participants.includes(k)) } : {}),
    reasons: entries.flatMap(([k, v]) => (v.state === 'assessed' ? [] : v.reasons.map((r) => `${k.toUpperCase()}: ${r}`))),
  };
}
