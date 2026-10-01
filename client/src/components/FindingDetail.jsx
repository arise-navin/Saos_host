import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { ItsmFindingDetail } from './HealthItsm.jsx';
import './FindingDetail.css';

/*
 * ONE HEALTH ASSIST FINDING — the detail page.
 *
 * PRESENTATION ONLY. Everything shown comes from the finding and the
 * remediation guidance the server already returns
 * (GET /health/runs/:runId/findings/:fingerprint); the actions are the page's
 * own handlers, passed in: `onGenerate` opens the same RemediationDrawer,
 * `onAskAgent` is the same Agent hand-off, `onTab` the same lane switch. The
 * only request made here is a READ — the existing findings search, to list
 * other findings on the same records.
 *
 * Progressive disclosure: the problem and why it matters first; the rule's
 * mechanics and the evidence in sections that fold away.
 */

export const minutes = (m) => {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}h ${rest}m` : `${h}h`;
};

/*
 * Inline code and bold only, for the hand-written manual steps.
 *
 * The remediation steps are written by hand in this repository and are the only
 * thing passed through it — not model output and not instance data — so the
 * input is trusted. Everything that is not one of those two spans is ESCAPED
 * first, so even if that ever stopped being true the worst case is visible
 * markup rather than injected HTML.
 */
export function mdLite(text) {
  const escaped = String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

const PATHS = {
  alert: <><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></>,
  file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 13h8M8 17h6" /></>,
  db: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
  box: <><path d="M21 8 12 3 3 8v8l9 5 9-5z" /><path d="m3 8 9 5 9-5M12 13v8" /></>,
  tag: <><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" /><circle cx="7.5" cy="7.5" r="1.5" /></>,
  info: <><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></>,
  chevron: <path d="m6 9 6 6 6-6" />,
  list: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9h10M7 13h10M7 17h6" /></>,
  nodes: <><circle cx="12" cy="5" r="2.5" /><circle cx="5" cy="19" r="2.5" /><circle cx="19" cy="19" r="2.5" /><path d="M12 7.5v4M12 11.5 6.5 17M12 11.5l5.5 5.5" /></>,
  sparkle: <><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /><path d="M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" /></>,
  wrench: <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  chat: <path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z" />,
  back: <path d="M19 12H5M11 18l-6-6 6-6" />,
  check: <path d="M20 6 9 17l-5-5" />,
};

function Icon({ name, size = 16 }) {
  return (
    <svg className="fd-icon" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{PATHS[name]}</svg>
  );
}

/** A section that folds away. Open/closed is presentation only. */
function Fold({ icon, title, count, sub, defaultOpen = true, children, className = '' }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`fd-fold${open ? ' is-open' : ''} ${className}`.trim()}>
      <button type="button" className="fd-fold-head" onClick={() => setOpen((x) => !x)} aria-expanded={open}>
        <Icon name={icon} size={17} />
        <span className="fd-fold-title">{title}</span>
        {count != null && <span className="fd-count">{count}</span>}
        {sub && <span className="fd-fold-sub">{sub}</span>}
        <span className="fd-fold-chev"><Icon name="chevron" size={16} /></span>
      </button>
      {open && <div className="fd-fold-body">{children}</div>}
    </section>
  );
}

const pct = (c) => (typeof c === 'number' && c >= 0 && c <= 1 ? `${Math.round(c * 100)}%` : c);

/* Up to this many of a finding's records are searched for other findings. */
const RELATED_TARGETS = 3;
const RELATED_MAX = 8;

/**
 * Other findings on the same records — the existing findings search, which
 * matches a record's sys_id in `target_ids`. Read only; it changes nothing.
 */
function useRelatedFindings(f) {
  const [state, setState] = useState({ loading: false, rows: null, error: '' });
  const ids = (f?.target_ids || []).slice(0, RELATED_TARGETS);
  const key = `${f?.fingerprint}:${ids.join(',')}`;
  useEffect(() => {
    if (!f || !ids.length) { setState({ loading: false, rows: null, error: '' }); return undefined; }
    let alive = true;
    setState({ loading: true, rows: null, error: '' });
    Promise.all(ids.map((id) => api.get(`/health/modules/findings?q=${encodeURIComponent(id)}&limit=${RELATED_MAX + 1}`)))
      .then((pages) => {
        if (!alive) return;
        const seen = new Set([f.fingerprint]);
        const rows = [];
        for (const p of pages) {
          for (const x of p.findings || []) {
            if (seen.has(x.fingerprint)) continue;
            seen.add(x.fingerprint);
            rows.push(x);
          }
        }
        setState({ loading: false, rows: rows.slice(0, RELATED_MAX), error: '' });
      })
      .catch((e) => { if (alive) setState({ loading: false, rows: null, error: e.message }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { ...state, searched: ids.length, more: (f?.target_ids?.length || 0) > ids.length };
}


const EVIDENCE_PAGE = 25;

/*
 * MANUAL VS AGENT, AS TWO BARS ON ONE SCALE. The longer estimate is the full
 * bar; nothing here was timed, and the panel says so in words, with the basis
 * and the disclaimer one hover away.
 */
function EstimateBars({ effort }) {
  const manual = Number(effort.manualMinutes) || 0;
  const ai = Number(effort.aiMinutes) || 0;
  const max = Math.max(manual, ai, 1);
  const saved = manual > ai ? manual - ai : 0;
  const note = [effort.basis, effort.disclaimer].filter(Boolean).join(' ');
  const row = (label, value, cls) => (
    <div className="fd-est-row">
      <span className="fd-est-label">{label}</span>
      <span className="fd-est-track" aria-hidden="true">
        <span className={`fd-est-fill ${cls}`} style={{ width: `${Math.max(3, (value / max) * 100)}%` }} />
      </span>
      <span className="fd-est-val">{minutes(value)}</span>
    </div>
  );
  return (
    <div className="fd-estimate">
      <div className="fd-est-head">
        <span className="fd-estimate-icon"><Icon name="clock" size={20} /></span>
        <div>
          <b>Estimated time</b>
          <span className="fd-est-fine" title={note}>
            Estimated, not measured <Icon name="info" size={13} />
          </span>
          {saved > 0 && <span className="fd-est-saved">Saves ~{minutes(saved)}</span>}
        </div>
      </div>
      <div className="fd-est-bars" role="img" aria-label={`By hand ${minutes(manual)}, with the agent ${minutes(ai)}`}>
        {row('By hand', manual, 'is-manual')}
        {row('With the agent', ai, 'is-agent')}
      </div>
    </div>
  );
}

export default function FindingDetail({
  f, r, sev, sevByKey, moduleLabel, backLabel, onBack,
  tab, onTab, onGenerate, onAskAgent, onOpenFinding,
}) {
  const [allEvidence, setAllEvidence] = useState(false);
  const related = useRelatedFindings(f);

  const records = f.target_ids?.length ?? 0;
  const evidence = f.evidence || [];
  const shownEvidence = allEvidence ? evidence : evidence.slice(0, EVIDENCE_PAGE);
  const evidenceRecords = new Set(evidence.map((e) => e.sn_sys_id)).size;
  const multiRecord = evidenceRecords > 1;
  const hasReason = evidence.some((e) => e.reason);
  /* The evidence summary: what was read, and which fields came back empty. */
  const emptyFields = [...new Set(evidence.filter((e) => e.field_value === '').map((e) => e.field_name))];
  const human = r.decision !== 'mechanical';
  const cat = r.catalogue;
  const sevLabel = (k) => sevByKey[k]?.label || k;

  /* The catalogue's scoring notes, kept — just moved out of the header. */
  const scoring = f.catalogued ? [
    f.base_severity && f.base_severity !== f.severity && `Base ${sevLabel(f.base_severity)} → effective ${sev.label}`,
    f.gate && 'Trust gate — outside the score',
    f.escalated_to_systemic && 'Escalated to Systemic — zeroes its record, does not gate',
    f.posture && 'Systemic posture — does not gate, does not score',
    f.pattern && 'Class-wide pattern — does not zero records',
    !f.pattern && f.deduction_severity && f.deduction_severity !== f.severity && `Charged as ${sevLabel(f.deduction_severity)}`,
    !f.dimension && f.catalogue_group && `Group ${f.catalogue_group}`,
    f.lane && `Lane ${f.lane}`,
  ].filter(Boolean) : [];

  return (
    <div className="fd">
      {/* ── HEADER ─────────────────────────────────────────────────────── */}
      <header className="fd-head">
        <div className="fd-head-text">
          <nav className="fd-crumbs" aria-label="Breadcrumb">
            <button type="button" onClick={onBack}>Health Assist</button>
            <span aria-hidden="true">/</span>
            <button type="button" onClick={onBack}>{backLabel}</button>
            <span aria-hidden="true">/</span>
            <span className="fd-crumb-here">{f.rule_id}</span>
          </nav>
          <h1 className="fd-title">{r.headline}</h1>
          {f.title && f.title !== r.headline && <p className="fd-sub">{f.title}</p>}
        </div>
        <button type="button" className="btn fd-back" onClick={onBack}>
          <Icon name="back" /> Back to {backLabel.toLowerCase()}
        </button>
      </header>

      <div className="fd-badges">
        <span className={`fd-badge fd-badge-sev tone-${sev.tone}`}><Icon name="alert" /> {sev.label}</span>
        <span className="fd-badge"><Icon name="file" /> {records.toLocaleString()} record{records === 1 ? '' : 's'} affected</span>
        {f.table && <span className="fd-badge"><Icon name="db" /> Table <b className="mono">{f.table}</b></span>}
        {moduleLabel && <span className="fd-badge"><Icon name="box" /> Module <b>{moduleLabel}</b></span>}
        {f.dimension && <span className="fd-badge"><Icon name="tag" /> Dimension <b>{f.dimension}</b></span>}
      </div>

      {/* ── TOP ROW: what is wrong | how to fix it, side by side ──────────── */}
      <div className="fd-grid">
        <section className="fd-card">
          <h2 className="fd-card-title"><Icon name="file" size={19} /> Finding overview</h2>

          <h3 className="fd-h3">The problem</h3>
          <p className="fd-text">{r.problem}</p>
          {/* Why it matters — part of the problem, not a box of its own. */}
          {r.why && <p className="fd-text">{r.why}</p>}

          {f.ai_summary && (
            <div className="fd-callout">
              <span className="fd-callout-icon"><Icon name="sparkle" size={18} /></span>
              <div>
                <b>AI summary</b>
                <p>{f.ai_summary} <em>Written from the finding above; the finding itself is deterministic.</em></p>
              </div>
            </div>
          )}

          <div className="fd-evsum">
            <Fold icon="db" className="fd-fold-flat"
              title={`Evidence (${evidence.length.toLocaleString()} field${evidence.length === 1 ? '' : 's'})`}
              sub={evidence.length > 0 && (
                <>
                  {evidence.length.toLocaleString()} field{evidence.length === 1 ? '' : 's'} checked
                  {multiRecord && <> across {evidenceRecords.toLocaleString()} records</>}
                  {emptyFields.length > 0 && (
                    <>
                      <span className="fd-dot" aria-hidden="true">•</span>
                      {emptyFields.slice(0, 3).map((n) => <code key={n} className="fd-code">{n}</code>)}
                      {emptyFields.length > 3 && <> +{emptyFields.length - 3} more</>}
                      {' '}{emptyFields.length === 1 ? 'is' : 'are'} empty
                    </>
                  )}
                </>
              )}>
                {evidence.length === 0 ? (
                  <p className="fd-muted fd-small">No field-level evidence was stored for this finding.</p>
                ) : (
                  <>
                    <div className="fd-table-wrap">
                      <table className="fd-table">
                        <thead>
                          <tr>
                            {multiRecord && <th>Record</th>}
                            <th>Field</th><th>Value</th>
                            {hasReason && <th>Why it matters</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {shownEvidence.map((e, i) => (
                            <tr key={`${e.sn_sys_id}-${e.field_name}-${i}`}>
                              {multiRecord && <td className="mono fd-sysid">{e.sn_sys_id}</td>}
                              <td className="mono">{e.field_name}</td>
                              <td className="mono">{e.field_value === '' ? <em className="fd-muted">(empty)</em> : e.field_value}</td>
                              {hasReason && <td className="fd-muted">{e.reason || '—'}</td>}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {evidence.length > EVIDENCE_PAGE && (
                      <button type="button" className="btn ghost sm fd-more" onClick={() => setAllEvidence((x) => !x)}>
                        {allEvidence ? `Show the first ${EVIDENCE_PAGE}` : `Show all ${evidence.length.toLocaleString()} rows`}
                      </button>
                    )}
                  </>
                )}
            </Fold>
          </div>
        </section>

        <section className="fd-card">
          <h2 className="fd-card-title"><Icon name="wrench" size={19} /> Remediation</h2>

          <div className={`fd-decision ${human ? 'is-human' : 'is-mech'}`}>
            <span className="fd-decision-icon"><Icon name={human ? 'alert' : 'check'} size={16} /></span>
            <div>
              <b>{human ? 'This one needs your judgement.' : 'This one has a definite fix.'}</b>
              <p>{r.decisionNote}</p>
            </div>
          </div>

          <div className="fd-modes" role="radiogroup" aria-label="How to fix it">
            <button type="button" role="radio" aria-checked={tab === 'ai'}
              className={`fd-mode${tab === 'ai' ? ' is-on' : ''}`} onClick={() => onTab('ai')}>
              <Icon name="sparkle" size={19} />
              <span className="fd-mode-text"><b>{r.aiActionLabel}</b><span>Let the agent analyse the records and propose a plan</span></span>
              <span className="fd-radio" aria-hidden="true" />
            </button>
            <button type="button" role="radio" aria-checked={tab === 'manual'}
              className={`fd-mode${tab === 'manual' ? ' is-on' : ''}`} onClick={() => onTab('manual')}>
              <Icon name="wrench" size={19} />
              <span className="fd-mode-text"><b>Fix manually</b><span>Follow the manual steps yourself</span></span>
              <span className="fd-radio" aria-hidden="true" />
            </button>
          </div>

          {tab === 'ai' ? (
            <div className="fd-lane">
              <p className="fd-text">
                The agent reads the affected record(s), works out what it would change, and shows you the exact
                list — record by record, field by field, with the current value beside the proposed one.
              </p>
              <ol className="fd-stepper">
                <li><span className="fd-step-n is-on">1</span><b>Review evidence</b><span>The agent reads the records and their context.</span></li>
                <li><span className="fd-step-n">2</span><b>Build a proposed plan</b><span>It proposes specific changes, with its reasoning.</span></li>
                <li><span className="fd-step-n">3</span><b>Approve changes</b><span>You review, edit or remove, then approve. <b>Nothing is changed until you approve.</b></span></li>
              </ol>
              <button type="button" className="btn primary fd-cta" onClick={onGenerate}>
                <Icon name="sparkle" size={18} /> Generate remediation plan →
              </button>
              <button type="button" className="fd-link" onClick={onAskAgent}>
                <Icon name="chat" /> Discuss in Agent chat instead
              </button>
            </div>
          ) : (
            <div className="fd-lane">
              <ol className="fd-manual">
                {r.manualSteps.map((step, i) => (
                  <li key={i}>
                    <span className="fd-step-n">{i + 1}</span>
                    <span dangerouslySetInnerHTML={{ __html: mdLite(step) }} />
                  </li>
                ))}
              </ol>
              {r.verify && (
                <div className="fd-callout">
                  <span className="fd-callout-icon"><Icon name="check" size={18} /></span>
                  <div><b>How to check it worked</b><p>{r.verify}</p></div>
                </div>
              )}
            </div>
          )}

          {!r.known && (
            <p className="fd-muted fd-small fd-generic">
              No hand-written guidance exists for this rule yet, so these are generic steps. The finding itself is
              unaffected — it came from the rule pack and carries its own evidence.
            </p>
          )}

          {r.effort && <EstimateBars effort={r.effort} />}
        </section>
      </div>

      {/* ── FINDING DETAILS: the rule's mechanics (the evidence is in the overview) ── */}
      <section className="fd-card fd-card-tight">
        <Fold icon="file" title="Finding details" defaultOpen={false} className="fd-fold-flat"
          sub="Rule logic, source tables, threshold, scoring and other technical details">
        <div className="fd-block">
          <h3 className="fd-block-title"><Icon name="file" size={17} /> Detection details</h3>
          <dl className="fd-kv">
            <div><dt>Rule ID</dt><dd className="mono">{f.rule_id}</dd></div>
            {f.description && <div><dt>What it checks</dt><dd>{f.description}</dd></div>}
            <div><dt>Source table</dt><dd className="mono">{cat?.sourceTables || f.table}</dd></div>
            {cat?.detectionLogic && <div><dt>Detection logic</dt><dd className="mono">{cat.detectionLogic}</dd></div>}
            {cat?.threshold && <div><dt>Threshold</dt><dd>{cat.threshold}</dd></div>}
            {(f.confidence != null || cat?.confidenceBasis) && (
              <div>
                <dt>Confidence</dt>
                <dd>
                  {f.confidence != null && <span className="fd-pill">{pct(f.confidence)}</span>}
                  {cat?.confidenceBasis && <span className="fd-muted"> {cat.confidenceBasis}</span>}
                </dd>
              </div>
            )}
            {cat?.falsePositiveGuard && (
              <div>
                <dt>False-positive guard</dt>
                <dd>
                  {cat.falsePositiveGuard}
                  {f.false_positive_guard && (
                    <div className={f.false_positive_guard.evaluated ? 'fd-muted' : 'hs-guard-open'}>
                      {f.false_positive_guard.evaluated ? 'Checked: ' : 'Not checked by machine: '}
                      {f.false_positive_guard.note}
                    </div>
                  )}
                </dd>
              </div>
            )}
            {f.modifiers && (f.modifiers.escalators?.length > 0 || f.modifiers.de_escalators?.length > 0) && (
              <div>
                <dt>Modifiers applied</dt>
                <dd>{[...(f.modifiers.escalators || []).map((m) => `↑ ${m}`), ...(f.modifiers.de_escalators || []).map((m) => `↓ ${m}`)].join(' · ')}</dd>
              </div>
            )}
            {cat?.crossDomainLink && <div><dt>Cross-domain link</dt><dd>{cat.crossDomainLink}</dd></div>}
            {scoring.length > 0 && <div><dt>Scoring</dt><dd>{scoring.join(' · ')}</dd></div>}
          </dl>
          {f.itsm && <div className="fd-itsm"><ItsmFindingDetail f={f} /></div>}
        </div>

        {r.tables?.length > 0 && (
          <div className="fd-block">
            <h3 className="fd-block-title"><Icon name="db" size={17} /> Tables it reads <span className="fd-count">{r.tables.length}</span></h3>
            <div className="fd-table-wrap">
              <table className="fd-table">
                <thead><tr><th>Table</th><th>Fields</th><th>Why</th></tr></thead>
                <tbody>
                  {r.tables.map((t) => (
                    <tr key={t.table}>
                      <td className="mono">{t.table}</td>
                      <td className="mono">{t.fields.join(', ') || '—'}</td>
                      <td>{t.role}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        </Fold>
      </section>

      {/* ── CONNECTED IMPACT — the summary on the row, the detail one click down ── */}
      {f.impact && (
        <section className="fd-card fd-card-tight">
          <Fold icon="nodes" title="Connected impact" defaultOpen={false} className="fd-fold-flat"
            count={f.impact.reachable_nodes != null ? f.impact.reachable_nodes.toLocaleString() : null}
            sub={(
              <span className="fd-sub-stack">
                {f.impact.reachable_nodes != null && (
                  <b>
                    {f.impact.reachable_nodes.toLocaleString()} related record{f.impact.reachable_nodes === 1 ? '' : 's'}
                    {f.impact.max_depth != null && <> within {f.impact.max_depth} hops</>}
                  </b>
                )}
                <i>{f.impact.interpretation}.</i>
              </span>
            )}>
            <dl className="fd-kv">
              {f.impact.reachable_nodes != null && (
                <div><dt>Related records</dt><dd>{f.impact.reachable_nodes.toLocaleString()}</dd></div>
              )}
              {f.impact.max_depth != null && (
                <div><dt>Relationship depth</dt><dd>Up to {f.impact.max_depth} hops from the affected record{records === 1 ? '' : 's'}</dd></div>
              )}
              {f.impact.direction && (
                <div>
                  <dt>Direction</dt>
                  <dd>{f.impact.direction === 'undirected' ? 'Both ways — parents and children'
                    : f.impact.direction === 'estate' ? 'Estate-wide' : f.impact.direction}</dd>
                </div>
              )}
              <div><dt>What it means</dt><dd>{f.impact.interpretation}.</dd></div>
            </dl>
          </Fold>
        </section>
      )}

      {/* ── RELATED FINDINGS ───────────────────────────────────────────── */}
      {related.searched > 0 && (
        <section className="fd-card fd-card-tight">
          <Fold icon="nodes" defaultOpen={false} className="fd-fold-flat"
            title="Related findings"
            sub={`Other findings on ${records === 1 ? 'this record' : related.more ? `the first ${related.searched} of these records` : 'these records'}`}
            count={related.rows ? related.rows.length : null}>
            {related.loading && <p className="fd-muted fd-small">Looking…</p>}
            {related.error && <p className="error-text">{related.error}</p>}
            {related.rows && related.rows.length === 0 && (
              <p className="fd-muted fd-small">No other finding names {records === 1 ? 'this record' : 'these records'}.</p>
            )}
            {related.rows?.length > 0 && (
              <ul className="fd-related">
                {related.rows.map((x) => {
                  const s = sevByKey[x.severity] || { label: x.severity, tone: 'info' };
                  return (
                    <li key={x.fingerprint}>
                      <button type="button" onClick={() => onOpenFinding(x.fingerprint, x.run_id)}>
                        <span className={`hs-sev-tag sm tone-${s.tone}`}>{s.label}</span>
                        <span className="fd-related-title">{x.title}</span>
                        <span className="mono fd-muted fd-small">{x.rule_id}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Fold>
        </section>
      )}
    </div>
  );
}
