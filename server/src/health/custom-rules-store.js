import { getDb } from '../memory/db.js';
import { validateCustomRule, customPrefixOf, CustomRuleError } from './custom-rules.js';
import { workbookIndex } from './modules.js';
import { logRuleChange } from './rule-overrides.js';

/**
 * Storage of custom rules (D-038). A rule is validated before every write, and its
 * id is minted once — CUSTOM-<MODULE>-NNN — and never reused, so a finding stored
 * under it keeps meaning the same rule. The module is part of the id and cannot be
 * changed afterwards (save a new rule instead).
 */

const nowIso = () => new Date().toISOString();
const dimensionsOf = (module) => workbookIndex().dimensions(module);

function rowToRule(r) {
  const def = JSON.parse(r.definition_json);
  return { rule_id: r.rule_id, ...def, module: r.module, active: Boolean(r.active), created_by: r.created_by ?? null, created_at: r.created_at, updated_at: r.updated_at };
}

export function listCustomRules({ module = null, activeOnly = false } = {}) {
  const rows = getDb().prepare(`SELECT * FROM health_custom_rules ${module ? 'WHERE module = ?' : ''} ORDER BY rule_id`).all(...(module ? [module] : []));
  const rules = rows.map(rowToRule).filter((r) => !r.deleted);
  return activeOnly ? rules.filter((r) => r.active) : rules;
}

export function getCustomRule(ruleId) {
  const r = getDb().prepare('SELECT * FROM health_custom_rules WHERE rule_id = ?').get(String(ruleId));
  const rule = r ? rowToRule(r) : null;
  return rule && !rule.deleted ? rule : null;
}

function nextId(module) {
  const prefix = customPrefixOf(module);
  const rows = getDb().prepare('SELECT rule_id FROM health_custom_rules WHERE rule_id LIKE ?').all(`${prefix}%`);
  const max = rows.reduce((n, r) => Math.max(n, Number(String(r.rule_id).slice(prefix.length)) || 0), 0);
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}

const stored = (def) => {
  const { module, active, ...rest } = def;
  return JSON.stringify(rest);
};

export function createCustomRule(input, { user = null } = {}) {
  const def = validateCustomRule(input, { dimensionsOf });
  const db = getDb();
  db.exec('BEGIN');
  try {
    const id = nextId(def.module);
    const at = nowIso();
    db.prepare('INSERT INTO health_custom_rules (rule_id, module, definition_json, active, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, def.module, stored(def), def.active ? 1 : 0, user, at, at);
    db.exec('COMMIT');
    /* Job HC-1: every rule change is logged, so the Rulebook can say what no scan reflects yet. */
    logRuleChange({ ruleId: id, module: def.module, action: 'created', summary: `custom rule added: ${def.name}${def.active ? '' : ' (switched off)'}`, actor: user });
    return getCustomRule(id);
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}

export function updateCustomRule(ruleId, input, { user = null } = {}) {
  const cur = getCustomRule(ruleId);
  if (!cur) throw new CustomRuleError(`No custom rule ${ruleId}.`, 404);
  const merged = { ...cur, ...input, module: cur.module };
  if (input?.module && input.module !== cur.module) throw new CustomRuleError('A rule\'s module is part of its id and cannot change — save a new rule in the other module instead.');
  const def = validateCustomRule(merged, { dimensionsOf });
  getDb().prepare('UPDATE health_custom_rules SET definition_json = ?, active = ?, updated_at = ? WHERE rule_id = ?')
    .run(stored(def), def.active ? 1 : 0, nowIso(), cur.rule_id);
  const next = getCustomRule(cur.rule_id);
  const { active: a0, updated_at: u0, ...before } = cur;
  const { active: a1, updated_at: u1, ...after } = next;
  const edited = JSON.stringify(before) !== JSON.stringify(after);
  const summary = [a0 !== a1 ? (a1 ? 'switched on' : 'switched off') : null, edited ? 'edited' : null].filter(Boolean).join('; ');
  if (summary) logRuleChange({ ruleId: cur.rule_id, module: cur.module, action: edited ? 'edited' : (a1 ? 'switched_on' : 'switched_off'), summary, actor: user });
  return next;
}

/*
 * Deleting keeps a tombstone: the row stays, marked deleted and switched off, so its
 * id is never minted again — findings stored under it keep naming the same rule.
 */
export function deleteCustomRule(ruleId, { user = null } = {}) {
  const cur = getCustomRule(ruleId);
  if (!cur) throw new CustomRuleError(`No custom rule ${ruleId}.`, 404);
  const row = getDb().prepare('SELECT definition_json FROM health_custom_rules WHERE rule_id = ?').get(cur.rule_id);
  const def = { ...JSON.parse(row.definition_json), deleted: true };
  getDb().prepare('UPDATE health_custom_rules SET definition_json = ?, active = 0, updated_at = ? WHERE rule_id = ?').run(JSON.stringify(def), nowIso(), cur.rule_id);
  logRuleChange({ ruleId: cur.rule_id, module: cur.module, action: 'deleted', summary: `custom rule deleted: ${cur.name}`, actor: user });
  return { deleted: cur.rule_id };
}
