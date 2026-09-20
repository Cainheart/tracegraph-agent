# 模块 11：CLI 与装配

> 定位：唯一的"可运行入口"。把 Core / CodeGraph / Retrieval / Telemetry / Host 装配成一个本地服务，并管理数据目录、项目注册表与模型凭据。
> 代码：`apps/cli/src/index.ts`、`extension-config.ts`、`extension-command.ts`、`team-command.ts`、`permission-config.ts`、`sandbox-config.ts`（legacy seam）、`model-config.ts`、`telemetry-config.ts`、`retrieval-config.ts`、`subagent-config.ts`、`project-registry.ts`、`composition.ts`；扩展生命周期、凭据、Permission、Sandbox、Memory、Subagent 与 Session 实现在 `packages/core`，本地检索在 `packages/retrieval`，可选 HTTP 服务/client 在 `apps/retrieval-service`，Telemetry sink 在 `packages/telemetry`
> 最后核对：2026-09-19
> 实现状态：**已验证**（包括 `extension-config.test.ts`、`extension-command.test.ts`、`team-command.test.ts`、`retrieval-config.test.ts`、`subagent-config.test.ts` 与 retrieval-service 单元/集成测试）

---

## 1. 命令面

```
tracegraph serve [--readonly /absolute/path] [--data-dir <path>] [--session-dir <path>] [--env-file <path>] [--extension-config <path>] [--permission-preset read-only|workspace-write|full-write] [--sandbox-mode read-only|workspace-write|danger-full-access] [--subagent-profiles readonly,code-explorer] [--max-parallel-subagents 2] [--max-subagent-depth 1] [--subagent-max-steps 6] [--subagent-max-tokens 16000]
tracegraph extensions list [--host-url http://127.0.0.1:4311]
tracegraph extensions reload <trusted-extension-name> [--host-url http://127.0.0.1:4311]
tracegraph extensions run <command> [args...] [--host-url http://127.0.0.1:4311]
tracegraph team show <coordinator-run-id> [--host-url http://127.0.0.1:4311]
tracegraph team create <coordinator-run-id> [--command-id <id>] [--host-url http://127.0.0.1:4311]
tracegraph team mailbox send|claim <actor-run-id> <operation-flags> [--command-id <id>] [--host-url http://127.0.0.1:4311]
tracegraph team task create|claim|complete|block|cancel|reopen <actor-run-id> <operation-flags> [--command-id <id>] [--host-url http://127.0.0.1:4311]
tracegraph team heartbeat <member-run-id> [--command-id <id>] [--host-url http://127.0.0.1:4311]
tracegraph team sweep <coordinator-run-id> [--command-id <id>] [--host-url http://127.0.0.1:4311]
tracegraph mcp list [--host-url http://127.0.0.1:4311]
tracegraph mcp restart <server> [--host-url http://127.0.0.1:4311]
```

缺省命令仍是 `serve`；G-17 的 `extensions list|reload|run` 与 G-08 的 `team` 都是 typed SDK 的薄客户端，只连接已运行 Host。`runTeamCommand()` 覆盖 team snapshot、创建、mailbox、task、heartbeat 与 sweep；Run id 决定 Host 绑定的 coordinator/member authority，命令语法不接受 project、actor、sender、owner、客户端时钟或 timeout 注入。

除只读 `team show` 外，**每个 Team mutation** 都可选 `--command-id <id>`。收到超时、断连或响应丢失时，operator 应以同一 command id 和完全相同的业务参数重试；Core 返回原 canonical mutation result，而不是追加第二份事实。同 id 改 payload 会冲突。`team show` 只接受可选 `--host-url`，刻意不接受 `--command-id`。Host URL 的优先级是 `--host-url` → `TRACEGRAPH_HOST_URL` → `http://127.0.0.1:4311`；解析成功后 CLI 先 bootstrap capability，再发 typed SDK 请求并把 strict JSON 结果写到 stdout。

G-11 的 `mcp list|restart` 同样只连接已运行 Host：`runMcpCommand(...)` 实现命令分派，`mcp list` 读取 `/api/mcp` 的 bounded server/tool status，`mcp restart <server>` 只提交 command id 并可安全重试。

operator 应使用自己稳定且无内部前缀的 id。`team-expire:`、`team-join:`、`team-retire:` 与 `team-tool:` 是 Core 保留的 Team 命名空间；create/sweep 会拒绝任一这类外部 id，其它入口也按 actor/命令来源防止调用方占用内部派生 key。CLI 不会用保留前缀替用用户 id。

`team-command.ts` 的完整 usage 是具体 flag 的事实源：mailbox send 需要 `--to/--kind/--payload`，claim 需要 `--message-id`；task create 需要 id/title/至少一条 acceptance，后续 task mutation 需要精确 `--expected-version`，complete 还需要至少一个 `--evidence-event-id`。未知或重复的非 repeatable flag 在 bootstrap 前失败。未知命令写 stderr 并以退出码 2 结束。

`readFlag` 只支持 `--flag value` 形式（不支持 `--flag=value`），缺值抛错。

