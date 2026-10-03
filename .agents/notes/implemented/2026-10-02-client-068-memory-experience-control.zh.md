---
id: 2026-10-02-client-068-memory-experience-control
title: 将 Memory 与 Experience 控制面接入共享协议和 UI
status: implemented
owners: [client-memory, api, desktop]
created: 2026-10-02
last_reviewed: 2026-10-02
affects: [packages/contracts, packages/api, packages/sdk, packages/host, packages/workbench, apps/desktop-host, apps/desktop]
supersedes: []
---

# Agent Note：将 Memory 与 Experience 控制面接入共享协议和 UI

## 问题

MEM-046 已提供 owner-scoped Memory 控制服务以及 Web/CLI 客户端。MEM-050 已提供持久化 Experience 候选和生命周期转换，但 Experience 没有 Host API 或客户端界面。DESK-065/066 已提供 Web/Desktop 共享 Workbench 和 Desktop 私有传输；Desktop Workbench 仍无法检查或操作两个控制面。若 Web routes 和 Desktop dispatcher 各自复制 scope 与生命周期语义，传输行为容易漂移。

## 当前状态

- 私有 `@tracegraph/sdk/protocol` v1 只承载 Run command 与 Run/Session query。
- Web Memory REST routes 直接调用 Runtime Memory 方法；SDK 和共享 Memory 面板提供 list/create/review/correct/revoke/delete。
- Runtime 暴露 Experience list/create/review，并在 Core 中执行 owner 与 project scope 校验。当前没有 Experience Host routes、SDK methods 或共享 UI。
- Desktop framed dispatcher 和 fixed IPC 只开放 Run/Session。共享 Workbench 已有 Memory 面板。

## 提议

新增 Experience list 与生命周期审核的 canonical request/response schema，并扩展私有 client protocol，承载 Memory/Experience 控制查询和命令。升级私有协议版本，使不支持这些操作的 Host 在启动握手时拒绝连接，而不是稍后才发现无法服务 UI 调用。

在 `@tracegraph/api` 增加 transport-neutral Memory/Experience controller。它接收 Runtime port，并在每个请求中读取当前可见项目 ID。Web routes 与 Desktop framed RPC 调用同一 controller methods、schema parsing、scope 和 Runtime command ID。Web SDK 在映射到 HTTP endpoints 前校验同一套 protocol command/query envelope；Desktop Main 将 fixed、validated IPC 调用映射到私有 RPC client 的相同 envelope。Renderer 不提交 owner 或 actor identity。

扩展共享 Workbench Memory 控制面，加入 Experience 检查与生命周期审核。Experience 支持的动作是 candidate validate/reject、validated dispute/retire、disputed resolve/retire；每次都使用当前展示的 lifecycle sequence 做 CAS。Experience seed payload 保持不可变，本任务不添加 Experience 编辑或删除。Memory 保留现有 review/correct/revoke/delete 控件及其限制。

## 不变量与边界

- Memory 和 Experience command 继续以各自现有 Core service 作为 canonical ledger event 的唯一写入者。
- Web 与 Desktop 向同一个 Runtime service 传递相同的 strict command payload 和稳定 command ID；任何 transport 都不自创第二种 event 格式。
- 每个请求都从 Host 当前注册信息推导允许的 project scope。客户端提交的 owner/actor 值由 strict schema 拒绝或忽略。
- Experience lifecycle 继续 append-only、幂等、sequence-checked，并仅支持现有 contract 定义的状态转换。
- Experience 当前没有删除 command，因此本任务不支持 Experience 删除。Memory 删除仍仅影响现有本机 V2 payload/lineage 行为，并保留已记录的 audit/V1/backup 限制。
- V1 G-21 recall 与 Context 行为保持不变；控制面不会开启 Memory 或 Experience recall。
- 协议仍是私有版本化协议，不代表发布外部 SDK。

## 迁移与回滚

该协议只供精确版本匹配的本地客户端使用。升级协议版本会有意拒绝旧版 Desktop Host/client 组合。不改变持久化记录格式。回滚可移除新 UI/routes/IPC 操作并恢复之前的私有协议版本；现存 Memory 与 Experience ledger records 仍由现有 Core services 读取。

## 验收标准

- [x] Protocol schemas 与 fixtures 覆盖 Memory list/create/review/correct/revoke/delete 和 Experience list/review，并验证非法动作和未知操作会被 strict 拒绝。
- [x] Web REST 与 Desktop RPC 委托同一个 API controller，并保留 command ID、CAS sequence、scope 校验、幂等 replay 和 canonical event 行为。
- [x] 两种 transport 都将相同 command payload 交给共享 controller；Core lifecycle tests 验证 canonical event replay/idempotency，越权与过期 sequence fail closed。
- [x] 共享 Workbench 在 Web 与 Desktop 渲染相同的 Memory 和 Experience 控制面；Experience evidence、status、lifecycle sequence 和允许动作均可见。
- [x] Desktop fixed IPC 与 preload 只开放经过 schema 校验的控制操作；owner/actor 与文件系统权限不进入 Renderer。
- [x] 当前模块、SDK/Host/Desktop 文档、V2 roadmap、双语 Notes、package policy 与 module graph 均与已验证实现一致。

## 风险与未决问题

- Experience case 可能包含较丰富的证据文本。共享 UI 只显示现有已校验 projection 和来源引用，不能悄悄把 candidate 变成可召回状态。
- 后续 Experience correction/deletion policy 需要独立领域决策以及 lifecycle/event semantics，之后才能开放控件。

## 证据

实现源码：`packages/contracts/src/memory-experience-control.ts`、`packages/api/src/memory-experience-controller.ts`、`packages/host/src/webserver/index.ts`、`apps/desktop-host/src/desktop-host.ts`、`apps/desktop/src/bridge-contract.ts`、`apps/desktop/src/main.ts` 与 `packages/workbench/src/components/ExperienceControlSection.tsx`。

验证记录（2026-10-02）：Contracts 177 项、API 8 项、SDK 61 项、Host 56 项、Workbench 150 项、Desktop Host 单测 7 项 + 真实子进程 E2E 4 项、Desktop 9 项、Web 1 项；另有 Core Memory/Experience lifecycle focused tests 8 项。`pnpm typecheck` 通过（含 build、workspace typecheck 和 eval typecheck）；`pnpm test:engineering` 通过（48 项 Node checks + 8 项 coverage checks）。Boundary、invariant、module graph、V2 docs、package README 与 `git diff --check` gates 均通过；先按当前 imports 重新生成了 module graph。
