---
id: 2026-09-30-mem-043-episode-consolidation
title: 从已 settlement 的 Run 经历派生待审核 Memory Candidate
status: implemented
owners: [memory, contracts, evidence, runtime]
created: 2026-09-30
last_reviewed: 2026-09-30
affects: [memory-episodes, memory-background-pipeline, memory-control, evidence-ledger]
supersedes: []
---

# Agent Note：从已结束 Run 的 Episode 派生待审核 Memory Candidate

> 后续闭环（2026-10-03）：确定性跨 Run candidate/diff 和持久任务状态 UI 已由 [MEM-043 闭环 Note](2026-10-03-mem-043-cross-run-job-control.zh.md) 交付。以下 deferred 描述保留 2026-09-30 首个切片的历史范围。

## 问题

MEM-040–046 已提供 V2 契约、来源、生命周期、冲突/反馈治理和可见候选控制面。MEM-043 增加了首个纵向切片，从已结束 Run 证据生成有界 Episode 投影与待审核候选。提取不能延长 Run settlement、改写 active Memory，也不能建立第二个权威 Ledger。

## 当前状态

- Run 事实存放在 canonical Evidence Ledger；`run.completed`、`run.failed`、`run.cancelled` 是 settlement 边界。
- V2 candidate seed 是不可变本地负载；控制/生命周期事实进入同一个 Evidence Ledger，状态通过 replay 得出。
- Core 现有确定性的单 Run/单 terminal Episode projector，并校验完整事件流/hash chain。Episode 是投影，不是单独持久化的 canonical record。
- settlement 后的 owner-scoped worker 保存不含正文的每 Run 运维状态，使用进程内队列与跨进程 owner 租约；启动时以 32 个 Run ID 为批次流式恢复，最多尝试 5 次并指数退避。
- 可选 ModelAdapter 只接收有界、脱敏、allowlist 后的事件 JSON。返回候选只能引用实际发送给模型的行，并在 Memory 控制面创建候选前重新对照 canonical Run Ledger 校验。
- focused 和 Runtime 行为验证已通过：覆盖 projector 身份/结果/有界输入、恢复/重试/幂等、跨进程与过期租约、来源摘要不匹配/证据删除及 shutdown 取消时 fail-closed，以及 settlement 后提取、审核门、重复无操作和 V2 Recall 保持关闭的 Runtime 纵向流程。
- G-21 V1 `remember()`/`recall()` 仍是当前 Runtime 行为，V2 Recall 未接入。Experience Case、跨 Run consolidation、独立持久化 Episode/任务状态界面仍留待后续任务。
- G-21 V1 `remember()`/`recall()` 仍是当前 Runtime 行为；V2 Recall 尚未接入。

## 提案

- 增加严格的 Run 事件证据引用与 Episode 投影契约。Episode 从完整校验且已结束的 Run stream 确定性重建，不成为 Run 事实的第二真源。
- 在 settlement 后通过进程内队列调度有界提取；只持久化可重建的任务状态、租约到期（文件 mtime）、重试时间和来源摘要。启动时流式分批扫描 terminal Run ID，修复“提交 terminal 后、入队前崩溃”的窗口。
- 使用可选的 `ModelAdapter` 提取能力。它只接收有界、脱敏、字段白名单筛选后的来源投影，并将其视为不可信数据；Core 必须依据确切事件引用校验返回的候选。没有该能力时只生成 Episode，不生成 Candidate，也不影响 Run。
- 通过 `MemoryControlService` 与 canonical Memory 控制流创建派生候选。派生候选事实记录系统 extractor 与 Episode 身份，不复制 claim 正文。所有候选仍须审核，默认禁用模型使用/导出，不开启 V2 Recall。
- consolidation 限定为按 scope 确定性处理：相同 claim/key 是无操作；显式相同 key 的不同 claim 会创建带关联 lineage 的另一个候选，由 MEM-045 展示冲突。不会自动编辑或 supersede active 记录。
- 用稳定的提取版本 + Episode + candidate 槽位作为幂等身份；同一槽位重试结果发生变化时 fail closed，不创建另一条候选。限制事件、输出数量/大小、并发任务、尝试次数、租约时长和指数退避。引用无效时 fail closed，任务状态不保留派生 claim 正文。

## 考虑过的备选方案

