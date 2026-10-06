# Scoped local Skill management

[中文](README.zh.md)

This CAP-103 slice implements one bounded local SKILL.md lifecycle through the shared Host, SDK, fixed Desktop bridge, CLI and Workbench. It does not complete the entire capability roadmap or certify the newest installed application. The controller/transport/UI source and disk evidence below are current; installed GUI and Windows acceptance remain separate.

## Use the actual surface

Open Settings → Skills and extensions → Manage local Skills. Global on this device is available without a project. Select a registered project to manage that project's override. Create a name and Markdown body, or explicitly choose a local SKILL.md. Validate, then Save Skill. Selection alone does not write a file, download a URL, execute helpers or contact a model. This slice imports one UTF-8 Markdown document up to 256 KiB; it does not import arbitrary package directories or scripts.

Existing entries expose source, version, original file SHA, scope-state revision, validation diagnostics and effective conflicts. Open an entry to edit it. Save uses its original SHA; enable/disable and remove/restore also bind the original scope-state SHA. A refusal preserves the draft. Read the current document explicitly before replacing an externally edited version; there is no automatic merge.

Remove from loaded Skills (keep file) is a recoverable tombstone. It retains the original local file; Restore Skill is explicit. Removing or disabling a project override allows an enabled global definition to be inherited. A removed Skill does not silently return after a body edit or service restart. Existing shared disabled_skills remains restrictive. Changes affect new tasks; an admitted task retains its frozen Skill definition.

Exact approval displays the scope, name, original hash and command ID. Approve/Reject sends that original intent with the matching approval ID. Unknown outcomes lock further writes and offer Inspect Skill command result; an observed file hash is not a completed receipt. Drafts and pending intents survive closing/reopening the page within the same client. Receipt lookup remains available through CLI after a process restart; no automatic mutation retry is added.

## Actual verification

The table is the original controller/transport/UI checkpoint. Later source corrections and installed observations retain their own scope and do not replace these recorded counts.

| Layer | Result | Evidence |
|---|---|---|
| Host disk/controller and built HTTP/SDK | 2 files, 13 tests passed | [host-final-tests.log](checks/host-final-tests.log) |
| Original Core scanner/runtime | 4 tests passed | [core-tests.log](checks/core-tests.log) |
| SDK integrity and locale | 2 files, 11 tests passed | [sdk-locale-final-tests.log](checks/sdk-locale-final-tests.log) |
| CLI shared commands | 28 tests passed, including 2 new Skills cases | [cli-tests.log](checks/cli-tests.log) |
| Skill UI and permission surface | 2 files, 17 tests passed, including 7 new Skill journeys | [ui-tests.log](checks/ui-tests.log) |
| Entire Workbench | 40 files, 314 tests passed | [workbench-all-tests.log](checks/workbench-all-tests.log) |
| Types | Core, Host, SDK, CLI and Workbench passed | [Core](checks/core-types.log), [Host](checks/host-types.log), [SDK](checks/sdk-types.log), [CLI](checks/cli-types.log), [Workbench](checks/ui-types.log) |
| Builds | Targeted Core, Host and SDK passed without clean | [Core](checks/core-build.log), [Host](checks/host-build.log), [SDK](checks/sdk-build.log) |

The built HTTP test starts an isolated private profile, uses real authenticated SDK routes, verifies literal disk bytes, denies unauthenticated and arbitrary-path requests, restarts the owner and rereads tombstones/receipts. A second test uses a deterministic loopback provider with no paid model request: it edits the Skill while a task is held, then proves load_skill uses the admitted old body and a later task sees the new catalog version/digest. This is integration evidence, not model quality or external-user acceptance.

The original scanner hardlink negative first failed: a valid private Markdown hardlink entered its registry. [Before-fix output](checks/core-hardlink-before-fix.log) is retained. The existing scanner now rejects multi-link targets and performs bounded UTF-8 reads with file/directory identity checks; the same negative passes. Initial HTTP fixture attempts used the wrong tool decision shape and double-released a response; [fixture failure](checks/http-fixture-invalid-tool-before-fix.log) and [cleanup correction](checks/http-fixture-double-release-before-fix.log) are retained, followed by the final passing run.

