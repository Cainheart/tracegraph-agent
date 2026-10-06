---
id: 2026-10-05-dev-readonly-preview
title: Persistent preview with a read-only source and private writable cache
status: proposed
owners: [host, contracts]
created: 2026-10-05
last_reviewed: 2026-10-05
affects: [DEV-091]
supersedes: []
---

# Persistent preview with a read-only source and private writable cache

[中文](2026-10-05-dev-readonly-preview.zh.md)

## Decision

The authorized development-workbench correction separates an owned preview from interactive terminal authority. `preview.start` always enforces a read-only source sandbox, even when the selected Host permission is full access. It grants only a fixed private per-preview cache/temp directory and loopback service networking. The registered project's read capability and current project read policy remain required. No client may supply a cache path, sandbox profile or source write grant. A backend that cannot enforce this boundary fails closed with an actionable capability reason.

Use the existing workspace coordinator with a read-only preview lease. A persistent preview therefore does not block a later source-writing Run. The owned process still stops only through explicit stop or Host shutdown; closing a view detaches. The interactive terminal keeps its existing exclusive writer lease. An externally registered service is marked unmanaged: observing its health does not restrict its process or guarantee a read-only source.

Private cache paths never enter public snapshots or receipts. Add optional source-access/cache-writable metadata to the existing preview snapshot so older snapshots remain parseable. Existing process ownership and canonical command receipts stay authoritative. Resource shutdown must attempt every owned resource even when one cleanup is unknown, aggregate failures and retain uncertain leases rather than reporting all work stopped.

## Boundaries and recovery

Preview dependencies must already exist. Tools that insist on writing into the source tree fail visibly; this slice does not silently relocate an arbitrary build system, install dependencies or widen the sandbox. The cache grant is a separate trusted directory; preview code can write there but cannot read the rest of the private profile. Full native enforcement is currently available only on the verified platform. Registered external services and adversarial process escape are outside this guarantee. Cache retention and quotas are deferred.

Restarting the Host does not automatically relaunch prior preview commands. Safe metadata is retained with a stopped/interrupted state. Unknown cleanup cannot release the affected resource's lease. No task or write is automatically resubmitted.

## Verification

Use a real persistent HTTP process to prove source writes are denied, private cache writes succeed, private profile reads fail and a later same-workspace Run obtains its writer lease without queuing. Test read-only and full-access selected presets, backend-unavailable and project read-policy denial, external-service independence, actual process-group closure and attempt-all shutdown after a cleanup failure. Preserve the pre-fix negative evidence. This Note remains proposed until focused source, tests and current documentation agree; it does not imply final installation or Windows native acceptance.

## Current evidence

[Current source and raw verification](../../../docs/validation/dev-readonly-preview/README.md) record the actual pre-fix source/private-profile write/read negative, the source-internal `..name` cache boundary negative, and the fixed process/Run/cleanup oracles. Host 3 files / 33 tests, Contracts 1 file / 4 tests, targeted Host build/typecheck passed. A real admitted Run committed its source patch while the same preview PID kept serving HTTP; one unknown process-group cleanup did not skip the other group. Modules 09/10 now describe the read-only lease. Joint build, final installed GUI and native Windows remain separate unverified gates. This proposed pair is mechanically registered as unreviewed.
