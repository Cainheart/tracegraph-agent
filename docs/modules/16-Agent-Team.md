# 模块 16：Agent Team（G-08）

> 定位：在 G-07 有界父子 Run 委派之上，增加可重放的 team roster、mailbox、共享任务板与显式存活回收。
> 代码：`packages/contracts/src/team.ts`、`packages/core/src/domains/team/team.ts`、`packages/core/src/domains/runtime/runtime.ts`、`packages/core/src/domains/tools/registry.ts`、`packages/{host,sdk}/src/index.ts`、`apps/cli/src/team-command.ts`、`packages/workbench/src/components/TeamPanel.tsx`
> 实现状态：**已实现**；G-08 定向行为 eval、文档一致性 eval 与 eval typecheck 已通过，最终整体验证计数以全仓门禁为准；G-08 后经 G-10 追加 Skill、G-11 追加 MCP、G-12 追加 LSP、G-20 追加 CodeIntel、MEM-042 追加 MemoryUse、RUN-053 追加 ModelRetry 事件，canonical Event 当前共 108 种，`PROJECTOR_VERSION = "tracegraph.projector.v9"`，内部 Run recovery 仍为 v5

---

## 1. 一句话职责

G-08 把“几个 child Run”提升为一个**以 coordinator/root Run Ledger 为唯一事实源**的协作面：成员身份、消息投递/认领、任务认领/完成/阻塞/取消以及 heartbeat/loss 都是 canonical Event，进程重启后从同一账本重放，不依赖第二份 team 数据库或浏览器缓存。

它没有改变 G-07 的执行模型：每个 worker 仍是一个有独立 Session/Ledger 的受信 profile child Run，单次 `spawn_subagent` 仍同步等待 child 终态。所谓“并行 worker”只来自同一模型轮次的 G-05 安全批调用，再受 G-07 默认 `max_parallel_subagents=2` permit 限制；G-08 没有新增通用非阻塞父模型循环。

---

## 2. 唯一事实源与投影

```
coordinator/root Run Ledger
  ├─ team.created
  ├─ team.member_joined / heartbeat / member_lost
  ├─ team.sweep_completed
  ├─ team.mailbox_delivered / mailbox_claimed
  └─ team.task_created / claimed / completed / blocked / cancelled / reopened
                         │
                         ▼ projectRun()
RunProjection.team
  ├─ roster
  ├─ mailbox
  └─ task_board
```

- `team.created` 把 `team_id`、`coordinator_run_id` 与容量/heartbeat timeout 冻结在 root Ledger。
- `RunProjection.team` 对普通 Run 和 G-08 之前的旧 Ledger 是可选字段；一旦出现 `team.created`，projector v8 会完整重建 roster、mailbox 与 task board。
- child 自己的执行轨迹仍留在 child Ledger；root Ledger 只保存 G-07 link 与 team 协调事实，不复制 child 的模型/工具事件。
- Session JSONL 仍只是 Ledger Event 引用索引，内部 recovery Artifact 仍为 v5。G-08 不另存不可重放的私有 team 状态，所以没有为了 team 人为升级 recovery 格式。

版本边界：G-08 追加 13 种 `team.*` Event，随后 G-10 追加 3 种 `skill.*`、G-11 追加 5 种 `mcp.*`、G-12 追加 2 种 `lsp.*`、G-20 追加 2 种 `code.*`，MEM-042 追加 `memory.use_status`、RUN-053 追加 `model.retry_scheduled`，本机工作台再追加四种回执/触发事实后当前总数为 108；既有事件信封语义未变，因此 `SCHEMA_VERSION` 仍是 `tracegraph.session-event.v1`。新的 `RunProjection.team` 派生形状把 `PROJECTOR_VERSION` 从 v7 升到 v8，G-20 可选 `code_intel` 再升到 `tracegraph.projector.v9`；LSP 的 `diagnostics_summary` 是兼容旧账本的可选派生字段。

完整追加集合为：`team.created`、`team.member_joined`、`team.heartbeat`、`team.member_lost`、`team.sweep_completed`、`team.mailbox_delivered`、`team.mailbox_claimed`、`team.task_created`、`team.task_claimed`、`team.task_completed`、`team.task_blocked`、`team.task_cancelled`、`team.task_reopened`。

---

## 3. 契约模型

### 3.1 Team 与 roster

