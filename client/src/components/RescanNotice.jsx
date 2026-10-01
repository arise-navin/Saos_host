import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { RULES_CHANGED, FULL_SCAN_PATH, ago } from './ruleChanges.js';
import './RescanNotice.css';

/*
 * RULES CHANGED, RESULTS NOT YET (Job HC-1). Shown while any rule change —
 * built-in or custom, a threshold included — has not been reflected by a
 * finished scan of its module (the server decides: GET /health/rulebook/changes).
 * It goes away by itself once a scan has re-read those modules.
 *
 *   on the Rulebook      the button goes to the full scan screen
 *   on Health Assist     the button starts the full scan (`onRunFull`)
 */

const MODULE_LABEL = { cmdb: 'CMDB', itsm: 'ITSM', itom: 'ITOM', platform: 'Platform', enterprise_dq: 'Enterprise DQ', csdm: 'CSDM', itil: 'ITIL' };
const list = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

export default function RescanNotice({ onRunFull = null, running = false, refreshKey = 0 }) {
  const navigate = useNavigate();
  const [state, setState] = useState(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    api.get('/health/rulebook/changes').then(setState).catch(() => setState(null));
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);
  useEffect(() => {
    window.addEventListener(RULES_CHANGED, load);
    return () => window.removeEventListener(RULES_CHANGED, load);
  }, [load]);

  const pending = state?.pending ?? [];
  if (!pending.length) return null;
  const modules = (state.modules ?? []).map((m) => MODULE_LABEL[m] ?? m);
  const rules = new Set(pending.map((c) => c.rule_id)).size;

  return (
    <section className="rn-notice" role="status" aria-live="polite">
      <span className="rn-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 4v5h-5" />
        </svg>
      </span>
      <div className="rn-body">
        <p className="rn-title">
          {rules === 1 ? 'A rule changed' : `${rules} rules changed`} since your last scan — a full scan is recommended.
        </p>
        <p className="rn-sub">
          Your health results for {list(modules) || 'these modules'} do not reflect {pending.length === 1 ? 'this change' : `these ${pending.length} changes`} yet.
          {state.last_scan && <> Last scan {ago(state.last_scan)}.</>}
          {' '}
          <button type="button" className="rn-link" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? 'Hide changes' : 'Show changes'}
          </button>
        </p>
        {open && (
          <ul className="rn-list">
            {pending.slice(0, 12).map((c) => (
              <li key={c.id}>
                <code>{c.rule_id}</code> <span>{c.summary}</span>
                <span className="rn-when" title={c.at}>{ago(c.at)}{c.actor ? ` · ${c.actor}` : ''}</span>
              </li>
            ))}
            {pending.length > 12 && <li className="rn-more">and {pending.length - 12} more</li>}
          </ul>
        )}
      </div>
      {onRunFull ? (
        <button type="button" className="btn primary rn-btn" onClick={onRunFull} disabled={running} aria-busy={running}>
          {running ? 'Scanning…' : 'Run full scan'}
        </button>
      ) : (
        <button type="button" className="btn primary rn-btn" onClick={() => navigate(FULL_SCAN_PATH)}>Go to full scan</button>
      )}
    </section>
  );
}
