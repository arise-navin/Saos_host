import { declareRequirement } from '../itsm/data-access.js';
import { fromSnowTime } from '../itsm/run-context.js';
import { ancestors } from '../csdm/comparators.js';

/**
 * D-033 — the Enterprise Data Quality comparators the documentation research made
 * buildable (docs/HEALTH-ASSIST-RULE-RESEARCH.md). Same contract as every comparator.
 *
 * Every mapping is the platform's own: the asset ↔ CI state mappings
 * (alm_asset_ci_state_mapping; alm_hardware_state_mapping for hardware), a model's CI
 * class (cmdb_model.cmdb_ci_class), a model's lifecycle (cmdb_model_lifecycle), a
 * knowledge article's validity (valid_to; the platform writes 2100-01-01 when none is
 * set) and ownership group. The PAN and Aadhaar formats were approved by the product
 * owner (D-033): PAN — five letters, four digits, one letter (Income Tax Department);
 * Aadhaar — twelve digits not starting 0 or 1, the last a Verhoeff check digit (UIDAI).
 */

const COMPLETE = 'complete';
const usable = (cov) => ['complete', 'limited', 'truncated'].includes(cov?.status);
const isEmpty = (v) => v === undefined || v === null || String(v).trim() === '';
const ref = (v) => (v && typeof v === 'object' ? v.value ?? v.sys_id ?? null : v);
const chunks = (xs, n = 100) => { const out = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };
const DAY_MS = 86400000;

async function rowsOf(ctx, { table, fields, query = '', complete = false }) {
  const r = await ctx.reads.read(declareRequirement({ table, fields, query, strategy: 'rows' }));
  if (!(complete ? r.coverage?.status === COMPLETE : usable(r.coverage))) return { unavailable: `${table} could not be read${complete ? ' completely' : ''} (${r.coverage?.status}${r.coverage?.error ? `: ${r.coverage.error}` : ''}) — no claim is made from a partial read`, coverage: r.coverage };
  return { rows: r.rows, coverage: r.coverage };
}
async function inChunks(ctx, { table, fields, field, ids, extra = '' }) {
  const out = [];
  for (const c of chunks([...new Set(ids)])) {
    const r = await rowsOf(ctx, { table, fields, query: `${field}IN${c.join(',')}${extra ? `^${extra}` : ''}`, complete: true });
    if (r.unavailable) return r;
    out.push(...r.rows);
  }
  return { rows: out };
}
const pop = (total, judged, unit, basis) => ({ total, judged, unit, basis });
const offender = (r, field, value) => ({ sys_id: r.sys_id, field, value });

/* ── the approved identifier formats (D-033) ─────────────────────────────── */

const VERHOEFF_D = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1], [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]];
const VERHOEFF_P = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1], [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]];
/** Verhoeff checksum over a digit string (the check digit included): valid when the result is 0. */
export function verhoeffValid(digits) {
  let c = 0;
  const d = String(digits).split('').reverse().map(Number);
  for (let i = 0; i < d.length; i += 1) c = VERHOEFF_D[c][VERHOEFF_P[i % 8][d[i]]];
  return c === 0;
}
/** The identifiers in a text: { pan: [...], aadhaar: [...], aadhaar_validated: [...] }. */
export function identifiersIn(text) {
  const s = String(text ?? '');
  const pan = [...s.matchAll(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/g)].map((m) => m[0]);
  const aadhaar = [...s.matchAll(/\b([2-9][0-9]{3})[ -]?([0-9]{4})[ -]?([0-9]{4})\b/g)].map((m) => `${m[1]}${m[2]}${m[3]}`);
  return { pan, aadhaar, aadhaar_validated: aadhaar.filter(verhoeffValid) };
}
const mask = (v) => (v.length > 4 ? `${'•'.repeat(v.length - 4)}${v.slice(-4)}` : '••••');

