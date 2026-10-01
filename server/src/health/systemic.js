import { CMDB_CATALOGUE, GATING_KINDS } from './cmdb-quality.js';

/**
 * SYSTEMIC CONDITIONS AND BLOCKERS, for every module.
 * Phase 2 of docs/HEALTH-ASSIST-APPROACH.md (§5).
 *
 * PURE. The run's rule results (rule-results.js), its findings and each rule's
 * overlay entry in; per-module Systemic lists and the provisional effects of
 * blockers out. It changes no finding and no score: CMDB's trust gate keeps
 * deciding what it decided (cmdb-quality.js); this layer explains every module
 * in one vocabulary, and lets a blocker mark OTHER rules and modules.
 *
 * ═══ ROLES (a base-Systemic rule's, from its overlay) ═══
 *   blocker   invalidates what other measurements mean. It scores as a defect in
 *             its own dimension AND makes its `blocks` targets provisional.
 *   defect    a measured, severe failure that IS health: listed, and scored.
 *   posture   a missing governance mechanism: shown beside the score, not in it.
 *   derived   computed from the score itself: presentation only.
 * A correlation rule (kind `correlation`) explains other findings: `explanatory`.
 * A fired base-Systemic rule with no role yet is `unclassified`, shown as such:
 * never silently treated as an ordinary finding.
 *
 * Where an overlay has no role, the implementation's own classification is used
 * (CMDB `systemicKind`), and a rule's run-time downgrade (`systemic_kind_override`,
 * the capability it measures is absent) turns a blocker into posture, exactly as
 * the CMDB gate does. A rule can never promote itself.
 *
 * ═══ DEPENDENCIES (`blocks`, any severity) ═══
 * A rule's `blocks` (overlay: the workbook's stated dependencies and CMDB's
 * gating rules) name rules (`rule:ID`), modules (`cmdb`) or dimensions
 * (`cmdb:D7`). On a run the targets are:
 *   blocked      the blocker FAILED — the precondition is known to be broken;
 *   unverified   the blocker could not be assessed (skipped, unavailable,
 *                unconfigured, inconclusive): a precondition that was not
 *                established is not a precondition that held.
 * A blocker whose module this run did not read, or which is not built, sets
 * nothing: there is no result to reason from, and the target says so itself.
 */

export const SYSTEMIC_MODEL = 'systemic/1';
const CMDB_ROLE = Object.freeze({ config_absence: 'blocker', measured_kpi: 'blocker', posture: 'posture', derived: 'derived' });

const isSystemicBase = (b) => ['SYSTEMIC', 'Systemic'].includes(b);

/** A rule's Systemic role and where it came from, with a run-time downgrade applied. */
function roleOf(result, overlay, findings) {
  const declared = overlay?.systemic_role ?? null;
  let role = declared;
  let source = declared ? (overlay.reviewed ? 'overlay (reviewed)' : 'overlay (proposed)') : null;
  if (!role && result.source === 'cmdb_catalogue') {
    const kind = CMDB_CATALOGUE[result.rule_id]?.systemicKind;
    role = CMDB_ROLE[kind] ?? null;
    source = role ? `implementation: systemicKind "${kind}"` : null;
  }
  /* CMDB's downgrade: a finding that measures an ABSENT capability is posture, never a gate. */
  const override = findings.find((f) => f.systemic_kind_override && !GATING_KINDS.has(f.systemic_kind_override));
  if (role === 'blocker' && override) {
    return { role: 'posture', source: `${source}; downgraded at run time`, downgraded_because: override.systemic_kind_override_reason ?? override.systemic_kind_override };
  }
  return { role, source, downgraded_because: null };
}

/** Where a rule's `blocks` come from: its overlay, or CMDB's gating kinds for a code id with no sheet row (CMDB-141). */
function blocksOf(result, overlay, role) {
  if (overlay?.blocks?.length) return overlay.blocks;
  if (role === 'blocker' && result.source === 'cmdb_catalogue' && GATING_KINDS.has(CMDB_CATALOGUE[result.rule_id]?.systemicKind)) return ['cmdb'];
  return [];
}

