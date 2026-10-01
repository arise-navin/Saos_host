import { loadWorkbook, moduleDimensions } from './workbook.js';

/**
 * THE MODULE REGISTRY — Phase 1 of docs/HEALTH-ASSIST-APPROACH.md (§4.5).
 *
 * One definition per Health Assist module. Before this, a module was spread
 * over `SCOPES` (domains, tables, score kind), `RULE_PREFIXES` (routing),
 * `RULE_SCOPE` (overrides) and the workbook profiles. Now the routing data lives
 * here, `scopes.js` derives its constants from it, and the workbook-backed
 * profile (dimensions, weights, build coverage) is attached on request.
 *
 * `status`:
 *   scanned          a scan reads it and produces findings and a score today
 *   planned          the workbook defines it and nothing is built yet (none since Phase 7)
 *   awaiting_rules   the workbook sheet has no rules yet (none since Phase 9)
 * Only `scanned` modules are scan modules (MODULE_KEYS). A planned module is
 * listed, with its workbook profile, so the gap is visible rather than absent.
 *
 * Routing is unchanged by Phase 1: the scanned modules' domains, tables, rule
 * prefixes and overrides are exactly what scopes.js held, and a test compares
 * every derived constant (and the generated SQL filters) with a snapshot taken
 * before the move.
 */

