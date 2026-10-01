/**
 * HEALTH ASSIST PHASE 10 — the ITIL decision table: one entry per rule of the ITIL sheet
 * (ITIL-001 … ITIL-148, supplied by the product owner as ITIL.xlsx and added to the
 * master workbook — rules/workbook/supplements/itil-rules.json).
 *
 * `node scripts/build-workbook-pack.mjs --pack itil` turns this into the pack's generated
 * files. Every rule is in one recorded state (executable, unconfigured, undefined,
 * specification gap, not built, equivalent, derived); the rules of the other packs hold:
 * nothing is read before it is verified on the instance, no threshold is invented, and a
 * value the rule needs that ServiceNow does not publish waits for the product owner
 * (SAOS_Health_Rules_Open_Questions.xlsx).
 *
 * Every table and field below was checked READ-ONLY on techsnitchpvtltddemo2 before this
 * table was written (Phase 10, D-034). Products that are NOT installed there: Business
 * Continuity Management (no sn_bcm_* tables), Continual Improvement Management (no
 * improvement register), Major Incident Management (plugin inactive). Release Management's
 * tables exist (release_project, release_phase, release_task, release_rfcs) with no rows.
 *
 * EQUIVALENTS: where an ITIL rule states the same condition as a rule another module
 * already evaluates ("Joins …" and the same detection), it is shown as an equivalent and
 * counted once, where it is built — the product owner's rule for CSDM (D-030), applied here.
 */

const T = (table, ...fields) => ({ table, fields });
const P = (key, type, unit, dflt, description, source = null) => ({ key, type, unit, default: dflt, description, ...(source ? { source } : {}) });
const param = (key) => ({ $param: key });
const undef = (...deps) => ({ undefined_dependencies: deps });
const pending = (text) => ({ build_pending: text });
const gap = (missing) => ({ specification_gap: { missing } });
const cfg = (reader, compare, requires, partial) => ({ engine: 'configuration', requires_tables: requires, ...reader, compare, ...(partial ? { partial } : {}) });
const rowsReader = (table, fields, query = '') => ({ reader: 'table_rows', args: { table, fields, query } });
const eq = (a, of, note, cand = []) => ({ a, equivalent_of: of, cand, params: [], note });

/* Catalog items that are ordered and fulfilled (the requestable classes, as DQ-123). */
const REQUESTABLE = 'sys_class_nameINsc_cat_item,pc_hardware_cat_item,pc_software_cat_item';
const PERSONAL = null;
const R = {
  noProduct: (product, tables) => `${product} is not installed on the validation instance (${tables}) — the rule runs where the product is in use`,
  noRecord: (what) => `the platform records no ${what} — the rule cannot be read from any instance as worded`,
  threshold: (what) => `${what} — the supplied rule gives no number and ServiceNow publishes none`,
  customer: (what) => `${what} — the customer's to state`,
};

