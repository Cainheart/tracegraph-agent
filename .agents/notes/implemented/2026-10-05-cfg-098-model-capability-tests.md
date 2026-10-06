---
id: 2026-10-05-cfg-098-model-capability-tests
title: Explicit bounded model capability probes
status: implemented
language: en
owners: [host, model, workbench]
created: 2026-10-05
last_reviewed: 2026-10-05
affects: [packages/contracts, packages/core, packages/host, packages/sdk, packages/workbench, apps/desktop, apps/cli]
supersedes: []
---

# Agent Note: Explicit bounded model capability probes

[中文](2026-10-05-cfg-098-model-capability-tests.zh.md)

## Problem and accepted scope

The existing connection test submits one small text request. It cannot establish native function calling, image understanding or schema-constrained output. The user authorized explicit small tests for each capability; no paid user credentials will be used during implementation verification.

## Decision

A separate typed command selects a saved connection, exact model, configuration revision and one to four unique probe kinds. Every selected probe sends at most one bounded request, sequentially, only after explicit user confirmation. Requests contain generated fixtures and no project, conversation, memory or personal data. The existing text connection API remains compatible.

OpenAI Chat Completions probes use actual function tool calls, image content parts and strict JSON-schema response_format. Anthropic Messages uses native tool_use and base64 image blocks. Anthropic schema output is explicitly unavailable in this slice because the current adapter has not implemented its native schema-output format; it must not be emulated by prompt-only JSON. An OpenAI-compatible endpoint may reject the requested native format; that is a failed probe, not universal protocol support.

Passing requires the returned native structure and exact generated fixture answer, not HTTP 200 or self-reported model prose. Probe results contain safe classifications, elapsed time, provider-reported usage when valid, and bounded evidence labels. Raw provider output, secrets and image bytes are not persisted in receipts. Missing usage/cost is unknown. Image fixture success is narrow evidence, not a vision-quality benchmark or automatic image-input permission.

The controller captures the existing immutable configuration/credential lease before dispatch. Saved configurations may change while the probe or an admitted task runs; their original leases remain valid. A canonical command ID binds the full selected intent, with a durable receipt and read-only reconciliation. Lost responses/timeouts cannot trigger automatic repeat requests. Completed results remain inspectable even when a newer connection revision invalidates their relevance.

Only after canonical completion does the controller record the current-revision settings summary. Failure to persist that projection cannot fabricate a failed or successful provider outcome or repeat a request; the original completed receipt remains readable. Environment-managed connections clear summaries on owner reopen because external credentials/endpoints have no saved revision. This does not change Run revisions or leases. Mounted controls discard old-owner reads/results, reset removed model selections and mark same-revision environment history as historical unless its command matches the current owner's summary or an uninterrupted explicit test.

## Verification and boundaries

Controlled loopback HTTP fixtures verify native request/response structure, exact challenge checks, malformed/refusal/truncated/wrong answers, unsupported format zero dispatch, reported/missing usage, safe authentication/rate-limit/transport errors, idempotency and lease/CAS boundaries. SDK, fixed Desktop bridge, CLI and actual settings controls consume the same contract. These fixtures do not establish paid-provider quality or installation/native acceptance. This Note implements only the explicit test slice; the broader CFG-098/product scope remains separately tracked.

Evidence: [scoped report](../../../docs/validation/model-capability-tests/README.md), [native protocol tests](../../../packages/core/src/domains/model/model-capability-probe.test.ts), [actual shared composition HTTP](../../../packages/host/src/model-capability-http.test.ts), [canonical/projection ordering and failure](../../../packages/host/src/model-capability-control.test.ts), [mounted settings recovery tests](../../../packages/workbench/src/model-capability-tests.test.tsx), and [actual CLI HTTP](../../../apps/cli/src/model-capability-http.test.ts). Final focused checks include Core 58, Host 10, SDK/locale 15, Desktop 7, CLI 31, Workbench 38 and contract 2 tests; the report links exact raw outputs and retained failed attempts.

Primary protocol references: [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling), [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [vision](https://developers.openai.com/api/docs/guides/images-vision), [Anthropic tool definitions](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools), [vision](https://platform.claude.com/docs/en/build-with-claude/vision).

## Recovery and compatibility

No task is created and no tool is executed by a probe. It does not modify model declarations, permissions, active Run configuration or credentials. Unknown results are inspected by their original command ID; a user may choose a fresh test only after understanding that the previous request may have incurred provider usage. Prior connection-test DTOs remain unchanged.

## Acceptance

- [x] Bounded native protocol probes and negative fixture evidence.
- [x] Durable intent/receipt, no automatic retries and read-only reconciliation.
- [x] Shared settings, CLI, SDK and fixed Desktop transport integration.
- [x] Owning current documentation and remaining limitations match verification.