`TeamProjectionSchema` 固定 coordinator、创建事件、创建时间与 `TeamLimits`，并包含三个带 `last_sequence` 的子投影。默认限制包括：

- `TeamLimitsSchema` 的独立契约默认 `max_parallel_workers = 4`；标准 Runtime 会把它收紧为实际 G-07 `max_parallel_subagents` 配置，产品默认因此是 2，而不是额外增加一层 worker 并发；
- `heartbeat_timeout_ms = 30_000`；
- `max_members = 500`、`max_mailbox_messages = 500`、`max_tasks = 500`。

每个 `TeamMember` 必须绑定一个已由父投影证明的 canonical `SubagentRunLink`，并记录 role、`active|lost`、join/heartbeat/lost 时间。`coordinator` 是 mailbox 保留地址，`TeamMemberSchema` 明确拒绝把它用作 `subagent_id`，避免成员与协调者身份折叠。浏览器或模型不能仅凭一个任意 `subagent_id` 伪造成员。

若 Team 在 `subagent.started` 之后才创建，Runtime 会从 root Ledger 投影中回填**仍为 running 的 direct child**，使用原始 link（含 `parent_session_id`）和 profile role 生成幂等 `team.member_joined`。当前写路径将 `team.created` 与这些 backfill join 先全部 stage，再通过 `JsonlEventLedger.appendAtomic()` 一次 durable replace 提交；不会留下“Team 已创建、既有 running child 尚未入 roster”的新崩溃窗口。若读取到旧实现遗留的 `team.created`-only 尾部，同一 create command retry 可只补缺失 join。已终态 child、非 direct child 或 provenance 不一致的 link 不会被补入 roster，因此不会把历史 child 复活。

Team 已存在时，新 worker 的父侧 `subagent.started` 与对应 `team.member_joined` 也作为同一 root-Ledger atomic batch 提交；读者不会观察到已 durable start 却尚未入 roster 的中间状态。这个原子性只覆盖一个 root Run JSONL 的 hash-chain tail；child Run 的创建/执行仍是后续独立 Ledger 边界，不是跨文件事务。

### 3.2 Mailbox

`MailboxMessage` 包含：

- `message_id`；
- `from` / `to`（`coordinator` 或 roster member）；
- `kind: steer | handoff | question | answer`；
- 最多 8,000 字符的 payload；
- `delivered_at`，以及成对出现的 `claimed_at + claimed_by`。

投递与认领分别产生 `team.mailbox_delivered` / `team.mailbox_claimed`。只有被寻址的 recipient 能 claim，已 claim 的消息不能被第二个成员抢走；重启只是重放这两个事实，所以未认领消息不会因进程内队列丢失。

### 3.3 Shared task board

`TaskBoardItem` 使用 `open | claimed | done | blocked | cancelled` 状态，含 title/detail、验收条目、owner、完成证据 Event ids 与正整数 `version`。关键不变量是：

- 新任务从 `open/version=1` 开始；
- claim/complete/block/cancel/reopen 必须提交精确 `expected_version`，成功变更只增加一个 version；
- `claimed|done|blocked` 必须有 owner，`open|cancelled` 必须释放 owner；
- done 必须引用 durable evidence Event；
- 只有 active roster member 能 claim，complete/block 只能由当前 owner 执行；用户/coordinator 可取消。

同一 root Run 的 team command 在 Core 内串行化，第二个并发 claim 会因旧 `expected_version`/状态失败。因此单 Host 范围内一个任务最多一个 owner；这不是跨 Host consensus。

生产 Runtime 对 `complete` 还有一层跨账本的**写入时校验**：它根据当前 task owner 的 canonical `SubagentRunLink` 打开对应 child Run Ledger，重新核对 project/parent/child Run/Session/subagent provenance，只接受发生在本次 `team_task_write` action 之前、且属于 Todo completion eligible allowlist 的 durable evidence。伪造 id、root Event、其他 child 的 Event，以及 `team_read`、`team_task_write`、`team_mailbox_send`、`team_mailbox_claim`、`team_heartbeat` 这五个 Team 控制 Tool 的 receipt 都会以 `task_evidence_invalid` 拒绝，避免“协调动作自证业务完成”。一旦校验通过并提交 `team.task_completed`，该 root Event 就是“已验证完成”的 canonical receipt；后续 projector/restart 只重放 root Ledger，不跨文件重新查询 child Ledger。这样既保持 root Ledger 是 Team 唯一事实源，也避免历史 child 文件可用性改变重放结果。

