---
id: 2026-10-02-snap-071-core-recorded-scenarios
title: 核心 Recorded-session 场景
status: implemented
owners: [test-support, snapshots]
created: 2026-10-02
last_reviewed: 2026-10-02
affects: [SNAP-070, SNAP-071]
supersedes: []
---

# Agent Note：核心 Recorded-session 场景

## 问题

SNAP-070 只回放最小完成场景，并比较 Run 语义事件。SNAP-071 要求增加 recovery、取消、Memory recall 和 subagent 场景，同时校验事件与 workspace 结果。

## 当前状态

有界 fixture harness 现有五个已接纳的合成 Runtime 场景。实现见 `packages/test-support/src/recorded-session/` 和 `snapshots/{runtime,memory}/`。

## 已实现决策

保留 SNAP-070 命令和五文件 fixture 布局。增加四个严格场景 ID，以有限的模拟输入覆盖：从 approval interrupted 状态恢复并 resume、取消阻塞中的 provider 请求、已审核 Memory recall、单个只读 subagent。expected 增加按序排列的前后 workspace 条目，记录相对路径与内容摘要；回放同时比较这些条目和有序语义事件。所有已接纳 fixture 继续使用合成数据、有界输入、写入前脱敏检查，回放只读。

### Target

- 使用现有离线 provider 和 fixture sandbox 执行每个真实 Runtime 场景。
- 记录稳定的事件 type/summary 对及 workspace 条目的类型、路径和内容摘要。
- refresh 输出包含事件与 workspace 差异；写入仍必须显式传 `--write`。

### Deferred

- live Session 导出、真实用户 capture、UI replay、任意工具脚本，以及依赖第三方代码或凭据的变更快照。
- OS 级 crash 注入；recovery 回放使用合成数据覆盖持久化 interrupted/resume 路径。

## 考虑过的备选方案

- 保持只有完成场景：无法满足 SNAP-071 的四个领域，故不采用。
- 只比较事件输出：事件摘要不变时无法发现 workspace 已发生变更，故不采用。

## 不变量与边界

- Runtime/Ledger 仍是权威事实源；expected fixture 只用于离线回归。
- Snapshot 脚本和文件保持严格 schema、有界和脱敏门；workspace 路径为相对路径，内容只保存 SHA-256 摘要。
- recovery 与取消由场景 ID 选择，不执行任意 fixture 输入。
- 保留 minimal-completion capture importer；它不能覆盖已接纳场景。

## 迁移与回滚

按新的 expected-output schema 更新已接纳的 minimal fixture，并增加四个合成 fixture。回滚时删除四个场景并将 harness schema/runner 恢复到 SNAP-070；不修改产品数据或用户 workspace。

## 验收标准

- [x] 四个场景都执行对应 Runtime 行为并断言有序语义事件。
- [x] 回放独立比较 workspace 前后 manifest，expected 与实际的事件/workspace 差异清楚可读。
- [x] Snapshot 读取仍有界、严格、脱敏且不写入；根 `pnpm test` 回放所有已接纳场景。
- [x] 负责模块文档和实现路线图写明交付范围与已知限制。

## 风险与未决问题

Runtime 有意变化时，事件摘要和合成 workspace manifest 也会变化；只有显式 `--write` 才允许刷新 expected。

## 证据

- 实现：[runner.ts](../../../packages/test-support/src/recorded-session/runner.ts)、[schema.ts](../../../packages/test-support/src/recorded-session/schema.ts) 和 root `test:snapshots` script。
- 测试：[runner.test.ts](../../../packages/test-support/src/recorded-session/runner.test.ts)、`snapshots/` 下五个已接纳 fixture。
- 验证：`pnpm test` 通过，包含 build、五个已接纳 snapshot replay、所有 workspace 包单测和工程门禁；Core 56 个文件/457 项测试通过，test-support 4 个文件/67 项测试通过。
