# TraceGraph Agent

[English](README.en.md) · 简体中文

> 状态：P0 `v0.1-alpha` 纵向链已实现并通过自动化验证  
> 技术方向：TypeScript-first、Web-first、有界父子 Agent、事件原生  
> 工作名：TraceGraph Agent；正式公开前仍需检查 GitHub 与 npm 重名

TraceGraph Agent 是一个本地优先的 Web Coding Agent。它不只展示聊天结果，而是把 Agent 的 Decision、Tool、Approval、Patch、Test、Context 与代码架构变化放在同一条可回放轨迹中。

每个新 Run 都会进入一个 durable Session；在当前浏览器进程内，同一会话的后续追问可继续传入受预算约束、可在 Context Manifest 中检查的历史上下文。刷新/重启后可以恢复 Session 列表、最后一个 Run 投影和特定的待审批状态，但不会自动从所有历史 Run 重建完整 conversation transcript。会话索引是 versioned JSONL，只保存 header 与 canonical Event Ledger 的引用，不复制事件正文。对话中的“公开执行过程”由真实 Runtime 事件驱动：Context 组装/压缩、模型请求、工作区读取与搜索、真实 Tool 生命周期等会经 Live SSE 及时投影到当前轮次。它不暴露、补写或伪造模型私有思维链。

一句话定位：

> **一个架构感知、全程可观测、Context、长期 Memory 与验证证据可检查的 Web Coding Agent。**

## 当前已经实现

