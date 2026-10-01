import { useEffect, useState } from 'react';
import { AGENT_PREFS_SLOT_ID } from '../components/agentRail.js';
import { api } from '../api.js';
import { toast } from '../components/toast.js';
import { DisconnectedBanner } from '../components/states.jsx';
import {
  desktopNotificationsEnabled, notificationSupport, notifyDesktop, setDesktopNotifications, subscribeNotificationPref,
} from '../components/notify.js';
import ThemePicker from '../components/ThemePicker.jsx';
import DesktopDownloads from '../components/DesktopDownloads.jsx';
import { PROVIDERS, PROVIDER_HINTS as HINTS } from '../components/llmProviders.js';
import { useOnboarding, setOnboardingStatus } from '../hooks/useOnboarding.js';
import { checksVerdict, clearSetupStep, migrationSummary } from '../components/onboardingModel.js';
import { version as CLIENT_VERSION } from '../../package.json';

const PERMISSION_LABEL = {
  granted: 'allowed by this browser',
  denied: 'blocked by this browser',
  default: 'not asked yet',
  unsupported: 'not supported by this browser',
};

/**
 * Desktop notifications — the switch, what it covers, and a way to prove it
 * works. Per browser, because the permission it depends on is per browser.
 */
function NotificationsCard() {
  const [enabled, setEnabled] = useState(desktopNotificationsEnabled);
  const [permission, setPermission] = useState(notificationSupport);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => subscribeNotificationPref((on) => {
    setEnabled(on);
    setPermission(notificationSupport());
  }), []);

  const toggle = async (on) => {
    setBusy(true); setNote('');
    const r = await setDesktopNotifications(on);
    setEnabled(r.enabled);
    setPermission(notificationSupport());
    if (!r.ok) setNote(r.reason);
    else if (r.enabled) toast.success('Desktop notifications are on.');
    setBusy(false);
  };

  const test = () => {
    const shown = notifyDesktop({
      title: 'SAOS notifications work',
      body: 'You will see this when long-running work finishes while you are in another window.',
      tag: 'nha-test',
      force: true,
    });
    if (!shown) setNote('No notification was shown. Check that this switch is on and the browser allows notifications for this site.');
    else setNote('');
  };

  return (
    <div className="card">
      <div className="card-title">Notifications</div>
      <label className="check" style={{ marginBottom: 8 }}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy || permission === 'unsupported'}
          onChange={(e) => toggle(e.target.checked)}
        />
        Notify me on this computer when work finishes or needs me
      </label>
      <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--muted)' }}>
        Only while you are in another window or tab — if you are looking at the app, it tells you in place instead.
        Covers health checks finishing, agent replies, approvals waiting for you, flow builds and remediations.
        Browser permission: <b>{PERMISSION_LABEL[permission] || permission}</b>.
      </p>
      <button type="button" className="btn" onClick={test} disabled={!enabled}>
        Send a test notification
      </button>
      {note && <p className="error-text">{note}</p>}
    </div>
  );
}

/**
 * Theme — a dropdown of the three looks: Original, ServiceNow, ROBOTIC.
 * Per browser; the switch animates out from where it was chosen.
 */
function ThemeCard() {
  return (
    <div className="card">
      <div className="card-title">Theme</div>
      <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--muted)' }}>
        How the studio looks. Saved in this browser.
      </p>
      <ThemePicker />
    </div>
  );
}

/**
 * Setup — the backend's version and a live check of this machine, whether the
 * settings were carried over from another computer, the name greetings use,
 * and a way back into the setup wizard.
 */
