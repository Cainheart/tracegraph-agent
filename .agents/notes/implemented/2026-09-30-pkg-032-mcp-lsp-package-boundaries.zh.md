---
id: 2026-09-30-pkg-032-mcp-lsp-package-boundaries
title: 将 MCP 与 LSP Provider 提取到 Core 自有端口之后
status: implemented
owners: [capabilities, core]
created: 2026-09-30
last_reviewed: 2026-09-30
affects: [mcp-package, lsp-package, core-ports, package-policy]
supersedes: [2026-09-29-core-021-seams-extraction]
---

# Agent Note：将 MCP 与 LSP Provider 提取到 Core 自有端口之后

## 问题

PKG-032 路线图要求：只有 MCP 与 LSP 各自具有稳定契约、真实消费者或硬隔离理由、公开 API 契约测试，并且不依赖 Core 具体 Runtime 时，才升为物理包。当前 stdio client 和 manager 位于 `packages/core/src/seams/{mcp,lsp}`。协议与配置契约已经在 `@tracegraph/contracts`，但 manager 仍导入 Core Tool 定义、扩展生命周期、结果校验，以及（LSP）工作区路径工具。直接移动文件会保留对 Core 的向内依赖。

## 当前状态

- `@tracegraph/mcp` 在 `packages/mcp/src/` 拥有 MCP stdio protocol/client、服务器生命周期、工具目录与调用行为；契约类型来自 `@tracegraph/contracts`。
- `@tracegraph/lsp` 在 `packages/lsp/src/` 拥有 LSP stdio protocol/client、按项目懒加载会话、诊断与语义位置；契约类型来自 `@tracegraph/contracts`。
- Core 在 `packages/core/src/seams/{mcp,lsp}/` 保留结构化 Runtime 端口与 Tool 适配器，不导入 Provider 包。
- CLI 是组合根，直接组合两个 Provider 并通过 Core 自有端口注入 manager。
- 包根 focused tests 使用 fixture 子进程，覆盖失败/降级、有界结果、LSP realpath 路径包含、取消和停止/卸载。

## 决策

提取两个物理包：`@tracegraph/mcp` 和 `@tracegraph/lsp`。每个包只依赖 `@tracegraph/contracts`、`zod`、Node 平台 API 和本 family 模块。它们拥有独立的子进程协议、进程生命周期和有界输出，构成明确的硬隔离边界；配置、状态和事件契约继续共享自 `@tracegraph/contracts`。

Core 保留 Runtime 端口和 Tool 适配器，通过结构化 manager 端口及共享契约消费能力，不导入 Provider 包。CLI 仍是组合根，直接导入 Provider 并注入 Core。Core 专属的动态 Tool 注册与 raw-result 转换不放在 provider manager。LSP Provider 使用本地测试过的 resolver，在 realpath 后拒绝绝对路径、路径穿越和越界 symlink。

Provider focused tests 通过各自包根验证 API。共享 raw Tool-result 校验位于 `@tracegraph/contracts`，Core re-export 保持现有 Tool 实现兼容。两个包已经加入 workspace、`architecture-policy.yaml`，CLI 声明 Provider 依赖。

这是保持行为的包边界调整。MCP HTTP/SSE、resources/prompts/PTC、LSP 诊断重设计或自动导航工具，以及策略、审批、沙箱权限、event 顺序或持久格式的变更仍暂缓。

## 考虑过的备选方案

- 原样移动文件：不选，因为 Provider 包会依赖 Core Tool 和工作区实现细节。
- 永久将两个 manager 留在 Core：不选，因为两组能力各自拥有子进程协议与生命周期/teardown，且配置、状态、事件契约已经明确。
- 将 Tool 适配器放进新 Provider 包：不选，因为这会让 Core Tool Registry 和 Runtime 集成成为 Provider 实现细节。

## 不变量与边界

- `@tracegraph/mcp` 和 `@tracegraph/lsp` 不依赖 `@tracegraph/core`、Host、CLI 或 SDK。
- Core 只依赖 Core 自有端口和共享契约，不依赖 Provider 包。
- CLI 是组合根，可以依赖两个 Provider 包。
- MCP/LSP 进程事件和 canonical Run event 顺序保持不变；服务器配置与密钥仍归 Host 所有。
- LSP 只读取显式的工作区相对路径，并在 realpath 后检查边界。Provider 不获得 Ledger 或 Tool policy 权限。
- 每个新包具有显式根导出、通过该根导出的契约测试和 managed 依赖策略。

## 迁移与回滚

将 Provider clients、managers 和 focused tests 移到新包。把 Tool 适配器与 raw-result 转换拆到 Core 文件，用窄端口替代 Runtime 的具体 manager 类型，并只调整 CLI 组合入口的导入。无需持久数据或配置迁移。回滚时将 Provider 文件移回 Core，恢复兼容导出与导入，并移除包清单和策略登记。

## 验收标准

- [x] MCP 与 LSP Provider 构建时不导入 Core 或其他 app。
- [x] Core 不依赖/导入 `@tracegraph/mcp` 或 `@tracegraph/lsp`；CLI 通过 Core 自有端口组合两个 Provider。
- [x] 包根 API 契约测试保留失败、降级、子进程、有界、路径包含、取消和关停覆盖。
- [x] Core focused tests、CLI 纵向 e2e、workspace typecheck、boundary/invariant gates 和模块图检查通过。
- [x] MCP/LSP 当前模块文档、包 README、包策略、路线图状态和生成模块图与实现一致。

## 风险与未决问题

- 将 raw Tool-result schema 移至 `@tracegraph/contracts` 时，必须保持 Core 严格输出校验行为。
- 移除 Core WorkspaceHandle helper 后，LSP 路径检查必须保持等价。
- Core root 当前导出的 Provider classes 将迁到新包根；调用方须从所属包导入 Provider 实现。

## 证据

- 实现：[`@tracegraph/mcp`](../../../packages/mcp/src/index.ts)、[`@tracegraph/lsp`](../../../packages/lsp/src/index.ts)、Core 自有 [MCP ports/adapter](../../../packages/core/src/seams/mcp/) 与 [LSP ports/adapter](../../../packages/core/src/seams/lsp/)、`apps/cli/src/index.ts` 组合和 `architecture-policy.yaml` 包策略。
- 测试：`pnpm test` 通过全 workspace 单测与工程测试（Core 410、MCP 6、LSP 2；工程 48 项及 coverage checks）；`pnpm test:e2e` 通过 4 项 CLI 测试；Ledger replay eval 通过 1 项；文档一致性 eval 通过 6 项。
- 验证：`pnpm typecheck`、`pnpm verify:boundaries`（16 个包、29 条依赖、1,400 条 import references）、`pnpm verify:invariants`、`pnpm verify:package-readmes`、`pnpm verify:v2-docs`、`pnpm graph:modules:check` 和 `git diff --check` 均通过。评估指标/报告文件已恢复，执行前哈希校验一致。