- 把 Episode 保存为第二种 canonical event：拒绝，因为 Run 事实已经由 Evidence Ledger 保存；Episode 是投影。
- 在追加 Run terminal 前同步调用 extractor：拒绝，避免网络/模型延迟或失败阻塞 settlement。
- 复用 V1 `remember()` 或静默修改 active V2 记录：拒绝，因为会绕过 V2 审核控制面和不可变候选生命周期。
- 缺少 adapter 能力时仍调用模型提取：拒绝；提取是可选的，失败不改变 Run 结果。

## 不变量与边界

- 只能投影通过 hash 校验且已 terminal 的 Run stream。每条 Candidate evidence ref 必须精确指向该 stream 中的事件，并保留 project、Run、Session、sequence 和 hash 身份。
- 模型输出是不可信输入。它不能选择 owner、actor、project、scope、source trust、consent、active 状态或模型使用/导出策略。
- Extractor 只接收有界、脱敏的事件字段；来源 claim 和 provider 输出不得复制进任务元数据或不含正文的 Ledger 事实。
- 每条派生 Memory 初始状态都是 candidate，进入现有审核界面，必须由用户显式生命周期命令后才能激活。V2 自动 Recall 仍默认关闭。
- 按 scope 的 consolidation 由租约串行化；重试有界且幂等。失去租约不得重复创建 Candidate 或改变 active Memory。
- 不迁移或改写 G-21 V1 store、Recall 或 Run 事件历史。

## 迁移与回滚

不改写现存 Memory 或 Run 数据。队列和 Episode 投影可由 terminal Run stream 重建；Candidate 创建通过稳定 command ID 保持幂等。回滚可停止调度或禁用可选 extractor，但须保留已提交 Candidate seed 与 Ledger 事实。删除派生候选使用 MEM-046 的 review/revoke/delete 控制，不通过清空任务队列完成。

## 验收标准

- [x] Episode/evidence/extractor 契约严格验证身份、有界性、成功/失败/放弃结果和确切来源引用。
- [x] terminal Run 调度为 fire-and-forget；启动修复有界；租约、重试退避与幂等支持重启恢复。
- [x] 提取和确定性 consolidation 只创建可检查的 V2 Candidate；重复重放无副作用，active 记录不变。
- [x] Candidate record 与 control fact 保留来源，但 append-only fact 不复制 claim；默认禁用模型使用/导出。
- [x] 失败、过期租约、shutdown 取消、来源不匹配/删除、错误证据输出、重复和冲突 claim 均 fail closed。
- [x] Focused、Runtime 集成验证和 Memory/roadmap 文档与实际行为一致；已区分当前单 Run 切片与后续跨 Run、Experience Case 范围。

## 风险与未决问题

- 模型辅助提取会增加后台 Provider 请求与费用。装配层必须仅暴露明确可用的提取能力，且不能超过持久化重试上限。
- 没有安全候选的 Episode 是成功无操作，不是提取失败。
- Experience Case 生成和索引更新属于后续任务；本管线不新增平行检索索引。

## 证据

- 实现：`packages/contracts/src/memory-episode.ts`、`packages/core/src/domains/memory/memory-episode.ts`、`packages/core/src/domains/memory/memory-background-pipeline.ts`、`packages/core/src/domains/memory/memory-control.ts`、`packages/core/src/domains/runtime/runtime.ts`、`packages/evidence/src/event-ledger.ts`。
- 测试：新增 `packages/core/src/domains/memory/memory-episode.test.ts`、`packages/core/src/domains/memory/memory-background-pipeline.test.ts`、`packages/core/src/domains/runtime/runtime.memory-episode.test.ts`，共 12 项 focused/Runtime 用例。覆盖 terminal/hash 校验与 Episode outcome、有界脱敏引用、重启恢复、部分提交后的重试、owner lease 串行与过期接管、来源摘要不匹配/删除、取消、审核门、冲突 lineage、重复无操作和 V2 Recall 保持关闭。
- 验证：`env -u NODE_OPTIONS pnpm --filter @tracegraph/core exec vitest run src/domains/memory/memory-episode.test.ts src/domains/memory/memory-background-pipeline.test.ts src/domains/runtime/runtime.memory-episode.test.ts` 通过（3 个文件、12 项测试）；`env -u NODE_OPTIONS pnpm --filter @tracegraph/core typecheck` 通过；`env -u NODE_OPTIONS pnpm run verify:v2-docs` 通过（11 份文档、62 个路线图任务）；`git diff --check` 通过。
