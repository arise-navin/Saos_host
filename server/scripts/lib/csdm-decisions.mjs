/**
 * HEALTH ASSIST PHASE 9 — the CSDM decision table: one entry per rule of the CSDM sheet
 * (CSDM-001 … CSDM-080, transcribed from the product owner's CSDM KPI Articulation —
 * rules/workbook/supplements/csdm-kpi-articulation.md).
 *
 * `node scripts/build-workbook-pack.mjs --pack csdm` turns this into the pack's generated
 * files. Every rule is in one recorded state (executable, unconfigured, undefined,
 * specification gap, not built, equivalent, derived); the rules of the other packs hold:
 * nothing is read before it is verified on the instance, no platform value is hard-coded
 * (classifications, statuses and environments come from $choice labels), and no
 * threshold is invented — CSDM states few numbers, so most rules either have none to set
 * or wait for one.
 *
 * Every table and field below was checked READ-ONLY on techsnitchpvtltddemo2 before this
 * table was written (Phase 9).
 *
 * GATING (the catalogue's own build note): "CSDM-032 gates the entire lifecycle group,
 * CSDM-050 gates environment, CSDM-062 gates the offering group, and CSDM-043 gates
 * CSDM-044 through 046 … Encode the gating in the rule pack, not in the report." A gate
 * that FAILS makes its dependants unmeasurable (`gated_by`, the runner's gate); CSDM-043
 * is a per-record rule, so 044–046 judge only records whose environment is set and are
 * marked provisional on it (dependencies.json).
 *
 * THE LAYERS are read from the class, or from service_classification on the base class
 * (csdm/comparators.js layerFn): both CSDM 3 and CSDM 4 models are judged.
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

const CLASSIFICATION = {
  business: choice('cmdb_ci_service', 'service_classification', 'Business Service'),
  technical: choice('cmdb_ci_service', 'service_classification', 'Technology Management Service'),
  application: choice('cmdb_ci_service', 'service_classification', 'Application Service'),
};
const PRODUCTION = choice('cmdb_ci_service', 'used_for', 'Production');
const SVC_FIELDS = ['name', 'sys_class_name', 'service_classification', 'used_for', 'life_cycle_stage', 'life_cycle_stage_status', 'owned_by', 'managed_by', 'support_group', 'business_relation_manager', 'operational_status', 'parent'];
const SVC = T('cmdb_ci_service', ...SVC_FIELDS);
const REL = T('cmdb_rel_ci', 'parent', 'child', 'type');
const DBO = T('sys_db_object', 'name', 'super_class');
/** A rule over the service records (one shared read of cmdb_ci_service). */
const svc = (name, args = {}, { requires = [], partial, gated_by } = {}) => ({
  engine: 'configuration', requires_tables: [SVC, DBO, ...requires], reader: 'table_rows', args: { table: 'cmdb_ci_service', fields: SVC_FIELDS, query: '' },
  compare: { name, args: { classification: CLASSIFICATION, ...args } },
  ...(partial ? { partial } : {}), ...(gated_by ? { gated_by } : {}),
});
const LIFECYCLE_GATE = [{ rule: 'CSDM-032', reason: 'the lifecycle model is not configured (no permitted stage / status set)' }];
const ENVIRONMENT_GATE = [{ rule: 'CSDM-050', reason: 'no environment value set is defined' }];
const OFFERING_GATE = [{ rule: 'CSDM-062', reason: 'the offering layer is not used at all' }];
/*
 * D-032 — values taken from ServiceNow's own documentation (the product owner: "go ahead with the
 * recommendations"): the personal-data classes (the instance's Data Classification, the
 * m2m_dictionary_dataclass field tags), the pre-operational life cycle stages of the intangible /
 * logical process (CSDM 5 white paper), and the CSDM stage tables (Foundation … Fly).
 */
export const PERSONAL_DATA_CLASSES = ['Personally identifiable information', 'HR PII', 'Master data PII', 'Transactional Data PII', 'Contact information', 'Identification information', 'Demographic information'];
const PRE_OPERATIONAL = ['Ideation', 'Purchase', 'Inventory', 'Design', 'Deploy'];
const FOUNDATION = ['core_company', 'cmn_department', 'cmn_location', 'sys_user_group', 'sys_user', 'cmdb_model'];
const CLASSIFIED = [T('data_classification', 'name'), T('m2m_dictionary_dataclass', 'data_class', 'sys_dictionary'), T('sys_dictionary', 'name', 'element')];
const SUGGEST = T('cmdb_rel_type_suggest', 'base_class', 'dependent_class', 'cmdb_rel_type', 'parent', 'child');

const R = {
  personal: 'which service processes which personal data — the fields are classified (m2m_dictionary_dataclass, D-032), but no information object links them to a business application or service on the instance',
  dataOwner: 'a data owner — cmdb_ci_service has no data-owner field (verified, Phase 9); which field stands for it (the information object\'s owned_by, a role) is not given',
  conditionEvaluator: 'evaluating SLA definition conditions against services — no condition evaluator is defined (the ITSM-004 gap)',
  trend: 'a series across assessments — the pack keeps no snapshot history of its own measures yet',
  audit: 'sys_audit history of the lifecycle and ownership fields per service — sys_audit is opt-in for the scan and no field-level audit reading is built',
};

/* D-033 — the service read with its creation date (field history). */
const svcDated = (name, args = {}, { requires = [], partial, gated_by } = {}) => ({
  ...svc(name, args, { requires, partial, gated_by }), args: { table: 'cmdb_ci_service', fields: [...SVC_FIELDS, 'sys_created_on'], query: '' },
});
const SLA_READ = { engine: 'configuration', reader: 'table_rows', args: { table: 'contract_sla', fields: ['name', 'start_condition', 'pause_condition', 'stop_condition'], query: 'active=true' } };

