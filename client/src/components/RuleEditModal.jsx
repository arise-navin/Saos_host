import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { announceRuleChange } from './ruleChanges.js';

/*
 * EDIT A BUILT-IN RULE (Job HC-1). Everything a person can change about a
 * workbook rule, in one dialog:
 *
 *   in scans     switch it off (it stops running) or on again
 *   severity     a new base band — its findings and its weight in the score move
 *   wording      any column the Rulebook shows; the workbook's text stays beside it
 *   thresholds   the values its engine reads (the parameter registries) — a rule
 *                "waiting for a value" runs once its blocking values are set
 *
 * Nothing is written to ServiceNow. The server re-validates everything, keeps the
 * workbook untouched, and every scan from the next one applies the change.
 */

const SEVERITIES = ['Systemic', 'Critical', 'High', 'Moderate', 'Low'];
const FIELDS = [
  ['rule', 'Rule wording', 2], ['group', 'Group', 1], ['what_it_means', 'What it means', 3], ['why_it_matters', 'Why it matters', 3],
  ['detection_logic', 'Detection logic', 3], ['threshold_parameter', 'Threshold / parameter', 2], ['source_tables_fields', 'Source tables / fields', 2],
  ['false_positive_guard', 'False-positive guard', 3], ['remediation_lane', 'Remediation lane', 2], ['cross_domain_link', 'Cross-domain link', 2],
];
const clean = (s) => String(s ?? '').replace(/\\([_*])/g, '$1').trim();
const humanise = (k) => k.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

/** A threshold's value as the input shows it, and back. */
const toInput = (p) => (p.value == null ? '' : Array.isArray(p.value) ? p.value.join(', ') : String(p.value));
function fromInput(p, text) {
  const t = text.trim();
  if (t === '') return { empty: true };
  if (['number', 'percent', 'duration'].includes(p.type)) {
    const n = Number(t);
    return Number.isFinite(n) ? { value: n } : { error: `${humanise(p.key)} is a number.` };
  }
  if (p.type === 'boolean') return { value: t === 'true' };
  if (p.type === 'list') return { value: t.split(',').map((x) => x.trim()).filter(Boolean) };
  return { value: t };
}