| 路径 | 解析顺序 | 默认值 |
|---|---|---|
| 仓库根 | `import.meta.url` 上溯 3 级 | — |
| 数据目录 | `--data-dir` → `TRACEGRAPH_DATA_DIR` → | `<repo>/.tracegraph` |
| Session 目录 | `--session-dir` → `TRACEGRAPH_SESSION_DIR` → | `~/.tracegraph/sessions` |
| 环境文件 | `--env-file` → `TRACEGRAPH_ENV_FILE` → | `<repo>/.env.local` |
| 扩展配置 | `--extension-config` → `TRACEGRAPH_EXTENSION_CONFIG` → | `<dataDir>/extensions.json`（缺失时启用两个 trusted built-in） |
| MCP 配置 | `--mcp-config` → `TRACEGRAPH_MCP_CONFIG` → | `<dataDir>/mcp.json`（缺失时不配置 server；required failure 阻止 Host 启动，optional failure 降级） |
| Permission ceiling | `--permission-preset` → `TRACEGRAPH_PERMISSION_PRESET`；未设置时才采用兼容 sandbox 映射 | `workspace-write` |
| 兼容 Sandbox 输入 | `--sandbox-mode` → `TRACEGRAPH_SANDBOX_MODE`；映射为同名权限 preset，和新配置冲突则拒绝启动 | — |
| 用户 preset 选择 | 私有 `~/.tracegraph/harness-config.json`，必须不高于 ceiling | ceiling 本身 |
| 项目收紧规则 | canonical `<projectRoot>/.tracegraph/policy.json`；只允许 `ask/deny` | 空规则 |
| 托管项目 | — | `<dataDir>/projects` |
| 聊天工作区 | — | `<dataDir>/chat-workspace` |
| 本地项目注册表 | — | `<dataDir>/local-projects.json` |
| 模型配置 | — | `<dataDir>/model-config.json` |
| 附件 staging/claim/lookup | — | `<dataDir>/attachments`（私有目录；默认 staging TTL 15 分钟） |
| token 校准 | — | `<dataDir>/token-calibration.json` |
| Telemetry sink 配置 | — | `<dataDir>/telemetry.json`（文件缺失即 noop；没有 CLI/browser 写入口） |
| canonical Memory | — | `<dataDir>/memory/records.jsonl` |
| 本地 Retrieval 索引 | — | `<dataDir>/retrieval-index`（按项目隔离的 JSONL/BM25） |
| 可信子 Agent profile | `--subagent-profiles` → `TRACEGRAPH_SUBAGENT_PROFILES` | `readonly`；可选编译期 `code-explorer,evidence-reviewer` |
| 子 Agent 并发/深度 | `--max-parallel-subagents` / `--max-subagent-depth` → 同名 `TRACEGRAPH_MAX_PARALLEL_SUBAGENTS` / `TRACEGRAPH_MAX_SUBAGENT_DEPTH` | `2` / `1` |
| 子 Agent 默认预算 | `--subagent-max-steps` / `--subagent-max-tokens` → `TRACEGRAPH_SUBAGENT_MAX_STEPS` / `TRACEGRAPH_SUBAGENT_MAX_TOKENS` | `6` steps / `16000` tokens |
| Patch Action WAL / before-image | — | `<dataDir>/wal` |
| Recovery attempt ledger | — | `<dataDir>/recovery` |
| Session 回收站 | Session 目录的父目录 | `<sessionDir>/../sessions-trash` |

---

## 2. 启动顺序

```151:168:apps/cli/src/index.ts
  const runtime = await createAgentRuntime({
    dataDir,
    telemetrySink,
    sessionStore,
    codeGraph: createCodeGraphProvider(),
    retriever: retrieval.retriever,
    model,
    maxTurns: parsePositiveInteger(process.env.TRACEGRAPH_MAX_TURNS) ?? 12,
    sandboxMode: initialPermission.selected_preset.sandbox_mode,
    permissionPolicyResolver: (workspace) => permissionConfig.resolveProject(workspace.real_root),
    rollbackPolicy: {
      enabled: process.env.TRACEGRAPH_ROLLBACK_ENABLED === "true",
      allowForce: process.env.TRACEGRAPH_ROLLBACK_ALLOW_FORCE === "true",
    },
  });
  // ...
  const host = await createTraceGraphHost({
    runtime,
    sessions: new DurableSessionController({
      store: sessionStore,
      runtime,
      workspaceResolver: (projectId) => recoveryWorkspaces.get(projectId),
    }),
    projects,
    logger: true,
    modelSettings: { ... },
    permissionSettings: {
      get: () => permissionConfig.resolveSettings(),
      configure: async (input) => {
        await permissionConfig.setUserPreset(input.preset_key);
      },
    },
    projectFactory: (input) => createManagedProject(managedRoot, input.name),
    localProjectSelector: async ({ access }) => {
      const selectedRoot = await selectLocalDirectory(access);
      return selectedRoot === undefined
        ? undefined
        : localProjectRegistry.register(selectedRoot, access);
    },
    projectRevealer: async (project) => revealLocalDirectory(project.workspace.real_root),
    chatProject: {
      label: "Plain chat",
      workspace: chatWorkspace,
    },
  });
```

