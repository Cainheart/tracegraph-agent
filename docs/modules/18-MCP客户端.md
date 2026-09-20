# 18. MCP 客户端：生命周期、降级启动与工具桥接

> 实现状态：**已实现/已验证（G-11）**。当前支持受 Host 管理的 stdio JSON-RPC MCP server；每个 server 一个 client，支持 required/optional 启动、degraded 状态、工具发现刷新、原生工具注册、严格凭据引用与 canonical Trace。HTTP/SSE server、resources/instructions 和 PTC 子进程执行面尚未开放，均以 fail-closed 方式保留为后续扩展。

## 1. 交付边界

G-11 的目标是让外部能力进入现有 Tool/Policy/Receipt/Observation/Session Ledger 链，而不是让 MCP server 直接获得 Host 权限。

- 配置契约：MCP_CONFIG_VERSION = "tracegraph.mcp.v1"，默认读取 <dataDir>/mcp.json，也可用 --mcp-config 或 TRACEGRAPH_MCP_CONFIG 指定。
- 传输：只接受 transport: "stdio"；进程以 shell: false 启动，stdout 使用有界 JSON-RPC 行协议，stderr 只保留 4 KiB 尾部。
- 生命周期：spawning → initializing → ready → degraded → stopped。
- 工具模式：当前交付的是 native bridge——tools/list 的每个 MCP tool 映射为一个动态内部 Tool；PTC（脚本/子进程内的 Programmatic Tool Calling）没有假装启用，未来必须复用 G-13 沙箱与 G-05 批调度后再开放。
- 事件：mcp.server_started、mcp.server_failed、mcp.server_stopped、mcp.tools_changed、mcp.tool_called 追加到 canonical EventTypeSchema；随后 G-12 追加两个 `lsp.*`、G-20 追加两个 `code.*` 事件，当前总数为 102；事件账本仍是唯一事实源。
- 版本边界：`SCHEMA_VERSION = "tracegraph.session-event.v1"` 保持不变；G-20 的可选 `code_intel` 使当前 `PROJECTOR_VERSION = "tracegraph.projector.v9"`；`MCP_CONFIG_VERSION = "tracegraph.mcp.v1"` 只约束 MCP 配置 envelope。

## 2. 配置与密钥

配置示例（JSON）：

    {
      "config_version": "tracegraph.mcp.v1",
      "servers": [
        {
          "name": "filesystem",
          "command": "npx",
          "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
          "required": false,
          "transport": "stdio",
          "env": {
            "FILESYSTEM_TOKEN": "\${secret:FILESYSTEM_TOKEN}"
          },
          "tool_policy": {
            "allow": ["read_file", "list_directory"]
          }
        }
      ]
    }

McpConfigSchema 拒绝重复 server/tool policy 项、未知键、超限命令参数和明文的 TOKEN/SECRET/PASSWORD/KEY/CREDENTIAL 环境值。凭据引用在 CLI 装配阶段才由 G-19 credential store 解析；状态、事件、日志和 Web 永远不返回 secret value。

## 3. Core 生命周期与安全桥

packages/core/src/mcp/client.ts 负责一个 server 的 JSON-RPC：

1. initialize；
2. notifications/initialized；
3. tools/list；
4. tools/call；
5. notifications/tools/list_changed 到达时刷新目录。

`McpManager`（`packages/core/src/mcp/manager.ts`）负责多 server 编排；`createMcpToolsExtension` 把 catalog 接到 `ExtensionManager`：

- optional server 启动失败只变为 degraded，Host 继续启动；required server 失败会抛 McpStartupError，错误保留 server 名和 stderr 尾部，并阻止 Host 启动。
- ready server 的进程意外退出会撤下其旧 Tool、发 `mcp.tools_changed`，并转为 `degraded`/`mcp.server_failed`；Host 不会继续把已死亡进程伪装成 ready。
- readOnlyHint=true 映射为 read，destructiveHint=true 映射为 write，声明缺失时默认 write。工具名使用 mcp_<server>__<tool> 命名空间，避免与内置/扩展工具碰撞。
- MCP Tool 先进入 ExtensionManager/ToolRegistry，因此仍经过 strict input、模型 schema 白名单、G-06 Policy、Plan Mode、timeout、并发标记与标准 Receipt/Observation；MCP 工具不会拿到 Workspace 文件能力。
- 调用参数只持久化 SHA-256 摘要；结果统一裁剪为有界 RawToolResult。server 不可用时同样追加 mcp.tool_called(status=unknown)，不会静默丢失调用事实。
- tools_changed 会原子替换动态注册：新增工具出现在下一次 modelSchemas()，删除工具不残留；刷新失败会撤下旧工具并将 server 降级。

### 3.1 Canonical Trace 时序

MCP manager 的进程事件先进入 bounded history；Runtime 创建下一条 Run 时把未消费的生命周期事实追加到该 Run 的 Ledger。活动 Run 中的调用通过 Run-scoped bridge 追加 mcp.tool_called，因此 lifecycle、Tool Receipt、Observation 和 projection 可以按同一条 canonical trace 重放。MCP manager 不创建并行日志。

## 4. Host / SDK / CLI / Web

Host 提供有界、需要 capability 的控制面：

- GET /api/mcp：返回每个 server 的 state、required、tool_count、tool catalog 和 degraded error；
- POST /api/mcp/restart/:name：body 只有 command_id，按 command id 幂等；
- 缺少 MCP manager 的嵌入式 Host 返回 501，而不是假装“没有 server”。

SDK 对应 getMcpStatus() 与 restartMcpServer(name)。CLI：

    tracegraph mcp list
    tracegraph mcp restart <server>

实现入口为 `runMcpCommand(...)`（`apps/cli/src/mcp-command.ts`）；它只通过 Host API 读取状态或提交 restart command，不直接绕过 Host 调用 server。

Web Settings 只显示 bounded status/tool count，并对 degraded server 显示警示；配置文件和 credential value 仍归本机 Host 管理。

## 5. 验证映射

| 事实 | 代码 / 测试 |
| --- | --- |
| strict config、secret reference、status/event payload | packages/contracts/src/mcp.ts、packages/contracts/src/mcp-g11.test.ts |
| stdio JSON-RPC、超时、stderr tail、list_changed | packages/core/src/mcp/client.ts |
| required/optional、工具映射、刷新、调用结果与事件 | packages/core/src/mcp/manager.ts、packages/core/src/mcp.test.ts |
| Host status/restart 与 command-id 幂等 | packages/host/src/index.ts、packages/host/src/index.test.ts |
| typed SDK | packages/sdk/src/index.ts、packages/sdk/src/index.test.ts |
| CLI control plane | apps/cli/src/mcp-command.ts、apps/cli/src/mcp-command.test.ts |
| Web settings projection | apps/web/src/client.ts、apps/web/src/live-client.ts、apps/web/src/components/SettingsPanel.tsx |
| 文档/标识符/路由/事件一致性 | evals/docs/implementation-consistency.eval.ts |

## 6. 明确限制

当前不是完整的 MCP platform：只支持 stdio，不启动 HTTP/SSE transport，不暴露 resources/prompts/instructions，不动态加载第三方 npm/module，也不把 PTC 伪装成 native call。官方 @modelcontextprotocol/server-filesystem 的真实 e2e 仍是可选环境测试；离线 fixture 覆盖生命周期、降级、刷新和调用契约。PTC 若开放，必须先提供独立的沙箱/审批/批调用契约，不能让远程 MCP server 绕过既有 G-06/G-13/G-04 边界。
