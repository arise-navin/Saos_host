/**
 * What the health-scan progress panel says, decided in plain JS.
 *
 * Split out of ScanProgress.jsx for the same reason startupProgress.js is
 * split out of the startup screen: it carries rules the offline suite should
 * check, and Node cannot import `.jsx`.
 *
 * THE STEPS are the engine's own stages (server/src/health/index.js), grouped
 * into six a person can follow. Their times come from the server's TIMELINE —
 * when each stage first appeared — never from when this page happened to hear
 * about it, so a page opened halfway through a scan still says when every
 * earlier step started and how long it took.
 *
 * THE ESTIMATE is labelled as one and says what it rests on: how long scans of
 * the same modules took on this instance before, blended with this scan's own
 * pace as it gets further in. With neither, it says it is still estimating.
 */

export const SCAN_STEPS = Object.freeze([
  Object.freeze({ id: 'changes', label: 'Check for changes', hint: 'Compare each table with the last scan' }),
  Object.freeze({ id: 'read', label: 'Read tables', hint: 'Pull the records the rules need' }),
  Object.freeze({ id: 'rules', label: 'Run rule packs', hint: 'ITSM, ITOM, Platform and the other catalogues' }),
  Object.freeze({ id: 'analyse', label: 'Analyse findings', hint: 'Group, rank and de-duplicate what failed' }),
  Object.freeze({ id: 'explain', label: 'Explain findings', hint: 'Plain-language summaries from your model' }),
  Object.freeze({ id: 'save', label: 'Score and save', hint: 'Work out the scores and store the results' }),
]);

const INDEX = Object.fromEntries(SCAN_STEPS.map((s, i) => [s.id, i]));

/**
 * The step an engine stage belongs to, or null for one this page does not know
 * (a newer server) — which is then ignored rather than guessed at.
 *
 * "checking custom rules" runs INSIDE analysis (after it has begun), so it is
 * part of that step; putting it under the rule packs would walk the list back.
 */
export function stepOfStage(stage) {
  const s = String(stage || '').trim().toLowerCase();
  if (s === 'checking for changes') return 'changes';
  if (s === 'extracting' || s === 'reading governance') return 'read';
  if (s === 'checking custom rules') return 'analyse';
  if (/^checking .+ rules$/.test(s)) return 'rules';
  if (s === 'analysing') return 'analyse';
  if (s === 'explaining') return 'explain';
  if (s === 'scoring' || s === 'saving results' || s === 'done') return 'save';
  return null;
}

/** What the active step is doing right now, in words. */
export function stageDetail(progress) {
  if (!progress) return null;
  /* Matched lower-case, shown as the server wrote it: "ITSM" stays "ITSM". */
  const raw = String(progress.stage || '').trim();
  const s = raw.toLowerCase();
  if (s === 'extracting' && progress.table) {
    return progress.tableIndex && progress.tableTotal
      ? `Reading ${progress.table} · table ${progress.tableIndex} of ${progress.tableTotal}`
      : `Reading ${progress.table}`;
  }
  if (s === 'reading governance') return 'Reading CMDB governance settings';
  if (/^checking .+ rules$/.test(s)) return raw.charAt(0).toUpperCase() + raw.slice(1);
  if (s === 'saving results') return 'Saving results';
  if (s === 'scoring') return 'Working out the scores';
  return null;
}

/**
 * How long is left.
 *
 *   history  — how long scans of these modules took here before
 *   pace     — this scan's own progress so far, extrapolated
 *   blend    — both, trusting the pace more the further in the scan is
 *   overrun  — running past the usual length; only the pace can say more
 *   unknown  — neither yet
 *
 * The percent is coarse — reading tables is most of the bar, and it then sits
 * at 66–69% for the whole rule-pack stage — so the pace alone is not trusted
 * until a real share is done, and beside a history it only takes over near the
 * end (weight = share done, cubed). Measured on dev366630 (ITOM, 2026-09-28):
 * at 2:36 and 67% a share-weighted blend said "about 2 min" with 3m 25s left;
 * the cubed weight says about 3 min.
 */
export function estimateRemaining({ elapsedMs, percent, typicalMs }) {
  const elapsed = Math.max(0, Number(elapsedMs) || 0);
  const pct = Math.min(99, Math.max(0, Number(percent) || 0));
  const pace = pct >= 8 && elapsed >= 5000 ? (elapsed * (100 - pct)) / pct : null;
  if (typicalMs && elapsed < typicalMs) {
    const fromHistory = typicalMs - elapsed;
    if (pace == null) return { remainingMs: Math.round(fromHistory), basis: 'history' };
    const w = (pct / 100) ** 3;
    return { remainingMs: Math.round(fromHistory * (1 - w) + pace * w), basis: 'blend' };
  }
  if (pace != null) return { remainingMs: Math.round(pace), basis: typicalMs ? 'overrun' : 'pace' };
  return { remainingMs: null, basis: typicalMs ? 'overrun' : 'unknown' };
}

const ms = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/* The markers the server appends to a finished run's timeline. `done` is also
   a progress stage name, so only the two that are not can end a pack early. */
const ENDED_EARLY = { cancelled: 'stopped', error: 'failed' };