证据数组按契约上限 256 有界，而不是复用通用的 100 项截断；定向用例确认 101 个合法 evidence ids 在写入与重放中完整保留。所有 Team proposal 还会在结构化脱敏后、真正 append 前用对应 payload schema 校验**最终持久化形状**：例如两个不同 secret 被脱敏成同一 acceptance、secret-shaped stable id 或回拨时间都会 fail-closed，且不会留下毒化 Ledger 的半合法 Event。

---

## 4. Heartbeat、失联与任务回退

heartbeat 是显式操作，不是后台线程猜测 worker 是否存活：active member 调用 `team_heartbeat`，写入 `team.heartbeat` 并单调推进 `last_heartbeat_at`。可信 Host/operator 再显式执行 sweep；sweep 使用 `team.created` 中冻结的 timeout 和服务端当前时间，客户端不能提交 deadline 或伪造时间戳。

每个超时成员通过一条 `team.member_lost` canonical Event 变为 `lost`。该 Event 同时携带 `reopened_task_ids`，projector 在应用同一事实时把该成员仍 claimed 的任务释放为 `open`。因此“标记失联”和“任务回退”没有两次 append 之间的崩溃窗口；回退后**不会自动选下一个 owner 或重启 worker**，必须由后续显式 claim 决定。

顶层 sweep 总会产生一条 `team.sweep_completed` receipt，记录统一 `swept_at` 和本命令产生的全部 `member_lost_event_ids`；即使没有成员过期也写空结果 receipt。当前写路径预先检查所有派生 command namespace，再把全部新 `team.member_lost` 与由其已解析 Event id 构造的 receipt 通过一次 `appendAtomic()` durable replace 提交，所以新版本不会生成“只落了一部分 loss、没有 receipt”的尾部。为兼容旧实现遗留的 partial tail，重启后以同一 command id 会沿用原 `swept_at`，把剩余 loss 与引用完整 loss 集的 receipt 原子补齐；该 id 在 legacy partial window 也不能被其它 Team mutation 抢占。receipt 已存在后的响应丢失重试只返回 canonical duplicate，不会重复 loss、task reopen 或空 sweep。

`team.task_reopened` 是用户/coordinator 对 blocked/cancelled 任务的显式状态迁移；它与 member-loss 的原子自动回退是两条不同语义，不能混为一谈。

---

## 5. 五个模型工具与 authority 绑定

G-08 在内置 run-state 扩展中新增以下五个 Tool（内置 Tool 面的当前规模不在本文复述，以 `packages/contracts/src/action.ts` 的 `BUILTIN_TOOL_NAMES` 为唯一事实源）：

| Tool | 用途 | authority 边界 |
|---|---|---|
| `team_read` | 按 `roster|mailbox|task_board` 读取一个稳定、有界页 | actor/root scope 由 Runtime 派生；后续页可绑定 snapshot sequence |
| `team_task_write` | create/claim/complete/block/cancel/reopen | 模型输入没有 project/run/team/actor/owner；`expected_version` 防并发覆盖 |
| `team_mailbox_send` | 向 coordinator 或 roster member 投递消息 | `from` 由当前 root/child 身份绑定，模型不能填写 |
| `team_mailbox_claim` | recipient 认领消息 | recipient 从 child delegation 或 coordinator 身份绑定 |
| `team_heartbeat` | active child 更新心跳 | 只能代表当前绑定的 team member |

Team Tool 与其它 Tool 一样经过 G-05 strict input/output/timeout/Observation 路径以及 G-17 Run lease 的 frozen tool surface。它们只写 root Ledger，不直接写 Workspace；任何后续文件副作用仍必须单独经过 G-06 Policy/G-04 WAL 对应的工具路径。

`team_read` 不再把最大 500 个 member/message/task 的全投影一次塞入模型结果。它的 strict input 是 `section + offset + limit + expected_last_sequence?`：默认每页 25 项、最多 100 项，并在 512 KiB content / 640 KiB result 上限内按 UTF-8 字节动态收小实际页大小。响应给出 `total/returned_count/offset/limit/truncated/next_offset`、Team/section `last_sequence` 与有界 counts。从第二页起，模型应把首页 Team `last_sequence` 作为 `expected_last_sequence`；如果分页期间任何 Team 事实变化，Tool 显式返回 `team_snapshot_changed`，要求从 offset 0 重启，而不把两个 snapshot 混成一个视图。

