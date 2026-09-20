# 19. LSP 客户端：原生 stdio 诊断与语义位置

> 实现状态：**已实现/已验证（G-12）**。TraceGraph 现在可以按项目懒启动 Host-owned Language Server，通过有界 JSON-RPC stdio 接收诊断，并按需查询 definition/references。完整索引、跨 Host LSP、HTTP/SSE transport 和 PTC 不在本项范围内。

## 1. 交付边界

G-12 把语言服务器作为 Core 的语义能力 seam 接入现有 Tool/Receipt/Observation/Session Ledger 链；LSP 进程不会直接获得 Workspace 或 Ledger 写权限。

- 配置契约：`LSP_CONFIG_VERSION = "tracegraph.lsp.v1"`，默认候选为 `typescript-language-server --stdio` 与 `pyright-langserver --stdio`；CLI 可通过 `--lsp-config`、`TRACEGRAPH_LSP_CONFIG` 或 `<dataDir>/lsp.json` 覆盖。
- 传输：只接受原生 stdio；`shell:false`、Content-Length framing、请求/响应大小、请求超时、Abort 和 TERM→KILL 关停均有界。
- 生命周期：`stopped → spawning → initializing → ready → unavailable`；server 不存在或初始化失败时 `get_diagnostics` 返回 `status: "unavailable"`，不把失败伪装成空诊断。
- 工具：`get_diagnostics(paths?, max_items?, severity?)` 返回严格、分页前有界的诊断；完整诊断只作为当前 Tool observation 返回，Ledger 只保存摘要、计数、sample 和 hash。
- 语义位置：`LspManager.definition()` 与 `references()` 暴露经过 Workspace containment 和相对路径校验的 `LspLocation`，供可信 Host/Core 集成，不把任意 URI 直接传到 Web。
- 事件：`lsp.diagnostics_received` 与 `lsp.server_unavailable` 追加到 canonical `EventTypeSchema`；`RunProjection.diagnostics_summary` 只保存最新的有界摘要。当前 canonical Event 共 100 种，`PROJECTOR_VERSION = "tracegraph.projector.v8"` 保持不变。

## 2. Core 客户端与 Manager

`packages/core/src/lsp/client.ts` 实现单 server 的 LSP JSON-RPC：

1. `initialize` / `initialized` 能力协商；
2. `textDocument/didOpen`、`textDocument/didChange`、`textDocument/didClose`；
3. `textDocument/publishDiagnostics` 通知缓存；
4. `textDocument/definition`、`textDocument/references` 请求；
5. Content-Length 解帧、JSON-RPC error、超时/取消与优雅停止。

`packages/core/src/lsp/manager.ts` 的 `LspManager` 负责按 `(project, workspace, server)` 的懒 session，`createLspToolsExtension` 把 `get_diagnostics` 接到 ExtensionManager：

- 通过文件扩展名选择唯一 server，读取文件前复用 `resolveWorkspacePath` 与 `assertInside`；
- 每次诊断请求只打开显式 paths，等待一个有界 diagnostics window，再按 severity、稳定路径/位置排序；
- summary 最多保留 128 条计数、20 条 sample，`diagnostics_hash` 对 bounded window 做去重/对账；
- server unavailable 只产生 bounded unknown Tool result 和 canonical unavailable 事件；不盲目重试外部进程；
- Tool 经过 Runtime 的 `LspToolBridge` 写入当前 Run，因此 manager history/事件 observer 不会与 Run-scoped event sink 重复入账。

## 3. 证据、Context 与代码图边界

LSP 诊断不是第二份日志，也不是静态 CodeGraph 的替代品。

- CodeGraph 继续负责静态导入/导出拓扑；LSP 负责语言服务器已经确认的语义诊断和位置查询。
- `lsp.diagnostics_received` 的 payload 不含完整消息列表之外的大对象，Projection 只更新 `diagnostics_summary`；完整列表只有当前 Tool observation 可见。
- 当前实现没有自动把诊断注入每轮 Context，也没有“改动后自动诊断”后台任务。调用方必须显式调用 `get_diagnostics`，后续可由 G-20 的 `code_intel` 视图按预算接入。
- 诊断路径必须是 workspace-relative；URI、绝对路径、越界 symlink 和不匹配扩展均不会成为公开位置。

## 4. Host / SDK / CLI / Web

- Host `GET /api/lsp` 只返回 strict、bounded server status；没有 manager 的嵌入式 Host 返回 501。
- SDK 提供 `getLspStatus()`，重新解析 `LspStatusSnapshotSchema`；不会把 command、args、环境或 stderr 暴露给浏览器。
- CLI 在 MCP/扩展装配后创建 `LspManager`，激活 `@tracegraph/lsp-stdio` Tool extension，并在关闭时停止 LSP child；状态通过 Host control plane 查询。
- Web Settings 展示 server state、扩展名、诊断计数和脱敏错误；不会修改 LSP command，也不取得 Workspace 文件内容。

## 5. 验证映射

| 事实 | 代码 / 测试 |
| --- | --- |
| strict config/status/diagnostic/event/projection contract | `packages/contracts/src/lsp.ts`、`packages/contracts/src/lsp-g12.test.ts` |
| Content-Length stdio、initialize、publishDiagnostics、超时与 stop | `packages/core/src/lsp/client.ts`、`packages/core/src/lsp.test.ts` |
| lazy session、workspace containment、bounded summary、unavailable 降级 | `packages/core/src/lsp/manager.ts`、`packages/core/src/lsp.test.ts` |
| Runtime Tool bridge 与 canonical Trace | `packages/core/src/runtime.ts`、`packages/core/src/projection.ts` |
| Host/SDK status route | `packages/host/src/index.ts`、`packages/host/src/index.test.ts`、`packages/sdk/src/index.ts` |
| CLI 装配与 Web Settings | `apps/cli/src/index.ts`、`apps/web/src/live-client.ts`、`apps/web/src/components/SettingsPanel.tsx` |
| 文档/标识符/路由/事件一致性 | `evals/docs/implementation-consistency.eval.ts` |

## 6. 明确限制

这是原生 stdio LSP client，不是完整 IDE language platform：没有 HTTP/SSE server、远程 registry、跨 Host session、完整 workspace indexing、自动 Context 注入、G-20 `code_intel` 合并视图或 PTC。真实 `typescript-language-server`/`pyright` 是否安装仍由 Host 环境决定；没有可用 server 时系统保持可用并给出可审计的 unavailable 结果。LSP child 也不自动获得 G-13 OS sandbox、G-04 Action WAL 或外部副作用恢复能力。
