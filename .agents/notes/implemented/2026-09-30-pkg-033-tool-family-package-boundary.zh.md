---
id: 2026-09-30-pkg-033-tool-family-package-boundary
title: 将 Tool 强制执行内核提取为窄包 API
status: implemented
owners: [tool, core]
created: 2026-09-30
last_reviewed: 2026-09-30
affects: [tool-package, core-tool-composition, tool-policy, approval]
supersedes: []
---

# Agent Note：将 Tool 强制执行内核提取为窄包 API

## 问题

PKG-033 只有在物理边界稳定，且具备第二个真实消费者或硬隔离理由，并有契约测试时才升包。CORE-022 已把 Tool 契约、Registry、唯一 Executor、Policy Engine 和 Approval Token Store 拆成逻辑模块，但它们仍依赖 Core 内部契约与工具函数。20 个内置 Tool 实现与 Registry 文件混在一起，依赖 Core Workspace、Sandbox、Artifact、Todo、Team、Skill 和 Subagent 能力。原样移动该文件会把 Core Runtime 和领域实现带进新包。

## 当前状态

- `packages/core/src/kernel/tool/definition.ts` 拥有 Tool 契约和体量较大的 Host 注入执行上下文。
- `packages/core/src/domains/tools/` 拥有 Registry 机制、内置 Tool 组装、调用校验、输出裁剪、Executor、Policy Engine 和一次性 Approval Token Store。
- `packages/core/src/domains/runtime/` 是强制执行协调方。它在 Tool dispatch、Action WAL 和工作区修改之前评估策略和最终审批绑定。
- CLI 组合根使用 Core 的可信 Tool Registry。Runtime 与 ExtensionManager 是同一进程内调用链上的协作者，不计作升包门槛中的独立 package consumer。
- CORE-022 和当前 Core 测试覆盖契约、策略、审批和输出行为。final-denial 回归测试断言拒绝后没有启动 Tool、WAL 或 mutation。

## 提案

将通用 Tool 强制机制提升为 `@tracegraph/tool`：Tool 定义与执行上下文契约、通用 Registry 和调用校验机制、唯一有界 Executor、Policy Engine、Approval Token Store 及通用工具函数。该包可依赖 `@tracegraph/contracts`、`zod` 和 Node 平台 API，但不依赖 Core 或 app。

Core 专属内置 Tool 实现、内置 Registry 组合、ExtensionManager 集成、Runtime 编排、Action WAL 和 Workspace/Sandbox Provider 继续留在 `@tracegraph/core`。Core 将自身 Provider 适配到 `@tracegraph/tool` 的公开契约。现有调用方依赖的 Core 包根或源码兼容导出予以保留；生产实现与契约测试的 owner 转到 Tool 包。

升包门槛依据是副作用强制边界：managed 依赖规则必须阻止通用 Executor/Policy 包导入 Core 编排或绕过契约。这是明确的硬隔离理由；本提案不声称已有第二个独立产品消费者。

这是只移动实现的变更。Policy deny、审批绑定、action digest、dispatch、Action WAL、cancellation shield、mutation、Receipt/Observation 和 event 顺序均保持不变。拒绝仍必须发生在 dispatch、WAL intent 和 mutation 之前。Receipt/Observation 映射和 Core 内置工具实现暂不提取。

## 考虑过的备选方案

- 原样移动 `domains/tools/registry.ts`：不选，因为其中的内置 Tool 创建逻辑会导入 Core Workspace、Sandbox 和多个 Core 领域。
- 只提升 Tool 类型声明：不选，因为安全关键的 Executor/Policy/Approval 强制路径仍会留在未托管的兼容层。
- 将 Runtime/WAL 或内置领域行为移入新包：不选，因为它们属于 Core 的权限/状态 owner 和 Provider，实现后 Tool 包会反向依赖 Core。

## 不变量与边界

