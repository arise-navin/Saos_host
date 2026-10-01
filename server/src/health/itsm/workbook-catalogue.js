import { REQUIRED_RULE_FIELDS, SEVERITY_WORDS, CatalogueError } from './catalogue.js';

/**
 * HEALTH ASSIST PHASE 5 — a catalogue pack's rule loader, for any workbook sheet.
 *
 * The ITSM loader (catalogue.js) is the pattern: identity is the slot (rule n is
 * `<PREFIX>-nnn`, is `rules[n-1]`, came from Excel row n+1), every workbook
 * column the Schema sheet requires is present, the severity is a workbook band,
 * and the architecture map was built from the SAME workbook, one entry per slot.
 * This module applies it to another sheet (ITOM first) without touching the ITSM
 * loader, whose exports the ITSM suite pins.
 *
 * The architecture map carries the design-time classification the runner needs
 * (engine, supporting engines, dependencies) plus, for ITOM, the PRODUCT a rule
 * belongs to (Discovery, MID Server, Service Mapping, Event Management, Cloud),
 * which the applicability layer uses. Optional classification fields default to
 * empty — never to a guess.
 *
 * Phase 7: a pack may be a RANGE of a sheet (`first`): Enterprise Data Quality is
 * DQ-084 … DQ-139 of the data-quality sheet. Rule n is still `<PREFIX>-nnn`, its
 * slot is n and it came from Excel row n+1; the range must be contiguous.
 */

const idFor = (prefix, slot) => `${prefix}-${String(slot).padStart(3, '0')}`;
const list = (x) => Object.freeze([...(x || [])]);

export function validateWorkbookCatalogue(cat, { prefix, count, first = 1 }) {
  if (!cat || !Array.isArray(cat.rules)) throw new CatalogueError(`the ${prefix} catalogue has no rules array`);
  if (cat.rules.length !== count) throw new CatalogueError(`the ${prefix} catalogue holds ${cat.rules.length} rules, expected ${count}`);
  const seen = new Set();
  cat.rules.forEach((r, i) => {
    const expected = idFor(prefix, first + i);
    if (r.id !== expected) throw new CatalogueError(`catalogue rules[${i}] is ${JSON.stringify(r.id)}, expected ${expected}`, { index: i });
    if (seen.has(r.id)) throw new CatalogueError(`duplicate rule id ${r.id}`);
    seen.add(r.id);
    if (r.excel_row !== first + i + 1) throw new CatalogueError(`${r.id}: excel_row ${r.excel_row} is not ${first + i + 1}`);
    /* Phase 9: a rule the source states with no band (CSDM-072, "Composite") is declared on the sheet as exempt. */
    const exempt = r.base_severity == null && cat.severity_exempt?.[r.id];
    for (const f of REQUIRED_RULE_FIELDS) {
      if (f === 'base_severity' && exempt) continue;
      if (typeof r[f] !== 'string' || !r[f].trim()) throw new CatalogueError(`${r.id}: required field "${f}" is empty`);
    }
    if (!exempt && !SEVERITY_WORDS.includes(r.base_severity)) throw new CatalogueError(`${r.id}: base_severity "${r.base_severity}" is not a workbook band`);
  });
  return true;
}

export function validateWorkbookArchitecture(map, cat, { prefix, count, first = 1 }) {
  if (!map || !Array.isArray(map.entries)) throw new CatalogueError(`the ${prefix} architecture map has no entries array`);
  if (map.entries.length !== count) throw new CatalogueError(`the ${prefix} architecture map holds ${map.entries.length} entries, expected ${count}`);
  if (map.workbook_sha256 !== cat.source?.workbook_sha256) throw new CatalogueError(`the ${prefix} architecture map was built from a different workbook than the catalogue`);
  const archetypes = new Set(Object.keys(map.vocabularies?.archetypes || {}));
  const engines = new Set(Object.keys(map.vocabularies?.engines || {}));
  const products = map.vocabularies?.products ? new Set(Object.keys(map.vocabularies.products)) : null;
  map.entries.forEach((e, i) => {
    if (e.slot !== first + i || e.rule_id !== idFor(prefix, first + i)) throw new CatalogueError(`architecture entries[${i}] is slot ${e.slot} / ${e.rule_id}`);
    if (!archetypes.has(e.archetype)) throw new CatalogueError(`${e.rule_id}: unknown archetype ${e.archetype}`);
    if (!engines.has(e.recommended_engine)) throw new CatalogueError(`${e.rule_id}: unknown engine ${e.recommended_engine}`);
    for (const s of e.also_requires || []) if (!engines.has(s)) throw new CatalogueError(`${e.rule_id}: unknown supporting engine ${s}`);
    if (products && !products.has(e.product)) throw new CatalogueError(`${e.rule_id}: unknown product ${e.product}`);
    for (const d of e.dependencies?.consumes_output_of || []) if (!/^[A-Z]+-\d{3}$/.test(d)) throw new CatalogueError(`${e.rule_id}: dependency ${d} is not a rule id`);
  });
  return true;
}

/**
 * Load, validate and freeze one pack's catalogue.
 * @returns {{ prefix, meta, rules, byId, get(id), has(id), all() }}
 */
export function createWorkbookCatalogue({ prefix, count, first = 1, catalogue, architecture }) {
  validateWorkbookCatalogue(catalogue, { prefix, count, first });
  validateWorkbookArchitecture(architecture, catalogue, { prefix, count, first });
  const byId = new Map();
  const rules = catalogue.rules.map((r, i) => {
    const a = architecture.entries[i];
    const rule = Object.freeze({
      ...r,
      slot: first + i,
      architecture: Object.freeze({
        archetype: a.archetype,
        engine: a.recommended_engine,
        also_requires: list(a.also_requires),
        product: a.product ?? null,
        semantic_class: a.semantic_class ?? null,
        evaluation_level: a.evaluation_level ?? null,
        tables: list(a.tables),
        candidate_tables: list(a.candidate_tables),
        tables_undefined: Boolean(a.tables_undefined),
        fields: list(a.fields),
        data_requirements: Object.freeze({ ...(a.data_requirements || {}) }),
        dependencies: Object.freeze({
          consumes_output_of: list(a.dependencies?.consumes_output_of),
          interpret_with: list(a.dependencies?.interpret_with),
          related: list(a.dependencies?.related),
          external: list(a.dependencies?.external),
        }),
        result: Object.freeze({ ...(a.result || {}) }),
        time_window: a.time_window ?? null,
        notes: a.notes ?? null,
      }),
    });
    byId.set(rule.id, rule);
    return rule;
  });
  const meta = Object.freeze({
    prefix,
    catalogue_version: catalogue.catalogue_version ?? null,
    workbook: catalogue.source?.workbook ?? null,
    workbook_sha256: catalogue.source?.workbook_sha256 ?? null,
    map_version: architecture.map_version ?? null,
    rule_count: rules.length,
    groups_observed: list(catalogue.groups_observed),
  });
  const get = (id) => {
    const rule = byId.get(id);
    if (!rule) throw new CatalogueError(`${JSON.stringify(id)} is not a ${prefix} rule (${idFor(prefix, first)} … ${idFor(prefix, first + count - 1)})`);
    return rule;
  };
  return Object.freeze({ prefix, meta, rules: Object.freeze(rules), byId, get, has: (id) => byId.has(id), all: () => rules });
}
