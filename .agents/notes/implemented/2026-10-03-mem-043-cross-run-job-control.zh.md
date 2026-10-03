---
id: 2026-10-03-mem-043-cross-run-job-control
title: 跨 Run 候选归并与后台任务状态可检查
status: implemented
owners: [memory, contracts, workbench]
created: 2026-10-03
last_reviewed: 2026-10-03
affects: [memory-background-pipeline, memory-control, workbench]
supersedes: []
---

# Agent Note：跨 Run 候选归并与后台任务状态可检查

## 问题

MEM-043 原有单 Run Episode 和候选匹配，但跨 Run 的去重/对照决策没有独立结果，持久任务文件也没有客户端展示。

## 当前状态

owner lease 串行化提取，五次有界重试和稳定命令身份可恢复。Run 和 Memory 控制事实仍在 Evidence Ledger。job v2 新增无正文的结果引用和 request digest；v1 兼容读取并明确标注无差异明细。共享 Memory controller 为 Web/Desktop 返回记录、冲突和 project scope 内任务。

## 决策

Core 对同 owner/project 内已提交、来源有效的历史 Memory 做确定性归并。kind/key/claim 完全一致产生 unchanged；证据支持的相同 key 但 claim 不同产生候选及对照 lineage。撤销、过期、拒绝、不可信、未提交、删除、越界或来源无效的记录不得成为归并依据。每个完成 slot 都持久化有界且不含正文的结果引用，经既有 Memory list 协议返回 scope 过滤后的状态。独立 UI 展示 waiting/running/retry/complete/exhausted、已结束尝试次数、错误码、候选及来源 Run IDs，并用现有可见记录展示前后对照。

已交付：确定性跨 Run candidate/diff 和可检查持久任务状态。库存文件名恢复为 canonical 事件中的 Run ID（含 `run:UUID`）；重试不能改变或省略已提交 slot，部分结果在模型取消配置和重试期间保留。错误码使用显式白名单。后续：语义模型跨 Run 综合、调度控制、独立 canonical Episode 存储。

## 替代方案

不增加平行 canonical consolidation event store；复用既有 immutable candidate seeds 和控制/lifecycle journal。绝不静默改写 active Memory。

## 不变量与边界

owner/project scope 和 canonical source 校验仍拥有决定权。归并不激活、改写或 supersede Memory。job 仅保存 ID/digest/count/code，不保存 claim、摘要或异常正文。列表字段为可选增量，兼容旧列表和 v1 job。

## 迁移与回滚

旧 v1 job 以 `resultDetailsAvailable: false` 显式标注无差异详情；旧 proposal count 不标成新增候选数。新写入使用 v2。Memory 记录不迁移。若回滚到旧 reader，先停止 worker，保留 canonical Run/Memory 数据，仅移除 v2 operational job 文件再从已结算 Run 重建；稳定 Memory command IDs 阻止重复创建已提交候选。

## 验收

- [x] 两个以上已结算 Run 证明 unchanged 与 changed-key outcome，active 原文不变。
- [x] 越界、未提交、来源无效和 revoked 记录不能参与。
- [x] 重启恢复任务，waiting/retry/exhausted 可检查且不含正文。
- [x] 共享协议和独立 UI 可查看 scope 内任务。
- [x] 窄测试、类型检查和当前 Memory 文档一致。

## 风险与未决问题

精确匹配不声称语义等价。状态面仅提供最近最多 100 个任务；[有界任务索引后续 Note](2026-10-03-mem-043-bounded-job-index.zh.md) 明确后台恢复、历史 loading 与用户纠正来源链。独立 canonical Episode 存储、语义综合及人工调度控制仍未交付。

## 证据

- 实现：[控制服务](../../../packages/core/src/domains/memory/memory-control.ts)、[worker](../../../packages/core/src/domains/memory/memory-background-pipeline.ts)、[Runtime 查询](../../../packages/core/src/domains/runtime/runtime.ts)、[contract](../../../packages/contracts/src/memory-control.ts)、[任务 UI](../../../packages/workbench/src/components/MemoryBackgroundJobs.tsx)。
- 测试：[worker 与跨 Run 反例](../../../packages/core/src/domains/memory/memory-background-pipeline.test.ts)、[Runtime 集成](../../../packages/core/src/domains/runtime/runtime.memory-episode.test.ts)、[contract](../../../packages/contracts/src/memory-background-jobs.test.ts)、[共享 controller](../../../packages/api/src/memory-experience-controller.test.ts)、[SDK](../../../packages/sdk/src/index.test.ts)、[UI 渲染](../../../packages/workbench/src/components/MemoryBackgroundJobs.test.tsx)。
- 当前文档：[Memory 模块](../../../docs/modules/08-Memory-记忆子系统.md)、[Episode pipeline](../../../docs/outlive-agent-v2/04-memory-and-experience/01-evidence-episode-pipeline.md)。
- 2026-10-03 验证（仅当前进程 `env -u NODE_OPTIONS`）：Contracts build 与 8 项窄测试、Core build/typecheck 与 24 项 Memory/Runtime 测试、共享 API 3 项、SDK 45 项、Workbench typecheck 与 68 项 UI/live-client 测试通过。随后 Core 全量单测 56 文件 / 462 项通过；最终修正旧任务计数投影后，再跑 worker 11 项及 Core typecheck/build 均通过。变更 Markdown 链接和 `git diff --check` 均通过。
- 失败证据：Runtime 负例先发现 `run:UUID` 因文件名净化导致任务列表空，改为 canonical identity 后通过。旧 partial-commit 测试预期 0 个候选但已提交 1 个；现在状态与事实一致。重试输出变化返回 `memory_background_result_changed` 并保留前次结果。全量测试超时进一步发现真实 resume 竞态：waiting 已落盘而上一 worker 尚未释放 lease，active 去重丢失唤醒。`resumeWaiting()` 现先等待该 worker 完成再入队，重启/配置恢复负例无需放宽 timeout 即通过。并行 SDK locale 源码更新后曾因 dist 未生成阻塞 Workbench typecheck，SDK 重建后最终检查通过。
