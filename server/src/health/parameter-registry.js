import { ITOM } from './itom/pack.js';
import { PLATFORM } from './platform/pack.js';
import { ENTERPRISE_DQ } from './enterprise_dq/pack.js';
import { CSDM } from './csdm/pack.js';
import { ITIL } from './itil/pack.js';
import { OVERALL_MODULES, OVERALL_WEIGHT_DEFAULTS, OVERALL_WEIGHTS_STATUS } from './overall-health.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SIGNAL_DEFAULTS } from './cmdb-signals.js';
import { GATE_DEFAULTS } from './cmdb-gate.js';
import { COMPLETENESS_DEFAULTS } from './cmdb-completeness.js';
import { CORRECTNESS_DEFAULTS } from './cmdb-correctness.js';
import { UNIQUENESS_DEFAULTS } from './cmdb-uniqueness.js';
import { IDENTIFICATION_DEFAULTS } from './cmdb-identification.js';
import { RELATIONSHIP_DEFAULTS } from './cmdb-relationships.js';
import { FRESHNESS_DEFAULTS } from './cmdb-freshness.js';
import { LIFECYCLE_DEFAULTS } from './cmdb-lifecycle.js';
import { GOVERNANCE_DEFAULTS } from './cmdb-governance.js';
import { OWNERSHIP_DEFAULTS } from './cmdb-ownership.js';
import { CSDM_DEFAULTS } from './cmdb-csdm.js';
import { CONSUMPTION_DEFAULTS } from './cmdb-consumption.js';
import { SCALE_DEFAULTS } from './cmdb-scale.js';
import { DRIFT_DEFAULTS } from './cmdb-drift.js';

/**
 * THE HEALTH ASSIST PARAMETER REGISTRY — Phase 1 of docs/HEALTH-ASSIST-APPROACH.md (§4.3).
 *
 * Every tunable resolves in three layers:
 *
 *   SAOS default (code)  →  instance override (health_parameters, per bound instance)
 *                        →  runtime override (one run; recorded on it; never a baseline)
 *
 * This generalises what ITSM has had since its Phase 5 (itsm/parameters.js) to
 * the CMDB rule packs, whose thresholds were code defaults nobody could change.
 * ITSM keeps its own registry and table: its parameters are declared per rule
 * from the workbook, while CMDB's are declared per rule PACK, because one pack
 * key often tunes several rules (`dqInactiveInstallStatus` scopes ten).
 *
 * THE DEFAULT VALUE LIVES IN CODE. Each pack's `*_DEFAULTS` is the one source of
 * a default; `rules/workbook/params/cmdb-packs.json` declares its type, unit,
 * bounds, class and the rules it tunes, and keeps a snapshot of the default so a
 * silent code change fails the suite until someone reviews it.
 *
 * ZERO CHANGE WITHOUT OVERRIDES. A pack receives only the keys that were
 * overridden (its own `{ ...DEFAULTS, ...options }` supplies the rest), so with
 * no override every pack runs exactly as before. The instance-override
 * fingerprint joins the CMDB engine key only when there is one, so a deployment
 * with no overrides keeps its engine key.
 *
 * VALIDATED, NEVER GUESSED. A value is checked against its declaration before it
 * is stored and again before it is used. A pattern, a nested map or anything the
 * declaration marks not overridable is refused with the reason. Nothing here
 * reads the instance or the database: the caller passes the stored rows in.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DECLARATIONS_FILE = path.join(HERE, 'rules', 'workbook', 'params', 'cmdb-packs.json');

/** Scope → the pack's defaults. The scope is the key a pack reads its options under. */
export const CMDB_PARAMETER_PACKS = Object.freeze({
  signals: { label: 'Severity signals and materiality', file: 'cmdb-signals.js', defaults: SIGNAL_DEFAULTS },
  gate: { label: 'Health configuration meta (Group 1)', file: 'cmdb-gate.js', defaults: GATE_DEFAULTS },
  completeness: { label: 'Completeness D1 (Group 2)', file: 'cmdb-completeness.js', defaults: COMPLETENESS_DEFAULTS },
  correctness: { label: 'Correctness D2 (Group 3)', file: 'cmdb-correctness.js', defaults: CORRECTNESS_DEFAULTS },
  uniqueness: { label: 'Uniqueness D3 (Group 4)', file: 'cmdb-uniqueness.js', defaults: UNIQUENESS_DEFAULTS },
  identification: { label: 'Identification and reconciliation D4/D5 (Group 5)', file: 'cmdb-identification.js', defaults: IDENTIFICATION_DEFAULTS },
  relationships: { label: 'Relationships D6 (Group 6)', file: 'cmdb-relationships.js', defaults: RELATIONSHIP_DEFAULTS },
  freshness: { label: 'Freshness D7 (Group 7)', file: 'cmdb-freshness.js', defaults: FRESHNESS_DEFAULTS },
  lifecycle: { label: 'Lifecycle D8 (Group 8)', file: 'cmdb-lifecycle.js', defaults: LIFECYCLE_DEFAULTS },
  governance: { label: 'Data Manager and attestation (Group 9)', file: 'cmdb-governance.js', defaults: GOVERNANCE_DEFAULTS },
  ownership: { label: 'Ownership D9 (Group 10)', file: 'cmdb-ownership.js', defaults: OWNERSHIP_DEFAULTS },
  csdm: { label: 'CSDM linkage (Group 11)', file: 'cmdb-csdm.js', defaults: CSDM_DEFAULTS },
  consumption: { label: 'Consumption and trust D10 (Group 12)', file: 'cmdb-consumption.js', defaults: CONSUMPTION_DEFAULTS },
  scale: { label: 'Scale and platform impact (Group 13)', file: 'cmdb-scale.js', defaults: SCALE_DEFAULTS },
  drift: { label: 'Drift and regression (Group 14)', file: 'cmdb-drift.js', defaults: DRIFT_DEFAULTS },
});