export default function RuleEditModal({ rule, onClose, onSaved }) {
  const [detail, setDetail] = useState(null);
  const [form, setForm] = useState(null);
  const [values, setValues] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const panelRef = useRef(null);
  useEffect(() => { panelRef.current?.focus(); }, []);

  useEffect(() => {
    api.get(`/health/rulebook/rules/${encodeURIComponent(rule.id)}`).then((d) => {
      setDetail(d);
      const r = d.rule;
      setForm({ active: r.changes ? r.changes.active : true, severity: clean(r.base_severity), ...Object.fromEntries(FIELDS.map(([f]) => [f, clean(r[f])])) });
      setValues(Object.fromEntries(d.parameters.map((p) => [`${p.module}|${p.scope}|${p.key}`, toInput(p)])));
    }).catch((e) => setError(e.message));
  }, [rule.id]);

  const r = detail?.rule;
  const elsewhere = r?.base_status?.key === 'counted_elsewhere';
  const workbookOf = (f) => clean(r?.workbook?.[f] ?? r?.[f]);
  const changed = useMemo(() => {
    if (!r || !form) return { patch: {}, params: [] };
    const patch = {};
    if (form.active !== (r.changes ? r.changes.active : true)) patch.active = form.active;
    if (form.severity !== clean(r.base_severity)) patch.severity = form.severity;
    const fields = {};
    for (const [f] of FIELDS) if (form[f] !== clean(r[f])) fields[f] = form[f];
    if (Object.keys(fields).length) patch.fields = fields;
    const params = detail.parameters.filter((p) => values[`${p.module}|${p.scope}|${p.key}`] !== toInput(p));
    return { patch, params };
  }, [r, form, values, detail]);
  const dirty = Object.keys(changed.patch).length > 0 || changed.params.length > 0;

  const save = async () => {
    setBusy(true); setError('');
    const said = [];
    try {
      /* Thresholds first: a bad value stops the save before anything else changes. */
      const writes = [];
      for (const p of changed.params) {
        const got = fromInput(p, values[`${p.module}|${p.scope}|${p.key}`]);
        if (got.error) throw new Error(got.error);
        if (got.empty && p.source !== 'instance') continue;
        writes.push({ p, got });
      }
      for (const { p, got } of writes) {
        const url = `/health/rulebook/rules/${encodeURIComponent(rule.id)}/parameters/${p.module}/${encodeURIComponent(p.scope)}/${encodeURIComponent(p.key)}`;
        if (got.empty) await api.del(url); else await api.put(url, { value: got.value });
        said.push(`${humanise(p.key)} ${got.empty ? 'back to its default' : 'set'}`);
      }
      if (Object.keys(changed.patch).length) {
        const res = await api.patch(`/health/rulebook/rules/${encodeURIComponent(rule.id)}`, changed.patch);
        if (res.summary) said.unshift(res.summary);
      }
      announceRuleChange(`${rule.id}: ${said.join('; ') || 'saved'}.`);
      onSaved();
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  return (
    <div className="hx-modal" role="presentation">
      <div className="hx-modal-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="hx-modal-panel cr-panel re-panel" role="dialog" aria-modal="true" aria-label={`Edit ${rule.id}`} tabIndex={-1} ref={panelRef}>
        <header className="hx-modal-head">
          <h2>Edit {rule.id}</h2>
          <button type="button" className="hx-modal-x" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <div className="cr-body">
          {!form && !error && <p className="hs-muted">Loading the rule…</p>}
          {form && (
            <>
              <p className="cr-note">
                Your changes sit on top of the master workbook, which is never edited — <b>Reset</b> on the rule brings the workbook's version back.
                Every scan from the next one uses them; nothing is written to ServiceNow.
              </p>

              <div className="re-top">
                <label className={`re-switch${elsewhere ? ' is-disabled' : ''}`}>
                  <input type="checkbox" checked={form.active} disabled={elsewhere} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
                  <span><b>{form.active ? 'Runs in scans' : 'Switched off'}</b>{!form.active && <em> — it stops running and leaves its module's score</em>}</span>
                </label>
                <div className="field re-sev">
                  <label>Severity</label>
                  <select className="select" value={form.severity} disabled={elsewhere} onChange={(e) => setForm({ ...form, severity: e.target.value })}>
                    {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <span className="hs-muted re-was">Workbook: {workbookOf('base_severity')}</span>
                </div>
              </div>
              {elsewhere && <p className="hs-muted re-elsewhere">{r.base_status.label}: this rule is checked through that one, so switch that rule off or change its severity instead. Its wording can be edited here.</p>}

              {!!detail.parameters.length && (
                <section className="re-params">
                  <h3>Thresholds</h3>
                  <p className="hs-muted">The values this rule's check reads{r.base_status.key === 'needs_value' ? ' — it runs once every value marked “needed” is set' : ''}. Stored for this instance.</p>
                  {detail.parameters.map((p) => {
                    const k = `${p.module}|${p.scope}|${p.key}`;
                    const others = (p.rules || []).filter((id) => id !== rule.id);
                    return (
                      <div key={k} className="re-param">
                        <div className="re-param-name">
                          <b>{humanise(p.key)}</b>
                          {p.blocks && <span className="badge amber">needed</span>}
                          {p.source === 'instance' && <span className="badge blue">yours</span>}
                          <span className="hs-muted">{[p.type, p.unit].filter(Boolean).join(' · ')}{p.min != null ? ` · min ${p.min}` : ''}{p.max != null ? ` · max ${p.max}` : ''}</span>
                          {p.note && <span className="hs-muted re-param-note">{p.note}</span>}
                          {others.length > 0 && <span className="hs-muted re-param-note">Also tunes {others.slice(0, 6).join(', ')}{others.length > 6 ? ` and ${others.length - 6} more` : ''}.</span>}
                        </div>
                        {p.type === 'boolean' ? (
                          <select className="select" value={values[k]} disabled={!p.overridable} onChange={(e) => setValues({ ...values, [k]: e.target.value })}>
                            <option value="">—</option><option value="true">true</option><option value="false">false</option>
                          </select>
                        ) : (
                          <input className="input mono" value={values[k] ?? ''} disabled={!p.overridable} title={p.not_overridable_because || undefined}
                            inputMode={['number', 'percent', 'duration'].includes(p.type) ? 'decimal' : undefined}
                            placeholder={p.default != null ? `default ${Array.isArray(p.default) ? p.default.join(', ') : p.default}` : 'no default — set a value'}
                            onChange={(e) => setValues({ ...values, [k]: e.target.value })} />
                        )}
                        {p.workbook_text && <span className="hs-muted re-param-wb">Workbook: {clean(p.workbook_text)}</span>}
                      </div>
                    );
                  })}
                </section>
              )}

              <section className="re-fields">
                <h3>Wording</h3>
                {FIELDS.map(([f, label, rows]) => {
                  const differs = form[f] !== workbookOf(f);
                  return (
                    <div key={f} className="field">
                      <label>{label}{differs && <span className="badge amber re-edited">edited</span>}</label>
                      {rows === 1
                        ? <input className="input" value={form[f]} maxLength={f === 'rule' ? 300 : 4000} onChange={(e) => setForm({ ...form, [f]: e.target.value })} />
                        : <textarea className="textarea" rows={rows} value={form[f]} maxLength={f === 'rule' ? 300 : 4000} onChange={(e) => setForm({ ...form, [f]: e.target.value })} />}
                      {differs && (
                        <span className="re-was">
                          Workbook: <span className="hs-muted">{workbookOf(f) || '—'}</span>{' '}
                          <button type="button" className="rn-link" onClick={() => setForm({ ...form, [f]: workbookOf(f) })}>Use the workbook's</button>
                        </span>
                      )}
                    </div>
                  );
                })}
              </section>
            </>
          )}
          {error && <p className="rb-error">{error}</p>}
        </div>

        <footer className="cr-foot">
          <span className="hs-muted">{dirty ? 'Unsaved changes' : 'No changes yet'}</span>
          <span className="cr-spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" onClick={save} disabled={busy || !dirty} aria-busy={busy}>Save changes</button>
        </footer>
      </div>
    </div>
  );
}
