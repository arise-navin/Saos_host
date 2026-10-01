import { isComplete } from './rules.js';

/**
 * APPLICABILITY — is a product or capability in use on this instance?
 * Phase 2 of docs/HEALTH-ASSIST-APPROACH.md (§6); decision D-005.
 *
 * PURE and DETERMINISTIC. The tables this scan already read (estate + coverage)
 * in; one answer per module dimension out, WITH THE EVIDENCE. Nothing is read
 * from the instance here, and no probe reads a table outside the allow-list.
 *
 *   in_use       positive evidence: the capability's own records exist, or records
 *                elsewhere depend on it (a CI discovered by Discovery).
 *   not_in_use   RELIABLE negative evidence: every table that would show use was
 *                read COMPLETELY and is empty, or is not on the instance at all, and
 *                nothing elsewhere depends on it. The dimension leaves the
 *                denominator and the page says why. Absence is never a failure.
 *   unknown      a read failed or was partial, the evidence conflicts, or this build
 *                reads nothing that could tell. Neither excluded nor failed: counted
 *                as an assessment-coverage gap, with the reason.
 *
 * Conflicting evidence is NOT "not in use": no MID server while CIs carry
 * Discovery as their source means Discovery is in use and broken, and the
 * workbook rules then judge it.
 */

export const APPLICABILITY_VERSION = 'applicability/1';
export const APPLICABILITY_STATES = Object.freeze(['in_use', 'not_in_use', 'unknown']);

/* The platform's own discovery_source value for records Discovery creates or updates. */
const DISCOVERY_SOURCES = Object.freeze(['ServiceNow']);

function table(estate, coverage, t) {
  const c = coverage?.[t];
  return {
    table: t,
    status: c?.status ?? 'not_requested',
    complete: Boolean(c) && isComplete(coverage, t),
    unavailable: c?.status === 'unavailable',
    records: c?.records ?? (Array.isArray(estate?.[t]) ? estate[t].length : null),
  };
}
const hasRows = (e) => (e.records ?? 0) > 0;
const readEmpty = (e) => e.unavailable || (e.complete && e.records === 0);

function decide({ positive, negativeReliable, reasonIn, reasonOut, reasonUnknown, evidence, probe }) {
  if (positive) return { state: 'in_use', basis: reasonIn, probe, evidence };
  if (negativeReliable) return { state: 'not_in_use', basis: reasonOut, probe, evidence };
  return { state: 'unknown', basis: reasonUnknown, probe, evidence };
}

/* ── ITOM ─────────────────────────────────────────────────────────────── */

function discoveryDependents(estate, coverage) {
  const cis = table(estate, coverage, 'cmdb_ci');
  const rows = estate?.cmdb_ci || [];
  const fieldsRead = cis.complete && !(coverage?.cmdb_ci?.missing_fields || []).some((f) => ['last_discovered', 'discovery_source'].includes(f));
  const count = rows.filter((c) => String(c.last_discovered || '').trim() || DISCOVERY_SOURCES.includes(String(c.discovery_source || '').trim())).length;
  return { ...cis, fields_read: fieldsRead, discovered_cis: count };
}

