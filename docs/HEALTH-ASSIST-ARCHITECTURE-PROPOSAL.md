# Health Assist — Rule Framework and Scoring Architecture Proposal

**Status:** superseded by [HEALTH-ASSIST-APPROACH.md](HEALTH-ASSIST-APPROACH.md) (the agreed approach). Part A, the workbook-vs-code gap analysis, still applies. Parts B–E are the reasoning behind the final approach.
**Inputs:**
- `SAOS_Health_Rules_Tracker_v2_9574 (1).xlsx`. Its sheets are Schema, CMDB, ITSM, CSDM, ITOM, platform and data quality.
- The Health Assist code as analysed in [HEALTH-ASSIST-REPORT.md](HEALTH-ASSIST-REPORT.md).

**Principle:** one framework for how rules are defined, configured, executed, covered, classified, escalated, blocked and exposed. Each module then uses the scoring method its rules actually justify. Accuracy comes before uniformity.

---

## Part A — What the workbook says

### A.1 The workbook's own contract (Schema sheet)

Five statements in the Schema sheet drive the design:

1. **"Group — Dimension the rule contributes to. Must match a defined scoring dimension."** Every rule group is meant to be a scoring dimension, in every module.
2. **Severity bands and weights are universal:** Systemic 100 · Critical 40 · High 15 · Moderate 5 · Low 1. Systemic means "the governance mechanism itself is broken. One finding explains thousands."
3. **Severity modifiers are universal.** The Schema's second worked example is an ITOM rule, ITOM-017. It moves Critical → Moderate on a lab subnet, and Critical → Systemic on a production range for 31 days. Today only CMDB applies modifiers.
4. **"Every threshold is configurable. State the default and the unit."** This supports a single typed parameter registry.
5. **The Confidence Basis must be a formula or a structural certainty, and every rule names its false-positive guard.** These are rule-contract fields that every module must carry.

### A.2 Inventory: workbook vs implementation

| Sheet | Workbook rules | Implemented as catalogue | Implemented as hand-written ("legacy") rules | Workbook "Implementation Status" |
|---|---|---|---|---|
| CMDB | 138 (Groups 1–14) | **143** (all 138, plus CMDB-139…143 from a v3 tracker) | 9 (CMDB-OWNER, CMDB-STALE, CMDB-DUPLICATE, CMDB-UNRELATED, CSDM-OWNER/LIFECYCLE/OFFERING, REL-SELF/DUPLICATE) | "Not Started" on every row |
| ITSM | 139 | 139 configured. Of these, ~76 run with defaults, ~30 are unconfigured and 33 are unavailable. | 11 | "Not Started" on every row |
| ITOM | **156** (12 groups) | **0** | 18 | Not Started |
| Platform | **183** (15 groups) | **0** | 7 (two of them are really ITOM) | Not Started |
| Data quality — "CMDB Quality" model | 83 (D1–D10, weights 12/12/14/12/8/16/10/6/6/4) | Implemented through the CMDB rules (`dq` field). The weights match. | — | — |
| Data quality — "Enterprise Data Quality" model | **56** (Q1–Q7, weights 18/15/15/12/12/18/10) | **0**. No module exists for them. | — | — |
| CSDM | 0 ("CSDM rules will be added when provided") | CMDB Group 11 covers CSDM linkage | — | — |

**Headline:** about 395 of the workbook's ~755 rules are not implemented. These are the 156 ITOM, 183 Platform and 56 Enterprise DQ rules. The ITOM and Platform scores today rest on 25 hand-written rules that do not correspond one-to-one to the workbook.

### A.3 CMDB: workbook vs implementation

- **Rule IDs, titles and base severities: 138 of 138 identical.**
- **Five implemented rules are absent from this workbook:** CMDB-139 (no principal classes), 140 (identity attributes missing where the identification rule uses them), 141 (impact analysis returns no services, the D10 headline), 142 and 143 (a bulk write presented as freshness). The code states they come from a **v3** tracker (`catalogue/cmdb.json` source: `SAOS_Health_Rules_Tracker_v3.xlsx`).
- **16 thresholds and 4 detection-logic texts differ.** In each case the implementation added a *v3 fallback* ("when no principal classes are designated, evaluate all populated classes"). It also added confirmed defaults, for example CMDB-021 (80% of a class at a default choice) and CMDB-023 (stage sets).
- **The workbook provided is older than the code for CMDB.** The v3 workbook should become the source of truth, or v3 should be folded back into this file (see Question 1).
- **The workbook's Implementation and Validation Status columns are stale.** Every row says Not Started / Not Tested. The tracker cannot be used today to see what is built.

### A.4 ITSM: workbook vs implementation

- **139 of 139 IDs, titles and base severities match.** The implemented catalogue was generated from `SAOS_Health_Rules_Tracker_ITSM.xlsx` and pinned by its sha.
- **The 11 legacy ITSM rules are not in the workbook, and several contradict its intent.** They charge individual records for conditions the workbook defines as estate-level rates:

