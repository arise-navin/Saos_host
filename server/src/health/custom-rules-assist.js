import { chatOnce } from '../agent/providers/index.js';
import { log } from '../logging.js';
import { CUSTOM_KINDS, CUSTOM_OPERATORS, CUSTOM_SEVERITIES, CUSTOM_MODULES } from './custom-rules.js';

/**
 * AI ASSIST for a custom rule (D-038): a description in plain English → a proposed
 * definition (table, conditions, kind, severity, limit). It PROPOSES only: nothing is
 * saved, the person reviews every field, and the preview checks the table and fields
 * on the instance before the rule can be trusted. A failure here never blocks
 * anything — every rule can be built by hand.
 */

export const CUSTOM_ASSIST_TIMEOUT_MS = 90_000;

export class CustomAssistError extends Error {
  constructor(message, status = 502) { super(message); this.name = 'CustomAssistError'; this.status = status; }
}

function extractJson(raw) {
  const body = String(raw ?? '').replace(/```(?:json)?/gi, '');
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

export function buildCustomAssistPrompt({ description, module, dimensions }) {
  const system = [
    'You turn a ServiceNow health check described in plain English into ONE structured rule definition.',
    'Reply with a single JSON object and nothing else, of this exact shape:',
    '{"name": string, "kind": "record"|"rate"|"age", "table": string, "scope": [{"field","op","value"}], "conditions": [{"field","op","value"}],',
    ' "threshold": {"max_share": number} | null, "age": {"field": string, "days": number} | null, "severity": string, "dimension": string, "explanation": string}',
    'Kinds: "record" — every record matching the conditions is a problem; "rate" — fail when the share of matching records exceeds max_share percent;',
    '"age" — records (matching the conditions) whose date field is older than N days.',
    `Operators: ${CUSTOM_OPERATORS.join(', ')}. ISEMPTY / ISNOTEMPTY take an empty value. IN / NOT IN take comma-separated values.`,
    'Use real ServiceNow table and field names (incident, change_request, cmdb_ci_server, sys_user, assignment_group, priority, active, state …) and stored choice VALUES, not labels (priority=1, not "Critical").',
    '"scope" narrows the population (e.g. active=true); "conditions" are what makes a record a problem.',
    `Severity is one of ${CUSTOM_SEVERITIES.join(', ')}. "dimension" is one of the area keys given.`,
    'If the description cannot be expressed with one table and these operators (it needs relationships between tables, several tables, or a script), reply {"unsupported": "<one sentence why>"}.',
  ].join('\n');
  const user = JSON.stringify({ description, module: CUSTOM_MODULES[module]?.label ?? module, areas: dimensions.map((d) => ({ key: d.key, label: d.label })), kinds: CUSTOM_KINDS });
  return { system, user };
}

/** Propose a definition for `description` in `module`. `{ proposal, explanation }` or `{ unsupported }`. */
export async function suggestCustomRule({ description, module, dimensions }, { generate = chatOnce, timeoutMs = CUSTOM_ASSIST_TIMEOUT_MS } = {}) {
  const d = String(description ?? '').trim();
  if (!d) throw new CustomAssistError('Describe what the rule should check first — the proposal is made from it.', 422);
  if (!CUSTOM_MODULES[module]) throw new CustomAssistError('Choose the module first.', 422);
  const { system, user } = buildCustomAssistPrompt({ description: d, module, dimensions });
  let raw;
  try {
    raw = await generate({ system, user, maxTokens: 2048, decoding: { temperature: 0 }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    log.warn('health', `custom rule assist: model call failed — ${err?.message || err}`);
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new CustomAssistError(timedOut ? 'The model did not answer in time. Build the rule by hand, or try again.' : 'The configured model could not be reached. Build the rule by hand, or try again.');
  }
  const obj = extractJson(raw);
  if (!obj) throw new CustomAssistError('The model\'s answer was not a rule definition. Build the rule by hand, or rephrase and try again.');
  if (obj.unsupported) return { unsupported: String(obj.unsupported).slice(0, 300) };
  const proposal = {
    name: String(obj.name ?? '').slice(0, 120),
    module,
    kind: CUSTOM_KINDS.includes(obj.kind) ? obj.kind : 'record',
    table: String(obj.table ?? '').toLowerCase(),
    scope: Array.isArray(obj.scope) ? obj.scope.slice(0, 10) : [],
    conditions: Array.isArray(obj.conditions) ? obj.conditions.slice(0, 10) : [],
    threshold: obj.threshold && Number.isFinite(Number(obj.threshold.max_share)) ? { max_share: Number(obj.threshold.max_share) } : null,
    age: obj.age && obj.age.field ? { field: String(obj.age.field), days: Number(obj.age.days) } : null,
    severity: CUSTOM_SEVERITIES.includes(String(obj.severity).toUpperCase()) ? String(obj.severity).toUpperCase() : 'MEDIUM',
    dimension: dimensions.some((x) => x.key === obj.dimension) ? obj.dimension : (dimensions[0]?.key ?? ''),
    description: d,
  };
  return { proposal, explanation: String(obj.explanation ?? '').slice(0, 500) };
}
