import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { setAccountId } from '../account.js';
import SAOSLoadingScreen from './SAOSLoadingScreen.jsx';
import './AccountGate.css';

export default function AccountGate({ children }) {
  const [session, setSession] = useState(null);
  const [form, setForm] = useState({ username: '', password: '' });
  const [firstTime, setFirstTime] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const check = () => {
    setChecking(true);
    return api.get('/auth/session').then(value => {
    setAccountId(value.user?.id);
    setSession(value);
    setError('');
    }).catch(err => setError(err.message)).finally(() => setChecking(false));
  };
  useEffect(() => { check(); }, []);

  const login = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/auth/login', { ...form, createAccount: firstTime });
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
  return <><SAOSLoadingScreen ready={!!session || !!error} /><main className="account-gate">
    <form className="card account-form" onSubmit={login}>
      <h1>{firstTime ? 'Create account' : 'Sign in to SAOS'}</h1>
      <>
        <p>{firstTime ? 'Choose a username and password, then continue to setup.' : 'Sign in with your saved username and password. You can use your ServiceNow username.'}</p>
        <label className="label" htmlFor="account-username">Username</label>
        <input id="account-username" className="input" value={form.username} onChange={event => setForm({ ...form, username: event.target.value })} required autoComplete="username" />
        <label className="label" htmlFor="account-password">Password</label>
        <input id="account-password" className="input" type="password" value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} required autoComplete={firstTime ? 'new-password' : 'current-password'} />
        <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Signing in…' : firstTime ? 'Continue setup' : 'Sign in'}</button>
        <button className="btn" type="button" disabled={busy} onClick={() => { setFirstTime(!firstTime); setError(''); }}>{firstTime ? 'Already have an account? Sign in' : 'Create account'}</button>
      </>
      {error && <p role="alert">{error}</p>}
      {!session && error && <button className="btn" type="button" disabled={checking} onClick={check}>{checking ? 'Retrying…' : 'Retry'}</button>}
    </form>
  </main></>;
}
