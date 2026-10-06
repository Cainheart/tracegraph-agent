---
id: 2026-10-05-cap-103-remote-mcp
title: Bounded Streamable HTTP MCP and feature-local startup failures
status: proposed
language: en
owners: [mcp, host]
created: 2026-10-05
last_reviewed: 2026-10-05
affects: [CAP-103, packages/contracts, packages/mcp, packages/host]
supersedes: []
---

# Bounded Streamable HTTP MCP

[中文](2026-10-05-cap-103-remote-mcp.zh.md)

## Decision and current state

Current MCP config accepts only STDIO; a required server failure tears down healthy peers and Host startup. Add an explicit Streamable HTTP config variant with HTTPS (or loopback HTTP), credential-store bearer reference and no shell/env/process properties. Existing STDIO and legacy default remain compatible. Use the existing manager/catalog/tool seam, preserving conservative authority and unknown effects after dispatched network loss.

## Target and boundaries

Negotiate protocol and session headers; accept bounded JSON and SSE POST responses, tool-list notifications, timeout/cancellation and explicit session DELETE. Never redirect authenticated requests or automatically reinitialize/retry tool writes. Remote error bodies are not diagnostic secrets. The shared Host opts into feature-local startup isolation; generic manager default retains strict required-server behavior for existing consumers. A failed required feature is degraded, never falsely ready. OAuth authorization UI, full guided service management, standalone GET event subscription and proxy layering remain pending CAP-103 scope.

## Alternatives, migration and rollback

A second independent MCP stack would duplicate lifecycle/authority semantics. Add a transport variant instead; old events/config retain their schema version and STDIO meaning. Reverting the variant requires disabling remote entries before using older builds, without changing ledgers or credentials. Do not classify remote hints as trusted authorization.

## Acceptance

- [ ] Real loopback JSON/SSE server initialization, session headers and actual tool output.
- [ ] Credentials absent from persisted config/errors; redirects rejected.
- [ ] Timeout/disconnect/cancel after dispatch classified unknown without retries.
- [ ] Feature-local failures preserve healthy peers; strict legacy mode unchanged.
- [ ] Current module docs and pending OAuth/GUI/platform acceptance remain explicit.

Evidence: pending per-slice report.
