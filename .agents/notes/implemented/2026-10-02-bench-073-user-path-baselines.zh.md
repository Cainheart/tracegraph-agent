---
id: 2026-10-02-bench-073-user-path-baselines
title: BENCH-073 用户路径基线
status: implemented
owners: [benchmarks]
created: 2026-10-02
last_reviewed: 2026-10-02
affects: [BENCH-073]
supersedes: []
---

# Agent Note：BENCH-073 用户路径基线

## 问题

BENCH-072 提供了离线进程 Runner，但 Outlive 首批八条用户路径还没有可重复的性能场景。缺少固定 fixture、正确性 oracle、受审预算和 CI 报告，性能变化就无法稳定比较。

## 当前状态

Runner 接受严格场景 manifest，并写入有界 wall-time 报告。BENCH-073 增加了八条生产路径场景、受审 P95 ceiling 和专用 CI job。`evals/perf/` 仍是独立的 G16 质量门禁。首轮本地校准环境为 macOS ARM64 / Node 24.21.0；专用 CI 环境为 Ubuntu 24.04 / Node 22.19.0，首次托管 CI 报告仍待审查。

## 决策

八个固定离线场景通过公开生产包入口覆盖：Runtime/Host 就绪、持久化 Ledger 追加、已完成 Run 的 replay、Context compact、受治理的 Memory 排序、受限文件 Tool 执行、Runtime 取消并达到终态静默、以及中断 Run 恢复。每个场景有独立 correctness 命令、一次 warmup、五个测量样本和 manifest 中受审的 wall-time P95 ceiling。本地首轮观测 P95 与上限见 `benchmarks/README.md`。合成状态只写入 Runner 提供的临时根目录。

完整 suite 已接入专用 CI job，固定使用 Ubuntu 24.04 和 Node 22.19，并配置上传所有有界报告，包括失败运行的报告。预算只通过 manifest 中显式、可评审的修改调整，不提供自动覆写基线命令。预算是硬上限，不是跨提交趋势比较；报告继续作为后续校准的原始证据。

### 目标

- 八条路径都通过现有的全新进程离线 Runner 执行。
- 正确性断言先证明预期路径结果，再开始计时。
- 固定路径上限超标时使 CI 失败；机器元数据和原始样本报告保留为 CI 制品。
- 预算修改明确显示在场景 manifest diff 中。

### 延期

- 进程树 RSS/CPU 采样仍不属于 Runner v1。
- 跨提交统计基线比较和 Runner 类方差建模留待后续；低于硬上限的较小退化不会单独告警。
- 外部 provider、网络和模型质量评估不进入这组离线场景。

## 不变量与边界

- 场景调用构建后的公开生产包入口，不复制产品算法，也不依赖 Langfuse。
- 场景数据和生成文件只写入 `TRACEGRAPH_BENCHMARK_TEMP_ROOT`，并在每个进程结束后删除。
- Runner 丢弃命令输出，只记录有界结果元数据。
- 正确性失败时跳过性能测量。
- 不修改现有 G16 评估基线和普通正确性测试套件。

## 验收

- [x] 八个版本化 manifest 覆盖 cold start、Ledger、replay、Context、Memory、Tool、cancel 和 recovery。
- [x] 每个 manifest 的正确性命令通过且具有固定 P95 预算。
- [x] 专用 pinned CI 已配置为执行完整场景并上传有界报告。
- [x] 人为调低预算会使 benchmark gate 失败。
- [x] 当前文档和路线图区分已交付的硬上限与延期的统计趋势比较、RSS/CPU 测量。

## 回滚

移除八个 manifest、路径场景、专用 CI job 和 BENCH-073 文档/路线图条目。BENCH-072 Runner 契约和现有 G16 评估仍可独立使用。

## 证据

- 实现：`benchmarks/paths/scenario.mjs`、`benchmarks/scenarios/` 下八个 manifest、`benchmarks/support/runner.mjs` 和 `.github/workflows/ci.yml` 的 `benchmarks` job。
- 测试：`benchmarks/support/runner.test.mjs` 覆盖 correctness fail-closed、离线隔离、超时，以及人为降低预算后 gate 失败。
- 验证：`pnpm benchmark:check` 已通过构建和本机八条路径；`pnpm test:engineering` 通过 55 项 Node 测试和 8 项 Vitest 测试；`pnpm verify:boundaries`、`pnpm verify:v2-docs`、`pnpm verify:package-readmes`、`pnpm graph:modules:check` 和 `git diff --check` 均通过。本任务未运行 GitHub 托管 Ubuntu CI job。

## 风险与限制

首轮 P95 观测来自 macOS ARM64 / Node 24.21.0，而 CI 固定使用 Ubuntu 24.04 / Node 22.19.0。首次 CI 报告需要审查后再收紧上限。低于 ceiling 的退化不会使该 gate 失败；当前没有跨提交统计比较。RSS/CPU 和外部 provider 场景仍延期。