export const DQ_RESEARCH_COMPARATORS = Object.freeze({
  /**
   * DQ-099 — assets whose CI's state contradicts the platform's own asset ↔ CI state
   * mapping: an active mapping (asset → CI or both ways) exists for the asset's state
   * and substate, and the CI is in none of the states it maps to.
   */
  dq_asset_ci_state_contradiction: () => async (rows, ctx) => {
    const linked = rows.filter((a) => !isEmpty(ref(a.ci)));
    const gen = await rowsOf(ctx, { table: 'alm_asset_ci_state_mapping', fields: ['asset_state', 'asset_substate', 'configuration_item_status', 'synch_direction', 'active'], query: 'active=true^synch_directionINasset_to_ci,both', complete: true }); if (gen.unavailable) return gen;
    const hw = await rowsOf(ctx, { table: 'alm_hardware_state_mapping', fields: ['asset_state', 'asset_substate', 'hardware_ci_status', 'hardware_ci_substatus', 'synch_direction', 'active'], query: 'active=true^synch_directionINasset_to_ci,both', complete: true }); if (hw.unavailable) return hw;
    const ciIds = linked.map((a) => String(ref(a.ci)));
    const cis = await inChunks(ctx, { table: 'cmdb_ci', fields: ['install_status'], field: 'sys_id', ids: ciIds }); if (cis.unavailable) return cis;
    /* hardware_status lives on cmdb_ci_hardware, not on the base class */
    const hwIds = linked.filter((a) => a.sys_class_name === 'alm_hardware').map((a) => String(ref(a.ci)));
    const hws = hwIds.length ? await inChunks(ctx, { table: 'cmdb_ci_hardware', fields: ['hardware_status', 'hardware_substatus'], field: 'sys_id', ids: hwIds }) : { rows: [] }; if (hws.unavailable) return hws;
    const hwOf = new Map(hws.rows.map((h) => [h.sys_id, h]));
    const ci = new Map(cis.rows.map((c) => [c.sys_id, { ...c, ...(hwOf.get(c.sys_id) || {}) }]));
    const rowsFor = (maps, a) => maps.filter((m) => String(m.asset_state) === String(a.install_status) && (isEmpty(m.asset_substate) || String(m.asset_substate) === String(a.substatus ?? '')));
    const offenders = []; let judged = 0;
    for (const a of linked) {
      const c = ci.get(String(ref(a.ci))); if (!c) continue;
      const hardware = a.sys_class_name === 'alm_hardware';
      /* A CI with no state of its own (not a hardware CI, or status blank) cannot contradict — it is not judged. */
      if (hardware ? isEmpty(c.hardware_status) : isEmpty(c.install_status)) continue;
      const maps = rowsFor(hardware ? hw.rows : gen.rows, a);
      if (!maps.length) continue;
      judged += 1;
      /* The STATE is judged; a substatus only when both sides carry one. */
      const ok = hardware
        ? maps.some((m) => String(m.hardware_ci_status) === String(c.hardware_status) && (isEmpty(m.hardware_ci_substatus) || isEmpty(c.hardware_substatus) || String(m.hardware_ci_substatus) === String(c.hardware_substatus)))
        : maps.some((m) => String(m.configuration_item_status) === String(c.install_status ?? ''));
      if (!ok) offenders.push(offender(a, 'ci', `${a.display_name ?? a.sys_id}: asset ${a.install_status}${a.substatus ? `/${a.substatus}` : ''}, CI ${hardware ? `${c.hardware_status}${c.hardware_substatus ? `/${c.hardware_substatus}` : ''}` : c.install_status} — the mapping expects ${maps.map((m) => (hardware ? m.hardware_ci_status : m.configuration_item_status)).join(' or ')}`));
    }
    return { offenders, observed: { linked_assets: linked.length, judged, contradicting: offenders.length }, expected: 0, absent: false,
      population: pop(linked.length, judged, 'assets linked to a CI', 'assets whose state the platform maps to a CI state (alm_asset_ci_state_mapping; alm_hardware_state_mapping for hardware)') };
  },

  /** DQ-102 — CIs whose class is neither their model's CI class nor a subclass of it. */
  dq_model_class_contradiction: () => async (rows, ctx) => {
    const models = await rowsOf(ctx, { table: 'cmdb_model', fields: ['name', 'cmdb_ci_class'], query: 'cmdb_ci_classISNOTEMPTY', complete: true }); if (models.unavailable) return models;
    const want = new Map(models.rows.map((m) => [m.sys_id, m]));
    const judged = rows.filter((c) => want.has(String(ref(c.model_id))) && !isEmpty(c.sys_class_name));
    const ch = await ancestors(ctx, judged.map((c) => c.sys_class_name)); if (ch.unavailable) return ch;
    const offenders = judged.filter((c) => !(ch.chains.get(c.sys_class_name) || [c.sys_class_name]).includes(String(want.get(String(ref(c.model_id))).cmdb_ci_class)))
      .map((c) => offender(c, 'sys_class_name', `${c.name}: ${c.sys_class_name}, model ${want.get(String(ref(c.model_id))).name} is for ${want.get(String(ref(c.model_id))).cmdb_ci_class}`));
    return { offenders, observed: { models_with_class: models.rows.length, cis_judged: judged.length, contradicting: offenders.length }, expected: 0, absent: false,
      population: pop(judged.length, judged.length, 'CIs whose model states a CI class', 'cmdb_model.cmdb_ci_class, against the CI class and its ancestors') };
  },

  /** DQ-121 — assets in use whose model has reached its End of Life phase (cmdb_model_lifecycle). */
  dq_assets_past_model_eol: ({ phase = 'end_of_life' }) => async (rows, ctx) => {
    const now = new Date(ctx.run.run_started_at).getTime();
    const life = await rowsOf(ctx, { table: 'cmdb_model_lifecycle', fields: ['model', 'lifecycle_phase', 'start_date'], query: `lifecycle_phase=${phase}^start_dateISNOTEMPTY`, complete: true }); if (life.unavailable) return life;
    const eol = new Map();
    for (const l of life.rows) { const t = fromSnowTime(`${String(l.start_date).slice(0, 10)} 00:00:00`); if (t && t <= now) eol.set(String(ref(l.model)), l.start_date); }
    const judged = rows.filter((a) => !isEmpty(ref(a.model)));
    const offenders = judged.filter((a) => eol.has(String(ref(a.model)))).map((a) => offender(a, 'model', `${a.display_name ?? a.sys_id}: in use; its model reached End of Life on ${eol.get(String(ref(a.model)))}`));
    return { offenders, observed: { assets_in_use: rows.length, models_past_eol: eol.size, in_use_past_eol: offenders.length }, expected: 0, absent: false,
      population: pop(judged.length, judged.length, 'assets in use with a model', 'the model\'s End of Life phase in cmdb_model_lifecycle, started on or before today') };
  },

  /** DQ-122 — published articles past their valid-to date (the platform's 2100-01-01 is "no date"). */
  dq_articles_past_valid_to: ({ none = '2100-01-01' }) => async (rows, ctx) => {
    const now = new Date(ctx.run.run_started_at).getTime();
    const dated = rows.filter((a) => !isEmpty(a.valid_to) && !String(a.valid_to).startsWith(none));
    const offenders = dated.filter((a) => { const t = fromSnowTime(`${String(a.valid_to).slice(0, 10)} 00:00:00`); return t && t < now; })
      .map((a) => offender(a, 'valid_to', `${a.number}: valid to ${String(a.valid_to).slice(0, 10)} — ${Math.floor((now - fromSnowTime(`${String(a.valid_to).slice(0, 10)} 00:00:00`)) / DAY_MS)} days overdue, ${a.sys_view_count ?? 0} views`));
    return { offenders, observed: { published: rows.length, with_review_date: dated.length, overdue: offenders.length }, expected: 0, absent: false,
      population: pop(dated.length, dated.length, 'published articles with a review date', `valid_to set and not the platform's "no date" (${none})`) };
  },

  /**
   * DQ-085 — locations with no country or no time zone, judged only when routing or
   * SLA conditions read a location's country or time zone (the workbook's guard).
   */
  dq_location_fields_referenced: ({ fields = ['country', 'time_zone'] }) => async (rows, ctx) => {
    const sla = await rowsOf(ctx, { table: 'contract_sla', fields: ['name', 'start_condition', 'pause_condition', 'stop_condition'], query: 'active=true', complete: true }); if (sla.unavailable) return sla;
    const ar = await rowsOf(ctx, { table: 'sysrule_assignment', fields: ['name', 'condition'], query: 'active=true', complete: true }); if (ar.unavailable) return ar;
    const text = [...sla.rows.map((d) => [d.start_condition, d.pause_condition, d.stop_condition].join('^')), ...ar.rows.map((r) => r.condition)].join('^');
    const used = fields.filter((f) => new RegExp(`location\\.${f}\\b`).test(text));
    if (!used.length) return { offenders: [], observed: { locations: rows.length, fields_referenced: [] }, expected: 0, absent: false, population: { total: rows.length, judged: 0, unit: 'locations', basis: 'no SLA or assignment condition reads location country or time zone', determinate_when_empty: 'no rule depends on the fields' } };
    const offenders = rows.filter((l) => used.some((f) => isEmpty(l[f]))).map((l) => offender(l, used.find((f) => isEmpty(l[f])), `${l.name}: no ${used.filter((f) => isEmpty(l[f])).join(' / ')}, which ${used.length > 1 ? 'rules read' : 'a rule reads'}`));
    return { offenders, observed: { locations: rows.length, fields_referenced: used, missing: offenders.length }, expected: 0, absent: false,
      population: pop(rows.length, rows.length, 'locations', `the location fields SLA / assignment conditions read: ${used.join(', ')}`) };
  },

  /**
   * DQ-133 / DQ-139 — PAN and Aadhaar in the free-text fields `fields` (table.field).
   *   'content'        each record holding an identifier (133; Aadhaar matches that pass the checksum reported separately)
   *   'unclassified'   the tables where identifiers were found and no field is classified (139)
   */
  dq_identifiers_in_text: ({ fields, mode = 'content' }) => async (_rows, ctx) => {
    const byTable = new Map();
    for (const tf of fields) { const [t, f] = String(tf).split('.'); if (!t || !f) continue; if (!byTable.has(t)) byTable.set(t, []); byTable.get(t).push(f); }
    const offenders = []; const tablesWith = new Set(); let scanned = 0; let validated = 0;
    for (const [t, fs] of byTable) {
      const r = await rowsOf(ctx, { table: t, fields: ['number', ...fs], query: fs.map((f) => `${f}ISNOTEMPTY`).join('^OR'), complete: true });
      if (r.unavailable) return r;
      for (const rec of r.rows) {
        scanned += 1;
        const hits = fs.map((f) => ({ f, ...identifiersIn(rec[f]) })).filter((h) => h.pan.length || h.aadhaar.length);
        if (!hits.length) continue;
        tablesWith.add(t);
        validated += hits.reduce((n, h) => n + h.aadhaar_validated.length, 0);
        if (mode === 'content') offenders.push(offender(rec, hits[0].f, `${rec.number ?? rec.sys_id}: ${hits.map((h) => `${h.f} — ${h.pan.map((v) => `PAN ${mask(v)}`).concat(h.aadhaar.map((v) => `Aadhaar ${mask(v)}${h.aadhaar_validated.includes(v) ? ' (checksum valid)' : ''}`)).join(', ')}`).join('; ')}`));
      }
    }
    if (mode === 'unclassified') {
      const m2m = await rowsOf(ctx, { table: 'm2m_dictionary_dataclass', fields: ['sys_dictionary'], complete: true }); if (m2m.unavailable) return m2m;
      const dict = await inChunks(ctx, { table: 'sys_dictionary', fields: ['name'], field: 'sys_id', ids: m2m.rows.map((x) => String(ref(x.sys_dictionary))) }); if (dict.unavailable) return dict;
      const classified = new Set(dict.rows.map((d) => d.name));
      for (const t of tablesWith) if (!classified.has(t)) offenders.push({ sys_id: t, field: 'classification', value: `${t}: holds PAN / Aadhaar in free text and no field of the table is classified` });
      return { offenders, observed: { tables_scanned: byTable.size, tables_with_identifiers: tablesWith.size, unclassified: offenders.length }, expected: 0, absent: false,
        population: pop(tablesWith.size, tablesWith.size, 'tables holding identifiers in free text', 'the scanned fields; a table counts as classified when any of its fields is (m2m_dictionary_dataclass)') };
    }
    return { offenders, observed: { records_scanned: scanned, with_identifiers: offenders.length, aadhaar_checksum_valid: validated }, expected: 0, absent: false,
      population: pop(scanned, scanned, 'records with text in the scanned fields', `${fields.join(', ')} — PAN (AAAAA9999A) and Aadhaar (12 digits, Verhoeff checked), values masked`) };
  },

  /**
   * DQ-137 — custom string fields (u_) whose values hold PAN or Aadhaar and that are
   * not classified (m2m_dictionary_dataclass).
   */
  dq_identifier_custom_fields_unclassified: ({ max_fields = 200 }) => async (rows, ctx) => {
    const fields = rows.filter((d) => String(d.element).startsWith('u_')).slice(0, max_fields);
    const m2m = await rowsOf(ctx, { table: 'm2m_dictionary_dataclass', fields: ['sys_dictionary'], complete: true }); if (m2m.unavailable) return m2m;
    const classified = new Set(m2m.rows.map((x) => String(ref(x.sys_dictionary))));
    const offenders = []; let judged = 0;
    for (const f of fields.filter((x) => !classified.has(x.sys_id))) {
      const r = await rowsOf(ctx, { table: f.name, fields: [f.element], query: `${f.element}ISNOTEMPTY` });
      if (r.unavailable) continue;
      judged += 1;
      const hit = r.rows.find((x) => { const i = identifiersIn(x[f.element]); return i.pan.length || i.aadhaar_validated.length; });
      if (hit) offenders.push(offender(f, 'element', `${f.name}.${f.element}: holds identifier data and is not classified`));
    }
    return { offenders, observed: { custom_string_fields: fields.length, judged, unclassified_with_identifiers: offenders.length }, expected: 0, absent: false,
      population: pop(fields.length, judged, 'unclassified custom string fields', 'u_ string fields, values tested for PAN and checksum-valid Aadhaar') };
  },

  /**
   * DQ-132 — active reports naming a field their table no longer has: the fields a report
   * groups, sums, trends, lists and pivots by (field, field_list, sumfield, trend_field,
   * column, row, and the filter's GROUPBY / ORDERBY / TRENDBY), resolved against the
   * dictionary of the table and every table it extends. A dot-walk is judged on its first
   * field. Reports on database views, and on tables no longer on the instance, are counted
   * apart, not judged.
   */
  dq_report_fields_missing: () => async (rows, ctx) => {
    const refsOf = (r) => {
      const out = new Set();
      for (const k of ['field', 'sumfield', 'trend_field', 'column', 'row']) if (!isEmpty(r[k])) out.add(String(r[k]));
      for (const f of String(r.field_list ?? '').split(',')) if (f.trim()) out.add(f.trim());
      for (const m of String(r.filter ?? '').matchAll(/(?:GROUPBY|ORDERBYDESC|ORDERBY|TRENDBY)([A-Za-z0-9_.]+)/g)) out.add(m[1]);
      return [...out].map((f) => f.split('.')[0]).filter((f) => f && !PSEUDO.has(f));
    };
    const tables = [...new Set(rows.map((r) => String(r.table ?? '')).filter(Boolean))];
    const known = await inChunks(ctx, { table: 'sys_db_object', fields: ['name'], field: 'name', ids: tables }); if (known.unavailable) return known;
    const views = await inChunks(ctx, { table: 'sys_db_view', fields: ['name'], field: 'name', ids: tables }); if (views.unavailable) return views;
    const isView = new Set(views.rows.map((v) => v.name));
    const live = tables.filter((t) => known.rows.some((x) => x.name === t) && !isView.has(t));
    const ch = await ancestors(ctx, live); if (ch.unavailable) return ch;
    const chainTables = [...new Set(live.flatMap((t) => ch.chains.get(t) || [t]))];
    const dict = await inChunks(ctx, { table: 'sys_dictionary', fields: ['name', 'element'], field: 'name', ids: chainTables, extra: 'elementISNOTEMPTY' }); if (dict.unavailable) return dict;
    const fieldsOf = new Map();
    for (const d of dict.rows) { if (!fieldsOf.has(d.name)) fieldsOf.set(d.name, new Set()); fieldsOf.get(d.name).add(d.element); }
    const has = (t, f) => (ch.chains.get(t) || [t]).some((x) => fieldsOf.get(x)?.has(f));
    const judged = rows.filter((r) => live.includes(String(r.table)));
    const offenders = [];
    for (const r of judged) {
      const missing = refsOf(r).filter((f) => !has(String(r.table), f));
      if (missing.length) offenders.push(offender(r, 'field', `${r.title || r.sys_id} (${r.table}): ${[...new Set(missing)].join(', ')} not in the dictionary`));
    }
    return { offenders, observed: { active_reports: rows.length, judged: judged.length, on_views: rows.filter((r) => isView.has(String(r.table))).length, on_missing_tables: rows.filter((r) => !isEmpty(r.table) && !isView.has(String(r.table)) && !known.rows.some((x) => x.name === String(r.table))).length, referencing_missing_fields: offenders.length }, expected: 0, absent: false,
      population: pop(rows.length, judged.length, 'active reports', 'grouping, sum, trend, list and pivot fields, against the dictionary of the report\'s table and its ancestors') };
  },
});

