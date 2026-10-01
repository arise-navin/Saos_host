# SAOS desktop — the Windows and macOS installers

`desktop/` packages SAOS as an installable app: `SAOS-Setup-<version>.exe` for
Windows and `SAOS-<version>-mac-<chip>.dmg` for macOS. The installed app opens
in its own window and carries everything it needs — nothing else has to be
installed on the computer, not Node.js and not npm.

People download them from **Preferences → Desktop app**, which also has the
step-by-step install guide for both systems.

## Build an installer

Each installer is built on its own kind of computer: SAOS bundles native parts
made for one system (canvas, swc, rollup, keyring, libxmljs2 …) and the Node
runtime it was installed with. A Windows PC builds the Windows installer; a Mac
builds the Mac one, for its own chip.

You need this repository and Node.js 22.5 or newer, with dependencies installed:

```
npm install --prefix server
npm install --prefix server/fluent-workspace
npm install --prefix client
npm install --prefix desktop
node desktop/node_modules/electron/install.js   # only if npm skipped Electron's download (see below)
```

Then, from the repository folder:

```
npm run desktop:dist
```

| On      | You get                                         | Size    |
|---------|-------------------------------------------------|---------|
| Windows | `desktop/dist/SAOS-Setup-<version>.exe`         | ~250 MB |
| Mac     | `desktop/dist/SAOS-<version>-mac-arm64.dmg` (Apple silicon) or `-mac-x64.dmg` (Intel) | similar |

Preferences offers whatever is in `desktop/dist` on the computer running SAOS
(or in the folder `SAOS_DOWNLOADS_DIR` names). A Mac installer built on a Mac
can simply be copied into that folder on the Windows PC, and both buttons work.

`npm run pack` builds the unpacked app only (`desktop/dist/win-unpacked` or
`mac`), which is quicker when you are testing.

**What ships, and what never does.** `npm run stage` builds the client and
copies an allow-list into `desktop/stage/payload/`: the built UI, the server's
source and dependencies, the Fluent workspace's tracked files and SDK, and the
Node runtime running the build. It then checks the result and stops if anything
looks like user data (`settings.json`, a database, `.env`, flow backups,
`now.config.json`). Your credentials and chats never leave your computer.

**npm 11 blocks install scripts.** If `desktop/node_modules/electron/dist` is
missing after `npm install`, run `node desktop/node_modules/electron/install.js`.

**Running from a VS Code terminal?** VS Code sets `ELECTRON_RUN_AS_NODE=1`,
which makes Electron start as plain Node. Unset it for `npm start` in
`desktop/` (`set ELECTRON_RUN_AS_NODE=` in cmd, `unset ELECTRON_RUN_AS_NODE` on a
Mac). The installed app, opened normally, is not affected.

## What the installed app does

- **Runs the server on the bundled Node** (`payload/runtime`), as a child
  process, on `http://127.0.0.1:47831` — this computer only. The ServiceNow SDK
  runs on the same Node. It does NOT use Electron's own Node: the SDK's
  command-line parser mistakes that for a packaged Electron app and fails every
  build ("Unknown command"), and native modules built for Node do not load in
  Electron's (different module version). Measured 2026-09-29.
- **Keeps your files out of the program folder**, which every upgrade replaces:
  - Windows `%APPDATA%\SAOS`, macOS `~/Library/Application Support/SAOS`
    - `data` — settings (instance credentials, API keys), the database,
      attachments, flow backups
    - `workspaces` — the Fluent workspace and `app-<scope>` workspaces the agent
      writes. The SDK's 300 MB of dependencies are linked in from the install,
      not copied.
    - `logs/server.log` — the server's log (File → Open server log)
- **Shows the setup wizard** on first run — a new computer is a new user.
- **Stops the server when you close it**, and offers to restart it if it stops
  on its own. Uninstalling keeps your data.
- **Asks for a licence key, and locks itself when it ends** — see below.

## Licence keys (trials)

Every installed copy needs a key, and the key decides how long it works. Everyone
downloads the same installer; you send each person their own key.

```
cd desktop
npm run licence -- issue --name "Acme — Jane Doe" --hours 2
npm run licence -- issue --name "Acme — Jane Doe" --days 7
npm run licence -- issue --name "Acme — Jane Doe" --until 2026-10-07T17:00
npm run licence -- issue --name "Acme — Jane Doe" --days 7 --machine 1A2B-3C4D-5E6F-7A8B
npm run licence -- show SAOS1-…
```

- **The time counts from when you issue the key**, not from when they first open
  the app. `--hours 2` issued at 10:00 ends at 12:00. `--until` is read in this
  computer's local time.
- `--machine` ties the key to one computer: the person reads the ID off the
  licence page (Help → Licence) and sends it to you. Without it, the key works
  on any computer.
- Every key you issue is recorded in `issued.csv` beside the signing key.
- **In the app:** the first start shows the licence page. With a key the app works
  normally, the title bar shows the time left in the last week, and a warning
  appears 10 minutes before the end. **At the end** the server refuses every
  request and the window switches to "Your licence has ended" within a second.
  Chats, settings and projects are kept, and a new key unlocks them again.
- **Turning the clock back doesn't help.** The app takes the real time from the
  `Date` header of every ServiceNow reply (and asks the instance, without
  logging in, when it hasn't heard from it for 15 minutes). It also remembers the
  latest time it has seen, across restarts.

**The signing key** (`~/.saos-licence/signing-key.pem`, or
`SAOS_LICENCE_SIGNING_KEY`) is the whole secret: whoever has it can make keys.
It is NOT in the repository, and the build refuses a payload with a private key
in it. **Back it up.** If it is lost, installers already handed out won't accept
keys from a new one (`keygen`), until everyone gets a new build.

**What this does not stop:** someone who edits the installed files (the app's
code is plain JavaScript in the install folder, and the installers are
unsigned). It stops everyone else, and it can't be reset by reinstalling or by
changing the clock.

## Not in the installer (yet)

- **Meeting capture** — it needs a Python environment (`meeting-agent/`). The
  app hides it when it is not shipped.
- **Code signing** — both installers are unsigned. Windows SmartScreen says
  "Windows protected your PC" (More info → Run anyway); macOS asks you to allow
  the app in System Settings → Privacy & Security (Open Anyway). A Windows
  code-signing certificate (`CSC_LINK`) and an Apple Developer ID with
  notarisation remove those prompts; notarised Mac builds also need
  `hardenedRuntime: true` with JIT entitlements for the bundled Node.
- **The Mac build is untested so far** — it has only been configured on
  Windows. Build it on a Mac and try it before handing it out.
- **Auto-update** — install a newer version over the old one; your data stays.

## Trying a build without touching your real profile

```
set SAOS_USER_DIR=%TEMP%\saos-test        (Windows)
export SAOS_USER_DIR=/tmp/saos-test       (Mac)
npm start --prefix desktop
```

`SAOS_USER_DIR` points the app at another profile folder (data, workspaces, logs).
