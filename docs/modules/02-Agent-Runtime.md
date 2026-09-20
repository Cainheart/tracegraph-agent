# 模块 02：Agent Runtime

> 定位：整个系统的执行内核。模型循环、动作闸门、审批、Patch 提交、Context 组装、事件写入全部在这里发生。
> 代码：`packages/core/src/runtime.ts`、`subagent.ts`、`memory.ts`、`runtime-telemetry.ts`、`policy-engine.ts`、`approval-token-store.ts`、`sandbox/`、`action-wal.ts`、`session-store.ts`、`session-controller.ts`
> 契约：`packages/contracts/src/{commands,action,tool,action-wal,event,context,memory,token,sandbox,permission,projection,session,steering,subagent,telemetry}.ts` 与 `packages/telemetry/src/`
> 最后核对：2026-09-19（对照源码核对主循环、审批、命令、Sandbox、Steering、Telemetry 与投影路径）
> 实现状态：**已验证**（当前精确用例数以 Core/Test-support 测试命令为准）

---

## 1. 依赖注入（`AgentRuntimeOptions`）

| 选项 | 必填 | 默认 | 作用 |
|---|---|---|---|
| `dataDir` | ✓ | — | 数据根目录；ledger/artifact/WAL/recovery 分别落在 `events/artifacts/wal/recovery` |
| `sessionStore` | | `undefined` | G-01 durable Session 索引；CLI 注入 `JsonlSessionStore`，不改变 Event Ledger 的事实源地位 |
| `tokenMeter` | | `CalibratedTokenMeter(<dataDir>/token-calibration.json)` | provider/model-aware preflight、post-call 校准与异常判断；初始化失败不阻断 Agent |
| `telemetrySink` | | `NoopTelemetrySink` | G-15 process-local 观测旁路；Runtime 用 `SafeTelemetry` 包裹并从 committed Event 白名单派生。Core 不读取 `telemetry.json`、环境变量或 authorization reference |
| `retriever` | | `undefined` | G-21 本地或远端检索 seam；缺失时自动 turn 不检索、不追加伪造 recall 事件，显式 `recall()` 则以 degraded evidence 收口 |
| `retrievalBudget` | | `{max_tokens:4096,max_hits:8}` | 每轮 Memory 召回进入 Context 前的独立 token/hit 上限 |
| `memoryStore` | | `JsonlMemoryStore(<dataDir>/memory/records.jsonl)` | admitted Memory 的 canonical append-only 记录；检索索引只是可重建投影 |
| `model` | | `DeterministicFakeModel` | 模型适配器 |
| `now` | | `() => new Date()` | 时钟注入（可复现性） |
| `idFactory` | | `defaultIdFactory` | ID 生成注入 |
| `toolRegistry` | | `createDefaultToolRegistry()` | 工具注册表 |
| `maxToolConcurrency` | | `4` | G-05 同一安全波的并发上限；只接受 1..16，写/审批/不安全调用仍串行 |
| `subagentRegistry` | | 含 `readonly` 的 Host-owned registry | G-07 可信 profile 解析；模型只选 name，provider/role prompt/tool allowlist 不从模型输入取值 |
| `maxParallelSubagents` | | `2` | 进程内公平 permit pool 的 active child 硬上限 |
| `maxSubagentDepth` | | `1` | 冻结到 root/child recovery 与 parent projection 的委派深度上限 |
| `sandboxMode` | | `workspace-write` | 旧调用方兼容输入；未提供 G-06 policy 时映射为 legacy effective policy，新的 composition 应注入下列策略 |
| `permissionPolicy` | | 由 legacy `sandboxMode` 安全映射 | 已解析、Host-owned 的默认 `EffectivePermissionPolicy` |
| `permissionPolicyResolver` | | `undefined` | 按 Workspace 为**每个新 Run**解析 preset + Host/project rule layers；返回值不合法即 fail-closed |
| `approvalAnswerer` | | `undefined` | 只处理**非 Patch Tool** 的策略 `ask`；缺失、抛错、非法或 unavailable 一律拒绝。Patch ask 仍走公开 `approve/reject` 命令 |
| `approvalTokenStore` | | 进程内 `ApprovalTokenStore` | G-06 bounded one-shot token；Host 可注入对抗性测试替身 |
| `sandboxRunner` | | `createSandboxRunner()` | 平台探测与 `run_test` 执行边界；测试可注入 |
| `codeGraph` | | `undefined` | 代码图提供方；未注入则跳过所有图事件 |
| `contextPolicy` | | `undefined` | 由 Host 选择并传入，每轮 Context build 与 manifest 都记录它 |
| `maxTurns` | | `12` | 轮次闸门 |
| `actionWal` | | `ActionWal(<dataDir>/wal)` | G-04 Patch WAL 与 exact before-image；初始化失败则 Runtime fail-closed |
| `attachmentStore` | | `AttachmentStore(<dataDir>/attachments)` | G-18 durable staging/claim、Artifact materialization、PDF extraction 与 relation-scoped content |
| `recoveryLedger` | | `RecoveryLedger(<dataDir>/recovery)` | 恢复 recipe/attempt 事实、自动尝试上限与报告来源 |
| `rollbackPolicy` | | `{enabled:false, allowForce:false}` | 显式 rollback 总开关及非 disposable 的 force 策略 |
| `actionCommitFaultInjector` | | `undefined` | 仅用于自动化注入四个 commit 边界崩溃点 |

```89:90:packages/core/src/runtime.ts
/** Default guard against an unbounded model/tool loop. This is not a token limit. */
export const DEFAULT_MAX_TURNS = 12;
```

`maxTurns` 是**循环次数**闸门，与 token 预算无关——两者是正交的两道防线。

---

## 2. 公开接口（含 G-01 恢复控制）

| 方法 | 语义 |
|---|---|
| `startRun(input)` | 创建并启动 Run |
| `submitUserInput(command)` | G-14 durable inbox；按 `command_id` / `input_id` 幂等排入 message、approve hint 或 cancel，返回 queued/duplicate，不把普通消息直接塞进正在执行的模型或工具 |
| `approvePlan(command)` | 精确批准当前 `plan_event_id`，在同一 Run 切到 execute 并继续主循环 |
| `readTodos(runId, projectId)` | 从 canonical Ledger 重放当前 Todo 投影 |
| `writeTodo(command)` | 以 Host-bound user actor 更新 Todo；幂等且只允许可变 Run 状态 |
| `readTeam(runId, projectId)` | 从 coordinator/root Run Ledger 重放 G-08 roster/mailbox/task board；普通 Run 返回空 team |
| `createTeam(runId, projectId, request)` | 在 root Run 写唯一 `team.created`；冻结 limits，command id 幂等 |
| `writeTeamTask(...)` | user-bound create/claim/complete/block/cancel/reopen；optimistic `expected_version` 防并发覆盖 |
| `sendTeamMailbox(...)` / `claimTeamMailbox(...)` | user/worker identity 由 Runtime bridge 绑定，deliver/claim 都进入 root Ledger |
| `heartbeatTeamMember(...)` | trusted worker ingress；subagent identity 不从模型/浏览器 payload 读取 |
| `expireTeamMembers(...)` | 显式 scheduler sweep；使用冻结 timeout，一条 member-lost 事实原子 reopen claimed tasks |
| `remember(runId, candidate)` | G-21：strict candidate → scope/准入/去重 → canonical Memory JSONL → 可选索引，并追加准入/写入/索引事实 |
| `recall(runId, query, budget?)` | G-21：在项目/Run scope 与预算内检索；只把通过 provenance 校验的命中返回，并总是为显式调用追加 completed/degraded `memory.recalled` |
| `approve(command)` | 批准待处理的 Patch |
| `reject(command)` | 拒绝待处理的 Patch（随后终止 Run） |
| `stop(command)` | 旧兼容停止入口；触发 AbortSignal 并幂等收敛到终态，但不产生 G-14 queued/consumed inbox 事实。新交互取消使用 `submitUserInput(kind:"cancel")` |
| `getProjection(runId)` | 从账本重建视图；无事件则 `run_not_found` |
| `listSubagents(runId, projectId)` | 从父 Run canonical projection 返回冻结 profile/link/budget/status 列表 |
| `sendSubagentMessage(runId, projectId, input)` | 只向 direct active child 投递 `actor:"parent_agent"` 的有界 durable message |
| `interruptSubagent(runId, projectId, input)` | 只中断 direct active child，等 child 终态后再收口父回执 |
| `subscribe(runId, listener)` | 订阅 canonical 事件 |
| `subscribeLive(runId, listener)` | 订阅展示层活动（瞬时） |
| `listLiveActivities(runId, afterSequence)` | 拉取进程内展示缓冲（补发竞态窗口） |
| `subscribeModelSurface(runId, listener)` | 订阅模型公开输出画面（独立游标） |
| `listModelSurface(runId, afterCursor)` | 拉取模型画面缓冲 |
| `replay(runId)` | **仅** Event → Projection，不触碰模型与工具 |
| `replayAt({session_id, run_id, until_sequence})` | G-23：完整校验 Ledger 后只投影到指定 Run-local sequence，返回 anchor 与 canonical snapshot hash |
| `replayDiff({session_id, run_id, from, to})` | G-23：从同一次 Ledger read 派生两个端点，比较 Event/Evidence/Tool/Todo/审批/状态，不执行模型或工具 |
| `reconcileActions(locator + workspace)` | 重算 WAL 目标，关闭未生效 prepare、补齐已生效事实或标记 divergence；不重做 patch mutation |
| `rollback(input)` | 显式、默认关闭的单目标恢复；所有拒绝条件都成为 `action.rollback_refused` |
| `markRunInterrupted(locator)` | 在 Session lease 下为无终态 Run 幂等追加 `run.interrupted` |
| `resumeRun(input)` | 只允许 interrupted Run；待审批 Patch 重签 approval，待审批 Plan 恢复原 revision，其它状态只恢复只读视图 |
| `recordSessionFact(input, lease?)` | 在 canonical Ledger 与 Session 引用索引中写入 title/close/tail-repair 生命周期事实 |
| `getArtifact({artifactId, runId, projectId})` | 取工件，含六字段一致性校验 |
| `getTelemetryStatus()` | 返回当前进程 strict sink/status/error 快照；不是 durable Run Projection |
| `flushTelemetry()` | best-effort flush；任何 sink failure 都被隔离，不会以 Runtime 失败向上传播 |

