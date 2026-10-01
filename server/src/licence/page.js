/*
 * /licence — the page the window shows while SAOS is locked, and from
 * Help → Licence at any time: the licence's state, this computer's ID, and a
 * box for a key.
 *
 * Self-contained (inline style and script, nothing from the built UI), because
 * while locked the server serves nothing else. Same ground and verdigris as
 * the desktop app's starting page (desktop/splash.js).
 */

export function licencePageHtml() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SAOS — Licence</title>
<style>
  :root{--ground:#0e1116;--panel:#151a21;--line:#262e39;--ink:#e7e3da;--muted:#8b93a1;--accent:#57b57c;--accent-line:#2c4e3b;--bad:#e4645c;--warn:#d9a441}
  *{box-sizing:border-box}
  html,body{min-height:100%;margin:0;background:var(--ground);color:var(--ink);font-family:"Segoe UI",system-ui,-apple-system,sans-serif}
  body{display:flex;justify-content:center;padding:48px 16px}
  main{width:100%;max-width:560px;display:flex;flex-direction:column;gap:20px}
  .mark{width:56px;height:56px;border-radius:14px;display:grid;place-items:center;background:var(--panel);border:1px solid var(--accent-line)}
  h1{margin:0;font-size:21px;font-weight:600;letter-spacing:-.01em}
  h1.bad{color:var(--bad)}
  p{margin:0;color:var(--muted);font-size:14px;line-height:1.55}
  dl{margin:0;display:grid;grid-template-columns:max-content 1fr;gap:8px 18px;padding:14px 16px;background:var(--panel);border:1px solid var(--line);border-radius:10px;font-size:13.5px}
  dt{color:var(--muted)}
  dd{margin:0;overflow-wrap:anywhere}
  .mono{font-family:Consolas,"SF Mono",monospace;letter-spacing:.02em}
  button{font:inherit;font-size:13.5px;border-radius:8px;padding:8px 16px;cursor:pointer;border:1px solid var(--accent-line);background:var(--accent);color:#08140d;font-weight:600}
  button.quiet{background:transparent;color:var(--ink);border-color:var(--line);font-weight:500;padding:3px 10px;font-size:12.5px;margin-left:8px}
  button:disabled{opacity:.6;cursor:default}
  label{font-size:13.5px;font-weight:600}
  textarea{width:100%;min-height:96px;resize:vertical;margin-top:8px;padding:10px 12px;background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:8px;font:12.5px Consolas,"SF Mono",monospace;word-break:break-all}
  textarea:focus{outline:2px solid var(--accent-line);border-color:var(--accent)}
  .row{display:flex;gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap}
  .error{color:var(--bad);font-size:13.5px}
  .hint{color:var(--warn)}
  .small{font-size:12.5px}
  [hidden]{display:none!important}
</style></head>
<body><main>
  <div class="mark" aria-hidden="true"><svg viewBox="0 0 64 64" width="34" height="34"><path d="M43 21.5 C40.5 16.5 22 15 21 24.5 C20 34 44 30 44 40.5 C44 50 24 50 20.5 43" fill="none" stroke="#57b57c" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
  <div>
    <h1 id="title">Licence</h1>
    <p id="lead" style="margin-top:8px">Checking the licence…</p>
    <p id="clock" class="hint small" style="margin-top:8px" hidden></p>
  </div>
  <dl id="facts" hidden>
    <dt class="k">Licensed to</dt><dd class="k" id="name"></dd>
    <dt class="k">Ends</dt><dd class="k" id="ends"></dd>
    <dt class="k">Time left</dt><dd class="k" id="left"></dd>
    <dt>This computer</dt><dd><span id="machine" class="mono"></span><button type="button" class="quiet" id="copy">Copy</button></dd>
  </dl>
  <div class="row" id="continueRow" hidden><button type="button" id="continue">Continue to SAOS</button></div>
  <form id="form">
    <label for="key" id="keyLabel">Licence key</label>
    <textarea id="key" spellcheck="false" autocomplete="off" placeholder="SAOS1-…"></textarea>
    <div class="row"><button type="submit" id="activate">Activate</button><span id="error" class="error" role="alert"></span></div>
  </form>
  <p class="small">Your chats, settings and projects stay on this computer whatever the licence says, and are all there again under a new key. Ask your SAOS contact for a key; if it should work on this computer only, send them the ID above.</p>
</main>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  let status = null;
  let fetchedAt = 0;
  const when = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  function span(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (d) return d + (d === 1 ? ' day ' : ' days ') + h + ' h';
    if (h) return h + ' h ' + m + ' min';
    if (m) return m + ' min ' + sec + ' s';
    return sec + ' s';
  }
  function left() { return status && status.remainingMs != null ? status.remainingMs - (performance.now() - fetchedAt) : null; }

  function render() {
    const s = status;
    const title = $('title');
    title.className = '';
    $('facts').hidden = false;
    /* Who and until when only once there is a key to say it. */
    for (const el of document.querySelectorAll('.k')) el.hidden = !s.expiresAt;
    $('continueRow').hidden = true;
    $('machine').textContent = s.machineId || '—';
    $('name').textContent = s.name || '—';
    $('ends').textContent = s.expiresAt ? when(s.expiresAt) : '—';
    $('left').textContent = '—';
    $('keyLabel').textContent = 'Licence key';
    if (!s.required) {
      title.textContent = 'No licence needed here';
      $('lead').textContent = 'Run from the source repository, SAOS does not check a licence. Only the installed desktop app does.';
    } else if (s.state === 'active') {
      title.textContent = 'Licence active';
      $('lead').textContent = 'SAOS is ready to use. It locks by itself when the licence ends.';
      $('left').textContent = span(left());
      $('continueRow').hidden = false;
      $('keyLabel').textContent = 'Have a new key? Paste it here to replace this one';
    } else if (s.state === 'expired') {
      title.textContent = 'Your licence has ended';
      title.className = 'bad';
      $('lead').textContent = 'The licence ended on ' + when(s.expiresAt) + '. Paste a new key to carry on where you left off.';
      $('left').textContent = 'none';
    } else if (s.state === 'wrong-machine') {
      title.textContent = 'This key is for another computer';
      title.className = 'bad';
      $('lead').textContent = 'The saved key was issued for computer ' + s.boundTo + '. Ask for a key for this computer, ' + s.machineId + '.';
    } else if (s.state === 'invalid') {
      title.textContent = 'The saved licence key is not valid';
      title.className = 'bad';
      $('lead').textContent = 'Paste your key again, or ask for a new one.';
    } else {
      title.textContent = 'Enter your licence key';
      $('lead').textContent = 'SAOS needs a licence key to start. Paste the key you were sent below.';
    }
    const skew = s.clockSkewMs;
    $('clock').hidden = !(skew != null && Math.abs(skew) > 5 * 60000);
    if (!$('clock').hidden) {
      $('clock').textContent = 'This computer\\'s clock is ' + span(Math.abs(skew)) + (skew > 0 ? ' ahead of' : ' behind')
        + ' the real time (as your ServiceNow instance reports it). The licence counts real time.';
    }
  }

  async function load() {
    try {
      const r = await fetch('/api/licence', { cache: 'no-store' });
      status = await r.json();
      fetchedAt = performance.now();
      render();
    } catch {
      $('lead').textContent = 'The local SAOS service is not answering. Close SAOS and open it again.';
    }
  }

  setInterval(() => {
    if (!status || status.state !== 'active') return;
    const l = left();
    if (l <= 0) { load(); return; }
    $('left').textContent = span(l);
  }, 1000);
  setInterval(load, 60000);

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = $('key').value.trim();
    $('error').textContent = '';
    if (!key) { $('error').textContent = 'Paste the key first.'; return; }
    $('activate').disabled = true;
    try {
      const r = await fetch('/api/licence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
      const body = await r.json();
      if (!r.ok) { $('error').textContent = body.message || 'That key was not accepted.'; return; }
      status = body;
      fetchedAt = performance.now();
      $('key').value = '';
      render();
    } catch {
      $('error').textContent = 'The local SAOS service is not answering. Close SAOS and open it again.';
    } finally {
      $('activate').disabled = false;
    }
  });

  $('continue').addEventListener('click', () => { location.href = '/'; });
  $('copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('machine').textContent); $('copy').textContent = 'Copied'; }
    catch { window.getSelection().selectAllChildren($('machine')); }
    setTimeout(() => { $('copy').textContent = 'Copy'; }, 1500);
  });

  load();
})();
</script>
</body></html>`;
}
