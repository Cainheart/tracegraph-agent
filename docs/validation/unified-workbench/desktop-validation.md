# PAR-088 Desktop and CLI acceptance

The source build passed 21 real journeys and the 134-frame Desktop matrix on 2026-10-03. The [report](desktop-evidence-final/report.json), [independent verification](desktop-evidence-final/independent-verification.json) and [clickable original-image index](desktop-evidence-final/gallery.html) are preserved. Source entry-artifact hashes record the bytes tested at that time. Historical source images and receipts are not overwritten.

The final installed archive separately passed the same **21 journeys, 134 frames and 22 actual CLI process commands**, including the final telemetry wording. See its [installed report](../unified-local-workbench/evidence/installed-desktop/report.json), [independent verification](../unified-local-workbench/evidence/installed-desktop/independent-verification.json), [visual review](../unified-local-workbench/evidence/installed-desktop/visual-review.json) and [original-image index](../unified-local-workbench/evidence/installed-desktop/gallery.html). Archive SHA-256 is `33147dfea9230ad877627946d5117bd1eb96bc27289435528bd60b067f87c615`. After acceptance, [closed inventory verification](../unified-local-workbench/evidence/installed-desktop/post-inventory-integrity.json) passed for **1,489 files / 23,746,578 bytes**; no unlisted files were written into the installation. All three owned Host PIDs and Electron exited.

## Verified journeys

Desktop Main/preload and the actual CLI connect to one authenticated private local Host, sharing its model configuration, settings CAS revision, project scope, Runtime and owner identity. Fixed settings/status, skills/extensions, MCP/LSP, usage and telemetry routes return real Host results, including unconfigured states. The CLI connection test is separate from configuration saving, and command-line credentials are rejected without printing their values.

The visible Desktop composer stages a real fixture image and starts an executable task with Enter. Navigation, command palette and settings shortcuts work after readiness; DOM composition Enter does not submit, and Shift+Enter adds a newline. This checks browser event semantics, not native operating-system IME behavior.

Current public activity remains compact until clicked. Expanded history comes from actual operations. Three real SSE feeds keep separate cursors, drop compatibility thinking events, and detach without cancelling the Run. No private reasoning is displayed or inferred.

The real task reads and searches a disposable TypeScript project, requests approval, applies its scoped patch exactly once despite an identical command retry, and runs the actual fixture test process. Its successful receipt, test-log Artifact hash, actual source bytes and **2/2 assertions passed** output agree. The visible **Test output** control is absent before a test exists and later opens the same Artifact content. Attachment upload/read/download preserve bytes, media type and hash through Desktop and CLI. Replay authority stays opaque in the renderer and refuses writes until explicit exit.

Default rollback policy disables the UI action and records a same-Action refusal without changing the file. After an explicit isolated Host restart with both rollback policy flags enabled, the actual UI confirms the precise project/Run/Action/scope and requires the force checkbox for the linked project. A new durable `patch.rolled_back` event and the restored external file hash agree. This does not change default policy.

Queued CLI cancellation removes only the queued holder, preserving the active Run and model dispatch. Closing Electron keeps the owner and background Run alive; another Desktop reconnects to the same Run and receives completion. Explicit CLI cancellation returns zero only after canonical `cancelled`, while reading the cancelled task remains exit 1. No subsequent model call is dispatched.

Actual CLI resource commands produce real PTY output, detach the terminal client without closing the PTY, register a ready preview, and create a local schedule. Native preview uses a separate sandboxed view with no Node or app bridge; closing the view preserves the backend service. A configured native editor receives exactly one confined file argument without a shell. Native migration exposes bounded metadata/source IDs, creates a backup, preserves the source and reconnects to the new owner. Explicit Host stop reports offline; native start restores the same profile and gateway port with a new live owner.

## Screenshot coverage

Every frame uses the actual packaged renderer and native window content dimensions, with no injected demo projection. PNG hashes, pixel/CSS scale, theme and horizontal page bounds are recorded. Review additionally requires visible, nonzero bounds intersecting the viewport.

| States | Dimensions and themes | Frames |
|---|---|---:|
| Empty, project ready, active Run, approval, tool result, change review | 1440×900, 1280×800, 1024×768; light and dark | 36 |
| General, Appearance, Models, Permissions, Memory/privacy, Developer, Skills/extensions, MCP/LSP, Usage/diagnostics, About | Same three dimensions and two themes | 60 |
| Background tasks, Git/worktrees, Terminal, Preview services, Schedules, Archive | Same three dimensions and two themes | 36 |
| Settings search | 1024×768; light and dark | 2 |
| Total | | **134** |

All 134 frames were visually inspected through the unchanged-image index; representative narrow review/settings, expanded activity and actual test output were inspected at full resolution. Visible layout, controls and theme transitions passed. Additional evidence images show expanded public activity, actual test output, force confirmation and isolated native preview; they are not counted as target matrix frames. The Archive frames show the truthful empty archive in this fixture, and configured external MCP/LSP server behavior is outside this run.

## Reproduction and boundaries

The [harness](desktop-transport.mjs) uses a synthetic loopback provider, disposable profile/project paths and explicit private-file credentials. It never reads a real user key or Keychain. It exercises real Runtime, process, filesystem, approval, attachment, transport and resource behavior; model quality and independent external-user acceptance remain unknown.

```sh
env -u NODE_OPTIONS \
  OUTLIVE_DESKTOP_MATRIX=1 \
  OUTLIVE_PLAYWRIGHT_MODULE=/absolute/installed/playwright/index.mjs \
  node docs/validation/unified-workbench/desktop-transport.mjs /new/evidence/directory
node docs/validation/unified-workbench/verify-desktop-evidence.mjs /new/evidence/directory
node docs/validation/unified-workbench/desktop-gallery.mjs /new/evidence/directory
```

For an installed archive, add `OUTLIVE_REPOSITORY_ROOT=/absolute/installed/tree`. Electron Main, Host, SDK, Test Support, CLI and all seven public fixture template files resolve from that tree; the QA program runs externally and output belongs outside the archive. Template preflight/hash checks forbid falling back to source files. No dependency installation or build is performed, and no unlisted QA files are inserted into the frozen inventory. The verifier compares the selected tested entry-artifact and template hashes to that tree, so a later artifact rebuild is detected rather than silently accepted.

Success is written only after client detaches, owner PID exits, Electron shutdown, provider/preview closure and temporary directory cleanup complete. The source receipt records three distinct owner PIDs, all exited. [Failed attempts](desktop-attempts.md) retain their original errors and cleanup outcomes, including real CLI subscription, narrow review layout and native restart defects, alongside corrected fixture assumptions.
