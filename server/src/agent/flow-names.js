import fsp from 'node:fs/promises';
import path from 'node:path';

import { WORKSPACE_DIRS, parseArtifacts } from '../servicenow/fluent.js';

/**
 * JOB 1.2b — the app's flow names, so a request that NAMES a flow reaches the
 * flow tools even when it never says "flow". MEASURED in Job 1.2 (T11): "add a
 * step to NowForge Edit Test that sets the incident state to In Progress"
 * matched only `incident`, and the agent answered that it could not edit flows.
 *
 * No instance call: the names come from the app's own Fluent sources on disk
 * (every flow edit_flow can change is one of those) plus any names a
 * list_flows result has already shown. A turn that must not touch the
 * instance still does not. Dropped after any flow write; without it the
 * keyword signals still apply exactly as before.
 */
const TTL_MS = 5 * 60_000;
let cache = { at: 0, names: [] };
const learned = new Set();

export const knownFlowNames = () => [...new Set([...cache.names, ...learned])];
export function invalidateFlowNames() { cache = { at: 0, names: [] }; }
export function rememberFlowNames(names = []) { for (const n of names) if (typeof n === 'string' && n.trim()) learned.add(n.trim()); }

export async function refreshFlowNames() {
  if (!cache.at || Date.now() - cache.at >= TTL_MS) {
    const names = [];
    try {
      for (const f of (await fsp.readdir(WORKSPACE_DIRS.flows)).filter((x) => x.endsWith('.now.ts'))) {
        // eslint-disable-next-line no-await-in-loop
        const text = await fsp.readFile(path.join(WORKSPACE_DIRS.flows, f), 'utf8');
        for (const a of parseArtifacts(text)) names.push(a.name);
      }
      cache = { at: Date.now(), names };
    } catch { cache = { at: Date.now(), names: [] }; }
  }
  return knownFlowNames();
}
