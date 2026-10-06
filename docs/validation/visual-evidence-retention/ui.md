---
id: visual-retention-workbench-ui
language: en
status: current
---

# Visual evidence retention: shared UI slice

[简体中文](ui.zh.md)

This is current source-level UI verification. The [retention controller evidence](README.md) remains a separate frozen checkpoint; these results do not certify the latest installed native application or Windows behavior. No paid provider call, image generation or native input was used by these UI tests.

## Use the real controls

Settings → Memory and privacy → Screenshots and visual evidence reads the six typed methods: getVisualRetentionSettings, updateVisualRetentionSettings, listVisualEvidence, pinVisualEvidence, cleanupVisualEvidence and getVisualEvidenceCommandReceipt. Availability comes from visual.retention.read/write and visual.evidence.read/pin/cleanup/reconcile. A callback alone is not availability. Offline, Replay, policy refusal, missing component, load failure and empty inventory are distinct states.

Retention defaults to 30 days and can be 1–365 days. Background periodic cleanup is configurable; opening this page makes only reads and never initiates deletion. Saving values binds the loaded revision; CAS refusal retains the edited draft across a fresh read so the user can explicitly retry against the new revision. An exact evidence ID/revision is required to pin or unpin; the 500-pin limit remains backend enforced.

Project and optional task filters bind the cleanup request. Review expired screenshots previews only loaded, retained, unpinned, expired records. Confirmation sends one bounded batch of 50; the controller rechecks scope, expiry and pin status and may inspect other registered records in that same scope. It deletes only proven screenshot copies. Messages, Ledger facts, generated media and unregistered legacy images are retained. An empty list never produces a cleanup-success claim, and a completed receipt with zero deletions explicitly reports no deletion.

Lost-response or uncertain cleanup preserves the original command and locks further writes. Reopening this page with the same client retains the pending ID. Inspect original screenshot command is read-only, verifies the command/operation and never redispatches. Observed bytes are not a completed receipt; a completed command whose cleanup result is unknown remains locked. Failed or confirmed pre-dispatch/CAS rejection stays distinct from uncertainty. Raw private addresses are not displayed.

## Verification

| Check | Actual result | Raw evidence |
|---|---|---|
| Retention controls + Help + integration surface | 3 files, 29 tests passed | [targeted-final.log](ui-checks/targeted-final.log) |
| Entire Workbench | 41 files, 323 tests passed | [workbench-all-tests.log](ui-checks/workbench-all-tests.log) |
| Shared locale | 10 tests passed | [locale-tests.log](ui-checks/locale-tests.log) |
| Types | Workbench and SDK passed | [Workbench](ui-checks/types-final.log), [SDK](ui-checks/sdk-types.log) |

The seven new retention UI journeys cover read-only opening/default values, exact pin commands without pretending metadata is image pixels, scoped preview and zero-deletion receipt, unknown cleanup after remount without repeat, load failure vs empty inventory, policy/offline stale controls, and a refused CAS draft explicitly saved after refreshing its revision. Help only navigates to the matching settings category and never calls a model/controller action. Known built-in extension labels are friendly names, while diagnostic package IDs, enablement and reload calls keep exact trusted identifiers; unknown extension names are unchanged.

The initial fixture type error used a void reload response rather than the strict ExtensionStatus return. [Before-fix type output](ui-checks/types-fixture-before-fix.log) is retained; final fixtures return the actual typed receipt. Older [initial retention test output](ui-checks/tests.log) is not substituted for final counts. No UI test is labeled as real OS pixels or independent user acceptance. Final bundled build/native observation belongs to the parent release work.

## Guide and scope

[In-app Help](../../../packages/workbench/src/components/WorkbenchHelp.tsx) and the [user guide](../../user-guide/README.md#topic-visual) describe these controls and their limits in English/Chinese. The Skills Help topic now describes the verified [bounded single-file lifecycle](../skill-management/README.md); floating chat uses the same loaded window and Always on top is off by default for the app session. Browser/Computer provenance, old-image retention and same-UID unlink-window limitations remain those of the controller evidence, not stronger UI guarantees.
