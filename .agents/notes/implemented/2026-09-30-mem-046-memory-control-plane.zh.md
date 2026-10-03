---
id: 2026-09-30-mem-046-memory-control-plane
title: V2 Memory 统一审查与治理控制面
status: implemented
owners: [memory-api, contracts, evidence, host, cli, web]
created: 2026-09-30
last_reviewed: 2026-10-02
affects: [memory-control, memory-lifecycle, evidence-ledger, host-api, cli, web, desktop]
supersedes: []
---

# Agent Note：V2 Memory 统一审查与治理控制面

## 问题

MEM-040～045 已提供 V2 contracts、生命周期、Context/MemoryUse provenance、冲突与反馈治理，但缺少用户可见的 candidate/source/status/use 查询，以及统一的 review、correct、revoke、delete 命令。不能让 CLI、Web 或未来 Desktop 分别写文件或实现不同的状态机；也不能借此切换 G-21 V1 recall。

## 当前状态

- `MemoryControlService` 是 Core 唯一的 V2 Memory 控制 command/query 服务；`AgentRuntime` 持有服务实例。
- 新增本机 owner-scoped V2 seed store：`<dataDir>/memory-v2/<sha256(owner)>/records.jsonl`。每个 seed 是 immutable candidate；当前状态始终由 MEM-041 lifecycle event replay 得出。
- Host `/api/memory` 提供 list/create/review/correct/revoke/delete 路由；SDK 和 CLI 通过 Host 接入。Host 使用认证后的 local capability，并从当前可见项目集合派生 `allowedScopeIds`；请求体不能提供 owner 或 actor。
- Web 新增 Memory 控制面，可创建候选、检查来源/状态/冲突/反馈/MemoryUse 请求阶段、审核、更正、撤销和删除更正 lineage。
- 创建、更正、删除追加 content-free `memory.control.commanded` 到既有 Evidence Ledger；审核/撤销沿用 `memory.lifecycle.transitioned`。MemoryUse、feedback 和 lifecycle/control 仍是不同 aggregate/read model。
- 删除先提交包含 lineage IDs 与 scope IDs 的无正文 tombstone，再用 fsync + rename 重写本地 V2 record file。重复删除可重放同一 family；已删除 ID 不能被同命令重建。跨 scope 隐藏为 404。
- MEM-046 实施时，本仓尚无 Desktop client。之后 CLIENT-068 已通过版本化私有协议和共享 Workbench 将 Desktop 接入同一控制服务；见配对的 CLIENT-068 Note。

## 决策

Core 控制服务成为唯一领域写入口。Host 负责认证、命令 ID 一致性校验和 scope 派生；客户端只传输领域命令，不决定 owner/actor，也不直接改 seed store、投影或 Ledger。当前 owner 与 user actor 来自 Runtime 本地配置（默认 local single-user identity），不代表多用户账户或远端身份认证。

V2 正文和 lifecycle 状态分开：seed store 仅保存 candidate seed，status 由不可变 lifecycle transition 重放。create/correct/delete 的内容无关控制事件用于审计和 tombstone；review/revoke 不复制 claim。Correction 创建新 Memory identity/version 和 lineage，通过两个 aggregate 的事件协调；两个 aggregate 间不宣称事务原子性。

删除的当前承诺限制为本机 V2 canonical candidate payload 文件。家族 tombstone durable commit 后重写该 owner 文件；Run/feedback/lifecycle/control 审计事件继续保留。此实现不清理 G-21 V1 records、外部 Artifact、备份、文件系统快照或介质残留，不提供 crypto-erase。未来如要求全面遗忘，需要另行裁决 Artifact/key/backup 生命周期和恢复时 tombstone replay。

G-21 `remember()`/`recall()` 与 V1 `records.jsonl` 完全不切换。V2 recall gate 仍未接入 Runtime；MemoryUse 状态不证明 Provider 接受或模型因果使用。

## 不变量

