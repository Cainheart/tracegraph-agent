---
id: 2026-10-01-mem-049-v2-memory-recall-runtime
title: V2 Memory Runtime 召回消费者
status: implemented
owners: [memory-runtime, memory-governance]
created: 2026-10-01
last_reviewed: 2026-10-01
affects: [memory-recall, runtime-context, provenance]
supersedes: []
---

# Agent Note：V2 Memory Runtime 召回消费者

## 问题

MEM-045 已提供 fail-closed 资格判定，MEM-046 已提供 V2 控制面投影，但 G-21 Runtime 仍直接消费可选的 V1 Retriever。只有新增一个显式启用的消费者，并在排序或构建 Context 前检查最新生命周期、反馈、冲突、scope、有效期、信任、consent 和模型使用策略，评测才能代表 V2 行为。

## 已实现状态

- Runtime 提供由 Host 选择的 `v2MemoryRecallEnabled` 开关，默认关闭，并保持 G-21 V1 Recall 路径独立。
- 显式开启的每个 turn 都构建 owner-scoped 控制快照、执行 `evaluateMemoryRecallEligibility`，再仅检索资格门通过的确切 Memory id/version。
- Store、Ledger、投影或资格门失败时只产生空 V2 Memory contribution，不回退到未过滤的 V1 结果。
- Context/MemoryUse 来源信息将确切版本和 evidence refs 保留到 Runtime handoff 边界。

## 实现

### Target

新增由 Host 控制、默认关闭的 V2 召回开关。开启后，每个 turn 读取完整且 scoped 的 V2 控制面快照，执行资格门，只对精确匹配的 eligible id/version 排序，再把带 canonical retrieval attribution 的记录传入 Context。Ledger、payload store、投影或资格门出错时返回空 Memory contribution；不得回退到未过滤结果。V2 未启用时，G-21 V1 路径保持独立。

只在实际发生的生命周期位置记录 retrieved/selected/handoff。Context 和 Ledger 来源可以证明内容何时可见、何时交给 adapter，但不能证明 Provider 实际依赖了内容。

### 暂缓

- 默认开启 V2 召回或静默迁移 G-21 记录。
- 语义冲突推断、学习式排序，以及将模型自述当授权证据。
- 超出 Runtime 显式 handoff 的 Provider/model 因果归因。

## 不变量与边界

- 每个 turn 都重新读取 V2 投影，并在排序前检查 owner/project/run scope、生命周期、反馈、冲突、有效期、来源信任、consent、敏感度和 `allowModelUse`。
- 快照不完整或损坏时，任何 V2 内容都不得进入 Context。
- candidate、revoked、disputed、expired、越 scope 或需反馈复核的记录不得进入排序池。
- 本任务不引入自动副作用，也不改变默认策略。

## 迁移与回滚

新 Runtime 选项默认为关闭，保持现有行为。Host 在提供 V2 store 后可显式启用。回滚时关闭该选项；不改写已存记录。

## 验收标准

- [x] 显式开启的 V2 Runtime 读取先经过资格门，再检索并保留 id/version/evidence 来源。
- [x] Gate/store/Ledger 故障 fail closed，且没有 legacy 或未过滤回退。
- [x] 默认关闭、scope/策略负例、精确版本来源和真实 Context handoff 有 focused Runtime 测试。

## 证据

- 实现：`packages/core/src/domains/memory/memory-v2-recall.ts`、`packages/core/src/domains/runtime/runtime.ts`，以及 `packages/core/src/domains/runtime/agent-loop.ts` 的 Context handoff。
- Focused 行为证据：`packages/core/src/domains/runtime/runtime.memory-experience-recall.test.ts` 覆盖默认关闭、精确版本 Memory handoff、store 故障 fail closed 和不回退 V1。
- 验证：Contracts 156/156、Evidence 5/5、Context 28/28、Core 426/426 全部通过；根 typecheck 和仓库门禁随 MEM-048 完成证据一并记录。
