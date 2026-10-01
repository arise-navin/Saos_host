export const SCRIPT_VALIDATION_STATUSES = Object.freeze([
  'VALIDATED',
  'PARTIALLY VALIDATED',
  'FIX REQUIRED',
  'BLOCKED',
]);

const rx = (text, re) => re.test(String(text ?? ''));

const MECHANISM = Object.freeze({
  UI_POLICY: 'UI Policy',
  DATA_POLICY: 'Data Policy',
  BEFORE_BR: 'Before Business Rule',
  AFTER_BR: 'After Business Rule',
  ASYNC_BR: 'Async Business Rule',
  DISPLAY_BR: 'Display Business Rule',
  CLIENT_SCRIPT: 'Client Script',
  SCRIPT_INCLUDE: 'Script Include',
  GLIDEAJAX: 'Client Script + GlideAjax + Script Include',
  REFERENCE_QUALIFIER: 'Reference Qualifier',
  DICTIONARY: 'Dictionary Configuration',
  ASSIGNMENT_RULE: 'Assignment Rule',
  ACL: 'ACL / Security Rule',
  CATALOG_UI_POLICY: 'Catalog UI Policy',
  CATALOG_CLIENT_SCRIPT: 'Catalog Client Script',
  SCHEDULED_SCRIPT: 'Scheduled Script Execution',
  BACKGROUND_SCRIPT: 'Background Script',
  FIX_SCRIPT: 'Fix Script',
  FLOW: 'Flow Designer',
});

export function serviceNowScriptArchitectureGuidance() {
  return [
    'ServiceNow script architecture rules:',
    '  1. Before creating Client Scripts, Script Includes, Business Rules, Scheduled Script Executions, Background Scripts or Fix Scripts: SCAN -> inspect complete configuration/code -> detect duplicates/conflicts -> REUSE -> FIX -> EXTEND -> CREATE.',
    '  2. Assignment Group / Assigned To browser behavior: do NOT clear assigned_to on every assignment_group change. If assigned_to is empty, do nothing. If assignment_group is cleared, clear assigned_to. If the assigned user belongs to the newly selected group, preserve assigned_to. If not, clear assigned_to and show immediate UI feedback. Preferred implementation: Incident onChange Client Script -> asynchronous GlideAjax -> client-callable Script Include extending AbstractAjaxProcessor -> query sys_user_grmember -> return a minimal boolean. Protect against stale async responses. Do not use client-side GlideRecord.',
    '  3. Cross-channel Assignment Group / Assigned To integrity is relational server-side validation, not a simple Data Policy. Prefer a Before Business Rule on Incident that runs when relevant assignment fields are populated/changed, queries sys_user_grmember, calls gs.addErrorMessage(), and current.setAbortAction(true). Do not call current.update(). If an existing Business Rule already enforces this, inspect and reuse/fix it.',
    '  4. Mechanism selection: Client Scripts are for immediate form behavior, not server-side integrity. UI Policies are for declarative form visibility, mandatory and read-only behavior. Data Policies are for supported declarative server-side field enforcement, not arbitrary GlideRecord-style relational lookup. Business Rules are for server-side validation/processing across UI, REST, integrations, scripts and other supported write paths; use Before rules for validation, pre-persist calculation and aborting invalid writes.',
    '  5. Scheduled Script Execution is for recurring batch processing. Do not claim fixed timeouts, independent transactions, specific indexes, or overlap behavior unless verified on the instance/platform. For large jobs, verify indexed queries where possible, estimate affected records, make processing idempotent, prevent duplicate output, batch/chunk when appropriate, log counts/failures and design safe retries. For stale Incident detection use the appropriate date field such as sys_updated_on according to the requirement. For generated escalation records, prefer both check-before-create and a unique business key/constraint where appropriate.',
    '  6. Background Scripts are for investigation, troubleshooting, one-time administrative execution and controlled inspection/correction. For investigations, default to READ ONLY: query first, show affected count and representative records, and do not mutate unless explicitly approved. Say "No database mutation is performed; the script is read-only." Do not describe read-only execution as "no transaction."',
    '  7. Fix Scripts are for controlled one-time application/deployment remediation. Exactly-once safety must not depend solely on run_once. Production Fix Scripts must be logically idempotent: check before create/update, process only records requiring correction, skip already-correct records, track counts, validate references, tolerate reruns and detect previously processed data where appropriate. Support DRY RUN -> COUNT -> EXECUTE -> READ-BACK / POST-VALIDATION.',
    '  8. Separate VERIFIED INSTANCE FACT from SERVICENOW DESIGN ASSUMPTION from RECOMMENDATION. If behavior is not verified from the instance/tool output, validated project knowledge or included authoritative docs, say REQUIRES VERIFICATION.',
    '  9. Validation statuses are VALIDATED, PARTIALLY VALIDATED, FIX REQUIRED and BLOCKED. A successful create/update API call alone is not VALIDATED. VALIDATED requires, where tooling permits, persisted read-back, configuration comparison, dependency/conflict scan and functional execution validation. If browser behavior cannot be executed, report CLIENT-SIDE STATUS = PARTIALLY VALIDATED. If scheduled execution cannot be observed, report SCHEDULED EXECUTION STATUS = PARTIALLY VALIDATED.',
  ].join('\n');
}

