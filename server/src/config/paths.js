import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * WHERE THE SERVER KEEPS ITS FILES — one answer for every module.
 *
 * Run from the repository (npm start / npm run dev) nothing is set, and every
 * path is exactly what it always was: server/data for what the app records,
 * and server/ itself for the Fluent workspace and the app-<scope> workspaces
 * beside it.
 *
 * The installed desktop app (desktop/) sets both, because its program folder
 * is replaced on every upgrade and uninstall — anything written there would
 * be lost with it:
 *
 *   SAOS_DATA_DIR        settings.json (credentials), the SQLite database,
 *                        attachments, flow backups, timings, the edit journal
 *   SAOS_WORKSPACES_DIR  fluent-workspace/ and app-<scope>/ — the Fluent
 *                        sources the agent writes, and their builds
 *
 * Read once, at import: the process that starts the server decides.
 */

export const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const fromEnv = (name) => (process.env[name] ? path.resolve(process.env[name]) : null);

export const DATA_DIR = fromEnv('SAOS_DATA_DIR') ?? path.join(SERVER_ROOT, 'data');

export const WORKSPACES_ROOT = fromEnv('SAOS_WORKSPACES_DIR') ?? SERVER_ROOT;

/** The managed Fluent workspace — its sources, builds and now.config.json. */
export const FLUENT_WORKSPACE = path.join(WORKSPACES_ROOT, 'fluent-workspace');

/** A path under the data directory. */
export const dataPath = (...parts) => path.join(DATA_DIR, ...parts);

/*
 * Where the desktop installers are offered from (Preferences → Desktop app):
 * SAOS_DOWNLOADS_DIR, or what `npm run dist` in desktop/ writes — the
 * repository's desktop/dist. The installed app has neither, and says so.
 */
export const DOWNLOADS_DIR = fromEnv('SAOS_DOWNLOADS_DIR') ?? path.resolve(SERVER_ROOT, '..', 'desktop', 'dist');
