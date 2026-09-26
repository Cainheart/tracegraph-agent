---
id: 2026-09-23-outlive-agent-v2
title: Adopt Outlive Agent V2 as the proposed product and architecture direction
status: proposed
owners: [product, architecture]
created: 2026-09-23
last_reviewed: 2026-09-26
affects: [identity, runtime, memory, packages, clients, repository-governance, quality]
supersedes: []
---

# Agent Note: Adopt Outlive Agent V2 as the proposed direction

[中文](2026-09-23-outlive-agent-v2.zh.md) · English

## Problem

TraceGraph already has useful evidence, replay, Memory, Web, CLI, and offline quality-checking
foundations, but the product story is dominated by tracing and the main runtime
has accumulated too many responsibilities. The repository also lacks one small
governance entrypoint for architecture decisions, reusable workflows, package
promotion, recorded-session regression, and future Desktop work.

## Current state

Current behavior remains defined by:

- [`README.md`](../../../README.md)
- [`docs/modules/`](../../../docs/modules/)
- the source and executable tests linked from each owning module.

The useful TraceGraph capability inventory, unresolved boundaries, and
migration rules are consolidated in the
[`TraceGraph → Outlive migration baseline`](../../../docs/outlive-agent-v2/10-tracegraph-to-outlive-migration/README.md).

## Proposal

Adopt **Outlive Agent** as the single canonical name for both the user-facing
product and the underlying Agent Runtime/technical core, and position it as a
full general-purpose Agent for varied real-world tasks; coding is an important
scenario, not the product boundary. **TraceGraph Agent** refers only to the
pre-migration project, current repository, and historical implementation. The
final package scope is `@outlive/*`; keep `@tracegraph/*` only for migration
compatibility until a separate, behavior-preserving migration is approved.
[Outlive Agent V2](../../../docs/outlive-agent-v2.md) remains the proposed target
architecture, and the maintainer confirms the naming clearance is complete.

The current product surfaces are limited to **Desktop, Web UI, and CLI**.
Standalone API, externally distributed SDK, and ACP are outside the current
product scope; internal protocol/client code exists only to serve those three
surfaces. LSP (Language Server Protocol) follows DSH's optional read-only code-
navigation shape: a shared `lsp` contract, a configured stdio provider, and a
model-facing `lsp` tool for definitions, references, implementations, and
hover. Deployments supply the language-server executable; DSH ships none.
TraceGraph's current diagnostics do not automatically enter the target.
CodeGraph is not a built-in Outlive Agent V2 capability, and the existing
implementation has no planned migration target.

Human multi-user Workspace/Memory sharing is outside V2 and deferred to a later
version for separate review. This does not remove internal Subagent/Agent Team
collaboration from the V2 runtime design.

The design centers on one promise: a work session should leave behind evidence,
reviewable memory, and reusable experience—not only an answer. Knowledge may
outlive a session; authority must be re-established in the present.

Implementation follows the machine-readable
[`roadmap.yaml`](../../../docs/outlive-agent-v2/roadmap.yaml), beginning with
baselines and architecture gates before physical package expansion.

Quality responsibilities are split deliberately: deterministic tests, CI/
architecture gates, performance benchmarks, and session snapshots stay local.
Model, retrieval, Memory/Experience, and task-quality evaluations are planned
for a future external Langfuse project; V2 does not create a repository-local
`evals/` suite. Langfuse availability or authorization must not block local
gates, and permissions, scope, revocation, and deletion invariants remain
provable by local deterministic tests.

## Alternatives considered

- Keep **TraceGraph Agent** as the product and technical-core name: rejected;
  retain it only as the pre-migration project and historical implementation name.
- **Time Agent** or **Time Memory Agent**: easily mistaken for scheduling and
  unnatural as a product name.
- **MEN/Man Agent**: meaning is opaque and introduces avoidable ambiguity.
- Immediately copy another project's directory/package count: fast visually,
  but would encode boundaries that have not yet stabilized in this codebase.

## Invariants and boundaries

- Current documentation remains authoritative until each V2 slice ships.
- Raw events/receipts remain distinct from derived Episode, Memory, and
  Experience projections.
- Memory never carries stale permission, credential, or approval authority.
- Package extraction follows stable seams and tests, not a target folder count.
- Desktop shares domain protocol and UI where safe, but renderer code receives
  no direct Node or credential authority.

## Migration and rollback

V2 is introduced incrementally behind current public behavior. Outlive Agent
names both the product and its underlying technical runtime. The final package
scope is `@outlive/*`; existing `@tracegraph/*` names and persisted formats
remain compatible until a separate versioned migration is accepted. TraceGraph
Agent remains a repository and migration history label, not a second
technical-core brand.

## Acceptance criteria

- [x] Adopt Outlive Agent as the canonical name for both the product and
      underlying Agent Runtime/technical core.
- [x] Limit product surfaces to Desktop, Web UI, and CLI; defer standalone API,
      external SDK, and ACP.
- [x] Set `@outlive/*` as the final package scope; the maintainer confirms name
      clearance is complete, while actual renaming remains a separate migration.
- [x] Defer human multi-user Workspace/Memory sharing beyond V2; distinguish it
      from internal Agent Team collaboration.
- [x] Use DSH's optional read-only LSP code-navigation seam (definitions,
      references, implementations, hover); ship no language server and do not
      automatically carry current diagnostics into the target. Exclude
      CodeGraph from built-in V2 capabilities and migration targets.
- [ ] Review the memory authority model, package-promotion gate, and Desktop
      shell choice.
- [ ] Complete P0 baselines and P1 architecture gates.
- [ ] Demonstrate recovery, cancellation, and a provenance-preserving Memory
      lifecycle from evidence through correction/export.
- [ ] Update current docs only as each verified vertical slice ships.

## Risks and open questions

- Human team sharing requires a separate post-V2 review of membership, shared
  scope, correction arbitration, revocation, and data isolation.
- Personal legacy export needs a threat model, privacy review, and explicit
  consent semantics before public positioning.
- Desktop technology remains a decision, not a locked implementation choice.

## Evidence

- Design set: [`docs/outlive-agent-v2.md`](../../../docs/outlive-agent-v2.md)
- Implementation: pending
- Tests: pending
- Verification: pending
