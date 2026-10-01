/**
 * Preferences → Desktop app, decided in plain JS (the offline suite imports
 * this; Node cannot import .jsx).
 */

/** "220 MB" — binary units, as Windows and the browser's download bar count them. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['bytes', 'KB', 'MB', 'GB'];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) { n /= 1024; u += 1; }
  return u === 0 ? `${n} bytes` : `${n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[u]}`;
}

/**
 * Which desktop OS this browser is on, to open the right guide first and mark
 * the matching download. `userAgentData.platform` where the browser has it,
 * else the user-agent string. Null for anything else (a phone, Linux).
 */
export function detectPlatform(userAgent = '', uaPlatform = '') {
  const s = `${uaPlatform} ${userAgent}`.toLowerCase();
  if (/iphone|ipad|android/.test(s)) return null;
  if (/windows|win32|win64/.test(s)) return 'windows';
  if (/mac os|macos|macintosh|darwin/.test(s)) return 'mac';
  return null;
}

export const MAC_ARCH_LABEL = { arm64: 'Apple silicon (M1 and later)', x64: 'Intel', universal: 'Apple silicon and Intel' };

/** The Mac builds in the order a person should see them: Apple silicon first. */
export function orderMacBuilds(builds = []) {
  const rank = { arm64: 0, universal: 1, x64: 2 };
  return [...builds].sort((a, b) => (rank[a.arch] ?? 9) - (rank[b.arch] ?? 9));
}

export const downloadHref = (build) => `/api/desktop/download/${encodeURIComponent(build.file)}`;