/**
 * Each rule pack the scan ran — "checking ITSM rules", "checking ITOM rules",
 * … — with how long it took, from the same server timeline as the steps. A
 * pack ends where the next stage began; the last one still going is active.
 * Custom rules run inside analysis and are not a pack.
 */
export function rulePacks(timeline = [], { now, finished = null } = {}) {
  const tl = (timeline || []).filter((t) => t && t.stage);
  const packs = [];
  tl.forEach((t, i) => {
    const m = /^checking (.+) rules$/i.exec(String(t.stage).trim());
    if (!m || /^custom$/i.test(m[1])) return;
    const start = ms(t.at);
    const next = tl[i + 1] ?? null;
    let state;
    let end;
    if (next) {
      state = ENDED_EARLY[next.stage] ?? 'done';
      end = ms(next.at);
    } else if (finished) {
      state = finished.status === 'completed' ? 'done' : (finished.status === 'cancelled' ? 'stopped' : 'failed');
      end = ms(finished.finishedAt);
    } else {
      state = 'active';
      end = null;
    }
    packs.push({
      name: m[1],
      state,
      startedAt: start,
      durationMs: start == null ? null : Math.max(0, (end ?? now) - start),
    });
  });
  return packs;
}

/**
 * The whole panel's state.
 *
 * @param {object} p
 * @param {Array<{stage:string, at:string}>} [p.timeline]  the server's stage timeline
 * @param {object} [p.progress]      the latest progress frame
 * @param {string} [p.startedAt]
 * @param {number} [p.typicalMs]
 * @param {number} [p.percent]       the highest percent seen (the caller keeps it monotonic)
 * @param {number} p.now             epoch ms
 * @param {object} [p.finished]      { status: 'completed'|'failed'|'cancelled', finishedAt, durationMs }
 * @param {number} [p.tablesTotal]   how many tables the scan reads, once a table frame has said
 */
export function describeScan({ timeline = [], progress = null, startedAt = null, typicalMs = null, percent = null, now, finished = null, tablesTotal = null }) {
  /* First time each step appeared, and the furthest step reached. */
  const start = {};
  let reached = -1;
  for (const t of timeline || []) {
    const id = stepOfStage(t.stage);
    if (!id) continue;
    const at = ms(t.at);
    if (at != null && (start[id] == null || at < start[id])) start[id] = at;
    reached = Math.max(reached, INDEX[id]);
  }
  const liveId = stepOfStage(progress?.stage);
  if (liveId) reached = Math.max(reached, INDEX[liveId]);

  const begun = ms(startedAt) ?? (Object.values(start).length ? Math.min(...Object.values(start)) : null);
  const endAt = finished ? (ms(finished.finishedAt) ?? now) : null;
  const status = finished?.status ?? 'running';
  const ended = status !== 'running';

  const steps = SCAN_STEPS.map((s, i) => {
    const startedAtMs = start[s.id] ?? null;
    /* A step ends where the next step that actually ran began. */
    let endedAtMs = null;
    for (let j = i + 1; j < SCAN_STEPS.length; j += 1) {
      if (start[SCAN_STEPS[j].id] != null) { endedAtMs = start[SCAN_STEPS[j].id]; break; }
    }
    let state;
    if (status === 'completed') {
      state = startedAtMs != null ? 'done' : 'skipped';
      if (state === 'done' && endedAtMs == null) endedAtMs = endAt;
    } else if (i < reached) {
      state = startedAtMs != null ? 'done' : 'skipped';
    } else if (i === reached) {
      state = ended ? (status === 'cancelled' ? 'stopped' : 'failed') : 'active';
      if (ended) endedAtMs = endAt;
    } else {
      state = ended ? 'not-run' : 'pending';
    }
    const durationMs = startedAtMs == null ? null
      : endedAtMs != null ? Math.max(0, endedAtMs - startedAtMs)
        : state === 'active' ? Math.max(0, now - startedAtMs) : null;
    return {
      ...s,
      state,
      startedAt: startedAtMs,
      endedAt: endedAtMs,
      durationMs,
      detail: state === 'active' ? stageDetail(progress) : null,
      /* What the step covered, when it is known: the tables read. */
      count: s.id === 'read' && tablesTotal && state !== 'pending' && state !== 'skipped'
        ? `${tablesTotal} table${tablesTotal === 1 ? '' : 's'}` : null,
    };
  });

  const elapsedMs = begun == null ? null : Math.max(0, (endAt ?? now) - begun);
  const shownPercent = status === 'completed' ? 100 : Math.max(0, Math.min(99, Math.round(percent ?? progress?.percent ?? 0)));
  const estimate = ended || elapsedMs == null
    ? { remainingMs: null, basis: 'none' }
    : estimateRemaining({ elapsedMs, percent: shownPercent, typicalMs });
  return {
    status,
    steps,
    packs: rulePacks(timeline, { now, finished: ended ? { status, finishedAt: finished?.finishedAt ?? null } : null }),
    current: reached >= 0 ? SCAN_STEPS[reached].id : null,
    percent: shownPercent,
    startedAt: begun,
    finishedAt: endAt,
    elapsedMs: finished?.durationMs ?? elapsedMs,
    remainingMs: estimate.remainingMs,
    basis: estimate.basis,
    expectedEndAt: estimate.remainingMs != null ? now + estimate.remainingMs : null,
    typicalMs: typicalMs ?? null,
  };
}