1. `loadPrivateEnvFile(envFile)`（`node:process.loadEnvFile`；ENOENT 静默忽略）。
2. 打开 `PermissionConfigController`：新 permission flag/environment 建立 Host ceiling；旧 sandbox flag/environment 只作兼容映射；新旧冲突、用户持久选择高于 ceiling 或非法值都直接拒绝启动。
3. 建平台 `CredentialStore`，然后调用 `createConfiguredTelemetry({dataDir, credentialStore, environment})` 读取 `<dataDir>/telemetry.json`；authorization 只能借用这份 G-19 边界。配置缺失直接得到 Noop sink。
4. 调用 `createConfiguredRetrieval({dataDir, environment})`：缺少远端 URL 时建立 `<dataDir>/retrieval-index` 的本地 JSONL/BM25 backend；配置 URL 时建立远端 client + 本地可用性 fallback。
5. 打开 `HostExtensionController`：配置仅为最大 256 KiB、O_NOFOLLOW 的 strict JSON，`module` 只能等于 Host trusted catalog id；Core/CLI 不执行项目 `tracegraph.config.ts`、本地 JS/TS 或 npm specifier。随后读取 MCP 配置，先启动每个 stdio server，再把 native tools 接入同一个 ExtensionManager；required server 失败会在 Host listen 前中止，optional server 记录 degraded 并继续。随后建 `JsonlSessionStore`、`projects/` 与 `chat-workspace/`，打开本地项目注册表并汇总 managed/linked/readonly 项目，构造无 Workspace 能力的聊天工作区。
6. 装配模型适配器，读取/迁移 persisted model config，并选择 environment 或 persisted 活动配置；G-18 `TRACEGRAPH_MODEL_IMAGE_INPUT` 只接受 `true/false/1/0`，未设置默认 false，作为显式 Host-owned capability 注入适配器。
7. 调用 `createConfiguredSubagents()`：只从编译期 trusted catalog 选 profile name，并用 flag/env 收窄 profile 集合、parallel/depth 与 step/token 默认预算；provider 绑定、role prompt/version/hash、tool allowlist 不从环境、HTTP 或模型输入读取。
8. 建 Runtime：注入与 Host controller **同一个** `extensionManager`，再注入 `telemetrySink`、`sessionStore`、`retriever`、`subagentRegistry`、parallel/depth limits、初始 legacy fallback `sandboxMode` 与逐新 Run 调用的 `permissionPolicyResolver`；Runtime 默认建立 `<dataDir>/token-calibration.json`、`memory/records.jsonl`、`wal/`、`recovery/` 与 `attachments/`；这里也是标准 serve 路径注入 `codeGraph`、标准 retrieval、G-07 trusted subagent composition 与 G-18 model image capability 的地方。G-20 的 `createCodeGraphProvider()` 同时提供 AST snapshot/delta 与固定只读 Git context probe；Host 本身不构造该 provider。
9. 用已加载 workspace 建只读 `recoveryWorkspaces` Map，注入 `DurableSessionController.workspaceResolver`。
10. 建 Host（注入 bounded permission settings get/configure 与同一 `HostExtensionController`）。Telemetry status 不另设 composition seam；Host 直接读取 Runtime 的 `getTelemetryStatus()`，避免第二份状态源。在 `listen()` 前完成 Session tail repair → 已注册 workspace 的 Action WAL/父子 Run 对账 → 其它非终态 Run 的 interrupted 标记，失败则 fail-closed。
11. 打印 Permission preset、对应 sandbox 状态、Retrieval 模式、启用的 Subagent profiles 与 parallel/depth、Model image input enabled/disabled、Host 地址、Web Workbench 地址、模型配置来源与令牌到期时间；full-write 文案明确注明 sandbox disabled。
12. `SIGINT` / `SIGTERM` 调用 `closeHostAndFlushTelemetry()`：先等待 `host.close()` settle，无论 close 成功或失败都会随后启动 `runtime.flushTelemetry()`；整个 Telemetry flush barrier 共用默认 5,000 ms 总等待预算，超时即继续关停。该预算不同于 `telemetry.json.timeout_ms` 的单次 HTTP 请求 timeout。

**这是全仓唯一的组合根。** 所有可选能力（项目创建、目录选择、目录揭示、模型配置、Permission 设置、代码图、Memory retriever、Telemetry sink）都在这里被接线。Telemetry 缺失配置时明确装配 Noop sink，保持零网络；Retrieval 缺失远端配置时明确装配本地 backend，而不是关闭 recall。

G-20 的 `createCodeGraphProvider().captureGitContext()` Git probe 不是模型 Tool，也不是 shell escape hatch：它只运行 `git -c core.hooksPath=/dev/null -C <canonical workspace>` 的固定只读子命令，`shell:false`、5 秒 deadline、64 KiB stdout 上限、禁用 system config/optional locks；工作树探测使用 `git status --porcelain=v1 -z --untracked-files=normal`，故 status SHA-256 fingerprint **覆盖 untracked 文件**。公开事实只写 full commit、branch、dirty、该 fingerprint 与时间。Git 不可用时返回严格的 `unavailable` context；不会把“无法探测”当作“工作树未变化”，因此不会承诺 stale-base 重新审批保护。

Session 目录有独立 flag/env，但**不是可与任意 `dataDir` 自由组合的独立数据库**：JSONL 只保存 Event ref，没有 ledger locator，Controller 总是到当前 `dataDir/events` 解析它。一个 Session root 必须固定配对创建它的同一个 `dataDir`；多数据目录/多实例应同时指定不同且稳定的 `--session-dir`。误把多个 Ledger 指向同一 Session root 时，启动扫描会因找不到或作用域不匹配而 fail-closed。默认组合为 `<repo>/.tracegraph` + `~/.tracegraph/sessions`，隐含单一 TraceGraph data root 的使用方式。删除会话移动到 Session 根的同级 `sessions-trash`，不会删除 Project、Run Ledger 或真实工作区文件。

`token-calibration.json` 跟随 `dataDir`，没有单独 CLI flag。它只保存 provider/model 的比例样本、revision 与时间，不保存 Context 正文；目录/文件在 POSIX 上收紧为 `0700`/`0600`，采用临时文件 + fsync + rename，并拒绝 symlink、非普通文件、错误 owner/权限、损坏或超 1 MiB 内容。初始化失败会让 Runtime 本轮退回启发式并保留未校准 usage，而不是让 Host 不可用。它的 Promise queue 只保护单进程：不要让多个 Host 同时写同一 `dataDir`，否则校准状态可能 last-writer-wins。

