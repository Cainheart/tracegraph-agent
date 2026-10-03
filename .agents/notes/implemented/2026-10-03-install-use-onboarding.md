---
id: 2026-10-03-install-use-onboarding
title: Actionable first use through the shared workbench
status: implemented
language: en
owners: [workbench, sdk, desktop]
created: 2026-10-03
last_reviewed: 2026-10-03
affects: [packages/workbench, packages/sdk, apps/desktop]
supersedes: []
---

# Agent Note: Install and use onboarding

## Current before this change

The shared workbench already saves model configuration and separately tests the saved configuration through typed Host methods. Settings retain safe credential metadata and a configuration-bound model test result. Ordinary chat needs a configured model but does not need a project, MCP server or LSP server. Current entry views expose missing-model and service terminology without guiding a new installation through these operations.

## Accepted target

Use the same shared UI for a first-use flow: select a real provider/model, save a write-only credential when needed, explicitly request a bounded connection test, then select/add a project or continue with plain chat. Saving configuration never implies a successful connection test. No automatic provider request is made by opening the app or changing a field.

Derive setup readiness from the existing safe model/settings/capability projections. UI step and drafts are ephemeral; do not add an onboarding flag, credential store, event schema or privileged renderer method. Existing configured users retain their conversation canvas. Optional tools are independently unavailable when absent and never gate model setup or plain chat.

Normal entry copy offers connect-model, choose-project and installation-repair actions. Exact transport/configuration facts remain available in diagnostics. Keep a conversation-first canvas, one current public statement and one actual operation row; expanded details never reveal private reasoning or trigger replay.

## Authority and recovery

Secrets are accepted only as write-only input to configureModel. Never read or log an existing key. Honor credential source and writable metadata, configuration revisions, real capabilities, read-only replay and permission ceilings. Desktop lifecycle stays in Main and existing fixed start/reconnect seams; the renderer does not spawn services or accept generic shell/file authority. A failed save preserves a draft, a failed test is explicitly failed, and cancellation/retry is user-triggered and bounded.

## Verification and completion

- [x] A fresh isolated profile saves model configuration and performs an explicit real bounded test through built Web/Desktop transport.
- [x] Missing/failed/locked credential states show a useful action and never a fabricated ready state.
- [x] Project selection/create/native selection uses actual APIs; plain chat works without MCP/LSP or a project.
- [x] First-use, configured, loading and repair states remain usable at 1024, 1280 and 1440 widths.
- [x] Existing chat/approval/review behavior and UI privacy/scroll/keyboard invariants pass regression tests.
- [x] Current documentation and evidence distinguish local simulated validation from independent-user acceptance and signed distribution.

## Implemented behavior and evidence

`SetupFlow` derives ephemeral setup from safe configuration, source and capability projections. Save and the explicit 16-token test remain separate; a real 401 cannot advance; a cancelled native selection keeps the project step. Configured users retain the conversation. No project/MCP/LSP prerequisite blocks plain chat. Environment-owned credentials stay read-only, failed drafts survive, and diagnostics never display a key.

Shared settings put lifecycle commands, profile/CLI and exact protocol facts inside installation diagnostics. Normal actions connect a model, repair a connection and explicitly apply a restart. Restart acceptance is not completion: reconnect and a fresh cleared `pending_restart` are required; busy refusal never cancels tasks. The default activity is one public statement plus one paired actual operation with details collapsed. No permanent Local badge or empty queue is shown. Approval preserves the conversation and review opens explicitly. Media UI consumes capability-gated typed operations and canonical tool/Artifact facts, retains unknown accepted command identity for explicit inspection, and previews/downloads SDK-verified scoped bytes.

- Workbench: 28 files / 209 unit tests and typecheck passed. Coverage includes read-only credentials, failed save, native cancellation, failed test, unavailable settings, restart acceptance versus application, Replay/IME/scroll and media acceptance boundaries.
- [Latest real Web journey](../../../docs/validation/install-use-workbench/attempt007-final-web-with-approval/report.json): 66 actual screenshots / 22 states, each at 1440×900, 1280×800 and 1024×768; real Host/model/media HTTP, approval, file write and tests; independent verifier 694 checks passed.
- [DMG-installed Desktop journey](../../../docs/validation/install-use-workbench/attempt009-final-installed-dmg-desktop/report.json): 66 actual renderer screenshots, `/Users/cain/Applications/Outlive Agent.app`, bundled Node with minimal PATH, no source fallback or fake bridge. Explicit test → project → chat → PNG/SVG preview and actual Download → approval → review. Installed `bin/outlive` rereads the same Run/Action/test. Independent verifier 706 checks passed; installed inventory hashes are unchanged from start to finish and cleanup passed.
- Retained before/applied external bytes and SHA256, exact approval/Action/event, actual successful test receipt and independent CLI projection are in each `patch-proof.json`, `before-add.ts`, `applied-add.ts`, `cli-run-read.stdout.json` (the earlier Web report retains live-file hashes only).

Earlier negative attempts remain: local Web media wrongly triggered Memory model derivation (trusted-media Core fix); packaging removed TypeScript native runtime `lib.d.ts` (packaging fix, build ID `c72a0a30a897dab039db2275ddcb839ce4dc617fdb16da92968867e619c507f2`). Attempt004 was an incorrect inventory path assumption; attempt005 used a blob fetch blocked by the correct Desktop CSP and was replaced by actual Download clicks. Attempt008 missed its native observation marker and is not CmdQ success. No failed report is overwritten.

Participants are Agents in the maintainer workspace, with deterministic loopback model/image fixtures. This proves real transport/governance/output bytes, not real AI quality, signed public distribution or independent-user acceptance. [Separate installed native-quit acceptance](../../../docs/validation/install-use-workbench/attempt011-installed-native-quit/report.json) passed: actual CUA Cmd+Q exits Electron0, the same owner PID/boot nonce completes the held real Run, installed CLI rereads completed, and cleanup passes. Attempt010 was a fixture reload during initial loadFile; waiting for the actual `.app` mount fixes the harness without changing the product.

## Deferred

Provider account creation, remote OAuth, cloud billing and private model reasoning are outside this change. Package scope and legacy wire versions remain compatible. Native installation/bootstrap and branded assets are separately owned changes.
