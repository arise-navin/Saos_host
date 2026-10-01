'use strict';

/*
 * The window's first page, shown while the bundled server starts (a few
 * seconds: the database opens and migrates). Once the server answers, the
 * window navigates to the app, which has its own startup screen.
 *
 * Inline HTML as a data: URL — no file on disk, no server needed to show it.
 * Colours are the Original theme's ground and verdigris, the app's default.
 */

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function page(body) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>SAOS</title>
<style>
  html,body{height:100%;margin:0;background:#0e1116;color:#e7e3da;font-family:"Segoe UI",system-ui,sans-serif}
  body{display:flex;align-items:center;justify-content:center}
  .box{display:flex;flex-direction:column;align-items:center;gap:18px;max-width:560px;padding:24px;text-align:center}
  .mark{width:64px;height:64px;border-radius:16px;display:grid;place-items:center;background:#151a21;border:1px solid #2c4e3b}
  h1{margin:0;font-size:20px;font-weight:600;letter-spacing:-.01em}
  p{margin:0;color:#8b93a1;font-size:13.5px;line-height:1.55}
  .spin{width:18px;height:18px;border:2px solid #57b57c;border-right-color:transparent;border-radius:50%;animation:s .9s linear infinite}
  @keyframes s{to{transform:rotate(360deg)}}
  code{display:block;margin-top:6px;padding:8px 10px;background:#151a21;border:1px solid #262e39;border-radius:7px;color:#e7e3da;font:12px Consolas,monospace;word-break:break-all;text-align:left}
  .bad{color:#e4645c}
</style></head><body><div class="box">
  <div class="mark"><svg viewBox="0 0 64 64" width="38" height="38"><path d="M43 21.5 C40.5 16.5 22 15 21 24.5 C20 34 44 30 44 40.5 C44 50 24 50 20.5 43" fill="none" stroke="#57b57c" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
  ${body}
</div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

exports.startingPage = () => page(`
  <h1>Starting SAOS…</h1>
  <div class="spin" aria-hidden="true"></div>
  <p>Opening the local service. This takes a few seconds.</p>`);

exports.failedPage = (message, logFile) => page(`
  <h1 class="bad">SAOS could not start</h1>
  <p>${esc(message)}</p>
  <p>The details are in the server log:<code>${esc(logFile)}</code></p>
  <p>Close this window and open SAOS again. If it keeps happening, send that log file to your SAOS contact.</p>`);
