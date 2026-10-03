# Client terminology

English is canonical for UI keys. Chinese text translates presentation only. Stable technical identifiers stay verbatim in code, receipts, protocols, examples and search.

| English term | Simplified Chinese | Meaning / boundary |
| --- | --- | --- |
| Run | 运行 | One runtime execution; keep the identifier `run_id`. |
| Session | 会话 | Durable sequence of Runs; keep `session_id`. |
| Workspace | 工作区 | Authorized working scope; a path alone does not grant authority. |
| Project | 项目 | Registered project association, separate from Run and Session. |
| Tool | 工具 | Typed callable capability; names such as `read_file` remain unchanged. |
| Approval | 审批 | A policy decision authorizing a bounded action. |
| Receipt | 凭证 | Durable evidence of business outcome; process exit is insufficient. |
| Observation | 观察结果 | A model-visible fact linked to durable evidence. |
| Artifact | 制品 | Content-addressed output or evidence with provenance. |
| Memory | 记忆 | Governed retained knowledge, not automatically verified truth. |
| Experience | 经验 | Governed reusable experience with evidence and scope. |
| Episode | 情节 | Memory summary for a bounded Run episode. |
| Consolidation | 整合 | Cross-Run grouping that retains source lineage. |
| Candidate | 候选项 | Proposed memory awaiting admission or review. |
| Revoke | 撤销 | Exclude from use while preserving governance history. |
| Replay | 回放 | Rebuild projections without redispatching side effects. |
| Recovery | 恢复 | Resume after rechecking current authority and state. |
| Host | 本地主机 | Runtime owner behind the client protocol. |
| Preview | 演示预览 | Explicit demo data, never live runtime evidence. |
| Stale | 已过期 | Previously captured evidence requires refresh or review. |
| Draft translation | 翻译草稿 | Mechanically checked or generated text without human review. |

The catalog remains keyed by the existing English strings. New keys are added once under `packages/sdk/src/client/locale/catalog.ts`; English and Chinese key inventories are derived from the same object. Full TUI navigation, automatic translation of arbitrary model content, and human certification of historical translations are outside I18N-075.