| Legacy rule (per record) | Workbook rule | Workbook intent |
|---|---|---|
| ITSM-INC-NO-CI (Low, every incident) | ITSM-016 (Systemic) | *rate* of incidents with no CI/service, default 40%, 90-day window |
| ITSM-CHG-NO-CI (Moderate) | ITSM-094 (Systemic) | *rate*, default 30% |
| ITSM-INC-REOPENED (≥2 reopens) | ITSM-030 (Systemic) | *reopen rate* by group and resolution code, 8%, escalate at 15% |
| ITSM-INC-UNASSIGNED / P1-AGED / PRB-STALE | ITSM-042 / 037 / 056, 061 | already folded into "defect families" in scoring |

  The same condition therefore enters the ITSM score twice. It is charged per record (60% part) *and* judged as a rate verdict (40% part). The defect-family deduplication only removes duplicates *within* the record part.

### A.5 ITOM: how the 18 legacy rules compare with the workbook

| Legacy rule | Closest workbook rule | Difference |
|---|---|---|
| DISC-STALE: last completion > **90 days** (the global staleDays) | ITOM-006 | Workbook uses the schedule's **own interval × 2** tolerance, with guard "paused deliberately". A daily schedule failing for 30 days passes today's rule. |
| DISC-LOG-ERROR: **any single** error-level log line (Moderate) | ITOM-038 | Workbook asks for an error volume **trend over ≥5 runs**, with guard "verbosity changed". Today's rule fires on noise. |
| DISC-FAILED: any errored or cancelled run | ITOM-032 / 033 / 039 | Workbook: error count > 10% of devices; run not completing in window; cancelled **and never re-run**. |
| DISC-DEVICE-ISSUE | ITOM-030 / 031 / 035 | Workbook splits by phase (port-scan halt, classified-not-explored, no CI produced). |
| CRED-INACTIVE: **any** inactive credential (Critical) | ITOM-018 | Workbook: inactive/expired **and still referenced by a schedule**. Guard: planned rotation. Today's rule is too broad. |
| CRED-NONE, CRED-ALL-INACTIVE | ITOM-016 (per range, per device type) | Workbook is range- and type-aware. |
| MID-DOWN (status = Down) | ITOM-053 | Workbook also counts "degraded" and "last refresh > 3× heartbeat". |
| MID-NOT-VALIDATED | ITOM-055 | Matches, but the workbook limits it to MIDs "in production use". |
| MID-NO-CAPABILITY | ITOM-062 | Workbook: no capabilities **and referenced by schedules**. |
| MID-ISSUE: any open issue | ITOM-059 | Workbook: issue count **rising over ≥3 observations**. |
| SM-NOT-IN-USE / SM-UNMAPPED | ITOM-067 / 068 / 074 | Workbook uses ratios (Business Critical unmapped > 10%; coverage < 60%) and "entry point with zero CIs". |
| EVENT-UNBOUND (open alert, no CI) | ITOM-095 / 098 | Workbook: **binding success rate** < 85% by source and class, and **events** failing to bind by node format. |
| PERF-ECC-AGE: ready item > **1 h fixed** | ITOM-036 | Workbook: depth **and** age, both configurable. |
| MID-NONE, DISC-NEVER-RAN, OUTAGE-OPEN | *none* | No workbook counterpart. The first two are really **applicability** facts (is Discovery in use?). OUTAGE-OPEN (availability) is not in the ITOM catalogue at all. |

Whole ITOM areas have no implementation at all:

- schedules (1A);
- patterns and probes (1D);
- MID certificates, versions and clusters;
- connectors and ingestion (4A);
- match rules (4B);
- alert operations (4C);
- cloud discovery and provisioning (5A–5B);
- all cross-domain ITOM rules.

### A.6 Platform: how the legacy rules compare with the workbook

| Legacy rule | Workbook rule | Severity: legacy → workbook | Detection difference |
|---|---|---|---|
| CUSTOM-BEFORE-UPDATE | PLT-034 | High → **Systemic** | Workbook guard: *parse* rather than plain-match (comments and strings). Today's rule is a regex. |
| INT-HTTP | PLT-144 | High → **Critical** | Same condition. |
| SEC-INACTIVE-ROLE | PLT-129 | High/Moderate → **Critical** | Workbook: report elevated roles separately. |
| UPGRADE-SKIPPED | PLT-154 | Moderate → **Systemic** | Workbook: skipped **and never reviewed**, ranked by execution volume. Today's rule flags every skipped update. |
| PERF-JOB-ERROR (state = error) | PLT-110 | default → Critical | Workbook: failure rate > 20% **with no alerting**. |
| MID-DOWN, EVENT-UNBOUND | (ITOM) | — | These are ITOM rules living in `platformRules()`. |

The Platform sheet also contains **SLA engineering (PLT-001…032)**, business rules, script includes, client scripts, UI/data policies, flows, jobs and events, ACLs and roles, integrations, customisation debt and performance. That is 183 rules and 15 groups, a very large denominator. The original reason for "Platform has no score" (no shared denominator) no longer holds once Platform is scored *per dimension* (§C.4).

### A.7 Duplicates across sheets

The same condition often appears in more than one sheet, sometimes with **different base severities**:

