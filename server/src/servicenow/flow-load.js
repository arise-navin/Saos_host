import fsp from 'node:fs/promises';
import path from 'node:path';

import { table, instanceRequest, SnowError } from './client.js';
import { flows, activateFlows, publishedVerdict } from './flows.js';
import { WORKSPACE, readAppIdentity, resolveScopeId } from './fluent.js';

/**
 * JOB 1.2b — THE FAST CHANNEL: load ONE flow's SDK-built package, then publish it.
 *
 * WHY NOT `now-sdk install` (measured on dev366630, 2026-09-25):
 *   - install ships the WHOLE app (803 files: every flow, 13 tables, catalog
 *     policies, 571 deletion records) and took ~16 min per edit;
 *   - the SDK build writes every flow header as `active=false, status=draft`
 *     (sdk-api/dist/external-plugins/flow.js, `active: $.val(false)` — no
 *     source option changes it), so every install un-publishes every flow
 *     until something re-publishes it: a window of many minutes.
 *
 * WHAT THIS DOES INSTEAD — still the SDK's own output and the SDK's own channel:
 *   - `now-sdk build` compiles and validates the WHOLE workspace, exactly as before;
 *   - the build emits one self-contained XML per flow (header, inputs, outputs,
 *     labels, every step, and `delete_multiple` for the flow's rows that are no
 *     longer in the source);
 *   - that ONE file is loaded through `api/fluent/load/<scope>` — the endpoint
 *     the SDK's own `installConfigurations()` / `uploadXMLFiles()` use — with
 *     the build's own deletion records for the steps the new version drops;
 *   - a LIVE flow's header is sent as active + status "draft" (Flow Designer's
 *     "edited, not yet published"): its published snapshot keeps running —
 *     measured, a record inserted in that window ran the old version — until
 *     `wfa_fluent/activate_flows` compiles the new version into it. A draft is
 *     sent as it is. No other flow is in the payload, so no other flow changes.
 *
 * Every claim above is checked on every call, not assumed: the caller reads the
 * flow back, proves the published snapshot equals the definition, and diffs
 * every other flow in the app before and after.
 */

const DIST_UPDATE = path.join(WORKSPACE, 'dist/app/update');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const flowPackageFile = (sysId) => path.join(DIST_UPDATE, `sys_hub_flow_${sysId}.xml`);

/**
 * Write the header in the given state instead of the SDK's hardcoded draft.
 * Refuses unless the header has exactly one <active> and one <status>: a
 * package whose shape is not the one measured is not patched on a guess.
 */
export function patchHeaderState(xml, { active, status }) {
  const start = xml.indexOf('<sys_hub_flow action=');
  const end = start >= 0 ? xml.indexOf('</sys_hub_flow>', start) : -1;
  if (start < 0 || end < 0) throw new SnowError('The built flow package has no <sys_hub_flow> header element.', 500);
  const header = xml.slice(start, end);
  const actives = header.match(/<active>(?:true|false)<\/active>/g) ?? [];
  const statuses = header.match(/<status>[^<]*<\/status>/g) ?? [];
  if (actives.length !== 1 || statuses.length !== 1) {
    throw new SnowError(`Unexpected flow header shape (active x${actives.length}, status x${statuses.length}); refusing to patch it.`, 500);
  }
  const patched = header
    .replace(/<active>(?:true|false)<\/active>/, `<active>${active ? 'true' : 'false'}</active>`)
    .replace(/<status>[^<]*<\/status>/, `<status>${String(status).replace(/[<&>]/g, '')}</status>`);
  return xml.slice(0, start) + patched + xml.slice(end);
}

const DIST_DELETES = path.join(WORKSPACE, 'dist/app/author_elective_update');
const STEP_TABLES = ['sys_hub_trigger_instance_v2', 'sys_hub_action_instance_v2', 'sys_hub_flow_logic_instance_v2', 'sys_hub_sub_flow_instance_v2'];

