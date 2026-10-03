# Current workbench recovery validation

This directory records the current delivery of owner connection recovery, the user-selected B Current identity, unified conversation controls, saved model services and immutable task options, the real file editor and local answer feedback. Earlier UX/onboarding/install reports remain historical and are not overwritten.

The pre-order-correction built Web passed [126 screenshots and eight real journeys](attempt012-final-web/report.json), with [1,716 independent checks](attempt012-final-web/independent-verification.json). The final7 payload still requires fresh Web/native acceptance. The final6 first-load/full-flow receipt is preserved separately; a historical [final5 native pass](attempt016-final-packaged-desktop/report.json) does not certify a new installer archive. No external user credential or paid-provider request is used by these fixtures.

## Delivered application and installer identity

The historical final6 [macOS DMG](../../../_tmp_release/current-workbench-recovery-mac-final6/artifacts/Outlive-Agent-0.1.0-alpha.0-mac-arm64.dmg) and [Windows EXE](../../../_tmp_release/current-workbench-recovery-win-final6/artifacts/Outlive-Agent-0.1.0-alpha.0-win-x64.exe) contain the fixed Node 24.21.0 runtime, CLI and native dependencies. End users do not need Node or pnpm. Windows is a cross-build artifact with no native Windows launch or installation acceptance.

| Artifact | Build identity | SHA256 |
| --- | --- | --- |
| macOS ARM64 DMG | `7c07335476e0c48a314fe36b9c8435b830d289f489e10e1dc1961032f030457f` | `280e44eb2bd3fba94bede7d1148751b26cd4504af2816b2a1e564ce2ccbd7a52` |
| Windows x64 EXE | `04c2a2d958c51ddc8dc385aeac86e63ea6858909f481ece0f93c69c03537e308` | `d43969679f764776466f4d8069f321ce500f6ffcd89347e6cb92e92237d255a7` |

[The actual installation receipt](native-install.json) records the mounted final6 DMG source, destination `/Users/cain/Applications/Outlive Agent.app`, 11,514 individually hashed resources, launcher and complete ICNS. The earlier application is retained in the recorded backup directory; replacement does not copy or replace the user's profile. Dependency pins were corrected to the already-resolved CodeMirror versions. The v5 and v6 runtime graph identity is identical, while each archive's checksum identifies its own packaging bytes.

## Reproducible source checks

| Check | Current result and raw log |
| --- | --- |
| Clean production build | All 22 workspaces; [image-capability build](checks/build-image-final.log), [brand/order build](checks/build-brand-order-final.log) |
| Workspace and evaluation types | All 22 workspaces; [workspace log](checks/types-image-final.log), [evaluation types](checks/eval-types-final.log) |
| Workspace unit suite | 1,529 tests before the final layout-only reorder; [log](checks/unit-image-final.log) |
| Shared workbench | 236 tests across 29 files after the shared composer reorder; [log](checks/composer-order-final-unit.log), [types](checks/composer-order-final-typecheck.log) |
| Saved per-model image input | Four actual authenticated Host-route/provider/Ledger fixtures; [log](checks/saved-image-capabilities-final.log) |
| Engineering gates | 104 Node tests and eight Vitest tests; [log](checks/engineering-final.log) |
| Offline evaluations | [Final log](checks/evals-final.log) |
| Five accepted recorded snapshots | [Final log](checks/snapshots-final.log) |
| Lockfile and exact manifests | 23 manifests and 715 entries, frozen resolution unchanged; [strict gate](checks/lockfile-exact-final.log), [manifest gate](checks/manifests-exact-final.log) |
| Architecture and invariants | [Boundary log](checks/boundaries-final.log), [invariant log](checks/invariants-final.log) |
| Target installers | [macOS packaging](checks/package-mac-final6.log), [Windows cross-build packaging](checks/package-windows-final6.log) |

Earlier failed manifest logs remain intact: they exposed seven unpinned CodeMirror ranges, subsequently pinned to the exact existing lockfile versions. The strict gate above is the current result; no dependency resolution upgrade is implied.

## Backend and asset checks

```bash
pnpm --filter @tracegraph/contracts exec vitest run src/project-files-feedback.test.ts
pnpm --filter @tracegraph/sdk exec vitest run src/project-files-feedback.test.ts
pnpm --filter @tracegraph/host exec vitest run src/project-files-feedback.test.ts src/project-files-feedback.integration.test.ts
node --test scripts/build-brand-icons.test.mjs
node scripts/build-brand-icons.mjs --check
```

The real transport test uses a temporary private-file credential profile, actual authenticated private UDS and loopback HTTP clients, an actual registered project and a canonical completed local diagram Run. It checks explicit exact save approval, external file bytes, durable receipts, plain-chat feedback without filesystem authority, foreign answer rejection and replay rejection. It does not use user credentials or contact an external model.

The controller tests inject a controlled receipt-storage failure after a real file write: the save reports unknown and explicit reconciliation observes the target hash without repeating the mutation. Another fixture changes the file after durable dispatch and before the pinned descriptor writes; the final CAS comparison refuses the write. Workspace queue cancellation writes a terminal command receipt and prevents an exact retry from requeueing.

