---
id: 2026-10-02-snap-070-recorded-session-harness
title: 无密钥 Recorded-session Snapshot harness
status: implemented
owners: [test-support, quality]
created: 2026-10-02
last_reviewed: 2026-10-02
affects: [packages/test-support, snapshots, package-scripts, docs/outlive-agent-v2/07-quality-benchmarks-snapshots-i18n]
supersedes: []
---

# Agent Note：无密钥 Recorded-session Snapshot harness

## 问题

仓库已有确定性 mock provider 和 Runtime 集成测试 fixture，但没有顶层 recorded-session fixture 格式或 runner。P7 要求普通 replay 不依赖凭据，并要求创建/刷新 fixture 必须显式执行且经过脱敏。CI 依赖 snapshot 前，还需要可审查的目录布局和更新命令边界。

## 当前状态

- `@tracegraph/test-support` 导出零网络 `ScriptedMockProvider`、临时 Runtime data helpers 和受控 workspace。
- 集成测试会在进程内验证 Runtime 行为，但没有顶层 `snapshots/` fixture 目录或区分模式的 snapshot 命令。
- `docs/outlive-agent-v2/07-quality-benchmarks-snapshots-i18n/03-recorded-session-snapshots.md` 的 snapshot 布局仍是 proposed，覆盖范围大于 SNAP-070。

## 提议

在 `@tracegraph/test-support` 增加窄范围的顶层 harness 和一个合成 Runtime 完成场景。fixture 使用 strict JSON metadata、录制的 `ScriptedMockProvider` 响应、语义化 expected projection 和脱敏审阅文件。Replay 只使用仓库内的响应脚本，不初始化网络 provider，也不读取 API key 环境变量。

提供显式 `replay`、`record`、`refresh` 三种模式。`record` 从调用者明确选择的 JSON capture 导入新 case 目录；本切片不连接 live provider，也不捕获真实用户 Session。`refresh` 用已录制输入重跑，只在提供 `--write` 时替换 expected output。两个写模式都要求显式目标/身份，在写入前验证 strict schema 与脱敏门；record 不覆盖已有 case。`replay` 只读。

恢复/取消/Memory/subagent fixture 和 workspace outcome 断言归 SNAP-071。Live Session exporter、广泛格式迁移、snapshot UI replay 与自动晋级基线均延期。

## 考虑过的备选方案

- 只用 Vitest snapshots：无法区分 replay 与显式录制/刷新策略，也容易在 fixture 脱敏门之外更新 expected value。
- 第一切片直接连接 live provider 录制：会把基线耦合到凭据/网络且超出当前验收；导入显式选择的离线 capture 可保持 CI keyless。

## 不变量与边界

- Replay 是确定且只读的；不能创建 provider client、访问在线凭据存储或改写 fixture。
- `record` 与 `refresh` 不是默认模式，持久化结果必须有 `--write`。
- Fixture schema 严格且有界。含敏感凭据的字段名、常见 token/credential 格式、个人绝对路径和私钥块必须在写入前 fail closed。
- Expected output 固定稳定语义字段（终态 status/outcome 和有序 canonical event type/summary），排除易变 ID、时间戳、机器路径和模型隐藏推理。
- Snapshot 是测试证据，不是产品数据，也不是另一套 Event Ledger。

## 迁移与回滚

不改变 Runtime 或产品持久化格式。现有测试不受影响。删除 runner 或 fixture 可安全回滚；可以独立停用 CI replay，不会把 fixture 数据迁入用户状态。未来 fixture schema 版本变化需要独立的兼容性任务。

## 验收标准

- [x] 仓库内合成 Runtime snapshot 在不包含 provider key 环境变量的隔离进程中 replay，并产生固定的语义输出。
- [x] Replay 只读；缺失/未知模式会失败且不写文件。
- [x] Record 只从显式输入和写入目标创建新 case；Refresh 仅在显式 `--write` 时修改 expected output。
- [x] 写入或替换 fixture 前，schema bounds 和 secret/path 脱敏检查会拒绝不安全 source data。
- [x] test-support、root runner command、CI replay、负责文档与双语 Notes 的行为和延期范围一致。

## 风险与未决问题

- 初始语义投影刻意保持很小；不能把它当成对 recovery、cancel、Memory、subagent、workspace 写入或 UI 的覆盖。
- 导入离线 capture 不等于 live recorder。以后增加真实 Session 导出时，必须先定义 consent、source authority 和 redaction。

## 证据

- 实现：`packages/test-support/src/recorded-session/` 提供严格 schema、有界脱敏检查、CLI 模式、确定性 Runtime replay 与 semantic diff。已接收的合成 fixture 位于 `snapshots/runtime/minimal-completion/`；record 候选位于 Git 忽略的 `snapshots/candidates/`。
- 测试：test-support typecheck 通过；包内 62 项测试全通过，含 5 项 snapshot harness 测试，覆盖无凭据子进程 replay、只读/模式失败、显式 record、输入 credential/path 脱敏、已接收 model stream 敏感字段校验、禁止覆盖和 refresh 行为。另将一个既有的 timeout 断言收窄到 Tool receipt，因为 retry-policy 元数据也包含 `timeout` 一词。
- 验证：root `pnpm typecheck`、`pnpm test:engineering`、`pnpm verify:v2-docs`、`pnpm verify:package-readmes`、`pnpm verify:boundaries`、`pnpm graph:modules:check`、`pnpm snapshots replay --case runtime/minimal-completion` 与 `git diff --check` 通过。尝试运行 root `pnpm test` 时，Core 子代理容量测试失败（`ProjectionError: subagent concurrency exceeds 1`）；root 脚本现已把 SNAP-070 replay 排在 build 后、递归 package tests 前。test-support 包测试单独全通过。
