# Health Assist — Final Approach

**Status:** agreed approach, before implementation. This document supersedes the open questions in [HEALTH-ASSIST-ARCHITECTURE-PROPOSAL.md](HEALTH-ASSIST-ARCHITECTURE-PROPOSAL.md), whose Part A gap analysis still applies.

**Source of truth:** `C:\Users\AgamyaTanwar\Downloads\SAOS_Health_Rules_Tracker_v2_9574.xlsx`. It has 7 sheets: Schema, CMDB 138, ITSM 139, CSDM 80 (added 25 Sep 2026 from the CSDM KPI Articulation, D-031), ITOM 156, Platform 183, Data quality 139. It was verified cell for cell against the copy analysed earlier, and the content is identical.

---

## 1. Principles

1. **The workbook defines what is measured.** Code implements it, never redefines it. Any deviation is recorded and resolved, never silent.
2. **One framework, several scoring methods.** Every module shares how rules are defined, configured, executed, covered, classified, escalated, blocked and exposed. Each module scores with the method its rules justify. Accuracy comes before uniformity.
3. **A score always describes what was actually measured.** It says how much that was and whether anything undermines it. The number is always shown, with its validity next to it.
4. **Absence of evidence is never a failure,** and nothing judged is never health.
5. **No number is a default until it has been validated.** Weights, tiers, curves and floors start as *provisional, "not reviewed", configurable* assumptions. They become defaults only after scenario and sensitivity testing.

---

## 2. Modules

| Module | Workbook sheet | Rules | Status today |
|---|---|---|---|
| CMDB | CMDB (+ data quality D1–D10 mapping and weights) | 138 | Built (plus 5 extensions, see §3.3) |
| ITSM | ITSM | 139 | Built on engines; 33 unavailable, ~30 unconfigured |
| ITOM | ITOM | 156 | **Built on the shared engine (Phase 5).** Every rule has a recorded state: 45 run (32 executable, 11 once a threshold is set, 2 equivalent to CMDB rules), 108 deferred with a named reason, 3 not built. The 18 legacy rules remain as unscored drill-down views. |
| Platform | platform | 183 | **Built on the shared engine (Phase 6).** 152 configured (74 run, 78 deferred with a named reason), 31 not built; script and design rules judge customer-authored records only (D-024). Legacy rules remain as unscored drill-down views. |
| **Enterprise Data Quality** (new, own module) | data quality, model "Enterprise Data Quality" Q1–Q7 | 56 | **Built on the shared engine (Phase 7).** 54 configured (31 run, 23 deferred with a named reason), 2 not built; scored with the workbook's own Q1–Q7 weights (D-026). Fields the platform lacks are recorded as undefined, never substituted. |
| CSDM | CSDM | 80 | **Built on the shared engine (Phase 9, D-029).** Supplied as the CSDM KPI Articulation (kept verbatim in `rules/workbook/supplements/`) and written into the workbook's CSDM sheet like every rule sheet (D-031). Checks another module already makes stay there only (D-030). 73 configured (53 run: 41 executable, 12 equivalents; 20 deferred with a named reason), 7 not built. Values the rules left open come from ServiceNow's documentation and the instance's own configuration (D-032); CSDM-072 reports the ServiceNow maturity stage. The catalogue's gates (CSDM-032 lifecycle, CSDM-050 environment, CSDM-062 offerings, CSDM-026 over CSDM-017) are encoded in the rules. |

---

## 3. Source of truth and catalogues

### 3.1 From workbook to code

```
SAOS_Health_Rules_Tracker_v2_9574.xlsx
   │  scripts/health-import-workbook.mjs   (build-time; no spreadsheet library at runtime)
   ▼
server/src/health/catalogue/<module>.json        workbook fields, verbatim, pinned by workbook sha256
server/src/health/catalogue/<module>.overlay.json engineering fields (hand-maintained, reviewed JSON)  ← decision 7
server/src/health/catalogue/<module>.params.json typed parameter declarations derived from "Threshold / Parameter"
   ▼
catalogue loader (boot-time validation)  →  one unified rule registry
```

