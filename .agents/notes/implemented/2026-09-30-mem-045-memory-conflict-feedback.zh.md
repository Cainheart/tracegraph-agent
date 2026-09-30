---
id: 2026-09-30-mem-045-memory-conflict-feedback-zh
title: 增加确定性 Memory 冲突、有效期与使用反馈治理
status: implemented
owners: [memory, contracts, evidence]
created: 2026-09-30
last_reviewed: 2026-09-30
affects: [memory-recall, memory-feedback, evidence-ledger, memory-governance]
supersedes: []
---

# Agent Note：增加确定性 Memory 冲突、有效期与使用反馈治理

## 问题

MEM-041 建立了由审核驱动的 V2 生命周期状态，MEM-042 建立了精确版本的 Context provenance 与 Run 级 MemoryUse。它们尚未提供可复用的 V2 召回门来处理未解决冲突和过期，也没有持久化 response-backed Memory 使用反馈的方式。G-21 V1 Runtime 仍是真正的生产路径，本任务不能顺带切换它。

## 当前状态

- Contracts 导出 strict、无正文的冲突、召回门与版本化反馈 schema。
- Core 导出确定性冲突检测、V2 召回资格、反馈记录/重放与 review dismissal API。
- Evidence 在既有 canonical Ledger 中按 owner + Memory ID + 不可变版本隔离持久化反馈，采用 sequence CAS、幂等键、hash chain 和 durable replace。
- 反馈必须指向 Run `MemoryUse` 中准确的 V2 schema/version/content digest，且 MemoryUse 已到 `response`，Run、use ID 与 ContextManifest 均匹配。每个用户对同一个 MemoryUse/version 最多提交一个反馈值；相同反馈的重试幂等。
- 上述 API 未接入 G-21 `remember()`/`recall()`、Runtime 自动召回、V2 canonical record store 或客户端 UI。
- Actor contract 只校验 user identity 的数据形状；身份认证和 owner 授权由未来可信命令调用方负责，本 API 不提供这些能力。

## 决策

仅当记录具有相同 owner、相同非空显式 `normalizedKey`、scope 与有效期有重叠，并且 claim 的 SHA-256 digest 不同，才判为冲突。Key 使用 Unicode NFKC、trim、大小写与空白折叠规范化。不推断语义冲突。冲突组是确定性派生视图，只包含 ID、版本、状态和 key digest；它不发出 lifecycle conflict event，也不改变记录状态。V2 资格门阻断所有未解决冲突参与者。

V2 资格门还会阻断非 active、owner/请求 scope 不匹配、尚未生效或 `validUntil <= now`，以及不符合模型使用 consent、sensitivity 或 source trust 的记录。输入必须是完整的单 owner V2 快照，每个 Memory ID 只能有一个当前版本。该 API 是纯决策 seam，不改变 G-21 V1 检索行为。

反馈作为单独的、无正文 Memory aggregate stream 持久化，因为它是关于某个不可变 Memory 版本的长期治理事实，而 MemoryUse 本身属于一次 Run。`helpful` 和 `irrelevant` 只形成可重放计数，不改变真实性、置信度或排序。`incorrect` 和 `stale` 打开复核要求，在 reviewer 追加 dismissal 前阻断该版本。Dismissal 只关闭复核门；纠正、supersede、revoke 与删除交给后续控制面命令。

## 考虑过的备选方案

- 语义/模型辅助冲突检测：不采用，因为它会在安全门中引入未经审核的推断；冲突要求显式 key 和确定性证据。
- 持久化 `memory.conflict.detected` 或在此任务中改 lifecycle status：延期，因为冲突是从调用方快照派生的，解决需要用户可见控制面。
- 将反馈写进 Run MemoryUse 事件：不采用，因为反馈是长期治理事实，不是请求交付状态机的一步。
- 反馈直接修改 truth/confidence 或检索排序：不采用，因为单次主观评价不能证明正确性或因果关系。
- 将 G-21 Runtime 切换到 V2：延期到 V2 canonical store 与控制面另行评审之后。

## 不变量

- 没有显式 `normalizedKey` 就不推断语义冲突；scope 不相交的记录可以并存。
- 过期/未来有效、非 active、scope 不符、不可信、未授权或禁用模型使用的 V2 记录不能进入召回资格集。
- 未解决冲突的所有参与者均阻断；不做 last-write-wins。
- 反馈绑定准确 V2 schema/version/content digest 与 response-backed MemoryUse/ContextManifest；同一用户不能用新幂等键重复放大同一次使用的反馈计数。
- incorrect/stale 在追加 dismissal 前持续阻断；dismissal 不会改写 claim 或 provenance。
- 反馈事实不含 Memory claim、Context 正文、Adapter 响应或用户自由文本。Ledger replay 拒绝 sequence、identity、幂等、hash chain 和 review 转移损坏。
- G-21 V1 store、Runtime recall 与 Run `SessionEvent` schema/sequence 均不变。
- 不得把 actor schema 当成 owner 已认证/授权的证明；组合根或控制面必须在调用服务前授权。

## 迁移与回滚

没有数据迁移。只有 Core 显式调用反馈 API 时才创建反馈文件。回滚时停止调用新 API；已提交 Ledger 事实继续追加保留，不随代码回滚删除或改写。V1 records 与 Memory 索引不被重写。

## 验收标准

- [x] 派生显式 key 冲突；V2 召回门阻断全部未解决参与者。
- [x] 有效期、状态、owner/scope、治理和来源可信度过滤 fail closed。
- [x] 反馈绑定准确 V2 schema/version/content digest、response-backed MemoryUse 与 ContextManifest。
- [x] helpful/irrelevant 不影响真值/排序；incorrect/stale 在追加复核 dismissal 前阻断。
- [x] Feedback replay 校验追加 hash chain，并拒绝同一用户对同一 MemoryUse/version 重复投票。
- [x] G-21 V1 Runtime 未改变，当前/目标文档已准确说明边界。

## 证据

- Contracts：`packages/contracts/src/memory-governance.ts` 与包根导出。
- Core：`packages/core/src/domains/memory/memory-governance.ts` 与包根导出。
- Evidence：`packages/evidence/src/event-ledger.ts` 与公开 API 测试。
- 聚焦测试：Contracts 12 项、Core Memory 22 项、Evidence public API 4 项通过。
- 验证：`pnpm typecheck` 通过 18 个可构建 workspace 项目与 eval typecheck；`pnpm -r --if-present test:unit` 通过 119 个文件共 1,037 项测试；`pnpm test:engineering` 通过 48 项 Node 检查与 8 项 Vitest 检查；implementation-consistency eval 通过 6 项。`verify:boundaries` 通过（18 packages、34 条 workspace dependencies、1,493 条 imports、0 个 legacy findings）；package README 门禁通过（18 个）；207 个源码文件的不变量检查通过；V2 docs 通过（11 份文档、62 项任务）；生成图与当前基线检查通过；`git diff --check` 通过。
- 当前/目标文档：模块 08、Memory 与 Experience 专题、迁移基线、package README 和路线图。
