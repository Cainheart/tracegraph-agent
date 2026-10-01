---
id: 2026-10-01-mem-047-legacy-capsule-v1
title: Implement an integrity-checked, review-gated Legacy Capsule v1
status: implemented
owners: [memory-export, contracts, core]
created: 2026-10-01
last_reviewed: 2026-10-01
affects: [legacy-capsule-v1, memory-import-candidates]
supersedes: []
---

# Agent Note: Implement an integrity-checked, review-gated Legacy Capsule v1

## Problem

The V2 design describes user-curated Memory/Experience portability, but the repository has no executable Capsule format, integrity verifier, redaction boundary, quarantine review, or explicit import path. The V2 docs currently show both `manifest.json` and `manifest.yaml`; a v1 implementation needs one canonical wire format.

## Current state

- `packages/contracts/src/legacy-capsule.ts` defines bounded strict manifest, entry, quarantine, and accept contracts; `packages/contracts/src/memory-control.ts` defines the content-free imported-candidate command/event.
- `packages/core/src/domains/memory/legacy-capsule.ts` exposes deterministic build, offline verify, no-write preview, and explicit accept over a fixed relative-path file map. `MemoryControlService` remaps imported Memory to local owner/scope and writes external/untrusted candidates with consent/model use/export disabled.
- `packages/core/src/domains/memory/legacy-capsule.test.ts` covers redaction, checksums, unsupported versions, noncanonical JSONL, path traversal, selected rows, review diff/staleness, candidate-only Experience results, and idempotent Memory retry.
- Current module/API documentation is in `docs/modules/08-Memory-记忆子系统.md`, `packages/core/README.md`, and `packages/contracts/README.md`; the canonical format and V1 limits are recorded in `docs/outlive-agent-v2/04-memory-and-experience/README.md` and `05-legacy-governance.md`.
- MEM-044 provides an Experience Case contract, but no Experience persistence or review aggregate exists; imported Cases are returned as external candidate-only results and are not written.

## Decision

- Use the V1 directory format shown in Memory README section 10: `manifest.yaml`, `memories.jsonl`, `experiences.jsonl`, `policies/usage-consent.yaml`, `README.md`, and `SHA256SUMS`. This resolves the older JSON manifest sketch in the governance document; document the canonical V1 form there.
- Add bounded strict bundle contracts and Core build/verify/preview/accept operations in the existing packages. Do not create a physical package or accept arbitrary filesystem paths in domain APIs.
- Export only explicitly selected, locally exportable records. Redact known secrets and sensitive structured fields, never include credentials, approvals, policy grants, raw Run events, or raw artifacts. Keep source evidence as references.
- Verify exact relative paths, file/count/byte limits, schemas, manifest digests, and SHA256SUMS before parsing a bundle into an inert quarantine preview.
- Preview returns a deterministic review diff and confirmation digest without writing to canonical stores. Accept re-verifies the exact bundle and review digest, requires explicit item selection, and is the only operation that writes imported Memory candidates.
- Add an explicit MemoryControl import command that maps owner/scope locally, records external Capsule provenance, resets lifecycle to `candidate`, and forces untrusted source assessment with model use/export disabled. Imported claims never inherit trust, consent, active status, or permissions.
- Experience rows are retained as untrusted, candidate-only import results for a future Experience store; this task does not invent a second persistent Experience writer.

## Alternatives considered

- Keep the older `manifest.json` sketch: rejected because Memory README section 10 already specified `manifest.yaml`; v1 now has one canonical format.
- Create a physical `@tracegraph/capsule` package: rejected because no second independent consumer or hard isolation boundary is established.
- Persist imported Experience in a new ad hoc store: deferred because MEM-044 defines the Case contract/extractor but no Experience lifecycle aggregate or canonical store.

## Invariants and boundaries

- A checksum proves byte integrity, not authorship or factual trust. V1 has no signature verification.
- Importing or accepting a diff never activates a Memory or Experience and never enables recall.
- Every imported item has a new local identity and local owner/scope mapping; external owner, status, provenance, and policy are data only.
- Quarantine is non-canonical. No candidate/event side effect occurs before `accept`.
- Path traversal, links, duplicate/unknown files, unsupported versions, malformed JSONL/YAML, digest mismatch, over-limit bundles, and secret-bearing export material fail closed or are redacted according to the explicit report.
- Existing V1 Memory storage, Session/Run Ledger, and original Capsule bytes remain untouched.

## Deferred

Desktop/Web/CLI surfaces, ZIP/streaming transport, encryption, signature trust roots, raw evidence/artifact opt-in, revocation propagation, Experience persistence/review, automatic migration, and automatic activation are outside MEM-047.

## Acceptance criteria

- [x] Deterministic V1 bundle output has a canonical manifest, bounded entries, and independently verifiable SHA-256 checksums.
- [x] Export includes only explicitly selected eligible items, redacts sensitive material, and never emits credentials/approvals/raw source evidence.
- [x] Offline verify rejects tampering, malformed/unsupported manifests, unsafe file names, noncanonical JSONL, and limit violations.
- [x] Preview quarantines verified content, classifies new/duplicate/conflicting Memory rows, and returns a stable review diff digest without storage side effects.
- [x] Explicit accept requires matching bundle/diff digests and selected IDs; Memory imports are durable untrusted candidates and Experience imports remain candidate-only results.
- [x] Tests cover tamper, secret redaction, path traversal, replay/idempotency, stale preview, duplicate/conflict diff, and unselected rows; current docs and roadmap match.

## Migration and rollback

No existing data is migrated. The directory format is additive. Rollback removes the new format/service path and the explicit MemoryControl import action; it does not alter existing Memory records or canonical Run events.

## Risks and open questions

- Capsule IDs and source actor identifiers are portable metadata; export confirmation must explain that copies leave local deletion control.
- A redaction report must not reproduce the secret it found.
- A future Experience store must define how external evidence references are displayed and locally reviewed before these returned case candidates can be persisted.

## Evidence

- Design/current limits: `docs/outlive-agent-v2/04-memory-and-experience/05-legacy-governance.md`, section 10 of `docs/outlive-agent-v2/04-memory-and-experience/README.md`, and `docs/modules/08-Memory-记忆子系统.md` section 1.5.
- Implementation/contracts: `packages/contracts/src/legacy-capsule.ts`, `packages/contracts/src/memory-control.ts`, `packages/core/src/domains/memory/legacy-capsule.ts`, and `packages/core/src/domains/memory/memory-control.ts`.
- Tests: `packages/core/src/domains/memory/legacy-capsule.test.ts`; 14 focused Capsule/MemoryControl tests passed, all 419 Core unit tests and all 156 Contracts tests passed.
- Verification: Core/Contracts builds and Core typecheck passed; `pnpm test:engineering` (56 checks), docs consistency eval (10 checks), `verify:boundaries`, `verify:package-readmes`, `verify:v2-docs`, `verify:lockfile`, `graph:modules:check`, and `git diff --check` passed. Existing `_tmp_evals` outputs were restored byte-for-byte after the docs eval.