- The **importer** copies the Schema sheet's 16 fields verbatim and records the workbook's sha256. It also emits a **diff report** whenever the workbook changes: rules added, removed or reworded, severity changes and threshold changes.
- The **overlay** holds what the workbook does not:
  - `dimension` (the workbook Group, mapped to a profile dimension)
  - `kind`
  - `attainment`
  - `systemic_role`
  - `blocks`
  - `applicability`
  - `engine` + `config`
  - `owner` / `references`
  - `defect_family`
  - `remediation`
- The **loader** refuses to start if any of these hold:
  - a rule is missing an overlay entry;
  - an overlay entry has no rule;
  - a Systemic rule has no `systemic_role`;
  - a parameter is referenced but not declared;
  - a dimension is not in the module profile;
  - the workbook sha differs from the pinned one without a regenerated catalogue.

### 3.2 Workbook status columns

Implementation Status and Validation Status in the workbook are stale ("Not Started" everywhere). The build will **generate a status export** (built / tested / validated per rule) so the tracker can be updated from facts, not by hand.

### 3.3 Deviations register (code vs workbook)

Because the workbook is authoritative, every place where the code differs from it is listed in `catalogue/deviations.json` and must be resolved one of two ways: **conform** (the code changes) or **ratify** (SAOS adds it to the workbook).

| Deviation | Treatment until resolved |
|---|---|
| CMDB-139, 142, 143: implemented but not in the workbook | **Retired in Phase 4** (D-009). CMDB-140 and CMDB-141 are the workbook's DQ-003 and DQ-077 and are kept (D-010); CMDB-141 defaults to the workbook's 70% (D-015). |
| 16 CMDB thresholds and 4 detection texts extended in code (the "principal classes" fallback, confirmed defaults) | Proposed for ratification (D-017, D-018). The fallback is kept: without it 14 rules would skip on every estate with no principal classes. When used, it is recorded (`measures.principal_fallback`) and caveats the affected dimensions. |
| 9 legacy CMDB rules (CMDB-OWNER, CMDB-STALE, CMDB-DUPLICATE …) | Retired from scoring. Kept only as drill-down views under their workbook owner rules. |
| 11 legacy ITSM rules (per-record versions of workbook rate rules) | Same as above. |
| 18 legacy ITOM and 7 legacy Platform rules (thresholds, severities and conditions differ from the workbook) | Replaced by their workbook rules as those are built. Until then they stay **unscored** and labelled "interim". |

---

## 4. The shared framework

### 4.1 Rule contract

Every rule is **workbook fields + overlay fields**, the same shape in every module. Routing, scoring, dimensions, remediation lane and classification (Finding Dimensions) all read the contract. Nothing infers them from ID prefixes or domains any more.

### 4.2 `RuleResult`: one outcome per rule per run

```
status      evaluated | not_applicable | unconfigured | unavailable | skipped | error
verdict     pass | fail | inconclusive
population  { total, judged, unit, basis }       empty population ⇒ inconclusive, never pass
measure     { value, unit, threshold, direction }
attainment  0..1 | null
severity    { base, effective, deduction, modifiers }
systemic    { role, blocks[] } | null
findings    [...]                                (finding shape and fingerprints unchanged)
blocker     { kind, reason, step } | null
parameters  { key: { value, source } }
confidence  { value, basis }                     formula per the workbook Schema
applicability { state, probe }                   see §6
```

A pass is recorded, never inferred. Coverage, applicability, scoring, trends and re-scoring all read `RuleResult`s, and they are stored on every run.

### 4.3 Parameter registry (all modules; CMDB becomes configurable)

This generalises the ITSM registry:

- **Types:** number, percent, duration+unit, string, list, boolean, cidr-list, class-list, regex.
- **Precedence:** workbook default → **instance override** (persisted per instance) → **runtime override** (per run, recorded, never becomes the baseline).
- **No default in the workbook means UNCONFIGURED.** The rule does not run and says which key it needs. Nothing is guessed.
- **Three classes, versioned differently:**
  - *rule thresholds* (engine key → re-read);
  - *estate facts* (production CIDRs, VIP ranges, rotation policy, market; empty = "not evaluated", **no customer-specific defaults**; engine key);
  - *scoring-model constants* (weights, blends, curves, floors, tiers; scoring key → new trend series; an overridden value marks the model "customised").
- CMDB's ~200 hard-coded pack defaults become declarations. The ITSM parameter screen becomes one Health Assist settings screen with a tab per module.