export const MODULE_DEFINITIONS = Object.freeze([
  Object.freeze({
    key: 'cmdb',
    label: 'CMDB',
    description: 'Are the configuration records themselves right — owned, current, related and unique?',
    status: 'scanned',
    domains: Object.freeze(['CMDB', 'CMDB_GOVERNANCE', 'RELATIONSHIP', 'FRESHNESS', 'LIFECYCLE', 'ATTESTATION', 'OWNERSHIP', 'CSDM']),
    tables: Object.freeze(['cmdb_ci', 'cmdb_rel_ci', 'cmdb_ci_service', 'service_offering', 'cmdb_health_config', 'cmdb_health_metric',
      'cmdb_health_metric_pref', 'cmdb_class_info', 'cmdb_recommended_fields', 'cmdb_data_management_policy',
      'cmdb_policy_scheduled_job', 'sysauto_script', 'cmn_location', 'core_company', 'cmdb_identifier', 'cmdb_identifier_entry',
      'life_cycle_stage_status', 'svc_ci_assoc', 'change_request', 'life_cycle_mapping', 'life_cycle_control',
      'cmdb_reconciliation_definition', 'cmdb_datasource_attribute_value', 'reconcile_duplicate_task', 'duplicate_audit_result',
      'sys_object_source', 'cmdb_datasource_precedence', 'cmdb_datasource_last_update', 'cmdb_datasource_staleness',
      'cmdb_ire_output_aggregate_stats', 'cmdb_metadata_hosting', 'cmdb_metadata_containment', 'cmdb_rel_type',
      'discovery_schedule', 'discovery_device_history', 'discovery_range_item', 'alm_asset',
      'cert_audit', 'cert_audit_result', 'cert_filter', 'cert_follow_on_task', 'sys_archive', 'sys_archive_destroy', 'sys_user_grmember',
      'sys_table_rotation', 'cmdb_data_management_task']),
    /* `sys_audit` is deliberately ABSENT: it is opt-in (tables.js `optIn`). */
    scoreKind: 'records',
    rulePrefixes: Object.freeze(['CMDB-', 'REL-', 'CUSTOM-CMDB-']),
    /* Family labels that are not rule ids: the CSDM service rules log their table skips as `CSDM`.
       Phase 9: the three hard-coded CSDM checks keep routing to CMDB by exact id; the
       CSDM- prefix now belongs to the CSDM catalogue (CSDM-001 … CSDM-080). */
    ruleExact: Object.freeze(['CSDM', 'CSDM-OWNER', 'CSDM-LIFECYCLE', 'CSDM-OFFERING']),
    ruleOverrides: Object.freeze([]),
  }),
  Object.freeze({
    key: 'itom',
    label: 'ITOM',
    description: 'Is anything keeping the CMDB true — MID servers, Discovery, credentials, mapping, events?',
    status: 'scanned',
    domains: Object.freeze(['DISCOVERY', 'CREDENTIALS', 'MID_SERVER', 'SERVICE_MAPPING', 'EVENT_MANAGEMENT', 'AVAILABILITY', 'ITOM']),
    tables: Object.freeze(['ecc_agent', 'ecc_agent_capability', 'ecc_agent_issue', 'ecc_queue', 'discovery_status',
      'discovery_device_history', 'discovery_log', 'discovery_credentials', 'svc_ci_assoc',
      'cmdb_ci_service_discovered', 'em_alert', 'cmdb_ci_outage']),
    scoreKind: 'checks',
    /* `ITOM-` and domain ITOM: the 156-rule workbook catalogue (Health Assist Phase 5). */
    rulePrefixes: Object.freeze(['MID-', 'DISC-', 'CRED-', 'SM-', 'EVENT-', 'OUTAGE-', 'ITOM-', 'CUSTOM-ITOM-']),
    ruleExact: Object.freeze(['SM']),
    /* `PERF-ECC-AGE` was written under Performance, but a stuck ECC queue means a MID
       server is not collecting work — an ITOM fact. Overridden here so nothing stored
       changes meaning. */
    ruleOverrides: Object.freeze(['PERF-ECC-AGE']),
  }),
  Object.freeze({
    key: 'itsm',
    label: 'ITSM',
    description: 'Is the work running on top of the CMDB flowing — assigned, moving, linked and closed?',
    status: 'scanned',
    /* `ITSM` is the 139-rule catalogue's domain; the other three are the eleven hard-coded rules'. */
    domains: Object.freeze(['INCIDENT', 'CHANGE', 'PROBLEM', 'ITSM']),
    tables: Object.freeze(['incident', 'change_request', 'problem']),
    scoreKind: 'records',
    rulePrefixes: Object.freeze(['ITSM-', 'CUSTOM-ITSM-']),
    /* The eleven legacy rules log their table skips as rule `ITSM`. */
    ruleExact: Object.freeze(['ITSM']),
    ruleOverrides: Object.freeze([]),
  }),
  Object.freeze({
    key: 'platform',
    label: 'Platform',
    description: 'Business rules, integrations, scheduled jobs, upgrades and access hygiene.',
    status: 'scanned',
    domains: Object.freeze(['CUSTOMIZATION', 'INTEGRATION', 'PERFORMANCE', 'UPGRADE', 'SECURITY', 'PLATFORM']),
    tables: Object.freeze(['sys_script', 'sys_rest_message', 'sys_trigger', 'sysauto', 'sys_upgrade_history_log', 'sys_user_has_role']),
    scoreKind: 'none',
    /* Platform is the fallback: any rule no other module claims routes here. `PLT-` and domain PLATFORM: the 183-rule workbook catalogue (Health Assist Phase 6). */
    rulePrefixes: Object.freeze(['PLT-', 'CUSTOM-PLT-']),
    ruleExact: Object.freeze([]),
    ruleOverrides: Object.freeze([]),
  }),
  Object.freeze({
    key: 'enterprise_dq',
    label: 'Enterprise Data Quality',
    description: 'Is the reference data every process depends on right — users, groups, locations, companies, assets, catalogue, knowledge, personal data?',
    /* Health Assist Phase 7: the 56-rule catalogue (DQ-084 … DQ-139) on the shared engine. */
    status: 'scanned',
    domains: Object.freeze(['ENTERPRISE_DQ']),
    /* The pack reads its own tables, each verified first; nothing is added to the extraction. */
    tables: Object.freeze([]),
    scoreKind: 'catalogue',
    /* By exact id: DQ-001 … DQ-083 are the data-quality sheet's CMDB Quality rows, scored in CMDB. */
    /* D-038: the module's custom rules (CUSTOM-EDQ-NNN). */
    rulePrefixes: Object.freeze(['CUSTOM-EDQ-']),
    ruleExact: Object.freeze(Array.from({ length: 56 }, (_, i) => `DQ-${String(84 + i).padStart(3, '0')}`)),
    ruleOverrides: Object.freeze([]),
  }),
  Object.freeze({
    key: 'csdm',
    label: 'CSDM',
    description: 'Is the Common Service Data Model complete and connected — layers, lifecycle, ownership, environment, relationships, offerings?',
    /* Health Assist Phase 9: the 80-rule catalogue (CSDM-001 … CSDM-080) on the shared engine. */
    status: 'scanned',
    /* CSDM_MODEL, not CSDM: CMDB's three hard-coded CSDM checks keep the CSDM domain. */
    domains: Object.freeze(['CSDM_MODEL']),
    /* The pack reads its own tables, each verified first; nothing is added to the extraction. */
    tables: Object.freeze([]),
    scoreKind: 'catalogue',
    rulePrefixes: Object.freeze(['CSDM-', 'CUSTOM-CSDM-']),
    ruleExact: Object.freeze([]),
    ruleOverrides: Object.freeze([]),
  }),
  Object.freeze({
    key: 'itil',
    label: 'ITIL',
    description: 'Are the ITIL practices working on the platform — request, catalogue, knowledge, service level, release, testing, capacity, availability, continuity, supplier, service desk, portfolio, improvement?',
    /* Health Assist Phase 10: the 148-rule catalogue (ITIL-001 … ITIL-148) on the shared engine. */
    status: 'scanned',
    domains: Object.freeze(['ITIL_PRACTICE']),
    /* The pack reads its own tables, each verified first; nothing is added to the extraction. */
    tables: Object.freeze([]),
    scoreKind: 'catalogue',
    rulePrefixes: Object.freeze(['ITIL-', 'CUSTOM-ITIL-']),
    ruleExact: Object.freeze([]),
    ruleOverrides: Object.freeze([]),
  }),
]);