`getProjection()`、`replay()`、`replayAt()` 与 `replayDiff()` 都直接读账本；后两者额外把 Session/Run/sequence 作为强制范围并验证 hash chain：

```485:491:packages/core/src/runtime.ts
  async getProjection(runId: string): Promise<RunProjection> {
    const events = await this.#ledger.list(runId);
    if (events.length === 0) {
      throw new RuntimeCommandError("run_not_found", "Run is unavailable");
    }
    return projectRun(events);
  }
```

**这意味着历史 Run 的可读性不依赖进程内存**——Host 重启后仍能查询与重放。G-01 还会在启动扫描时把旧的非终态投影显式推进到 `interrupted`。`#runs` 只缓存当前进程可继续处理的 Run。

---

## 3. 进程内状态

`#runs: Map<runId, RunState>` 之外还维护命令幂等、输入命令幂等、每 Run append/control 串行器，以及展示活动/模型画面的缓冲、监听者与游标。`#controlQueues` 与 `#appendQueues` 不是同一把锁：前者把“读终态或 inbox → 判定 → append”作为控制迁移串行化；后者只保证单条 Ledger 写入顺序。仅有 append 排队无法关闭 submit-vs-terminal 的 check/append 竞态。

`RunState` 除既有执行字段外，还包含 `sessionId`、Session lease、最后一个树节点 id 与已索引 Event id 集合；它们让**正常完成的 append 路径**把每条 Ledger Event 顺序索引进 Session：

```
runId projectId task conversationHistory mode reasoningEffort workspace
permissionPolicy        ← 本 Run 冻结的 preset + Host/project layers + digest
policyEngine            ← 从同一 effective policy 恢复的求值器
observations[]          ← 累积的工具观测（每轮全量交给 Context builder）
turn                    ← 已消耗轮次
pendingPatch?           ← 等待审批的 { pendingApproval, previewCall }
pendingPlan?            ← 等待审批的 { planEventId, todoIds }
cancelInputId?           ← 已 durable 排队、正等待安全边界完成的 cancel input
baseGraph?              ← 最近一次基线图快照
lastPatchEventId?       ← 供 test.completed 关联
stopped                 ← 停止标记
abortController         ← 取消信号
commandQueue            ← 该 Run 的命令串行化
actionSignatures        ← Map<actionId, 参数签名>，用于重复动作检测
canonicalActionSequence ← runtime 自有动作序号（见 §6）
```

### 3.1 恢复状态不是 Session Event 正文

新 Run 启动时，Runtime 把经过脱敏和上限约束的 task/conversation/mode/reasoning，以及本 Run 的 `EffectivePermissionPolicy` 写成 v5 内部 `recovery_state` Artifact。策略快照保留 preset、分开的 Host/project rules 与原 `policy_digest`；G-07 另保留 root/child `depth/limits/delegation?`，child delegation 必须与父 `subagent.started` 的冻结 spec/link 一致；G-17 再冻结 extension API/generation/config digest/active extension 与 Tool 集。这些不能在恢复时扁平化或按当前设置重算，扩展 snapshot 不一致时 fail-closed。待批 Plan 的 `plan_event_id` 与 Todo 集合仍由 canonical Ledger 投影，不复制进 recovery Artifact。进入 Patch 待审批时，再写一份包含完整绑定 `PendingApproval` 与**精确、已校验** `preview_patch` call 的内部 Artifact。Event 只在 `_internal_recovery_artifact` 字段中保留引用，`toWireEvent()` 会移除所有 `_internal_*` 字段，Session JSONL 也只写该 Event 的引用。公开 `get()` 仍受 1 MiB 限制；恢复只经 Runtime-only `getInternal()` 读取，独立上限为 8 MiB，并复用 scope、MIME、长度、hash 与二次脱敏校验。Artifact root/data/meta 权限分别收紧为 `0700`/`0600`，symlink root 会 fail-closed。

`resumeRun()` 必须先验证 Artifact metadata/hash、action binding 与 effective policy。v4/v3/v2 原样使用冻结 policy；v1 根据历史 `sandbox.configured` 收窄映射，连该事实也没有的旧账本退到不高于 read-only，不从当前配置推断写权限。Patch 待审批恢复时只追加 `run.resumed` 并用新的 approval id/action digest 重新请求批准，不自动调用 preview/commit，旧进程 token 不恢复；Plan 待审批恢复则重建同一 `plan_event_id` 的等待态，不重新调用模型，也不把旧 Plan 静默视为已批准。若中断前不是 `awaiting_approval` 或 `awaiting_plan_approval`，恢复只追加 `{view_only: true}`，投影仍为 `interrupted`。

这里没有跨文件事务：Runtime 先 append canonical Ledger，再 append Session `event_ref`。两步之间崩溃时 Ledger 仍权威，但索引可缺 ref。G-04 会在恢复 Patch Action 时重新提交带稳定幂等键的相同提案，Ledger 返回原 Event、Session 路径补齐缺失引用；它不是针对所有历史 Event 的通用反向扫描。

### 3.2 G-06 权限快照与 G-13 Run 级 Sandbox 生命周期

新 Run 先通过 resolver 得到并校验 effective policy，写 `permission.configured`，再在 `run.started` 之前调用 `#recordSandboxConfiguration()`；恢复 Run 使用冻结 policy，在 `run.resumed` 之前重新记录 sandbox lifecycle。Sandbox mode 始终取自 `state.permissionPolicy.preset.sandbox_mode`：probe canonical workspace 后依次追加 `sandbox.configured {mode,platform}` 与一个结果事件。`full/partial` 使用 `sandbox.enforced {sandbox_report}`；`none` 使用 `sandbox.disabled {reason,sandbox_report}`，其中 danger 是 `explicit_danger_full_access`，受限后端不可用是 `enforcement_unavailable`。

G-18 把附件认领插在 `run.created` 与上述 permission/sandbox/run.started 之间：

```text
run.created
  → claim attachment_upload_ids
  → attachment.added/rejected[/offloaded]
  → permission.configured
  → sandbox.configured + sandbox.enforced/disabled
  → run.started
  → indexing/context/model
```

只有存在 Run 后，超限、scope 错误或模型不支持图片才有 durable rejection；认领又必须早于首个模型请求，保证不支持图片的模型收到零 image block。成功附件生成 bounded Observation；offload 只把 `artifact:<id>` 与 PDF 抽取状态交给文本 Context，inline PNG/JPEG 只进入首次模型输入。运行中 G-14 steering 不接受 upload ids。

这份 Run 级报告是配置/能力事实，不代替执行期证据。`run_test` 仍须经同一个 `SandboxRunner.run()`，Runtime 再校验实际 report 的 schema 与 mode；合法报告写入 Receipt metadata、Observation facts、`tool.completed|failed` 与 `test.completed`。报告丢失、mode 不一致或非法时改写为 `sandbox_unavailable`，受限 child 不被当成已执行。该业务失败映射到通用 failure class `denied`。

默认 preset/ceiling 是 `workspace-write`，但 preset 永远不能扩大 Workspace capability。`read-only` 的 commit policy 在 preview 完成后立即产生 `policy.evaluated(kind:"deny")` + `policy.denied` 并结束 Run，**不会创建 `approval.requested`**；`workspace-write` 才建立待批 Patch。未被规则收紧的 `full-write` 不询问用户，也不写 `approval.requested` / `approval.granted` 或签发 token；Runtime 仍重算 canonical action digest，并复用 `#approveLocked(..., "policy")` 的提交 continuation 进入 Workspace/hash/WAL 边界。`commit_patch` 不通过 SandboxRunner；模型 adapter 的 HTTP 请求也在 Host 内执行。

### 3.3 G-09 Plan Mode 与 Todo Ledger

`mode: "plan"` 现在是独立控制流，不再只是少开放几个工具。模型只能使用严格的只读规划白名单，以及声明 `side_effect: "none"`、`concurrency_safe: false` 的 `todo_write`；文件写入、测试执行、补丁预览与任何未知工具都会在策略层拒绝。模型结束规划前至少要建立一个 Todo，Runtime 随后追加 `plan.ready`，把 Run 置为 `awaiting_plan_approval`，而不是写入终态。

批准命令必须同时绑定 `run_id` 与当前 `plan_event_id`。批准成功后追加 `plan.approved`，同一个 Run 切到 `execute` 并继续主循环；拒绝旧 revision、跨 Run revision，以及在该 `plan.ready` 后又发生 Todo 变更的陈旧批准。等待期间修改 Todo 会产生新的 `plan.ready` revision，因此批准方始终针对一份确定的计划快照。

