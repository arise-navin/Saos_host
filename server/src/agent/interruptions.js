import { readJournal } from '../servicenow/flow-edit.js';
import { tasksForSession } from '../memory/tasks.js';
import { BOOT } from '../boot.js';

/**
 * JOB 1.2b — what a server restart left behind, told on the NEXT message.
 *
 * MEASURED 2026-09-25: a restart 21 s into a chat turn killed it; the browser
 * spun indefinitely and nothing afterwards said what had happened. Two things
 * can be left behind, and both are read here, never changed:
 *
 *   - an edit or restore whose journal is still on disk. It stopped part-way,
 *     every flow edit is refused until it is recovered, and restore_flow is the
 *     recovery (it needs no backup id: it reads the journal);
 *   - this chat's previous request, still open in the task table although it
 *     began before this server started — so the process running it is gone.
 *     The task is NOT resolved here (§17: a stale task stays observable). It is
 *     reported only while it is still the chat's newest task, so it is said once.
 */

const OPEN = new Set(['planned', 'running', 'awaiting_approval', 'blocked']);
/* Stages at which the edit had not yet sent anything to the instance. */
const BEFORE_LOAD = new Set(['started', 'source_written', 'built']);
const hhmm = (iso) => (iso ? `${String(iso).slice(11, 19)} UTC` : 'an unknown time');

export function interruptionNotices(sessionId, {
  excludeTaskId = null,
  bootStartedAt = BOOT.startedAt,
  journal = readJournal(),
  tasks = null,
} = {}) {
  const notices = [];
  if (journal) {
    const flow = journal.flow?.name ?? 'a flow';
    const reached = BEFORE_LOAD.has(journal.stage)
      ? 'It stopped before anything was sent to the instance, so the flow on the instance is unchanged.'
      : 'It stopped after the new version was sent to the instance, so the flow may be half-changed.';
    notices.push({
      kind: 'interrupted_edit',
      tool: journal.kind,
      flow,
      flowSysId: journal.flow?.sys_id ?? null,
      stage: journal.stage,
      startedAt: journal.startedAt ?? null,
      backupId: journal.backupId ?? null,
      text: `An ${journal.kind} of "${flow}" was interrupted at stage "${journal.stage}" (started ${hhmm(journal.startedAt)}). ${reached} `
        + `No flow can be edited until it is recovered: restore_flow on "${flow}" puts it back to the backup taken before that change `
        + `and publishes it again if it was live.`,
    });
  }
  let list = tasks;
  if (!list) { try { list = tasksForSession(sessionId, { limit: 5 }); } catch { list = []; } }
  const previous = (list || []).filter((t) => t.id !== excludeTaskId)[0];
  if (previous && OPEN.has(previous.state) && String(previous.created_at) < String(bootStartedAt)) {
    const began = previous.started_at ?? previous.created_at ?? '';
    const editWasPartOfIt = Boolean(journal?.startedAt) && String(journal.startedAt) >= String(began);
    notices.push({
      kind: 'interrupted_turn',
      taskId: previous.id,
      goal: previous.goal ?? null,
      startedAt: previous.started_at ?? previous.created_at ?? null,
      text: `Your previous request${previous.goal ? ` ("${String(previous.goal).slice(0, 160)}")` : ''} did not finish: `
        + `the server stopped while it was running (started ${hhmm(previous.started_at ?? previous.created_at)}). `
        + (editWasPartOfIt
          ? 'The interrupted edit above is part of it.'
          : 'No flow edit of it was in progress. Anything it had already changed is listed on the Audit page.'),
    });
  }
  return notices;
}

/** The same facts for the model, so its reply says them and offers restore_flow. Empty when there is nothing. */
export function noticeForModel(notices = []) {
  if (!notices.length) return '';
  return [
    'SERVER NOTICE — the server restarted, and this is what it interrupted. Tell the user this first, in plain words.',
    ...notices.map((n) => `- ${n.text}`),
    /*
     * JOB 1.2b follow-up — this said "Offer restore_flow", and the model did exactly that: it asked
     * "Shall I proceed with the restore now?" in prose (T2 chat, 2026-09-25) and the person had to
     * type "yes". The approval card is the confirmation, so the notice says to call the tool.
     * Measured with that wording alone: after a Reject the model called restore_flow 7 more times in
     * the same turn (each blocked as user-rejected), so the notice also says what to do on a Reject.
     */
    ...(notices.some((n) => n.kind === 'interrupted_edit')
      ? ['If this message asks for anything on a flow (a change, a retry, a restore, or whether a change went through), call restore_flow on that flow '
        + 'now (no backup_id needed; it reads the journal). Its approval card IS the confirmation: do not ask "shall I proceed?" in chat. '
        + 'Do not attempt any other flow edit before it. If the user rejects that card, do not call it again: say flow edits stay blocked '
        + 'until the restore is done, and stop.']
      : []),
  ].join('\n');
}
