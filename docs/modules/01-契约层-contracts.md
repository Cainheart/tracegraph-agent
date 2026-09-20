# 模块 01：契约层（`packages/contracts`）

> 定位：整个系统的「法律层」。所有跨边界的数据形状都由这里定义，`core` 内部事实、Host/浏览器传输、进程内瞬时事件三层各有独立契约。
> 代码：`packages/contracts/src/`
> 最后核对：2026-09-19（对照源码逐文件核对）
> 实现状态：**已验证**（当前精确用例数以 `pnpm --filter @tracegraph/contracts test:unit` 为准）

---

## 1. 一句话职责

把"什么形状的数据可以在哪里出现"变成可执行、可校验、可拒绝的 Zod schema，使得越界数据在**进入系统的那一刻**就被拒绝，而不是在崩溃时被发现。

---

## 2. 文件清单

| 文件 | 量级 | 职责 |
|---|---|---|
| `common.ts` | — | 版本常量、基础标量、`SourceRef`、`ArtifactRef`（含 PNG/JPEG/PDF kind）、Artifact 出站三态 |
| `workspace.ts` | 85 行 | Workspace 种类、能力档案、安全项目元数据、三种预设能力 |
| `action.ts` | — | 20 个内置工具名清单、可扩展的有界 Tool 名、兼容单/批调用的 `Decision`、legacy/完整绑定 Action 与 Approval、`PatchPreview`、`Receipt`、`Observation` |
| `tool.ts` | — | G-05 有界 JSON Schema、完整 Host descriptor/模型白名单、标准失败类与 strict batch 审计载荷 |
| `action-wal.ts` | — | G-04 WAL phase/target/record 与 Recovery recipe/attempt v1 契约 |
| `commands.ts` | — | 浏览器→Host 请求、Host→Core 输入、`plan|execute`、Plan/Tool 审批与显式 rollback 命令 |
| `todo.ts` | — | G-09 Todo item/list/read-write、四种状态事件、Plan revision 与 strict browser request |
| `steering.ts` | — | G-14 有界用户输入、Host 绑定提交命令、队列/消费事件载荷与公开 inbox 投影 |
| `subagent.ts` | — | G-07 可信 profile/任务包、冻结 spec、父子 Run link、预算/结果、lifecycle payload、恢复与父侧投影 |
| `team.ts` | — | G-08 Team limits/roster/mailbox/task board、13 种 Event payload（含 durable sweep receipt）、5 个模型 Tool input、Host/SDK request/command/result |
| `attachment.ts` | — | G-18 PNG/JPEG/PDF、5 MiB/8 个上限、stage receipt、offload/inline、模型能力、PDF 抽取结果与附件投影 |
| `extension.ts` | — | G-17 API/config/status/command/error、Run snapshot 与 strict trusted-catalog 数据契约 |
| `telemetry.ts` | — | G-15 浏览器安全的 strict 只读状态：独立 schema v1、sink/state/error count/last error；结构上排除 Host-only 配置与 payload |
| `credentials.ts` | 约 100 行 | Credential backend/name、`${secret:NAME}`、迁移 outbox、安全元数据、模型配置写入/公开响应 |
| `sandbox.ts` | — | G-13 三档 mode、enforcement/platform、versioned report 与 lifecycle Event data |
| `permission.ts` | — | G-06 权限预设、Host/project 策略层、可解释决策、公开设置、审批 outcome/token 与 Event payload |
| `event.ts` | — | 100 种事件类型、可选 `session_id`、canonical 事件、提案、wire 事件 |
| `lsp.ts` | — | G-12 stdio LSP 配置、server status、位置/诊断、摘要与 unavailable 事件 payload |
| `session.ts` | — | Session JSONL v1 header/event-ref、root/all 查询、恢复响应与 v1/v2/v3/v4/v5 内部恢复 Artifact 契约 |
| `context.ts` | — | 上下文策略、G-02 surface node/spill/summary/step、预算、preflight `TokenEstimate` 与 `ContextManifest` |
| `token.ts` | — | G-03 的 section、preflight estimate、provider usage、observation 与持久校准格式 |
| `projection.ts` | — | `RunStatus`、`PendingPlan`、legacy/完整绑定 `PendingApproval`、Todo/inbox/subagents/attachments/可选 Team 与 permission/sandbox 快照的 `RunProjection` |
| `replay.ts` | — | G-23 的 Run-scoped snapshot request、canonical snapshot/hash envelope、Host replay authority response 与双向 projection diff |
| `graph.ts` | 140 行 | 图节点/边/快照/Delta 及其形状校验 |
| `memory.ts` | — | G-21 记忆范围/准入/持久记录、检索预算/命中/来源、remember/recall 与索引事件 payload |
| `live-event.ts` | 47 行 | 执行回放的展示事件（**不入账本**） |
| `model-stream.ts` | 49 行 | 模型公开输出画面（**进程内、独立游标**） |
| `index.ts` | — | 全量再导出上述契约模块 |
| `contracts.test.ts` | — | 契约、严格拒绝与版本兼容用例 |

---

## 3. 三层平面：本模块最重要的结构

契约不是"一套"，而是**三套并存、互不越界**：

| 平面 | 代表 schema | 是否入 JSONL 账本 | 携带 hash / 序号 | 用途 |
|---|---|---|---|---|
| **canonical（内部事实）** | `SessionEvent` | 是 | `sequence` + `event_hash` + `previous_event_hash` | 唯一事实源 |
| **wire（跨进程传输）** | `WireSessionEvent`、`ArtifactWireResponse` | 否 | 无 hash、无 `attempt`、无 `idempotency_key` | HTTP / SSE 出站 |
| **transient（进程内展示）** | `LivePublicActivity`、`ModelSurfaceEvent` | 否 | 各自独立游标 | 实时画面，可丢 |

这个分层是硬约束，代码注释把它写成了契约的一部分：

- `live-event.ts`：*"deliberately not a SessionEvent: it is not written to the JSONL ledger and it never carries a provider request/response body, token delta, hidden reasoning, credential, or raw tool output."*
- `model-stream.ts`：*"it has its own cursor, is process-local"*；`cursor` 字段注释明确 *"not a ledger sequence"*。

**推论**：UI 看到的一切都不是证据。证据只能从 canonical 事件重新推导（见模块 05）。

---

## 4. 版本常量

```3:4:packages/contracts/src/common.ts
export const SCHEMA_VERSION = "tracegraph.session-event.v1" as const;
export const PROJECTOR_VERSION = "tracegraph.projector.v8" as const;
```

