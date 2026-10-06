# FLOW/TEAM finite-budget delivery review: verified backend slice

[中文](README.zh.md)

This is a controlled software-delivery protocol receipt, not completion of FLOW-097, GOAL-099 or TEAM-100. The model is a deterministic local HTTP provider. Actual Node processes edit, build and test a temporary clamp library; separate readonly child Runs inspect actual source, identify an omitted reversed-bound requirement, and require repair. No paid model, default profile, Git commit, merge or push is used.

## Current behavior

This directory records a delivery-recovery slice under a finite budget policy. Its 200,000-token / 15-minute lease is configured explicitly by test fixtures for historical Run recovery; it is not the current production Host default. Ordinary Runs now have no aggregate token, elapsed-time or fixed-turn ceiling. Goals continue to use budgets explicitly set by the user. The finite-lease admission, pre-dispatch rejection and recovery behavior remain covered as compatibility evidence.

The internal turn threshold becomes `delivery.turn_checkpoint` under this trusted lease. It does not reset the no-progress guard, credentials, authority or charges. An applied patch requires a fresh successful `run_test` or `run_project_command` receipt before review. Two consecutive missing-verification finishes fail closed; the Runtime never chooses or runs a new command itself.

Only settled POSIX-quiescent nonzero verification receipts may enter a normal inspect/repair stage. Timeout, abort, output truncation, unknown write, policy rejection and model failure do not. The third known verification failure stops the Run. Repeating the same scoped command without new canonical inspection or a verified patch is rejected before dispatch. A fresh actual successful receipt resolves each earlier known failure for that command; unresolved failures cannot be hidden by a new patch or a prose finish. Windows, children and legacy embeddings keep their previous failure behavior.

The reviewer is a separate child Run/Session with an independent frozen model lease, Plan mode, readonly policy and readonly tools intersected with the parent's ceiling. A structured `review_result` is accepted only from its real terminal and exact parent terminal-id/hash receipt. Declared paths require actual successful canonical `read_file` receipts. Before/after bounded, policy-checked source hashes fence changes during review. Blocking findings become canonical Observations for the existing AgentLoop; failed, inconclusive, forged or cancelled review cannot claim successful delivery. Plan answers remain direct answers; approved execution plans admit the finite policy only after exact Todo revision approval. Delivery admissions persist suppression of hidden background extraction, including recovery after Plan approval.

## Actual evidence

The [current proof](controlled-known-failure-proof/proof.json), [canonical events](controlled-known-failure-proof/canonical-events.json), [delivered files](controlled-known-failure-proof/delivered/src/clamp.mjs), and [independent reader result](controlled-known-failure-proof/verification.json) show 15 real local HTTP requests, one parent plus two readonly reviewers, actual command receipts in order **pass → fail → pass**, blocked then passed review, and phase checkpoints at turns 3, 6 and 9 under the original lease. An independent external assertion also fails against the pre-repair built output. The final test exercises the reversed-range requirement against the rebuilt module.

The [read-only verifier](verify-proof.mjs) checks 692 facts, including event hash chains, exact child terminal receipts, scoped command Artifact bytes, actual nonzero stderr, repair/source hashes and all 15 reservations/settlements. It executes no process or model. Reproduce it with `node docs/validation/delivery-review/verify-proof.mjs`.

Checks run on this source:

- [Core final focused](checks/core-final-focused.log): six files / 70 tests; [Team compatibility](checks/core-team-final.log): two files / 18 tests. This includes 23 delivery cases, bounded-read growth, legacy Plan behavior, shared budget, unknown disk effect, cancellation, fake reviews, missing verification and no-progress continuity.
- [Goal focused](checks/goal-final-focused.log): 17 tests, including real unsupported Core adapter admission with zero dispatch and a failed scoped receipt, rather than `launch_unknown`.
- [Production Host admission](checks/host-production-admission-final2.log): typed Host unsupported admission and production-composed Runtime bound-adapter rejection; both preserve source bytes and release owned admission resources.
- [Fixture/recovery](checks/fixture-and-recovery-final.log): three files / 30 tests; old file-context Plan fixture now explicitly submits a plan, and cancellation readiness follows actual stdout flush.
- [Contracts](checks/contracts-focused.log): two files / six tests. [Core types](checks/core-types.log), [Host types](checks/host-types.log), and [boundaries](checks/boundaries.log) exited zero.

The earlier [61-test receipt](checks/core-focused.log) and [13-request proof](controlled-proof/proof.json) predate known-failure continuation. They are retained historical evidence. The root's first integrated parallel run retained seven failures, including five 5-second timeouts, the old Plan fixture and a stdout-readiness race. Focused serial checks above pass; a broader run is owned by the root. No timeout was widened to obtain these results. Initial local harness mistakes (invalid 20 ms timeout, wrong Plan status and wrong Host fixture address/binding assumptions) were corrected; their retained Host failure logs are not passing receipts.

## Scope and limits

This proves controlled Runtime behavior and external bytes, not the quality of a real coding/review model or test coverage. The reviewer required scope covers verified patch paths and successful command manifests (plus `test/run.mjs` for the legacy test tool). Arbitrary files created by scripts are **not** a complete changed-file inventory; command-only review must not be described as reviewing every generated file. Each required file is bounded to 64 KiB, 32 files, no sensitive paths or hardlinks, and admitted reads must be `allow`; unsupported evidence stops delivery. Hash checks reduce external-change races but are not an atomic filesystem snapshot against a same-user attacker.

This historical proof used a review packet containing the initial public task's first 4,000 characters and the latest ten completed verification-command IDs. That bounded provenance did not cover all later steering or Goal criteria. The subsequent [human-continuation slice](../delivery-human-continuation/README.md) replaces it with complete bounded public requirements and actual full-page/final-window guards; this older proof and its numbers remain unchanged. An independent peer inspected the final authority/known-failure guards and ran the same verifier with its optional report write removed: 692 checks passed with zero dispatch or file writes.

Ordinary delivery recovery requires a new explicit approved Run and retains spent/unknown facts; it does not invent a renewed budget. Unknown command effects retain their real bytes and are never automatically retried or rolled back. No native UI, Windows quiescence, paid quality, nonblocking Team scheduler, complete user-facing review controls or final user acceptance is asserted here. A successful software Run still leaves Goal acceptance to the user.
