---
id: 2026-10-02-api-062-framed-rpc-conformance
title: 增加有界私有 framed RPC client/server conformance
status: implemented
owners: [client-protocol]
created: 2026-10-02
last_reviewed: 2026-10-02
affects: [packages/sdk/client, packages/sdk/server, client-protocol-v1]
supersedes: []
---

# Agent Note：增加有界私有 framed RPC client/server conformance

## 问题

API-060 建立了 transport-neutral client protocol，API-061 将首个 Run/Session Controller 切片从 Fastify 中分离。Desktop/CLI 尚无共用的字节传输和 server dispatcher，也没有 partial read、请求取消、写背压或 protocol version mismatch 的可复验证据。

## 当前状态

- `@tracegraph/sdk/protocol` 定义了基于 canonical contracts 的版本化 Command、Query、Event、reply 与 error envelope。
- `@tracegraph/api` 提供进程内 Run/Session 操作；`@tracegraph/host` 拥有本地 HTTP/SSE，本任务不让 SDK 依赖 Host。
- API-062 已实现可复用的私有 framing 与 dispatch seam。Desktop 和 framed RPC 进程集成仍不存在；本 Note 不声称产品已集成。

## 提案

增加私有 `@tracegraph/sdk/client` 与 `@tracegraph/sdk/server` 子路径。帧采用 4 字节 unsigned big-endian payload 长度，后接一个 UTF-8 JSON protocol envelope。默认帧上限 8 MiB；每条消息都执行严格 UTF-8/JSON 解码、现有 `ClientProtocolMessageSchema` 校验和 `CLIENT_PROTOCOL_VERSION` 校验。

Client 按 `request_id` 关联有界的 command/query 请求，向调用方转交 server event；AbortSignal 触发时发送 transport `cancel` 消息。Server 把 command/query 交给注入的 protocol handler，传入协作式 AbortSignal 和 event writer，限制并发请求并返回安全的协议错误。两侧都串行写帧，并等待 WHATWG WritableStream 背压解除。

Transport cancel 只指向 RPC `request_id`；它不是 `RunCommand`，不代表领域 Run 已取消，也不能撤销 Controller 已接纳的命令。产品调用方必须读取 canonical reply/projection；若要取消 Run，应使用领域 cancel command。

## 决策与备选方案

- 选择 4 字节大端长度前缀，而不是 Content-Length 文本头，以便在私有 stdio/pipe 上按字节计数、无歧义地 framing，且不依赖按行解析。
- 以 WHATWG `ReadableStream`/`WritableStream` 作为 transport seam。Node 调用方可在 composition 层适配子进程 stdio；SDK 不负责进程启动、endpoint 安全、Desktop Main/Preload 或 Host 生命周期。
- Server 使用注入 handler，不直接依赖 Fastify、Runtime internals 或某一种 Controller 实现。这样 transport 可复用，也不扩大 API-061 当前限定的 Controller 操作范围。
- Version mismatch fail-closed。Server 在能关联 incoming request 时返回 `unsupported_version`；Peer 若收到与本地协议版本不同的 envelope，则拒绝该结果，不猜测兼容性。
- 不新增 loopback listener、对外 RPC 服务、CLI 自动迁移或 Desktop 实现。

## 不变量与边界

- Frame 必须是非空、UTF-8 JSON envelope，并在 dispatch 前通过长度上限。
- 将任意 partial reads 拆帧或把多个 frame 合在一次 read，产生的已校验消息相同。
- 并发 dispatch 与 pending request 都有显式有限上限。Frame 写入有序并等待 sink/backpressure；有界 writer 溢出时 fail-closed。
- Cancel frame 只取消目标 request 的 in-flight dispatch signal。未知或过期 cancel 无副作用，不能误取消其它请求。
- Unsupported version 与 malformed envelope 不会进入 Controller dispatch。Handler 未分类异常不回显内部错误内容。
- `@tracegraph/sdk/client` 和 `@tracegraph/sdk/server` 仍是私有包导出，不形成外部 API 产品。

## 迁移与回滚

新增 client/server 子路径与 cancel discriminator 均为增量变化。现有 HTTP/SSE SDK 方法、CLI 行为和 Host 路由不变。回滚时移除子路径、framing 代码/测试和 cancel discriminator；无需迁移持久数据或用户配置。

## 验收标准

- [x] Client/server framing 和 dispatch API 使用共用私有 protocol envelope，并实施帧长与并发上限。
- [x] Conformance test 将 frame 拆成任意 partial reads，并验证一次 read 中的多个 frame。
- [x] Client cancel 仅抵达对应 server AbortSignal；文档明确它不等同领域 Run cancel。
- [x] 背压测试证明前一帧尚未被 bounded stream writer 接收时，server 不写后续帧。
- [x] Client/server version mismatch fail-closed 且有稳定可诊断错误；不匹配输入不进入 dispatch。
- [x] SDK client/server 子路径、README、架构策略、生成模块图和路线图一致；不声称对外 RPC 产品或 CLI/Desktop 迁移。

## 风险与未决问题

- 取消是协作式的。忽略 AbortSignal 的 Controller handler 可能在 Peer 停止等待后继续；已接纳领域命令仍由 durable receipt/projection 说明结果。
- API-062 建立 framing 与 conformance，不实现身份认证。Desktop private pipe 与一次性 Host token 仍由生命周期/安全层负责。
- Event 与 reply 共用有序 frame writer；未来 stream-level flow control 可能需要 cursor replay/snapshot recovery，而不是放大 transport queue。

## 证据

- 实现：`packages/sdk/src/protocol/index.ts`、`packages/sdk/src/transport/`、`packages/sdk/src/client/`、`packages/sdk/src/server/` 及 `packages/sdk/package.json` 私有子路径导出。
- 测试：`env -u NODE_OPTIONS pnpm --filter @tracegraph/sdk test:unit`，5 个文件、59 项通过；覆盖 partial/coalesced frame、无效/截断/超限 frame、队列字节上限、写背压、request-scoped cancel、并发上限和双向版本错配。
- 验证：在命令中 unset 继承的失效 Node preload 后，`env -u NODE_OPTIONS pnpm --filter @tracegraph/sdk build`、`env -u NODE_OPTIONS pnpm run verify:boundaries`、`env -u NODE_OPTIONS pnpm run verify:invariants`、`env -u NODE_OPTIONS pnpm run verify:package-readmes`、`env -u NODE_OPTIONS pnpm run verify:v2-docs`、`env -u NODE_OPTIONS pnpm run graph:modules:check`、`env -u NODE_OPTIONS pnpm run verify:lockfile` 和 `git diff --check` 均通过。