CLI 当前没有装配 bundled tokenizer 或 Anthropic `count_tokens` client，也没有向 Runtime 注入自定义 `TokenCounter`。因此默认 preflight 只可能是 `estimated` 或已有历史样本后的 `calibrated`；契约中的 `exact` 仍是未来 full-wire counter 的预留值。

### 2.1 Rollback 环境策略

两个开关都采用**精确字符串 `"true"`**；未设置、大小写不同或其它值一律为 false：

| 变量 | 默认 | 含义 |
|---|---|---|
| `TRACEGRAPH_ROLLBACK_ENABLED` | `false` | 总开关；关闭时包括 disposable 在内的全部请求都写 `action.rollback_refused` |
| `TRACEGRAPH_ROLLBACK_ALLOW_FORCE` | `false` | 允许 managed/读写 linked workspace 的 force 分支；不能单独启用 rollback |

当总开关开启后，disposable workspace 不需要请求 force；managed/读写 linked workspace 必须同时满足 `ALLOW_FORCE=true` 与 wire 请求 `force:true`。无论配置如何，readonly 永远拒绝，force 也永远不能绕过 quiescent Run、verified WAL、canonical root binding、单目标和当前 after-hash 匹配。当前 CLI 没有 rollback 子命令，调用入口是 Host API / SDK。

### 2.2 Permission ceiling、用户选择与项目收紧

`PermissionConfigController.open()` 把配置分成三层，而不是让任意请求提交一组散装权限：

1. `--permission-preset` 高于 `TRACEGRAPH_PERMISSION_PRESET`，建立不可由 Web 提升的 Host ceiling；旧 `--sandbox-mode` / `TRACEGRAPH_SANDBOX_MODE` 映射为 `read-only / workspace-write / full-write`，仅用于兼容。若新旧来源同时存在且映射结果不同，启动 fail-closed。
2. 私有 `~/.tracegraph/harness-config.json` 保存用户选择，只能等于或低于 ceiling。Host/SDK/Web 的 `GET/POST /api/permission-config` 只读写 bounded preset key；更新无需重启 Host，但只影响之后创建的 Run。
3. 每个新 Run 再从 canonical `<projectRoot>/.tracegraph/policy.json` 读取 strict、最多 64 KiB 的项目规则。目录/文件 symlink、越界、非普通文件或非法结构均拒绝；项目规则只允许 `ask/deny`，不能增加 allow。

Run 创建时会冻结双层 effective policy 与 digest；活动 Run 不热切换，恢复 Run 也使用 recovery Artifact 中的原 policy/layers。若要改变 CLI/environment ceiling，仍须重启 Host。浏览器 StartRun/StartChat payload 没有 preset/sandbox/rule/token 字段，不能逐 Run 提权。

三种内置 preset 是固定组合：`read-only = read-only + never`、`workspace-write = workspace-write + on-write`、`full-write = danger-full-access + never`。默认 `workspace-write` 不等于“所有平台都已隔离”：macOS Runtime 会对每个 Run probe `/usr/bin/sandbox-exec`，成功才报告 full；Linux bwrap runner 尚未启用，Windows 无 backend，restricted `run_test` 会 fail-closed。`full-write` 是显式 opt-out，CLI 启动摘要与 durable/Web 证据都会显示 disabled/none。模型 provider networking 始终由 Host 发起，不经过这个 child runner。

Patch 行为也不是“受限程度越低，仍走同一审批”：`read-only` 在 preview 后直接 policy deny，不创建 approval request；默认 `workspace-write` 进入 Web/SDK 手工 ask 并使用一次性 token；未被规则收紧的 `full-write` policy allow 不产生 request/grant/token，仍重算 canonical action digest 并走 Workspace/hash/WAL。非 Patch `ask` 依赖可信 Host `approvalAnswerer`；当前 CLI composition 没有注入该自动 answerer，因此会按 Runtime 规则 fail-closed，不能改由 Web 的 Patch 审批条回答。

### 2.3 G-15 Telemetry 配置、G-19 authorization 与关停 flush

配置固定为服务端 `<dataDir>/telemetry.json`，没有单独 CLI flag、Host 写 API 或 Web 控件。文件不存在等价于：

```json
{ "sink": "noop" }
```

因此即使环境里已有 `OTEL_EXPORTER_OTLP_ENDPOINT`，也不会隐式启用外发。显式 OTLP-HTTP 示例：

```json
{
  "sink": "otlp_http",
  "endpoint_env": "OTEL_EXPORTER_OTLP_ENDPOINT",
  "authorization_ref": "${secret:TRACEGRAPH_OTLP_AUTH}",
  "max_queue_size": 512,
  "batch_size": 64,
  "timeout_ms": 5000
}
```

`endpoint_env` 保存的是**环境变量名**，endpoint 值只在服务端环境解析；它不经 G-19 存储。`authorization_ref` 才经 `createSecretReference()` + `resolveSecretReference()` 走现有 CredentialStore，解析出的值仅用于 Authorization header。config 不接受明文 authorization/header，也不会通过 status API 回显 reference/value。loader 限制 65,536 bytes、要求普通文件并拒绝 symlink/未知字段；错误文案不回显秘密。