/**
 * The SDK's own deletion records for the steps this load removes.
 *
 * MEASURED (T7, 2026-09-25): restoring NowForge Edit Test to its Log-only
 * original left the T3 If block on the instance, and the read-back FAILED. A
 * flow package cleans a table itself only while the new version still has rows
 * in it (one `delete_multiple` per table); the original has no logic steps, so
 * nothing in the package removed the If. A whole-app install also applies the
 * deletion records the build writes to dist/app/author_elective_update/
 * <table>_<sys_id>.xml — which the fast channel did not send.
 *
 * So every step row the flow has on the instance NOW that the new package does
 * not carry must be removed by the package's own delete_multiple, or travel
 * with its SDK deletion record. A row with neither stops the load: nothing is
 * loaded rather than something left behind.
 */
export async function stepDeletions(sysId, xml, { query = (t, o) => table.query(t, o), dir = DIST_DELETES } = {}) {
  const carried = new Set([...xml.matchAll(/<sys_id>([0-9a-f]{32})<\/sys_id>/g)].map((m) => m[1]));
  const selfCleaned = new Set([...xml.matchAll(/<(\w+) action="delete_multiple" query="flow=([0-9a-f]{32})\^/g)]
    .filter((m) => m[2] === sysId).map((m) => m[1]));
  const rows = (await Promise.all(STEP_TABLES.map((t) => query(t, { query: `flow=${sysId}`, fields: 'sys_id', limit: 1000, display: 'false' })
    .then((r) => r.map((x) => ({ table: t, id: x.sys_id })))))).flat();
  const files = [];
  const uncovered = [];
  for (const r of rows.filter((x) => !carried.has(x.id))) {
    const name = `${r.table}_${r.id}.xml`;
    // eslint-disable-next-line no-await-in-loop
    const text = await fsp.readFile(path.join(dir, name), 'utf8').catch(() => null);
    if (text && text.includes('action="DELETE"') && text.includes(`<sys_id>${r.id}</sys_id>`)) files.push({ name, text, table: r.table, id: r.id });
    else if (!selfCleaned.has(r.table)) uncovered.push(r);
  }
  return { files, uncovered };
}

/** Load one flow's package. `headerState` null = leave the SDK's header as built (a NEW flow: draft). */
export async function loadFlowPackage({ sysId, headerState = null, emit = () => {} }) {
  const file = flowPackageFile(sysId);
  let xml = await fsp.readFile(file, 'utf8').catch(() => null);
  if (!xml) throw new SnowError(`The build produced no package for flow ${sysId} (${path.relative(WORKSPACE, file)}).`, 500);
  if (headerState) xml = patchHeaderState(xml, headerState);
  const [{ scope }, deletions] = await Promise.all([readAppIdentity(), stepDeletions(sysId, xml)]);
  if (deletions.uncovered.length) {
    throw new SnowError(`Nothing was loaded: the flow has step(s) on the instance that the new version drops, and the build has no deletion record for them `
      + `(${deletions.uncovered.map((r) => `${r.table} ${r.id}`).join(', ')}). Loading would leave them behind.`, 409, { stage: 'preload' });
  }
  const { scopeId } = await resolveScopeId(scope);
  if (!scopeId) throw new SnowError(`The scope ${scope} could not be resolved on the bound instance.`, 409, { stage: 'preload' });
  const form = new FormData();
  form.append('files', new Blob([xml], { type: 'application/xml' }), path.basename(file));
  for (const d of deletions.files) form.append('files', new Blob([d.text], { type: 'application/xml' }), d.name);
  if (deletions.files.length) emit({ type: 'deletions', count: deletions.files.length });
  emit({ type: 'loading' });
  const t0 = Date.now();
  const res = await instanceRequest(`/api/fluent/load/${scopeId}`, { method: 'POST', form });
  if (!res.ok) {
    throw new SnowError(`Loading the flow package failed (HTTP ${res.status}): `
      + `${res.json?.result?.error ?? res.json?.error?.message ?? String(res.text ?? '').slice(0, 300)}`, res.status || 502, { stage: 'load' });
  }
  emit({ type: 'loaded', ms: Date.now() - t0 });
  return {
    ms: Date.now() - t0, updateSetId: res.json?.result?.targetUpdateSetId ?? null, bytes: xml.length, file: path.basename(file), scopeId,
    deleted: deletions.files.map((d) => `${d.table} ${d.id}`),
  };
}

/** Publish exactly one flow, then read the three-way proof with backoff until it holds (or time runs out). */
export async function publishFlow({ sysId, emit = () => {}, maxMs = 90_000 }) {
  const { scope } = await readAppIdentity();
  const { scopeId } = await resolveScopeId(scope);
  emit({ type: 'activating' });
  const t0 = Date.now();
  /*
   * MEASURED (X1, X2 on dev366630): the endpoint answers "Published successfully"
   * even when it compiled NOTHING (a header already marked published). So its
   * answer is recorded, never trusted: done means the header is back to
   * published AND the three-way proof holds — and the caller then proves the
   * published snapshot equals the definition.
   */
  const reported = await activateFlows({ flowSysIds: [sysId], scopeId });
  const state = async () => {
    const [h, p] = await Promise.all([
      table.query('sys_hub_flow', { query: `sys_id=${sysId}`, fields: 'active,status', limit: 1, display: 'false' }),
      flows.publishedProof(sysId).catch(() => ({ published: null })),
    ]);
    return { status: h[0]?.status ?? null, active: h[0]?.active === 'true', proof: p };
  };
  let st = await state();
  for (let wait = 500; !(st.proof.published === true && st.status === 'published') && Date.now() - t0 < maxMs; wait = Math.min(wait * 2, 8000)) {
    // eslint-disable-next-line no-await-in-loop
    await sleep(wait);
    // eslint-disable-next-line no-await-in-loop
    st = await state();
  }
  emit({ type: 'activated', ms: Date.now() - t0 });
  return { published: st.proof.published === true && st.status === 'published', proof: st.proof, header: { active: st.active, status: st.status }, reported: reported.reported, perFlow: reported.perFlow, ms: Date.now() - t0 };
}

/**
 * Header state and published verdict of EVERY flow in the scope, in three
 * queries — the same three-way verdict `flows.publishedProof` computes one
 * flow at a time (that took ~30 s for ten flows; this takes ~3 s).
 */
export async function scopeFlowStates() {
  const { scope } = await readAppIdentity();
  const heads = await table.query('sys_hub_flow', {
    query: `sys_scope.scope=${scope}`, fields: 'sys_id,name,type,active,status,latest_snapshot', limit: 500, display: 'false',
  });
  const ids = heads.map((h) => h.sys_id);
  const latest = heads.map((h) => h.latest_snapshot).filter(Boolean);
  const [snaps, named] = await Promise.all([
    ids.length ? table.query('sys_hub_flow_snapshot', { query: `parent_flowIN${ids.join(',')}`, fields: 'sys_id,parent_flow,status,active', limit: 2000, display: 'false' }) : [],
    latest.length ? table.query('sys_hub_flow_snapshot', { query: `sys_idIN${latest.join(',')}`, fields: 'sys_id,parent_flow,status,active', limit: 2000, display: 'false' }) : [],
  ]);
  const namedById = new Map(named.map((s) => [s.sys_id, s]));
  const out = {};
  for (const h of heads) {
    const v = publishedVerdict({
      header: h,
      snapshots: snaps.filter((s) => s.parent_flow === h.sys_id),
      named: h.latest_snapshot ? namedById.get(h.latest_snapshot) ?? null : null,
      namedUnreadable: Boolean(h.latest_snapshot) && !namedById.has(h.latest_snapshot),
    });
    out[h.sys_id] = { name: h.name, type: h.type, active: h.active === 'true', status: h.status, published: v.published, latest_snapshot: h.latest_snapshot || null };
  }
  return out;
}