Todo 不是 UI 临时数组，而是 canonical Ledger 投影。`todo.created|updated|completed|blocked` 记录结构化状态、依赖与证据；服务端校验唯一 id、依赖存在、无环、最多 500 条，并串行化同 Run 写命令。模型把 Todo 标成 done 前必须引用同 Run、早于当前 mutation 的 eligible 独立成功执行事实：成功非 Todo `tool.completed`、带严格成功 `run_test` Receipt 的 `test.completed`，或 allowlist 中的 Patch/Graph/Action Event；Todo/Plan/Model/Policy/Approval/lifecycle 不可自证。已有证据的 done Todo 在保持 done 时不能清空证据。用户的 actor-bound `todo.completed` 会确认该 Todo，但不是另一个模型完成的 eligible 证据。这条检查只证明执行事实已 durable 发生，不替代逐 Todo 的语义验收。`todo_read` 以 item 分页并让模型沿 `next_offset` 继续；专属 content/result envelope 为 512/640 KiB，模型 excerpt 按 UTF-8 截到 4,000 bytes，完整页存入 Artifact，既容纳最大合法单项，也避免大列表尾部被通用裁剪器丢失。

### 3.4 G-14 durable inbox 与恢复

`submitUserInput()` 不争用被 Agent 主循环长时间占有的 `commandQueue`，而是在独立的 per-Run control mutex 中原子完成：读取 Ledger、检查 command/input id、检查 terminal/cancelling/容量，再 append `user.input_queued`。`command_id` 绑定完整命令 digest；`input_id` 另绑定 raw `{kind,body}` digest，因此两段不同秘密即使公开正文都脱敏为同一字符串也不能碰撞成“重复成功”。同 input id、同 payload、不同 command id 返回原提交；不同 payload fail-closed。

公开上限仍是 100 条 pending，但普通 `message|approve_hint` 到 99 条即拒绝，第 100 个槽永久留给 `cancel`；否则满队列会让停止控制本身不可达。cancel 已排队后，新的不同 input 与审批/Todo 推进被拒绝，已有命令的幂等重放仍可返回原结果而不产生新迁移。

普通 message/approve hint 只在安全点消费：工具批次完全 settle 后、下一次 Context/模型请求前，每个安全点最多一条 FIFO。Runtime 写 `user.input_consumed {input_id,kind,consumed_at,at_step,queued_event_id}` 后才把它作为 user history 加进下一次请求。若模型在输入排队期间返回 `finish`，finish Decision 被视为陈旧；`#transitionAfterFinish` 在同一 control gate 中看到 pending inbox 后让路，而不是抢先 `run.completed` 或 `plan.ready`。三条普通输入因此需要三个安全点，`at_step` 严格递增。cancel 是专用 control lane：durable finalizer 可越过最多 99 条更早的普通输入，消费指定 cancel 并立即终结；被越过的普通输入保持 pending，供终态投影解释“未被模型处理”。

恢复不信任进程内数组：Projection v9 从当前 102 种事件中的 queued/consumed 差集重建 `input_queue.pending`，从 `attachment.*` 重建只读 `attachments`，从 `team.*` 重建可选 roster/mailbox/task board，并从 `code.*`/`lsp.*` 重建可选 `code_intel`；`#restoreRunState` 从所有已消费的 message/approve hint 重建 conversation history，覆盖“consumed Event 已落、内存 history 尚未更新”崩溃窗且不重复。恢复和 duplicate 返回还会按**当前** secret registry 重新脱敏并截到 8,000 字符，避免后来登记的秘密泄漏或替换文本膨胀突破契约。未消费输入在重启后仍保留。普通 running/indexing Run 仍遵守 G-01 的 fail-safe 只读恢复，不因 pending message 自动重跑未知的模型/工具；若崩溃前已有 durable pending cancel，显式 `resumeRun()` 只恢复最小 Run shell，适用于 prior indexing/running/待批状态，直接 consume+cancel，绝不重启旧 indexing/model/tool；未知外部副作用仍交给 Action WAL 对账。附件 Projection 可重放，但恢复不会重新发送历史图片或重新 claim 旧 upload；Team facts 可重放，但不会复活旧 worker 或自动重派任务。若 cancel 已 consumed、但进程在 terminal append 前崩溃，`markRunInterrupted()` 直接补唯一 `run.cancelled`，不会把它误写成 `run.interrupted`。

### 3.5 G-15 committed-Event Telemetry 旁路

Telemetry 不是 `RunState` 的组成部分，而是 Runtime 级的 `SafeTelemetry + RuntimeTelemetryProjector`。构造器默认使用 `NoopTelemetrySink`，因此 Core 单独运行时状态为 `disabled` 且零网络；CLI composition 才能显式注入 memory/OTLP/custom sink。Core 不知道 `<dataDir>/telemetry.json`、endpoint 环境变量或 G-19 authorization reference。

唯一派生点在 `#appendScopedInOrder()`：先等待 `#ledger.append()` 成功拿到 canonical `SessionEvent`，再调用 projector；之后才继续 Session event-ref 索引与 live publish。Projector 自身 catch future/legacy payload 的解析错误，`SafeTelemetry` 再 catch sink 的 emit/flush 错误，所以旁路失败既不能回滚 Ledger，也不能把已提交的 Run 改成 failed。terminal Event 会触发非阻塞 safe flush；嵌入方可显式 await `flushTelemetry()`，标准 CLI 则在 Host close 后以 5 秒总等待预算收口，不让旁路无界阻塞关停。

派生器只选择有界字段，不转发 Event summary 或任意 `data`：run lifecycle；model request/call/token/明确 provider cost；tool call/batch；compaction；approval wait；sandbox configuration。Tool `output_bytes` 来自 canonical Receipt metadata，是已校验、有界 `RawToolResult` envelope 的精确 UTF-8 字节数；`artifact_bytes` 另行求和 canonical Event `artifact_refs[].byte_length`，表示外置 Artifact 已持久化总字节。两者不可互换，也都不携带原始 Tool output；`parallel` 只对实际 `effective_concurrency > 1` 的可并行批成员成立。span 时间以开始时刻为 `at`，时长由关联 Event 计算。近期 Event id 去重上限 8,192，未闭合关联表上限 2,048，避免无限增长。

恢复完全不读取该状态。Runtime 不从 sink 反推 Event，也不在启动时重放 Ledger 以 backfill Telemetry；`error_count`、`last_error_at` 和 OTLP queue 都只在当前进程内。Ledger 才是事实源。

### 3.6 G-21 durable Memory 与每轮检索

Runtime 初始化时默认打开 `<dataDir>/memory/records.jsonl`；它保存通过准入的完整 `MemoryRecord`，检索索引只是一份可重建投影。`remember()` 先 strict parse candidate 并校验 project/run scope，再在单进程队列内按 `candidate_id + candidate_hash` 幂等：结构非法、跨 scope 或复用 candidate id 携带不同内容会在写任何 admission 事实前失败；无来源、过期、不可信或内容+scope 重复等**合法但不应接纳**的候选会写 `memory.candidate_evaluated {accepted:false,reason}`。确认候选先提交 candidate Event，并以实际 committed Event 中的 admission id、结果 memory id 与决定时间为准，再持久化 record、尝试 ingest、写 `memory.written`，成功索引再写由该 Event 引起的 `retrieval.index_updated`。

candidate Event 已提交、record 尚未写入，或 record 已落盘、后续 Event/索引步骤崩溃时，同一 candidate 重试都会复用原 admission/memory id，不创建第二条 canonical Memory；同 candidate id 换内容则 fail-closed。索引 ingest 失败不会否定已经 durable 的 Memory，也不会伪造 `retrieval.index_updated`，因此“记录存在、索引需重建”在证据上可区分。Memory JSONL 损坏或写失败则直接失败，不从不可信索引反推 canonical record。

主循环每轮在 Context build 前、仅当配置了 retriever 时调用 MemoryManager：query 是 `state.task.slice(0, 8_000)`，默认最多 8 个命中/4,096 token。project/run 记忆写入当前项目索引；global 记忆写入专用 `tracegraph:global-memory` 索引，recall 同时搜索当前项目与 global 索引并按 score/chunk id 合并去重。Retriever response 必须分别匹配所查 `project_id + sha256(query)`；`memory/<id>.md` 命中还要回查 canonical record 的 status、trust、source、expiry、project/run scope 与 superseded 状态。失败、非法响应或显式无 backend 都只产生 `memory.recalled {status:"degraded",failure_code,...}` 和空 hits，不能把未经审计的文本送入模型；自动 turn 在根本未装配 retriever 时保持旧行为，不追加无意义事件。

通过的命中携带 rank/hit id/content hash/score/source path/start-end line/heading/token。Context builder 将它们标成 untrusted 的 `memory/retrieved` item/node，Manifest 强制 item/node/token 与 durable recall evidence 对齐。Ledger 只保存 query hash 和有界 provenance，不保存 raw query/命中正文；正文存在 canonical Memory store、检索索引与本轮 Context Manifest/Artifact 边界中。

### 3.7 G-07 有界父子 Run 委派

`spawn_subagent` 的模型输入只能选 `profile_name`、任务包、`isolated|fork` 与请求预算。Runtime 从 Host-owned `SubagentRegistry` 解析 provider、role prompt/version/hash、tool allowlist 与 budget ceiling，并把有效值冻结为 `SubagentSpec`。child 有自己的 Run id、Session id、Ledger 和 recovery v5 Artifact；`run.created` 额外记录 parent run/session、subagent id/depth/limits provenance，后续恢复和 Host 只读路由都重验这些关系。