### Subsequent source corrections

The real HTTP fixture now supplies provider usage required by the finite default budget; missing usage still stops production work. The combined [Skill HTTP and visual-evidence regression](../product-workbench-2026-10-05/checks/host-nonbudget-isolated-final.log) passes two files/15 tests. The Skill fixture proves the original admitted body and a later edited body, with two counted requests and no unknown usage; it does not bypass the budget.

Skill templates use the selected language without rewriting imported or saved documents. Known result codes and built-in extension states have friendly labels while technical identifiers remain in diagnostics. A confirmed create/save receipt remains visible after selecting the saved document; opening a fresh draft clears it. [Receipt and locale-date regression](../product-workbench-2026-10-05/checks/skills-receipt-dates-ui-final.log) passes three files/20 tests. [Settings isolation and initial-state regression](../product-workbench-2026-10-05/checks/settings-focus-connection-ui-final.log) passes five files/32 tests: settings makes the underlying chat inert, contains disclosure/escaped focus and restores the untouched draft. These are source-level DOM fixtures; the final rebuilt package needs its own native observation.

The [first rebuilt macOS package observation](../product-workbench-2026-10-05/README.md) records actual Skill create/edit/remove/restore and shared CLI readback for its stated historical build ID. Subsequent UI/backend changes require a new package; those earlier observations are not a final-byte certificate.

## Safety and limits

Management receives scope/name/content, never a host import path or download URL. Global files belong to the selected profile's fixed skills directory; projects use registered .tracegraph/skills. The parser/loader remains the original SkillRegistry. Canonical SessionEvent records include content hashes, intent/policy digest, approval, dispatch and receipt; raw Markdown and private profile paths are absent from management events and receipts. Explicit local document reads return body. The existing Agent load_skill path may include the admitted Skill body in its authorized model context; management itself never sends it to a provider.

Skill allowed_tools cannot grant file, command, model or operating-system authority. Read-only/deny, exact ask approvals, selected immutable ceiling and project write coordination remain enforced. Symlinks, hardlinks, malformed UTF-8, oversized text, stale file/state hashes, same command ID used concurrently in different scopes, and state overflow are tested. The same ID binds one canonical intent and at most one dispatch.

Linux writes use a pinned parent FD path. macOS uses the kernel O_NOFOLLOW_ANY flag (probe required, no fallback), directory/target inode checks and file CAS. The actual last-open ancestor-symlink attack returns unknown, leaves the private marker unchanged and creates no SKILL.md, including no empty file. This is not an atomic openat/inode transaction: a same-user concurrent real-directory replacement remains conservatively unknown. Windows writes are explicitly unavailable until platform validation; this report contains no Windows native proof. Multi-file Skill packages, remote marketplace installation and automatic downloads remain outside this slice.

Legacy standalone SkillRegistry consumers retain their legacy default root. Shared-profile management explicitly uses the selected profile's fixed root; import old global Markdown explicitly if it belongs to a different legacy directory. It never copies arbitrary legacy/private files automatically.

## Equivalent CLI operations

`outlive skills list` defaults to global scope. Use `--project-id` for a registered project's scope. `read --name`, `validate --input-file`, `create/save/import/remove/restore/set-enabled --input-file` and `receipt <command-id>` use the same typed controller. Content JSON includes name, original expected_sha256 and, for scope-state changes, expected_state_sha256. Precise approval is part of the original command JSON. Unknown/awaiting approval returns exit 3; denied/conflict/failed or invalid validation returns nonzero; receipt inspection never submits another write.

## Related background entry

Desktop's tray provides Floating chat window and Always on top for the same already-loaded renderer. It can resize/restore that window; always-on-top is off by default and lasts for the app session. This does not create a second client or task. A second renderer and shortcut-based context attachment are not delivered by that presentation slice. See the [floating presentation Note](../../../.agents/notes/proposed/2026-10-05-app-105-floating-presentation.md).

[Current module](../../modules/17-Skill系统.md), [scoped implementation Note](../../../.agents/notes/implemented/2026-10-05-cap-103-skill-lifecycle.md).
