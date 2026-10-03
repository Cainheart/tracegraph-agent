---
id: 2026-10-01-run-051-cancellation-quiescence
title: 阻止 Runtime 新派发并结清取消任务
status: implemented
owners: [runtime]
created: 2026-10-01
last_reviewed: 2026-10-01
affects: [runtime, tools, sandbox]
supersedes: []
language: zh-CN
---

# Agent Note：阻止 Runtime 新派发并结清取消任务

## 问题

持久化取消已经中止 Run 信号并阻止后续控制变更。但 Tool 包装器可能在 AbortSignal 触发后、底层执行器结清前返回；POSIX 进程 runner 也会在进程组 leader 关闭时返回，即使后代仍在运行。因此 `run.cancelled` 可能早于 Runtime 自有任务已停止的证明。

## 当前状态

Runtime 为每个 Run 持有 `AbortController`，通过 Event Ledger 串行化持久化用户输入，门控 `tool.started`，并用 cancellation shield 保护不可逆写入和子进程启动。模型循环与通用 Tool executor 通过 abort signal 竞争返回。`run_test` 使用独立 POSIX 进程组并通过 TERM 到 KILL 递进清理，但它观察的是进程组 leader，而非全部后代。见 [`02-Agent-Runtime.md`](../../../docs/modules/02-Agent-Runtime.md)、[`runtime.ts`](../../../packages/core/src/domains/runtime/runtime.ts)、[`packages/tool executor`](../../../packages/tool/src/executor.ts) 和 [`process-runner.ts`](../../../packages/core/src/seams/sandbox/process-runner.ts)。

## 已实现决策

现在每个 Run 都有一个进程内 `CancellationController`。它通过同步栅栏准入并登记模型、审批 answerer 和实际 Tool executor Promise，也会登记那些在 Tool 包装器的 abort race 已返回后仍在执行的工作。持久化取消会封锁后续派发并中止当前工作。finalizer 最多等待 1,000 ms；仍有任务活动时保留 pending cancel，并在最后一个任务结清时重试。新 Host 进程中的显式恢复可完成 pending cancel，因为旧进程及其自有任务已经退出。旧兼容 `stop` 也会在写终态前等待 quiescence。

POSIX 进程 runner 在直接子进程关闭后仍保留进程组身份，先发 SIGTERM，再在 250 ms 宽限期后发 SIGKILL，并且只在进程组消失后返回。它也会回收正常退出的 group leader 留下的后代。Tool executor 可向调用方返回有界的 abort 结果，但 controller 会单独追踪底层 executor，直到其结清。

### 延后范围

跨 Host 取消锁、强制终止忽略 AbortSignal 的任意进程内 JavaScript、Windows 后代进程树治理，以及新增公开取消进度事件均延后。忽略取消信号且不结清的进程内任务，会让 Run 保持持久化取消 pending，直到任务结清或 Host 重启；Runtime 不得在仍拥有该任务时声称 `run.cancelled`。

## 考虑过的备选方案

- 把 `AbortController.abort()` 当作取消证明：不采用，因为 abort 是请求，不能证明执行器或后代已结清。
- 在取消命令中无限等待：不采用，因为调用方需要有界响应。等待超时后保留持久化 pending 取消，待安全时再结算。

## 不变量与边界

- Event Ledger 仍是取消意图和终态的持久化事实来源。
- Controller 是每 Run 的易失状态；重启后只有在所属 Host 进程已经退出时，恢复逻辑才能推断旧进程任务已消失。
- 派发准入和取消栅栏在 Runtime 进程内通过同一个同步线性化点协调。
- 仅当 controller 确认没有活动自有任务后才写入 `run.cancelled`；不可逆操作仍须先通过 cancellation shield 结清持久化边界。
- POSIX `run_test` 完成代表其进程组已回收。这不等同于 Host 容器或跨进程锁。

## 迁移与回滚

不改变持久化 Event schema 或用户命令。回滚可恢复为直接使用 AbortController 和现有 executor 包装；历史 cancel input 与终态 Event 仍可回放。进程清理修改局限于有界 runner。

## 验收标准

- [x] Run 被取消栅栏封锁后，不再启动模型、审批 answerer 或 Tool executor 派发。
- [x] 跟踪任务仍活动时，持久化取消不会写入 consumption 或 `run.cancelled`；任务结清后才完成。
- [x] POSIX 进程组会杀死忽略 SIGTERM 的后代，且只在进程组消失后返回。
- [x] 恢复会完成持久化 pending 取消，且不派发模型或 Tool 工作。
- [x] 当前 Runtime 文档和 RUN-051 路线项记录经过验证的行为与不合作任务限制。

## 风险与未决问题

第三方执行器可能忽略 AbortSignal 且永不结清。安全处理是保留 pending 取消，不能发布错误的终态证明。Controller 只在本地 Runtime 进程内生效，不协调并发 Host。

## 证据

- 实现：[`cancellation-controller.ts`](../../../packages/core/src/domains/runtime/cancellation-controller.ts)、[`agent-loop.ts`](../../../packages/core/src/domains/runtime/agent-loop.ts)、[`runtime.ts`](../../../packages/core/src/domains/runtime/runtime.ts)、[`packages/tool executor`](../../../packages/tool/src/executor.ts) 和 [`process-runner.ts`](../../../packages/core/src/seams/sandbox/process-runner.ts)
- 测试：[`cancellation-controller.test.ts`](../../../packages/core/src/domains/runtime/cancellation-controller.test.ts)、[`runtime.steering.test.ts`](../../../packages/core/src/domains/runtime/runtime.steering.test.ts)、[`runtime.subagent.test.ts`](../../../packages/core/src/domains/runtime/runtime.subagent.test.ts)、[`memory-g21.test.ts`](../../../packages/core/src/domains/memory/memory-g21.test.ts) 和 [`process.test.ts`](../../../packages/core/src/seams/sandbox/process.test.ts)
- 文档：[`02-Agent-Runtime.md`](../../../docs/modules/02-Agent-Runtime.md) 与[实现路线图](../../../docs/outlive-agent-v2/09-implementation-roadmap/README.md)
- 验证：`pnpm --filter @tracegraph/core test:unit` 通过（54 个文件、438 项测试）；`pnpm --filter @tracegraph/tool test:unit` 通过（3 个文件、24 项测试）；Core 与 Tool 构建和类型检查通过；`pnpm verify:v2-docs`、`pnpm verify:boundaries`、`pnpm verify:invariants`、`pnpm verify:package-readmes` 和 `git diff --check` 通过。