父账本常规只记三个节点：`subagent.started`、initial `subagent.message_sent {actor:"parent_agent"}` 与一个 terminal receipt。terminal 绑定 child terminal event id/hash 和有界 result/usage，不复制 child timeline；只有 launch 在 initial delivery 前失败才允许 `started → failed{failure_stage:"launch"}` 两事件收口。默认并发上限 2、深度 1；permit pool、step/token budget、profile ceiling 和冻结 tool allowlist 都在 Tool 执行前 fail-closed。`fork` 只携带精确绑定的有界父 Context 快照，`isolated` 不隐式继承父 history。

`listSubagents/sendSubagentMessage/interruptSubagent` 只操作 direct child，且受同一 parent/project/terminal 边界约束。启动恢复不重启旧 child model loop：父 active link 已指向终态 child 时补写 hash-linked 父 receipt；child 仍非终态时先递归收口 descendants、写 child `run.cancelled`，再收口父 receipt/interrupt。父终态永远晚于其 active child 终态。

当前 `spawn_subagent` 仍在父 Tool call 内等 child 终态；G-08 没有改变这个执行边界。若同一模型 Decision 通过 G-05 batch 提交多个安全 spawn，可在 G-07 默认 permit 2 内并行；单个调用不是通用非阻塞 worker handle。若 child terminal 本身已 durable、但父 terminal receipt 的 durable append 持续失败，Runtime 选择 fail-stop：父保持 `running`、permit 不释放，不在同进程猜测恢复；需重启 Host 后由上述 ledger-first reconciliation 补回执。

### 3.8 G-08 root-Ledger Agent Team

`TeamDomainService` 只读取/追加 coordinator/root Run 的 canonical Ledger，没有第二份 team store。`team.created` 冻结 team id、coordinator 与 limits；成员加入必须证明同一 root 投影里已经有匹配的 direct `subagent.started` link。root lead 与 child member 的 Tool bridge 均由 Runtime 从当前 Run/delegation 关系派生 actor，模型输入没有 project/run/team/actor/from/owner authority。

mailbox deliver/claim、task create/claim/complete/block/cancel/reopen 与 heartbeat 都通过 root-keyed command serialization 执行，command digest 让 lost-response retry 返回相同事实。Task claim 必须同时匹配 `state=open` 与精确 `expected_version`，所以两个并发 claimant 只有第一个可提交；complete/block 还要求当前 owner，done evidence 必须是同 root Ledger 中已有且符合资格的 durable Event。

heartbeat 不由后台定时器自动发送，lost 也不由读操作隐式判断。worker 显式推进 heartbeat 后，可信 Host/operator 显式调用 `expireTeamMembers()`；它读取 `team.created` 冻结的 timeout，以一条 `team.member_lost {reopened_task_ids}` 同时将 member 置 lost、把其仍 claimed 的任务释放为 open。Runtime 不选择新 owner、不重发旧模型请求，也不把这条本地串行化冒充跨 Host consensus。

### 3.9 G-17 扩展 lease 与错误隔离

Runtime 与 Host controller 共享同一个 `ExtensionManager`。新 Run 在写恢复种子前获取 lease，因此 model-visible Tool、Context strategy 和 extension policy 在整个 Run 期间不会被 reload 替换；所有终态、中断和启动失败路径都释放 lease。生命周期 mutation 与 lease acquisition 互斥，新 Run 不能观察到半卸载的注册表。

Context contribution 被转成有界、untrusted 的 retrieval-style surface，再交给原 Context 预算链；extension policy rules 只能进入既有 `PolicyEngine`，不能改写 Plan Mode、Workspace capability、preset ceiling、Sandbox 或 WAL 硬约束。每个 canonical Event 成功 append 后才分发只读 hook。hook/Context 错误被转为唯一 `extension.error`；该事件不再进入 hook，不得改变已提交的 Run outcome。详细生命周期与配置边界见模块 15。

---

## 4. 主循环 `#continueRun`

循环条件四项同时成立才继续：

```2201:2206:packages/core/src/runtime.ts
    while (
      !state.stopped
      && state.pendingPatch === undefined
      && state.pendingPlan === undefined
      && !(await this.#isTerminal(state.runId))
    ) {
```

即：未停止 **且** 无待批 Patch **且** 无待批 Plan **且** 未终态。Patch 遇到 `preview_patch` 会 `return`；Plan 的 `finish` 则写入 `plan.ready`、设置 `pendingPlan` 后 `return`。两条审批路径都让模型循环物理暂停，只有对应的 Host 命令可以继续。

每次进入循环后，Runtime 先证明还剩一个模型 turn，再运行 G-14 安全点：从 durable inbox 只消费 FIFO 头部一条普通输入。message/approve hint 在 `user.input_consumed` durable 后进入下一次模型请求的 history；若预算已耗尽，它会保持 pending 而不是产生“已消费但没有下一请求”的假事实。随后，已装配的 G-21 retriever 用原始 Run task 作有界 recall，成功命中作为带 provenance 的 Memory surface 交给 Context builder。cancel 由专用 durable finalizer 在工具/模型安全边界越过普通队列并直接收敛，不再发起模型调用。工具批次执行期间不会把新消息插进半轮 Decision，必须等当前安全波全部 settle；三条普通消息因此需要三个循环安全点，而不是一次清空。

### 4.1 一轮 turn 的完整阶段

| # | 阶段 | 关键行为 |
|---|---|---|
| 1 | 轮次闸门 | `task.turn >= maxTurns` → `turn_budget_exhausted` 失败 |
| S | G-14 Steering 安全点 | 预算允许下一次模型请求时，从 Ledger 投影读取普通输入 FIFO 头部，每次最多写一条 `user.input_consumed`；message/approve hint 进入下一次请求 history；cancel 由独立 control lane 在安全边界处理 |
| 2 | 分配 ID | `turnId`、`modelCallId` |
| R | G-21 Memory recall | 若 retriever 可用，按 task query 与独立 recall budget 检索、过滤 canonical Memory scope/trust/status，先 durable 写 completed/degraded `memory.recalled`；命中正文不进该 Event |
| 3 | Context 纯预计算 | `#contextBuilder.buildWithStrategies(...)` 将通过筛选的命中加入 `memory/retrieved` surface，再计 token 并证明候选替代会严格减量；此阶段尚未写 archive 或请求 summary provider |
| 4 | 压缩副作用栅栏与执行 | 第一个 archive/provider 副作用前，builder await `onCompactionStarted`，Runtime durable 写 `context.compaction_started`；随后才外置原文或发起独立 summary call |
| 5 | 落盘 manifest | builder 返回后 `artifacts.put(kind: "context_manifest")` |
| 6 | 落盘压缩 notice | `context.tool_output_spilled` / `context.summary_created|failed` |
| 7 | summary usage | 使用独立 model call 与 `request_kind:"summary"` 落账，不校准 Decision Context |
| 8 | 压缩结束 | 若压缩 → `context.compaction_completed`（带 steps 与 archive 引用） |
| 9 | 预算预警 | 若 `budget.status === "warning"` → `context.budget_warning` |
| 10 | 上下文就绪 | `context.built`（**每轮必发**，带 manifest 引用与预算/压缩摘要） |
| 11 | Decision 请求开始 | `model.request_started`（只含公开元数据） |
| 12 | 挂回调 | `onPublicProgress` → 易失 model surface；`onUsage` → 本轮内存收集并按 request kind/sequence 去重 |
| 13 | 调模型 + 校验 | `DecisionSchema.parse(await model.decide(...))` |
| 14 | **凭据闸门** | 见 §4.2 |
| 15 | Decision usage 回填 | 成功或失败路径都先 `#flushModelUsage()`；initial 校准并可发 anomaly，repair 只分开落账 |
| 16 | 失败分支 | usage 之后才写 `model.request_failed`（`ModelRequestError`）或 `model.output_invalid` |
| 17 | 取消分支 | 模型调用响应 AbortSignal 后写 `action.late_ignored { phase: "model" }`；durable cancel 随后在命令队列安全边界消费并收敛终态 |
| 18 | 动作身份修复 | `#repairActionIdentity()`（见 §6） |
| 19 | 冲刷公开画面 | 标记 `completed`——**只有通过全部校验后才算完成** |
| 20 | `model.decision` | 公开决策摘要；durable usage 已先写入 |
| 21 | 完成分支 | `#transitionAfterFinish` 在 per-Run control gate 内先重读 pending inbox；有新输入就把 finish 视为陈旧并进入下一安全点，否则 execute 写 `run.completed`，plan 校验 Todo 后写 `plan.ready` |
| 22 | 批决策展开、整批预校验与策略求值 | 旧 `tool_call` 归一为单元素；`tool_calls` 最多 16。逐项检查 action id、schema/注册表，再让 `PolicyEngine` 检查 capability/plan/preset/path hard constraint 与 Host/project rules；每项先写 `policy.evaluated`，deny 再写 `policy.denied`，任一失败时整批零 Tool 执行 |
| 23 | ask 与批审计/调度 | 非 Patch `ask` 只能由可信 `approvalAnswerer` 回答并用 one-shot token 原子消费，任何 unavailable/throw/invalid 都失败；Patch ask 延后到 preview。显式 batch 在 control gate 内检查 cancel 后写 `tool.batch_started`；安全非写调用按连续 wave、最多 `maxToolConcurrency` 并行，write/ask/不安全调用串行；所有 started/completion durable 写入保持请求顺序 |
| 24 | 记录观测 | 已完成成员按请求顺序进入 `state.observations`；显式 batch 追加 `tool.batch_completed`；archive 回读成功另写 `context.spill_refetched` |
| 25 | 测试特例 | `run_test` → `test.completed`（带 `patch_event_id` / `test_receipt_id`） |
| 26 | 未知处置 | `raw.status === "unknown"` → `unknown_side_effect` **失败，禁用自动重试** |
| 27 | 失败处置 | `raw.status === "failure"` → `#fail` |
| 28 | 预览分支 | 成功 `preview_patch` 后为实际 `commit_patch` 计算 canonical action digest 并再次求策略：deny 在创建 approval 前结束；ask → `patch.preview_created` → 设 `pendingPatch` → `approval.requested` → **return**；allow（`full-write`）不产生审批事件/token，直接带 action/policy digest 进入 WAL 提交链 |