### 4.4 Execution

- **The shared engines** (the ten ITSM engines, made module-agnostic) are the default executor. **Code packs** are allowed per rule where logic is genuinely algorithmic; CMDB's packs stay, returning `RuleResult`.
- **New engines:**
  - `script_analysis` parses script bodies rather than regex-matching them, as the PLT-034 guard requires;
  - `schedule_interval` checks "beyond its own interval × tolerance";
  - `trend` requires N comparable observations, then computes slope and projection.
- **Runner gate order:** applicability → dependencies → objects/tables → fields → parameters → instance values → engine. An engine error is `error`: it never passes and never stops the run.
- **Extraction stays allow-listed.** Each module declares the tables it needs.

### 4.5 Module registry

One JSON registry declares for each module:

- its key and label;
- catalogue files;
- tables;
- applicability probes;
- scoring profile (method, dimensions, weights, blends, attainment curves);
- overall participation.

It replaces `SCOPES`, `RULE_PREFIXES`, `RULE_SCOPE`, `AGENTS` domains and `ITOM_CHECKS`. Adding a module (e.g. CSDM) means adding a catalogue, an overlay, parameters and a registry entry, with no code change beyond any new engine it needs.

### 4.6 One condition, one owner (decision 3)

Each condition that appears in more than one sheet has one **owner** rule, chosen by domain:

- data → CMDB / Enterprise DQ;
- mechanism → ITOM;
- platform configuration → Platform;
- process → ITSM.

The owner's severity applies. The other rules become **references**: they show the owner's result in context, are **scored only in the owner module**, and are **counted once** in Overall. The ownership table lives in the overlays and is listed for review.

### 4.7 Severity (all modules)

- `effective = clamp(base + escalators − de-escalators, Low, Systemic)`, exactly as the Schema defines it, for every module.
- The signals library becomes module-agnostic (business-critical, production, shared infrastructure, retiring, duration > 30 days, recurred, control, class defect rate). Non-record rules resolve their subject (range → CIs → services; job → tables) so that modifiers can apply to them, as the Schema's ITOM-017 example requires.
- Population modifiers move only the reporting band, never the charge.

---

## 5. Systemic and blocking conditions (all modules)

Each Systemic rule declares one role in its overlay. At run time it may **downgrade** with a stated reason (e.g. "the measured capability is absent, so this is posture"). It can never promote itself.

| Role | Meaning | Scoring | Presentation |
|---|---|---|---|
| **blocker** | Invalidates what other measurements mean | Scores as a defect in its own dimension, **and** marks every module or dimension in `blocks[]` as *provisional — blocked by X*. Can cross modules (e.g. ITOM-002 → CMDB freshness and relationships). | Blocker banner on every affected module: rule, evidence, what it undermines |
| **defect** | A measured, severe failure that *is* health | Scores at full Systemic weight. It is never excluded from the score, which is what ITSM does today. | Systemic panel, separate from ordinary findings |
| **posture** | A missing governance mechanism: a risk, not a measured failure | Not in the score | Posture panel beside the score |
| **derived** | Computed from the score itself | None | Presentation only |

Findings escalated to Systemic by context are `defect`s, shown with their escalation chain.

**The score is never hidden.** Every module and the Overall show a number plus a **validity**:

- `assessed`
- `provisional · blocked (n)`
- `provisional · coverage (x%)`
- `insufficient coverage`: shown greyed, excluded from Overall
- `not scanned`

---

## 6. Applicability (decision 5)

A product or capability that the evidence *reliably* shows is not used is **excluded from the denominator**. It is never turned into a failure. Detection is deterministic and recorded.

- **Probes are declared per module and dimension** in the registry. Examples: Discovery, Service Mapping, Event Management, Cloud Discovery, Cloud Provisioning; for Platform, flows vs legacy workflow and the credential vault; for DQ Q7, the market.
- Each probe reads named tables or plugins with fixed criteria and returns one of three states, **stored as evidence on the run** (probe id and version, what it read, the values it saw, the rule it applied, the timestamp):