CLI 把构造出的 sink 注入 Runtime，Runtime 用 `SafeTelemetry` 维护唯一 process-local 状态。Host 的只读 status 直接调用 Runtime，Web 只看 sink/state/error count/last error。终态会触发非阻塞 safe flush；关停 helper 即使 `host.close()` 失败也会尝试 flush，但 Host close settle 后的 Telemetry 总等待最多 5 秒，超时按 best-effort 继续退出。两者都不改变 Ledger 的事实源地位，也不把 Telemetry 用于恢复。

### 2.4 G-21 Retrieval：本地默认、远端可选与安全降级

CLI retrieval 配置只有三个环境输入：

| 变量 | 默认 | 含义 |
|---|---|---|
| `TRACEGRAPH_RETRIEVAL_URL` | 未设置 | 未设置时直接使用 `<dataDir>/retrieval-index` 的本地 JSONL/BM25；设置后优先调用远端服务 |
| `TRACEGRAPH_RETRIEVAL_TOKEN` | 未设置 | 远端 `/ingest`、`/search` 的 bearer token；不会进入 query/body 或 Ledger |
| `TRACEGRAPH_RETRIEVAL_TIMEOUT_MS` | `10000` | 单次远端 client deadline；只接受 1–60,000 的整数，非法值使启动失败 |

远端模式不是“网络失败时随便吞错”。`createConfiguredRetrieval()` 的规则是：

- ingest 远端成功后必须再写本地 mirror；mirror 写失败会向上暴露，不能声称已有可用 fallback；
- ingest/search 遇到连接失败、client timeout 或 HTTP 502–504 时才回退本地；
- 调用方主动 abort、4xx/认证，以及成功响应中的 scope、query hash、content hash 或 contract 校验错误都直接暴露，不用本地结果掩盖配置/安全问题；服务端返回的 HTTP 502–504 按明确的 availability 契约处理；
- 本地与远端 response 都继续由 Core 校验 project scope 与 query hash，Memory hit 再经过 canonical record 过滤。

独立服务可用 `pnpm retrieval:serve` 启动（先 build，再运行 `@tracegraph/retrieval-service`）；默认 loopback `4312`。服务进程另接受 `TRACEGRAPH_RETRIEVAL_PORT`、`TRACEGRAPH_RETRIEVAL_DATA_DIR` 与同名 `TRACEGRAPH_RETRIEVAL_TOKEN`。CLI **不会**自动启动、探活或监管该进程；URL 未设置时也不会发任何 retrieval 网络请求。若在同一机器同时使用远端服务和 CLI 本地 mirror，应给服务配置独立 data directory，避免两个进程并发写同一个 JSONL 索引目录。

服务/backend 暴露 embedding/provider 替换 seam，但当前标准装配仍是 JSONL/BM25；不能据此声称已经实现向量数据库、embedding 或 hybrid RAG。

### 2.5 G-07 Subagent：可信 catalog 与预算上限

`subagent-config.ts` 内置 `readonly`、`code-explorer`、`evidence-reviewer` 三个只读 profile。默认只启用 `readonly`；`--subagent-profiles` / `TRACEGRAPH_SUBAGENT_PROFILES` 只能从这三个名字中选取和去重，未知名直接阻止启动。三个 profile 的实际 provider key 固定为 `parent`，role prompt/version 与 tool allowlist 都在 composition root 中定义；CLI/env 不能注入 prompt、provider 或 authority。

parallel 允许 1–16、depth 允许 1–4、steps 允许 1–1000、tokens 允许正安全整数，非法值 fail-closed。配置形成 Runtime 的全局 orchestration limits 与每个 profile 的 default/ceiling；模型侧 `spawn_subagent` 仍只能请求不高于 ceiling 的 budget。默认 `parallel=2`、`depth=1`、`steps=6`、`tokens=16000`。G-08 复用这条 bounded delegation seam：root Ledger 已有 roster/mailbox/task board，Host/SDK/Web 有 Team 控制面，CLI 也提供上述连接已运行 Host 的 `tracegraph team` 薄客户端。单个 `spawn_subagent` 仍同步等 child 终态，worker 并行只来自 G-05 batch 并受这里的 permit 限制。

---

## 3. 聊天工作区：能力全关

```73:88:apps/cli/src/index.ts
  const chatWorkspaceBase = await createReadonlyWorkspaceHandle({
    projectId: "chat:local",
    root: chatRoot,
  });
  const chatWorkspace = {
    ...chatWorkspaceBase,
    capabilities: {
      index: false,
      read: false,
      search: false,
      run_command: false,
      preview_patch: false,
      commit_patch: false,
      test: false,
    },
  };
```

在只读句柄之上**再把七项能力全部显式置为 false**。因此普通聊天：

- 不建代码图（`index: false`）
- 任何工具调用都会被策略层拒绝
- 只有纯对话

Host 侧覆写 chat `project_id` 并强制 `mode: "execute"`（模块 09 §7）：execute 让普通聊天可以直接回答并结束，而不是误停在 Plan approval。"聊天不得触碰用户代码"仍由三层 Host 边界保证：独立项目路由、七项 Workspace capability 全 false，以及 PolicyEngine 对 capability 的 hard deny；它不依赖 Plan Mode 充当安全沙箱。

---

## 4. 模型凭据：引用、后端与迁移（G-19）

### 4.1 平台后端

CLI 在启动时只建立一个 `CredentialStore` seam：

