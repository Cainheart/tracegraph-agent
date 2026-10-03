# Local installers, preview archives and public proofs

## Install and use the application

The self-contained Desktop product includes Electron, an independent Node
24.21.0 runtime, built application/Web assets, fixed project templates and an
`outlive` CLI launcher. Installed users do not need Node.js or pnpm. The macOS
artifact is `Outlive-Agent-VERSION-mac-ARCH.dmg` (also a ZIP); Windows uses a
per-user NSIS `Outlive-Agent-VERSION-win-ARCH.exe` (also a ZIP). Open the DMG and
copy **Outlive Agent** to Applications, or run the Windows setup wizard. The
default local builds are unsigned; a successful build does not establish
platform trust, notarization or a fresh-machine acceptance.

On first launch, save a model provider/API key and explicitly test its
connection. A saved key is not a passed connection test. Then create/open a
project or start a chat. MCP/LSP and image-provider configuration are optional.
Normal application use requires no terminal. The app starts one private,
authenticated background Host for `~/.outlive/profiles/default`; closing a
window retains background tasks. An unspecified Web gateway port is dynamic.
Use the local address shown in diagnostics or the bundled CLI's `host status`
output to reach the same owner's Web workbench.

The next local installer candidate is final7. Assembly and acceptance are
pending; the paths below are expected outputs, not verified final7 files:

| Target | Installer path from the source checkout | Current acceptance |
| --- | --- | --- |
| macOS Apple Silicon | `_tmp_release/current-workbench-recovery-mac-final7/artifacts/Outlive-Agent-0.1.0-alpha.0-mac-arm64.dmg` | Build and acceptance pending. |
| Windows x64 | `_tmp_release/current-workbench-recovery-win-final7/artifacts/Outlive-Agent-0.1.0-alpha.0-win-x64.exe` | Build pending; native Windows installation and use remain unverified. |

The builder also generates a ZIP and `SHA256SUMS` for each target. These are
local artifacts, not a published download service.

### Retained final6 artifacts and observations

The verified existing files are
`_tmp_release/current-workbench-recovery-mac-final6/artifacts/Outlive-Agent-0.1.0-alpha.0-mac-arm64.dmg`
(SHA-256 `280e44eb2bd3fba94bede7d1148751b26cd4504af2816b2a1e564ce2ccbd7a52`)
and
`_tmp_release/current-workbench-recovery-win-final6/artifacts/Outlive-Agent-0.1.0-alpha.0-win-x64.exe`
(SHA-256 `d43969679f764776466f4d8069f321ce500f6ffcd89347e6cb92e92237d255a7`).
Both byte hashes match their adjacent `SHA256SUMS`. The exact final6 product
build identities are `7c07335476e0c48a314fe36b9c8435b830d289f489e10e1dc1961032f030457f`
(macOS) and `04c2a2d958c51ddc8dc385aeac86e63ea6858909f481ece0f93c69c03537e308`
(Windows); both bundle Node 24.21.0 and are unsigned. The
[built Web attempt 012](../validation/current-workbench-recovery/attempt012-final-web/report.json)
and [packaged Desktop attempt 016](../validation/current-workbench-recovery/attempt016-final-packaged-desktop/report.json)
passed real UI/Host/Runtime journeys with a deterministic loopback provider,
126 screenshots each, and completed isolated cleanup. They cover saved models,
run options, actual patch/test approval, file editing, feedback, inline image
bytes, terminal input and external owner restart. Desktop also covers actual
owner crash, explicit stop and repair. The
[final6 attempt 017 receipt](../validation/current-workbench-recovery/attempt017-final-packaged-desktop/report.json)
retains its failed result; a preceding candidate's result does not prove new
installer bytes. Earlier failures remain in the
[current recovery evidence](../validation/current-workbench-recovery/README.md).
Attempt 017 reports navigation/screenshot timeouts and incomplete cleanup;
its isolated PIDs were verified exited and profile removed. The cause is not
established by that receipt. The subsequent
[final6 attempt 018](../validation/current-workbench-recovery/attempt018-final-packaged-desktop/report.json)
passed normal initial load and the full journey: 126 screenshots, 9 assertions,
and completed isolated cleanup. This does not mark repeated CDP reload as
resolved or prove final7 bytes.

### Bundled CLI and owner lifetime

The macOS CLI is contained at:

```bash
"/Applications/Outlive Agent.app/Contents/Resources/bin/outlive" host status --json
```

Windows includes `resources\bin\outlive.cmd` under the chosen installation
directory. The launcher invokes the fixed bundled Node and discovers the same
profile; it does not install a global command or change the user's PATH.
`host stop` explicitly stops background resources. `host restart` applies
restart-scoped settings only while idle and never cancels busy work. Its
receipt means requested; verify the new boot nonce/readiness before treating
the restart as complete. The Desktop settings action performs that reconnect.
Owner supervision rebinds current read authority and subscriptions after an
external restart or bounded crash recovery. It never replays a mutation or
resubmits an interrupted task. An explicit stop persists across monitoring,
wake and reopening a window in an already-running application. Fully quitting
and then starting the application is a new explicit start intent; only an
initial `stopped` snapshot triggers one repair. Explicit Start/Repair or
`host start` can also continue. Other startup failures are not treated as stop.
Replay retains its original read-only authority; repair requires leaving it.