`context.compaction_started` 的前置位置是 G-02 的可恢复性边界：archive `put()` 与 summary provider request 都不得先于它发生。summary/checkpoint 的模型可见表示含 archive locator；需要精确原文时，模型用 `read_artifact {locator,offset,limit}` 在同一 Run 内逐页回读。该工具不读取 Workspace，所以 Plain Chat 的零能力工作区也可回读自己的压缩原文。

### 4.2 第 12 步的凭据闸门

```759:765:packages/core/src/runtime.ts
        const serializedDecision = JSON.stringify(decision);
        if (
          redactSecrets(serializedDecision) !== serializedDecision
          || containsSensitiveStructuredData(decision)
        ) {
          throw new Error("Decision contained credential-like material");
        }
```

**模型输出里只要出现形似凭据的内容，整轮判定为 `model.output_invalid`。** 这是防止"模型把密钥写进动作参数"的硬拦截——它发生在写事件与执行动作之前。

### 4.3 G-03 usage 回填不是 Manifest 改写

`ModelInput.onUsage` 是 best-effort 侧通道。Runtime 每轮最多接收 16 个合法 report，并按 `request_kind:request_sequence` 去重；初始请求调用 `TokenMeter.observeUsage(modelCallId, report, manifest.input_tokens)`，把 provider input 与 preflight 比较、更新校准，再追加 `model.usage_reported`。`abs(provider_input / estimated_input - 1) > 0.25` 时追加 `model.usage_anomaly`。

repair 是第二个、请求形状不同的 provider 调用。它仍用同一 `model_call_id` 关联，但写 `request_kind: "repair"`、独立 sequence、`calibration_applied: false`，不会用初始 Context Manifest 的估算计算 `delta_ratio`，也不会污染滑动窗口。成本只有 report 自带合法 amount/currency 才记 `provider_reported`，否则明确为 `unavailable`。

usage append 失败不会改变已有模型响应或 Run 结果；因此它是 durable 后的审计事实，却不是与 provider 响应的事务提交。provider 已返回、usage 尚未 append 就崩溃时可能缺账；当前 G-04 只保护 Patch Action，并未覆盖 usage。Manifest 保持不可变，逐 section 也不会被 post-call total 反向重写。

### 4.4 第 25 步的原子性

```932:940:packages/core/src/runtime.ts
        state.pendingPatch = { pendingApproval, previewCall: call };
        await this.#append(state, {
          type: "approval.requested",
          ...
        });
        return;
```

只有 Patch policy 为 `ask` 才会把 pending/recovery Artifact 与 `approval.requested` 暴露为可恢复的人工审批状态。`pendingPatch` 赋值与 `approval.requested` 的 append **之间没有 `await`**：**「决定 → 执行 → 记账 → 状态迁移」必须在同一作用域内完成**，否则 `stop()` 可能插入两者之间，造成“内存里在等审批、账本里没有审批请求”的不一致。`read-only` 在此前已 policy deny；`full-write` 为 allow，Runtime 只在当前命令队列内构造内部绑定并进入 `#approveLocked(..., "policy")` 的提交 continuation，不持久化待批恢复工件，也不向用户发出 request/grant/token。

### 4.5 G-05 批调度与顺序语义

`Decision.tool_calls` 才产生 batch lifecycle；旧单 `tool_call` 继续沿用原来的逐工具事件，不被强制包装成 batch。Runtime 在第一个 `tool.started` 前完成整批 action id、注册、schema、capability、mode 与 G-06 policy 求值，避免“前项已产生副作用、后项才发现非法”。hard constraint 命中后任何 allow rule 都不能覆盖；Host rules 先按稳定顺序求值，project rules 只允许把结果收紧为 ask/deny。

每个已验证调用会得到一个序列化判断：`approval_required`、`write_side_effect`、`concurrency_unsafe` 三类必须单独执行；其余 `concurrency_safe && side_effect !== "write"` 的连续区间切成最多 4 个一组的安全波。每个波在任何 `tool.started` 前先整波重算 action binding 并按冻结 policy 最终授权；`deny` 或缺少 `approved-once` 的 `ask` 会让整波在执行前收口。授权通过后，Runtime 才按请求序写完该波全部 `tool.started`，工具函数可并行运行；等整波 settle 后再按请求序写 completion/Observation，因此 Session parent 链不会因并行执行分叉。

失败或 `unknown` 会在当前安全波全部 settle 后阻止后续波，并以请求序最早失败决定 Run 结果；成功的 `preview_patch` 同样阻止后续成员并进入审批。`tool.batch_started` 与 durable cancel 共享 per-Run control gate：cancel 先赢时不写 batch started、也不调用 scheduler；batch started 先赢时，cancel 或 legacy `stop()` 仍可能发生在首个工具开始之前，此时 completed audit 合法地记录零完成与实际峰值 0，以闭合已开始的 batch，而不是伪造执行。若工具已经开始，则必须先等当前安全波及 cancellation shield 收口，下一安全边界才消费 cancel。

`tool.batch_completed.results[].code` 与 Receipt `code` 保留业务原因；跨工具控制面另外写五类 `failure_code`（`invalid_arguments/timeout/output_contract_violation/denied/internal`）。两者不能混为一列，否则会丢失如 `tests_failed`、`stale_base` 之类的领域诊断。

---

## 5. Patch 提交 continuation `#approveLocked`

这个内部函数同时承载两种来源：`source:"user"` 是 Patch `ask` 的手工审批路径；`source:"policy"` 是 `full-write` 的 allow 路径。两者都复核 pending identity、过期、canonical action digest 与后续 Workspace/hash/WAL 边界；只有 `source:"user"` 会签发/消费 one-shot token 并写 `approval.granted`。

| 顺序 | 行为 |
|---|---|
| 1 | `state.stopped` → 直接返回投影（不报错） |
| 2 | `#requirePending(state, command)` 校验存在且匹配 |
| 3 | **过期检查**：user/ask 来源写 `approval.expired` 并以 `approval_expired` 失败；policy/allow 来源写 `action.rejected` 并以 `patch_preview_expired` 失败，绝不伪造 approval Event |
| 4 | 要求 `BoundPendingApproval`；用预览期参数、canonical target、base/patch hash 与 scope 重算 `action_digest`。不一致时 user/ask 写 `approval.denied(digest_mismatch)`，policy/allow 写 `action.rejected(action_digest_mismatch)`；两者都不改盘 |
| 5 | 若 `source:"user"`：Host token store 签发并立即原子消费 token；精确校验 approval/project/run/action、action/policy digest、scope 与 expiry，任何失配先 burn 再拒绝 |
| 6 | 若 `source:"user"`：以 token 与 digest 构造 `ApprovalBoundGrant` 并写 `approval.granted`；若 `source:"policy"`：跳过 token 与全部 approval 事件 |
| 7 | 用预览期的 `base_hash` / `patch_hash` 构造 `commit_patch` 调用；`ToolExecutionBinding` 是 `policy-allow` / `approved-once` 判别联合，两种来源都携带 action/policy/canonical-target digest，只有 user/ask 来源额外携带 approval/token binding |
| 8 | `#executeTool` 最终重评 policy：deny 立即结束；ask 必须配 `approved-once`，不能拿 policy-allow 冒充批准 |
| 9 | Tool 解析当前 canonical target；`patchMutation.prepare` 在 WAL 前再次比较 target digest，变化则以 `action_digest_mismatch` 拒绝；通过后才保存 exact before-image 并落 `prepare` |
| 10 | 工具用 durable temp + file fsync + rename + directory fsync 应用补丁，重读核对 after hash，再落 `applied` |
| 11 | 生成 `tool.completed` 的 Receipt/Observation；普通工具失败按 code 处理，WAL/注入中断则原样向上抛给重启恢复 |
| 12 | 失败且 `code === "stale_base"` → `action.stale`；随后 `#fail` |
| 13 | 成功 → 幂等 `patch.applied`（指向 commit tool 事件）→ WAL `committed`（绑定 event/receipt id） |
| 14 | `action.verified` → WAL `verified`；记录 `lastPatchEventId` |
| 15 | 若有 codeGraph 与 baseGraph → 抓结果快照 → `createDelta` → **四字段交叉校验** → 落工件 → `graph.delta_created` → 更新 `baseGraph` |
| 16 | 图失败 → `graph_delta_failed`；否则 `#continueRun(state)` |

预览过期时间是 **5 分钟**（`now + 5 * 60_000`），且 `preview.diff` 在事件里被截断到 **2 000 字符**（完整 diff 在工件里）。

第 15 步的四字段校验值得单独记住：

```405:412:packages/core/src/runtime.ts
        if (
          delta.project_id !== state.projectId
          || delta.base_snapshot_id !== state.baseGraph.snapshot_id
          || delta.result_snapshot_id !== resultGraph.snapshot_id
          || delta.patch_event_id !== patchEvent.event_id
        ) {
          throw new Error("CodeGraph delta did not match the active project, snapshots, and patch event");
        }
```

