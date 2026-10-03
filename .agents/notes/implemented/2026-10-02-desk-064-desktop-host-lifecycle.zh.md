---
id: 2026-10-02-desk-064-desktop-host-lifecycle
title: 增加 exact-version Desktop Host 进程生命周期
status: implemented
owners: [desktop, client-protocol]
created: 2026-10-02
last_reviewed: 2026-10-02
affects: [apps/desktop-host, packages/core, packages/session, packages/api, packages/sdk/server]
supersedes: []
---

# Agent Note：增加 exact-version Desktop Host 进程生命周期

## 问题

API-062 已提供有界私有 framing，API-061 已提供首个进程内 Run/Session Controller，但仓库还没有 Desktop Host 子进程。未来 Electron Main 需要确认启动的是兼容版本、得到有界协议通道，并在关停或重启时保护 canonical Run Ledger。

## 当前状态

- `@tracegraph/core` 创建 Runtime 并拥有 canonical event ledger；`@tracegraph/session` 拥有持久 Session 引用索引。
- `@tracegraph/api` 把现有 Run/Session 操作绑定到 Host 注册的 Workspace capability。
- DESK-064 已提供 `@tracegraph/desktop-host`：通过私有 Node IPC 启动握手运行的 exact-version 子进程，以 stdin/stdout 提供版本化 framed RPC；不开放网络 listener，也没有 GUI。
- Core 和 Session 已有进程丢失后的恢复逻辑：非终态 Run 会被明确标成 interrupted，不会自动重跑模型或工具工作。

## 决策

私有 app `@tracegraph/desktop-host` 通过 Node IPC 等待可信 parent 的启动消息，校验期望的 package version、protocol version、绝对 data directory 和注册 Workspace handle，再创建单个 Runtime 与 Session controller。ready reply 同时返回精确 app/protocol 版本和启动恢复报告。版本不匹配时，Host 不接受协议帧。

Node IPC 只承载启动配置和就绪信息。Run/Session command/query 通过 child stdin/stdout 使用 API-062 framed RPC。Host 不开放 HTTP/TCP listener。首期 dispatcher 将 `start_run` 和当前 Run/Session read query 绑定到既有 `RunSessionController`；尚未支持的 Run command 一律 fail closed，后续再增量覆盖其它 route family。

私有输入流 EOF 后停止分派、关闭 framed writer、等待有界 handler 收敛，然后关停 Runtime 后台 Memory work 并 flush Telemetry。进程突然丢失时，下次启动根据现有持久 Session/Ledger 状态恢复；活动 Run 会成为 `interrupted`，不会自动重放。

## 不变量与边界

- Parent 必须要求精确 package version 与 protocol version；child 校验两者并在 ready 中返回。
- Workspace handle 只从可信 parent 进程传入，并在 Runtime/controller 装配前校验。不接受 Renderer 提交的路径。
- 每个 child 进程只装配一个 Runtime、Session store、DurableSessionController 与 RunSessionController。
- Framed RPC 沿用 SDK 现有 frame/request/queue 限额；transport cancel 不等同领域 Run cancel。
- 正常关停和重启不把活动操作宣称为完成；canonical 状态由 durable recovery 决定。
- 本任务不创建 Electron window、Renderer bridge、TCP listener、自动 crash-loop 重启策略或新的持久 schema。

## 验收标准

- [x] Child 返回精确 package/protocol 版本；版本错配会在接收 RPC 请求前拒绝启动。
- [x] 无 GUI smoke 测试启动已构建 child，并通过 framed RPC 完成 schema-valid Session query。
- [x] 在模拟进程丢失后，child 启动期间会收敛一个持久化活动 Run；恢复报告与 canonical Projection 均显示 `interrupted`，且不会第二次执行 Run。
- [x] EOF 执行有界优雅关停；child 突然终止再启动后持久数据仍在，恢复事实不重复。
- [x] 当前模块文档、package README、架构策略、生成模块图、路线图与双语 Note 一致。

## 迁移与回滚

新增 app 与进程边界为增量变化。回滚时移除 `apps/desktop-host` 及对应架构/路线图条目；现有 CLI/Web Host 和 Session/Ledger 数据无需迁移。

## 风险与未决问题

- 首期 dispatcher 只覆盖 Run start/read 和 Session read。Approval、steering、cancel、artifact、live event subscription、credential/profile 装配与自动进程重启留给后续工作。
- Node IPC 提供本机进程隔离，不提供远程身份认证。添加 Electron Main 时必须保留可信 parent/child 所有权边界。

## 证据

- 实现：`apps/desktop-host/src/desktop-host.ts`、`host-process.ts`、`worker.ts` 和严格生命周期 schema。
- 测试：`desktop-host.test.ts`（2 项通过）；真实构建 child 的 `desktop-host.e2e.test.ts`（3 项通过，包含恢复及 Host 二次崩溃/重启）。
- 验证：package build/typecheck 以及 `verify:boundaries`、`verify:invariants`、`verify:package-readmes`、`verify:v2-docs`、`graph:modules:check`、`verify:lockfile`、`git diff --check` 均通过。
