import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * SETUP — one shared answer to "is the first-run wizard owed, and who is
 * this install for". A module-level store like useHealth, so the wizard,
 * Settings and the agent's greeting read one request, not three.
 *
 * `session` bumps each time setup becomes owed again (Re-run setup), so the
 * wizard can be keyed on it and start clean rather than resuming stale state.
 */

let state = { loading: true, status: null, error: null, session: 0 };
const listeners = new Set();
let inFlight = null;
const COMPLETED_KEY = 'saos.setup.completed';
let completedHere = false;
try { completedHere = localStorage.getItem(COMPLETED_KEY) === 'true'; } catch {}

function browserStatus(status) {
  if (!status || status.userId || status.required || completedHere) return status;
  return { ...status, required: true, reason: 'first-run' };
}

function set(next) {
  const wasRequired = Boolean(state.status?.required);
  state = { ...state, ...next };
  if (!wasRequired && state.status?.required) state = { ...state, session: state.session + 1 };
  for (const fn of listeners) fn(state);
}

export function refreshOnboarding() {
  if (inFlight) return inFlight;
  set({ loading: true, error: null });
  inFlight = api.get('/onboarding')
    .then((status) => set({ loading: false, status: browserStatus(status), error: null }))
    // A server that does not answer owes no wizard — the app's own
    // "server not responding" banner is the right thing to show then.
    .catch((err) => set({ loading: false, error: err.message }))
    .finally(() => { inFlight = null; });
  return inFlight;
}

/** Adopt a status a setup route already returned, without asking again. */
export function setOnboardingStatus(status, { completed = false } = {}) {
  if (!status) return;
  if (completed || status.required) {
    completedHere = completed && !status.required;
    try {
      if (completedHere) localStorage.setItem(COMPLETED_KEY, 'true');
      else localStorage.removeItem(COMPLETED_KEY);
    } catch {}
  }
  set({ loading: false, status: browserStatus(status), error: null });
}

export function useOnboarding() {
  const [snapshot, setSnapshot] = useState(state);
  useEffect(() => {
    listeners.add(setSnapshot);
    if (state.loading && !inFlight) refreshOnboarding();
    return () => { listeners.delete(setSnapshot); };
  }, []);
  return {
    ...snapshot,
    open: Boolean(snapshot.status?.required),
    name: snapshot.status?.settings?.profile?.name || '',
  };
}
