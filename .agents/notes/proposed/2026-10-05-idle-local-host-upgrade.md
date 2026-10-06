---
id: idle-local-host-upgrade-2026-10-05
status: proposed
owner: HOST-087 / DIST-095
last_reviewed: 2026-10-05
language: en
---

# Atomic idle replacement of a local Host build

[中文](2026-10-05-idle-local-host-upgrade.zh.md)

## Scope and accepted requirement

The user authorized an install-and-use product. A verified installed build must be able to replace a compatible private owner at a safe idle point without asking the user to stop it through the CLI. Existing background work, stopped intent, approvals and unknown effects retain authority. This Note recorded the decision before lifecycle/protocol edits. The scoped source and isolated verification below are current; integrated installer acceptance is pending and the Note remains `proposed`.

## Decision

1. Main and bundled CLI use the shared native connection/ensure seam. A build mismatch invokes a fixed authenticated private `prepare-upgrade` operation with command identity, expected profile/owner nonce and target build identity. No renderer/model path, arbitrary RPC, PID kill or tool replay is accepted.
2. The old owner synchronously closes mutation and Run admission, pauses scheduler producers, then validates all existing mutation activity, workspace claims, durable Run/Goal/command facts, approvals, terminals/previews, browser sessions and native computer leases. Unknown, missing, corrupt, unbounded or unsupported state fails closed with a safe reason and preserves the old process. Busy rejection reopens admission and producer timers.
3. The canonical SessionEvent command journal records the prepared receipt before shutdown. A prepared receipt means admission is sealed, not that replacement succeeded. The native client waits for old leases/discovery to retire, checks explicit stop intent again, and starts only its verified bundled Node/worker path. Replacement success requires a fresh private authenticated owner with the same profile and requested build identity. No existing Run or write is resubmitted.
4. Client death, unknown preparation outcome, cleanup failure or an unrecognized old protocol never triggers a kill, guessed shutdown, mutation replay or stop-marker bypass. A safe idle owner without this protocol remains upgrade-required. Backward retrofitting code into an already running legacy owner is outside the safe mechanism.
5. GET/health is not an idle oracle. Replay connections cannot initiate upgrade. Source-only explicit build IDs do not gain production bundle authority; isolated tests may compose owners with explicit identities and real fixed worker paths.
6. Build hashes have no temporal ordering. A client already bound to a different build must not reverse a known replacement. Canonical source/target retirement records prohibit automatically returning to a retired source build; explicit downgrade requires a separate human operation. This prevents old windows/CLI installations from alternating owner builds.

7. A completed `models.capabilities.test` receipt is a closed read-only provider test, not an unknown project write. Its strict result and original `command_id` must validate; `status: unknown` and `usage_status: unknown` remain in the receipt without permanent write locks. Actual request/receipt-projection `pending` still blocks replacement. Private prepare requests are serialized lifecycle checks, excluded from business mutation counts; all other admitted commands remain active until the handler actually settles, even after socket abort.

## Verification and limits

Required negatives include active/queued Runs, outstanding approval/Goal/command/effect, scheduler race, concurrent mutation/start, active browser/desktop lease/resource, forged owner/profile, wrong bundle, replay, stop intent, failed cleanup and unsupported protocol. A real temporary-profile child-process oracle must show old/new PID and build changes, single owner, unchanged persisted configuration and Run facts, zero task/provider/write resubmission, and complete owned cleanup. Formal signing, Windows native acceptance and paid-provider quality remain separate gates.

## Implementation evidence

- [Current source and command verification](../../../docs/validation/idle-local-host-upgrade/README.md): five focused test files, 28 passing tests; real local provider, UDS handler and detached child-process fixtures. Host build and Host/Core typechecks exited 0. Historical failed attempts remain linked.
- [Private lifecycle/receipt controller](../../../packages/host/src/local-host-upgrade.ts), [owner and native transport](../../../packages/host/src/local-host.ts), [connection supervisor](../../../packages/host/src/local-connection-supervisor.ts), [HTTP handler lifetime](../../../packages/host/src/webserver/index.ts), [Memory producer barrier](../../../packages/core/src/domains/memory/memory-background-pipeline.ts).
- [Actual child-process oracle](../../../packages/host/src/local-host-upgrade-owner.e2e.test.ts) verifies concurrent first clients converge on one new PID/nonce/build, the same Profile/gateway, unchanged credential/settings bytes and full completed Run timeline. The task is requested once; every provider request precedes the canonical prepared event. Existing derivation may finish before preparation and is not mislabelled as replay.
- [Actual probe settlement](../../../packages/host/src/local-upgrade-model-probe.test.ts) rejects held network and receipt projection, then permits settled no-usage and aborted read-only results without resubmission. [Disconnected handler](../../../packages/host/src/local-upgrade-aborted-handler.test.ts) retains business admission until the original handler settles.

The process fixtures use hard-linked supported developer Node plus strict test runtime manifests and the actual fixed worker. They do not prove a vendor runtime/installer, Windows native behavior, signed upgrades, or arbitrary old binaries. Missing upgrade protocol requires explicit safe retirement through the old application's supported Stop Host action. Unknown cleanup/receipts, waiting Memory jobs, active browser/input/resource leases and bounds preserve the old owner; no work is cancelled to manufacture idle.
