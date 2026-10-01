import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { describeScan } from './scanProgress.js';
import {
  formatClock, formatDateTime, formatDay, formatDuration, formatEstimate, formatRelative, formatStopwatch, sameDay,
} from './time.js';
import './ScanProgress.css';

/*
 * HEALTH SCAN TIMING — the live progress panel and the scan history.
 *
 * The panel follows the app-wide run store (healthRun.js) and stays on the
 * page for the WHOLE run, on every tab: a scan of one module still shows while
 * another tab is open, because it names the modules it is scanning. Laid out
 * across the page — the numbers in one row (how far, when it started, how long
 * it has been going, what is left, when it should finish), the six steps side
 * by side with when each started and how long it took, and a line per rule
 * pack. When the scan ends it stays as a summary until dismissed. On a narrow
 * screen the steps stack.
 *
 * Every time here is the SERVER's (the stage timeline and the run's stored
 * ends), so reloading or opening the page mid-scan changes nothing it says.
 * The only motion is the running step's spinner and the bar and ring filling.
 */

const Icon = ({ d, size = 14, sw = 2.2 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={sw}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const CHECK = <path d="m5 12.5 4.5 4.5L19 7" />;
const CROSS = <path d="M6 6l12 12M18 6 6 18" />;
const PAUSE = <path d="M9 6v12M15 6v12" />;
const SKIP = <path d="M5 12h14" />;

const TITLES = {
  running: 'Health scan in progress',
  completed: 'Scan complete',
  cancelled: 'Scan stopped',
  failed: 'Scan did not finish',
};

const STEP_STATE_LABEL = { skipped: 'Skipped', 'not-run': 'Not run', stopped: 'Stopped', failed: 'Failed', pending: 'Waiting' };
const RING_CAPTION = { running: 'complete', completed: 'done', cancelled: 'stopped', failed: 'failed' };

function basisText({ basis, typicalMs }, samples) {
  const n = samples || 0;
  const earlier = `${n} earlier scan${n === 1 ? '' : 's'}`;
  switch (basis) {
    case 'history': return `Estimated from ${earlier} of the same modules on this instance.`;
    case 'blend': return `Estimated from ${earlier} of the same modules here, adjusted to this scan's pace.`;
    case 'pace': return "No earlier scan of these modules on this instance, so the estimate follows this scan's pace.";
    case 'overrun': return `Taking longer than usual — scans like this usually take ${formatDuration(typicalMs)}.`;
    case 'unknown': return 'Estimating — the first steps say little about how long the rest will take.';
    default: return null;
  }
}

function Ring({ percent, status }) {
  const r = 42;
  const c = 2 * Math.PI * r;
  return (
    <div className={`sp-ring is-${status}`} aria-hidden="true">
      <svg viewBox="0 0 100 100">
        <circle className="sp-ring-track" cx="50" cy="50" r={r} />
        <circle className="sp-ring-fill" cx="50" cy="50" r={r}
          strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(100, Math.max(0, percent)) / 100)} />
      </svg>
      <span className="sp-ring-text"><b>{percent}%</b><em>{RING_CAPTION[status] || ''}</em></span>
    </div>
  );
}

function Dot({ state, index }) {
  if (state === 'done') return <span className="sp-dot"><Icon d={CHECK} /></span>;
  if (state === 'active') return <span className="sp-dot"><span className="sp-spin" /></span>;
  if (state === 'failed') return <span className="sp-dot"><Icon d={CROSS} /></span>;
  if (state === 'stopped') return <span className="sp-dot"><Icon d={PAUSE} /></span>;
  if (state === 'skipped' || state === 'not-run') return <span className="sp-dot"><Icon d={SKIP} /></span>;
  return <span className="sp-dot">{index + 1}</span>;
}