- 设置内置 OpenAI、DeepSeek、GLM、Qwen/Qwen Code、MiniMax、Claude 提供商预设，并支持自定义 OpenAI Chat Completions 或 Anthropic Messages 端点；
- DeepSeek 预设默认使用 `deepseek-v4-flash`，也可在设置中改为 `deepseek-v4-pro`；
- 支持 `default / low / medium / high / xhigh / max` 推理强度请求；实际发送值会按提供商与模型能力映射，不支持时保留提供商默认值；
- 本机 Host 创建并持久化 TypeScript 项目，支持在项目中提交任务、自由问答、预览并审批文件创建或修改；
- 可从浏览器触发本机原生目录选择器，把现有文件夹以读写或只读项目打开；Host 规范化路径并将登记表持久化到 `.tracegraph/local-projects.json`；
- 无项目时可直接开始普通对话；普通对话绑定到隐藏的无能力工作区，不允许索引、读取、搜索、执行或写文件；
- G-18 支持在新任务中拖放或选择 PNG、JPEG、PDF（单个最多 5 MiB、每 Run 最多 8 个）：Host 先以 raw bytes 做短期 staging，Runtime 在 `run.created` 后按 scope/hash/MIME 认领并落 Artifact 与 `attachment.added/rejected/offloaded`。图片默认外置；只有用户显式勾选 inline 且 Host 明确声明模型支持图片时才发送图片 content block。PDF 原文只保留引用，抽取文本进入独立 Artifact，抽取失败明确降级为 `reference_only`；
- `Decision → Schema/Capability/Policy → Tool → Receipt → Observation` 受控执行链；G-06 把 capability、plan mode、预设工具/path scope 作为不可被规则放宽的 hard constraint，并为每次 Tool action 写入可解释的 `policy.evaluated`（拒绝另写 `policy.denied`）；
- PatchPreview、base/patch hash 绑定、过期与 stale 校验；action digest 绑定 canonical target，mutation boundary 会在 WAL 前再次核对 target digest。Tool 启动前还会用 Run 冻结策略最终重评，deny 不会留下 `tool.started`、WAL 或 mutation。当最终 policy 为 `ask` 时，一次性审批 token 还精确绑定 project/run/action/approval、action digest、policy digest 与 scope，失配先消费再拒绝，不能重放；policy `allow` 不伪造审批事实或 token；
- 完整 Patch Artifact 校验成功前，Web 不允许批准写入；
- TS/JS file/module/static import/export Graph Snapshot 与 Delta；
- append-only JSONL Event Ledger、Artifact Store、Projection Replay；G-23 进一步支持按 Run 内 `sequence` 重建历史 `RunProjection`、比较两个序列的结构化差异，并为回放生成稳定的 canonical snapshot hash；
- versioned JSONL Session Store：header + 树形 `event_ref`、v0→v1 迁移、列表/搜索/改名、软删除和单写者租约；启动时在租约保护下修复不完整尾行并落 `session.tail_truncated`，把无终态 Run 明确标记为 `run.interrupted`；
- Host/SDK/Web 会话浏览闭环：`/api/sessions*` 支持受项目范围约束的查询与恢复，侧栏提供搜索、恢复和删除确认，启动恢复报告进入 `/api/bootstrap`；
- G-17 提供受信的进程内扩展内核：`TraceGraphExtension` 通过 `registerTool`、`registerTelemetrySink`、`registerContextStrategy`、`registerPolicyRule`、`registerCommand` 与 `on(event)` 六个可逆 seam 注册能力；激活失败会回收已注册项，卸载按逆序释放，API version 不匹配会在执行 `activate()` 前拒绝。每个新 Run 在 `run.created` 前获取 extension lease，并冻结 API version、generation、config digest、active extensions 与实际 Tool 集合；活动 Run 存在时 reload/deactivate 返回冲突，恢复时若 v5 快照不一致则 fail-closed。扩展 hook/context/sink 的超时或异常被隔离，必要时追加 `extension.error`，不会递归分发或改写 Run 结果；G-08 再追加 13 个 team Event、G-10 再追加 3 个 skill Event、G-11 再追加 5 个 MCP Event、G-12 再追加 2 个 LSP Event 后当前共 100 种；
- G-10 提供本地 Skill 系统：扫描项目 `.tracegraph/skills/*/SKILL.md` 与用户 `~/.tracegraph/skills/*/SKILL.md`，受限 frontmatter、项目优先冲突、坏文件诊断和 registry digest 都进入 canonical 证据；system Context 只放 name/description/version，模型按需调用 `load_skill` 获取有界正文，`allowed_tools` 仅与 G-06/父级 allowlist 取交集并 fail-closed。CLI 提供 `tracegraph skills list|validate`，Host/SDK 的 `/api/skills` 和 Web Settings 显示 catalog/conflicts/diagnostics，不执行 Skill 脚本；
- G-11 提供 Host-owned MCP stdio 客户端：`.tracegraph/mcp.json`（也可由 `--mcp-config`/`TRACEGRAPH_MCP_CONFIG` 指定）按 server 启动一个 JSON-RPC client，执行 `initialize → tools/list → tools/call`，按 `readOnlyHint`/`destructiveHint` 保守映射 native Tool，支持 required/optional 生命周期、degraded startup、`tools/list_changed` 无残留刷新、G-19 secret reference 与 canonical `mcp.*` Trace；CLI 提供 `tracegraph mcp list|restart <server>`，Host/SDK 的 `/api/mcp` 与 Web Settings 显示 bounded 状态/tool count。当前只开放 stdio/native bridge，PTC、HTTP/SSE、resources/instructions 和任意第三方动态加载仍 fail-closed；
- G-12 提供 Host-owned 原生 LSP stdio 客户端：按项目懒启动 `typescript-language-server`/`pyright-langserver` 候选，完成 `initialize`、`didOpen/didChange`、`publishDiagnostics`、`definition`、`references`；`get_diagnostics` 走标准 Tool/Receipt/Observation 路径，完整诊断只作为 bounded observation，Ledger/Projection 只保存 `lsp.diagnostics_received` 摘要和 `lsp.server_unavailable` 降级事实。Host/SDK 的 `/api/lsp` 与 Web Settings 只显示 server 状态/诊断计数；没有可用 server 时返回可审计的 unavailable，不伪造空诊断；自动 Context 注入、完整索引和 G-20 `code_intel` 合并留后续；
- 默认 20-Tool 能力面中，新增 `load_skill`；`read_artifact` / `list_artifacts` 已迁入 `@tracegraph/builtin-artifact-tools`，Todo、四个子 Agent 控制工具与五个 Team 工具已迁入 `@tracegraph/builtin-run-state-tools`；`read_file`、`list_dir`、`search`、`preview_patch`、`commit_patch`、`run_test` 留在最小核心。Host 暴露扩展状态、idle-only reload 与有界命令路由，SDK/CLI 提供对应 typed 操作，Web 设置页展示状态/generation/registration count/脱敏错误并允许 reload；
- G-07 提供有界子 Agent 委派：模型只能选择 Host 注册的可信 profile、任务包、`isolated|fork` 上下文范围和请求预算，不能提交 provider、role prompt 或 tool allowlist authority。Runtime 为 child 创建独立 Run、Session、Ledger 与 recovery Artifact，冻结实际 provider key、role prompt hash、工具白名单、depth 和 step/token budget；默认最多并行 2 个 direct child、最大深度 1。父账本只记录 `subagent.started`、父→子 `subagent.message_sent` 和一个 terminal 结果，child 内部轨迹不复制进父账本；Host/SDK/Web 可从父投影打开 child ledger 的只读视图，普通历史默认只列 root Session；
- G-08 在 G-07 之上增加 Agent Team：coordinator/root Run Ledger 是 roster、mailbox 与共享 task board 的唯一事实源，`RunProjection.team` 可从 13 种 `team.*` Event 完整重放。成员必须绑定 canonical G-07 child link；mailbox 支持 `steer|handoff|question|answer` 的 durable deliver/claim；task 以 optimistic `version` 仲裁 create/claim/complete/block/cancel/reopen，同一任务并发 claim 只会产生一个 owner。生产 Runtime 在 complete 写 root receipt 前只从当前 owner 对应的 canonical child Ledger 接受 eligible durable evidence，伪造、其他 child 或五个 Team 控制 Tool 的 receipt 会被拒绝；receipt 提交后 root replay 不跨文件复验。late create 的 create+running-child backfill、后续 started+join，以及 sweep 的全部 loss+`team.sweep_completed` receipt（空结果也写）分别以同一 root JSONL 的一次 durable replace 原子提交；旧 partial sweep tail 仍可用原 command id 补齐，响应丢失重试不会重复 loss/reopen。active member 与可信 Host/operator 分别显式 heartbeat/sweep；失联任务只回到 open，绝不自动重派或重启旧 worker。Web Team 面板以只读为主，只开放用户 steer 与任务 cancel；steer 只在明确成功且文本未被新输入替换时清空，失败/不确定保留 draft；Replay 继续只读；
- 待审批 Patch 的精确恢复状态保存为内部、脱敏且校验哈希的 `recovery_state` Artifact。当前 v5 状态在 v4 的 root/child orchestration depth、limits 与冻结 delegation 上增加 G-17 extension snapshot；v1/v2/v3/v4 仅供历史读取。Runtime-only 读取使用独立的 8 MiB 硬上限，公开 Artifact 路由仍是 1 MiB 且不会返回内部引用。重启后旧进程 token 不会复活，只会按原策略重新签发新的单次审批，不会自动执行 preview/commit；等待 Plan 审批的 Run 可恢复回同一计划版本，其它被中断状态只能恢复为只读视图。G-07 的启动对账会先收口父投影中仍 active 的 child link：child 已终态则补写绑定 terminal event id/hash 的父回执，child 未终态则先递归取消 descendants 并写 child `run.cancelled`，再收口父回执；它不会自动重启旧 child 模型循环。若 child terminal 已 durable、但父 terminal receipt 持续无法落盘，Runtime 会 fail-stop：父保持 `running`、permit 不释放，必须重启 Host 后再由 Ledger 对账，而不会在同进程猜测成功；
- G-04 Patch Action WAL：`commit_patch` 在改盘前持久化精确 before-image、before/after hash 与 workspace 绑定，按 `prepare → applied → committed → verified` 推进；Host 启动时会对仍已注册的工作区重算目标 hash，安全补齐缺失的 Patch/Receipt/verification 事实，未实际写入则关闭为 `aborted`，不匹配则写 `action.diverged` 并把 Run 固定为 `needs_manual_review`，不会自动覆盖或回滚用户手改；
- 显式 Action rollback 已接入 Host API 与 typed SDK，但默认关闭且 P0 仅支持单目标。启用后 disposable workspace 可回滚；managed/读写 linked workspace 还必须同时允许 force 且请求 `force:true`。任何模式都要求当前文件仍完整匹配 WAL 的 after hash，`force` 不会绕过此检查；Web 当前只展示恢复/分歧事件和人工复核状态，尚无回滚按钮；
- Fastify Host、typed TypeScript SDK、SSE cursor/reconnect；
- 默认 Host-owned Context Policy：总窗口 `258_000` tokens，预留 `32_000` 输出 tokens，故单轮输入预算为 `226_000`；`70%` 预警、`80%` 压缩阈值与估算器版本都会写入 Context Manifest；
- G-03 token 计量闭环：每次模型调用前把可见 section 文本记为 `TokenEstimate`（默认 `heuristic_v2`，可按 `(provider, model)` 的历史 usage 校准，也可注入可选 `TokenCounter`）；模型响应后把提供商回报的 input/output/total/cache/reasoning usage 作为 `model.usage_reported` durable Event 落账，输入偏差超过 ±25% 另写 `model.usage_anomaly`。OpenAI-compatible 与 Anthropic 的 JSON/SSE 响应均支持 usage 解析，Web 会按 `model_call_id` 把历史 Context 与对应 usage 配对展示；
- 每个 Run 默认最多执行 `12` 个模型/工具编排轮次，用于阻止模型在工具调用之间无限循环；它与 Context token 预算、模型单次输出上限相互独立。可在 `.env.local` 中用 `TRACEGRAPH_MAX_TURNS` 调整；运行记录会持久化实际轮次上限与失败时的已用轮次；
- G-02 Context 压缩策略链已接入 Runtime：按 `tool_output_pruner → spill → model_summary → tiered_checkpoint` 顺序缩减返回给模型的表面，直到落入输入预算。模型摘要必须符合 `{facts[], open_questions[], refs[{path,lines}]}` 严格契约，并独立记录 summary model call 的 usage；provider 不可用、超时、返回非法或摘要不足以缩减时，会写 `context.summary_failed` 并降级到确定性 checkpoint；
- 被替代的历史或工具原文以 `context_source_archive` / `spilled_tool_output` Artifact 保留，Manifest 通过 `nodes[].superseded_by`、`compaction_steps[].archived_artifact_refs` 和 opaque `artifact:<id>` locator 说明每步变换；summary/checkpoint 的模型可见内容也保留 locator。只读 `read_artifact` 严格绑定当前 Run，以 UTF-8 字节 `offset/next_offset` 和最多 4,000-byte page 回读并校验 hash；它不读取 Workspace，因此 Plain Chat 也能回读自己的 spill。Web Context 面板可显式展开公开 1 MiB 上限内的被压缩原文。`context.compaction_started` 先于 archive/provider 副作用，随后 `context.compaction_completed`、`context.tool_output_spilled`、`context.summary_created/failed`、`context.spill_refetched` 形成 durable 证据；
- G-21 已接入真实长期 Memory 与检索链：`packages/retrieval` 将 Markdown 按标题/段落切分，保持 fenced code block 完整，并把来源路径、精确行号和内容 hash 写入按项目隔离的原子 JSONL 索引；查询使用本地倒排 BM25，返回有界 `top_k`、分数与可回读原文。Runtime `remember()` 先执行带 scope/source/trust 的候选评估，持久化 canonical Memory record 后更新可重建索引；`recall()` 会按 Run scope、有效期和 Context token/hit budget 过滤命中，自动在每轮模型请求前把带引用的 `retrieved` 节点注入 `memory` section，并落 `memory.candidate_evaluated`、`memory.written`、`retrieval.index_updated`、`memory.recalled` 审计事件；
- CLI 默认直接使用 `<dataDir>/retrieval-index` 的本地 BM25；也可通过 `TRACEGRAPH_RETRIEVAL_URL` 选择 strict、loopback-only 的 `apps/retrieval-service` HTTP seam。远端写成功后仍写穿本地镜像；只有连接、deadline 或 `502/503/504` 才回退本地，鉴权、契约、scope 与完整性错误不会被静默降级。该 seam 为未来可替换后端保留边界，当前实现仍是 JSONL + BM25，不包含 embedding、向量数据库、Qdrant 或语义向量检索；
- G-05/G-07/G-08/G-09/G-17 默认工具面为十九个：六个最小核心工具加两个内置扩展贡献的十三个 Artifact/Todo/子 Agent/Team 工具；G-08 新增 `team_read`、`team_task_write`、`team_mailbox_send`、`team_mailbox_claim`、`team_heartbeat`，其模型输入不含 project/run/team/actor/from/owner authority。`team_read` 按 `roster|mailbox|task_board` 分 section，以 `offset/limit`（默认 25、最多 100）和 UTF-8 字节上限无损分页；后续页用首页 `last_sequence` 作 `expected_last_sequence`，跨页期间状态变化会显式返回 `team_snapshot_changed` 而不混合快照。完整页过大时会以 `spilled_tool_output` 落入 current-Run Artifact，模型用 `read_artifact` 按字节续读；四个 Team 写工具只返回 command/disposition/Event ids 与投影计数，不复制完整 Team。每个工具声明 strict、有界的 input/output schema、超时、并发安全、side-effect 和最大结果字节数；模型只收到当前 Run lease 冻结的 `name/description/input_schema` 白名单投影。`todo_read` 同样按 item 分页（默认 25、最多 100），返回 `next_offset` 并在每页内再按 UTF-8 envelope 动态收口；它与 `team_read` 的专属 content/result 上限均为 512/640 KiB，模型可见 excerpt 仍最多 4,000 UTF-8 bytes，完整页进入 current-Run Artifact。这样既能容纳一个最大合法 item，也能继续读取合法 500 条列表的尾部，而不会被通用结果裁剪静默丢失。旧 `tool_call` 继续兼容，同一轮也可提交最多 16 个 `tool_calls`；Runtime 预校验整个批次，只把 `concurrency_safe && side_effect !== "write"` 的连续安全波并行执行（默认最大 4），写操作、需审批或并发不安全调用保持串行，并以 `tool.batch_started/completed` 记录计划、实际并发度、顺序、耗时与失败分类。Team 并行 worker 只来自这种 G-05 batch 中的多个 G-07 spawn，并继续受默认 2 个 direct child permit 限制；单个 spawn 仍同步阻塞。`list_artifacts` 只列当前 Run 的公开 Artifact 元数据，不读取正文；
- `commit_patch` 在最终取消检查后、原子 rename 前进入 Host-only cancellation shield；若 stop/timeout 与不可逆写入竞争，Runtime 会先完成 applied WAL、Receipt、`patch.applied` 和 `action.verified`，再响应停止，避免把已经发生的写入误记为 `tool_aborted`；
- G-13 为 `run_test` 子进程增加 Host-owned 三档执行策略：`read-only` / `workspace-write` / `danger-full-access`。macOS 在可信 `/usr/bin/sandbox-exec` 探测成功后用 Seatbelt 限定 canonical workspace 文件范围并禁网；受限模式缺少可用后端时返回 `enforcement:"none"` + 明确的 `unmet_constraints`，且测试子进程不启动。Linux 当前只探测 bwrap 是否存在但尚未启用执行后端，Windows 也尚无后端；`danger-full-access` 会明确记录禁用沙箱并直接运行受限时长/输出/进程组的子进程；
- G-06 提供 `read-only`、`workspace-write`、`full-write` 三种不可拆的权限预设，分别绑定 `read-only + never`、`workspace-write + on-write`、`danger-full-access + never`。默认 Host ceiling 为 `workspace-write`；Host 规则按 priority 降序、同优先级 `deny > ask > allow > rule_id` 稳定求值，项目 `.tracegraph/policy.json` 只允许 `ask/deny` 进一步收紧。Web 只能选择 Host 广告且不高于 ceiling 的预设，不能提交规则、路径、sandbox/approval 组合或 token；
- G-09 把 `plan|execute` 与 Todo 接入主链：Plan 中只允许信任白名单里的只读工具和只写 Run Ledger 的 `todo_write`，其他动作以 `policy.denied{reason:"plan_mode"}` 在 Tool/WAL/改盘前收口。模型完成规划后追加非终态 `plan.ready`，用户审批精确 `plan_event_id` 后在**同一 `run_id`**追加 `plan.approved` 并继续 execute；重启可恢复到原计划审批点，旧 `manual` 模式只用于历史重放；
- Todo 是账本投影而不是 Prompt 里的自由文本：它有状态、依赖、创建主体和证据 Event 引用，缺失依赖或成环会返回明确路径并拒绝。模型置为 done 必须引用同 Run、早于本次 Todo mutation 的 eligible 独立成功执行事实：成功的非 Todo `tool.completed`、带严格成功 `run_test` Receipt 的 `test.completed`，或受信的 Patch/Graph/Action 事实；Todo/Plan/Model/Policy/Approval/Run lifecycle 与 `todo_read/todo_write` 不能自证。已有证据的 done Todo 在保持 done 时不能清空证据。该引用只证明对应执行事实已 durable 发生，不是逐 Todo 的语义验收器。Web Trajectory 上方的 Todo 面板可由用户勾选/重开；用户勾选本身会作为 actor-bound `todo.completed` 持久确认，但不会变成另一个 Todo 的 eligible 模型证据。Plan 横幅在待审批时展示当前 revision 并触发同 Run 审批；
- G-14 把运行中输入建模为每 Run 的 durable mailbox：`POST /api/runs/:runId/input` / typed SDK 提交 `message | approve_hint | cancel`，先落 `user.input_queued`。普通 message/hint 只在工具批次结束、下一次模型请求前的安全点按 FIFO 每次消费一条并落 `user.input_consumed { at_step }`；`cancel` 是专用 control lane，可越过更早的普通输入并在安全边界收口，被越过输入仍保留为 pending。同一 `input_id` 精确幂等，command key 使用 hash namespace 且 duplicate alias 会 durable 绑定；正文最多 8,000 字符、待消费最多 100 条；重启可从 Ledger 重建未消费队列和已消费的对话历史；
- Web 在 running、indexing、待 Patch 审批和待 Plan 审批期间保留排队输入框，显示“将在下一步发送”与 pending 状态，Trajectory 展示消费 step。响应丢失后的 retry 会复用同一组 input/command id，同 Run 只接受单调前进的 Projection，跨 Run 的晚响应不会夺回当前页面；`reconnecting` 禁写，但紧急 cancel 不会被普通 steering/审批/Todo 的 busy 状态阻塞。`cancel` 会先持久化再停止当前模型；工具已经开始时会等到安全边界，若 `commit_patch` 已进入不可逆阶段则先完成 WAL/Receipt/Patch 收口，最后写唯一的 `run.cancelled { reason:"user_cancel", last_sequence }`，不会把已提交 Patch 自动回滚；
- G-15 提供 vendor-neutral Telemetry 契约、`noop` / bounded `memory` / OTLP-HTTP sink 与统一 conformance suite；套件会比较两次 flush 后的 `deliverySnapshot`，实测空 flush 不会重复交付。Runtime 只在 canonical Session Event 已成功写入 Ledger 后，从白名单字段派生少量 run/model/tool/compaction/approval/sandbox span、metric、log；`tool.call.output_bytes` 是已校验、有界 `RawToolResult` envelope 的精确 UTF-8 字节数，`artifact_bytes` 则是外置 Artifact 引用的持久化总字节数。sink 的 `emit` / `flush` 失败只累计进程内 `error_count` 并尽力上报 `telemetry.sink_errors`，不会改变 Run 结果。Telemetry 是可丢失的观测旁路，不是第二份事实账本，也不参与恢复；
- Telemetry 缺省为 `noop`，即使机器上存在 OTLP endpoint 环境变量也不会默认联网。只有服务端 `<dataDir>/telemetry.json` 显式选择 `otlp_http` 后，CLI 才从 `endpoint_env` 指定的环境变量（默认 `OTEL_EXPORTER_OTLP_ENDPOINT`）读取 endpoint；可选 `authorization_ref` 必须经 G-19 `${secret:NAME}` 凭据边界解析。Host/SDK/Web 仅暴露 strict、只读的 sink/state/error count/last error 状态，浏览器看不到也不能设置 endpoint、header、credential、配置路径或待发送 payload；旧 Host/SDK 若不支持该查询，Web 会显式报告不可用，不伪装成 `noop`；
- G-16/G-21 提供与单测分离的离线评测面：首批 5 条 Runtime 行为回归（审批链、Context 压缩、工具并行、崩溃恢复、只读拒绝），再加 G-07 子 Agent、G-18 附件、G-17 扩展和 G-08 Agent Team，共 9 条独立 Runtime 用户路径；另有 Memory/CodeGraph 确定性质量对比、生产检索链的“有/无检索”任务成功率与引用准确率对比、文档与实现一致性审计，以及 Context input token、模型调用数、Tool P95 和 loopback SSE 首字节的性能门。有界 `ScriptedMockProvider` 支持固定/非法输出、usage、超时和取消；评测 worker 清除 provider 凭据并拦截非 loopback 网络，不需要 API key；
- `pnpm evals` 运行离线行为/质量/性能/文档/时间旅行评测，并将有界报告写到 `_tmp_evals/reports/latest.json`；对已提交性能基线它只做验证，只有显式 `pnpm evals:update` 或 `pnpm evals -- --update` 才能更新 `evals/baselines/performance.json`。基线更改必须人工审查，wall-clock 上限是回归报警而非跨机器 SLA；
- G-22 提供三个独立的 GitHub Actions job（`typecheck` / `test` / `evals`）、全局与关键模块覆盖率门、文档/限制映射审计、exact + 24 小时冷却的依赖解析、fail-closed lockfile guard、high/critical audit 门，以及 tag/version/CHANGELOG/构建出口一致的私有 workspace 发布清单；第三方 Actions 固定到完整 commit SHA，依赖安装前先检查 manifests；
- G-23 提供交互式 Trace Replay Debugger：点击 Trajectory Event 可进入该 Run/sequence 的历史投影，顶部 Replay 条显示 sequence/head/hash 与相邻步差异，支持按钮及 `←/→` 单步，并可重新读取最新 head 后返回实时态。Host 签发短时、前缀 Artifact 绑定的只读 replay capability；回放 bearer 不能访问 latest Run、SSE 或领域写路由，SDK 也不会把过期 replay authority 自动升级为 live authority；
- 发布工作流只接受与根版本精确匹配的 `v<version>` tag，先清理所有受 manifest 管理的 `dist`，再将校验过的构建出口复制到隔离的 `_tmp_release/bundle` 并生成含 SHA-256 的 `tracegraph.release-manifest.v1`。全部 workspace 包保持 `private`，这不是 npm 发布、签名、provenance 或部署；
- 每个新 Run 都会 durable 记录 `permission.configured`、`sandbox.configured` 及 `sandbox.enforced` / `sandbox.disabled`；每个 Tool action 的解释性策略结果进入轨迹，`run_test` 的实际 `sandbox_report` 进入 Receipt、Tool/Test Event 与 Projection。Web 顶栏显示固定的 Run 权限预设和沙箱 enforcement。模型 provider 网络请求由 Host 发起、位于 child sandbox 之外；`commit_patch` 也仍是 Host 文件操作：`read-only` 在 mutation 前拒绝，默认 `workspace-write` 通过一次性审批 + Workspace capability + Action WAL 保护，`full-write` 不询问但仍不能绕过这些 hard constraint 与完整性边界；
- 另有仅驻留内存的 `LivePublicActivity` SSE 投影：它将真实 Event 的脱敏摘要以 `started / completed / failed` 等状态快速追加到当前对话，不写入第二份 Ledger，也不携带原始 Prompt、模型响应、API Key、隐藏推理或原始工具输出；
- React Web Workbench：Trajectory、Context、Diff、Graph Delta、Test Log；选择某条轨迹事件会进入该 sequence 的只读时间旅行视图，并按该历史前缀加载对应证据；
- 对话页实时显示公开执行进度，包括模型请求阶段、Context 预算/压缩状态和真实的 read/search/tool 事件；最终回答只在完整 `Decision` JSON 校验通过后展示，不传输提供商私有思维链；
- 对架构图、流程图与状态图请求，Model 指令会要求使用语义化 Mermaid；Markdown 中的 Mermaid 代码块由浏览器渲染为 SVG，渲染失败时显示错误与可展开源码；
- 本地仓库只读能力边界、Artifact scope/hash/MIME/大小检查；Artifact root 初始化为 `0700`、data/metadata 文件以 `0600` 创建，并拒绝 symlink root；
- 模型凭据只以 `${secret:NAME}` 引用进入持久化配置；macOS 使用系统 Keychain，非 macOS 使用权限为 `0600` 的私有凭据文件，环境变量凭据保持只读；旧版 `model-config.json` 明文 Key 会在启动时迁移并留下不含密钥值的 `credentials.migrated` 审计事件；
- Event、Artifact 和 Wire Projection 的凭据、本地路径脱敏；常见凭据文件的 read/search 拒绝策略；read/search 的单文件、文件数、总字节、目录深度、截止时间与取消边界。