/**
 * The modules whose parameters this registry resolves. ITSM has its own (itsm/parameters.js).
 * ITOM (Health Assist Phase 5) is here: its declarations are the ITOM pack's (scope = the
 * rule id, key = the parameter), its overrides live in the same health_parameters table.
 */
/* Phase 8: `overall` — the Overall's module weights (scope `weights`, one key per module). */
export const PARAMETER_MODULES = Object.freeze(['cmdb', 'itom', 'platform', 'enterprise_dq', 'csdm', 'itil', 'overall']);

export class ParameterRegistryError extends Error {
  constructor(message, status = 422) { super(message); this.name = 'ParameterRegistryError'; this.status = status; }
}

/** A default as JSON: a pattern becomes `{ $regex, flags }`, recursively. */
export function describeDefault(value) {
  if (value instanceof RegExp) return { $regex: value.source, flags: value.flags };
  if (Array.isArray(value)) return value.map(describeDefault);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, describeDefault(v)]));
  return value;
}

let declarationsCache = null;
function declarationFile() {
  if (!declarationsCache) declarationsCache = JSON.parse(fs.readFileSync(DECLARATIONS_FILE, 'utf8'));
  return declarationsCache;
}

/** Every CMDB declaration: code default + metadata. */
export function cmdbDeclarations() {
  const file = declarationFile();
  const out = [];
  for (const [scope, pack] of Object.entries(CMDB_PARAMETER_PACKS)) {
    for (const [key, value] of Object.entries(pack.defaults)) {
      const meta = file.scopes?.[scope]?.keys?.[key];
      out.push({
        module: 'cmdb', scope, key,
        scope_label: pack.label,
        declared: Boolean(meta),
        type: meta?.type ?? null,
        unit: meta?.unit ?? null,
        min: meta?.min ?? null,
        max: meta?.max ?? null,
        nullable: Boolean(meta?.nullable),
        class: meta?.class ?? null,
        overridable: Boolean(meta?.overridable),
        not_overridable_because: meta?.not_overridable_because ?? (meta ? null : 'Not declared in rules/workbook/params/cmdb-packs.json.'),
        rules: meta?.rules ?? [],
        note: meta?.note ?? null,
        reviewed: Boolean(meta?.reviewed),
        default: describeDefault(value),
        default_source: 'saos_default',
      });
    }
  }
  return out;
}

/**
 * Every ITOM declaration (Phase 5): each ITOM rule's thresholds, typed, with the
 * workbook's default — or none, where the workbook leaves the value to the customer
 * ("configurable", "from the customer's policy"). Such a rule is UNCONFIGURED until
 * an override is set here; nothing is suggested in its place.
 */
