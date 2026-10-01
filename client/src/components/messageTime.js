/**
 * JOB UI-4 — when a message was sent, said the way a chat app says it.
 *
 * Times are the viewer's local clock ("1:31 pm"); the full date and time sit in
 * the tooltip. Day dividers follow the WhatsApp convention: Today, Yesterday,
 * the weekday within the last week, then the date.
 */

const asDate = (at) => (at instanceof Date ? at : new Date(at));
const valid = (at) => at != null && !Number.isNaN(asDate(at).getTime());

export function formatTime(at) {
  if (!valid(at)) return '';
  return asDate(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function formatFull(at) {
  if (!valid(at)) return '';
  return asDate(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

/** A key that is equal for two times on the same local calendar day. */
export function dayKey(at) {
  if (!valid(at)) return null;
  const d = asDate(at);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function dayLabel(at, now = new Date()) {
  if (!valid(at)) return '';
  const d = asDate(at);
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], {
    day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
}

/**
 * JOB UI-4 — a reply that quotes a passage. The quote travels as a markdown
 * blockquote at the head of the message, so the model reads it as a quotation
 * and a reloaded chat can show it again from the stored text alone.
 */
export function quoteBlock(text) {
  return String(text || '').trim().split('\n').map((l) => `> ${l}`).join('\n');
}

/** Split a stored message into its leading quote (if any) and the rest. */
export function splitQuote(text) {
  const lines = String(text || '').split('\n');
  let i = 0;
  while (i < lines.length && /^>( |$)/.test(lines[i])) i += 1;
  if (i === 0 || (i < lines.length && lines[i].trim() !== '')) return { quote: null, rest: text };
  return {
    quote: lines.slice(0, i).map((l) => l.replace(/^> ?/, '')).join('\n'),
    rest: lines.slice(i).join('\n').trim(),
  };
}
