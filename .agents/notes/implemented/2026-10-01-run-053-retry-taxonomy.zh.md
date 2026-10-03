---
id: 2026-10-01-run-053-retry-taxonomy
title: 分离有界 Provider 重试与 Tool、Action 派发
status: implemented
owners: [runtime]
created: 2026-10-01
last_reviewed: 2026-10-01
affects: [runtime, contracts, events, tools, recovery]
supersedes: []
language: zh-CN
---

# Agent Note：分离有界 Provider 重试与 Tool、Action 派发

## 问题

模型传输层瞬时故障重试、重放 Tool、重新执行结果未知的外部 Action，安全属性各不相同。共用重试循环可能重复副作用或掩盖未知结果。

## 当前状态

Runtime 在每个 `model.request_started` 中记录有界重试分类。Tool 执行最多单次派发；外部 Action 不确定性由 RUN-052 的只读对账契约处理。见 [`agent-loop.ts`](../../../packages/core/src/domains/runtime/agent-loop.ts)、[`retry-policy.ts`](../../../packages/core/src/domains/runtime/retry-policy.ts)、[`runtime.ts`](../../../packages/core/src/domains/runtime/runtime.ts) 和 [Runtime 模块指南](../../../docs/modules/02-Agent-Runtime.md)。

## 已实现决策

模型 Provider 对显式瞬时 HTTP 或传输错误最多尝试 3 次。确定性指数退避为 250 ms、500 ms，策略上限为 1,000 ms。Runtime 不重试任意 Adapter 异常、永久 HTTP 响应、无效 Decision、取消，或已经报告 usage 的请求。`model.retry_scheduled` 持久化记录重试序号、原因分类和实际等待时长；最终的 `model.decision` 或 `model.request_failed` 会记录尝试总数和退避时长。取消会中止等待，且后续派发仍受 RUN-051 controller 门控。

Tool executor 不会自动重放；Tool 失败会结束 Run。模型后续新生成的 Tool 调用是独立 Action，受 Run 轮数上限、策略、唯一 action identity 和 RUN-050 no-progress guard 约束。每个规范 Action operation 只派发一次。外部结果未知时只能使用 RUN-052 查询对账。Patch WAL 恢复仍由其单次自动恢复 attempt 独立限制。重试 timer 只存在当前进程，不会在 Host 重启后续跑。

### 延后范围

自动重放 Tool、盲目重放 Action、抖动或 `Retry-After` 支持、Provider 专属重试覆盖，以及跨进程重启的持久化定时重试。

## 不变量与边界

- 只有 allowlist 中的瞬时 `ModelRequestError` 才能安排 Provider 重试。
- 一旦收到有效 Provider usage report，该 attempt 的重试窗口即关闭。
- 每次 Tool 派发只产生一个 `tool.started` 和一个 Tool 终态 Event；没有 executor 重放循环。
- 外部 Action 状态未知时，只授权查询对账，绝不授权重新派发。
- 重试事实写入规范 Session Event Ledger；live activity 和 Telemetry 都是投影。

## 迁移与回滚

新的 `model.retry_scheduled` Event 追加在现有 Event 类型列表末尾。已有 Event payload 仍可读取；新事实不改变历史 Projection，因此不提升 Projection 版本。关闭 Provider 重试循环即可恢复模型单次调用，无需迁移数据。

## 验收标准

- [x] 瞬时模型错误最多重试三次，并持久化准确退避事实。
- [x] 永久错误、未分类错误、已报告 usage、无效输出与取消均不重试。
- [x] Tool 派发与 Action 执行保持单次；未知 Action 结果只做对账查询。
- [x] 重试 Event 经契约校验，并投影为安全 live activity 与 Telemetry。
- [x] Runtime 文档和 RUN-053 路线项描述实际交付行为。

## 证据

- 实现：[`retry-policy.ts`](../../../packages/core/src/domains/runtime/retry-policy.ts)、[`agent-loop.ts`](../../../packages/core/src/domains/runtime/agent-loop.ts)、[`event.ts`](../../../packages/contracts/src/event.ts)、[`retry.ts`](../../../packages/contracts/src/retry.ts)、[`runtime-telemetry.ts`](../../../packages/core/src/domains/runtime/runtime-telemetry.ts)
- 测试：[`retry-policy.test.ts`](../../../packages/core/src/domains/runtime/retry-policy.test.ts)、[`runtime.usage.test.ts`](../../../packages/core/src/domains/runtime/runtime.usage.test.ts)、[`runtime.telemetry.test.ts`](../../../packages/core/src/domains/runtime/runtime.telemetry.test.ts)、[`retry.test.ts`](../../../packages/contracts/src/retry.test.ts)，以及现有 [`runtime.external-action-reconciliation.test.ts`](../../../packages/core/src/domains/runtime/runtime.external-action-reconciliation.test.ts)
- 文档：[`02-Agent-Runtime.md`](../../../docs/modules/02-Agent-Runtime.md) 和[实现路线图](../../../docs/outlive-agent-v2/09-implementation-roadmap/README.md)
- 验证：Contracts 28 个文件 / 177 项测试通过；Core 56 个文件 / 455 项测试通过。Contracts/Core build 与类型检查通过。`verify:v2-docs`、`verify:boundaries`、`verify:invariants`、`verify:package-readmes`、`graph:modules:check` 和 `git diff --check` 通过。