| 平台/来源 | 实现 | 读写语义 | 静态存储边界 |
|---|---|---|---|
| macOS | `MacOsKeychainCredentialStore` | 可读写 | 系统 Keychain；`security add-generic-password` 的值经 stdin 输入，不进入 argv |
| 非 macOS | `PrivateFileCredentialStore` | 可读写 | `~/.tracegraph/credentials.json`，目录 `0700`、文件 `0600`；**仍是 plaintext-at-rest** |
| 环境变量 / `.env.local` | `EnvironmentCredentialStore` | **只读** | 值留在进程环境，不由 TraceGraph 写回 |

`LayeredCredentialStore` 只在所选持久后端返回“该名字不存在”时查询环境；持久后端读取报错会直接传播，**不会**静默回退到另一份明文。macOS 不会因 Keychain 被锁或命令失败而改用私有文件；私有文件只在非 macOS 由 composition 选中。

### 4.2 环境配置与活动优先级

`modelConfigFromEnvironment(process.env)` 不复制 Key，而是生成 `${secret:ENV_NAME}` 引用和 `{ backend: "environment", writable: false }` 元数据。显式 `TRACEGRAPH_MODEL_API_KEY` 模式与 provider-specific 推断顺序保持不变：

`DEEPSEEK_API_KEY` → `OPENAI_API_KEY` → `ANTHROPIC_API_KEY` → `GLM_API_KEY`/`ZHIPU_API_KEY` → `QWEN_API_KEY`/`DASHSCOPE_API_KEY` → `MINIMAX_API_KEY`

活动配置仍是 `environmentConfig ?? persistedConfig`。任何活动凭据元数据为 `writable: false`（包括自动识别的环境配置和 persisted reference 解析到环境）时，设置 API 都返回 `409`，Web 同时禁用保存；更新方式是修改环境变量后重启。

与旧实现不同，CLI **即使已有活动环境配置，也会读取持久化文件**。目的不是让文件覆盖环境，而是确保历史 `model-config.json` 中的明文 Key 仍会被迁移。

### 4.3 只持久化 secret reference

`model-config.json` 现在只保存 provider/protocol/baseUrl/model 与 `apiKey: "${secret:NAME}"`，不保存值。`persistModelConfig()` 先用 `SecretReferenceSchema` 拒绝明文，再以临时文件 `wx → chmod 0600 → rename` 原子替换；权限在 rename 前已经收紧，避免“引用已提交、随后 chmod 失败”造成悬空凭据。

设置页提交新 Key 时，`saveModelConfig()` 先写入 provider-scoped、带随机后缀的凭据名，读回并用 constant-time compare 验证，再取得安全 metadata、最后提交引用配置；中途失败会删除刚写的凭据。省略 Key 时只能复用**同一 provider**的现有引用，切换 provider 必须提供新 Key。设置写入由 CLI 串行化；成功轮换后给已捕获旧配置的在途请求保留 60 秒宽限，再 best-effort 删除旧可写凭据，失败只记录名字、不记录值。

模型适配器内存中长期保留的也是 `credentialRef`。每次 provider 请求前才调用 `resolveSecretReference()` 取值、登记精确值脱敏，然后放入 `Authorization` 或 `x-api-key` 请求头。

### 4.4 旧版明文迁移与审计

`readPersistedModelConfig()` 同时识别旧 `apiKey` 与 `api_key`：

1. 写入所选安全后端并读回验证；
2. 把源文件原子重写为 `${secret:TRACEGRAPH_<PROVIDER>_KEY...}`，同时写入不含值的 `credentialMigration` outbox；
3. 用稳定 migration id 幂等写一个 `system:tracegraph` 维护 Run，其中包含 `credentials.migrated`；若上次只写到一半，重启会补齐；
4. 审计 Run 提交后清除 outbox，stderr 只提示凭据名与 backend。

安全后端写入或验证失败时，迁移 fail-closed，旧源文件不被重写，Host 启动失败等待人工处理；审计或确认失败时 outbox 保留并在下次启动重试。迁移事件只含安全元数据，不含引用和值。启动摘要会报告 `environment`、实际 backend、`reference missing` 或 `not configured`。

---

## 5. 托管项目

`createManagedProject(managedRoot, name)`：

| 步骤 | 规则 |
|---|---|
| slug | 转小写 → NFKD 归一化 → 非 `[a-z0-9]` 换 `-` → 去首尾 `-` → 截断 40 → 空则 `project` |
| project_id | `project:<slug>:<randomUUID 前 8 位>` |
| 目录 | `<managedRoot>/<slug>-<id 后 8 位>` |
| 文件 | `.tracegraph-project.json`、`README.md`、`package.json`、`src/index.ts`，**全部 `flag: "wx"`** |

```154:154:apps/cli/src/index.ts
    writeFile(resolve(root, "src/index.ts"), `export function hello(): string {\n  return "Hello from ${name.replace(/["\\]/gu, "")}";\n}\n`, { flag: "wx" }),
```

用户输入的项目名进入生成代码前会**剥离引号与反斜杠**，避免注入模板字符串。

`loadManagedProjects` 在启动时扫描 `projects/` 子目录，读取元数据还原项目；元数据缺失或字段类型不对时**静默跳过**，JSON 解析失败时打印一行警告。

---

## 6. 本地项目注册表

```33:37:apps/cli/src/project-registry.ts
/**
 * Host-owned registry for folders selected through the native picker. The
 * browser never supplies `real_root`; it only receives an informational path
 * after the Host has canonicalized and registered the directory.
 */
