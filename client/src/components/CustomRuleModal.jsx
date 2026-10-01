import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { announceRuleChange } from './ruleChanges.js';

/*
 * ADD / EDIT A CUSTOM RULE (D-038) — a three-step dialog, like a custom dimension's.
 *
 *   1 Describe      name, module, the area it is scored in, what to check (plain English)
 *   2 Define        the check itself — by AI assist from the description, or by hand:
 *                   a record, rate or age check on one table
 *   3 Preview       run it read-only on the instance, see what it would find, save
 *
 * Nothing is saved until Save; the server re-validates everything it is sent.
 *
 * The SAME dialog gives a built-in rule the product never built a check of its
 * own (Job HC-1, `builtIn`): the rule fixes the name, module and severity, the AI
 * assist starts from the rule's own detection logic, and the check runs under the
 * rule's id (PUT /health/rulebook/rules/:id/check).
 */

const KINDS = [
  { key: 'record', title: 'Record check', sub: 'Every record matching the conditions is a finding' },
  { key: 'rate', title: 'Rate check', sub: 'Fails when the share of matching records passes a limit' },
  { key: 'age', title: 'Age check', sub: 'Records older than a number of days are findings' },
];
const OPERATORS = [['=', 'is'], ['!=', 'is not'], ['ISEMPTY', 'is empty'], ['ISNOTEMPTY', 'is not empty'], ['IN', 'is one of'], ['NOT IN', 'is not one of'],
  ['LIKE', 'contains'], ['NOT LIKE', 'does not contain'], ['STARTSWITH', 'starts with'], ['>', 'greater than'], ['<', 'less than'], ['>=', 'at least'], ['<=', 'at most']];
const VALUELESS = new Set(['ISEMPTY', 'ISNOTEMPTY']);
const SEVERITIES = [['SYSTEMIC', 'Systemic'], ['CRITICAL', 'Critical'], ['HIGH', 'High'], ['MEDIUM', 'Moderate'], ['LOW', 'Low']];
const STEPS = [{ key: 1, title: 'Describe' }, { key: 2, title: 'Define the check' }, { key: 3, title: 'Preview and save' }];

const blank = () => ({ field: '', op: '=', value: '' });
const WORD_BAND = { systemic: 'SYSTEMIC', critical: 'CRITICAL', high: 'HIGH', moderate: 'MEDIUM', medium: 'MEDIUM', low: 'LOW' };
const bandOf = (s) => WORD_BAND[String(s ?? '').toLowerCase()] ?? 'MEDIUM';
const cleanText = (s) => String(s ?? '').replace(/\\([_*])/g, '$1').trim();

/** The starting definition: an existing custom rule, a built-in rule's check, or a blank one (in the tab's module). */
function initialDef({ existing, builtIn, presetModule }) {
  const defaults = { scope: [], conditions: [blank()], threshold: { max_share: 10 }, age: { field: 'sys_created_on', days: 7 }, scored: true, active: true };
  if (builtIn) {
    const r = builtIn.rule;
    const c = r.changes?.check ?? null;
    return {
      ...defaults, ...(c ?? {}), name: cleanText(r.rule), module: r.module, severity: bandOf(r.base_severity),
      description: c?.description || [cleanText(r.detection_logic), cleanText(r.source_tables_fields) && `Source: ${cleanText(r.source_tables_fields)}`].filter(Boolean).join(' — '),
      dimension: c?.dimension ?? r.dimension ?? '', kind: c?.kind ?? 'record', table: c?.table ?? '',
      scope: c?.scope ?? [], conditions: c?.conditions?.length ? c.conditions : [blank()], threshold: c?.threshold ?? defaults.threshold, age: c?.age ?? defaults.age,
    };
  }
  if (existing) return { ...existing, scope: existing.scope ?? [], conditions: existing.conditions ?? [], threshold: existing.threshold ?? defaults.threshold, age: existing.age ?? defaults.age };
  return { ...defaults, name: '', module: presetModule || 'itsm', dimension: '', description: '', kind: 'record', table: '', severity: 'MEDIUM' };
}

