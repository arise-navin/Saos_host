import { table } from './client.js';

function rawValue(value) {
  return value && typeof value === 'object' && 'value' in value ? value.value : value;
}

function hasValue(value) {
  const v = rawValue(value);
  return v !== undefined && v !== null && String(v).trim() !== '';
}

/**
 * ServiceNow's task rule "Abort changes on group" rejects an assigned user who
 * is not a member of the chosen assignment group. Check the pair before create
 * or update so the caller gets a useful refusal instead of a 403 after the POST.
 */
export async function validateIncidentAssignmentPair(payload = {}) {
  const assignedTo = rawValue(payload.assigned_to);
  const assignmentGroup = rawValue(payload.assignment_group);
  if (!hasValue(assignedTo) || !hasValue(assignmentGroup)) return null;

  const rows = await table.query('sys_user_grmember', {
    query: `user=${assignedTo}^group=${assignmentGroup}`,
    fields: 'sys_id,user,group',
    limit: 1,
    display: 'false',
  });
  if (rows.length) return null;

  return {
    ok: false,
    refused: true,
    reason: 'assigned_user_not_group_member',
    table: 'incident',
    fields: ['assigned_to', 'assignment_group'],
    message: 'Refused before execution: ServiceNow business rule "Abort changes on group" requires assigned_to to be a member of assignment_group. '
      + 'Choose an assignee who belongs to that group, omit assigned_to, or choose a matching group. Nothing was written.',
  };
}

export async function createIncident(payload = {}) {
  const refusal = await validateIncidentAssignmentPair(payload);
  if (refusal) return refusal;
  return table.create('incident', payload);
}