export function packDeclarations(module, registry) {
  return [...registry.definitions.values()].map((d) => ({
    module, scope: d.rule, key: d.key,
    scope_label: d.rule,
    declared: true,
    type: d.type,
    unit: d.unit ?? null,
    min: ['number', 'duration', 'percent'].includes(d.type) ? 0 : null,
    max: d.type === 'percent' ? 100 : null,
    nullable: false,
    class: 'threshold',
    overridable: true,
    not_overridable_because: null,
    rules: [d.rule],
    note: d.description ?? null,
    reviewed: false,
    default: d.default,
    default_source: d.status === 'DEFINED' ? 'workbook' : 'undefined_in_workbook',
    workbook_text: d.workbook_text ?? null,
  }));
}

export const itomDeclarations = () => packDeclarations('itom', ITOM.parameters);
export const platformDeclarations = () => packDeclarations('platform', PLATFORM.parameters);
export const enterpriseDqDeclarations = () => packDeclarations('enterprise_dq', ENTERPRISE_DQ.parameters);
export const csdmDeclarations = () => packDeclarations('csdm', CSDM.parameters);
export const itilDeclarations = () => packDeclarations('itil', ITIL.parameters);

/**
 * HEALTH ASSIST PHASE 8 — the Overall's module weights (overall-health/2). Equal and
 * NOT REVIEWED until SAOS sets them (approach §9); 0 takes a module out of the
 * Overall without hiding it. A change is a new Overall series (the key hashes them).
 */
export const overallDeclarations = () => OVERALL_MODULES.map((m) => ({
  module: 'overall', scope: 'weights', key: m,
  scope_label: 'Overall module weights',
  declared: true, type: 'number', unit: null, min: 0, max: 100, nullable: false,
  class: 'weight', overridable: true, not_overridable_because: null,
  rules: [], note: OVERALL_WEIGHTS_STATUS, reviewed: false,
  default: OVERALL_WEIGHT_DEFAULTS[m], default_source: 'saos_default', workbook_text: null,
}));
/** The weights a resolution of the `overall` module gives: the defaults, with its overrides. */
export const overallWeightsFrom = (resolved) => ({ ...OVERALL_WEIGHT_DEFAULTS, ...(resolved?.options?.weights || {}) });

const declarationsOf = (module) => (module === 'cmdb' ? cmdbDeclarations() : module === 'itom' ? itomDeclarations() : module === 'platform' ? platformDeclarations() : module === 'enterprise_dq' ? enterpriseDqDeclarations() : module === 'csdm' ? csdmDeclarations() : module === 'itil' ? itilDeclarations() : module === 'overall' ? overallDeclarations() : []);

export function findDeclaration(module, scope, key) {
  if (!PARAMETER_MODULES.includes(module)) return null;
  return declarationsOf(module).find((d) => d.scope === scope && d.key === key) ?? null;
}

const IPV4_CIDR = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}\/(3[0-2]|[12]?\d)$/;

/** Check a value against its declaration. Returns the value to use, or why it is refused. */
export function validateParameterValue(decl, value) {
  if (!decl) return { ok: false, reason: 'no such parameter' };
  if (!decl.declared) return { ok: false, reason: 'the parameter is not declared' };
  if (!decl.overridable) return { ok: false, reason: decl.not_overridable_because || 'not overridable' };
  if (value === null) return decl.nullable ? { ok: true, value: null } : { ok: false, reason: 'a value is required' };
  const bounded = (n) => {
    if (typeof n !== 'number' || !Number.isFinite(n)) return 'must be a finite number';
    if (decl.min != null && n < decl.min) return `must be ≥ ${decl.min}`;
    if (decl.max != null && n > decl.max) return `must be ≤ ${decl.max}`;
    return null;
  };
  switch (decl.type) {
    case 'number': case 'percent': case 'duration': {
      const why = bounded(value);
      return why ? { ok: false, reason: `${decl.key} ${why}` } : { ok: true, value };
    }
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true, value } : { ok: false, reason: `${decl.key} must be true or false` };
    case 'string':
      return typeof value === 'string' && value.trim() && value.length <= 200
        ? { ok: true, value: value.trim() } : { ok: false, reason: `${decl.key} must be a non-empty string of at most 200 characters` };
    case 'list': case 'cidr_list': {
      if (!Array.isArray(value) || value.length > 500) return { ok: false, reason: `${decl.key} must be a list of at most 500 values` };
      const items = value.map((x) => (typeof x === 'string' ? x.trim() : x));
      if (items.some((x) => typeof x !== 'string' || !x || x.length > 200)) return { ok: false, reason: `${decl.key} must contain non-empty strings` };
      if (decl.type === 'cidr_list') {
        const bad = items.filter((x) => !IPV4_CIDR.test(x));
        if (bad.length) return { ok: false, reason: `${decl.key}: not IPv4 CIDR notation: ${bad.slice(0, 3).join(', ')}` };
      }
      return { ok: true, value: [...new Set(items)] };
    }
    case 'number_map': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: `${decl.key} must be an object` };
      const expected = Object.keys(decl.default).sort();
      if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected)) {
        return { ok: false, reason: `${decl.key} must have exactly the keys ${expected.join(', ')}` };
      }
      for (const [k, v] of Object.entries(value)) {
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return { ok: false, reason: `${decl.key}.${k} must be a non-negative number` };
      }
      return { ok: true, value: { ...value } };
    }
    default:
      return { ok: false, reason: `${decl.key} has type ${decl.type}, which is not overridable` };
  }
}