| Condition | Rules (base severity) |
|---|---|
| IP ranges with no discovery schedule | ITOM-001 (Systemic) · CMDB-071 (Critical) · DQ-059 (Critical) |
| Discovery coverage below threshold | ITOM-002 (Systemic) · CMDB-070 (Systemic) · DQ-056 |
| Name-only identification / match rule | CMDB-044 (Systemic) · ITOM-097 (Critical) · DQ-032 |
| Weak match order | CMDB-054 (Moderate) · ITOM-102 (High) · DQ-038 |
| Credentials outside vault | ITOM-024 (High) · PLT-139 (Systemic) |
| Event queue backlog | ITOM-091 (High) · PLT-115 (Critical) |
| Event flood from one source | ITOM-115 (High) · PLT-117 (High) |
| Priority band with no SLA | ITSM-003 (Systemic) · PLT-002 (Systemic) |
| Notifications to inactive users / empty groups | ITSM-011 · PLT-024 |
| Group with zero active members | CMDB-102 · ITSM-101 · ITSM-018 · DQ-071 · DQ-096 |
| Owner is an inactive user | CMDB-103 · DQ-072 · PLT-061/101/113 (per artefact type) |
| Extension depth beyond recommended | CMDB-120 · PLT-170 · DQ-083 |
| Integration with no error handling | ITOM-093 · PLT-141 |

If each module implemented its own copy, one defect would be detected several times, **counted several times in Overall**, and shown at different severities. The framework needs a rule to be **owned by one module and referenced by others** (§B.8).

---

## Part B — The common framework

This is the part that should be the same everywhere.

### B.1 One rule contract

Every rule in every module is one catalogue entry. It has two layers:

- **Workbook fields.** These are the Schema sheet's 16 fields, imported, never hand-edited in code: id, group, title, base severity, what it means, why it matters, source tables, detection logic, threshold, confidence basis, evidence, false-positive guard, remediation lane, cross-domain link, and status fields.
- **Engineering overlay.** These are machine fields the workbook does not carry, kept in one reviewed overlay file per module:

| Field | Values | Why it must be explicit |
|---|---|---|
| `module`, `dimension` | from the module profile | routing and scoring. Replaces prefix and domain guessing. |
| `kind` | `record` · `rate` · `configuration` · `trend` · `correlation` · `context` | decides how the result can be scored (§C.1) |
| `attainment` | `binary` · `good_share` · `bad_rate` · `record_deduction` · `none` | how a verdict becomes a number |
| `systemic_role` | `blocker` · `defect` · `posture` · `derived` (only when base = Systemic, or when escalation reaches it) | §B.5 |
| `blocks` | modules or dimensions whose measurement this invalidates | cross-module blockers (§B.5) |
| `applicability` | product, plugin or capability the rule needs (e.g. `event_management`, `cloud_discovery`) | a rule for a product not in use is N/A, not a pass or a fail |
| `parameters` | typed declarations (§B.3) | configurability |
| `engine` + `config` | engine key and declarative config, or `code:` for a code pack | execution (§B.4) |
| `owner_of` / `references` | canonical owner for a duplicated condition | §B.8 |
| `defect_family` / `dedupe_key` | one defect, one charge | stops double counting |
| `remediation` | lane plus guidance (workbook Remediation Lane 1/2/3) | one remediation source |

A **build-time importer** turns workbook plus overlay into `catalogue/<module>.json`, pinned by workbook sha, as ITSM already does. The loader validates at boot:

- slot order;
- required fields;
- severity words;
- every parameter referenced is declared;
- every dimension exists in the profile;
- every Systemic rule has a `systemic_role`.

A mis-tag fails the test suite, not a scan.

### B.2 One rule-outcome contract (`RuleResult`)

Every rule, in every module, produces exactly one outcome per run. Today only ITSM does.

```
RuleResult {
  rule_id, module, dimension, engine, version
  status      evaluated | not_applicable | unconfigured | unavailable | skipped | error
  verdict     pass | fail | inconclusive                (evaluated only)
  population  { total, judged, unit, basis }            (what was judged; empty ⇒ inconclusive, never pass)
  measure     { value, unit, threshold, direction }     (rates and KPIs)
  attainment  0..1 | null                               (§C.1; null when not scorable)
  severity    { base, effective, deduction, modifiers{escalators, de_escalators, not_evaluated} }
  systemic    { role, blocks[] } | null
  findings    [ Finding … ]                             (unchanged finding shape and fingerprints)
  blocker     { kind, reason, step } | null             (why it could not be evaluated)
  parameters  { key: {value, source: workbook|instance|runtime} }
  confidence  { value, basis }                          (the workbook's formula, not an asserted number)
}
```

**What this fixes:**
- A **pass is recorded, not inferred.** Today ITOM's "check passed" just means no finding appeared.
- **Coverage, applicability and scoring all read one structure** (§B.6).
- **Stored runs keep enough to be re-scored under a later model** (§D.2).
- CMDB packs keep their code. They return `RuleResult`s instead of pushing into `findings`, `skipped` and `kpis` separately.

### B.3 One parameter registry (CMDB becomes configurable)

This generalises `itsm/parameters.js` to all modules and keeps its semantics:

