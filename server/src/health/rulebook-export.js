import { RULEBOOK_TABS } from './rulebook.js';
import { CUSTOM_MODULES } from './custom-rules.js';

/**
 * THE RULEBOOK AS AN EXCEL WORKBOOK (Job HC-1). One sheet per module tab, as the
 * Rulebook shows it — with a person's changes applied and the workbook's own
 * value beside anything they changed — a Custom sheet, and a Summary.
 *
 * Every value is written as a plain string cell (ExcelJS writes a formula only
 * when handed one explicitly), so rule text that starts with = + - or @ stays text.
 */

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B3D2E' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' } };
const CHANGED_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF4D6' } };
const OFF_FONT = { color: { argb: 'FF8A8F98' } };

const clean = (s) => String(s ?? '').replace(/\\([_*])/g, '$1').trim();
const text = clean;

const RULE_COLUMNS = [
  { header: 'Rule ID', key: 'id', width: 12 },
  { header: 'Group', key: 'group', width: 30 },
  { header: 'Rule', key: 'rule', width: 60 },
  { header: 'Severity', key: 'severity', width: 12 },
  { header: 'Workbook severity', key: 'workbook_severity', width: 14 },
  { header: 'Status', key: 'status', width: 26 },
  { header: 'In scans', key: 'in_scans', width: 10 },
  { header: 'Your changes', key: 'changes', width: 34 },
  { header: 'Thresholds', key: 'thresholds', width: 30 },
  { header: 'What it means', key: 'what_it_means', width: 60 },
  { header: 'Why it matters', key: 'why_it_matters', width: 60 },
  { header: 'Detection logic', key: 'detection_logic', width: 50 },
  { header: 'Threshold / parameter', key: 'threshold_parameter', width: 40 },
  { header: 'Source tables / fields', key: 'source_tables_fields', width: 40 },
  { header: 'False-positive guard', key: 'false_positive_guard', width: 50 },
  { header: 'Remediation lane', key: 'remediation_lane', width: 36 },
  { header: 'Cross-domain link', key: 'cross_domain_link', width: 36 },
  { header: 'Changed by', key: 'changed_by', width: 18 },
  { header: 'Changed at (UTC)', key: 'changed_at', width: 20 },
];

const CUSTOM_COLUMNS = [
  { header: 'Rule ID', key: 'rule_id', width: 18 },
  { header: 'Rule', key: 'name', width: 50 },
  { header: 'Module', key: 'module', width: 14 },
  { header: 'Check', key: 'kind', width: 12 },
  { header: 'Table', key: 'table', width: 22 },
  { header: 'Applies to', key: 'scope', width: 40 },
  { header: 'A problem when', key: 'conditions', width: 50 },
  { header: 'Limit', key: 'limit', width: 22 },
  { header: 'Severity', key: 'severity', width: 12 },
  { header: 'In score', key: 'scored', width: 10 },
  { header: 'On', key: 'active', width: 8 },
  { header: 'Last result', key: 'last', width: 34 },
  { header: 'Description', key: 'description', width: 60 },
  { header: 'Created by', key: 'created_by', width: 18 },
  { header: 'Updated at (UTC)', key: 'updated_at', width: 20 },
];

