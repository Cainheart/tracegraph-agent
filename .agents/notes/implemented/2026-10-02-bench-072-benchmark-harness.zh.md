---
id: 2026-10-02-bench-072-benchmark-harness
title: Outlive Benchmark harness 与运行报告
status: implemented
owners: [benchmarks]
created: 2026-10-02
last_reviewed: 2026-10-02
affects: [BENCH-072, BENCH-073]
supersedes: []
---

# Agent Note：Outlive Benchmark harness 与运行报告

## 问题

BENCH-072 要求一个可复现 harness，记录原始样本、固定预算和机器元数据。现有离线性能 eval 只覆盖少量确定性回归门禁，尚无可复用的跨路径报告格式供后续 BENCH-073 用户路径基线使用。

## 当前状态

Benchmark 目标记录在 `docs/outlive-agent-v2/07-quality-benchmarks-snapshots-i18n/02-benchmark-system.md`。现有 `evals/perf/` 仍是独立的 G16 回归 eval。在 BENCH-072 交付时，通用 runner 已可供当时规划中的用户路径场景使用；这些场景及受审预算现已由 BENCH-073 实现，详见 `.agents/notes/implemented/2026-10-02-bench-073-user-path-baselines.zh.md`。

## 决策

`benchmarks/support/` 中的无第三方依赖 Node runner 接受严格 JSON 场景 manifest。Runner 先运行一次正确性命令，通过后再按固定配置启动 warmup 和测量样本；每次调用使用新进程和私有临时 HOME/TMP。它按 manifest 中受源码评审的 wall-time P95 预算判定，并写出有界 JSON 报告，包含原始结果、统计摘要、配置摘要、Git 状态以及不含身份信息的机器/运行时元数据。Node 子进程启用仓库离线 guard，并清理凭据环境变量。报告仅写入 Git 忽略的 `_tmp_benchmarks/`。

### Target

- 场景定义和预算可在仓库中审查。
- 正确性失败会停止测量并生成失败报告。
- warmup 与测量样本区分记录；每次调用使用新进程与私有临时目录。
- 有界制品保留原始样本、正确性结果、汇总、预算结果、commit/dirty 状态及机器/运行时元数据。
- 普通 `pnpm test` 不执行性能场景；纯 harness 契约测试纳入 `test:engineering`。本任务不提前建立 BENCH-073 用户路径基线。

### Deferred

- 首批八个用户路径场景、校准预算和趋势/回归基线属于 BENCH-073。
- 进程树 RSS/CPU 测量适配器和 CI runner 类校准需结合具体场景提供证据，留待后续。
- 公开 benchmark dashboard 及网络/模型测量不在范围内。

## 考虑过的备选方案

- 只复用 G16 Vitest eval：它使用固定代表性指标和不同的报告/基线生命周期，无法充当可复用路径 harness。
- 在根级单测中加入计时断言：调度器噪声会使正确性 CI 不稳定，也不会保留可审阅的原始制品。

## 不变量与边界

- Node 子进程对标准 fetch/TCP/TLS/UDP/DNS API 使用离线 guard；凭据样式和代理环境变量被清除，`HOME`/临时目录被隔离，继承的 `NODE_OPTIONS` 被受控 guard import 替换。
- Runner 不使用 shell，拒绝仓库外工作目录，并限制参数、样本数、超时和报告大小；stdout/stderr 丢弃且不保留。
- 正确性是前置条件；正确性命令失败时不得产生有效性能结果。
- 预算只来自受版本控制的场景 manifest；环境变量不能静默放宽预算。
- 报告不包含主机名、用户名、绝对路径、命令输出或环境变量值。
- Benchmark 只测量现有产品入口，不复制产品算法。

## 迁移与回滚

本任务新增工具入口，不变更产品数据或基线。回滚时移除 `benchmarks/`、根级 benchmark script/测试注册以及 BENCH-072 Note/文档更新；现有 G16 eval 保持不变。

## 验收标准

- [x] 严格场景 manifest 定义固定正确性命令、warmup/样本数量、命令超时和预算。
- [x] Harness 写出有界机器可读报告，包含原始样本、汇总、预算、机器/运行时元数据及配置摘要。
- [x] 测试证明隔离与清理、离线和凭据 guard、正确性 fail-closed、预算失败、超时和报告生成。
- [x] 质量模块和路线图准确描述已交付范围与延期项；不宣称 BENCH-073 基线已完成。

## 风险与未决问题

初始预算留给 BENCH-073 校准。v1 提供 wall time 和主机元数据；进程树资源指标需先有可移植且独立验证的适配器，才能作为正式测量。离线 guard 不是 OS sandbox，因此受评审的场景不能启动具备网络能力的非 Node 客户端，并须将写入定向到提供的临时根目录。

## 证据

- 实现：`benchmarks/support/runner.mjs`、`benchmarks/support/offline-guard.mjs`、`benchmarks/AGENTS.md` 和根级 `benchmark` script。
- 测试：`benchmarks/support/runner.test.mjs`（7 项契约测试）。
- 验证：`pnpm test:engineering`（55 项 Node 测试与 8 项 Vitest 测试）、`pnpm verify:boundaries`、`pnpm verify:v2-docs`、`pnpm verify:package-readmes`、`pnpm benchmark -- --help` 和 `git diff --check` 均通过。