每个成功 `team_read` 页都以 `spilled_tool_output` 保存在**当前调用 Run** 的 Artifact 中，Observation 只展示最多 4,000 UTF-8 bytes 的 excerpt 和 opaque `artifact:<id>` locator；如页正文未全显示，模型可用 `read_artifact` 按字节续读。这不扩大 Workspace 读权限，也不允许跨 Run 回读。另外四个 Team mutation Tool 只返回 compact receipt（command id/disposition/Event ids/Team sequence 和各状态计数），不再在 content/facts 里复制完整 projection。Host/SDK/CLI/Web 的 typed `GET team`/`show`/面板读取仍使用完整 canonical `TeamProjection`，这个分页仅收紧模型 Tool 表面。

---

## 6. Runtime、Host、SDK 与 Web

`TeamDomainService` 对外提供 create/read、member join/heartbeat/loss sweep、mailbox deliver/claim 和 task mutation API；Runtime 在它之上绑定 Run/Session/Event append。创建 team 后，G-07 成功建立的 direct child 可绑定为 roster member；Team late-create 还会补入当时仍 running 的 direct child。worker Tool bridge 从 child recovery/delegation link 派生 root Run 与 `subagent_id`，不会接受模型提交的 authority 字段。

Host/SDK 的 typed 路由为：

| Method | Route | 语义 |
|---|---|---|
| `GET` | `/api/runs/:runId/team` | 读取 coordinator/root 的 canonical team 投影 |
| `POST` | `/api/runs/:runId/team` | 创建 team（幂等 command id） |
| `POST` | `/api/runs/:runId/team/mailbox/send` | actor-bound 投递；Web 用户入口固定为 steer |
| `POST` | `/api/runs/:runId/team/mailbox/claim` | worker/coordinator recipient claim |
| `POST` | `/api/runs/:runId/team/tasks/write` | strict task mutation |
| `POST` | `/api/runs/:runId/team/heartbeat` | member heartbeat |
| `POST` | `/api/runs/:runId/team/sweep` | coordinator/operator 显式失联扫描 |

所有写请求都以 Host 绑定的 project/run/actor 和服务端时间执行，request schema 只允许 command id 与最小业务 input；Replay bearer 没有这些 mutation capability。

每个 `TeamMutationResult.event_ids` 只从该结果的 exact command receipt（sweep 则是 receipt 引用的 loss 集 + receipt）构造，不通过“本次读取期间新增的全部 Team Event”猜测归属。因此同一 root Run 上并发 mutation 不会把另一个 command 的 Event id 串入自己的响应；相同命令并发/重试则得到相同 canonical id 集。

Core 保留 `team-expire:`、`team-join:`、`team-retire:` 与 `team-tool:` 命名空间，用于 sweep 派生 loss、成员 join/retire 和 Tool bridge 的确定性内部 command id。公开 create/sweep 拒绝所有保留前缀，其他入口也按 actor/来源保护相应内部 key；调用方不能预占它们来伪造已执行的维护事实。

同一控制面也有 `tracegraph team` CLI 入口：`show`、`create`、`mailbox send|claim`、`task create|claim|complete|block|cancel|reopen`、`heartbeat` 与 `sweep`。它是 `runTeamCommand()` 经 typed SDK 连接已运行 Host 的薄客户端，不在本地另建 team store。除只读 `show` 外，所有 mutation 都可选 `--command-id`；响应丢失时以同一 id 和完全相同的业务参数重试可取回 canonical 结果，同 id 改 payload 会冲突。`show` 只接受 `--host-url`，不接受 `--command-id`。CLI 同样不暴露 project/actor/sender/owner/time/timeout 字段，authority 仍由 Run path 与 Host 派生。

Web 的 Team 面板从 `RunProjection.team` 展示 roster、task board 与 mailbox。它以只读证据浏览为主，只开放用户 steer 与任务 cancel；Replay 模式保持只读，浏览器不做本地乐观 owner 仲裁，也不能伪造 heartbeat、claim 或 member identity。steer 文本只有在 Host 明确确认成功、且输入框仍是本次提交内容时才清空；Host 返回失败、抛错或响应状态不确定时保留原 draft 供重试，用户在请求期间输入的更新文本也不会被旧成功响应覆盖。

