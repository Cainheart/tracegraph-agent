---
id: 2026-09-30-mem-041-memory-lifecycle
title: 在 canonical Evidence Ledger 中实现 Memory V2 生命周期转移
status: implemented
owners: [memory, contracts]
created: 2026-09-30
last_reviewed: 2026-09-30
affects: [memory-lifecycle, memory-contract, memory-persistence]
supersedes: []
---

# Agent Note：在 canonical Evidence Ledger 中实现 Memory V2 生命周期转移

## 问题

MEM-040 定义了带版本的 V2 记录和需审核的迁移 sidecar，但尚未定义生命周期命令、转移事件或并发边界。当前 G-21 JSONL store 在单独评审切换之前必须继续作为 V1 canonical store。

## 当前状态

- `MemoryRecordV2Schema` 定义 candidate/active/disputed/superseded/revoked/expired 状态。
- V1 Runtime 与 Run Event Ledger 以 Session/Run 为范围。MEM-041 在 canonical Evidence Ledger 中增加 owner-scoped Memory aggregate stream，不改变 Run `SessionEvent` envelope。
- V1→V2 sidecar 包含待审核候选记录，但 Runtime 不会加载它。
- Core 提供以 immutable V2 candidate seed 为输入的生命周期服务；G-21 Runtime 仍使用 V1。

## 决策

实现一个仅供 V2 使用的生命周期服务，将转移写入 canonical `@tracegraph/evidence` Event Ledger 所拥有的、按 owner 和 memory 标识分区的 append-only stream。`JsonlEventLedger` 将它存放在现有 Evidence Ledger root 下的独立 hash 命名空间；Core 不创建第二套 Event store。该 stream 是生命周期转移事实源；V2 record/sidecar 仍是 claim 与 provenance 数据源。每个 `memory.lifecycle.transitioned` 事件保存 aggregate identity、确切 record version、序号、动作、转移前后状态、actor、原因码、可选关联 Memory 和 hash-chain 信息，不保存 claim 正文或自由文本审核理由。

服务通过 expected lifecycle sequence 实现乐观并发控制，通过 idempotency key 支持重试。Evidence Ledger 通过单个 ledger 实例串行化写入，并使用现有 durable replace/hash-chain 边界发布 stream；遇到序列、hash chain、status chain、schema 或 identity 不一致时拒绝写入。一个 lifecycle stream 固定绑定一个 Memory record version；正文变化须另行决定新版本/aggregate 规则。多个 ledger 实例/进程共享 root 暂不支持；在多个 Host 共享 data directory 前必须另行解决。

Lifecycle API 为显式 opt-in，不接入 G-21 `remember()`/`recall()`、Runtime 启动或 V1 store。`active` 状态本身不授予模型使用或导出权限，现有 scope 与 governance 校验仍然适用。迁移得到的 `legacy_unclassified` 记录必须先经用户审核并补齐有效分类与 governance 才能激活；它仍可被拒绝/撤销且保持不可用。

## 转移策略

- Candidate：显式用户 `review_activate` 后才可激活；`review_reject` 会将其撤销。
- Active：用户/系统可因新证据提出争议；已有 active 的替代项可将其 supersede；用户/系统治理可撤销；系统可按保留期限或策略使其过期。
- Disputed：用户审核后可恢复 active，或以 superseded 解决；也可撤销。
- Superseded：只允许撤销。
- Expired：用户 `revalidate` 后返回 candidate、设置未来的有效期截止并重置 `validFrom`；也可撤销。
- Revoked 为终态。任何转移都不静默编辑 claim 内容，也不允许候选项绕过用户审核直接激活。

每个转移只生成一个事件。Supersede 事件会记录关联 Memory ID，但不会原子修改另一个 aggregate；在跨 aggregate 事务设计完成前，调用方必须另行协调 successor admission。

## 备选方案