## 快速运行

要求 Node.js `22.19+` 和 pnpm `11.19.0`。

```bash
pnpm install --frozen-lockfile
pnpm dev
```

五分钟构建并启动本机 Host（`pnpm serve` 会自行执行 build；下面展开写出发布前同样的构建步骤）：

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @tracegraph/cli serve
```

随后打开：

- Web Workbench：`http://127.0.0.1:4310`
- Local Host API：`http://127.0.0.1:4311`

Web 默认使用真实 Live Adapter，经 `@tracegraph/sdk` 连接 Host。先在设置中选择模型提供商，也可以修改预设 Base URL 和模型名，然后创建持久化项目并提交任务。设置页提交的 API Key 是 write-only：浏览器只在本次保存请求中发送它，不写浏览器存储，Host/SDK 响应也不会回显。`.tracegraph/model-config.json` 只保存 `${secret:NAME}` 引用（文件权限 `0600`）；macOS 的值存入系统 Keychain，非 macOS 则存入 `~/.tracegraph/credentials.json`。后者虽强制 `0600`，仍是 plaintext-at-rest 回退，不等同于 OS Keychain。已有凭据时，仅切换同一提供商的模型或 Base URL 不需要再次输入 API Key。

也可以复制 [`.env.example`](.env.example) 为 `.env.local`，优先通过环境变量配置。例如 DeepSeek 只需：

