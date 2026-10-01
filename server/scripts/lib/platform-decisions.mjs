/**
 * HEALTH ASSIST PHASE 6 — the Platform decision table: one entry per workbook rule.
 *
 * `node scripts/build-workbook-pack.mjs --pack platform` turns this into the pack's
 * generated files. Every rule is in one recorded state (executable, unconfigured,
 * undefined, specification gap, object unverified, not built, equivalent) — the
 * vocabulary and the three rules of the ITOM pack (itom-decisions.mjs) hold here:
 * nothing is read before it is verified on the instance, no platform value is
 * hard-coded, and no threshold is invented.
 *
 * Every table and field named below was checked READ-ONLY on a real instance before
 * this table was written (Phase 6, techsnitchpvtltddemo2): the schema, not a guess.
 *
 * CUSTOMER-AUTHORED SCOPE (D-024): the script and design rules judge records that
 * carry a customer update (sys_update_xml) — the customer's own work, not the
 * ServiceNow baseline. Their reader is the customer-update list for the table.
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
const needs = (...objects) => ({ requires_objects: objects });
const clause = (template, value) => ({ $clause: { template, value } });

const UPX = T('sys_update_xml', 'name');
/** The customer-update list for a table — the reader of every customer-scoped rule. */
/* The distinct customer-update names, aggregated in one request (configuration.js customer_updates). */
const customerReader = (table) => ({ reader: 'customer_updates', args: { table } });
/** A script rule over customer-authored records of `table`. */
const script = (table, check, { fields = [], where = {}, args = {}, query = 'active=true', partial } = {}) => ({
  engine: 'configuration', requires_tables: [UPX, T(table, 'name', 'script', 'active', ...fields, ...Object.keys(where))], ...customerReader(table),
  compare: { name: 'plt_script_scan', args: { table, check, fields, where, args, query } },
  ...(partial ? { partial } : {}),
});
/** A design rule over customer-authored records of `table` matching `where`. */
const custom = (table, where, { fields = [], query = 'active=true', partial, label = 'name' } = {}) => ({
  engine: 'configuration', requires_tables: [UPX, T(table, label, ...fields, ...Object.keys(where), ...(query.includes('active') ? ['active'] : []))], ...customerReader(table),
  compare: { name: 'plt_customer_where', args: { table, fields, query, where } },
  ...(partial ? { partial } : {}),
});
const creator = (table, { query = 'active=true', partial } = {}) => ({
  engine: 'configuration', requires_tables: [UPX, T(table, 'name', 'sys_created_by'), T('sys_user', 'user_name', 'active')], ...customerReader(table),
  compare: { name: 'plt_creator_inactive', args: { table, query } },
  partial: partial ?? { kind: 'detection_gap', not_covered: `${table} has no owner field on the platform (verified, Phase 6): the creator is judged; "no owner" cannot be.` },
});

const BEFORE = choice('sys_script', 'when', 'before');
const DISPLAY = choice('sys_script', 'when', 'display');
const SYNC_WHEN = [BEFORE, choice('sys_script', 'when', 'after'), DISPLAY];
const ON_LOAD = choice('sys_script_client', 'type', 'onLoad');
const ON_CHANGE = choice('sys_script_client', 'type', 'onChange');
const SCRIPT_RISK = { kind: 'false_positive_risk', not_covered: 'Static, lexical analysis of customer-authored scripts: comments and string contents are set aside before a pattern is tested; code built dynamically (eval, strings assembled at run time) is not seen.' };

const R = {
  conditionEvaluator: 'evaluating an encoded-query condition against records (which tasks a start condition, alert filter or trigger matches) — no condition evaluator is defined (the ITSM-004 gap)',
  executionCounts: 'per-rule execution counts and error attribution — the platform keeps no per-rule execution log the workbook names, and syslog entries are not attributed to their rule',
  oobInventory: 'the out-of-box baseline (which records are ServiceNow\'s, by name and table, per release) — not established as data',
  sensitiveClass: 'a sensitive / personal-data table and field classification — "from classification or content detection", neither given',
  opClass: 'an operation classification (async-appropriate operations, UI-policy-expressible actions, privileged operations) — "configurable", no default',
  transactions: 'script attribution in slow transactions and per-query cost — syslog_transaction records a transaction, not which rule or widget spent its time',
  trend: 'a series across snapshots — the pack keeps no snapshot history of its own measures yet',
};

/* D-033 — values from ServiceNow's documentation and the instance's own configuration (docs/HEALTH-ASSIST-RULE-RESEARCH.md). */
const MC = T('sys_metadata_customization', 'sys_update_name', 'author_type');
/* The terminal states of the task tables, ServiceNow's own choice values. */
const TERMINAL = { incident: ['6', '7', '8'], problem: ['106', '107'], change_request: ['3', '4'] };
/* The personal-data classes (D-032). */
const PERSONAL = ['Personally identifiable information', 'HR PII', 'Master data PII', 'Transactional Data PII', 'Contact information', 'Identification information', 'Demographic information'];
const PERSONAL_TABLES = [T('data_classification', 'name'), T('m2m_dictionary_dataclass', 'data_class', 'sys_dictionary'), T('sys_security_acl', 'name', 'operation', 'active')];
const cfg = (reader, compare, requires, partial) => ({ engine: 'configuration', requires_tables: requires, ...reader, compare, ...(partial ? { partial } : {}) });
const rowsReader = (table, fields, query = '') => ({ reader: 'table_rows', args: { table, fields, query } });
/* Flow Designer structure (D-035): active flows, their current snapshots, and subflow steps. */
const FLOW_TABLES = [T('sys_properties', 'name'), T('sys_hub_flow', 'name', 'internal_name', 'type', 'master_snapshot', 'active'), T('sys_hub_sub_flow_instance_v2', 'flow', 'subflow'), T('sys_hub_flow_snapshot', 'parent_flow')];
/* A rule whose comparator reads everything itself: one row that is on every instance. */
const PRODUCT_ROW = rowsReader('sys_properties', ['name'], 'name=glide.product.name');
/* D-037: where a customer script include can be named (platform/analysis-comparators.js REFERENCE_SOURCES; the core ones are verified). */
const REF_TABLES = [T('sys_script', 'script'), T('sys_script_client', 'script'), T('sys_ui_action', 'script'), T('sysauto_script', 'script')];
const INCLUDE_REFS = { kind: 'detection_gap', not_covered: 'Customer-authored active includes; a caller is a script that names the include as a word in any of the platform\'s script fields (business rules, includes, client scripts, UI actions, jobs, scripted REST, UI pages and macros, widgets, ACLs, fix scripts, processors, transforms, script actions, UI scripts, catalog client scripts) — static and by-name use (GlideAjax) alike (D-037). Flows and workflows are not read; a field that cannot be read is listed.' };
const SCRIPT_RISK_QUERY = { kind: 'detection_gap', not_covered: 'Customer scripts: a GlideRecord on a literal table that is queried with no setLimit, no get() and no condition at all, where the table holds at least the threshold of rows (D-037). A query with any condition is taken as restrictive (the guard); a table named at run time is not seen.' };