- 将生命周期 Event 写入来源 Run stream：不采用，因为 Memory 所有权独立于来源 Run；改为在 canonical Evidence Ledger 中保存独立的 owner-scoped Memory aggregate stream。
- 原地重写 V1 `records.jsonl` 或把 MEM-040 sidecar 改为 canonical：不采用，因为本任务不能隐式迁移用户数据或切换 Runtime 读取路径。
- 只实现进程内状态机：不采用，因为生命周期变更必须可跨重启保留并可回放。

## 不变量

- 非法状态/动作、actor/原因码组合在持久化前拒绝。
- 从候选 seed record 与通过校验的生命周期事件可确定性重建投影。
- 每个已提交状态转移恰有一个 append-only event；相同 idempotency key 的重试返回原 event。
- 过期的 expected sequence 不能追加竞争转移。
- 一个 lifecycle stream 内 V2 内容版本保持固定；状态转换不创建正文修订。
- Memory owner identity 不从 Run 或 Session 推断。
- Lifecycle event 不含 claim 正文，只包含有界原因码。
- 后续任务明确组合此服务前，不改变 Runtime 或 UI 行为。

## 迁移与回滚

默认不会读取或改动现有数据。调用方需显式提供 Evidence Ledger 和 V2 candidate seed 以选择使用该 API。回滚时停止调用新 API，并保留已经提交到 canonical Ledger 的生命周期事件；物理删除这些事实须另行评审保留/删除策略。不得触碰 V1 records 或 MEM-040 sidecar。

## 验收标准

- [x] 严格 lifecycle command/event schema 与合法转移策略。
- [x] 非法转移、无效激活、identity/version 错误、过期序号、损坏 hash chain 和冲突的幂等键均 fail closed。
- [x] 从 candidate seed 与事件确定性回放 status 及重新验证后的 validity。
- [x] 每次成功转移产生一条 owner-scoped、无 claim 正文的事件；重启和重试语义明确。
- [x] 当前 Memory 模块文档与路线图区分已交付 API 和保持不变的 V1 Runtime。

## 风险与未决问题

- Ledger 当前只保证单实例 writer 串行化；多个实例/进程共享目录仍不支持。
- 同时 supersede 两个 Memory aggregate 不是原子操作。后续 Memory 控制面必须安全地排序并协调这两次写入。
- 物理删除、密钥销毁、加密、V2 canonical record store 以及 Runtime/UI 集成仍延期。

## 证据

- 实现：`packages/contracts/src/memory.ts`、`packages/evidence/src/event-ledger.ts`、`packages/core/src/domains/memory/memory-lifecycle.ts` 及 Core/Evidence package exports。
- 测试：`packages/contracts/src/memory-v2.test.ts`、`packages/core/src/domains/memory/memory-lifecycle.test.ts` 与现有 Core Memory/Evidence 测试集。
- 生成文档：`docs/generated/module-graph.md` 与 `docs/generated/current-baseline.md` 的检查发现文档落后后，已重新生成。基线包含整个当前工作树，也包括之前已存在的 PKG-032～035 package extractions；18 个包、60,840 行和 143 个测试文件是全仓当前快照，不能只归因于 MEM-041。
- 验证：`pnpm typecheck` 全 workspace build/typecheck 通过；Contracts focused tests 6 项、Core Memory 全量 19 项、Evidence 全量 3 项通过。`pnpm verify:v2-docs` 通过（11 份 manifest 文档/62 个 roadmap tasks），`pnpm verify:boundaries` 通过（18 个包/34 条依赖/1,466 个 imports/0 个 legacy findings），`pnpm verify:package-readmes` 通过（18 个包），`pnpm verify:invariants` 通过（203 个 source files），重生成后 `pnpm graph:modules:check` 与 `pnpm baseline:current:check` 通过，`git diff --check` 通过。由于 shell 继承的 preload 路径不可用，执行命令时通过 `env -u NODE_OPTIONS` 清除了该变量。
