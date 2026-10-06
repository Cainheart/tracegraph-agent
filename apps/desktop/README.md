# @tracegraph/desktop

## Purpose

Electron Main composes the shared React Workbench, native dialogs and a fixed preload bridge. Live Desktop connects to the same authenticated local Host as Web and CLI; it creates no separate Runtime or Desktop data profile.

## Public API

The self-contained local installer includes Electron, an independently verified Node 24.21.0 runtime, the shared Web assets and an `outlive` CLI launcher. Installed users need no Node or pnpm installation. Open **Outlive Agent**, save a model configuration, run the explicit connection test, then create/open a project or start a chat. Optional tool configuration does not block first use. See [installation and release instructions](../../docs/releases/README.md).

After the workspace build, `env -u NODE_OPTIONS pnpm --filter @tracegraph/desktop start` opens the live application. `pnpm --filter @tracegraph/desktop preview` builds and opens deterministic fixtures with a visible Preview marker; it connects to no Host/model and writes no user profile.

Source startup requires a standalone Node 22.19+ within 22.x, or Node 24+. The trusted Host launcher verifies the executable and excludes Electron/preload flags and provider secrets from the background worker environment. Packaged startup verifies its fixed runtime manifest, binary SHA-256, platform, CPU, version and non-Electron identity; a broken bundle reports setup unavailable and never falls back to PATH. Only the owner/CLI child environment prepends its bundled Node directory; global shell settings are unchanged.

## Dependencies

`@tracegraph/desktop-host` exposes the shared Host connection. `@tracegraph/workbench` supplies React views, `@tracegraph/sdk` supplies typed operations/cursors, and `@tracegraph/contracts`/Zod validate safe boundaries. Electron owns windows, native dialogs and sandbox isolation.

## State ownership

`ensureLocalHost` discovers or starts the background owner for `~/.outlive/profiles/default`; `OUTLIVE_PROFILE_ROOT` is the trusted process override shared with Web/CLI. Explicit legacy profile paths remain supported; startup does not merge an existing `.tracegraph` directory. Private HTTP over UDS (Windows named pipe) authenticates against the same typed routes and Runtime as the loopback Web gateway. An unspecified gateway port is assigned dynamically; installed Web assets use that same owner. Discovery credentials stay in Main. The renderer receives only fixed, validated operations, safe settings/status and opaque project/Run/Session IDs.

The Host owns Ledger, Sessions, projects, credentials, settings revisions, background Runs, PTYs, previews and schedules. Closing the window or exiting Desktop closes client subscriptions and detaches; background work continues. The About settings page offers explicit Host stop/start/reconnect. A stopped owner is reported offline and is restarted only by the explicit start operation or a later application startup.

Restart-scoped settings use an explicit idle Host restart. Admission is quiesced before checking active Runs, queued work, terminals, previews and other writes; busy restart preserves them and returns a typed failure. A request receipt does not mean readiness: Main reconnects only after a new boot nonce and the UI verifies that pending settings cleared. Installed clients reject a different content-derived build ID without killing its background work; finish/stop that owner explicitly before launching the replacement build.

## Extension points

The shared Workbench provides conversation/project/session navigation, follow-up and active steering, exact patch/plan approvals, Todo, Artifact/test receipts, attachments, replay/rollback, Memory/Experience and Team. Canonical ledger, execution activity and public model surface use three actual SSE subscriptions with independent cursors. Compatibility thinking events never cross preload. Private model reasoning is never shown.

Settings expose source, scope, effective timing and writable state. Model credentials are write-only; saving a configuration and testing a provider are distinct outcomes. The default macOS credential store retains Keychain references. Isolated tests explicitly choose a private-file backend and a disposable profile; they do not inspect real credentials.

Workspace tools expose background tasks/queue cancellation, scoped Git/worktrees, a Host-owned PTY terminal, local preview services, schedules and archived sessions. Capability availability comes from the Host and the client-local native operations; unconfigured, policy-denied, read-only and unavailable states remain explicit.