export const RULES = {
  /* ═══ 1A. SLA definition and design ═══ */
  'PLT-001': { a: 'record_predicate', cand: ['contract_sla'], params: [], config: gap('"business-hours intent" — an empty schedule means 24x7, and whether 24x7 was intended is not recorded on the definition') },
  'PLT-002': { a: 'configuration_inspection', equivalent_of: 'ITSM-003', cand: ['contract_sla', 'incident'], params: [],
    note: 'The same condition as ITSM-003 Ownership OWN-003 is AGREED with ITSM-003 as owner (D-025): evaluated and counted in ITSM, shown here as an equivalent.' },
  'PLT-003': { a: 'configuration_inspection', cand: ['contract_sla'], params: [], config: undef('the task state transition map that makes a start / pause / stop combination reachable — not defined') },
  'PLT-004': { a: 'aggregate_distribution', also: ['configuration'], cand: ['task_sla', 'contract_sla'], params: [],
    config: { engine: 'configuration', requires_tables: [T('task_sla', 'task', 'sla', 'active'), T('contract_sla', 'name', 'type')], reader: 'table_rows', args: { table: 'task_sla', fields: ['task', 'sla'], query: 'active=true' },
      compare: { name: 'plt_multiple_slas', args: {} },
      partial: { kind: 'evidence_gap', not_covered: 'Tasks with more than one active SLA of one type are found; the overlapping definition PAIRS are named per task, not reported as pairs.' } } },
  'PLT-005': { a: 'reference_integrity', cand: ['service_commitment', 'contract_sla'], params: [],
    config: { requires_tables: [T('service_commitment', 'name', 'sla'), T('contract_sla', 'active')], table: 'service_commitment', scope: 'slaISNOTEMPTY', field: 'sla', target: 'contract_sla', check: 'active', report: ['inactive'], evidence_fields: ['name', 'sla'],
      partial: { kind: 'evidence_gap', not_covered: 'Commitments are read; offerings reach SLAs only through commitments (service_offering_commitment), so the offering is not named.' } } },
  'PLT-006': { a: 'configuration_inspection', cand: ['contract_sla'], params: [], config: undef('"insert-only" evaluation timing — no field of contract_sla records it (verified, Phase 6)') },
  'PLT-007': { a: 'configuration_inspection', cand: ['contract_sla'], params: [],
    config: cfg(rowsReader('contract_sla', ['name', 'collection', 'stop_condition'], 'active=true^collectionINincident,problem,change_request'), { name: 'plt_stop_condition_terminal_states', args: { terminal: TERMINAL } }, [T('contract_sla', 'name', 'collection', 'stop_condition', 'active')],
      { kind: 'detection_gap', not_covered: 'The terminal states are ServiceNow\'s own (incident Resolved 6 / Closed 7 / Canceled 8; problem 106, 107; change Closed 3 / Canceled 4 — D-033). A state is judged only where records in it exist: the instance counts those the stop condition matches.' }) },
  'PLT-008': { a: 'configuration_inspection', cand: ['contract_sla', 'task_sla'], params: [P('paused_threshold', 'duration', 'days', null, 'paused duration — UNDEFINED ("configurable")')],
    config: pending('reading when_to_resume against resume_condition per definition and joining SLA records paused beyond the threshold') },
  'PLT-009': { a: 'configuration_inspection', cand: ['contract_sla', 'service_commitment'], params: [], config: undef('where business time "was intended" — implied by a schedule or commitment, not recorded') },
  'PLT-010': { a: 'configuration_inspection', cand: ['contract_sla'], params: [P('gap', 'duration', 'minutes', null, 'event-to-record gap — UNDEFINED')], config: undef('the triggering event\'s time for a record, against which the creation gap is measured — not defined') },
  'PLT-011': { a: 'cross_record_linkage', cand: ['contract_sla', 'wf_context', 'sys_flow_context'], params: [], config: undef('the platform does not keep every execution of an SLA flow: on the validation instance half the SLAs created since the oldest retained flow context have no context at all, so a flow that never ran cannot be told from a purged context (D-035)') },
  'PLT-012': { a: 'record_predicate', cand: ['contract_sla'], params: [],
    config: { requires_tables: [T('contract_sla', 'name', 'active', 'workflow', 'flow')], table: 'contract_sla', scope: 'active=true', predicates: [{ field: 'workflow', op: 'empty' }, { field: 'flow', op: 'empty' }], evidence_fields: ['name', 'collection', 'type'], report_ratio: true,
      partial: { kind: 'false_positive_risk', not_covered: 'Breach escalation runs through the definition\'s workflow or flow; a definition with neither is flagged. A notification on task_sla itself would escalate without them and is not read.' } } },
  'PLT-013': { a: 'configuration_inspection', cand: ['contract_sla'], params: [],
    config: { engine: 'configuration', requires_tables: [T('contract_sla', 'name', 'active', 'collection', 'type', 'start_condition', 'pause_condition', 'stop_condition', 'reset_condition', 'cancel_condition', 'duration', 'duration_type', 'schedule', 'relative_duration_works_on', 'target')], reader: 'table_rows',
      args: { table: 'contract_sla', fields: ['name', 'collection', 'type', 'start_condition', 'pause_condition', 'stop_condition', 'reset_condition', 'cancel_condition', 'duration', 'duration_type', 'schedule', 'relative_duration_works_on', 'target'], query: 'active=true' },
      compare: { name: 'plt_sla_duplicates', args: { fields: ['collection', 'type', 'target', 'start_condition', 'pause_condition', 'stop_condition', 'reset_condition', 'cancel_condition', 'duration', 'duration_type', 'relative_duration_works_on', 'schedule'] } } } },
  'PLT-014': { a: 'configuration_inspection', cand: ['contract_sla', 'sys_dictionary'], params: [],
    config: { engine: 'configuration', requires_tables: [T('contract_sla', 'name', 'active', 'collection', 'start_condition', 'pause_condition', 'stop_condition', 'reset_condition', 'cancel_condition', 'resume_condition')], reader: 'table_rows',
      args: { table: 'contract_sla', fields: ['name', 'collection', 'start_condition', 'pause_condition', 'stop_condition', 'reset_condition', 'cancel_condition', 'resume_condition'], query: 'active=true' },
      compare: { name: 'plt_sla_condition_fields', args: { conditions: ['start_condition', 'pause_condition', 'stop_condition', 'reset_condition', 'cancel_condition', 'resume_condition'] } },
      partial: { kind: 'detection_gap', not_covered: 'The first field of each condition clause is verified on the definition\'s table (inheritance included); the far end of a dot-walked field is not.' } } },
  'PLT-015': { a: 'configuration_inspection', cand: ['contract_sla'], params: [], config: undef('a "multi-timezone estate" and the records that span timezones — not defined') },
  'PLT-016': { a: 'record_predicate', cand: ['contract_sla'], params: [P('min_age', 'duration', 'days', 730, 'age threshold')],
    config: { requires_tables: [T('contract_sla', 'name', 'active')], table: 'contract_sla', scope: 'active=true',
      predicates: [{ field: 'sys_created_on', op: 'date_before', window: win('min_age') }, { field: 'sys_updated_on', field2: 'sys_created_on', op: 'same_as' }], evidence_fields: ['name', 'sys_created_on', 'sys_updated_on'], report_ratio: true,
      partial: { kind: 'false_positive_risk', not_covered: '"No review" is read as an update time equal to the creation time; a review that changed nothing reads as none.' } } },

  /* ═══ 1B. Runtime behaviour ═══ */
  'PLT-017': { a: 'temporal_correlation', also: ['configuration'], cand: ['task_sla', 'contract_sla', 'cmn_schedule'], params: [],
    config: cfg({ reader: 'table_rows', args: { table: 'task_sla', fields: ['task', 'sla', 'planned_end_time', 'has_breached'], query: [clause('stage={}', choice('task_sla', 'stage', ['In progress', 'In Progress']))] } }, { name: 'plt_sla_stuck', args: {} },
      [T('task_sla', 'task', 'sla', 'stage', 'planned_end_time', 'has_breached')],
      { kind: 'detection_gap', not_covered: 'The maximum is the SLA engine\'s own planned end time — the definition\'s duration expanded under its schedule, pauses included (D-037). An In-progress SLA past it and never marked breached has a stuck timer. Paused SLAs are not In progress.' }) },
  'PLT-018': { a: 'aggregate_distribution', cand: ['task_sla'], params: [P('share', 'percent', null, 15, 'share of SLA records cancelled')],
    config: { requires_tables: [T('task_sla', 'sla', 'stage')], engine: 'aggregate', table: 'task_sla', numerator_query: [clause('stage={}', choice('task_sla', 'stage', ['Cancelled', 'Canceled']))], denominator_query: '', group_by: ['sla'],
      threshold: { op: 'gt', value: param('share') }, basis: 'cancelled SLA records / SLA records, by definition',
      partial: { kind: 'evidence_gap', not_covered: 'The share by definition is judged; cancellation within seconds of attachment is not measured.' } } },
  'PLT-019': { a: 'configuration_inspection', cand: ['task_sla', 'contract_sla'], params: [], config: undef('a definition\'s "intended scope" from its description and commitment — not readable') },
  'PLT-020': { a: 'cross_record_linkage', also: ['configuration'], cand: ['task_sla', 'contract_sla'], params: [],
    config: cfg(rowsReader('contract_sla', ['name', 'collection', 'start_condition'], 'active=true'), { name: 'plt_records_missing_sla', args: {} }, [T('contract_sla', 'name', 'collection', 'start_condition', 'active'), T('task_sla', 'task', 'sla')],
      { kind: 'detection_gap', not_covered: 'Each active definition\'s start condition is evaluated by the instance against the ACTIVE records of its table (D-033); a definition whose table cannot be read is passed over.' }) },
  'PLT-021': { a: 'aggregate_distribution', also: ['configuration'], cand: ['task_sla'], params: [P('share', 'percent', null, 25, 'share of SLA records paused longer than active')],
    config: { engine: 'configuration', requires_tables: [T('task_sla', 'sla', 'pause_duration', 'duration')], reader: 'table_rows', args: { table: 'task_sla', fields: ['sla', 'pause_duration', 'duration'], query: 'pause_durationISNOTEMPTY' },
      compare: { name: 'plt_pause_exceeds_active', args: { share: param('share') } },
      partial: { kind: 'evidence_gap', not_covered: 'By definition; the by-group split is not reported.' } } },
  'PLT-022': { a: 'aggregate_distribution', cand: [], params: [], config: undef('manual SLA repair executions — no execution record of the repair jobs is established') },
  'PLT-023': { a: 'aggregate_distribution', cand: ['task_sla'], params: [], config: undef('the expected SLA-per-task ratio "derived from active definition count and coverage" — the derivation is not given') },
  'PLT-024': { a: 'reference_integrity', equivalent_of: 'ITSM-011', cand: ['sysevent_email_action'], params: [],
    note: 'The same condition as ITSM-011 Ownership OWN-010 is AGREED with ITSM-011 as owner (D-025): evaluated and counted in ITSM, shown here as an equivalent.' },
  'PLT-025': { a: 'record_predicate', cand: ['task_sla'], params: [P('ceiling', 'number', null, 500, 'percentage ceiling (the workbook default 500%, above the 0–100 percent type, so declared as a number)')],
    config: { requires_tables: [T('task_sla', 'sla', 'percentage')], table: 'task_sla', evidence_fields: ['sla', 'task', 'percentage', 'stage'], report_ratio: true,
      variants: [
        { variant: 'below zero', scope: 'percentage<0', predicates: [{ field: 'percentage', op: 'not_empty' }] },
        { variant: 'above the ceiling', scope: [clause('percentage>{}', param('ceiling'))], predicates: [{ field: 'percentage', op: 'not_empty' }] },
      ] } },
  'PLT-026': { a: 'temporal_correlation', cand: ['task_sla', 'task'], params: [], config: gap('a tolerance after closure — the SLA record is stopped BY the closure, moments after it, so "updated after closure" needs a margin the workbook does not give') },
  'PLT-027': { a: 'reference_integrity', cand: ['task_sla', 'task'], params: [],
    config: { requires_tables: [T('task_sla', 'task', 'sla')], table: 'task_sla', scope: 'taskISNOTEMPTY', field: 'task', target: 'task', check: 'exists', report: ['missing'], evidence_fields: ['task', 'sla', 'stage'] } },

  /* ═══ 1C. Commitment linkage ═══ */
  'PLT-028': { a: 'record_predicate', cand: ['service_commitment'], params: [],
    config: { requires_tables: [T('service_commitment', 'name', 'sla', 'type')], table: 'service_commitment', predicates: [{ field: 'sla', op: 'empty' }], evidence_fields: ['name', 'type'], report_ratio: true,
      partial: { kind: 'false_positive_risk', not_covered: 'A commitment with no LINKED definition is flagged; a "condition-matching" definition cannot be recognised (no condition evaluator).' } } },
  'PLT-029': { a: 'configuration_inspection', cand: ['contract_sla', 'service_commitment'], params: [],
    config: { engine: 'configuration', requires_tables: [T('contract_sla', 'name', 'active', 'service_commitment'), T('service_commitment', 'sla')], reader: 'table_rows', args: { table: 'contract_sla', fields: ['name', 'service_commitment'], query: 'active=true' },
      compare: { name: 'plt_sla_untraceable', args: {} },
      partial: { kind: 'evidence_gap', not_covered: '"With non-zero volume" is not applied: every active definition is judged.' } } },
  'PLT-030': { a: 'configuration_inspection', also: ['configuration'], cand: ['service_commitment', 'contract_sla'], params: [],
    config: cfg(rowsReader('service_commitment', ['name', 'sla', 'time_amount', 'schedule']), { name: 'plt_commitment_duration', args: {} },
      [T('service_commitment', 'name', 'sla', 'time_amount', 'schedule'), T('contract_sla', 'name', 'duration', 'schedule')],
      { kind: 'detection_gap', not_covered: 'A commitment that states its own duration (time_amount) against the SLA it references, where both run on the same schedule or both 24 × 7 (D-037). Pairs on different schedules are counted and not judged; a commitment that states no duration takes its SLA\'s by reference.' }) },
  'PLT-031': { a: 'configuration_inspection', cand: ['cmdb_ci_service', 'task_sla'], params: [],
    config: cfg(rowsReader('cmdb_ci_service', ['name', 'busines_criticality'], 'busines_criticality=1 - most critical'), { name: 'plt_critical_services_without_sla', args: { critical_values: ['1 - most critical'] } }, [T('cmdb_ci_service', 'name', 'busines_criticality'), T('task_sla', 'task')],
      { kind: 'detection_gap', not_covered: 'Business Critical = the platform\'s top criticality, "1 - most critical" (D-033). Coverage is judged by what ran: an SLA on any task whose business service is the service.' }) },
  'PLT-032': { a: 'configuration_inspection', cand: ['sys_report'], params: [], config: undef('which SLA definitions a report or dashboard is built on — not readable from report configuration as the workbook names it') },

  /* ═══ 2A. Business rules — design and placement ═══ */
  'PLT-033': { a: 'configuration_inspection', cand: ['sys_script'], params: [P('volume', 'number', null, null, 'table volume threshold — UNDEFINED ("configurable")')], config: pending('combining table row counts and update frequency for the tables customer-authored rules run on') },
  'PLT-034': { a: 'text_analysis', also: ['configuration'], cand: ['sys_script', 'sys_update_xml'], params: [], config: script('sys_script', 'current_update', { fields: ['when'], where: { when: BEFORE }, partial: SCRIPT_RISK }) },
  'PLT-035': { a: 'text_analysis', also: ['configuration'], cand: ['sys_script', 'sys_script_include', 'sys_update_xml'], params: [],
    config: { ...script('sys_script', 'query_in_loop'), requires_tables: [UPX, T('sys_script', 'name', 'script', 'active'), T('sys_script_include', 'name', 'script', 'active')],
      variants: [
        { variant: 'business rules', ...customerReader('sys_script'), compare: { name: 'plt_script_scan', args: { table: 'sys_script', check: 'query_in_loop', fields: [], where: {}, args: {}, query: 'active=true' } } },
        { variant: 'script includes', ...customerReader('sys_script_include'), compare: { name: 'plt_script_scan', args: { table: 'sys_script_include', check: 'query_in_loop', fields: [], where: {}, args: {}, query: 'active=true' } } },
      ],
      partial: { kind: 'evidence_gap', not_covered: `${SCRIPT_RISK.not_covered} The ranking by execution count is not available (no per-rule execution log).` } } },
  'PLT-036': { a: 'text_analysis', cand: ['sys_script'], params: [], config: undef(R.opClass) },
  'PLT-037': { a: 'configuration_inspection', also: ['configuration'], cand: ['sys_script', 'sys_db_object'], params: [],
    config: custom('sys_script', { collection: ['task', 'cmdb_ci'] }, { fields: ['collection'],
      partial: { kind: 'evidence_gap', not_covered: 'Rules on task and cmdb_ci (the two base tables the workbook names) are flagged; "other significant parents" are not defined, and the child-class volume is not attached.' } }) },
  'PLT-038': { a: 'record_predicate', also: ['configuration'], cand: ['sys_script'], params: [],
    config: custom('sys_script', { condition: null, filter_condition: null, action_insert: 'true', action_update: 'true' }, { fields: ['condition', 'filter_condition', 'action_insert', 'action_update'] }) },
  'PLT-039': { a: 'text_analysis', also: ['configuration'], cand: ['sys_script', 'sys_script_include', 'sysauto_script'], params: [P('min_rows', 'number', null, 100000, 'target table row threshold')],
    config: cfg(PRODUCT_ROW, { name: 'plt_unbounded_queries', args: { sources: [['sys_script', 'script'], ['sys_script_include', 'script']], min_rows: param('min_rows') } },
      [T('sys_properties', 'name'), UPX, T('sys_script', 'name', 'script', 'active'), T('sys_script_include', 'name', 'script', 'active')], SCRIPT_RISK_QUERY) },
  'PLT-040': { a: 'text_analysis', also: ['configuration'], cand: ['sys_script', 'sys_update_xml'], params: [P('max_depth', 'number', null, 2, 'GlideRecord nesting depth')], config: script('sys_script', 'query_depth', { args: { max_depth: param('max_depth') }, partial: SCRIPT_RISK }) },
  'PLT-041': { a: 'text_analysis', also: ['configuration'], cand: ['sys_script'], params: [],
    config: cfg(PRODUCT_ROW, { name: 'plt_rule_ordering', args: {} }, [T('sys_properties', 'name'), UPX, T('sys_script', 'name', 'collection', 'when', 'order', 'script', 'condition', 'action_insert', 'action_update', 'active')],
      { kind: 'detection_gap', not_covered: 'Before rules on one table (at least one customer-authored), sharing an operation: a rule that reads a current field another rule writes later in order (D-037). Field use is lexical (current.field, getValue / setValue); dependencies through other records, after rules and flows are not analysed.' }) },
  'PLT-042': { a: 'text_analysis', also: ['configuration'], cand: ['sys_script', 'sys_update_xml'], params: [], config: script('sys_script', 'writes', { fields: ['when'], where: { when: DISPLAY }, partial: SCRIPT_RISK }) },
  'PLT-043': { a: 'text_analysis', cand: ['sys_script', 'sys_hub_flow', 'wf_workflow'], params: [], config: undef('the overlap threshold ("configurable") and a comparison of flow and workflow logic with scripts') },
  'PLT-044': { a: 'text_analysis', also: ['configuration'], cand: ['sys_script', 'sys_update_xml'], params: [], config: script('sys_script', 'set_workflow_unjustified', { partial: SCRIPT_RISK }) },
  'PLT-045': { a: 'text_analysis', also: ['configuration'], cand: ['sys_script'], params: [],
    config: cfg(PRODUCT_ROW, { name: 'plt_rule_recursion', args: {} }, [T('sys_properties', 'name'), UPX, T('sys_script', 'name', 'collection', 'when', 'script', 'condition', 'filter_condition', 'action_update', 'active')],
      { kind: 'detection_gap', not_covered: 'Customer after / async update rules that call current.update() without setWorkflow(false), with no condition or a condition naming a field they write (D-037). A guard inside the script (the workbook\'s) is not recognised beyond setWorkflow(false).' }) },
  'PLT-046': { a: 'text_analysis', also: ['configuration'], cand: ['sys_script', 'sys_update_xml'], params: [], config: script('sys_script', 'sys_id_literal', { partial: SCRIPT_RISK }) },
  'PLT-047': { a: 'text_analysis', also: ['configuration'], cand: ['sys_script', 'sys_update_xml'], params: [], config: script('sys_script', 'credentials', { partial: SCRIPT_RISK }) },
  'PLT-048': { a: 'text_analysis', also: ['configuration'], cand: ['sys_script', 'sys_update_xml'], params: [], config: script('sys_script', 'sleep', { partial: SCRIPT_RISK }) },
  'PLT-049': { a: 'text_analysis', also: ['configuration'], cand: ['sys_script', 'sys_update_xml'], params: [], config: script('sys_script', 'outbound_http', { fields: ['when'], where: { when: SYNC_WHEN }, partial: SCRIPT_RISK }) },
  'PLT-050': { a: 'text_analysis', also: ['configuration'], cand: ['sys_script', 'sys_update_xml'], params: [], config: script('sys_script', 'empty_body', { partial: SCRIPT_RISK }) },
  'PLT-051': { a: 'record_predicate', also: ['configuration'], cand: ['sys_script', 'sys_update_xml'], params: [], config: custom('sys_script', { description: null }, { fields: ['description'] }) },

  /* ═══ 2B. Execution and impact ═══ */
  'PLT-052': { a: 'aggregate_distribution', also: ['configuration'], cand: ['sys_script_pattern'], params: [P('percentile', 'number', null, 95, 'slow threshold: the percentile of total script time')],
    config: cfg(rowsReader('sys_script_pattern', ['script_source'], 'script_source_table=sys_script'), { name: 'plt_slow_scripts', args: { source_table: 'sys_script', percentile: param('percentile') } }, [T('sys_script_pattern', 'script_source', 'script_source_table', 'count', 'average', 'total')],
      { kind: 'false_positive_risk', not_covered: 'Script time is ServiceNow\'s Slow Scripts log (sys_script_pattern, D-033): the business rules whose total time is at or above the 95th percentile of every logged script. A rule the log has not seen is not ranked.' }) },
  'PLT-053': { a: 'aggregate_distribution', cand: ['sys_script', 'sys_audit'], params: [P('factor', 'number', null, 2, 'multiple of table update volume')], config: undef(R.executionCounts) },
  'PLT-054': { a: 'aggregate_distribution', cand: ['syslog'], params: [], config: undef(R.executionCounts) },
  'PLT-055': { a: 'configuration_inspection', cand: ['sys_script'], params: [], config: pending('table volume and update frequency per table (both thresholds "configurable")') },
  'PLT-056': { a: 'aggregate_distribution', cand: ['sys_script'], params: [P('window', 'duration', 'days', 90, 'observation window')], config: undef(R.executionCounts) },
  'PLT-057': { a: 'temporal_correlation', cand: ['sys_script', 'syslog_transaction'], params: [], config: undef(R.transactions) },

  /* ═══ 2C. Governance ═══ */
  'PLT-058': { a: 'configuration_inspection', cand: ['sys_script', 'sys_scope'], params: [], config: undef('"ownership inference" of a table by a scoped application — not defined') },
  'PLT-059': { a: 'configuration_inspection', cand: ['sys_script', 'sys_metadata_customization'], params: [],
    config: cfg(rowsReader('sys_metadata_customization', ['author_type'], 'author_type=Custom^sys_update_nameSTARTSWITHsys_script_'), { name: 'plt_custom_rules_on_oob_tables', args: {} }, [MC, T('sys_script', 'name', 'collection', 'sys_scope', 'active')],
      { kind: 'detection_gap', not_covered: 'Customer-created = author_type "Custom" in ServiceNow\'s customization register (sys_metadata_customization, D-033); a ServiceNow table is one not named u_ / x_.' }) },
  'PLT-060': { a: 'configuration_inspection', cand: ['sys_script', 'sys_update_xml'], params: [], config: undef('the "deployment windows" a creation timestamp falls outside — not defined') },
  'PLT-061': { a: 'reference_integrity', also: ['configuration'], cand: ['sys_script', 'sys_user'], params: [], config: creator('sys_script') },
  'PLT-062': { a: 'cross_record_linkage', cand: ['sys_update_set', 'change_request'], params: [], config: undef('the link from an update set to its change request — not a platform field') },
  'PLT-063': { a: 'configuration_inspection', cand: ['sys_script', 'sys_metadata_customization'], params: [],
    config: cfg(rowsReader('sys_metadata_customization', ['author_type'], 'author_type=Custom^sys_update_nameSTARTSWITHsys_script_'), { name: 'plt_custom_shadowing_oob', args: { table: 'sys_script', also: 'collection' } }, [MC, T('sys_script', 'name', 'collection')]) },
  'PLT-064': { a: 'aggregate_distribution', also: ['configuration'], cand: ['sys_script'], params: [P('min_windows', 'number', null, 2, 'snapshots needed')],
    config: cfg(PRODUCT_ROW, { name: 'plt_rule_count_trend', args: { min_windows: param('min_windows') } }, [T('sys_properties', 'name'), UPX, T('sys_script', 'collection', 'active')],
      { kind: 'detection_gap', not_covered: 'Active customer business rules per table, one reading per scan of this instance, trended when at least two scans exist (D-037). Active development (the guard) is charged.' }) },

  /* ═══ 3A. Script Includes ═══ */
  'PLT-065': { a: 'configuration_inspection', cand: ['sys_script_include', 'sys_security_acl', 'sys_update_xml'], params: [],
    config: { engine: 'configuration', requires_tables: [UPX, T('sys_script_include', 'name', 'api_name', 'client_callable', 'active'), T('sys_security_acl', 'name', 'type', 'active')], ...customerReader('sys_script_include'),
      compare: { name: 'plt_callable_unprotected', args: {} },
      partial: { kind: 'detection_gap', not_covered: 'An ACL named for the include is looked for; a role restriction inside the include\'s own script is not recognised, and the escalation for includes that query or write is not applied.' } } },
  'PLT-066': { a: 'configuration_inspection', also: ['configuration'], cand: ['sys_script_include'], params: [],
    config: cfg(PRODUCT_ROW, { name: 'plt_include_scope_callers', args: {} }, [T('sys_properties', 'name'), UPX, T('sys_script_include', 'name', 'api_name', 'access', 'script', 'client_callable', 'active'), ...REF_TABLES], INCLUDE_REFS) },
  'PLT-067': { a: 'text_analysis', cand: ['sys_script_include'], params: [], config: undef(R.opClass) },
  'PLT-068': { a: 'text_analysis', also: ['configuration'], cand: ['sys_script_include'], params: [P('similarity', 'number', null, 0.85, 'similarity threshold')],
    config: cfg(PRODUCT_ROW, { name: 'plt_include_similarity', args: { similarity: param('similarity') } }, [T('sys_properties', 'name'), UPX, T('sys_script_include', 'name', 'script', 'active')],
      { kind: 'detection_gap', not_covered: 'Every pair of customer includes with a body, compared on 5-token shingles of their code with comments removed (Jaccard, D-037). Versioned copies during a migration (the guard) are charged.' }) },
  'PLT-069': { a: 'text_analysis', also: ['configuration'], cand: ['sys_script_include'], params: [P('min_age', 'duration', 'days', 180, 'age threshold')],
    config: cfg(PRODUCT_ROW, { name: 'plt_include_unreferenced', args: { min_age: param('min_age') } }, [T('sys_properties', 'name'), UPX, T('sys_script_include', 'name', 'script', 'active'), ...REF_TABLES], INCLUDE_REFS) },
  'PLT-070': { a: 'text_analysis', also: ['configuration'], cand: ['sys_script_include', 'sys_update_xml'], params: [P('max_lines', 'number', null, 500, 'line threshold')], config: script('sys_script_include', 'too_long', { args: { max_lines: param('max_lines') } }) },
  'PLT-071': { a: 'relationship_graph', also: ['configuration'], cand: ['sys_script_include'], params: [P('max_depth', 'number', null, 5, 'call depth')],
    config: cfg(PRODUCT_ROW, { name: 'plt_include_graph', args: { max_depth: param('max_depth') } }, [T('sys_properties', 'name'), UPX, T('sys_script_include', 'name', 'script', 'active')], INCLUDE_REFS) },
  'PLT-072': { a: 'text_analysis', also: ['configuration'], cand: ['sys_script_include', 'sys_update_xml'], params: [], config: script('sys_script_include', 'credentials', { partial: SCRIPT_RISK }) },
  'PLT-073': { a: 'text_analysis', cand: ['sys_script_include', 'syslog'], params: [], config: undef(R.executionCounts) },
  'PLT-074': { a: 'configuration_inspection', cand: ['sys_script_include', 'sys_metadata_customization'], params: [],
    config: cfg(rowsReader('sys_metadata_customization', ['author_type'], 'author_type=Custom^sys_update_nameSTARTSWITHsys_script_include_'), { name: 'plt_custom_shadowing_oob', args: { table: 'sys_script_include' } }, [MC, T('sys_script_include', 'name')]) },

  /* ═══ 3B. Client Scripts ═══ */
  'PLT-075': { a: 'text_analysis', also: ['configuration'], cand: ['sys_script_client', 'sys_update_xml'], params: [], config: script('sys_script_client', 'sync_ajax', { partial: SCRIPT_RISK }) },
  'PLT-076': { a: 'text_analysis', also: ['configuration'], cand: ['sys_script_client', 'sys_update_xml'], params: [], config: script('sys_script_client', 'dom_access', { partial: SCRIPT_RISK }) },
  'PLT-077': { a: 'text_analysis', also: ['configuration'], cand: ['sys_script_client', 'sys_update_xml'], params: [], config: script('sys_script_client', 'server_call', { fields: ['type'], where: { type: ON_LOAD }, partial: { kind: 'evidence_gap', not_covered: `${SCRIPT_RISK.not_covered} The ranking by form view volume is not available.` } }) },
  'PLT-078': { a: 'text_analysis', cand: ['sys_script_client'], params: [], config: undef(R.opClass) },
  'PLT-079': { a: 'aggregate_distribution', also: ['configuration'], cand: ['sys_script_client'], params: [],
    config: { engine: 'configuration', requires_tables: [UPX, T('sys_script_client', 'name', 'table', 'field', 'type', 'active')], reader: 'table_rows', args: { table: 'sys_script_client', fields: ['name', 'table', 'field'], query: ['active=true', clause('type={}', ON_CHANGE)] },
      compare: { name: 'plt_duplicate_onchange', args: {} } } },
  'PLT-080': { a: 'record_predicate', also: ['configuration'], cand: ['sys_script_client', 'sys_update_xml'], params: [], config: custom('sys_script_client', { type: ON_LOAD, condition: null }, { fields: ['type', 'condition'] }) },
  'PLT-081': { a: 'text_analysis', also: ['configuration'], cand: ['sys_script_client', 'sys_ui_section'], params: [],
    config: cfg(PRODUCT_ROW, { name: 'plt_client_fields_off_form', args: {} }, [T('sys_properties', 'name'), UPX, T('sys_script_client', 'name', 'table', 'type', 'field', 'script', 'active'), T('sys_ui_section', 'name', 'view'), T('sys_ui_element', 'sys_ui_section', 'element'), T('sys_db_object', 'name', 'super_class')],
      { kind: 'detection_gap', not_covered: 'Fields a customer client script names through g_form, against every view of the form layout of its table or the nearest table it extends (D-037). A field on any view is present (the guard). Variables, dot-walks and fields added by script are not judged.' }) },
  'PLT-082': { a: 'text_analysis', cand: ['sys_script_client'], params: [], config: undef('the deprecated API set per UI framework version — external reference data') },

  /* ═══ 3C. UI Policies and Data Policies ═══ */
  'PLT-083': { a: 'configuration_inspection', also: ['configuration'], cand: ['sys_script_client', 'sys_data_policy2'], params: [],
    config: cfg(PRODUCT_ROW, { name: 'plt_client_validation_unenforced', args: {} }, [T('sys_properties', 'name'), UPX, T('sys_script_client', 'name', 'table', 'type', 'script', 'active'), T('sys_data_policy_rule', 'table', 'field', 'mandatory', 'disabled'), T('sys_script', 'collection', 'when', 'script', 'active'), T('sys_db_object', 'name', 'super_class')],
      { kind: 'detection_gap', not_covered: 'A customer onSubmit script that can return false validates the fields it reads; each is enforced on the server when a data policy rule makes it mandatory or read-only, or a before rule naming it calls setAbortAction(true) (D-037). Server validation in flows or script includes is not seen.' }) },
  'PLT-084': { a: 'configuration_inspection', cand: ['sys_ui_policy_action', 'sys_data_policy_rule'], params: [],
    config: { engine: 'configuration', requires_tables: [UPX, T('sys_ui_policy_action', 'table', 'field', 'mandatory', 'ui_policy'), T('sys_data_policy_rule', 'table', 'field', 'mandatory')], reader: 'table_rows',
      args: { table: 'sys_ui_policy_action', fields: ['table', 'field', 'mandatory', 'ui_policy'], query: 'mandatory=true^ui_policy.active=true' },
      compare: { name: 'plt_mandatory_without_data_policy', args: { dictionary_optional: false } } } },
  'PLT-085': { a: 'configuration_inspection', also: ['configuration'], cand: ['sys_ui_policy_action'], params: [],
    config: cfg(rowsReader('sys_ui_policy', ['table', 'short_description', 'ui_type', 'global', 'view', 'conditions'], 'active=true'), { name: 'plt_ui_policy_conflicts', args: {} },
      [T('sys_ui_policy', 'table', 'short_description', 'ui_type', 'global', 'view', 'conditions', 'active'), T('sys_ui_policy_action', 'ui_policy', 'field', 'visible', 'mandatory', 'disabled')],
      { kind: 'detection_gap', not_covered: 'The conflict matrix the workbook gives (visible vs hidden, mandatory vs read-only) over the actions of active policies that meet on table, UI type and view and hold at the same time: equal conditions, or either unconditioned (D-035). Different conditions that can both hold are not analysed, nor reverse-if-false actions.' }) },
  'PLT-086': { a: 'record_predicate', also: ['configuration'], cand: ['sys_data_policy2', 'sys_update_xml'], params: [],
    /* sys_data_policy2 has no name field (verified, Phase 6D): short_description labels it. */
    config: { ...custom('sys_data_policy2', {}, { fields: ['apply_import_set', 'apply_soap', 'short_description'], label: 'short_description' }),
      variants: [
        { variant: 'import sets', compare: { name: 'plt_customer_where', args: { table: 'sys_data_policy2', fields: ['apply_import_set', 'apply_soap', 'short_description'], query: 'active=true', where: { apply_import_set: 'false' } } } },
        { variant: 'web services', compare: { name: 'plt_customer_where', args: { table: 'sys_data_policy2', fields: ['apply_import_set', 'apply_soap', 'short_description'], query: 'active=true', where: { apply_soap: 'false' } } } },
      ],
      partial: { kind: 'evidence_gap', not_covered: '"Where those paths carry volume" is not measured: every customer-authored policy not applied to a path is flagged.' } } },
  'PLT-087': { a: 'configuration_inspection', cand: ['sys_ui_policy'], params: [], config: undef(R.opClass) },
  'PLT-088': { a: 'record_predicate', also: ['configuration'], cand: ['sys_ui_policy', 'sys_update_xml'], params: [], config: custom('sys_ui_policy', { conditions: null }, { fields: ['conditions', 'short_description'], label: 'short_description' }) },
  'PLT-089': { a: 'configuration_inspection', cand: ['sys_data_policy2'], params: [], config: undef('process documentation or a control register that references a data policy — not established') },
  'PLT-090': { a: 'configuration_inspection', cand: ['sys_ui_policy_action', 'sys_data_policy_rule', 'sys_dictionary'], params: [],
    config: { engine: 'configuration', requires_tables: [UPX, T('sys_ui_policy_action', 'table', 'field', 'mandatory', 'ui_policy'), T('sys_data_policy_rule', 'table', 'field', 'mandatory'), T('sys_dictionary', 'name', 'element', 'mandatory')], reader: 'table_rows',
      args: { table: 'sys_ui_policy_action', fields: ['table', 'field', 'mandatory', 'ui_policy'], query: 'mandatory=true^ui_policy.active=true' },
      compare: { name: 'plt_mandatory_without_data_policy', args: { dictionary_optional: true } } } },

  /* ═══ Flows, Workflows and Automation ═══ */
  'PLT-091': { a: 'composite', cand: ['sys_script', 'wf_workflow', 'sys_hub_flow'], params: [], config: undef('an overlap analysis of trigger conditions and target fields across rules, workflows and flows — not defined') },
  'PLT-092': { a: 'configuration_inspection', cand: ['wf_workflow', 'sys_hub_flow'], params: [], config: undef('the "equivalence assessment by function and trigger" between a workflow and a flow — not defined') },
  'PLT-093': { a: 'configuration_inspection', also: ['configuration'], cand: ['sys_hub_flow', 'wf_workflow'], params: [],
    config: cfg(rowsReader('wf_workflow_version', ['name', 'table', 'condition'], 'active=true^published=true'), { name: 'plt_flow_workflow_overlap', args: {} },
      [T('wf_workflow_version', 'name', 'table', 'condition', 'active', 'published'), ...FLOW_TABLES, T('sys_hub_trigger_instance_v2', 'flow', 'trigger_type', 'trigger_inputs')],
      { kind: 'detection_gap', not_covered: 'A flow\'s record trigger (create / update) is read from its current snapshot\'s trigger inputs (D-035). Overlap is the same table with equal conditions, or either unconditioned; conditions that differ but intersect are not analysed.' }) },
  'PLT-094': { a: 'configuration_inspection', also: ['configuration'], cand: ['sys_hub_flow'], params: [],
    config: cfg(PRODUCT_ROW, { name: 'plt_flow_error_handling', args: {} }, [...FLOW_TABLES, T('sys_metadata_customization', 'sys_update_name', 'author_type'), T('sys_hub_flow_logic_definition', 'type'), T('sys_hub_flow_logic_instance_v2', 'flow', 'logic_definition')],
      { kind: 'detection_gap', not_covered: 'Customer-created active flows and subflows (author "Custom", as PLT-102): error handling is a Try / Catch block or the flow-level error handler in the current version\'s flow logic (D-037). Trivial flows (the guard) are charged.' }) },
  'PLT-095': { a: 'reference_integrity', also: ['configuration'], cand: ['sys_hub_flow'], params: [],
    config: cfg(PRODUCT_ROW, { name: 'plt_flow_dead_references', args: {} },
      [...FLOW_TABLES, T('sys_hub_action_instance_v2', 'flow', 'action_type'), T('sys_hub_action_type_snapshot', 'parent_action'), T('sys_hub_action_type_definition', 'active')],
      { kind: 'detection_gap', not_covered: 'Actions and subflows a current snapshot calls, resolved to their definitions: missing or inactive is charged (D-035). Records, tables and fields named inside step inputs are not resolved.' }) },
  'PLT-096': { a: 'record_predicate', cand: ['sys_flow_context'], params: [P('max_age', 'duration', 'hours', 24, 'executing-state threshold for non-wait flows')],
    config: { requires_tables: [T('sys_flow_context', 'name', 'state', 'flow')], table: 'sys_flow_context', scope: [clause('state={}', choice('sys_flow_context', 'state', ['In Progress', 'In progress']))],
      predicates: [{ field: 'sys_created_on', op: 'date_before', window: win('max_age') }], evidence_fields: ['name', 'flow', 'state', 'sys_created_on'], report_ratio: true,
      partial: { kind: 'detection_gap', not_covered: 'Contexts in progress (not waiting) are judged; a flow whose running step is itself a wait is not recognised.' } } },
  'PLT-097': { a: 'aggregate_distribution', cand: ['sys_flow_context'], params: [P('failure_rate', 'percent', null, 5, 'failure rate')],
    config: { requires_tables: [T('sys_flow_context', 'flow', 'state')], engine: 'aggregate', table: 'sys_flow_context', numerator_query: [clause('state={}', choice('sys_flow_context', 'state', 'Error'))], denominator_query: '', group_by: ['flow'],
      threshold: { op: 'gt', value: param('failure_rate') }, basis: 'contexts in error / contexts, by flow' } },
  'PLT-098': { a: 'configuration_inspection', cand: ['sys_hub_flow'], params: [P('volume', 'number', null, null, 'table volume threshold — UNDEFINED ("configurable")')], config: pending('reading record-created triggers and their conditions (sys_hub_trigger_instance)') },
  'PLT-099': { a: 'relationship_graph', also: ['configuration'], cand: ['sys_hub_flow'], params: [],
    config: cfg(PRODUCT_ROW, { name: 'plt_subflow_cycles', args: {} }, FLOW_TABLES,
      { kind: 'detection_gap', not_covered: 'The call graph of active flows\' current snapshots (subflow steps, callees resolved to their flow, D-035); a subflow started from a script is not an edge.' }) },
  'PLT-100': { a: 'text_analysis', also: ['configuration'], cand: ['sys_hub_flow'], params: [],
    config: cfg(PRODUCT_ROW, { name: 'plt_flow_hardcoded', args: {} }, [...FLOW_TABLES, T('sys_metadata_customization', 'sys_update_name', 'author_type'), T('sys_hub_action_instance_v2', 'flow', 'values')],
      { kind: 'detection_gap', not_covered: 'The step inputs of the current version of customer-created active flows: credential-named or password inputs holding a literal, Basic / Bearer values, URLs with embedded credentials, literal endpoints in URL inputs, and script steps (the script rules\' credential set, PLT-047) (D-037). Data pills are not literals.' }) },
  'PLT-101': { a: 'reference_integrity', also: ['configuration'], cand: ['sys_hub_flow', 'sys_user'], params: [], config: creator('sys_hub_flow', { query: 'active=true' }) },
  'PLT-102': { a: 'configuration_inspection', also: ['configuration'], cand: ['sys_hub_flow'], params: [],
    config: cfg(PRODUCT_ROW, { name: 'plt_flow_orphans', args: {} },
      [...FLOW_TABLES, T('sys_metadata_customization', 'sys_update_name', 'author_type'), T('sys_hub_trigger_instance_v2', 'flow'), T('contract_sla', 'flow'), T('sc_cat_item', 'flow_designer_flow'),
        T('sys_script_include', 'script'), T('sys_script', 'script'), T('sys_ui_action', 'script'), T('sysauto_script', 'script'), T('sys_ws_operation', 'operation_script')],
      { kind: 'detection_gap', not_covered: 'Customer-created flows and subflows only (author "Custom", D-033 register): ServiceNow ships subflows its own code calls. Callers read: triggers, subflow steps of active flows, SLA definitions, catalog items and scripts naming the flow (D-035). Virtual Agent topics, playbooks and AI agent tools are not read.' }) },
  'PLT-103': { a: 'aggregate_distribution', also: ['configuration'], cand: ['wf_workflow_version'], params: [P('max_versions', 'number', null, 20, 'version count threshold')],
    config: { engine: 'configuration', requires_tables: [T('wf_workflow_version', 'workflow')], reader: 'table_rows', args: { table: 'wf_workflow_version', fields: ['workflow'], query: '' },
      compare: { name: 'plt_group_count', args: { table: 'wf_workflow_version', group_field: 'workflow', max: param('max_versions') } } } },
  'PLT-104': { a: 'configuration_inspection', cand: ['sys_hub_flow'], params: [], config: undef('flow step types and execution mode, and which triggers are "user-facing" — not established') },
  'PLT-105': { a: 'aggregate_distribution', also: ['configuration'], cand: ['sys_flow_context'], params: [P('max_age', 'duration', 'days', null, 'age threshold — UNDEFINED'), P('growth', 'percent', null, null, 'growth threshold — UNDEFINED')],
    config: cfg(PRODUCT_ROW, { name: 'plt_flow_context_accumulation', args: { max_age: param('max_age'), growth: param('growth') } }, [T('sys_properties', 'name'), T('sys_flow_context', 'state')],
      { kind: 'detection_gap', not_covered: 'Contexts not Complete, Cancelled or Error, by age; and the context table\'s count against the previous scan of this instance (D-037). Long-running approval flows (the guard) are charged.' }) },

  /* ═══ Scheduled Jobs and Events ═══ */
  'PLT-106': { a: 'configuration_inspection', cand: ['sysauto', 'sys_trigger'], params: [],
    config: { engine: 'configuration', requires_tables: [T('sysauto', 'name', 'active', 'run_type', 'run_period'), T('sys_trigger', 'document_key', 'processing_duration')], reader: 'table_rows', args: { table: 'sysauto', fields: ['name', 'run_type', 'run_period'], query: 'active=true' },
      compare: { name: 'plt_job_overrun', args: { periodic: choice('sysauto', 'run_type', 'Periodically') } },
      partial: { kind: 'detection_gap', not_covered: 'The trigger keeps the LAST run\'s duration, not a history: that run is compared with the interval; the average is not available.' } } },
  'PLT-107': { a: 'temporal_correlation', cand: ['sysauto', 'sys_trigger'], params: [P('concurrency', 'number', null, null, 'concurrency threshold — UNDEFINED ("configurable")')], config: pending('expanding every schedule into run windows and counting concurrent jobs') },
  'PLT-108': { a: 'text_analysis', also: ['configuration'], cand: ['sysauto_script'], params: [P('min_rows', 'number', null, 100000, 'target table row threshold (PLT-039\'s)', 'D-037')],
    config: cfg(PRODUCT_ROW, { name: 'plt_unbounded_queries', args: { sources: [['sysauto_script', 'script']], min_rows: param('min_rows') } },
      [T('sys_properties', 'name'), UPX, T('sysauto_script', 'name', 'script', 'active')], SCRIPT_RISK_QUERY) },
  'PLT-109': { a: 'aggregate_distribution', cand: ['sys_trigger'], params: [P('horizon', 'duration', 'days', 90, 'projection horizon'), P('min_runs', 'number', null, 5, 'runs needed')], config: undef('a job\'s run-duration history — sys_trigger keeps the last run only (verified, Phase 6)') },
  'PLT-110': { a: 'aggregate_distribution', also: ['configuration'], cand: ['sys_trigger'], params: [P('failure_rate', 'percent', null, 20, 'failure rate')],
    config: { engine: 'configuration', requires_tables: [T('sys_trigger', 'name', 'error_count', 'run_count')], reader: 'table_rows', args: { table: 'sys_trigger', fields: ['name', 'error_count', 'run_count'], query: 'run_count>0' },
      compare: { name: 'plt_job_failure_rate', args: { failure_rate: param('failure_rate') } },
      partial: { kind: 'detection_gap', not_covered: 'The failure share is judged; "no failure alerting" cannot be read, so a job that alerts is flagged too — the rule can fail but never pass.' } } },
  'PLT-111': { a: 'cross_record_linkage', also: ['configuration'], cand: ['sysauto', 'sys_trigger'], params: [P('min_age', 'duration', 'days', 30, 'age threshold')],
    config: { engine: 'configuration', requires_tables: [T('sysauto', 'name', 'active', 'run_type'), T('sys_trigger', 'document_key', 'run_count')], reader: 'table_rows',
      /* An on-demand job never runs by itself (verified, Phase 6D): it is not judged. */
      args: { table: 'sysauto', fields: ['name', 'sys_created_on'], query: ['active=true', clause('run_type!={}', choice('sysauto', 'run_type', 'On Demand'))] },
      compare: { name: 'plt_job_never_ran', args: { min_age: win('min_age') } },
      partial: { kind: 'detection_gap', not_covered: '"Or 3 intervals, whichever is longer" is not applied: the 30-day age is.' } } },
  'PLT-112': { a: 'text_analysis', also: ['configuration'], cand: ['sysauto_script', 'sys_update_xml'], params: [],
    config: script('sysauto_script', 'deletes', { partial: { kind: 'false_positive_risk', not_covered: `${SCRIPT_RISK.not_covered} An archival step elsewhere cannot be seen, so every deleting job is flagged.` } }) },
  'PLT-113': { a: 'reference_integrity', also: ['configuration'], cand: ['sysauto', 'sys_user'], params: [], config: creator('sysauto') },
  'PLT-114': { a: 'configuration_inspection', cand: ['sysauto'], params: [], config: undef('a job\'s output consumption ("depends on the job type; state the method") — no method is given') },
  'PLT-115': { a: 'record_predicate', cand: ['sysevent'], params: [P('max_age', 'duration', 'minutes', 10, 'oldest unprocessed event')],
    config: { requires_tables: [T('sysevent', 'name', 'state', 'queue')], table: 'sysevent', scope: [clause('state={}', choice('sysevent', 'state', ['Ready', 'ready']))],
      predicates: [{ field: 'sys_created_on', op: 'date_before', window: win('max_age') }], evidence_fields: ['name', 'queue', 'sys_created_on'], report_ratio: true,
      partial: { kind: 'detection_gap', not_covered: 'The age half (the workbook calls it the more meaningful); the depth threshold is not given.' } } },
  'PLT-116': { a: 'cross_record_linkage', also: ['configuration'], cand: ['sysevent_register', 'sysevent_script_action', 'sysevent_email_action'], params: [],
    config: cfg(rowsReader('sysevent_register', ['event_name', 'table']), { name: 'plt_events_unconsumed', args: {} }, [T('sysevent_register', 'event_name'), T('sysevent_script_action', 'event_name', 'active'), T('sysevent_email_action', 'event_name', 'active'), T('sysevent', 'name')],
      { kind: 'detection_gap', not_covered: 'Fire volume is the event log as retained (sysevent is rotated). An event consumed by a flow trigger is not seen.' }) },
  'PLT-117': { a: 'aggregate_distribution', cand: ['sysevent'], params: [P('share', 'percent', null, 30, 'share of event volume from one event')],
    config: { requires_tables: [T('sysevent', 'name')], engine: 'aggregate', table: 'sysevent', group_by: ['name'], measure: 'share', threshold: { op: 'gt', value: param('share') }, basis: 'share of event volume from the largest event name',
      partial: { kind: 'evidence_gap', not_covered: 'By event name; the originating source is not reported.' } } },
  'PLT-118': { a: 'aggregate_distribution', cand: ['sys_trigger'], params: [P('max_backlog', 'number', null, null, 'backlog threshold — UNDEFINED ("configurable")')],
    config: { requires_tables: [T('sys_trigger', 'next_action')], engine: 'aggregate', table: 'sys_trigger', query: { $now: { field: 'next_action', op: '<' } }, measure: 'count', threshold: { op: 'gt', value: param('max_backlog') }, basis: 'triggers whose next action is in the past',
      partial: { kind: 'evidence_gap', not_covered: 'The backlog count is judged; its trend is not.' } } },
  'PLT-119': { a: 'aggregate_distribution', also: ['configuration'], cand: ['sys_trigger'], params: [P('max_lag', 'duration', 'minutes', 15, 'lag threshold')],
    config: cfg(rowsReader('sys_trigger', ['name', 'next_action', 'state'], 'nameSTARTSWITHASYNC^state=0'), { name: 'plt_async_lag', args: { max_lag: param('max_lag') } }, [T('sys_trigger', 'name', 'next_action', 'state')],
      { kind: 'detection_gap', not_covered: 'The async queue is the scheduler\'s "ASYNC: …" jobs (async business rules and events) waiting in state ready; lag is how far their next action is in the past.' }) },

  /* ═══ ACLs, Roles and Access ═══ */
  'PLT-120': { a: 'aggregate_distribution', also: ['configuration'], cand: ['sys_user_has_role'], params: [P('max_admins', 'number', null, 10, 'admin count threshold')],
    config: { engine: 'configuration', requires_tables: [T('sys_user_has_role', 'user', 'role', 'state')], reader: 'table_rows', args: { table: 'sys_user_has_role', fields: ['user'], query: 'role.name=admin^user.active=true^state=active' },
      compare: { name: 'plt_admin_count', args: { max: param('max_admins'), role: 'admin' } },
      partial: { kind: 'detection_gap', not_covered: '"1% of fulfillers, whichever is lower" needs a fulfiller definition the workbook does not give; the count is judged against 10, so a pass is not conclusive.' } } },
  'PLT-121': { a: 'configuration_inspection', cand: ['sys_security_acl', 'sys_security_acl_role', 'sys_update_xml'], params: [],
    config: { engine: 'configuration', requires_tables: [UPX, T('sys_security_acl', 'name', 'operation', 'condition', 'script', 'advanced', 'active'), T('sys_security_acl_role', 'sys_security_acl')], ...customerReader('sys_security_acl'),
      compare: { name: 'plt_open_acls', args: {} },
      partial: { kind: 'false_positive_risk', not_covered: 'An ACL grants unconditionally only when it has NO role requirement as well as no condition and no (or an always-true) script — a role-only ACL is not "open"; the escalation on sensitive tables needs a classification the workbook does not give.' } } },
  'PLT-122': { a: 'configuration_inspection', cand: ['sys_db_object', 'sys_security_acl'], params: [],
    config: cfg(rowsReader('sys_db_object', ['name'], 'nameSTARTSWITHu_^ORnameSTARTSWITHx_'), { name: 'plt_tables_without_acl', args: {} }, [T('sys_db_object', 'name', 'super_class'), T('sys_security_acl', 'name', 'active')],
      { kind: 'detection_gap', not_covered: 'Custom tables (u_ / x_) with no table-level ACL (table or table.*) on themselves or any table they extend — the inheritance the workbook requires.' }) },
  'PLT-123': { a: 'temporal_correlation', cand: ['sys_user_has_role', 'sys_audit', 'change_request'], params: [], config: undef('the approval / change correlation window ("configurable") and the elevated role set') },
  'PLT-124': { a: 'relationship_graph', cand: ['sys_user_role_contains'], params: [], config: undef('when an elevated role is "not evident from the role name or description" — not defined') },
  'PLT-125': { a: 'text_analysis', also: ['configuration'], cand: ['sys_security_acl', 'sys_update_xml'], params: [], config: script('sys_security_acl', 'returns_true', { fields: ['advanced'], where: { advanced: 'true' } }) },
  'PLT-126': { a: 'configuration_inspection', cand: ['sys_security_acl', 'm2m_dictionary_dataclass'], params: [],
    config: cfg(rowsReader('data_classification', ['name']), { name: 'plt_personal_data_acls', args: { classes: PERSONAL, mode: 'write_absent' } }, PERSONAL_TABLES,
      { kind: 'detection_gap', not_covered: 'Sensitive tables are the ones holding fields the instance classifies as personal data (m2m_dictionary_dataclass, D-032 / D-033). Table-level ACLs are read; ACLs inherited from a parent table are not credited.' }) },
  'PLT-127': { a: 'configuration_inspection', cand: ['sys_security_acl', 'm2m_dictionary_dataclass'], params: [],
    config: cfg(rowsReader('data_classification', ['name']), { name: 'plt_personal_data_acls', args: { classes: PERSONAL, mode: 'field_absent' } }, PERSONAL_TABLES,
      { kind: 'detection_gap', not_covered: 'The sensitive fields are those the instance classifies as personal data (D-032). Financial and credential fields are judged only when the instance classifies them.' }) },
  'PLT-128': { a: 'configuration_inspection', cand: ['sys_security_acl', 'm2m_dictionary_dataclass'], params: [],
    config: cfg(rowsReader('data_classification', ['name']), { name: 'plt_personal_data_acls', args: { classes: PERSONAL, mode: 'broad_read' } }, [...PERSONAL_TABLES, T('sys_security_acl_role', 'sys_security_acl', 'sys_user_role'), T('sys_user_role', 'name')]) },
  'PLT-129': { a: 'aggregate_distribution', cand: ['sys_user_has_role', 'sys_user'], params: [],
    config: { requires_tables: [T('sys_user_has_role', 'user', 'role')], engine: 'aggregate', table: 'sys_user_has_role', denominator_query: '', threshold: { op: 'gt', value: 0 },
      variants: [
        { variant: 'all roles', numerator_query: 'user.active=false', basis: 'role grants held by inactive users / role grants' },
        { variant: 'elevated roles', numerator_query: 'user.active=false^role.elevated_privilege=true', basis: 'elevated role grants held by inactive users / role grants' },
      ] } },
  'PLT-130': { a: 'record_predicate', cand: ['sys_user'], params: [],
    config: { requires_tables: [T('sys_user', 'user_name', 'active', 'internal_integration_user', 'web_service_access_only')], table: 'sys_user', scope: 'active=true^internal_integration_user=true',
      predicates: [{ field: 'web_service_access_only', op: 'not_equals', value: 'true' }], evidence_fields: ['user_name', 'last_login_time'], report_ratio: true,
      partial: { kind: 'detection_gap', not_covered: 'A service account is one the platform flags internal_integration_user; classification "from naming, roles and usage" is not applied.' } } },
  'PLT-131': { a: 'aggregate_distribution', cand: ['sys_user_has_role'], params: [P('direct_share', 'percent', null, null, 'share of direct grants — UNDEFINED (the workbook asks for the ratio, no threshold)')],
    config: { requires_tables: [T('sys_user_has_role', 'inherited')], engine: 'aggregate', table: 'sys_user_has_role', numerator_query: 'inherited=false', denominator_query: '', threshold: { op: 'gt', value: param('direct_share') }, basis: 'direct role grants / role grants' } },
  'PLT-132': { a: 'configuration_inspection', also: ['configuration'], cand: ['sys_user_role', 'sys_user_has_role', 'sys_user_role_contains', 'sys_update_xml'], params: [],
    config: { engine: 'configuration', requires_tables: [UPX, T('sys_user_role', 'name'), T('sys_user_has_role', 'role'), T('sys_user_role_contains', 'role')], ...customerReader('sys_user_role'),
      compare: { name: 'plt_roles_unheld', args: {} } } },
  'PLT-133': { a: 'configuration_inspection', cand: ['sys_group_has_role', 'sys_user_role', 'sys_user_grmember'], params: [],
    config: { engine: 'configuration', requires_tables: [T('sys_group_has_role', 'group', 'role'), T('sys_user_role', 'name', 'elevated_privilege'), T('sys_user_grmember', 'group', 'user')], reader: 'table_rows', args: { table: 'sys_group_has_role', fields: ['group', 'role'], query: '' },
      compare: { name: 'plt_empty_elevated_groups', args: {} },
      partial: { kind: 'detection_gap', not_covered: 'The elevated role set is the platform\'s own elevated_privilege flag; a customer-defined set is not configured.' } } },
  'PLT-134': { a: 'configuration_inspection', cand: [], params: [], config: undef('recertification or attestation records for role and group grants, and the review period "from policy" — not established') },
  'PLT-135': { a: 'configuration_inspection', cand: ['sys_security_acl', 'sys_metadata_customization'], params: [],
    config: cfg(rowsReader('sys_metadata_customization', ['author_type'], 'author_type=Custom^sys_update_nameSTARTSWITHsys_security_acl_'), { name: 'plt_custom_acl_weaker_than_oob', args: {} }, [MC, T('sys_security_acl', 'name', 'operation', 'condition', 'script', 'advanced', 'active'), T('sys_security_acl_role', 'sys_security_acl')],
      { kind: 'detection_gap', not_covered: 'Weaker = no role, no condition and no script, where the ServiceNow ACL on the same object and operation has at least one. A weaker condition than another condition is not compared.' }) },
  'PLT-136': { a: 'aggregate_distribution', also: ['configuration'], cand: ['sysevent'], params: [],
    config: cfg(rowsReader('sysevent', ['name', 'parm1', 'parm2'], 'name=impersonation.start'), { name: 'plt_impersonation_by_user', args: {} }, [T('sysevent', 'name', 'parm1', 'parm2')],
      { kind: 'detection_gap', not_covered: 'Impersonations are ServiceNow\'s impersonation.start events (parm1 the impersonator, parm2 the user, D-033), as retained — sysevent is rotated after about a week. Whether one was reviewed is not recorded.' }) },

  /* ═══ Integrations and Inbound ═══ */
  'PLT-137': { a: 'configuration_inspection', cand: ['sys_user', 'sys_user_has_role'], params: [],
    config: { engine: 'configuration', requires_tables: [T('sys_user', 'user_name', 'active', 'web_service_access_only', 'internal_integration_user'), T('sys_user_has_role', 'user', 'role')], reader: 'table_rows',
      args: { table: 'sys_user', fields: ['user_name'], query: 'active=true^web_service_access_only=true^ORinternal_integration_user=true' },
      compare: { name: 'plt_integration_admins', args: { role: 'admin' } },
      partial: { kind: 'detection_gap', not_covered: 'Integration accounts are those the platform flags; classification by naming and usage is not applied, and "admin or equivalent" is the admin role.' } } },
  'PLT-138': { a: 'record_predicate', cand: ['sys_rest_message', 'sys_rest_message_fn', 'sys_soap_message'], params: [],
    config: { requires_tables: [T('sys_rest_message', 'name', 'authentication_type'), T('sys_rest_message_fn', 'function_name', 'authentication_type'), T('sys_soap_message', 'name', 'use_basic_auth')], table: 'sys_rest_message', report_ratio: true,
      variants: [
        { variant: 'REST messages', table: 'sys_rest_message', scope: [clause('authentication_type={}', choice('sys_rest_message', 'authentication_type', 'Basic'))], predicates: [{ field: 'authentication_type', op: 'not_empty' }], evidence_fields: ['name', 'rest_endpoint'] },
        { variant: 'REST methods', table: 'sys_rest_message_fn', scope: [clause('authentication_type={}', choice('sys_rest_message_fn', 'authentication_type', 'Basic'))], predicates: [{ field: 'authentication_type', op: 'not_empty' }], evidence_fields: ['function_name', 'rest_endpoint'] },
        { variant: 'SOAP messages', table: 'sys_soap_message', scope: 'use_basic_auth=true', predicates: [{ field: 'use_basic_auth', op: 'equals', value: 'true' }], evidence_fields: ['name'] },
      ],
      partial: { kind: 'detection_gap', not_covered: 'Outbound integrations are judged; inbound basic authentication is an instance-wide setting, not per integration, and is not reported separately.' } } },
  'PLT-139': { a: 'record_predicate', cand: ['sys_rest_message', 'sys_rest_message_fn', 'sys_soap_message'], params: [],
    config: { requires_tables: [T('sys_rest_message', 'name', 'use_basic_auth', 'basic_auth_profile', 'basic_auth_password'), T('sys_rest_message_fn', 'function_name', 'use_basic_auth', 'basic_auth_profile', 'basic_auth_password'), T('sys_soap_message', 'name', 'use_basic_auth', 'basic_auth_profile', 'basic_auth_password')], table: 'sys_rest_message', report_ratio: true,
      variants: [
        { variant: 'REST messages', table: 'sys_rest_message', scope: 'use_basic_auth=true', predicates: [{ field: 'basic_auth_password', op: 'not_empty' }, { field: 'basic_auth_profile', op: 'empty' }], evidence_fields: ['name'] },
        { variant: 'REST methods', table: 'sys_rest_message_fn', scope: 'use_basic_auth=true', predicates: [{ field: 'basic_auth_password', op: 'not_empty' }, { field: 'basic_auth_profile', op: 'empty' }], evidence_fields: ['function_name'] },
        { variant: 'SOAP messages', table: 'sys_soap_message', scope: 'use_basic_auth=true', predicates: [{ field: 'basic_auth_password', op: 'not_empty' }, { field: 'basic_auth_profile', op: 'empty' }], evidence_fields: ['name'] },
      ],
      partial: { kind: 'detection_gap', not_covered: 'An inline password with no authentication profile (the platform\'s credential alias) is flagged; other credential-bearing integrations (data sources, spokes) are not read. Owner of OWN-005 (ITOM-024 defers here).' } } },
  'PLT-140': { a: 'configuration_inspection', cand: [], params: [], config: undef('inbound integration write paths (which inbound API writes which table, through IRE or not) — not established') },
  'PLT-141': { a: 'configuration_inspection', cand: [], params: [], config: undef('integration retry and error-handling configuration — not a platform field of REST or SOAP messages; ownership OWN-009 has no owner yet') },
  'PLT-142': { a: 'aggregate_distribution', also: ['configuration'], cand: ['sys_outbound_http_log'], params: [P('failure_rate', 'percent', null, 5, 'failure rate')],
    config: cfg(rowsReader('sys_outbound_http_log', ['url', 'hostname', 'response_status']), { name: 'plt_outbound_failure_rate', args: { rate: param('failure_rate') } }, [T('sys_outbound_http_log', 'url', 'hostname', 'response_status')],
      { kind: 'detection_gap', not_covered: 'Outbound calls as retained in sys_outbound_http_log, by host; a failure is no status or HTTP 400 and above. Inbound integrations are not read.' }) },
  'PLT-143': { a: 'configuration_inspection', cand: ['sys_ws_definition', 'sys_rate_limit_rules'], params: [], config: undef('which rate-limit rule covers which inbound integration — rate limits match by resource and user, and the matching is not defined') },
  'PLT-144': { a: 'record_predicate', cand: ['sys_rest_message', 'sys_rest_message_fn', 'sys_soap_message'], params: [],
    config: { requires_tables: [T('sys_rest_message', 'name', 'rest_endpoint'), T('sys_rest_message_fn', 'function_name', 'rest_endpoint'), T('sys_soap_message', 'name', 'wsdl')], table: 'sys_rest_message', report_ratio: true,
      variants: [
        { variant: 'REST messages', table: 'sys_rest_message', scope: 'rest_endpointSTARTSWITHhttp://', predicates: [{ field: 'rest_endpoint', op: 'not_empty' }], evidence_fields: ['name', 'rest_endpoint'] },
        { variant: 'REST methods', table: 'sys_rest_message_fn', scope: 'rest_endpointSTARTSWITHhttp://', predicates: [{ field: 'rest_endpoint', op: 'not_empty' }], evidence_fields: ['function_name', 'rest_endpoint'] },
        { variant: 'SOAP messages', table: 'sys_soap_message', scope: 'wsdlSTARTSWITHhttp://', predicates: [{ field: 'wsdl', op: 'not_empty' }], evidence_fields: ['name', 'wsdl'] },
      ] } },
  'PLT-145': { a: 'configuration_inspection', cand: ['oauth_entity'], params: [P('max_days', 'number', null, 90, 'refresh-token lifetime in days')],
    config: { engine: 'configuration', requires_tables: [T('oauth_entity', 'name', 'active', 'refresh_token_lifespan')], reader: 'table_rows', args: { table: 'oauth_entity', fields: ['name', 'refresh_token_lifespan'], query: 'active=true' },
      compare: { name: 'plt_oauth_lifetime', args: { max_days: param('max_days') } } } },
  'PLT-146': { a: 'configuration_inspection', cand: [], params: [], config: undef('integration write paths and workflow suppression per integration — not established') },
  'PLT-147': { a: 'aggregate_distribution', cand: ['sys_outbound_http_log'], params: [P('window', 'duration', 'days', 180, 'window')], config: needs('integration_outcomes') },
  'PLT-148': { a: 'configuration_inspection', cand: ['sys_rest_message_fn'], params: [],
    config: { engine: 'configuration', requires_tables: [T('sys_rest_message_fn', 'rest_message', 'rest_endpoint', 'http_method')], reader: 'table_rows', args: { table: 'sys_rest_message_fn', fields: ['rest_message', 'rest_endpoint', 'http_method', 'function_name'], query: '' },
      compare: { name: 'plt_duplicate_endpoints', args: {} },
      partial: { kind: 'detection_gap', not_covered: 'REST functions are compared on method and normalised URL; payload comparison and SOAP functions are not.' } } },
  'PLT-149': { a: 'aggregate_distribution', cand: ['sys_import_set'], params: [P('max_rows', 'number', null, null, 'size threshold — UNDEFINED ("configurable")')], config: pending('row counts per import set table and the cleanup job configuration') },
  'PLT-150': { a: 'configuration_inspection', cand: ['sys_transform_map', 'sys_transform_entry'], params: [],
    config: { engine: 'configuration', requires_tables: [T('sys_transform_map', 'name', 'active', 'target_table'), T('sys_transform_entry', 'map', 'coalesce')], reader: 'table_rows', args: { table: 'sys_transform_map', fields: ['name', 'target_table'], query: 'active=true' },
      compare: { name: 'plt_transform_no_coalesce', args: {} },
      partial: { kind: 'evidence_gap', not_covered: 'Every active map without coalesce is flagged; whether its import recurs, and the duplicate counts on its target, are not attached.' } } },
  'PLT-151': { a: 'aggregate_distribution', cand: ['sys_import_set_row'], params: [], config: undef('transform script errors attributed to their map, relative to row volume — not established') },
  'PLT-152': { a: 'configuration_inspection', cand: ['sys_data_source'], params: [], config: undef('data-source credential expiry and authentication outcomes — not fields of sys_data_source (verified, Phase 6)') },
  'PLT-153': { a: 'reference_integrity', also: ['configuration'], cand: ['sys_rest_message', 'sys_user'], params: [], config: creator('sys_rest_message', { query: '' }) },

  /* ═══ Customization and Upgrade Debt ═══ */
  'PLT-154': { a: 'configuration_inspection', cand: ['sys_upgrade_history', 'sys_upgrade_history_log'], params: [],
    config: { engine: 'configuration', requires_tables: [T('sys_upgrade_history', 'to_version', 'upgrade_started'), T('sys_upgrade_history_log', 'upgrade_history', 'disposition', 'resolution_status')], reader: 'table_rows', args: { table: 'sys_upgrade_history', fields: ['to_version', 'upgrade_started'], query: '' },
      compare: { name: 'plt_unreviewed_skips', args: { skipped_values: [choice('sys_upgrade_history_log', 'disposition', ['Skipped', 'skipped'])] } },
      partial: { kind: 'evidence_gap', not_covered: 'Unreviewed skips of the latest upgrade are found; the ranking by execution volume and criticality is not available.' } } },
  'PLT-155': { a: 'aggregate_distribution', also: ['configuration'], cand: ['sys_metadata_customization'], params: [],
    config: cfg(rowsReader('sys_metadata_customization', ['author_type'], 'author_type=ServiceNow'), { name: 'plt_oob_modifications_by_type', args: {} }, [MC]) },
  'PLT-156': { a: 'configuration_inspection', cand: ['sys_update_version'], params: [], config: undef('ServiceNow\'s own change frequency per object across releases — external reference data') },
  'PLT-157': { a: 'configuration_inspection', cand: ['sys_properties'], params: [P('max_families', 'number', null, 2, 'families behind')], config: undef('the CURRENT ServiceNow release family — external reference data') },
  'PLT-158': { a: 'configuration_inspection', cand: ['sys_metadata'], params: [], config: undef('a "coherent functional group suitable for a scoped application" — not defined') },
  'PLT-159': { a: 'configuration_inspection', cand: ['sys_db_object'], params: [], config: undef('"usage that exercises the inherited capabilities" — not defined') },
  'PLT-160': { a: 'aggregate_distribution', also: ['configuration'], cand: ['sys_dictionary'], params: [P('min_population', 'percent', null, 5, 'population threshold')],
    config: cfg(rowsReader('sys_dictionary', ['name', 'element'], 'elementSTARTSWITHu_'), { name: 'plt_custom_field_population', args: { min_population: param('min_population') } }, [T('sys_dictionary', 'name', 'element')]) },
  'PLT-161': { a: 'configuration_inspection', cand: ['sys_dictionary'], params: [], config: undef('semantic matching of a custom field with an OOB field "from name, type and population correlation" — no method is given') },
  'PLT-162': { a: 'text_analysis', cand: ['sys_script', 'sys_script_include'], params: [], config: undef('the deprecated API list per release — external reference data') },
  'PLT-163': { a: 'record_predicate', cand: ['v_plugin'], params: [], config: undef('plugin deprecation status — v_plugin has no deprecation field on a verified instance (Phase 6)') },
  'PLT-164': { a: 'aggregate_distribution', also: ['configuration'], cand: ['sys_update_version'], params: [P('max_changes', 'number', null, 5, 'modifications'), P('window', 'duration', 'months', 12, 'window')],
    config: { engine: 'configuration', requires_tables: [T('sys_update_version', 'name', 'source_table')], reader: 'table_rows', args: { table: 'sys_update_version', fields: ['name'], query: 'sys_idISEMPTY' },
      compare: { name: 'plt_hotspots', args: { max: param('max_changes'), window: win('window') } },
      partial: { kind: 'evidence_gap', not_covered: 'Customer versions (source: an update set) per object in the window are counted; the trend is not.' } } },
  'PLT-165': { a: 'record_predicate', cand: ['sys_update_set', 'sys_remote_update_set'], params: [P('open_age', 'duration', 'days', null, 'age of an open update set — UNDEFINED'), P('preview_age', 'duration', 'days', null, 'age in preview — UNDEFINED')],
    config: { requires_tables: [T('sys_update_set', 'name', 'state', 'is_default'), T('sys_remote_update_set', 'name', 'state')], table: 'sys_update_set', report_ratio: true,
      variants: [
        { variant: 'open', table: 'sys_update_set', scope: [clause('state={}', choice('sys_update_set', 'state', 'In progress')), 'is_default=false'], predicates: [{ field: 'sys_created_on', op: 'date_before', window: win('open_age') }], evidence_fields: ['name', 'sys_created_by'] },
        { variant: 'preview', table: 'sys_remote_update_set', scope: [clause('state={}', choice('sys_remote_update_set', 'state', 'Previewed'))], predicates: [{ field: 'sys_created_on', op: 'date_before', window: win('preview_age') }], evidence_fields: ['name'] },
      ],
      partial: { kind: 'detection_gap', not_covered: 'The open and preview cases are judged; unresolved collisions are not read.' } } },
  'PLT-166': { a: 'configuration_inspection', cand: ['sys_metadata', 'sys_update_xml'], params: [], config: undef('the creation window and instance indicators that separate a production change from a deployment — not defined') },
  'PLT-167': { a: 'configuration_inspection', cand: ['sys_scope_privilege'], params: [], config: undef('"breadth assessment from actual usage" of a cross-scope privilege — not defined') },
  'PLT-168': { a: 'configuration_inspection', cand: ['sys_app'], params: [], config: undef('a custom application\'s owner and source-control link — neither is a field of sys_app (verified, Phase 6)') },
  'PLT-169': { a: 'aggregate_distribution', also: ['configuration'], cand: ['sys_db_object'], params: [P('max_rows', 'number', null, 5, 'row threshold'), P('min_age', 'duration', 'days', 180, 'age threshold')],
    config: cfg(rowsReader('sys_db_object', ['name', 'sys_created_on'], 'nameSTARTSWITHu_^ORnameSTARTSWITHx_'), { name: 'plt_sparse_custom_tables', args: { max_rows: param('max_rows'), min_age: param('min_age') } }, [T('sys_db_object', 'name')]) },
  'PLT-170': { a: 'configuration_inspection', equivalent_of: 'CMDB-120', cand: ['sys_db_object'], params: [],
    note: 'The same condition as CMDB-120 Ownership OWN-007 is AGREED with CMDB-120 as owner (D-025): evaluated and counted in CMDB, shown here as an equivalent.' },

  /* ═══ Performance and Platform Health ═══ */
  'PLT-171': { a: 'aggregate_distribution', also: ['configuration'], cand: ['syslog_transaction'], params: [P('max_seconds', 'number', null, 3, 'p95 response-time threshold in seconds'), P('window', 'duration', 'hours', null, 'window — UNDEFINED')],
    config: { engine: 'configuration', requires_tables: [T('syslog_transaction', 'response_time', 'type')], reader: 'table_rows',
      args: { table: 'syslog_transaction', fields: ['response_time', 'type'], query: [{ $window: { param: 'window', field: 'sys_created_on', edge: 'within' } }] },
      compare: { name: 'plt_p95_response', args: { max_seconds: param('max_seconds') } },
      partial: { kind: 'detection_gap', not_covered: 'The overall 95th percentile is judged; the per-transaction-type breakdown is not, and "interactive" is every transaction in the window.' } } },
  'PLT-172': { a: 'aggregate_distribution', also: ['configuration'], cand: ['syslog_transaction'], params: [P('min_windows', 'number', null, 3, 'windows needed'), P('max_seconds', 'number', null, 3, 'slow threshold in seconds (PLT-171\'s)', 'D-037'), P('period', 'duration', 'days', null, 'window length — UNDEFINED')],
    config: cfg(PRODUCT_ROW, { name: 'plt_slow_transaction_trend', args: { min_windows: param('min_windows'), max_seconds: param('max_seconds'), period: param('period') } }, [T('sys_properties', 'name'), T('syslog_transaction', 'response_time')],
      { kind: 'detection_gap', not_covered: 'The share of transactions slower than PLT-171\'s threshold per window, over the retained transaction log (normalised by all transactions in the window, as the workbook requires), trended by least squares (D-037).' }) },
  'PLT-173': { a: 'aggregate_distribution', also: ['configuration'], cand: ['sys_script_pattern'], params: [],
    config: cfg(rowsReader('sys_script_pattern', ['script_source']), { name: 'plt_slow_scripts', args: { top: 25 } }, [T('sys_script_pattern', 'script_source', 'script_source_table', 'count', 'average', 'total')],
      { kind: 'evidence_gap', not_covered: 'A measure: ServiceNow\'s Slow Scripts log ranked by total time and frequency (D-033); the workbook gives no threshold, so nothing is judged.' }) },
  'PLT-174': { a: 'aggregate_distribution', cand: ['sys_db_object'], params: [P('max_rows', 'number', null, 10000000, 'size threshold')], config: pending('row counts across tables and their rotation / archival configuration') },
  'PLT-175': { a: 'configuration_inspection', cand: ['sys_db_object'], params: [], config: undef(R.transactions) },
  'PLT-176': { a: 'aggregate_distribution', cand: ['sys_audit', 'sys_history_line'], params: [P('max_rows', 'number', null, null, 'size threshold — UNDEFINED')], config: pending('audit and history table sizes against their rotation configuration') },
  'PLT-177': { a: 'aggregate_distribution', cand: ['sys_attachment'], params: [P('max_bytes', 'number', null, null, 'storage threshold — UNDEFINED')], config: pending('attachment storage volume and growth rate') },
  'PLT-178': { a: 'record_predicate', cand: ['sys_email'], params: [P('max_age', 'duration', 'minutes', 15, 'oldest unsent message')],
    config: { requires_tables: [T('sys_email', 'type', 'state')], table: 'sys_email', scope: [clause('type={}', choice('sys_email', 'type', ['send-ready', 'Send-ready']))],
      predicates: [{ field: 'sys_created_on', op: 'date_before', window: win('max_age') }], evidence_fields: ['subject', 'sys_created_on'], report_ratio: true,
      partial: { kind: 'detection_gap', not_covered: 'The age half (the workbook\'s own default); the depth threshold is not given.' } } },
  'PLT-179': { a: 'aggregate_distribution', cand: ['sys_semaphore'], params: [], config: undef('semaphore exhaustion events or utilisation — "where available", and none is established') },
  'PLT-180': { a: 'aggregate_distribution', also: ['configuration'], cand: ['syslog_cancellation'], params: [],
    config: cfg(rowsReader('syslog_cancellation', ['url', 'sys_created_on']), { name: 'plt_cancelled_transactions', args: {} }, [T('syslog_cancellation', 'url')],
      { kind: 'evidence_gap', not_covered: 'Cancelled transactions are ServiceNow\'s cancellation log (syslog_cancellation, D-033), as retained; the trend needs stored history and is not reported.' }) },
  'PLT-181': { a: 'aggregate_distribution', cand: ['syslog_transaction'], params: [P('max_rows', 'number', null, 10000, 'row threshold')], config: undef('rows returned per list or report query — not a field of the transaction log') },
  'PLT-182': { a: 'aggregate_distribution', cand: ['sys_portal_page'], params: [], config: undef(R.transactions) },
  'PLT-183': { a: 'temporal_correlation', cand: ['sys_report', 'syslog_transaction'], params: [], config: undef('when a scheduled report runs, and the instance\'s peak window "derived from its own transaction distribution" — no derivation is given') },
};

/* The platform objects the configs above name, with their candidate table (null: none known). */
export const PLACEHOLDERS = {
  integration_outcomes: { candidate: 'sys_outbound_http_log', rules: ['PLT-142', 'PLT-147'], expected_fields: ['url', 'response_status', 'sys_created_on'] },
};