- **Typed declarations** (number, percent, duration+unit, string, list, boolean, cidr-list, class-list, regex), taken from the workbook "Threshold / Parameter" text.
- **Precedence:** workbook default → **instance override** (persisted per bound instance) → **runtime override** (per run, recorded on the run, never part of the baseline key).
- **UNCONFIGURED, never guessed.** A parameter the workbook gives no default for blocks its rule, which answers `unconfigured` and names the key. For example ITOM-025's "rotation period from the customer's policy, not assumed".
- **Three classes of parameter,** because they are versioned differently:

| Class | Examples | Overridable per instance | Effect on comparability |
|---|---|---|---|
| **Rule thresholds** | CMDB `untouchedDays 180`, `discoveryCoveragePct 85`, ITOM-006 tolerance 2× | yes | part of the module's *engine key* (forces a re-read). Recorded per result, so a trend can show "threshold changed here". |
| **Estate facts** | production CIDRs, VIP ranges, principal classes, business-critical rule, script-account names, rotation policy | yes. **No customer-specific defaults.** Empty means "not evaluated", and that is disclosed. | engine key |
| **Scoring-model constants** | band weights, dimension weights, blends, attainment curves, overall weights | yes, but a changed value marks the model as **customised** | part of the **scoring key**. A change starts a new trend series. |

- **Migrating CMDB:** about 200 `*_DEFAULTS` entries across 14 packs become declarations. Each maps to the catalogue rule it tunes, or to `signals` / `module` for shared ones.
- **UI:** the ITSM parameter panel becomes a Health Assist settings panel with module tabs.

### B.4 One execution model

- **Engines are module-agnostic.** The 10 ITSM engines move to `health/engines/` and become the default executor for all modules:
  - record predicate
  - aggregate
  - linkage
  - configuration
  - reference integrity
  - relationship graph
  - temporal correlation
  - audit history
  - text analysis
  - composite
- **Code packs are allowed.** CMDB's 14 packs stay as code engines registered per rule. Some rules genuinely need code (IRE analysis, graph reachability, materiality).
- **New engines are needed:**
  - **`script_analysis`** parses script bodies rather than regex-matching them. PLT-034's guard explicitly asks for this. It covers Platform 2A/3A/3B/flows and the hard-coded credential rules PLT-047/072/100.
  - **`schedule_interval`** covers "last success beyond its own interval × tolerance" for ITOM-006/071/084/124 and PLT-106/111. This check recurs across modules.
  - **`trend`**: min-N comparable observations and a slope/projection. ITOM-029/038/059, PLT-064/109/172 and CMDB G14 all need it. It generalises `measure-history.js`.
- **Gates keep the runner's order** (undefined dependency → object pipeline → tables → fields → parameters → instance values → engine). A new first gate is **applicability** (§B.6). An engine exception is an `error`. It never passes and never stops the run.
- **Extraction stays allow-listed** (`tables.js`). ITOM and Platform will add tables:
  - discovery_schedule(_range), sa_pattern, sa_service_entry_point, em_connector_definition, em_match_rule, sn_cmp_*;
  - sys_script_include, sys_script_client, sys_ui_policy, sys_data_policy2, sys_hub_flow, wf_workflow, sys_security_acl, sys_user_role, oauth_entity, sys_update_set, contract_sla, task_sla, syslog_transaction …

### B.5 Systemic and blocking conditions (generalised)

CMDB's gate mixes two different ideas. The generalised model separates them:

- **"The assessment cannot be trusted"** (a *measurement* problem).
- **"Something is severely broken"** (a *health* problem).

| `systemic_role` | Meaning | Score effect | Shown as |
|---|---|---|---|
| **blocker** | The finding invalidates what *other* measurements mean. Examples: no health inclusion rule (CMDB-001); Discovery coverage below threshold (ITOM-002/CMDB-070) makes CMDB freshness and relationships unrepresentative; HR feed not running (DQ-118) invalidates the user DQ rules. | **Scores as a defect in its own dimension** (weight 100) **and** marks every module or dimension in `blocks[]` as **"provisional — blocked by X"**. The number is **shown**, never nulled. | A blocker banner on each affected module, naming the rule, its evidence and what it undermines. |
| **defect** | A measured, severe failure that *is* health. Examples: credential failure rate ≥ 70% for 3 days (ITOM-015); client-callable Script Includes with no ACL (PLT-065); reopen rate 8% (ITSM-030). | **Scores** at weight 100 (effective Systemic). It is *not* excluded, which is what ITSM does today. | A Systemic panel with a count, listed apart from ordinary findings. |
| **posture** | A missing governance mechanism whose absence is a risk, not a measured failure. Examples: no access recertification (PLT-134); Data Manager or attestation posture (CMDB G9). | Not in the score. Shown beside it. | A posture panel. |
| **derived** | Computed from the score itself (CMDB-116). | None | Presentation only. |

**Rules of the model:**

