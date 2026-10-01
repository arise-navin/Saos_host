/**
 * JOB 1.2b — when to stop waiting on a streamed request, and what to say.
 *
 * MEASURED 2026-09-25: the server restarted 21 s into a chat turn. The browser's
 * request went through vite's dev proxy, which answered the dead upstream by
 * leaving the browser's response OPEN — so the reader waited forever and the
 * chat spun with no error. Two signals now end that wait:
 *   - the server writes a keep-alive ping every 15 s while a turn runs, so a
 *     stream silent for three pings is a dead connection;
 *   - /api/system/health carries a bootId that changes on every server start, so
 *     a different one means the process running this request is gone.
 * Pure: no timers and no fetch, so it is tested without a browser.
 */
export const STALL_MS = 45_000;
export const PROBE_EVERY_MS = 5_000;
export const MAX_PROBE_FAILURES = 3;

const AFTERWARDS = 'If it was changing a flow, your next message will say so and offer to put the flow back (restore_flow). '
  + 'Anything already changed on the instance is on the Audit page.';

export function watchdogVerdict({
  now, lastByteAt, bootAtStart = null, bootNow = null, probeFailures = 0,
  stallMs = STALL_MS, maxProbeFailures = MAX_PROBE_FAILURES,
}) {
  if (bootAtStart && bootNow && bootNow !== bootAtStart) {
    return { reason: 'restarted', message: `The server restarted while this request was running, so it stopped part-way and will not finish. ${AFTERWARDS}` };
  }
  if (probeFailures >= maxProbeFailures) {
    return {
      reason: 'unreachable',
      message: 'The server is not responding, so this request cannot finish. Start it again with `npm start` in the repo root. '
        + AFTERWARDS,
    };
  }
  if (now - lastByteAt > stallMs) {
    return {
      reason: 'stalled',
      message: `Nothing has come from the server for ${Math.round(stallMs / 1000)} s — the connection was lost, so this request stopped part-way. ${AFTERWARDS}`,
    };
  }
  return null;
}

/* What a long-running tool is doing, in words. Stages not listed keep the last line on screen. */
const STAGES = Object.freeze({
  preview: 'working out what this change would do…',
  planning: 'planning the change…',
  backup_saved: 'backup saved',
  snapshot_other_flows: 'reading the other flows first…',
  generating: 'understanding the request…',
  attempt: 'writing the flow…',
  building: 'building…',
  deletions: 'preparing the steps it removes…',
  loading: 'loading the flow onto the instance…',
  activating: 'publishing…',
  readback: 'reading the flow back…',
  verify_spec_attempt: 'writing the verification plan…',
  snapshot_other_flows_after: 'checking that no other flow changed…',
  describe_after: 'summarising the result…',
});

export function progressLabel(stage) {
  return STAGES[stage] ?? null;
}