| State | Condition | Effect |
|---|---|---|
| `in_use` | positive evidence (plugin active **and** usage records, e.g. schedules, runs, connectors, sources) | rules apply |
| `not_in_use` | **reliable** negative evidence: the plugin is inactive/absent, **or** every usage table was read completely and is empty, with no dependent evidence elsewhere (no discovery sources on CIs, no cloud account identifiers …) | dimension excluded from the denominator and disclosed as "not applicable — evidence: …" |
| `unknown` | reads failed, partial, or conflicting | **not excluded, not failed:** counted as an assessment-coverage gap, with the reason |

- Conflicting evidence is not "not in use". For example: no MID server, but CIs carry Discovery as their source. That is `in_use` with a broken mechanism, which the workbook rules then judge.
- Workbook rules that explicitly detect a *needed but missing* product stay normal rules. Examples: ITOM-085 (monitoring tool with no connector) and ITOM-120 (cloud account with no service account). Their own evidence is what makes them fire, not the absence alone.

---

## 7. Coverage (three measures, never inside the score)

| Measure | Definition |
|---|---|
| **Build coverage** | rules implemented ÷ rules in the workbook (per module and dimension) |
| **Applicability** | the dimensions and rules in scope on this instance, with probe evidence |
| **Assessment coverage** | Σ base weight of *evaluated* applicable built rules ÷ Σ base weight of applicable built rules **that the score uses**. Correlation, trend and context rules, and rules of an unscored dimension, are listed apart (D-020). |

A module takes part in Overall only when its assessment coverage reaches a **minimum-coverage floor**. The floor is a scoring-model parameter set through calibration (§10). This is how Platform, ITOM and Enterprise DQ **switch on automatically** as their rules are built. No module is permanently "unscored".

---

## 8. Scoring methods and module profiles

### 8.1 The methods

The method is chosen per dimension by what its rules ask.

**Method R — population health** ("what share of the maintained population is in good condition?"):

```
record_score(r) = max(0, 100 − Σ w(deduction band) over distinct charges on r)
R(d) = Σ c(r)·record_score(r) ÷ Σ c(r)          c(r) = consequence weight (candidate; §10)
```

**Method C — control attainment** ("how much of what should be working is working, weighted by how bad each failure is?"):

```
C(d) = 100 × max(0, 1 − Σ w(effective)·(1 − a_r) ÷ Σ w(base))   over evaluated, applicable, scorable rules
```

**Attainment `a_r`** is derived from the workbook threshold form:

- **binary:** "any occurrence" / "absence";
- **good_share:** `min(1, measured ÷ target)`;
- **bad_rate:** `min(1, (1 − measured) ÷ (1 − limit))`;
- **none:** trend, correlation and context rules are not scored, unless Systemic.

The exact curve shape is a candidate, to be validated in calibration.

**Blend** for mixed dimensions: `β·R(d) + (1 − β)·C(d)`, with β as a scoring-model parameter.

**Module score:** `Σ W_d·S(d) ÷ Σ W_d` over measured, applicable dimensions.

Severity weights 100/40/15/5/1 come **from the workbook** and are fixed by it.

### 8.2 Module profiles

| Module | Dimensions (from workbook groups) | Method | Weight source |
|---|---|---|---|
| CMDB | D1–D10 | R, blended with C for KPI rules | **Workbook** (12/12/14/12/8/16/10/6/6/4) |
| Enterprise DQ | Q1–Q7 | R | **Workbook** (18/15/15/12/12/18/10) |
| ITSM | Incident (1A–1D), Problem (2A–2C), Change (3A–3D), Cross-process | C; record-predicate rules enter as graded rates | Not in workbook → **provisional equal, "not reviewed", configurable** |
| ITOM | Discovery (1A–1D), MID Server, Service Mapping, Event Management (4A–4C), Cloud (5A–5B); cross-domain ITOM = correlation, not scored | C | Not in workbook → provisional equal, "not reviewed" |
| Platform | SLA engineering, Server-side logic, Client & form logic, Automation, Jobs & events, Access & security, Integrations, Customisation & upgrade debt, Performance | C | Not in workbook → provisional equal, "not reviewed" |

- Provisional weights are shown in the UI and API as **"Weights not reviewed by SAOS"** until replaced. Providing them in the workbook or in configuration moves the scoring key.
- Correlation rules (ITOM-147…156, ITSM cross-process correlations) explain *why* other findings exist. They feed root-cause clustering and cross-domain links, and are not scored, so a consequence is never counted twice.

