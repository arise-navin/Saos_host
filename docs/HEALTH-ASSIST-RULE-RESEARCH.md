# Health Assist — research on the rules that do not run

Date: 2026-09-25. Scope: every rule of every module that is not executable today (339 rules).
Method: ServiceNow product documentation and the ServiceNow Community (sources below), checked against a
read-only probe of the validation instance (techsnitchpvtltddemo2, Zurich patch 10). Nothing was changed on the instance.

## Summary

| Category | Meaning | ITSM | ITOM | Platform | Enterprise DQ | CSDM | Total |
|---|---|---:|---:|---:|---:|---:|---:|
| **A** | Answered by ServiceNow documentation or the instance's own configuration — can be built now | 21 | 5 | 15 | 6 | 1 | 48 |
| **B** | Fully specified; only engineering is missing (the data is readable) — can be built now | 5 | 20 | 35 | 4 | 10 | 74 |
| **C** | Needs a value only the customer can give (a policy, a list, a mapping) | 6 | 9 | 8 | 8 | 7 | 38 |
| **D** | Needs a number the workbook leaves "configurable" and ServiceNow does not publish | 19 | 24 | 24 | 2 | 5 | 74 |
| **E** | The product is not installed or not in use on this instance — runs where it is | 9 | 17 | 1 | 0 | 0 | 27 |
| **F** | Needs outside reference data (ServiceNow release / deprecation lists, cloud provider data) | 0 | 6 | 5 | 0 | 0 | 11 |
| **G** | The platform does not record what the rule needs — cannot be read from any instance | 3 | 28 | 24 | 4 | 4 | 63 |
| **H** | Waiting on a cross-module ownership decision (evaluated once, by the owner) | 0 | 3 | 1 | 0 | 0 | 4 |
| | **Total** | 63 | 112 | 113 | 24 | 27 | 339 |

A and B can be built without anything from you. C and D need a decision (a value from the customer, or a number the
workbook leaves open — or the choice to report those rules as unscored measures). E runs automatically on an instance where
the product is in use. F needs a reference list we would have to maintain. G cannot be evaluated from any instance as the
rule is written — it needs a rewording, a manual input, or retirement. H waits on the ownership decisions already open.

## Findings that unblock many rules at once

1. **Condition evaluation (ITSM-004 family).** Stored conditions are encoded queries; the instance evaluates them itself when the
   same query is passed to the Table API. No evaluator of our own is needed. Unblocks ITSM-004, 091, 137; ITOM-094, 105, 108, 111, 116; PLT-020, 031; DQ-085; CSDM-045, 067.
2. **Out-of-box baseline.** `sys_metadata_customization` lists the customer's modifications to ServiceNow's own records (Washington DC onward). Unblocks PLT-059, 063, 074, 135, 155.
3. **Per-script timing.** `sys_script_pattern` (Slow Scripts) records count, average and total per script, keyed by the script record and table. Unblocks PLT-052, 053, 057, 173. It cannot prove a rule never ran (PLT-056 stays G).
4. **Personal data.** The instance's own field classification (D-032) also answers PLT-126, 127, 128. ServiceNow ships no PAN / Aadhaar pattern, so DQ-133 / 137 / 139 need you to approve the government-published formats.
5. **Platform values.** MID heartbeat 5 minutes; incident auto-close `glide.ui.autoclose.time`; change freeze = blackout schedule; change conflict `change.conflict.*`; approval routing = change approval policies; KB review date = `valid_to`; asset ↔ CI states = `alm_asset_ci_state_mapping`; model EOL = `cmdb_model_lifecycle`; phone formats = `sys_phone_territory`; service accounts = `web_service_access_only`; impersonation = `impersonation.start` events; staleness = `cmdb_health_staleness_rule`.
6. **Products not in use here.** Major Incident Management is inactive (9 ITSM rules); Cloud Provisioning tables are empty (10 ITOM rules); no cloud service accounts (5 ITOM rules). These are built to run where the product is present and report "not applicable" here.

## ITSM

