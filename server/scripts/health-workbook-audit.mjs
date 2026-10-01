/**
 * HEALTH ASSIST PHASE 0 — write the deviations register and the status export.
 *
 *   node scripts/health-workbook-audit.mjs
 *
 * Run after `import-health-workbook.mjs` and `health-workbook-overlays.mjs`, and
 * again whenever the workbook, the overlays or the implemented catalogues change.
 * `test/health-workbook.test.js` fails if the committed files are stale.
 */
import fs from 'node:fs';
import { buildAudit, statusCsv, AUDIT_FILES } from './lib/health-workbook-audit.mjs';

const { deviations, statusExport } = buildAudit();
fs.writeFileSync(AUDIT_FILES.deviations, `${JSON.stringify(deviations, null, 1)}\n`);
fs.writeFileSync(AUDIT_FILES.statusJson, `${JSON.stringify(statusExport, null, 1)}\n`);
fs.writeFileSync(AUDIT_FILES.statusCsv, statusCsv(statusExport));

const s = deviations.summary;
process.stdout.write([
  `deviations: ${s.implementation_only_rules} implementation-only rule(s) (retire ${s.retire.join(', ') || '—'}; identity ${s.workbook_identity.join(', ') || '—'})`,
  `            ${s.cmdb_text_differences} CMDB text difference(s) ${JSON.stringify(s.cmdb_text_differences_by_cause)}, ${s.cmdb_escaping_only_ignored} escaping-only ignored`,
  `            ${s.itsm_field_differences} ITSM field difference(s), ${s.workbook_internal_severity_conflicts} workbook-internal severity conflict(s), ${s.legacy_rules} legacy rule(s)`,
  `coverage:   ${Object.entries(s.build_coverage).map(([m, c]) => `${m} ${c.built}/${c.workbook_rules}`).join(' · ')}`,
  `status:     ${statusExport.rows.length} row(s) → ${AUDIT_FILES.statusCsv}`,
].join('\n') + '\n');