即**不信任 CodeGraph 提供方**：它返回的 delta 必须与本 Run 的项目、两个快照 ID、本次 patch 事件完全对应，否则整体判失败。

`reject` 的语义是“拒绝即终止”：写入 `approval.denied` 后立即 `run.cancelled { code: "approval_denied" }`。

### 5.1 非 Patch `ask`：可信 answerer，而不是 Web 待批条

Host/project rule 也可让 read/execute 等非 Patch Tool 得到 `ask`。这类调用不会进入 `pendingPatch`，而是调用 Host 注入的 `approvalAnswerer(request)`；request 已绑定 action/policy digest、project/run/action、scope、expiry 与人类可读 explanation。只有 strict `allowed-once` 会签发并立即消费 one-shot token、写 `approval.granted` 后继续；`rejected/cancelled/unavailable`、answerer 缺失、抛错或返回非法值全部写 `approval.denied` 并让 Run 失败。Web/SDK 的 `approve/reject` 命令**只处理 Patch ask**，不能冒充这条可信 Host integration seam。

### 5.2 G-04 启动对账与显式回滚

WAL 记录既保存进程内 `workspace_handle_id`，也保存稳定的 `sha256(realpath(root))`。重启会拿到新 handle id，所以对账/回滚真正的跨进程绑定条件是 project id、workspace kind 与 canonical root digest 全部一致。

`reconcileActions()` 对每个未关闭 Action 只做 hash 分类，不重放 mutation：

| 最近 phase / 磁盘 | 结果 |
|---|---|
| `prepare` + 全部 before | WAL → `aborted`，写 `action.reconciled {outcome:"not_applied"}` |
| `prepare/applied/committed` + 全部 after | 补齐缺失 `tool.completed` / `patch.applied` / `action.reconciled` / `action.verified` 与 Session ref，WAL → `verified` |
| workspace 不匹配、目标不可读、混合/其它 hash | 写 `action.diverged {automatic_rollback:false}`，投影进入粘性 `needs_manual_review` |

恢复 recipe 会进入独立 `RecoveryLedger`，自动 attempt 默认最多 1 次；重复启动依靠 recovery state 与 Event idempotency key 收敛，不重复事件或 Session ref。`DurableSessionController` 只对 composition 能从当前注册表解析出的 workspace 调用它，然后才考虑追加 `run.interrupted`。

`rollback()` 是另一条显式维护命令：策略默认关闭；开启后 disposable 可用，非 disposable 还需 Runtime `allowForce` 与请求 `force:true`。它还要求 Run quiescent、WAL verified、canonical workspace 一致、单目标、当前内容完整匹配 after hash，并验证 exact before-image。任何不满足都写 `action.rollback_refused`；成功用 durable replace（或删除此前不存在的目标）恢复 before 状态并写 `patch.rolled_back`。force 不绕过 hash/binding。

restore attempt 在真正修改 before 状态前先以 `started` 落 Recovery Ledger。若进程在 filesystem restore 后、`patch.rolled_back` 前退出，启动扫描会处理这个 open attempt：磁盘为 before 时补唯一的 `patch.rolled_back` + `action.reconciled` 并关闭 attempt；仍为 after 时记失败；其它 hash 则升级为 divergence。该恢复同样只补事实，不重复 restore syscall。

---

## 6. 幂等与竞态

### 6.1 命令幂等

普通命令入口（包括 rollback）经过 `#runCommand(command_id, signature, operation)`，其背后是 `#commandRuns: Map<commandId, CommandBinding>`。相同 `command_id` 重复提交会命中已绑定结果；**签名不同则判定冲突**。rollback 还把 command fingerprint 落入 durable Event，重启后重复提交也能判定冲突或幂等返回。

`submitUserInput` 另走 `#runInputCommand` 与 `#inputCommandRuns`，因为它必须在 Agent 的长命令仍执行时接受输入。进程内去重只是快速路径；durable 真相在 namespaced `user.input_queued.idempotency_key = command:${sha256(command_id)}:user.input_queued`、`_internal_command_digest` 与 `_internal_input_digest`。hash namespace 防止用户可控 command id 冒充 `${runId}:terminal`、consumed 或 WAL key；command digest 检测同 command id 改 payload，input digest 按 raw `{kind,body}` 检测同 input id 改 payload。只要 raw digest 存在，正文身份就不再依赖可能随 secret registry 变化的公开脱敏文本；legacy 无 digest Event 才 fallback canonical body。`_internal_*` 不进入 wire Event。同 input id、同 payload 即使换 command id，逻辑队列仍只有原输入；在非终态（包括重启后的 view-only/interrupted）Runtime 会追加一个复用原 input 的 command-binding queued receipt，使新 command id 的完整 digest 跨重启不可改绑，Projection 把它折叠为同一逻辑输入。终态禁止任何 post-terminal queued append，但原 command 与已绑定 alias 仍可 Ledger-first replay；真正的新 payload 精确返回 `run_terminal`。

`run.created` / `run.started` 另有 `commandEventKey(commandId, phase)` 生成的 `idempotency_key`，把幂等性下沉到账本层（见模块 05）。

### 6.2 动作身份由 runtime 拥有

```142:148:packages/core/src/runtime.ts
  /**
   * Number of runtime-owned action identities minted for this run.  The model
   * supplies an action_id as a correlation hint, but the Harness owns the
   * canonical identity.  Keeping the counter on the run makes collision
   * repair deterministic and independent of provider output.
   */
  canonicalActionSequence: number;
```

`#repairActionIdentity()` 在 `model.decision` 写入**之前**运行，处理"provider 每轮重复使用 `action:1` 这类短 ID"的现实问题。修复后原始 ID 只作为**脱敏审计元数据**保留（`model_action_id` 经 `redactSensitiveText` 并截断 160 字符），所有回执与观测都使用 runtime 自有的规范 ID。

### 6.3 重复动作拦截

```844:861:packages/core/src/runtime.ts
      const actionSignature = commandSignature({
        tool_name: call.tool_name,
        arguments: call.arguments,
      });
      const priorActionSignature = state.actionSignatures.get(call.action_id);
      if (priorActionSignature !== undefined) {
        const code = priorActionSignature === actionSignature
          ? "action_id_duplicate"
          : "action_id_conflict";
```

同 ID 同参数 → `action_id_duplicate`；同 ID 异参数 → `action_id_conflict`。**两者都直接失败 Run**，而不只是拒绝该次动作。

### 6.4 G-14 取消、工具 shield 与 legacy `stop`

新的交互取消使用 `submitUserInput(kind:"cancel")`。Runtime 先在 control mutex 内 durable append `user.input_queued`，再设置 `stopped` 并触发 AbortController；因此 provider 能尽快收到取消，但账本不会出现“已经 abort、却没有用户取消事实”的状态。若首次调用在 Ledger commit 后、Session index/响应前失败，Ledger-first retry 会修复索引、重新武装 abort，并再次排入幂等 finalizer；失败 Promise 不会永久毒化进程内 command cache。取消 finalizer 排在当前 `commandQueue` 后面：模型可立即结束；工具批次必须先让已开始的安全波 settle，写工具若已越过最终 signal check，则由 Host-only cancellation shield 完成原子 rename、WAL、Receipt、`patch.applied` 与 `action.verified`。已提交 Patch 不因取消回滚，也不会留下“磁盘已改但账本说 aborted”的半写状态。

到达安全边界后，Runtime 先写对应的 `user.input_consumed`，再写唯一终态 `run.cancelled {reason:"user_cancel", last_sequence:<consumed sequence>}`。`last_sequence` 精确指向取消前最后一个 durable Event，也就是该 consumed Event；重试、模型失败或工具失败不能抢写另一个终态。

`submitUserInput` 的 terminal-check+append、`#transitionAfterFinish` 的 pending-check+terminal/`plan.ready`、cancel consume+terminal，以及所有 `#terminal` 都经过同一 per-Run control mutex。因此 submit 与 finish/失败/取消的竞态被串成一种顺序：要么输入先 durable，终结让路；要么终态先 durable，后来的新输入得到 `run_terminal`。cancel 已 queued 后，批准、拒绝、Todo 与其它不同输入不再推进；相同命令仍可幂等重放。

`stop()` 只保留给旧调用方：它触发同一 AbortSignal，并以 `run.cancelled {code:"user_stop"}` 幂等收敛，但**不会**创建 `user.input_queued/consumed`，也不具备可展示的 inbox 生命周期。对已经终态的 Run 再 stop 会返回现有投影，不再追加第二终态或抛账本不变量错误。新 Web/SDK 交互应使用 durable cancel。

---

## 7. 事件产出清单

Runtime 主循环与 Session 恢复控制实际发出以下事件族（`credentials.migrated` 由凭据维护路径另行产生）：