export const RULES = {
  /* ═══ Group 1 — Request Fulfilment ═══ */
  'ITIL-001': { a: 'record_predicate', cand: ['incident'], params: [],
    config: { requires_tables: [T('incident', 'number', 'close_code', 'category')], table: 'incident', scope: 'resolved_atISNOTEMPTY', predicates: [{ field: 'close_code', op: 'equals', value: 'Resolved by request' }],
      evidence_fields: ['number', 'category', 'close_code'], report_ratio: true,
      partial: { kind: 'detection_gap', not_covered: 'Judged by ServiceNow\'s own close code "Resolved by request" — an incident closed as a request (D-034). Category and description patterns are not classified.' } } },
  'ITIL-002': { a: 'record_predicate', cand: ['sc_cat_item'], params: [],
    config: { requires_tables: [T('sc_cat_item', 'name', 'active', 'workflow', 'flow_designer_flow', 'delivery_plan')], table: 'sc_cat_item', scope: `active=true^${REQUESTABLE}`,
      predicates: [{ field: 'workflow', op: 'empty' }, { field: 'flow_designer_flow', op: 'empty' }, { field: 'delivery_plan', op: 'empty' }], evidence_fields: ['name'], report_ratio: true,
      partial: { kind: 'detection_gap', not_covered: 'No workflow, no Flow Designer flow and no execution plan (delivery plan) — the three ways the platform generates fulfilment. Fulfilment by manual assignment is charged (the guard).' } } },
  'ITIL-003': { a: 'cross_record_linkage', cand: ['sc_req_item', 'task_sla'], params: [],
    config: { requires_tables: [T('sc_req_item', 'number', 'cat_item'), T('task_sla', 'task')], from: { table: 'sc_req_item', query: 'active=true', fields: ['number', 'cat_item'] },
      to: { table: 'task_sla', query: '', fields: [] }, link: { kind: 'reference', field: 'task', direction: 'inbound' }, expect: 'absent', report_ratio: true, evidence_fields: ['number', 'cat_item'],
      partial: { kind: 'detection_gap', not_covered: 'Coverage is judged by what ran: an open request item no SLA has attached to.' } } },
  'ITIL-004': eq('reference_integrity', 'DQ-095', 'The same condition as DQ-095 (approvers resolving to inactive users) and DQ-096 (approver groups with zero active members), which the supplied rule joins: evaluated and counted in Enterprise Data Quality, shown here as an equivalent.', ['sysapproval_approver', 'sys_user']),
  'ITIL-005': { a: 'record_predicate', cand: ['sc_req_item'], params: [P('max_age', 'duration', 'days', null, 'open request age by type — UNDEFINED')], config: undef(R.threshold('the request age threshold by type')) },
  'ITIL-006': { a: 'record_predicate', cand: ['sc_task'], params: [P('max_age', 'duration', 'days', null, 'fulfilment task age — UNDEFINED')], config: undef(R.threshold('the fulfilment task age threshold')) },
  'ITIL-007': { a: 'cross_record_linkage', also: ['configuration'], cand: ['sc_req_item', 'sc_task'], params: [],
    config: cfg(rowsReader('sc_req_item', ['number', 'close_notes'], 'active=false^close_notesISEMPTY'), { name: 'itil_requests_without_evidence', args: {} }, [T('sc_req_item', 'number', 'close_notes', 'active'), T('sc_task', 'request_item', 'state')],
      { kind: 'detection_gap', not_covered: 'Closed request items with empty close notes and no fulfilment task in Closed Complete (3). Evidence held in a workflow context is not read (the guard).' }) },
  'ITIL-008': { a: 'text_analysis', cand: ['sc_req_item', 'incident'], params: [P('similarity', 'percent', null, null, 'description similarity — UNDEFINED')], config: undef(R.threshold('the similarity that makes descriptions "the same request"')) },
  'ITIL-009': eq('record_predicate', 'DQ-091', 'The same condition as DQ-091 (catalog item with no owner or fulfilment group), which the supplied rule joins: evaluated and counted in Enterprise Data Quality, shown here as an equivalent.', ['sc_cat_item']),
  'ITIL-010': { a: 'aggregate_distribution', cand: ['sc_req_item'], params: [P('rate', 'percent', null, null, 'reopen / rework rate — UNDEFINED')], config: undef(R.threshold('the reopen / rework rate')) },
  'ITIL-011': { a: 'text_analysis', also: ['configuration'], cand: ['item_option_new', 'wf_workflow', 'sys_hub_flow'], params: [],
    config: cfg(rowsReader('sc_cat_item', ['name', 'flow_designer_flow', 'workflow'], `active=true^${REQUESTABLE}^flow_designer_flowISNOTEMPTY^ORworkflowISNOTEMPTY`), { name: 'itil_variables_unused', args: {} },
      [T('sc_cat_item', 'name', 'flow_designer_flow', 'workflow', 'active'), T('item_option_new', 'name', 'type', 'cat_item', 'variable_set', 'active'), T('io_set_item', 'sc_cat_item', 'variable_set'), T('sys_hub_flow', 'master_snapshot'), T('sys_hub_action_instance_v2', 'flow', 'values'), T('sys_hub_flow_logic_instance_v2', 'flow', 'values'), T('wf_workflow_version', 'workflow', 'published'), T('wf_activity', 'workflow_version'), T('sys_variable_value', 'document', 'document_key', 'value')],
      { kind: 'detection_gap', not_covered: 'An input variable of an item (its own and its variable sets\', labels and containers aside) is used when the current version of the item\'s flow names it or points to it by sys_id in a step input (Get Catalog Variables included), or its published workflow\'s activity settings name it (D-037). A flow or workflow shared by several items is generic fulfilment and is not judged: it cannot name one item\'s variables, and its fulfillers read them on the task form (the guard). Task descriptions and variables read by a fulfiller on the task form (the guard) are not seen.' }) },
  'ITIL-012': { a: 'reference_integrity', also: ['configuration'], cand: ['sc_cat_item', 'sc_task', 'sys_user_grmember'], params: [],
    config: cfg(rowsReader('sc_cat_item', ['name', 'group'], `active=true^${REQUESTABLE}^groupISNOTEMPTY`), { name: 'itil_fulfilment_groups_empty', args: {} }, [T('sc_cat_item', 'group'), T('sc_task', 'assignment_group', 'active'), T('sys_user_grmember', 'group', 'user'), T('sys_user', 'active')],
      { kind: 'detection_gap', not_covered: 'Fulfilment groups are the catalog items\' groups and the assignment groups of open fulfilment tasks. A group in transition is charged (the guard).' }) },
  'ITIL-013': eq('cross_record_linkage', 'DQ-123', 'The same condition as DQ-123 (catalog item never ordered), which the supplied rule joins: evaluated and counted in Enterprise Data Quality.', ['sc_cat_item', 'sc_req_item']),
  'ITIL-014': { a: 'aggregate_distribution', cand: ['sc_req_item', 'sc_cat_item'], params: [P('top', 'number', null, null, 'how many top request types — UNDEFINED')], config: undef(R.threshold('how many "top request types by volume" are judged')) },
  'ITIL-015': { a: 'record_predicate', cand: ['sc_task'], params: [],
    config: { requires_tables: [T('sc_task', 'number', 'description', 'short_description', 'active')], table: 'sc_task', scope: 'active=true', predicates: [{ field: 'description', op: 'empty' }],
      evidence_fields: ['number', 'short_description'], report_ratio: true,
      partial: { kind: 'detection_gap', not_covered: 'Open fulfilment tasks with no description carried from the request; variables shown on the task through the request item are not read.' } } },
  'ITIL-016': { a: 'aggregate_distribution', cand: ['sc_req_item', 'sc_cat_item'], params: [], config: gap('what makes a request-type distribution show "no meaningful differentiation"') },

  /* ═══ Group 2 — Service Catalogue Management ═══ */
  'ITIL-017': eq('configuration_inspection', 'CSDM-016', 'The same condition as CSDM-016 (service portfolio against the catalogue), which the supplied rule joins: counted once, in CSDM.', ['sc_cat_item', 'cmdb_ci_service']),
  'ITIL-018': { a: 'cross_record_linkage', cand: ['sc_cat_item', 'sc_cat_item_service'], params: [], config: undef(R.noRecord('general catalog item → service or offering reference (only the Service catalog item class, sc_cat_item_service, names a service)')) },
  'ITIL-019': { a: 'configuration_inspection', cand: ['sc_catalog', 'user_criteria'], params: [], config: gap('what separates a business from a technical catalogue ("audience or user-criteria differentiation")') },
  'ITIL-020': { a: 'record_predicate', cand: ['sc_cat_item'], params: [], config: undef(R.noRecord('review date on catalog items (sc_cat_item has no review-date field)')) },
  'ITIL-021': { a: 'configuration_inspection', cand: ['sc_cat_item', 'sc_cat_item_user_criteria_mtom'], params: [],
    config: cfg(rowsReader('sc_cat_item', ['name', 'roles'], `active=true^${REQUESTABLE}`), { name: 'itil_items_without_criteria', args: {} }, [T('sc_cat_item', 'name', 'roles', 'active'), T('sc_cat_item_user_criteria_mtom', 'sc_cat_item', 'user_criteria')],
      { kind: 'detection_gap', not_covered: 'Judged only where entitlement differentiation exists elsewhere (some item has user criteria, the rule\'s guard): items with no "Available for" user criteria and no roles.' }) },
  'ITIL-022': { a: 'record_predicate', cand: ['sc_cat_item'], params: [],
    config: { requires_tables: [T('sc_cat_item', 'name', 'description', 'short_description', 'active')], table: 'sc_cat_item', scope: `active=true^${REQUESTABLE}`, evidence_fields: ['name'], report_ratio: true,
      variants: [
        { variant: 'no description', predicates: [{ field: 'description', op: 'empty' }, { field: 'short_description', op: 'empty' }] },
        { variant: 'description is the name', predicates: [{ field: 'short_description', field2: 'name', op: 'same_as' }] },
      ],
      partial: { kind: 'detection_gap', not_covered: '"Description length below threshold" needs a length the rule does not give; items with no description, or a short description equal to the name, are judged.' } } },
  'ITIL-023': { a: 'record_predicate', cand: ['sc_cat_item'], params: [], config: undef(R.customer('whether a chargeback / showback model is in use')) },
  'ITIL-024': eq('text_analysis', 'DQ-116', 'The same condition as DQ-116 (duplicate catalog items), which the supplied rule joins: counted once, in Enterprise Data Quality.', ['sc_cat_item']),
  'ITIL-025': { a: 'configuration_inspection', cand: ['sc_cat_item'], params: [], config: undef(R.noRecord('publication approval of catalog items outside Catalog Builder review')) },
  'ITIL-026': { a: 'configuration_inspection', cand: ['service_availability'], params: [], config: undef(R.customer('which service record is the catalogue / portal whose availability is measured')) },

  /* ═══ Group 3 — Knowledge Management ═══ */
  'ITIL-027': { a: 'aggregate_distribution', cand: ['m2m_kb_task', 'incident', 'kb_knowledge'], params: [P('min_share', 'percent', null, null, 'article-linkage share — UNDEFINED ("near zero")')], config: undef(R.threshold('the linkage share that counts as "near zero"')) },
  'ITIL-028': { a: 'configuration_inspection', cand: ['cxs_table_config', 'kb_knowledge'], params: [],
    config: cfg(rowsReader('cxs_table_config', ['table', 'active'], 'active=true^tableINsc_request,sc_req_item,sc_cat_item'), { name: 'absent_despite_volume', args: { volume_table: 'kb_knowledge', query: 'workflow_state=published' } }, [T('cxs_table_config', 'table', 'active')],
      { kind: 'detection_gap', not_covered: 'The request half: a Contextual Search configuration for the request tables where articles are published (D-034). The incident half is ITSM-015.' }) },
  'ITIL-029': eq('record_predicate', 'DQ-122', 'The same condition as DQ-122 (article past its review date), which the supplied rule joins: counted once, in Enterprise Data Quality.', ['kb_knowledge']),
  'ITIL-030': { a: 'reference_integrity', also: ['configuration'], cand: ['kb_knowledge', 'sys_user_grmember'], params: [],
    config: cfg(rowsReader('kb_knowledge', ['number', 'ownership_group', 'author'], 'workflow_state=published'), { name: 'itil_articles_without_owner', args: {} }, [T('kb_knowledge', 'number', 'ownership_group', 'author', 'workflow_state'), T('sys_user_grmember', 'group', 'user'), T('sys_user', 'active')],
      { kind: 'false_positive_risk', not_covered: 'The owner is the ownership group (D-033); an article with none, or whose group has no active member, is charged. A knowledge base that owns articles at base level is charged (the guard).' }) },
  'ITIL-031': eq('cross_record_linkage', 'ITSM-066', 'The same condition as ITSM-066, which the supplied rule joins: counted once, in ITSM.', ['problem', 'kb_knowledge']),
  'ITIL-032': { a: 'aggregate_distribution', cand: ['kb_knowledge', 'incident'], params: [P('min_rate', 'percent', null, null, 'article creation rate — UNDEFINED')], config: undef(R.threshold('the article creation rate against resolved volume')) },
  'ITIL-033': { a: 'record_predicate', cand: ['kb_knowledge'], params: [P('min_age', 'duration', 'days', null, 'article age — UNDEFINED')], config: undef(R.threshold('the age after which zero views counts')) },
  'ITIL-034': { a: 'temporal_correlation', also: ['configuration'], cand: ['kb_feedback', 'kb_knowledge'], params: [],
    config: cfg(rowsReader('kb_feedback', ['article', 'flagged', 'useful', 'comments', 'sys_created_on'], 'flagged=true^ORuseful=no^ORcommentsISNOTEMPTY'), { name: 'itil_feedback_not_actioned', args: {} }, [T('kb_feedback', 'article', 'flagged', 'useful', 'comments'), T('kb_knowledge', 'number')],
      { kind: 'detection_gap', not_covered: 'Feedback that flags an article, marks it not useful or comments on it, where the article has not been updated since (D-034). Feedback actioned outside the record is charged (the guard).' }) },
  'ITIL-035': { a: 'text_analysis', cand: ['kb_knowledge'], params: [P('similarity', 'percent', null, null, 'content similarity — UNDEFINED')], config: undef(R.threshold('the content similarity above which two articles are duplicates')) },
  'ITIL-036': { a: 'aggregate_distribution', cand: ['incident', 'kb_knowledge'], params: [P('volume', 'number', null, null, 'incident volume — UNDEFINED')], config: undef(R.threshold('the incident volume that makes a service "high volume"')) },
  'ITIL-037': { a: 'text_analysis', also: ['configuration'], cand: ['kb_knowledge'], params: [],
    config: cfg(rowsReader('data_classification', ['name']), { name: 'dq_identifiers_in_text', args: { fields: ['kb_knowledge.text'] } }, [T('data_classification', 'name'), T('kb_knowledge', 'text')],
      { kind: 'detection_gap', not_covered: 'PAN and Aadhaar in article text, in the formats the product owner approved (D-033; Aadhaar checksum-validated and reported separately), values masked.' }) },
  'ITIL-038': { a: 'configuration_inspection', cand: ['kb_knowledge_base'], params: [],
    config: cfg(rowsReader('kb_knowledge_base', ['title', 'kb_publish_flow', 'workflow'], 'active=true'), { name: 'itil_kb_without_publish_approval', args: {} }, [T('kb_knowledge_base', 'title', 'kb_publish_flow', 'workflow', 'active'), T('sys_hub_flow', 'name'), T('wf_workflow', 'name')],
      { kind: 'detection_gap', not_covered: 'A knowledge base publishing through ServiceNow\'s "Knowledge - Instant Publish" flow or workflow has no approval step (D-034). A custom publish flow is not read.' }) },
  'ITIL-039': eq('cross_record_linkage', 'ITSM-139', 'The same condition as ITSM-139 (and DQ-131), which the supplied rule joins: counted once, in ITSM.', ['kb_knowledge', 'm2m_kb_task']),
  'ITIL-040': { a: 'configuration_inspection', cand: ['ssa_deflection_metric', 'pa_indicators'], params: [], config: undef(R.customer('which measurement counts as knowledge effectiveness (deflection, resolution time with an article, self-service success)')) },

  /* ═══ Group 4 — Service Level Management ═══ */
  'ITIL-041': { a: 'configuration_inspection', cand: [], params: [], config: undef(R.noRecord('service review records, meetings or tasks as a record type')) },
  'ITIL-042': eq('record_predicate', 'PLT-016', 'The same condition as PLT-016 (SLA definition never reviewed since creation), which the supplied rule joins: counted once, in Platform.', ['contract_sla']),
  'ITIL-043': { a: 'temporal_correlation', cand: ['sysauto_report', 'problem', 'change_request'], params: [], config: undef(R.noRecord('a link between a breach report and the action taken on it')) },
  'ITIL-044': { a: 'configuration_inspection', cand: ['contract_sla'], params: [],
    config: cfg(rowsReader('contract_sla', ['name', 'type', 'collection'], 'active=true'), { name: 'itil_agreement_type_absent', args: { base: 'SLA', missing: 'OLA' } }, [T('contract_sla', 'name', 'type', 'active')],
      { kind: 'detection_gap', not_covered: 'SLA, OLA and Underpinning contract are ServiceNow\'s own SLA-definition types (D-034): SLAs in use with no OLA defined at all. Coverage of each contributing group is not traced.' }) },
  'ITIL-045': { a: 'configuration_inspection', cand: ['contract_sla'], params: [],
    config: cfg(rowsReader('contract_sla', ['name', 'type', 'collection'], 'active=true'), { name: 'itil_agreement_type_absent', args: { base: 'SLA', missing: 'Underpinning contract' } }, [T('contract_sla', 'name', 'type', 'active')],
      { kind: 'detection_gap', not_covered: 'SLAs in use with no Underpinning contract definition at all (D-034). Which services depend on a third party is not recorded, so per-service linkage is not traced.' }) },
  'ITIL-046': { a: 'configuration_inspection', cand: ['contract_sla', 'service_commitment'], params: [], config: gap('how an underpinning contract is matched to "the customer SLA it supports" for the same service chain') },
  'ITIL-047': { a: 'configuration_inspection', cand: ['sysauto_report', 'sys_report'], params: [],
    config: cfg(rowsReader('sysauto_report', ['name', 'active', 'report', 'address_list', 'user_list', 'group_list'], 'active=true'), { name: 'itil_service_reports_without_distribution', args: { tables: ['task_sla', 'contract_sla', 'service_availability', 'service_sla_result'] } }, [T('sysauto_report', 'report', 'address_list', 'active'), T('sys_report', 'table', 'title')],
      { kind: 'detection_gap', not_covered: 'Scheduled reports on SLA and availability data with no external e-mail address (address_list). Distribution through a portal is charged (the guard).' }) },
  'ITIL-048': { a: 'configuration_inspection', cand: ['sys_report'], params: [], config: undef(R.noRecord('what a report discloses about its excluded population')) },
  'ITIL-049': { a: 'configuration_inspection', cand: ['sys_user_has_role'], params: [],
    config: cfg(rowsReader('sys_user_role', ['name'], 'name=sla_manager'), { name: 'itil_role_unheld', args: { role: 'sla_manager' } }, [T('sys_user_role', 'name'), T('sys_user_has_role', 'user', 'role'), T('sys_user', 'active')],
      { kind: 'detection_gap', not_covered: 'The SLM owner is ServiceNow\'s own sla_manager role (D-034): absent when no active user holds it. A broader role holding the responsibility is charged (the guard).' }) },
  'ITIL-050': { a: 'configuration_inspection', cand: ['asmt_metric_type', 'asmt_assessment_instance'], params: [],
    config: cfg(rowsReader('asmt_metric_type', ['name', 'evaluation_method', 'active'], 'active=true^evaluation_method=survey'), { name: 'itil_surveys_in_use', args: {} }, [T('asmt_metric_type', 'name', 'evaluation_method', 'active'), T('asmt_assessment_instance', 'metric_type', 'state')],
      { kind: 'detection_gap', not_covered: 'Satisfaction measurement is an active survey (asmt_metric_type, survey) with assessments sent. Its correlation to service or SLA performance is not judged.' }) },
  'ITIL-051': eq('aggregate_distribution', 'ITSM-054', 'The same condition as ITSM-054 (recurring incident patterns with no Problem), which the supplied rule joins: counted once, in ITSM.', ['task_sla', 'problem']),
  'ITIL-052': { a: 'aggregate_distribution', cand: ['service_commitment', 'cmdb_ci_service'], params: [P('variance', 'percent', null, null, 'target variance — UNDEFINED')], config: undef(R.threshold('the target variance across services of one criticality band')) },

  /* ═══ Group 5 — Release and Deployment ═══ */
  'ITIL-053': { a: 'configuration_inspection', cand: ['release_project', 'change_request'], params: [],
    config: cfg(rowsReader('release_project', ['number', 'active']), { name: 'absent_despite_volume', args: { volume_table: 'change_request', query: 'active=true' } }, [T('release_project', 'number', 'active')],
      { kind: 'detection_gap', not_covered: 'The release practice is ServiceNow\'s Release Management (release_project, D-034): no release while changes are open. A release pipeline outside the platform is charged (the guard).' }) },
  'ITIL-054': { a: 'cross_record_linkage', cand: ['release_project', 'release_rfcs'], params: [],
    config: { requires_tables: [T('release_project', 'number', 'short_description'), T('release_rfcs', 'release', 'rfc')], from: { table: 'release_project', query: '', fields: ['number', 'short_description'] },
      to: { table: 'release_rfcs', query: '', fields: [] }, link: { kind: 'reference', field: 'release', direction: 'inbound' }, expect: 'absent', report_ratio: true, evidence_fields: ['number', 'short_description'] } },
  'ITIL-055': { a: 'record_predicate', cand: ['release_project'], params: [], config: undef(R.noRecord('a release-level rollback plan (release_project has no rollback field)')) },
  'ITIL-056': { a: 'cross_record_linkage', cand: ['release_project', 'release_task'], params: [], config: undef(R.noRecord('a deployment-verification task type on release_task')) },
  'ITIL-057': { a: 'temporal_correlation', cand: ['release_project', 'incident'], params: [P('rate', 'percent', null, null, 'release-induced incident rate — UNDEFINED'), P('window', 'duration', 'days', null, 'post-deployment window — UNDEFINED')], config: undef(R.threshold('the incident rate and the post-deployment window')) },
  'ITIL-058': { a: 'record_predicate', cand: ['change_request'], params: [],
    config: { requires_tables: [T('change_request', 'number', 'outside_maintenance_schedule', 'state')], table: 'change_request', scope: 'stateIN-1,0,3', predicates: [{ field: 'outside_maintenance_schedule', op: 'equals', value: 'true' }],
      evidence_fields: ['number', 'type', 'start_date', 'end_date'], report_ratio: true,
      partial: { kind: 'detection_gap', not_covered: 'The release windows are the CIs\' maintenance schedules; the platform sets outside_maintenance_schedule on a change planned outside them (D-034). Emergency changes are charged (the guard).' } } },
  'ITIL-059': { a: 'configuration_inspection', cand: [], params: [], config: undef(R.noRecord('an artefact / definitive media library linked to releases')) },
  'ITIL-060': { a: 'cross_record_linkage', cand: ['release_project'], params: [], config: undef(R.noRecord('a release\'s demand or problem origin (release_project has no such reference)')) },
  'ITIL-061': { a: 'cross_record_linkage', cand: ['sys_update_set'], params: [], config: undef(R.noRecord('a link from an update set to a release or change')) },
  'ITIL-062': { a: 'configuration_inspection', cand: ['sys_update_set', 'sys_remote_update_set'], params: [], config: undef(R.noRecord('the environment promotion path (it spans instances)')) },
  'ITIL-063': { a: 'cross_record_linkage', also: ['configuration'], cand: ['release_project', 'sysapproval_approver'], params: [],
    config: cfg(rowsReader('release_project', ['number']), { name: 'itil_records_without_approval', args: {} }, [T('release_project', 'number'), T('sysapproval_approver', 'sysapproval')]) },
  'ITIL-064': { a: 'record_predicate', cand: ['release_project'], params: [],
    config: { requires_tables: [T('release_project', 'number', 'notes', 'description')], table: 'release_project', predicates: [{ field: 'notes', op: 'empty' }, { field: 'description', op: 'empty' }], evidence_fields: ['number'], report_ratio: true } },
  'ITIL-065': { a: 'cross_record_linkage', cand: ['release_project'], params: [], config: undef(R.noRecord('a release outcome (unsuccessful) and a release review record')) },
  'ITIL-066': { a: 'aggregate_distribution', cand: ['release_project', 'release_rfcs'], params: [P('window', 'number', null, null, 'how many releases form the trend — UNDEFINED')], config: undef(R.threshold('how many consecutive releases (or what period) make "trending upward together"')) },

  /* ═══ Group 6 — Service Validation and Testing ═══ */
  'ITIL-067': { a: 'cross_record_linkage', also: ['configuration'], cand: ['change_request', 'change_task'], params: [],
    config: cfg(rowsReader('change_request', ['number', 'test_plan'], 'state=3^test_planISEMPTY'), { name: 'itil_changes_without_test_evidence', args: {} }, [T('change_request', 'number', 'test_plan', 'state'), T('change_task', 'change_request', 'change_task_type')],
      { kind: 'detection_gap', not_covered: 'Closed changes with no test plan and no Testing task (change_task_type testing, ServiceNow\'s own value, D-034). Attachments and releases are not read.' }) },
  'ITIL-068': eq('record_predicate', 'ITSM-098', 'The same condition as ITSM-098 (test plan empty on high-risk changes): counted once, in ITSM.', ['change_request']),
  'ITIL-069': { a: 'record_predicate', cand: ['change_request'], params: [], config: undef(R.noRecord('acceptance criteria on a change (no such field)')) },
  'ITIL-070': { a: 'configuration_inspection', cand: [], params: [], config: undef(R.noRecord('the test instance\'s configuration (it is another instance)')) },
  'ITIL-071': { a: 'temporal_correlation', also: ['configuration'], cand: ['sys_upgrade_history', 'sys_atf_test_suite_result'], params: [],
    config: cfg(rowsReader('sys_upgrade_history', ['to_version', 'upgrade_started'], 'to_versionSTARTSWITHglide-'), { name: 'itil_upgrades_without_regression', args: {} }, [T('sys_upgrade_history', 'to_version', 'upgrade_started'), T('sys_atf_test_suite_result', 'start_time'), T('sys_atf_test_result', 'start_time')],
      { kind: 'detection_gap', not_covered: 'Platform upgrades (sys_upgrade_history, to a glide- build) after which no Automated Test Framework result was recorded (D-034). A regression suite run outside ATF is charged (the guard).' }) },
  'ITIL-072': { a: 'aggregate_distribution', also: ['configuration'], cand: ['sys_atf_test', 'sys_update_version'], params: [P('max_changes', 'number', null, 5, 'modifications that make a hotspot (PLT-164\'s)', 'D-037'), P('window', 'duration', 'months', 12, 'hotspot window (PLT-164\'s)', 'D-037')],
    config: cfg(rowsReader('sys_properties', ['name'], 'name=glide.product.name'), { name: 'itil_hotspots_untested', args: { max: param('max_changes'), window: { $param: 'window', as: 'window' } } },
      [T('sys_properties', 'name'), T('sys_update_version', 'name', 'source_table'), T('sys_atf_step', 'test', 'table', 'active'), T('sys_atf_test', 'active'), T('sys_variable_value', 'document', 'document_key', 'value')],
      { kind: 'detection_gap', not_covered: 'Hotspots are PLT-164\'s (more than 5 customer versions in 12 months); an object is covered when an active ATF step runs on its table, or a step input names the object or the catalog item it belongs to (D-037). Tests in an external framework (the guard) are not seen.' }) },
  'ITIL-073': { a: 'temporal_correlation', cand: ['sys_atf_test_result'], params: [], config: undef(R.noRecord('an override of a failed test before promotion')) },
  'ITIL-074': { a: 'record_predicate', cand: ['change_request'], params: [], config: undef(R.noRecord('a change objective and its outcome validation')) },

  /* ═══ Group 7 — Capacity and Performance ═══ */
  'ITIL-075': { a: 'configuration_inspection', cand: [], params: [], config: undef(R.noRecord('capacity plans or forecasts (no capacity management product on the instance)')) },
  'ITIL-076': { a: 'configuration_inspection', cand: [], params: [], config: undef(R.noRecord('capacity thresholds as records')) },
  'ITIL-077': { a: 'aggregate_distribution', cand: ['sys_physical_table_stats'], params: [], config: undef('growth metrics against known platform and licence limits — the limits are external reference data and table statistics are empty on the instance') },
  'ITIL-078': { a: 'cross_record_linkage', cand: ['incident', 'problem'], params: [], config: undef(R.customer('which close codes mean "capacity-related"')) },
  'ITIL-079': { a: 'configuration_inspection', cand: ['dmn_demand'], params: [], config: undef(R.noRecord('a demand forecast linked to capacity planning')) },
  'ITIL-080': { a: 'configuration_inspection', cand: [], params: [], config: undef(R.noRecord('performance baselines as records')) },
  'ITIL-081': { a: 'configuration_inspection', cand: ['sys_report'], params: [], config: undef(R.noRecord('an action threshold on a capacity report')) },
  'ITIL-082': { a: 'aggregate_distribution', also: ['configuration'], cand: ['subscription_detail'], params: [],
    config: cfg(rowsReader('subscription_detail', ['subscription_name', 'status', 'allocated_count'], 'is_latest=true'), { name: 'itil_subscriptions_over', args: {} }, [T('subscription_detail', 'subscription_name', 'status', 'allocated_count', 'is_latest')],
      { kind: 'detection_gap', not_covered: 'Consumption against entitlement is Subscription Management\'s own status on its latest calculation: Over-allocated is charged, Near capacity reported (D-034); no calculation at all is the absence. The trend and the projected renewal position are not computed (no horizon is given). Entitlement managed outside the platform is charged (the guard).' }) },
  'ITIL-083': { a: 'configuration_inspection', cand: ['risk_conditions'], params: [], config: undef(R.customer('which change risk condition counts as a capacity dimension')) },
  'ITIL-084': { a: 'configuration_inspection', cand: ['sys_user_role'], params: [], config: undef(R.noRecord('a capacity management role (ServiceNow ships none)')) },

  /* ═══ Group 8 — Availability ═══ */
  'ITIL-085': { a: 'configuration_inspection', cand: ['service_availability', 'cmdb_ci_outage'], params: [],
    config: cfg(rowsReader('service_availability', ['cmdb_ci']), { name: 'absent_despite_volume', args: { volume_table: 'cmdb_ci_service', query: 'operational_status=1' } }, [T('service_availability', 'cmdb_ci')],
      { kind: 'detection_gap', not_covered: 'Availability measurement is ServiceNow\'s service availability record (service_availability, D-034): none at all while services are operational. External monitoring is charged (the guard).' }) },
  'ITIL-086': { a: 'cross_record_linkage', cand: ['incident', 'task_outage'], params: [], config: undef(R.noProduct('Major Incident Management', 'plugin com.snc.incident.mim inactive')) },
  'ITIL-087': { a: 'cross_record_linkage', also: ['configuration'], cand: ['cmdb_ci_service', 'service_offering', 'service_commitment'], params: [],
    config: cfg(rowsReader('cmdb_ci_service', ['name', 'busines_criticality', 'operational_status'], 'operational_status=1'), { name: 'itil_services_without_commitment', args: { types: ['availability', 'SLA'] } }, [T('cmdb_ci_service', 'name', 'operational_status'), T('service_offering', 'parent'), T('service_offering_commitment', 'service_offering', 'service_commitment'), T('service_commitment', 'type')],
      { kind: 'detection_gap', not_covered: 'A service\'s targets are the commitments (type Availability or SLA, ServiceNow\'s own types, D-034) of its offerings. A target held only in a contract is charged (the guard).' }) },
  'ITIL-088': { a: 'record_predicate', cand: ['cmdb_ci_outage'], params: [],
    config: { requires_tables: [T('cmdb_ci_outage', 'number', 'type', 'cmdb_ci')], table: 'cmdb_ci_outage', predicates: [{ field: 'type', op: 'empty' }], evidence_fields: ['number', 'cmdb_ci', 'begin'], report_ratio: true,
      partial: { kind: 'detection_gap', not_covered: 'Outage records with no type (Outage, Degradation, Planned Outage — ServiceNow\'s own values). Undisclosed exclusions in availability reports are not read.' } } },
  'ITIL-089': { a: 'relationship_graph', cand: ['cmdb_ci_service', 'cmdb_rel_ci'], params: [], config: undef(R.customer('how a redundant peer is recognised in the CMDB (a cluster, a load-balanced pool, a named relationship type) and how deep the dependency path is walked')) },
  'ITIL-090': { a: 'configuration_inspection', cand: ['risk_conditions'], params: [], config: undef(R.customer('which change risk condition counts as an availability / redundancy dimension')) },
  'ITIL-091': { a: 'record_predicate', cand: ['service_availability'], params: [],
    config: { requires_tables: [T('service_availability', 'cmdb_ci', 'mtbf')], table: 'service_availability', predicates: [{ field: 'mtbf', op: 'empty' }], evidence_fields: ['cmdb_ci', 'start', 'end'], report_ratio: true,
      partial: { kind: 'detection_gap', not_covered: 'MTBF is the service availability record\'s own field; a record without it is charged. Where no availability is recorded at all, ITIL-085 carries the finding.' } } },
  'ITIL-092': { a: 'cross_record_linkage', cand: ['service_availability', 'em_connector_instance'], params: [], config: undef(R.customer('how a service\'s monitoring coverage is recognised (the ITOM-085 question)')) },
  'ITIL-093': { a: 'configuration_inspection', cand: ['cmdb_ci_service'], params: [], config: undef(R.noRecord('a vital business function on a service')) },
  'ITIL-094': { a: 'configuration_inspection', cand: ['sys_user_role'], params: [], config: undef(R.noRecord('an availability management role (ServiceNow ships none)')) },

  /* ═══ Group 9 — Service Continuity (Business Continuity Management not installed) ═══ */
  'ITIL-095': { a: 'cross_record_linkage', cand: ['cmdb_ci_service'], params: [], config: undef(R.noProduct('Business Continuity Management', 'no sn_bcm_* tables')) },
  'ITIL-096': { a: 'record_predicate', also: ['configuration'], cand: ['cmdb_ci_service', 'service_commitment'], params: [],
    config: cfg(rowsReader('cmdb_ci_service', ['name', 'busines_criticality', 'operational_status'], 'busines_criticality=1 - most critical'), { name: 'itil_services_without_commitment', args: { types: ['recovery_time_objective', 'recovery_point_objective'], all: true } }, [T('cmdb_ci_service', 'name', 'busines_criticality'), T('service_offering', 'parent'), T('service_offering_commitment', 'service_offering', 'service_commitment'), T('service_commitment', 'type')],
      { kind: 'detection_gap', not_covered: 'RTO and RPO are ServiceNow\'s own commitment types (Recovery time objective, Recovery point objective, D-034); a Business Critical service (busines_criticality "1 - most critical") is charged unless its offerings carry both. A register held outside the platform is charged (the guard).' }) },
  'ITIL-097': { a: 'cross_record_linkage', cand: ['service_commitment', 'cmdb_ci'], params: [], config: undef(R.noRecord('the recovery characteristics of supporting CIs')) },
  'ITIL-098': { a: 'temporal_correlation', cand: [], params: [], config: undef(R.noProduct('Business Continuity Management', 'no sn_bcm_* tables')) },
  'ITIL-099': { a: 'temporal_correlation', cand: [], params: [], config: undef(R.noProduct('Business Continuity Management', 'no sn_bcm_* tables')) },
  'ITIL-100': { a: 'cross_record_linkage', cand: ['cmdb_ci'], params: [], config: undef(R.noProduct('Business Continuity Management', 'no continuity requirement is recorded on services, and no DR environment value on CIs (the environment choices are Development, Test, Production)')) },
  'ITIL-101': { a: 'configuration_inspection', cand: [], params: [], config: undef(R.noProduct('Business Continuity Management', 'no DR CI set is recorded')) },
  'ITIL-102': { a: 'cross_record_linkage', cand: [], params: [], config: undef(R.noProduct('Business Continuity Management', 'no sn_bcm_* tables')) },
  'ITIL-103': { a: 'record_predicate', cand: [], params: [], config: undef(R.noProduct('Business Continuity Management', 'no sn_bcm_* tables')) },
  'ITIL-104': { a: 'record_predicate', cand: [], params: [], config: undef(R.noProduct('Business Continuity Management', 'no sn_bcm_* tables')) },

  /* ═══ Group 10 — Supplier ═══ */
  'ITIL-105': { a: 'cross_record_linkage', cand: ['cmdb_ci_service', 'core_company'], params: [], config: undef(R.customer('which services have external (supplier) dependencies')) },
  'ITIL-106': { a: 'cross_record_linkage', also: ['configuration'], cand: ['ast_contract', 'contract_rel_ci'], params: [],
    config: cfg(rowsReader('ast_contract', ['number', 'short_description', 'vendor', 'state'], 'active=true'), { name: 'itil_contracts_unlinked', args: {} }, [T('ast_contract', 'number', 'vendor', 'active'), T('contract_rel_ci', 'contract', 'ci_item')],
      { kind: 'detection_gap', not_covered: 'The contract → CI / service link is contract_rel_ci (ci_item), and the contract → asset link is clm_m2m_contract_asset where Contract Management is present (D-034): an active contract with neither is charged. The reverse half — services with a supplier dependency and no contract — needs the dependency, which is not recorded.' }) },
  'ITIL-107': { a: 'configuration_inspection', cand: ['ast_contract'], params: [], config: undef(R.noRecord('supplier performance measurements against contract terms')) },
  'ITIL-108': { a: 'temporal_correlation', cand: ['ast_contract'], params: [P('notice_period', 'duration', 'days', null, 'notice period before expiry — UNDEFINED')], config: undef(R.threshold('the notice period before a contract\'s end (ast_contract records no notice date)')) },
  'ITIL-109': { a: 'cross_record_linkage', cand: ['incident'], params: [], config: undef(R.customer('which close codes mean "vendor-related"')) },
  'ITIL-110': eq('configuration_inspection', 'PLT-134', 'The same condition as PLT-134 (no access recertification evidenced), which the supplied rule joins: counted once, in Platform.', ['sys_user_has_role']),
  'ITIL-111': eq('reference_integrity', 'PLT-153', 'The same condition as PLT-153 (integration with no documented owner), which the supplied rule joins: counted once, in Platform.', ['sys_rest_message']),
  'ITIL-112': { a: 'configuration_inspection', cand: [], params: [], config: undef(R.noRecord('a recurring contract ↔ commitment reconciliation activity')) },
  'ITIL-113': { a: 'aggregate_distribution', cand: ['core_company', 'ast_contract'], params: [P('share', 'percent', null, null, 'dependency concentration — UNDEFINED')], config: undef(R.threshold('the concentration of dependent services that counts as a risk')) },
  'ITIL-114': { a: 'record_predicate', cand: [], params: [], config: undef(R.noRecord('supplier exit or transition plans')) },

  /* ═══ Group 11 — Service Desk ═══ */
  'ITIL-115': { a: 'aggregate_distribution', also: ['configuration'], cand: ['incident', 'sc_request'], params: [],
    config: cfg(rowsReader('sys_properties', ['name'], 'name=glide.product.name'), { name: 'itil_channel_distribution', args: { tables: ['incident', 'sc_request'] } }, [T('incident', 'contact_type'), T('sc_request', 'contact_type')],
      { kind: 'evidence_gap', not_covered: 'A measure: the contact type (channel) distribution of incidents and requests, with the share left empty. The rule gives no threshold, so nothing is judged.' }) },
  'ITIL-116': { a: 'configuration_inspection', cand: ['ssa_deflection_configuration', 'ssa_deflection_metric'], params: [],
    config: cfg(rowsReader('ssa_deflection_metric', ['type']), { name: 'absent_despite_volume', args: { volume_table: 'kb_use' } }, [T('ssa_deflection_metric', 'type')],
      { kind: 'detection_gap', not_covered: 'Deflection measurement is ServiceNow\'s self-service deflection metric (ssa_deflection_metric, D-034): none recorded while articles are used. External measurement is charged (the guard).' }) },
  'ITIL-117': { a: 'configuration_inspection', cand: ['pa_indicators'], params: [], config: undef(R.customer('which measurement is first contact resolution')) },
  'ITIL-118': { a: 'configuration_inspection', cand: [], params: [], config: undef(R.noRecord('call or portal abandonment (telephony data)')) },
  'ITIL-119': { a: 'configuration_inspection', cand: ['cmdb_ci_service'], params: [], config: undef(R.customer('which service record is the service desk')) },
  'ITIL-120': { a: 'configuration_inspection', also: ['configuration'], cand: ['cmn_rota_escalation_set', 'cmn_rota'], params: [],
    config: cfg(rowsReader('cmn_rota', ['name', 'group', 'use_custom_escalation'], 'active=true'), { name: 'itil_escalation_unresolved', args: {} },
      [T('cmn_rota', 'name', 'group', 'use_custom_escalation', 'active'), T('cmn_rota_escalation_set', 'cmn_rota', 'active'), T('cmn_rota_esc_step_def', 'escalation_set', 'sys_users', 'sys_user_groups', 'cmn_rota_rosters', 'group_manager'), T('cmn_rota_roster', 'rota', 'active'), T('cmn_rota_member', 'roster', 'member'), T('sys_user_group', 'manager'), T('sys_user_grmember', 'group', 'user'), T('sys_user', 'active')],
      { kind: 'detection_gap', not_covered: 'Escalation is On-Call Scheduling\'s own configuration (D-034): a custom escalation\'s active sets and steps (users, groups, rosters, group manager), or the default escalation through the rota\'s active rosters, resolved to active users. Roster member date windows and catch-all settings are not judged; escalation by convention is charged (the guard).' }) },
  'ITIL-121': { a: 'configuration_inspection', cand: ['awa_agent_capacity'], params: [], config: undef(R.noRecord('agent workload against capacity (Advanced Work Assignment capacity is not in use)')) },
  'ITIL-122': { a: 'aggregate_distribution', cand: ['asmt_assessment_instance'], params: [P('margin', 'percent', null, null, 'acceptable confidence margin — UNDEFINED')], config: undef(R.threshold('the confidence margin a survey must reach to support inference')) },
  'ITIL-123': { a: 'configuration_inspection', cand: ['sys_report'], params: [], config: undef(R.noRecord('tier or queue type in reporting')) },
  'ITIL-124': eq('cross_record_linkage', 'ITSM-046', 'The same condition as ITSM-046 (major incident with no communication plan or task), which the supplied rule joins: counted once, in ITSM.', ['incident']),

  /* ═══ Group 12 — Portfolio, Demand and Financial ═══ */
  'ITIL-125': { a: 'configuration_inspection', cand: ['cmdb_ci_service', 'life_cycle_stage'], params: [], config: undef(R.customer('which life cycle stages are the portfolio\'s "pipeline" and "retired" stages')) },
  'ITIL-126': { a: 'configuration_inspection', cand: ['dmn_demand', 'change_request'], params: [],
    config: cfg(rowsReader('dmn_demand', ['number']), { name: 'absent_despite_volume', args: { volume_table: 'change_request', query: 'active=true' } }, [T('dmn_demand', 'number')],
      { kind: 'detection_gap', not_covered: 'Demand is ServiceNow\'s Demand Management record (dmn_demand, D-034): none while changes are open. A backlog outside the platform is charged (the guard).' }) },
  'ITIL-127': { a: 'record_predicate', cand: ['dmn_demand'], params: [],
    config: { requires_tables: [T('dmn_demand', 'number', 'business_applications', 'business_capabilities')], table: 'dmn_demand', predicates: [{ field: 'business_applications', op: 'empty' }, { field: 'business_capabilities', op: 'empty' }], evidence_fields: ['number'], report_ratio: true } },
  'ITIL-128': { a: 'cross_record_linkage', also: ['configuration'], cand: ['cmdb_ci_service', 'fm_expense_line'], params: [],
    config: cfg(rowsReader('cmdb_ci_service', ['name'], 'operational_status=1'), { name: 'itil_service_cost', args: { mode: 'unattributed' } }, [T('cmdb_ci_service', 'name', 'operational_status'), T('cmdb_rel_ci', 'parent', 'child'), T('fm_expense_line', 'ci')],
      { kind: 'detection_gap', not_covered: 'Cost attribution is an expense line (fm_expense_line) on the service; the cost data available is expense lines on its direct supporting CIs (cmdb_rel_ci children), D-034. Deeper dependencies and costing in a finance system (the guard) are not seen.' }) },
  'ITIL-129': { a: 'configuration_inspection', cand: ['fm_expense_line'], params: [], config: undef(R.customer('whether a chargeback or showback model is in use')) },
  'ITIL-130': { a: 'configuration_inspection', cand: ['cost_plan'], params: [], config: undef(R.noRecord('a budget linked to a service record')) },
  'ITIL-131': { a: 'cross_record_linkage', also: ['configuration'], cand: ['cmdb_ci_service', 'fm_expense_line'], params: [],
    config: cfg(rowsReader('cmdb_ci_service', ['name'], 'operational_status=6^ORinstall_status=7'), { name: 'itil_service_cost', args: { mode: 'retired' } }, [T('cmdb_ci_service', 'name', 'operational_status', 'install_status'), T('cmdb_rel_ci', 'parent', 'child'), T('cmdb_ci', 'operational_status'), T('fm_expense_line', 'ci')],
      { kind: 'detection_gap', not_covered: 'A retired service is operational status Retired (6) or install status Retired (7); its supporting CIs are its direct cmdb_rel_ci children in operational status Operational (1) with expense lines (D-034). A wind-down period (the guard) is charged.' }) },
  'ITIL-132': { a: 'record_predicate', cand: ['dmn_demand'], params: [],
    config: { requires_tables: [T('dmn_demand', 'number', 'goal', 'financial_benefit')], table: 'dmn_demand', predicates: [{ field: 'goal', op: 'empty' }, { field: 'financial_benefit', op: 'empty' }], evidence_fields: ['number'], report_ratio: true } },
  'ITIL-133': { a: 'temporal_correlation', cand: ['cmdb_ci_service'], params: [], config: undef(R.noRecord('the performance data a portfolio decision referenced')) },
  'ITIL-134': { a: 'configuration_inspection', cand: ['sys_user_has_role'], params: [],
    config: cfg(rowsReader('sys_user_role', ['name'], 'name=portfolio_manager'), { name: 'itil_role_unheld', args: { role: 'portfolio_manager' } }, [T('sys_user_role', 'name'), T('sys_user_has_role', 'user', 'role'), T('sys_user', 'active')],
      { kind: 'detection_gap', not_covered: 'The portfolio owner is ServiceNow\'s portfolio_manager role (D-034): absent when no active user holds it.' }) },

  /* ═══ Group 13 — Continual Improvement (Continual Improvement Management not installed) ═══ */
  ...Object.fromEntries(['135', '136', '137', '138', '139', '140', '141', '142'].map((n) => [`ITIL-${n}`,
    { a: 'configuration_inspection', cand: [], params: [], config: undef(R.noProduct('Continual Improvement Management', 'no improvement register')) }])),

  /* ═══ Group 14 — Cross-Practice ═══ */
  'ITIL-143': eq('composite', 'ITSM-129', 'The same condition as ITSM-129 (the processes not referencing the CMDB / a shared service model), which the supplied rule joins: counted once, in ITSM.', ['incident', 'problem', 'change_request']),
  'ITIL-144': eq('composite', 'ITOM-134', 'The same condition as ITOM-134 (a provisioning path bypassing CMDB registration), which the supplied rule joins: counted once, in ITOM.', ['sc_cat_item']),
  'ITIL-145': { a: 'composite', also: ['configuration'], cand: ['incident', 'problem', 'kb_knowledge', 'm2m_kb_task'], params: [],
    config: cfg(rowsReader('sys_properties', ['name'], 'name=glide.product.name'), { name: 'itil_loop_ratios', args: {} }, [T('incident', 'problem_id'), T('problem', 'number', 'known_error'), T('kb_knowledge', 'source', 'workflow_state'), T('m2m_kb_task', 'task')],
      { kind: 'detection_gap', not_covered: 'A measure, reported and never judged (no threshold is given): incident recurrence (incidents on a problem with more than one incident), problem creation, known-error publication (as ITSM-066) and article consumption (as ITIL-027), D-034.' }) },
  'ITIL-146': { a: 'composite', cand: ['service_commitment', 'cmdb_rel_ci'], params: [], config: undef(R.noRecord('the recorded recovery characteristics of the infrastructure')) },
  'ITIL-147': { a: 'composite', derived_from: 'itil-quality/2', cand: [], params: [], note: 'The practice-level profile IS the ITIL module score by group (itil-quality/2 reports one score per practice group): shown as a row of its own, never scored twice.' },
  'ITIL-148': { a: 'configuration_inspection', also: ['configuration'], cand: ['pa_indicators', 'pa_job_indicators', 'pa_thresholds', 'pa_targets'], params: [],
    config: cfg(rowsReader('pa_job_indicators', ['indicator'], 'active=true^job.active=true'), { name: 'itil_indicators_ungoverned', args: {} }, [T('pa_job_indicators', 'indicator', 'job', 'active'), T('pa_thresholds', 'indicator', 'owner', 'active'), T('pa_targets', 'indicator', 'owner', 'active'), T('pa_indicators', 'name')],
      { kind: 'detection_gap', not_covered: 'A reported metric is a Performance Analytics indicator collected by an active job; its owner and action threshold are an active threshold (pa_thresholds) or target (pa_targets), which carry the owner (D-034). Correlated action records are not recorded; governance outside the platform is charged (the guard).' }) },
};

export const PLACEHOLDERS = {};
void PERSONAL;
