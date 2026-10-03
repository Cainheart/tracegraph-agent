---
id: 2026-10-02-desk-065-shared-workbench-desktop-shell
title: 提取共享工作台并增加隔离的 Desktop 外壳
status: implemented
owners: [desktop, web]
created: 2026-10-02
last_reviewed: 2026-10-02
affects: [packages/workbench, apps/web, apps/desktop, apps/desktop-host, packages/sdk]
supersedes: []
---

# Agent Note：提取共享工作台并增加隔离的 Desktop 外壳

## 问题

Web app 已拥有主要 Workspace/Session 导航、对话、Run 轨迹、Tool 状态与审阅界面。其 `App` 接受 `WorkbenchClient`，但视图与 client 契约仍放在 `apps/web/src`，Electron Renderer 无法通过稳定的内向 package 边界复用。DESK-064 提供了首个私有 Host 进程，但没有 Electron 外壳。

## 当前实现

- `packages/workbench` 拥有 `App`、`WorkbenchClient`、Demo/Live client、投影模型、组件、翻译、CSS 与 UI/client 测试。`App` 必须注入 client；Web 与 Desktop 是两个独立 composition root。
- `apps/web/src/main.tsx` 显式注入原有 HTTP/SSE `LiveTraceGraphClient`。Web build 与 protocol-conformance 测试通过。
- `apps/desktop` 使用 Electron 44.5.1，启动 exact-version `@tracegraph/desktop-host` 并加载本地 Renderer；只开放 Host status、Session list/read、Run get/start 五个 schema 校验 IPC 方法。
- 默认 Desktop adapter 因 DESK-064 暂无项目注册路由而如实返回空项目列表。活动 Run 通过 500 ms `run.get` 轮询 canonical projection；未支持命令明确返回 unavailable。
- `--preview` 只注入 `DemoTraceGraphClient`，共享顶栏标为“演示预览”。真实 Electron 窗口分别在 Preview 与普通实时模式下检查。

## 决策与实现

把当前工作台视图、共享 client contract/adapter、model、翻译目录、测试和样式提取为私有 workspace package `@tracegraph/workbench`。`apps/web` 保持 Web composition root，并显式注入现有 `LiveTraceGraphClient`。

创建 `apps/desktop`：Electron Main 启动 `@tracegraph/desktop-host`，然后加载随应用打包的本地 renderer 文件。Preload 只暴露固定且有类型的 Host identity/status、支持的 Run/Session query 与 command；不提供通用 `ipcRenderer`、Node、任意 channel、路径或 secret。Renderer 通过共享 `WorkbenchClient` 视图契约和 Desktop bridge adapter 工作。

实时 Desktop 界面只展示当前 Host 路由真实提供的事实。显式的 `--preview` 启动可使用已有 `DemoTraceGraphClient` 进行视觉检查，但必须明确标记 Preview，不能把演示数据标成 live Host state。目录选择、持久项目注册、credentials 和未支持的 command family 留给 DESK-066 及后续。

## 考虑过的备选方案

- Desktop 直接 import `apps/web/src`：不采用。apps 是 composition roots，跨 app 源码导入会形成错误方向的深依赖。
- 把 Web UI 复制到 Desktop：不采用。这样会复制业务呈现并持续漂移。
- 将共享视图放入 `@tracegraph/workbench`：采用。Web 与 Desktop 是两个真实消费者，现有 `WorkbenchClient` 已是注入 seam，并能为 package 增加契约/UI 测试。

## 不变量与边界

- 共享 Workbench 拥有展示和 client-neutral view state；Host/Core 仍是真实业务事实来源。
- Web 与 Desktop 都通过各自 transport adapter 注入同一个 `App`；共享 package 不导入 Electron 或 Node 模块。
- Electron Main 拥有 Host 子进程生命周期。Preload 只暴露显式方法。Renderer 开启 `contextIsolation`、sandbox，且 `nodeIntegration: false`。
- 打包后的 Renderer 通过 `file://` 加载；Electron Main 不启动 HTTP server，也不监听网络端口。
- 每个 RPC request/response 在跨入 Renderer 前由现有 SDK/contracts schema 校验。
- Demo state 必须显式标记，不得伪装成真实 Run 或 Host receipt。
- DESK-065 不增加项目路径权限、credential 访问、持久设置或当前 Host 不支持的路由语义。

## 迁移与回滚

把共享源码和测试移动至 `packages/workbench`，保留现有 UI 导出与行为。`apps/web` 只调整导入并显式创建 client。若回滚 Desktop shell，Web app 仍依赖共享 package；两个消费者继续支持 package 的边界存在。

## 验收标准

- [x] Web 与 Desktop 都从 `@tracegraph/workbench` 呈现相同的 Workspace/Session 导航、对话、Run 活动与 Tool 状态 UI。
- [x] Web app 显式注入 client 后，保留原有 HTTP/SSE Host 语义。
- [x] Desktop Main 启动 exact-version Host，通过固定 typed preload methods 使用当前支持的 framed route；不支持的能力明确返回，不编造业务状态。
- [x] `--preview` 界面明确标为 Preview，且只使用 `DemoTraceGraphClient` 数据。
- [x] Renderer/共享 Workbench 不含 Node/Electron 导入；Preload 运行时只依赖 Electron `contextBridge`/`ipcRenderer`；Main 不开放网络端口。
- [x] Desktop build 与真实 Electron Preview/实时窗口 smoke 通过。Workbench：149 项测试和 typecheck；Desktop：5 项 adapter/security 测试、typecheck、build；Web：build 与 protocol test。
- [x] workspace 依赖策略、生成模块图、路线图、Desktop/client 文档、package README 与双语 Note 一致。

## 风险与未决问题

- 当前 Host 没有 project list/open-local 路由，因此实时 Desktop 启动时没有已注册 Workspace；Session 列表仍以 Host 返回为准。DESK-066 增加原生项目注册。
- 首期 Desktop adapter 不能把未支持的 command 显示成 transport 故障。UI 消息需要保留路由的显式 unavailable 状态。
- Electron 安装包与更新签名不在本任务范围。

## 证据

- 实现：`packages/workbench/src/`、`apps/web/src/main.tsx`、`apps/desktop/src/`、`apps/desktop/renderer/`。
- 测试：Workbench `test:unit` 149 项通过；Desktop `test:unit` 5 项通过；Web protocol test 1 项通过。
- Build/typecheck：Workbench build/typecheck、Web build、Desktop build/typecheck 通过。
- 架构门禁：`verify:lockfile`、`verify:package-readmes`、`verify:boundaries`、`verify:invariants`、`graph:modules:check`、`verify:v2-docs` 均通过。
- Runtime：Electron 窗口在实时与 `--preview` 模式下均真实启动；Preview 标签可见，实时模式显示“本地”且无已注册 Workspace；`lsof -nP -a -p <Electron-main>,<Desktop-Host-child> -iTCP -sTCP:LISTEN` 无结果。