function itomProbes(estate, coverage) {
  const status = table(estate, coverage, 'discovery_status');
  const schedule = table(estate, coverage, 'discovery_schedule');
  const devices = table(estate, coverage, 'discovery_device_history');
  const dependents = discoveryDependents(estate, coverage);
  const discovery = decide({
    probe: 'itom.discovery/1',
    evidence: { tables: [status, schedule, devices], dependents: { table: 'cmdb_ci', status: dependents.status, complete: dependents.complete, fields_read: dependents.fields_read, discovered_cis: dependents.discovered_cis } },
    positive: hasRows(status) || hasRows(schedule) || hasRows(devices) || dependents.discovered_cis > 0,
    negativeReliable: [status, schedule, devices].every(readEmpty) && dependents.fields_read && dependents.discovered_cis === 0,
    reasonIn: dependents.discovered_cis > 0 && ![status, schedule, devices].some(hasRows)
      ? `${dependents.discovered_cis} CI(s) carry Discovery evidence (last_discovered or discovery_source ServiceNow) though no run or schedule was found — in use, and its machinery is what the rules judge`
      : 'Discovery runs, schedules or device history exist',
    reasonOut: 'discovery_status, discovery_schedule and discovery_device_history were read completely and are empty (or absent), and no CI carries Discovery evidence',
    reasonUnknown: 'a Discovery table or cmdb_ci (last_discovered, discovery_source) was not read completely, so absence cannot be established',
  });

  const agents = table(estate, coverage, 'ecc_agent');
  const queue = table(estate, coverage, 'ecc_queue');
  const mid = decide({
    probe: 'itom.mid_server/1',
    evidence: { tables: [agents, queue], depends_on: { discovery: discovery.state } },
    positive: hasRows(agents) || hasRows(queue) || discovery.state === 'in_use',
    negativeReliable: readEmpty(agents) && readEmpty(queue) && discovery.state === 'not_in_use',
    reasonIn: hasRows(agents) ? 'MID server records exist' : hasRows(queue) ? 'ECC queue traffic exists' : 'Discovery is in use, and Discovery needs a MID server',
    reasonOut: 'ecc_agent and ecc_queue are empty (read completely) and Discovery is not in use',
    reasonUnknown: 'ecc_agent or ecc_queue was not read completely, or Discovery\'s own state is unknown',
  });

  const discovered = table(estate, coverage, 'cmdb_ci_service_discovered');
  const mapping = decide({
    probe: 'itom.service_mapping/1',
    evidence: { tables: [discovered] },
    positive: hasRows(discovered),
    negativeReliable: readEmpty(discovered),
    reasonIn: 'discovered application services exist',
    reasonOut: 'cmdb_ci_service_discovered is empty (read completely) or not on this instance',
    reasonUnknown: 'cmdb_ci_service_discovered was not read completely',
  });

  const alerts = table(estate, coverage, 'em_alert');
  const events = decide({
    probe: 'itom.event_management/1',
    evidence: { tables: [alerts] },
    positive: hasRows(alerts),
    negativeReliable: readEmpty(alerts),
    reasonIn: 'Event Management alerts exist',
    reasonOut: alerts.unavailable ? 'em_alert is not on this instance (Event Management is not installed)' : 'em_alert was read completely and is empty',
    reasonUnknown: 'em_alert was not read completely',
  });

  const cloud = {
    state: 'unknown', probe: 'itom.cloud/1', evidence: { tables: [] },
    basis: 'this build reads no cloud table (cloud service accounts, cloud resources): whether cloud discovery is in use cannot be established',
  };
  return {
    discovery, mid_server: mid, service_mapping: mapping, event_management: events, cloud,
    cross_domain: { state: 'in_use', probe: 'itom.cross_domain/1', evidence: {}, basis: 'correlation rules: not scored, applicable wherever their inputs are' },
  };
}

/* ── ITSM ─────────────────────────────────────────────────────────────── */

function itsmProbes(estate, coverage) {
  const one = (t, label) => {
    const e = table(estate, coverage, t);
    /* The ITSM read is a SLICE (open, or updated in the window): an empty slice
       does not show the process was never used, so it cannot be "not in use". */
    return decide({
      probe: `itsm.${t}/1`,
      evidence: { tables: [e], slice: coverage?.[t]?.filter ?? null },
      positive: hasRows(e),
      negativeReliable: e.unavailable,
      reasonIn: `${label} records in the open-or-recent slice`,
      reasonOut: `${t} is not on this instance`,
      reasonUnknown: e.complete ? `no open or recent ${label} records; the slice cannot show whether the process was ever used` : `${t} was not read completely`,
    });
  };
  const incident = one('incident', 'incident');
  const change = one('change_request', 'change');
  const problem = one('problem', 'problem');
  const used = [incident, change, problem].filter((x) => x.state === 'in_use').length;
  return {
    incident, change, problem,
    cross_process: {
      state: used >= 2 ? 'in_use' : 'unknown', probe: 'itsm.cross_process/1', evidence: { processes_in_use: used },
      basis: used >= 2 ? `${used} of the three processes are in use` : 'fewer than two processes show recent use',
    },
  };
}

