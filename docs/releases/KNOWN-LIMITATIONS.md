# Local distribution limitations

The self-contained Desktop product and the older workspace preview archive
are distinct artifacts. Both are for local single-user evaluation. All workspace
packages remain private; nothing is published to npm by these scripts. The
Desktop product bundles Electron, an independent checksum-verified Node, built
application/Web assets and a fixed CLI launcher. Its inventory/checksums and
content-derived build identity are not an OS vulnerability audit. The older
archive contains built JavaScript and renderer assets, pinned manifests and
lockfile, instructions, SHA-256 checksums and a CycloneDX dependency inventory.

The current final8 local installer candidate has verified existing output files
`_tmp_release/current-workbench-recovery-mac-final8/artifacts/Outlive-Agent-0.1.0-alpha.0-mac-arm64.dmg`
and
`_tmp_release/current-workbench-recovery-win-final8/artifacts/Outlive-Agent-0.1.0-alpha.0-win-x64.exe`.
The macOS DMG hash is `7538966e67dca660b4661c68f35ef4b22e9f735932bdda351cd626a4932d04e5`,
with build ID `871f507b0b4cc01f59950715d542b2a40294cf38022a9aed49e2bcbf5832ed8f`.
The Windows EXE hash is `eac0970abf8872ce2cffd921c7d781d64f5fca769d766039efbcd7c288269e53`,
with build ID `d3bf4978eaa4708cfca015e56bb7994fddd64d11d88d59893736633750599fd3`.
Both bundle Node 24.21.0, require no external Node/pnpm and remain unsigned.
[Built Web attempt 024](../validation/current-workbench-recovery/attempt024-final8-web/report.json)
and its external CLI/context oracles passed;
[installed Desktop attempt 025](../validation/current-workbench-recovery/attempt025-final8-installed-desktop/report.json)
passed 11 assertions, 130 PNGs and
[4,429 independent checks](../validation/current-workbench-recovery/attempt025-final8-installed-desktop/independent-verification.json),
including actual owner SIGKILL recovery, explicit stop/Repair and fresh Main
launch with six completed Run timelines unchanged and no extra execution.
Isolated process/profile cleanup completed. This is controlled maintainer-Agent
acceptance on macOS, not a clean-machine, independent-user or OS sleep/wake
acceptance. The earlier final7
[installed macOS attempt 021](../validation/current-workbench-recovery/attempt021-final-installed-desktop/report.json)
failed at automatic owner recovery after SIGKILL; cleanup completed. The
full GUI business flows passed before this failure, whose cause remains unknown.
[Attempt 023](../validation/current-workbench-recovery/attempt023-final7-native-lifecycle-diagnostic/report.json)
observed actual crash recovery/stop/Repair/fresh Main but retained a failed
download-CDP cleanup result; owned processes exited and profile was removed.
Neither receipt proves final8 installation acceptance. Final7 hashes and build
identities remain in the [retained release record](README.md#retained-final7-artifacts-and-observations).
Native Windows installation/use and formal signing are not
proved by container hashes or macOS cross-builds.
Retained final6 installers are
`_tmp_release/current-workbench-recovery-mac-final6/artifacts/Outlive-Agent-0.1.0-alpha.0-mac-arm64.dmg`
and
`_tmp_release/current-workbench-recovery-win-final6/artifacts/Outlive-Agent-0.1.0-alpha.0-win-x64.exe`;
both include Node 24.21.0 and need no separately installed Node or pnpm.
[Built Web attempt 012](../validation/current-workbench-recovery/attempt012-final-web/report.json)
and [packaged macOS attempt 016](../validation/current-workbench-recovery/attempt016-final-packaged-desktop/report.json)
passed controlled maintainer-Agent journeys and cleanup. The preceding macOS
candidate's result is separate from
[final6 attempt 017](../validation/current-workbench-recovery/attempt017-final-packaged-desktop/report.json),
which failed before its first screenshot with navigation/screenshot timeouts
and incomplete cleanup. The receipt verifies isolated process exit and profile
removal but does not establish the timeout cause. The subsequent
[final6 attempt 018](../validation/current-workbench-recovery/attempt018-final-packaged-desktop/report.json)
passed normal initial load and the full journey with 126 screenshots,
9 assertions and completed cleanup; this does not resolve the repeated-CDP-reload
failure or establish final7 acceptance. Native Windows, clean macOS/Windows machines, formal
signing/notarization and independent non-maintainer acceptance remain unverified.
Previous archive/installer observations below remain historical evidence.

- Installed Desktop use needs no external Node or pnpm. Source builds and the
  older workspace preview require Node and the exact pnpm in package.json. Dependency
  installation needs access to the configured registry (or a populated pnpm
  store); that archive's Electron native download is an explicit install step.
- The older archive SBOM covers workspace packages and every registry package pinned in the
  lockfile, including development/optional dependencies. Node, pnpm, system
  libraries, and the separately downloaded Electron binary are external runtimes;
  this is not a full operating-system/native-binary SBOM or vulnerability audit.
- macOS DMG/ZIP and Windows NSIS/ZIP assembly exist. Default artifacts are
  unsigned. Explicit signing/notarization configuration is available for native
  CI, but actual credentials and verified receipts are required before claiming
  those outcomes. No Linux installer, auto-update, production support promise
  or remote hosted deployment is provided. Windows cross-builds on macOS do
  not prove native installation, launch or PTY behavior.
- A fresh-directory install on a maintainer machine is not a clean-machine test.
  REL-083 also has an isolated Linux container install and a native macOS
  Preview observation; neither proves a signed platform installer. Current
  REL-084 accepts an explicitly labelled maintainer Agent simulation. P8's
  independent external-user condition still requires a real participant.
- Desktop Preview displays deterministic synthetic data. Live Web/Desktop and
  CLI connect to one authenticated local Host/profile. Existing approvals,
  Todo, Artifact, attachments, public SSE, replay/rollback, Team and optional
  settings use common controllers; operation capabilities and permission policy
  remain authoritative. Saving a model is separate from testing its connection.
- Client windows detach from Runs, terminals and previews. Explicit Host stop
  cancels Runs and closes owned process groups. No login startup is installed.
  A terminal holds its workspace write lease until it exits or is explicitly
  closed; queued operations can be cancelled before execution. After Host crash,
  terminals/previews are reported interrupted/stopped and are not auto-rerun.
- Installed default state is `~/.outlive/profiles/default`. Explicit older roots
  remain supported; startup never automatically merges `.tracegraph` data.
  An unspecified gateway port is dynamic. A different live product build is
  rejected without stopping it; complete/stop its work explicitly before
  starting the replacement. Restart-scoped optional-tool/telemetry settings
  require an explicit idle Host restart, not closing and reopening a window. Busy restart returns a
  typed failure and preserves tasks/resources; a request receipt is not readiness.
  Current clients supervise owner generations and refresh authenticated read clients
  and subscriptions after external restart/crash/wake. Recovery never retries a
  mutation or resumes a Run. Explicit stop leaves a persistent marker until
  a fresh application launch after fully quitting, explicit Start/Repair or CLI
  `host start`. Activation, window reopening in an existing Main process and wake
  do not override it. Fresh launch repairs only `stopped`, never a generic
  profile/build/replay failure. Replay retains its fixed read-only authority.
  Bootstrap-managed HTTP clients perform a bounded read-only authentication
  preflight before an explicit write, then send the command once. A rejected
  preflight sends no command; an uncertain dispatched result needs reconciliation.
- Saved model services and per-session options bind the actual model, credential
  version and permission at task admission. Key removal/replacement affects new
  tasks, while admitted tasks retain leased credentials. Local Full eligibility
  is an explicit revocable grant and cannot raise an administrator ceiling.
  Grant changes remain pending until an idle owner replacement applies the new
  ceiling; busy tasks/resources are retained rather than cancelled to apply it.
  Image-input declarations apply only to selected configured models and remain
  frozen for admitted tasks. They are user declarations, not a successful image
  quality test or an inference from a familiar model name.
  Human file saves use exact content/base hash, policy, approvals and a workspace
  lease; unknown writes require reconciliation. In-place text writes are not a
  filesystem-wide transaction. See the [file/editor limits](../validation/current-workbench-recovery/README.md).
- Patch, Plan and human file-save approvals have explicit public decision paths.
  A general non-Patch tool policy `ask` still requires a trusted Runtime
  `approvalAnswerer`; without one it fails closed as `approval_unavailable`.
  The current approval UI cannot approve every tool-policy `ask`.
- Project-file context is limited to five existing project-relative UTF-8 files,
  64 KiB per file and 128 KiB total. Binary/NUL, excluded private/dependency paths,
  symlinks, multiple hard links and non-allow read policies are rejected. Client
  requests carry paths and hashes, never trusted content. Admission freezes the
  version; a changed selection creates no Run. Core verifies the trusted bytes
  and persists redacted Artifacts with untrusted provenance. Original source
  hashes and redacted Artifact hashes are distinct. Explicit recovery reads
  saved Artifacts, and missing/corrupt ones fail closed. Plain chat has no project
  selection. Source tests and final8 built Web/external CLI context acceptance have passed;
  final8 installed Desktop acceptance passed. Final7 crash recovery failed in attempt 021, and earlier final6
  receipts cannot prove this new behavior.
- Native restricted process enforcement remains macOS Seatbelt only. Linux and
  Windows restricted execution reports unavailable and fails closed. An explicit
  full-access preset has its existing broader authority. This preview does not
  certify cross-platform PTY or installer behavior from macOS observations.
  Packaged runtime validation never falls back to an external Node when its
  fixed manifest/binary fails verification; repair requires a valid bundle.
  TypeScript's target-native standard-library declarations are required at
  runtime and are preserved explicitly. Earlier installer candidates missing
  these files failed real project analysis; those failures remain in evidence
  and do not qualify as final installation acceptance.
- Schedules require the Host to remain running. Missed/overlapping triggers are
  recorded and skipped; pending approvals pause the schedule. An interrupted
  claimed trigger is never automatically retried. Replay never executes a task.
- Workbench notifications are bounded projections of canonical Run facts, with
  stable event references. Reconnecting shows retained completion/failure/approval
  facts. System notifications require an attached client and explicit browser/OS
  permission; closing every client does not install a separate OS notification
  daemon or grant notification permission.
- Legacy migration preserves source directories and creates a private backup.
  Sources with conflicts require explicit selection; other sources and linked
  project authority remain quarantined. Stop active legacy writers and close
  current resources before committing. Credential references without an existing
  backend value require reconfiguration; keys are never included in inventory.
- Public demos use synthetic user content and controlled model decisions, while
  Runtime, files, WAL reconciliation, and POSIX child process cleanup are real.
  Windows descendant cleanup is unsupported; the proof fails rather than skips.
- Memory export requires explicit consent for the exact active authored version.
  Correction defaults to no export consent and requires a fresh explicit opt-in
  for that corrected version. Revocation stops future local use and export;
  it cannot retract a previously exported external Capsule.
- Isolation is not claimed by the demos: their disposable fixture explicitly
  runs with sandbox enforcement disabled to exercise process/WAL semantics.

Do not enter private provider credentials or real personal Memory into a public
evidence bundle. Generated demo fixtures contain only synthetic public content.

## Observation after the UX-086 archive was frozen

The final archive (`41622f1719467850475d583115357d21ba0aa69e8469f27ab8b1e6cf0140298a`)
had one Linux DEMO-080 failure before crash injection: a fail-closed
`SessionPathSafetyError` reported that the session file changed while opening.
One completely fresh container rerun passed installation, smoke and all three
proofs. The cause remains unlocated; Core was not changed and the initial
failure is retained in the source sidecar report at
`docs/validation/ui-086-workbench-ux/release/attempts/final-archive/report.json`.
The immutable archive keeps the documentation captured at freeze time; this
current-source observation supplements it and does not claim zero failures.