```dotenv
DEEPSEEK_API_KEY=your-key
```

此时使用 DeepSeek 默认预设 `deepseek-v4-flash`；需要更大模型时可再设置 `TRACEGRAPH_MODEL=deepseek-v4-pro`。模型名和可用能力仍以对应账号与提供商为准。

还支持 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GLM_API_KEY`、`QWEN_API_KEY`、`MINIMAX_API_KEY`，以及通用的 `TRACEGRAPH_MODEL_PROVIDER`、`TRACEGRAPH_MODEL_PROTOCOL`、`TRACEGRAPH_MODEL_BASE_URL`、`TRACEGRAPH_MODEL`、`TRACEGRAPH_MODEL_API_KEY`。启动优先级为“环境变量 / `.env.local` > 持久化引用配置 > 未配置”；环境凭据是只读来源，设置页会显示来源并禁止覆盖，需修改环境变量后重启。即使环境配置处于活动状态，启动仍会检查并迁移旧版 `model-config.json` 中的明文 Key，避免遗留明文长期留在磁盘。默认事件、Artifact、Action WAL/Recovery Ledger、Memory record、BM25 索引与 token 校准数据都位于仓库根目录的 `.tracegraph`；G-02 外置原文与 spill 进入 `<dataDir>/artifacts`，Action WAL/恢复尝试分别位于 `<dataDir>/wal` 与 `<dataDir>/recovery`，G-21 canonical Memory 与可重建索引分别位于 `<dataDir>/memory/records.jsonl` 与 `<dataDir>/retrieval-index`。可选 Telemetry 配置固定为 `<dataDir>/telemetry.json`；文件缺失即使用 `noop`，不会仅凭环境变量启用外发。G-17 扩展配置默认为 `<dataDir>/extensions.json`，也可用 `TRACEGRAPH_EXTENSION_CONFIG` / `--extension-config` 指向其它文件。默认 Session 目录为 `~/.tracegraph/sessions`，软删除进入其同级 `sessions-trash`。可用 `TRACEGRAPH_DATA_DIR`、`TRACEGRAPH_SESSION_DIR`、`TRACEGRAPH_ENV_FILE` 或对应 CLI flag 指定绝对路径，但 `dataDir` 与 Session root 是一对：Session 文件没有 ledger locator，不能把同一个 Session root 与多个独立 `dataDir` 共用。使用多个数据目录时应为每个实例同时指定独立、稳定的 `--session-dir`，否则启动恢复会 fail-closed。`.env.local` 和仓库 `.tracegraph/` 均已加入 `.gitignore`。

CLI 不设置检索环境变量时就使用本地 JSONL + BM25。需要单独验证 HTTP seam 时，可在两个终端启动内置检索服务和主 Host；为避免两个进程共享同一个本地 writer，服务端使用独立数据目录：

```bash
# 终端 1：内置服务只监听 loopback；token 可选，但建议显式配置
TRACEGRAPH_RETRIEVAL_DATA_DIR=/absolute/path/to/retrieval-service-data \
TRACEGRAPH_RETRIEVAL_TOKEN=replace-me \
pnpm retrieval:serve

