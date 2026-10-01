import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { apiUrl } from '../apiBase.js';
import { toast } from '../components/toast.js';
import CustomRuleModal from '../components/CustomRuleModal.jsx';
import RuleEditModal from '../components/RuleEditModal.jsx';
import RescanNotice from '../components/RescanNotice.jsx';
import { announceRuleChange } from '../components/ruleChanges.js';

/*
 * THE RULEBOOK (D-038, Job HC-1) — every Health Assist rule, module by module, as
 * the master workbook states it, with what the product does with it today — and
 * everything a person can do with a rule:
 *
 *   add        a new rule in any module (a custom rule: record, rate or age check)
 *   edit       wording, severity and thresholds of any rule
 *   switch     a rule off (it stops running and leaves the score) or on again
 *   remove     a rule from the rulebook and every scan — and restore it
 *   check      give a rule the product never built a check of its own
 *   reset      a built-in rule back to the workbook's
 *   export     the rulebook, with the changes, as an Excel workbook
 *
 * The workbook itself is never edited: changes sit on top of it (server-side,
 * health/rule-overrides.js) and every scan applies them. After a change the page
 * says a full scan is recommended, until one has reflected it.
 */

export const SEVERITY_LABEL = { SYSTEMIC: 'Systemic', CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Moderate', LOW: 'Low' };
const SEVERITY_ORDER = ['Systemic', 'Critical', 'High', 'Moderate', 'Low'];
const STATUS_TONE = { runs: 'green', needs_value: 'amber', needs_answer: 'red', counted_elsewhere: 'blue', off: '', removed: '' };
const STATUS_FILTERS = [['', 'Any status'], ['runs', 'Runs'], ['needs_value', 'Built, waiting for a value'], ['needs_answer', 'Waiting on an answer'],
  ['counted_elsewhere', 'Counted elsewhere'], ['changed', 'Changed by you'], ['custom', 'Custom rules'], ['off', 'Switched off'], ['removed', 'Removed']];
const DETAIL = [
  ['what_it_means', 'What it means'], ['why_it_matters', 'Why it matters'], ['detection_logic', 'Detection logic'],
  ['threshold_parameter', 'Threshold / parameter'], ['source_tables_fields', 'Source tables / fields'],
  ['false_positive_guard', 'False-positive guard'], ['remediation_lane', 'Remediation lane'], ['cross_domain_link', 'Cross-domain link'],
];
const KIND_LABEL = { record: 'Record check', rate: 'Rate check', age: 'Age check' };
/* Which tab shows a custom rule of each module. */
const MODULE_TAB = { cmdb: 'cmdb', itsm: 'itsm', itom: 'itom', platform: 'platform', enterprise_dq: 'enterprise_dq', csdm: 'csdm', itil: 'itil' };

/* Paging, as the app's DataTable footer does it (Rows · ‹ page / pages ›). */
const PAGE_SIZES = [10, 12, 25, 50];
function Pager({ total, page, pageSize, onPage, onSize }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total ? page * pageSize + 1 : 0;
  const to = Math.min(total, (page + 1) * pageSize);
  return (
    <footer className="dt-foot">
      <span className="dt-count">{total === 0 ? 'No rules' : `${from}–${to} of ${total}`}</span>
      <label className="dt-size">
        Rows
        <select className="select" value={pageSize} onChange={(e) => onSize(Number(e.target.value))}>
          {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <div className="dt-pager">
        <button type="button" className="dt-page-btn" disabled={page === 0} onClick={() => onPage(page - 1)} aria-label="Previous page">‹</button>
        <span className="dt-page-now">{page + 1} / {pages}</span>
        <button type="button" className="dt-page-btn" disabled={page >= pages - 1} onClick={() => onPage(page + 1)} aria-label="Next page">›</button>
      </div>
    </footer>
  );
}

const clean = (s) => String(s ?? '').replace(/\\([_*])/g, '$1').trim();
const sevWord = (s) => SEVERITY_LABEL[String(s).toUpperCase()] ?? clean(s);
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const conds = (list) => (list || []).map((c) => `${c.field} ${c.op} ${c.value}`.trim()).join(' AND ');

function lastWord(last) {
  if (!last) return { text: 'Not run yet', tone: '' };
  if (last.status !== 'evaluated') return { text: 'Could not run', tone: 'amber', title: last.reason };
  if (last.verdict === 'fail') return { text: `Failed · ${last.matches} match${last.matches === 1 ? '' : 'es'}`, tone: 'red' };
  if (last.verdict === 'pass') return { text: 'Passed', tone: 'green' };
  return { text: 'Nothing to check', tone: '' };
}

/** A custom rule, shaped like a workbook row so one table lists both. */
const customRow = (c) => ({
  id: c.rule_id, rule: c.name, base_severity: SEVERITY_LABEL[c.severity] ?? c.severity, group: `Custom ${KIND_LABEL[c.kind]?.toLowerCase() ?? 'rule'} on ${c.table}`,
  status: c.active ? { key: 'runs', label: 'Runs — custom' } : { key: 'off', label: 'Switched off' }, custom: c,
});

/** The Export to Excel menu: this tab as filtered, or every tab. */
function ExportMenu({ tab, tabLabel, shown, filters }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const key = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key); };
  }, [open]);
  const qs = (t, withFilters) => {
    const p = new URLSearchParams({ tab: t });
    if (withFilters) for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
    if (withFilters && filters.status === 'removed') p.set('removed', '1');
    return apiUrl(`/health/rulebook/export.xlsx?${p}`);
  };
  const pick = (label) => { setOpen(false); toast.info(`Exporting ${label} to Excel…`); };
  return (
    <div className={`rb-export${open ? ' is-open' : ''}`} ref={ref}>
      <button type="button" className="btn" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="true">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 4v11M7 10l5 5 5-5" /><path d="M5 20h14" />
        </svg>
        Export to Excel
      </button>
      {open && (
        <div className="rb-export-menu" role="menu">
          <a role="menuitem" href={qs(tab, true)} download onClick={() => pick(tabLabel)}>
            <b>{tabLabel} tab</b><span>{shown} rule{shown === 1 ? '' : 's'}, as filtered now</span>
          </a>
          <a role="menuitem" href={qs('all', false)} download onClick={() => pick('the whole rulebook')}>
            <b>All tabs</b><span>Every rule, one sheet per module, with a summary</span>
          </a>
        </div>
      )}
    </div>
  );
}

