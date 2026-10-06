---
id: 2026-10-05-public-chat-stream
title: Public chat stream from recorded facts
status: proposed
language: en
owners: [contracts, workbench]
created: 2026-10-05
last_reviewed: 2026-10-05
affects: [packages/contracts, packages/workbench, apps/cli]
supersedes: []
---

# Agent Note: Public chat stream

## Problem and current state

The chat disclosure renders internal lifecycle/context rows and duplicates the current Run failure outside its turn. Earlier screenshots do not establish the newly requested visual acceptance.

## Proposal

Project explicit public plans and paired tool operations into an ordered, read-only stream. Group adjacent tools between public statements. Internal lifecycle and usage facts remain in diagnostics. Show turn-local safe error explanations; terminal success must never settle unknown child operations. Completed process defaults closed, with user disclosure state preserved on updates.

## Alternatives considered

Retaining the full timeline inside the chat disclosure was rejected by the user. Keep that timeline as an evidence inspector instead.

## Invariants and boundaries

Ledger remains authoritative. Only Runtime `public_plan` is commentary; no provider reasoning, raw arguments, output or generic summaries are promoted to commentary. Operations pair only by explicit identity. No disclosure triggers execution. No new persisted event format. The projection is additive and shared by clients.

## Migration and rollback

Read existing events without rewriting them. Unknown historical event types remain inspectable in diagnostics. Reverting rendering leaves all recorded facts intact.

## Acceptance criteria

- [x] Public order, explicit pairing, unknown results and private-field exclusion
- [ ] Completed disclosure, historical errors, long messages and real change cards
- [ ] Current documentation and Web/Desktop visual evidence

## Risks and deferred work

Real provider/network failure causes require separate diagnosis. Installation, Windows, full settings and other roadmap gaps are not closed by this rendering change.

## Evidence

Shared projection, Workbench, SDK and CLI checks passed. [Incremental evidence](../../../docs/validation/codex-chat-2026-10-05/README.md). Native Desktop and full visual acceptance pending.

The explicit tiny text connection probe will disable DeepSeek thinking only for that probe, keeping its bounded output and normal task configuration intact. This follows [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/); it does not prove the historical timeout cause or repair the installed Host.