1. A rule's role is **declared in the catalogue overlay**, reviewed once per rule (≈120 Systemic rules in total). A rule may **downgrade** at run time with a stated reason, for example "the capability measured is absent, so this is posture". It can never promote itself. This is today's `systemic_kind_override`, generalised.
2. **Escalated-to-Systemic** findings (a Critical escalated by context) are `defect`s. They count, and they are shown with their escalation chain.
3. **Blockers cross modules.** ITOM-002 can mark CMDB as provisional. Overall is provisional if any participating module is blocked.
4. **The score is never hidden.** Each module shows `score` + `validity`:
   - `assessed`
   - `provisional:blocked(n)`
   - `provisional:coverage(x%)`
   - `insufficient_coverage` (number shown greyed, excluded from Overall)
   - `not_scanned`
   The words "Assessment incomplete" / "Score not trustworthy" become the *validity label* next to a visible number. Today the CMDB gate variant publishes `null`.

### B.6 Applicability and coverage (one definition for all modules)

Three different numbers, never mixed into the score:

| Measure | Definition | What it tells the user |
|---|---|---|
| **Build coverage** | implemented rules ÷ catalogue rules (per module and dimension) | how much of the SAOS model exists in this build (e.g. Platform 0/183 today) |
| **Applicability** | rules whose product or capability is in use on the instance | what *should* be judged here. Cloud rules are N/A without cloud discovery. |
| **Assessment coverage** | Σ base-weight of **evaluated** applicable rules ÷ Σ base-weight of **applicable, built** rules | how much of what should be judged *was* judged on this run |

- Weighting coverage by **base severity weight**, not rule count, keeps "we couldn't evaluate five Low hygiene rules" from looking as bad as "we couldn't evaluate the Systemic coverage rule".
- **Applicability is evidence-based, not assumed.** It uses plugin/licence reads plus usage evidence. Absence can itself be a finding when evidence says the product is needed. Examples: ITOM-085 (monitoring tool with no connector) and ITOM-120 (cloud account with no service account).
- **Minimum coverage to score** (a scoring-model parameter, default proposal **40% of applicable base weight**). Below it the module shows its partial number as `insufficient_coverage` and does not take part in Overall. **This is the mechanism that switches Platform (and ITOM) scoring on as their rules are built**, with no hard-coded "Platform has no score".

### B.7 Severity pipeline (shared)

- `effective = clamp(base + escalators − de-escalators, LOW, SYSTEMIC)`, the workbook formula, for **all** modules.
- The **signals library** (today `cmdb-signals.js`) becomes module-agnostic:
  - business-critical support
  - production
  - shared infrastructure
  - retiring
  - duration > 30 days
  - recurred (from history)
  - control (approval / segregation of duties)
  - class defect rate
- Non-record rules resolve their **subject** to the CIs or services it affects: a range → its CIs → their services; a job → its tables; an integration → its target tables. That lets production and business-critical escalation apply to ITOM-017's "production range" exactly as the Schema example describes.
- Reporting band vs deduction band (population modifiers only move reporting) stays as CMDB defines it.

### B.8 One condition, one owner

- For every cross-sheet duplicate (§A.7), the overlay names an **owner rule**. The others become `references` that link to the owner's result instead of re-detecting.
  - Proposed ownership: data condition → CMDB/DQ; mechanism → ITOM; platform configuration → Platform; process → ITSM.
  - Example: ITOM-001 owns "range with no schedule"; CMDB-071 and DQ-059 reference it.
- **A referenced result is shown in the referencing module** as context, is **scored only in the owner module**, and is **counted once in Overall**.
- Where the workbook assigns different base severities to the same condition, that conflict goes to a **decision list** (Question 3), not silently to code.

### B.9 Module registry

One data structure replaces the hard-coded `SCOPES`, `RULE_PREFIXES`, `RULE_SCOPE`, `AGENTS` domains and `ITOM_CHECKS`:

```
{ key, label, catalogue, tables, applicability probes, profile: {method, dimensions[{key,label,weight,groups[]}], blends, attainment curves},
  overall: {weight, participates_when}, rule_id_pattern }
```

Routing reads the rule's `module` field. There is no more prefix-then-domain inference, and no PERF-ECC-AGE-style overrides.

---

## Part C — Scoring: what each module measures, and the method that fits

### C.1 Two scoring methods and one blend, chosen per dimension

Health rules ask one of two kinds of question. That, not the module name, should pick the method.

**Method R — record deduction (population health).** *"What share of the population is in good condition?"* Used where the rule's unit is a record that someone maintains.

```
record_score(r) = max(0, 100 − Σ w(deduction band) over distinct charges on r)
R(d) = Σ_r c(r)·record_score(r) ÷ Σ_r c(r)            c(r) = consequence weight (§C.2 change 1)
```

**Method C — control attainment (mechanism and process health).** *"How much of what should be working is working, weighted by how bad each failure is?"* Used where the rule's unit is a configuration, a capability, a rate or a process.

```
loss(d)  = Σ_r w(effective band of r) × (1 − a_r)     over evaluated, applicable, scorable rules in d
C(d)     = 100 × max(0, 1 − loss(d) ÷ Σ_r w(base band of r))
```

**Attainment `a_r`, derived from the workbook's own threshold form:**

