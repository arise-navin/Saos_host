import crypto from 'node:crypto';

/**
 * JOB 1.2b — the identity of THIS server process.
 *
 * It changes on every start, so a client waiting on a long request can tell
 * "the server restarted" (the request is gone) from "the server is slow" (it is
 * still working). Measured 2026-09-25: a restart mid-turn left the chat
 * spinning indefinitely, because nothing the browser could see had changed.
 */
export const BOOT = Object.freeze({ id: crypto.randomUUID(), startedAt: new Date().toISOString() });
