/**
 * The workbook-vs-implementation audit, as a pure function over files.
 *
 * `buildAudit()` returns:
 *   deviations     every place the code differs from the master workbook, with its
 *                  resolution and the decision behind it (docs/HEALTH-ASSIST-APPROACH.md §3.3)
 *   statusExport   per workbook rule, the Implementation / Validation status the code
 *                  can PROVE, ready to paste into the workbook's tracking columns (§3.2)
 *
 * The CLI (scripts/health-workbook-audit.mjs) writes both. The test suite runs the
 * same function and compares against the committed files, so the register cannot
 * silently go stale while the code or the workbook moves.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SERVER = path.resolve(HERE, '../..');
const HEALTH = path.join(SERVER, 'src/health');
const WB = path.join(HEALTH, 'rules/workbook');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

/* Workbook cells carry Markdown escapes ("used\_for"); the code carries the plain text. */
export const normaliseText = (s) => String(s ?? '').replace(/\\_/g, '_').replace(/\s+/g, ' ').trim();

/* Workbook snake_case field → catalogue/cmdb.json camelCase field. */
const CMDB_FIELDS = Object.freeze({
  rule: 'title',
  what_it_means: 'whatItMeans',
  why_it_matters: 'whyItMatters',
  source_tables_fields: 'sourceTables',
  detection_logic: 'detectionLogic',
  threshold_parameter: 'threshold',
  confidence_basis: 'confidenceBasis',
  evidence_to_show: 'evidenceToShow',
  false_positive_guard: 'falsePositiveGuard',
  remediation_lane: 'remediationLane',
  cross_domain_link: 'crossDomainLink',
});
const SEVERITY_TO_BAND = Object.freeze({ Systemic: 'SYSTEMIC', Critical: 'CRITICAL', High: 'HIGH', Moderate: 'MEDIUM', Low: 'LOW' });

/*
 * Why a CMDB text difference exists, so its resolution follows from the cause.
 * `platform_correction`: the workbook names a table or field the platform does
 * not have, and the code reads what verification on a real instance found. That
 * is a correction to ratify INTO the workbook, not a code defect.
 */
function classifyCmdbDifference(field, workbook, code) {
  /* D-017: kept and proposed for ratification — retiring them would blind 14 rules on estates with no principal classes. */
  if (/Fallback \(v3\)/.test(code)) return { cause: 'v3_principal_class_fallback', resolution: 'ratify', decision: 'D-017' };
  if (field === 'source_tables_fields') return { cause: 'platform_correction', resolution: 'ratify', decision: 'D-001' };
  return { cause: 'code_extension', resolution: 'ratify', decision: 'D-018' };
}

function testMentions() {
  const dir = path.join(SERVER, 'test');
  const out = {};
  if (!fs.existsSync(dir)) return out;
  /* The framework suites name rule ids to test the framework (this audit, the
     registry, rule results, parameters), not the rules: they are not evidence. */
  const FRAMEWORK = new Set(['health-workbook.test.js', 'health-modules.test.js', 'health-rule-results.test.js', 'health-parameter-registry.test.js', 'health-assessment.test.js', 'health-scoring.test.js', 'health-phase4.test.js']);
  for (const f of fs.readdirSync(dir).filter((x) => /^health-.*\.test\.js$/.test(x) && !FRAMEWORK.has(x)).sort()) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const id of new Set(text.match(/\b(CMDB|ITSM|ITOM|PLT|DQ)-\d{3}\b/g) || [])) (out[id] ||= []).push(f);
  }
  return out;
}

