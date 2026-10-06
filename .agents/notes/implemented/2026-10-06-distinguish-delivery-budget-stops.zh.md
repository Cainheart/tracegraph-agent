---
id: 2026-10-06-distinguish-delivery-budget-stops
title: 区分 Run 预算停止与 Goal 预算停止
status: implemented
language: zh-CN
owners: [runtime]
created: 2026-10-06
last_reviewed: 2026-10-06
affects: [runtime-events, run-projection, workbench]
supersedes: []
---

# Agent Note：区分 Run 预算停止与 Goal 预算停止

[English](2026-10-06-distinguish-delivery-budget-stops.md)

## 问题

截图中普通项目 Run 因“Goal budget stopped”停止。当时普通 Run 使用 200,000 Token 累计预留、15 分钟租约和 12 轮限制。界面上的 `213K / 226K` 是模型上下文窗口读数，不是 Run 的累计用量。系统在下一次模型请求前安全停止，但显示的预算归属和原因不准确。

## 决策

普通对话和项目 Run 不再设置累计 Token、总时长或固定轮数上限。请求依据所选模型已确认的上下文和输出能力构建；上下文压力约达 80% 时压缩；暂时性模型请求失败最多进行五次有界重试。Goal 仍执行用户明确设置的预算。无进展保护、单项操作超时、权限审批、取消和未知副作用核对继续有效。

## 兼容性

Goal 和显式设置有限预算的兼容性 fixture 仍可使用共享有限预算恢复。历史 Run 保留原 Ledger 事实和可读诊断；打开或重连 Run 不会重新提交任务。重试仅作用于工具派发前的模型请求，不会重放工具调用或写操作。

## 不变量

- Event Ledger 仍是事实来源。停止原因归属对应 Run 和轮次；较早轮次的失败不能覆盖之后的正常回答。
- 公开进度仅包含经过验证的用户可见阶段和真实回执。私有推理、上下文构建和 Token 估算不进入公开投影。
- 仅已知结果可按有界模型请求策略重试。未知写入必须先核对回执与磁盘结果，之后才可由用户明确继续。
- 上下文窗口用量与 Run 累计预算是两种不同度量。

## 迁移与回滚

无需迁移 Ledger。既有终态记录保持不变，并根据记录的 Run 和预算归属投影。回退普通 Run 策略会恢复提前触发的累计预算停止；显式 Goal 限制和兼容性 fixture 仍可独立测试。

## 验收

- [x] 普通项目 Run 可超过过去的 200,000 Token、15 分钟和 12 轮默认值继续运行。
- [x] 上下文压力会触发压缩；暂时性模型请求失败最多重试五次。
- [x] Goal 预算停止仍生效；无进展保护和单项操作超时仍生效。
- [x] 模型请求重试不会重放工具调用或未知写入。
- [x] 已安装的 macOS arm64 应用从用户安装路径运行，Host 上报的 Product Build ID 与包内 runtime manifest 一致。
- [ ] Windows 原生安装和界面验收待用户验证。
- [ ] Developer ID 签名和公证待有效发行凭据。

## 证据

- 实现：[`runtime.ts`](../../../packages/core/src/domains/runtime/runtime.ts)、[`retry-policy.ts`](../../../packages/core/src/domains/runtime/retry-policy.ts)、[`runtime-service.ts`](../../../packages/core/src/domains/context/runtime-service.ts)、[`ChatProcess.tsx`](../../../packages/workbench/src/components/ChatProcess.tsx)
- 测试：[`runtime.shared-budget.test.ts`](../../../packages/core/src/domains/runtime/runtime.shared-budget.test.ts)、[`retry-policy.test.ts`](../../../packages/core/src/domains/runtime/retry-policy.test.ts)、[`delivery-recovery-safety.test.ts`](../../../packages/core/src/domains/runtime/delivery-recovery-safety.test.ts)
- macOS 安装、Profile 保留、清理、包检查和发行外部依赖：[重建验收记录](../../../docs/validation/desktop-install-2026-10-06-rebuild/README.md)
- 此前停止原因与历史有限租约证据：[Run 停止调查](../../../docs/validation/runtime-budget-stop-2026-10-06.md)
