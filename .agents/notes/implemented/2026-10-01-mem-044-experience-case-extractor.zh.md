---
id: 2026-10-01-mem-044-experience-case-extractor
title: 定义有界且有证据支持的 Experience Case 候选
status: implemented
owners: [experience, contracts, core]
created: 2026-10-01
last_reviewed: 2026-10-01
affects: [experience-case-contract, experience-case-extractor]
supersedes: []
---

# Agent Note：定义有界且有证据支持的 Experience Case 候选

## 问题

MEM-043 可以将一个已结束 Run 投影成有界 Episode，并可选地派生待审核 Memory candidate。仓库把 Experience Case 定义为可复用的条件化知识，但目前没有可执行的 Case 契约或 extractor 边界。Case 必须保留观察事实、适用条件、结果验证和限制复用的反例。

## 当前状态

- `MemoryEpisode` 与其提取输入提供 canonical source digest 和精确事件证据引用。
- 当前实现包括严格 Experience Case 契约、显式可选 ModelAdapter extractor 能力和 Core candidate validator。Experience 持久化、审核命令、检索、Runtime 调度和注入仍未实现。

## 决策

- 增加严格契约，表达版本化 Experience Case、有界 extractor 输入/结果，以及结构化 situation、action、outcome、verification、applicability 和 counterexample。
- 在 Core 实现 validator，消费一个 canonical MEM-043 Episode 和不可信 extractor 输出。候选引用只能指向实际发送给 extractor 的行，并须再次与 canonical Run Ledger 校验。
- 输出仅物化为稳定身份、来源 Episode/digest 和 `status: candidate` 的确定性候选投影。Extractor 不能设置身份、版本、validated 状态、权限、可执行命令或复用策略。
- Outcome 表达为 `success | failure | partial | unknown`。非 unknown 结果至少需要一条有证据支持的 verification；不确定性应显式表示，不能由模型置信度代替。
- 复用 MEM-043 的有界脱敏 Episode 输入构建器。ModelAdapter 提供显式可选的 Provider 提取方法；本任务不由 Runtime 调度该方法。不新增物理 package、Experience 持久化 aggregate、审核生命周期、检索、Runtime 注入或 UI。

## 不变量与边界

- Case 是可复用建议，不是可执行 workflow，也不是未来成功的证明。
- Situation、action、outcome、verification、applicability、counterexample 和整体 evidence refs 都必须精确对应源 Episode 中的事件；单个字段中的序号不能重复。
- Case 初始状态保持 candidate；当前切片不能验证、激活或注入模型上下文。
- 可以表达 unknown outcome；模型置信度不能把缺乏验证的结果升级为确定结果。

## 验收标准

- [x] 契约能表达 success、failure、partial、unknown，以及字段有界的结构化 applicability 和 counterexamples。
- [x] Core 可从 Episode 与严格校验的不可信 extractor 输出构造确定性候选投影。
- [x] 无效、重复或超出输入范围的证据引用 fail closed；没有依据的非 unknown 结果会被拒绝。
- [x] 测试和 Experience/Memory 文档描述实际契约，并清晰标明持久化、审核、检索和 Runtime 调度/使用属于后续范围。

## Evidence

- 契约：`packages/contracts/src/experience-case.ts`；公开导出：`packages/contracts/src/index.ts`。
- Core 投影与显式 extractor seam：`packages/core/src/domains/experience/experience-case.ts`；公开导出：`packages/core/src/index.ts`。
- OpenAI-compatible 与 Anthropic 两种 ModelAdapter 可选实现：`packages/core/src/domains/model/model-provider.ts`。
- 测试：`packages/contracts/src/experience-case.test.ts`、`packages/core/src/domains/experience/experience-case.test.ts`，以及 `packages/core/src/domains/model/model-provider.test.ts` 中的协议用例。
- 当前契约与后续边界：`docs/outlive-agent-v2/04-memory-and-experience/README.md`、`docs/outlive-agent-v2/04-memory-and-experience/03-experience-learning.md`、`docs/outlive-agent-v2/09-implementation-roadmap/README.md`。
- 验证：`pnpm --filter @tracegraph/contracts build`；Contracts 单测 156 项通过；Core 单测 411 项通过且 typecheck 通过；`pnpm test:engineering`（48 项 Node 测试、8 项 Vitest 测试）；`pnpm verify:boundaries`（18 packages、34 workspace dependencies、1,592 条 imports）；`pnpm verify:package-readmes`；`pnpm graph:modules`、`pnpm graph:modules:check`；`pnpm verify:v2-docs`（11 份文档、62 个 roadmap tasks）；`git diff --check` 均通过。

## 迁移与回滚

不修改任何已存数据。新契约和 validator 均为增量接口。回滚只移除本任务尚未持久化的投影 seam，不触碰 MEM-043 Episode 或 Memory records。

## 风险与未决问题

- Scope 维度和检索权重需要独立校准。本切片只保存有界的显式适用规则，不计算匹配分数。
- Experience Case 持久化与审核生命周期需由后续任务提供，之后候选才能被复用。