Replacing the application preserves the profile outside the bundle. An
installed client refuses to attach to a different live product build; finish
and explicitly stop the previous owner before starting the new build.
Importing older `.tracegraph` data is an explicit preview/selection/backup
migration. Launch does not silently merge directories or replay side effects.

## Build a self-contained installer from source

Build tools are required only on the build machine:

```bash
env -u NODE_OPTIONS pnpm build
env -u NODE_OPTIONS pnpm dist:desktop --output /tmp/outlive-desktop-product
env -u NODE_OPTIONS node scripts/smoke-desktop-product.mjs \
  --product /tmp/outlive-desktop-product --output /tmp/outlive-desktop-smoke
```

Use a new output directory for every build; assembly refuses to mix an
existing stage. `--platform darwin|win32 --arch arm64|x64` selects a target;
`--dir` creates an unpacked candidate. The builder verifies official pinned
Node archive checksums and target-native node-pty/TypeScript binary headers.
The target TypeScript standard libraries remain runtime resources even though
they have `.d.ts` extensions; a fixed post-pack step preserves that library
tree. The native smoke runs its actual CodeGraph API through bundled Node.
Assembly records
the content-derived product build ID, application/runtime inventory and exact
artifact checksums in `product-release.json`, `stage/stage-inventory.json` and
`artifacts/SHA256SUMS`. `packaged-inventory.json` records the actual delivered
resources after the builder's dependency relocation and metadata pruning;
the pre-builder stage and installed resource inventories are distinct.
Cross-building an installer does not verify launching
it on the target OS. Native release CI runs the smoke separately on macOS and
Windows; an unexecuted CI job is not a passed platform result.

Unsigned builds do not read signing credentials. `--sign` explicitly enables
native platform signing using the configured `CSC_LINK`/`CSC_NAME` and
`CSC_KEY_PASSWORD`; macOS `--sign --notarize` additionally requires configured
Apple notarization credentials. Builds fail if an explicitly requested
signature/notarization is unavailable, and validate the native result before
recording it verified. No credential values enter release receipts. Current
local evidence and any failures are retained under
`docs/validation/installed-local-product/` in the source checkout. See
[known limitations](KNOWN-LIMITATIONS.md) for actual acceptance boundaries.

## Source/workspace preview compatibility

The public proofs and preview are reproducible locally; no upload or public
release occurs. The source checkout requires the Node/pnpm versions pinned in
package.json, a frozen dependency installation, and `pnpm build` first.

## Reproduce the three public proofs

```bash
node demos/proofs.mjs
# Optional: retain evidence in an explicitly new directory.
node demos/proofs.mjs --output /tmp/outlive-proof-review
```

The command exits nonzero on any failed oracle and prints a bundle path only
after all three pass. `report.json`, `SHA256SUMS`, per-demo `oracle.json`, raw
canonical ledgers, projections, and synthetic workspace files remain available.
The bundle contains local absolute paths and process IDs for verification; review
them before sharing. Controlled model responses are declared as fixtures.

| Task | Observable proof |
| --- | --- |
| DEMO-080 | A worker applies a real patch, pauses after apply/before WAL applied, receives SIGKILL, and dies. A new Runtime recovers and reconciles the same ledger; one patch/applied fact, one verified fact, unchanged file hash, and zero added events on repeated reconciliation are checked. |
| DEMO-081 | An explicitly exportable public fact is reviewed, recalled into a real model-request manifest and MemoryUse chain, and exported as a verified Capsule. A correction receives fresh explicit export consent, preserves lineage, is reviewed and recalled as the new version, and exports a second verified Capsule. Revocation excludes it from the next request and rejects future export. |
| DEMO-082 | Runtime run_test launches a leader and SIGTERM-resistant descendant. A durable cancel stops dispatch, settles work, and records canonical events. Both PIDs and the whole POSIX process group must be absent before success. |

## Build and extract the preview

```bash
node scripts/create-preview-release.mjs --output /tmp/outlive-preview-artifact
cd /tmp/outlive-preview-artifact
shasum -a 256 -c SHA256SUMS
mkdir /tmp/outlive-fresh-install
tar -xzf outlive-agent-0.1.0-alpha.0-preview.tar.gz -C /tmp/outlive-fresh-install
cd /tmp/outlive-fresh-install/outlive-agent-0.1.0-alpha.0-preview
node scripts/preview-install.mjs
node scripts/preview-smoke.mjs
```

