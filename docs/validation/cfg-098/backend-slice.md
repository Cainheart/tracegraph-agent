# CFG-098 inheritance and settings history slice

Current source implements explicit request → persisted Session overrides → Profile-owned project defaults → global defaults. Legacy complete Session records retain their explicit choices. New partial request/settings contracts preserve omitted values; the Web/Desktop shared composer displays effective values while sending explicit overrides only. Profile history/restore uses the canonical Workbench journal with CAS and redacted snapshots. Restore creates a new revision and preserves current sections containing historical redactions; it does not restore credentials, consent or repository policy.

This is a slice, not completion of CFG-098 or the complete product plan. Project/Session history restore, client-specific inheritance, a complete setting provenance/lock editor, and generalized safe-idle restart remain outstanding. Native Windows, revised installed GUI acceptance and external user acceptance are not proven here. Root owns combined build, fixed Desktop acceptance, roadmap and the overall report.

Verified commands and raw outputs:

| Command | Result | Durable output |
|---|---|---|
| `pnpm --filter @tracegraph/host exec vitest run src/configuration-inheritance-history.test.ts --maxWorkers=1` | 5 passed; actual provider/key binding, global/project/Session precedence, stale CAS, canonical redaction/reopen, HTTP auth and replay denial | [host-new.log](checks/host-new.log) |
| Existing Host conversation/workbench suites | 26 passed in the combined run; combined command failed on the new fixture's missing Origin header, now corrected and independently rerun | [original combined failure](checks/host-focused.log) |
| `pnpm --filter @tracegraph/contracts test:unit` | 197 passed | [contracts-focused.log](checks/contracts-focused.log) |
| `pnpm --filter @tracegraph/sdk exec vitest run src/settings-history.test.ts src/index.test.ts --maxWorkers=1` | 55 passed | [sdk-focused.log](checks/sdk-focused.log) |
| `pnpm --filter @tracegraph/cli exec vitest run src/workbench-command.test.ts --maxWorkers=1` | 22 passed | [cli-focused.log](checks/cli-focused.log) |
| `pnpm --filter @tracegraph/workbench exec vitest run src/configuration-inheritance.test.tsx src/current-workbench.test.tsx src/live-client.test.ts --maxWorkers=1` | 97 passed | [workbench-focused.log](checks/workbench-focused.log) |
| Host / SDK / CLI / Workbench typecheck | All exit 0 | [Host](checks/host-types.log), [SDK](checks/sdk-types.log), [CLI](checks/cli-types.log), [Workbench](checks/workbench-types.log) |

All fixtures used owned temporary profiles and a local deterministic HTTP provider. No real keys, default profile changes, paid model requests, whole-monorepo build, or commits were made by this slice. Commands were run with process-scoped `env -u NODE_OPTIONS`.

Sources: [configuration contracts](../../../packages/contracts/src/settings-history.ts), [ConversationControl](../../../packages/host/src/conversation-control.ts), [settings history](../../../packages/host/src/settings-history.ts), [settings controller](../../../packages/host/src/workbench-control.ts), [real fixture](../../../packages/host/src/configuration-inheritance-history.test.ts), [composer inheritance test](../../../packages/workbench/src/configuration-inheritance.test.tsx), [paired decision](../../../.agents/notes/proposed/2026-10-05-cfg-098-inheritance-history.md).
