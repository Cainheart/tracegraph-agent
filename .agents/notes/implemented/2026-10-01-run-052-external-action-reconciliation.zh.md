---
id: 2026-10-01-run-052-external-action-reconciliation
title: 通过类型化 Provider 契约对账未知外部 Action
status: implemented
owners: [evidence-runtime]
created: 2026-10-01
last_reviewed: 2026-10-01
affects: [runtime, tools, events, recovery]
supersedes: []
language: zh-CN
---

# Agent Note：通过类型化 Provider 契约对账未知外部 Action

## 问题

当前 Action WAL 只对 `commit_patch` 的文件系统结果提供恢复证明。Tool 调用其它系统时，可能在派发后超时或在 `tool.started` 后丢失 Host 进程；Runtime 没有 Provider 接口查询外部状态，也不能从传输层状态推断成功或失败。

## 当前状态

`tool.started` 持久化 Runtime 所有的 operation 身份和受限 Tool 名称。Tool 执行上下文现在会收到同一 Run 范围的 `operationId`；文件系统 Action WAL 仍只负责 `commit_patch`。Raw Tool 结果允许 `unknown`；可选 Host reconciler 为配置的外部 Tool 增加查询路径，不改变其执行或重试行为。见 [`02-Agent-Runtime.md`](../../../docs/modules/02-Agent-Runtime.md)、[`runtime.ts`](../../../packages/core/src/domains/runtime/runtime.ts) 和 [`definition.ts`](../../../packages/tool/src/definition.ts)。

## 已实现决策

`AgentRuntimeOptions.externalActionReconciler` 接受 Host 配置的 Provider ID、受支持 Tool 名称快照和只读 `reconcile()` 回调。Runtime 将 `tool.started` 中规范化的 `operationId` 传给 `ToolExecutionContext`；Provider 应把它与 project/Run 身份组合起来关联外部状态。恢复会查询受支持、没有终态结果，或 Tool 返回 unknown、timeout、取消的操作。请求仅携带 Run/action/operation 身份与触发状态，不携带原始 Tool 参数或凭据。

Provider 结果写入 Ledger：`confirmed` 表示已证明预期后置条件；`failed` 表示已证明 Action 未生效；两者都要求 evidence digest 并结束自动对账。`unknown` 记录不确定性，可再次查询但不重放 Tool。`diverged` 或属于其它 operation 身份的结果会写入粘性的 `action.diverged` 供人工审查。Provider 抛错、超时或返回无效结果均按 `unknown` 处理。查询默认期限为 5 秒，Host 最多可配置到 30 秒。该契约与 Action WAL 的 Patch 恢复分离。

一个本仓可控 Provider 的 Runtime 纵向测试演示四种结果，并通过新的 Runtime 实例证明可从持久化事实恢复对账。该契约不包含外部 Agent Adapter，也不制定通用重试策略。

### 延后范围

真实外部 Provider 实现、凭据和 capability 接入、通用 Action 执行重试、公开对账 UI、跨 Host Provider 协调和 Langfuse 评估均延后。`unknown` 绝不允许盲目重放 Action。

## 不变量与边界

- Event Ledger 中的 Tool 生命周期仍是派发身份真源；operation ID 由 Runtime 生成并规范化。
- 对账只读取 Provider 状态，绝不重新执行 Action。
- 只有 Host 配置的 reconciler 可以分类其明确支持的 Tool。
- `unknown` 保持未知并可再次查询；`diverged` 是粘性状态，不能静默回到普通执行。
- Provider 输出经 schema 校验和大小限制后才能进入 Ledger。
- Digest 绑定 Provider 的 evidence bytes，但不验证 Provider 身份；Provider 配置仍属于 Host 信任边界。

## 验收标准

- [x] 自定义 Tool 收到 Runtime 稳定生成的 `operationId`。
- [x] Host 重启后，恢复从 durable Event 找出未决且被支持的操作，并忽略不支持的 Tool。
- [x] 受控 Provider 端到端产生持久化 `confirmed`、`failed`、`unknown` 和 `diverged` 结果。
- [x] 对账不会重新派发 Tool；`unknown` 可再次查询，`diverged` 会进入人工审查。
- [x] 当前 Runtime 文档和 RUN-052 路线项描述实际实现的边界。

## 证据

- 实现：[`action-reconciliation.ts`](../../../packages/contracts/src/action-reconciliation.ts)、[`runtime.ts`](../../../packages/core/src/domains/runtime/runtime.ts)、[`definition.ts`](../../../packages/tool/src/definition.ts)
- 测试：[`action-reconciliation.test.ts`](../../../packages/contracts/src/action-reconciliation.test.ts)、[`runtime.external-action-reconciliation.test.ts`](../../../packages/core/src/domains/runtime/runtime.external-action-reconciliation.test.ts)
- 文档：[`02-Agent-Runtime.md`](../../../docs/modules/02-Agent-Runtime.md)、[`@tracegraph/tool README`](../../../packages/tool/README.md) 和[实现路线图](../../../docs/outlive-agent-v2/09-implementation-roadmap/README.md)
- 验证：Core 55 个文件 / 446 项测试通过；Contracts 27 个文件 / 176 项测试通过；Tool 3 个文件 / 24 项测试通过。Contracts、Tool、Core 构建和类型检查通过；`pnpm verify:v2-docs`、`pnpm verify:boundaries`、`pnpm verify:invariants`、`pnpm verify:package-readmes` 和 `git diff --check` 通过。