/* ── CMDB and Platform ────────────────────────────────────────────────── */

function cmdbProbes(estate, coverage, dimensions) {
  const cis = table(estate, coverage, 'cmdb_ci');
  const d = decide({
    probe: 'cmdb.estate/1', evidence: { tables: [cis] },
    positive: hasRows(cis), negativeReliable: false,
    reasonIn: `the CMDB holds ${cis.records} CI(s)`, reasonOut: '',
    reasonUnknown: cis.complete ? 'cmdb_ci is empty' : 'cmdb_ci was not read completely',
  });
  return Object.fromEntries(dimensions.map((k) => [k, d]));
}

function platformProbes(dimensions) {
  const d = { state: 'in_use', probe: 'platform.core/1', evidence: {}, basis: 'a core platform capability present on every instance; declared, not probed, in this build' };
  return Object.fromEntries(dimensions.map((k) => [k, d]));
}

/* Phase 7: users, groups, locations, companies and the catalogue are core platform data on every instance. */
/* Phase 9: the service model's classes are part of every instance (the CSDM tables); an EMPTY layer is a finding (CSDM-001), not "not in use". */
/* Phase 10: the ITIL practices are judged by their rules; a product a practice needs that is not installed is each rule's own blocker, not the module's. */
function itilProbes(dimensions) {
  const d = { state: 'in_use', probe: 'itil.core/1', evidence: {}, basis: 'the ITIL practices are read from the platform\'s own records; a practice whose product is not installed shows as each rule\'s blocker (not applicable), not as the module\'s' };
  return { state: 'in_use', probe: 'itil.core/1', basis: d.basis, dimensions: Object.fromEntries(dimensions.map((k) => [k, { ...d }])) };
}

function csdmProbes(dimensions) {
  const d = { state: 'in_use', probe: 'csdm.core/1', evidence: {}, basis: 'the CSDM service classes are present on every instance; an empty layer is judged by the rules (CSDM-001, 062), not excluded; declared, not probed, in this build' };
  return Object.fromEntries(dimensions.map((k) => [k, d]));
}

function enterpriseDqProbes(dimensions) {
  const d = { state: 'in_use', probe: 'enterprise_dq.core/1', evidence: {}, basis: 'core reference data (users, groups, locations, companies) present on every instance; declared, not probed, in this build' };
  return Object.fromEntries(dimensions.map((k) => [k, d]));
}

/**
 * @param {object} args
 * @param {string[]} args.modules      the modules this scan read
 * @param {object}   args.estate       rows by table
 * @param {object}   args.coverage     coverage by table
 * @param {(m: string) => {key: string}[]} args.dimensions  a module's dimension keys (workbook profile)
 */
export function assessApplicability({ modules = [], estate = {}, coverage = {}, dimensions = () => [] }) {
  const out = {};
  for (const m of modules) {
    const dims = dimensions(m).map((d) => d.key);
    if (m === 'itom') out.itom = itomProbes(estate, coverage);
    else if (m === 'itsm') out.itsm = itsmProbes(estate, coverage);
    else if (m === 'cmdb') out.cmdb = cmdbProbes(estate, coverage, dims);
    else if (m === 'platform') out.platform = platformProbes(dims);
    else if (m === 'enterprise_dq') out.enterprise_dq = enterpriseDqProbes(dims);
    else if (m === 'csdm') out.csdm = csdmProbes(dims);
    else if (m === 'itil') out.itil = itilProbes(dims);
  }
  return { version: APPLICABILITY_VERSION, modules: out };
}

/** A dimension's state, or `unknown` when nothing was decided for it. */
export function dimensionState(applicability, module, dimension) {
  return applicability?.modules?.[module]?.[dimension]?.state ?? 'unknown';
}