```
run.created  run.started  run.completed  run.failed  run.cancelled
context.built  context.budget_warning  context.compaction_started  context.compaction_completed
context.tool_output_spilled  context.summary_created  context.summary_failed  context.spill_refetched
model.request_started  model.usage_reported  model.usage_anomaly
model.decision  model.request_failed  model.output_invalid
action.rejected  action.stale  action.late_ignored  action.verified
action.reconciled  action.diverged  action.rollback_refused
permission.configured  policy.evaluated  policy.denied
approval.requested  approval.granted  approval.denied  approval.expired
plan.ready  plan.approved
todo.created  todo.updated  todo.completed  todo.blocked
tool.started  tool.batch_started  tool.batch_completed  tool.completed  tool.failed  tool.unknown
sandbox.configured  sandbox.enforced  sandbox.disabled
patch.preview_created  patch.applied  patch.rolled_back
test.completed
graph.snapshot_created  graph.delta_created
code.intel_updated  code.stale_base_detected
memory.candidate_evaluated  memory.written  memory.recalled  retrieval.index_updated
subagent.started  subagent.message_sent  subagent.completed  subagent.failed  subagent.interrupted
attachment.added  attachment.rejected  attachment.offloaded
team.created  team.member_joined  team.heartbeat  team.member_lost
team.mailbox_delivered  team.mailbox_claimed
team.task_created  team.task_claimed  team.task_completed  team.task_blocked  team.task_cancelled  team.task_reopened
session.opened  session.closed  session.title_changed  session.tail_truncated
run.interrupted  run.resumed
user.input_queued  user.input_consumed
```

契约当前声明 **102** 种，Projection 使用 `tracegraph.projector.v9`；G-21 的四个 Memory/Retrieval 事件、G-07 的五个 subagent lifecycle、G-18 的三个 attachment lifecycle、G-17 `extension.error`、G-08 的十三个 team lifecycle、G-12 的两个 LSP lifecycle 与 G-20 的两个 CodeIntel lifecycle 都已有生产路径。`code.intel_updated` 只记录有界 snapshot/Git/symbol/LSP 摘要事实；`code.stale_base_detected` 会使旧 Patch approval 失效并生成新的 request，而不是写盘或直接终止 Run。只有 `artifact.stored` 仍没有独立生产者（工件通过 `artifact_refs` 关联），其余 101 种由 Runtime/恢复/维护路径产生。G-15 不增加 Session Event：span/metric/log 只从 committed Event 旁路派生，使用独立 `tracegraph.telemetry-status.v1` 报告健康度。

失败码（`run.failed` 的 `code`）可观察到的取值包括：`turn_budget_exhausted`、`model_request_failed`、`model_output_invalid`、`missing_tool_call`、`action_id_duplicate`、`action_id_conflict`、`capability_denied`、`plan_mode_denied`、`sandbox_denied`、`preset_denied`、`path_scope_denied`、`invalid_policy_path`、`policy_denied`、`approval_unavailable`、`approval_required`、`approval_expired`、`approval_binding_unavailable`、`approval_digest_mismatch`、`patch_preview_expired`、`action_digest_mismatch` 与其它 token/digest 拒绝码，以及 `schema_invalid`、`unknown_side_effect`、`stale_base`、`patch_anchor_mismatch` 等（工具业务 code 原样透传）、`graph_delta_failed`、`indexing_failed`、`runtime_failed`。G-05 的通用分类写在失败 Receipt metadata 的 `failure_code`、`tool.failed.data.code` 与 batch result 的 `failure_code`，用于跨工具控制；业务 code 则保留在 Receipt `code` 和 `business_code`，不会被覆盖。

---

## 8. 不变量

1. 一个 Run 至多一个终态事件（由账本层强制）。
2. 遇到 `preview_patch` 后必须先对实际 commit action 求策略：deny 立即结束；ask 才暂停等待用户并使用 one-shot token；allow 不产生审批事实/token，携带 canonical digest 直接进入 WAL 链。
3. Patch ask 路径中 `pendingPatch` 的赋值与 `approval.requested` 之间无 `await`。
4. `ask` 的批准是一次性的，token 精确绑定 approval/project/run/action、action/policy digest、scope 与 expiry；任何失配不得留下可重试 token。
5. 模型输出的凭据检查发生在写事件与执行动作之前。
6. `unknown` 副作用**不自动重试**。
7. CodeGraph 返回的 delta 必须与本 Run 的项目与快照 ID 一致。
8. 先前可用的 G-20 Git baseline 在 Patch ask 批准进入 `commit_patch` 前若发生 commit/branch/status-fingerprint 漂移，旧 approval 必须先 durable 作废，并以新 approval 重新请求；Git unavailable 不得伪装成未漂移，也不构成此 fence 的保证。
9. `getProjection` / `replay` / `replayAt` / `replayDiff` 只依赖账本，不依赖进程内存；G-23 的历史 hash 不包含会增长的 head 或 Host replay authority。
10. `ContextManifest.token_estimate` 是不可变 preflight；provider usage 通过后续 Event 关联，同一 model call 的 repair 不参与 initial 校准。
11. 若本轮会压缩，`context.compaction_started` 必须早于 archive/provider 副作用；summary usage 与 Decision usage 用不同 model call 分账。
12. `read_artifact` 只读当前 Run 的 Context archive、逐页最多 4,000 字节，不能因 Plain Chat 的 capability 例外变成 Workspace 文件读取入口。
13. `commit_patch` 在 WAL `prepare` durable 前不能改盘；WAL `verified` 必须有对应的 `patch.applied` 与 `action.verified` durable 事实。
14. 磁盘既不匹配 before 也不匹配 after 时不得自动覆盖或回滚；`needs_manual_review` 不会被后续维护事件清除。
15. rollback 默认关闭、只支持单目标，force 不能绕过 workspace binding 或 after-hash。
16. 显式 batch 在任何工具开始前完成全批预校验；安全波可以并行执行，但 durable start/completion 与 Observation 都保持请求顺序。
17. 写、需审批或 `concurrencySafe:false` 的调用不得进入并行波；默认峰值不超过 4，durable cancel 或 legacy stop 可让已开始的 batch 以零完成闭合。
18. 每个新 Run 必须在 `run.started` 前留下 `permission.configured` 与 sandbox configured + enforced/disabled；每个 Tool action 先有 `policy.evaluated`，deny 另有 `policy.denied`。
19. Sandbox mode 来自本 Run 冻结的 Host-owned permission preset，不来自 StartRun/StartChat；preset/rule 不能替代或放宽 Workspace capability。full-write 不使用 approval token，但也不能绕过 Patch digest、hash、Workspace capability 或 WAL。
20. 项目 policy 只能 ask/deny，Host allow 规则不能覆盖 hard constraint，project 高优先级条目也不能用 allow 遮挡后续收紧规则。
21. 非 Patch ask 的 answerer unavailable/throw/invalid 必须 fail-closed；Patch ask 只由公开 approve/reject 命令继续。
22. v5/v4/v3/v2 恢复必须保留原 policy digest 与 Host/project layers；设置变化不得改变已存在 Run 的权限。v3 起保存当前 `plan|execute` mode，v4 另保存 root/child orchestration 与冻结 delegation，v5 再保存冻结 extension snapshot；待批 Plan revision 与 Todo 不复制进 recovery Artifact，必须从 canonical Ledger 重放。
23. Plan 的 `finish` 至少要有一条 Todo；它只产生 `plan.ready` 并暂停，同 Run 只有批准当前 revision 后才能转入 `execute`。
24. Todo 写入按 Run 串行、依赖图必须无环且总数不超过 500；模型完成 Todo 必须引用同 Run、早于本次 mutation 的 eligible 独立成功执行 Event，且已有证据的 done Todo 在保持 done 时不能清空证据。该引用证明 durable execution fact，不承担 Todo 语义验收。
24. Todo 在 `plan.ready` 后发生变化会使旧 Plan revision 失效；终态或人工复核状态禁止新写入，但相同 `command_id` 的已提交结果仍可幂等重放。
25. `user.input_queued` 必须先于 cancel abort；普通输入只能在工具批次结束后、下一模型调用前的安全点按 FIFO 每次消费一条。cancel 是 control-lane 例外，可越过旧普通输入但仍须等待当前工具安全边界；所有 consumed Event 的 `at_step` 在同 Run 内严格递增。
26. 普通输入在 pending 99 条时拒绝，给第 100 槽保留 cancel；cancel 仅在 pending 已达 100 时拒绝。
27. submit、finish/`plan.ready` 与所有 terminal append 必须共享 per-Run control mutex；输入先 durable 时 finish 让路，终态先 durable 时输入不得追加。
28. cancel 只能在 `user.input_consumed` 后写唯一 `run.cancelled {reason:"user_cancel",last_sequence}`；工具 cancellation shield 内已提交的 Patch 不回滚。
29. 恢复必须从 Ledger 保留 pending，并从已 consumed 的 message/approve hint 重建 history；cancel consumed→terminal 的崩溃窗补 cancelled，不能补成 interrupted。普通 running/indexing Run 仍只读恢复，不能仅因 pending 自动续跑。
30. Telemetry 只能在 canonical Ledger append 成功后派生；它的 emit/flush failure 不得改变 Event、Run 终态或恢复结果。恢复与 replay 不读取/回填 Telemetry，默认 noop 不得产生网络 I/O。
31. Sequence 是 Run-local；任何交互式 replay 都必须同时绑定 `session_id + run_id`。Diff 两端必须来自同一次完整、已校验的 Ledger read，回放不能 append Event、调用模型或执行工具。
32. Memory candidate 必须先 strict/scope 校验；语义拒绝写 `memory.candidate_evaluated {accepted:false}`，确认记录按 candidate/hash 幂等，索引不能替代 canonical Memory JSONL。
33. 自动 recall 必须先于本轮 Context build；project/query hash 或 response schema 不匹配、backend 失败与显式 unavailable 都只能得到空的 degraded recall，不能注入文本。
34. 每条可见 retrieved item/node 必须能回指同一 hit 的 rank/hash/score/path/lines，且 attribution token 与 Manifest item/node token 一致；Ledger 不记录 raw query。
35. 模型的 subagent spawn 输入不得包含 provider、role prompt、tool allowlist 或父 scope authority；冻结 `SubagentSpec` 必须与 Host registry/profile ceiling 一致。
36. 每个非 launch failure 的 child 必须有 started → initial parent message → 单 terminal 回执；terminal 必须绑定 child terminal event id/hash，父终态前 active child 必须为零。
37. child 的 depth、并发、step/token budget 和 tool allowlist 都是 hard limit；默认 depth 1/parallel 2，越权 tool 不得产生 `tool.started`。
38. child terminal 已落账但父 receipt 持续写失败时必须 fail-stop：父保持 running、permit 不释放，直到 Host restart 从 canonical Ledger 对账；不得在同进程伪造终态或重启 child model loop。
39. 附件必须在 `run.created` 后、`run.started`/首个模型请求前完成 claim 并落 `attachment.*`；未经 capability gate 的图片不得进入模型。
40. 图片默认 offload，只有显式 inline + `image_input:true` 才进入首个模型请求；PDF 永远 reference-only，抽取文本必须是独立、同 scope 的 Artifact。