| Threshold form in the workbook | Attainment | Examples |
|---|---|---|
| "Any occurrence", "fixed: absence", "both fields empty" | **binary**: 1 pass, 0 fail | PLT-034, ITOM-018, CMDB-001 |
| "Default threshold X%" on a *good* share (coverage, binding, success) | **good_share**: `min(1, measured ÷ X)` | ITOM-002 (85%), ITOM-095 (85%), ITOM-068 (60%) |
| "Default X%" on a *bad* rate (failure, reopen, error) | **bad_rate**: `min(1, (1 − measured) ÷ (1 − X))` | ITSM-030 (8%), PLT-097 (5%), ITOM-032 (10%) |
| trend, correlation, context | **none**: shown, not scored (unless Systemic → blocker / defect) | ITOM-038, ITOM-147…156, CMDB G14 |

- **Graded, not binary, where the workbook gives a number.** 84% coverage against an 85% target is nearly healthy. 20% is not. A binary verdict scores both at 0.
- **Binary where the workbook says "any occurrence".** One hard-coded credential is a full failure, not "99.8% of scripts are fine".
- Escalation raises a failing rule's loss above its base weight, so an escalated failure can push a dimension towards 0. This is intended: the Schema says Systemic means "one finding explains thousands".

**Blend (for mixed dimensions):** `S(d) = β·R(d) + (1−β)·C(d)`, with β per dimension kind (record 0.7 / mixed 0.6 / estate 0.3, as CMDB uses today). It is declared in the profile and part of the scoring key.

**Module score:** `Σ W_d·S(d) ÷ Σ W_d` over **measured, applicable** dimensions. The dimension weights come from the workbook where it gives them.

### C.2 CMDB (Method R + blend, workbook D1–D10 weights)

**What its rules measure:** mostly defects on maintained records (110 of 143 are record rules), plus estate KPIs (impact analysis, consumption) and governance configuration. The per-record model fits the nature of the rules.