---

## 9. Overall score (decision 6)

- **The Overall is a configurable model** (`overall-health/2`), selected only after scenario testing. Its hard requirement: **a materially unhealthy module must never be hidden**, neither in the number nor in the word.
- Every **candidate aggregation** is implemented behind one interface and evaluated in the calibration harness (§10):

| Candidate | Form |
|---|---|
| Weighted mean | `Σ W_m·S_m ÷ Σ W_m` |
| Weighted mean + weakest-area band cap | mean for the number; the band can be no more than *k* bands better than the worst module |
| Penalised mean | mean minus a penalty per module below a "materially unhealthy" level |
| Generalised (power) mean | `(Σ W_m·S_m^p ÷ Σ W_m)^(1/p)`, p < 1, which weights low scores more |
| Min-blend | `λ·mean + (1 − λ)·min` |

- **Fixed regardless of the aggregation chosen:**
  - participation needs *scanned + applicable + minimum coverage*;
  - a missing module is renormalised away, never scored 0 or 100;
  - validity = the worst participating validity, and cross-module blockers propagate;
  - each condition is counted once (owners);
  - coverage is shown beside the number, never inside it;
  - attribution names the weakest module;
  - module weights W_m are provisional and "not reviewed" until SAOS sets them.

---

## 10. Calibration and validation (decision 8)

**No weight, tier, curve, blend or floor becomes a default until it passes this process.**

**Scenario library** (fixtures plus recorded PDI runs):
- healthy estate;
- a single failing module;
- a single Systemic blocker;
- thin coverage;
- product not in use;
- a large clean endpoint tail with a defective core;
- mass low-severity noise;
- a duplicated condition across modules;
- escalation-driven failures;
- recovery after remediation.

Each scenario states the **expected qualitative outcome**, e.g. "Overall must not read Healthy", "ITOM must not drop when Event Management is not used".

**Acceptance properties**, tested automatically for every candidate model:
1. **Monotonicity:** fixing a defect never lowers any score; adding one never raises it.
2. **Severity ordering:** a Systemic failure moves the score more than a Critical one, which moves it more than a High one, and so on.
3. **No masking:** a module under the "materially unhealthy" level is visible in the Overall number *and* band.
4. **Dilution resistance:** adding clean low-consequence records does not materially lift a defective core.
5. **Authoring invariance:** splitting one rule into two identical halves does not change the score materially.
6. **Coverage honesty:** unevaluated rules never raise a score.
7. **Applicability neutrality:** excluding a reliably-not-used product neither rewards nor penalises the module.
8. **Stability:** small parameter changes produce proportionate score changes.

**Sensitivity analysis:** each candidate parameter is swept across its range. For each sweep the harness reports score deltas, band changes and the stability of rank order across scenarios. Parameters with outsized, unexplained influence are redesigned, not tuned.

**Output:** a versioned calibration report per model: parameters, scenario results, property results, and sensitivity charts. A model version ships only with a passing report. Its parameter values then become the SAOS defaults, still overridable and still versioned.

---

## 11. Versioning and history

| Key | Covers | On change |
|---|---|---|
| **Engine key** (per module) | engine/code versions, catalogue sha, rule thresholds, estate facts, accepted risks | module re-read |
| **Scoring key** (per module) | method, profile, weights, blends, curves, tiers, floor, severity weights, implemented rule set | new trend series |
| **Overall key** | aggregation model and its parameters, module weights, participation rules, module scoring keys | new overall series |

- **`RuleResult`s are stored on every run.** Scoring is pure, so stored runs can be **re-scored** under a newer model whenever their inputs are sufficient. The trend shows them labelled "re-scored under <model>".
- Runs from before `RuleResult` existed keep their original series, and the chart shows the break.
- **Dual publication** covers the first runs after a model change: the old and new scores are shown side by side, so a shift caused by the method is not mistaken for a change in the estate.
- A building rule widens coverage under the same scoring key. A rule changing *how it scores* moves the key.

---

## 12. Delivery phases

Each phase is shippable and gated by its tests.

