import fs from 'node:fs';
import path from 'node:path';
import { dataPath } from '../config/paths.js';

/**
 * JOB 1.2b — stage timings for create / edit / restore.
 *
 * Recorded from the events the pipelines already emit, so it measures what
 * happens without changing it. Every write is best-effort: a timing that
 * cannot be recorded never fails the pipeline it was watching.
 *
 * A stage is named by the event that starts it and lasts until the next one.
 * The full timeline goes to server/data/timings/ (gitignored); the tool result
 * carries a compact summary, because tool output is capped at 8,000 chars.
 */
const DIR = dataPath('timings');

const DETAIL_KEYS = ['attempt', 'name', 'names', 'waitedMs', 'failing', 'stage', 'reported', 'ms', 'count'];

export function startTimeline(label, forward = null) {
  const t0 = Date.now();
  const events = [];
  const emit = (ev) => {
    try {
      const detail = {};
      for (const k of DETAIL_KEYS) {
        if (ev?.[k] === undefined) continue;
        /* an event's own duration (e.g. loaded {ms}) must not overwrite its place on the timeline */
        detail[k === 'ms' ? 'reportedMs' : k] = Array.isArray(ev[k]) ? ev[k].length : ev[k];
      }
      events.push({ ms: Date.now() - t0, type: String(ev?.type ?? 'event'), ...detail });
    } catch { /* measurement only */ }
    if (forward) { try { forward(ev); } catch { /* the pipeline's own emit decides */ } }
  };
  const finish = (extra = {}) => {
    const totalMs = Date.now() - t0;
    const stages = events.map((e, i) => ({ stage: e.type, ms: (events[i + 1]?.ms ?? totalMs) - e.ms, at: e.ms }));
    const record = { label, startedAt: new Date(t0).toISOString(), totalMs, stages, events, ...extra };
    try {
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(path.join(DIR, `${record.startedAt.replace(/[:.]/g, '-')}-${label}.json`), JSON.stringify(record, null, 1));
    } catch { /* measurement only */ }
    const top = [...stages].sort((a, b) => b.ms - a.ms).slice(0, 6).map((s) => `${s.stage} ${(s.ms / 1000).toFixed(1)}s`);
    return { totalSeconds: Math.round(totalMs / 100) / 10, slowestStages: top, ...extra };
  };
  return { emit, finish, mark: (type, detail = {}) => emit({ type, ...detail }) };
}
