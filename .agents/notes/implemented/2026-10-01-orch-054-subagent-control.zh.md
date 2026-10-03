---
id: 2026-10-01-orch-054-subagent-control
title: 在 root ledger 中保留有界 Subagent 控制与失联恢复
status: implemented
owners: [subagent-team, runtime]
created: 2026-10-01
last_reviewed: 2026-10-02
affects: [runtime, contracts, events, team, recovery]
supersedes: []
language: zh-CN
---

# Agent Note：在 root ledger 中保留有界 Subagent 控制与失联恢复

## 问题

委派 Run 需要受 Host 信任边界约束的权限、可见容量与状态、父对子持久消息、预算回执和确定性恢复。把 child 的完整事件时间线复制到 root，或在 Host 重启后重新启动不透明 child 工作，都会产生重复或含糊的证据。

## 当前状态

G-07 定义可信 `SubagentRegistry`、独立的 child Run/Session/Ledger、冻结的委派限制、step/token 预算、直接子级控制和带哈希关联的终态回执。G-08 将 Team roster、task、mailbox、heartbeat 与失联事实写入 coordinator Run 的规范 Event Ledger。边界见 [Subagent 编排与 Team 文档](../../../docs/modules/02-Agent-Runtime.md)。

## 已实现决策

- Host 持有 Registry，并据此解析 provider、role prompt/version/hash、工具 allowlist 与预算上限。模型输入只能选择 profile、有限任务包、上下文范围和请求预算。
- 公平的进程内 permit pool 会在持久化 `subagent.started` 前限制 child 启动。Run 冻结最大并发与深度。回归测试在并发上限为 1 时提交 3 个 child，验证任一时刻只有 1 个进入执行，并且 3 个最终均完成。
- 2026-10-02 补正：permit 仅在等待 parent 终态回执持久化后释放。此前直接返回终态记录 Promise 会先执行 `finally`，即使 provider 调用被串行化，后一个 `subagent.started` 仍可能先于前一个终态回执。回归测试现在同时检查 provider 峰值并发和 root ledger 的 start/terminal 顺序。
- 父 Event Ledger 记录精确的父子 Run/Session 关联、解析后的 profile 和预算、初始消息/直接 `parent_agent` 消息，以及包含 usage 和 child 终态 Event id/hash 的唯一终态结果；不会复制 child 时间线。
- `listSubagents`、`sendSubagentMessage` 与 `interruptSubagent` 仅作用于直接 child。终态 child 拒绝新消息。父取消会先收口活动 child，再写父终态。
- Team 事实（包括 `team.member_lost` 与可能的 task reopen）写入同一 root Event Ledger。失联或重启不会自动重新分配任务，也不会重复 child 模型请求。恢复会先收口非终态 child/descendant 并记录带哈希的父回执，然后 parent 才能恢复或进入终态；若 child 已终态，则从其规范 ledger 对账。

## 考虑过的备选方案

- 不把完整 child 事件时间线复制到 parent，因为 child Run Ledger 已是规范事实源，复制会导致两份证据可能分叉。
- 不在 Host 崩溃后重启非终态模型工作，因为 Runtime 无法证明被中断的 provider 请求没有副作用。

## 不变量与边界

- root Run Event Ledger 是委派、消息、Team 失联和 child 终态证明的规范证据；child 执行细节仍由 child Run Ledger 保存。
- 有效工具和预算不得超过 Host 可信 profile、parent policy 或 Run 冻结的限制。
- 容量 permit 是进程内状态。重启时 Runtime 先对账并收口所有继承的活动链接，不会把过期 permit 当作仍在运行的工作。
- 当前实现提供本地协调，不提供跨 Host 分布式调度。

## 迁移与回滚

ORCH-054 不新增持久化格式或 Event 类型；现有严格 G-07/G-08 Event schema 与 legacy 空投影保持兼容。新增容量回归测试和路线图记录可独立回退，无需迁移数据。关闭 Subagent/Team feature 仍使用既有 Runtime feature gate。

## 验收标准

- [x] 容量受到限制，状态可从 root evidence 重建。
- [x] 直接消息、冻结预算和 child 终态证明均可持久读取。
- [x] Team 成员失联与恢复事实写入 root Run ledger。
- [x] child/parent 取消与重启恢复会闭合 lineage，不会静默重放不透明模型工作。
- [x] 契约、Runtime 定向测试和当前模块/路线图文档一致。

## 证据

- 实现：[`subagent.ts`](../../../packages/core/src/domains/subagent/subagent.ts)、[`runtime.ts`](../../../packages/core/src/domains/runtime/runtime.ts)、[`team.ts`](../../../packages/core/src/domains/team/team.ts)、[Subagent contract](../../../packages/contracts/src/subagent.ts) 和 [Team contract](../../../packages/contracts/src/team.ts)。
- 测试：[`runtime.subagent.test.ts`](../../../packages/core/src/domains/runtime/runtime.subagent.test.ts)、[`runtime.team.test.ts`](../../../packages/core/src/domains/runtime/runtime.team.test.ts)、[`team.test.ts`](../../../packages/core/src/domains/team/team.test.ts)、[`subagent-g07.test.ts`](../../../packages/contracts/src/subagent-g07.test.ts) 与 [`team-g08.test.ts`](../../../packages/contracts/src/team-g08.test.ts)。
- 验证：Runtime 定向套件通过（3 个文件 / 32 项测试）；G-07/G-08 contract 定向套件通过（2 个文件 / 25 项测试）；Contracts 和 Core 的测试类型检查通过。2026-10-02 修正后的容量回归测试和完整 Core 套件也通过（56 个文件 / 457 项测试）。
- 文档：[Runtime 模块指南](../../../docs/modules/02-Agent-Runtime.md) 和[实现路线图](../../../docs/outlive-agent-v2/09-implementation-roadmap/README.md)。

## 延后范围

跨 Host worker 调度、非阻塞的持久化 worker handle、成员失联后的自动任务重新分配，以及恢复被中断的 provider 工作。