```

**最重要的安全属性：`real_root` 只由 Host 产生。** 浏览器永远不能指定要访问的目录，只能通过原生选择器让用户在操作系统层面授权，Host 拿到后 `realpath` 规范化再注册。

| 行为 | 规则 |
|---|---|
| 文件格式 | `{ version: 1, projects: PersistedLocalProject[] }` |
| 安全校验 | `realpath` → 必须是目录 → **拒绝文件系统根** |
| project_id | `project:local:<sha256(access\0root) 前 16 位>`（**确定性**） |
| label | 目录基名；只读时加 ` (read-only)` |
| 重复注册 | 同 `real_root` + 同 `access` → 返回既有项目（幂等） |
| 写入 | tmp(`wx`, `0o600`) → `rename` → `chmod 0o600`；失败不改内存状态 |
| 加载 | 重复 id 告警跳过；目录不可用告警跳过（**记录保留在文件里**） |
| 解析失败 | 告警并返回空表（**不抛错**，保证 Host 仍能启动） |

```236:239:apps/cli/src/project-registry.ts
  if (canonicalRoot === parse(canonicalRoot).root) {
    throw new TypeError("Selecting the filesystem root is not allowed");
  }
```

---

## 7. 原生对话框与揭示目录

`selectLocalDirectory(access)` 按平台分派：

| 平台 | 命令 | 用户取消的识别 |
|---|---|---|
| macOS | `osascript` + `choose folder` | AppleScript `on error number -128` → 空字符串 |
| Linux | `zenity --file-selection --directory` | 退出码 1 |
| Windows | `powershell.exe -NoProfile -STA` + `FolderBrowserDialog` | 对话框非 OK → 无输出 |

统一超时 5 分钟、`maxBuffer` 16 KB。提示文案在读写模式下会明确说明：

```106:108:apps/cli/src/project-registry.ts
  const prompt = access === "read_write"
    ? "Choose a folder and grant TraceGraph read-write access (writes still require approval)"
    : "Choose a folder and grant TraceGraph read-only access";
```

**“授权写能力”与最终 policy 是否允许写是两件事。** 这条原生提示按默认 `workspace-write` 的人工审批语义编写；若 Host ceiling/用户选择是 `full-write`，实际写入不会再询问，因此不要把该静态文案当作当前 Run 的策略证据。真正的事实源是 Run 的 `permission.configured`、`policy.evaluated` 与 approval lifecycle。

`revealLocalDirectory(root)` 先 `requireSafeDirectory`（再规范化一次并拒绝根目录），再调 `open` / `xdg-open` / `explorer.exe`（超时 30 s）。

---

## 8. 已知缺口

1. **命令面仍很窄。** 除 `serve`、G-17 的 `extensions list|reload|run` 与 G-08 的 `team` 运维面外，没有一次性任务（`tracegraph run "..."`），也没有 `logs` / `replay` / `export` 的 CLI 子命令。G-23 已把按 sequence 的时间旅行接入 Runtime、Host、SDK 与 Web，但命令行用户仍不能通过 `tracegraph replay ...` 直接操作它。

2. **环境凭据是只读且启动时定值。** 它仍优先于持久化配置；设置 API 会明确返回 `409`、Web 会禁用保存，但要轮换环境 Key 仍必须修改环境并重启，当前没有运行时 reload。

3. **非 macOS 后端仍是明文静态存储。** `~/.tracegraph/credentials.json` 虽强制 `0600` 并拒绝权限过宽的既有文件，但没有 DPAPI/libsecret 集成，不能宣传为与 macOS Keychain 同等级保护。

4. **`--readonly` 的 project_id 恒为 `local-readonly`。** 同一 `dataDir` 下先后指向不同目录时，两个不同工作区共享同一个 project_id，账本里无法区分，`assertRegisteredProject` 也无法察觉。

5. **同一目录可用两种 access 注册两次。** `localProjectId` 把 `access` 纳入摘要，于是同一路径会出现 `read_write` 与 `read_only` 两个项目、两个 id；界面上是两条同名条目，需自行去重。

6. **项目移除边界明确。** Web 左侧项目列表的 remove command 对 Host 选择的本机目录只从 `local-projects.json` 撤销登记，不删除真实目录或源码；对 Host 创建的托管项目则在确认后删除其 `.tracegraph/projects` 下的项目副本。目录被外部删除、移动或撤销权限后，Host 仍会跳过不可用记录并报告告警。

7. **托管项目的失败静默度不一致。** 缺元数据时静默 `continue`（无任何日志），元数据非法时打印警告。排查"我的项目怎么不见了"时会遇到完全没有线索的情况。

8. **CLI 不托管 Web 静态资源。** 它只打印 `Web Workbench: http://127.0.0.1:4310`——那需要另起 Vite 或别的静态服务。Host 的 4311 只提供 API，`apps/web/dist` 不被任何服务读取。两个端口、两个进程、无内置编排。

9. **`TRACEGRAPH_MAX_TURNS` 非法值被静默忽略。** `abc` 或 `0` 会退回 12，不报错也不警告。

10. **`readFlag` 缺值抛的是未捕获异常。** `tracegraph serve --data-dir` 会以 Node 堆栈终止（退出码非 2），而不是给出 usage 提示；只有"未知命令"路径做了规范的 usage 输出。

11. **Linux 依赖外部 `zenity`。** 缺失时抛错而不是回退到终端输入；无 `--no-gui` 之类的降级路径。

12. **`spec` 之外的启动校验缺失。** `--readonly` 指向不存在或非目录的路径时，错误来自 `createReadonlyWorkspaceHandle` 内部，而非 `requireSafeDirectory`，错误信息与本地选择器路径不一致（后者会明确说"不是目录"/"不允许根目录"）。