`SCHEMA_VERSION` 被 `SessionEvent`、`WireSessionEvent`、`RunProjection`、`LivePublicActivity`、`ModelSurfaceEvent` 共同引用；`EventTypeSchema` 是 durable event type 的唯一枚举；`PROJECTOR_VERSION` 只出现在 `RunProjection`。G-01 的 Session identity / `interrupted` 使 projector 升到 v2，G-04 的粘性 `needs_manual_review` 升到 v3，G-09 的 execute 迁移、PendingPlan 与 Todo 投影升到 v4，G-14 的 durable input queue / consumption fact 升到 v5，G-07 的 durable `subagents` 父侧派生形状升到 v6，G-18 的 `attachments` 派生形状升到 v7，G-08 的可选 `team` 派生形状再升到当前 v8。这些只追加 Event 类型/派生形状，所以 canonical Event schema 仍保持 v1。G-21 曾把 Event 总数增至 68；G-07 追加 5 个 `subagent.*` 后为 73；G-18 再追加 3 个 `attachment.*` 后为 76；G-17 追加 `extension.error` 后为 77；G-08 追加 13 个 `team.*` 后为 90；G-10 追加 3 个 `skill.*`、G-11 追加 5 个 `mcp.*`、G-12 追加 2 个 `lsp.*` 后当前为 100。Telemetry 的只读健康状态使用独立 `TELEMETRY_STATUS_SCHEMA_VERSION = "tracegraph.telemetry-status.v1"`，检索 wire/index 使用独立 `tracegraph.retrieval.v1`，扩展 API 使用 `EXTENSION_API_VERSION = "tracegraph.extension.v1"`，LSP 配置使用 `LSP_CONFIG_VERSION = "tracegraph.lsp.v1"`，都不能与 canonical schema 混用。Session 文件仍使用 `SESSION_FORMAT_VERSION = 1`；G-08 的 Team 与 G-12 LSP 状态均由 Ledger/manager 边界重建，没有私有不可重放状态，因此内部 Run recovery 仍为 v5，Action WAL / Recovery Ledger 各自有磁盘格式 v1。

---

## 5. 关键 schema 速查

### 5.1 `common.ts` — 基础标量与工件

