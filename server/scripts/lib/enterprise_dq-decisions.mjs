/**
 * HEALTH ASSIST PHASE 7 — the Enterprise Data Quality decision table: one entry per
 * workbook rule (DQ-084 … DQ-139, the data-quality sheet's "Enterprise Data Quality"
 * model; DQ-001 … DQ-083 restate CMDB rules and stay with CMDB).
 *
 * `node scripts/build-workbook-pack.mjs --pack enterprise_dq` turns this into the
 * pack's generated files. Every rule is in one recorded state (executable,
 * unconfigured, undefined, specification gap, object unverified, not built,
 * equivalent). The rules of the ITOM and Platform packs hold here: nothing is read
 * before it is verified on the instance, no platform value is hard-coded (choice
 * values come from $choice labels), and no threshold is invented.
 *
 * Every table and field named below was checked READ-ONLY on a real instance before
 * this table was written (Phase 7, techsnitchpvtltddemo2): the schema, not a guess.
 * Where the workbook names a field the platform does not have (a knowledge "review
 * date", a group or cost-centre "company", an asset "end-of-life date"), the rule
 * says so and is not evaluated against a substitute.
 */

const T = (table, ...fields) => ({ table, fields });
const choice = (table, element, label) => ({ $choice: { table, element, label } });
/* `source`: the recorded decision that took a default from ServiceNow's documentation (D-033) — never a guess. */
const P = (key, type, unit, dflt, description, source = null) => ({ key, type, unit, default: dflt, description, ...(source ? { source } : {}) });
const param = (key) => ({ $param: key });
const win = (key) => ({ $param: key, as: 'window' });
const undef = (...deps) => ({ undefined_dependencies: deps });
const pending = (text) => ({ build_pending: text });
const gap = (missing) => ({ specification_gap: { missing } });
const clause = (template, value) => ({ $clause: { template, value } });

/** A configuration rule over the rows of one table (the shared `table_rows` reader). */
const rows = (table, fields, query, compare, { requires, partial } = {}) => ({
  engine: 'configuration', requires_tables: requires ?? [T(table, ...fields)], reader: 'table_rows', args: { table, fields, query },
  compare, ...(partial ? { partial } : {}),
});

/* Catalog items that are ordered and fulfilled (sc_req_item): the requestable classes.
   Record producers, order guides, content items and wizards create no requested item
   and have no fulfilment (measured, Phase 7: 469 items, 219 of them requestable). */
const REQUESTABLE = 'sys_class_nameINsc_cat_item,pc_hardware_cat_item,pc_software_cat_item';
/* D-037: the tables DQ-098 reads — the master and reference data Enterprise DQ judges (the pack's own tables). */
const CHOICE_TABLES = ['sys_user', 'sys_user_group', 'core_company', 'cmn_location', 'cmn_department', 'alm_asset', 'cmdb_ci', 'cmdb_ci_hardware', 'cmdb_model', 'kb_knowledge', 'sc_cat_item', 'sc_req_item', 'task', 'contract_sla', 'sysapproval_approver'];
/* Accounts that do not sign in as people (the platform's own flags). */
const PEOPLE = 'active=true^web_service_access_only=false^internal_integration_user=false';

/* D-032: the personal-data classes of the instance's Data Classification (m2m_dictionary_dataclass field tags). */
const PERSONAL_DATA_CLASSES = ['Personally identifiable information', 'HR PII', 'Master data PII', 'Transactional Data PII', 'Contact information', 'Identification information', 'Demographic information'];

const R = {
  noReviewDate: 'kb_knowledge has no owner and no review-date field on the platform (verified, Phase 7: author, ownership_group and valid_to exist) — which fields stand for "owner" and "review date" is not given',
  hrFeed: 'which data source is the HR feed — not identified by the workbook, and not recorded on sys_data_source',
  multiCompanyGroup: 'a group\'s company scope — sys_user_group has no company field on the platform (verified, Phase 7)',
  personalData: 'personal data found by content ("from DQ-133 detection") — DQ-133 has no pattern set; the classified fields alone cannot show personal data that is NOT classified',
  retention: 'the customer\'s retention periods per record type — a policy the platform does not hold',
};

