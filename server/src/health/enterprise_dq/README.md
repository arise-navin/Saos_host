# `health/enterprise_dq/` — the Enterprise Data Quality pack (Health Assist Phase 7)

The master workbook's 56 Enterprise Data Quality rules (DQ-084 … DQ-139, the
data-quality sheet's "Enterprise Data Quality" model) run on the **shared rule
engine** as the third *workbook pack*, beside ITOM and Platform. The same factory
builds it (`health/itsm/workbook-pack.js`). Since Phase 7 a pack can cover a
contiguous **range** of a sheet (`first`). DQ-001 … DQ-083 are the same sheet's
"CMDB Quality" rows. They restate CMDB rules and stay with CMDB. Enterprise DQ
therefore routes its 56 ids **exactly** (`modules.js`), never by the `DQ-` prefix.

```
scripts/lib/enterprise_dq-decisions.mjs ──► scripts/build-workbook-pack.mjs --pack enterprise_dq ──► rules/enterprise_dq/*.json + enterprise_dq/rules/*.json
enterprise_dq/pack.js          the pack (createWorkbookPack over the sheet's Enterprise Data Quality rows)
enterprise_dq/comparators.js   cycles, duplicates, cross-record checks — merged into the shared library
scoring/enterprise-dq-v2.js    enterprise-dq-quality/2 — the module's first score
scripts/pack-instance-validation.mjs --pack enterprise_dq   read-only validation on the connected instance
```

## Scoring (D-026)

The score uses the promoted model over the workbook's seven dimensions, Q1–Q7. It
applies the **workbook's own weights** (18 · 15 · 15 · 12 · 12 · 18 · 10). This is
the first catalogue module whose workbook states them. The shared arithmetic
(`scoreCatalogueControls`) uses stated weights when every dimension has one, and
equal weights otherwise, so ITSM, ITOM and Platform are unchanged. The coverage
floor applies. The module carries weight 0 in the Overall until Phase 8.

## What the platform does not have

Some rules name a field that is not on the platform. We checked each one read-only
on the instance. These rules are recorded as undefined, not evaluated against a
substitute:

- knowledge "owner" and "review date" (DQ-094, DQ-122): `kb_knowledge` has
  `author`, `ownership_group` and `valid_to`.
- a group's company (DQ-106) and a cost centre's company (DQ-110).
- an asset's end-of-life date (DQ-121): `warranty_expiration` and
  `retirement_date` are different dates.
- field-level data classification (DQ-134, DQ-137, DQ-139): `sys_data_classification`
  is not on the instance.

## Reads that make a claim

A missing target row, or a link not returned, counts as a defect. Such a read must
be **complete**. The comparators refuse a partial read (`complete: true`) rather
than charge what they could not see. Duplicate and cycle checks cannot invent an
offender from a partial read, so they accept one.

## States

| State | Rules |
|---|---|
| executable | 30 |
| undefined (a field, a policy, a mapping or a threshold is missing; each rule says which) | 22 |
| not built (DQ-098 choice values against sys_choice, DQ-132 report fields against the dictionary) | 2 |
| specification gap (DQ-133: which free-text fields, and the account-number patterns) | 1 |
| equivalent (DQ-131 ≡ ITSM-139, Ownership OWN-004 agreed — D-027) | 1 |

## Validated on a real instance

`rules/enterprise_dq/instance-validation.json` records the read-only run on
techsnitchpvtltddemo2. That run caused three corrections:

- DQ-130 no longer judges a notification that names no one. A mail script in its
  message can add recipients: 51 of the instance's 73 fixed-recipient notifications
  name no one.
- Reads that make a claim must be complete.
- Catalog-item rules are scoped to the requestable classes. Record producers, order
  guides and content items have no fulfilment: 219 of the instance's 469 items are
  requestable.
