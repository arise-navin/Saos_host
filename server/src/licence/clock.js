/*
 * THE REAL TIME, as the ServiceNow instance tells it.
 *
 * A licence ends at a moment in real time; this computer's clock says whatever
 * its owner set it to. Every reply from the instance carries a Date header, so
 * servicenow/client.js hands each one here, and the licence counts from it —
 * turning the clock back does not give a trial more time.
 *
 * Between replies the last one is carried forward on the monotonic clock
 * (performance.now), which a change to the wall clock does not move.
 * Measured 2026-09-30: dev366630 answers an unauthenticated HEAD / with a Date
 * header equal to UTC to the second.
 */

const EARLIEST = Date.UTC(2026, 0, 1);   // older than any key: a wrong header, not the time

let seen = null;   // { at: real time in ms, mono: performance.now() when it was seen }

export function observeServerTime(header, mono = performance.now()) {
  const at = Date.parse(header || '');
  if (!Number.isFinite(at) || at < EARLIEST) return;
  seen = { at, mono };
}

/** { now, ageMs } — the real time now, from the last reply ageMs ago — or null before any reply. */
export function trustedTime(mono = performance.now()) {
  if (!seen) return null;
  return { now: seen.at + (mono - seen.mono), ageMs: mono - seen.mono };
}

export function _resetTrustedTimeForTests() {
  seen = null;
}
