import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { version as CLIENT_VERSION } from '../../package.json';
import { THEMES, THEME_INFO, preloadTheme, useTheme } from '../theme.js';
import { refreshHealth } from '../hooks/useHealth.js';
import { refreshBinding } from '../hooks/useBinding.js';
import { useOnboarding, setOnboardingStatus } from '../hooks/useOnboarding.js';
import { buildScoresIfNone } from './healthRun.js';
import { PROVIDERS, PROVIDER_HINTS, providerById, providerNeeds } from './llmProviders.js';
import {
  SETUP_STEPS, stepPercent, clampStep, normaliseInstanceUrl, instanceUrlProblem, instanceHost,
  firstName, checksVerdict, reasonNotice, readSetupStep, writeSetupStep, clearSetupStep,
} from './onboardingModel.js';
import './Onboarding.css';

/*
 * THE SETUP WIZARD — first run, a move to another computer, or "Re-run setup".
 *
 * Five steps: who you are (and how the studio looks), whether this machine can
 * run SAOS, which model the agent runs on, which instance it works against,
 * and a summary. It is an OVERLAY like the startup screen, not a gate: the
 * shell mounts underneath exactly as it always does, and this only decides
 * whether to stand in front of it (config/onboarding.js on the server owns
 * that decision).
 *
 * Nothing here is a second settings store. The model and the connection are
 * saved through the same routes Settings and the Dashboard use, so what the
 * wizard sets is what those pages show, and the server's own refusals still
 * apply. The only new records are a display name and "setup finished here".
 *
 * LAYOUT — wide screens get a side rail (brand, the step list, what stays
 * local) beside a left-aligned form; below 1024px the rail becomes a compact
 * top bar with the progress. Buttons, fields and labels are the app's own
 * .btn / .input / .label, so each theme's rules reach them.
 *
 * MOTION — deliberately quiet. A step fades in; nothing floats, pulses,
 * slides or lifts on hover. Measured 2026-09-28: a floating logo, hover lifts
 * that flickered at an element's edge, a 22px sideways slide that briefly
 * added a scrollbar, and check rows that grew as they resolved all read as
 * the page shaking.
 */

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/* ── icons: one stroke family, drawn from currentColor ─────────────────────── */

const PATHS = {
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" /></>,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  back: <path d="M19 12H5M11 18l-6-6 6-6" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  alert: <><path d="M12 8v5" /><path d="M12 16.5v.01" /><path d="M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></>,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  refresh: <><path d="M20 11a8 8 0 0 0-14.9-3.5L4 9" /><path d="M4 4v5h5" /><path d="M4 13a8 8 0 0 0 14.9 3.5L20 15" /><path d="M20 20v-5h-5" /></>,
  laptop: <><rect x="4" y="5" width="16" height="11" rx="1.5" /><path d="M2 19.5h20" /></>,
  route: <><circle cx="6" cy="19" r="2.2" /><circle cx="18" cy="5" r="2.2" /><path d="M8.2 19H15a3.5 3.5 0 0 0 0-7H9a3.5 3.5 0 0 1 0-7h6.8" /></>,
  terminal: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></>,
  sparkles: <><path d="M12 3.5 13.8 9l5.7 1.8-5.7 1.8L12 18.3l-1.8-5.7L4.5 10.8 10.2 9Z" /><path d="M19 3v3M17.5 4.5h3" /></>,
  cloud: <path d="M7.5 18.5h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 9.1 4.75 4.75 0 0 0 7.5 18.5Z" />,
  server: <><rect x="3.5" y="4" width="17" height="7" rx="1.5" /><rect x="3.5" y="13" width="17" height="7" rx="1.5" /><path d="M7.5 7.5h.01M7.5 16.5h.01" /></>,
  cpu: <><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2.5v3M15 2.5v3M9 18.5v3M15 18.5v3M2.5 9h3M2.5 15h3M18.5 9h3M18.5 15h3" /></>,
  database: <><ellipse cx="12" cy="5.5" rx="7.5" ry="2.8" /><path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13" /><path d="M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8" /></>,
  box: <><path d="M12 2.8 20.5 7.5v9L12 21.2 3.5 16.5v-9Z" /><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9.2" /></>,
  link: <><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1" /><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" /></>,
  lock: <><rect x="5" y="11" width="14" height="9.5" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  shield: <><path d="M12 3 5 6v5.5c0 4.3 3 7.9 7 9.5 4-1.6 7-5.2 7-9.5V6Z" /><path d="m9 12 2.2 2.2L15.5 10" /></>,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="2.8" /></>,
  eyeOff: <><path d="M3 3l18 18" /><path d="M10.6 5.6A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-3 3.7M6.3 6.8C3.9 8.5 2.5 12 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4.2-1" /><path d="M9.9 10a2.8 2.8 0 0 0 4 4" /></>,
  external: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>,
  chat: <path d="M20 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2Z" />,
  pulse: <path d="M3 12h4l2.5-6 5 12 2.5-6H21" />,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></>,
  palette: <><path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.7-.8 1.7-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.8-1.7 1.7-1.7H16a5 5 0 0 0 5-5C21 6.6 17 3 12 3Z" /><circle cx="7.5" cy="11" r="1" /><circle cx="10.5" cy="7" r="1" /><circle cx="15" cy="7.5" r="1" /></>,
};

