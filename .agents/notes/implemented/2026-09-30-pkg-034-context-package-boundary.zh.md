---
id: 2026-09-30-pkg-034-context-package-boundary
title: 将模型可见 Context 边界提取到物理包
status: implemented
owners: [context, core]
created: 2026-09-30
last_reviewed: 2026-09-30
affects: [context-package, model-visible-context, package-policy]
supersedes: []
---

# Agent Note：将模型可见 Context 边界提取到物理包

## 问题

PKG-034 要求 Context 边界稳定、具备两个真实消费者或明确硬隔离理由，并有契约测试后才能升为物理包。当前 builder 与 compaction chain 位于 `packages/core/src/domains/context/`。Builder 已产出 `ContextManifest` 和模型可见上下文，但依赖 Core model types、Core crypto 兼容模块及共享 Tool-output 压缩阈值。原样移动仍会依赖 Core。

## 当前状态

- `context.ts` 和 `context-compaction.ts` 实现确定性组装、manifest/node lineage、压缩策略与 spill locator。`token-meter.ts` 实现 calibration 持久化并留在 Core，与 package topology 中后续 LLM family 对齐。
- Core Runtime 是 builder 唯一的生产消费者。Runtime 内部协作者不计为多个消费者。
- `ContextManifestSchema` 与相关 policy/item/node contracts 位于 `@tracegraph/contracts`；Core Runtime 负责写入 canonical lifecycle events，并拥有 ArtifactStore、provider/model adapters。
- 现有 Context 与 token-meter tests 覆盖组装和压缩；当前压缩测试依赖 Core 的 ArtifactStore 实现。

## 提案

将 Context 组装、模型可见投影、compaction algorithms 和 spill ports 提取到 `@tracegraph/context`。它只依赖 `@tracegraph/contracts`、`@tracegraph/tool` 提供的共享 digest/ID/output-threshold helpers 与 Node 平台 API。Package 暴露窄的 `TokenMeter` consumer port；calibrated meter 实现留在 Core，等待后续 LLM family 提取。Core 通过 curated Context Runtime façade 消费 package root；model-provider integration、ArtifactStore、Ledger/event lifecycle 和 Run authority 继续归 Core。

硬隔离理由是模型可见信任边界：此包从带来源归属且可能不可信的输入构造有界投影，并公开足够的 manifest 证据来重建同一个投影；同时不能导入 Runtime、provider implementation、apps 或 Ledger authority。这是明确的隔离理由，不是声称有第二个消费者。

本次只移动代码。模型可见 context string 必须能从 included manifest items 按相同稳定顺序重建。Policy defaults、字节/token 限制、压缩顺序与回退、Artifact refs、notices、calibration 格式、Ledger event timing 和 provider calls 均保持不变。新增 Context providers、policy/schema 改动及通用 Memory/model redesign 暂缓。

## 考虑过的备选方案

- 将 Context 留在 Core：不选，因为 PKG-034 要把模型可见投影及其 manifest 不变量隔离在 Runtime orchestration 的模块边界之外。
- 将 AgentLoopCoordinator 与 Runtime 算作两个消费者：不选，因为二者是同一条 Core 生产路径上的内部协作者。
- 原样移动 Context：不选，因为新包仍会导入 Core 拥有的 model types 和 utilities。

## 不变量与边界

- `@tracegraph/context` 具有公开根 API，不能导入 Core、Host、apps 或 provider implementations。
- Context policy 和 manifest schemas 继续由 `@tracegraph/contracts` 所有，持久结构不变。
- 目前 Runtime 仍是唯一生产消费者；canonical event 写入、ArtifactStore 生命周期、provider selection、cancellation settlement 与 run authority 继续归 Runtime。
- Context 不把 model summary 输出或 retrieval/tool 数据当作可信指令；投影始终有界且带归属信息。
- Package contract tests 通过公开 Context API 验证，并从 manifest items 重建模型可见输入；Core integration tests 继续验证真实 ArtifactStore 与 Runtime 组合。

## 迁移与回滚

将 Context 源码与 focused tests 移入 `packages/context`，用窄的 structural Context ports 替换 Core 私有类型，并在 workspace manifests 和 managed architecture policy 登记新包。Core 的 curated façade 与 imports 改为消费 Context package root。无需持久 schema 或数据迁移。回滚时将源码移回 Core、恢复 façade imports，并移除 package/policy 条目。

## 验收标准

- [x] `@tracegraph/context` 构建时不导入 Core/apps，且只暴露声明的 root API。
- [x] 包根测试覆盖确定性组装、context/manifest 重建、压缩顺序与回退、spill/refetch 及取消/错误行为；calibration 持久化测试留在 Core。
- [x] Core 测试通过真实 ArtifactStore 和 Runtime 验证包消费；模型可见输出和 canonical event 行为不变。
- [x] 新包登记为 managed；Core 不再直接导入被移动的 Context 实现路径。
- [x] Context 当前模块文档、package README、roadmap、package policy 和生成模块图与实现一致。

## 风险与未决问题

- `@tracegraph/tool` 当前拥有共享 Tool-output compaction threshold 与 canonical digest helpers。Context 必须依赖这些稳定 helper，不能导入 Tool 执行机制或复制策略值。
- Core 的 `ModelObservation` 和 `ContextSummaryInput` 面向 provider/Runtime。提取后的 package 应定义结构兼容的 Context 自有类型，不能把 provider 所有权移入 Context。
- 依赖 Core ArtifactStore 的现有测试应继续作为 Core integration coverage；package contract tests 需使用独立的 ArtifactStore port fake。

## 证据

- 实现：`packages/context` 现在负责 Context builder、compaction、manifest 重建和公开的 `TokenMeter` port；calibrated meter 实现及 Runtime/ArtifactStore/Ledger/provider 权限仍在 Core。双语 Note 已实施，不声称存在第二个生产消费者；硬隔离理由是有界且可从 manifest 重放的模型可见 Context 投影。
- 测试：`packages/context` focused suite 通过（27 项）；Core suite 通过（41 个文件、365 项），包含使用真实 ArtifactStore 的 Context package integration；CLI 纵向端到端测试通过（4 项）。
- 验证：Context build/typecheck 与 workspace `pnpm typecheck` 通过；`pnpm test:engineering` 通过（48 项 Node 测试和 8 项 coverage-gate 测试）；`pnpm coverage` 通过（1,009 项测试、整体行覆盖率 77.83%、Context builder 90.51%、Tool policy engine 93.9%）；boundary、package README、V2 docs、lockfile、生成模块图和生成 baseline 检查均通过。