function SetupCard() {
  const ob = useOnboarding();
  const status = ob.status;
  const [checks, setChecks] = useState(null);
  const [checking, setChecking] = useState(false);
  const [name, setName] = useState(null); // null = not edited: show the saved one
  const [savingName, setSavingName] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const verdict = checks ? checksVerdict(checks) : null;
  const migration = migrationSummary(status);
  const shownName = name ?? ob.name;
  const problems = checks?.checks?.filter((c) => c.state !== 'ok') || [];

  const check = async () => {
    setChecking(true);
    try {
      setChecks(await api.get(`/onboarding/checks?client=${encodeURIComponent(CLIENT_VERSION)}`));
    } catch (e) {
      setChecks({ checks: [{ id: 'backend', label: 'SAOS backend', state: 'fail', blocking: true, detail: e.message }] });
    } finally { setChecking(false); }
  };

  const saveName = async (e) => {
    e.preventDefault();
    setSavingName(true);
    try {
      setOnboardingStatus(await api.post('/onboarding/profile', { name: shownName }));
      setName(null);
      toast.success(shownName.trim() ? 'Name saved.' : 'Name cleared.');
    } catch (err) { toast.error(err.message); }
    finally { setSavingName(false); }
  };

  const rerun = async () => {
    setRerunning(true);
    try {
      clearSetupStep();
      // The wizard opens as soon as the store hears setup is owed again.
      setOnboardingStatus(await api.post('/onboarding/reset'));
    } catch (err) { toast.error(err.message); }
    finally { setRerunning(false); }
  };

  let badge = null;
  if (verdict) {
    badge = !verdict.ready
      ? <span className="badge red">Needs attention</span>
      : verdict.warnings.length
        ? <span className="badge amber">{verdict.warnings.length} warning{verdict.warnings.length > 1 ? 's' : ''}</span>
        : <span className="badge green">Healthy</span>;
  }

  return (
    <div className="card setup-card">
      <div className="card-title">Setup</div>

      <div className="setup-group-label">SAOS backend</div>
      <div className="setup-row">
        <div className="setup-row-text">
          <div className="setup-row-title">Version</div>
          <div className="setup-row-sub">Local backend service{status?.machine?.host ? ` on ${status.machine.host}` : ''}</div>
        </div>
        <div className="setup-row-side">
          <span className="setup-version mono">v{status?.version ?? '—'}</span>
          {badge}
          <button type="button" className="btn sm" onClick={check} disabled={checking} aria-busy={checking}>Check</button>
        </div>
      </div>
      {problems.length > 0 && (
        <ul className="setup-problems">
          {problems.map((c) => (
            <li key={c.id} className={c.state === 'fail' ? 'is-bad' : 'is-warn'}><b>{c.label}</b> — {c.detail}</li>
          ))}
        </ul>
      )}

      <div className="setup-group-label">Configuration migration</div>
      <div className="setup-row">
        <div className="setup-row-text">
          <div className="setup-row-title">Status</div>
          <div className="setup-row-sub">{migration.text}</div>
        </div>
        <div className="setup-row-side">
          {migration.state === 'none' ? <span className="setup-na">N/A</span> : <span className="badge green">Migrated</span>}
        </div>
      </div>

      <div className="setup-group-label">Profile</div>
      <form className="setup-row" onSubmit={saveName}>
        <div className="setup-row-text">
          <label className="setup-row-title" htmlFor="setup-name">Your name</label>
          <div className="setup-row-sub">Used for greetings only.</div>
        </div>
        <div className="setup-row-side setup-name">
          <input id="setup-name" className="input" maxLength={60} placeholder="Your name" value={shownName}
            onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="btn sm" disabled={savingName || name === null} aria-busy={savingName}>Save</button>
        </div>
      </form>

      <div className="setup-group-label">Onboarding</div>
      <div className="setup-row">
        <div className="setup-row-text">
          <div className="setup-row-title">Re-run setup</div>
          <div className="setup-row-sub">Open the setup wizard again now. Everything you saved is kept and filled in.</div>
        </div>
        <div className="setup-row-side">
          <button type="button" className="btn sm" onClick={rerun} disabled={rerunning} aria-busy={rerunning}>Re-run setup</button>
        </div>
      </div>
    </div>
  );
}