- `@tracegraph/tool` 只有显式包根 API，不导入 `@tracegraph/core`、apps、Host 或 Provider 实现。
- Core 继续拥有内置 Tool 实现、Run 策略快照、Action WAL、Workspace、Sandbox 和 Event Ledger 集成。
- 生产代码中只有一个 `executeToolDefinition()` 实现；Runtime 每次 Tool 调用仍经过它。
- Policy/Approval 拒绝仍发生在 dispatch、WAL intent 和 mutation 之前。包边界不得增加另一条执行路径。
- Tool 契约与结果继续有界并通过 schema 校验。持久 schema、公开 Event 数据、Tool 清单和输出语义均不变。
- 契约测试通过 `@tracegraph/tool` 包根导入；Core integration tests 继续验证真实组合与拒绝时序。

## 迁移与回滚

将通用 Tool 契约与强制模块迁入 `packages/tool`，把通用 Registry 机制与 Core 内置定义拆开，再让 Core 依赖包根 API。只有为保留现有调用方路径时才保留 Core 窄兼容导出。更新 workspace 清单、`architecture-policy.yaml`、lockfile、生成模块图和 README 合约。回滚时将通用模块恢复到 Core，并删除新包和策略条目；无需持久数据或配置迁移。

## 验收标准

- [x] `@tracegraph/tool` 构建时不导入 Core/app，且只公开声明的包根 API。
- [x] Core 消费 Tool 包；Core 内置工具和 Runtime/Extension 组合继续留在 Core。
- [x] 包根契约测试覆盖 schema 校验、输出边界、取消/超时、deny/approval token 失败与 Registry 行为。
- [x] Core integration 证明最终拒绝发生在 Tool dispatch、Action WAL intent 和工作区 mutation 之前，且生产中仅有一个 Executor。
- [x] Workspace typecheck、单测/integration、boundary/invariant gates、包 README、路线图和模块图检查通过。
- [x] 当前 Tool 文档标明包 owner 并保留 deferred 边界。

## 风险与未决问题

- `ToolExecutionContext` 当前汇集多个 Host/Core 所有的 bridge。公开类型必须保持结构化，并且不能把 Workspace、WAL、Ledger 或 Approval 权限转移给新包。
- Canonical digest/stringification 不能与 Core helpers 分叉或改变已持久化 action/policy digest。
- Core 兼容接口不能遗留第二份 Registry 或 Executor 实现。

## 证据

- 实现：`packages/tool/src/index.ts` 是唯一公开入口。Definition、通用 Registry/调用校验、有界 Executor、Policy Engine、one-shot Approval Token Store、输出限制、crypto helper 与 sandbox port 已迁入 `packages/tool/src/`。Core 原源码路径仅薄 re-export 包根；Core 继续持有内置 Tool 创建/组合、Runtime、ExtensionManager、Run effective policy、Workspace/Sandbox authority、Action WAL、Receipt/Observation 与 Ledger 集成。Canonical `sha256`、`stableStringify` 和 ID factory 由 Core crypto 兼容导出转到同一 Tool 包实现。
- 测试：包根测试覆盖模型 schema 投影、Registry 可逆注册、input schema/approval 拒绝、有界输出、取消和超时；迁入的 Policy 与 Approval tests 从 `./index.js` 导入。Core `runtime.permission.test.ts` 的最终 deny 回归确认拒绝后没有 `tool.started`、WAL intent 或文件修改。源码搜索确认生产中只有一个 `ToolRegistry` 和一个 `executeToolDefinition()` 实现。
- 验证：`pnpm typecheck`；`pnpm test`（Tool 24 项、Core 390 项、工程门禁 48 项 Node 测试 + 8 项覆盖率门禁测试）；`pnpm test:e2e`（CLI E2E 4 项）；Runtime permission focused suite（13 项）；`pnpm verify:boundaries`（17 个包 / 31 条 workspace 边 / 1,431 个 import references）；`pnpm verify:invariants`；`pnpm verify:package-readmes`；`pnpm verify:v2-docs`（11 份文档 / 62 个任务）；`pnpm graph:modules:check`；`pnpm baseline:current:check`；lockfile 检查；6 项 implementation-consistency eval；`git diff --check`。