const SEV_WORD = { SYSTEMIC: 'Systemic', CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Moderate', LOW: 'Low' };
const utc = (iso) => (iso ? String(iso).replace('T', ' ').slice(0, 19) : '');
const conds = (list) => (list || []).map((c) => `${c.field} ${c.op} ${c.value}`.trim()).join(' AND ');

function changeWords(r) {
  const c = r.changes;
  if (!c) return '';
  const parts = [];
  if (c.deleted) parts.push('Removed');
  else if (!c.active) parts.push('Switched off');
  if (c.severity) parts.push(`Severity (workbook: ${clean(r.workbook.base_severity)})`);
  if (c.edited?.length) parts.push(`Edited: ${c.edited.join(', ').replace(/_/g, ' ')}`);
  if (c.check) parts.push(`Own ${c.check.kind} check on ${c.check.table}`);
  return parts.join('; ');
}

function lastWord(last) {
  if (!last) return 'Not run yet';
  if (last.status !== 'evaluated') return `Could not run: ${last.reason ?? ''}`.trim();
  if (last.verdict === 'fail') return `Failed · ${last.matches} of ${last.population}`;
  if (last.verdict === 'pass') return 'Passed';
  return 'Nothing to check';
}

function styleHeader(ws) {
  const row = ws.getRow(1);
  row.font = HEADER_FONT;
  row.fill = HEADER_FILL;
  row.alignment = { vertical: 'middle', wrapText: true };
  row.height = 22;
  ws.views = [{ state: 'frozen', ySplit: 1, xSplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };
}

/** Which rules a sheet holds: `tabs` is 'all' or a list of tab keys. */
const wanted = (tabs) => (tabs === 'all' || !tabs?.length ? RULEBOOK_TABS.map((t) => t.key) : tabs);

/**
 * Build the workbook. `book` is effectiveRulebook(); `custom` the custom rules
 * (with `last`); `filters` narrows the rows as the page did (q, severity, status).
 * Returns an ExcelJS workbook; the caller writes it.
 */
export async function buildRulebookWorkbook({ book, custom = [], tabs = 'all', filters = {}, includeRemoved = false, instance = null, generatedAt = new Date() }) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SAOS Health Assist';
  wb.created = generatedAt;
  const keys = wanted(tabs);
  const needle = String(filters.q ?? '').trim().toLowerCase();
  /* The page's status filter: a status, or "changed" (by you: a change row or a threshold you set), "removed", "custom". */
  const statusOk = (r) => {
    if (!filters.status) return true;
    if (filters.status === 'changed') return Boolean(r.changes || r.thresholds?.own);
    if (filters.status === 'custom') return false;
    return r.status.key === filters.status;
  };
  const keep = (r) => (includeRemoved || filters.status === 'removed' || r.status.key !== 'removed')
    && (!needle || `${r.id} ${clean(r.rule)} ${clean(r.group)}`.toLowerCase().includes(needle))
    && (!filters.severity || clean(r.base_severity) === filters.severity)
    && statusOk(r);

  const summary = wb.addWorksheet('Summary');
  summary.columns = [{ header: 'Tab', key: 'tab', width: 18 }, { header: 'Rules', key: 'rules', width: 10 }, { header: 'Run in scans', key: 'runs', width: 14 },
    { header: 'Switched off', key: 'off', width: 14 }, { header: 'Removed', key: 'removed', width: 12 }, { header: 'Changed by you', key: 'changed', width: 16 },
    { header: 'Waiting for a value', key: 'needs_value', width: 20 }, { header: 'Waiting on an answer', key: 'needs_answer', width: 22 }, { header: 'Counted elsewhere', key: 'elsewhere', width: 18 }];
  styleHeader(summary);

  let exported = 0;
  for (const t of RULEBOOK_TABS) {
    if (!keys.includes(t.key)) continue;
    if (t.key === 'custom') {
      const ws = wb.addWorksheet('Custom');
      ws.columns = CUSTOM_COLUMNS;
      styleHeader(ws);
      /* Every custom rule is "changed by you"; runs / off follow its switch; the workbook's statuses match none. */
      const customStatusOk = (c) => !filters.status || ['custom', 'changed'].includes(filters.status) || (filters.status === 'runs' && c.active) || (filters.status === 'off' && !c.active);
      const rows = custom.filter((c) => (!needle || `${c.rule_id} ${c.name} ${c.description}`.toLowerCase().includes(needle)) && (!filters.severity || SEV_WORD[c.severity] === filters.severity) && customStatusOk(c));
      for (const c of rows) {
        const row = ws.addRow({
          rule_id: c.rule_id, name: text(c.name), module: CUSTOM_MODULES[c.module]?.label ?? c.module, kind: c.kind, table: c.table,
          scope: text(conds(c.scope)), conditions: text(conds(c.conditions)),
          limit: c.kind === 'rate' ? `fails above ${c.threshold?.max_share}%` : c.kind === 'age' ? `older than ${c.age?.days} days by ${c.age?.field}` : '',
          severity: SEV_WORD[c.severity] ?? c.severity, scored: c.scored ? 'Yes' : 'No', active: c.active ? 'On' : 'Off', last: lastWord(c.last),
          description: text(c.description), created_by: c.created_by ?? '', updated_at: utc(c.updated_at),
        });
        row.alignment = { vertical: 'top', wrapText: true };
        if (!c.active) row.font = OFF_FONT;
      }
      exported += rows.length;
      summary.addRow({ tab: 'Custom', rules: rows.length, runs: rows.filter((c) => c.active).length, off: rows.filter((c) => !c.active).length, removed: 0, changed: rows.length, needs_value: 0, needs_answer: 0, elsewhere: 0 });
      continue;
    }
    const list = (book.rules[t.key] || []).filter(keep);
    const ws = wb.addWorksheet(t.label);
    ws.columns = RULE_COLUMNS;
    styleHeader(ws);
    for (const r of list) {
      const row = ws.addRow({
        id: r.id, group: text(r.group), rule: text(r.rule), severity: clean(r.base_severity), workbook_severity: clean(r.workbook?.base_severity ?? r.base_severity),
        status: r.status.label, in_scans: ['runs'].includes(r.status.key) ? 'Yes' : 'No', changes: changeWords(r),
        thresholds: r.thresholds ? `${r.thresholds.count} parameter${r.thresholds.count === 1 ? '' : 's'}${r.thresholds.unresolved ? `, ${r.thresholds.unresolved} without a value` : ''}${r.thresholds.own ? `, ${r.thresholds.own} set by you` : ''}` : '',
        what_it_means: text(r.what_it_means), why_it_matters: text(r.why_it_matters), detection_logic: text(r.detection_logic),
        threshold_parameter: text(r.threshold_parameter), source_tables_fields: text(r.source_tables_fields), false_positive_guard: text(r.false_positive_guard),
        remediation_lane: text(r.remediation_lane), cross_domain_link: text(r.cross_domain_link),
        changed_by: r.changes?.updated_by ?? '', changed_at: utc(r.changes?.updated_at),
      });
      row.alignment = { vertical: 'top', wrapText: true };
      if (['off', 'removed'].includes(r.status.key)) row.font = OFF_FONT;
      /* What differs from the workbook is shaded, so a reviewer sees the changes at a glance. */
      for (const f of [...(r.changes?.edited ?? []), ...(r.changes?.severity ? ['severity'] : [])]) {
        const col = RULE_COLUMNS.findIndex((c) => c.key === f) + 1;
        if (col > 0) row.getCell(col).fill = CHANGED_FILL;
      }
    }
    exported += list.length;
    const n = (k) => list.filter((r) => r.status.key === k).length;
    summary.addRow({ tab: t.label, rules: list.length, runs: n('runs'), off: n('off'), removed: n('removed'), changed: list.filter((r) => r.changes || r.thresholds?.own).length,
      needs_value: n('needs_value'), needs_answer: n('needs_answer'), elsewhere: n('counted_elsewhere') });
  }
  summary.addRow({});
  summary.addRow({ tab: 'Exported', rules: exported });
  summary.addRow({ tab: 'Generated (UTC)', rules: utc(generatedAt.toISOString()) });
  if (instance) summary.addRow({ tab: 'Instance', rules: instance });
  const filterWords = [needle && `search "${filters.q}"`, filters.severity && `severity ${filters.severity}`, filters.status && `status ${filters.status}`].filter(Boolean).join(', ');
  if (filterWords) summary.addRow({ tab: 'Filters', rules: filterWords });
  return { workbook: wb, rows: exported };
}
