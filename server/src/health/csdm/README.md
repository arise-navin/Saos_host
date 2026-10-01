# `health/csdm/` — the CSDM pack (Health Assist Phase 9)

The CSDM module's 80 rules run on the **shared rule engine** as the fourth workbook
pack, after ITOM, Platform and Enterprise DQ (decision D-029).

The product owner supplied the rules as a document, the *CSDM KPI Articulation*:

- The document is kept verbatim in `rules/workbook/supplements/csdm-kpi-articulation.md`.
- `scripts/import-csdm-catalogue.mjs --write-workbook <xlsx>` wrote it mechanically into
  the master workbook's CSDM sheet, in the other rule sheets' shape and styles (D-031).
- The workbook importer reads CSDM like every sheet, and the suite checks that the
  workbook still says what the document says.

```
supplements/csdm-kpi-articulation.md ──► import-csdm-catalogue.mjs --write-workbook ──► workbook CSDM sheet ──► import-health-workbook.mjs ──► sheets/csdm.json
scripts/lib/csdm-decisions.mjs ──► scripts/build-workbook-pack.mjs --pack csdm ──► rules/csdm/*.json + csdm/rules/*.json
csdm/pack.js          the pack (createWorkbookPack)
csdm/comparators.js   layers, links, lifecycle, environment, cycles — merged into the shared library
scoring/csdm-v2.js    csdm-quality/2 — CSDM's first score (and CSDM-072 itself)
```

## Layers

A service record's layer comes from its class: the CSDM 4 classes
`cmdb_ci_service_business`, `cmdb_ci_service_technical`, the application-service tree
under `cmdb_ci_service_auto`, and `service_offering`.

A record of the base class `cmdb_ci_service` takes its layer from
`service_classification` instead, which is how CSDM 3 modelled it. The value comes
from the instance's choice list by label. Both models are in use on the validation
instance, so both are judged.

## Gates

The catalogue's build note asks for gating "in the rule pack, not in the report". The
shared runner's `gated_by` does this. When a gate rule fails, its dependent rules are not
evaluated: each reports `gated`, names the gate, and raises no findings. When the gate
passes, or cannot be assessed, the dependent rules run as normal. The workbook-stated
dependencies then mark them provisional where they apply.

| Gate | Gates |
|---|---|
| CSDM-032 lifecycle model not configured | the lifecycle group (CSDM-017 … 031) |
| CSDM-050 no environment value set | the environment group (CSDM-043 … 049) |
| CSDM-062 offering layer not used | CSDM-004, 005, 041, 061 |
| CSDM-026 a class sits at the default lifecycle value | CSDM-017 (026 "replaces" the per-record findings) |

CSDM-043 is a per-record rule. CSDM-044 to CSDM-046 judge only records whose environment
is set, and are marked provisional on CSDM-043 (`dependencies.json`).

## States

| State | Rules |
|---|---|
| executable (7 of them from ServiceNow's documentation, D-032: 014, 028, 029, 051, 055, 058, 072) | 41 |
| undefined (a mapping, a policy, a field or a data-owner definition is missing; each rule says which) | 15 |
| specification gap | 5 |
| not built (audit history, life_cycle_mapping join, full-hierarchy traversal, impact calculation, cross-domain correlation) | 7 |
| equivalent — checked only in the owner module, never here (D-030: CMDB-080/102/103/110–114, ITSM-017/136; CSDM-071 is CSDM-004's ratio) | 12 |

## Legacy

CMDB keeps its three hard-coded CSDM checks (CSDM-OWNER, CSDM-LIFECYCLE, CSDM-OFFERING)
by exact rule ID, in the `CSDM` domain. The `CSDM-` prefix and the `CSDM_MODEL` domain
belong to this catalogue.

## Validated on a real instance

`rules/csdm/instance-validation.json` records the read-only run on techsnitchpvtltddemo2:

- All 36 tables exist, and every choice label resolves.
- 33 rules were evaluated: 12 fail, 6 pass, 15 inconclusive.
- The estate has no business capabilities, applications or information objects, so
  CSDM-001 fails and the rules that need those layers have nothing to judge.
- Every service's lifecycle stage is empty. CSDM-026 therefore reports the classes, and
  CSDM-017 is gated rather than raising 319 findings.

## Values from ServiceNow's documentation (D-032)

| Rule | Value | Source |
|---|---|---|
| CSDM-058 | depth = the instance's `glide.relationship.max_depth`, else 10 | ServiceNow's impact analysis default |
| CSDM-029 | planning = Ideation, Purchase, Inventory, Design, Deploy (Pilot excluded) | CSDM 5 white paper, intangible / logical life cycle |
| CSDM-028 | parent End of Life with an Operational child (the only conflict judged) | ServiceNow publishes no matrix |
| CSDM-051 / 055 | the instance's suggested relationships (`cmdb_rel_type_suggest`) | CI Class Manager |
| CSDM-014 (and DQ-134) | fields classified with a personal-data class (`m2m_dictionary_dataclass`) | ServiceNow Data Classification |
| CSDM-072 | the stage reached: Foundation → Crawl → Walk → Run → Fly, by the tables in use | CSDM 5 white paper; no percentage thresholds exist |

On the validation instance, CSDM-072 reports **Foundation**: there are no business
applications, so Crawl is not reached. CSDM-014 fails: 52 personal-data fields are
classified across 7 tables, and no information object exists. DQ-134 passes: all 52 fields
are protected by a restrictive read ACL.
