# CLAUDE.md

## Project: NowForge

NowForge is an agentic AI platform for ServiceNow development ("Claude Code for ServiceNow").
React frontend (`client/`), Node backend (`server/`), and agent tools that act on the PDI.

### Environment facts
Verified 2026-09-24 (Job 1.1), updated 2026-09-25 (Jobs 1.2 / 1.2b), unless marked UNVERIFIED.
- Connected instance: `dev366630` (server `data/settings.json` → `server/data/`, gitignored).
  The brief said `dev442675`; that PDI is UNVERIFIED / not the one connected.
- Workspace scope: `x_2002152_nwforge` ("NowForge Flows", sys_id `a20ebedf…`, 14 flows) — in
  `server/fluent-workspace/now.config.json`. `x_2196302_nwforge` does NOT exist on dev366630.
  CORRECTION 2026-09-25: it is NOT the only one — a second active app with the SAME name,
  `x_2002152_nowforge` "NowForge Flows" (`4e029a0c…`, created 2026-09-21, 4 flows), exists. Our tools
  act only on `x_2002152_nwforge`; do not match the app by its name.
- SDK: workspace pins `@servicenow/sdk` `^4.12.2`; the server reports CLI 4.12.2 (not 4.10.1).
- Base feature branch `fluent-live-flow-authoring`: does not exist in this repo (local or origin).
  Job branches have been cut from `fixes_existing`.
- Chat model: Ollama `gpt-oss:120b-cloud`.
- The connection user is shared with interactive browser use and runs scheduled jobs, so
  "records changed by the connection user" is noisy — scope change checks by table, not by user.
- Flow Designer uses the `*_v2` tables. Verified in sys_dictionary:
  - `sys_hub_flow` (extends `sys_hub_flow_base` < `sys_hub_flow_block`): `type` = flow | subflow,
    `internal_name`, `status`, `active`, `latest_snapshot`
  - `sys_hub_trigger_instance_v2`: `trigger_type`, `trigger_definition`, `trigger_inputs` (encoded)
  - `sys_hub_action_instance_v2` / `sys_hub_flow_logic_instance_v2` / `sys_hub_sub_flow_instance_v2`
    (extend `sys_hub_flow_component`): `flow`, `order` (int), `ui_id`, `parent_ui_id`, `values` /
    `subflow_inputs` (encoded)
  - `sys_hub_flow_input` / `_output` / `_variable` (extend `var_dictionary`): keyed by `model`
- Step config blobs are gzip+base64 JSON (also plain base64 / plain JSON). Data pills reference a
  step by its `ui_id` (hyphenated sys_id) and the trigger as `<Trigger>_1`.
- A subflow call's `subflow` column points at a `sys_hub_flow_snapshot`; its `parent_flow` is the subflow.
- A record-triggered FLOW has `sys_hub_flow_input` rows (current, table_name…): trigger data, not inputs.
- Tool results are cut at 8,000 chars by the orchestrator (`RESULT_CHAR_LIMIT`) — size tool output to fit.
- `gs.dateGenerate` in encoded queries did not match UTC values over REST; use
  `RELATIVEGE@minute@ago@N` for "changed recently" checks.
- `now-sdk build` runs offline and type-checks (TS6133 unused locals/params, TS2769 wrong input types)
  — but it does NOT check table names or data-pill output names: both compile and install (Job 1.2).