/** Under a step's name: how long it took (or is taking) and when it started. */
function StepMeta({ step }) {
  const at = step.startedAt ? formatClock(step.startedAt, { seconds: true }) : null;
  if (step.state === 'active') {
    return (
      <span className="sp-step-meta">
        <span className="sp-time is-live">{formatStopwatch(step.durationMs)}</span>
        {at && <span className="sp-step-at">since {at}</span>}
      </span>
    );
  }
  if (step.durationMs == null) {
    return <span className="sp-step-meta"><span className="sp-time is-muted">{STEP_STATE_LABEL[step.state] || '—'}</span></span>;
  }
  const ended = step.endedAt ? ` · ended ${formatClock(step.endedAt, { seconds: true })}` : '';
  const suffix = step.state === 'stopped' ? ' · stopped' : step.state === 'failed' ? ' · failed' : '';
  return (
    <span className="sp-step-meta" title={at ? `Started ${at}${ended}` : undefined}>
      <span className="sp-time">{formatDuration(step.durationMs)}{step.count ? ` · ${step.count}` : ''}{suffix}</span>
      {at && <span className="sp-step-at">{at}</span>}
    </span>
  );
}

function Fact({ label, value, sub, title, mono = false }) {
  return (
    <div className="sp-fact" title={title || undefined}>
      <dt>{label}</dt>
      <dd className={mono ? 'sp-mono' : undefined}>{value}{sub ? <em>{sub}</em> : null}</dd>
    </div>
  );
}

/**
 * @param {object} props
 * @param {object} props.run        the healthRun store snapshot
 * @param {(key:string)=>string} props.labelOf   module key → display label
 * @param {()=>void} props.onStop
 * @param {()=>void} props.onDismiss
 */
