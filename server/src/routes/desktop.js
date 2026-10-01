import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { DOWNLOADS_DIR } from '../config/paths.js';
import { BACKEND_VERSION } from '../config/onboarding.js';

/*
 * DESKTOP INSTALLERS — what Preferences → Desktop app offers to download.
 *
 * The installers `npm run dist` in desktop/ builds: the Windows one on a
 * Windows PC, the macOS one on a Mac (each carries native modules for its own
 * OS). Both land in desktop/dist, or wherever SAOS_DOWNLOADS_DIR points.
 *
 * Only files named like an installer are listed or served. Nothing else in
 * the folder is reachable, and the file to send is looked up by name among
 * the listed ones — a name with a path in it matches nothing.
 */

const VERSION = String.raw`(\d+\.\d+\.\d+(?:-[\w.]+)?)`;
const KINDS = [
  { platform: 'windows', re: new RegExp(`^SAOS-Setup-${VERSION}\\.exe$`, 'i'), arch: () => 'x64' },
  { platform: 'mac', re: new RegExp(`^SAOS-${VERSION}-mac-(arm64|x64|universal)\\.dmg$`, 'i'), arch: (m) => m[2].toLowerCase() },
];

/** Numeric, part by part: 0.10.0 is newer than 0.9.3. */
export function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

/** Every installer in the folder, newest version (then newest file) first. */
export function scanDownloads(dir = DOWNLOADS_DIR) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return { dir, found: false, builds: [] }; }
  const builds = [];
  for (const file of names) {
    for (const kind of KINDS) {
      const m = kind.re.exec(file);
      if (!m) continue;
      let stat;
      try { stat = fs.statSync(path.join(dir, file)); } catch { continue; }
      if (!stat.isFile()) continue;
      builds.push({ platform: kind.platform, arch: kind.arch(m), version: m[1], file, size: stat.size, builtAt: stat.mtime.toISOString() });
    }
  }
  builds.sort((x, y) => compareVersions(y.version, x.version) || Date.parse(y.builtAt) - Date.parse(x.builtAt));
  return { dir, found: true, builds };
}

/** The newest build for each platform and CPU. */
export function latestBuilds(builds) {
  const seen = new Set();
  return builds.filter((b) => {
    const key = `${b.platform}:${b.arch}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function createDesktopRouter({ dir = DOWNLOADS_DIR } = {}) {
  const router = Router();

  router.get('/downloads', (_req, res) => {
    const scan = scanDownloads(dir);
    const latest = latestBuilds(scan.builds);
    res.json({
      /* Whether the page is open inside the installed app, and on what. */
      running: { desktop: process.env.SAOS_DESKTOP === '1', platform: process.platform, version: BACKEND_VERSION },
      folder: scan.found ? scan.dir : null,
      windows: latest.find((b) => b.platform === 'windows') ?? null,
      mac: latest.filter((b) => b.platform === 'mac'),
    });
  });

  router.get('/download/:file', (req, res) => {
    const build = scanDownloads(dir).builds.find((b) => b.file === req.params.file);
    if (!build) return res.status(404).json({ message: 'That installer is not available here.' });
    return res.download(path.join(dir, build.file), build.file);
  });

  return router;
}

export const desktopRouter = createDesktopRouter();