function Ic({ name, size = 18 }) {
  return (
    <svg className="onb-ic" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

/** The SAOS mark — the favicon's own "S" path, in the theme's accent. */
function Brand() {
  return (
    <div className="onb-brand">
      <span className="onb-mark" aria-hidden="true">
        <svg viewBox="0 0 64 64" width="20" height="20">
          <path d="M43 21.5 C40.5 16.5 22 15 21 24.5 C20 34 44 30 44 40.5 C44 50 24 50 20.5 43"
            fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="onb-brand-name">SAOS</span>
      <span className="onb-brand-sep" aria-hidden="true" />
      <span className="onb-brand-tag">Setup</span>
    </div>
  );
}

/* ── frame: the rail (wide screens) and the top bar (narrow ones) ──────────── */

function Rail({ step, furthest, version, onGo }) {
  return (
    <aside className="onb-rail" aria-label="Setup steps">
      <Brand />
      <div className="onb-rail-intro">
        <p className="onb-rail-title">Set up your studio</p>
        <p className="onb-rail-text">A few short steps to get SAOS ready on this computer.</p>
      </div>
      <ol className="onb-stepper">
        {SETUP_STEPS.map((s, i) => {
          const current = i === step;
          const done = !current && i < furthest;
          const cls = current ? 'is-current' : done ? 'is-done' : i <= furthest ? 'is-open' : '';
          return (
            <li key={s.id} className={cls} aria-current={current ? 'step' : undefined}>
              <button type="button" onClick={() => onGo(i)} disabled={current || i > furthest}>
                <span className="onb-dot">{done ? <Ic name="check" size={14} /> : i + 1}</span>
                <span className="onb-stepper-text">
                  <span className="onb-stepper-label">{s.label}</span>
                  <span className="onb-stepper-hint">{s.hint}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <div className="onb-rail-foot">
        <p><Ic name="lock" size={15} /> Keys and passwords stay on this computer.</p>
        <p><Ic name="shield" size={15} /> The agent asks before it changes anything.</p>
        {version && <p className="onb-rail-version">SAOS {version}</p>}
      </div>
    </aside>
  );
}

function TopBar({ step }) {
  const pct = stepPercent(step);
  return (
    <header className="onb-topbar">
      <div className="onb-topbar-row">
        <Brand />
        <span className="onb-topbar-step">
          <span className="onb-topbar-count">{step + 1}/{SETUP_STEPS.length}</span> {SETUP_STEPS[step].label}
        </span>
      </div>
      <div className="onb-track" role="progressbar" aria-label={`Setup, step ${step + 1} of ${SETUP_STEPS.length}: ${SETUP_STEPS[step].label}`}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className="onb-fill" style={{ width: `${pct}%` }} />
      </div>
    </header>
  );
}

/** Kicker, title, one line. The title takes focus on arrival unless a field should. */
function StepHeader({ index, title, lead, focus = true, badge = null }) {
  const ref = useRef(null);
  useEffect(() => { if (focus) ref.current?.focus({ preventScroll: true }); }, [focus]);
  return (
    <header className="onb-header">
      {badge}
      <p className="onb-kicker">Step {index + 1} of {SETUP_STEPS.length}</p>
      <h1 className="onb-title" id="onb-title" tabIndex={-1} ref={ref}>{title}</h1>
      {lead && <p className="onb-lead">{lead}</p>}
    </header>
  );
}

/* ── 1. Welcome ───────────────────────────────────────────────────────────── */

function ThemeChoice({ labelledBy }) {
  const [theme, setTheme] = useTheme();
  useEffect(() => { THEMES.forEach(preloadTheme); }, []);
  return (
    <div className="onb-themes" role="radiogroup" aria-labelledby={labelledBy}>
      {THEMES.map((t) => {
        const [side, ground, accent] = THEME_INFO[t].swatch;
        const on = t === theme;
        return (
          <button key={t} type="button" role="radio" aria-checked={on}
            className={`onb-theme${on ? ' is-on' : ''}`}
            onClick={(e) => setTheme(t, { x: e.clientX, y: e.clientY })}
            title={THEME_INFO[t].blurb}>
            <span className="onb-theme-preview" style={{ '--p-side': side, '--p-ground': ground, '--p-accent': accent }} aria-hidden="true">
              <span className="onb-theme-side" />
              <span className="onb-theme-main"><i /><i /></span>
            </span>
            <span className="onb-theme-foot">
              <span className="onb-theme-name">{THEME_INFO[t].label}</span>
              <span className="onb-radio" aria-hidden="true" />
            </span>
          </button>
        );
      })}
    </div>
  );
}

function WelcomeStep({ name, setName, notice, onNext }) {
  const uid = useId();
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { inputRef.current?.focus({ preventScroll: true }); }, []);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    await onNext();
    setBusy(false);
  };
  return (
    <form onSubmit={submit}>
      <StepHeader index={0} focus={false} title="Welcome to SAOS"
        lead="Your agentic studio for building, understanding and fixing ServiceNow. Setup takes about two minutes, and everything can be changed later." />
      <div className="onb-content">
        {notice && (
          <div className="note onb-notice" role="status"><b>{notice.title}</b> {notice.text}</div>
        )}
        <div className="onb-field">
          <label className="label" htmlFor={`${uid}-name`}>What should SAOS call you?</label>
          <input id={`${uid}-name`} ref={inputRef} className="input onb-input" placeholder="Your name"
            maxLength={60} autoComplete="given-name" value={name} onChange={(e) => setName(e.target.value)} />
          <span className="onb-help">Used for greetings across your workspace. Optional.</span>
        </div>
        <div className="onb-field">
          <span className="label" id={`${uid}-look`}>Appearance</span>
          <ThemeChoice labelledBy={`${uid}-look`} />
          <span className="onb-help">Saved in this browser. Change it any time in Settings.</span>
        </div>
      </div>
      <footer className="onb-footer">
        <span className="onb-spacer" />
        <button className="btn primary onb-primary" type="submit" aria-busy={busy} disabled={busy}>
          Get started <Ic name="arrow" size={16} />
        </button>
      </footer>
    </form>
  );
}

/* ── 2. Workspace ─────────────────────────────────────────────────────────── */

const CHECK_ICON = { backend: 'server', runtime: 'cpu', storage: 'database', sdk: 'box', compat: 'link' };
const STATE_ICON = { ok: 'check', warn: 'alert', fail: 'x' };
const STATE_LABEL = { ok: 'Passed', warn: 'Warning', fail: 'Failed' };
const PLACEHOLDER_IDS = ['backend', 'runtime', 'storage', 'sdk', 'compat'];
const STAGGER_MS = 160;

function WorkspaceStep({ result, setResult, onBack, onNext }) {
  const [running, setRunning] = useState(false);
  const [shown, setShown] = useState(result ? Infinity : 0);

  const run = async () => {
    setRunning(true);
    setShown(0);
    let r;
    try {
      r = await api.get(`/onboarding/checks?client=${encodeURIComponent(CLIENT_VERSION)}`);
    } catch (err) {
      r = {
        checks: [{
          id: 'backend', label: 'SAOS backend', state: 'fail', blocking: true,
          detail: `Not answering (${err.message}). Start it with npm start in the SAOS folder, then check again.`,
        }],
        ready: false,
      };
    }
    setResult(r);
    setRunning(false);
  };

  useEffect(() => { if (!result) run(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* One row resolves at a time, so the list reads as checks happening. Every
     row holds its final height while pending, so nothing below it moves. */
  const total = result?.checks?.length || 0;
  useEffect(() => {
    if (!result || shown >= total) return undefined;
    if (reducedMotion()) { setShown(total); return undefined; }
    const t = setTimeout(() => setShown((n) => n + 1), STAGGER_MS);
    return () => clearTimeout(t);
  }, [result, shown, total]);

  const settled = Boolean(result) && !running && shown >= total;
  const verdict = checksVerdict(result);
  const rows = (!running && result?.checks) || PLACEHOLDER_IDS.map((id) => ({ id }));

  let summary = null;
  if (settled) {
    summary = !verdict.ready
      ? { tone: 'fail', text: 'SAOS cannot run here until the failed check is fixed. Fix it, then check again.' }
      : verdict.warnings.length
        ? { tone: 'warn', text: `${verdict.warnings.length === 1 ? 'One warning' : `${verdict.warnings.length} warnings`} — setup can continue; only the feature named is affected.` }
        : { tone: 'ok', text: `All ${total} checks passed.` };
  }

  return (
    <div>
      <StepHeader index={1} title="Check your workspace" lead="SAOS is confirming this computer has what it needs. Nothing here reaches your instance." />
      <div className="onb-content">
        <ul className="onb-list" aria-live="polite" aria-busy={!settled}>
          {rows.map((c, i) => {
            const pending = !settled && (running || !result || i >= shown);
            if (pending) {
              return (
                <li key={c.id} className="onb-row is-pending">
                  <span className="onb-row-icon"><span className="onb-spinner" aria-hidden="true" /></span>
                  <span className="onb-row-text" aria-hidden="true">
                    <span className="skeleton onb-skel-title" />
                    <span className="skeleton onb-skel-sub" />
                  </span>
                  <span className="onb-status is-pending">Checking</span>
                </li>
              );
            }
            return (
              <li key={c.id} className={`onb-row is-${c.state}`}>
                <span className="onb-row-icon"><Ic name={CHECK_ICON[c.id] || 'check'} /></span>
                <span className="onb-row-text">
                  <span className="onb-row-title">{c.label}</span>
                  {c.detail && <span className="onb-row-sub">{c.detail}</span>}
                </span>
                <span className={`onb-status is-${c.state}`}>
                  <Ic name={STATE_ICON[c.state] || 'check'} size={13} /> {STATE_LABEL[c.state] || c.state}
                </span>
              </li>
            );
          })}
        </ul>
        {/* Always present, so the verdict arriving does not push the actions down. */}
        {summary ? (
          <p className={`onb-summary is-${summary.tone}`} role={summary.tone === 'fail' ? 'alert' : 'status'}>
            <Ic name={STATE_ICON[summary.tone]} size={15} /> {summary.text}
          </p>
        ) : (
          <p className="onb-summary">Running checks…</p>
        )}
      </div>
      <footer className="onb-footer">
        <button type="button" className="btn ghost" onClick={onBack}><Ic name="back" size={16} /> Back</button>
        <span className="onb-spacer" />
        <button type="button" className="btn" onClick={run} disabled={running}><Ic name="refresh" size={15} /> Check again</button>
        <button type="button" className="btn primary onb-primary" onClick={onNext} disabled={!settled || !verdict.ready}>
          Continue <Ic name="arrow" size={16} />
        </button>
      </footer>
    </div>
  );
}

/* ── 3. Model ─────────────────────────────────────────────────────────────── */

function SecretInput({ value, onChange, placeholder, label, id }) {
  const [show, setShow] = useState(false);
  return (
    <div className="password-wrapper">
      <input id={id} className="input mono onb-input" type={show ? 'text' : 'password'} placeholder={placeholder}
        autoComplete="off" spellCheck={false} value={value} onChange={onChange} />
      <button type="button" className="password-toggle onb-eye" onClick={() => setShow((s) => !s)}
        aria-label={show ? `Hide ${label}` : `Show ${label}`}>
        <Ic name={show ? 'eyeOff' : 'eye'} size={16} />
      </button>
    </div>
  );
}

function formFor(provider, llm) {
  const same = llm?.provider === provider;
  return { apiKey: '', baseUrl: same ? llm.baseUrl || '' : '', model: same ? llm.model || '' : '' };
}

function ModelStep({ llm, setLlm, result, setResult, onBack, onNext }) {
  const uid = useId();
  const [provider, setProvider] = useState(llm?.provider || PROVIDERS[0].id);
  const [form, setForm] = useState(() => formFor(llm?.provider || PROVIDERS[0].id, llm));
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [orModels, setOrModels] = useState(null);
  const p = providerById(provider);
  const hint = PROVIDER_HINTS[provider];
  const needs = providerNeeds(provider, form, llm);
  const dirty = provider !== llm?.provider || Boolean(form.apiKey)
    || form.baseUrl !== (llm?.baseUrl || '') || form.model !== (llm?.model || '');
  const savedHere = llm?.provider === provider
    && providerNeeds(provider, { baseUrl: llm.baseUrl, model: llm.model }, llm).ready;

  useEffect(() => {
    if (provider !== 'openrouter' || orModels) return;
    api.get('/agent/openrouter/models').then(setOrModels)
      .catch((e) => setOrModels({ ok: false, models: [], error: e.message }));
  }, [provider, orModels]);

  const choose = (id) => {
    if (id === provider) return;
    setProvider(id);
    setForm(formFor(id, llm));
    setResult(null);
    setError('');
  };

  const save = async () => {
    const s = await api.post('/system/settings', { llm: { provider, ...form } });
    setLlm(s.llm);
    setForm((f) => ({ ...f, apiKey: '' }));
    return s;
  };

  const test = async () => {
    setBusy('test'); setError(''); setResult(null);
    try {
      if (dirty) await save();
      setResult(await api.post('/agent/model/test'));
    } catch (e) { setError(e.message); }
    finally { setBusy(''); }
  };

  const next = async (e) => {
    e?.preventDefault();
    if (!needs.ready) return;
    setBusy('save'); setError('');
    try {
      if (dirty) await save();
      onNext();
    } catch (err) { setError(err.message); }
    finally { setBusy(''); }
  };

  const keySaved = llm?.provider === provider && llm?.hasApiKey;

  return (
    <form onSubmit={next}>
      <StepHeader index={2} title="Choose your model"
        lead="The agent runs on the model you bring. You can switch providers any time in Settings." />
      <div className="onb-content">
        <div className="onb-options" role="radiogroup" aria-label="Model provider">
          {PROVIDERS.map((opt) => {
            const on = opt.id === provider;
            const current = llm?.provider === opt.id && (llm?.hasApiKey || llm?.model || llm?.baseUrl);
            return (
              <button key={opt.id} type="button" role="radio" aria-checked={on}
                className={`onb-option${on ? ' is-on' : ''}`} onClick={() => choose(opt.id)}>
                <span className="onb-option-icon">
                  {opt.mark ? <span className="onb-mono" aria-hidden="true">{opt.mark}</span> : <Ic name={opt.icon} />}
                </span>
                <span className="onb-option-text">
                  <span className="onb-option-name">
                    {opt.label}
                    {current && <span className="onb-tag">Current</span>}
                  </span>
                  <span className="onb-option-blurb">{opt.blurb}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="onb-fields">
          {p.key !== 'none' ? (
            <div className="onb-field">
              <div className="onb-label-row">
                <label className="label" htmlFor={`${uid}-key`}>
                  {p.key === 'optional' ? 'API key (optional)' : 'API key'}{keySaved ? ' · saved' : ''}
                </label>
                {p.keyUrl && (
                  <a className="onb-link" href={p.keyUrl} target="_blank" rel="noreferrer">
                    Get a key <Ic name="external" size={12} />
                  </a>
                )}
              </div>
              <SecretInput id={`${uid}-key`} label="API key" value={form.apiKey}
                placeholder={keySaved ? '•••••••••••• kept unless you type a new one' : 'Paste your key'}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
            </div>
          ) : (
            <p className="onb-inline-note">
              Runs on this computer — no key and no metering. Install Ollama and pull a tool-capable model first.{' '}
              <a className="onb-link" href={p.keyUrl} target="_blank" rel="noreferrer">Get Ollama <Ic name="external" size={12} /></a>
            </p>
          )}
          {p.baseUrl !== 'fixed' && (
            <div className="onb-field">
              <label className="label" htmlFor={`${uid}-url`}>Base URL{p.baseUrl === 'optional' ? ' (optional)' : ''}</label>
              <input id={`${uid}-url`} className="input mono onb-input" placeholder={hint.baseUrl} value={form.baseUrl}
                spellCheck={false} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
            </div>
          )}
          <div className="onb-field">
            <div className="onb-label-row">
              <label className="label" htmlFor={`${uid}-model`}>
                Model{p.model === 'optional' ? ' (blank = provider default)' : ''}
              </label>
              {provider === 'openrouter' && orModels?.ok && <span className="onb-help">{orModels.count} available</span>}
            </div>
            <input id={`${uid}-model`} className="input mono onb-input" placeholder={hint.model} value={form.model} spellCheck={false}
              list={provider === 'openrouter' ? `${uid}-models` : undefined}
              onChange={(e) => setForm({ ...form, model: e.target.value })} />
            {provider === 'openrouter' && orModels?.ok && (
              <datalist id={`${uid}-models`}>
                {orModels.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </datalist>
            )}
            {provider === 'openrouter' && orModels && !orModels.ok && <span className="onb-help">{orModels.error}</span>}
          </div>

          <div className="onb-test">
            <button type="button" className="btn sm" onClick={test} disabled={!needs.ready || Boolean(busy)} aria-busy={busy === 'test'}>
              {busy === 'test' ? 'Asking the model…' : 'Test model'}
            </button>
            <span className="onb-test-result" role="status">
              {result?.ok && <span className="is-ok"><Ic name="check" size={14} /> {result.model} answered in {(result.ms / 1000).toFixed(1)} s</span>}
              {result && !result.ok && <span className="is-bad"><Ic name="x" size={14} /> {result.message}</span>}
              {!result && !needs.ready && <>Needs {needs.missing.join(' and ')}.</>}
              {!result && needs.ready && savedHere && !dirty && <>Saved. Test it to be sure.</>}
            </span>
          </div>
          {error && <p className="error-text onb-error">{error}</p>}
        </div>
      </div>
      <footer className="onb-footer">
        <button type="button" className="btn ghost" onClick={onBack}><Ic name="back" size={16} /> Back</button>
        <span className="onb-spacer" />
        <button type="button" className="btn ghost" onClick={onNext}>Skip for now</button>
        <button type="submit" className="btn primary onb-primary" disabled={!needs.ready || Boolean(busy)} aria-busy={busy === 'save'}>
          {dirty ? 'Save & continue' : 'Continue'} <Ic name="arrow" size={16} />
        </button>
      </footer>
    </form>
  );
}

/* ── 4. ServiceNow ────────────────────────────────────────────────────────── */

function connFormFor(conn) {
  return {
    instanceUrl: conn?.instanceUrl || '',
    authType: conn?.authType || 'basic',
    username: conn?.username || '',
    password: '',
    clientId: conn?.clientId || '',
    clientSecret: '',
  };
}

function ServiceNowStep({ conn, setConn, result, setResult, onBack, onNext }) {
  const uid = useId();
  const [form, setForm] = useState(() => connFormFor(conn));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const url = normaliseInstanceUrl(form.instanceUrl);
  const urlProblem = form.instanceUrl ? instanceUrlProblem(url) : null;
  const sameTarget = url === (conn?.instanceUrl || '') && form.username === (conn?.username || '') && form.authType === (conn?.authType || 'basic');
  const hasPassword = Boolean(form.password) || (sameTarget && conn?.hasPassword);
  const hasSecret = Boolean(form.clientSecret) || (sameTarget && conn?.hasClientSecret);
  const dirty = !sameTarget || Boolean(form.password) || Boolean(form.clientSecret) || form.clientId !== (conn?.clientId || '');
  const complete = Boolean(url) && !instanceUrlProblem(url) && Boolean(form.username) && hasPassword
    && (form.authType !== 'oauth' || (Boolean(form.clientId) && hasSecret));
  const connected = result?.ok && !dirty;

  const set = (patch) => { setForm((f) => ({ ...f, ...patch })); setError(''); };

  const connect = async (e) => {
    e?.preventDefault();
    if (connected) { onNext(); return; }
    if (!complete) return;
    setBusy(true); setError(''); setResult(null);
    try {
      if (dirty) {
        const s = await api.post('/system/settings', { connection: { ...form, instanceUrl: url } });
        setConn(s.connection);
        setForm((f) => ({ ...f, instanceUrl: url, password: '', clientSecret: '' }));
        refreshHealth();   // every RequiresInstance gate reads this
        refreshBinding();  // a new instance must not wear the old binding's verdict
      }
      const r = await api.post('/system/connection/test');
      setResult(r);
      if (r?.ok) buildScoresIfNone();
    } catch (err) {
      setResult({ ok: false, message: err.message });
    } finally { setBusy(false); }
  };

  const who = result?.user?.name || result?.user?.userName || conn?.username;
  const warnings = conn?.warnings || [];

  return (
    <form onSubmit={connect}>
      <StepHeader index={3} title="Connect ServiceNow"
        lead="Sign in to the instance SAOS will read, build on and check. A personal developer instance is ideal." />
      <div className="onb-content">
        <div className="onb-fields">
          <div className="onb-field">
            <label className="label" htmlFor={`${uid}-url`}>Instance URL</label>
            <input id={`${uid}-url`} className="input mono onb-input" placeholder="https://<your-instance>.service-now.com"
              inputMode="url" autoComplete="url" spellCheck={false} value={form.instanceUrl}
              onChange={(e) => set({ instanceUrl: e.target.value })}
              onBlur={() => { if (url && url !== form.instanceUrl && !instanceUrlProblem(url)) set({ instanceUrl: url }); }} />
            {urlProblem
              ? <span className="onb-help is-bad">{urlProblem}</span>
              : url && url !== form.instanceUrl.trim()
                ? <span className="onb-help">Will connect to <span className="mono">{url}</span></span>
                : <span className="onb-help">Paste it from your browser, or type just the instance name.</span>}
          </div>

          <div className="onb-field">
            <span className="label" id={`${uid}-auth`}>Sign-in method</span>
            <div className="onb-seg" role="radiogroup" aria-labelledby={`${uid}-auth`}>
              {[['basic', 'Username & password'], ['oauth', 'OAuth 2.0']].map(([v, l]) => (
                <button key={v} type="button" role="radio" aria-checked={form.authType === v}
                  className={form.authType === v ? 'is-on' : ''} onClick={() => set({ authType: v })}>{l}</button>
              ))}
            </div>
          </div>

          <div className="onb-grid2">
            <div className="onb-field">
              <label className="label" htmlFor={`${uid}-user`}>Username</label>
              <input id={`${uid}-user`} className="input onb-input" autoComplete="username" spellCheck={false} placeholder="admin"
                value={form.username} onChange={(e) => set({ username: e.target.value.trim() })} />
            </div>
            <div className="onb-field">
              <label className="label" htmlFor={`${uid}-pass`}>Password{sameTarget && conn?.hasPassword ? ' · saved' : ''}</label>
              <SecretInput id={`${uid}-pass`} label="password" value={form.password}
                placeholder={sameTarget && conn?.hasPassword ? '•••••••• kept' : 'Password'}
                onChange={(e) => set({ password: e.target.value })} />
            </div>
          </div>
          {form.authType === 'oauth' && (
            <div className="onb-grid2">
              <div className="onb-field">
                <label className="label" htmlFor={`${uid}-cid`}>Client ID</label>
                <input id={`${uid}-cid`} className="input mono onb-input" spellCheck={false} value={form.clientId}
                  onChange={(e) => set({ clientId: e.target.value.trim() })} />
              </div>
              <div className="onb-field">
                <label className="label" htmlFor={`${uid}-cs`}>Client secret{sameTarget && conn?.hasClientSecret ? ' · saved' : ''}</label>
                <SecretInput id={`${uid}-cs`} label="client secret" value={form.clientSecret}
                  placeholder={sameTarget && conn?.hasClientSecret ? '•••••••• kept' : ''}
                  onChange={(e) => set({ clientSecret: e.target.value })} />
              </div>
            </div>
          )}

          {connected && (
            <p className="onb-result is-ok" role="status">
              <Ic name="check" size={16} />
              <span>Connected{who ? <> as <b>{who}</b></> : null} on <b>{result.host || instanceHost(url)}</b>
                {result.build && <span className="onb-muted"> · {result.build}</span>}</span>
            </p>
          )}
          {result && !result.ok && (
            <p className="onb-result is-bad" role="alert"><Ic name="x" size={16} /> <span>{result.message}</span></p>
          )}
          {result && !result.ok && warnings.map((w) => <p key={w} className="onb-help is-warn">{w}</p>)}
          {error && <p className="error-text onb-error">{error}</p>}
        </div>
        <p className="onb-help onb-fine"><Ic name="lock" size={13} /> Stored only on this computer, in server/data/settings.json. Nothing is sent anywhere but your instance.</p>
      </div>
      <footer className="onb-footer">
        <button type="button" className="btn ghost" onClick={onBack}><Ic name="back" size={16} /> Back</button>
        <span className="onb-spacer" />
        <button type="button" className="btn ghost" onClick={onNext}>Skip for now</button>
        <button type="submit" className="btn primary onb-primary" disabled={busy || (!connected && !complete)} aria-busy={busy}>
          {busy ? 'Connecting…' : connected ? 'Continue' : 'Connect'} <Ic name="arrow" size={16} />
        </button>
      </footer>
    </form>
  );
}

/* ── 5. Done ──────────────────────────────────────────────────────────────── */

const NEXT = [
  { to: '/agent', icon: 'chat', title: 'Ask the agent', text: 'Build flows, tables and fixes in plain words.' },
  { to: '/health', icon: 'pulse', title: 'Check instance health', text: 'Score the instance and see what to fix first.' },
  { to: '/settings', icon: 'gear', title: 'Fine-tune settings', text: 'Approvals, notifications, theme and more.' },
];

function DoneStep({ name, version, llm, conn, connResult, modelResult, previousHost, onBack, onFinish }) {
  const [theme] = useTheme();
  const [busy, setBusy] = useState('');
  const p = llm?.provider ? providerById(llm.provider) : null;
  const modelReady = p && providerNeeds(p.id, { baseUrl: llm.baseUrl, model: llm.model }, llm).ready;
  const host = instanceHost(conn?.instanceUrl);
  const first = firstName(name);

  const rows = [
    {
      icon: 'sparkles', label: 'Model',
      value: modelReady ? `${p.label}${llm.model ? ` · ${llm.model}` : ' · default model'}` : 'Not set up yet — add one in Settings',
      status: modelReady ? (modelResult?.ok ? 'Tested' : modelResult ? 'Test failed' : 'Saved') : 'Needed for the agent',
      tone: modelReady ? (modelResult && !modelResult.ok ? 'warn' : 'ok') : 'warn',
    },
    {
      icon: 'cloud', label: 'ServiceNow',
      value: host || 'Not connected — module pages wait for one',
      status: host ? (connResult?.ok ? 'Connected' : connResult ? 'Sign-in failed' : 'Saved') : 'Skipped',
      tone: host ? (connResult && !connResult.ok ? 'warn' : 'ok') : 'warn',
    },
    { icon: 'palette', label: 'Theme', value: THEME_INFO[theme]?.label || theme, status: 'This browser', tone: 'ok' },
  ];
  if (previousHost) rows.push({ icon: 'link', label: 'Settings', value: `Carried over from ${previousHost}`, status: 'Confirmed', tone: 'ok' });

  const go = async (to) => { setBusy(to); await onFinish(to); setBusy(''); };

  return (
    <div>
      <StepHeader index={4}
        badge={<span className="onb-done-badge" aria-hidden="true"><Ic name="check" size={22} /></span>}
        title={`You're all set${first ? `, ${first}` : ''}.`}
        lead={`SAOS ${version} is ready. Here is how this computer is set up.`} />
      <div className="onb-content">
        <ul className="onb-list">
          {rows.map((r) => (
            <li key={r.label} className="onb-row">
              <span className="onb-row-icon"><Ic name={r.icon} size={16} /></span>
              <span className="onb-row-text">
                <span className="onb-row-label">{r.label}</span>
                <span className="onb-row-title">{r.value}</span>
              </span>
              <span className={`onb-status is-${r.tone}`}>{r.status}</span>
            </li>
          ))}
        </ul>
        <div className="onb-field">
          <span className="label">Where to start</span>
          <ul className="onb-list onb-links">
            {NEXT.map((n) => (
              <li key={n.to}>
                <button type="button" className="onb-link-row" onClick={() => go(n.to)} disabled={Boolean(busy)}>
                  <span className="onb-row-icon"><Ic name={n.icon} size={16} /></span>
                  <span className="onb-row-text">
                    <span className="onb-row-title">{n.title}</span>
                    <span className="onb-row-sub">{n.text}</span>
                  </span>
                  <Ic name="chevron" size={16} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <footer className="onb-footer">
        <button type="button" className="btn ghost" onClick={onBack}><Ic name="back" size={16} /> Back</button>
        <span className="onb-spacer" />
        <button type="button" className="btn primary onb-primary" onClick={() => go('/agent')} disabled={Boolean(busy)} aria-busy={busy === '/agent'}>
          Start building <Ic name="arrow" size={16} />
        </button>
      </footer>
    </div>
  );
}

/* ── the wizard ───────────────────────────────────────────────────────────── */

function SetupWizard({ status }) {
  const navigate = useNavigate();
  const saved = status.settings || {};
  const [step, setStep] = useState(readSetupStep);
  const [furthest, setFurthest] = useState(readSetupStep);
  const [name, setName] = useState(saved.profile?.name || '');
  const [llm, setLlm] = useState(saved.llm || null);
  const [conn, setConn] = useState(saved.connection || null);
  const [checks, setChecks] = useState(null);
  const [modelResult, setModelResult] = useState(null);
  const [connResult, setConnResult] = useState(null);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState('');
  const mainRef = useRef(null);
  const notice = reasonNotice(status.reason, status.machine?.previousHost);

  /* The shell beneath is covered but still in the tab order; take it out
     while setup is showing, so the keyboard stays in here. */
  useEffect(() => {
    const shell = document.querySelector('.shell');
    shell?.setAttribute('inert', '');
    return () => shell?.removeAttribute('inert');
  }, []);

  const go = (to) => {
    const next = clampStep(to);
    setStep(next);
    setFurthest((f) => Math.max(f, next));
    writeSetupStep(next);
    setError('');
    mainRef.current?.scrollTo({ top: 0 });
  };

  const saveName = async () => {
    setError('');
    try { await api.post('/onboarding/profile', { name }); } catch (e) { setError(e.message); return; }
    go(1);
  };

  const finish = async (to) => {
    setError('');
    let next;
    try { next = await api.post('/onboarding/complete', { name }); } catch (e) { setError(e.message); return; }
    clearSetupStep();
    refreshHealth();
    setLeaving(true);
    navigate(to);
    setTimeout(() => setOnboardingStatus(next), reducedMotion() ? 0 : 280);
  };

  const id = SETUP_STEPS[step].id;
  return (
    <div className={`onb${leaving ? ' is-leaving' : ''}`} role="dialog" aria-modal="true" aria-labelledby="onb-title">
      <Rail step={step} furthest={furthest} version={status.version} onGo={go} />
      <div className="onb-main" ref={mainRef}>
        <TopBar step={step} />
        <div className="onb-panel" key={id}>
          {id === 'welcome' && <WelcomeStep name={name} setName={setName} notice={notice} onNext={saveName} />}
          {id === 'workspace' && <WorkspaceStep result={checks} setResult={setChecks} onBack={() => go(0)} onNext={() => go(2)} />}
          {id === 'model' && (
            <ModelStep llm={llm} setLlm={setLlm} result={modelResult} setResult={setModelResult}
              onBack={() => go(1)} onNext={() => go(3)} />
          )}
          {id === 'servicenow' && (
            <ServiceNowStep conn={conn} setConn={setConn} result={connResult} setResult={setConnResult}
              onBack={() => go(2)} onNext={() => go(4)} />
          )}
          {id === 'done' && (
            <DoneStep name={name} version={status.version} llm={llm} conn={conn} connResult={connResult}
              modelResult={modelResult} previousHost={status.machine?.previousHost} onBack={() => go(3)} onFinish={finish} />
          )}
          {error && <p className="error-text onb-error" role="alert">{error}</p>}
        </div>
      </div>
    </div>
  );
}

/**
 * Mounted once, in App. Renders nothing unless the server says setup is owed
 * on this machine — and keyed on the store's session, so "Re-run setup"
 * always starts a clean wizard.
 */
export default function Onboarding() {
  const ob = useOnboarding();
  if (!ob.open || !ob.status) return null;
  return <SetupWizard key={ob.session} status={ob.status} />;
}