/**
 * DQ-098 (D-037) — values in use on active records that the field's choice list does not
 * hold. For each choice field (dropdown: choice 1 or 3) of `tables`, the values in use are
 * counted by the instance per record class; each class's list is its own sys_choice rows
 * for the field, or the nearest table it extends that has some. A value held only by an
 * inactive choice is reported as its own case.
 */
export const DQ_CHOICE_COMPARATORS = Object.freeze({
  dq_choice_values_unlisted: ({ tables }) => async (_rows, ctx) => {
    const dict = await inChunks(ctx, { table: 'sys_dictionary', fields: ['name', 'element', 'choice', 'internal_type'], field: 'name', ids: tables, extra: 'choiceIN1,3^internal_typeNOT INreference,workflow^choice_tableISEMPTY' });
    if (dict.unavailable) return dict;
    const fields = dict.rows.filter((d) => !isEmpty(d.element));
    const has = await inChunks(ctx, { table: 'sys_dictionary', fields: ['name', 'element'], field: 'name', ids: tables, extra: 'elementINactive,sys_class_name' });
    if (has.unavailable) return has;
    const hasField = (t, f) => has.rows.some((x) => x.name === t && x.element === f);
    const offenders = []; let judged = 0; const classes = new Set();
    const uses = [];
    for (const d of fields) {
      const byClass = hasField(d.name, 'sys_class_name');
      const g = await ctx.reads.read(declareRequirement({ table: d.name, query: `${hasField(d.name, 'active') ? 'active=true^' : ''}${d.element}ISNOTEMPTY`, strategy: 'aggregate', groupBy: byClass ? ['sys_class_name', d.element] : [d.element] }));
      if (g.coverage?.status !== 'complete') continue;
      judged += 1;
      for (const x of g.groups) { const cls = byClass ? String(x.group.sys_class_name || d.name) : d.name; classes.add(cls); uses.push({ table: d.name, field: d.element, cls, value: String(x.group[d.element]), count: x.count }); }
    }
    const ch = await ancestors(ctx, [...classes]); if (ch.unavailable) return ch;
    const chainTables = [...new Set([...classes].flatMap((c) => ch.chains.get(c) || [c]))];
    /* sys_choice refuses paged reads (Pagination not supported): the lists are read as grouped counts, one per table chunk. */
    const choices = { rows: [] };
    for (const c of chunks(chainTables, 50)) {
      const g = await ctx.reads.read(declareRequirement({ table: 'sys_choice', query: `nameIN${c.join(',')}^elementIN${[...new Set(fields.map((f) => f.element))].join(',')}`, strategy: 'aggregate', groupBy: ['name', 'element', 'value', 'inactive'] }));
      if (g.coverage?.status !== 'complete') return { unavailable: `sys_choice could not be read (${g.coverage?.status})` };
      for (const x of g.groups) choices.rows.push({ name: String(x.group.name), element: String(x.group.element), value: String(x.group.value ?? ''), inactive: String(x.group.inactive) });
    }
    const listOf = (cls, field) => {
      for (const t of ch.chains.get(cls) || [cls]) {
        const rows = choices.rows.filter((c) => c.name === t && c.element === field);
        if (rows.length) return { table: t, active: new Set(rows.filter((c) => String(c.inactive) !== 'true').map((c) => String(c.value))), inactive: new Set(rows.filter((c) => String(c.inactive) === 'true').map((c) => String(c.value))) };
      }
      return null;
    };
    const grouped = new Map();
    for (const u of uses) {
      const list = listOf(u.cls, u.field); if (!list || list.active.has(u.value)) continue;
      const key = `${u.cls}.${u.field}`;
      if (!grouped.has(key)) grouped.set(key, { absent: [], inactive: [] });
      (list.inactive.has(u.value) ? grouped.get(key).inactive : grouped.get(key).absent).push(`${u.value} (${u.count})`);
    }
    for (const [key, v] of grouped) offenders.push({ sys_id: null, field: key, value: `${key}: ${v.absent.length ? `not in the choice list — ${v.absent.slice(0, 8).join(', ')}` : ''}${v.absent.length && v.inactive.length ? '; ' : ''}${v.inactive.length ? `inactive choice — ${v.inactive.slice(0, 8).join(', ')}` : ''}` });
    return { offenders, observed: { choice_fields: fields.length, judged, classes: classes.size, fields_with_unlisted_values: offenders.length }, expected: 0, absent: false,
      population: pop(fields.length, judged, 'choice fields', `dropdown choice fields of ${tables.join(', ')}; values in use on active records, per class, against the class's choice list (inheritance resolved)`) };
  },
});

/* Report columns that are not dictionary entries: tags, and the platform's own sys_ grouping aliases. */
const PSEUDO = new Set(['sys_tags', 'sys_id']);