Native folder selection registers roots privately. Native file selection is confined to the registered canonical project; a configured editor runs with fixed `[file]` argv and `shell: false`, otherwise OS open handles the file. Native preview accepts a ready Host-managed `127.0.0.1` service ID and opens a separate sandboxed WebContentsView with no Node, app preload or remote navigation. Closing the view preserves the service; stopping it is a separate command.

About also offers backup-first data import. Main remembers native-selected sources; the renderer reviews bounded metadata/conflicts and submits only the selected source ID. Active Host work rejects migration with `migration_busy`. Successful import reconnects to the new owner, preserves source data and isolates conflicting/untrusted registrations. An unknown migration outcome blocks a new import until the explicit **Inspect previous result** action returns a terminal persistent receipt; queries use only Main's remembered operation ID bound to the profile. After restarting the client, `host migration result OPERATION_ID` is the CLI recovery path.

## Model effect

The Host resolves the configured provider for new Runs and retains their recorded model/permission snapshot. Public plans are explicit model-authored statements; operation rows come from Runtime events and receipts. Saving credentials is independent of the explicit connection test. Preview supplies only deterministic presentation fixtures.

## Verification

Run package `build`, `typecheck`, and `test:unit`, plus shared Workbench tests. The reusable real transport acceptance is [desktop-transport.mjs](../../docs/validation/unified-workbench/desktop-transport.mjs); it uses disposable paths and a synthetic loopback provider with actual patch/test/PTY effects. `OUTLIVE_DESKTOP_MATRIX=1` adds native-window screenshot coverage at 1440×900, 1280×800 and 1024×768 in light/dark themes. Installed Playwright is supplied with `OUTLIVE_PLAYWRIGHT_MODULE`; the harness performs no build.

[smoke-desktop-product.mjs](../../scripts/smoke-desktop-product.mjs) launches the real assembled app with an isolated profile and a system-only child PATH. It checks the actual window, bundled CLI/model state, same-owner Web gateway, managed project, bundled Node in a real PTY where policy supports it, background completion across window close/reopen and idle settings restart. It records app termination/owner cleanup separately. This is a maintainer-machine test, not an independent fresh-machine or Windows acceptance claim.

## Background entry (APP-105 current slice)

Live Main creates a real menu-bar/Tray entry using the packaged icon. Closing all windows retains this entry where Tray creation succeeds; **Quit application** detaches Main while the single Host continues. **Stop background and quit** first shows a concrete native confirmation and dispatches the existing journaled `host.stop` command. Preview creates no background entry. A platform without a usable Tray retains the normal window/platform quit fallback.

Main reads the actual typed Host resources. Initial canonical notifications form a historical baseline, then new completion/failure/approval `event_id` values are deduplicated across owner replacement and filtered by shared profile notification preferences. OS bodies omit task contents. Clicking a notification loads/shows the packaged window and verifies the current live Run/project/session before emitting the one closed `onNativeRunRequested` event. Its consumer only navigates to a read-only Run; a click never approves, resumes or starts a task. Replay/offline cannot emit this event. A successful `Notification.show()` call is not proof of OS delivery.

The Tray and General settings use the shared CAS/history preference `general.prevent_sleep_during_tasks` (absent/false by default). Main holds `prevent-app-suspension` only for canonical `created`/`indexing`/`running` Runs when opted in. Waiting for approval, queued/idle, Replay, unavailable Host and Main quit release the blocker; closing a window alone keeps Main active. Lock screen, lid-close/manual sleep and OS policy remain outside this guarantee. Main notifications and the blocker end when the application is fully quit even though Host work continues.

[APP-105 narrow evidence](../../docs/validation/app-105/backend-slice.md) covers real persisted settings, compiled preload and isolated Main composition. Native system notification delivery, real Tray interaction and Windows acceptance remain separate pending evidence; this section does not certify an installer byte graph.

## Known limitations

Unsigned macOS and Windows installer assembly is available. Signing/notarization is a separate explicit build option requiring trusted credentials; no signed or notarized delivery is claimed without verified receipts. Auto-update, independent external-user acceptance and production model quality are not established by deterministic local tests. macOS observations do not prove Windows native execution. See [release instructions](../../docs/releases/README.md) and effective Host capabilities for current platform/provider constraints.