---

## 7. 并发与恢复边界

### 已保证

- root Ledger 是 roster/mailbox/task board 的唯一事实源，重启后确定性重放；
- command id + digest 保证同一命令的响应丢失重试不会二次创建事实；
- sweep 包括空结果都有 durable `team.sweep_completed`；当前 loss+receipt 一次同文件 atomic replace，legacy partial tail 可按同一 command 修复，receipt 后重试不重复 loss/reopen；
- 同一 Host 进程内按 root team 串行 mutation，task optimistic version 保证单 owner；
- task complete 在写 root receipt 前从当前 owner 的 canonical child Ledger 校验 eligible evidence，并排除五个 Team 控制 Tool receipt；receipt durable 后重放不跨文件复验；
- append 前校验脱敏后的最终 Team payload；合法的 101 项 evidence 数组不被意外截断；
- late create 只回填 canonical running direct child，create+backfill 以及后续 started+join 分别同文件原子提交；mutation result 只返回 exact command 的 Event ids；
- `member_lost + claimed task reopen` 是一个 Event 的原子投影语义；
- G-05 同轮 batch 可并发提交两个 G-07 spawn，实际并行还受 G-07 permit 限制。

### 没有保证

- 没有跨 Host consensus、分布式 lease、跨进程 task lock 或 exactly-once 外部副作用；同一 Session/Run 仍只应由一个 Host writer 管理；
- `appendAtomic()` 只是一份 root Run JSONL 的单次 durable replace，不是 root/child Ledger、Workspace 或外部系统间的事务；
- 没有自动 heartbeat 定时器或自动 sweep；漏掉显式 heartbeat/sweep 就不会自行判失联；
- 不会在 Host 重启后重发旧 child 模型请求、复活 opaque worker 进程或自动重新分派其任务；
- 单个 `spawn_subagent` 仍同步阻塞到 child 终态；send/mailbox 不代表父模型已经获得任意时刻的非阻塞多轮调度循环；
- team task 的 evidence ids 证明事实已 durable，不能自动判断交付物是否语义上满足 acceptance；
- G-14 用户 input queue 与 G-08 team mailbox 是两套不同契约：前者驱动一个 Run 的下一 model step，后者是 root team 协调事实。

---

## 8. 验证入口

```bash
pnpm --filter @tracegraph/contracts test:unit
pnpm --filter @tracegraph/core test:unit
pnpm --filter @tracegraph/host test:unit
pnpm --filter @tracegraph/sdk test:unit
pnpm --filter @tracegraph/web test:unit
pnpm evals
```

重点验收由本模块及对应测试维护：mailbox 重启不丢、heartbeat timeout 原子 reopen 且不自动重派、空/部分 sweep 的 durable receipt 与重试修复、late-create running child backfill、并发 claim 单 owner、exact-command result、完成证据与最终 payload 校验、CLI/Host/SDK/Web authority/read-only 边界，以及事件/projector/recovery 版本的文档一致性。V2 去向见 [`../outlive-agent-v2/10-tracegraph-to-outlive-migration/README.md`](../outlive-agent-v2/10-tracegraph-to-outlive-migration/README.md)。


## 9. TEAM-100：dirty 基线上的隔离可写子任务（已验证后端切片）

标准共享 Host 现在向模型发布闭合的 `readonly`、`isolated-coder` 角色目录。低层兼容装配默认仍为 readonly；模型只能选择已发布名称、任务和有界预算，不能自定义工具、权限、凭据或工作区路径。空目录安全启动并拒绝未知角色。父 Run 必须是 Execute 且已有写能力；Plan/readonly 父不能借角色升级权限。

`isolated-coder` 从已有 HEAD 的普通 Git 仓库读取父级已授权的 staged、unstaged、untracked 和删除状态，创建私有 detached `--no-checkout` worktree，再复制冻结字节。源 HEAD、源 index 和源文件不被 stage/stash/reset/clean/checkout；仓库 hook、smudge filter 不执行。边界为 2,000 路径、单文件 1 MiB、总字节 16 MiB，读取只接受父级冻结策略的 allow 和无链接普通文件，并复用 `read_file` 的敏感路径硬边界。忽略的依赖/构建文件不复制；linked worktree、无 HEAD、冲突 index、submodule、符号/硬链接及超限基线拒绝。原生 workspace-write 必须达到 full enforcement，当前真实工作区验收仅在 macOS 完成；其他平台不能据此宣称可写子工作区已通过。

