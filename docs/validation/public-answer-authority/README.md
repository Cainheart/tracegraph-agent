# Public answer authority verification

[中文](README.zh.md)

This source-level Workbench correction gives durable task results precedence over volatile model answer candidates. The Runtime, SDK transport, event schema and stored history are unchanged. No provider request, native input or default user profile was used for this verification. Installed GUI acceptance after rebuilding remains separate.

## Verified behavior

Completed, historical and ready-for-review views render their durable response, including when a retained answer snapshot disagrees. Failed, cancelled, interrupted and manual-review states render the durable error instead of a previous success statement. A mounted progressive draft is replaced immediately on transition; it cannot continue animating to a false final answer.

If a completed, historical or ready-for-review projection has no outcome, the view now says only that the final response is unavailable and points to recorded activity. A canonical completion event with no verification facts cannot manufacture a claim that results were generated or verified, and a volatile success candidate cannot replace the missing outcome.

While running, only the current model call's explicitly public answer may appear, labelled **Answer draft — not verified**, with no formal copy or feedback controls. A matching canonical decision, invalid-output/failure/cancellation fact, or newer canonical model request invalidates the candidate. Thus a first finish candidate disappears while readonly delivery review, repair or verification continues. The next current call can still show public draft text. Surface cursor and ledger sequence use separate clocks; tests intentionally make the old cursor much larger than the new ledger sequence.

Hosts with no model-operation history retain labelled public streaming compatibility. When model history exists, an unbound candidate cannot borrow another call's authority. Failed/cancelled surface payloads and private thinking are excluded. This conservative display rule does not claim that any running draft passed validation.

## Evidence

- [Before fix](checks/before-fix.log): the 15 new regression cases failed against the previous component. Terminal cases displayed a conflicting success candidate; delivery review and failure candidates stayed visible; draft labelling was absent.
- [Final focused tests](checks/targeted-final.log): 3 files, 29 tests passed, covering 15 new authority cases plus existing public progress and UX journey tests.
- [Workbench types](checks/types-final.log): exit 0.
- [Locale tests](checks/locale-final.log): 1 file, 11 tests passed; Chinese draft wording distinguishes unverified content.
- [Translation registry gate](checks/i18n-final.log): 89 registered pairs, zero unregistered. The gate failed only on concurrent hash/structure drift in the parent-owned flow-team-delivery-review Note; this slice's two pairs are mechanically registered without a human-review claim. The parent owns refreshing that Note after its content freezes.

The mounted React test covers live draft → ongoing delivery review → durable failure → different durable completed answer without remounting. It verifies no feedback read for the draft/failure and exactly one read after canonical completion. SSR cases separately verify terminal priority, compatibility streaming, explicit model identity, approval states and private-reasoning filtering. These are controlled component fixtures, not proof of paid-model quality or installed native GUI behavior.

The independent UI audit found the missing-outcome copy issue after the original receipt above. [Before the follow-up fix](checks/missing-outcome-before-fix.log), all three new completed/historical/ready-for-review negative cases failed on the unsupported "Verified results" fallback. [After the fix](checks/missing-outcome-after-fix.log), two focused files / 28 tests passed, including each new case in both English and Chinese with a canonical-shaped completion event and no generated/verification evidence. [Workbench types](checks/missing-outcome-types.log) exited zero. No provider, build, installed application or native input was invoked for this follow-up.

## Sources and decision

[Component](../../../packages/workbench/src/components/WorkbenchStates.tsx), [authority tests](../../../packages/workbench/src/components/public-answer-authority.test.tsx), [existing chat tests](../../../packages/workbench/src/components/WorkbenchStates.test.tsx), [current module](../../modules/10-Web-工作台.md#73-回答与正在进行的回答), [paired Note](../../../.agents/notes/implemented/2026-10-05-public-answer-authority.md).
