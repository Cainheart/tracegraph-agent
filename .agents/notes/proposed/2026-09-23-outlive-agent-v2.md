---
id: 2026-09-23-outlive-agent-v2
title: Adopt Outlive Agent V2 as the proposed product and architecture direction
status: proposed
owners: [product, architecture]
created: 2026-09-23
last_reviewed: 2026-09-23
affects: [identity, runtime, memory, packages, clients, repository-governance]
supersedes: []
---

# Agent Note: Adopt Outlive Agent V2 as the proposed direction

[中文](2026-09-23-outlive-agent-v2.zh.md) · English

## Problem

TraceGraph already has useful evidence, replay, Memory, Web, CLI, and evaluation
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

Adopt [Outlive Agent V2](../../../docs/outlive-agent-v2.md) as the proposed
target architecture and **Outlive Agent** as the working product name, while
retaining **TraceGraph Engine** and the `@tracegraph/*` scope during migration.

The design centers on one promise: a work session should leave behind evidence,
reviewable memory, and reusable experience—not only an answer. Knowledge may
outlive a session; authority must be re-established in the present.

Implementation follows the machine-readable
[`roadmap.yaml`](../../../docs/outlive-agent-v2/roadmap.yaml), beginning with
baselines and architecture gates before physical package expansion.

## Alternatives considered

- Keep **TraceGraph Agent** as the product name: precise for the engine, but too
  narrow for the memory-and-experience product promise.
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

V2 is introduced incrementally behind current public behavior. Package names
and persisted formats remain compatible until an accepted Note defines a
versioned migration. The working product name can be rejected without renaming
the technical core or package scope.

## Acceptance criteria

- [ ] Review and accept/reject the product name, memory authority model,
      package-promotion gate, and Desktop shell choice.
- [ ] Complete P0 baselines and P1 architecture gates.
- [ ] Demonstrate recovery, cancellation, and a provenance-preserving Memory
      lifecycle from evidence through correction/export.
- [ ] Update current docs only as each verified vertical slice ships.

## Risks and open questions

- Final trademark/domain/package-name clearance for Outlive Agent is pending.
- Personal legacy export needs a threat model, privacy review, and explicit
  consent semantics before public positioning.
- Desktop technology remains a decision, not a locked implementation choice.

## Evidence

- Design set: [`docs/outlive-agent-v2.md`](../../../docs/outlive-agent-v2.md)
- Implementation: pending
- Tests: pending
- Verification: pending