| 导出 | 要点 |
|---|---|
| `IdentifierSchema` | 非空、trim、**max 160** |
| `IsoDateTimeSchema` | `z.iso.datetime({ offset: true })`，**必须带时区偏移** |
| `Sha256Schema` | 正则 `^sha256:[a-f0-9]{64}$`，**带算法前缀** |
| `RelativePathSchema` | 拒绝绝对路径、`\` 开头、Windows 盘符、任何 `..` 段 |
| `TrustLevelSchema` | `trusted` / `untrusted` / `quarantined` |
| `ArtifactKindSchema` | 14 种：包含 G-02 `spilled_tool_output` / `context_source_archive`、内部恢复用 `recovery_state` 与 G-18 `image/png` / `image/jpeg` / `application/pdf` |
| `ArtifactWireResponseSchema` | 判别联合：`available`（带 range）/ `unavailable`（`not_found`/`out_of_scope`/`unsupported_mime`/`too_large`）/ `corrupt`（带 `expected_hash` 与可选 `actual_hash`） |

`RelativePathSchema` 值得单独记住：**路径安全是在契约层强制的**，不是靠调用方自觉。

### 5.2 `workspace.ts` — 能力即数据

`CapabilityProfileSchema` 是 7 个布尔：`index`、`read`、`search`、`run_command`、`preview_patch`、`commit_patch`、`test`。

三种预设：

| 常量 | index | read | search | run_command | preview_patch | commit_patch | test |
|---|---|---|---|---|---|---|---|
| `READONLY_LOCAL_CAPABILITIES` | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| `DISPOSABLE_FIXTURE_CAPABILITIES` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `MANAGED_LOCAL_CAPABILITIES` | 同上（`= DISPOSABLE_FIXTURE_CAPABILITIES`） | | | | | | |

`WorkspaceHandleSchema` 用 `superRefine` 强制：`workspace_kind === "readonly_local"` 时，`run_command` / `preview_patch` / `commit_patch` / `test` **必须为 false**。也就是说"只读工作区偷偷开写能力"在类型层就不成立。

`ProjectLocationSchema` 与 `ProjectSummarySchema` 承载一个明确的安全立场（注释原文）：

> *Clients may display this value, but no mutation contract accepts it as a capability or filesystem path.*

浏览器能看到 `display_path`，但**不能把它当作输入**去打开或提权。

### 5.3 `action.ts` — 动作闭环

```
ToolNameSchema      有界 160 字符命名空间语法；BUILTIN_TOOL_NAMES 精确列出当前 20 个内置工具（含 load_skill）
DecisionSchema      模型输出：kind ∈ {tool_call, finish}；tool_call 与 tool_calls(1..16) 二选一
ValidatedActionSchema  校验通过后的动作（带 project_id/run_id/workspace_handle_id/approval_id）
PatchPreviewSchema  preview_id / path / diff / base_hash / patch_hash / scope / expires_at
ApprovalGrantSchema legacy grant；ApprovalBoundGrantSchema 追加 token/action/policy digest 与 single_use
ReceiptSchema       传输状态与业务状态分离
ObservationSchema   观测：status / summary / facts / artifact_refs
```

两个必须注意的设计点：

1. **`Decision` 向后兼容且不含糊。** 旧单调用仍使用 `tool_call`；批调用使用 `tool_calls`，上限 16、`action_id` 必须唯一，二者不得同时出现。`finish` 必须有 `final_answer` 且不得携带任一工具字段。
2. **`Receipt` 区分 `transport_status` 与 `business_status`。** 二者各自是 `success|failure|unknown`。这直接支撑了"命令发出去了、进程跑了、但业务失败"这类可判定性——否则无法区分"网络失败"和"测试没通过"。
3. **新 `ask` 审批写入必须使用完整绑定联合。** `ApprovalBoundValidatedAction` 与 `ApprovalBoundGrant` 在 legacy 字段之外绑定 `token_id/action_digest/policy_digest/single_use`；旧账本仍可解析，但缺少这些绑定的旧 pending approval 不能直接执行。批准不是“允许某类动作”，而是“允许这个 project/run/action、哈希与 scope 的这一次动作”。policy `allow` 不签发 token 或制造 grant，但执行绑定仍携带 action/policy digest。

### 5.4 `tool.ts` — Host 契约与模型白名单

`BoundedJsonSchemaSchema` 只接受本地可理解的 JSON Schema 子集，拒绝远程引用和未知关键字；单份 schema 最多 64 KiB、深度 8、节点 256、对象属性 64，且工具 input/output 根必须是 object。

| 契约 | 字段/语义 |
|---|---|
| `ToolDescriptorSchema` | strict：`name/description/input_schema/output_schema/timeout_ms/concurrency_safe/side_effect/max_result_bytes`；timeout 10..300,000 ms，result 最多 8 MiB |
| `ModelToolSchema` | strict 白名单：只含 `name/description/input_schema`；`toModelToolSchema()` 显式重建，Host 策略字段不能因对象展开而泄漏 |
| `ToolFailureCodeSchema` | `invalid_arguments / timeout / output_contract_violation / denied / internal`；`business_code` 可另外保留领域原因 |
| `ToolBatchStartedDataSchema` | 请求数、有序 action ids、计划/上限并发度、parallel ids、逐项序列化原因 |
| `ToolBatchCompletedDataSchema` | 完成/失败数、实际峰值、有序结果及每项 duration/status/business code/可选 failure class；允许 started 后被 stop 而零执行 |

这些 batch payload 没有替换 `SessionEvent.data` 的通用 record 形状；它们是单独导出的 strict schema，由 Runtime 在 append 前解析，给新增 G-05 事件建立可执行边界。

### 5.5 `commands.ts` — 命令与提权防线

| 导出 | 关键点 |
|---|---|
| `OpenLocalProjectRequestSchema` | `command_id` + `access`（默认 `read_write`），`.strict()` |
| `RevealProjectRequestSchema` / `RemoveProjectRequestSchema` | wire 只有 `command_id`；项目 id 取自 Host 路由，浏览器不能提交本机路径 |
| `StartRunRequestSchema` | 浏览器→Host：有 `project_id`、`mode` 与可选的最多 8 个 opaque `attachment_upload_ids`；**没有 sandbox 字段或附件字节** |
| `StartChatRequestSchema` | `StartRunRequestSchema.omit({project_id, mode}).strict()`——**纯对话没有项目、没有路径、没有客户端可选执行模式**，由 Host 绑定私有空工作区并强制 execute；可带已按 chat scope staging 的 upload ids |
| `ApprovePlanRequest/CommandSchema` | wire 只有 `command_id + plan_event_id`；Host 才绑定 `project_id/run_id`，防止批准过期 revision 或跨 scope 请求 |
| `SubmitUserInputRequest/CommandSchema` | wire 只有 `command_id/input_id/kind/body`；Host/Core command 才绑定 `project_id/run_id/actor`，其中 `user` 用于浏览器 steering、`parent_agent` 只用于受信父 Runtime 向 direct child 投递；浏览器不能夹带 scope、actor 或服务端时间戳 |
| `StartRunInputSchema` | Host→Core：多出 `workspace: WorkspaceHandleSchema` |
| `RollbackActionRequestSchema` | 浏览器→Host 只有 `command_id` / `force`；不能自选 project 或 workspace |
| `RollbackActionInputSchema` | Host→Core 才加入 `project_id/run_id/action_id/workspace`，并强制 workspace project 匹配 |
| `RunCommandSchema` | 判别联合：`start_run` / `approve_plan` / `submit_user_input` / `approve` / `reject` / `stop` / `rollback_action` |

这一段是权限边界的核心：**浏览器永远构造不出 `WorkspaceHandle`**。`workspace` 只在 Host→Core 的 `StartRunInput` 里出现，注释写明 *"The client can select a server-known project, but cannot construct or elevate the server-owned WorkspaceHandle capability."*

`StartRunCommandSchema` 还有一条交叉校验：命令信封的 `command_id` 必须与 `input.command_id` 相等。

### 5.5a `attachment.ts` — 二阶段附件契约

| 导出 | 关键点 |
|---|---|
| `AttachmentMediaTypeSchema` | 只接受 `image/png` / `image/jpeg` / `application/pdf` |
| `AttachmentUploadRequestSchema` | wire metadata；project/chat 两个目标分支，正文必须另走 raw bytes |
| `AttachmentStageReceiptSchema` | accepted/rejected 判别联合；公开 receipt 只有 opaque upload id，不含 project/session scope |
| `AttachmentUploadIdsSchema` | 每 Run 最多 8 个，必须唯一 |
| `AttachmentRefSchema` | attachment id、MIME、1..5 MiB、SHA-256、source 与可选 PDF 文本 Artifact id |
| `AttachmentAdded/Rejected/OffloadedDataSchema` | 三种 durable Event 的 strict payload；PDF/delivery/extraction/locator 有交叉约束 |
| `ModelCapabilitiesSchema` / `ModelImageInputSchema` | Host-owned `image_input`；只允许 PNG/JPEG base64，解码后仍须落在 5 MiB 内 |
| `AttachmentListProjectionSchema` | G-18 在 v7 引入的 replay 派生列表；旧 Ledger 默认为空，当前随整体 Projection 使用 v8 |

附件 raw bytes 不属于任何 command/event JSON schema。StartRun/StartChat 只携带 opaque upload ids，Host/Core 再用内部 staging record 恢复 project/session scope；这避免 Plain Chat 隐藏 project id 被 receipt 回显，也避免 base64 膨胀进入 Ledger。

### 5.5b `team.ts` — G-08 Agent Team

| 导出 | 关键点 |
|---|---|
| `TeamProjectionSchema` | coordinator/root Run 上的可选投影；冻结 limits，聚合 roster/mailbox/task board 与各自 `last_sequence` |
| `TeamMemberSchema` / `TeamRosterSchema` | 每个 worker 必须绑定 canonical G-07 `SubagentRunLink`；`coordinator` 是 mailbox 保留地址、不得用作 member `subagent_id`；`active|lost` 与 join/heartbeat/lost 时间交叉校验 |
| `MailboxMessageSchema` | coordinator/member 地址、四种 kind、8,000 字符 payload；claim 时间与 recipient 必须原子自洽 |
| `TaskBoardItemSchema` | `open|claimed|done|blocked|cancelled`、owner、acceptance/evidence 与 optimistic positive `version` |
| `TEAM_EVENT_DATA_SCHEMAS` | 13 个 `team.*` payload 的 strict 映射；`member_lost.reopened_task_ids` 将失联与任务回退绑定为同一事实，`team.sweep_completed` 为顶层 sweep（含空结果）提供 durable receipt |
| `TeamReadInputSchema` | 只允许 `roster|mailbox|task_board` section、`offset`、默认 25/最多 100 的 `limit` 与可选 `expected_last_sequence`；用 snapshot pin 防止跨页混合新旧投影 |
| 五个 Team Tool input | 不包含 project/run/team/actor/from/owner authority；task mutation 必须按 operation 补齐 `expected_version`/证据/reason |
| Host/SDK request/command/result | browser request 只带 command id + 最小 input；scope、actor 与服务端时间由 Host/Core 绑定 |

Team task `done` 必须带 durable evidence；`claimed|done|blocked` 必须有 owner，`open|cancelled` 必须释放 owner。`TeamProjectionSchema` 还会确认 member 与父 `RunProjection.subagents` 中的 canonical link 一致，避免把任意 id 提升为 worker。

### 5.6 `event.ts` — 100 种事件

```
run.created          run.started          run.completed / run.failed / run.cancelled
context.built        context.budget_warning
context.compaction_started / context.compaction_completed
context.tool_output_spilled / context.summary_created / context.summary_failed / context.spill_refetched
model.request_started / model.usage_reported / model.usage_anomaly
model.decision / model.request_failed / model.output_invalid
action.rejected      action.stale         action.late_ignored
action.verified      action.reconciled    action.diverged / action.rollback_refused
permission.configured / policy.evaluated / policy.denied
plan.ready / plan.approved
todo.created / todo.updated / todo.completed / todo.blocked
user.input_queued / user.input_consumed
approval.requested / approval.granted / approval.denied / approval.expired
tool.started / tool.batch_started / tool.batch_completed / tool.completed / tool.failed / tool.unknown
sandbox.configured / sandbox.enforced / sandbox.disabled
patch.preview_created / patch.applied / patch.rolled_back
test.completed
graph.snapshot_created / graph.delta_created
memory.candidate_evaluated  memory.written  memory.recalled  retrieval.index_updated
subagent.started / subagent.message_sent / subagent.completed / subagent.failed / subagent.interrupted
attachment.added / attachment.rejected / attachment.offloaded
extension.error
team.created / team.member_joined / team.heartbeat / team.member_lost / team.sweep_completed
team.mailbox_delivered / team.mailbox_claimed
team.task_created / team.task_claimed / team.task_completed / team.task_blocked / team.task_cancelled / team.task_reopened
lsp.diagnostics_received / lsp.server_unavailable
artifact.stored
credentials.migrated
session.opened / session.closed / session.title_changed / session.tail_truncated
run.interrupted / run.resumed
```

`terminalEventTypes = ["run.completed", "run.failed", "run.cancelled"]`，并导出 `isTerminalEventType()` 供投影层判定终态。

`SessionEvent` 的身份/关联字段中，`session_id` 对 G-01 之前的旧账本保持可选；新 Runtime Run 均填入。其余可选关联字段：`turn_id`、`operation_id`、`parent_event_id`、`caused_by_event_id`、`context_manifest_ref`、`model_call_id`、`action_id`、`patch_event_id`、`graph_delta_id`、`test_receipt_id`。

`SessionEvent` 独有而 wire 事件没有的字段：`attempt`、`idempotency_key`、`previous_event_hash`、`event_hash`——**这四个正是"记账"与"重放"能力的物理载体**。

注释也点明了取舍：*"payload-specific contracts are linked by explicit IDs/artifact refs instead of placing large objects in the ledger."* 事件只放 ID 和工件引用，大对象走工件存储。

### 5.7 `context.ts` — 校验最密的文件

枚举：
- `ContextSectionSchema`（6）：`system` / `goal` / `history` / `tool` / `repo` / **`memory`**
- `ContextActionSchema`（6）：`pinned` / `kept` / `truncated` / `masked` / `externalized` / **`retrieved`**
- `ContextBudgetStatusSchema`（3）：`healthy` / `warning` / `compressed`
- `ContextAppliedCompactionStrategySchema`（6）：`none` / `tiered_history_checkpoint` / `bounded_history` / `bounded_tool_output` / `mixed` / **`strategy_chain`**

G-02 又增加了四组契约：

- `ContextCompactionPolicySchema`：`tool_output_pruner / spill / model_summary / tiered_checkpoint` 均可独立开关，目标 token 不得大于触发阈值；
- `ContextNodeSchema`：`raw / summary / spill_ref / checkpoint / retrieved`，带 content hash、parent 和 `superseded_by`；`retrieved` 只能属于 memory 并携带 G-21 provenance；
- `SpillRefSchema` 与 `ContextSummarySchema`：前者强制 locator 逐字等于 `artifact:<artifact_id>`，并绑定字节/预览；后者只允许 `facts/open_questions/refs[path+lines]`；
- `CompactionStepSchema`：策略、section、before/after、archive refs，summary step 还必须有 model call/prompt version。

`ContextManifestSchema` 的 `superRefine` 是整包最严格的一段，除预算与逐项约束外，还校验 preflight token 账：

1. `token_limit - reserved_output_tokens >= 0`
2. `input_tokens <= token_limit - reserved_output_tokens`
3. **`sum(items[].included_tokens) === input_tokens`**——账目必须自洽
4. 若有 `token_estimate`，其 `input_tokens === manifest.input_tokens`
5. `token_estimate.per_section[section]` 必须等于相同 section 的可见 item token 合计
6. 逐项：`included_tokens <= original_tokens`；`action === "masked"` 时 `included_tokens` 必须为 0
7. `compaction_steps` 每步必须严格减少、首尾连续、遵循 pruner→spill→summary→checkpoint 顺序，且各步减量之和完整解释 Manifest 总减量
8. archive ref 必须属于当前 project/run 且 kind 为 G-02 Context archive；node 的 parent/superseded 引用必须指向同 Manifest 内节点

这些约束保证的是**preflight 口径内部可审计、自洽**，不等于 provider 对完整 wire request 的逐 section 精确计费。任何一个 item、section 与总数对不上，整份 manifest 直接非法；调用结束后的 provider total 则由独立 Event 追加，不回写 Manifest。

### 5.8 `token.ts` — preflight 与 provider report 分账

- `TokenSectionSchema` 固定六类：`system / goal / history / tool / repo / memory`；`TokenSectionCountsSchema` 要求六类全部出现。
- `TokenEstimateSchema` 表示请求前的 estimator/confidence/input/output/cache 与 `per_section`，并强制 section 合计等于 input。
- `ModelUsageReportSchema` 表示 provider 返回后的 input/output/total，可选 cached input、reasoning output 与显式 `{amount,currency}`；`request_kind` 是 `initial / repair / summary`，`total_tokens` 必须等于 input + output。
- `TokenUsageObservationSchema` 把 report 与 preflight 的 `estimated_input_tokens`、`delta_ratio`、anomaly 和 calibration revision 绑定到同一个 `model_call_id`。
- `TokenCalibrationFileSchema` 独立版本为 1，按 provider/model 保存有界 samples，并拒绝重复键。

置信度在具体契约上是收窄的：`TokenEstimateConfidenceSchema` 只允许 `estimated / calibrated / exact`，`TokenUsageConfidenceSchema` 只允许 `provider_reported`；`TokenConfidenceSchema` 只是两者供通用展示代码使用的 union。当前实现不会为 preflight 发出 `exact`：可选 `TokenCounter` 只看到 section 文本，不掌握 provider-owned wire framing。当前 preflight 只有 `estimated` 或收到历史 usage 后的 `calibrated`，`exact` 为未来 canonical full-wire counter 预留。

### 5.9 `graph.ts` — 图的引用完整性

`GraphNodeSchema.kind`（3）：`file` / `directory` / `module`
`GraphEdgeSchema.kind`（2）：`static_import` / `static_export`，另有 `confidence`（`high`/`medium`/`low`）与 `resolution`（`resolved`/`partial`/`unknown`）
`GraphChangeSchema`（5）：`added` / `removed` / `changed` / `unknown` / `partial`

`GraphSnapshotSchema` 校验：节点 id 唯一、边 id 唯一、**每条边的 source/target 都必须存在于本快照节点集中**。
`validateDeltaShape()` 校验：`added` 只能有 `after`、`removed` 只能有 `before`、`changed` 两者都要有、`unknown`/`partial` 至少有一个；且 `before` 与 `after` 若同时存在，`id` 必须相同。

### 5.10 `memory.ts` — 记忆的准入与留证

| 导出 | 关键点 |
|---|---|
| `MemoryScopeSchema` | `kind ∈ {run, project, global}`；`project`/`run` 必须有 `project_id`，`run` 还必须有 `run_id` |
| `MemoryStatusSchema`（6） | `candidate` / `confirmed` / `rejected` / `quarantined` / `superseded` / `expired` |
| `MemoryRecordSchema` | `source_refs` **`.min(1)`**、`version` 正整数、`supersedes` 默认 `[]`、可选 `expires_at`；G-21 新写记录还绑定 content/candidate hash 与 admission 来源 |
| `MemoryCandidateSchema` | strict 候选；来源和 supersedes id 各自唯一，`source_refs` 可为空以便形成可审计的语义拒绝 |
| `MemoryAdmissionSchema` | `decision ∈ {confirmed, rejected, quarantined, expired, superseded}`（**5 值**） |
| `RetrievalReceiptSchema` | `retrieved_memory_ids` + `blocked_memory_ids` + `reasons: Record<memory_id, string>` |
| `MemoryRecallBudgetSchema` | `max_tokens` + `max_hits`；命中进入模型 Context 前的第二道预算边界 |
| `RetrievalSearchResponseSchema` | strict `tracegraph.retrieval.v1`；只回显 `query_hash`，命中含 rank/score/hash/来源路径与行号 |
| `RetrievalAttributionSchema` / `RetrievedMemoryHitSchema` | 注入文本与 provenance 分离；provenance 带 hit id、内容 hash、score、heading、行号和注入 token |
| `MemoryCandidateEvaluatedDataSchema` / `MemoryWrittenDataSchema` | 准入裁决与 canonical Memory 写入的 strict Event payload |
| `MemoryRecalledDataSchema` | completed/degraded、预算、注入/拦截命中、token 合计及有限 failure code |
| `RetrievalIndexUpdatedDataSchema` | 可重建索引的 source/hash/generation/chunk 计数事实 |
| `MemoryRememberResultSchema` / `MemoryRecallResultSchema` | admission/record 与 recall evidence/hits 的交叉一致性 |

两个值得记住的点：

- **`MemoryRecord.source_refs.min(1)`**：无来源的记忆在结构上就不合法。
- **`MemoryRecalledData` 同时记"注入了什么"和"拦下了什么、为什么"**，并强制逐 hit token 之和等于 `injected_tokens` 且不超过预算。
- `ContextManifest` 又要求 `memory + retrieved` item/node 的 `hit_id/content_hash` 对齐，`retrieval.injected_tokens` 与最终可见 item/node token 完全一致。检索结果因此不是一段无法解释的 prompt 拼接。

### 5.11 `action-wal.ts` — Patch 副作用与恢复尝试

- `ActionWalPhaseSchema`：`prepare / applied / committed / verified / aborted`。
- `ActionWalTargetSchema`：workspace-relative target、是否原先存在、before/after hash，以及既存目标必需的 opaque `backup_ref`；曾不存在的目标反而禁止伪造 backup。
- `ActionWalPrepare/RecordSchema`：绑定 project/run/action、进程内 handle id、稳定的 canonical root digest、workspace kind、patch hash 与唯一 target 列表；read-only workspace 不能产生 mutation WAL。`committed` 必须同时绑定 event/receipt id，`verified` 必须绑定 verification event id，`aborted` 必须有 reason。
- `RecoveryAttemptRecordSchema`：三种 recipe（`replay_missing_event / restore_from_backup / mark_diverged`）与 `started/succeeded/failed/escalated`；started 与 terminal 行共享 recovery id/attempt，终态必须有时间及其状态所需原因。

这些契约只描述可持久化事实，不代表任意 Tool 都自动获得恢复能力；当前生产者仅接入 `commit_patch`。

### 5.12 `session.ts` — durable Session 与内部恢复状态

- `SessionHeaderSchema`：`session_version/session_id/project_id/created_at/title?/parent_session_id?/run_ids[]`。
- `SessionEventReferenceSchema`：`entry_id/parent_entry_id?` 形成树，只引用 `{event_id, run_id, sequence}`；strict schema 从结构上禁止复制 Event 正文。
- `SessionListQuery/Response`：项目筛选、标题/ID 搜索、limit/cursor，以及默认 `roots` / 显式 `all` view；普通历史不会把带 `parent_session_id` 的 child Session 混成顶层对话。另有 rename/delete/resume 与 startup recovery report，报告分别列出 reconciled / aborted / diverged Action id。
- `RunRecoveryStateSchema` 是 v1/v2/v3/v4/v5 判别联合：当前 v5 在 `plan|execute`、推理强度、完整 `effective_policy` 与 orchestration `depth/limits/delegation?` 上，再冻结 G-17 extension API/generation/config digest/active extension 与 Tool 集。child 必须持久化与父 `subagent.started` 相同的冻结 delegation，root 则不能伪造 parent。v1/v2 的 `manual` 只为历史读取并映射为 execute，v3/v4 仍供已有 Run 兼容。`SessionPendingPatchRecoveryStateSchema` 另保存完整绑定的 pending approval 与精确 preview call。Todo/Plan revision 仍从 canonical Ledger 重放，不复制进 recovery Artifact。这些内容只用于内部 `recovery_state` Artifact，不进入 Session JSONL，也不应出现在 Wire Projection。

### 5.13 `projection.ts` — 视图

`RunStatusSchema`（10）新增 `awaiting_plan_approval`；`plan.ready` 进入该暂停态，不属于终态。
`RunProjectionSchema`：`schema_version` + `projector_version` 双 literal、可选 `session_id`（只为旧账本兼容）、`last_sequence`、`timeline: WireSessionEvent[]`、`todos`、`input_queue`、`subagents`、`pending_plan`、`pending_approval`、可选 `permission` / `sandbox_report`、`artifact_refs`、`outcome` / `failure_code`。`input_queue` 对旧账本默认 `{pending:[]}`；`subagents` 对旧账本默认空列表，并保留 active count、实际 limits、稳定父子 link、冻结 profile authority、消息/终态证据和有界结果。pending input 必须属于投影 Run；subagent 必须属于投影 parent Run/Session，child result Artifact 必须属于同 project/child Run。`PendingPlan` 绑定 `plan_event_id + todo_ids`；`PendingApprovalSchema` 仍接受 legacy shape 用于重放，但新 Runtime 写入 `BoundPendingApprovalSchema`，强制 tool/action/policy digest。

`timeline` 用的是 **wire** 事件而非 canonical——视图层拿不到 hash 链。

### 5.14 `live-event.ts` / `model-stream.ts` — 展示层

`LivePublicActivity`：`activity_id`、`source_event_id`、`source_event_type`、`sequence`、`kind`（`run`/`context`/`model`/`tool`）、`status`（`started`/`completed`/`failed`/`cancelled`/`info`）、`summary`（max 800）、可选的 `turn_id`/`model_call_id`/`operation_id`/`action_id`。**只带 `source_event_id` 引用，不带任何内容**。

`ModelSurfaceEvent`：`type ∈ {public_plan_snapshot, thinking_snapshot(废弃), answer_snapshot}`、`status ∈ {streaming, completed, failed, cancelled}`、`cursor`、`text`（max 8 000）。`thinking_snapshot` 的注释是明确的废弃标记：*"never render provider-private reasoning"*。

### 5.15 `credentials.ts` — 引用与公开元数据

凭据契约把“可持久化/可传输的指针”和“只能留在 Host 信任边界内的值”分开：

| Schema | 约束 |
|---|---|
| `CredentialBackendSchema` | `macos_keychain` / `private_file` / `environment` |
| `CredentialNameSchema` | 大写字母开头，仅大写字母、数字、下划线，最长 128 |
| `SecretReferenceSchema` | 只接受 `${secret:NAME}`；明文字符串不能作为模型配置凭据通过校验 |
| `SafeCredentialMetadataSchema` | 只有 `name/backend/writable/last_updated_at?`，结构上没有 value 字段 |
| `CredentialMigrationMarkerSchema` | 非敏感 durable outbox：UUID、safe metadata、secret reference、迁移时间；metadata name 必须与 reference 一致 |
| `ModelConfigUpdateRequestSchema` | `api_key` 是可选 write-only 输入，长度 8..2 000；`.strict()` 拒绝额外字段 |
| `PublicModelConfigResponseSchema` | 返回 `has_key` 与可选安全元数据，不存在 `api_key` 字段；`.strict()` 会拒绝意外回显 |

`PublicModelConfigResponseSchema` 还有交叉校验：`has_key === (credential !== undefined)`。因此“声称有 Key 却不给来源元数据”或“声称没有 Key 却附带凭据元数据”的响应都会失败。

### 5.16 `sandbox.ts` — 请求模式与实际 enforcement 分账

`SandboxModeSchema` 固定三档：`read-only / workspace-write / danger-full-access`；`SandboxEnforcementSchema` 是 `full / partial / none`，平台只接受 `darwin / linux / win32`。两组值刻意分开：请求了受限模式不代表平台已经执行了它。

`SandboxReportSchema` 是 strict、独立 `report_version: 1` 的 durable 事实，包含有界且唯一的 `mechanisms[]` 与 `unmet_constraints[]`。交叉约束禁止：

- `danger-full-access` 冒充任何 enforcement 或 active mechanism；
- `full` 没有 mechanism 或同时声称 unmet；
- `partial` 缺 active mechanism 或缺 unmet；
- restricted mode 的 `none` 不列出 unmet。

三个 lifecycle payload 也各自 strict：`sandbox.configured` 只记录 Host 请求的 mode/platform；`sandbox.enforced` 只能承载 `full/partial`；`sandbox.disabled` 只能承载 `none`，并区分显式 `danger-full-access` 与受限后端不可用。浏览器命令契约没有 sandbox 字段，所以选择权留在本机 composition root，而不是不可信客户端。

### 5.17 `permission.ts` — 权限预设、解释性策略与审批绑定

三种 built-in preset 是不可拆的组合；`custom` 只允许作为 Host 已解析快照的键，不是浏览器可提交选项：

| preset | sandbox mode | approval policy | 关键默认 |
|---|---|---|---|
| `read-only` | `read-only` | `never` | `allowed_tools` 不含 `commit_patch` |
| `workspace-write` | `workspace-write` | `on-write` | 默认 preset/ceiling，写入需要一次性批准 |
| `full-write` | `danger-full-access` | `never` | 不询问写入，但不增加 Workspace capability |

- `PolicyDocumentSchema` 由最多 256 条 strict rule 组成；`when` 可用 `tool / side_effect / path_glob / max_diff_lines / session_tags`，`then` 只有 `allow / deny / ask`，并强制非空 explanation。
- `EffectivePermissionPolicySchema` 必须保留 `host_rules` 与 `project_rules` 两层以及 `policy_digest`；跨层 `rule_id` 唯一，project rule 禁止 `allow`，防止恢复时因扁平化规则改变权限含义。
- `PolicyDecisionSchema` 记录 preset、digest、tool、side effect、`kind/source/explanation`，configured rule 还必须有 `matched_rule_id/priority`；可选 `action_digest` 把 ask/deny 与具体动作关联。
- `PermissionSettingsResponseSchema` 只公开 active preset、sandbox/approval pair、digest、ceiling、最多三个 available presets、source/locked/reason；`PermissionPresetUpdateRequestSchema` 只允许 `command_id + preset_key`，结构上排除 rules、path、token 与本机路径。
- `ApprovalTokenSchema` 绑定 `approval_id/project_id/run_id/action_id/action_digest/policy_digest/scope/issued_at/expires_at/single_use:true`，仅供最终 policy 为 `ask` 的一次性批准路径使用；policy `allow` 不制造 token。`ApprovalRequested/Granted/Denied/ExpiredDataSchema` 为新写入提供 strict payload；legacy action/pending approval 兼容只用于读取。

### 5.18 `todo.ts` — Plan revision 与结构化 Todo

- `TodoItemSchema` 固定 `todo_id/title/detail?/state/depends_on/evidence_event_ids/created_by`，依赖和证据 id 都唯一、有界，并拒绝自依赖。
- `TodoReadInputSchema` 用 `{offset:0..500=0, limit:1..100=25}` 做 item 分页；完整 Host Todo 投影仍由 `TodoListSchema` 表达。Core 为模型读取另设 512 KiB content / 640 KiB result envelope、4,000 UTF-8-byte excerpt 与完整页 Artifact，不靠一个无限大响应。
- `TodoWriteInputSchema` 只允许 `create|update`；create 必须有 title、必须从 pending 开始且不能伪造完成证据，update 必须至少改一个字段。
- `TodoWriteRequestSchema` 只包含 `command_id + input`，路由侧的 project/run 和 `updated_by:"user"` 由 Host 绑定。
- `TodoCompletedDataSchema` 在契约层要求模型完成时至少有一个证据 id；是否为同 Run、早于 mutation 且属于 eligible 独立成功执行事实，由 Core 在 live write 与 replay 共用的 fail-closed predicate 校验。用户勾选本身就是对该 Todo 的持久确认，不需伪造 Tool 事件，但 Todo Event 不能作为另一个模型完成的独立证据。`updated_by` 与 item 上不可变的 `created_by` 分开。
- `PlanReadyDataSchema` 保存唯一 Todo id 集与自洽 count；`PlanApprovedDataSchema` 绑定确切 `plan_event_id`、当时 Todo ids 与 `approved_by:"user"`。

### 5.19 `steering.ts` — 运行中输入与 inbox

- `UserInputKindSchema` 固定为 `message|cancel|approve_hint`；正文最多 8,000 字符，message/hint 不能为空，消费字段 `consumed_at + consumed_at_step` 必须成对出现，step 只允许 1..1,000,000。
- `SubmitUserInputRequestSchema` 是 Browser→Host 的 strict body，只接收 `command_id/input_id/kind/body`，仍不能夹带 actor；`SubmitUserInputCommandSchema` 才由可信 Host/Core 绑定 `project_id/run_id/actor`。actor 现为 `user|parent_agent`，后者仅供父 Runtime 向 direct child 的内部 mailbox 发送消息/取消。
- `UserInputQueuedDataSchema` / `UserInputConsumedDataSchema` 是 `SessionEvent.data` 通用 record 之外的 strict payload。queued fact 最多形成 100 条 pending queue；consumed fact 精确绑定 `input_id/kind/queued_event_id/consumed_at/at_step`。
- Runtime 在 queued fact 顶层写 `_internal_command_digest` 与 `_internal_input_digest`，分别保护 command-id 和 input-id 重用冲突；它们参与 canonical Event hash/replay，但 `toWireEvent()` 会删除全部顶层 `_internal_*`，浏览器拿不到 digest。
- `SubmitUserInputResultSchema` 用 `queued|duplicate` 表达新入队与幂等回放；新 queued 结果不能伪装成已经消费。`InputQueueProjectionSchema` 要求 pending id 唯一，且 `last_consumed` 不能同时仍在 pending。

### 5.20 `subagent.ts` — 可信委派，而不是模型自授权限

- `SpawnSubagentInputSchema` 只允许 `profile_name/task_packet/context_scope/budget?`；provider key、role prompt/hash、tool allowlist、depth 与父 scope 均不在模型输入中。
- `SubagentProfileSchema` 是 Host 注册表的可信配置；`SubagentSpecSchema` 是实际启动时冻结的 authority，包含 provider key、role prompt version/hash、effective tool allowlist、depth、context scope 与 step/token budget。
- `SubagentRunLinkSchema` 绑定 parent/child Run 与各自独立 Session；child 不得复用 parent id。started/message/terminal payload 都复用同一 link，结果还必须匹配 subagent/child Run。
- `SubagentUsageSchema` 汇总 child 全程 steps、input/output/total tokens、confidence 与 provider-reported costs；它不是单次 Context estimate。
- `SubagentFailedDataSchema` 区分 launch 与 execution：launch 失败没有伪造 child terminal proof；execution failure（含 `budget_exceeded`）必须携带 child terminal Event id/hash。completed/interrupted 也必须携带 proof。
- `SubagentOrchestrationRecoverySchema` 固化 depth/limits/delegation；默认 `max_parallel_subagents=2`、`max_depth=1`。`SubagentListProjectionSchema` 对 active count、唯一 child ids、并发上限与终态字段做交叉校验。

### 5.21 `telemetry.ts` — 只读健康状态，不是配置或事实账本

`TelemetryStatusSchema` 是 `.strict()` 的独立 wire schema：

| 字段 | 约束 |
|---|---|
| `schema_version` | 固定 `tracegraph.telemetry-status.v1` |
| `sink` | `noop | memory | otlp_http | custom` |
| `state` | `disabled | active | degraded` |
| `error_count` | 非负整数 |
| `last_error_at?` | 带时区的 ISO datetime |

`DEFAULT_TELEMETRY_STATUS` 固定为 `noop / disabled / 0`。该 schema 的价值也在于它**没有** endpoint、header、authorization/credential、配置 source path 或 pending payload 字段；Host seam 即使意外返回这些值，也会被 strict parse 拒绝。它只描述当前进程的 sink 健康快照，不是 `SessionEvent`、不进入 Run Projection，也不能作为恢复输入。具体 span/metric/log 与 sink 接口属于独立 `packages/telemetry`，避免把可丢失的观测旁路混入 canonical Contract。

---

## 6. 跨字段约束清单（本模块的核心价值）

只列"单字段类型检查抓不到"的规则：

| 位置 | 约束 |
|---|---|
| `WorkspaceHandleSchema` | `readonly_local` ⇒ 四个写能力必须为 false |
| `DecisionSchema` | `tool_call` 决策必须恰有单 `tool_call` 或 1..16 个 `tool_calls`，batch action id 唯一且禁止 `final_answer`；`finish` 必须有 `final_answer` 且禁止两种工具字段 |
| `ToolDescriptor/ModelTool` | Host descriptor 所有字段必填；模型投影只能出现 `name/description/input_schema`；JSON Schema strict 且有 byte/depth/node/property 上限 |
| `ToolBatchStarted/CompletedData` | count、并发度、action id 唯一/成员关系、序列化原因、结果顺序、失败数与 failure class/status 必须自洽；stop race 可形成零完成审计 |
| `StartRunCommandSchema` | 信封 `command_id` === `input.command_id` |
| `StartChatRequestSchema` | 由 `omit` 结构性移除 `project_id` / `mode`，且 `.strict()` |
| `ApprovePlanRequest/CommandSchema` | wire 不能夹带 project/run；Host command 必须绑定当前 `plan_event_id` |
| `SubmitUserInputRequest/CommandSchema` | wire 不能夹带 project/run/actor/timestamp；普通 Host 请求绑定 `actor:"user"`，只有受信父 Runtime 的 child mailbox 路径可绑定 `actor:"parent_agent"`；正文、队列和 step 都有硬上限 |
| `UserInputQueued/ConsumedData` | queued/consumed payload strict；消费时间与 step 合法并绑定 queued event；内部 command/input digest 只留 canonical 平面 |
| `InputQueueProjectionSchema` | pending input id 唯一、最多 100；最后已消费 input 不得仍 pending；pending `run_id` 必须匹配 RunProjection |
| `TelemetryStatusSchema` | 只接受固定独立版本、四种 sink、三种 state、非负错误数与可选 ISO 时间；`.strict()` 拒绝 endpoint/header/credential/path/payload 等 Host-only 字段 |
| `TodoItem/ListSchema` | id 唯一，自依赖/缺失依赖/闭环非法；`last_sequence` 非负；上限 500 |
| `TodoCreated/Updated/Completed/BlockedData` | created 只能 pending；进入 done/blocked 必须专用 Event；模型 done 在契约层必须带 evidence id，Core 再校验同 Run/先后顺序/eligible type；已有证据的 done 不能在保持 done 时清空；creator 与 updater 分账 |
| `PlanReady/ApprovedData` | todo ids 非空且唯一，count 与长度一致；approval 必须指向确切 Plan Event |
| `RollbackActionInputSchema` | Host 注入的 `workspace.project_id` 必须等于命令 `project_id`；wire request 不能携带二者 |
| `PermissionPreset/Snapshot/Option` | built-in key 必须与固定 sandbox/approval pair 一致；公开 available preset 不能超过 ceiling，browser update 不能提交 `custom` |
| `EffectivePermissionPolicySchema` | Host/project rule id 跨层唯一；project rules 只允许 ask/deny；层次必须持久保留，不能扁平化 |
| `PolicyDecisionSchema` | `configured-rule` 必须带 matched rule id 与 priority；其它 source 禁止伪造 rule metadata；action digest 若有必须符合 SHA-256 契约 |
| `ApprovalTokenSchema` | scope 非空且唯一、`expires_at > issued_at`、`single_use === true`，并完整绑定 approval/project/run/action/action/policy digest |
| `ApprovalBoundValidatedAction/Grant` | 新审批路径必须绑定 token/action/policy digest；grant 的时间、scope、base/patch hash 与一次性语义必须自洽 |
| `ActionWalTarget/RecordSchema` | existing target 必须有 backup；目标唯一；workspace 非 readonly；committed/verified/aborted phase 必须带相应证据字段 |
| `RecoveryAttemptRecordSchema` | started 不得有 finished_at；terminal 必须有 finished_at，failed/escalated 各要求 failure/escalation reason |
| `ContextPolicySchema` | `reserved_output_tokens < window_tokens`；`warning_ratio < compression_ratio` |
| `ContextManifestSchema` | item 合计、section 合计、`token_estimate.input_tokens` 与 manifest 总量一致；`masked` ⇒ 0；逐项 `included <= original` |
| `TokenEstimateSchema` | `sum(per_section) === input_tokens`；cached 是 input 子集 |
| `ModelUsageReportSchema` | `total === input + output`；cached/reasoning 分别是 input/output 子集；成本必须 amount + ISO-like 三字母大写币种成对出现 |
| `TokenCalibrationFileSchema` | provider/model 唯一；版本/revision/sample 比例有界 |
| `GraphSnapshotSchema` | 节点/边 id 唯一；边的两端必须存在于节点集 |
| `GraphNodeDelta/EdgeDelta` | `added`/`removed`/`changed` 的 `before`/`after` 组合合法；`before.id === after.id` |
| `MemoryScopeSchema` | `project`/`run` ⇒ 必须有 `project_id`；`run` ⇒ 还必须有 `run_id` |
| `MemoryRecordSchema` | `source_refs.min(1)` |
| `MemoryRecalledDataSchema` | completed/degraded 与 failure code 成对；hit/token 不得超过预算；逐 hit token 和必须等于总注入量 |
| `MemoryRecallResultSchema` | 可见 hit 顺序/id 必须与 durable recall evidence 完全一致 |
| `ContextNode/ManifestItem` retrieval | 只有 `memory/retrieved` 可携带 provenance；item/node 的 hit/hash/token 必须互相一致 |
| `PublicModelConfigResponseSchema` | `has_key` 必须与 `credential` 是否存在完全一致；响应结构不能出现 `api_key` |
| `SandboxReportSchema` | mode/enforcement/mechanisms/unmet 必须相互诚实；restricted `none` 必须解释未满足项，danger 不能声称 active mechanism |
| `SandboxEnforced/DisabledDataSchema` | enforced 禁止 `none`；disabled 只接受 `none`，reason 必须与 danger/restricted mode 一致 |

---

## 7. 测试证据

`contracts.test.ts` 覆盖 G-03 的 estimate/report/calibration 正反例、G-04 rollback request/command 边界，以及 G-19 的 `${secret:NAME}` 解析、迁移 marker、公开凭据元数据、`has_key` 一致性和 `api_key` 回显拒绝。`action-wal.test.ts` 单独覆盖 target/backup、phase evidence 与 recovery attempt 的交叉约束。G-05 的 `tool-g05.test.ts` 覆盖模型字段白名单、JSON Schema 边界、旧单调用兼容、batch 数量/互斥/action id/order/count、标准 failure/event/tool 枚举。G-06 的 `permission-g06.test.ts` 覆盖 built-in pair、规则/解释/分层、公开设置防夹带、token claims、legacy/new action/pending approval 与旧 recovery。G-07 的 `subagent-g07.test.ts` 覆盖 spawn authority 防夹带、可信 profile/spec、budget/terminal proof、4 个控制工具、当时 73 个事件、`parent_agent` 内部 actor、旧投影默认、Session root/all 与 recovery v4；Core `projection-g07.test.ts` 再覆盖双 child 6-event、launch failure 特例、链接/并发/终态与 payload fail-closed。G-08 的 `team-g08.test.ts` 覆盖 roster/mailbox/task strict shape、authority 字段排除、13 个 Event/90-event 全集、projector v8、member-loss 原子 reopen、sweep receipt 与 recovery 仍为 v5；Core Team 用例再覆盖幂等、权限、重启重放与并发 claim。G-09 的 `todo-g09.test.ts` 覆盖 Todo strict/上限/唯一/依赖、契约层模型/用户完成差异、分页入参、Plan count/revision、browser scope smuggling 与 legacy mode 迁移；`core/src/todo.test.ts` 再覆盖 evidence eligibility、保持 done 不得清空证据、最大合法单项与 replay fail-closed。G-13 的 `sandbox-g13.test.ts` 覆盖三档 vocabulary、full/partial/none 正反例、strict/version/size/unique 边界、lifecycle payload 与旧 Projection 兼容。G-14 的 `steering-g14.test.ts` 覆盖 Browser scope/actor smuggling、正文/队列/step 上限、消费原子字段、strict payload、幂等 result、队列唯一性与旧 Projection 空队列默认；Core `projection.test.ts` 再覆盖冲突 digest、未知/重复消费、scope、step 顺序与 Wire 剥离。G-15 的 `telemetry-g15.test.ts` 覆盖合法状态、四种 sink/三种 state、默认 noop，以及 endpoint/header/credential/source path/pending payload 的 strict 拒绝。G-18 的 attachment 契约正反例覆盖 MIME、5 MiB/8 个、delivery、拒绝码、PDF 抽取、offload locator、base64 与当时 76-event 枚举；Core `attachment.test.ts` 再覆盖 durable staging/claim。G-17 的 `extension-g17.test.ts` 覆盖 API/config/status/command/error/recovery v5 与当时 77-event 集；Core `extension.test.ts` 覆盖生命周期、六个 seam、错误隔离、可逆卸载与 lease/reload 竞态。G-23 的 `replay-g23.test.ts` 覆盖强制 Run 坐标、sequence bound、snapshot scope/anchor、authority 与 canonical state 分离，以及 diff direction/shape；Core `replay.test.ts` 再验证 hash chain 与确定性投影。G-21 的 `memory-g21.test.ts` 覆盖 strict candidate/事件 payload、query hash、预算、hit/item/node provenance 一致性、degraded recall 与三个新增 Event type。精确用例数以 `pnpm --filter @tracegraph/contracts test:unit` 当次输出为准。

G-08 的后续对抗用例还单独锁定 `team_read` section/offset/limit/snapshot pin 分页、保留 command namespace 与同 Run 原子批次；分页不会改变 Host/SDK 的完整 `TeamReadResponseSchema`。

---

## 8. 已知缺口与未完成分支

以下是逐文件核对时发现的、**契约已有但实现未跟上**或**类型层表达力不足**的地方：

1. **Memory 契约已有生产者，但没有独立 Projection 管理面。** Runtime 会生产 `memory.candidate_evaluated / memory.written / memory.recalled / retrieval.index_updated`，Context builder 会生产带来源的 `memory/retrieved` item/node；这些事实目前仍主要通过 timeline 与 Context Manifest 检查，`RunProjection` 没有专门的 Memory 列表或索引健康字段。

2. **`MemoryAdmissionSchema.decision` 有 5 个取值，实现只产出 4 个**——`superseded` 目前不可能出现。细节见模块 08。

3. **事件判别联合是"宽而扁"的。**
`eventVariants` 由同一个 `EventBaseShape` 对 100 个 type 各 `extend` 一次生成，因此**所有事件都拥有全部可选关联字段**。好处是统一、向后兼容；代价是"`context.built` 必须带 `context_manifest_ref`"这类约束**无法在类型层表达**，只能靠运行时约定。G-05 batch、G-07 subagent、G-08 team、G-09 Todo/Plan、G-14 steering、G-18 attachment、G-21 Memory、G-17 extension error 与 G-12 LSP 为自己的 payload 额外导出 strict schema，但通用联合仍然宽。

4. **`SessionEvent.data` 仍是 `z.record(z.string(), z.unknown())`**，所以通用事件联合没有逐 type 自动收窄 payload。G-05 batch、G-07 `subagent.*`、G-09 Todo/Plan 与 G-14 `user.input_*` 是局部改进：它们有独立 strict data schema，Runtime append 前强制 parse；G-07/G-14 投影重放时还会再次 strict parse 并 fail-closed。其它事件的内容仍依赖生产者与投影层约定。

5. **`artifact_refs` 在 canonical 与 wire 上的默认值语义不同**：`SessionEvent` 里是 `.default([])`，`WireSessionEvent` 里是必填。出站时必须显式给出，这个差异是有意的，但容易在新增出站路径时被忽略。

6. **`projection.git` / `graph` 相关字段缺席**：`RunProjection` 没有承载图快照与 Delta 的直接引用，只能通过 `timeline` 里的 `graph_delta_id` 反查。

7. **无 `examples/failing-typescript-repo` 之外的契约夹具**：`SourceRefSchema.source_type` 有 `fixture` 取值、`MemoryRecord.origin` 也有 `fixture`，说明测试夹具是设计考虑过的路径，但契约没有对应的测试专用严格模式。

8. **事件枚举扩展但 schema literal 仍为 v1。** G-03 追加 usage、G-04 追加 action/rollback、G-05 追加 batch lifecycle、G-13 追加 sandbox lifecycle、G-06 追加 permission/policy、G-09 追加 plan/todo、G-14 追加两个 user input、G-21 追加三个 Memory/Retrieval、G-07 追加五个 subagent lifecycle、G-18 追加三个 attachment lifecycle、G-17 追加 `extension.error`、G-08 追加十三个 team lifecycle、G-10 追加三个 skill lifecycle、G-11 追加五个 MCP lifecycle/call、G-12 追加两个 LSP lifecycle；它们没有修改既有 Event 字段语义，因此项目保持 `tracegraph.session-event.v1`。把 v1 type 集合硬编码为旧枚举的第三方 strict consumer 会拒绝新事件，必须升级到 100 种枚举后再读取新账本；投影消费者还必须接受 projector v8、可选 `team`、`attachments`、`subagents`、`input_queue`、`awaiting_plan_approval`、`needs_manual_review`、Todo/PendingPlan、`diagnostics_summary` 与可选 `permission` / `sandbox_report`。

9. **Telemetry status 不是 durable schema。** 它只报告当前进程内 sink 状态；错误计数与最后错误时间重启即丢，且不能替代 Ledger。配置 `<dataDir>/telemetry.json`、endpoint 环境变量、G-19 authorization reference 与 buffered payload 均不属于公开 Contract。

---

## 9. 相关文档

- 模块 05（证据链）：`SessionEvent` 如何变成 hash 链与投影
- 模块 02（Agent Runtime）：`Decision`、`ValidatedAction`、`Receipt`、`Observation` 的实际生产者
- 模块 08（记忆）：准入、持久记录、BM25 检索、Context provenance 与降级边界
- 根目录 `KNOWN_LIMITATIONS.md`：跨模块的已知边界
