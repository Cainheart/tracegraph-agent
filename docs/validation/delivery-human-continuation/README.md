---
id: delivery-human-continuation
status: current
language: en
---

# Finite software Run: explicit human continuation

[中文](README.zh.md)

This verified FLOW-097 slice lets an explicit existing Session resume command continue the same interrupted ordinary software Run. It restores the original finite budget and immutable admission binding instead of rejecting all delivery recovery. It does not revive completed/failed Runs, automatically replay a Tool, or manufacture a Goal allowance. Final user acceptance and complete software quality remain separate.

## Current boundary

The canonical `run.created` binds a digest of the trusted canonical workspace root, its kind/capabilities and the admitted model configuration/credential reference. Resume checks the same registered scope, current session authorization, Extension/Skill snapshot, exact delivery policy, settled model reservations and Action WAL before acquiring work. Alternate roots, aliases, wider workspace capabilities, changed policy/provider/model/key revision, lost reservations and unknown effects reject before any new provider request or file mutation. Historical delivery Runs without these verifiable facts remain unavailable. Goal-backed work must use its existing Goal controller; ordinary Session resume returns `goal_resume_required`.

Reconstruction keeps the same budget identity, token/time ceilings, cumulative charges, conservative elapsed time including downtime, known failure counters and review rounds. Pending patch approval receives a new ID/expiry and retains its exact base/patch hash fence; no file is written until explicit approval. Resume without a pending approval proceeds from a fresh model observation boundary. Exact command retries return the canonical receipt and do not dispatch again.

A previous validation receipt cannot certify newer source. A later canonical verified patch may explicitly invalidate older verification only when its full scope matches a verified WAL record and current source SHA values match the latest retained writes. Fresh successful validation and independent review remain mandatory. External file changes, missing checkpoints, unknown writes or unverified scope reject with zero new dispatch. The two multi-patch fixtures prove both fresh success and `delivery_verification_missing` when validation is omitted.

## Complete review evidence

The readonly reviewer receives a scoped immutable `outlive.delivery-requirements.v1` Artifact: the complete redacted initial task/context, all consumed public guidance, every canonical validation receipt reference, and approved Goal objective/done conditions when supplied by its trusted budget. The packet is bounded to 20 KiB and explicit contract counts. Oversized packets fail instead of truncating requirements. The reviewer must really read every byte through scoped `read_artifact` receipts and retain all pages in its exact final model Context Manifest: `kept`, positive included tokens, no truncation/masking/externalization. This proves access to supplied public evidence, not semantic understanding or paid-model quality.

Command-only output inventory remains a narrower existing boundary: review covers declared patch paths and actual command/test manifest scope, not every arbitrary generated file. Windows process-group quiescence and live paid-provider software quality are not established by these POSIX deterministic fixtures.

## Verified receipts

The [Core focused log](checks/core-focused.log) passed four files / 56 tests: 13 actual-process continuation scenarios, 12 budget/packet/window safety cases, 23 delivery-review cases and eight shared-budget cases. The [fresh proof export](checks/core-proof.log) reran the positive real-owner scenario after adding Artifact exports. Its owner was actually SIGKILLed and confirmed exited before a fresh Runtime resumed the same Run; one queued public guidance message was consumed before the first resumed model request. Real approval, disk patch, external Node build/test, readonly child and exact retry complete under the original 200,000-token / 15-minute limit. The controlled provider reports 1,000 input plus five output tokens per request: retained first charge 1,005; parent plus child total 5,025 across five requests. These are deterministic provider protocol units.

The [Host focused log](checks/host-focused.log) passed two files / nine tests. Five exercise actual listening HTTP start/resume/approval/retry, immutable saved connection recovery and changed model/policy/key rejection; four preserve existing recovery-policy coverage. The [API proof](api-proof/report.json) uses a durable pre-shutdown owned-profile copy and fresh composition, not a claimed SIGKILL. Its actual routes return 200, source SHA equals built SHA, and five controlled 15-token requests total 75. [Core and Host targeted builds](checks/core-build.log), [Host build](checks/host-build.log) and [Core typecheck](checks/core-types.log) passed.

The [independent verifier](verify-proof.mjs) reads canonical hash chains, exported real command/Context Artifacts, complete packet bytes, actual child terminal linkage, aggregate charges and HTTP receipts. [Its report](verification.json) passes 656 checks without invoking any model, command or Runtime. The [Core receipt](core-proof/report.json), [canonical facts](core-proof/events.json), [scoped Artifact bytes](core-proof/artifacts.json), [delivered file bytes](core-proof/delivered.json) and [API canonical facts](api-proof/events.json) remain reproducible evidence. Test-owned runtimes, real child processes and HTTP servers were cleaned by their passed test lifecycle; no default profile, real credential or paid provider was used.

The retained [fixture diagnosis](checks/fixture-diagnostics.json) distinguishes an invalid test-only `steer` kind and already-exited child cleanup from production failure. A later 10-token under-report fixture masked a short history item in its model window; the final positive fixture reports realistic nonzero context usage and keeps the strict first-request guidance oracle. Neither issue was resolved by extending deadlines. These scoped receipts do not replace the root's final whole-workspace and installed-client checks.
