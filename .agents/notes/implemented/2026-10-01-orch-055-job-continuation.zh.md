---
id: 2026-10-01-orch-055-job-continuation
title: 恢复 settlement 后台 Job，并区分命令接纳与执行完成
status: implemented
owners: [workflow-jobs, memory, runtime]
created: 2026-10-01
last_reviewed: 2026-10-01
affects: [memory-background-jobs, runtime, evidence-ledger]
supersedes: []
language: zh-CN
---

# Agent Note：恢复 settlement 后台 Job，并区分命令接纳与执行完成

## 问题

异步命令得到接纳回执，不代表后台工作已完成。Host 也可能在来源 Run settlement 后、worker 入队前退出，或在 extraction 进行时退出。恢复必须从规范证据推导待办工作、以幂等方式重试，并让需要审核的输出与 Job 完成保持区分。

## 当前状态

仓库已有一个 bounded 的 settlement 后台 Job 切片：[`MemoryBackgroundPipeline`](../../../packages/core/src/domains/memory/memory-background-pipeline.ts)。Job 来源是 Evidence Ledger 中的 Run 终态。V2 candidate 和 control facts 经 `MemoryControlService` 写入，并保持待审核状态。Runtime 启动路由返回当前 `RunProjection`；公开 Run status schema 没有 `accepted` 终态。CLI 端到端测试先观察到 start 返回 `indexing|running`，随后才观察审批/完成状态。

## 已实现决策

- 以 Run Ledger 中的 terminal Event 作为提取工作是否存在的依据。启动恢复按有界批次扫描 terminal Run ID，因此 terminal append 后、queue insertion 前崩溃也不会丢失 Job。
- 每 Run Job 文件只作为无内容的 operational projection，不新建第二条业务 Event 流。它记录 `waiting`、`running`、`retry`、`complete` 或 `exhausted`，以及来源摘要、尝试次数、重试时间、candidate 数量和安全错误码。
- 调用 extractor 前先写 `running`。重启遇到遗留 `running` 会重新入队；owner lease 防止并发提取。关停/失败后最多重试 5 次，使用指数退避。稳定的 extractor/Episode/candidate slot 命令 ID 让部分 candidate 写入后的重放保持幂等。
- 所有 candidate 写入成功返回后才标记 Job `complete`。这只表示提取和 candidate 创建结束；生成的 Memory 仍是 `candidate`，需要独立的用户审核转移才能激活。
- 命令传输成功和当前 Run 投影只代表接纳或观察，不等于业务完成。Run 终态仍需要规范 terminal Event；不会把 `accepted` 响应转换成 `completed`。
- 本切片用现有的单 Run Memory Episode Job 满足 ORCH-055 对可恢复后台工作的验收，不声称通用 Workflow DAG runner 或独立 operation 查询资源已经交付。

## 考虑过的备选方案

- 在 canonical Run 和 Memory Ledger 之外新增第二套 Job Event journal：本切片不采用，因为这会复制生命周期证据并增加新的写者与恢复格式。Operational Job 状态从来源 Run Event 和幂等 Memory 命令恢复。
- 把 HTTP 成功、排入队列或 `running` 当作完成：不采用，因为这些都不能证明 durable candidate 命令已完成。

## 不变量与边界

- 只有经过校验的 Run terminal stream 才能提取；重试期间来源摘要保持固定。
- 同一 owner 的活动 lease 会串行化本机多个 Host process 的提取；它不是分布式 Workflow scheduler。
- Job state 不保存提取出的 claim 文本；candidate store 与规范 Memory control Ledger 分别拥有正文和审核事实。
- `complete` 表示操作结束，不表示 candidate 已接受、审核、激活或被模型使用。

## 迁移与回滚

现有 `tracegraph.memory-background-job.v1` operational record 新增可选状态 `running`。原有 `waiting`、`retry`、`complete`、`exhausted` 记录仍有效。重启时 `running` 会被当作可恢复工作；稳定 candidate command ID 保护部分输出。回退测试和文档无需迁移数据；关闭 extraction 不会删除 canonical Run terminal 或已存在的待审核 candidate facts。

## 验收标准

- [x] 即使崩溃发生在入队前，也能通过 terminal Run inventory 找回任务。
- [x] 执行中的 Job 有明确 `running` 状态；重启会重新入队，不会跳过并误记为完成。
- [x] 中断提取不会创建 candidate；恢复后只创建一个幂等、待审核 candidate，再将 Job 置为 complete。
- [x] 启动响应/当前投影、Job 完成与 candidate 审核状态相互区分。
- [x] 定向 Job 测试、CLI Run 启动/终态行为及 owner 文档一致。

## 证据

- 实现：[`memory-background-pipeline.ts`](../../../packages/core/src/domains/memory/memory-background-pipeline.ts)、[`memory-control.ts`](../../../packages/core/src/domains/memory/memory-control.ts)、[`runtime.ts`](../../../packages/core/src/domains/runtime/runtime.ts) 与 [`RunProjection` status 契约](../../../packages/contracts/src/projection.ts)。
- 测试：[`memory-background-pipeline.test.ts`](../../../packages/core/src/domains/memory/memory-background-pipeline.test.ts) 覆盖 terminal inventory 恢复、stale `running` 恢复、重试/幂等、lease 串行与关停；[`e2e.test.ts`](../../../apps/cli/src/e2e.test.ts) 验证 Run 状态与后续完成状态不同。
- 验证：Core Memory Episode/Job/Runtime 测试通过（3 个文件 / 13 项）；CLI 端到端测试通过（1 个文件 / 4 项）。Core build 与测试类型检查通过。`verify:v2-docs`、`graph:modules:check`、`verify:boundaries`、`verify:invariants`、`verify:package-readmes` 和 `git diff --check` 均通过。
- 文档：[`08-Memory-记忆子系统.md`](../../../docs/modules/08-Memory-记忆子系统.md)、[`02-Agent-Runtime.md`](../../../docs/modules/02-Agent-Runtime.md) 和[实现路线图](../../../docs/outlive-agent-v2/09-implementation-roadmap/README.md)。

## 延后范围

通用 Workflow definition/依赖图、独立持久化 operation resource/查询 API、客户端 cursor continuation、Workflow 级 retry/verifier/compensation 策略，以及 detached Subagent ownership。
