---
id: 2026-10-01-mem-047-legacy-capsule-v1
title: 实现完整性校验、审核门控的 Legacy Capsule v1
status: implemented
owners: [memory-export, contracts, core]
created: 2026-10-01
last_reviewed: 2026-10-01
affects: [legacy-capsule-v1, memory-import-candidates]
supersedes: []
---

# Agent Note：实现完整性校验、审核门控的 Legacy Capsule v1

## 问题

V2 设计描述了由用户策展的 Memory/Experience 迁移，但仓库还没有可执行 Capsule 格式、完整性校验器、脱敏边界、隔离审核或显式导入路径。当前 V2 文档同时出现 `manifest.json` 和 `manifest.yaml`；V1 必须选定唯一 wire format。

## 当前状态

- `packages/contracts/src/legacy-capsule.ts` 定义有界 strict manifest、entry、quarantine 和 accept 契约；`packages/contracts/src/memory-control.ts` 定义不含正文的导入候选命令/事件。
- `packages/core/src/domains/memory/legacy-capsule.ts` 在固定相对路径 file map 上提供确定性构建、离线验证、无写入 preview 和显式 accept。`MemoryControlService` 将导入 Memory 映射到本地 owner/scope，并写入 external/untrusted candidate，关闭 consent/model use/export。
- `packages/core/src/domains/memory/legacy-capsule.test.ts` 覆盖脱敏、checksum、不支持版本、非规范 JSONL、路径穿越、显式选择、审核 diff/过期、Experience 仅返回候选、Memory 幂等重试。
- 当前模块/API 文档位于 `docs/modules/08-Memory-记忆子系统.md`、`packages/core/README.md` 与 `packages/contracts/README.md`；V1 格式和边界记录在 `docs/outlive-agent-v2/04-memory-and-experience/README.md` 与 `05-legacy-governance.md`。
- MEM-044 提供 Experience Case 契约，但没有 Experience 持久化或审核 aggregate；导入 Case 只作为 external candidate 结果返回，不写入。

## 决策

- 使用 Memory README 第 10 节中的 V1 目录格式：`manifest.yaml`、`memories.jsonl`、`experiences.jsonl`、`policies/usage-consent.yaml`、`README.md` 和 `SHA256SUMS`。这会解决治理文档中旧的 JSON manifest 草案，并更新文档使 V1 格式唯一。
- 在现有 packages 中增加有界严格 bundle contracts 以及 Core build/verify/preview/accept 操作；不新建物理 package，也不让领域 API 接受任意文件系统路径。
- 仅导出显式选择且本地允许 export 的记录。脱敏已知 secret 和敏感结构化字段；不导出凭据、审批、策略授权、原始 Run events 或原始 artifacts，只保留来源引用。
- 在把 Capsule 解析为无副作用 quarantine preview 之前，验证精确相对路径、文件/条目/字节上限、schema、manifest digest 和 SHA256SUMS。
- Preview 生成确定性审核 diff 和确认 digest，不写入 canonical store。Accept 必须重新校验 Capsule 和审核 digest，并要求显式选择条目；只有 Accept 能写入导入 Memory candidates。
- 增加显式 MemoryControl 导入命令：在本地映射 owner/scope，记录外部 Capsule provenance，把生命周期状态重置为 `candidate`，并强制 source trust 为 untrusted、关闭模型使用和再导出。导入 claim 不继承信任、consent、active 状态或权限。
- Experience rows 作为不可信、candidate-only 导入结果返回，留待未来 Experience store；本任务不另造持久 Experience writer。

## 考虑过的备选方案

- 沿用旧的 `manifest.json` 草案：不采用，因为 Memory README 第 10 节已有 `manifest.yaml` 格式；v1 现在只保留一个 canonical 格式。
- 新建独立 `@tracegraph/capsule` package：不采用，因为尚无第二个独立消费者或硬隔离理由。
- 为导入 Experience 临时新增持久化 store：延后，因为 MEM-044 只有 Case 契约/extractor，没有 Experience lifecycle aggregate 或 canonical store。

## 不变量与边界

- Checksum 证明字节完整性，不证明作者或事实可信度；V1 不实现签名验证。
- 导入或接受 diff 都不会激活 Memory/Experience，也不会开启 Recall。
- 每个导入条目分配新的本地身份和 owner/scope 映射；外部 owner、status、provenance 和 policy 仅作为数据。
- Quarantine 非 canonical；执行 `accept` 前不得产生 candidate/event 副作用。
- 路径穿越、链接、重复/未知文件、不支持的版本、格式错误的 JSONL/YAML、digest 不匹配、超限 bundle 和含 secret 的导出材料必须 fail closed 或按明确报告脱敏。
- 不修改现有 V1 Memory 存储、Session/Run Ledger 或原始 Capsule bytes。

## 延后范围

Desktop/Web/CLI 界面、ZIP/流式传输、加密、签名信任根、原始证据/artifact opt-in、撤销传播、Experience 持久化/审核、自动迁移和自动激活均不属于 MEM-047。

## 验收标准

- [x] 确定性 V1 bundle 有唯一 manifest、有界条目和可独立验证的 SHA-256 checksums。
- [x] 导出仅包含显式选择的合格条目，能脱敏敏感内容，且不输出凭据/审批/原始来源证据。
- [x] Offline verify 拒绝篡改、格式错误/不支持的 manifest、不安全文件名、非规范 JSONL 和超限输入。
- [x] Preview 隔离已验证内容，对 Memory 条目区分 new/duplicate/conflict，返回稳定 diff digest 且不产生存储副作用。
- [x] 显式 Accept 要求匹配 bundle/diff digest 和选择 ID；Memory 导入成为持久化的不可信候选，Experience 导入仅返回 candidate 结果。
- [x] 测试覆盖篡改、secret 脱敏、路径穿越、重试/幂等、过期 preview、duplicate/conflict diff 和未选条目；当前文档与路线图一致。

## 迁移与回滚

不迁移任何已有数据。目录格式为增量新增。回滚删除新格式/服务路径和 MemoryControl 显式导入动作，不修改现有 Memory records 或 canonical Run events。

## 风险与未决问题

- Capsule ID 和源 actor 标识属于可携带 metadata；导出确认必须说明副本离开本地删除控制范围。
- 脱敏报告不能复述发现的 secret。
- 后续 Experience store 必须定义如何展示外部 evidence refs，并在持久化这些返回候选前建立本地审核流程。

## 证据

- 设计与当前边界：`docs/outlive-agent-v2/04-memory-and-experience/05-legacy-governance.md`、`docs/outlive-agent-v2/04-memory-and-experience/README.md` 第 10 节、`docs/modules/08-Memory-记忆子系统.md` 第 1.5 节。
- 实现/契约：`packages/contracts/src/legacy-capsule.ts`、`packages/contracts/src/memory-control.ts`、`packages/core/src/domains/memory/legacy-capsule.ts`、`packages/core/src/domains/memory/memory-control.ts`。
- 测试：`packages/core/src/domains/memory/legacy-capsule.test.ts`；14 项 Capsule/MemoryControl focused 测试通过，Core 419 项、Contracts 156 项全量单测通过。
- 验证：Core/Contracts build 和 Core typecheck 通过；`pnpm test:engineering`（56 项）、文档一致性 eval（10 项）、`verify:boundaries`、`verify:package-readmes`、`verify:v2-docs`、`verify:lockfile`、`graph:modules:check`、`git diff --check` 均通过。文档评估后已原样恢复 `_tmp_evals` 旧结果。