export default function ScanProgress({ run, labelOf = (m) => m, onStop, onDismiss }) {
  const running = run.status === 'starting' || run.status === 'running';
  const stopping = running && Boolean(run.stopping);
  const last = !running ? run.last : null;
  const [now, setNow] = useState(() => Date.now());

  /* One tick a second while a scan runs: the elapsed clock and the running step's timer. */
  useEffect(() => {
    if (!running) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  if (!running && (!last || last.dismissed)) return null;

  const view = describeScan(running
    ? {
      timeline: run.progress?.timeline || [],
      progress: run.progress,
      startedAt: run.startedAt ?? run.progress?.startedAt,
      typicalMs: run.typicalMs,
      percent: run.peak,
      tablesTotal: run.tablesTotal,
      now,
    }
    : {
      timeline: last.timeline || [],
      startedAt: last.startedAt,
      typicalMs: last.typicalMs,
      percent: last.peak,
      tablesTotal: last.tablesTotal,
      now: Date.parse(last.finishedAt) || Date.now(),
      finished: { status: last.status, finishedAt: last.finishedAt, durationMs: last.durationMs },
    });

  const modules = (running ? run.modules : last.modules) || [];
  const moduleText = modules.length ? modules.map(labelOf).join(', ') : 'Selected modules';
  const status = view.status;
  const verifiedOnly = !running && last.kind === 'verification';

  let sub;
  if (stopping) sub = <>Finishing the table it is reading, then it stops — a large table can take a couple of minutes. Nothing is written.</>;
  else if (running) sub = <>Scanning <b>{moduleText}</b> · keeps running if you leave this page</>;
  else if (status === 'completed') {
    sub = verifiedOnly
      ? <>No changes since the last scan — the existing results were verified.</>
      : <><b>{moduleText}</b> · finished {formatClock(view.finishedAt)} after {formatDuration(view.elapsedMs)}</>;
  } else sub = last.message || (status === 'cancelled' ? 'Stopped before it finished. Nothing was written.' : 'The scan stopped with an error.');

  const basis = running && !stopping ? basisText(view, run.typicalSamples) : null;
  const startedLong = view.startedAt ? formatDateTime(view.startedAt, { seconds: true }) : null;
  const finishedLong = view.finishedAt ? formatDateTime(view.finishedAt, { seconds: true }) : null;

  return (
    <section className={`card sp is-${status}`} aria-label="Health scan progress">
      <div className="sp-head">
        <div className="sp-head-main">
          <span className={`sp-badge is-${status}`} aria-hidden="true">
            {running ? <span className="sp-spin" /> : <Icon d={status === 'completed' ? CHECK : status === 'cancelled' ? PAUSE : CROSS} size={16} />}
          </span>
          <div className="sp-head-text">
            <h2 className="sp-title">{stopping ? 'Stopping the scan…' : TITLES[status]}</h2>
            <p className="sp-sub" aria-live="polite">{sub}</p>
          </div>
        </div>
        <div className="sp-head-actions">
          {running
            ? (
              <button type="button" className="btn ghost sm" onClick={onStop} disabled={!run.runId || stopping} aria-busy={stopping}>
                {stopping ? 'Stopping…' : 'Stop scan'}
              </button>
            )
            : <button type="button" className="btn ghost sm" onClick={onDismiss}>Dismiss</button>}
        </div>
      </div>

      <div className="sp-track" role="progressbar" aria-label="Scan progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={view.percent}>
        <span style={{ width: `${Math.max(2, view.percent)}%` }} />
      </div>

      {/* The numbers, in one row. */}
      <div className="sp-stats">
        <Ring percent={view.percent} status={status} />
        <dl className="sp-facts">
          <Fact label="Started" value={formatClock(view.startedAt, { seconds: true })} sub={view.startedAt ? formatDay(view.startedAt) : null} title={startedLong} />
          {running ? (
            <>
              <Fact label="Elapsed" value={formatStopwatch(view.elapsedMs)} mono />
              <Fact label="Time left" value={stopping ? '—' : view.remainingMs != null ? formatEstimate(view.remainingMs) : 'Estimating…'} />
              <Fact label="Expected finish" value={!stopping && view.expectedEndAt ? `~${formatClock(view.expectedEndAt)}` : '—'} />
            </>
          ) : (
            <>
              <Fact label={status === 'completed' ? 'Finished' : 'Ended'} value={formatClock(view.finishedAt, { seconds: true })}
                sub={view.finishedAt && !sameDay(view.finishedAt, view.startedAt) ? formatDay(view.finishedAt) : null} title={finishedLong} />
              <Fact label="Took" value={formatDuration(view.elapsedMs)} />
              {view.typicalMs != null && status === 'completed' && !verifiedOnly
                ? <Fact label="Usually" value={formatDuration(view.typicalMs)} />
                : null}
            </>
          )}
        </dl>
      </div>

      {/* The six steps, side by side (stacked on a narrow screen). */}
      <ol className="sp-steps">
        {view.steps.map((s, i) => (
          <li key={s.id} className={`sp-step is-${s.state}`} aria-current={s.state === 'active' ? 'step' : undefined} title={s.hint}>
            <Dot state={s.state} index={i} />
            <span className="sp-step-text">
              <span className="sp-step-label">{s.label}</span>
              <span className="sp-step-hint">{s.hint}</span>
              <StepMeta step={s} />
              {s.detail && <span className="sp-step-detail">{s.detail}</span>}
            </span>
          </li>
        ))}
      </ol>

      {(view.packs.length > 0 || basis) && (
        <div className="sp-foot">
          {view.packs.length > 0 && (
            <div className="sp-packs" aria-label="Rule packs">
              <span className="sp-packs-label">Rule packs</span>
              {view.packs.map((p) => (
                <span key={p.name} className={`sp-pack is-${p.state}`}
                  title={p.startedAt ? `Started ${formatClock(p.startedAt, { seconds: true })}` : undefined}>
                  {p.state === 'active'
                    ? <span className="sp-spin" aria-hidden="true" />
                    : <Icon d={p.state === 'done' ? CHECK : p.state === 'stopped' ? PAUSE : CROSS} size={12} />}
                  <b>{p.name}</b>
                  <em>{p.state === 'active' ? formatStopwatch(p.durationMs) : formatDuration(p.durationMs)}</em>
                </span>
              ))}
            </div>
          )}
          {basis && <p className="sp-basis">{basis}</p>}
        </div>
      )}
    </section>
  );
}

/* ── the scan history ─────────────────────────────────────────────────────── */

const RESULT = {
  completed: { label: 'Completed', tone: 'green' },
  partial: { label: 'Partial', tone: 'amber' },
  failed: { label: 'Failed', tone: 'red' },
  cancelled: { label: 'Stopped', tone: '' },
  running: { label: 'Running', tone: 'blue' },
};

/**
 * The last scans on this instance: when each started and finished, how long it
 * took, what it read or only verified, how it ended and what it found.
 * `refreshKey` changes when a scan finishes, so the list is re-read then.
 */
export function ScanHistory({ refreshKey, labelOf = (m) => m, limit = 6 }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    api.get(`/health/runs/history?limit=${limit}`)
      .then((r) => { if (alive) { setRows(r.runs || []); setError(''); setNow(Date.now()); } })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [refreshKey, limit]);

  /* "12 min ago" stays true while the page is open. */
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  if (error) return <p className="error-text">Scan history could not be loaded: {error}</p>;
  if (!rows) return null;
  if (!rows.length) return <p className="hs-muted">No scans have run on this instance yet.</p>;

  const names = (list) => (list?.length ? list.map(labelOf).join(', ') : '—');
  return (
    <div className="table-wrap sp-history">
      <table className="table">
        <thead>
          <tr><th>Started</th><th>Finished</th><th>Duration</th><th>Covered</th><th>Result</th><th className="sp-num">Findings</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const verification = r.kind === 'verification';
            const result = verification && r.status === 'completed' ? { label: 'Verified', tone: 'green' } : (RESULT[r.status] || { label: r.status, tone: '' });
            return (
              <tr key={r.id}>
                <td title={formatDateTime(r.startedAt, { seconds: true })}>
                  <span className="sp-cell-main">{formatDateTime(r.startedAt)}</span>
                  <span className="sp-cell-sub">{formatRelative(r.startedAt, now)}</span>
                </td>
                <td title={r.completedAt ? formatDateTime(r.completedAt, { seconds: true }) : undefined}>
                  {r.completedAt
                    ? (sameDay(r.startedAt, r.completedAt) ? formatClock(r.completedAt, { seconds: true }) : formatDateTime(r.completedAt))
                    : (r.status === 'running' ? 'Still running' : '—')}
                </td>
                <td className="sp-mono">{formatDuration(r.durationMs)}</td>
                <td>
                  {r.read?.length ? <span>{names(r.read)}</span> : null}
                  {r.verified?.length ? <span className="sp-cell-sub">Verified unchanged: {names(r.verified)}</span> : null}
                  {!r.read?.length && !r.verified?.length ? names(r.requested) : null}
                </td>
                <td>
                  <span className={`badge ${result.tone}`} title={r.error || undefined}>{result.label}</span>
                </td>
                <td className="sp-num sp-mono">{r.findings == null ? '—' : r.findings.toLocaleString()}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * "Usually takes about 12 min" for the modules a scan is about to cover, from
 * this instance's history. Renders nothing until there is a history to go on.
 */
export function ScanEstimate({ modules }) {
  const key = [...(modules || [])].sort().join(',');
  const [estimate, setEstimate] = useState(null);
  useEffect(() => {
    if (!key) { setEstimate(null); return undefined; }
    let alive = true;
    api.get(`/health/runs/estimate?modules=${encodeURIComponent(key)}`)
      .then((r) => { if (alive) setEstimate(r); })
      .catch(() => { if (alive) setEstimate(null); });
    return () => { alive = false; };
  }, [key]);
  if (!estimate?.typicalMs) return null;
  return (
    <p className="sp-estimate">
      Usually takes {formatEstimate(estimate.typicalMs)} here
      <span> · from {estimate.samples} earlier scan{estimate.samples === 1 ? '' : 's'}</span>
    </p>
  );
}
