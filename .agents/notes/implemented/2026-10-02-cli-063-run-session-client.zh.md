---
id: 2026-10-02-cli-063-run-session-client
title: CLI Run 与 Session 命令接入共享 Client Protocol
status: implemented
owners: [cli, client-protocol]
created: 2026-10-02
last_reviewed: 2026-10-02
affects: [apps/cli, packages/sdk/protocol, packages/api/run-session-controller]
supersedes: []
---

# Agent Note：CLI Run 与 Session 命令接入共享 Client Protocol

## 问题

API-060 建立了 Run/Session 共用 protocol envelope，API-061 让 Host Run/Session Controller 成为应用层真源，API-062 增加了有界私有 framing。CLI 还没有 Run/Session 命令入口来产生这些 protocol message，也没有证据说明 CLI 输出事件与 Host/Web canonical event stream 一致。

## 当前状态

- `tracegraph` 把本地 Host 与一个 Runtime 组合为运行进程；现有 `team`、`memory`、`mcp`、`extensions` 子命令通过 `TraceGraphClient` 连接运行中的 Host。
- Host Run/Session HTTP route 调用同一个进程内 `RunSessionController`；它的 active-Run 与幂等状态必须和 Web 请求共享。
- 私有协议已有 Run start/read、Session list/read 消息，以及 typed event/reply envelope。当前 CLI 仅校验公共 fixture 集。

## 决策

增加 CLI `run start|get|events` 与 `sessions list|get`。命令构造并校验现有共享 protocol envelope，再把支持的操作适配到既有 typed `TraceGraphClient`。这样 CLI 与 Web 请求落到同一个运行中 Host 和 `RunSessionController`，保留唯一 Runtime 与进程内协调，不另建 Host 或 RPC listener。机器输出采用 JSON Lines，每行是 protocol reply/event envelope；诊断信息写入 stderr。

`run events` 默认读取 canonical projection timeline，可用 `--follow` 跟随 Host event stream。每个 canonical `WireSessionEvent` 会包在共享 `ledger` event envelope 中输出。本 CLI 切片不增加领域操作、不改变 authority，也不把 CLI 接到 Desktop stdio/framed-RPC 进程。

## 不变量与边界

- CLI 参数用现有 contracts/protocol 校验；argv 不接受 Workspace handle、actor、policy 或文件系统 authority。
- Run start 把显式 command id 原样传至现有 Host API/Controller 幂等边界。
- CLI JSONL stdout 只含 schema 校验后的 protocol reply/event。Usage 与 Host 错误留在 stderr 并返回非零退出码。
- Event payload 是 Host canonical ledger fact，并与 Web conformance 使用相同的 protocol event schema/fixture。
- 现有 `serve` 装配、Host 生命周期、HTTP/SSE route 与非 Run CLI 子命令保持原行为。

## 验收标准

- [x] `run start|get|events` 和 `sessions list|get` 使用共享 protocol schema 与现有 typed Host client/controller 路径。
- [x] JSONL 输出通过 schema 校验且 stdout 无诊断；输入无效或 Host 失败时不伪造成功输出。
- [x] CLI event message 保留 canonical event identity/sequence，并与同一 Host Web/SDK event stream 相等。
- [x] CLI 单测与 Host 集成覆盖通过；package README、模块 11、protocol/controller 文档、路线图和生成模块图一致。
- [x] 不增加第二个 Runtime/Controller、新 listener、外部 API、Desktop 集成或无关 CLI 子命令迁移。

## 迁移与回滚

新增命令是增量变化。移除 Run/Session CLI 模块及分派分支即可回滚；Host、SDK、持久事件 Ledger 与现有子命令无需迁移。

## 风险与未决问题

- 长时间 `--follow` 依赖现有 Host SSE 重连；操作员可用 SIGINT 停止等待，但不改变 Run。
- 这里只暴露 API-060/061 的 Run/Session 切片。Approval、steering、rollback 与更广 client catalog 仍由现有命令/route 和后续路线图负责。

## 证据

- 实现：`apps/cli/src/run-session-command.ts`、`apps/cli/src/index.ts`；命令通过 `TraceGraphClient` 进入 Host 现有 RunSessionController routes。
- 测试：`env -u NODE_OPTIONS pnpm --filter @tracegraph/cli test:unit`（17 个文件、70 项）与 `env -u NODE_OPTIONS pnpm --filter @tracegraph/cli test:e2e`（4 项）。E2E 覆盖五个命令、CLI 发起 Run，以及 CLI ledger event 与 SDK SSE 逐条相等；单测覆盖 JSONL schema、输入与 bootstrap 顺序、Host failure 输出和 follow cursor。
- 验证：`env -u NODE_OPTIONS pnpm --filter @tracegraph/cli build`；`verify:boundaries`、`verify:invariants`、`verify:package-readmes`、`verify:v2-docs`、`graph:modules:check`、`verify:lockfile` 与 `git diff --check` 均通过。
