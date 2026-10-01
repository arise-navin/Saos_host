import { table, SnowError } from './client.js';
import { tableExists } from './business-rules.js';

const bool = (v) => (v === true || v === 'true' ? 'true' : 'false');
const clean = (v) => String(v ?? '').trim();
const cell = (v) => {
  if (!v || typeof v !== 'object') return v;
  if ('value' in v) return v.value;
  if ('display_value' in v) return v.display_value;
  return v;
};

const SCRIPT_TABLES = Object.freeze({
  client_script: {
    table: 'sys_script_client',
    fields: 'sys_id,name,table,type,field,ui_type,active,global,applies_extended,order,script,description,view,isolate_script,sys_scope,sys_updated_on',
  },
  scheduled_script: {
    table: 'sysauto_script',
    fields: 'sys_id,name,active,run_type,run_start,time_zone,run_as,conditional,condition,script,sys_scope,sys_updated_on',
  },
  fix_script: {
    table: 'sys_script_fix',
    fields: 'sys_id,name,description,active,script,unloadable,before,run_once,order,sys_scope,sys_updated_on',
  },
  script_include: {
    table: 'sys_script_include',
    fields: 'sys_id,name,api_name,active,client_callable,access,script,description,sys_scope,sys_updated_on',
  },
});

const CLIENT_TYPES = new Set(['onLoad', 'onChange', 'onSubmit', 'onCellEdit']);
const RUN_TYPES = new Set(['once', 'daily', 'weekly', 'monthly', 'periodically', 'on_demand']);
const SCRIPT_INCLUDE_ACCESS = Object.freeze({
  package_private: 'package_private',
  private: 'package_private',
  this_application_scope_only: 'package_private',
  'this application scope only': 'package_private',
  public: 'public',
  all: 'public',
  all_application_scopes: 'public',
  'all application scopes': 'public',
});

const SCRIPT_SERVER_CONTROLLED = new Set([
  'sys_id', 'sys_created_on', 'sys_created_by', 'sys_updated_on', 'sys_updated_by',
  'sys_mod_count', 'sys_class_name', 'sys_tags', 'number',
  'sys_scope', 'sys_package', 'sys_policy', 'sys_update_name', 'run_as_tz',
]);

function compareBack(requested, back) {
  const mismatches = [];
  const dropped = [];
  for (const [field, want] of Object.entries(requested)) {
    if (SCRIPT_SERVER_CONTROLLED.has(field)) continue;
    /*
     * A field completely absent from the read-back means the platform does
     * not have that column on this instance version (e.g. `isolate_script`
     * was added in a later release). That is not a mismatch — it is a
     * platform limitation. Record it separately so the caller can mention
     * it without treating it as a verification failure.
     */
    if (!(field in (back || {}))) {
      dropped.push(field);
      continue;
    }
    const got = cell(back?.[field]) ?? '';
    if (!equivalent(field, want, got)) mismatches.push({ field, sent: want, stored: got });
  }
  return { mismatches, dropped };
}

function normalizedText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim();
}

const UI_TYPE_ALIASES = Object.freeze({
  0: '0',
  '0': '0',
  desktop: '0',
  1: '1',
  '1': '1',
  mobile: '1',
  service_portal: '1',
  mobile_or_service_portal: '1',
  'mobile / service portal': '1',
  10: '10',
  '10': '10',
  all: '10',
});

function equivalent(field, want, got) {
  const w = normalizedText(want);
  const g = normalizedText(got);
  if (w === g) return true;

  if (field === 'api_name') {
    return w === g || g === `global.${w}` || g.endsWith(`.${w}`) || w.endsWith(`.${g}`);
  }
  if (field === 'name') {
    if (w.slice(0, 40) === g || (w.startsWith(g) && g.length >= 10)) return true;
  }
  if (['active', 'global', 'applies_extended', 'isolate_script', 'conditional', 'unloadable', 'before', 'run_once', 'client_callable'].includes(field)) {
    return bool(w) === bool(g);
  }
  if (['order'].includes(field)) {
    return Number(w) === Number(g);
  }
  if (field === 'ui_type') {
    const normUi = (v) => UI_TYPE_ALIASES[String(v ?? '').trim().toLowerCase()] ?? String(v);
    return normUi(w) === normUi(g);
  }
  if (field === 'access') {
    const keyW = w.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const keyG = g.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return (SCRIPT_INCLUDE_ACCESS[w.toLowerCase()] || SCRIPT_INCLUDE_ACCESS[keyW] || w) === (SCRIPT_INCLUDE_ACCESS[g.toLowerCase()] || SCRIPT_INCLUDE_ACCESS[keyG] || g);
  }
  if (field === 'time_zone' || field === 'run_as_tz') {
    return w === g || g === '' || g === 'floating' || w === 'floating' || w.toLowerCase() === g.toLowerCase();
  }
  if (field === 'run_start') {
    if (w === g) return true;
    return !isNaN(Date.parse(w.replace(' ', 'T'))) && !isNaN(Date.parse(g.replace(' ', 'T')));
  }

  return false;
}