| Rule | Category | What the research found | Sources |
|---|:-:|---|---|
| ITSM-004 — Assignment rules absent, so routing is fully manual | B | Assignment-rule conditions are encoded queries (sysrule_assignment, 63 on the instance). The instance can evaluate them itself: count the incidents in the window that match each rule's condition through the Table API; those matched by none are the finding. | S18 INST |
| ITSM-007 — Auto-close duration set so short that resolution verification is impossible | A | The duration is the property glide.ui.autoclose.time (days; OOB default 7; instance 7). Workbook: minimum 3 business days. Judge the property against 3 days. | S1 INST |
| ITSM-008 — Resolution code list with a dominant catch-all value ("Other", "Resolved") | C | The OOB close codes (instance): Solution provided, Workaround provided, Resolved by caller / change / problem / request, Known error, Duplicate, User error, No resolution provided. None is "Other"; which count as catch-alls is the customer's call ("No resolution provided" is the closest). | INST |
| ITSM-010 — Mandatory fields enforced at the wrong state (too late to be useful) | C | UI policies and data policies are readable (sys_ui_policy, sys_data_policy2); the field → stage at which each must be mandatory is the customer's process. | INST |
| ITSM-013 — Custom incident states added without corresponding SLA handling | A | The standard incident states are New 1, In Progress 2, On Hold 3, Resolved 6, Closed 7, Canceled 8 (instance choice list = the OOB set). Any other active state is custom; check whether any SLA definition condition names it. | S1 INST |
| ITSM-015 — Knowledge suggestion not enabled on incident | A | Knowledge suggestion on incident = a Contextual Search configuration for the incident table (cxs_table_config; 87 on the instance). Fires only where published articles exist. | S20 INST |
| ITSM-022 — Caller field populated with a service account or generic user | D | Service accounts are identified by the platform: sys_user.web_service_access_only / internal_integration_user (no naming pattern needed). Still missing: the caller-volume threshold. | S8 INST |
| ITSM-023 — Short description duplicated across large volumes (template pasting) | D | Share of volume one identical short description must reach — no ServiceNow value. | — |
| ITSM-024 — Category not matching the resolution code pattern for that category | D | The statistic, anomaly threshold and minimum volume per category — no ServiceNow value. | — |
| ITSM-025 — Close code and close notes inconsistent | D | Per-close-code consistency rules "derived from the estate" — no method or threshold given. | — |
| ITSM-027 — Attachment-only resolution with no text record | D | Attachment-to-resolution timing window — no ServiceNow value. | — |
| ITSM-031 — Auto-close used as the primary closure mechanism (resolution never verified) | A | The OOB auto-close business rule closes the incident as the system and writes "Incident automatically closed after N days in the Resolved state."; that marker identifies an auto-closure. Workbook default 70%. | S1 |
| ITSM-034 — SLA paused or cancelled at abnormal rates (gaming) | B | task_sla pause / cancel per assignment group against the estate mean (workbook: 2×). Only the aggregate is missing. | — |
| ITSM-035 — Resolution time distribution with a spike immediately before SLA expiry | D | The interval before breach to examine and its expected density — not defined. | — |
| ITSM-037 — Backlog ageing beyond threshold by priority | D | P1–P3 ages are given (2 / 5 / 15 days); P4 and P5 are not. Option: run P1–P3 now, leave P4 / P5 unjudged. | — |
| ITSM-038 — P1 raised manually where automated conditions existed | A | An automatically raised incident is one referenced by an alert (em_alert.incident, set by Event Management alert rules). Manual = a P1 with no alert. Workbook window 30 minutes. | INST |
| ITSM-040 — Incidents created by the same caller repeatedly for the same issue (unresolved root cause) | D | Similarity threshold and repeat count — no ServiceNow value. | — |
| ITSM-045 — No major incident process configured despite P1 volume | E | Major Incident Management (com.snc.incident.mim) is INACTIVE on the instance, so major_incident_state does not exist. Build against major_incident_state; not applicable here. | S7 INST |
| ITSM-046 — Major incident raised with no communication plan or task | E | MIM inactive. Communication plans: comm_plan (Incident Communication Management) — table exists, 0 rows. | S7 INST |
| ITSM-047 — Major incident closed with no post-incident review | E | MIM inactive. The PIR is produced by MIM (post-incident report); no review table exists on this instance. | S7 INST |
| ITSM-048 — Major incident with no linked Problem record | E | MIM inactive; when active: accepted major incidents with problem_id empty. | S7 INST |
| ITSM-049 — Major incident with no affected service populated | E | MIM inactive; when active: accepted major incidents with business_service empty. | S7 INST |
| ITSM-050 — Major incident timeline gaps (no updates for extended periods) | E | MIM inactive; when active: journal gaps > 30 min (workbook default) while major_incident_state = accepted. | S7 INST |
| ITSM-051 — Major incident candidate criteria never triggering | E | MIM inactive; when active: P1s present and none ever proposed. | S7 INST |
| ITSM-052 — Post-incident review actions created but never closed | E | MIM inactive; PIR action records not established even when active. | S7 INST |
| ITSM-054 — Recurring incident patterns with no corresponding Problem record | D | Cluster volume and similarity thresholds — no ServiceNow value. | — |
| ITSM-055 — P1 and major incidents with no Problem raised | E | MIM inactive; the P1 half can run now (P1 with no problem_id). | S7 INST |
| ITSM-058 — Top ten incident clusters by short-description similarity with no Problem | D | N = 10 is given; the similarity threshold is not. | — |
| ITSM-059 — Problem raised only by one group (process not adopted estate-wide) | D | "Far exceeds" — no ratio given. | — |
| ITSM-066 — Known Error records not published to knowledge | A | A known error's article is linked through kb_knowledge.source (the problem) — the OOB "Communicate Workaround / Create Knowledge" path; seen on the instance. | INST |
| ITSM-071 — Problem with no linked Change where a fix was clearly required | C | Which close codes / text mean "a fix was required" — customer classification. | — |
| ITSM-073 — Problem priority not aligned to the aggregate impact of linked incidents | C | The problem-priority vs incident-impact matrix — customer policy. | — |
| ITSM-074 — Incident volume for a resolved Problem not declining post-closure (fix ineffective) | D | Window 90 days given; the decline threshold is not. | — |
| ITSM-076 — Known Error articles with no views or no linkage from incidents | B | Views: kb_knowledge.sys_view_count; incident linkage: m2m_kb_task. Window 90 days given. | INST |
| ITSM-078 — Permanent fix implemented but no validation recorded | G | No platform field records validation of a permanent fix. | — |
| ITSM-081 — Approval routing with no defined approver group for a change type | A | Approval routing = change approval policies (chg_policy 6, chg_approval_def 8 on the instance). A change type with volume whose policy yields no approval definition is the finding. | S3 INST |
| ITSM-084 — No conflict detection configured | A | Conflict detection is configured by change.conflict.* properties (instance: mode advanced, blackout / currentci / currentwindow true). Report both cases; the second is ITSM-138. | S2 INST |
| ITSM-086 — Emergency change path with the same approval requirements as Normal (so it gets bypassed) | A | Compare the Emergency and Normal change policies' decisions and approval definitions (chg_policy / chg_approval_def). | S3 INST |
| ITSM-087 — Change model states allowing closure without implementation evidence | A | Change model state transitions are records (sttrm_state_transition; chg_model.implementation_states). A model with a transition into Closed that skips its implementation states is the finding. | S4 INST |
| ITSM-089 — Standard change templates with no expiry or review date | A | ServiceNow templates have no expiry or review-date field. The review evidence the platform keeps is the template version (std_change_producer_version); workbook default review period 12 months → a current version older than 12 months. | S5 INST |
| ITSM-091 — Change types customised without corresponding approval logic | B | OOB types are Normal, Standard, Emergency (+ Model on the instance). A custom type with volume and no policy decision covering it — needs the condition evaluation of ITSM-004. | S3 S18 INST |
| ITSM-092 — No post-implementation review step for high-risk changes | A | High risk = the platform's own High (and Very High where present) risk values. The PIR evidence is change_request.review_status / review_date / review_comments. | INST |
| ITSM-093 — Change calendar not published or not consumed | A | Change Schedule (com.snc.change_management.soc) active on the instance → the configured half runs. "Consumed" needs access logs the workbook qualifies with "where log data is available" (not readable) — reported, not judged. | INST |
| ITSM-098 — Test plan empty on high-risk changes | A | High risk = the platform's High / Very High risk values; test_plan empty. | INST |
| ITSM-104 — Backout plan text identical across many changes (template pasting) | D | Share of change volume one identical backout plan must reach — no ServiceNow value. | — |
| ITSM-105 — Affected CI list containing a single CI where the change clearly spans more | D | "Clearly spans" — scope inference not defined. | — |
| ITSM-106 — Unauthorised change rate — CI modified with no corresponding approved change | C | Change-controlled classes are the customer's policy; correlation window not given. | — |
| ITSM-110 — Approval granted outside the approver's authority level | C | The authority matrix is the customer's delegation policy. | — |
| ITSM-114 — Failed change rate with no corresponding backout executed | G | OOB change_task_type values are planning / implementation / testing / review — the platform records no backout execution. | INST |
| ITSM-115 — Changes closed as Successful with a linked incident created within the window | A | Dependency depth = the platform's impact depth glide.relationship.max_depth, default 10 (as D-032 for CSDM-058). Window 72 h given. | INST |
| ITSM-117 — Standard change used for work that meets Normal change criteria | D | "Meets Normal criteria" from the template definition — not defined. | — |
| ITSM-118 — Conflict detected but overridden with no justification | A | change_request.conflict_status = Conflict on changes that went ahead is detectable; the platform has no override-justification field, so "no justification" is every such change — reported as such. | S2 INST |
| ITSM-122 — Change closed without post-implementation review where required | A | As ITSM-092: High / Very High risk with review_status empty at closure. | INST |
| ITSM-126 — Changes to CIs supporting Business Critical services with no service reference populated | A | Depth = glide.relationship.max_depth (default 10); Business Critical = busines_criticality "1 - most critical" (the platform's top value). | INST |
| ITSM-127 — Change freeze periods with change activity anyway | A | ServiceNow's freeze is the blackout schedule (cmn_schedule_blackout; 2 on the instance). Changes whose planned window falls in a blackout span. | S6 INST |
| ITSM-128 — Incidents resolved with a resolution code indicating change causation, but no change linked | A | The OOB close code "Resolved by change" is the change-causation code (instance choice list). | INST |
| ITSM-129 — Incident, Problem and Change all failing to reference the CMDB — the three processes operating blind | D | The problem-process threshold (016 and 094 carry their own) — not given. | — |
| ITSM-131 — Change risk assessment computed without CMDB dependency data | D | Depth threshold for "computed without dependency data" — not given. | — |
| ITSM-132 — Recurring incidents on CIs whose CMDB data is stale, traced to a discovery failure | G | Depends on ITOM-147, which needs per-credential failure records the platform does not keep. | — |
| ITSM-133 — Business Critical service with high incident volume and no Problem records | D | Volume relative to the service population — no threshold. | — |
| ITSM-135 — CI owner and incident assignment group inconsistent | D | Dominance threshold and minimum volume per CI — no ServiceNow value. | — |
| ITSM-137 — SLA attached to a service with no offering (commitment structurally unenforceable) | B | Needs the condition evaluation of ITSM-004 (SLA start conditions naming a service). | S18 |
| ITSM-138 — Change conflict detection producing no results because relationships are missing | A | Changes with conflict_status "No Conflict" whose CIs have no relationships — conflict detection could not see dependencies. | S2 INST |

## ITOM

| Rule | Category | What the research found | Sources |
|---|:-:|---|---|
| ITOM-005 — Schedule inactive but never deleted, with its range still live | D | "Recent" window and staleness test — not given. | — |
| ITOM-007 — Schedule interval longer than CI staleness threshold (guaranteed stale data) | A | Per-class staleness is ServiceNow's CMDB Health staleness rules (cmdb_health_staleness_rule). Compare each schedule interval with the tightest rule among the classes it discovers. | S19 INST |
| ITOM-008 — Schedule assigned to a MID with no network route to its range | G | Device history does not classify an outcome as a connection-level failure. | — |
| ITOM-012 — Shazzam batch size or concurrency tuned beyond safe limits for the MID | D | MID capability derivation not given. | — |
| ITOM-013 — Schedule window colliding with backup or change-freeze window | B | Expand each schedule's run window and intersect with blackout / maintenance spans (both readable). | S6 |
| ITOM-015 — Credential failure rate above threshold on a range for N consecutive days | G | No record of each failed attempt per credential (only affinity on success). | — |
| ITOM-016 — No credential of the required type exists for a range containing devices of that type | D | Port-signature → device-type mapping not given. | — |
| ITOM-017 — Credential authentication failing (the rotation case) | G | As ITOM-015. | — |
| ITOM-018 — Credential expired or inactive but still referenced by a schedule | G | Discovery schedules do not reference credentials on the platform. | — |
| ITOM-019 — Credential affinity absent for a range, so every run re-tries the full ladder | D | Window of successful discoveries — not given. | — |
| ITOM-021 — Credential order causing high-privilege credentials to be tried first | C | Credential privilege classification — customer's. | — |
| ITOM-022 — Single credential scoped far wider than necessary (blast radius on compromise) | G | Credentials scope by MID / tag, not by address range. | — |
| ITOM-023 — Credential type mismatched to the devices in range (SSH credential on a Windows range) | D | As ITOM-016. | — |
| ITOM-024 — Credential stored outside the credential vault or with vault integration disabled | H | Owned by PLT-139 (OWN-005). | — |
| ITOM-025 — Credential last updated beyond the organisation's rotation policy | C | Rotation period from the customer's policy (the workbook forbids assuming one). | — |
| ITOM-032 — Run completing with error count above threshold | D | Window of runs — not given (10% is). | — |
| ITOM-033 — Run not completing within its window | D | Window — not given. | — |
| ITOM-034 — Timeouts clustered on a specific MID or subnet | G | No "timeout" classification of outcomes. | — |
| ITOM-035 — Devices discovered but producing no CI (sensor failure) | G | Exploration is recorded only by the CI written. | — |
| ITOM-036 — ECC queue input backlog beyond threshold | D | ECC input age threshold — ServiceNow publishes none. | — |
| ITOM-037 — ECC queue output processing lag | D | ECC output lag threshold — ServiceNow publishes none. | — |
| ITOM-038 — Discovery log error volume trending up | D | Error class and trend test — not given; also needs stored scan history. | — |
| ITOM-040 — Discovery status records accumulating without cleanup | D | Row-count threshold — not given. | — |
| ITOM-041 — Custom pattern overriding OOB with lower success rate | B | Pattern runs are logged in sa_discovery_log (OOB table cleaner keeps 90 days; 0 rows on the instance) — build the read; no data here. | INST |
| ITOM-042 — Pattern with zero successful executions in the window | B | CORRECTED during the build: sa_ci_to_pattern maps a pattern to the CI TYPES it creates, not to executed CIs. Execution evidence is sa_discovery_log (pattern_name, status), empty on the instance, with undocumented status values. | INST |
| ITOM-043 — Pattern failing repeatedly on the same device class | B | As ITOM-041 (60% / min 20 given). | INST |
| ITOM-044 — Pattern steps timing out consistently | B | As ITOM-041 (30% / min 20 given). | INST |
| ITOM-045 — Deprecated probes still referenced by active schedules | G | No deprecation marker on probe definitions. | — |
| ITOM-046 — Pattern version behind the instance version after upgrade | F | Pattern versions shipped per family — external. | — |
| ITOM-047 — Custom pattern with no version control or documentation | G | sa_pattern has no description or owner field. | — |
| ITOM-048 — Pattern producing CIs that IRE then duplicates | B | Duplicates are flagged by IRE (duplicate_of, reconcile_duplicate_task) and each CI's sources are in sys_object_source / discovery_source — join them. (None on the instance.) | S15 INST |
| ITOM-049 — Sensor script errors | D | Error ratio relative to execution volume — not given. | — |
| ITOM-050 — Unused custom patterns never retired | B | As ITOM-042 (corrected); the 180-day window also exceeds the 90-day table cleaner of the log. | INST |
| ITOM-053 — MID down or in a degraded state | A | Heartbeat every 5 minutes (ServiceNow) × 3 tolerance (workbook) = 15 minutes on ecc_agent.last_refreshed / status. | S9 INST |
| ITOM-056 — MID certificate expired or expiring within 30 days | E | MID certificates matter only with mutual authentication (ecc_agent.is_using_mutual_auth — false on both MIDs here). | INST |
| ITOM-057 — MID capability mismatched to assigned work | D | Capability per work type — not given. | — |
| ITOM-059 — MID issue count rising | D | Trend test not given; needs stored history. | — |
| ITOM-060 — MID host resource exhaustion indicators (heap, thread, disk) | G | MID resource limits live on the MID host. | — |
| ITOM-061 — MID last refreshed beyond threshold | A | As ITOM-053. | S9 INST |
| ITOM-064 — MID not on a supported JVM or OS version | F | JVM: the MID runs ServiceNow's bundled JRE (jvm_version "17.0.15-sncmid1") — supported by definition; the OS support matrix is external. | INST |
| ITOM-065 — MID log rotation not configured | G | Log rotation is set in the MID wrapper on the host. | — |
| ITOM-069 — Maps built manually where automated mapping is available and licensed | F | Licensing and pattern coverage per stack — not readable. | — |
| ITOM-070 — Entry point unreachable or failing | G | No mapping-run outcome on the entry point. | — |
| ITOM-071 — Map last refreshed beyond interval | G | No map refresh history. | — |
| ITOM-072 — Map returning fewer CIs than the previous run (silent map collapse) | G | No map refresh history. | — |
| ITOM-073 — Map contradicting cmdb\_rel\_ci relationships | G | No separate map-edge object. | — |
| ITOM-075 — Map producing CIs that IRE then duplicates | B | As ITOM-048. | S15 |
| ITOM-076 — Map incomplete — traversal terminating before reaching infrastructure tier | D | Tier-model derivation not given. | — |
| ITOM-078 — Map with unresolved or unmatched CIs | G | No mapping-run output object. | — |
| ITOM-079 — Tag-based service definitions with no refresh schedule | E | No tag-based services on the instance (cmdb_ci_service_by_tags 0). | INST |
| ITOM-080 — Manual map with no review since creation | G | No map creation method / review history. | — |
| ITOM-081 — Map discovery credentials failing for mapping-specific access | G | No mapping-run credential errors. | — |
| ITOM-082 — Entry point defined but no corresponding traffic-based validation | E | Traffic-based collection not in use. | — |
| ITOM-085 — Monitoring tool in the estate with no connector at all (blind spot) | D | Tool-detection matching not given. | — |
| ITOM-087 — Event ingestion volume dropped sharply (source silently stopped) | D | Baseline length and weekday handling not given. | — |
| ITOM-088 — Event ingestion volume spiking beyond processing capacity | G | No processing-capacity / discard object. | — |
| ITOM-089 — Connector credentials failing | G | Connector last error is free text. | — |
| ITOM-090 — Connector instance inactive but source still live | D | Liveness evidence not defined. | — |
| ITOM-092 — Events discarded due to processing limits | G | No discard counts. | — |
| ITOM-093 — Connector with no error handling or retry configuration | H | OWN-009 (with PLT-141). | — |
| ITOM-094 — No match rule exists for a CI class set receiving events | B | The instance evaluates each rule's condition over the events per class (as ITSM-004). | S18 |
| ITOM-095 — Overall CI binding success rate below threshold | D | Window — not given (85% is). | — |
| ITOM-097 — Match rule using name-only criteria with no class filter | C | Name-type attribute classification — customer's. | — |
| ITOM-099 — Events binding to the wrong CI of a duplicate pair | B | As ITOM-048. | S15 |
| ITOM-100 — Match rule with no precedence between multiple candidates | G | No precedence configuration on match rules. | — |
| ITOM-102 — Match rule order producing weak matches first | C | Attribute strength classification — customer's. | — |
| ITOM-103 — Node values arriving in a format no match rule handles | D | Format classification per rule — not readable. | — |
| ITOM-104 — Bound CI in a class that cannot participate in impact calculation | G | Impact class set not established. | — |
| ITOM-105 — Match rule defined but disabled | B | As ITOM-094. | S18 |
| ITOM-108 — Alert with no assignment and no notification path | B | Notification conditions evaluated by the instance (as ITSM-004). | S18 |
| ITOM-111 — Alerts with no matching alert rule, so no action ever fires | B | Alert rule alert_filter evaluated by the instance. | S18 |
| ITOM-112 — Alert rules firing but with no configured action | A | A rule's actions are records: em_alert_management_action (39 on the instance), executions in em_alert_management_execution. | INST |
| ITOM-113 — Deduplication not occurring — alert count tracking event count one to one | A | em_alert.event_count holds the events deduplicated into each alert; ratio alerts / events over the alerts in scope (workbook 0.8). | INST |
| ITOM-114 — Alert correlation rules absent for known parent-child device patterns | C | Co-occurrence threshold — customer's. | — |
| ITOM-116 — Alert-to-incident creation not configured for Critical severities | B | As ITOM-111. | S18 |
| ITOM-119 — Alerts never actioned and auto-closed by age | G | No field records "closed by age". | — |
| ITOM-120 — Cloud account present in the organisation with no service account registered | D | Account evidence matching not given. | — |
| ITOM-121 — Cloud discovery coverage below threshold vs. known subscriptions or accounts | E | No cloud service accounts on the instance (cmdb_ci_cloud_service_account 0). | INST |
| ITOM-122 — Cloud CIs and on-prem CIs modelled in inconsistent classes | C | Cloud ↔ on-prem class mapping — customer's. | — |
| ITOM-123 — Cloud service account credentials failing or expired | E | As ITOM-121. | INST |
| ITOM-125 — Cloud resources discovered but not linked to any application service | C | Which cloud classes should be in the service model — customer's. | — |
| ITOM-126 — Cloud API rate limiting causing incomplete collection | G | Rate-limit responses not recorded as such. | — |
| ITOM-127 — Regions or subscriptions excluded from the schedule without justification | E | As ITOM-121. | INST |
| ITOM-128 — Cloud service account with excessive IAM permissions | F | Cloud IAM — external. | — |
| ITOM-129 — Cloud CIs going stale — resource terminated in cloud, still Operational in CMDB | E | As ITOM-121. | INST |
| ITOM-130 — Tag-based classification failing or tags missing on cloud resources | C | Required tag set — customer's policy. | — |
| ITOM-131 — Cloud resource cost attributes not collected | F | Cost-collection availability per provider — external. | — |
| ITOM-132 — Multi-cloud accounts with inconsistent discovery intervals | D | Variance threshold — not given. | — |
| ITOM-133 — Cloud discovery duplicating CIs already found by agent-based discovery | B | As ITOM-048. | S15 |
| ITOM-134 — Provisioning path exists that bypasses CMDB registration entirely | E | Cloud Provisioning tables exist (sn_cmp_*) but are empty — not in use. | INST |
| ITOM-135 — Resources provisioned outside ServiceNow with no reconciliation back (shadow estate) | E | As ITOM-134. | INST |
| ITOM-136 — No policy enforcement on provisioning requests | E | As ITOM-134. | INST |
| ITOM-137 — Provisioned resources with no owner or cost centre | E | As ITOM-134. | INST |
| ITOM-138 — Provisioning failures with orphaned partial resources left running | E | As ITOM-134. | INST |
| ITOM-139 — Blueprints or templates referencing deprecated images or sizes | F | Provider deprecation data — external. | — |
| ITOM-140 — Decommission workflow not retiring the corresponding CI | E | As ITOM-134. | INST |
| ITOM-141 — Quota or budget policy defined but not enforced | E | As ITOM-134. | INST |
| ITOM-142 — Provisioning approvals routed to inactive users or empty groups | H | OWN-008. | — |
| ITOM-143 — Untagged resources not blocked at provisioning time | E | As ITOM-134. | INST |
| ITOM-144 — Blueprint drift — deployed configuration differing from the template | D | Comparison set and tolerance — not given. | — |
| ITOM-145 — No lease or expiry on non-production provisioned resources | E | As ITOM-134. | INST |
| ITOM-146 — Provisioning catalogue items with no owner | C | Which catalogue items are provisioning items — customer's. | — |
| ITOM-147 — Credential failure on a range directly causing CI staleness, with the affected CI count attached | G | As ITOM-015. | — |
| ITOM-148 — Discovery failure causing relationship collapse, quantified | B | Attribute audited cmdb_rel_ci deletions to failed discovery windows (sys_audit_delete; opt-in read). | — |
| ITOM-149 — Weak identification rule plus a monitoring integration jointly producing duplicates | B | As ITOM-048. | S15 |
| ITOM-150 — Alert binding to the duplicate CI that carries no relationships | B | As ITOM-048. | S15 |
| ITOM-151 — Service map incomplete because the underlying discovery failed on that tier | G | No separate map topology. | — |
| ITOM-152 — Business Critical service whose impact calculation cannot return a result, traced to a specific ITOM cause | B | Traverse each critical service; cross-domain link to the ITOM finding at the break point. | — |
| ITOM-153 — MID outage window correlating with a relationship deletion window | G | No MID availability history (only current status). | — |
| ITOM-154 — Event flood correlating with a discovery reclassification loop | D | Correlation window — not given. | — |
| ITOM-155 — Cloud resource terminated but CI still Operational and still on a service map | E | As ITOM-121. | INST |
| ITOM-156 — Discovery schedule missing location, causing N CIs to have no location, breaking M routing rules | B | Attribute CIs to their location-less schedule; count rules whose conditions reference location. | — |

## Platform

| Rule | Category | What the research found | Sources |
|---|:-:|---|---|
| PLT-001 — SLA definitions with no schedule attached (24x7 applied unintentionally) | G | Whether 24×7 was intended is not recorded. | — |
| PLT-003 — SLA definitions where start, pause and stop conditions can never be simultaneously satisfiable | G | No reachable-state map for task tables. | — |
| PLT-006 — Start condition matching on insert only, missing records that qualify later | G | Insert-only timing is not a field of contract_sla. | — |
| PLT-007 — Stop condition not covering all resolution or closure states | A | Terminal states are the platform's own: incident Resolved 6 / Closed 7 / Canceled 8, etc. (choice lists). A stop condition missing one is the finding. | INST |
| PLT-008 — Pause condition with no corresponding resume path (SLA pauses permanently) | B | Read when_to_resume / resume_condition per definition and join paused task_sla. | — |
| PLT-009 — Duration defined in calendar time where business time was intended | G | "Intended" business time is not recorded. | — |
| PLT-010 — Retroactive start not configured where the process requires it | G | The triggering event's time is not recorded. | — |
| PLT-011 — SLA workflow attached but never executing | B | Join each definition's flow / workflow to its executions. | — |
| PLT-015 — Timezone handling inconsistent between schedule and duration | D | "Multi-timezone estate" not defined. | — |
| PLT-017 — Task SLA records stuck in In Progress beyond maximum possible duration | B | Maximum duration by schedule expansion. | — |
| PLT-019 — SLA attached to records it should not apply to | G | Intended scope is not readable. | — |
| PLT-020 — Records that should carry an SLA carrying none | B | Start conditions evaluated by the instance (as ITSM-004). | S18 |
| PLT-022 — SLA repair or recalculation jobs run manually and frequently | G | No execution record of SLA repair. | — |
| PLT-023 — task\_sla table growth disproportionate to task volume | D | Expected ratio derivation not given. | — |
| PLT-026 — SLA attached to closed records still updating | D | Tolerance after closure not given. | — |
| PLT-030 — Commitment targets inconsistent with the SLA duration configured to enforce them | B | Effective duration by schedule expansion. | — |
| PLT-031 — Business Critical services with no SLA coverage on any priority | B | As PLT-020. | S18 |
| PLT-032 — SLA reporting based on a different definition than the one contractually committed | G | Report → SLA definition linkage not readable. | — |
| PLT-033 — Business rules on high-volume tables with no condition (fire on every operation) | D | Volume threshold "configurable". | — |
| PLT-036 — Synchronous processing that should be asynchronous (before/after where async fits) | C | Operation classification — customer's. | — |
| PLT-039 — Query with no setLimit on an unbounded table | B | Row threshold 100,000 given; resolve each query's table and count. | — |
| PLT-041 — Rule ordering causing dependent rules to execute before their prerequisite | B | Field read/write analysis across rules on one table. | — |
| PLT-043 — Business rule duplicating logic already in a flow, workflow, or another rule | D | Overlap threshold "configurable". | — |
| PLT-045 — Recursive rule triggering itself through its own update | B | Match write targets against the rule's own condition. | — |
| PLT-052 — Rules contributing measurably to slow transactions, ranked by total time | A | ServiceNow records script timing per script in sys_script_pattern (Slow Scripts; script_source + table sys_script = business rule; count, average, total). Rank by total; 95th percentile given. | S10 INST |
| PLT-053 — Rule execution count disproportionate to table activity | A | Execution count per rule from sys_script_pattern against the table's record activity (2× given). Caveat: only scripts the Slow Scripts log has seen. | S10 INST |
| PLT-054 — Rules throwing errors in the log, by frequency | G | Log errors are not attributed to their rule. | — |
| PLT-055 — Rules on tables with high record volume and high update frequency | D | Both thresholds "configurable". | — |
| PLT-056 — Rules active but with zero execution in the observation window | G | Absence from the Slow Scripts log does not prove zero executions. | S10 |
| PLT-057 — Rules modified within the last N days correlating with performance degradation | A | Rules updated within N days (sys_update_version) whose sys_script_pattern timing rose. Window must be chosen (D) — runs with the 90-day window used elsewhere only if you agree. | S10 |
| PLT-058 — Business rules created in global scope where a scoped app exists | D | Ownership inference not defined. | — |
| PLT-059 — Rules modifying OOB tables without a scoped application boundary | A | The out-of-box baseline is sys_metadata_customization (the customer's changes to OOB records) — read against the OOB table set. | S11 INST |
| PLT-060 — Rules created directly in production (no update set lineage) | C | Deployment windows — customer's. | — |
| PLT-062 — Rules with no linked change record | G | No update set → change link on the platform. | — |
| PLT-063 — Rules overriding OOB rules of the same name | A | As PLT-059. | S11 |
| PLT-064 — Rule count growth trend per table | B | Needs stored scan history (the app keeps it; build the series). | — |
| PLT-066 — Script Include accessible from all application scopes unnecessarily | B | Caller analysis across scripts. | — |
| PLT-067 — Script Include with no access restriction performing privileged operations | C | Privileged operation set — customer's. | — |
| PLT-068 — Duplicate Script Includes with near-identical logic | B | Pairwise similarity (0.85 given). | — |
| PLT-069 — Script Include never referenced by anything | B | Reference detection (180 days given). | — |
| PLT-071 — Recursive or deeply nested include chains | B | Include call graph (depth 5 given). | — |
| PLT-073 — Script Include throwing uncaught exceptions | G | Errors not attributed to their include. | — |
| PLT-074 — Overriding an OOB Script Include | A | As PLT-059. | S11 |
| PLT-078 — Client script duplicating logic available in a UI Policy | C | As PLT-036. | — |
| PLT-081 — Client script referencing fields not present on the form | B | Form layout per view (sys_ui_element). | — |
| PLT-082 — Client script not compatible with the current UI framework | F | Deprecated client API list — external. | — |
| PLT-083 — Client-side validation with no matching server-side enforcement | B | Field-level comparison. | — |
| PLT-085 — Conflicting UI Policies on the same field | B | Conflict matrix over policy actions. | — |
| PLT-087 — UI Policy with a script where declarative configuration suffices | C | As PLT-036. | — |
| PLT-089 — Data Policy inactive but relied upon by process documentation | G | No documentation linkage. | — |
| PLT-091 — Three generations of automation (business rule, workflow, flow) performing the same function | D | Overlap analysis not defined. | — |
| PLT-092 — Legacy Workflow still active where Flow Designer equivalents exist | D | Equivalence assessment not defined. | — |
| PLT-093 — Flows and workflows both triggering on the same table and condition | B | Flow triggers (sys_hub_trigger_instance_v2) vs workflow conditions. | INST |
| PLT-094 — Flow with no error handling path | B | Step error handling is recorded (sys_hub_step_instance.error_handling_type). | INST |
| PLT-095 — Flow referencing a deleted or inactive object | B | Resolve step input references. | — |
| PLT-098 — Flow triggered on every insert with no condition | B | Record-created triggers and their conditions. | INST |
| PLT-099 — Subflow recursion | B | Subflow call graph. | — |
| PLT-100 — Flow with hardcoded credentials or endpoints | B | Scan action inputs (pattern set = the credential patterns already used by PLT-045 family). | — |
| PLT-102 — Orphaned flows with no trigger and no caller | B | Triggers and subflow callers. | — |
| PLT-104 — Flow performing synchronous integration calls in a user-facing path | G | "User-facing" trigger not established. | — |
| PLT-105 — Long-running flow contexts accumulating in the context table | B | Context growth from stored history. | — |
| PLT-107 — Jobs clustered in the same window causing contention | D | Concurrency threshold "configurable". | — |
| PLT-108 — Job with a query that scans an unbounded table | B | As PLT-039. | — |
| PLT-109 — Job execution duration trending upward toward its interval | G | sys_trigger keeps only the last run. | — |
| PLT-114 — Job running more frequently than its output is consumed | G | Consumption method not given. | — |
| PLT-116 — Events registered with no script action or notification consuming them | B | Join events to script actions / notifications. | — |
| PLT-118 — sys\_trigger backlog growing | D | Backlog threshold "configurable". | — |
| PLT-119 — Async job queue processing lag | B | Async jobs are sys_trigger rows (ASYNC jobs) past next_action; 15-minute default given. | INST |
| PLT-122 — Tables with no ACL coverage at all | B | ACL coverage with inheritance. | — |
| PLT-123 — Elevated privilege granted with no approval or change trail | C | Elevated role set and window — customer's. | — |
| PLT-124 — Role nesting producing unintended effective permissions | C | As PLT-123. | — |
| PLT-126 — Write ACL absent where read ACL exists on sensitive tables | A | Sensitive tables / fields = the instance's data classification (m2m_dictionary_dataclass), as D-032. | S17 INST |
| PLT-127 — ACLs on sensitive fields (financial, personal, credential) missing | A | As PLT-126. | S17 |
| PLT-128 — snc\_internal or public-facing access on tables holding personal data | A | As PLT-126. | S17 |
| PLT-131 — Roles granted directly to users rather than via groups | D | Direct-grant share — no threshold. | — |
| PLT-134 — No access recertification or review process evidenced | E | Access certification is a separate product (not installed); cert_* here certifies CI data, not role grants. | INST |
| PLT-135 — ACL overriding an OOB ACL with weaker conditions | A | As PLT-059. | S11 |
| PLT-136 — Impersonation used in production with no audit review | A | Impersonations are sysevent impersonation.start / .end (parm1 impersonator, parm2 impersonated) — 20+ on the instance. Workbook: any occurrence, volume by impersonator. sysevent keeps ~7 days; "no audit review" is not recorded. | S14 INST |
| PLT-140 — Inbound integration bypassing IRE or Data Policy | G | Inbound write paths not recorded. | — |
| PLT-141 — Integration with no error handling or retry | H | OWN-009. | — |
| PLT-142 — Integration failure rate above threshold | B | Outbound calls are logged in sys_outbound_http_log (response_status) — readable on the instance; 5% given. | INST |
| PLT-143 — Integration with no rate limiting configured | D | Rate-limit → integration matching not defined. | — |
| PLT-146 — Integration writing directly to tables, bypassing business logic | G | Write paths not recorded. | — |
| PLT-147 — Orphaned integrations with no execution in the window | B | As PLT-142 (180 days given; the log is rotated shorter). | INST |
| PLT-149 — Import sets accumulating without cleanup | D | Size threshold "configurable". | — |
| PLT-151 — Transform scripts with unhandled errors | G | Transform errors not attributed. | — |
| PLT-152 — Data source credentials expired | G | Credential expiry not a field of sys_data_source. | — |
| PLT-155 — Modified OOB records count and trend | A | A measure: sys_metadata_customization count by object type — reported, never judged (the workbook gives no threshold). | S11 |
| PLT-156 — Customization concentrated in objects ServiceNow actively develops | F | ServiceNow change frequency per object — external. | — |
| PLT-157 — Instance more than two families behind current | F | The instance family is readable (glide.war = Zurich); the CURRENT family is external. Option: a dated reference list we maintain. | INST |
| PLT-158 — Global scope customization where scoped apps should be used | D | Grouping not defined. | — |
| PLT-159 — Custom tables extending task or cmdb\_ci without justification | D | Usage assessment not defined. | — |
| PLT-160 — Custom fields on OOB tables, unpopulated | B | Population per custom field (5% given). | — |
| PLT-161 — Custom fields duplicating OOB field function | D | Semantic matching not defined. | — |
| PLT-162 — Deprecated API usage in scripts | F | Deprecated API list — external. | — |
| PLT-163 — Deprecated plugin still active | F | Plugin deprecation not in v_plugin — external. | — |
| PLT-165 — Update sets unclosed, stuck in preview, or with collisions | D | Age thresholds "configurable". | — |
| PLT-166 — Changes made directly in production with no update set lineage | C | Creation window — customer's. | — |
| PLT-167 — Cross-scope access requests granted broadly | D | Breadth from usage not defined. | — |
| PLT-168 — Custom application with no owner or no source control | G | Owner / source control not fields of sys_app. | — |
| PLT-169 — Table sprawl — custom tables with zero or near-zero records | B | Row counts per custom table (5 rows / 180 days given). | — |
| PLT-171 — Transaction response time 95th percentile beyond threshold | D | 3 s is given; the window is not (syslog_transaction is rotated). | INST |
| PLT-172 — Slow transaction count trending up | B | Needs stored history (3 windows). | — |
| PLT-173 — Specific scripts appearing repeatedly in slow transaction traces | A | sys_script_pattern ranked by total time (workbook: total time is the better ranking). | S10 |
| PLT-174 — Tables above size threshold with no rotation or archival | B | Row counts + sys_table_rotation (10 M rows given). | INST |
| PLT-175 — Queries on large tables without supporting indexes | D | Thresholds "configurable" (sys_query_pattern holds the queries). | S10 |
| PLT-176 — sys\_audit and history tables growing without rotation | D | Size threshold "configurable". | — |
| PLT-177 — Attachment storage growth beyond threshold | D | Threshold "configurable". | — |
| PLT-179 — Semaphore exhaustion indicators | G | Semaphore exhaustion not recorded as data. | — |
| PLT-180 — Long-running transactions cancelled by the platform | A | Cancelled transactions are logged in syslog_cancellation (seen on the instance). Any occurrence; frequency and trend. | INST |
| PLT-181 — List and report queries returning excessive row counts | G | Rows returned not logged. | — |
| PLT-182 — Homepages and dashboards with expensive widgets | G | Widget cost not attributed. | — |
| PLT-183 — Scheduled reports running during peak hours | D | Peak-window derivation not given. | — |

## Enterprise DQ

| Rule | Category | What the research found | Sources |
|---|:-:|---|---|
| DQ-085 — Location with no country or timezone where routing depends on it | B | Which routing / SLA conditions reference location country / timezone — read the conditions (encoded queries) for the field names. | S18 |
| DQ-088 — Cost centre with no account number | C | Whether a financial integration exists — customer's. | — |
| DQ-092 — Location with no parent in the hierarchy | C | Intended root locations — customer's. | — |
| DQ-094 — Knowledge article with no owner or review date | A | Owner = ownership_group (ServiceNow's article ownership); review date = valid_to, where the platform default 2100-01-01 means none was set. | S13 INST |
| DQ-098 — Choice value in use that is absent from sys\_choice | B | Distinct values per choice field vs sys_choice with inheritance. | — |
| DQ-099 — Asset state contradicting its linked CI state | A | The platform's own mapping: alm_asset_ci_state_mapping (47 on the instance; hardware uses alm_hardware_state_mapping). | S12 INST |
| DQ-101 — Phone number not conforming to a defined pattern | A | The platform holds phone formats per territory (sys_phone_territory 215, sys_phone_format 776, India included) — validate E.164 numbers against them. | INST |
| DQ-102 — Model class contradicting the CI class it maps to | A | The model states its CI class (cmdb_model.cmdb_ci_class); a CI in a different class (not a subclass) contradicts it. | INST |
| DQ-106 — Group members drawn from companies the group does not serve | G | sys_user_group has no company field. | — |
| DQ-108 — Naming conventions diverging between import-created and manually created records | D | Divergence measure not given. | — |
| DQ-109 — Hierarchy depth varying widely across regions | D | Variance threshold not given. | — |
| DQ-110 — Cost centre pointing at a company that does not own it | G | cmn_cost_center has no company field. | — |
| DQ-117 — User inactive in the HR feed but active in ServiceNow | B | The HR feed is identified by the platform: sys_user.hr_integration_source / sn_hr_integrations_source (1 on the instance); compare with HR staging status. | INST |
| DQ-118 — HR feed failing or not run within interval | C | The source is identified (DQ-117); the expected run interval is the customer's. | INST |
| DQ-121 — Asset past end-of-life still in Deployed state | A | End of life is the model lifecycle (cmdb_model_lifecycle lifecycle_phase end_of_life, start_date). Deployed assets whose model is past its EOL date. | INST |
| DQ-122 — Knowledge article past its review date | A | As DQ-094: valid_to in the past on a published article. | S13 |
| DQ-128 — Reference field pointing to a deleted record | C | Which reference fields are "operationally significant" — customer's. | — |
| DQ-132 — Report or dashboard referencing a deleted field | B | Report fields vs dictionary with inheritance. | — |
| DQ-133 — PAN, Aadhaar or account-number patterns in free-text fields | C | ServiceNow ships no PAN / Aadhaar pattern (S16). The formats are published by the Income Tax Department (PAN: 5 letters, 4 digits, 1 letter) and UIDAI (Aadhaar: 12 digits, Verhoeff checksum) — you approve them and the free-text field scope. | S16 INST |
| DQ-135 — Personal data in attachments on records with broad read access | G | Attachment content is not readable as data. | — |
| DQ-136 — Personal data present beyond the defined retention period | C | Retention periods — customer's policy. | — |
| DQ-137 — Custom field storing identifier-class data with no classification | C | Needs DQ-133's patterns. | — |
| DQ-138 — Personal data replicated into non-production instances | G | Non-production instances are outside this instance. | — |
| DQ-139 — No data classification applied to tables holding personal data | C | Needs DQ-133's patterns. | — |

## CSDM

| Rule | Category | What the research found | Sources |
|---|:-:|---|---|
| CSDM-009 — CI placed at the wrong CSDM layer | D | Layer profile and margin not given. | — |
| CSDM-010 — Duplicate service constructs representing the same thing at two layers | D | Overlap measures not given. | — |
| CSDM-012 — Service hierarchy depth below the estate's own standard | D | Distance below top-decile not given. | — |
| CSDM-016 — Service portfolio count inconsistent with the business's own service catalogue | C | Which catalogue to compare with — customer's. | — |
| CSDM-020 — Lifecycle contradicting operational_status | B | Join operational_status through life_cycle_mapping (202 on the instance). | INST |
| CSDM-025 — Lifecycle never updated since creation | B | Field history from sys_audit (opt-in read). | — |
| CSDM-027 — Lifecycle transitions occurring with no corresponding change record | D | Needs sys_audit (build) and a correlation window (not given). | — |
| CSDM-031 — No validation preventing invalid lifecycle combinations | C | What counts as enforcement — customer's. | — |
| CSDM-039 — Service ownership never changed since creation despite organisational change | B | As CSDM-025. | — |
| CSDM-040 — Service with no data owner where it processes personal data | G | No data-owner field on services; no information objects on the instance. | — |
| CSDM-042 — No service ownership review or attestation process evidenced | C | Attestation is readable (cert_filter "Critical Business Services", CMDB Data Manager policies); the review period is the customer's. | INST |
| CSDM-045 — Non-production services carrying production SLAs | B | As PLT-020. | S18 |
| CSDM-049 — Non-production services counted in production service portfolio reporting | G | Portfolio reports not identifiable. | — |
| CSDM-052 — Relationship direction reversed between layers | A | The suggested relationships (cmdb_rel_type_suggest) state the parent / child direction per class pair — same source as D-032. | INST |
| CSDM-059 — Service dependency edges created manually and never corroborated | G | cmdb_rel_ci has no source / last-discovered field. | — |
| CSDM-063 — Offerings not covering the full consumption surface of their parent service | C | Channel / category → offering mapping — customer's. | — |
| CSDM-064 — Commitment targets inconsistent across offerings of the same service | D | Variance threshold not given. | — |
| CSDM-065 — Offering inactive while its parent service is Operational | C | Which status means "inactive" — customer's. | — |
| CSDM-066 — Offering with no price or cost model where chargeback is in use | C | Whether chargeback is in use — customer's. | — |
| CSDM-067 — SLA attached to a service rather than to its offering | B | As PLT-020. | S18 |
| CSDM-070 — Percentage of services with a complete hierarchy from capability to CI | B | Layer traversal per service (band threshold from the workbook band). | — |
| CSDM-073 — CSDM maturity declining across assessments | B | Series of CSDM-072 stages from stored scan history. | — |
| CSDM-074 — New services created without CSDM conformance | C | The conformance rule set — customer's. | — |
| CSDM-075 — Business Critical service whose impact calculation cannot return a result, with the CSDM structural cause traced | B | Impact traversal per critical service. | — |
| CSDM-078 — Service model completeness capped by discovery coverage | B | Correlate traversal end with discovery failure. | — |
| CSDM-079 — Change risk assessed without service context because the CI has no service path | B | CI → service path per change. | — |
| CSDM-080 — Personal data processing not traceable to an accountable service | G | As CSDM-040. | — |

## Build status (2026-09-25)

The product owner approved building categories A and B, and the PAN / Aadhaar formats. Built, tested on the offline estates and run read-only on the validation instance: **107** rules. A / B rules not built yet: **18**, each with its reason.

### Built

- ITSM-004
- ITSM-007
- ITSM-013
- ITSM-015
- ITSM-031
- ITSM-034
- ITSM-038
- ITSM-066
- ITSM-076
- ITSM-081
- ITSM-084
- ITSM-086
- ITSM-087
- ITSM-089
- ITSM-091
- ITSM-092
- ITSM-093
- ITSM-098
- ITSM-115
- ITSM-118
- ITSM-122
- ITSM-126
- ITSM-127
- ITSM-128
- ITSM-137
- ITSM-138
- ITOM-007
- ITOM-013
- ITOM-053
- ITOM-061
- ITOM-075 — runs once the minimum count is given (workbook: "configurable")
- ITOM-094
- ITOM-099
- ITOM-105
- ITOM-108
- ITOM-111
- ITOM-112
- ITOM-113
- ITOM-116
- ITOM-148
- ITOM-150
- PLT-007
- PLT-020
- PLT-031
- PLT-052
- PLT-059
- PLT-063
- PLT-074
- PLT-116
- PLT-119
- PLT-122
- PLT-126
- PLT-127
- PLT-128
- PLT-135
- PLT-136
- PLT-142
- PLT-155
- PLT-160
- PLT-169
- PLT-173
- PLT-180
- PLT-085
- PLT-093
- PLT-095
- PLT-099
- PLT-102
- DQ-085
- DQ-094
- DQ-099
- DQ-102
- DQ-121
- DQ-122
- DQ-133 — runs once the free-text field list is given (open question)
- DQ-137
- DQ-139 — runs once the free-text field list is given (open question)
- DQ-132
- ITOM-152
- ITOM-156
- PLT-017
- PLT-030
- PLT-039
- PLT-041
- PLT-045
- PLT-064
- PLT-066
- PLT-068
- PLT-069
- PLT-071
- PLT-081
- PLT-083
- PLT-094
- PLT-100
- PLT-105 — runs once the age and growth thresholds are given (workbook: "configurable")
- PLT-108
- PLT-172 — runs once the window length is given (workbook: not stated)
- DQ-098
- CSDM-073
- CSDM-075
- CSDM-078
- CSDM-020
- CSDM-025
- CSDM-039
- CSDM-045
- CSDM-052
- CSDM-067
- CSDM-079

### A / B rules not built yet

| Rule | Why |
|---|---|
| ITOM-041 | pattern execution log — see ITOM-042 |
| ITOM-042 | pattern execution log (sa_discovery_log) is empty on the instance and its status values are undocumented |
| ITOM-043 | pattern execution log — see ITOM-042 |
| ITOM-044 | pattern execution log — see ITOM-042 |
| ITOM-050 | pattern execution log — see ITOM-042 |
| ITOM-048 | in the open-questions workbook (G): the platform records no per-CI pattern attribution |
| ITOM-133 | the cloud vs agent discovery-source values are not verified (no cloud CIs on the instance) |
| ITOM-149 | needs an identification-rule strength classification (a D-type value) |
| PLT-053 | in the open-questions workbook (G): the Slow Scripts log has no window to match table activity |
| PLT-057 | the observation window is not given (a D-type value) |
| PLT-008 | also waits on an UNDEFINED threshold |
| PLT-011 | built, then withdrawn: SLA flow contexts are not retained, so a flow that never ran cannot be told from a purged context (D-035; open-questions workbook, sheet G) |
| PLT-098 | also waits on an UNDEFINED threshold |
| PLT-147 | the outbound log is rotated long before the 180-day window |
| PLT-174 | row counts across every table — too many requests; needs table statistics (empty on the instance) |
| DQ-101 | phone numbers are stored without a country code; per-territory validation risks false findings — not built |
| DQ-117 | in the open-questions workbook (C): which import is the HR feed of the customer |
| CSDM-070 | also waits on an UNDEFINED threshold |

## Sources

- **S1** — Incident auto-close: glide.ui.autoclose.time (days), OOB "incident autoclose" business rule — <https://www.servicenow.com/community/itsm-articles/incident-auto-close-configuration/ta-p/2302132>
- **S2** — Change conflict detection properties (change.conflict.*) and conflict_status / conflict_last_run — <https://www.servicenow.com/docs/r/it-service-management/change-management/configure-conflict-properties.html>
- **S3** — Change approval policies are decision tables; applied policies logged in chg_policy_applied; approvals from chg_approval_def — <https://www.servicenow.com/community/in-other-news/using-change-approval-policies/ba-p/2286835>
- **S4** — Change models: state model and transitions (sttrm_*), implementation_states — <https://www.servicenow.com/docs/r/it-service-management/change-management/c_ChangeStateModel.html>
- **S5** — Standard change templates: retire / versions, closed and unsuccessful change counts (no expiry or review-date field) — <https://www.servicenow.com/docs/r/washingtondc/it-service-management/change-management/manage-standard-change-template.html>
- **S6** — Blackout schedules = periods when changes must not occur (change freeze), used by conflict detection — <https://www.servicenow.com/docs/bundle/vancouver-it-service-management/page/product/change-management/task/t_CreateBlkoutMaintSched.html>
- **S7** — Major Incident Management: major_incident_state (proposed / accepted / rejected / canceled) on incident; plugin com.snc.incident.mim — <https://www.servicenow.com/docs/r/it-service-management/incident-management/major-incident-management.html>
- **S8** — Service / integration accounts: sys_user.web_service_access_only and internal_integration_user — <https://www.servicenow.com/community/itsm-forum/what-is-the-difference-between-internal-integration-user-and-web/td-p/851999>
- **S9** — MID Server heartbeat: the instance checks every 5 minutes and marks the MID Down on no response — <https://www.servicenow.com/docs/r/servicenow-platform/mid-server/r_MIDServerHeartbeat.html>
- **S10** — Slow Scripts / Slow Queries / Slow Transactions: sys_script_pattern, sys_query_pattern, sys_transaction_pattern (count, average, total, first, last, source script) — <https://www.servicenow.com/community/sysadmin-forum/how-do-we-analyse-the-slow-scripts/m-p/2940920>
- **S11** — sys_metadata_customization (Washington DC onward): the customer's modifications of out-of-box records — <https://www.servicenow.com/community/servicenow-ai-platform-articles/identify-changes-to-ootb-baseline-records/ta-p/2421282>
- **S12** — Asset ↔ CI state mapping: alm_asset_ci_state_mapping (hardware: alm_hardware_state_mapping) — <https://www.servicenow.com/docs/r/washingtondc/it-asset-management/hardware-asset-management/t_CreateAssetandCIInstallStatusMapping.html>
- **S13** — Knowledge article validity: Valid to is the expiry date; blank validity sets 2100-01-01; ownership groups own articles — <https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/article-validity.html>
- **S14** — Impersonation logging: impersonation.start / impersonation.end events (parm1 impersonator, parm2 impersonated) — <https://www.servicenow.com/docs/r/platform-administration/user-administration/c_LogImpersonations.html>
- **S15** — De-duplication: IRE flags duplicates (duplicate_of) and creates reconcile_duplicate_task; sources in sys_object_source / discovery_source — <https://www.servicenow.com/docs/r/servicenow-platform/configuration-management-database-cmdb/reconcile-dup-task.html>
- **S16** — Data Discovery patterns (sn_data_discovery_data_pattern): OOB patterns are US / card / email / phone — no PAN or Aadhaar — <https://store.servicenow.com/store/app/340d23a21b646a50a85b16db234bcbf8>
- **S17** — Data classification of dictionary fields (m2m_dictionary_dataclass) — already used by D-032 — <https://www.servicenow.com/docs/r/washingtondc/platform-security/data-classification/apply-data-classification-codes-dictionary-entries.html>
- **S18** — Table API accepts an encoded query (sysparm_query): the instance itself evaluates a stored condition — <https://www.servicenow.com/docs/r/zurich/api-reference/rest-apis/c_TableAPI.html>
- **S19** — CMDB Health staleness rules (cmdb_health_staleness_rule) — <https://www.servicenow.com/docs/r/zurich/servicenow-platform/configuration-management-database-cmdb/t_CreateCMDBHealthStaleRule.html>
- **S20** — Contextual Search on the incident form (cxs_table_config) — <https://www.servicenow.com/docs/bundle/washingtondc-platform-administration/page/administer/contextual-search/task/t_DefineContextualSearchForForm.html>
- **INST** — Read-only probe of techsnitchpvtltddemo2 (2026-09-25)