## Public API and limits

The six SDK methods are `listProjectFiles`, `readProjectFile`, `saveProjectFile`, `reconcileProjectFileSave`, `getAnswerFeedback` and `setAnswerFeedback`. Their closed contracts live in [project-files-feedback.ts](../../../packages/contracts/src/project-files-feedback.ts). Desktop fixed bridges call the same typed client and shared Host.

- File requests use registered project IDs and relative POSIX paths. Absolute paths, traversal, symlink components, multiply-linked files, private policy directories, dependency trees and dotenv files are rejected or omitted. Listings are one directory at a time, capped at 2,000 visible entries.
- Reads are bounded to one MiB. Existing UTF-8 regular files are editable; BOM and CRLF content is preserved. Binary files are read-only. Validated PNG/JPEG/static WebP preview snapshots carry actual bounded bytes, SHA256 and dimensions; SDK verifies the decoded bytes before the UI renders them. PNG preview currently accepts the generated-media validator's eight-bit non-interlaced formats. Unsupported or malformed raster encodings stay binary. JPEG/WebP container and size validation is not a claim that a browser decoded the image; the real UI must report decode errors.
- Saves require `command_id`, `expected_sha256` and the exact content; optional `session_id` resolves the selected session's permission without widening registration or the Host ceiling. Human editor saves are distinct from Agent Plan execution. Repository restrictions still apply. An `ask` decision returns a bound approval ID and writes nothing; approval or rejection must be explicit for the same intent, base hash, target hash and policy digest.
- Saves hold a WorkspaceCoordinator file lease and write only the authorized open inode. A symlink or pathname swap cannot redirect the descriptor to another target. This is not an atomic filesystem replacement: a crash can leave a partial write, reported as unknown and reconciled by observed hashes. External writers outside the Host coordinator can still race after the final CAS check; the post-write hash detects divergence, but the API is not a filesystem-wide transaction.
- Canonical SessionEvent commands, approvals and receipts are stored in `profileRoot/project-file-events`. They record paths, hashes, status and provenance IDs, never editor content, image bytes, API keys or the answer text. Reconciliation does not repeat a dispatched write.
- Feedback is `like`, `dislike` or `clear`, bound to the actual completed Run's public `run.completed` answer event. Its command and receipt persist locally; no provider call or telemetry transmission is made. Plain chat does not need filesystem capabilities for feedback. Failed/cancelled Runs and foreign answer IDs are rejected. Replay authority cannot invoke these live APIs.

## GUI evidence

`ui-journey.mjs` runs new built Web and staged/installed Desktop against isolated profiles and a declared synthetic loopback provider. It must finish cleanup before another native app acceptance run starts. Exact screenshot states, external CLI owner restart, saved provider/model choices, real editor CAS/approval/feedback and native bundle/icon hashes are recorded by each attempt's report. No report is passed before resource cleanup succeeds. The final built Web and each actual packaged-native attempt are linked below, retaining external effects, failures and cleanup instead of promoting screenshots alone into acceptance.

Real paid-provider quality, native Windows display, signing/notarization and independent non-maintainer acceptance remain outside these fixtures.

## Retained intermediate attempts

These reports are failed receipts, not completed acceptance. Their cleanup receipts verify that the owned temporary Host/browser resources were closed. A later pass must use newly built bytes and a new output directory.