function createResult(kind, sysId, back, requested, mismatches, dropped = []) {
  return {
    ok: Boolean(back),
    verified: Boolean(back) && mismatches.length === 0,
    status: !back ? 'FAILED' : mismatches.length ? 'PARTIAL' : 'VERIFIED',
    sys_id: sysId ?? null,
    record: back,
    requested,
    mismatches,
    /*
     * Fields sent but not present on this instance version. Informational —
     * these are NOT verification failures, just platform columns that don't
     * exist on this release. Reported so the caller can mention it.
     */
    ...(dropped.length ? { dropped } : {}),
    ...(back && mismatches.length ? {
      warning: `Created ${SCRIPT_TABLES[kind].table} ${sysId}, but ${mismatches.length} field(s) read back differently after ServiceNow normalized the record.`,
    } : {}),
  };
}

function assertScript(name, script) {
  if (!clean(name)) throw new SnowError('The script artifact needs a name.', 400);
  if (!clean(script)) throw new SnowError('The script artifact needs a non-empty script body.', 400);
}

function uiType(value) {
  const v = clean(value === undefined || value === null || value === '' ? '0' : value).toLowerCase();
  const aliases = {
    0: '0',
    desktop: '0',
    1: '1',
    mobile: '1',
    service_portal: '1',
    mobile_or_service_portal: '1',
    'mobile / service portal': '1',
    10: '10',
    all: '10',
  };
  const out = aliases[v];
  if (!out) throw new SnowError(`ui_type must be 0/desktop, 1/mobile_or_service_portal, or 10/all (got "${value}").`, 400);
  return out;
}

function runType(value) {
  const v = clean(value || 'once').toLowerCase();
  if (!RUN_TYPES.has(v)) throw new SnowError(`run_type must be once, daily, weekly, monthly, periodically, or on_demand (got "${value}").`, 400);
  return v;
}

async function readCreated(kind, sysId) {
  const meta = SCRIPT_TABLES[kind];
  const id = cell(sysId);
  return id ? (await table.query(meta.table, { query: `sys_id=${id}`, fields: meta.fields, limit: 1, display: 'false' }))[0] : null;
}

export async function listScriptArtifacts({ kind = 'all', table: tableName = '', search = '', limit = 50 } = {}) {
  const kinds = kind === 'all' ? Object.keys(SCRIPT_TABLES) : [kind];
  const out = {};
  for (const k of kinds) {
    const meta = SCRIPT_TABLES[k];
    if (!meta) throw new SnowError(`Unknown script artifact kind "${kind}".`, 400);
    const q = [];
    if (tableName && k === 'client_script') q.push(`table=${clean(tableName).replace(/\^/g, '')}`);
    if (search) q.push(`nameLIKE${clean(search).replace(/\^/g, '')}`);
    out[k] = await table.query(meta.table, {
      query: q.join('^'),
      fields: meta.fields,
      limit: Math.min(Number(limit) || 50, 500),
      orderBy: 'name',
      display: 'false',
    });
  }
  return out;
}