- `now-sdk install` deploys the WHOLE workspace app (8 flow sources + DBA tables + catalog policies here).
  With default activation it publishes EVERY flow in the app, drafts included (seen 2026-09-20);
  with `--skip-flow-activation` published flows revert to draft (trap #129). A whole-app install +
  re-publish took 1,364 s for one create and un-published every live flow for 9–16 min (2026-09-25).
  The SDK build hardcodes `active=false, status=draft` on every flow header (no source option).
- Since Job 1.2b, create_flow_live / edit_flow / restore_flow do NOT install the app. They build,
  then load ONE flow's package — `dist/app/update/sys_hub_flow_<sys_id>.xml` — through
  `POST /api/fluent/load/<scopeId>` (multipart `files`, the SDK's own `uploadXmlFiles` channel),
  then publish only that flow with `/api/now/wfa_fluent/activate_flows` (`server/src/servicenow/flow-load.js`).
  Measured: load ~4–15 s, activation ~30–60 s, whole tool ~75–120 s.
- Activation traps (measured, X1/X2): a header sent as `status=published` makes activate_flows answer
  "Published successfully" while compiling NOTHING. A LIVE flow must be loaded as active + `status=draft`
  (Flow Designer's "edited, not yet published"); its published snapshot keeps running until the compile
  lands (a record inserted in that window ran the OLD version). Never trust the activation answer — read
  the header back to `published` and prove the published snapshot equals the definition.
- A flow package's `delete_multiple` covers only tables the NEW version still has rows in. Rows the new
  version drops elsewhere (e.g. its last If block) need the build's deletion records,
  `dist/app/author_elective_update/<table>_<sys_id>.xml` — the fast channel sends them (T7 left an If behind without).
- A fluent load is captured in the app's "Default" update set (`5366098493a30b107c75f527dd03d632`):
  one `sys_hub_flow_<sys_id>` update record per flow (it is overwritten by each later edit), plus one
  `<table>_<sys_id>` record per step the edit deleted. It is NEVER moved into the chat's own update set
  (verified 2026-09-25): the harness job (`sysauto_script`, created over REST) runs in the connection
  user's CURRENT application — `x_2002152_nv` "NV_AG_AA app" since 2026-09-22 06:24 (before that
  `rhino.global`) — and from there `sys_update_set.insert()` returns null with no error (77 of 77
  since 2026-09-22; syslog `NFRPT … "setId":null,"ok":true`). The footer says "NOT captured for moving
  to another instance …". The two failed attempts cost ~35 s per flow-edit turn. Today a flow change
  reaches another instance only through the Fluent source (git) + `now-sdk install`, or by moving the
  Default-set rows into a named update set by hand.
- Runtime record triggers: `sys_flow_trigger_plan` (snapshot → trigger) → `sys_flow_record_trigger`
  (table, condition, on_insert/on_update). Flows with identical trigger configs SHARE one trigger row.
  The shared "incident created, no condition" row `8b35630c…` has fired nothing since 2026-09-23
  (Dummy Incident Flow, NowForge Edit Test original) — an instance problem, not ours. A trigger change
  re-points the plan to a new row (verified: priority=1 edit fired within seconds).
- now-sdk CLI flag casing is MIXED — `--skip-flow-activation` is kebab-case, `--demoData` camelCase.
  Check `--help`; do not assume camelCase.
- `now-sdk transform --table sys_hub_flow --id <sys_id>` pulls a UI-built flow into Fluent, but also
  emits raw Record() files tied to its published snapshot; not used automatically.
- ts-morph (TS 5.6.2) ships inside `server/fluent-workspace/node_modules` via the SDK.
- `now-sdk explain` is more reliable than the docs (UNVERIFIED this session)
- keys.ts ids == the live sys_ids of installed steps (verified on 5/5 steps), so step ↔ source is exact.
- HOW TO RUN (repo root): `npm start` = API (`node src/index.js`, NO auto-restart) + UI (vite, :5173).
  Use it for any flow work. `npm run dev` = same two halves, but the API restarts when a file in
  server/src changes (server/scripts/watch.mjs: content changes only, src/ only). The root had no
  `start` script before 2026-09-25; `server/`'s own `npm start` is the API alone (no UI).
- ROOT CAUSE of the "unexplained" mid-edit restarts (proven 2026-09-25): the old dev script was
  `node --watch`, which restarts on ANY fs event for a file the server has loaded. NTFS last-access
  updates are ON here (DisableLastAccess = 2) and persist when the stored time is > 1 h old, so the
  first lazy load of a module nobody read for an hour (ts-morph and friends, on the first flow preview
  or edit) fired an event and restarted the server mid-request (T5: 09:14:11 UTC). Reproduced in
  isolation. Every boot re-stamps the seed facts (`facts.ts`), which is how a restart can be dated.
  Saving a server/src file still restarts dev mode — never change server code during a flow edit.
  edit_flow keeps a journal (`server/data/flow-edit-journal.json`); if one is left behind, edits are
  refused until `restore_flow` on that flow has finished the recovery (worked every time). Any chat,
  old or new, shows a notice card with a Restore button while it is unrecovered (`/live` → `notices`),
  and the next message's model notice says to CALL restore_flow (the card is the confirmation) and to
  stop after a Reject (without that it re-called the rejected restore 7× in one turn).
  To check that UI without breaking a flow, write the journal by hand with stage `built` (before
  load: nothing on the instance changes) and delete it afterwards.
- Harness nudges to the model ("SYSTEM: that turn ended without calling a tool…") are stored as user
  rows with `internal: true` and never shown; rows stored before 2026-09-25 are hidden by the prefix.
  A second nudge is allowed after new tool results (the T2 case), none after the person rejected a card.
- get_flow shows choice LABELS (log_level "Info"); the SDK needs VALUES ("info"). edit_flow maps a
  label to its value before building — "Info" failed the build with TS2769 after 5.6 min (2026-09-25).
- Approval cards: the nonce reaches the SSE stream that started the turn, AND (since 2026-09-25) any
  window of that chat through `GET /api/agent/sessions/:id/live` (running turn, latest step, waiting
  cards). So a turn started by a script CAN be approved in the browser: open that chat. Cards time
  out after 5 min (`APPROVAL_TIMEOUT_MS`).
- The browser's stream reader has a watchdog: a changed `bootId` (from /api/system/health), three
  failed health probes, or 45 s without a byte (the server pings every 15 s) ends a request with a
  clear error. Vite's proxy keeps a dead upstream stream open, so without it the chat spun forever.
- Flow edit backups live in `server/data/flow-backups/<host>/<flow sys_id>/<timestamp>/` (gitignored).
- Trap #131 (seen live): after a flow EXECUTES, its header's `latest_snapshot` can point at an unreadable
  record, so `publishedProof` says UNKNOWN (null) while the header says active+published. Treat
  "unknown + live header" as live, or an install will leave the flow a draft.
- Only flows declared in the workspace's Fluent source are touched by an install; only those may be
  re-published. "DEMO Flow" (built in Flow Designer, no source) must never be activated by our tools.
- The chat model (gpt-oss) tends to send tool calls in the OUTPUT shape of the matching read tool
  (e.g. get_flow's {kind, name}); edit_flow normalises the unambiguous forms before validating.
- Tool selection is keyword-based (`server/src/agent/context-selection.js`): a request that never names
  the domain only gets that domain's tools if a signal matches it. Since Job 1.2b, naming one of the
  app's flows (names from the Fluent sources on disk + list_flows results) is such a signal.
- Live tests are driven through the chat API with approvals sent to `/api/agent/approve` (see Job 1.2
  report). Since Job 1.2b a create / edit / restore turn takes ~2–3 min end to end.
- Stage timings of every create / edit / restore are written to `server/data/timings/` (gitignored).
- Agent flow read tools are `list_flows` and `get_flow` (fixed in Job 1.1). `list_live_flows` lists
  only Fluent-source flows, not everything on the instance.
- First-run setup wizard (Job UI-1, 2026-09-28): `server/src/config/onboarding.js` decides whether it
  is owed — `first-run` (no settings.json / nothing configured), `new-machine` (the `onboarding.machineId`
  hash in settings.json ≠ this computer's), `reset` (Settings → Re-run setup). An install configured
  before the wizard existed is adopted silently on its first `GET /api/onboarding`. A first run records
  `startedAt`, or the name saved on step 1 would get the install adopted mid-setup (seen live).
  To see the wizard on a configured PC, use Settings → Re-run setup. Model test: `POST /api/agent/model/test`.
- Health scan timing (Job UI-2, 2026-09-28): every progress frame carries the server's stage `timeline`, `at`,
  `startedAt` and `typicalMs`; terminal frames carry `finishedAt`/`durationMs` read back from the run row, so
  live and stored times match to the ms. `GET /api/health/runs/history` (lean, no manifests) and
  `/runs/estimate?modules=` (median of the last 5 finished non-verification scans with the SAME requested
  module set; null otherwise). Measured on dev366630: ITOM-only scan 6m 31s (read tables 2m 49s, rule packs
  3m 35s); reading `cmdb_ci` alone takes ~2–2.5 min, and Stop only lands between tables (1m 42s seen).
  `health-dimensions.css` holds the dark `--hx-*` surfaces on `:root`; each light theme must re-point them.
- Windows installer (Job PKG-1, 2026-09-29): `desktop/` (Electron 44 + electron-builder NSIS) → `npm run dist` in
  desktop/ → `desktop/dist/SAOS-Setup-<ver>.exe` (~242 MB, per-user, unsigned → SmartScreen "Run anyway").
  The install folder is FIXED (%LOCALAPPDATA%\Programs\SAOS): NSIS silently skips any file whose full path
  reaches 260 chars (1,367 files, the SDK among them, lost installing into a deep folder); at start the app
  checks the 50 longest paths listed in payload.json and says "not fully installed" if one is missing.
  The server runs on the BUNDLED Node (payload/runtime = the build machine's node) at 127.0.0.1:47831 — NOT on
  Electron's Node: under ELECTRON_RUN_AS_NODE the SDK's yargs `hideBin` drops an argument ("Unknown command" on
  every build; `--version` still works, so a version probe does not catch it), and libxmljs2 is ABI 137 vs
  Electron's 149. Mac: `npm run desktop:dist` on a Mac → `SAOS-<ver>-mac-<arch>.dmg` (configured, UNVERIFIED).
  Preferences → Desktop app offers what is in desktop/dist (`SAOS_DOWNLOADS_DIR`) via /api/desktop/downloads.
  Every data/workspace path goes through `server/src/config/paths.js` (`SAOS_DATA_DIR`, `SAOS_WORKSPACES_DIR`;
  unset = server/data, server/) — a test fails if a module builds its own. Desktop: %APPDATA%\SAOS\{data,
  workspaces,logs}; the workspace's node_modules is a junction to the install. `SAOS_CLIENT_DIR` makes the API
  serve the built UI. VS Code terminals export ELECTRON_RUN_AS_NODE=1 — unset it to launch Electron from them.
  npm 11 skips Electron's download: `node node_modules/electron/install.js`. Install ~4 min, uninstall ~1 min.
- Rulebook CRUD (Job HC-1, 2026-09-29): changes to BUILT-IN rules live in `health_rule_overrides` (off / removed /
  severity / wording / an own check for a rule the product never built); every rule change — custom rules and
  thresholds too — is logged in `health_rule_history` (GLOBAL; thresholds stay per instance). The workbook files are
  never edited. A scan applies them via `ruleOverrides` (health/rulebook.js `rulebookScanOverrides`): CMDB through the
  catalogue Proxy (`withCatalogueOverrides`, cmdb-quality.js), ITSM + packs via `applyToNormalized` before analyze(),
  switched-off output dropped in analyze(). They join each module's ENGINE KEY (custom rules now too), so a reuse
  scan re-reads a changed module. Custom-rule / own-check findings now go through synthesize() — before, a failing
  custom rule had no priority (NOT NULL) and would have failed the run's write. "Pending" = a change no finished
  scan that READ its module started after (`/api/health/rulebook/changes`). `/health?scan=full` opens the scan
  options with Full System Scan ticked. Export: `/api/health/rulebook/export.xlsx?tab=`. On dev366630 a full scan
  took 97 min (ITSM ~11 min) on 2026-09-29. A test pins the schema version (now 34) in ~12 files; the Phase 18 guard
  forbids a table named *change*/*diff*/*baseline*. `scripts/health-workbook-audit.mjs` must be re-run when a test
  file starts naming rule ids (status-export lists them).
- Licence / trial lock (Job LIC-1, 2026-09-30): the installed desktop app needs a signed key (`SAOS1-…`, Ed25519)
  with a FIXED end time; `npm run licence -- issue …` in desktop/ makes one. The signing key lives OUTSIDE the repo
  (`~/.saos-licence/signing-key.pem` — made 2026-09-30 in `C:\Users\AaronSingh\.saos-licence`, `issued.csv` beside it);
  only the public half is in `server/src/licence/public-key.js`. Enforced when SAOS_LICENCE=required or SAOS_DESKTOP=1 (main.js sets both);
  NEVER from the repo (`npm start` / `npm run dev`). Locked: `licenceGate` (first middleware) answers 403
  `{code:'licence'}` to every /api path but /api/licence and /api/system/health, and redirects pages to /licence.
  Time = max(local clock, last ServiceNow `Date` header carried on the monotonic clock, stored high-water mark in
  `licence.json`); `instanceRequest` feeds every reply's Date header in, and `probeInstanceTime` does an
  unauthenticated HEAD / when it is > 15 min old. Measured on dev366630: header = UTC to the second; the window
  moved to /licence 1 s after the end (twice). Machine ID = hash of MachineGuid / IOPlatformUUID (Mac UNVERIFIED).

## How we work: jobs

Work is done in small "jobs". Follow these rules for EVERY job:

1. **Inspect before coding.** Query the real instance (the actual tables and `sys_dictionary`)
   instead of assuming table or field names. Write down what you verified.
2. **Stay in scope.** Build only what the job asks. No extra features, no refactors outside scope.
3. **Expose it as a tool.** Every new capability must be a proper agent tool (clear name,
   input schema, description) so the chat agent can call it.
4. **Gate writes.** Any tool that writes to the instance must go through the existing approval gate.
5. **Test for real.** Test on the live PDI, not just with mocks. Also add automated tests where practical.
6. **Branch per job.** Commit on a new branch per job named `job-<phase>-<number>-<short-name>`.
7. **Report.** Finish every job with a report in EXACTLY this format:

```
JOB REPORT
- Job: <id and name>
- What I built: <files + tools, 3-6 lines>
- What I verified on the instance: <tables/fields actually checked>
- Test results: <each acceptance test: PASS/FAIL + one line of evidence>
- Problems / surprises: <anything odd, or "none">
- Open questions for Rahul: <or "none">
```