- 所有写入经过 strict domain command，并以 Evidence Ledger lifecycle/control event 表达；客户端不写文件或投影。
- Host 在每次请求从已注册且当前可见项目派生 scope；不可见记录与不存在记录统一返回 404。更正家族跨越不可见 scope 时整项拒绝。
- 新 Memory 默认 `allowModelUse=false`，必须显式用户审核才能从 candidate 进入 active；模型使用许可不会替代 lifecycle review。
- seed claim digest 必须匹配创建/更正控制事实。相同 command retry 幂等；同一 ID/command 被用于不同 claim、scope 或治理选项时拒绝。
- delete tombstone 只包含 IDs、scope IDs、digest/hash-chain 元数据，不包含 Memory claim；tombstone durable commit 先于 payload 删除，重复创建不能复活已删 ID。
- 撤销改变资格状态但不擦除正文；删除擦除范围仅为本机 V2 payload store。V1 与 Run Ledger 不被改写。
- Web、CLI 与 Desktop 通过各自支持的 transport 共用 Host/SDK/API seam。Desktop 复用同一 Workbench 控制面和 API controller，不新增 Memory store 或 lifecycle 状态机。
- 控制队列和 V2 payload 文件写入只保证单个 Runtime/Core 服务实例；多个 Host 并发共享同一 dataDir 不支持。

## 迁移与回滚

没有自动迁移既有 V1 rows；创建 V2 record 前不会读取或改写 G-21 store。回滚代码时保留已追加的 lifecycle/control/tombstone events；不能因回滚而重建已删除 payload。若要停用界面/CLI，可禁用入口，但必须保留 Ledger 解释和控制 tombstone 的能力。

## 验收

- [x] Candidate inspect/create、review、correct、revoke 与 family delete 使用唯一 Core 服务。
- [x] Host/SDK、CLI 与 Web 都走同一 command/query seam；Host auth、command ID 与 scope 负测通过。
- [x] provenance、冲突、feedback review gate 与 exact-version MemoryUse 状态可查询；输出不把 Adapter hand-off 描述为模型因果使用。
- [x] 已撤销、已删除、跨 scope、重复命令、lineage 删除、删除后复建与正文 tombstone 反例通过。
- [x] G-21 V1 store/recall 未切换；当前/目标文档已说明 V2-only payload deletion 的限制。
- [x] Desktop 通过 fixed IPC、framed RPC 与同一 API controller 复用 Memory inspect/review/correct/revoke/delete；scope 和 command ID 仍由 Host 推导/校验。

## 证据

- Contracts：`packages/contracts/src/memory-control.ts`。
- Core：`packages/core/src/domains/memory/memory-control.ts`；Runtime 入口在 `packages/core/src/domains/runtime/runtime.ts`。
- Ledger：`packages/evidence/src/event-ledger.ts`。
- Host/SDK/CLI/Web/Desktop：`packages/host/src/webserver/index.ts`、`packages/sdk/src/index.ts`、`apps/cli/src/memory-command.ts`、`packages/workbench/src/components/MemoryControlPanel.tsx` 与 `apps/desktop/src/main.ts`。
- Desktop 验收补充见 [CLIENT-068 Note](2026-10-02-client-068-memory-experience-control.zh.md)；新增 Experience 控制的边界也在该 Note 单独记录。
- 聚焦验证：Core Memory 控制面 6 项、Core Memory family 34 项、Host 路由/整体测试 55 项、CLI 控制命令 3 项、Contracts Memory 12 项、Evidence public API 4 项均通过。
- 全仓 `pnpm typecheck` 通过（18 个 workspace packages build/typecheck + eval typecheck）；`pnpm test:engineering` 通过 48 项 Node 检查和 8 项 Vitest 检查；`pnpm verify:invariants` 通过 211 个源码文件；`verify:v2-docs` 校验 11 份 manifest 文档/62 个 roadmap tasks；README gate 校验 18 个包；boundary gate 校验 18 packages、34 条依赖和 1,532 条 imports、0 legacy findings；`git diff --check` 通过。