export function analyzeIntent(requirement) {
  const text = String(requirement ?? '').toLowerCase();
  const assignmentPair = rx(text, /\bassignment[_\s-]?group\b/) && rx(text, /\bassigned[_\s-]?to\b|\bassigned\s+user\b|\bassignee\b/);
  const allWritePaths = rx(text, /\b(rest|api|imports?|integration|background update|server-side enforcement|all write paths|data integrity|abort transaction|across ui|across .*ui.*api|prevent invalid save|api\/ui|ui\/api)\b/);
  const negatesRelationalLookup = rx(text, /\b(no|without)\s+(?:relational|cross-table|server)?\s*lookup\b/);
  const relationalLookup = !negatesRelationalLookup && (assignmentPair || rx(text, /\b(member(?:ship)?|belongs to|active child tasks?|related .*exist|cross-table|lookup against|sys_user_grmember|category\/subcategory|invalid .*relation)\b/));
  const immediateUx = rx(text, /\b(immediate|onchange|on change|browser|form feedback|user-triggered|clicks?|when .*changes?|list edit|list-edit|client)\b/) || (assignmentPair && rx(text, /\bform\b/));
  const catalogContext = rx(text, /\b(catalog|catalog item|variable|variables|record producer|order guide|item_option_new)\b/);
  const declarativeForm = rx(text, /\b(show|hide|visible|visibility|not visible|mandatory (?:on )?(?:the )?form|required (?:on )?(?:the )?form|read-only (?:on )?(?:the )?form|readonly (?:on )?(?:the )?form|field presentation|condition-driven)\b/);
  const mandatoryOrReadonly = rx(text, /\b(mandatory|required|must be populated|read-only|readonly)\b/);
  const simpleFieldPolicy = mandatoryOrReadonly && !relationalLookup
    && (!rx(text, /\b(complex|script|gliderecord|lookup|member|child tasks?)\b/) || negatesRelationalLookup);
  const beforeTiming = rx(text, /\b(before insert|before update|before save|before persistence|before .*persist|populate .* before|normaliz(?:e|ation)|abort|prevent|validate|validation)\b/);
  const afterTiming = rx(text, /\b(after insert|after update|after .*created|after .*creation|after .*save|post-write|after persistence|related .*record|referencing the .*incident|parent record must already exist|sys_id is required|create .*records?|create .*audit|create .*child)\b/);
  const asyncTiming = rx(text, /\b(async|asynchronous|non-blocking|without delaying|later|must not wait|after transaction|slow|does not depend|external system|webhook|enrichment|non-critical)\b/);
  const displayTiming = rx(text, /\b(display|on load|form load|before form rendering|g_scratchpad|scratchpad|provide server.*data.*client|server-computed .* client)\b/);
  const scheduled = rx(text, /\b(nightly|recurring|scheduled|stale incident|batch|daily|weekly|monthly|rerun)\b/);
  const notDeployment = rx(text, /\bnot part of (?:an? )?(?:app )?deployment|not .*deployment\b/);
  const deployment = !notDeployment && rx(text, /\b(fix script|upgrade|install|deployment|deployed|migration|legacy-data|next app upgrade)\b/);
  const adhoc = rx(text, /\b(one-time|admin-driven|background script|production cleanup|investigation|troubleshooting|inspect|ad-hoc|adhoc|large-volume|bulk|once|resumably)\b/);
  const destructive = rx(text, /\b(delete|destructive|remove|purge|cleanup|correction|correct|remediation|fix data|update legacy)\b/) && !rx(text, /\bread-only\b/);
  const workflowOrchestration = rx(text, /\b(approval|approvals|manager then finance|multi-step|waits?|workflow|orchestrat|notification|integration|long-running)\b/) && !adhoc;
  const existingArtifactConflict = rx(text, /\b(existing|already|already exists|duplicate logic|competing|conflict|overlap|overlapping|baseline|ootb|out-of-box|oob)\b/);
  const idempotencyRequired = rx(text, /\b(retr(?:y|ies)|repeated|duplicate creation|duplicate|exactly once|same threshold window|import retry|scheduled rerun|safe rerun|idempotent|large-volume|bulk|100000)\b/) || scheduled || deployment;
  const browserUnavailable = rx(text, /\b(browser .*unavailable|browser .*cannot|no browser|browser behavior.*cannot|browser.*not.*executed)\b/);
  const scheduledUnavailable = rx(text, /\b(scheduler .*unavailable|scheduled execution.*cannot|no actual scheduled|runtime cannot be executed|scheduler runtime cannot)\b/);
  const securityBoundary = rx(text, /\b(acl|access control|only .*role|only .*admin|non-admins?|permission|security|api access|rest access|block .*from (?:read|write|writing|update|updating|see|seeing))\b/);
  const referenceQualifier = rx(text, /\b(reference qualifier|filter .*reference|limit .*choices|restrict .*choices|available .*choices|choices? to|before .*picks?|before .*selects?)\b/);
  const assignmentRouting = rx(text, /\b(assignment rule|route .*assignment|route .*assignment group|route .*incidents? to .*assignment group|set assignment group based on|category routing)\b/);
  const dictionaryConfiguration = rx(text, /\b(dictionary|choice value|field type|max length|string field|create .*field|add .*field|new .*field|dictionary default)\b/);
  const schemaMissing = rx(text, /\b(non[_\s-]?existent|does not exist|not present|missing field|missing table|unknown field|unknown table)\b/) && !dictionaryConfiguration;
  const vagueUnsafeMutation = rx(text, /\bfix .*bad records.*somehow|clean .*somehow|update .*somehow\b/);
  const portalException = rx(text, /\bexcept (?:in )?(?:service )?portal|not in (?:service )?portal\b/);
  const pureClientCalculation = rx(text, /\b(as .*types|user types|calculate .*on the form|without server data|client-side calculation)\b/);
  const userTriggeredServerLookup = rx(text, /\b(clicks?|button|fetch .*from the server|query the server|server-side data|matching .*contract|server data|assignment validation)\b/) && immediateUx && !displayTiming;
  const reusableServerHelper = rx(text, /\b(reusable server-side|shared by several business rules|shared .*business rules|common server helper)\b/);

  const serverIntegrity = allWritePaths
    || (rx(text, /\b(prevent|abort|server-side|data integrity|invalid save)\b/) && (relationalLookup || !declarativeForm))
    || (rx(text, /\b(validate|validation)\b/) && !immediateUx && (relationalLookup || !declarativeForm));
  return {
    channel: serverIntegrity && immediateUx ? 'both' : (serverIntegrity ? 'server' : (immediateUx || declarativeForm || catalogContext ? 'client' : 'server')),
    enforcement: serverIntegrity ? 'all_write_paths' : (declarativeForm ? 'ui_only' : 'none'),
    timing: scheduled ? 'scheduled' : deployment ? 'deployment' : displayTiming ? 'display' : asyncTiming ? 'async' : afterTiming ? 'after' : beforeTiming ? 'before' : adhoc ? 'adhoc' : 'none',
    recurrence: scheduled ? 'recurring' : (adhoc || deployment ? 'once' : 'none'),
    destructive,
    relationalLookup,
    immediateUx,
    requiresExistingRecordSysId: afterTiming,
    workflowOrchestration,
    catalogContext,
    existingArtifactConflict,
    idempotencyRequired,
    serverIntegrity,
    assignmentPair,
    allWritePaths,
    declarativeForm,
    simpleFieldPolicy,
    mandatoryOrReadonly,
    browserUnavailable,
    scheduledUnavailable,
    securityBoundary,
    referenceQualifier,
    assignmentRouting,
    dictionaryConfiguration,
    schemaMissing,
    vagueUnsafeMutation,
    portalException,
    pureClientCalculation,
    userTriggeredServerLookup,
    reusableServerHelper,
    text,
  };
}

