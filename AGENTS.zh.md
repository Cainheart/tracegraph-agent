# Outlive Agent 仓库规则（中文对照）

中文对照 · [English source](AGENTS.md)

> 本文是便于阅读的译文；仓库执行规则以 [AGENTS.md](AGENTS.md) 为准。修改规则时应同步核对两份文件。

## 适用范围与权威性

本文件对应的英文规则适用于 `tracegraph-agent/` 内的工作。上级工作区的 `../AGENTS.md` 及其规范性的 `.claude/` 工作流仍负责整个工作区的求职与 agent-trace 行为。本文件补充仓库架构、证据和验证规则，不替代上级规则。

## 先读正确的真源

- 了解**当前产品行为**：阅读 `README.md`、相关的 `docs/modules/*.md`，以及该模块链接的源码和测试。
- 了解**V2 提议中的目标**：从 `docs/outlive-agent-v2.md` 开始，只打开本次任务需要的模块。
- 了解**仓库决策的原因**：阅读 `.agents/notes/`。
- 了解**可重复的维护流程**：只有真实的 `SKILL.md` 已获接受，才使用 `.agents/skills/`；候选名称不是可执行指令。
- `docs/outlive-agent-v2/10-tracegraph-to-outlive-migration/README.md` 记录 TraceGraph 能力及边界如何迁移到 V2，不能据此证明某项 V2 能力已交付。

没有源码、测试和对应当前模块文档的更新，就不能把提议中的设计说成现有能力。

## 不可妥协的不变量

1. 只追加的 Event Ledger 是持久 Run 事实的真源。报告、UI 状态、记忆候选和摘要都是可重放的投影。
2. 一个事实只有在已持久记录，或明确标为临时且不具权威性时，才能呈现给模型。
3. 工具退出码或 HTTP 成功不等于业务成功。有副作用的动作需要持久 Command、Receipt、Observation；结果不确定时还需要对账路径。
4. Memory 必须带来源、作用域、有效性、修订和治理状态。检索相似度不会把文本变成事实。
5. 恢复的 Session 可以继承知识，但必须重新评估策略、凭据、审批和工作区权限。
6. 取消操作必须停止新任务派发并收束子工作；重试必须有界、类型明确且在证据中可见。
7. 不要在 `scripts/` 中添加产品行为；不要在 `apps/` 中添加客户端专属的业务语义。

## 架构规则

- `apps/*` 只作为组合根和交付入口。
- 通过公开包导出向内依赖；禁止跨包深层导入。
- 领域契约应独立于传输层、模型供应商、UI 和持久化实现。
- 只有边界稳定、至少有两个消费者或存在强隔离理由，并具备契约测试时，才引入实体包。
- 可选能力通过类型化接缝注册，不要在中央 Agent Loop 中不断增加功能专属分支。
- 持久 schema、事件、协议、权限、包边界和 Desktop 方面的决策，实现前需要 Agent Note。
- V2 迁移期间保留 `@tracegraph/*` 包作用域，除非另有已接受的 Note 决定修改。

## 变更流程

1. 检查工作树，保留与任务无关的用户改动。
2. 将变更归类为 `behavior`、`protocol`、`storage`、`refactor`、`tooling`、`docs` 或 `tests`。
3. 找出所有者、真源、兼容性影响和恢复路径。
4. 对持久性或架构性变更，实现前在 `.agents/notes/proposed/` 中创建或更新 Note。
5. 实现最小纵向切片；可行时将文件移动/重构与语义变更分开。
6. 加上最窄且有用的单元、契约或不变量测试，再按受影响边界运行更广的门禁。
7. 只在行为得到验证后更新当前文档。在此之前，目标状态文字应标为 `proposed`、`target` 或 `deferred`。

## 验证

先选最可能否定这次变更的最窄命令，再按风险扩大范围：

```bash
pnpm --filter <package> test
pnpm --filter <package> typecheck
pnpm test:engineering
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm evals
pnpm coverage
```

契约变更后，先重建生成的声明文件，再做类型检查。仅修改文档时，至少校验 Markdown 链接、YAML 解析、roadmap 依赖 DAG 和行尾空白。命令没有在当前工作树实际运行，就不能声称它通过。

## 完成标准

只有实现、证据、测试、当前文档与已说明的限制相互一致，任务才算完成。如果外部结果未知，应记录为 `unknown` 并写明对账方法，不能报告成功。
