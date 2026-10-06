---
id: 2026-10-05-cli-interactive-workbench
title: Interactive CLI over the shared local workbench
status: implemented
owners: [cli, host]
created: 2026-10-05
last_reviewed: 2026-10-05
language: en
affects: [CLI-089, FLOW-097, HELP-106]
supersedes: []
---

# Interactive CLI over the shared local workbench

[中文](2026-10-05-cli-interactive-workbench.zh.md)

## Current and accepted target

The shared CLI now provides interactive conversation and slash commands in addition to authenticated named operations and JSON receipts. The terminal presentation uses the existing command parser, SDK public activity stream and Host controllers. There is no second business loop, event ledger, permission resolver or shell evaluator.

Explicit `outlive chat interactive` and `outlive chat` select this entrypoint. Named `chat start` and existing default `serve` remain compatible. Ordinary messages create or continue the selected shared Session. Input during an active Run enters its existing durable user-message mailbox; `/guide` is an explicit message to that Run, never approval. `/new` only changes the selected conversation. Project/session switches first validate server-known identities. Model, mode and effort changes use the shared Session options controller with CAS when a Session exists; they affect future admission. Opening history and the conversation returned by an explicit named command inherit their saved options. An owner replacement may reset volatile sequence numbers; canonical source-event IDs suppress duplicate display without losing new facts.

Slash operations use literal argv, quotes and backslash handling; `$()`, backticks and semicolons are data, never executed by a shell. `//` escapes a task starting with `/`. Commands which consume terminal stdin or attach raw terminal input must use the existing noninteractive CLI separately. Approval requires the existing exact revision/action identifiers. Display only typed public activities and terminal canonical outcomes; a model draft is never a successful delivery.

EOF, `/quit` and Ctrl+C close subscriptions and the client connection. They do not cancel a Run or stop the Host. `/stop` explicitly calls the canonical cancellation operation. JSONL is a presentation format, not a persistent event model; each activity retains its canonical source event and sequence.

## Acceptance and limits

Twelve focused tests verify literal task handling, scope selection without resume, current-vs-next task options, explicit mailbox guidance, exact approval forwarding, private-surface exclusion, owner sequence reset and exit without cancellation. A real process journey using an owned test Profile read six typed activities and a canonical completed Plan answer, then exited with code 0 while the same Host PID/nonce remained alive. Interactive terminal display does not prove model quality or native Windows behavior.

## Verified sources

- [Interactive entrypoint](../../../apps/cli/src/interactive-chat.ts), [focused tests](../../../apps/cli/src/interactive-chat.test.ts), and [CLI module](../../../docs/modules/11-CLI-与装配.md).
- [Actual process evidence](../../../docs/validation/product-workbench-2026-10-05/checks/cli-interactive-process-proof.json) and [user guide](../../../docs/user-guide/README.md#topic-cli).