# 终端 2：CLI 保留自己的 <dataDir>/retrieval-index 作为写穿镜像/故障回退
TRACEGRAPH_RETRIEVAL_URL=http://127.0.0.1:4312 \
TRACEGRAPH_RETRIEVAL_TOKEN=replace-me \
TRACEGRAPH_RETRIEVAL_TIMEOUT_MS=10000 \
pnpm serve
```

检索服务公开 strict `GET /health`、`POST /ingest` 与 `POST /search`；`TRACEGRAPH_RETRIEVAL_PORT` 可修改默认端口 `4312`。内置 server 拒绝非 loopback 监听，token 未设置时也只是关闭 bearer 校验，不会扩大监听地址。

显式启用 OTLP-HTTP 的服务端配置示例：

```json
{
  "sink": "otlp_http",
  "endpoint_env": "OTEL_EXPORTER_OTLP_ENDPOINT",
  "authorization_ref": "${secret:TRACEGRAPH_OTLP_AUTH}"
}
```

endpoint 值只从服务端环境读取，authorization 值只经 G-19 CredentialStore 解析；两者都不会出现在 `/api/telemetry-status` 或 Web 设置页中。

G-17 的扩展配置是 data-only 的 strict JSON；文件最大 256 KiB，必须是非 symlink 的普通文件，未知字段、重复项、未知 catalog id 或 `name !== module` 都会拒绝启动。缺失文件会使用两个内置扩展的安全默认值。例如：

```json
{
  "config_version": "tracegraph.extensions-config.v1",
  "extensions": [
    {
      "name": "@tracegraph/builtin-artifact-tools",
      "module": "@tracegraph/builtin-artifact-tools",
      "enabled": true,
      "required": true
    },
    {
      "name": "@tracegraph/builtin-run-state-tools",
      "module": "@tracegraph/builtin-run-state-tools",
      "enabled": true,
      "required": true
    }
  ]
}
```

Host 运行后，可通过 typed SDK 的 `listExtensions()` / `reloadExtension()` / `runExtensionCommand()`，或 CLI 查看、重新加载与调用已注册的有界命令：

```bash
node apps/cli/dist/index.js extensions list
node apps/cli/dist/index.js extensions reload @tracegraph/builtin-artifact-tools
node apps/cli/dist/index.js extensions run <registered-command> [args...]
```

对应 Host 路由是 `GET /api/extensions`、`POST /api/extensions/reload` 与 `POST /api/extensions/commands/:name`；Web 设置页当前提供状态查看与 reload。reload/deactivate 只允许在没有 active Run lease 时进行。这里的 `module` 只是 Host-owned catalog key，不是文件路径或 npm specifier：当前不会 `import()` 仓库里的 JS/TS，也不支持任意第三方插件加载。

G-08 Team 也提供连接已运行 Host 的运维入口：

```bash
node apps/cli/dist/index.js team show <coordinator-run-id>
node apps/cli/dist/index.js team create <coordinator-run-id> --command-id <stable-id>
node apps/cli/dist/index.js team task claim <member-run-id> --task-id <id> --expected-version <n> --command-id <stable-id>
```

`team` 还覆盖 mailbox send/claim、task create/complete/block/cancel/reopen、heartbeat 与 sweep。除只读 `show` 外，每个 mutation 都可带 `--command-id`，用于响应丢失后以相同参数安全重试；`show` 不接受该 flag。完整参数见 `tracegraph team` usage 与 `docs/modules/11-CLI-与装配.md`。

权限预设由本机 Host 控制。CLI flag 优先于环境变量并建立不可热提升的 ceiling；都未设置时 ceiling 为 `workspace-write`：

```bash
pnpm --filter @tracegraph/cli run serve -- --permission-preset workspace-write
```

也可在 `.env.local` 设置 `TRACEGRAPH_PERMISSION_PRESET=read-only|workspace-write|full-write`。Web 设置页的选择写入私有 `~/.tracegraph/harness-config.json`，只能等于或低于 ceiling；项目根的 `.tracegraph/policy.json` 最后叠加且只能收紧。配置变更只影响之后创建的 Run，活动/恢复 Run 使用已经冻结的 effective policy。旧 `--sandbox-mode` / `TRACEGRAPH_SANDBOX_MODE` 仍映射到三种预设以兼容已有启动脚本；新旧配置同时存在且不一致会拒绝启动。受限两档只有在当前平台后端确实生效时才允许 `run_test` 启动；`full-write` 会在 durable 轨迹与 Web 红色徽标中明确显示 `enforcement:none`，不能把它理解成“沙箱已开启”。

Rollback 策略默认为关闭。需要通过 API/SDK 做显式回滚时，在 `.env.local` 中设置：

```dotenv
# disposable workspace 也只有在此开关为 true 时才能回滚
TRACEGRAPH_ROLLBACK_ENABLED=true
# managed / read-write linked workspace 还要求此项为 true，且请求 force=true
TRACEGRAPH_ROLLBACK_ALLOW_FORCE=true
```

第二个开关不会单独启用 rollback，也不会放宽 workspace 绑定、quiescent Run、verified WAL、单目标或 after-hash 校验。

如果运行反复进行仓库搜索、读取而没有返回最终 Decision，可以在 `.env.local` 提高编排轮次，例如 `TRACEGRAPH_MAX_TURNS=24`。这只提高模型/工具循环次数，不会提高 `258K` Context 窗口或提供商的输出上限；页面会同时显示两种预算，失败事件会明确标注触发的是哪一种。

只读查看一个本地 TS/JS 仓库时，分别启动 Host 和 Web：

```bash
pnpm build
pnpm --filter @tracegraph/cli run serve -- --readonly /absolute/repository/path
pnpm --filter @tracegraph/web run dev
```

## 验证

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm evals
pnpm coverage
pnpm supply-chain:check
pnpm release:check
```

