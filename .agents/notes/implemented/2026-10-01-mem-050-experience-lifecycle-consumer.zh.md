---
id: 2026-10-01-mem-050-experience-lifecycle-consumer
title: Experience 生命周期与 Runtime 召回消费者
status: implemented
owners: [experience, memory-runtime]
created: 2026-10-01
last_reviewed: 2026-10-01
affects: [experience-governance, runtime-context, provenance]
supersedes: []
---

# Agent Note：Experience 生命周期与 Runtime 召回消费者

## 问题

MEM-044 生成有证据的 Experience candidate，但明确排除了持久化、审核、检索和注入。在 candidates 具备 canonical 审核路径、Runtime 能带独立 provenance 将当前已验证且适用的 Case 交给模型之前，MEM-048 无法开展有意义的 Experience off/on 对照。

## 已实现状态

- Experience Case candidate 有独立 owner-scoped 持久化，并在 canonical Evidence Ledger 中追加生命周期 aggregate。
- Runtime 通过 CAS/幂等命令和确定性 replay 显式执行审核/验证、dispute、resolve 和 retire。
- Recall 读取最新 validated 投影，检查 project scope、明确的任务适用性和 counterexamples；状态损坏或不可用时 fail closed。
- Runtime 注入默认关闭，使用独立 `experience` Context section、token 分区以及 Case/version/evidence 来源；Memory 事件仍保持隔离。

## 实现

### Target

在 owner-scoped 本地 store 中保存不可变的 Experience candidate seed，并将 review/validate、dispute、resolve、retire facts 追加到 canonical Evidence Ledger 的独立 Experience aggregate namespace。Replay 校验身份、序列、状态迁移、幂等键和 hash chain。检索读取最新投影，只接受显式 validated 的 Case，再根据明确的任务事实检查 owner/project scope、适用条件和 counterexamples；状态不可用或损坏时不返回结果。Runtime 注入默认关闭，启用后使用独立的 `experience` Context section，并记录 Case/version/source/evidence 来源；经验模式仅作为建议。

### 暂缓

- 自动执行 Case action、把模型自述当作成功，或自动批准 candidate。
- 跨 owner/global 分享、原地编辑、为缺失任务事实做语义推断和无监督适用性学习。
- 复用 MemoryUse、Memory 生命周期或 Memory retrieval attribution 表示 Experience。

## 不变量与边界

- Candidate seed 不可变；review state 由 CAS/幂等检查的事件重放得出。
- 只有显式用户审核可以 validate candidate。Dispute 和 retire 会立即停止召回。
- 未知或缺失的适用事实不能算匹配；匹配的 counterexample 会阻断 Case。
- Context 分别记录 retrieved、selected 和 adapter handoff；这些事实单独都不能证明复用成功。
- Host 未显式开启前，Runtime 检索和注入保持关闭。

## 迁移与回滚

owner-scoped store 是增量新增。已有 candidate 在显式持久化/审核前仍只能供 review。默认关闭使回滚只需禁用 Runtime 选项；append-only 历史保留。

## 验收标准

- [x] Candidate 持久化、CAS 审核迁移、幂等 replay 和篡改/损坏拒绝，使用独立 canonical Ledger aggregate。
- [x] 召回必须是 validated 状态并通过精确 owner/project applicability 与 counterexample 检查。
- [x] Runtime Context 和 Ledger 能区分 Experience Case/version/evidence，并只记录实际 adapter handoff。
- [x] 默认关闭、审核/replay、scope、dispute/retire、适用性和实际 Context handoff 有 focused Runtime 测试。

## 证据

- 实现：`packages/contracts/src/experience-lifecycle.ts`、`packages/core/src/domains/experience/experience-lifecycle.ts`、`packages/evidence/src/event-ledger.ts`、`packages/core/src/domains/runtime/runtime.ts`，以及 `packages/context/src/context.ts` 的独立 Context 分区。
- Focused 行为证据：`packages/core/src/domains/experience/experience-lifecycle.test.ts` 和 `packages/core/src/domains/runtime/runtime.memory-experience-recall.test.ts` 覆盖 lifecycle/replay、validated-only recall、适用性/反例、默认关闭、provenance 与实际 Runtime handoff。
- 验证：Contracts 156/156、Evidence 5/5、Context 28/28、Core 426/426 全部通过；根 typecheck 和仓库门禁随 MEM-048 完成证据一并记录。