function baseDecision(requirement, intent) {
  return {
    requirement: String(requirement ?? ''),
    intent,
    primaryAction: intent.existingArtifactConflict ? 'reuse_or_fix_existing' : 'select_mechanism',
    existingArtifactPolicy: ['SCAN', 'INSPECT', 'DETECT_DUPLICATES_OR_CONFLICTS', 'REUSE', 'FIX', 'EXTEND', 'CREATE'],
    factLabels: ['VERIFIED INSTANCE FACT', 'SERVICENOW DESIGN ASSUMPTION', 'RECOMMENDATION'],
    validationStatuses: SCRIPT_VALIDATION_STATUSES,
    unverifiedBehavior: 'REQUIRES VERIFICATION',
    expected: [],
    mustNot: [],
    architecturalProperties: [],
    secondaryMechanisms: [],
    status: 'PARTIALLY VALIDATED',
    decisionState: 'SELECTED',
    validation: {},
  };
}

function setMechanism(decision, mechanism, expected = [mechanism], caseName = null) {
  decision.primaryMechanism = mechanism;
  decision.selectedMechanism = mechanism;
  decision.expected = expected;
  decision.case = caseName || mechanism.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function addIdempotency(decision) {
  decision.architecturalProperties.push('idempotency', 'check-before-create/update', 'safe retry behavior', 'unique business key/constraint where appropriate');
  decision.architecturalProperties.idempotencyRequired = true;
}

function addValidationState(decision) {
  if (decision.intent.browserUnavailable || [MECHANISM.UI_POLICY, MECHANISM.CLIENT_SCRIPT, MECHANISM.GLIDEAJAX, MECHANISM.CATALOG_UI_POLICY, MECHANISM.CATALOG_CLIENT_SCRIPT].includes(decision.primaryMechanism)) {
    decision.validation.clientSideStatus = 'PARTIALLY VALIDATED';
  }
  if (decision.intent.scheduledUnavailable || decision.primaryMechanism === MECHANISM.SCHEDULED_SCRIPT) {
    decision.validation.scheduledExecutionStatus = 'PARTIALLY VALIDATED';
  }
}

export function selectServiceNowScriptArchitecture(requirement) {
  const intent = analyzeIntent(requirement);
  const decision = baseDecision(requirement, intent);

  if (intent.existingArtifactConflict) decision.architecturalDirective = 'SCAN -> REUSE -> FIX -> EXTEND -> CREATE';

  if (intent.schemaMissing || intent.vagueUnsafeMutation) {
    decision.primaryAction = 'clarify_requirements';
    decision.decisionState = 'NEEDS REQUIREMENT CLARIFICATION';
    decision.case = intent.schemaMissing ? 'schema_requires_verification' : 'unsafe_mutation_requires_clarification';
    decision.expected = ['verify table/field schema and exact mutation criteria before selecting or generating implementation'];
    decision.mustNot.push('invent missing fields or tables', 'mutate production data from an ambiguous request');
  } else if (intent.timing === 'scheduled') {
    setMechanism(decision, MECHANISM.SCHEDULED_SCRIPT, ['Scheduled Script Execution', 'idempotent processing', 'duplicate-output protection', 'logged counts and failures', 'safe retry behavior'], 'scheduled_script_execution');
    decision.mustVerify = ['timeout behavior', 'transaction boundaries', 'indexes', 'overlap behavior'];
    decision.mustNot.push('claim a fixed timeout without evidence', 'assume every insert is an independent transaction', 'assume indexes exist', 'assume overlap behavior');
    if (rx(intent.text, /\bstale incident\b|\bstale incidents\b/)) decision.dateFieldGuidance = 'Use sys_updated_on when it matches the actual stale-record requirement.';
    addIdempotency(decision);
  } else if (intent.timing === 'deployment') {
    setMechanism(decision, MECHANISM.FIX_SCRIPT, ['Fix Script', 'DRY RUN', 'COUNT', 'EXECUTE', 'READ-BACK / POST-VALIDATION', 'logical idempotency'], 'idempotent_fix_script');
    decision.mustNot.push('rely solely on run_once metadata for safety', 'assume platform fields or execution semantics without verification');
    addIdempotency(decision);
  } else if (intent.timing === 'adhoc' || (intent.destructive && rx(intent.text, /\bone-time|production cleanup|admin\b/))) {
    setMechanism(decision, MECHANISM.BACKGROUND_SCRIPT, ['Background Script or equivalent read-only server script', 'Background Script', 'explicit approval before mutation', 'query/count first', 'representative records'], intent.destructive ? 'background_script_destructive_remediation' : 'background_script_read_only');
    decision.mutationAllowed = intent.destructive ? 'explicit approval required' : false;
    decision.requiredWording = intent.destructive ? 'Destructive Background Scripts require explicit approval.' : 'No database mutation is performed; the script is read-only.';
    decision.mustNot.push('mutate without explicit approval', 'describe read-only execution as no transaction');
    if (intent.destructive) addIdempotency(decision);
  } else if (intent.securityBoundary) {
    setMechanism(decision, MECHANISM.ACL, ['ACL / Security Rule', 'role/operation security enforcement across supported access paths'], 'acl_security_rule');
    decision.mustNot.push('rely on UI-only hiding for a security boundary');
  } else if (intent.assignmentRouting) {
    setMechanism(decision, MECHANISM.ASSIGNMENT_RULE, ['Assignment Rule', 'assignment routing based on record conditions'], 'assignment_rule');
  } else if (intent.referenceQualifier) {
    setMechanism(decision, MECHANISM.REFERENCE_QUALIFIER, ['Reference Qualifier', 'filter selectable reference choices'], 'reference_qualifier');
    if (intent.serverIntegrity || intent.relationalLookup) decision.secondaryMechanisms.push(MECHANISM.BEFORE_BR);
  } else if (intent.dictionaryConfiguration) {
    setMechanism(decision, MECHANISM.DICTIONARY, ['Dictionary Configuration', 'field/choice/default metadata configuration'], 'dictionary_configuration');
  } else if (intent.reusableServerHelper) {
    setMechanism(decision, MECHANISM.SCRIPT_INCLUDE, ['Script Include', 'reusable server-side helper logic'], 'script_include');
  } else if (intent.catalogContext && intent.declarativeForm && !rx(intent.text, /\bcomplex|script|validation before submit|interactive validation\b/)) {
    setMechanism(decision, MECHANISM.CATALOG_UI_POLICY, ['Catalog UI Policy', 'declarative catalog variable visibility/mandatory/read-only behavior'], 'catalog_ui_policy');
  } else if (intent.catalogContext && rx(intent.text, /\bcomplex|script|validation before submit|interactive validation|before submit\b/)) {
    setMechanism(decision, MECHANISM.CATALOG_CLIENT_SCRIPT, ['Catalog Client Script', 'complex interactive catalog validation'], 'catalog_client_script');
    if (rx(intent.text, /\bserver|license|lookup|query\b/)) decision.secondaryMechanisms.push(MECHANISM.GLIDEAJAX);
    decision.mustNot.push('use normal table Client Script as the default for catalog variable behavior');
  } else if (intent.timing === 'display') {
    setMechanism(decision, MECHANISM.DISPLAY_BR, ['Display Business Rule', 'g_scratchpad'], 'display_business_rule');
    decision.secondaryMechanisms.push(MECHANISM.GLIDEAJAX);
  } else if (intent.timing === 'async') {
    setMechanism(decision, MECHANISM.ASYNC_BR, ['Async Business Rule', 'non-blocking post-transaction processing'], 'async_business_rule');
    decision.mustNot.push('use Async Business Rule when the immediate transactional result is required');
    if (intent.requiresExistingRecordSysId) decision.secondaryMechanisms.push(MECHANISM.AFTER_BR);
  } else if (intent.workflowOrchestration && !intent.serverIntegrity && !intent.relationalLookup && !intent.destructive) {
    setMechanism(decision, MECHANISM.FLOW, ['Flow Designer', 'business-process orchestration', 'approvals/waits/notifications/integrations'], 'flow_designer_orchestration');
    decision.secondaryMechanisms.push(MECHANISM.BEFORE_BR);
  } else if (intent.timing === 'after') {
    setMechanism(decision, MECHANISM.AFTER_BR, ['After Business Rule', 'parent sys_id is available', 'related local record work after persistence'], 'after_business_rule');
    if (intent.idempotencyRequired || rx(intent.text, /\bcreate\b/)) addIdempotency(decision);
  } else if (intent.allWritePaths && intent.simpleFieldPolicy) {
    setMechanism(decision, MECHANISM.DATA_POLICY, ['Data Policy', 'supported declarative server-side field enforcement'], 'data_policy');
    decision.secondaryMechanisms.push(MECHANISM.UI_POLICY);
    decision.mustNot.push('use Data Policy for arbitrary cross-table lookup or GlideRecord-style relational validation');
  } else if (intent.immediateUx && intent.relationalLookup && !intent.serverIntegrity) {
    setMechanism(decision, MECHANISM.GLIDEAJAX, ['Incident onChange Client Script', 'asynchronous GlideAjax', 'client-callable Script Include', 'sys_user_grmember boolean membership lookup'], 'assignment_group_assigned_to_client_behavior');
    decision.behavior = [
      'If assigned_to is empty, do nothing.',
      'If assignment_group is cleared, clear assigned_to.',
      'If assigned user belongs to the new group, preserve assigned_to.',
      'If assigned user does not belong to the new group, clear assigned_to and show immediate UI feedback.',
      'Ignore stale async responses when the user changes the group again before the GlideAjax answer returns.',
    ];
    decision.mustNot.push('unconditionally clear assigned_to', 'use client-side GlideRecord', 'treat Client Script as server-side integrity');
  } else if (intent.userTriggeredServerLookup) {
    setMechanism(decision, MECHANISM.GLIDEAJAX, ['Client Script', 'asynchronous GlideAjax', 'client-callable Script Include', 'minimal server result'], 'user_triggered_glideajax_lookup');
    decision.mustNot.push('use client-side GlideRecord');
  } else if (intent.serverIntegrity || intent.relationalLookup || intent.timing === 'before') {
    const expected = intent.assignmentPair
      ? ['Before Business Rule on Incident', 'sys_user_grmember membership lookup', 'gs.addErrorMessage()', 'current.setAbortAction(true)']
      : ['Before Business Rule', 'server-side validation/calculation before persistence', 'abort invalid writes when needed'];
    setMechanism(decision, MECHANISM.BEFORE_BR, expected, intent.assignmentPair ? 'assignment_group_assigned_to_server_validation' : 'before_business_rule');
    decision.mustNot.push('claim a simple Data Policy can perform arbitrary membership lookup', 'call current.update()', 'create competing validation without inspecting existing Business Rules');
    if (intent.immediateUx || intent.assignmentPair) decision.secondaryMechanisms.push(MECHANISM.GLIDEAJAX);
  } else if (intent.declarativeForm) {
    setMechanism(decision, MECHANISM.UI_POLICY, ['UI Policy', 'declarative form visibility/mandatory/read-only behavior'], 'ui_policy');
    decision.mustNot.push('choose Client Script unless scripting is actually required');
  } else if (intent.pureClientCalculation || intent.immediateUx) {
    setMechanism(decision, MECHANISM.CLIENT_SCRIPT, ['Client Script', 'immediate client-side form behavior'], 'client_script');
  } else {
    setMechanism(decision, MECHANISM.BEFORE_BR, ['Before Business Rule', 'REQUIRES VERIFICATION: no narrower deterministic architecture matched'], 'requires_verification_before_business_rule');
    decision.status = 'FIX REQUIRED';
  }

  if (intent.allWritePaths && decision.primaryMechanism === MECHANISM.UI_POLICY) {
    setMechanism(decision, MECHANISM.DATA_POLICY, ['Data Policy', 'supported declarative server-side field enforcement'], 'data_policy');
    decision.secondaryMechanisms.push(MECHANISM.UI_POLICY);
  }
  if (intent.idempotencyRequired) addIdempotency(decision);
  if (intent.destructive) decision.architecturalProperties.explicitApprovalRequired = true;
  if (intent.portalException) {
    decision.decisionState = 'PARTIAL ARCHITECTURE';
    decision.validation.portalExceptionStatus = 'REQUIRES VERIFICATION';
    decision.mustVerify = [...new Set([...(decision.mustVerify || []), 'Service Portal exclusion behavior for the selected policy/mechanism'])];
  }
  if (intent.workflowOrchestration && decision.primaryMechanism !== MECHANISM.FLOW && !decision.secondaryMechanisms.includes(MECHANISM.FLOW)) {
    decision.secondaryMechanisms.push(MECHANISM.FLOW);
  }
  if ((intent.immediateUx || intent.assignmentPair) && decision.primaryMechanism === MECHANISM.BEFORE_BR && !decision.secondaryMechanisms.includes(MECHANISM.GLIDEAJAX)) {
    decision.secondaryMechanisms.push(MECHANISM.GLIDEAJAX);
  }
  decision.architecturalProperties = [...new Set(decision.architecturalProperties)];
  if (decision.architecturalProperties.includes('idempotency')) decision.architecturalProperties.idempotencyRequired = true;
  if (intent.destructive) decision.architecturalProperties.explicitApprovalRequired = true;
  decision.secondaryMechanisms = [...new Set(decision.secondaryMechanisms.filter((m) => m !== decision.primaryMechanism))];
  addValidationState(decision);
  return decision;
}
