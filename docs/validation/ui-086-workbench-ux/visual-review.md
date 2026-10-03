# UX-086 live screenshot review

The final receipt was recorded at `2026-10-02T23:42:18.763Z` (2026-10-03 07:42 Asia/Shanghai). The full journey and the independent evidence verifier passed. All 24 live screenshots below were individually viewed after capture. Their viewport dimensions, SHA-256 hashes, interactive checks, canonical Run state, and sequence are in [report.json](evidence/report.json).

| Surface / state | 1440 × 900 | 1280 × 800 | 1024 × 768 |
| --- | --- | --- | --- |
| Web / empty | [PNG](evidence/web-empty-1440x900.png) | [PNG](evidence/web-empty-1280x800.png) | [PNG](evidence/web-empty-1024x768.png) |
| Web / active Run | [PNG](evidence/web-active-run-1440x900.png) | [PNG](evidence/web-active-run-1280x800.png) | [PNG](evidence/web-active-run-1024x768.png) |
| Web / tool result | [PNG](evidence/web-tool-result-1440x900.png) | [PNG](evidence/web-tool-result-1280x800.png) | [PNG](evidence/web-tool-result-1024x768.png) |
| Web / change review | [PNG](evidence/web-change-review-1440x900.png) | [PNG](evidence/web-change-review-1280x800.png) | [PNG](evidence/web-change-review-1024x768.png) |
| Desktop / empty | [PNG](evidence/desktop-empty-1440x900.png) | [PNG](evidence/desktop-empty-1280x800.png) | [PNG](evidence/desktop-empty-1024x768.png) |
| Desktop / active Run | [PNG](evidence/desktop-active-run-1440x900.png) | [PNG](evidence/desktop-active-run-1280x800.png) | [PNG](evidence/desktop-active-run-1024x768.png) |
| Desktop / tool result | [PNG](evidence/desktop-tool-result-1440x900.png) | [PNG](evidence/desktop-tool-result-1280x800.png) | [PNG](evidence/desktop-tool-result-1024x768.png) |
| Desktop / change review | [PNG](evidence/desktop-change-review-1440x900.png) | [PNG](evidence/desktop-change-review-1280x800.png) | [PNG](evidence/desktop-change-review-1024x768.png) |

The shared navigation, conversation canvas, editable composer, actual tool receipt, and verified file diff remain usable at each width. The 1024-pixel review layout exposes Files, Architecture, and Diff through tabs; actual panel visibility and file selection were exercised. Wider layouts expose the panels together and use the actual file selector. No horizontal document overflow or compact read-only gate was observed. Desktop accurately shows missing architecture evidence; Web records the real fixture's CodeGraph evidence.

Both completed projections require an actual verified patch and a `tests_passed` business receipt. The raw test-log Artifact was opened from each UI and contained `2/2 fixture assertions passed`. Desktop used the real `workspace-write` sandbox with full Seatbelt enforcement, network denied, and no unmet constraints. The disposable Web fixture used its explicitly configured legacy `danger-full-access` mode. Provider decisions came from the labelled local synthetic provider; this receipt does not measure remote model quality or independent external-user acceptance. Fixture registration and synthetic model configuration were seeded through the public/native Host APIs; project selection and subsequent interactions used the actual UI.

The separate [source Preview marker screenshot](evidence/desktop-preview-boundary.png) proves the observable deterministic example-data boundary. It was captured during the startup animation and remains the original receipt; it is not counted among the 24 live screenshots. Clear installed-archive native screenshots are separate release evidence.

The retained [Desktop failed attempt](attempts/desktop-tests-failed/report.json) and [Electron process negative oracle](attempts/desktop-tests-failed/electron-process-oracle.json) exposed the embedded Electron executable failing Seatbelt resource reads. The Host now launches a supported standalone Node executable; the final live Desktop journey passes the same real fixture under full enforcement. The [responsive review harness failure](attempts/responsive-review-harness-assumption/report.json) attempted a hidden narrow-layout tab at a wide viewport; the harness was corrected to use the visible file selector. The subsequent [Web responsive checks](attempts/responsive-files-negative/report.json) passed on the actual loaded CSS, before the final full receipt. Failed receipts have not been relabelled.

All journey-owned Chrome, Electron, HTTP/private Hosts, temporary fixture data, and the uniquely named synthetic credential were cleaned up. The final process exited zero; `cleanup.status` is `passed` with no errors. See [harness.md](harness.md) for reproduction and [README.md](README.md) for the owning completion and release boundaries.