自动化验证覆盖 G-01 的 v0→v1 迁移、半行尾部修复、跨进程单写者租约冲突、重启中断标记、待审批恢复与连续序号，G-02 的策略顺序与开关、结构化摘要、usage、失败降级、原文外置/hash 回读、超长输入预算与 Web 原文查看，G-03 的 provider/model 校准、可选 counter 降级、JSON/SSE usage 解析、durable usage/anomaly 事件及 Web 历史配对，G-04 的 WAL phase/私有 before-image、崩溃注入窗口、重启 hash 对账、分歧不自动覆盖与显式回滚拒绝，G-05 的 strict Tool contract、批预校验/并发保序、timeout/进程树回收、不可逆 Patch cancellation shield 与当前 Run Artifact 发现，G-06 的预设/规则排序/hard constraint、配置 ceiling 与项目只收紧、action/policy digest、一次性 token、fail-closed answerer、冻结恢复及 Host/SDK/Web 有界配置，G-07 的可信 profile/authority 防夹带、独立 child Run/Session、step/token/depth/parallel/tool allowlist 硬门、父侧 6-event 双 child 投影、重启时已终态 child 补回执/未终态 descendants 递归取消、recovery v5、Host `run.created` provenance 复核与 Web stale child cache 淘汰，G-08 的 root-ledger roster/mailbox/task board 重放、worker authority 绑定、mailbox 重启持久性、optimistic-version 单 owner、显式 heartbeat/sweep、失联与 claimed task reopen 原子性、无自动重派，以及 Host/SDK/Web 用户 steer/取消边界，G-09 的 Todo strict/闭环路径/证据约束、Plan 写工具无副作用拒绝、revision-bound 审批、同 Run 继续、重启恢复与 Host/SDK/Web 全链，G-13 的三档契约、Seatbelt profile/路径防逃逸/禁网、缺后端 fail-closed、Runtime durable 报告与 Web 徽标，G-14 的 strict mailbox、namespaced/durable 幂等、普通输入逐安全点 FIFO、cancel 抢占与 authority gate、turn-budget/finish 竞态、工具中取消、重启崩溃窗、lost-response retry、旧投影/跨 Run 晚响应隔离及 Host/SDK/Web 排队闭环，G-15 的三类 sink conformance、默认零网络、strict 服务端配置/G-19 authorization、提交后白名单派生、sink 失败隔离、终态/关停 flush 及 Host/SDK/Web 只读状态，G-16 的 5 条基础行为回归、质量对比、文档一致性与四项性能门，G-17 的 API/config contract、六个可逆 seam、激活/卸载/reload rollback、Run lease/recovery v5、内置工具组迁移、`extension.error` 隔离以及 Host/SDK/CLI/Web 控制面，G-18 的两阶段 staging/claim、大小/MIME/hash/scope、默认 offload/显式 inline、unsupported model 零图片 block、PDF `reference_only` 降级、v7 rollout 与当前 v8 replay 兼容以及 Host/SDK/Web 闭环，G-19 的 secret-reference、Keychain/私有文件、迁移与全链脱敏，G-21 的 Markdown 分块/代码围栏、原子 JSONL 恢复、项目隔离、BM25 排名/引用回读、候选拒绝与幂等恢复、自动 Context 注入、可选服务鉴权/超时/fallback，以及真实生产检索包“有/无检索”质量对比，G-22 的 clean build、覆盖率失败注入、锁文件/供应链失败注入、工作流/文档审计和私有发布 staging，以及 G-23 的逐序列确定性回放、snapshot hash、正反向 diff、replay authority 隔离、竞态淘汰与 Web 步进；也覆盖本地目录登记、Plain Chat 能力隔离、推理强度和公开 SSE 投影。CLI 纵向 `test:e2e` 仍覆盖 `SDK → Host → Runtime → Approval → Patch → Test → Graph Delta`；`pnpm evals` 在离线守卫下独立运行，不替代单测/E2E。工作流配置与同构命令已在本地验证，但 GitHub-hosted run URL 仍需代码进入远端后取得，不能用本地结果冒充。文件到断言映射见 [`docs/verification-map.md`](docs/verification-map.md)。

## 项目模式