export const RULES = {
  /* ═══ Q1. Completeness ═══ */
  'DQ-084': { a: 'record_predicate', cand: ['sys_user_group'], params: [],
    config: { requires_tables: [T('sys_user_group', 'name', 'active', 'manager', 'email')], table: 'sys_user_group', scope: 'active=true',
      predicates: [{ field: 'manager', op: 'empty' }, { field: 'email', op: 'empty' }], evidence_fields: ['name'], report_ratio: true,
      partial: { kind: 'evidence_gap', not_covered: 'Active groups with neither a manager nor an email are found; the escalation for groups referenced by open tasks, and the role-container guard, are not applied.' } } },
  'DQ-085': { a: 'record_predicate', also: ['configuration'], cand: ['cmn_location', 'contract_sla', 'sysrule_assignment'], params: [],
    config: rows('cmn_location', ['name', 'country', 'time_zone'], '', { name: 'dq_location_fields_referenced', args: {} }, {
      requires: [T('cmn_location', 'name', 'country', 'time_zone'), T('contract_sla', 'start_condition', 'stop_condition', 'active'), T('sysrule_assignment', 'condition', 'active')],
      partial: { kind: 'detection_gap', not_covered: 'The rules that depend on the fields are the active SLA definitions and assignment rules whose conditions read location.country or location.time_zone (D-033); routing in flows is not read.' } }) },
  'DQ-086': { a: 'record_predicate', cand: ['alm_asset', 'alm_hardware'], params: [],
    config: { requires_tables: [T('alm_asset', 'display_name', 'model', 'serial_number', 'sys_class_name')], table: 'alm_asset', evidence_fields: ['display_name', 'sys_class_name'], report_ratio: true,
      variants: [
        { variant: 'no model', scope: '', predicates: [{ field: 'model', op: 'empty' }] },
        /* A serial is judged on hardware only: consumables and licences have none (the workbook's guard). */
        { variant: 'no serial number (hardware)', scope: 'sys_class_name=alm_hardware', predicates: [{ field: 'serial_number', op: 'empty' }] },
      ],
      partial: { kind: 'evidence_gap', not_covered: 'The two cases are reported separately; assets missing both are not escalated.' } } },
  'DQ-087': { a: 'record_predicate', cand: ['sys_user'], params: [],
    config: { requires_tables: [T('sys_user', 'user_name', 'active', 'manager', 'web_service_access_only', 'internal_integration_user')], table: 'sys_user', scope: PEOPLE,
      predicates: [{ field: 'manager', op: 'empty' }], evidence_fields: ['user_name'], report_ratio: true,
      partial: { kind: 'false_positive_risk', not_covered: 'Integration and web-service-only accounts are excluded. The top of the hierarchy has no manager by design and is still counted; the join to the approval workflows that resolve through the manager is not made.' } } },
  'DQ-088': { a: 'record_predicate', cand: ['cmn_cost_center'], params: [], config: undef('whether a financial integration exists — the workbook fires the rule "where financial integration exists", and that is not recorded on the instance') },
  'DQ-089': { a: 'record_predicate', cand: ['sys_user'], params: [],
    config: { requires_tables: [T('sys_user', 'user_name', 'active', 'department', 'location', 'company', 'web_service_access_only', 'internal_integration_user')], table: 'sys_user', evidence_fields: ['user_name'], report_ratio: true,
      variants: ['department', 'location', 'company'].map((f) => ({ variant: `no ${f}`, scope: PEOPLE, predicates: [{ field: f, op: 'empty' }] })),
      partial: { kind: 'false_positive_risk', not_covered: 'Reported per field; users missing all three are not escalated. Contractors and external users cannot be told apart (no user type on the platform) and are counted.' } } },
  'DQ-090': { a: 'record_predicate', also: ['configuration'], cand: ['sys_user_group'], params: [],
    config: rows('sys_user_group', ['name', 'type', 'active'], 'active=true', { name: 'dq_empty_where_used', args: { field: 'type', label: 'name', unit: 'active groups', practice: 'group typing' } }) },
  'DQ-091': { a: 'record_predicate', cand: ['sc_cat_item'], params: [],
    config: { requires_tables: [T('sc_cat_item', 'name', 'active', 'owner', 'group', 'sys_class_name')], table: 'sc_cat_item', evidence_fields: ['name', 'sys_class_name'], report_ratio: true,
      variants: [
        { variant: 'no owner', scope: `active=true^${REQUESTABLE}`, predicates: [{ field: 'owner', op: 'empty' }] },
        { variant: 'no fulfilment group', scope: `active=true^${REQUESTABLE}`, predicates: [{ field: 'group', op: 'empty' }] },
      ],
      partial: { kind: 'false_positive_risk', not_covered: 'Requestable items only (record producers, order guides and content items have no fulfilment). An item whose workflow or flow assigns the group dynamically is still counted under "no fulfilment group"; the escalation is not applied.' } } },
  'DQ-092': { a: 'record_predicate', cand: ['cmn_location'], params: [], config: undef('the intended root locations — "identified by configuration or by depth", and neither is given') },
  'DQ-093': { a: 'record_predicate', cand: ['cmdb_model'], params: [],
    config: { requires_tables: [T('cmdb_model', 'name', 'status', 'manufacturer')], table: 'cmdb_model', scope: [clause('status!={}', choice('cmdb_model', 'status', 'Retired'))],
      predicates: [{ field: 'manufacturer', op: 'empty' }], evidence_fields: ['name', 'sys_class_name'], report_ratio: true,
      partial: { kind: 'false_positive_risk', not_covered: '"Active" is read as not Retired. Generic or internal models with no manufacturer are counted.' } } },
  'DQ-094': { a: 'record_predicate', cand: ['kb_knowledge'], params: [],
    config: { requires_tables: [T('kb_knowledge', 'number', 'workflow_state', 'ownership_group', 'valid_to')], table: 'kb_knowledge', scope: 'workflow_state=published', evidence_fields: ['number', 'ownership_group', 'valid_to'], report_ratio: true,
      variants: [
        { variant: 'no owner', predicates: [{ field: 'ownership_group', op: 'empty' }] },
        { variant: 'no review date', predicates: [{ field: 'valid_to', op: 'in', value: ['', '2100-01-01'] }] },
      ],
      partial: { kind: 'false_positive_risk', not_covered: 'ServiceNow\'s article owner is the ownership group and its review date is Valid to, which the platform sets to 2100-01-01 when none is given (D-033). A knowledge base that does not use ownership groups is charged on every article.' } } },

  /* ═══ Q2. Validity ═══ */
  'DQ-095': { a: 'reference_integrity', cand: ['sys_user', 'sysapproval_approver', 'sys_user_delegate'], params: [],
    config: { requires_tables: [T('sys_user', 'user_name', 'active', 'manager')], table: 'sys_user', scope: 'active=true^managerISNOTEMPTY', field: 'manager', target: 'sys_user', check: 'active', report: ['missing', 'inactive'], evidence_fields: ['user_name'],
      partial: { kind: 'detection_gap', not_covered: 'Manager references are judged; approval definitions (workflow and flow logic) are not readable as data, open approvals to inactive approvers are DQ-126, and the delegate grace-period guard is not applied.' } } },
  'DQ-096': { a: 'reference_integrity', cand: ['sysapproval_group', 'sys_user_grmember', 'sys_user'], params: [],
    config: { requires_tables: [T('sysapproval_group', 'assignment_group', 'active'), T('sys_user_grmember', 'group', 'user')], table: 'sysapproval_group', scope: 'active=true^assignment_groupISNOTEMPTY', field: 'assignment_group', target: 'sys_user_group', check: 'members_active', report: ['inactive'], evidence_fields: ['number'],
      partial: { kind: 'detection_gap', not_covered: 'Open group approvals are judged against the group\'s active members now; approval configuration in workflows and flows is not readable as data. Overlap OWN-008: scoped to approver groups only.' } } },
  'DQ-097': { a: 'record_predicate', also: ['configuration'], cand: ['sysevent_email_action', 'sys_user', 'sys_user_group'], params: [],
    config: rows('sysevent_email_action', ['recipient_users', 'recipient_groups'], 'active=true', { name: 'dq_notification_email_format', args: {} }, {
      requires: [T('sysevent_email_action', 'active', 'recipient_users', 'recipient_groups'), T('sys_user', 'email', 'active'), T('sys_user_group', 'email', 'active')],
      partial: { kind: 'detection_gap', not_covered: 'Users and groups named directly on active notifications are judged with a permissive validator; recipients reached through a record field are resolved per record and are not.' } }) },
  'DQ-098': { a: 'record_predicate', also: ['configuration'], cand: ['sys_choice', 'sys_dictionary'], params: [],
    config: rows('sys_properties', ['name'], 'name=glide.product.name', { name: 'dq_choice_values_unlisted', args: { tables: CHOICE_TABLES } }, {
      requires: [T('sys_properties', 'name'), T('sys_dictionary', 'name', 'element', 'choice', 'internal_type', 'choice_table'), T('sys_choice', 'name', 'element', 'value', 'inactive'), T('sys_db_object', 'name', 'super_class')],
      partial: { kind: 'detection_gap', not_covered: 'The dropdown choice fields (choice 1 or 3) of the master and reference tables Enterprise Data Quality judges (D-037); values in use on active records, per record class, against the class\'s own list or the nearest table it extends that has one; workflow stages and choices drawn from another table are not sys_choice lists and are left out. Inactive choices still in use are their own case (the workbook). Other tables are not read: 29,518 choice fields exist on the validation instance.' } }) },
  'DQ-099': { a: 'cross_record_linkage', also: ['configuration'], cand: ['alm_asset', 'cmdb_ci', 'alm_asset_ci_state_mapping', 'alm_hardware_state_mapping'], params: [],
    config: rows('alm_asset', ['display_name', 'install_status', 'substatus', 'ci', 'sys_class_name'], 'ciISNOTEMPTY', { name: 'dq_asset_ci_state_contradiction', args: {} }, {
      requires: [T('alm_asset', 'install_status', 'substatus', 'ci'), T('alm_asset_ci_state_mapping', 'asset_state', 'configuration_item_status'), T('alm_hardware_state_mapping', 'asset_state', 'hardware_ci_status'), T('cmdb_ci', 'install_status'), T('cmdb_ci_hardware', 'hardware_status')],
      partial: { kind: 'detection_gap', not_covered: 'The mapping is the platform\'s own (Asset CI Install Status Mapping; hardware state mapping for hardware, D-033), read from the asset side: rows that map asset → CI or both ways.' } }) },
  'DQ-100': { a: 'record_predicate', cand: ['sys_user'], params: [],
    config: { requires_tables: [T('sys_user', 'user_name', 'manager')], table: 'sys_user', scope: 'managerISNOTEMPTY', predicates: [{ field: 'manager', field2: 'sys_id', op: 'same_as' }], evidence_fields: ['user_name', 'active'], report_ratio: true,
      partial: { kind: 'false_positive_risk', not_covered: 'The top-of-hierarchy guard for executives is not applied: a self-manager is always reported.' } } },
  'DQ-101': { a: 'record_predicate', cand: ['sys_user'], params: [], config: undef('the phone pattern set per region — "for India include the standard mobile and landline formats", no pattern given') },
  'DQ-102': { a: 'cross_record_linkage', also: ['configuration'], cand: ['cmdb_model', 'cmdb_ci'], params: [],
    config: rows('cmdb_ci', ['name', 'sys_class_name', 'model_id'], 'model_idISNOTEMPTY', { name: 'dq_model_class_contradiction', args: {} }, {
      requires: [T('cmdb_ci', 'name', 'sys_class_name', 'model_id'), T('cmdb_model', 'name', 'cmdb_ci_class')],
      partial: { kind: 'detection_gap', not_covered: 'The mapping is the model\'s own CI class (cmdb_model.cmdb_ci_class, D-033); a CI in that class or a subclass agrees.' } }) },

  /* ═══ Q3. Consistency ═══ */
  'DQ-103': { a: 'relationship_graph', also: ['configuration'], cand: ['sys_user'], params: [],
    config: rows('sys_user', ['user_name', 'manager'], 'managerISNOTEMPTY', { name: 'dq_reference_cycles', args: { field: 'manager', label: 'user_name', unit: 'users with a manager', selfLoops: false } }, {
      partial: { kind: 'evidence_gap', not_covered: 'The whole manager graph is walked (each user once), so no depth bound is needed. A user who is their own manager is DQ-100, not a loop here.' } }) },
  'DQ-104': { a: 'relationship_graph', also: ['configuration'], cand: ['cmn_location'], params: [],
    config: rows('cmn_location', ['name', 'parent'], 'parentISNOTEMPTY', { name: 'dq_reference_cycles', args: { field: 'parent', label: 'name', unit: 'locations with a parent', selfLoops: true } }, {
      partial: { kind: 'evidence_gap', not_covered: 'The whole location tree is walked (each location once), so no depth bound is needed; a location that is its own parent is reported as a loop of one.' } }) },
  'DQ-105': { a: 'cross_record_linkage', also: ['configuration'], cand: ['sys_user', 'cmn_department'], params: [],
    config: rows('sys_user', ['user_name', 'company', 'department'], 'active=true^companyISNOTEMPTY^departmentISNOTEMPTY', { name: 'dq_department_company', args: {} }, {
      requires: [T('sys_user', 'active', 'company', 'department'), T('cmn_department', 'company')],
      partial: { kind: 'false_positive_risk', not_covered: '"Multi-company" is read as active users in more than one company. Cross-entity secondments are counted.' } }) },
  'DQ-106': { a: 'cross_record_linkage', cand: ['sys_user_group', 'sys_user_grmember'], params: [], config: undef(R.multiCompanyGroup) },
  'DQ-107': { a: 'cross_record_linkage', also: ['configuration'], cand: ['alm_asset', 'cmdb_ci'], params: [],
    config: rows('alm_asset', ['display_name', 'ci', 'assigned_to'], 'ciISNOTEMPTY^assigned_toISNOTEMPTY', { name: 'dq_asset_ci_assignee', args: {} }, {
      requires: [T('alm_asset', 'ci', 'assigned_to'), T('cmdb_ci', 'assigned_to')],
      partial: { kind: 'false_positive_risk', not_covered: 'The custodian-versus-user guard is not applied: a deliberate difference is counted.' } }) },
  'DQ-108': { a: 'text_analysis', cand: ['cmdb_ci', 'sys_user'], params: [P('divergence', 'percent', null, null, 'divergence threshold — UNDEFINED')], config: undef('which records\' names are compared, and the divergence measure and threshold') },
  'DQ-109': { a: 'relationship_graph', cand: ['cmn_location', 'cmn_department'], params: [P('variance', 'number', null, null, 'depth variance threshold — UNDEFINED ("configurable")')], config: undef('the depth-variance threshold — "configurable", no default') },
  'DQ-110': { a: 'cross_record_linkage', cand: ['cmn_cost_center'], params: [], config: undef('a cost centre\'s company — cmn_cost_center has no company field on the platform (verified, Phase 7: legal_entity only)') },

  /* ═══ Q4. Uniqueness ═══ */
  'DQ-111': { a: 'aggregate_distribution', also: ['configuration'], cand: ['sys_user'], params: [],
    config: rows('sys_user', ['user_name', 'email', 'employee_number', 'active'], '', { name: 'dq_duplicate_users', args: {} }, {
      partial: { kind: 'false_positive_risk', not_covered: 'Active-active pairs are charged; active-inactive pairs (supersession) are counted in the observation only. A deliberate second account (an admin account) sharing an email is counted.' } }) },
  'DQ-112': { a: 'aggregate_distribution', also: ['configuration'], cand: ['sys_user_group', 'sys_user_grmember'], params: [P('overlap', 'percent', null, 90, 'membership overlap'), P('min_members', 'number', null, 3, 'minimum membership')],
    config: rows('sys_user_grmember', ['group', 'user'], 'group.active=true^user.active=true', { name: 'dq_duplicate_groups', args: { overlap: param('overlap'), min_members: param('min_members') } }, {
      requires: [T('sys_user_grmember', 'group', 'user'), T('sys_user_group', 'active'), T('sys_user', 'active')],
      partial: { kind: 'false_positive_risk', not_covered: 'Overlap is the shared members over the union of the two active member sets (Jaccard). Groups with the same people serving different functions are counted.' } }) },
  'DQ-113': { a: 'text_analysis', also: ['configuration'], cand: ['cmn_location'], params: [],
    config: rows('cmn_location', ['name', 'street', 'city', 'zip', 'country'], 'streetISNOTEMPTY', { name: 'dq_duplicate_by', args: { fields: ['street', 'city', 'zip', 'country'], require: ['street'], label: 'name', unit: 'locations with a street address' } }, {
      partial: { kind: 'false_positive_risk', not_covered: 'Addresses are compared after case, spacing and punctuation are normalised; floors or buildings recorded as separate locations at one address are counted.' } }) },
  'DQ-114': { a: 'text_analysis', also: ['configuration'], cand: ['core_company'], params: [],
    config: rows('core_company', ['name'], 'nameISNOTEMPTY', { name: 'dq_duplicate_by', args: { fields: ['name'], require: ['name'], label: 'name', unit: 'companies' } }, {
      partial: { kind: 'detection_gap', not_covered: 'Names are compared after case, spacing and punctuation are normalised. core_company has no registration identifier on the platform (verified, Phase 7). Legally distinct entities with the same name are counted.' } }) },
  'DQ-115': { a: 'text_analysis', also: ['configuration'], cand: ['cmdb_model'], deps: { interpret: ['DQ-093'] }, params: [],
    config: rows('cmdb_model', ['name', 'manufacturer', 'model_number'], 'manufacturerISNOTEMPTY^model_numberISNOTEMPTY', { name: 'dq_duplicate_by', args: { fields: ['manufacturer', 'model_number'], require: ['manufacturer', 'model_number'], label: 'name', unit: 'models with a manufacturer and part number' } }, {
      partial: { kind: 'false_positive_risk', not_covered: 'The part number is the model number. Genuine variants sharing a part number are counted.' } }) },
  'DQ-116': { a: 'text_analysis', also: ['configuration'], cand: ['sc_cat_item', 'io_set_item'], params: [],
    config: rows('sc_cat_item', ['name', 'sys_class_name'], `active=true^${REQUESTABLE}`, { name: 'dq_duplicate_by', args: { fields: ['name'], require: ['name'], label: 'name', unit: 'active requestable items' } }, {
      requires: [T('sc_cat_item', 'name', 'active', 'sys_class_name')],
      partial: { kind: 'detection_gap', not_covered: 'Matching normalised names are found; identical variable sets with the same fulfilment are not compared. Deliberate variants for different audiences are counted.' } }) },

  /* ═══ Q5. Timeliness ═══ */
  'DQ-117': { a: 'cross_record_linkage', cand: ['sys_user', 'sys_data_source', 'sys_import_set_run'], deps: { interpret: ['DQ-118'] }, params: [], config: undef(R.hrFeed) },
  'DQ-118': { a: 'temporal_correlation', cand: ['sys_data_source', 'sys_import_set_run'], params: [P('tolerance', 'number', null, 2, 'tolerance, as a multiple of the feed interval')], config: undef(R.hrFeed, 'the feed\'s expected run interval — not recorded on the data source') },
  'DQ-119': { a: 'record_predicate', cand: ['sys_user'], params: [P('min_age', 'duration', 'days', 90, 'account age')],
    config: { requires_tables: [T('sys_user', 'user_name', 'active', 'last_login_time', 'sys_created_on')], table: 'sys_user', scope: 'active=true',
      predicates: [{ field: 'last_login_time', op: 'empty' }, { field: 'sys_created_on', op: 'date_before', window: win('min_age') }], evidence_fields: ['user_name', 'sys_created_on'], report_ratio: true,
      partial: { kind: 'false_positive_risk', not_covered: 'Users who only receive notifications or approve by email never sign in and are counted.' } } },
  'DQ-120': { a: 'temporal_correlation', also: ['configuration'], cand: ['sys_user_grmember', 'sys_user_group'], params: [P('max_age', 'duration', 'days', 730, 'age threshold')],
    config: rows('sys_user_group', ['name', 'sys_created_on'], 'active=true', { name: 'dq_stale_membership', args: { max_age: win('max_age') } }, {
      requires: [T('sys_user_group', 'name', 'active', 'sys_created_on'), T('sys_user_grmember', 'group', 'user', 'sys_created_on')],
      partial: { kind: 'detection_gap', not_covered: 'A membership change is read as the newest membership record; a REMOVAL leaves no record, so a group changed only by removals is counted as unchanged. Genuinely stable teams are counted.' } }) },
  'DQ-121': { a: 'record_predicate', also: ['configuration'], cand: ['alm_asset', 'cmdb_model_lifecycle'], params: [],
    config: rows('alm_asset', ['display_name', 'model', 'install_status'], 'install_status=1', { name: 'dq_assets_past_model_eol', args: {} }, {
      requires: [T('alm_asset', 'display_name', 'model', 'install_status'), T('cmdb_model_lifecycle', 'model', 'lifecycle_phase', 'start_date')],
      partial: { kind: 'detection_gap', not_covered: 'End of life is the model\'s End of Life phase in the platform\'s model lifecycle (cmdb_model_lifecycle, D-033); "Deployed" is the asset state In use (1).' } }) },
  'DQ-122': { a: 'record_predicate', also: ['configuration'], cand: ['kb_knowledge'], params: [],
    config: rows('kb_knowledge', ['number', 'valid_to', 'sys_view_count'], 'workflow_state=published', { name: 'dq_articles_past_valid_to', args: {} }) },
  'DQ-123': { a: 'cross_record_linkage', also: ['configuration'], cand: ['sc_cat_item', 'sc_req_item'], params: [P('min_age', 'duration', 'days', 365, 'item age')],
    config: rows('sc_cat_item', ['name', 'sys_created_on'], `active=true^${REQUESTABLE}`, { name: 'dq_never_ordered', args: { min_age: win('min_age') } }, {
      requires: [T('sc_cat_item', 'name', 'active', 'sys_class_name', 'sys_created_on'), T('sc_req_item', 'cat_item')],
      partial: { kind: 'false_positive_risk', not_covered: 'Seasonal or emergency items kept on purpose are counted.' } }) },
  'DQ-124': { a: 'cross_record_linkage', also: ['configuration'], cand: ['cmn_location', 'cmdb_ci', 'sys_user'], params: [],
    config: rows('cmn_location', ['name', 'sys_created_on'], '', { name: 'dq_unreferenced_locations', args: {} }, {
      requires: [T('cmn_location', 'name', 'parent'), T('cmdb_ci', 'location'), T('sys_user', 'location')],
      partial: { kind: 'false_positive_risk', not_covered: 'cmn_location has no active field (verified, Phase 7): every location is judged. Parents of other locations are excluded; locations created ahead of a site opening are counted.' } }) },

  /* ═══ Q6. Referential integrity ═══ */
  'DQ-125': { a: 'reference_integrity', cand: ['task', 'sys_user_group'], params: [],
    config: { requires_tables: [T('task', 'number', 'assignment_group')], table: 'task', scope: 'assignment_groupISNOTEMPTY', field: 'assignment_group', target: 'sys_user_group', check: 'exists', report: ['missing'], evidence_fields: ['number', 'sys_class_name'] } },
  'DQ-126': { a: 'reference_integrity', cand: ['sysapproval_approver', 'sys_user'], params: [],
    config: { requires_tables: [T('sysapproval_approver', 'approver', 'state')], table: 'sysapproval_approver', scope: ['approverISNOTEMPTY', clause('state={}', choice('sysapproval_approver', 'state', 'Requested'))],
      field: 'approver', target: 'sys_user', check: 'active', report: ['missing', 'inactive'], evidence_fields: ['sysapproval', 'source_table'],
      partial: { kind: 'false_positive_risk', not_covered: 'Open (requested) approvals are judged; approval configuration is not readable as data. An inactive approver with a configured delegate is counted.' } } },
  'DQ-127': { a: 'reference_integrity', also: ['configuration'], cand: ['sc_cat_item', 'wf_workflow', 'io_set_item', 'item_option_new_set'], params: [],
    config: rows('sc_cat_item', ['name', 'workflow'], 'active=true', { name: 'dq_catalog_references', args: {} }, {
      requires: [T('sc_cat_item', 'name', 'active', 'workflow'), T('wf_workflow', 'name'), T('io_set_item', 'sc_cat_item', 'variable_set'), T('item_option_new_set', 'name')],
      partial: { kind: 'detection_gap', not_covered: 'Absent workflows and variable sets are found. A workflow\'s "retired" state lives on its versions, not the workflow record, and is not judged.' } }) },
  'DQ-128': { a: 'reference_integrity', cand: [], params: [], config: undef('the "operationally significant reference fields" the scan is scoped to — not named') },
  'DQ-129': { a: 'cross_record_linkage', also: ['configuration'], cand: ['alm_asset', 'cmdb_ci'], params: [],
    config: rows('alm_asset', ['display_name', 'ci'], 'ciISNOTEMPTY', { name: 'dq_asset_ci_links', args: {} }, {
      requires: [T('alm_asset', 'ci'), T('cmdb_ci', 'asset')],
      partial: { kind: 'false_positive_risk', not_covered: 'Each direction is reported separately. Classes where a one-directional link is the intended model are counted.' } }) },
  'DQ-130': { a: 'reference_integrity', also: ['configuration'], cand: ['sysevent_email_action', 'sys_user', 'sys_user_grmember'], params: [],
    config: rows('sysevent_email_action', ['recipient_users', 'recipient_groups', 'recipient_fields', 'event_parm_1', 'event_parm_2', 'subscribable', 'collection'], 'active=true', { name: 'dq_notification_no_recipients', args: {} }, {
      requires: [T('sysevent_email_action', 'active', 'recipient_users', 'recipient_groups', 'recipient_fields', 'event_parm_1', 'event_parm_2', 'subscribable'), T('sys_user', 'active'), T('sys_user_grmember', 'group', 'user')],
      partial: { kind: 'detection_gap', not_covered: 'Notifications that name users or groups are resolved now. One with recipient fields, event-parameter recipients or subscriptions resolves per record, and one naming no one may add recipients in a mail script (measured, Phase 7): neither is judged. Distinct from ITSM-011, which charges ANY inactive or empty recipient.' } }) },
  'DQ-131': { a: 'cross_record_linkage', equivalent_of: 'ITSM-139', cand: ['m2m_kb_task', 'kb_knowledge'], params: [],
    note: 'The same condition as ITSM-139 Ownership OWN-004 is AGREED with ITSM-139 as owner (D-027): evaluated and counted in ITSM, shown here as an equivalent.' },
  'DQ-132': { a: 'reference_integrity', also: ['configuration'], cand: ['sys_report', 'sys_dictionary'], params: [],
    config: rows('sys_report', ['title', 'table', 'field', 'field_list', 'sumfield', 'trend_field', 'column', 'row', 'filter'], 'active=true', { name: 'dq_report_fields_missing', args: {} }, {
      requires: [T('sys_report', 'title', 'table', 'field', 'field_list', 'sumfield', 'trend_field', 'column', 'row', 'filter', 'active'), T('sys_db_object', 'name', 'super_class'), T('sys_db_view', 'name'), T('sys_dictionary', 'name', 'element')],
      partial: { kind: 'detection_gap', not_covered: 'The fields a report groups, sums, trends, lists and pivots by, against the dictionary of its table and every table it extends (D-035); a dot-walk is judged on its first field. Filter condition fields, reports on database views and dashboard widgets are not read.' } }) },

  /* ═══ Q7. Sensitive data exposure ═══ */
  'DQ-133': { a: 'text_analysis', also: ['configuration'], cand: ['task', 'sys_user', 'sc_req_item'], params: [P('fields', 'list', null, null, 'the free-text fields to scan, as table.field — UNDEFINED: named by the customer (SAOS_Health_Rules_Open_Questions.xlsx)')],
    config: rows('data_classification', ['name'], '', { name: 'dq_identifiers_in_text', args: { fields: param('fields') } }, {
      requires: [T('data_classification', 'name')],
      partial: { kind: 'detection_gap', not_covered: 'PAN and Aadhaar, in the formats the product owner approved (D-033; Aadhaar checked with its Verhoeff digit and reported separately). Account numbers are not matched until their formats are given.' } }) },
  'DQ-134': { a: 'configuration_inspection', also: ['configuration'], cand: ['sys_security_acl', 'm2m_dictionary_dataclass'], deps: { interpret: ['DQ-133'] }, params: [],
    config: rows('data_classification', ['name'], '', { name: 'dq_personal_field_acl', args: { classes: PERSONAL_DATA_CLASSES } }, {
      requires: [T('data_classification', 'name'), T('m2m_dictionary_dataclass', 'data_class', 'sys_dictionary'), T('sys_dictionary', 'name', 'element'), T('sys_security_acl', 'name', 'operation', 'condition', 'script', 'advanced', 'active'), T('sys_security_acl_role', 'sys_security_acl')],
      partial: { kind: 'false_positive_risk', not_covered: 'The personal-data fields are those the instance classifies with a personal-data class (D-032). A read ACL with a role, a condition or an advanced script counts as protection on the field or its table; whether that protection is adequate is not judged, and a deny-unless ACL is not modelled.' } }) },
  'DQ-135': { a: 'configuration_inspection', cand: ['sys_attachment', 'sys_security_acl'], params: [], config: undef('the content classification method — "must be stated", and none is') },
  'DQ-136': { a: 'temporal_correlation', cand: [], deps: { related: ['DQ-139'] }, params: [], config: undef(R.retention, R.personalData) },
  'DQ-137': { a: 'configuration_inspection', cand: ['sys_dictionary', 'm2m_dictionary_dataclass'], params: [],
    config: rows('sys_dictionary', ['name', 'element'], 'elementSTARTSWITHu_', { name: 'dq_identifier_custom_fields_unclassified', args: {} }, {
      requires: [T('sys_dictionary', 'name', 'element'), T('m2m_dictionary_dataclass', 'sys_dictionary')],
      partial: { kind: 'detection_gap', not_covered: 'Custom fields (u_) whose values hold a PAN or a checksum-valid Aadhaar (D-033) and that are not classified. At most 200 fields are read per scan.' } }) },
  'DQ-138': { a: 'configuration_inspection', cand: [], params: [], config: undef('access to the non-production instances, or their clone and scrub configuration — outside this instance') },
  'DQ-139': { a: 'configuration_inspection', cand: ['data_classification', 'm2m_dictionary_dataclass'], deps: { interpret: ['DQ-133'] }, params: [P('fields', 'list', null, null, 'the free-text fields to scan, as table.field — UNDEFINED: named by the customer (SAOS_Health_Rules_Open_Questions.xlsx)')],
    config: rows('data_classification', ['name'], '', { name: 'dq_identifiers_in_text', args: { fields: param('fields'), mode: 'unclassified' } }, {
      requires: [T('data_classification', 'name'), T('m2m_dictionary_dataclass', 'sys_dictionary')] }) },
};

export const PLACEHOLDERS = {};
