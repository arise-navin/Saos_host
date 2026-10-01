# `health/rules/workbook/` — the SAOS rule workbook as the source of truth

This folder is Phase 0 of [docs/HEALTH-ASSIST-APPROACH.md](../../../../../docs/HEALTH-ASSIST-APPROACH.md). The master workbook `SAOS_Health_Rules_Tracker_v2_9574.xlsx` defines **what** Health Assist measures, and this folder is its transcription into code. Next to it sit the engineering decisions the workbook does not carry, and a register of every place the code still differs from the workbook.

The folder is outside the engine hash (`incremental.js` hashes `health/*.js` engine files and `health/catalogue/*.json` only), so adding it moved no module's engine key.

**Phase 1 (done) reads it in three places:**
- `health/modules.js`, the module registry, via `health/workbook.js`. It supplies workbook profiles, build coverage, each rule's workbook identity and the retirement list.
- `health/parameter-registry.js`, which reads `params/cmdb-packs.json`: the declarations for the 168 CMDB pack parameters.
- `health/rule-results.js`, through the registry's workbook index. It labels each rule outcome with its workbook identity.

A scan that cannot read the transcription carries on, and its `rule_results.workbook_index_error` says why.

**Phase 2 (done)** adds four modules. Each run manifest gains `applicability`, `systemic`, `coverage_measures`, and a `validity` block on every scope. The additions are additive: no existing field changes meaning, and a score is never hidden.
- `health/applicability.js`: deterministic probes that decide whether each product is in use, recording their evidence.
- `health/systemic.js`: Systemic roles (blocker / defect / posture / derived, plus explanatory and unclassified) and blocker effects (blocked / unverified).
- `health/coverage-measures.js`: coverage of rules built, rules applicable and rules assessed.
- `health/validity.js`: the validity labels.

`GET /api/health/runs/:runId/assessment` returns all of it.

## Files

| File | Kind | What it is |
|---|---|---|
| `source.json` | generated | Workbook file name, sha256, sheets and rule counts |
| `schema.json` | generated | The Schema sheet: articulation fields, severity bands and weights, modifiers, worked examples |
| `sheets/<sheet>.json` | generated | Every rule row, verbatim: `cmdb`, `itsm`, `itom`, `platform`, `data-quality` (both models, with parsed dimension weights), `csdm` (placeholder) |
| `traceability.json` | generated | Rule id → sheet and Excel row |
| `import-report.json` | generated | What changed against the previous import |
| `profiles.json` | **hand-maintained** | Modules, dimensions, workbook group → dimension, weight status (`workbook` or `undefined_in_workbook`) |
| `overlays/<sheet>.json` | **hand-maintained**, seeded | Per rule: module, dimension, kind, attainment, systemic role, blocks, applicability, ownership, equivalence, implementation state. `proposed` names the basis of each auto-proposed value; `reviewed: true` locks an entry. |
| `params/<sheet>.json` | seeded | Per rule: the workbook threshold text and declaration status |
| `params/cmdb-packs.json` | **hand-maintained**, seeded | Phase 1: the CMDB pack parameters (168 keys, 15 scopes) with type, unit, bounds, class, overridability and the rules each tunes. The default value lives in code; `default` here is a snapshot the suite compares with it. Re-seed with `node scripts/health-cmdb-parameters.mjs`. |
| `ownership.json` | **hand-maintained** | One owner per condition that several sheets restate (decision D-003). Proposals, for review. |
| `dependencies.json` | **hand-maintained** | Phase 2: the 15 measurement dependencies the workbook itself states ("Precondition for", "Blocks", "depends on", "guard on", "Gated by", "Requires … to interpret"). Each entry quotes its workbook text, and the suite checks the quote is present. Seeds the overlays' `blocks`. |
| `legacy-map.json` | **hand-maintained** | The 43 hard-coded rules in `rules.js` against their workbook counterparts: relation, differences, disposition, phase |
| `decisions.json` | **hand-maintained** | The decisions everything else refers to (D-001 … D-011) |
| `deviations.json` | generated | Code vs workbook: implementation-only rules, CMDB wording differences, ITSM field differences, legacy rules, build coverage |
| `status-export.json` / `.csv` | generated | Implementation and Validation status per workbook rule, claimed only from evidence in the repo. Ready to paste into the workbook's tracking columns. |

## Workflow

Run these from `server/`:

```bash
# 1. The workbook changed: re-transcribe (refuses on any structural surprise)
node scripts/import-health-workbook.mjs "C:/Users/<you>/Downloads/SAOS_Health_Rules_Tracker_v2_9574.xlsx"

# 2. Seed overlay/param entries for new rules; reviewed entries are never touched
node scripts/health-workbook-overlays.mjs            # add --refresh-proposals to re-derive unreviewed proposals

# 3. Regenerate the deviations register and status export
node scripts/health-workbook-audit.mjs

# 4. Validate
node --test test/health-workbook.test.js
```

`test/health-workbook.test.js` fails in any of these cases:
- an overlay or param file is stale against the imported workbook;
- a workbook group maps to no dimension;
- an overlay value has no stated basis;
- the deviations register or status export differs from what the audit produces now;
- anything under `src/` imports this folder before Phase 1 wires it.

## Current state (Phase 0)

| Module | Workbook rules | Built |
|---|---|---|
| CMDB (CMDB sheet) | 138 | 138 |
| CMDB (data-quality sheet, CMDB Quality model D1–D10) | 83 | 83, via the CMDB rules. CMDB-140 ≡ DQ-003 and CMDB-141 ≡ DQ-077 |
| ITSM | 139 | 139 configured (identical to the implemented catalogue, field for field) |
| ITOM | 156 | 153 configured on the shared engine (Phase 5): 45 run, 108 deferred with a named reason. 3 not built. The 18 hard-coded rules are unscored drill-down views |
| Platform | 183 | 152 configured on the shared engine (Phase 6): 74 run, 78 deferred with a named reason. 31 not built. The hard-coded rules are unscored drill-down views |
| Enterprise Data Quality (Q1–Q7) | 56 | 54 configured on the shared engine (Phase 7, D-026): 31 run (30 executable, DQ-131 ≡ ITSM-139), 23 deferred with a named reason. 2 not built |
| CSDM (D-029; in the workbook since D-031) | 80 | 73 configured on the shared engine (Phase 9): 53 run (41 executable, 12 equivalents), 20 deferred with a named reason. 7 not built |

**Applied in Phase 4:** CMDB-139, CMDB-142 and CMDB-143 are retired (D-009): they no longer run as findings, KPIs or gates. The v3 "principal classes" fallbacks are **kept** and proposed for ratification (D-017); when one is used, the run records `measures.principal_fallback` and the affected dimensions carry a caveat. CMDB-141 (≡ DQ-077) now defaults to the workbook's 70% (D-015).