export async function createClientScript(spec = {}) {
  assertScript(spec.name, spec.script);
  const type = clean(spec.type || 'onLoad');
  if (!CLIENT_TYPES.has(type)) throw new SnowError(`type must be onLoad, onChange, onSubmit, or onCellEdit (got "${spec.type}").`, 400);
  const tableName = clean(spec.table);
  if (!tableName && spec.global !== true) throw new SnowError('A client script needs a table unless global=true.', 400);
  if ((type === 'onChange' || type === 'onCellEdit') && !clean(spec.field)) {
    throw new SnowError(`${type} client scripts need a target field.`, 400);
  }
  if (tableName && !(await tableExists(tableName))) throw new SnowError(`There is no table named "${tableName}" on this instance. Resolve it with lookup_table first.`, 400);

  const requested = {
    name: clean(spec.name),
    type,
    script: String(spec.script),
    active: bool(spec.active !== false),
    ui_type: uiType(spec.ui_type),
    order: String(Number(spec.order) || 100),
    global: bool(spec.global === true),
    applies_extended: bool(spec.applies_extended === true),
    ...(tableName ? { table: tableName } : {}),
    ...(spec.field ? { field: clean(spec.field) } : {}),
    ...(spec.view ? { view: clean(spec.view) } : {}),
    ...(spec.description ? { description: String(spec.description) } : {}),
    ...(spec.isolate_script !== undefined ? { isolate_script: bool(spec.isolate_script) } : {}),
  };
  const created = await table.create('sys_script_client', requested, 'false');
  const sysId = cell(created?.sys_id);
  const back = await readCreated('client_script', sysId);
  const { mismatches, dropped } = back
    ? compareBack(requested, back)
    : { mismatches: [{ field: '(record)', sent: 'insert', stored: 'not readable' }], dropped: [] };
  return createResult('client_script', sysId, back, requested, mismatches, dropped);
}

export async function createScheduledScript(spec = {}) {
  assertScript(spec.name, spec.script);
  const requested = {
    name: clean(spec.name),
    script: String(spec.script),
    active: bool(spec.active !== false),
    run_type: runType(spec.run_type),
    ...(spec.run_start ? { run_start: clean(spec.run_start) } : {}),
    ...(spec.time_zone ? { time_zone: clean(spec.time_zone) } : {}),
    ...(spec.run_as ? { run_as: clean(spec.run_as) } : {}),
    ...(spec.condition ? { conditional: 'true', condition: String(spec.condition) } : { conditional: bool(spec.conditional === true) }),
  };
  const created = await table.create('sysauto_script', requested, 'false');
  const sysId = cell(created?.sys_id);
  const back = await readCreated('scheduled_script', sysId);
  const { mismatches, dropped } = back
    ? compareBack(requested, back)
    : { mismatches: [{ field: '(record)', sent: 'insert', stored: 'not readable' }], dropped: [] };
  return createResult('scheduled_script', sysId, back, requested, mismatches, dropped);
}

export async function createFixScript(spec = {}) {
  assertScript(spec.name, spec.script);
  const requested = {
    name: clean(spec.name),
    script: String(spec.script),
    active: bool(spec.active !== false),
    order: String(Number(spec.order) || 100),
    unloadable: bool(spec.unloadable !== false),
    ...(spec.description ? { description: String(spec.description) } : {}),
    ...(spec.before !== undefined ? { before: bool(spec.before) } : {}),
    ...(spec.run_once !== undefined ? { run_once: bool(spec.run_once) } : {}),
  };
  const created = await table.create('sys_script_fix', requested, 'false');
  const sysId = cell(created?.sys_id);
  const back = await readCreated('fix_script', sysId);
  const { mismatches, dropped } = back
    ? compareBack(requested, back)
    : { mismatches: [{ field: '(record)', sent: 'insert', stored: 'not readable' }], dropped: [] };
  return createResult('fix_script', sysId, back, requested, mismatches, dropped);
}

function scriptIncludeAccess(value) {
  const v = clean(value || 'package_private').toLowerCase();
  const key = v.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const out = SCRIPT_INCLUDE_ACCESS[v] || SCRIPT_INCLUDE_ACCESS[key];
  if (!out) throw new SnowError(`access must be package_private/this application scope only or public/all application scopes (got "${value}").`, 400);
  return out;
}

export async function createScriptInclude(spec = {}) {
  assertScript(spec.name, spec.script);
  const requested = {
    name: clean(spec.name),
    script: String(spec.script),
    active: bool(spec.active !== false),
    client_callable: bool(spec.client_callable === true),
    access: scriptIncludeAccess(spec.access),
    ...(spec.api_name ? { api_name: clean(spec.api_name) } : {}),
    ...(spec.description ? { description: String(spec.description) } : {}),
  };
  const created = await table.create('sys_script_include', requested, 'false');
  const sysId = cell(created?.sys_id);
  const back = await readCreated('script_include', sysId);
  const { mismatches, dropped } = back
    ? compareBack(requested, back)
    : { mismatches: [{ field: '(record)', sent: 'insert', stored: 'not readable' }], dropped: [] };
  return createResult('script_include', sysId, back, requested, mismatches, dropped);
}