/** The modules a scan can read today, in routing order. */
export const SCANNED_MODULES = Object.freeze(MODULE_DEFINITIONS.filter((m) => m.status === 'scanned'));

export function moduleDefinition(key) {
  return MODULE_DEFINITIONS.find((m) => m.key === key) ?? null;
}

let workbookCache = null;

/**
 * For a scan: each code rule id's workbook identity, and the code rules recorded
 * for retirement. FAIL-SOFT: a scan must never fail because the workbook
 * transcription could not be read. It then gets an empty index and says why.
 *
 * Identity: a CMDB- or ITSM-sheet rule is itself. A data-quality CMDB-model row
 * whose `equivalent_of` is a code id with no CMDB-sheet row (CMDB-140 → DQ-003,
 * CMDB-141 → DQ-077) names that code rule's workbook identity.
 */
export function workbookIndex({ workbook = null } = {}) {
  try {
    const wb = workbook ?? (workbookCache ??= loadWorkbook());
    const identity = new Map();
    for (const [key, sheet] of Object.entries(wb.sheets)) {
      if (key === 'data-quality') continue;
      for (const r of sheet.rules) identity.set(r.id, { sheet: sheet.sheet, id: r.id });
    }
    /* Phase 7: the data-quality sheet's Enterprise Data Quality rows are rules of their own. */
    for (const r of wb.sheets['data-quality']?.rules || []) if (r.model === 'Enterprise Data Quality') identity.set(r.id, { sheet: wb.sheets['data-quality'].sheet, id: r.id });
    for (const [id, e] of Object.entries(wb.overlays['data-quality']?.rules || {})) {
      if (e.equivalent_of && !identity.has(e.equivalent_of)) identity.set(e.equivalent_of, { sheet: wb.sheets['data-quality'].sheet, id });
    }
    const retiring = new Set((wb.deviations?.implementation_only_rules || []).filter((d) => d.resolution === 'retire').map((d) => d.rule_id));
    /* The overlay entry behind a code rule: its own sheet's entry, or — for a code id
       that implements a data-quality row — that row's entry (Phase 2). */
    const sheetOf = Object.fromEntries(Object.entries(wb.sheets).map(([key, s]) => [s.sheet, key]));
    const overlay = (ruleId) => {
      const id = identity.get(ruleId);
      if (!id) return null;
      const entry = wb.overlays[sheetOf[id.sheet]]?.rules?.[id.id];
      return entry ? { ...entry, workbook_id: id.id } : null;
    };
    return {
      identity: (ruleId) => identity.get(ruleId) ?? null,
      overlay,
      dimensions: (moduleKey) => moduleDimensions(wb, moduleKey) ?? [],
      retiring,
      workbook_sha256: wb.source.workbook_sha256,
      error: null,
    };
  } catch (err) {
    return { identity: () => null, overlay: () => null, dimensions: () => [], retiring: new Set(), workbook_sha256: null, error: err.message };
  }
}
/**
 * Every module with its workbook-backed profile: dimensions (and whether their
 * weights come from the workbook or are undefined there), and build coverage —
 * how many of the workbook's rules for the module are implemented. Read lazily,
 * so importing this module costs nothing at boot.
 */
export function moduleRegistry({ workbook = null } = {}) {
  const wb = workbook ?? (workbookCache ??= loadWorkbook());
  return MODULE_DEFINITIONS.map((m) => {
    const profile = wb.profiles.modules.find((p) => p.key === m.key) ?? null;
    const rules = [];
    for (const [sheet, ov] of Object.entries(wb.overlays)) {
      for (const [id, e] of Object.entries(ov.rules)) if (e.module === m.key && !e.orphan) rules.push({ id, sheet, state: e.implementation?.state });
    }
    /* A data-quality CMDB-model row restates a CMDB-sheet rule; count each condition once. */
    const distinct = rules.filter((r) => !(m.key === 'cmdb' && r.sheet === 'data-quality' && wb.overlays['data-quality'].rules[r.id]?.equivalent_of
      && wb.overlays.cmdb.rules[wb.overlays['data-quality'].rules[r.id].equivalent_of]));
    return {
      key: m.key,
      label: m.label,
      description: m.description,
      status: m.status,
      score_kind: m.scoreKind,
      tables: m.tables,
      profile: profile ? {
        dimensions: moduleDimensions(wb, m.key) ?? [],
        weights_status: profile.weights_status ?? null,
        provisional_policy: profile.provisional_policy ?? null,
        sheets: profile.sheets,
      } : null,
      build: {
        workbook_rules: distinct.length,
        built: distinct.filter((r) => r.state === 'built').length,
        not_built: distinct.filter((r) => r.state !== 'built').length,
        basis: m.key === 'cmdb' ? 'CMDB-sheet rules plus data-quality CMDB-model rules with no CMDB-sheet equivalent (DQ-003, DQ-077)' : 'workbook rules assigned to this module',
      },
    };
  });
}
