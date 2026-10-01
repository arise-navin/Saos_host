/**
 * JOB 1.2b — the turn a chat is running right now, readable by ANY window.
 *
 * A turn's event stream belongs to the request that started it. When that
 * stream is somewhere else — another tab, a script, a tab that lost its
 * connection — a window opening the same chat could not tell that a turn was
 * running, what it was doing, or that an approval card was waiting. That is
 * how the 2026-09-25 T5 turn looked from the browser: a spinner, then nothing.
 *
 * In memory on purpose: it describes a live process, and a restart ends every
 * turn it holds (the next message says so — see interruptions.js).
 */
const turns = new Map(); // sessionId -> { taskId, startedAt, lastEvent, lastAt }

/* The frames that say where a turn is. Everything else leaves `lastEvent` alone. */
const STEP_FRAMES = new Set(['tool_use', 'tool_progress', 'tool_result', 'approval_required', 'approval_resolved', 'assistant_text']);

export function beginLiveTurn(sessionId, { taskId = null } = {}) {
  const at = new Date().toISOString();
  turns.set(sessionId, { taskId, startedAt: at, lastEvent: null, lastAt: at });
}

export function noteLiveTurn(sessionId, ev) {
  const t = turns.get(sessionId);
  if (!t || !STEP_FRAMES.has(ev?.type)) return;
  t.lastEvent = { type: ev.type, name: ev.name ?? null, stage: ev.stage ?? null };
  t.lastAt = new Date().toISOString();
}

export function endLiveTurn(sessionId) {
  turns.delete(sessionId);
}

export function liveTurn(sessionId) {
  const t = turns.get(sessionId);
  return t ? { ...t, lastEvent: t.lastEvent ? { ...t.lastEvent } : null } : null;
}
