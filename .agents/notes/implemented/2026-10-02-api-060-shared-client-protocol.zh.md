---
id: 2026-10-02-api-060-shared-client-protocol
title: 共享内部 Client Protocol v1
status: implemented
owners: [client-protocol]
created: 2026-10-02
last_reviewed: 2026-10-02
affects: [packages/sdk/protocol, packages/contracts, apps/cli, apps/web]
supersedes: []
---

# Agent Note：共享内部 Client Protocol v1

## 问题

仓库已有 canonical domain schema 和 Host HTTP/SSE SDK，但产品入口之间没有与 transport 无关的 Command/Query/Event envelope。需要在拆分 Controller 和实现 framed RPC 前提供同源 schema，又不能形成独立公共 SDK/API。

## 决策与实现

`packages/sdk/src/protocol/` 拥有私有、transport-neutral 的 `tracegraph.client-protocol.v1` envelope。Run command、Run/Session query 和 typed result payload 复用 `@tracegraph/contracts`。Event 明确区分持久 `ledger` 与瞬时 `activity`、`model_surface` 消息；各自序号/游标仍由原 contract 所有。

SDK 以私有子路径 `@tracegraph/sdk/protocol` 暴露协议。一组 deterministic fixture 从该子路径导出，由 CLI 和 Web conformance check 消费。`packages/sdk` 继续标记为 private。现有 HTTP 路由、SDK 行为、Host authentication 和 Runtime execution 未改变。当前还没有 Desktop app；未来 Desktop 可使用同一 schema 和 fixture 路径。

当前只覆盖 Run/Session contract 切片，并未建立完整 Controller catalog。Workspace、Memory、Operation、Artifact、Profile 命令/查询可在后续从 owner contract 加入；Controller 分离与 transport framing 留给 API-061/API-062。

## 不变量与边界

- Protocol 依赖 `@tracegraph/contracts`；contracts 不依赖 SDK 或应用。
- 收到 protocol message 不产生 SessionEvent，也不传递 authority。Host/Controller 继续推导 actor、scope 和 workspace capability。
- 未知消息 kind、query operation、event stream 和 error code 都无法通过 schema。未知可选 envelope 字段会被剥离，使旧 client 可忽略新增字段。
- Durable ledger、live activity 和 model-surface event 语义保持独立；瞬时事件不能作为 ledger replay 证据。
- Protocol package 是内部实现细节，不是对外发布的 SDK/API。

## 迁移与回滚

本变更是增量式。现有调用方继续使用当前 Host 路由和 SDK 方法。API-061 采用 v1 前若 envelope 需要调整，可移除 protocol 子路径和 fixture checks；无需迁移持久数据或重写 ledger。

## 验收标准

- [x] 私有 protocol 子路径导出带版本的 Command/Query/Event/reply/error schema 与推导类型。
- [x] Deterministic fixture 覆盖 Run command、Session query、durable event、live activity、model-surface event 和 typed reply。
- [x] SDK contract test 拒绝畸形/未知 discriminator，验证 stream 区分和新增 envelope 字段兼容。
- [x] CLI 与 Web conformance check 从同一 package 子路径解析相同 fixture 集。
- [x] 当前文档和路线图准确说明交付切片与 Desktop 限制，没有误称 transport/controller 已迁移。

## 风险与未决问题

- 第一版仅覆盖已有 Run/Session contracts。API-061 增加 operation 时必须沿用 canonical contract，并保留 Host authority binding。
- Desktop app 存在后才能接入 Desktop consumer。

## 证据

- 实现：`packages/sdk/src/protocol/index.ts`、`constants.ts`、`fixtures.ts`；私有子路径在 `packages/sdk/package.json`。
- 消费者：`apps/cli/src/protocol-conformance.test.ts` 和 `apps/web/src/protocol-conformance.test.ts` 从统一入口导入 fixture 与 parser。
- 测试：SDK 47 项、CLI unit 66 项、Web unit 149 项通过。
- 验证：SDK build/typecheck；CLI 和 Web typecheck；`verify:boundaries`（18 个包、34 条 workspace dependency、1,713 个 import reference、0 legacy finding）、`verify:invariants`（229 个源文件）、`verify:package-readmes`（18 个 package）、`verify:v2-docs`（11 份文档、64 个任务）、`graph:modules:check`、`verify:lockfile`（19 个 manifest）及 `git diff --check` 通过。
- 当前文档：`docs/modules/09-Host-与-SDK-接口层.md` 与 `docs/outlive-agent-v2/06-clients-protocols-desktop/01-shared-protocol-controller.md`。
