import { toast } from './toast.js';

/*
 * A change to a Health Assist rule (Job HC-1) — built-in or custom, wording,
 * severity, on/off, a check of its own, a threshold — only reaches the health
 * results once a scan has re-read that module. Every change is announced the
 * same way: a toast with the way to the full scan, and an event the rescan
 * notices listen for, so they refresh without a reload.
 */

export const RULES_CHANGED = 'saos:rules-changed';
export const FULL_SCAN_PATH = '/health?scan=full';

export function announceRuleChange(message) {
  window.dispatchEvent(new CustomEvent(RULES_CHANGED));
  toast.success(message, {
    detail: 'A full scan is recommended so your health results reflect it.',
    action: { label: 'Go to full scan', path: FULL_SCAN_PATH },
  });
}

/** "2 minutes ago" for a change time; the full time goes in a title. */
export function ago(iso, now = Date.now()) {
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}