| 模式 | 当前能力 | 安全边界 |
|---|---|---|
| Plain Chat | 不选择项目即可多轮问答、公开执行进度、Markdown/Mermaid 输出；可分页回读当前 Run 自己的压缩 archive | 隐藏工作区的所有文件与命令能力均关闭；`read_artifact` 不是工作区读权限，不能读取或修改本机项目或其它 Run |
| Managed Project | 持久化项目、真实模型问答、read/search、创建或修改文件、Preview/Approval、Graph Delta | 位于 `.tracegraph/projects`；默认 `workspace-write` 下写入需一次性审批，`read-only` 禁写，显式 `full-write` 不询问但仍受 Workspace/schema/WAL 约束；API Key 只由本机 Host 解析 |
| Linked Local Folder | 由本机原生目录选择器打开已有目录；可选读写或只读；显示并可在系统文件管理器中定位目录 | 浏览器不能提交任意路径；Host 规范化并登记目录；Workspace capability 与 G-06 hard constraint 不可被 preset/rule 提权，默认 `workspace-write` 写入需一次性审批 |

原生选择过的目录登记在 `.tracegraph/local-projects.json`，Host 重启后会恢复可用项目。左侧项目列表提供移除操作：本机目录只撤销 TraceGraph 登记、不删除真实目录；由 Host 创建的托管项目会在确认后删除其 `.tracegraph/projects` 下的项目副本。目录被外部删除、移动或撤销权限后，Host 会跳过不可用记录并报告告警，不会把失效路径伪装成可用项目。

## 工程结构

```text
apps/web              React/Vite Web Workbench
apps/cli              Composition Root 与 Host 启动
apps/retrieval-service 可选 loopback HTTP 检索服务与 strict client
packages/contracts    Canonical/Wire Zod Contracts
packages/core         Runtime、Extension Manager、Context、Policy、Tools、Ledger、Artifacts、Session Store/Recovery
packages/retrieval    Markdown chunk、原子 JSONL 索引、本地 BM25 与原文回读
packages/telemetry    Vendor-neutral Telemetry、noop/memory/OTLP-HTTP sink 与 conformance suite
packages/codegraph    TS/JS 静态 Module Graph
packages/host         Fastify Command/Query/Artifact/SSE 边界
packages/sdk          Typed TypeScript Client
packages/test-support Fixture、纵向集成测试与有界 ScriptedMockProvider
evals/                G-07/G-16/G-17/G-18/G-21/G-22/G-23 离线行为、扩展、检索质量、性能、文档、发布一致性与时间旅行评测
examples/             内置 failing TypeScript repository
```

## 文档

- [模块 01–17：架构与实现说明](docs/modules/01-契约层-contracts.md)
- [评测体系](docs/modules/12-评测体系.md)
- [Agent Runtime](docs/modules/02-Agent-Runtime.md)
- [证据链：Ledger / Projection / Artifact](docs/modules/05-证据链-账本投影工件.md)
- [Host 与 SDK](docs/modules/09-Host-与-SDK-接口层.md)
- [Web 工作台](docs/modules/10-Web-工作台.md)
- [CLI 与装配](docs/modules/11-CLI-与装配.md)
- [工程化与发布](docs/modules/13-工程化与发布.md)
- [附件与多模态](docs/modules/14-附件与多模态.md)
- [插件与扩展系统](docs/modules/15-插件与扩展系统.md)
- [Agent Team](docs/modules/16-Agent-Team.md)
- [Skill 系统](docs/modules/17-Skill系统.md)
- [LSP 客户端](docs/modules/19-LSP客户端.md)
- [能力差距对标与补强路线图](docs/12-能力差距对标与补强路线图.md)
- [G-01/G-02/G-03/G-04/G-05/G-06/G-07/G-08/G-09/G-12/G-13/G-14/G-15/G-16/G-17/G-18/G-19/G-21/G-22/G-23 验证映射](docs/verification-map.md)
- [已知限制](KNOWN_LIMITATIONS.md)

## 边界声明

G-14 的 mailbox 是当前 Host 进程内、按 Run 串行协调的输入控制面，不是跨 Host 消息队列或 Team inbox。普通 `message` / `approve_hint` 每个模型 step 最多消费一条；`approve_hint` 只作为下一次模型 history 的用户提示，不会批准 Plan、Patch 或签发 G-06 token。`cancel` 是高优先级控制输入，可以越过更早的普通 pending message；因此终态投影可能如实保留未投递消息。重启会保留队列，但 G-01 的普通 `interrupted` Run 仍只读恢复，不会仅因有 pending input 就自动重跑 Model/Tool；唯一例外是崩溃前已 durable 排入的 cancel，可由显式 resume 仅执行最小 consume+cancel 终结。取消不等于事务回滚：已提交 Patch 继续由 G-04 WAL 表示，若需要回滚必须另走显式且默认关闭的 rollback API。

G-15 Telemetry 只观察已经提交的 canonical Event：Ledger 才是恢复、审计与 Projection 的事实源。默认 `noop` 不产生网络流量；OTLP 队列、错误计数和最后错误时间只在当前进程内，重启不会恢复。导出为 best-effort：只有网络/超时失败以及 HTTP `429/502/503/504` 会将对应 signal 重排到有界内存队列；`400` 等不可重试响应和 HTTP 200 `partialSuccess` 拒收会计错但丢弃该批，避免 poison batch 阻塞后续交付。非 200 响应不读正文；HTTP 200 正文最多读取 64 KiB 以检查 rejected count，正文/错误消息不回显。当前没有自动 retry/backoff、持久队列、完整 OpenTelemetry SDK/processor/propagation/sampling，也尚未用真实外部 collector 做集成验证；被保留的可重试批次在后续手动/terminal flush 中可能重复发送。CLI 关停会先 close Host，再给 Telemetry flush 最多 5 秒总等待预算，超时即继续关停。Telemetry 状态是浏览器只读诊断，不是恢复输入，也不会暴露 endpoint、authorization 或 payload。

G-16 评测是开发期离线回归面，不是生产运行时能力或新的事实账本。原有 `memory-context-quality.eval.ts` 仍用受控记录隔离评测 Context 决策；G-21 新增的 `retrieval-rag-quality.eval.ts` 则直接执行生产 `packages/retrieval` 的 ingest/search/read-back 链并比较有/无检索，但固定三条本地任务的 `0→1` 成功率与引用准确率不是通用 RAG benchmark、真实模型效果或线上指标。CodeGraph 用例同样只是确定性代理。Tool P95 和 SSE 首字节基线预留本地 scheduler/startup 余量，只用于回归报警，不构成 SLA。G-22 已把离线 eval/performance/docs gate 接入 `evals` CI job，并另设覆盖率、供应链和发布门；当前仍没有 Playwright 真实浏览器或真实 provider/Collector 评测，且本地工作树不能替代 GitHub-hosted run URL。性能基线只允许显式 update mode 改写，任何更改都应评审。

