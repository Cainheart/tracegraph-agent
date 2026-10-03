---
id: 2026-10-02-api-061-run-session-controller
title: 抽取进程内 Run/Session Client Controller
status: implemented
owners: [client-protocol]
created: 2026-10-02
last_reviewed: 2026-10-02
affects: [packages/api, packages/host/webserver, run-session-commands]
supersedes: []
---

# Agent Note：抽取进程内 Run/Session Client Controller

## 问题

API-060 已增加第一版 Run/Session 共享 protocol，但 `packages/host/src/index.ts` 曾把 Fastify 装配和应用编排混在一起：Run 启动幂等、单活动 Run 协调、Workspace 绑定、Session scope 与 Projection 校验都在路由 handler 内。非 HTTP 调用方当时无法直接复用同一应用操作。

## 当前状态

- `@tracegraph/host` 拥有 Fastify server 和本地 bearer/Origin 校验；Fastify 路由现位于 `packages/host/src/webserver/index.ts`，package root 保留兼容 re-export。
- 启动命令去重和活动 Run 跟踪由 `@tracegraph/api` 的 `RunSessionController` 在进程内持有。
- Core 的 `DurableSessionController` 拥有 Session JSONL lease/recovery 与 canonical Run 交互；Host 提供 Workspace resolver 和 HTTP scope 校验。
- API-060 为当前 Run/Session operation 切片增加了私有 protocol schema 子路径。CLI 通过 SDK 使用 Host HTTP；当前没有 Desktop app。
- `architecture-policy.yaml` 将 `@tracegraph/api` 限定为只依赖 `@tracegraph/contracts`。

## 提案

创建 transport-neutral 的进程内 `@tracegraph/api` Run/Session 应用 Controller。它负责 Run 启动幂等和单活动 Run 协调、把 client Run request 绑定到 Host 提供的 Workspace handle、校验注册项目/Session identity，并提供类型化 Run/Session query。该包仅依赖 `@tracegraph/contracts` 与窄化注入的 Runtime/Session port，不依赖 Fastify、Node、apps 或 SDK。

把 Fastify 实现移到 `packages/host/src/webserver/`，并保留 Host package root 作为兼容 re-export。Host HTTP adapter 继续拥有 loopback、Origin、capability/replay authentication、HTTP parsing/status/header 行为和 SSE streaming；选定的 Run/Session routes 调用 `@tracegraph/api`。同一 API Controller 可由进程内测试及未来 RPC adapter 直接调用。

本首个 Controller 切片与 API-060 当前 Run/Session schema 对齐。Settings、项目生命周期、扩展、MCP/LSP、Team、Memory、Artifact 内容和 SSE transport 仍由 Host route/controller seam 承担，不声称本任务已提取这些部分。

## 考虑过的备选方案

- 一次把全部 route logic 搬入新包：会将 transport authentication、replay capability、二进制 attachment、SSE 生命周期和可选 Host seam 混为一次高风险批量改写，因此不采用。
- Controller 继续留在 Fastify package：未来 RPC/进程内调用方仍会依赖 Web transport family，因此不采用。
- 让 `@tracegraph/api` 依赖完整 SDK protocol package：Controller 属于 domain/application 层，应依赖 canonical contracts 和窄 port；transport 负责把 protocol message 适配进来，因此不采用。

## 不变量与边界

- `@tracegraph/api` 不导入 Fastify、Node HTTP、React、CLI、Desktop、持久文件实现或 SDK。
- API Controller 从可信 composition 接收 Workspace handle；client request 只能选择 Host 已登记的项目 id，不能创建或提交 filesystem capability。
- Project scope 从当前 Host registry 推导。Session read/list 结果必须在该 scope 内，并保留 Session/Run identity。
- 单活动 Run 和 command-id 重放语义不变。同 id 同 fingerprint 返回 canonical projection；同 id 不同输入产生 conflict。
- Host 在调用应用 Controller 前继续执行 loopback 与 bearer/replay authority 校验。
- Canonical Run Event Ledger 与 DurableSessionController 继续拥有持久状态；API Controller 只保留进程内协调/幂等索引。

## 迁移与回滚

新 package 与 Host webserver path 为增量改动，root re-export 保持现有 imports。Route 行为和 URL 不变。回滚时恢复旧 Host module 和 inline 编排，移除 API package/policy entry 与 lockfile importer；无需迁移持久数据。

## 验收标准

- [x] `@tracegraph/api` 拥有类型化进程内 Run/Session Controller，且不导入 transport。
- [x] Host Run start/read 和 Session list/read/resume routes 调用共享 Controller；Host 继续负责 transport security 和响应行为。
- [x] Controller contract test 不经 Fastify 调用，覆盖 scope、Session 绑定、命令幂等重放/冲突、活动 Run 串行化和 Session resume Workspace 绑定。
- [x] Host route tests 证明本地 HTTP adapter 保留 status、scope 和 resume 后的活动 Run 保护行为。
- [x] `@tracegraph/host` 暴露 `webserver` 并保留 root 兼容导出；架构策略、文档和生成模块图一致。
- [x] 路线图记录已实现切片和明确延后的 route family。

## 风险与未决问题

- 进程内 active-Run 和 idempotency index 保留当前单 Host 限制；API-061 不建立多进程持久协调。
- Run/Session 以外的 Host routes 仍是既有 domain seam 的 adapter。其它 transport 暴露前需要逐步补齐 controller 覆盖。

## 证据

- 实现：`packages/api/src/run-session-controller.ts`；Fastify 实现移至 `packages/host/src/webserver/index.ts`；`packages/host/src/index.ts` 保留 root re-export；manifest 与架构策略登记新 seam。
- 测试：`env -u NODE_OPTIONS pnpm --filter @tracegraph/api test:unit`（6 项通过）；`env -u NODE_OPTIONS pnpm --filter @tracegraph/host test:unit`（55 项通过）；API typecheck 与 API/Host build 通过。
- 验证：`verify:boundaries`、`verify:invariants`、`verify:package-readmes`、`verify:v2-docs`、`graph:modules:check`、`verify:lockfile`、`git diff --check` 通过。第一次 V2 docs 检查发现 YAML 标量需加引号，修正后复验通过。
