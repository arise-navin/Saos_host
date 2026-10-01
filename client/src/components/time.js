/**
 * Timestamps and durations, formatted one way across the app.
 *
 * Plain JS so the offline suite can hold it to its rules. Every function takes
 * an ISO string, a Date or epoch ms, and answers '—' (or null where noted) for
 * a missing or unreadable value rather than "Invalid Date". `locale` and
 * `timeZone` are the browser's unless given — the suite pins them.
 */

export const DASH = '—';

export function toDate(value) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const fmt = (d, opts, { locale, timeZone } = {}) => d.toLocaleString(locale, { ...opts, ...(timeZone ? { timeZone } : {}) });

/** "Sep 23, 2026" */
export function formatDay(value, o = {}) {
  const d = toDate(value);
  return d ? fmt(d, { month: 'short', day: 'numeric', year: 'numeric' }, o) : DASH;
}

/** "10:52 AM", or "10:52:04 AM" with seconds. */
export function formatClock(value, { seconds = false, ...o } = {}) {
  const d = toDate(value);
  return d ? fmt(d, { hour: 'numeric', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) }, o) : DASH;
}

/** "Sep 23, 2026, 10:52 AM" — a full, unambiguous moment. */
export function formatDateTime(value, { seconds = false, ...o } = {}) {
  const d = toDate(value);
  return d
    ? fmt(d, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) }, o)
    : DASH;
}

/**
 * A length of time for people: "<1s", "42s", "3m 27s", "1h 02m". Seconds are
 * dropped past an hour — nobody plans around them — and nothing is rounded up
 * into a unit it has not reached.
 */
export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return DASH;
  if (ms < 1000) return '<1s';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** A running clock: "0:07", "12:05", "1:02:03". */
export function formatStopwatch(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * An estimate, said as one: "about 6 min", "about 1 h 10 min", "under a minute".
 * Rounded to the minute on purpose — a to-the-second countdown on an estimate
 * reads as a promise.
 */
export function formatEstimate(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 60_000) return 'under a minute';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `about ${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `about ${h} h ${rest} min` : `about ${h} h`;
}

const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "just now", "12 min ago", "3 h ago", "yesterday", "4 days ago", then the date. */
export function formatRelative(value, now = Date.now(), o = {}) {
  const d = toDate(value);
  if (!d) return DASH;
  const nowD = toDate(now) || new Date();
  const diff = nowD.getTime() - d.getTime();
  if (diff < 0) return formatDateTime(d, o);
  if (diff < 45_000) return 'just now';
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} min ago`;
  const days = Math.round((dayStart(nowD) - dayStart(d)) / 86_400_000);
  if (days === 0) return `${Math.floor(diff / 3_600_000)} h ago`;
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return formatDay(d, o);
}

export const sameDay = (a, b) => {
  const x = toDate(a);
  const y = toDate(b);
  return Boolean(x && y && dayStart(x) === dayStart(y));
};

/**
 * A start and an end as one phrase: "Sep 23, 2026, 10:52 AM → 11:04 AM", with
 * the end's date only when it is a different day.
 */
export function formatRange(start, end, { seconds = false, ...o } = {}) {
  const a = toDate(start);
  const b = toDate(end);
  if (!a) return DASH;
  if (!b) return `${formatDateTime(a, { seconds, ...o })} → …`;
  const tail = sameDay(a, b) ? formatClock(b, { seconds, ...o }) : formatDateTime(b, { seconds, ...o });
  return `${formatDateTime(a, { seconds, ...o })} → ${tail}`;
}
