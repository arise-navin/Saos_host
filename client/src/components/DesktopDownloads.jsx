import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { formatDateTime } from './time.js';
import { detectPlatform, downloadHref, formatBytes, MAC_ARCH_LABEL, orderMacBuilds } from './desktopApp.js';
import './DesktopDownloads.css';

/*
 * PREFERENCES → DESKTOP APP. The Windows and macOS installers, and how to
 * install each in a few plain steps.
 *
 * The files come from the server (routes/desktop.js): whatever `npm run dist`
 * in desktop/ has built on this machine, or has been copied into that folder.
 * A platform without a build says so and says how one is made, rather than
 * offering a button that cannot work.
 */

const PATHS = {
  monitor: <><rect x="3" y="4" width="18" height="12" rx="1.5" /><path d="M8 20h8M12 16v4" /></>,
  laptop: <><rect x="4" y="5" width="16" height="11" rx="1.5" /><path d="M2 19.5h20" /></>,
  download: <><path d="M12 4v11M7 10l5 5 5-5" /><path d="M5 20h14" /></>,
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  build: <><path d="M14.5 6.5 17 4l3 3-2.5 2.5M14.5 6.5l3 3M14.5 6.5 5 16v3h3l9.5-9.5" /></>,
};
const Ic = ({ name, size = 18 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{PATHS[name]}</svg>
);

const B = ({ children }) => <b>{children}</b>;
const K = ({ children }) => <code className="dl-code">{children}</code>;

/* The steps, as a person does them. Kept short on purpose. */
const GUIDE = {
  windows: {
    steps: [
      <>Click <B>Download for Windows</B>. The installer saves to your <B>Downloads</B> folder.</>,
      <>Open the file. If Windows says <B>“Windows protected your PC”</B>, click <B>More info</B> and then <B>Run anyway</B>. It appears because the installer is not signed with a certificate yet.</>,
      <>On <B>“Choose Installation Options”</B>, keep <B>Only for me</B> selected and click <B>Install</B>. It takes about 5 minutes.</>,
      <>SAOS opens when it finishes. Next time, open it from the <B>Start menu</B> or the <B>SAOS</B> icon on your desktop.</>,
      <>The first time, a short setup asks for your name, your AI model and your ServiceNow instance. You can change them later in Preferences.</>,
    ],
    after: <>To remove it: <B>Settings → Apps → Installed apps → SAOS → Uninstall</B>. Your settings and chats stay in <K>%APPDATA%\SAOS</K>, so installing again picks up where you left off.</>,
  },
  mac: {
    steps: [
      <>Check which Mac you have: <B>Apple menu → About This Mac</B>. <B>Chip</B> means Apple silicon; <B>Processor</B> means Intel. Click the matching <B>Download</B> button.</>,
      <>Open the downloaded <K>.dmg</K> file and drag <B>SAOS</B> onto the <B>Applications</B> folder.</>,
      <>Open <B>SAOS</B> from Applications. If macOS says it cannot check the app, open <B>System Settings → Privacy &amp; Security</B>, scroll down, click <B>Open Anyway</B> and confirm. It appears because the app is not signed by Apple yet.</>,
      <>If macOS says SAOS <B>“is damaged and can’t be opened”</B>, open <B>Terminal</B>, run <K>xattr -cr /Applications/SAOS.app</K>, then open SAOS again.</>,
      <>The first time, a short setup asks for your name, your AI model and your ServiceNow instance. You can change them later in Preferences.</>,
    ],
    after: <>To remove it: drag <B>SAOS</B> from Applications to the Bin. Your settings and chats stay in <K>~/Library/Application Support/SAOS</K>.</>,
  },
};

/* Inside the installed app the installers are not bundled: they come from whoever shares SAOS. */
const SHARED_ELSEWHERE = 'Not offered from inside the app. Get the installer from whoever shares SAOS with your team.';

function BuildMeta({ build, kind }) {
  return (
    <p className="dl-meta">
      Version {build.version} · {formatBytes(build.size)} · {kind}
      <span>Built {formatDateTime(build.builtAt)}</span>
    </p>
  );
}

function Unavailable({ children }) {
  return <p className="dl-meta dl-missing">{children}</p>;
}

export default function DesktopDownloads() {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const here = detectPlatform(navigator.userAgent, navigator.userAgentData?.platform);
  const [guide, setGuide] = useState(here === 'mac' ? 'mac' : 'windows');

  useEffect(() => {
    api.get('/desktop/downloads').then(setInfo).catch((e) => setError(e.message));
  }, []);

  const win = info?.windows ?? null;
  const macs = orderMacBuilds(info?.mac ?? []);
  const inApp = Boolean(info?.running?.desktop);

  return (
    <section className="card dl-card" aria-labelledby="dl-title">
      <div className="dl-head">
        <div>
          <div className="card-title">Desktop app</div>
          <h2 className="dl-title" id="dl-title">Install SAOS on your computer</h2>
          <p className="dl-lead">
            SAOS opens in its own window with everything it needs built in, so there is nothing else to install first.
            Your settings, keys and chats stay on your computer.
          </p>
        </div>
        {inApp && <span className="badge green dl-inapp"><Ic name="check" size={13} /> You’re using the desktop app</span>}
      </div>

      {error && <p className="error-text">The downloads could not be listed: {error}</p>}

      <div className="dl-options">
        <div className={`dl-option${here === 'windows' ? ' is-here' : ''}`}>
          <div className="dl-option-head">
            <span className="dl-icon"><Ic name="monitor" /></span>
            <div>
              <h3>Windows</h3>
              <p>Windows 10 or 11, 64-bit</p>
            </div>
            {here === 'windows' && <span className="dl-here">This computer</span>}
          </div>
          {win ? <BuildMeta build={win} kind="installer (.exe)" /> : (
            <Unavailable>{!info ? 'Checking…' : inApp ? SHARED_ELSEWHERE : 'Not built yet. It is built on a Windows PC — see “Building the installers” below.'}</Unavailable>
          )}
          {win ? (
            <a className="btn primary dl-btn" href={downloadHref(win)} download={win.file}>
              <Ic name="download" size={16} /> Download for Windows
            </a>
          ) : (
            <button type="button" className="btn dl-btn" disabled><Ic name="download" size={16} /> Download for Windows</button>
          )}
        </div>

        <div className={`dl-option${here === 'mac' ? ' is-here' : ''}`}>
          <div className="dl-option-head">
            <span className="dl-icon"><Ic name="laptop" /></span>
            <div>
              <h3>macOS</h3>
              <p>Apple silicon or Intel Mac</p>
            </div>
            {here === 'mac' && <span className="dl-here">This computer</span>}
          </div>
          {macs.length ? (
            macs.map((b) => (
              <div key={b.file} className="dl-mac-build">
                <BuildMeta build={b} kind={`${MAC_ARCH_LABEL[b.arch] || b.arch} (.dmg)`} />
                <a className="btn primary dl-btn" href={downloadHref(b)} download={b.file}>
                  <Ic name="download" size={16} /> Download for Mac{macs.length > 1 ? ` — ${b.arch === 'x64' ? 'Intel' : 'Apple silicon'}` : ''}
                </a>
              </div>
            ))
          ) : (
            <>
              <Unavailable>{!info ? 'Checking…' : inApp ? SHARED_ELSEWHERE : 'Not built yet. A Mac installer is built on a Mac — see “Building the installers” below.'}</Unavailable>
              <button type="button" className="btn dl-btn" disabled><Ic name="download" size={16} /> Download for macOS</button>
            </>
          )}
        </div>
      </div>

      <div className="dl-guide">
        <div className="dl-guide-head">
          <h3>How to install</h3>
          <div className="dl-tabs" role="tablist" aria-label="Operating system">
            {[['windows', 'Windows'], ['mac', 'macOS']].map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={guide === id}
                className={guide === id ? 'is-on' : ''} onClick={() => setGuide(id)}>{label}</button>
            ))}
          </div>
        </div>
        <ol className="dl-steps">
          {GUIDE[guide].steps.map((s, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <li key={i}><span className="dl-step-n" aria-hidden="true">{i + 1}</span><span>{s}</span></li>
          ))}
        </ol>
        <p className="dl-after">{GUIDE[guide].after}</p>
      </div>

      <details className="dl-admin">
        <summary><Ic name="build" size={15} /> Building the installers</summary>
        <div className="dl-admin-body">
          <p>
            Each installer is built on its own kind of computer, because SAOS bundles parts made for that system.
            You need this repository and Node.js 22.5 or newer, with <K>npm install</K> run in <K>server</K>,{' '}
            <K>server/fluent-workspace</K>, <K>client</K> and <K>desktop</K>.
          </p>
          <ul>
            <li><B>Windows installer</B> — on a Windows PC, run <K>npm run desktop:dist</K> in the repository folder.</li>
            <li><B>Mac installer</B> — on a Mac, run the same <K>npm run desktop:dist</K>. It builds for that Mac’s chip.</li>
          </ul>
          <p>
            The file lands in <K>desktop/dist</K>. To offer it here, keep it in{' '}
            {info?.folder ? <K>{info.folder}</K> : <>that folder</>} on the computer that runs SAOS. A Mac installer built
            elsewhere can simply be copied in. The steps are in <K>desktop/README.md</K>.
          </p>
        </div>
      </details>
    </section>
  );
}
