# `health/itom/` — the ITOM catalogue pack (Health Assist Phase 5)

The master workbook's 156 ITOM rules (`rules/workbook/sheets/itom.json`, pinned to
the workbook's sha256), running on the **shared rule engine** in `health/itsm/`,
the same runner, engines, object-verification pipeline, field gate and verdict
rules as the ITSM catalogue. ITOM is a *catalogue pack*: a catalogue, an
architecture map, parameter declarations and rule configurations. There is no
second engine.

```
scripts/lib/itom-decisions.mjs ──► scripts/build-itom-catalogue.mjs ──► rules/itom/architecture-map.json
   (one recorded decision per rule)                                   rules/itom/parameters.json
                                                                      rules/itom/placeholders.json
                                                                      rules/itom/equivalents.json
                                                                      itom/rules/<engine>.json
itom/catalogue.js   the pack: get / has / all / adapt (domain ITOM, agent itom_agent)
itom/parameters.js  the declarations in the shared ParameterRegistry
itom/rules/index.js the configurations, validated exactly as ITSM's
itom/comparators.js the ITOM comparators (IP ranges, schedules, MIDs, maps, alerts), merged into the shared library
itom/integration.js normalisation (156 rows), equivalents, per-scan parameter registry
itom/engine-key.js  the ITOM module's engine key
scoring/itom-v2.js  itom-quality/2
```

The generated files are never edited by hand. Change the decision table and run
`node scripts/build-itom-catalogue.mjs`. The suite fails if a committed file is stale.

## Every rule has one recorded state

| State | Rules | Meaning |
|---|---|---|
| executable | 42 | Runs once its tables are verified on the instance |
| unconfigured | 11 | Runs once a threshold the workbook leaves open is set (`/api/health/parameters/itom/<rule>/<key>`) |
| undefined | 72 | The workbook leaves part of the detection undefined (a classification, a policy, a matrix, provider data), the platform does not record what the rule needs (verified in 5E), or the condition is owned by another module's rule |
| object unverified | 20 | Needs a platform object whose table is not established (Pattern execution results, MID certificates, cloud accounts and provisioning) |
| specification gap | 6 | The workbook does not say enough to evaluate deterministically |
| not built | 3 | Fully defined; evaluator not built yet (ITOM-013, 148, 156) |
| equivalent | 2 | ITOM-001 ≡ CMDB-071, ITOM-002 ≡ CMDB-070: evaluated once, counted once (D-019) |

The design-time state is a *classification*. The run decides each rule's actual
status: a verified table can still be missing on a given instance (unavailable),
or a rule with a partial detection can fail but never pass (inconclusive).

## Three rules the pack keeps

- **Nothing is read before it is verified.** Every table a configuration reads is
  in its `requires_tables`, so the runner checks it exists and has the fields
  before any read. An ITOM product that is not installed makes its rules
  UNAVAILABLE at table discovery, never PASS.
- **No platform value is hard-coded.** Run types, states, severities and
  criticality are named by their label (`$choice`) and resolved from the
  instance's `sys_choice`. A label the instance lacks makes the rule UNAVAILABLE.
- **No threshold is invented.** A workbook default is declared with its value (the
  suite checks the number is in the rule's own words). A value the workbook leaves
  to the customer is UNDEFINED, and the rule says so until it is set.

## Scoring (`itom-quality/2`, D-021)

The ITSM arithmetic (`scoreCatalogueControls`) applies over five product areas:
Discovery, MID Server, Service Mapping, Event Management and Cloud. Each area
starts at 100 and loses each failing rule's workbook severity weight. A rate rule
loses weight by how far it misses its own threshold. An area with no judged rule
is not averaged in.

- Cross-domain correlation rules are not scored.
- Equivalents are counted in CMDB.
- Rules that could not be judged are coverage gaps. Below the calibrated floor (40% of applicable
  severity weight), the score is shown but labelled *Insufficient coverage*.
- The previous model (`itom-checks/1`) and its capability checks are published beside the score.
- The 18 hard-coded ITOM rules keep producing findings as drill-down views and are not scored.

## Validated on a real instance (Phase 5E, D-022)

`node scripts/itom-instance-validation.mjs` checks the pack against the connected
instance. It is read-only and records metadata and counts, never record contents.
The result is in `rules/itom/instance-validation.json`. On techsnitchpvtltddemo2
(2026-09-24): all 43 named tables exist, every choice label resolves, and **40
rules evaluate**, with no engine error and no missing field. The architecture map
records which candidate tables the instance verified.

The run corrected the decision table in these places:

| Finding on the instance | Change |
|---|---|
| The affinity table is `dscy_credentials_affinity`, and it is **empty** beside 357 Discovery-sourced CIs | New table name. An empty affinity table beside discovered CIs makes ITOM-019/020/027 unavailable ("affinities are not recorded"), where it would otherwise have charged all 27 credentials as unused |
| 3 of 4 ranges attach to a schedule through a range set; 1 is an "IP Address List" | Ranges are attributed directly *or* through `discovery_schedule_range`, and list ranges are read from `discovery_range_item_ip` |
| The label is "Canceled" here and "Cancelled" elsewhere | `$choice` accepts alternative spellings and resolves only when they name one value |
| `ecc_agent.status` has no choice list | Its stored text ("Up" / "Down") is compared |
| Device history's `last_state` is free text, and its `cmdb_ci` is empty | A device's phase is read from `classified_as` and `cmdb_ci` (ITOM-028/030/031). "Explored but no CI" cannot be told apart, so ITOM-035 stays unavailable |
| Entry points, connectors, impact status and alert management rules exist, with verified schemas | Verified readers were added for ITOM-074, 083, 084, 086, 106, 107 and 118 |
| `sa_pattern` has no description or owner field; schedules have no owner field | ITOM-047 is undefined and ITOM-014 is unavailable, both with that reason |

The status export marks a rule "Tested on PDI" only where this run produced a pass
or fail verdict: 27 rules. The rows name the instance, which is non-customer.