G-17 是 Host/Core 信任边界内的能力组装层，不是第三方代码安全沙箱。`extensions.json` 的 `module` 字段只匹配编译进 CLI 的 trusted catalog；它不会加载 npm 包、本机路径或项目内 `tracegraph.config.ts`，也没有插件签名、进程隔离、扩展 UI 注入或活动 Run HMR。idle-only reload 只影响之后取得新 lease 的 Run；恢复中的旧 Run 必须精确匹配其 recovery v5 extension snapshot。受信进程内扩展代码与 Host 同权，`registerTool` 只保证进入标准 schema/Policy/Receipt/Observation 路径，不会自动产生 OS Sandbox、Action WAL 或外部系统崩溃对账；当前 catalog 只含 read/none Tool。G-10 Skill 已作为独立的本地 `SKILL.md` 数据目录实现，但不支持网络/npm 安装、脚本执行、签名分发或跨 Host registry；G-11 MCP 仍只开放 stdio/native bridge，G-12 LSP 已接入原生 stdio seam，但 PTC、HTTP/SSE、完整 workspace indexing、自动 Context 注入、远程 registry 和代码图 `code_intel` 合并仍未开放。

G-21 当前实现的是**词法 BM25**，不是 embedding/向量语义检索：同义改写、跨语言语义匹配和领域 reranker 均不在当前能力内。JSONL 索引是 canonical Memory record 的可重建投影，不取代 Event Ledger 或 `<dataDir>/memory/records.jsonl`；package 的写队列只协调同一进程，不能把多个进程直接指向同一个索引目录。CLI 已自动在每轮模型请求前 recall，但新增 Memory candidate 目前只通过 Core Runtime `remember()` 接缝进入，尚无 Host/SDK/Web 的用户写入入口或模型自动记忆策略。内置 retrieval-service 只监听 loopback，仍使用同一个本地 BM25 backend，不代表 Qdrant、分布式检索、多租户 RBAC 或生产部署。

G-23 回放只对 canonical Ledger → `RunProjection` 做按序列重建与哈希承诺，不会重新执行 Model/Tool，也不会把 Web 的连接状态、项目列表、volatile model surface 或异步 Artifact 展示状态纳入 snapshot hash。进入 Replay 只停止当前页面的订阅与写入口，不会暂停后台 Agent，也不会撤销其它客户端持有的 live bearer。当前没有从历史节点 fork、跨 Run 合并时间线或持久化浏览器 replay cursor；真实 Playwright 浏览器 E2E 仍未实现。

G-18 附件只绑定**下一项新任务**，运行中 SteeringComposer 不接受附件；Replay 可重放附件 metadata/status，但不提供二进制预览，也不会再次把历史图片发给模型。当前只支持 PNG/JPEG/PDF，默认每个 5 MiB、每 Run 8 个；Host 的 6 MiB 只是允许业务层把轻微超限写成 durable rejection 的 transport hard cap，不是产品额度。PDF 提取器只做保守 literal-text 提取，不做 OCR，失败时原文件仅作 reference。模型图片能力必须由 Host 用 `TRACEGRAPH_MODEL_IMAGE_INPUT=true|1` 显式启用，默认 false，不能从模型名自动推断。

G-13 不是整个 Host、模型网络或所有文件操作的生产级容器：当前只有 `run_test` 子进程进入 OS boundary。macOS Seatbelt 可在探测成功时对受限模式执行 workspace 文件范围与禁网；Linux bwrap runner、Windows backend、宿主网络白名单代理尚未实现，故 Linux/Windows 受限执行会以 `none + unmet_constraints` 拒绝启动。`full-write` / `danger-full-access` 是显式关闭 OS 沙箱，仍保留无 shell、环境白名单、时长/输出与进程终止边界。G-06 的 token 是 policy `ask` 路径上的 Host 进程内 opaque one-shot capability，不是跨进程签名凭证；重启后待批动作重新审批。policy `allow`（包括未被规则收紧的 `full-write`）不会签发 token 或记录虚假的 approval request/grant。G-09 的 Plan 审批不是一次性 Tool token：它只把同一 Run 从只读规划状态转到 execute，之后每个写动作仍要独立经过 G-06 策略/审批与 G-04 WAL。Plan 等待期的 Todo 变更会产生新 `plan.ready` revision，旧 `plan_event_id` 不能批准变更后的计划。策略 `path_glob` 匹配 workspace-relative 逻辑路径，真实路径/symlink containment 与敏感文件仍在 Tool/Workspace 边界复核，且策略检查本身不能消除外部文件变化造成的 TOCTOU。`commit_patch` 留在 Host：所有分支都有 Workspace capability、canonical action/policy digest、hash 与 WAL；只有 `ask` 分支额外使用 one-shot approval。模型 provider `fetch` 也由 Host 执行，不受 child network deny 约束。`258K` 是 Harness 的默认 Context Policy，不是所有提供商/模型都已验证接受的输入上限。默认 preflight 仍从 `heuristic_v2` 起步，并用 provider/model 的历史回报校准；仓库没有内置 tokenizer 或 Anthropic `count_tokens` 适配器。即使注入能精确分词单个片段的 `TokenCounter`，它看到的也只是交给 meter 的 section 文本，不包含 provider system prompt、JSON envelope、`[section]` 前缀/分隔符等完整 wire framing；因此当前 preflight confidence 仍是 `estimated`，有历史 usage 后才是 `calibrated`，`exact` 保留给未来覆盖 canonical full-wire request 的实现。只有调用结束后的 provider-reported total 可按提供商回报口径展示，逐 section 始终是 preflight 分配。成本也只在 provider 明确同时返回金额与币种时可用，不做本地价格推算。已实现的“实时”是安全公开的 SSE 执行活动和 durable Context/Tool/usage 事实；模型返回的结构化 `Decision` 仍须整体校验后才能进入 Ledger，因此尚无提供商 token 级回答正文流式输出，也没有公开 `reasoning_content`/私有 CoT。G-05 的通用 Tool timeout 会及时结束 Runtime 等待并传递 AbortSignal，但任意忽略取消的第三方执行器仍可能在后台继续；内置 `run_test` 在 POSIX 上通过 SIGTERM→SIGKILL 回收整个进程组，Windows 仍只保证直接子进程。批调度与 per-run Event/Session append 队列只在进程内协调；Artifact、Memory Store 与 retrieval index 是各自有界的 durable 文件边界，也没有跨进程协调，它们都不是跨 Host 的锁。G-08 已在 G-07 的同步阻塞 spawn 上增加 durable roster/mailbox/task board/heartbeat/sweep，但没有跨 Host consensus、自动重启旧 worker、自动任务重派或通用非阻塞父循环；单个 spawn 仍等 child 终态，Team 并行只来自 G-05 batch 与 G-07 permit。G-11 MCP、Langfuse、模型连通性测试和**非 Patch 工具/外部系统的通用副作用对账**仍未实现。G-04 只保护 `commit_patch`：启动对账依赖仍已注册的可信工作区，rollback 默认关闭、仅单目标、永不覆盖 after-hash 不匹配的文件，也没有跨进程 target lock。G-01 的普通中断恢复仍不会自动续跑模型或工具。Mermaid 是可检查的 SVG 图表能力，不是通用图片生成服务。完整边界见 [Known Limitations](KNOWN_LIMITATIONS.md)。

G-11/G-12 状态更正：Host-owned stdio/native MCP 与原生 stdio LSP client 已接入；上文限制中的“未实现”仅指 MCP 的 PTC/HTTP/SSE/resources/instructions、LSP 的完整索引/自动 Context 注入/代码图合并，以及通用外部副作用对账，不覆盖已交付的 native bridge。

本项目是独立实现，不复制 DeepSeek Harness、Claude Code、Codex、Pi 或其他产品的源码与品牌界面。源码采用 MIT License。
