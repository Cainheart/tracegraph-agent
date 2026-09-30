---
id: 2026-09-30-mem-040-memory-contract-v2-migration
title: 定义版本化 Memory V2 契约与需审核的相邻迁移
status: implemented
owners: [memory, contracts]
created: 2026-09-30
last_reviewed: 2026-09-30
affects: [memory-contract, memory-migration, memory-ownership]
supersedes: []
---

# Agent Note：定义版本化 Memory V2 契约与需审核的相邻迁移

## 问题

G-21 将严格但无版本标记的 `MemoryRecord` 写入 `<dataDir>/memory/records.jsonl`。Outlive V2 为 Memory 增加 provenance、validity、governance 和 lineage，并把跨 Session Memory 归属到 owner-scoped aggregate。若原地重新解释现有 JSONL，回滚与无损比对会很困难；若从来源 Run 推断 owner 或使用资格，也会混淆来源历史和 Memory 所有权。

## 当前状态

- `MemoryRecordSchema` 是当前 G-21 结构；`JsonlMemoryStore` 直接读取和写入该结构。该 Store 是已准入记录的 canonical source，检索索引是可重建投影。
- 当前 Memory Ledger facts 写在发起调用的 Run/Session 中；尚无独立 Memory aggregate stream 或 V2 状态机。
- 当前数据目录可能包含用户记录。开发验证不应重写或检查这些真实数据。

## 决策与实现

`MemoryRecordV1Schema` 保持原有 strict G-21 结构，`MemoryRecordSchema` 仍是兼容别名，保留原有默认值和 ZodObject API。`MemoryRecordV2Schema` 是独立的可执行契约。迁移信封会保留原始解析后的 V1 行结构，包括缺省字段。转换函数要求显式 owner ID 和迁移时间，绝不从来源 Run/Session 推导 owner。导入项均为待审核 candidate；未分类记录禁止模型使用和导出。

Core 导出 `migrateMemoryJsonlAdjacent()`。它完整验证 V1 JSONL，以 mode-0600 创建 sidecar staging 文件，再通过同目录独占 hard link 发布 `records.v2.jsonl`。原 `records.jsonl` 逐字节保持不变；已有目标拒绝覆盖，函数只返回路径和数量。删除相邻输出即可回滚；本任务不切换 canonical store，也不双写。

V2 契约将 ownerId + memoryId 定义为 Memory 所有权边界；Session/Run 标识保留为来源 scope/provenance，不属于 aggregate identity。迁移保留旧 runId，将所有导入项标为 candidate，并将 consent 默认设为 none、模型使用和导出关闭。MEM-040 定义边界，但不实现 Memory Ledger stream 或生命周期命令。

### 延后事项

- 生命周期转换、独立 Memory Ledger stream 持久化、审核 UI、冲突解决、MemoryUse、自动 Episode 提取和自动 Recall 策略调整仍属于后续路线图任务。
- 加密、密钥生命周期、物理删除、备份、tombstone 和 canonical store 切换仍需独立的实现期 ADR 与恢复证据。

## 考虑过的备选方案

- 原地重写 `records.jsonl`：拒绝，因为中断转换会破坏直接回滚来源。
- 推断 owner 或将旧 `confirmed` 记录直接提升为 V2 `active`：拒绝，因为 G-21 没有 owner identity 或 V2 governance/consent 证据。因此所有迁移记录都需要审核。
- 启动第二套 Memory journal 或双写 Events：拒绝，因为 Memory aggregate 和事务边界尚未落地，会造成双真源。

## 不变量与边界

- V1 解析保持严格且无损；本任务中 G-21 Runtime 继续使用 V1。
- V2 和迁移信封 schema 必须严格、带版本，并为 status、scope/owner、provenance、validity、governance、lineage 提供契约测试。
- 每个信封保留准确解析后的 V1 原始记录；迁移不得丢弃旧 admission 元数据或扩大来源 scope。
- owner identity 必须是显式输入。Memory aggregate 独立于 Session/Run；来源 Session/Run facts 留在来源证据中。
- 相邻输出仅由用户显式调用、权限为私有、禁止覆盖，并且不会自动变成 canonical 或参与 recall。

## 迁移与回滚

完整验证源 JSONL，将每行转换成 V2 review envelope，再发布一个相邻的 `records.v2.jsonl`。遇到坏行、缺少 owner、无效日期或目标已存在时，应在发布前失败。原文件不修改。回滚仅删除生成的相邻文件；Runtime 继续读取 V1 canonical 文件。

## 验收标准

- [x] V1 schema/read path 在不改变 V1 结构的前提下接受现有记录。
- [x] V2 schema 测试覆盖 status、scope/owner、provenance、validity、governance 和 lineage 不变量。
- [x] V1 到 V2 的转换无损且需要审核；不得猜测缺失的 owner。
- [x] 相邻迁移拒绝覆盖、保证源文件字节不变；无效记录/options 不会发布输出。
- [x] Memory 模块文档与路线图区分已交付的契约/迁移工具和延后的生命周期/runtime 切换。

## 风险与未决问题

- 未来 Runtime 切换必须提供稳定 owner identity，并决定如何把旧 Run scope 映射为 V2 授权而不扩大权限。
- MEM-041 后续已在 canonical Evidence Ledger 中实现 owner-scoped lifecycle stream，并具备单实例串行化、expected-sequence CAS、幂等与 hash-chain 校验。历史 Run/Session Event 迁移策略仍延期。
- 旧记录的 expiry timestamp 可能早于创建时间；这些记录在 V1 中仍须可读，但迁移必须按行给出诊断并失败，不得静默修补。
- 原子且不覆盖地发布 sidecar 需要底层文件系统支持同目录 hard link；不支持时安全失败且不修改 canonical V1 文件。

## 证据

- 实现：`packages/contracts/src/memory.ts` 定义 V1/V2 schema 与保留原始行的迁移信封；`packages/core/src/domains/memory/memory-migration.ts` 提供 opt-in 相邻 sidecar 发布。模块 08、V2 Memory 概览、contracts/Core README 和 roadmap acceptance 均说明真实切换边界。
- 测试：contracts 21 个文件 / 142 项测试通过；Core 42 个文件 / 369 项测试通过。新增夹具覆盖完整字段迁移、缺省字段、owner/run scope、权限模式、源文件字节保持、拒绝覆盖、无效行/options 不产生输出。
- 验证：完整 `pnpm typecheck` 通过；`pnpm test:engineering` 通过（48 项 Node 测试 + 8 项 coverage gate）；implementation-consistency eval 通过（6 项）；`verify:boundaries` 通过（18 个包、34 条依赖、1,455 条 imports）；`verify:v2-docs` 通过（11 份文档、62 个任务）；package README、lockfile、invariants、generated graph/baseline 与 `git diff --check` 均通过。迁移仅使用隔离临时夹具验证；未读取或改动本机用户 Memory 文件。