**Keep:**
- the D1–D10 dimensions and weights (they are in the workbook's data quality sheet);
- band weights;
- one-defect-one-charge (`dedupe_key`);
- the population/per-CI modifier split;
- materiality patterns that report but don't charge;
- "measured only if something that can charge ran";
- the three published variants;
- the retired/stolen/absent exclusion for D1–D5.

**Change:**

1. **Consequence-weighted record mean.** Today every CI counts equally in the denominator, so thousands of leaf devices dilute a defect on a core router. The code comments record D10's record part at 96 and "near-inert by design". Consequence scoping today only lowers the *band* of leaf-device defects. The fix is to weight records by consequence tier in the mean:
   - supports a business-critical service;
   - infrastructure / host / application;
   - other;
   - endpoint / non-production.

   The tier weights are scoring-model parameters; defaults are for review, e.g. 4 / 2 / 1 / 0.5. The score then answers "how healthy is the CMDB where it matters", which is what the D-dimension rationale says it should.
2. **KPI part uses attainment against target** (`good_share`/`bad_rate`), not the raw pass %. Today CMDB-141 at 89% against a 90% target scores 89; under this proposal it would score ≈99. At 0% it scores 0 either way.
3. **Blockers split from defects** (§B.5):
   - CMDB-001/002/044/045 → `blocker`;
   - CMDB-003/046/057/070/141 → `blocker` + `defect` (they gate *and* score, as `measured_kpi` does today);
   - posture unchanged.
   - The gate variant shows the number with a validity label instead of `null`.
4. **Retire the legacy duplicates:** CMDB-OWNER (→ CMDB-102/105), CMDB-STALE (→ D7), CMDB-DUPLICATE (→ CMDB-035), CMDB-UNRELATED (→ CMDB-058), and CSDM-OWNER/LIFECYCLE/OFFERING (→ G11).
5. **Score drivers come from the actual deductions**, per dimension, weighted, not from the legacy pass-rate helper.

### C.3 ITSM (Method C over process dimensions)

**What its rules measure:** of 139 rules, most are rates, distributions, configurations and correlations: aggregate 20, configuration 24, linkage 22, temporal 9, composite 10, text 11. 33 are Systemic. The workbook groups are **process areas**:

- Incident: 1A config, 1B data quality, 1C behaviour, 1D major incident
- Problem: 2A–2C
- Change: 3A–3D
- Cross-process

The question the rules ask is *"is the process working?"*, not *"what share of tickets is clean?"*

**What is wrong with today's model (`itsm-quality/1`):**

1. **Systemic rules have zero influence.** All 33 are posture: excluded from the rule part, never charged, never gating. The most important ITSM findings cannot move the ITSM score.
2. **The record part is driven by per-record legacy rules that re-implement workbook rates** (§A.4), so the same condition is counted twice.
3. **The rule part is binary and unweighted.** A failing Systemic rule counts the same as a failing Moderate one, and a 9% reopen rate scores the same as a 60% one.
4. The 60/40 blend has no basis in the workbook.

**Proposal:**
- **Method C per process dimension:** Incident, Problem, Change and Cross-process. Record-predicate rules enter as `bad_rate` over the population they judged. For example ITSM-020 "close notes shorter than N" contributes its offending share. The per-record evidence is still listed.
- **Systemic ITSM rules become `defect`s** by default: ITSM-016, 030, 094 and similar score at weight 100. A few become `blocker`s. For instance ITSM-016 (≥40% of incidents with no CI) blocks the cross-process correlation rules (ITSM-123/130/132), because their joins then describe a minority of incidents.
- **Retire the 11 legacy ITSM rules,** or keep them as evidence views (drill-down lists) under their workbook owners. They should not be scored.
- **Unavailable and unconfigured rules count against assessment coverage, not health.** This is already true in principle and is now formalised via §B.6.
- **Dimension weights:** not stated in the workbook (Question 4). An interim default is equal weights over the applicable process dimensions, flagged "weights not reviewed" (the precedent is CMDB-116).

### C.4 ITOM (Method C over capability dimensions, applicability-aware)

**What its rules measure:** whether the machinery that keeps the CMDB true is configured, running and effective. Of 156 rules, 29 are Systemic. They are mostly ratios with defaults (coverage 85%, binding 85%, classification 85%) and binary configuration checks.

**What is wrong with today's model (`itom-checks/1`):**
- 9 hand-made checks built from 18 rules that differ from the workbook (§A.5);
- severity-blind;
- a pass is inferred from silence;
- a score step of ≈11 points;
- no applicability, so an estate without Event Management has its `events_bound` check "not applicable", but only because the table is empty.

**Proposal:**
- **Dimensions from the workbook groups:**

| Dimension | Workbook groups |
|---|---|
| Discovery | 1A schedules, 1B credentials, 1C execution, 1D patterns |
| MID Server | MID Server |
| Service Mapping | Service Mapping |
| Event Management | 4A connectors, 4B binding, 4C alerts |
| Cloud | 5A cloud discovery, 5B provisioning |

- **Applicability per dimension** comes from plugin/licence and usage evidence. A product not in use is N/A: excluded from the denominator and disclosed. The "Cross-domain ITOM" group (ITOM-147…156) is **correlation**. It explains *why* CMDB and ITSM findings exist and quantifies the chain. It feeds root-cause clustering and cross-domain links and is **not scored**, because scoring it would count the downstream consequences a second time.
- **Blockers:** examples include ITOM-002 (discovery coverage) → blocks CMDB D7/D6; ITOM-095 (binding rate) → blocks ITSM/CMDB impact KPIs; ITOM-107 (impact never populated) → blocks CMDB-141 interpretation.
- **MID-NONE / DISC-NEVER-RAN become applicability evidence plus binary blockers.** If CMDB shows discovery sources and ranges but no MID exists, Discovery is in use and broken, which is Systemic. If there is no evidence of Discovery at all, the Discovery dimension is N/A and a posture note says so (Question 5).
- **Dimension weights:** not stated in the workbook (Question 4).

### C.5 Platform (Method C, artefact-aware)

**What its rules measure:** the engineering health of the platform itself: SLA engineering, scripted logic, automation, access control, integrations, customisation debt and performance. Of 183 rules, 42 are Systemic, and a large share of those are security (ACLs, credentials, admin roles).

**Proposal:**
- **Dimensions** (from the 15 workbook groups, merged where they measure the same thing):

| Dimension | Workbook groups |
|---|---|
| SLA engineering | 1A–1C |
| Server-side logic | 2A–2C business rules, 3A script includes |
| Client-side and form logic | 3B, 3C |
| Automation | flows and workflows |
| Scheduled jobs and events | — |
| Access and security | ACLs, roles and access |
| Integrations | — |
| Customisation and upgrade debt | — |
| Performance | — |

- **Artefact rules** (business rules, scripts, flows, ACLs) with "any occurrence" are binary. Rules with a stated share (PLT-018 15%, PLT-097 5%) are graded. This solves the original denominator problem: 42,000 role assignments no longer outweigh 14 integrations, because each is judged inside its own dimension and the dimensions are weighted.
- **Security Systemic rules** (PLT-047/072/100 hard-coded credentials, PLT-065/067 unprotected script includes, PLT-121/122 ACL gaps, PLT-137/138 integration admin and basic auth) are `defect`s at weight 100. A proposed blocker is PLT-122 (tables with no ACL coverage), for any score that claims data protection (Enterprise DQ Q7).
- **Scored once assessment coverage ≥ the minimum** (§B.6). Until then the partial number is shown as `insufficient_coverage`.
- **SLA rules overlap ITSM** (ITSM-003 ↔ PLT-002 and others). Ownership goes in the decision list (Question 3). The suggestion: SLA *engineering* (definitions, conditions, schedules) → Platform; SLA *outcomes* on process records → ITSM.

### C.6 Enterprise Data Quality: a fifth module the workbook already defines

These are the 56 rules in Q1–Q7 (users, groups, locations, companies, assets, models, catalogue items, knowledge, personal data), weights 18/15/15/12/12/18/10. They are record rules, so **Method R**, with the workbook weights. Q7 (sensitive data, market-specific) should be **applicable per market** (a parameter). DQ-118 (HR feed failing) and DQ-139 (no data classification) are natural **blockers** for Q5 and Q7 respectively (Question 2).

### C.7 Overall

**What is wrong with `overall-health/1`:**
- equal weights that no evidence supports;
- Platform at 0;
- a module with thin coverage counts in full;
- a mean can say "Healthy" while one module "Needs work";
- a duplicated condition is counted in several modules;
- blockers are module-local.

**Proposal (`overall-health/2`):**
1. `Overall = Σ W_m·S_m ÷ Σ W_m` over modules that are **scanned, applicable, and at or above minimum coverage**. W_m is a declared scoring-model parameter (Question 6). A missing module is renormalised away, never counted as 0 or 100.
2. **Validity** is the worst validity of the participating modules, and cross-module blockers propagate. The number is always shown.
3. **Weakest-area rule:** the Overall *band* cannot be more than one band better than the worst participating module's band. The number stays the weighted mean; the *word* reflects the weakest area. This stops "Healthy" from covering an area that "Needs work". The attribution field already names the weakest area, so this makes it binding.
4. Duplicate conditions are counted once, through ownership (§B.8).
5. Coverage is reported beside the number, weighted the same way, and never inside it.

---

## Part D — Versioning, history and migration

### D.1 Keys

| Key | Covers | Effect of a change |
|---|---|---|
| **Engine key** (per module) | rule code / engine versions, catalogue, rule-threshold and estate-fact parameters, accepted risks | the module is re-read (no reuse) |
| **Scoring key** (per module) | method, dimension set and weights, blends, attainment curves, band weights, consequence tiers, minimum coverage, the implemented-rule set | a new trend series (the chart breaks the line and labels it) |
| **Overall key** | module weights, participation rules, band rule, module scoring keys | a new overall series |

A new rule being *built* widens coverage under the same scoring key, as today for CMDB. A rule that *changes how it scores* moves the key.

### D.2 History

1. **Store `RuleResult`s on every run.** They carry measures, attainment inputs, populations and per-record charges. Because every scoring function is pure, **a stored run can be re-scored under a newer model** whenever its stored inputs are sufficient. The trend can then show the new model back through history, labelled "re-scored under cmdb-quality/2".
2. Runs stored before `RuleResult` existed keep their original series. The chart shows the break rather than joining two models.
3. **Dual publication for a transition window** (e.g. the first N runs after release): compute old and new models side by side, so a customer can see the shift is from the method, not the estate.

### D.3 Migration phases (each independently shippable)

| Phase | Delivers | Score change? |
|---|---|---|
| **0. Source of truth** | Workbook importer plus overlays. A gap register (this document's Part A as data). A conformance test that every rule has a complete contract. The v3 CMDB workbook reconciled. | No |
| **1. Framework core** | `RuleResult` for CMDB/legacy. Module registry. The parameter registry generalised, with CMDB's ~200 defaults declared. The settings UI. | No |
| **2. Systemic, coverage and applicability model** | `systemic_role` on all Systemic rules. Blocker propagation. Validity labels (number never hidden). Three coverage measures. | Validity presentation only |
| **3. Scoring kernel + CMDB v2 + ITSM v2** | Methods R and C, attainment curves, consequence weighting. ITSM process dimensions. Legacy ITSM/CMDB rules retired from scoring. Dual publication. | **Yes**: new keys, dual-published |
| **4. ITOM catalogue** | 156 rules on the engines (+ `schedule_interval`, `trend`, applicability probes). Legacy ITOM retired. `itom-quality/1`. | Yes (new model) |
| **5. Platform catalogue** | 183 rules (+ `script_analysis`). `platform-quality/1`, scored once coverage ≥ minimum. | Platform switches on |
| **6. Enterprise DQ (+ CSDM when provided)** | Q1–Q7 module | New module |
| **7. Overall v2** | Weights, weakest-area band, cross-module blockers, single counting | Yes (new overall key) |

---

## Part E — Decisions needed

1. **CMDB source of truth:** the provided workbook is v2 and the code implements v3 (CMDB-139…143, 16 thresholds). Provide the v3 workbook, or confirm the implemented catalogue is authoritative for CMDB.
2. **Enterprise Data Quality:** should Q1–Q7 become its own fifth module (as the workbook's separate model and weights suggest), or be distributed (e.g. Q7 → Platform security)? Which market(s) should Q7 apply to by default?
3. **Duplicate conditions and conflicting severities** (§A.7): accept the ownership rule of thumb (data → CMDB/DQ, mechanism → ITOM, platform config → Platform, process → ITSM), with the severity conflicts resolved from that owner's sheet?
4. **Dimension weights for ITSM, ITOM and Platform:** the workbook gives weights only for CMDB (D1–D10) and Enterprise DQ (Q1–Q7). Will SAOS supply them (preferably as workbook columns), or should the build ship equal interim weights flagged "not reviewed"?
5. **ITOM not in use:** when an instance shows no evidence of Discovery / Event Management / Cloud at all, should those dimensions be **N/A** (excluded, disclosed as posture) or **failures**?
6. **Overall module weights and the weakest-area band rule:** equal weights across participating modules as the default? Is the "band cannot be more than one better than the worst module" rule acceptable?
7. **Engineering overlay location:** keep the machine fields (kind, attainment, systemic_role, blocks, applicability, owner) in overlay JSON reviewed in code, or add them as workbook columns so the workbook stays the single source?
8. **Consequence tier weights and minimum coverage:** are the proposed defaults acceptable as starting values (4/2/1/0.5 and 40% of applicable base weight), or does SAOS want to set them?