function Conditions({ label, hint, list, onChange }) {
  const set = (i, patch) => onChange(list.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <div className="field">
      <label>{label}</label>
      {hint && <span className="hs-muted cr-hint">{hint}</span>}
      {list.map((c, i) => (
        <div key={i} className="cr-cond">
          <input className="input mono" placeholder="field (e.g. priority)" value={c.field} onChange={(e) => set(i, { field: e.target.value })} />
          <select className="select" value={c.op} onChange={(e) => set(i, { op: e.target.value })}>
            {OPERATORS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <input className="input mono" placeholder={VALUELESS.has(c.op) ? '—' : 'value (e.g. 1)'} disabled={VALUELESS.has(c.op)} value={VALUELESS.has(c.op) ? '' : c.value} onChange={(e) => set(i, { value: e.target.value })} />
          <button type="button" className="btn sm ghost" onClick={() => onChange(list.filter((_, j) => j !== i))} aria-label="Remove condition">✕</button>
        </div>
      ))}
      <button type="button" className="btn sm ghost cr-add" onClick={() => onChange([...list, blank()])}>+ Add condition</button>
    </div>
  );
}

export default function CustomRuleModal({ existing = null, builtIn = null, presetModule = null, modules, dimensions, onClose, onSaved }) {
  const [step, setStep] = useState(1);
  const [def, setDef] = useState(() => initialDef({ existing, builtIn, presetModule }));
  const ruleId = builtIn?.rule.id ?? null;
  const hadCheck = Boolean(builtIn?.rule.changes?.check);
  const [assist, setAssist] = useState({ busy: false, note: '' });
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const panelRef = useRef(null);
  useEffect(() => { panelRef.current?.focus(); }, []);

  const set = (patch) => { setDef((d) => ({ ...d, ...patch })); setPreview(null); };
  const areas = dimensions[def.module] ?? [];
  useEffect(() => { if (!areas.some((a) => a.key === def.dimension)) set({ dimension: areas[0]?.key ?? '' }); }, [def.module]); // eslint-disable-line react-hooks/exhaustive-deps

  /* What is sent: only the parts the chosen kind uses. */
  const payload = () => ({
    name: def.name, description: def.description, module: def.module, dimension: def.dimension, kind: def.kind, table: def.table,
    scope: def.scope.filter((c) => c.field), conditions: def.conditions.filter((c) => c.field), severity: def.severity, scored: def.scored, active: def.active,
    threshold: def.kind === 'rate' ? { max_share: Number(def.threshold.max_share) } : null,
    age: def.kind === 'age' ? { field: def.age.field, days: Number(def.age.days) } : null,
  });

  const runAssist = async () => {
    setAssist({ busy: true, note: '' }); setError('');
    try {
      const r = builtIn
        ? await api.post(`/health/rulebook/rules/${ruleId}/check/suggest`, { note: def.description })
        : await api.post('/health/custom-rules/suggest', { description: def.description || def.name, module: def.module });
      if (r.unsupported) { setAssist({ busy: false, note: `This check needs more than one table or relationships, which custom rules do not support yet: ${r.unsupported}` }); return; }
      const p = r.proposal;
      setDef((d) => ({ ...d, name: d.name || p.name, kind: p.kind, table: p.table, scope: p.scope?.length ? p.scope : [], conditions: p.conditions?.length ? p.conditions : [blank()],
        threshold: p.threshold ?? d.threshold, age: p.age ?? d.age, severity: builtIn ? d.severity : p.severity, dimension: p.dimension || d.dimension }));
      setPreview(null);
      setAssist({ busy: false, note: r.explanation ? `Proposed: ${r.explanation} Review every field before saving.` : 'Proposed — review every field before saving.' });
      setStep(2);
    } catch (e) { setAssist({ busy: false, note: '' }); setError(e.message); }
  };

  const runPreview = async () => {
    setBusy(true); setError('');
    try {
      const url = builtIn ? `/health/rulebook/rules/${ruleId}/check/preview` : '/health/custom-rules/preview';
      setPreview((await api.post(url, payload())).result);
    } catch (e) { setError(e.message); setPreview(null); }
    setBusy(false);
  };

  const save = async () => {
    setBusy(true); setError('');
    try {
      if (builtIn) {
        const r = await api.put(`/health/rulebook/rules/${ruleId}/check`, payload());
        announceRuleChange(`${ruleId} ${hadCheck ? 'check updated' : 'now runs with your check'} — in every ${modules[def.module] ?? def.module} scan from the next one.`);
        onSaved(r.rule);
      } else {
        const r = existing ? await api.patch(`/health/custom-rules/${existing.rule_id}`, payload()) : await api.post('/health/custom-rules', payload());
        announceRuleChange(`${r.rule.rule_id} ${existing ? 'saved' : 'added'} — it runs in every ${modules[r.rule.module] ?? r.rule.module} scan from the next one.`);
        onSaved(r.rule);
      }
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  const canNext1 = def.name.trim() && def.module && def.dimension;
  const title = builtIn ? `${hadCheck ? 'Edit the check of' : 'Give a check to'} ${ruleId}` : existing ? `Edit ${existing.rule_id}` : 'Add a rule';
  const canNext2 = def.table.trim() && (def.kind === 'age' || def.conditions.some((c) => c.field));

  return (
    <div className="hx-modal" role="presentation">
      <div className="hx-modal-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="hx-modal-panel cr-panel" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={panelRef}>
        <header className="hx-modal-head">
          <h2>{title}</h2>
          <button type="button" className="hx-modal-x" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <ol className="cr-steps">
          {STEPS.map((s) => <li key={s.key} className={step === s.key ? 'is-on' : step > s.key ? 'is-done' : ''}>{s.key}. {s.title}</li>)}
        </ol>

        <div className="cr-body">
          {step === 1 && (
            <>
              {builtIn && (
                <p className="cr-note">
                  The product has no check for <b>{ruleId}</b> yet. Define one here — a record, rate or age check on one table — and it runs under {ruleId}{' '}
                  in every {modules[def.module] ?? def.module} scan, scored in the area you choose, at the rule's severity. <b>AI assist</b> drafts it from the rule's detection logic below; you review it and preview it on the instance before it is saved.
                </p>
              )}
              <div className="field"><label>Rule name</label><input className="input" maxLength={builtIn ? 300 : 120} value={def.name} readOnly={Boolean(builtIn)} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Active P1 incidents with no assignment group" /></div>
              <div className="cr-row">
                <div className="field"><label>Module</label>
                  <select className="select" value={def.module} disabled={Boolean(existing || builtIn)} onChange={(e) => set({ module: e.target.value })}>
                    {Object.entries(modules).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </div>
                <div className="field"><label>Scored in area</label>
                  <select className="select" value={def.dimension} onChange={(e) => set({ dimension: e.target.value })}>
                    {areas.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
                  </select>
                </div>
              </div>
              <div className="field"><label>{builtIn ? 'What it checks (from the rule — add anything the AI should know)' : 'What should it check?'}</label>
                <textarea className="textarea" rows={4} maxLength={2000} value={def.description} onChange={(e) => set({ description: e.target.value })}
                  placeholder="Describe it in plain English — e.g. active incidents with priority 1 that have no assignment group" />
              </div>
              {assist.note && <p className="cr-note">{assist.note}</p>}
            </>
          )}

          {step === 2 && (
            <>
              {assist.note && <p className="cr-note">{assist.note}</p>}
              <div className="cr-kinds">
                {KINDS.map((k) => (
                  <button key={k.key} type="button" className={`cr-kind${def.kind === k.key ? ' is-on' : ''}`} onClick={() => set({ kind: k.key })}>
                    <b>{k.title}</b><span>{k.sub}</span>
                  </button>
                ))}
              </div>
              <div className="cr-row">
                <div className="field"><label>Table</label><input className="input mono" value={def.table} onChange={(e) => set({ table: e.target.value })} placeholder="e.g. incident" /></div>
                <div className="field"><label>Severity</label>
                  <select className="select" value={def.severity} disabled={Boolean(builtIn)} title={builtIn ? 'The rule\'s own severity — change it from the rule' : undefined} onChange={(e) => set({ severity: e.target.value })}>
                    {SEVERITIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
              </div>
              <Conditions label="Applies to (optional)" hint="Narrows which records are checked — e.g. active is true." list={def.scope} onChange={(scope) => set({ scope })} />
              <Conditions label={def.kind === 'age' ? 'Only records where (optional)' : 'It is a problem when'} list={def.conditions} onChange={(conditions) => set({ conditions })} />
              {def.kind === 'rate' && (
                <div className="field cr-inline"><label>Fail when more than</label>
                  <input className="input" type="number" min="0.1" max="99.9" step="0.1" value={def.threshold.max_share} onChange={(e) => set({ threshold: { max_share: e.target.value } })} />
                  <span>% of the records match</span>
                </div>
              )}
              {def.kind === 'age' && (
                <div className="field cr-inline"><label>Older than</label>
                  <input className="input" type="number" min="1" max="3650" value={def.age.days} onChange={(e) => set({ age: { ...def.age, days: e.target.value } })} />
                  <span>days, measured by</span>
                  <input className="input mono" value={def.age.field} onChange={(e) => set({ age: { ...def.age, field: e.target.value } })} />
                </div>
              )}
              <label className="cr-check"><input type="checkbox" checked={def.scored} onChange={(e) => set({ scored: e.target.checked })} /> Count in the {modules[def.module]} score</label>
            </>
          )}

          {step === 3 && (
            <>
              <p className="hs-muted">The check runs read-only on the instance, exactly as a scan would run it. Nothing is changed and nothing is saved until you press Save.</p>
              <button type="button" className="btn" onClick={runPreview} disabled={busy} aria-busy={busy}>{preview ? 'Run preview again' : 'Run preview'}</button>
              {preview && (
                <div className={`cr-preview${preview.status !== 'evaluated' ? ' is-bad' : ''}`}>
                  {preview.status !== 'evaluated' ? (
                    <p><b>It cannot run as defined:</b> {preview.reason}. Fix the table or field names in step 2.</p>
                  ) : (
                    <>
                      <p><b>{preview.matches}</b> of <b>{preview.population}</b> records match{preview.share != null ? ` (${preview.share}%)` : ''} — the rule would <b>{preview.verdict === 'fail' ? 'fail' : preview.verdict === 'pass' ? 'pass' : 'have nothing to check'}</b> today.</p>
                      {!!preview.sample.length && (
                        <ul className="cr-sample">{preview.sample.map((s) => <li key={s.sys_id}><code>{s.label}</code></li>)}</ul>
                      )}
                      <p className="hs-muted cr-query">Query: <code>{preview.query}</code></p>
                    </>
                  )}
                </div>
              )}
            </>
          )}
          {error && <p className="rb-error">{error}</p>}
        </div>

        <footer className="cr-foot">
          {step === 1 && <button type="button" className="btn" onClick={runAssist} disabled={assist.busy || !(def.description.trim() || def.name.trim())} aria-busy={assist.busy}>✨ AI assist</button>}
          <span className="cr-spacer" />
          {step > 1 && <button type="button" className="btn ghost" onClick={() => setStep(step - 1)}>Back</button>}
          {step === 1 && <button type="button" className="btn primary" disabled={!canNext1} onClick={() => setStep(2)}>{existing ? 'Next' : 'Build it by hand'}</button>}
          {step === 2 && <button type="button" className="btn primary" disabled={!canNext2} onClick={() => { setStep(3); runPreview(); }}>Preview</button>}
          {step === 3 && <button type="button" className="btn primary" onClick={save} disabled={busy || !preview || preview.status !== 'evaluated'} aria-busy={busy}>{builtIn ? 'Save check' : 'Save rule'}</button>}
        </footer>
      </div>
    </div>
  );
}
