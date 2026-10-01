# `health/platform/` — the Platform catalogue pack (Health Assist Phase 6)

The master workbook's 183 Platform rules, running on the **shared rule engine** as
the second *workbook pack*, beside ITOM (`health/itom/`). Both are built by one
factory (`health/itsm/workbook-pack.js`) from data. The scan runs every pack in
`health/packs.js`, so a further module is one entry there, not new wiring.

```
scripts/lib/platform-decisions.mjs ──► scripts/build-workbook-pack.mjs --pack platform ──► rules/platform/*.json + platform/rules/*.json
platform/pack.js          the pack (createWorkbookPack): catalogue, parameters, configs, normalize, engine key
platform/comparators.js   script checks + Platform comparators, merged into the shared library
scoring/platform-v2.js    platform-quality/2 — Platform's first score
scripts/pack-instance-validation.mjs --pack platform   read-only validation on the connected instance
```

## Customer-authored scope (D-024)

The script and design rules judge the records the **customer** created or changed:
those with a customer update in `sys_update_xml` (the platform's own "Customer
Updates", matched by `sys_update_name`). They do not judge the ServiceNow baseline.
On the instance this was built against, 12,897 of 14,654 business rules were
created by `admin`, and nearly all of them are out of the box; 320 carry a customer
update. `sys_created_by` cannot separate the two. The customer list is read once
per table through the aggregate API (the `customer_updates` reader).

## Script analysis

The analysis is static and lexical (`SCRIPT_CHECKS`). Comments are removed and
string literals are set aside before any pattern is tested:

- A pattern inside a comment or string never fires.
- A credential is looked for in literals and assignments.
- A property read (`gs.getProperty`) is not a hard-coded credential.
- A callback-style `getReference` is not synchronous.
- A `setWorkflow(false)` with an explanatory comment is justified.

Code assembled at run time (eval, concatenated strings) is not seen, and every
script rule says so as its stated risk.

## States

| State | Rules |
|---|---|
| executable | 67 |
| unconfigured | 4 |
| undefined (the workbook, or the platform, leaves part of the detection undefined — each says what) | 73 |
| not built (defined; evaluator not written: graphs, schedule expansion, similarity…) | 31 |
| specification gap | 3 |
| object unverified | 2 |
| equivalent (PLT-002 ≡ ITSM-003, PLT-024 ≡ ITSM-011, PLT-170 ≡ CMDB-120) | 3 |

## Validated on a real instance (Phase 6D)

`rules/platform/instance-validation.json` records the read-only run on
techsnitchpvtltddemo2: every named table exists, and every choice label resolves.
That run caused five corrections:

- `sys_ui_policy` and `sys_data_policy2` have no `name` field.
- On-demand jobs never run by design and are not charged.
- Duplicate onChange scripts and UI-policy mandatory fields count only where the
  customer authored a script or policy (D-024).
- SLA condition fields are probed once per table.
- The customer list comes through the aggregate API.