const assessed = (r) => r.status === 'evaluated' && ['pass', 'fail'].includes(r.verdict);

/**
 * @param {object}   args
 * @param {object[]} args.ruleResults   this run's rule results
 * @param {object[]} args.findings      this run's findings
 * @param {(ruleId: string) => object|null} args.overlay  a code rule's overlay entry (modules.workbookIndex)
 * @param {string[]} args.modules       the modules this run read
 */
export function assessSystemic({ ruleResults = [], findings = [], overlay = () => null, modules = [] }) {
  const byRule = new Map();
  for (const f of findings) {
    if (!byRule.has(f.rule_id)) byRule.set(f.rule_id, []);
    byRule.get(f.rule_id).push(f);
  }
  const resultById = new Map(ruleResults.map((r) => [r.rule_id, r]));
  const perModule = Object.fromEntries(modules.map((m) => [m, { blockers: [], defects: [], posture: [], derived: [], explanatory: [], unclassified: [], escalated: [] }]));

  const effects = [];
  for (const r of ruleResults) {
    const ov = overlay(r.rule_id);
    const found = byRule.get(r.rule_id) || [];
    const { role, source, downgraded_because } = roleOf(r, ov, found);
    const entry = {
      rule_id: r.rule_id, workbook: r.workbook ?? null, module: r.module,
      findings: found.length, role, role_source: source, reviewed: Boolean(ov?.reviewed),
      ...(downgraded_because ? { downgraded_because } : {}),
    };
    const list = perModule[r.module];
    if (list && isSystemicBase(r.severity?.base) && r.verdict === 'fail') {
      if (ov?.kind === 'correlation') list.explanatory.push(entry);
      else if (role === 'blocker') list.blockers.push({ ...entry, blocks: blocksOf(r, ov, role) });
      else if (role === 'defect') list.defects.push(entry);
      else if (role === 'posture') list.posture.push(entry);
      else if (role === 'derived') list.derived.push(entry);
      else list.unclassified.push(entry);
    }
    /* Findings escalated to Systemic by their CI's context: counted in the score, shown with the chain. */
    if (list && !isSystemicBase(r.severity?.base)) {
      const up = found.filter((f) => f.severity === 'SYSTEMIC');
      if (up.length) list.escalated.push({ rule_id: r.rule_id, workbook: r.workbook ?? null, findings: up.length, base: r.severity?.base ?? null });
    }

    /* Dependencies: any rule, any severity. */
    const targets = blocksOf(r, ov, role);
    if (!targets.length) continue;
    const state = r.verdict === 'fail' ? 'blocked' : assessed(r) ? null : 'unverified';
    if (!state) continue;
    effects.push({
      blocker: r.rule_id, workbook: r.workbook ?? null, module: r.module, state,
      blocker_status: r.status, blocker_verdict: r.verdict,
      reason: state === 'blocked'
        ? `${r.rule_id} failed${r.workbook?.id && r.workbook.id !== r.rule_id ? ` (${r.workbook.id})` : ''}`
        : `${r.rule_id} could not be assessed (${r.status}${r.verdict ? ` / ${r.verdict}` : ''}${r.blocker?.reason ? `: ${r.blocker.reason}` : ''})`,
      targets,
    });
  }

  /* Resolve the effects onto what they reach in THIS run. */
  const provisionalRules = {};
  const provisionalModules = {};
  const workbookToCode = new Map(ruleResults.filter((r) => r.workbook?.id).map((r) => [r.workbook.id, r.rule_id]));
  for (const e of effects) {
    for (const t of e.targets) {
      const [head, tail] = String(t).split(':');
      const mark = { blocker: e.blocker, state: e.state, reason: e.reason };
      if (head === 'rule') {
        const code = resultById.has(tail) ? tail : workbookToCode.get(tail);
        if (code && resultById.has(code)) (provisionalRules[code] ||= []).push(mark);
      } else if (modules.includes(head)) {
        (provisionalModules[head] ||= []).push({ ...mark, scope: tail ? `${head}:${tail}` : head });
      }
    }
  }
  return { model: SYSTEMIC_MODEL, modules: perModule, effects, provisional_rules: provisionalRules, provisional_modules: provisionalModules };
}