const hash = (payload) => crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);

/**
 * Resolve a module's parameters for one scan.
 *
 * @param {string} module                 'cmdb'
 * @param {object} args
 * @param {object[]} [args.instance]      stored rows: { scope, key, value, set_by, set_at }
 * @param {object}   [args.runtime]       { scope: { key: value } } for this run only
 * @returns {{ options: Record<string, object>, applied: object[], rejected: object[], fingerprint: string|null }}
 *   `options[scope]` holds ONLY overridden keys — the pack's own defaults fill the rest.
 *   `fingerprint` hashes the applied INSTANCE overrides (the engine-key input); null when there are none.
 */
export function resolveParameters(module, { instance = [], runtime = {} } = {}) {
  if (!PARAMETER_MODULES.includes(module)) throw new ParameterRegistryError(`no parameter registry for module "${module}"`);
  const options = {};
  const applied = [];
  const rejected = [];
  /* The instance layer, kept apart: a runtime override of the same key wins for
     the run but must not remove the instance override from the fingerprint. */
  const instanceApplied = [];
  const apply = (scope, key, value, source, extra = {}) => {
    const decl = findDeclaration(module, scope, key);
    const v = validateParameterValue(decl, value);
    if (!v.ok) { rejected.push({ scope, key, value, source, reason: v.reason }); return; }
    (options[scope] ||= {})[key] = v.value;
    const i = applied.findIndex((a) => a.scope === scope && a.key === key);
    const row = { scope, key, value: v.value, source, ...extra };
    if (i >= 0) applied[i] = row; else applied.push(row);
    if (source === 'instance') instanceApplied.push([scope, key, v.value]);
  };
  for (const r of instance) apply(r.scope, r.key, r.value, 'instance', { set_by: r.set_by ?? null, set_at: r.set_at ?? null });
  for (const [scope, keys] of Object.entries(runtime || {})) {
    for (const [key, value] of Object.entries(keys || {})) apply(scope, key, value, 'runtime');
  }
  instanceApplied.sort((a, b) => `${a[0]}.${a[1]}`.localeCompare(`${b[0]}.${b[1]}`));
  return { options, applied, rejected, fingerprint: instanceApplied.length ? hash({ module, overrides: instanceApplied }) : null };
}

/** Validate a runtime override object up front (the POST /runs body), without applying it. */
export function validateRuntimeOverrides(module, runtime) {
  if (runtime == null) return [];
  if (typeof runtime !== 'object' || Array.isArray(runtime)) return [`${module} parameters must be an object of { scope: { key: value } }`];
  const problems = [];
  for (const [scope, keys] of Object.entries(runtime)) {
    if (!keys || typeof keys !== 'object' || Array.isArray(keys)) { problems.push(`${scope}: must be an object of { key: value }`); continue; }
    for (const [key, value] of Object.entries(keys)) {
      const v = validateParameterValue(findDeclaration(module, scope, key), value);
      if (!v.ok) problems.push(`${scope}.${key}: ${v.reason}`);
    }
  }
  return problems;
}

/** Every declaration with its resolved value and where it came from — the settings API shape. */
export function describeModuleParameters(module, instance = []) {
  const { options, applied, rejected } = resolveParameters(module, { instance });
  const decls = declarationsOf(module);
  return {
    module,
    parameters: decls.map((d) => {
      const a = applied.find((x) => x.scope === d.scope && x.key === d.key);
      return {
        ...d,
        value: a ? describeDefault(options[d.scope][d.key]) : d.default,
        source: a ? a.source : 'default',
        set_by: a?.set_by ?? null,
        set_at: a?.set_at ?? null,
      };
    }),
    rejected_overrides: rejected,
  };
}