export function buildAudit() {
  const source = readJson(path.join(WB, 'source.json'));
  const sheet = (k) => readJson(path.join(WB, 'sheets', `${k}.json`));
  const overlay = (k) => readJson(path.join(WB, 'overlays', `${k}.json`)).rules;
  const legacy = readJson(path.join(WB, 'legacy-map.json'));
  const ownership = readJson(path.join(WB, 'ownership.json'));
  const cmdbImpl = readJson(path.join(HEALTH, 'catalogue/cmdb.json'));
  const itsmImpl = readJson(path.join(HEALTH, 'rules/itsm/catalogue.json'));
  const itsmStatus = readJson(path.join(HEALTH, 'rules/itsm/status-matrix.json'));
  const itsmInstance = readJson(path.join(HEALTH, 'rules/itsm/phase5-instance-validation.json'));
  /* ITOM (Phase 5): the pack's rule configurations and parameter declarations, for the status notes. */
  /* Phases 5–6: every workbook pack's configurations, parameters and instance validation. */
  /* Phase 7: Enterprise DQ, a pack over the data-quality sheet's Enterprise Data Quality rows. */
  const packData = Object.fromEntries(['itom', 'platform', 'enterprise_dq', 'csdm', 'itil'].map((k) => {
    const configs = {};
    const dir = path.join(HEALTH, `${k}/rules`);
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) Object.assign(configs, readJson(path.join(dir, f)).rules || {});
    const pf = path.join(HEALTH, `rules/${k}/parameters.json`);
    const vf = path.join(HEALTH, `rules/${k}/instance-validation.json`);
    return [k, { configs, params: fs.existsSync(pf) ? readJson(pf) : {}, val: fs.existsSync(vf) ? readJson(vf) : null }];
  }));
  /* Phase 5E: the read-only instance validation (non-customer instance). */


  const cmdb = sheet('cmdb');
  const itsm = sheet('itsm');
  const dq = sheet('data-quality');
  const wbCmdb = new Map(cmdb.rules.map((r) => [r.id, r]));
  const dqById = new Map(dq.rules.map((r) => [r.id, r]));

  /* ── 1. implemented rules with no row in the CMDB sheet ── */
  const implementationOnly = cmdbImpl.rules.filter((r) => !wbCmdb.has(r.id)).map((r) => {
    const dqRow = r.dq ? dqById.get(r.dq) : null;
    return dqRow
      ? {
        rule_id: r.id, title: r.title, type: 'workbook_identity',
        workbook_identity: dqRow.id, workbook_sheet: 'data quality', workbook_model: dqRow.model,
        note: `Implements workbook rule ${dqRow.id} ("${dqRow.rule}"); the code gave it a CMDB id.`,
        resolution: 'keep', decision: 'D-010',
      }
      : {
        rule_id: r.id, title: r.title, type: 'unratified_extension',
        note: 'Implemented, and in no workbook sheet.',
        resolution: 'retire', decision: 'D-009', effective_phase: 4,
      };
  });

  /* ── 2. CMDB field differences (implementation vs workbook wording) ── */
  const cmdbTextDifferences = [];
  let escapingOnly = 0;
  for (const r of cmdb.rules) {
    const impl = cmdbImpl.rules.find((x) => x.id === r.id);
    if (!impl) continue;
    if (SEVERITY_TO_BAND[r.base_severity] !== impl.base) {
      cmdbTextDifferences.push({ rule_id: r.id, field: 'base_severity', workbook: r.base_severity, code: impl.base, cause: 'severity', resolution: 'conform', decision: 'D-001' });
    }
    for (const [wf, cf] of Object.entries(CMDB_FIELDS)) {
      const a = r[wf]; const b = impl[cf];
      if ((a ?? '') === (b ?? '')) continue;
      if (normaliseText(a) === normaliseText(b)) { escapingOnly += 1; continue; }
      cmdbTextDifferences.push({ rule_id: r.id, field: wf, workbook: a, code: b, ...classifyCmdbDifference(wf, a ?? '', b ?? '') });
    }
  }

  /* ── 3. ITSM: the implemented catalogue against the master workbook's ITSM sheet ── */
  const itsmFieldDifferences = [];
  for (const r of itsm.rules) {
    const impl = itsmImpl.rules.find((x) => x.id === r.id);
    if (!impl) { itsmFieldDifferences.push({ rule_id: r.id, field: '*', note: 'no implemented catalogue entry' }); continue; }
    for (const f of Object.keys(r)) {
      if (f === 'excel_row' || f === 'id') continue;
      if ((r[f] ?? null) !== (impl[f] ?? null)) itsmFieldDifferences.push({ rule_id: r.id, field: f, workbook: r[f], code: impl[f] });
    }
  }

  /* ── 4. inside the workbook: the data-quality CMDB model restating CMDB rules ── */
  const ov = overlay('data-quality');
  const workbookInternal = [];
  for (const r of dq.rules.filter((x) => x.model === 'CMDB Quality')) {
    const eq = ov[r.id]?.equivalent_of;
    const c = eq ? wbCmdb.get(eq) : null;
    if (!c) continue;   // DQ-003 / DQ-077: equivalents are implementation-only ids, covered in section 1
    const sev = r.base_severity !== c.base_severity;
    if (sev) workbookInternal.push({ dq_rule: r.id, cmdb_rule: c.id, field: 'base_severity', dq: r.base_severity, cmdb: c.base_severity });
  }

  /* ── 5. hard-coded rules ── */
  const legacyRules = Object.entries(legacy.rules).map(([id, m]) => ({
    rule_id: id, module: m.module, workbook: m.workbook, relation: m.relation,
    code_severity: m.code_severity, workbook_severity: m.workbook_severity,
    disposition: m.disposition, effective_phase: m.effective_phase,
  }));

  /*
   * ── 5b. the workbook identity the CODE claims for a hard-coded rule ──
   * rules.js ITOM_MEASUREMENTS (since 16 Sep) stamps each hard-coded ITOM
   * finding with a workbook rule id (`measurement_rule_id`). Where that claim
   * is not among the counterparts legacy-map.json records, one of the two is
   * wrong; the register names the pair and the reviewer decides.
   */
  const rulesSrc = fs.readFileSync(path.join(HEALTH, 'rules.js'), 'latin1');
  const block = /const ITOM_MEASUREMENTS = Object\.freeze\(\{([\s\S]*?)\n\}\);/.exec(rulesSrc)?.[1] ?? '';
  const wbRule = (id) => ['itom', 'itsm', 'cmdb', 'platform'].map((k) => sheet(k).rules.find((r) => r.id === id)).find(Boolean);
  const codeClaims = [...block.matchAll(/'([A-Z-]+)':\s*\{\s*id:\s*'([A-Z]+-\d{3})'/g)].map(([, legacyId, claimed]) => {
    const recorded = legacy.rules[legacyId]?.workbook ?? [];
    return {
      rule_id: legacyId,
      code_claims: claimed,
      code_claim_title: wbRule(claimed)?.rule ?? null,
      legacy_map_workbook: recorded,
      agrees: recorded.includes(claimed),
      resolution: recorded.includes(claimed) ? 'keep' : 'review',
    };
  });

  /* ── 6. build coverage, per module AND sheet ──
     Keyed by both because the data-quality sheet's CMDB Quality rows restate
     CMDB-sheet rules: summing them into one "cmdb" count would count 81 rules twice. */
  const allOverlays = ['cmdb', 'itsm', 'itom', 'platform', 'data-quality', 'csdm', 'itil'].flatMap((k) => Object.entries(overlay(k)).map(([id, e]) => ({ id, sheet: k, ...e })));
  const coverage = {};
  for (const e of allOverlays) {
    const c = (coverage[`${e.module} (${e.sheet} sheet)`] ||= { workbook_rules: 0, built: 0, not_built: 0 });
    c.workbook_rules += 1;
    if (e.implementation.state === 'built') c.built += 1; else c.not_built += 1;
  }

  const deviations = {
    register_version: '0.1.0',
    workbook: { file: source.workbook, sha256: source.workbook_sha256 },
    generator: 'server/scripts/health-workbook-audit.mjs',
    resolutions: {
      conform: 'the code changes to match the workbook',
      ratify: 'the workbook is updated to match what the code verified (the code is right)',
      retire: 'the code rule is removed (decision D-009)',
      keep: 'the difference is an identity, not a defect (decision D-010)',
      review: 'undecided: conform or ratify, per rule',
    },
    summary: {
      implementation_only_rules: implementationOnly.length,
      retire: implementationOnly.filter((x) => x.resolution === 'retire').map((x) => x.rule_id),
      workbook_identity: implementationOnly.filter((x) => x.type === 'workbook_identity').map((x) => `${x.rule_id} ≡ ${x.workbook_identity}`),
      cmdb_text_differences: cmdbTextDifferences.length,
      cmdb_text_differences_by_cause: cmdbTextDifferences.reduce((a, d) => { a[d.cause] = (a[d.cause] || 0) + 1; return a; }, {}),
      cmdb_escaping_only_ignored: escapingOnly,
      itsm_field_differences: itsmFieldDifferences.length,
      workbook_internal_severity_conflicts: workbookInternal.length,
      legacy_rules: legacyRules.length,
      code_workbook_claims_disputed: codeClaims.filter((c) => !c.agrees).map((c) => `${c.rule_id} → ${c.code_claims}`),
      ownership_conditions_open: ownership.conditions.filter((c) => c.status !== 'agreed').length,
      build_coverage: coverage,
    },
    implementation_only_rules: implementationOnly,
    cmdb_text_differences: cmdbTextDifferences,
    itsm_field_differences: itsmFieldDifferences,
    workbook_internal: workbookInternal,
    legacy_rules: legacyRules,
    code_workbook_claims: codeClaims,
  };

  /* ── status export ── */
  const mentions = testMentions();
  const statusRows = Object.fromEntries(itsmStatus.rows.map((r) => [r.rule_id, r]));
  const instanceRows = Object.fromEntries((itsmInstance.rules || []).map((r) => [r.id, r]));
  const instanceName = itsmInstance.instance?.name || itsmInstance.instance?.url || itsmInstance.instance || 'PDI';
  const instanceDate = String(itsmInstance.generated || '').slice(0, 10);
  const retiring = new Set(implementationOnly.filter((x) => x.resolution === 'retire').map((x) => x.rule_id));

  const exportRows = [];
  const push = (sheetName, r, implStatus, implNotes, valStatus, valNotes) => exportRows.push({
    sheet: sheetName, rule_id: r.id,
    implementation_status: implStatus, implementation_notes: implNotes,
    validation_status: valStatus, validation_notes: valNotes,
    workbook_implementation_status: r.implementation_status ?? null,
    workbook_validation_status: r.validation_status ?? null,
  });
  const unitNote = (ids) => {
    const files = [...new Set(ids.flatMap((id) => mentions[id] || []))];
    return files.length ? `Unit-tested (${files.join(', ')}); no per-rule instance validation recorded.` : 'No per-rule test or instance validation recorded.';
  };

  /* The pack a sheet row belongs to: the sheet's own, or Enterprise DQ for the data-quality sheet's Enterprise Data Quality rows. */
  const packOf = (k, r) => (k === 'data-quality' ? (r.model === 'Enterprise Data Quality' ? 'enterprise_dq' : null) : k);
  for (const k of ['cmdb', 'itsm', 'itom', 'platform', 'data-quality', 'csdm', 'itil']) {
    const s = sheet(k);
    const o = overlay(k);
    for (const r of s.rules) {
      const e = o[r.id];
      const impl = e.implementation;
      if (k === 'itsm') {
        const st = statusRows[r.id];
        const cls = impl.classification;
        const inst = instanceRows[r.id];
        const implStatus = cls === 'UNAVAILABLE' ? 'Deferred' : 'Built';
        const implNotes = cls === 'EXECUTABLE' ? `Built on the ${impl.engine} engine (health/itsm/rules).`
          : cls === 'UNCONFIGURED' ? `Built on the ${impl.engine} engine; unconfigured until instance parameter value(s) are set: ${(st?.unresolved_parameters || st?.referenced_parameters || []).join(', ') || 'see parameters.json'}.`
          : `Configured on the ${impl.engine} engine; unavailable by declaration: ${st?.blocking_reason || 'a required object is undefined'}.`;
        const tested = inst && inst.status === 'evaluated' && ['pass', 'fail'].includes(inst.verdict);
        push(s.sheet, r, implStatus, implNotes,
          tested ? 'Tested on PDI' : 'Not Tested',
          tested ? `${instanceName} ${instanceDate}: evaluated, verdict ${inst.verdict}, ${inst.findings} finding(s), population ${inst.population?.judged ?? '?'} ${inst.population?.unit ?? ''}`.trim()
            : `${instanceName} ${instanceDate}: ${inst ? `${inst.status}${inst.verdict ? ` / ${inst.verdict}` : ''}${inst.reason ? ` — ${inst.reason}` : ''}` : 'not run'}`);
      } else if (packData[packOf(k, r)] && impl.classification) {
        /* Health Assist Phases 5–7: a workbook pack. Its classification is the decision table's (scripts/lib/<pack>-decisions.mjs). */
        const pk = packOf(k, r);
        const { configs: itomConfigs, params: itomParams, val: itomVal } = packData[pk];
        const cls = impl.classification;
        const cfg = itomConfigs[r.id] || {};
        const why = cfg.undefined_dependencies?.[0] ?? cfg.specification_gap?.missing ?? (cfg.requires_objects?.length ? `the platform object(s) ${cfg.requires_objects.join(', ')} are not established on a verified instance` : null) ?? cfg.build_pending ?? null;
        const open = (itomParams.declarations?.[r.id]?.parameters || []).filter((q) => q.status === 'UNDEFINED').map((q) => q.key);
        const implStatus = ['executable', 'unconfigured', 'equivalent'].includes(cls) ? 'Built' : cls === 'not_built' ? 'Not Started' : 'Deferred';
        const implNotes = cls === 'executable' ? `Built on the ${impl.engine} engine (health/${pk}/rules).`
          : cls === 'unconfigured' ? `Built on the ${impl.engine} engine; unconfigured until instance parameter value(s) are set: ${open.join(', ') || `see rules/${pk}/parameters.json`}.`
          : cls === 'equivalent' ? `The same condition as ${impl.ref}, evaluated there and counted once (D-019).`
          : cls === 'not_built' ? `Fully defined; evaluator not built yet: ${why}.`
          : `Configured on the ${impl.engine} engine; ${cls === 'specification_gap' ? 'specification gap' : cls === 'object_unverified' ? 'object not yet verified' : 'unavailable by declaration'}: ${why}.`;
        const v = itomVal?.run?.rules?.[r.id];
        const tested = v && v.status === 'evaluated' && ['pass', 'fail'].includes(v.verdict);
        const where = itomVal ? `${itomVal.instance} ${String(itomVal.generated).slice(0, 10)} (non-customer instance, read-only)` : null;
        push(s.sheet, r, implStatus, implNotes, tested ? 'Tested on PDI' : 'Not Tested',
          tested ? `${where}: evaluated, verdict ${v.verdict}, ${v.findings} finding(s), population ${v.population?.judged ?? '?'} ${v.population?.unit ?? ''}. ${unitNote([r.id])}`.trim()
            : v ? `${where}: ${v.status}${v.verdict ? ` / ${v.verdict}` : ''}${v.blocker?.kind ? ` (${v.blocker.kind})` : ''}. ${unitNote([r.id])}` : unitNote([r.id]));
      } else if (impl.state === 'built') {
        const codeId = impl.ref;
        push(s.sheet, r, 'Built',
          k === 'data-quality' ? `Implemented as ${codeId} (health/catalogue/cmdb.json).` : `Implemented in the CMDB rule packs (health/cmdb-*.js).`,
          'Not Tested', unitNote([r.id, codeId]));
      } else {
        const interim = impl.interim_legacy;
        push(s.sheet, r, 'Not Started',
          interim ? `Interim hard-coded stand-in: ${interim.join(', ')} (differs from this definition; see legacy-map.json).` : null,
          'Not Tested', null);
      }
    }
  }

  const statusExport = {
    workbook: { file: source.workbook, sha256: source.workbook_sha256 },
    generator: 'server/scripts/health-workbook-audit.mjs',
    note: 'Statuses use the workbook Schema vocabulary (Implementation: Not Started / In Progress / Built / Deferred; Validation: Not Tested / Tested on PDI / Tested on Customer / Failed). A status is claimed only where the repository holds evidence for it. Unit tests are named in the notes but are not claimed as PDI validation.',
    retiring_not_exported: [...retiring],
    rows: exportRows,
  };

  return { deviations, statusExport };
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function statusCsv(statusExport) {
  const head = ['Sheet', 'Rule ID', 'Implementation Status', 'Implementation Notes', 'Validation Status', 'Validation Notes'];
  const lines = statusExport.rows.map((r) => [r.sheet, r.rule_id, r.implementation_status, r.implementation_notes, r.validation_status, r.validation_notes].map(csvCell).join(','));
  return `${[head.join(','), ...lines].join('\n')}\n`;
}

export const AUDIT_FILES = Object.freeze({
  deviations: path.join(WB, 'deviations.json'),
  statusJson: path.join(WB, 'status-export.json'),
  statusCsv: path.join(WB, 'status-export.csv'),
});