| Attempt | Captured screenshots | Finding |
| --- | ---: | --- |
| [001 Web](attempt001-web/report.json) | 24 | The harness expected an unavailable Full access option to remain visible. The UI correctly omitted it before an explicit grant; the harness was corrected. |
| [002 Web](attempt002-web/report.json) | 27 | Actual first Full access grant returned HTTP 500 because the fresh profile's configuration parent directory was absent. The production fix and regression tests precede later attempts. |
| [003 Web](attempt003-web/report.json) | 39 | The harness expected Low reasoning effort from a custom adapter that advertised Default only. The controlled Alpha fixture was corrected to use the real OpenAI adapter with a loopback endpoint; unsupported options were not widened. |
| [004 Web](attempt004-web/report.json) | 54 | The actual patch, approval, Node test and committed file card passed. The harness compared CodeMirror DOM trailing blank lines as stored bytes; its UI document comparison was corrected while independent external-file hash checks remained exact. Independent visual review also found a real 1024-pixel project icon/label overlap, subsequently fixed in source. |
| [005 Web](attempt005-web/report.json) | 78 | Actual editor approval, denial, external CAS conflict, PNG decode and external CLI restart retained both drafts. The next explicit save was rejected with a stale capability token before command admission. This is an actual connection recovery defect; the failed receipt remains, and the safe authorization preflight and explicit rejection recovery require a new real UI run. |
| [006 Web](attempt006-web/report.json) | 81 | The new safe authorization preflight passed the original post-restart explicit-save flow, including approval and external hash. The remaining failure was a harness assumption that Appearance required a separate Save button; the actual typed setting saves on change. |
| [007 Web](attempt007-web/report.json) | 99 | The initial light/dark matrix and corrected project icon geometry passed. The attachment checkbox locator included a hidden duplicate file-input surface; the harness was corrected to select the visible checkbox by accessibility role. |
| [008 Web](attempt008-web/report.json) | 102 | The explicit inline image next task completed without an `attachment.added` event or actual provider image bytes. It remains a failed receipt; the next attempt captured the precise canonical rejection before cleanup. |
| [009 Web](attempt009-web/report.json) | 102 | The canonical Run proves the exact PNG reached Core with `delivery: inline`, then was rejected with `model_image_unsupported`: the bound model did not declare image-input capability. No inline bytes were sent to the provider. This is the correct fail-closed boundary, and the positive capability configuration still requires separate implementation/acceptance. |
| [010 partial Web](attempt010-web-interim-negative/report.json) | 108 | The explicitly declared interim run kept the negative image rejection and reached the real reopened history card. It then exposed a harness error: `getSession` returns a header and event references, not the session-list summary shape. The harness now derives Run IDs from canonical entry references. |
| [011 partial Web](attempt011-web-interim-negative/report.json) | 126 | Status is `diagnostic-completed`, not `passed`. All real light/dark layout, file/feedback/restart, retained history card, keyboard-to-PTY external bytes, external preview/detach, and current scoped SVG Artifact preview/download checks completed with cleanup. Inline input deliberately remains a recorded negative rejection. The final independent validator rejects this report. |
| [012 final built Web](attempt012-final-web/report.json) | 126 | Passed all eight real journeys, including explicit saved-model image-input configuration, immutable admitted capability and exact provider PNG bytes. [Independent verification](attempt012-final-web/independent-verification.json) passed 1,716 checks. All owned resources exited. |
| [013 packaged Desktop](attempt013-final-packaged-desktop/report.json) | 0 | The QA source-layout test-support helper looked for the template under `app/node_modules/examples`, while the seven real delivered files are in `app/examples`. The harness now supplies that actual bundled template root to the public bundled Core fixture factory and records every template hash. No source fallback or installation modification was used. |
| [014 packaged Desktop](attempt014-final-packaged-desktop/report.json) | 126 | All GUI journeys and actual owner SIGKILL/recovery/explicit-stop checks reached the last repair action. The harness selected both the enabled offline repair button and a disabled About fieldset button with the same label; it now targets the usable offline recovery control. |
| [015 packaged Desktop](attempt015-final-packaged-desktop/report.json) | 0 | Native reload waited for the full load event and timed out before interactions; the failure screenshot also timed out. The original cleanup timeout remains recorded. [Follow-up PID verification](attempt015-final-packaged-desktop/post-cleanup-verification.json) proves both owned processes subsequently exited. The harness uses DOMContentLoaded and independently waits for every actual control and receipt. |
| [016 packaged Desktop v5](attempt016-final-packaged-desktop/report.json) | 126 | Passed all nine real journeys and [1,752 independent checks](attempt016-final-packaged-desktop/independent-verification.json), including actual crash recovery, explicit stop respected by ordinary clients and explicit UI repair. This is a preserved v5 payload receipt; the v6 archive is separately identified even though its resolved runtime graph is unchanged. Final7 changes the shared composer ordering and needs fresh acceptance. |
| [017 packaged Desktop v6](attempt017-final-packaged-desktop/report.json) | 0 | A second artificial CDP reload during initial navigation timed out before any interaction; failure screenshot also timed out. Original cleanup timeout is preserved alongside the follow-up owned-PID exit proof. This receipt is failed. |
| [018 packaged Desktop v6 first load](attempt018-final-packaged-desktop/report.json) | 126 | Normal first-load document, real composer and fixed bridge readiness passed, followed by all nine actual journeys, [1,756 independent checks](attempt018-final-packaged-desktop/independent-verification.json) and owned-process cleanup. It does not certify final7's changed composer ordering. |
| [019 fully ready native reload diagnostic](attempt019-native-ready-reload-diagnostic/report.json) | 2 | Once the real initial document, model control and bridge were ready, an explicit reload regained usable controls in 107 ms with the same owner/generation, zero provider requests and zero Runs. Cleanup passed. This narrows the failed initial-navigation reload boundary without claiming its cause was proven or repaired. |

The executable independent validator, [verify-ui-evidence.mjs](verify-ui-evidence.mjs), checks exact state coverage, screenshot hashes and geometry, actual Run/model bindings, left Add/Permissions/Plan and right Model/Submit geometry for the newly corrected layout, external file/test/PTY/preview/download bytes, CLI reads and canonical scoped receipts. It rejects intermediate reports. The final intended matrix contains 42 state/theme pairs at three viewport sizes (126 screenshots); installed Desktop additionally exercises actual owner SIGKILL recovery, explicit CLI stop, non-starting ordinary reads, and explicit UI repair in the same isolated profile.