export const RULES = {
  /* ═══ Group 1 — Taxonomy conformance ═══ */
  'CSDM-001': { a: 'configuration_inspection', cand: ['cmdb_ci_business_capability'], params: [],
    config: { engine: 'configuration', requires_tables: [T('cmdb_ci_business_capability', 'name')], reader: 'table_rows', args: { table: 'cmdb_ci_business_capability', fields: ['name'], query: '' },
      compare: { name: 'csdm_absent', args: { what: 'Business Capability layer (cmdb_ci_business_capability)' } },
      partial: { kind: 'false_positive_risk', not_covered: '"Where the CSDM plugin is active" is read as the class existing on the instance. An estate that deliberately starts at Business Service (a lower target band) is still charged: the target band is not recorded.' } } },
  'CSDM-002': { a: 'cross_record_linkage', also: ['configuration'], cand: ['cmdb_ci_business_capability', 'cmdb_ci_business_app', 'cmdb_rel_ci'], params: [],
    config: svc('csdm_unlinked', { from: { table: 'cmdb_ci_business_capability' }, to: { table: 'cmdb_ci_business_app' }, unit: 'business capabilities' }, { requires: [T('cmdb_ci_business_capability', 'name'), T('cmdb_ci_business_app', 'name'), REL],
      partial: { kind: 'false_positive_risk', not_covered: 'A relationship of any type, in either direction, counts as the link. Capabilities created ahead of a mapping programme are counted.' } }) },
  'CSDM-003': { a: 'cross_record_linkage', also: ['configuration'], cand: ['cmdb_ci_business_app', 'cmdb_ci_service_auto', 'cmdb_rel_ci'], params: [],
    config: svc('csdm_unlinked', { from: { table: 'cmdb_ci_business_app' }, to: { layers: ['application'] }, unit: 'business applications' }, { requires: [T('cmdb_ci_business_app', 'name'), REL],
      partial: { kind: 'false_positive_risk', not_covered: 'A relationship of any type, in either direction, counts. Applications kept for portfolio purposes only are counted.' } }) },
  'CSDM-004': { a: 'cross_record_linkage', also: ['configuration'], cand: ['cmdb_ci_service', 'service_offering'], params: [],
    config: svc('csdm_no_offering', {}, { gated_by: OFFERING_GATE }) },
  'CSDM-005': { a: 'cross_record_linkage', also: ['configuration'], cand: ['service_offering', 'service_offering_commitment', 'contract_sla'], params: [],
    config: svc('csdm_offering_no_commitment', {}, { requires: [T('service_offering', 'name', 'sla'), T('service_offering_commitment', 'service_offering', 'service_commitment')], gated_by: OFFERING_GATE,
      partial: { kind: 'detection_gap', not_covered: 'A commitment (service_offering_commitment) or the offering\'s own SLA field counts; an SLA definition covering the offering through its conditions is not evaluated (no condition evaluator). Commitments held in a contract system are not seen.' } }) },
  'CSDM-006': { a: 'cross_record_linkage', equivalent_of: 'CMDB-110', cand: ['cmdb_ci_service_auto', 'svc_ci_assoc', 'cmdb_rel_ci'], params: [],
    note: 'The same condition as CMDB-110 ("Application Service with no supporting CIs", the same detection over both mechanisms): evaluated and counted in CMDB, shown here as an equivalent.' },
  'CSDM-007': { a: 'cross_record_linkage', also: ['configuration'], cand: ['cmdb_ci_service_technical', 'cmdb_rel_ci'], params: [],
    config: svc('csdm_unlinked', { from: { layers: ['technical'] }, to: { layers: ['application'] }, unit: 'technical services' }, { requires: [REL, T('cmdb_ci_business_app', 'name')],
      partial: { kind: 'detection_gap', not_covered: 'A relationship to an application service (either direction, any type) counts; a relationship to a business application directly is not read.' } }) },
  'CSDM-008': { a: 'configuration_inspection', cand: ['cmdb_ci_service'], params: [],
    config: svc('csdm_classification_mismatch') },
  'CSDM-009': { a: 'text_analysis', cand: ['cmdb_ci_service', 'cmdb_ci'], params: [], config: gap('each layer\'s "attribute signature and relationship pattern" profile, and the margin by which a record must match another layer\'s') },
  'CSDM-010': { a: 'text_analysis', cand: ['cmdb_ci_service', 'svc_ci_assoc'], params: [], config: gap('what counts as name and consumer overlap, and how much the supporting CI sets must overlap') },
  'CSDM-011': { a: 'relationship_graph', also: ['configuration'], cand: ['cmdb_ci_service', 'service_offering', 'cmdb_rel_ci'], params: [],
    config: svc('csdm_layer_skip', {}, { requires: [REL, T('cmdb_ci_business_app', 'name'), T('cmdb_ci_business_capability', 'name'), T('cmdb_ci_information_object', 'name')],
      partial: { kind: 'detection_gap', not_covered: 'The shortcut judged is a business service or offering related directly to an infrastructure CI (the catalogue\'s example). Other non-adjacent layer pairs are not defined and not judged; whether shortcuts are the dominant pattern is not assessed.' } }) },
  'CSDM-012': { a: 'relationship_graph', cand: ['cmdb_rel_ci'], params: [], config: gap('how far below the top-decile depth a service must fall to count — by construction nine services in ten are below the top decile') },
  'CSDM-013': { a: 'cross_record_linkage', also: ['configuration'], cand: ['cmdb_ci_business_app', 'cmdb_ci_business_capability', 'cmdb_rel_ci'], params: [],
    config: svc('csdm_unlinked', { from: { table: 'cmdb_ci_business_app' }, to: { table: 'cmdb_ci_business_capability' }, unit: 'business applications' }, { requires: [T('cmdb_ci_business_app', 'name'), T('cmdb_ci_business_capability', 'name'), REL],
      partial: { kind: 'false_positive_risk', not_covered: 'A relationship of any type, in either direction, counts. Where the capability layer is not in use every application is charged (the guard is CSDM-001\'s finding).' } }) },
  'CSDM-014': { a: 'configuration_inspection', also: ['configuration'], cand: ['cmdb_ci_information_object', 'm2m_dictionary_dataclass'], deps: { related: ['DQ-139'] }, params: [],
    config: svc('csdm_information_object_layer', { classes: PERSONAL_DATA_CLASSES }, { requires: [...CLASSIFIED, T('cmdb_ci_information_object', 'name')],
      partial: { kind: 'detection_gap', not_covered: 'Personal data holdings are the fields the instance classifies with a personal-data class (m2m_dictionary_dataclass, D-032); unclassified personal data is not seen. "Negligible" is not defined: zero information objects is judged. Classification kept outside CSDM is not recognised.' } }) },
  'CSDM-015': { a: 'cross_record_linkage', also: ['configuration'], cand: ['incident', 'cmdb_ci_service'], params: [],
    config: svc('csdm_unlayered_referenced', {}, { requires: [T('incident', 'business_service')],
      partial: { kind: 'detection_gap', not_covered: 'Service records incidents reference are judged; a record in no layer is a base-class service with no classification, or a class outside the CSDM tree. SLA references resolve through conditions and are not read.' } }) },
  'CSDM-016': { a: 'cross_record_linkage', cand: ['sc_cat_item', 'spm_service_portfolio'], params: [], config: undef('which "published catalogue" the service list is compared with (service catalog items, the service portfolio, an external catalogue), and how entries are matched') },

  /* ═══ Group 2 — Lifecycle integrity (gated by CSDM-032) ═══ */
  'CSDM-017': { a: 'record_predicate', also: ['configuration'], cand: ['cmdb_ci_service'], params: [],
    /* CSDM-026 "replaces" the per-record empty-field findings when a class sits at the default: gated on it too. */
    config: svc('csdm_services_where', { empty: ['life_cycle_stage'], unit: 'service records' }, { gated_by: [...LIFECYCLE_GATE, { rule: 'CSDM-026', reason: 'a service class sits entirely at the default lifecycle value — CSDM-026 reports it once, in place of one finding per record' }] }) },
  'CSDM-018': { a: 'record_predicate', also: ['configuration'], cand: ['cmdb_ci_service'], params: [],
    config: svc('csdm_services_where', { present: ['life_cycle_stage'], empty: ['life_cycle_stage_status'], unit: 'service records with a stage' }, { gated_by: LIFECYCLE_GATE }) },
  'CSDM-019': { a: 'configuration_inspection', also: ['configuration'], cand: ['cmdb_ci_service', 'life_cycle_control'], params: [],
    config: svc('csdm_lifecycle_combination', {}, { requires: [T('life_cycle_control', 'life_cycle_stage', 'life_cycle_stage_status', 'table', 'active')], gated_by: LIFECYCLE_GATE }) },
  'CSDM-020': { a: 'configuration_inspection', cand: ['cmdb_ci_service', 'life_cycle_mapping', 'life_cycle_control'], params: [],
    config: svc('csdm_lifecycle_vs_operational', {}, { requires: [T('life_cycle_mapping', 'table', 'legacy_field_name', 'legacy_field_value', 'life_cycle_control'), T('life_cycle_control', 'life_cycle_stage', 'life_cycle_stage_status')], gated_by: LIFECYCLE_GATE,
      partial: { kind: 'detection_gap', not_covered: 'The mapping is the platform\'s own life cycle mapping (life_cycle_mapping: operational_status value of the class or an ancestor → life_cycle_control, D-033). A value the mapping does not cover is not judged.' } }) },
  'CSDM-021': { a: 'cross_record_linkage', also: ['configuration'], cand: ['cmdb_ci_service', 'svc_ci_assoc', 'cmdb_rel_ci', 'cmdb_ci'], params: [],
    config: svc('csdm_operational_all_retired', { operational: choice('cmdb_ci', 'operational_status', 'Operational'), retired_install: choice('cmdb_ci', 'install_status', 'Retired'), retired_operational: choice('cmdb_ci', 'operational_status', 'Retired') },
      { requires: [T('svc_ci_assoc', 'service_id', 'ci_id'), REL, T('cmdb_ci', 'install_status', 'operational_status')], gated_by: LIFECYCLE_GATE,
        partial: { kind: 'false_positive_risk', not_covered: '"Operational" is the service\'s operational_status. A migration with new CIs not yet associated is counted.' } }) },
  'CSDM-022': { a: 'cross_record_linkage', also: ['configuration'], cand: ['cmdb_ci_service', 'incident', 'life_cycle_stage'], params: [],
    config: svc('csdm_stage_contradiction', { stage: 'Retired', check: 'open_incidents' }, { requires: [T('life_cycle_stage', 'name'), T('incident', 'business_service', 'active')], gated_by: LIFECYCLE_GATE,
      partial: { kind: 'false_positive_risk', not_covered: 'Incidents raised to complete the retirement are counted.' } }) },
  'CSDM-023': { a: 'cross_record_linkage', also: ['configuration'], cand: ['cmdb_ci_service', 'service_offering', 'service_offering_commitment', 'service_commitment', 'contract_sla'], params: [],
    config: svc('csdm_stage_contradiction', { stage: 'End of Life', check: 'active_sla' }, { requires: [T('life_cycle_stage', 'name'), T('service_offering_commitment', 'service_offering', 'service_commitment'), T('service_commitment', 'sla'), T('contract_sla', 'active')], gated_by: LIFECYCLE_GATE,
      partial: { kind: 'detection_gap', not_covered: 'Active SLA definitions reached through the service\'s offerings and their commitments are found; a definition covering the service through its conditions is not evaluated.' } }) },
  'CSDM-024': { a: 'temporal_correlation', also: ['configuration'], cand: ['cmdb_ci_service', 'svc_ci_assoc', 'cmdb_ci', 'incident'], params: [P('window', 'duration', 'days', 90, 'incident window')],
    config: svc('csdm_stage_contradiction', { stage: 'End of Life', check: 'live_cis_recent_incidents', operational: choice('cmdb_ci', 'operational_status', 'Operational'), window: win('window') },
      { requires: [T('life_cycle_stage', 'name'), T('svc_ci_assoc', 'service_id', 'ci_id'), REL, T('cmdb_ci', 'operational_status'), T('incident', 'business_service', 'sys_created_on')], gated_by: LIFECYCLE_GATE,
        partial: { kind: 'evidence_gap', not_covered: 'The finding is the ambiguity: detection is certain, remediation confidence is low — never bulk-apply. Both interpretations are for the reviewer.' } }) },
  'CSDM-025': { a: 'audit_history', also: ['configuration'], cand: ['sys_audit', 'cmdb_ci_service'], params: [P('min_age', 'duration', 'days', 365, 'age')],
    config: svcDated('csdm_fields_never_changed', { fields: ['life_cycle_stage', 'life_cycle_stage_status'], min_age: param('min_age') }, { requires: [T('sys_audit', 'documentkey', 'fieldname'), T('sys_dictionary', 'name', 'audit')],
      partial: { kind: 'detection_gap', not_covered: 'Field history is sys_audit; a service is judged only where its class table is audited (sys_dictionary audit=true) — elsewhere "no entry" would prove nothing (D-033).' } }) },
  'CSDM-026': { a: 'aggregate_distribution', also: ['configuration'], cand: ['cmdb_ci_service', 'sys_dictionary'], params: [P('share', 'percent', null, 90, 'share of a class at one value')],
    config: svc('csdm_default_lifecycle', { share: param('share') }, { requires: [T('sys_dictionary', 'name', 'element', 'default_value')], gated_by: LIFECYCLE_GATE,
      partial: { kind: 'false_positive_risk', not_covered: 'The default is the dictionary default of life_cycle_stage (empty when none is set). Whether any record has ever deviated is not read (no audit).' } }) },
  'CSDM-027': { a: 'temporal_correlation', cand: ['sys_audit', 'change_request'], deps: { related: ['ITSM-106'] }, params: [], config: undef(R.audit, 'the correlation window between a lifecycle change and its change record — not given') },
  'CSDM-028': { a: 'cross_record_linkage', also: ['configuration'], cand: ['cmdb_ci_service', 'life_cycle_stage'], params: [],
    config: svc('csdm_parent_child_lifecycle', { parent_stage: 'End of Life', child_stage: 'Operational' }, { requires: [T('life_cycle_stage', 'name')], gated_by: LIFECYCLE_GATE,
      partial: { kind: 'detection_gap', not_covered: 'ServiceNow publishes no parent-child lifecycle matrix (D-032): the one conflict judged is a parent at End of Life with a child still Operational, through the parent field. A staged, bottom-up retirement is counted.' } }) },
  'CSDM-029': { a: 'cross_record_linkage', also: ['configuration'], cand: ['cmdb_ci_service', 'incident', 'life_cycle_stage'], params: [],
    config: svc('csdm_stage_contradiction', { stage: PRE_OPERATIONAL, check: 'any_incidents', exclude_statuses: ['Pilot'] }, { requires: [T('life_cycle_stage', 'name'), T('life_cycle_stage_status', 'name'), T('incident', 'business_service')], gated_by: LIFECYCLE_GATE,
      partial: { kind: 'false_positive_risk', not_covered: 'The planning stages are ServiceNow\'s pre-operational stages for logical items (Ideation, Purchase, Inventory, Design, Deploy — CSDM 5, D-032); a service in Pilot is excluded (the guard: incidents raised during a pilot). Any incident on the service counts.' } }) },
  'CSDM-030': { a: 'reference_integrity', cand: ['cmdb_ci_service', 'life_cycle_stage'], params: [],
    config: { requires_tables: [T('cmdb_ci_service', 'name', 'life_cycle_stage'), T('life_cycle_stage', 'name')], table: 'cmdb_ci_service', scope: 'life_cycle_stageISNOTEMPTY', field: 'life_cycle_stage', target: 'life_cycle_stage', check: 'exists', report: ['missing'], evidence_fields: ['name', 'sys_class_name'], gated_by: LIFECYCLE_GATE,
      partial: { kind: 'evidence_gap', not_covered: 'Stage is a reference on the platform, so a "non-choice value" is a reference to no configured stage. The validation gap (Lane 2) is CSDM-031.' } } },
  'CSDM-031': { a: 'configuration_inspection', cand: ['sys_data_policy2', 'sys_ui_policy', 'sys_script'], params: [], config: undef('what counts as enforcement of the permitted combinations — a data policy, a UI policy, a dependent reference qualifier or a business rule — not stated; the platform\'s own dependency between stage and status is itself a qualifier') },
  'CSDM-032': { a: 'configuration_inspection', also: ['configuration'], cand: ['life_cycle_control', 'life_cycle_stage'], params: [],
    config: { engine: 'configuration', requires_tables: [T('life_cycle_control', 'life_cycle_stage', 'life_cycle_stage_status', 'active')], reader: 'table_rows', args: { table: 'life_cycle_control', fields: ['life_cycle_stage', 'life_cycle_stage_status'], query: 'active=true' },
      compare: { name: 'csdm_absent', args: { what: 'active lifecycle stage / status combinations (life_cycle_control)' } } } },

  /* ═══ Group 3 — Ownership ═══ */
  'CSDM-033': { a: 'record_predicate', also: ['configuration'], cand: ['cmdb_ci_service'], params: [],
    config: svc('csdm_services_where', { layers: ['business', 'technical', 'application'], empty: ['owned_by', 'managed_by'], unit: 'services' },
      { partial: { kind: 'false_positive_risk', not_covered: 'Business, technical and application services are judged (offerings are CSDM-041). Ownership held at the offering level is counted.' } }) },
  'CSDM-034': { a: 'reference_integrity', equivalent_of: 'CMDB-103', cand: ['cmdb_ci_service', 'sys_user'], params: [],
    note: 'Contained in CMDB-103 ("Owner is an inactive user", every CI including service records): evaluated and counted in CMDB, shown here as an equivalent so the service records are not charged twice.' },
  'CSDM-035': { a: 'reference_integrity', equivalent_of: 'CMDB-102', cand: ['cmdb_ci_service', 'sys_user_grmember'], params: [],
    note: 'Contained in CMDB-102 ("Support group has zero active members", every CI including service records): evaluated and counted in CMDB, shown here as an equivalent.' },
  'CSDM-036': { a: 'record_predicate', also: ['configuration'], cand: ['cmdb_ci_service'], params: [],
    config: svc('csdm_services_where', { layers: ['business'], empty: ['business_relation_manager'], unit: 'business services' },
      { partial: { kind: 'false_positive_risk', not_covered: 'An organisation that does not use the role is still charged: its use is not recorded.' } }) },
  'CSDM-037': { a: 'cross_record_linkage', also: ['configuration'], cand: ['cmdb_ci_business_app', 'cmdb_ci_service_auto', 'cmdb_rel_ci'], params: [],
    config: svc('csdm_app_ownership', {}, { requires: [T('cmdb_ci_business_app', 'name', 'owned_by', 'support_group'), REL],
      partial: { kind: 'false_positive_risk', not_covered: 'Divergence is a signal, not proof: deliberate separation of portfolio and operational ownership is counted.' } }) },
  'CSDM-038': { a: 'aggregate_distribution', also: ['configuration'], cand: ['cmdb_ci_service'], params: [P('max_share', 'percent', null, 20, 'share of services held by one owner')],
    config: svc('csdm_owner_share', { max_share: param('max_share') }, { partial: { kind: 'false_positive_risk', not_covered: 'The judgement is advisory: a genuinely centralised service management function is counted.' } }) },
  'CSDM-039': { a: 'audit_history', also: ['configuration'], cand: ['sys_audit', 'cmdb_ci_service'], params: [P('min_age', 'duration', 'days', 365, 'age')],
    config: svcDated('csdm_fields_never_changed', { fields: ['owned_by', 'managed_by'], min_age: param('min_age') }, { requires: [T('sys_audit', 'documentkey', 'fieldname'), T('sys_dictionary', 'name', 'audit')],
      partial: { kind: 'detection_gap', not_covered: 'Ownership never changed is judged from sys_audit on owned_by and managed_by, for audited class tables only; "despite organisational change" is not established.' } }) },
  'CSDM-040': { a: 'cross_record_linkage', cand: ['cmdb_ci_service', 'cmdb_ci_information_object'], params: [], config: undef(R.personal, R.dataOwner) },
  'CSDM-041': { a: 'cross_record_linkage', also: ['configuration'], cand: ['service_offering', 'cmdb_ci_service'], params: [],
    config: svc('csdm_offering_owner', {}, { gated_by: OFFERING_GATE, partial: { kind: 'false_positive_risk', not_covered: 'A documented rationale is not recorded on the platform: every divergence is counted.' } }) },
  'CSDM-042': { a: 'configuration_inspection', cand: ['cert_filter', 'cert_audit'], params: [], config: undef('the review period, and which attestation records cover service ownership (cert_filter / cert_audit attest any attribute) — not given') },

  /* ═══ Group 4 — Environment discipline (gated by CSDM-050) ═══ */
  'CSDM-043': { a: 'record_predicate', also: ['configuration'], cand: ['cmdb_ci_service_auto'], params: [],
    config: svc('csdm_services_where', { layers: ['application'], empty: ['used_for'], unit: 'application services' }, { gated_by: ENVIRONMENT_GATE,
      partial: { kind: 'false_positive_risk', not_covered: 'Environment expressed through a naming convention instead is not recognised.' } }) },
  'CSDM-044': { a: 'cross_record_linkage', also: ['configuration'], cand: ['cmdb_ci_service'], params: [],
    config: svc('csdm_mixed_environment', { production: PRODUCTION }, { gated_by: ENVIRONMENT_GATE,
      partial: { kind: 'detection_gap', not_covered: 'Children through the parent field are judged, with used_for set (records without it are CSDM-043). Deliberate combined modelling is counted.' } }) },
  'CSDM-045': { a: 'cross_record_linkage', also: ['configuration'], cand: ['contract_sla', 'cmdb_ci_service'], params: [],
    config: { ...SLA_READ, requires_tables: [T('contract_sla', 'name', 'start_condition', 'active'), SVC], compare: { name: 'csdm_sla_named_services', args: { mode: 'non_production', production: PRODUCTION } },
      gated_by: ENVIRONMENT_GATE,
      partial: { kind: 'detection_gap', not_covered: 'An SLA covers a service when its conditions name the service (business_service / cmdb_ci / service_offering = its sys_id, D-033); a service outside Production (used_for) named that way is charged.' } } },
  'CSDM-046': { a: 'cross_record_linkage', also: ['configuration'], cand: ['cmdb_ci_service', 'cmdb_rel_ci'], params: [],
    config: svc('csdm_business_nonprod_only', { production: PRODUCTION }, { requires: [REL], gated_by: ENVIRONMENT_GATE,
      partial: { kind: 'false_positive_risk', not_covered: 'Only business services whose related application services ALL have used_for set are judged; often the symptom of CSDM-043 rather than an architecture problem.' } }) },
  'CSDM-047': { a: 'cross_record_linkage', equivalent_of: 'CMDB-111', cand: ['cmdb_ci_service', 'cmdb_ci'], params: [],
    note: 'The same condition as CMDB-111 ("CI supporting production service but tagged non-production"): evaluated and counted in CMDB, shown here as an equivalent.' },
  'CSDM-048': { a: 'cross_record_linkage', also: ['configuration'], cand: ['cmdb_ci_service', 'svc_ci_assoc', 'cmdb_ci'], params: [],
    config: svc('csdm_nonprod_service_prod_cis', { production: PRODUCTION, ci_production: choice('cmdb_ci', 'environment', 'Production') }, { requires: [T('svc_ci_assoc', 'service_id', 'ci_id'), REL, T('cmdb_ci', 'environment')], gated_by: ENVIRONMENT_GATE,
      partial: { kind: 'detection_gap', not_covered: 'The mismatch judged is a non-production service on production CIs; the other direction is CSDM-047 (≡ CMDB-111), counted there. Service used_for and CI environment use different value sets, so only production against non-production is compared.' } }) },
  'CSDM-049': { a: 'configuration_inspection', cand: ['sys_report'], params: [], config: undef('which reports are "portfolio reports", and what counts as an environment filter in them') },
  'CSDM-050': { a: 'configuration_inspection', also: ['configuration'], cand: ['sys_choice'], params: [],
    config: { engine: 'configuration', requires_tables: [T('sys_choice', 'name', 'element', 'inactive')], reader: 'table_rows', args: { table: 'sys_choice', fields: ['value'], query: 'name=cmdb_ci_service^element=used_for^inactive=false' },
      compare: { name: 'csdm_absent', args: { what: 'environment values (cmdb_ci_service.used_for choice list)' } },
      partial: { kind: 'detection_gap', not_covered: 'The value set is judged; its enforcement is not ("or enforced" — what counts as enforcement is not stated).' } } },

  /* ═══ Group 5 — Relationship correctness ═══ */
  'CSDM-051': { a: 'relationship_graph', also: ['configuration'], cand: ['cmdb_rel_ci', 'cmdb_rel_type_suggest'], params: [],
    config: svc('csdm_suggested_relationships', { mode: 'types' }, { requires: [REL, SUGGEST, T('cmdb_ci', 'sys_class_name'), T('cmdb_ci_business_app', 'name'), T('cmdb_ci_business_capability', 'name'), T('cmdb_ci_information_object', 'name')],
      partial: { kind: 'detection_gap', not_covered: 'Relationships BETWEEN layers are judged (a service hierarchy inside one layer is not a layer pair). The permitted types are the instance\'s own suggested relationships (CI Class Manager, cmdb_rel_type_suggest, D-032), ancestors included; a class pair the list does not cover is not judged (the guard: type scoping not configured).' } }) },
  'CSDM-052': { a: 'relationship_graph', also: ['configuration'], cand: ['cmdb_rel_ci', 'cmdb_rel_type_suggest'], params: [],
    config: svc('csdm_suggested_relationships', { mode: 'direction' }, { requires: [REL, SUGGEST, T('cmdb_ci', 'sys_class_name'), T('cmdb_ci_business_app', 'name'), T('cmdb_ci_business_capability', 'name'), T('cmdb_ci_information_object', 'name')],
      partial: { kind: 'detection_gap', not_covered: 'The direction a class pair strongly indicates is the instance\'s own suggested relationships (cmdb_rel_type_suggest, parent / child, D-033); a pair suggested only the other way is reversed. A pair it does not cover is not judged.' } }) },
  'CSDM-053': { a: 'relationship_graph', equivalent_of: 'CMDB-113', cand: ['svc_ci_assoc', 'cmdb_rel_ci'], params: [],
    note: 'The same condition as CMDB-113 ("CI associated to service with no relationship path"): evaluated and counted in CMDB, shown here as an equivalent.' },
  'CSDM-054': { a: 'relationship_graph', equivalent_of: 'CMDB-114', cand: ['svc_ci_assoc', 'cmdb_rel_ci'], params: [],
    note: 'The same condition as CMDB-114 ("svc_ci_assoc and cmdb_rel_ci disagreeing", the symmetric difference per service): evaluated and counted in CMDB, shown here as an equivalent.' },
  'CSDM-055': { a: 'configuration_inspection', also: ['configuration'], cand: ['cmdb_rel_ci', 'cmdb_rel_type_suggest', 'cmdb_ci'], params: [],
    config: svc('csdm_suggested_relationships', { mode: 'containment' }, { requires: [REL, SUGGEST, T('cmdb_ci', 'sys_class_name'), T('cmdb_ci_business_app', 'name'), T('cmdb_ci_business_capability', 'name'), T('cmdb_ci_information_object', 'name')],
      partial: { kind: 'false_positive_risk', not_covered: 'The permitted containment set is the dependent classes the instance suggests for the application-service class (cmdb_rel_type_suggest, D-032 — "what would discovery do"). Application services whose class has no suggestion are not judged. Deliberate flattened modelling is counted.' } }) },
  'CSDM-056': { a: 'relationship_graph', also: ['configuration'], cand: ['cmdb_rel_ci', 'cmdb_ci_service'], params: [],
    config: svc('csdm_service_cycles', {}, { requires: [REL, T('cmdb_rel_type', 'parent_descriptor', 'child_descriptor')] }) },
  'CSDM-057': { a: 'relationship_graph', equivalent_of: 'CMDB-080', cand: ['cmdb_rel_ci', 'cmdb_ci'], params: [],
    note: 'Contained in CMDB-080 ("Retired CI still holding active relationships", every edge of a retired CI, service edges included): evaluated and counted in CMDB, shown here as an equivalent.' },
  'CSDM-058': { a: 'relationship_graph', also: ['configuration'], cand: ['cmdb_rel_ci', 'cmdb_ci_netgear', 'sys_properties'], deps: { related: ['ITOM-077'] }, params: [],
    config: svc('csdm_network_reach_platform_depth', { property: 'glide.relationship.max_depth', platform_default: 10 }, { requires: [REL, T('cmdb_ci', 'sys_class_name'), T('sys_properties', 'name', 'value')],
      partial: { kind: 'false_positive_risk', not_covered: 'The depth is the instance\'s own impact depth, glide.relationship.max_depth, or ServiceNow\'s default of 10 when it is not set (D-032). Downward traversal follows relationships from parent to child. Network modelled outside CSDM with another impact mechanism is counted.' } }) },
  'CSDM-059': { a: 'temporal_correlation', cand: ['cmdb_rel_ci'], params: [], config: undef('an edge\'s creation source and source confirmation — cmdb_rel_ci carries no discovery source or last-discovered field (verified, Phase 9)', 'the freshness window — not given') },
  'CSDM-060': { a: 'aggregate_distribution', also: ['configuration'], cand: ['cmdb_rel_ci'], params: [],
    config: svc('csdm_duplicate_edges', {}, { requires: [REL] }) },

  /* ═══ Group 6 — Offering and commitment structure (gated by CSDM-062) ═══ */
  'CSDM-061': { a: 'record_predicate', cand: ['service_offering'], params: [],
    config: { requires_tables: [T('service_offering', 'name', 'consumer_type')], table: 'service_offering', predicates: [{ field: 'consumer_type', op: 'empty' }], evidence_fields: ['name', 'parent'], report_ratio: true, gated_by: OFFERING_GATE,
      partial: { kind: 'detection_gap', not_covered: 'consumer_type is the consumer dimension; service_offering has no channel or audience field (verified, Phase 9). Single-channel services where differentiation is meaningless are counted.' } } },
  'CSDM-062': { a: 'configuration_inspection', also: ['configuration'], cand: ['service_offering', 'cmdb_ci_service'], params: [],
    config: svc('csdm_offering_layer', {}, { partial: { kind: 'detection_gap', not_covered: '"Zero or negligible": zero is judged; "negligible" is not defined. A deliberately simplified model (a lower target band) is counted.' } }) },
  'CSDM-063': { a: 'aggregate_distribution', cand: ['incident', 'service_offering'], params: [], config: undef('how an incident\'s channel or category maps to an offering — not given') },
  'CSDM-064': { a: 'aggregate_distribution', cand: ['service_commitment', 'service_offering'], params: [P('variance', 'number', null, null, 'target variance threshold — UNDEFINED')], config: undef('the commitment target variance threshold, and which commitment field is the target') },
  'CSDM-065': { a: 'cross_record_linkage', cand: ['service_offering', 'incident'], params: [], config: gap('what makes an offering "inactive" (operational_status, install_status or service_status all exist) and an incident "on that channel"') },
  'CSDM-066': { a: 'configuration_inspection', cand: ['service_offering'], params: [], config: undef('whether a chargeback model is in use — not recorded') },
  'CSDM-067': { a: 'cross_record_linkage', also: ['configuration'], cand: ['contract_sla', 'service_offering'], deps: { related: ['ITSM-137'] }, params: [],
    config: { ...SLA_READ, requires_tables: [T('contract_sla', 'name', 'start_condition', 'active'), SVC, T('service_offering', 'parent')], compare: { name: 'csdm_sla_named_services', args: { mode: 'with_offerings' } },
      gated_by: OFFERING_GATE } },

  /* ═══ Group 7 — Maturity and adoption ═══ */
  'CSDM-068': { a: 'relationship_graph', equivalent_of: 'CMDB-112', cand: ['cmdb_ci_business_capability', 'cmdb_rel_ci'], params: [],
    note: 'The same measure as CMDB-112 ("Percentage of principal CIs reachable from a Business Capability", the same traversal): evaluated and counted in CMDB, shown here as an equivalent.' },
  'CSDM-069': { a: 'aggregate_distribution', equivalent_of: 'ITSM-017', cand: ['incident'], params: [],
    note: 'The complement of ITSM-017 ("Percentage of incidents referencing a bare CI rather than a Business Service", over incidents with either reference): evaluated and counted in ITSM, shown here as an equivalent.' },
  'CSDM-070': { a: 'relationship_graph', cand: ['cmdb_ci_business_capability', 'cmdb_ci_business_app', 'cmdb_ci_service', 'cmdb_rel_ci'], params: [P('threshold', 'percent', null, null, 'complete-hierarchy share threshold — UNDEFINED')], config: pending('the traversal across every configured layer (capability → application → service → CI) per service, and the band threshold it is judged against') },
  'CSDM-071': { a: 'aggregate_distribution', equivalent_of: 'CSDM-004', cand: ['cmdb_ci_service', 'service_offering'], params: [],
    note: 'The ratio of CSDM-004 over the same business services (with at least one offering ÷ all): CSDM-004 reports it as its measure and is charged once.' },
  'CSDM-072': { a: 'composite', also: ['configuration'], cand: ['cmdb_ci_service', 'cmdb_ci_business_app', 'cmdb_ci_business_capability', 'cmdb_ci_information_object'], params: [],
    note: 'The weighted composite of Groups 1 to 6 is the module score, csdm-quality/2. This rule REPORTS the stage reached, by ServiceNow\'s staged approach (D-032): never scored.',
    config: svc('csdm_maturity_stage', { foundation: FOUNDATION }, { requires: [...FOUNDATION.map((t) => T(t, t === 'sys_user' ? 'user_name' : 'name')), T('cmdb_ci_business_app', 'name'), T('cmdb_ci_business_capability', 'name'), T('cmdb_ci_information_object', 'name')],
      partial: { kind: 'evidence_gap', not_covered: 'A stage is reached when its tables hold records and every earlier stage is reached — ServiceNow gives no percentage thresholds (CSDM 5). Contracts, business units and CMDB groups (also Foundation data) are not read. The number is csdm-quality/2.' } }) },
  'CSDM-073': { a: 'temporal_correlation', also: ['configuration'], cand: ['cmdb_ci_service'], params: [],
    config: svc('csdm_maturity_trend', { foundation: FOUNDATION }, { requires: [...FOUNDATION.map((t) => T(t, t === 'sys_user' ? 'user_name' : 'name')), T('cmdb_ci_business_app', 'name'), T('cmdb_ci_business_capability', 'name'), T('cmdb_ci_information_object', 'name')],
      partial: { kind: 'detection_gap', not_covered: 'The stage CSDM-072 reports (ServiceNow\'s staged approach), one reading per scan of this instance; a fall below the previous scan names the stages lost (D-037). Readings under a different rule configuration are never compared (the guard).' } }) },
  'CSDM-074': { a: 'aggregate_distribution', cand: ['cmdb_ci_service'], params: [], config: undef('"the conformance rule set" a new service must pass, and the creation window — not given') },

  /* ═══ Group 8 — Cross-domain (not scored: correlation) ═══ */
  'CSDM-075': { a: 'relationship_graph', also: ['configuration'], cand: ['cmdb_ci_service', 'cmdb_rel_ci'], deps: { related: ['ITOM-152'] }, params: [],
    config: svc('csdm_critical_impact_break', { critical: ['1 - most critical'] }, { requires: [REL, T('em_impact_graph', 'business_service'), T('service_offering', 'parent'), T('svc_ci_assoc', 'service_id', 'ci_id'), T('cmdb_ci', 'sys_class_name')],
      partial: { kind: 'detection_gap', not_covered: 'A Business Critical service (busines_criticality "1 - most critical", D-033) with no impact tree (em_impact_graph), walked down its model — offerings, relationships, mapped CIs, to depth 10 — to the layer where it ends (D-037). Where no impact tree exists at all, impact calculation is not in use and nothing is judged. A service deliberately outside the impact model (the guard) is charged.' } }) },
  'CSDM-076': { a: 'cross_record_linkage', equivalent_of: 'ITSM-136', cand: ['incident', 'cmdb_ci_service'], params: [],
    note: 'The same condition as ITSM-136 ("Service referenced in incidents but absent from the CSDM model"): evaluated and counted in ITSM, shown here as an equivalent.' },
  'CSDM-077': { a: 'reference_integrity', equivalent_of: 'CMDB-102', cand: ['cmdb_ci_service', 'sys_user_grmember'], params: [],
    note: 'The same records as CMDB-102 (support group resolving to zero active members, service records included): evaluated and counted in CMDB, shown here as an equivalent.' },
  'CSDM-078': { a: 'cross_record_linkage', also: ['configuration'], cand: ['cmdb_rel_ci', 'discovery_device_history'], deps: { related: ['ITOM-147', 'ITOM-151'] }, params: [],
    config: svc('csdm_traversal_vs_discovery', {}, { requires: [REL, T('service_offering', 'parent'), T('svc_ci_assoc', 'service_id', 'ci_id'), T('cmdb_ci', 'sys_class_name'), T('discovery_device_history', 'classified_as', 'issues', 'last_state')],
      partial: { kind: 'detection_gap', not_covered: 'Each service model walked to where it ends (as CSDM-075); models ending at the application tier are set against devices discovery could not classify, and models ending at CIs of a class against discovery failures on that class (discovery_device_history issues) (D-037). A tier deliberately excluded (the guard) is charged.' } }) },
  'CSDM-079': { a: 'cross_record_linkage', also: ['relationship_graph'], cand: ['change_request', 'cmdb_rel_ci'], deps: { related: ['ITSM-126', 'ITSM-131'] }, params: [],
    config: { engine: 'relationship_graph', requires_tables: [T('change_request', 'number', 'cmdb_ci', 'risk'), REL], table: 'change_request', scope: 'active=true^cmdb_ciISNOTEMPTY', ci_field: 'cmdb_ci', question: 'path_to_service', depth: 10,
      offend: { path: 'answer.found', op: 'equals', value: false }, evidence_fields: ['number', 'cmdb_ci', 'risk'],
      partial: { kind: 'detection_gap', not_covered: 'Active changes whose CI reaches no service within the platform\'s impact depth (10, D-033); the risk assigned is shown as evidence.' } } },
  'CSDM-080': { a: 'relationship_graph', cand: ['cmdb_ci_information_object', 'm2m_dictionary_dataclass'], params: [], config: undef(R.personal, R.dataOwner) },
};

export const PLACEHOLDERS = {};