Use the actual version printed by the builder if it differs. The installer checks
every archived file against SHA256SUMS, then runs a frozen dependency install
with lifecycle scripts and pnpmfile hooks disabled. Installation refuses any
unlisted file or directory, including extra workspace packages and config hooks.
It then runs the checksum-verified `prepare-native.mjs` to restore executable
permission on node-pty's pinned macOS spawn helper. Preparation does not execute
downloaded lifecycle scripts.
The headless smoke rechecks the same closed inventory, allowing only real
`node_modules` directories at the archive root and declared package roots. It
proves installed CLI→authenticated private shared Host Session query and the same
Session view through its HTTP gateway, legacy Desktop Host→framed RPC Session query, exact Host version,
clean Host exit, and package resolution within the extracted archive. It writes
a separate evidence report and uses temporary Runtime data.
No passed report is written until all Host/Runtime cleanup has succeeded.

The extracted archive also includes `demos/proofs.mjs`, so the three proofs can
run there after installation. Its bounded public failing-TypeScript example
includes the six template resources required by the installed Test Support
helper, with the same closed SHA-256 inventory. It excludes Outlive application source and
build tooling; use the prebuilt entrypoints documented here. Root `build`, `dev`,
`test`, and the source Desktop `preview` script require a source checkout and
must not be run inside this archive.

## Launch the Desktop preview

```bash
node scripts/preview-install.mjs --desktop-runtime
# Live local Desktop: connects to the shared background Host/profile.
pnpm --filter @tracegraph/desktop exec electron .
# Synthetic UI preview: explicitly labelled, no Host/model.
pnpm --filter @tracegraph/desktop exec electron . --preview
```

After the CLI install above, `--desktop-runtime` explicitly downloads the pinned
Electron native runtime without rerunning dependency installation. For a fresh
archive, `--desktop` performs both steps together. The package
is not code signed/notarized. The live window is labelled Local; configure a provider in Settings for model responses. The synthetic window is labelled Preview.
Do not use the source `preview` script in this archive: it rebuilds from source,
which is deliberately absent. The `site:*` scripts also require the source
checkout: the static documentation site and its source configuration are not
part of this runtime archive, even though the frozen workspace installation
includes their pinned development dependencies. The shared CLI starts the same
profile with `node apps/cli/dist/index.js host start`. Use
`--profile-root /absolute/profile` on each client for isolation. Stop it explicitly
with `host stop`; closing a window or an event subscription leaves background
tasks running. Explicit `serve --data-dir ... --session-dir ...` retains its
legacy compatibility behavior and cannot share a data writer with the new Host.

## Acceptance boundary

Read [known limitations](KNOWN-LIMITATIONS.md) before distributing the archive.
REL-083 has separate local evidence: an isolated official Node Linux container
installs the archive with no source checkout or host node_modules, then runs CLI,
Desktop Host and all three public proofs; a fresh macOS directory installs and
opens the actual unsigned Electron Preview. The container does not prove a
bare-metal or signed platform installer. Exact artifact hashes and receipts are
recorded in `docs/validation/2026-10-03-roadmap-closure.md` in the source
checkout, separate from the immutable install archive.

The current REL-084 task accepts the user-authorized, explicitly simulated
archive journey. P8's stronger external-user exit condition still requires at
least one actual non-maintainer to independently run the documented steps and
report environment, checksum, commands, outcomes and failure points.
Maintainer/Agent/container results do not substitute for that person's
observations. The full report template is in
`docs/validation/external-acceptance.md` in the source checkout. At minimum,
record a participant pseudonym and confirmation of non-maintainer status,
platform/date, archive SHA-256, initial environment, command exit codes,
CLI/GUI observations, demo evidence paths, failed steps and rerun outcomes.


## UX-086 refreshed preview

UX-086 changes the shared renderer and fixed Desktop commands. The earlier
archive checksum in `docs/validation/2026-10-03-roadmap-closure.md` identifies
the earlier UI. Fresh archive checksums, isolated Linux installation, macOS
installation and Desktop observations are recorded separately in
`docs/validation/ui-086-workbench-ux/release/` in the source checkout. Read those
receipts for the exact artifact and validation scope; earlier receipts do not
prove the refreshed bytes. Maintainer/Agent simulations remain explicitly
simulated, with real independent-user acceptance unverified.

## Shared-workbench refreshed preview

HOST-087 through RUN-092 and UX-086 second acceptance change Host lifetime,
profile, subscriptions, settings and developer resources. Archive and
fresh-directory installation receipts are recorded under
`docs/validation/unified-local-workbench/` in the source checkout. Use that
archive's checksum and evidence; previous archives identify previous behavior.
Migration is explicit through Desktop Settings/About or `host migration preview`
and `host migration commit` with an inventory and selected source. Original
directories remain intact, conflicts are quarantined, and restored history does
not automatically execute. Keep the Host running for schedules; missed and
overlapping occurrences are recorded and skipped.