---

## 9. 已知缺口与未完成分支

1. **只有 `artifact.stored` 没有独立生产者。** G-21 已接通 `memory.candidate_evaluated / memory.written / memory.recalled / retrieval.index_updated`；工件仍只通过 `artifact_refs` 被引用，从不单独记账。Memory 目前也没有 Host/SDK/Web 管理 API，标准 CLI 会自动召回已有索引，但不会替用户自动创造候选或爬取整个仓库。

2. **Action WAL 不是通用副作用事务层。** 当前只接入单目标 `commit_patch`；`run_test`、provider usage 与未来外部 Tool 不受其保护。WAL/Recovery Ledger 只有进程内串行，Session lease 也不是跨进程 target lock；启动只对仍已注册且能解析可信 workspace 的项目对账。before-image 是权限收紧的本地精确字节，不是加密备份。

3. **`#continueRun` 仍是很长的单方法**，把 Context 组装、模型调用、usage 冲刷、Decision 校验、动作闸门、工具派发、预览与审批请求放在一个作用域。可读性成本高；但其中相当部分是不可拆的原子迁移（见 §4.4），可抽出的只有纯判定部分（`#repairActionIdentity` 是已有的先例）。

4. **审批过期直接判 Run 失败。** `approval.expired` 之后立刻 `#fail("approval_expired")`，Run 无法"回到运行中让模型重新预览"。而投影层遇到 `approval.expired` 却把 `status` 退回 `running`（模块 05 §5.1），两者语义不一致：**账本说失败，投影在中转态之间短暂显示运行中**。

5. **G-14 inbox 不等于任意状态自动续跑。** 普通 running/indexing Run 在进程崩溃后仍按 G-01 进入 fail-safe 只读 `interrupted`，即使还有 pending message 也不自动重启未知的模型/工具；只有可证明安全的 Plan/Patch 等待态在合法 continuation 后消费。唯一控制面例外是已 durable 的 pending cancel：用户显式 resume 后只做最小状态恢复与 consume+cancel，不续跑原工作。`approve_hint` 也只是进入下一次模型 history 的提示，不等同于 `approvePlan` 或 Patch `approve` 命令。

6. **进程内命令去重 Map 永不清理。** `#commandRuns` 与 `#inputCommandRuns` 随命令数单调增长，长寿命 Host 上无上界；durable Ledger 虽保证重启后的 G-14 去重，却不解决单进程内存回收。

7. **展示缓冲按 Run 有界，但 Run 条目不回收。** `#liveActivities` 每 Run 保留最近 128 项，`#modelSurfaceEvents` 保留最近 96 个快照；单个长 Run 不再无限增长。但两个 Map 在 Run 终态后都没有 eviction，长寿命 Host 的 Run 数量仍会让进程内展示状态缓慢增长。

8. **`getArtifact` 依赖投影。** 每次取工件都要先 `getProjection(runId)`（读全账本 + 投影），复杂度随 Run 长度增长；且若投影因任何原因失败，工件也变得不可取。

9. **`maxTurns` 只按轮次计数，不区分"有效进展"。** 12 轮用尽即失败，即使每轮都有实质进展。

10. **`reject` 使 Run 直接终止。** 拒绝补丁等于取消整个 Run，无法"拒绝这一版预览、让模型换个方案"。

11. **Plan 目前只有单级批准门。** 它能冻结 Todo 快照、拒绝陈旧 revision，并在同 Run 内切换到 `execute`；但还没有多级审批、分支方案比较、计划局部批准或跨 Run 计划复用。

12. **provider response 与 usage Event 之间没有 WAL。** 回调已收到 usage 后 Runtime 会尽量在 decision/request-failure 之前 append，但进程在这段窗口崩溃仍可能留下 provider 已计费而 Ledger 无 usage 的情况；Patch 专用 G-04 不处理该缺账。

13. **显式 rollback 的产品面仍很窄。** CLI 策略默认关闭，P0 只支持单目标；Recovery Markdown 仅有 Core API，Web 没有回滚或报告导出按钮。它不是任意历史版本切换或跨文件事务回滚。

14. **G-05/G-14 并发与取消都不是跨进程强隔离。** scheduler 与 per-Run control mutex 只协调当前 Runtime；没有跨 Host lock。通用 Tool timeout 通过 AbortSignal/Promise race 及时 settle，但忽略 signal 的第三方 executor 仍可能继续占用后台资源。`commit_patch` 在最终 signal check 与原子 rename 之间 arm Host-only cancellation shield：durable cancel、legacy stop 或 timeout 发生在此后时先完成 applied WAL、Tool Receipt、`patch.applied` 与 `action.verified`，再进入取消终态，避免“文件已改却记成 tool_aborted”；这不是任意 Tool 的通用事务。内置 `run_test` 经 G-13 SandboxRunner 启动，并在 POSIX 上有进程组 SIGTERM→SIGKILL 回收。

15. **G-13 不是 Host 级容器。** 当前只把内置 `run_test` 子进程送进平台 runner；provider HTTP、Context/Artifact/Ledger 与 `commit_patch` 都留在 Host。Linux 仅探测固定 bwrap 路径但未启用 backend，Windows 也无 backend，因此受限模式报告 `none + unmet_constraints` 并拒绝 child；`danger-full-access` 才直跑。macOS 依赖 Apple 的 `/usr/bin/sandbox-exec` 与 `system.sb`，可移植性有限；native runner 当前只产出 `full` 或 `none`，`partial` 仅由契约/UI预留。

16. **G-06 不是远程身份系统或通用 TOCTOU 解法。** policy/token/config 都属于本机单 Host 信任边界；token 是进程内 opaque capability，重启后消失，不是签名 JWT 或跨 Host lock。策略 `path_glob` 匹配逻辑相对路径，真实路径/symlink containment 与敏感文件仍由 Tool/Workspace 复核；外部进程可在策略检查后改盘，Patch 仍须依靠 canonical target、hash、原子替换与 WAL。

17. **用户 permission 选择不热改活动 Run。** CLI/env ceiling 变更需要重启 Host；Web/用户配置可以立即保存，但只影响随后创建的 Run。恢复采用 recovery Artifact 中冻结的 effective policy；v1 历史只按 sandbox 事实做兼容且不从当前宽策略推断提权。

18. **G-15 Telemetry 不是可靠投递或恢复系统。** sink queue、错误计数、最后错误时间和关联 Map 都只在进程内，重启会丢；启动不 backfill 历史 Ledger。OTLP 仅将网络/超时失败及 HTTP `429/502/503/504` 的对应 signal 放回有界内存队首，后续 flush 可能重复；`400` 等不可重试响应与 HTTP 200 `partialSuccess` 拒收会计错并丢弃该 signal 批次。200 响应正文最多读 64 KiB 以解析 rejected count，Collector 文本不回显。当前没有自动 retry/backoff、持久队列、完整 OTel SDK/processor/sampling/propagation 或真实 Collector 集成验证；CLI 的 5 秒关停 flush 预算也不保证 drain。它只能作为 best-effort 观测，不能替代 Ledger。

19. **G-08 是 durable 协调面，不是通用异步/分布式 scheduler。** roster/mailbox/task board 与 heartbeat/loss 已在 root Ledger 闭环，单 Host optimistic version 保证 task 单 owner；但 `spawn_subagent` 仍同步等 child 终态，Team 并行只来自 G-05 batch + G-07 permit。没有跨 Host consensus、自动 heartbeat/sweep、旧 worker 自动重启或任务自动重派。若 child terminal 已 durable 而父 receipt 持续写不进，父保持 running 且 permit 不释放，需 Host restart 才依据 Ledger reconciliation；这是为避免同进程双重 child 和伪终态，不是可用性保证。

---

## 10. 相关文档

- 模块 01（契约层）：`StartRunInput` / `RunCommandSchema` / `Decision` / `Receipt`
- 模块 03（Context）：`#contextBuilder.buildWithStrategies()` 的策略链、archive 与预算行为
- 模块 08（Memory）：candidate 准入、canonical JSONL、BM25/HTTP retriever 与 provenance/degraded recall
- 模块 04（工具与策略）：`#executeTool()` 调用的工具层与错误码
- 模块 05（证据链）：事件的落盘、hash 链与投影
- 模块 11（CLI 与装配）：`<dataDir>/telemetry.json`、endpoint env、G-19 authorization 与关停 flush
- 模块 07（CodeGraph）：`#bootstrapRun` 与 `approve` 中的图快照与 delta