export default function Rulebook() {
  const [book, setBook] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('cmdb');
  const [q, setQ] = useState('');
  const [severity, setSeverity] = useState('');
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState(null);
  const [modal, setModal] = useState(null);   // null | { kind: 'custom', rule? } | { kind: 'edit', rule } | { kind: 'check', rule }
  const [busy, setBusy] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  /* A new tab, search or filter starts again at the first page. */
  useEffect(() => { setPage(0); setOpen(null); }, [tab, q, severity, status, pageSize]);

  const load = async () => {
    try { setBook(await api.get('/health/rulebook')); setError(''); } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  const tabLabel = book?.tabs.find((t) => t.key === tab)?.label ?? tab;
  const tabModule = book?.tabs.find((t) => t.key === tab)?.module ?? null;

  const rows = useMemo(() => {
    if (!book) return [];
    const needle = q.trim().toLowerCase();
    const custom = book.custom.filter((c) => (tab === 'custom' || MODULE_TAB[c.module] === tab)).map(customRow);
    const builtIn = tab === 'custom' ? [] : (book.rules[tab] || []);
    return [...builtIn, ...custom].filter((r) => {
      if (status === 'removed') { if (r.status.key !== 'removed') return false; } else if (r.status.key === 'removed') return false;
      /* Changed by you: its own row of changes, or a threshold you set. */
      if (status === 'changed' && !r.changes && !r.thresholds?.own) return false;
      if (status === 'custom' && !r.custom) return false;
      if (status && !['changed', 'custom', 'removed'].includes(status) && r.status.key !== status) return false;
      if (severity && sevWord(r.base_severity) !== severity) return false;
      return !needle || `${r.id} ${clean(r.rule)} ${clean(r.group)} ${r.custom?.description ?? ''}`.toLowerCase().includes(needle);
    });
  }, [book, tab, q, severity, status]);

  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(page, pages - 1);
  const pageRows = rows.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const pager = <Pager total={rows.length} page={safePage} pageSize={pageSize} onPage={(n) => { setPage(n); setOpen(null); }} onSize={setPageSize} />;

  /* One call, one announcement, one reload — every quick action goes through here. */
  const act = async (key, fn, message) => {
    setBusy(key);
    try { const r = await fn(); announceRuleChange(typeof message === 'function' ? message(r) : message); await load(); } catch (e) { toast.error(e.message); }
    setBusy('');
  };
  const rid = (r) => encodeURIComponent(r.id);
  const switchRule = (r) => act(`sw-${r.id}`, () => api.patch(`/health/rulebook/rules/${rid(r)}`, { active: r.status.key === 'off' }),
    r.status.key === 'off' ? `${r.id} switched on — it runs again from the next scan.` : `${r.id} switched off — it no longer runs or counts in the score.`);
  const removeRule = (r) => {
    if (!window.confirm(`Remove ${r.id} "${clean(r.rule)}"?\n\nIt leaves the rulebook and stops running in every scan. Past scans keep their findings. You can restore it from the "Removed" filter.`)) return;
    act(`rm-${r.id}`, () => api.del(`/health/rulebook/rules/${rid(r)}`), `${r.id} removed from the rulebook and every scan.`);
    setOpen(null);
  };
  const restoreRule = (r) => act(`rs-${r.id}`, () => api.post(`/health/rulebook/rules/${rid(r)}/restore`), `${r.id} restored.`);
  const resetRule = (r) => {
    if (!window.confirm(`Reset ${r.id} to the workbook's version?\n\nYour wording, severity, on/off and its own check are dropped. Thresholds you set stay.`)) return;
    act(`rt-${r.id}`, () => api.post(`/health/rulebook/rules/${rid(r)}/reset`), `${r.id} reset to the workbook.`);
  };
  const clearCheck = (r) => {
    if (!window.confirm(`Remove the check you gave ${r.id}? It goes back to not running.`)) return;
    act(`ck-${r.id}`, () => api.del(`/health/rulebook/rules/${rid(r)}/check`), `${r.id}'s check removed — it no longer runs.`);
  };
  const toggleCustom = (c) => act(`sw-${c.rule_id}`, () => api.patch(`/health/custom-rules/${c.rule_id}`, { active: !c.active }), `${c.rule_id} ${c.active ? 'switched off' : 'switched on'}.`);
  const deleteCustom = (c) => {
    if (!window.confirm(`Delete ${c.rule_id} "${c.name}"? Its past findings stay in earlier scans; the rule stops running.`)) return;
    act(`rm-${c.rule_id}`, () => api.del(`/health/custom-rules/${c.rule_id}`), `${c.rule_id} deleted.`);
    setOpen(null);
  };
  /* "Counted in CMDB-012": go to that rule. */
  const goTo = (id) => {
    const t = Object.entries(book.rules).find(([, list]) => list.some((x) => x.id === id))?.[0];
    if (!t) return;
    setTab(t); setStatus(''); setSeverity(''); setQ(id);
  };

  const pickTab = (key) => { setTab(key); setOpen(null); if (['counted_elsewhere', 'needs_value', 'needs_answer'].includes(status) && key === 'custom') setStatus(''); };

  const renderBuiltInDetail = (r) => {
    const base = r.base_status?.key ?? r.status.key;
    const canCheck = ['needs_answer', 'needs_value'].includes(base) || r.changes?.check;
    const elsewhere = base === 'counted_elsewhere';
    const target = elsewhere ? /Counted in (\S+)/.exec(r.status.label)?.[1] : null;
    const removed = r.status.key === 'removed';
    return (
      <>
        {r.changes && (
          <p className="rb-changed">
            <b>Changed by you</b>
            {[!r.changes.active && !r.changes.deleted && 'switched off', r.changes.deleted && 'removed', r.changes.severity && `severity (workbook: ${clean(r.workbook.base_severity)})`,
              r.changes.edited?.length && `${r.changes.edited.length} column${r.changes.edited.length === 1 ? '' : 's'} reworded`, r.changes.check && 'given its own check'].filter(Boolean).join(' · ')}
            {r.changes.updated_at && <span className="hs-muted"> — {when(r.changes.updated_at)}{r.changes.updated_by ? ` by ${r.changes.updated_by}` : ''}</span>}
          </p>
        )}
        <dl className="rb-detail">
          {DETAIL.filter(([f]) => clean(r[f])).map(([f, label]) => (
            <div key={f}>
              <dt>{label}{r.workbook?.[f] != null && <span className="badge amber rb-mini">edited</span>}</dt>
              <dd>{clean(r[f])}</dd>
              {r.workbook?.[f] != null && <dd className="rb-was">Workbook: {clean(r.workbook[f]) || '—'}</dd>}
            </div>
          ))}
          {r.workbook?.rule != null && <div><dt>Workbook wording</dt><dd className="rb-was">{clean(r.workbook.rule)}</dd></div>}
          {r.thresholds && (
            <div><dt>Thresholds</dt><dd>{r.thresholds.count} value{r.thresholds.count === 1 ? '' : 's'} the check reads{r.thresholds.unresolved ? ` — ${r.thresholds.unresolved} still needed` : ''}{r.thresholds.own ? ` — ${r.thresholds.own} set by you` : ''}</dd></div>
          )}
          {r.changes?.check && (
            <div>
              <dt>Your check</dt>
              <dd>{KIND_LABEL[r.changes.check.kind]} on <code>{r.changes.check.table}</code>{r.changes.check.conditions?.length ? ` where ${conds(r.changes.check.conditions)}` : ''}{r.changes.check.scope?.length ? ` (among ${conds(r.changes.check.scope)})` : ''}</dd>
              <dd className="rb-was">Last scan: {lastWord(r.last).text}{r.last?.status === 'evaluated' ? ` — ${r.last.matches} of ${r.last.population} records` : ''}</dd>
            </div>
          )}
        </dl>
        <div className="rb-actions">
          {removed ? (
            <button type="button" className="btn sm primary" onClick={() => restoreRule(r)} disabled={busy === `rs-${r.id}`}>Restore</button>
          ) : (
            <>
              <button type="button" className="btn sm" onClick={() => setModal({ kind: 'edit', rule: r })}>Edit</button>
              {!elsewhere && (
                <button type="button" className="btn sm" onClick={() => switchRule(r)} disabled={busy === `sw-${r.id}`}>{r.status.key === 'off' ? 'Switch on' : 'Switch off'}</button>
              )}
              {base === 'needs_value' && !r.changes?.check && <button type="button" className="btn sm primary" onClick={() => setModal({ kind: 'edit', rule: r })}>Set its values</button>}
              {canCheck && r.status.key !== 'off' && (
                <button type="button" className={`btn sm${base === 'needs_answer' && !r.changes?.check ? ' primary' : ''}`} onClick={() => setModal({ kind: 'check', rule: r })}>
                  {r.changes?.check ? 'Edit its check' : 'Give it a check'}
                </button>
              )}
              {r.changes?.check && <button type="button" className="btn sm" onClick={() => clearCheck(r)} disabled={busy === `ck-${r.id}`}>Remove its check</button>}
              {target && <button type="button" className="btn sm" onClick={() => goTo(target)}>Go to {target}</button>}
              {r.changes && <button type="button" className="btn sm ghost" onClick={() => resetRule(r)} disabled={busy === `rt-${r.id}`}>Reset to workbook</button>}
              <button type="button" className="btn sm danger" onClick={() => removeRule(r)} disabled={busy === `rm-${r.id}`}>Remove</button>
            </>
          )}
        </div>
      </>
    );
  };

  const renderCustomDetail = (c) => (
    <>
      <dl className="rb-detail">
        {c.description && <div><dt>Description</dt><dd>{c.description}</dd></div>}
        <div><dt>Module</dt><dd>{book.modules[c.module] ?? c.module}</dd></div>
        <div><dt>Table</dt><dd><code>{c.table}</code></dd></div>
        {!!c.scope?.length && <div><dt>Applies to</dt><dd>{conds(c.scope)}</dd></div>}
        {!!c.conditions?.length && <div><dt>A problem when</dt><dd>{conds(c.conditions)}</dd></div>}
        {c.kind === 'rate' && <div><dt>Fails above</dt><dd>{c.threshold.max_share}% of the records</dd></div>}
        {c.kind === 'age' && <div><dt>Older than</dt><dd>{c.age.days} days by {c.age.field}</dd></div>}
        <div><dt>Scored in</dt><dd>{book.dimensions[c.module]?.find((d) => d.key === c.dimension)?.label ?? c.dimension}{c.scored ? '' : ' (reported, not scored)'}</dd></div>
        <div><dt>Last scan</dt><dd>{c.last ? (c.last.status === 'evaluated' ? `${c.last.matches} of ${c.last.population} records matched${c.last.share != null ? ` (${c.last.share}%)` : ''}` : c.last.reason) : 'Not run yet'}</dd></div>
      </dl>
      <div className="rb-actions">
        <button type="button" className="btn sm" onClick={() => setModal({ kind: 'custom', rule: c })}>Edit</button>
        <button type="button" className="btn sm" onClick={() => toggleCustom(c)} disabled={busy === `sw-${c.rule_id}`}>{c.active ? 'Switch off' : 'Switch on'}</button>
        <button type="button" className="btn sm danger" onClick={() => deleteCustom(c)} disabled={busy === `rm-${c.rule_id}`}>Delete</button>
      </div>
    </>
  );

  return (
    <div className="page rb-page">
      <header className="rb-head">
        <div>
          <h1 className="rb-title">Rulebook</h1>
          <p className="rb-sub">Every rule Health Assist scans with, module by module — as the master workbook states it, what the product does with it today, and what you changed. Add, edit, switch off or remove any rule; every scan from the next one uses your changes.</p>
        </div>
        {book && (
          <div className="rb-head-actions">
            <ExportMenu tab={tab} tabLabel={tabLabel} shown={rows.length} filters={{ q: q.trim(), severity, status: tab === 'custom' ? '' : status }} />
            <button type="button" className="btn primary" onClick={() => setModal({ kind: 'custom' })}>+ Add rule</button>
          </div>
        )}
      </header>

      <RescanNotice />

      {error && <p className="rb-error">{error}</p>}
      {!book && !error && <p className="hs-muted">Loading the rulebook…</p>}

      {book && (
        <>
          <nav className="tabs rb-tabs" aria-label="Modules">
            {book.tabs.map((t) => (
              <button key={t.key} type="button" className={`tab${tab === t.key ? ' active' : ''}`} onClick={() => pickTab(t.key)}>
                {t.label} <span className="rb-count">{t.count + (t.key !== 'custom' ? book.custom.filter((c) => MODULE_TAB[c.module] === t.key).length : 0)}</span>
              </button>
            ))}
          </nav>

          <div className="rb-tools">
            <input className="input rb-search" placeholder="Search by rule ID, wording or group" value={q} onChange={(e) => setQ(e.target.value)} />
            <select className="select" value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="Severity">
              <option value="">Any severity</option>
              {SEVERITY_ORDER.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select className="select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
              {STATUS_FILTERS.filter(([k]) => tab !== 'custom' || ['', 'runs', 'off'].includes(k)).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <span className="hs-muted rb-shown">{rows.length} rule{rows.length === 1 ? '' : 's'}</span>
          </div>

          <div className="table-wrap card rb-card">
            {tab === 'custom' && !book.custom.length ? (
              <div className="rb-empty">
                <p><b>No custom rules yet.</b></p>
                <p className="hs-muted">Describe a check in plain English — for example "active P1 incidents with no assignment group" — and it runs in every scan of its module, scored with that module's own arithmetic.</p>
                <button type="button" className="btn primary" onClick={() => setModal({ kind: 'custom' })}>+ Add rule</button>
              </div>
            ) : (
              <>
                <table className="table rb-table">
                  <thead><tr><th className="tight">Rule ID</th><th>Rule</th><th className="tight">Severity</th><th>Group</th><th className="tight">Status</th></tr></thead>
                  <tbody>
                    {pageRows.map((r) => (
                      <Fragment key={r.id}>
                        <tr className={`click${open === r.id ? ' selected' : ''}${['off', 'removed'].includes(r.status.key) ? ' rb-off' : ''}`} onClick={() => setOpen(open === r.id ? null : r.id)}>
                          <td className="tight"><code>{r.id}</code></td>
                          <td className="grow">
                            {clean(r.rule)}
                            {r.custom && <span className="badge blue rb-mini">custom</span>}
                            {(r.changes || r.thresholds?.own > 0) && !r.custom && <span className="badge amber rb-mini" title="Changed by you">edited</span>}
                          </td>
                          <td className="tight"><span className={`rb-sev rb-sev-${sevWord(r.base_severity).toLowerCase()}`}>{sevWord(r.base_severity)}</span></td>
                          <td className="rb-group">{clean(r.group)}</td>
                          <td className="tight">
                            {r.custom
                              ? <span className={`badge ${r.custom.active ? lastWord(r.custom.last).tone || 'green' : ''}`} title={lastWord(r.custom.last).title}>{r.custom.active ? `Custom · ${lastWord(r.custom.last).text}` : 'Switched off'}</span>
                              : <span className={`badge ${STATUS_TONE[r.status.key] ?? ''}`}>{r.status.label}</span>}
                          </td>
                        </tr>
                        {open === r.id && (
                          <tr className="rb-detail-row"><td colSpan={5}>
                            {r.custom ? renderCustomDetail(r.custom) : renderBuiltInDetail(r)}
                          </td></tr>
                        )}
                      </Fragment>
                    ))}
                    {!rows.length && <tr><td colSpan={5} className="hs-muted">No rule matches these filters.</td></tr>}
                  </tbody>
                </table>
                {pager}
              </>
            )}
          </div>
        </>
      )}

      {modal?.kind === 'custom' && book && (
        <CustomRuleModal
          existing={modal.rule ?? null}
          presetModule={tabModule}
          modules={book.modules}
          dimensions={book.dimensions}
          onClose={() => setModal(null)}
          onSaved={(saved) => { setModal(null); if (saved?.module && tab !== 'custom' && MODULE_TAB[saved.module] !== tab) setTab(MODULE_TAB[saved.module]); load(); }}
        />
      )}
      {modal?.kind === 'check' && book && (
        <CustomRuleModal
          builtIn={{ rule: modal.rule }}
          modules={book.modules}
          dimensions={book.dimensions}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load(); }}
        />
      )}
      {modal?.kind === 'edit' && (
        <RuleEditModal rule={modal.rule} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />
      )}
    </div>
  );
}
