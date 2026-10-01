import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { setAccountId } from '../account.js';
import './AccountGate.css';

export default function AccountGate({ children }) {
  const [session, setSession] = useState(null);
  const [form, setForm] = useState({ instanceUrl: '', username: '', password: '' });
  const [firstTime, setFirstTime] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const check = () => api.get('/auth/session').then(value => {
    setAccountId(value.user?.id);
    setSession(value);
    setError('');
  }).catch(err => setError(err.message));
  useEffect(() => { check(); }, []);

  const login = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/auth/login', form);
      window.location.reload();
    } catch (err) { setError(err.message); setBusy(false); }
  };
  const logout = async () => {
    setBusy(true);
    try { await api.post('/auth/logout'); window.location.reload(); }
    catch (err) { setError(err.message); setBusy(false); }
  };

  if (session?.enabled === false) return children;
  if (session?.user) return <>
    {children}
    <div className="account-menu">
      <span>{session.user.username}</span>
      <button type="button" className="btn" disabled={busy} onClick={logout}>Sign out</button>
      {error && <span role="alert">{error}</span>}
    </div>
  </>;
  return <main className="account-gate">
    <form className="card account-form" onSubmit={login}>
      <h1>{!session ? 'Connecting to SAOS' : firstTime ? 'Set up your workspace' : 'Sign in to SAOS'}</h1>
      {session && <>
        <p>{firstTime ? 'Connect your ServiceNow account, then enter your own name and setup preferences.' : 'Use your ServiceNow account to open your saved workspace.'}</p>
        <label className="label" htmlFor="account-instance">ServiceNow instance URL</label>
        <input id="account-instance" className="input" type="url" placeholder="https://your-instance.service-now.com" value={form.instanceUrl} onChange={event => setForm({ ...form, instanceUrl: event.target.value })} required autoComplete="url" />
        <label className="label" htmlFor="account-username">Username</label>
        <input id="account-username" className="input" value={form.username} onChange={event => setForm({ ...form, username: event.target.value })} required autoComplete="username" />
        <label className="label" htmlFor="account-password">Password</label>
        <input id="account-password" className="input" type="password" value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} required autoComplete="current-password" />
        <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Signing in…' : firstTime ? 'Continue setup' : 'Sign in'}</button>
        <button className="btn" type="button" disabled={busy} onClick={() => setFirstTime(!firstTime)}>{firstTime ? 'Already set up? Sign in' : 'First time? Set up your workspace'}</button>
      </>}
      {error && <p role="alert">{error}</p>}
      {!session && error && <button className="btn" type="button" onClick={check}>Retry</button>}
    </form>
  </main>;
}
