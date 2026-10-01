/**
 * The setup wizard's decisions, in plain JS.
 *
 * Split out of Onboarding.jsx for the same reason startupProgress.js is split
 * out of the startup screen: these are the parts carrying a rule, and Node
 * cannot import `.jsx`, so a rule left in the component is a rule the offline
 * suite cannot check.
 */

export const SETUP_STEPS = Object.freeze([
  Object.freeze({ id: 'welcome', label: 'Welcome', hint: 'Your name and look' }),
  Object.freeze({ id: 'workspace', label: 'Workspace', hint: 'What this computer has' }),
  Object.freeze({ id: 'model', label: 'Model', hint: 'What the agent runs on' }),
  Object.freeze({ id: 'servicenow', label: 'ServiceNow', hint: 'The instance to work on' }),
  Object.freeze({ id: 'done', label: 'Ready', hint: 'Review and start' }),
]);

/** How far along the bar is on a step (1-based share, so step 1 is not empty). */
export function stepPercent(index) {
  const i = Math.min(Math.max(0, index), SETUP_STEPS.length - 1);
  return Math.round(((i + 1) / SETUP_STEPS.length) * 100);
}

export const clampStep = (n) => (Number.isInteger(n) ? Math.min(Math.max(0, n), SETUP_STEPS.length - 1) : 0);

/*
 * Which step the wizard was on, so a reload mid-setup resumes there. Per
 * browser and a convenience only: storage can be unavailable, and then setup
 * simply starts at the first step.
 */
const STEP_KEY = 'saos.setup.step';
export function readSetupStep() {
  try { return clampStep(Number(localStorage.getItem(STEP_KEY))); } catch { return 0; }
}
export function writeSetupStep(n) {
  try { localStorage.setItem(STEP_KEY, String(n)); } catch { /* resume is a convenience */ }
}
export function clearSetupStep() {
  try { localStorage.removeItem(STEP_KEY); } catch { /* noop */ }
}

/* The platform's own domain, written so the bare suffix is never a full host. */
const SN_SUFFIX = '.service-now.com';

/**
 * What a person pastes into "Instance URL", made into the origin the server
 * stores. Accepts the three things people actually paste:
 *
 *   a bare instance name   "acme"                      → https://acme + suffix
 *   a host                 "acme.service-now.com"      → https://…
 *   a page they had open   "https://…/now/nav/ui/home" → just the origin
 *
 * Anything that cannot be read as a URL is returned trimmed, so the form can
 * say what is wrong with it instead of silently rewriting it.
 */
export function normaliseInstanceUrl(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  if (/^[a-z0-9][a-z0-9-]*$/i.test(v)) return `https://${v.toLowerCase()}${SN_SUFFIX}`;
  const withScheme = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(withScheme);
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return v;
  }
}

/** Null when the URL is usable, else one sentence saying why not. */
export function instanceUrlProblem(url) {
  if (!url) return 'Enter your instance URL, or just its name.';
  let u;
  try { u = new URL(url); } catch { return 'That is not a URL. Paste it from your browser, or type just the instance name.'; }
  if (!/^https?:$/.test(u.protocol)) return 'The instance URL must start with https://';
  if (!u.hostname.includes('.')) return 'That host has no domain. Paste the full address from your browser.';
  return null;
}

export function instanceHost(url) {
  try { return new URL(url).host; } catch { return ''; }
}

export const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

/** "Good morning, Ada" — or just the salutation when no name was given. */
export function greeting(name, hour = new Date().getHours()) {
  const salutation = hour < 5 ? 'Working late'
    : hour < 12 ? 'Good morning'
      : hour < 18 ? 'Good afternoon'
        : 'Good evening';
  const first = firstName(name);
  return first ? `${salutation}, ${first}` : salutation;
}

/**
 * The verdict on a /onboarding/checks answer. The workspace step may continue
 * only when every BLOCKING check passed; a warning is shown, never enforced.
 */
export function checksVerdict(result) {
  const checks = Array.isArray(result?.checks) ? result.checks : [];
  const failing = checks.filter((c) => c.blocking && c.state !== 'ok');
  const warnings = checks.filter((c) => !c.blocking && c.state !== 'ok');
  return { ready: checks.length > 0 && failing.length === 0, failing, warnings };
}

/** What the setup record says about a move between machines, for Settings. */
export function migrationSummary(status) {
  const m = status?.migration;
  if (!m?.fromHost) return { state: 'none', text: 'No migration has been performed' };
  let when = '';
  try { when = new Date(m.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch { /* keep blank */ }
  return { state: 'done', text: `Settings carried over from ${m.fromHost}${when ? ` on ${when}` : ''}` };
}

/** The notice the welcome step opens with, by why setup is being shown. */
export function reasonNotice(reason, previousHost) {
  if (reason === 'new-machine') {
    return {
      tone: 'info',
      title: `SAOS has moved${previousHost ? ` from ${previousHost}` : ''}.`,
      text: 'Its settings came with it and are filled in below. Confirm each step so this computer is set up properly.',
    };
  }
  if (reason === 'reset') {
    return {
      tone: 'info',
      title: 'Running setup again.',
      text: 'Everything you saved is kept and filled in. Change only what you want to.',
    };
  }
  return null;
}
