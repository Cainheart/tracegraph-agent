---
id: 2026-09-30-mem-042-context-provenance
title: Bind Context provenance and Run-scoped MemoryUse evidence
status: implemented
owners: [context, memory, contracts]
created: 2026-09-30
last_reviewed: 2026-09-30
affects: [context-manifest, memory-recall, memory-use, runtime-ledger]
supersedes: []
---

# Agent Note: Bind Context provenance and Run-scoped MemoryUse evidence

## Problem

MEM-040 and MEM-041 established V2 Memory record/lifecycle contracts while keeping G-21 Runtime on its V1 canonical JSONL store. G-21 retrieval attributed a chunk to its index hit/path/lines, but did not bind canonical Memory hits to an exact record version and evidence refs. Context manifests exposed visible items and token counts, but no digest of the exact rendered string passed to the model adapter. Retrieval was therefore easy to confuse with selection or use.

## Current state

- `MemoryManager` still reads admitted V1 records from `records.jsonl`; this task does not read the MEM-040 sidecar or MEM-041 lifecycle stream.
- Canonical index paths `memory/<encoded-memory-id>.md` are checked against the current admitted record. Their retrieval attribution carries V1 schema version, record ID/version/content hash, and bounded evidence-ref identities. Non-Memory indexed sources remain path/chunk/line attributions and are not assigned a fabricated Memory version.
- New Context builders set `rendered_context_digest` to SHA-256 of the exact `modelContext` string and store the same build's `token_estimate`. Older manifests remain parseable without the new digest.
- Core appends Run-scoped `memory.use_status` events and exports `replayMemoryUseStatus()`; it does not create a second journal or change V1 Memory persistence.

## Decision

Keep retrieval, selection, and adapter hand-off as separate facts in the existing canonical Run Event Ledger:

1. `memory.recalled` means the retrieval step produced hits. It does not mean a hit was sent to a model.
2. After Context construction and immediately before calling the model adapter, append a `dispatch_intent` with the manifest ID, exact rendered-context digest, token estimate, and the final selected canonical Memory items. Each item links to its retrieval attribution, exact Memory version/evidence refs, selected content digest, and included tokens.
3. Once `ModelAdapter.decide()` has been invoked, append `adapter_invoked` with the bounded adapter identity.
4. Append exactly one observed terminal state: `response`, `failed`, or `unknown`. The status payload contains no response body or Memory claim text.

The dispatch event is durable before crossing the Adapter boundary. A process interruption can leave a nonterminal dispatch record; callers must treat that as unresolved/unknown rather than successful use. `adapter_invoked` means Runtime called the adapter method with the request object; it does not prove remote provider acceptance or model-internal attention. `response` means Runtime received and validated an adapter response, not that any Memory caused its content.

`ContextManifest.rendered_context_digest` binds the stable reconstruction from included manifest items to the string passed as `ModelInput.context`. The existing token estimate remains the estimate for this same visible request. Provider-reported usage remains separate follow-up evidence and does not rewrite the manifest.

## Alternatives considered

- Treat `memory.recalled` as Memory use: rejected because retrieval may be filtered, omitted, or never reach a model request.
- Store MemoryUse facts in the Memory lifecycle stream: rejected because use belongs to one Run/request, not to the long-lived Memory aggregate.
- Persist provider request/response bodies in MemoryUse events: rejected because IDs, evidence refs, hashes, and bounded status are sufficient for this request-boundary contract and avoid copying claim text into append-only events.
- Switch G-21 Runtime to V2 lifecycle records: deferred; MEM-042 must not silently migrate or dual-write canonical stores.

## Invariants

- A canonical `memory/` retrieval path cannot parse without a matching Memory ID; the encoded source path must match that identity.
- The exact Memory record version/hash and evidence refs survive recall into Context and `dispatch_intent`.
- New Context manifests bind the rendered input digest to a token estimate; Runtime passes the reconstructed string unchanged.
- The only legal MemoryUse progression is `dispatch_intent -> adapter_invoked -> response|failed|unknown`, with `dispatch_intent -> unknown` allowed when interruption occurs before adapter invocation.
- All status events remain scoped by the enclosing Run, turn, model call, and Context manifest. Replay rejects missing intents, identity drift, duplicate intents, and illegal transitions.
- MemoryUse events do not contain claims, selected Context bodies, raw adapter responses, or free-form failure messages.
- Retrieval is not selection; selection is not proof of provider acceptance or model-internal use.
- G-21 V1 records, automatic-recall policy, existing SessionEvent history, and the separate MEM-041 aggregate stream are not migrated or rewritten.

## Migration and rollback

No data migration is needed. Old Context artifacts remain parseable because the rendered digest is optional for legacy reads; new writers always emit it. Existing V1 records are read as before and only canonical matching retrievals receive exact version references. Rollback can stop writing `memory.use_status` events and remove the additive Context metadata from future builds; already committed Run events and old manifests remain immutable. Do not erase or rewrite existing Run history as a rollback step.

## Acceptance

- [x] Canonical Memory retrieval carries exact record version, record content hash, and bounded evidence refs into `ContextManifest`.
- [x] The exact model-visible string is reconstructible from the manifest and SHA-256-bound to the same token estimate.
- [x] Run Ledger records dispatch intent before adapter invocation, adapter invocation, and response/failure/unknown outcomes as append-only events.
- [x] Replay validates MemoryUse identity and legal transitions; no Memory claim or adapter body is stored in these events.
- [x] Current Memory/Context/migration docs distinguish delivered Run-scoped recording from the unimplemented V2 store, UI, and Provider-acceptance claims.

## Risks and deferred questions

- A crash after dispatch intent but before a terminal event leaves an unresolved status. Recovery/UI may later project this as unknown; automatic retries must not silently transform it into a confirmed provider call.
- The current V1 store is append-only and its version model is not the future V2 canonical record store. A reviewed cutover will need an explicit compatibility and retention plan.
- MemoryUse currently records status in the Run stream but does not provide a user-facing management/inspection UI, deletion redaction workflow, or cross-process concurrency protocol.

## Evidence

- Implementation: `packages/contracts/src/{context,memory,memory-use,event}.ts`, `packages/context/src/context.ts`, `packages/core/src/domains/{memory/memory,memory/memory-use,runtime/agent-loop}.ts`.
- Focused tests: `packages/contracts/src/memory-use.test.ts`, Context builder digest assertions, and the G-21 runtime integration proving exact version/evidence propagation, pre-adapter dispatch persistence, success/failure/interruption outcomes, and replay validation.
- Verification: `pnpm typecheck` passed across all 18 buildable workspace projects and eval typecheck; `pnpm -r --if-present test:unit` passed all workspace unit tests (1,027 tests); `pnpm test:engineering` passed 48 Node checks and 8 Vitest checks; the implementation-consistency eval passed 6 tests; `pnpm verify:boundaries`, `pnpm verify:package-readmes`, `pnpm verify:invariants`, `pnpm verify:v2-docs`, `pnpm graph:modules:check`, `pnpm baseline:current:check`, and `git diff --check` passed after regenerating the module graph and baseline.