export default function Settings() {
  const [llm, setLlm] = useState({ provider: 'anthropic', apiKey: '', baseUrl: '', model: '', embedModel: '' });
  const [memory, setMemory] = useState(null);
  const [saved, setSaved] = useState(null);
  const [autoApprove, setAutoApprove] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // OpenRouter's catalogue, fetched only when that provider is selected.
  const [orModels, setOrModels] = useState(null);

  useEffect(() => {
    api.get('/system/settings').then((s) => {
      setSaved(s);
      setLlm({ provider: s.llm.provider, apiKey: '', baseUrl: s.llm.baseUrl, model: s.llm.model, embedModel: s.llm.embedModel || '' });
      setAutoApprove(s.agent.autoApprove);
    }).catch((e) => setError(e.message));
    api.get('/agent/memory/status').then(setMemory).catch(() => {});
  }, []);

  // Loaded only when OpenRouter is the selected provider, and only once —
  // it is ~400 entries and irrelevant to every other provider.
  useEffect(() => {
    if (llm.provider !== 'openrouter' || orModels) return;
    api.get('/agent/openrouter/models').then(setOrModels)
      .catch((e) => setOrModels({ ok: false, models: [], error: e.message }));
  }, [llm.provider, orModels]);

  const hint = HINTS[llm.provider];

  const save = async () => {
    setSaving(true); setError('');
    try {
      const s = await api.post('/system/settings', { llm, agent: { autoApprove } });
      setSaved(s);
      setLlm((l) => ({ ...l, apiKey: '' }));
      toast.success('Settings saved.');
    } catch (e) { setError(e.message); toast.error(e.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="stack">
      <DisconnectedBanner />
      <div className="grid2">
      {/* The Windows and macOS installers, and how to install them. Full width. */}
      <DesktopDownloads />

      <div className="card">
        <div className="card-title">LLM provider — bring your own model</div>
        <div className="field">
          <label className="label">Provider</label>
          <select className="select" value={llm.provider} onChange={(e) => setLlm({ ...llm, provider: e.target.value, baseUrl: '', model: '' })}>
            {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.option}</option>)}
          </select>
        </div>
        {hint.key && (
          <div className="field">
            <label className="label">API key {saved?.llm.hasApiKey ? '· saved' : ''}</label>
            <input className="input mono" type="password" placeholder={saved?.llm.hasApiKey ? '••••••••••••' : 'sk-…'}
              value={llm.apiKey} onChange={(e) => setLlm({ ...llm, apiKey: e.target.value })} />
          </div>
        )}
        {llm.provider !== 'anthropic' && (
          <div className="field">
            <label className="label">Base URL</label>
            <input className="input mono" placeholder={hint.baseUrl} value={llm.baseUrl}
              onChange={(e) => setLlm({ ...llm, baseUrl: e.target.value })} />
          </div>
        )}
        <div className="field">
          <label className="label">
            Model
            {llm.provider === 'openrouter' && orModels?.ok && (
              <span className="badge green" style={{ marginLeft: 8 }}>{orModels.count} available</span>
            )}
          </label>
          <input className="input mono" placeholder={hint.model} value={llm.model}
            list={llm.provider === 'openrouter' ? 'openrouter-models' : undefined}
            onChange={(e) => setLlm({ ...llm, model: e.target.value })} />
          {/*
            A datalist rather than a select: OpenRouter's catalogue is large and
            changes, and typing an id that the list has not caught up with must
            still work. The list is a convenience, never a constraint.
          */}
          {llm.provider === 'openrouter' && orModels?.ok && (
            <datalist id="openrouter-models">
              {orModels.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </datalist>
          )}
          {llm.provider === 'openrouter' && orModels && !orModels.ok && (
            <div className="hint">{orModels.error}</div>
          )}
        </div>
        <div className="field">
          <label className="label">
            Embedding model — semantic recall
            {memory && (
              <span className={`badge ${memory.degraded ? 'amber' : 'green'}`} style={{ marginLeft: 8 }}>
                {memory.degraded ? 'keyword only' : `semantic · ${memory.dim}d`}
              </span>
            )}
          </label>
          <input className="input mono" placeholder="nomic-embed-text" value={llm.embedModel}
            onChange={(e) => setLlm({ ...llm, embedModel: e.target.value })} />
          {memory?.degraded && (
            <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
              Not pulled, so chat search matches words rather than meaning. Fix with{' '}
              <span className="mono">{memory.command}</span>
            </span>
          )}
        </div>
        <label className="check" style={{ marginBottom: 12 }}>
          <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} />
          Auto-approve agent mutations (skip the amber gate)
        </label>
        <button className="btn primary" onClick={save} aria-busy={saving} disabled={saving}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
        {error && <p className="error-text">{error}</p>}
      </div>

      <SetupCard />

      {/*
        * AGENT BEHAVIOUR — the two switches that used to sit in the navigation.
        *
        * Relocated, not reimplemented. The slot below is filled by AgentChat
        * through the same portal seam the chat list and skills already use, so
        * these are the SAME checkboxes bound to the SAME capture/autoApprove
        * state and the same handlers that talk to the same endpoints. Nothing
        * about approval or capture logic changed; only where they are drawn.
        */}
      <div className="card">
        <div className="card-title">Agent behaviour</div>
        <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--muted)' }}>
          How the agent treats changes it makes on your behalf. Both apply to the
          next turn; a turn already running keeps the settings it started with.
        </p>
        <div id={AGENT_PREFS_SLOT_ID} className="prefs-slot" />
      </div>

      <ThemeCard />

      <NotificationsCard />
      </div>
    </div>
  );
}