子 policy/capability/tool intersection 均不超过父级，并将 full-access 父收紧到 workspace-write。子工作区使用独立协调器 lease，不再占用父任务已持有的 root Run 名额；同一 Goal 请求预算沿用同一实例。支持实际暴露的 patch/test 及 `discover_project_commands` → `run_project_command` 已有命令 manifest/hash 绑定链，不提供任意 Shell 或自动安装依赖。

父 `subagent.started.spec.workspace_binding` 与子 `run.created.workspace_binding` 保存 opaque binding 和源 HEAD/index/tree digests；绝对根目录与完整基线只保存在 Host 私有 manifest/baseline。准备由 canonical Host command journal 持有回执；副作用后失败保留 worktree 并报 `team_workspace_effect_unknown`，相同 command 不自动重做。子终态仅释放自己的工作区/model lease，结果树保留审阅。`LeasedModelAdapter` 的 snapshot `forRun()` 为每个 child 建独立凭据引用，同时保持父级准入的 model、Key 版本与能力；保存连接旋转 Key 后，旧凭据等所有父子任务终态再清理。

恢复检测到可写子绑定时以 `subagent_workspace_review_required` 停止，保留原树/基线；不会改回父 root、重发补丁、自动合并或清理。可信 Host 的 `inspect(bindingId)` 提供相对路径与基线/当前 hash diff；当前尚未提供一般用户的三端 child diff/合并/CAS 工作流，也没有完成关系图、手动多角色设置或非阻塞多轮调度。因此这是 TEAM-100 后端切片，不是完整多 Agent 产品闭环。

源码与实际证据：

- [公开 binding 契约](../../packages/contracts/src/subagent-workspace.ts)、[Core 权限验证/resolver seam](../../packages/core/src/domains/subagent/workspace.ts)、[Runtime](../../packages/core/src/domains/runtime/runtime.ts)。
- [Host 冻结基线/私有 diff](../../packages/host/src/subagent-worktrees.ts)、[编译角色目录](../../packages/host/src/composition/subagent-config.ts)、[独立模型 lease](../../packages/host/src/composition/leased-model.ts)。
- [后端验证报告](../validation/team-100/backend-slice.md)：真实 Git 文件树/索引对比、两 child 原生命令和共享请求账单、Key 旋转前后真实本地 provider 请求；不代表真实 UI、最终安装包或 Windows 原生验收。

## 10. FLOW/TEAM：交付前独立只读审阅（已验证受限切片）

标准 Host 对普通软件 execute 根任务启用最多两轮编译 `delivery-reviewer`；普通任务使用同一 200,000 Token / 15 分钟总额度，Goal 复用已准入预算。审阅是实际独立子 Run/Session，Plan mode、独立冻结模型 lease，工具与父权限相交且只读；不会执行构建、修改文件、delegation 或自动合并。私有推理不作为审阅证据。父等待审阅时不持有 control lock，完成前重新核对输入和终态。

`Decision.review_result` 仅接受可信 reviewer 的闭合结果，声明路径必须有实际成功 `read_file` 回执。父校验子 canonical terminal id/hash、真实读路径及审阅前后授权文件 hash；阻断发现进入现有 AgentLoop 的 canonical Observation，经正常权限/批准闸门修复和新验证。未知/失败/证据不足/取消审阅不会转成功交付。最多两轮不是需求保证；Goal 最终用户验收仍独立。

真实临时 clamp 软件 fixture 完成源码、构建、弱测试通过、审阅发现漏项、新增回归实际失败、修复并重建测试通过、再次只读审阅通过；15 次本机确定性 HTTP 请求和所有子请求共用同一额度。[报告](../validation/delivery-review/README.zh.md)与 [692 项独立只读核验](../validation/delivery-review/controlled-known-failure-proof/verification.json)链接实际字节与事件链。该证明不代表付费模型质量。必读范围目前为 verified 补丁路径与命令 manifest；尚无任意脚本产物的完整变更清单，不能宣称全部生成文件已独立审阅。三端审阅设置/关系图、非阻塞持续调度和完整 TEAM/FLOW 产品验收仍待完成。
