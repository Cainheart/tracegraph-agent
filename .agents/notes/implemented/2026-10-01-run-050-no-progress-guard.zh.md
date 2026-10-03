---
id: 2026-10-01-run-050-no-progress-guard
title: Runtime 在重复 Tool 操作无新证据时停止
status: implemented
owners: [runtime]
created: 2026-10-01
last_reviewed: 2026-10-01
affects: [runtime, event-ledger]
supersedes: []
language: zh-CN
translation_of: 2026-10-01-run-050-no-progress-guard.md
---

# Agent Note：Runtime 在重复 Tool 操作无新证据时停止

## 问题

当前 Agent Loop 会在硬轮次上限处停止，但无法识别较短的循环：模型反复调用相同 Tool，并持续收到相同观察结果。这样会消耗多个模型轮次，却没有推动任务。

## 当前状态

RUN-050 之前，`AgentLoopCoordinator` 只依赖模型完成、现有失败、取消或 `maxTurns`。现在它会在成功 Tool 轮次后计算 hash-only 进度指纹，并在下一次模型请求前执行 Runtime policy。当前行为见 [02-Agent-Runtime.md](../../../docs/modules/02-Agent-Runtime.md)。

## 已实现决策

Runtime 持有仅在进程内保存的进度追踪器，每个成功 Tool 轮次记录经过哈希的规范化 Tool 调用身份和规范化结果证据；存在相应信号时，还会计算 workspace patch facts、LSP diagnostics 与 Todo state 的哈希。进度指纹不复制原始参数或 Tool 输出。

默认 policy 使用四轮窗口，要求至少连续三轮没有新规范化证据，并要求窗口内至少一半调用属于重复调用。这些值可通过受信的 `AgentRuntimeOptions.noProgressPolicy` 装配接缝配置。队列中的用户消息会清空无进展窗口和证据去重集合；guard 会先让位给排队 steering 的安全点。用户批准 Plan/Patch 后也会清空窗口。

触发 policy 后，Run 以现有 `run.failed` Event 和 failure code `no_progress_detected` 结束。Summary 说明重复 Tool 操作没有带来新证据。有限的终态 data 记录当前 policy、最近轮数、重复率和仅含哈希的最新 ProgressFingerprint，以便检查停机原因且不暴露原始参数或输出。

## 延后

自适应 policy 学习、停止前请求模型复盘/升级、CLI profile 配置，以及进程重启后重建临时窗口均延后。任何配置都不会关闭现有硬轮次上限。

## 考虑过的备选方案

- 第一次遇到重复 Tool 签名就停机：拒绝，因为正常迭代可能重读来源，或在证据变化后重试。
- 只保留硬轮次上限：拒绝，因为有限但无进展的循环会耗尽完整轮次预算。

## 不变量与边界

- Guard 在成功 Tool 结果之后、下一轮模型调用之前运行；取消、错误、审批与副作用结算仍由现有路径负责。
- 新的规范化 Tool 结果证据会重置连续无进展计数。单凭调用签名不会停止 Run。
- Policy 属于受信 Runtime 配置；模型输出和客户端请求不可调整它。
- 进度哈希是诊断指纹，不代表业务成功或 workspace 正确性。

## 迁移与回滚

新增 failure code `no_progress_detected` 复用现有终态 Event envelope，不改变旧 Ledger 的解析。回滚时移除循环 Guard 和 Runtime option；历史终态 Event 仍是普通失败 Run。

## 验收标准

- [x] 相同 Tool 操作持续得到相同结果时，以可检查的 `no_progress_detected` 失败停机。
- [x] 不同操作或变化的结果会继续迭代，不被误停。
- [x] 用户消息会重置无进展窗口。
- [x] 硬轮次预算以及现有失败/取消行为保持不变。
- [x] Core Runtime 文档说明已交付的 policy 和限制。

## 风险与未决问题

规范化证据采取保守策略：结果内容变化可能令等价结果看起来是新证据，从而延后停机。硬轮次预算仍是最终上限。进程重启后内存窗口会重置；如恢复场景需要，可单独评估跨重启检测。

## 证据

- 实现：[agent-loop.ts](../../../packages/core/src/domains/runtime/agent-loop.ts)、[no-progress-guard.ts](../../../packages/core/src/domains/runtime/no-progress-guard.ts) 与 [runtime.ts](../../../packages/core/src/domains/runtime/runtime.ts)
- 测试：[no-progress-guard.test.ts](../../../packages/core/src/domains/runtime/no-progress-guard.test.ts) 与 [runtime.steering.test.ts](../../../packages/core/src/domains/runtime/runtime.steering.test.ts)
- 文档：[02-Agent-Runtime.md](../../../docs/modules/02-Agent-Runtime.md) 与[实现路线图](../../../docs/outlive-agent-v2/09-implementation-roadmap/README.md)
- 验证：`pnpm --filter @tracegraph/core build`；`pnpm --filter @tracegraph/core typecheck`；`pnpm --filter @tracegraph/core test:unit`（434 项通过）；`pnpm verify:v2-docs`（11 个 manifest 文档、64 个路线任务）