13. **启动时 `mkdir` 与注册表读取是并发的**，但模型配置读取在之后串行执行；没有"配置损坏时给出修复指引"的路径，`parsePersistedConfig` 抛错会直接终止启动。

14. **G-04 启动对账只覆盖仍已注册的 workspace。** `workspaceResolver` 刻意不从 WAL 中恢复绝对路径；已取消注册、加载失败或移动后的项目不会被自动触碰。WAL/Recovery Ledger 没有跨进程 target lock，不能同时运行两个 Host 写同一 workspace。

15. **Rollback 与 Recovery report 没有 CLI 命令。** 环境变量只启用 Runtime policy；用户仍须经 Host API/SDK 请求单目标 rollback，`RecoveryLedger.exportMarkdown()` 也只有 Core 程序接口。

16. **Permission ceiling 与用户选择的生命周期不同。** CLI/environment ceiling 是启动边界，变更必须重启 Host；Host/SDK/Web 可以在 ceiling 内持久化用户 preset，无需重启，但只影响新 Run。项目 policy 只能按项目收紧；StartRun 没有 override。活动/恢复 Run 使用冻结 policy，不能热提升。Linux 仅探测 bwrap、Windows 无 backend，且没有 Host 网络代理；restricted mode 在这些平台会拒绝 `run_test`，不是透明回退。macOS backend 依赖 Apple 私有 Seatbelt 工具与 `system.sb`。

17. **当前 CLI 没有装配非 Patch 自动审批 answerer。** Host/project 规则若把普通 read/execute Tool 收紧为 `ask`，Runtime 会以 `approval_unavailable` fail-closed；Web/SDK 手工 approve/reject 只服务 Patch pending approval，不能代答一般 Tool ask。

18. **当前 CLI 没有独立 Host rule 配置源。** `PolicyEngine` 的 Host-rule 层供嵌入方注入和 Core 测试使用；标准组合根只从内置 preset 得到 Host 默认，再读取项目 `.tracegraph/policy.json` 的 ask/deny 收紧层。Web 设置页也不是 rule editor。

19. **G-15 不是可靠 Telemetry daemon。** `<dataDir>/telemetry.json` 只在启动时读取，修改后需重启；OTLP queue、错误计数和最后错误时间仅驻留当前进程。当前没有自动 retry/backoff、持久队列、完整 OTel SDK/processor/sampling/propagation，也尚未用真实外部 Collector 做集成验证。只有网络/超时与 HTTP `429/502/503/504` 批次留在内存队首，后续 flush 可能重复；`400` 等 non-retryable 失败及 HTTP 200 `partialSuccess` 拒收会计错并丢弃。200 响应正文最多读 64 KiB，Collector 文本不回显。关停 flush 只等待 5 秒，超时不保证 drain；status 只读且不参与恢复。

20. **G-21 没有 CLI/Web 的索引管理面。** 标准 `serve` 会装配本地或远端+本地 retrieval，并让 Runtime 每轮 recall，但不会自动爬取仓库、创建 Memory candidate、启动远端服务、展示索引健康或执行重建。远端只对严格的 availability failure 降级；认证/契约错误会让当前操作失败。默认 backend 是 BM25，不是向量 RAG。

21. **G-07 profile catalog 是编译期本地配置，不是插件或远程 registry。** flag/env 只能选择内置名字和数值 limits，不能新增 provider、role prompt 或 tool allowlist；修改 catalog 需要改代码并重启。G-08 已提供 durable Agent Team 协调事实，但默认 depth 1/parallel 2 与同步单 spawn 仍限制执行模型；不能据此宣称任意多轮 child 续聊、旧 worker 自动恢复或跨 Host 调度。

22. **G-17 配置不是任意第三方插件加载器。** 标准 catalog 精确只有 Artifact 与 Run-state 两个内置 id；`module` 是数据 key，不是 path/npm specifier。没有签名分发、依赖解析、恶意代码隔离、扩展 UI 或 active-Run HMR；修改配置后只能在所有 Run lease 释放时显式 reload。

23. **G-20 的 Git fence 不是通用并发锁或写入事务。** 它只在已有可用 Git baseline 的 Patch 审批进入写入前比较 commit/branch/status fingerprint；若 policy `allow` 的 Patch 检出漂移，Runtime 也会降级为新的手工审批。Git unavailable、非 Git 工作区、未注入 Git provider 的自定义 composition 和外部系统副作用不获得该保证。最终 `commit_patch` 仍只靠目标文件 `base_hash` 与 G-04 WAL 收口；动态调用、DI、路由、方法级和跨语言影响面不由 CodeGraph 推断。

---

## 14. 相关文档

- 模块 02（Runtime）：`maxTurns`、`permissionPolicyResolver`、`approvalAnswerer`、`codeGraph`、`retriever`、`telemetrySink`、`subagentRegistry`、Action WAL 与 rollback policy 注入项
- 模块 08（Memory）：准入、canonical JSONL、每轮 recall、global scope 与 Context provenance
- 模块 06（模型适配）：`ConfigurableModelAdapter.configure()` 的校验与 `publicConfig()`
- 模块 07（CodeGraph）：`createCodeGraphProvider()` 如何适配 `analyzeCodeGraph`
- 模块 09（Host/SDK）：`modelSettings` / `permissionSettings` / Project seams 与 Runtime-owned Telemetry status 的 Host 侧契约
- 模块 15（插件与扩展系统）：trusted catalog、六个 seam、idle-only reload 与 recovery v5