| # | Phase | Delivers | Gate |
|---|---|---|---|
| 0 | **Source of truth** | Workbook importer, catalogue JSON for all 5 modules, overlay skeletons, parameter declarations, deviations register, status export | Loader validation passes; the importer diff is clean against the pinned sha |
| 1 | **Framework core** | `RuleResult` everywhere, module registry, generalised parameter registry (CMDB configurable) with settings UI, ownership table | Existing scores unchanged; conformance test green |
| 2 | **Systemic, applicability and coverage** | `systemic_role` on all Systemic rules, blocker propagation, validity labels, applicability probes with evidence, three coverage measures | Scenario tests for blockers and applicability |
| 3 | **Scoring kernel + calibration harness** | Methods R/C, attainment curves, candidate overall models, scenario library, property tests, sensitivity reports | Calibration report produced; **no model promoted yet** |
| 4 | **CMDB and ITSM on the new models** ✅ | `cmdb-quality/2` and `itsm-quality/2` from `scoring/promotion.json` (D-016); legacy ITSM rules out of scoring; CMDB-139/142/143 retired; calibrated coverage floor on promoted modules; previous model published beside the new one (`previous_model`, `cmdb_quality_v1`, `model_transition`) | Calibration report passes; new scoring keys; `health-phase4.test.js` |
| 5 | **ITOM** ✅ (5A–5E) | 156 workbook rules as a catalogue pack on the shared engine (`health/itom/`, D-021); `itom-quality/2` with `itom-checks/1` beside it; legacy ITOM out of scoring; ITOM parameters in the generic registry | Rule tests (`health-itom-catalogue.test.js`) ✅; read-only instance validation ✅: 40 rules evaluated, 27 with a verdict, recorded in `rules/itom/instance-validation.json` (D-022) |
| 6 | **Platform** ✅ | 183 workbook rules as the second pack (pack factory, `health/packs.js`), lexical script analysis, `platform-quality/2` (Platform's first score) under the coverage floor | Rule tests (`health-platform-catalogue.test.js`) ✅; read-only instance validation ✅: 66 rules evaluated, 57 with a verdict (`rules/platform/instance-validation.json`) |
| 7 | **Enterprise DQ** ✅ | 56 workbook rules as the third pack, over a range of the data-quality sheet (DQ-084 … DQ-139, routed by exact id); `enterprise-dq-quality/2` with the workbook weights, under the coverage floor; Overall weight 0 until Phase 8 | Rule tests (`health-enterprise-dq-catalogue.test.js`) ✅; read-only instance validation ✅: 30 rules evaluated, 26 with a verdict (`rules/enterprise_dq/instance-validation.json`) |
| 8 | **Overall v2** ✅ | `overall-health/2` (D-028): the calibrated O8 min-blend (0.5 × weighted mean + 0.5 × weakest module) over the modules taking part (scanned, scored, weighted, above the coverage floor); equal module weights, not reviewed, configurable per instance (parameter module `overall`); validity = worst participant; `overall-health/1` published beside it | Calibration report passes (O8 promoted); Overall tests (`health-overall-v2.test.js`): promoted aggregation, no masking, participation, weights, monotonicity, validity ✅ |
| 9 | **CSDM** ✅ | 80 rules supplied as the CSDM KPI Articulation, transcribed into the CSDM sheet (the importer keeps them while the workbook sheet is a placeholder); the fourth pack; `gated_by` in the shared runner (a failed gate makes its dependants unmeasurable); layers from class or classification (CSDM 3 and 4); `csdm-quality/2` over seven groups, equal weights, not reviewed, cross-domain not scored; OWN-011 … 020 proposed equivalents; Overall weight 1 (D-028) | Rule tests (`health-csdm-catalogue.test.js`) ✅; read-only instance validation ✅: 33 rules evaluated, 18 with a verdict (`rules/csdm/instance-validation.json`) |

---

## 13. Items still to settle (none block phases 0–3)

1. ~~**CMDB-139…143**~~ Settled: 139/142/143 retired (D-009, applied Phase 4); 140/141 kept as DQ-003/DQ-077 (D-010).
2. **The ownership table** (§4.6) will be produced in phase 0 for review, including the severity conflicts it resolves.
3. **The Q7 market** (sensitive-data rules name PAN/Aadhaar/DPDP). It is an estate-fact parameter; no default market is assumed.
4. **Dimension weights for ITSM, ITOM and Platform, and module weights for Overall:** provisional equal and "not reviewed" until SAOS supplies them.
