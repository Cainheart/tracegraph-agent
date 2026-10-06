# 模块 09：Host 与 SDK 接口层

> 定位：单一本机 Host 拥有 Runtime/profile；Web 经 loopback HTTP/SSE，Desktop Main 与 CLI 经私有 UDS/Windows pipe HTTP adapter 使用同一组类型安全路由。
> 代码：`packages/api/src/run-session-controller.ts`、`packages/host/src/webserver/index.ts`、`packages/host/src/index.ts`（兼容导出）、`apps/desktop-host/src/`、`apps/desktop/src/`、`packages/workbench/src/`、`packages/sdk/src/index.ts`、`packages/sdk/src/protocol/`、`packages/sdk/src/client/`、`packages/sdk/src/server/`、对应测试
> 技术栈：Fastify 5 + `@fastify/cors` + Zod
> 最后核对：2026-10-03
> 实现状态：HOST-087/PAR-088/CLI-089/SET-090 的共享 owner/profile、私有连接、完整客户端路由与配置已有源码及窄验收；DESK-064 的 child/framed RPC 保留兼容，当前 Desktop 正式入口使用共享 Host。真实平台边界见第 11.12 节。

---

## 1. 进程模型

```75:83:packages/host/src/webserver/index.ts
export async function createTraceGraphHost(
  options: TraceGraphHostOptions,
): Promise<TraceGraphHost> {
  const now = options.now ?? (() => new Date());
  const token = options.capabilityToken ?? randomBytes(32).toString("base64url");
  const tokenTtlMs = options.tokenTtlMs ?? 8 * 60 * 60 * 1_000;
```

| 项 | 默认 |
|---|---|
| 监听地址 | 嵌入式 Host 默认 `127.0.0.1:4311`；共享产品 owner 未指定端口时用 `127.0.0.1:0`，实际地址来自私有 discovery（host 类型只允许 `127.0.0.1` \| `::1`） |
| Web 端 origin | `http://127.0.0.1:4310`、`http://localhost:4310` |
| 能力令牌 | 32 字节 base64url 随机 |
| 令牌 TTL | 8 小时 |
| 全局 `bodyLimit` | 256 KiB；`POST /api/runs` 与 `POST /api/chat/runs` 单独放宽到 8 MiB；G-18 raw upload route 为 6 MiB transport hard cap |
| `requestTimeout` | 30 s（只限制接收完整请求，不是 handler 执行 deadline） |

`listen()` 的 host 参数被**类型**限制为回环地址——想监听 `0.0.0.0` 必须改代码，不是改配置。Host 是**单进程、单用户、纯本地**的服务。当前正式装配是 [`startLocalHost()`](../../packages/host/src/local-host.ts)：先取得 profile、canonical data root 和 Session root 写入租约，再创建一份 Runtime；同一 Fastify app 同时服务私有 UDS/Windows pipe 和 loopback Web gateway。Desktop/CLI 的 [`ensureLocalHost()`](../../packages/host/src/local-host.ts) 发现已有 owner，缺失时用受支持的独立 Node 启动 detached worker，不随窗口或 CLI 退出而停止。

默认 profile 为 `~/.outlive/profiles/default`，显式 `profileRoot`/`--profile-root` 优先于 `OUTLIVE_PROFILE_ROOT`。旧 `~/.tracegraph` 数据不会被静默合并，需走显式迁移。[`local-profile.ts`](../../packages/host/src/local-profile.ts) 保存稳定 profile ID、data/session 根与版本；[`owner-lease.ts`](../../packages/host/src/owner-lease.ts) 对规范根建立跨 profile 写入所有者限制，拒绝两个 Runtime 共写。`close()` 仅断开客户端；显式 `stop()` / `host.stop` 才停止 owner、Run 和资源，关闭 SSE/模型请求后释放写入租约。不默认安装开机启动。

Desktop Main 与 CLI 使用 [`LocalHostConnectionSupervisor`](../../packages/host/src/local-connection-supervisor.ts) 管理连接。外部 CLI 重启、worker 崩溃或应用再次激活时，监控会验证当前 profile/build/owner nonce，并重新绑定私有连接；旧 generation 的延迟读取失效，三条流重新订阅。恢复只建立 owner，不自动 resume Run。握手和健康检查有独立短超时，恢复采用有界次数与退避，不能把无限启动循环当作修复。

显式停止会先持久化 [`owner-stop.json`](../../packages/host/src/local-owner-intent.ts)；普通启动/重连和新客户端均尊重该停止意图。用户显式 Start/Repair 才等待旧 owner 退出并清除停止标记。OS 终止不写这个标记，因而仍可安全恢复。`host.restart` 只在空闲时请求替换 owner，返回 `restart_requested` 只是请求回执，成功须再观察新 nonce 和配置生效；不会为了重启而自动取消活跃任务。

启用 logger 时还有一条 G-19 最终边界：Pino 每条 JSON line 在写 stream 前先解析成结构，再对动态 key/value 运行统一脱敏，最后重新序列化；解析不了的自定义行退回纯文本 `redactSecrets()`。因此已登记 opaque Key 即使含引号或反斜杠，也不会因 JSON escaping 绕过精确匹配。`authorization`、cookie 与 `api_key` 路径另有 Pino redact 配置。

`packages/host/src/dev.ts` 仍是小型嵌入式开发装配，不是三端共享产品入口。默认 `tracegraph serve` 使用共享 Host；显式旧 `--data-dir/--session-dir/...` serve 保留独立兼容装配并同样取得根写入租约，不能与共享 owner 争用数据。

若 composition 注入 `HostSessionController`，`createTraceGraphHost()` 会在注册路由/开始监听前先 `await sessions.recover()`。恢复先处理 Session tail，再对 composition 能从当前注册表解析出的 workspace 执行 G-04 Action 对账，最后标记其它无终态 Run；失败直接拒绝创建 Host。成功报告（含 reconciled/aborted/diverged action id）作为安全、结构化数据进入启动日志与 `/api/bootstrap.recovery`。

---

## 2. 四层防护

每个请求依次穿过四道闸门：

| 层 | 机制 | 位置 |
|---|---|---|
| 1 | 回环校验：`request.ip` 去 `::ffff:` 前缀后必须是 `127.0.0.1` 或 `::1` | 全局 preHandler |
| 2 | Origin 白名单：缺失或不在名单 → 403 | 全局 preHandler（**只对非 GET/HEAD**）、CORS 回调 |
| 3 | Bearer 令牌：TTL 检查 + `Bearer ` 前缀 + `timingSafeEqual` 常量时间比较 | 全局 preHandler |
| 4 | CORS：`credentials: false`，仅 `GET/POST/PATCH/DELETE/OPTIONS`，仅 3 个自定义头 | `app.register(cors)` |

私有连接先验证 discovery 文件的私有权限、profile ID/根、socket 路径和 boot nonce；UDS server 每个请求检查随机 `x-outlive-local-token`，成功后才进入同一 Fastify route/auth hooks。`isPrivateLocalRequest` 只绕过不适用于 UDS 的 loopback 地址检查，仍保留 bearer、Origin、command ID 与 replay 限制。原生项目路径、根解析、迁移和 stop 路由只允许已认证私有 socket，TCP 客户端即使持有 live bearer 也不能调用它们。Renderer 不获得两种真实令牌。[私有 fetch](../../packages/host/src/local-fetch.ts)、[鉴权与双端口测试](../../packages/host/src/local-host.test.ts)是当前依据。

```176:185:packages/host/src/webserver/index.ts
  app.addHook("preHandler", async (request) => {
    if (!request.url.startsWith("/api/") || request.url.startsWith("/api/bootstrap")) {
      return;
    }
    assertLoopback(request);
    assertBearer(request, token, expiresAtMs, now);
    if (request.method !== "GET" && request.method !== "HEAD") {
      assertOrigin(request, allowedOrigins);
    }
  });
```

**"所有写操作必须有 Origin"是本设计的核心防护**：它让浏览器之外的本地恶意页面无法用用户已登录的能力令牌发起跨站写请求（DNS rebinding 面）。`/health` 与 `/api/bootstrap` 不需要令牌，其余 `/api/*` 全部需要。

`/api/bootstrap` 只做回环 + Origin 校验并返回令牌本体与 G-01 startup recovery report，响应带 `cache-control: no-store`。

---

## 3. 路由表

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 无鉴权 |
| GET | `/api/bootstrap` | 回环 + Origin，无令牌 |
| GET | `/api/projects` | 只列 `visibleProjects` |
| POST | `/api/projects` | 需 `projectFactory`，否则 501 |
| POST | `/api/projects/open-local` | 需 `localProjectSelector`，否则 501 |
| POST | `/api/projects/:projectId/reveal` | 需 `projectRevealer` + `location.can_reveal`，否则 501/409 |
| POST | `/api/projects/:projectId/remove` | strict `command_id`；linked directory 仅撤销登记，managed storage 删除受管副本；同项目活动 Run 会阻止移除 |
| GET | `/api/model-config` | `cache-control: no-store` |
| POST | `/api/model-config` | 需 `modelSettings`，否则 501 |
| GET | `/api/permission-config` | Host-safe permission 快照：active preset、ceiling、available presets、source/lock；不返回 rules/path/token |
| POST | `/api/permission-config` | strict `command_id + preset_key`；只能选择 Host 广告且不高于 ceiling 的 preset，需 `permissionSettings` 否则 501 |
| GET | `/api/telemetry-status` | G-15 strict 只读 sink 健康快照；直接读取 Runtime（默认 noop/disabled/0），不返回 endpoint/header/credential/path/payload，无写路由 |
| GET | `/api/extensions` | G-17 trusted extension 状态；不返回 module path、配置路径或可执行内容 |
| POST | `/api/extensions/reload` | strict `command_id + extension_name + expected_config_digest?`；仅调用 Host-owned controller，活动 Run 时 409 |
| POST | `/api/extensions/commands/:name` | strict、有界 args 的扩展命令；path/body 名称必须一致并受 command-id 幂等保护 |
| GET | `/api/sessions?project_id=&q=&limit=&cursor=&view=roots|all` | scope 后列表/搜索/分页；默认 `roots`，避免 child Session 混入普通历史 |
| GET | `/api/sessions/:sessionId` | strict Session header/event-ref 详情 |
| PATCH | `/api/sessions/:sessionId` | 改名，先落 `session.title_changed` |
| DELETE | `/api/sessions/:sessionId` | 先落 `session.closed`，再软删到 Session trash |
| POST | `/api/sessions/:sessionId/resume` | interrupted Run 恢复；Patch 待审批重签 approval，Plan 待审批恢复原 revision |
| POST | `/api/replay` | G-23：`session_id + run_id + until_sequence` → canonical snapshot，并签发短时只读 replay capability |
| GET | `/api/replay/diff?session_id=&run_id=&from=&to=` | 仅 replay bearer；返回同一 Run 两个历史端点的结构化 projection diff |
| POST | `/api/runs` | 启动 Run |
| POST | `/api/chat/runs` | 启动聊天 Run（服务端强制隔离） |
| POST | `/api/attachments?...` | G-18 raw `application/octet-stream` staging；Host 绑定 project/chat/session scope，业务上限 5 MiB，transport hard cap 6 MiB |
| GET | `/api/runs/:runId` | 投影 |
| GET | `/api/runs/:runId/attachments/:attachmentId/content` | 仅 live capability；先验证 Projection relation，再返回 hash/size/MIME 一致的图片/PDF bytes；Replay 统一 403 |
| GET | `/api/runs/:parentRunId/subagents/:subagentId` | G-07 relation-scoped child Run 投影；重验父投影、project/session/run link 与 child `run.created` provenance，只读且 `private, no-store` |
| GET / POST | `/api/runs/:runId/team` | 读取 coordinator/root canonical Team / 以 user-bound command 创建 Team；普通 Run 的 GET 返回空 team |
| POST | `/api/runs/:runId/team/mailbox/send` | actor Run 关系与 sender 由 Host/Runtime 绑定；strict deliver input，Web 用户入口固定为 steer |
| POST | `/api/runs/:runId/team/mailbox/claim` | recipient-bound claim；客户端不能提交 `from/claimed_by/project/team` |
| POST | `/api/runs/:runId/team/tasks/write` | optimistic-version task create/claim/complete/block/cancel/reopen；Web 只开放用户 cancel |
| POST | `/api/runs/:runId/team/heartbeat` | member Run relation-scoped heartbeat；subagent identity 由 canonical link 派生 |
| POST | `/api/runs/:runId/team/sweep` | coordinator/root 显式 timeout sweep；deadline/当前时间不由客户端提交 |
| GET / POST | `/api/runs/:runId/todos` | 读取 canonical Todo / 用户 strict mutation；scope 与 actor 由 Host 注入 |
| POST | `/api/runs/:runId/input` | G-14 运行中输入：strict `command_id + input_id + kind + body`；Host 绑定 project/run/`actor:"user"`，返回 queued/duplicate receipt |
| POST | `/api/runs/:runId/plan/approve` | 批准当前 `plan_event_id`，同 Run 转 execute |
| POST | `/api/runs/:runId/approve` \| `/reject` \| `/stop` | 三个命令 |
| POST | `/api/runs/:runId/actions/:actionId/rollback` | 显式 Action rollback；wire body 只有 `command_id` / `force` |
| GET | `/api/artifacts/:artifactId?run_id=` | 工件 |
| GET | `/api/runs/:runId/events/stream` | canonical 事件流（持久） |
| GET | `/api/runs/:runId/live/stream` | 展示活动流（瞬时） |
| GET | `/api/runs/:runId/model-surface/stream` | 模型公开画面（瞬时，独立游标） |
| GET / POST | `/api/workbench/settings` | strict version/revision、分组 patch、字段来源/范围/生效时机与 pending restart；command ID 幂等 |
| GET | `/api/workbench/capabilities`、`/api/workbench/resources` | 可用性/缺配置/只读/策略拒绝；后台 Run、终端、预览、定时任务 |
| POST | `/api/workbench/model-test`、`/api/workbench/commands` | 有界模型连接测试和闭合命令 union；Git/worktree、PTY、预览、schedule、archive、诊断、清除 Key、取消 queued task、stop |
| GET / POST | `/api/workbench/models` | 已保存连接安全快照 / command ID 与 revision 保护的保存；不返回原始 Key |
| POST | `/api/workbench/models/:id/remove`、`/test` | CAS 移除 / 显式有界连接测试；测试结果不代表实际任务完成 |
| POST | `/api/workbench/models/:id/capability-tests` | confirmed、连接 revision、具体 model 和显式 text/tools/image/structured；生成夹具逐项至多一次请求，不执行工具 |
| GET | `/api/workbench/model-capability-tests/:commandId` | 原命令规范回执，只读核对；completed 的单项仍可 failed/unsupported/unknown，不重派发 |
| GET / POST | `/api/workbench/sessions/:id/options` | Session 的下一 Run 选项 / revision/CAS 更新；Host 验证模型与权限上限 |
| GET / POST | `/api/workbench/permission-grant` | 当前本地 Full 授权资格 / `confirmed:true` 的显式更改；管理员 ceiling 不可提升 |
| POST | `/api/workbench/projects/:projectId/files/list`、`/read` | bounded 相对路径目录/文本读取；路径在 strict body，仍受统一 auth/replay 限制 |
| POST | `/api/workbench/projects/:projectId/files/save`、`/reconcile` | policy/工作区协调/CAS 保存及原 command ID 对账；审批与 unknown 均不是保存成功 |
| GET / POST | `/api/workbench/runs/:runId/feedback` | 对当前 Run 的实际回答 Event 读取/写入本地点赞反馈；command ID 与 canonical 关系校验 |
| GET / POST | `/api/local/status`、`/api/local/projects/register`、`/api/local/projects/:projectId/root`、`/api/local/stop` | 仅私有已认证 socket；原生调用方显式授权路径，Renderer 仅持有项目 ID |
| POST / GET | `/api/local/migration/preview`、`/commit`、`/results/:operationId` | 仅私有已认证 socket；扫描、source 选择、busy 拒绝、备份/提交/重启与持久 receipt |

**501 是一个明确的契约**：相关 seam 未注入时，项目创建/选择/揭示/移除、模型/权限配置、扩展管理或 Session 控制返回 501，而不是静默失败。Telemetry status 不另设 Host seam：Host 直接读取 Runtime 拥有的 process-local 状态；Runtime 默认 Noop sink，因此未显式配置时自然返回 `noop / disabled / error_count:0`。

模型能力测试只在[控制器](../../packages/host/src/model-capability-control.ts)实际装配时提供 `models.capabilities.test/read`。请求 schema、回执和连接当前版本摘要采用[独立契约](../../packages/contracts/src/model-capability-tests.ts)。配置/凭据在派发前按原租约冻结；摘要只在 canonical receipt 完成后更新，摘要存储失败仍可按原 ID 读取回执，不自动重复请求。SDK 校验返回的 connection/model/revision/command 和完整所选项目，固定 Desktop 通道不接收任意 prompt、路径或秘密。Replay 不允许测试命令，回执端点不把历史视图提升为 live 权限。仅当前尚未 settle 的命令阻止闲时升级，历史未知用量不被当作未知文件写。协议、用量及安装边界见[验收记录](../validation/model-capability-tests/README.zh.md)。

Session 路由在 HTTP 边界重复检查 session id 与 project scope；列表默认 `view=roots`，先排除带 `parent_session_id` 的 child，再按 Host 可见项目过滤并分页，避免 child 污染普通历史以及 cursor/页大小侧信道泄漏其它项目。`view=all` 只供受信调用方检查完整 Session 树；Web 普通列表始终显式请求 roots。租约冲突返回脱敏 409，并写只含 operation/code/status/method/route 的 `session.operation_rejected` structured audit；Host 不记录可能含 lock path/PID/hostname 的底层错误，也不绕过 lease 向目标 Session 账本写冲突事件。

G-07 child 读取不接受客户端直接提交 child Run/Session/project scope。Host 先从 parent canonical Projection 找到精确 `subagent_id`，再加载该 link 指向的 child，并核对 parent run/session、child run/session、project、depth，以及 child 首条 `run.created` 中的 parent/subagent provenance；任何不一致都 fail-closed。该路由不会列出任意 child，也不提供写入、Resume 或消息入口；replay bearer 继续被统一只读 capability 规则拒绝访问 live child route，不能借历史视图换回 live authority。

G-08 Team 路由同样不信任 path 中的 Run 就是 coordinator/member authority。Host 先读取 canonical Projection 与 G-07 parent-child link，把 actor Run 映射到 root Team 和固定 `user|member` 身份，再调用 Runtime；request body 只保留 command id 与最小业务 input，没有 project/session/team/actor/from/owner/server time。所有 Team 写在 Replay capability 下统一 403。Heartbeat 与 sweep 都是显式请求；sweep 只使用 `team.created` 冻结的 timeout，`team.member_lost` 同一 Event 携带 `reopened_task_ids`，Host 不自动选新 owner。

G-18 上传端点 `POST /api/attachments` 不接受 JSON/base64 body：SDK 把 bytes 作为 `application/octet-stream` 发送，metadata 放在 strict query，写请求遇到 401 时直接失败，不自动 refresh 后重放；调用方须先恢复读取/核对回执，再由显式操作使用原 command id 和相同 bytes 重试。Host 从自身的项目注册表或隐藏 chat workspace 绑定 scope；若请求带 Session id，还要确认 Session 与目标 project 一致。公开 staging receipt 不含 project/session id。内容读取端点 `GET /api/runs/:runId/attachments/:attachmentId/content` 只允许当前 live bearer，并先从 `RunProjection.attachments` 证明该 attachment 与 Run 相关，再让 Runtime/Artifact Store 复核 project/run/MIME/bytes/hash；响应使用 `private, no-store`、`nosniff`、same-origin、sandbox CSP 与固定安全文件名。PDF 由 Web 下载，不嵌进 iframe。

Rollback 路由不接受 project id、workspace id 或 filesystem path。Host 先从 canonical Run projection 解析 project，再要求它仍在注册表，最后注入对应的 Host-owned `WorkspaceHandle`；Runtime 才执行默认关闭的 policy、WAL/binding/hash 检查。客户端的 `force:true` 因此既不能选择别的工作区，也不能绕过 after-hash。

G-23 replay bearer 不是客户端自报的 `replayMode`：Host 只保存随机 token 的 SHA-256 与 claims，claims 绑定 Session、Project、Run、进入时冻结的 head、当前 sequence、expiry 和该前缀可见 Artifact id。它只能 POST 同 scope/head 内的新回放点、GET diff 或读取当前前缀 Artifact；latest Run、三条 SSE 及全部领域写在统一 preHandler 返回 `403 replay_read_only`。每次步进会轮换 token，默认 TTL 10 分钟、同时最多 64 个；响应均 `private, no-store`。

---

## 4. 命令一致性：两道交叉校验

```722:737:packages/host/src/webserver/index.ts
function assertCommandId(request: FastifyRequest, commandId: string): void {
  const header = request.headers["x-tracegraph-command-id"];
  if (typeof header !== "string" || header !== commandId) {
    throw Object.assign(new Error("Command id header must match the command body"), {
      statusCode: 409,
    });
  }
}

function assertRunId(pathRunId: string, commandRunId: string): void {
  if (pathRunId !== commandRunId) {
    throw Object.assign(new Error("Run id path and command body do not match"), {
      statusCode: 409,
    });
  }
}
```

### 4.1 G-06 preset 是有界 wire 选择，sandbox/rules 仍是 Host 权限

当前 start payload 可带 strict `run_options`，或使用 Session 已保存选项，其中 `permission_preset` 只能选择 Host 当前 ceiling 内的内置预设；客户端仍不能提交 `sandboxMode`、approval policy、rules、path scope 或 token。CLI flag/environment 建立受管理的 ceiling；仅当本机默认/用户授权来源允许时，独立的显式 Full grant 才能请求新 owner 应用更高上限，管理员配置保持只读。选项冻结于 Run admission，活动 Run 不热切换；共享恢复重新校验当前 ceiling/项目规则，不能借旧审批扩大授权。

Run Projection 与 canonical SSE 会带 durable `permission` snapshot、`permission.configured` / `policy.evaluated` / `policy.denied`，以及 `sandbox_report` / `sandbox.*` lifecycle Event，供客户端观察“哪份策略作了什么决定、实际 enforcement 是什么”；这是证据面，不是规则编辑器。模型 provider `fetch` 也在 Host 进程内完成，当前不经过 child SandboxRunner 或网络代理。

审批面保持刻意分流：非 Patch policy `ask` 只能由 Runtime 的可信 Host `approvalAnswerer` 自动回答（默认 CLI 未注入时 fail-closed）；Patch `ask` 才会形成 pending approval，继续由 Web/SDK 的手工 `approve/reject` 命令处理；Plan approval 是第三条独立控制流，绑定最新 `plan_event_id`，不签发 Patch capability token。policy `allow`（包括未被规则收紧的 `full-write`）不会产生 approval request/grant/token。

`x-tracegraph-command-id` 头**必须**与 body 里的 `command_id` 相同，路径里的 `runId` **必须**与 body 里的 `run_id` 相同。两者都返回 409。SDK 侧自动保证（`#command()` 同时写两处），因此这层校验对正常客户端零成本，对构造型请求是硬拦。

Todo 路由同样只接收 `command_id + input`，不接收 project、actor 或 Ledger scope；Host 先由 Run Projection 解析已登记 project，再固定 `updated_by:"user"`。是否允许新写、是否为已落账命令的幂等重放，以及相同 id 不同 payload 的冲突，都由 Runtime 按 canonical Event 判断；Host 不做会遮挡 durable replay 的状态预判。

G-14 input 路由采用同一 authority 模式：浏览器只能提交 `command_id/input_id/kind/body`，不能提交 project、run body scope、actor、消费时间或 step。Host 从 path 和 canonical Projection 绑定 `run_id/project_id`，固定 `actor:"user"`，再调用 `submitUserInput()`；响应还会复验 input/run/kind/actor 身份。`message` 与 `approve_hint` 只进入 durable mailbox，后者是给下一模型安全点的提示，**不等于** Plan/Patch approval，也不会签发 capability。只读项目同样可以提交，因为该命令只追加 Run Ledger，不写 Workspace。

Runtime 的 command idempotency key 使用 hash namespace，原始 command/input payload digest 留在 wire 不可见的 `_internal_*` 字段；同输入换 command id 的 duplicate 会追加可折叠的 durable alias receipt，使改绑冲突在再次重启后仍可检测。SDK 若调用方未给 id 会生成新值；Web 因此在一次尚未确认的提交尝试内显式保留并复用两种 id，覆盖“Host 已提交、transport 丢响应”的 retry 窗口。

`kind:"cancel"` 是 G-14 的新取消入口：先落 `user.input_queued`，模型阶段可立即请求中断；工具阶段则等 Tool/WAL 的安全边界后落 `user.input_consumed` 与 canonical `run.cancelled`。提交响应只证明取消已排队，不能假定 Run 已终态。旧 `/stop` 与 SDK `stop()` 仍保留兼容，但新 Web 不再用它表达 G-14 中断语义。

---

## 5. Session 串行与 canonical Workspace 排队

[`RunSessionController`](../../packages/api/src/run-session-controller.ts) 绑定 Host-owned Workspace、Session scope 与 command fingerprint。当前共享 composition 选择 `admission:"workspace"`：同 Session 串行、同 canonical workspace 写任务排队、独立 workspace 在有界并发额度内执行。排队不取消活动 Run，切换或新建会话也不取消后台工作。默认未注入新 admission 的嵌入/旧兼容 Host 仍保留 API-061 的 `single` 行为。

- [`WorkspaceCoordinator`](../../packages/host/src/workspace-coordinator.ts) 通过 realpath 合并根目录别名；Run、Git mutation 和长期 PTY 共用写租约。当前 owned preview 始终执行源码只读与独立私有 cache/temp 沙箱，使用只读租约，不阻塞后续同工作区写 Run；外部登记 preview 不能限制其进程权限。显式只读操作可并行，同 Session 仍串行。见[预览实际验收](../validation/dev-readonly-preview/README.md)。
- 排队状态可通过 Host 资源/诊断面观察；`queue.cancel` 只取消尚未开始的 holder，不撤销 active writer。Run 到终态后释放租约，下一项才开始。
- `startCommands` 提供真正的启动幂等：

  同 `command_id` + 同 request fingerprint → 返回已有 canonical Projection；同 id 不同输入 → 409。指纹包含项目、Session、任务、模式、reasoning effort、conversation history 和已暂存 attachment ids。

---

## 6. 项目可见性与越权防护

Host 维护**两个 Map**：

| Map | 内容 | 用途 |
|---|---|---|
| `visibleProjects` | 仅注册项目 | `GET /api/projects` |
| `projects` | 注册项目 **+ chatProject** | 所有资源访问校验 |

每个读 Run / 工件 / 建流的路由都会做：

```786:795:packages/host/src/webserver/index.ts
function assertRegisteredProject(
  projectId: string,
  projects: ReadonlyMap<string, unknown>,
): void {
  if (!projects.has(projectId)) {
    throw Object.assign(new Error("Run is unavailable outside a registered project"), {
      statusCode: 404,
    });
  }
}
```

**项目注册表是能力边界**：Run 与工件的 project_id 必须在 Host 认为"自己管"的集合里，否则 404。Chat 工作区的 Run 因此可被访问（在 `projects` 里），但不会出现在项目列表中。

`/api/artifacts/:artifactId` 不信任客户端给的归属，而是**先从 `run_id` 反推 project**：

```436:443:packages/host/src/webserver/index.ts
    const projection = await options.runtime.getProjection(runId);
    assertRegisteredProject(projection.project_id, projects);
    const projectId = projection.project_id;
    const result = await options.runtime.getArtifact({
      artifactId: request.params.artifactId,
      runId,
      projectId,
    });
```

配合 Runtime 的六字段交叉校验（模块 02 §2），跨 Run 取工件在两层上都不可能。

Host 不会仅因项目是只读句柄就拒绝 execute Run 启动。`startRegisteredRun()` 只解析 Host 已登记项目并把 Host-owned `WorkspaceHandle` 传给 Runtime；因此只读项目仍可在 execute 模式读取、分析并给出最终答案。若模型随后请求写工具，Workspace capability 与 PolicyEngine hard constraint 会在 Tool/WAL/mutation 前拒绝。`mode` 决定 Plan/Execute 控制流，不是扩大或缩小 WorkspaceHandle authority 的替代品。

---

## 7. 聊天隔离由服务端强制

```369:374:packages/host/src/webserver/index.ts
    const wireInput = StartRunRequestSchema.parse({
      ...chatInput,
      project_id: options.chatProject.workspace.project_id,
      mode: "execute",
    });
```

`/api/chat/runs` 把 strict `StartChatRequest` 交给 API Controller；Controller 从 Host 注入的隐藏 chat Workspace **覆写** `project_id`，并固定 `mode: "execute"`，客户端无法指定项目或选择 plan。聊天永远落在专用隔离工作区；它的只读性来自 Host-owned chat Workspace capability，而不是借用 Plan Mode。这样普通对话可以正常回答并终态，又不能触碰用户代码——**不做客户端校验，直接改写**。

`chatProject` 的 id 与已注册项目冲突时 Host 启动就失败：

```91:96:packages/host/src/webserver/index.ts
  if (options.chatProject) {
    if (projects.has(options.chatProject.workspace.project_id)) {
      throw new Error("Chat workspace project id must be unique");
    }
    projects.set(options.chatProject.workspace.project_id, options.chatProject);
  }
```

---

## 8. 模型配置

| 路由 | 行为 |
|---|---|
| `GET /api/model-config` | `cache-control: no-store`；无 `modelSettings` 时返回未配置默认（`openai` / `openai-chat-completions` / `https://api.openai.com/v1` / `gpt-4.1-mini` / `has_key: false`） |
| `POST /api/model-config` | 校验后调 `configure()`，返回公开快照 |

POST 的字段约束：`provider` 枚举 7 项、`protocol` 枚举 2 项、`base_url` 必须是 URL 且 ≤ **500** 字符、`model` 去空格后 1..**200**、`api_key` 可选 8..**2 000**。`api_key` 是 write-only 输入；省略时由装配层决定是否复用同一提供商的现有引用。

响应由 `.strict()` 的 `PublicModelConfigResponseSchema` 再校验，字段只有 `provider/protocol/configured/base_url/model/has_key/credential?`。其中 `credential` 只能包含 `name/backend/writable/last_updated_at?`，且 `has_key` 必须与其是否存在一致。任何意外的 `api_key` 或 secret value 字段都会使 Host 返回前校验失败；SDK 在 GET/POST 两条路径上还会用同一 schema 复验。

因此**响应里永远不含 `api_key`**：密钥从 write-only POST/固定 IPC 进入 Host，不回流到前端。当前 backend/configure/clear/轮换 owner 位于 [`host-composition.ts`](../../packages/host/src/composition/host-composition.ts)，三端共享同一状态。共享 Host 不把进程环境模型配置当作另一个来源；旧显式 serve 的环境只读优先级仍保留。清除 Key 保留 provider/protocol/base_url/model draft，恢复 Key 不需要重新填写地址；模型配置与 credential reference 按 Run 绑定，轮换不热改进行中的后续轮次。

### 8.0 CFG-098：当前配置继承与安全历史切片

[ConversationControl](../../packages/host/src/conversation-control.ts) 对新 dispatch 按显式请求、会话 `overrides`、Profile 内项目默认值、当前全局模型/推理与权限选择解析。省略不再自动补入 `default` 推理或 `workspace-write`；旧完整 Session 记录仍作为显式覆盖读取。`options` 是解析后的展示值，`overrides` 与 `fields.source` 说明实际覆盖；全局/项目变化只影响仍在继承的下一任务。`full-write` 仍受固定 ceiling、有效 consent 与项目收紧规则校验。已准入任务的模型、凭据与策略不会热切换。

新增认证路由及 typed SDK 方法：

| 路由 | 方法与实际结果 |
|---|---|
| `GET /api/workbench/settings/history` | `getWorkbenchSettingsHistory()`：从 canonical command receipts 读取最多 200 个最新 Profile revision，`has_more` 不代表旧日志被删除 |
| `POST /api/workbench/settings/restore` | `restoreWorkbenchSettings()`：校验 `expected_revision`，恢复 `target_revision` 为新 revision；回执含 `preserved_sections` |
| `GET/POST /api/workbench/projects/:id/defaults` | `getProjectRunDefaults()` / `updateProjectRunDefaults()`：Profile-owned 项目默认覆盖与 CAS；不会写仓库配置文件 |
| `POST /api/workbench/sessions/:id/options/reset` | `resetSessionRunOptions()`：CAS 删除选定或全部会话覆盖，重新继承 |

`updateSessionRunOptions` 兼容旧完整 `options`，或接收新的 partial `overrides`，两者只能选一个。[契约](../../packages/contracts/src/settings-history.ts)、[路由](../../packages/host/src/workbench-routes.ts)、[SDK](../../packages/sdk/src/index.ts) 是当前事实源。

[Workbench settings history](../../packages/host/src/settings-history.ts) 记录安全 checkpoint 以及成功 update/restore；工具 literal env/args 和敏感文字不进入新历史/命令回执。恢复不恢复凭据、Full grant 或仓库策略；历史脱敏字段所属分组保留当前值并明示于回执。当前只交付 Profile 设置历史恢复，项目/会话历史恢复、客户端外观继承和所有配置安全空闲自动重启仍待后续切片。现有旧日志保持原样。[真实 Host/provider 与 HTTP auth/replay 测试](../../packages/host/src/configuration-inheritance-history.test.ts) 已通过；新设置视觉交互和新安装包 GUI 验收不能从该测试推断。

### 8.1 权限配置

Host 的 `permissionSettings` seam 只有 `get()` 与 `configure({command_id,preset_key})`。GET/POST 返回同一 `PermissionSettingsResponseSchema`：active preset、其固定 sandbox/approval pair、policy digest、Host ceiling、最多三个 available built-in presets、source/locked/lock reason。完整 preset tool/path scope、Host/project rules、配置文件路径和 approval token 从结构上不在公开响应里。

POST 与其它 command 一样要求 Bearer、allowed Origin、`x-tracegraph-command-id === body.command_id`。同一 command id + 同一 preset 幂等；同 id 换 preset 返回 409。该绑定表只在当前 Host 进程内，durable 用户选择由 CLI composition 的私有原子配置负责。Host seam 返回不符合 strict schema、泄漏 rule/path 等字段时，路由在出站前 fail-closed。

### 8.2 G-15 Telemetry 状态与共享设置

`GET /api/telemetry-status` 直接调用 `options.runtime.getTelemetryStatus()`，避免 Host composition 维护第二份会漂移的状态。它受与其它 `/api/*` 相同的 loopback + Bearer 防护并设置 `cache-control: no-store`；Runtime 默认 Noop sink 时返回：

```json
{
  "schema_version": "tracegraph.telemetry-status.v1",
  "sink": "noop",
  "state": "disabled",
  "error_count": 0
}
```

Runtime 返回值还必须通过 `.strict()` 的 `TelemetryStatusSchema`：sink 仅 `noop|memory|otlp_http|custom`，state 仅 `disabled|active|degraded`，错误计数非负，最后错误时间可选且必须是 ISO datetime。endpoint、header、credential/authorization、配置路径、pending payload 任一意外字段都会使路由 fail-closed；Host 没有 `/api/telemetry-config`，也没有该 status 路径的 POST/PUT。

该响应只是当前进程健康快照：`error_count` 与 `last_error_at` 重启会重置，不进入 Session/Run Projection，不用于恢复。共享 `/api/workbench/settings` 的 telemetry group 另提供 enabled、endpoint 与 secret reference 配置，声明为 restart 生效；authorization 值和待发送 payload 仍不返回客户端，关闭 telemetry 时不解析缺失的 credential reference。旧显式 serve 保留 `<dataDir>/telemetry.json`/environment 配置；缺旧路由不会被客户端伪装成 noop 健康。

### 8.3 G-17 扩展控制面：Host 只接收名字，不接收代码

`GET /api/extensions` 返回 strict 状态、generation、registration count 与有界错误；`POST /api/extensions/reload` 只接受扩展名和可选旧 config digest，真正的 replacement 由 Host-owned trusted catalog 解析。HTTP body、query 和 path 都没有 module/file/npm 字段，因此浏览器不能借 reload 让 Host 执行仓库代码。

`POST /api/extensions/commands/:name` 的 path/body name 必须一致，args 最多 64 个且每项最多 2,000 字符。reload/command 都把 `command_id` 同时绑定 header/body，并用 fingerprint 防止同 id 换参数；并发重复请求共享同一个 Promise，失败会移除内存幂等项供显式重试。Replay bearer 在统一 authority gate 上只能读取历史 snapshot，不能调用这些 live 管理路由。

---

### 8.4 COMP-102：独立原生应用授权后端切片

[ComputerControl](../../packages/host/src/computer-control.ts)与文件权限分开：指定应用 once/always 人工授权、全局独占输入租约、精确前台窗口复核，以及外部输入/锁屏/撤销/任务取消后暂停并要求人工恢复。Outlive 和系统权限/脚本授权窗口禁止成为操作目标。模型 DTO 不能提供已确认标志、执行路径或批准自己的权限。授权和回执私有持久化，Host 重启不恢复输入租约、不重放历史输入。

[原生助手边界](../../packages/host/src/native-computer.ts)从固定安装/source 路径加载匹配 SHA、平台和架构的编译程序，不接受环境变量、项目或模型的 executable 路径。Mac 使用 AX、限定窗口 ScreenCaptureKit 和 Quartz；Windows 提供 UIA/Win32 助手源码，原生构建与操作验收仍未知。操作回执 `posted` 只表示输入发出；中断是 `unknown`，业务结果必须再次观察，对账读取 canonical 回执而不重发输入。Plan 只观察。

当前窄测试 20 Host/2 契约/2 交付负例通过；真实 Mac 助手编译与只读状态通过，但当前 Accessibility/输入监控授权为 false，因此**没有真实用户应用输入成功证据**。三端路由、人工 GUI、Runtime 工具与安装旅程以根任务最后证据为准。详见[后端切片与验证边界](../validation/comp-102/backend-slice.md)。

## 9. 三条 SSE 通道

三条流的骨架相同（hijack → 手写响应头 → 订阅 → 补发 → 心跳），但语义分工明确。

### 9.1 canonical 事件流（`/events/stream`）

```620:623:packages/host/src/webserver/index.ts
    const unsubscribe = options.runtime.subscribe(request.params.runId, (event) => {
      if (!live || write === undefined) buffered.push(event);
      else write(event);
    });
```

**先订阅、再读投影、再接流**，用一个小缓冲消除"Run 已启动但流还没接上"的竞态窗口。补发阶段用 `projection.timeline`（也就是账本重放），随后 `live = true` 并冲刷缓冲。去重靠 `event.sequence <= lastSequence`。

这一条流**不因终态而关闭**，客户端可以一直挂着等新事件（对已完成的 Run 则只有心跳）。心跳间隔 15 s。响应头包含 `x-accel-buffering: no`，避免反向代理缓冲住 SSE。

### 9.2 展示活动流（`/live/stream`）

```456:462:packages/host/src/webserver/index.ts
    // Subscribe before the projection/access check. The small runtime buffer
    // below then closes the start-run -> attach-stream race without making a
    // second durable event ledger or replaying provider output.
    const unsubscribe = options.runtime.subscribeLive(request.params.runId, (activity) => {
      if (!live || write === undefined) buffered.push(activity);
      else write(activity);
    });
```

与其他两条的关键差别：**终态活动或当前 `plan.ready` 边界过线后立即 `close()`**，避免浏览器/SDK 永远停在"运行中"等心跳。Plan 判断还会核对 activity 的 Event id 等于 Projection 当前 `pending_plan.plan_event_id`，历史 revision 不会错误关掉新连接：

```500:504:packages/host/src/webserver/index.ts
      // A live feed belongs to one Run. Once its real terminal activity has
      // crossed the wire there will be no later activity for this stream, so
      // close it instead of leaving the browser/SDK in an apparent "running"
      // state waiting for heartbeats forever.
      if (isCurrentPlanBoundary || isTerminalLiveWaitBoundary(safeActivity)) close();
```

SDK 对终态活动可立即结束；对 `plan.ready` 则不会在 yield 时武断结束，因为它可能是 execute 阶段从旧 cursor 补发的历史活动。即使响应恰在该帧后 EOF，SDK 还会读取 durable Projection，只有 `status === awaiting_plan_approval` 且 `pending_plan.plan_event_id` 精确等于该活动 Event id 时才停止重连；否则从已推进的 sequence 继续接收 `plan.approved`、Tool 与终态活动。Projection 核验失败按瞬时断线退避重试，不把网络 EOF 冒充 Plan 状态。

取消提交本身不会关闭任何 SSE。Web 保持 canonical/live 消费，直到真正收到/读取 `run.cancelled`；这避免把“cancel 已排队”误显示成“已经安全停止”，也让等待写工具越过 WAL/rename/Receipt 边界的过程仍可观察。

### 9.3 模型公开画面（`/model-surface/stream`）

```525:529:packages/host/src/webserver/index.ts
  /**
   * A separate, volatile model surface. It uses a cursor unrelated to the
   * JSONL ledger sequence so a high-frequency public text stream can neither
   * reorder nor suppress durable runtime events.
   */
```

**独立游标是本模块最重要的架构决策之一。** 模型的高频公开文本（`public_reason` / `final_answer` 的增量）如果与账本 `sequence` 共用编号，就会污染持久事件的顺序语义。用 `after_cursor` 隔离后，瞬时流的频率与持久账本完全解耦。

这条流同时订阅两个源：`subscribeModelSurface`（数据）与 `subscribe`（用于感知终态或 `plan.ready` 等待边界）：

```547:552:packages/host/src/webserver/index.ts
    const unsubscribeRun = options.runtime.subscribe(request.params.runId, (event) => {
      if (event.type === "plan.ready" || event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled" || event.type === "run.interrupted" || event.type === "action.diverged") {
        terminalReached = true;
        if (live) close();
      }
    });
```

若接流时 Run 已是终态或 `awaiting_plan_approval`，则补发完历史画面后立刻关闭。批准后 Web 从批准返回 Projection 的 `last_sequence` 重新接 live/canonical 消费，避免历史 `plan.ready` 再次把新执行阶段当作等待边界。

---

## 10. 错误映射

```132:165:packages/host/src/webserver/index.ts
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      void reply.status(400).send({
        error: "invalid_request",
        message: "Request did not match the TraceGraph contract",
        issues: error.issues,
      });
      return;
    }
    if (error instanceof RuntimeCommandError) {
      const statusCode = error.code === "run_not_found"
        ? 404
        : error.code.includes("capability")
          ? 403
          : 409;
```

| 来源 | 状态码 | 响应体 |
|---|---|---|
| `ZodError` | 400 | `invalid_request` + `issues`（原始校验问题） |
| `RuntimeCommandError` | `run_not_found`→404，含 `capability`→403，其余→409 | `error` 码 + 消息 |
| Session Store/Controller error | not found→404，lease/version/corrupt→409，unsafe path→400 | 固定安全文案；同时写脱敏 Host audit |
| 带 `statusCode` 的错误 | 原样 | 4xx 回消息，≥500 换成固定文案 |
| 其他 | 500 | `internal_error` + 固定文案 |

未知 5xx 不泄露内部消息（固定 Host failure 文案）。受控 Workbench/模型/迁移错误保留稳定 code、status 与安全 message，例如 `credential_storage_failed`、`model_config_readonly`、`migration_busy`；不返回凭据或底层目录。SSE 中途出错用 `sendSseError()` 发送 `event: error` 帧。

---

## 11. SDK 客户端

`packages/sdk/src/index.ts` 是本地 Host HTTP/SSE 客户端；网络层使用平台 `fetch`，响应通过 `@tracegraph/contracts` 的 Zod schema 校验。私有 `@tracegraph/sdk/protocol` 子路径提供 API-060 的 transport-neutral 消息契约，不代表对外发布独立 SDK。

| 能力 | 实现 |
|---|---|
| 默认地址 | `http://127.0.0.1:4311` |
| Node 侧 Origin | 默认注入 `origin: http://127.0.0.1:4310`；浏览器不注入（由浏览器自管）；`nodeOrigin: false` 关闭 |
| 令牌刷新 | live GET/HEAD 的 401 →单飞 bootstrap→重试一次；写请求直接失败、不自动重发 |
| 并发去重 | `#tokenRefresh` Promise 单飞，多个 401 只触发一次 bootstrap |
| 命令 ID | `crypto.randomUUID()`，回退 `cmd_<ts>_<rand>`；同时写入 body 与 `x-tracegraph-command-id` |
| 响应校验 | **全部**经 Zod parse（`RunProjectionSchema` 等） |
| Project API | `listProjects()`、`createProject()`、`openLocalProject()`、`revealProject()`、`removeProject()`；remove body 只含 `command_id` |
| Session API | `list/get/rename/delete/resumeSession` 均用 canonical Session schema 双向校验；`listSessions()` 默认 `view:"roots"`，显式 `all` 才返回 child Session |
| G-07 child ledger | `getSubagent(parentRunId, subagentId)` 只调用 relation-scoped route，并再次以 `RunProjectionSchema` 校验；不暴露任意 child lookup 或写控制面 |
| G-08 Agent Team | `getTeam/createTeam/sendTeamMailbox/claimTeamMailbox/writeTeamTask/heartbeatTeam/sweepLostTeamMembers` 全部使用 strict request/result schema；调用方不能提交 project/team/actor/from/owner/time，Replay bearer 不升级为写 authority |
| Plan / Todo | `approvePlan(runId,{plan_event_id,command_id?})`、`getTodos(runId)`、`writeTodo(runId,{input,command_id?})` 均用 canonical schema；scope/actor 不对调用方开放 |
| G-14 steering | `submitUserInput(runId,{kind,body,input_id?,command_id?})` 自动生成两个 id，并用 `SubmitUserInputRequest/ResultSchema` 双向校验；不开放 project/actor/step |
| Action rollback | `rollbackAction(runId, actionId, {command_id?, force?})` 调 canonical route；不暴露 project/workspace authority |
| Permission | `getPermissionConfig()` / `configurePermissionPreset({preset_key,command_id?})` 使用 canonical bounded schema；没有设置 rule/path/sandbox/approval/token 的方法 |
| Telemetry | `getTelemetryStatus()` strict 只读健康快照；共享配置经 `updateWorkbenchSettings()` 的 telemetry group，restart 生效；不回显授权值或 payload |
| Extensions | `listExtensions()` / `reloadExtension()` / `runExtensionCommand()` 对 G-17 strict schema 双向校验；写入不自动重试，显式重试保持原 command ID；客户端不能提交 module path |
| Replay | `createReplay()` 切换到 Host 签发的只读 bearer，`getReplayDiff()` 自动补绑定的 session/run scope，`exitReplay()` 才恢复保留的 live bearer；replay 401 直接失败，禁止 bootstrap 自动升级 authority |
| Sandbox | 解析 Projection/Event 中的 `sandbox_report`；mode 只能随 Host 广告的 G-06 preset 间接选择，不能逐 Run 覆盖 |
| bootstrap recovery | 可选 `SessionRecoveryReportSchema`，旧 Host 无该字段仍可兼容 |
| Workbench | `get/updateWorkbenchSettings()`、`getCapabilities()`、`getWorkbenchResources()`、`testModel()`、`workbenchCommand()` 使用 canonical closed schemas |
| 保存的模型连接 | `getModelConnections()`、`saveModelConnection()`、`removeModelConnection()`、`testModelConnection()`；保存/移除返回 registry snapshot，revision/CAS，原始 Key 只写 |
| 会话选项与本地授权 | `get/updateSessionRunOptions()`、`get/setPermissionGrant()`；模型、mode、reasoning、bounded preset 在新 Run 冻结；Full grant 不能覆盖管理员 ceiling |
| 项目文件 | `listProjectFiles()`、`readProjectFile()`、`saveProjectFile()`、`reconcileProjectFileSave()`；相对路径、有界读取、CAS/policy/工作区协调及持久回执 |
| 项目文件上下文 | `startRun({file_contexts:[{path,expected_sha256}]})`；最多五份项目 UTF-8 文件，Host 准入冻结，客户端不传正文；普通 chat 不接受该字段 |
| 回答反馈 | `getAnswerFeedback()`、`setAnswerFeedback()`；绑定当前 Run 的实际 answer Event，`like/dislike/clear` 只保存本地事实 |

项目文件上下文经 [`ConversationControl.prepare()`](../../packages/host/src/conversation-control.ts)
绑定本次 Session/模型/策略，再调用 [`readContext()`](../../packages/host/src/project-files-feedback.ts)
按该策略读取固定项目内普通文件。路径排除、symlink/多硬链接拒绝和 O_NOFOLLOW/固定 inode
边界与文件编辑共用；每份 64 KiB、总计 128 KiB，严格 UTF-8 且不接受 NUL。
非 allow 策略直接拒绝，不签发交互审批；哈希变化返回 `file_context_revision_conflict`，
创建 Run 和模型派发前即失败。`files.context` 仅在真实 reader 已装配时广告 available，
generic control 缺 reader 时为 unavailable，路径权限仍在准入时校验。

[`Core context seam`](../../packages/core/src/domains/runtime/project-file-context.ts) 再核对
可信 snapshot 的 project/path/原始字节 SHA/长度与请求引用一致，随后写脱敏的
`project_file_context` text Artifact。规范 `artifact.stored` 只保存 path、原始 SHA/长度、
locator 与实际 Artifact ref，不保存文件正文。模型 Observation 的 source event ID 是该
真实存储 Event；Context Manifest 使用同一 ref、tool source 和 untrusted trust。摘要片段
有界，更多内容由当前 Run 的 `read_artifact` 分页读取。显式恢复读取旧 Artifact，不重新
读取已变化的工作区文件；缺失或损坏的 Artifact fail closed。详见
[Runtime tests](../../packages/core/src/domains/runtime/runtime.project-file-context.test.ts) 和
[Host tests](../../packages/host/src/project-file-context.test.ts)。final8 的 [Web attempt 024](../validation/current-workbench-recovery/attempt024-final8-web/report.json)
与外部 CLI 上下文已通过，安装后 Desktop 的
[attempt 025](../validation/current-workbench-recovery/attempt025-final8-installed-desktop/report.json)
也通过实际上下文、SIGKILL 恢复、stop/Repair 与 fresh Main，清理完成；六条已完成
Run 事实与模型请求数保持不变。历史 final7 的
[attempt 021](../validation/current-workbench-recovery/attempt021-final-installed-desktop/report.json)
恢复超时原因未知，
[attempt 023](../validation/current-workbench-recovery/attempt023-final7-native-lifecycle-diagnostic/report.json)
观察了实际恢复/stop/Repair/fresh Main，但清理阶段 CDP detach 失败；不能用
业务子步骤替代整轮结果或用旧字节证明 final8。

```467:479:packages/sdk/src/index.ts
function isBrowserRuntime(): boolean {
  return typeof globalThis.window !== "undefined" && typeof globalThis.document !== "undefined";
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("nodeOrigin must use http or https");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("nodeOrigin must be an origin without credentials, path, query, or fragment");
  }
  return url.origin;
}
```

`normalizeOrigin` 比 Host 的校验更严：拒绝带凭据、带路径、带查询或片段的 origin。

经 `bootstrap()` 建立 live authority 的客户端，在每个 authenticated POST/PATCH/DELETE **发出前**先执行同一个 single-flight GET bootstrap（10 秒 AbortSignal deadline），再提交一次原命令。这解决 owner 重启保留同 gateway、浏览器没有先读新 owner 而缓存旧 bearer 的首次写入问题；不是失败后的写请求自动重放。显式注入 token 且未 bootstrap 的嵌入式 fixed-authority client 保持兼容。pending bootstrap 受 Replay generation 保护，不会用迟到 live token 覆盖只读 bearer。

`TraceGraphMutationPreflightError` 带 `code:mutation_preflight_failed`、`admission:rejected`、`commandDispatched:false`，证明只读检查失败时领域命令尚未发送。`TraceGraphHttpError.admission:rejected` 仅用于 Host `401 + capability_required/invalid/expired` 的规范认证拒绝；普通网络失败、无标记 401 和其它状态不能据此断言未接纳。Supervisor 不把已知拒绝改成 unknown；Main/preload 仅保留闭合 code/status/admission，原始 body/message/path 不跨 IPC。UI 的恢复动作只更新连接/读取，原 command 的重试仍需用户明确触发。

### 11.1 SSE 解析

```488:516:packages/sdk/src/index.ts
export async function* parseSseData(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string, void, void> {
```

自研解析器（与 Core 的模型侧 SSE 解析器是两份独立实现）：按 `\n\n` 分帧、`\r\n` 归一化为 `\n`、只取 `data:` 开头的行、多行 `data` 用 `\n` 连接，`finally` 中释放 reader 锁。

### 11.2 自动重连

三条流结构一致：指数退避 `250 ms → ×2 → 上限 2 000 ms`，`reconnect: false` 可关闭；收到数据后**重置**退避；`signal.aborted` 时静默返回；401 只重试一次。游标用 `Math.max` 推进，保证只增不减。

`streamEvents` / `streamLiveActivities` / `streamModelSurface` 都是 `AsyncGenerator`，调用方需要自己保存 `afterSequence` / `afterCursor` 才能跨进程续传——SDK 不做持久化。

### 11.3 Replay authority 与普通自动刷新分离

普通 live GET/HEAD 读取仍可在 401 后 bootstrap 一次；写请求不自动刷新并重发。replay capability 明确走 fixed-authority 分支，过期或被步进轮换后直接返回错误。否则共享的自动刷新代码会把只读 token 换成 live token，等价于权限提升。SDK 在内存中保留进入回放前的 live token，但回放期间所有请求头使用 replay token；因此遗漏的 UI 写入口仍会被 Host 403，而不是只依赖按钮 `disabled`。

### 11.4 API-060 共享内部协议

`packages/sdk/src/protocol/index.ts` 定义独立于 HTTP/SSE 的 `tracegraph.client-protocol.v2` envelope：Run command、Run/Session query、Memory/Experience control command/query、reply/error、cancel 与事件消息。domain payload 复用 `@tracegraph/contracts` schema。API-061 已把 Run/Session 应用编排提取到 `@tracegraph/api`；CLIENT-068 增加 `MemoryExperienceController`，由 Web REST 与 Desktop framed RPC 共用。旧 DESK-064/CLIENT-068 framed dispatcher 与确定性 fixtures 继续作为兼容 seam；当前 Desktop Main 将具名 IPC 映射为 typed `TraceGraphClient` 方法，经私有 HTTP adapter 到同一 Host routes。CLI 当前同样使用私有 adapter，Web 使用 loopback HTTP/SSE；完整 Workbench DTO 在 `@tracegraph/contracts` 定义，不假定所有新能力都必须塞进旧 framed envelope。

协议事件明确区分 `ledger`、`activity` 与 `model_surface`：第一类沿用持久 Run 序号；后两类仍是独立游标的瞬时投影，不能当作 Ledger event 回放。所有 fixture 位于同一 `packages/sdk/src/protocol/fixtures.ts`；CLI、Web 与 Desktop conformance checks 都从 `@tracegraph/sdk/protocol` 导入。未知消息、query/command discriminator 与非法 lifecycle action 会被拒绝；私有客户端按精确 protocol version 握手，v1 客户端不会与 v2 Desktop Host 混用。

### 11.5 API-061 Run/Session Controller 与本地 Web transport

`packages/api/src/run-session-controller.ts` 拥有 Run start/read、Session list/read/resume 的应用级校验与协调：从 Host 当前注册表解析 Workspace，保证 Session/Project scope，对相同 `command_id` 做幂等 replay/conflict 判断，并处理可注入的 Session/Workspace admission。它可脱离 Fastify 直接调用，API 包只依赖 `@tracegraph/contracts`。

`packages/host/src/webserver/index.ts` 保留 Fastify 路由、loopback/Origin/bearer/replay capability 校验、command-id header 校验、HTTP error/cache 语义和 SSE。Run/Session routes 调用 `RunSessionController`；Memory/Experience routes 调用 `MemoryExperienceController`；Session rename/delete 和其它 Settings、项目、扩展、MCP/LSP、Team、Artifact 与 stream routes 仍走 Host seams。Host 保留 HTTP authority 与 transport 语义，两个 Controller 不依赖 Fastify。`packages/host/src/index.ts` 提供 HTTP Host、共享 local owner/connect、profile/migration 与 composition 的公共导出，保留旧包入口。

### 11.6 API-062 私有 framed RPC transport

`packages/sdk/src/transport/` 定义 4 字节 unsigned big-endian payload length + UTF-8 JSON frame，默认单帧最多 8 MiB；decoder 增量处理 partial/coalesced reads，并在 dispatch 前校验长度、UTF-8、协议 schema 与版本。`@tracegraph/sdk/client` 通过 `request_id` 关联有限数量的请求、接收事件并发送 cancel；`@tracegraph/sdk/server` 将 command/query 交给注入 handler，使用协作式 AbortSignal 和 event writer。两侧串行写入并等待 WHATWG WritableStream 背压，有界队列溢出时返回稳定 transport 错误。

Transport cancel 只终止指定 RPC handler 的协作式等待，不是 Run stop command，也不能撤销已经接纳的领域操作。SDK server 本身不启动子进程、不监听网络端口、不实现身份认证，也不绑定 API Controller。API-062 完成时尚无具体应用 binding；之后 DESK-064 在 `apps/desktop-host` 将该 seam 与 API Controller 相连。CLI-063 继续使用现有 Host HTTP/SSE 客户端。

### 11.7 CLI-063 Run/Session client slice

`apps/cli/src/run-session-command.ts` 增加 `run start|get|events` 与 `sessions list|get`。命令在访问 Host 前校验参数与共享 protocol schema，随后用 `TraceGraphClient` 访问已运行 Host；Host 的 HTTP route 仍调用同一个 `RunSessionController`，因此不额外创建 Runtime/Controller。成功结果写成 schema 校验后的 protocol JSON Lines，诊断只写 stderr。`run events` 首先读 canonical Run projection timeline，可选 `--follow` 从末尾序号订阅 canonical SSE；每条持久 event 都保留原 event id 与 sequence，并放入 `ledger` envelope。

CLI 单测验证 stdout 纯净、无效输入不 bootstrap、事件 envelope 与 follow cursor；Host-backed E2E 从 CLI 发起 Run，并将 CLI 输出逐条与同 Host 的 SDK SSE event 对照。该项只增加 Run/Session CLI 表面，没有把 CLI 迁至 API-062 framed RPC。

### 11.8 DESK-064 child/framed RPC：保留的兼容 seam

[`apps/desktop-host/src/host-process.ts`](../../apps/desktop-host/src/host-process.ts) 与 legacy worker 保留独立 Node child、framed RPC、EOF/版本错配/崩溃恢复的兼容测试。UX-086 已为该 seam 增加 `RunInteractionController`、chat、Session resume/rename/delete、Approval/Plan、Todo、Artifact 和 input 固定操作；旧“仅四种方法”的描述不再适用于当前源码。

独立 Node 解析位于 [`node-executable.ts`](../../packages/host/src/composition/node-executable.ts)：验证 absolute realpath、受支持版本、非 Electron 与可执行身份，再用白名单环境启动。缺支持 Node 时明确失败；不放宽 Sandbox scope，也不转发 `NODE_OPTIONS` 或任意模型环境。真实 Electron binary/Node 在同一 Seatbelt fixture 下的[失败对照](../validation/ui-086-workbench-ux/attempts/desktop-tests-failed/electron-process-oracle.json)保留。

该 child 的 EOF 关停语义只属于兼容 launcher；当前正式 Desktop 不为每个窗口启动和销毁这份 Runtime。

### 11.9 当前 Electron shell 与共享 Workbench

[`main.ts`](../../apps/desktop/src/main.ts) 以共享 connection supervisor 发现、恢复并绑定 owner；本地 Renderer 使用 `loadFile()`，开启 sandbox/contextIsolation，关闭 Node integration，校验主 frame、拒绝任意导航/窗口权限。[`preload.cts`](../../apps/desktop/src/preload.cts) 和 [`bridge-contract.ts`](../../apps/desktop/src/bridge-contract.ts) 只暴露具名且双向 schema 校验的方法。Main/Renderer 不监听 TCP；独立 Host 的 loopback gateway 服务同一 Runtime，Renderer CSP 仍为 `connect-src 'none'`。

[`desktop-sdk.ts`](../../apps/desktop/src/desktop-sdk.ts) 覆盖共享 Workbench port，包括设置/模型测试/权限、项目/Session/Run、Attachment、Approval/Plan/Todo、Artifact、input/cancel、Memory/Experience、Team/subagent、Replay/rollback、usage/telemetry/扩展/MCP/LSP 与闭合 developer/schedule commands。当前能力来自 Host capability snapshot；离线、未配置、只读、policy denied 与真正不支持分开呈现，不能把缺配置伪装成成功。

三条 stream 使用 [`stream-bridge.ts`](../../apps/desktop/src/stream-bridge.ts) 的固定 open/read/close pull bridge，将私有 HTTP 上的 canonical、activity、model-surface SSE 传给 Renderer。每次 read 只推进对应迭代器，不以 500ms Run.get polling 代替流；断开订阅只 detach，不取消 Run。Main 再次过滤 `thinking_snapshot`，三种游标保留各自语义。Preview 仅构造 deterministic demo adapter，不启动 live owner。

SDK `parseSseData` 在 abort 或消费者提前 return 时主动取消 response、移除 listener 并释放 reader lock，不能只检查 aborted 标志后留下空闲 socket。真实私有 UDS 负例与修后回归见 [Desktop 退出验证](../validation/desktop-quit/README.md)。Main 在窗口接受关闭后的 `will-quit` 才 detach；取消未保存编辑的退出保留原窗口与连接。最终 `app.quit` 安排到下一事件循环轮，避免同一原生退出事务内的 promise 重入被忽略。不取消 Run 或停止独立 Host。

连接状态来自 [`host-connection.ts`](../../packages/contracts/src/host-connection.ts)，包含 `state/generation/profile_id/owner_nonce` 及闭合安全 code，不包含 token/socket/绝对路径。`getCapabilities()` 连接失败会抛出 typed error，不能合成“未安装/unsupported”的 capability；真实 backend 缺失仍由已连接 Host 的能力清单解释。Main 在 IPC 边界将连接错误封装成受控结构，preload 解包后保留 code，避免 Electron 丢弃自定义 Error 属性。

| 连接 code | 操作含义 |
| --- | --- |
| `host_stopped` | 已显式停止，普通重连、wake 和已有 Main 的窗口重开不清除标记；完全退出后用户新启动应用，或显式 Start/Repair 才能启动 |
| `host_offline` / `host_reconnecting` / `host_recovering` | 暂时不可达或正在恢复；读取视图可刷新，不重复领域写入 |
| `host_read_stale` | 读取跨 owner generation 或认证失效，丢弃原数据后重新读取 |
| `host_write_outcome_unknown` | 命令结果丢失；先按原 command ID 查询/对账，不能声称副作用失败或成功 |
| `host_replay_stale` | Replay 保留原只读 authority；显式 exitReplay 后才绑定新 live owner |
| `host_upgrade_required` / `host_profile_invalid` | build/profile 身份无法兼容或验证，fail closed，不自动终止另一 owner |
| `host_recovery_exhausted` | 自动恢复预算已用尽；需要显式修复，而非无限拉起进程 |

每次 owner 替换建立新 `DesktopStreamManager(generation)`，旧 handles 关闭，晚到 packet/读取不得刷新新视图。CLI 的 [`supervisedLocalHost()`](../../packages/host/src/local-connection-client.ts) 同样保留持久 ledger sequence，新 owner 的 activity/model-surface cursor 从零重建；订阅自身不持久化游标，也不取消任务。

自动恢复预算只在 ensure 拉起/等待 owner 时暂记一次。完成私有 profile/build
验证及 bind 后，成功首次启动，或已确认仍为同一 PID 的 live/计划重连，仅退回
本次成功的计数；之前失败启动和不同 PID 的崩溃恢复计数继续保留。不会每次成功
都清零；原有稳定连接窗口、显式 Repair 和耗尽上限不变。该计数修复有
[`local-connection-supervisor.test.ts`](../../packages/host/src/local-connection-supervisor.test.ts)
的先失败负例与回归，不被用作 attempt 021 实际超时的已证实解释。

Desktop `app.whenReady` 的新 Main 启动是可信用户启动意图：supervisor 完成普通
`initialize()` 后，只有 safe snapshot 为 `stopped` 才执行一次显式 `repair()`。
`activate` 与已运行 Main 的窗口重开仍只 refresh/createWindow，不清除停止标记。
离线、配置损坏、版本不兼容或 Replay 失败不走此启动例外；原 Replay 只读权限
不因恢复而升级。该 Main 装配语义由
[`main-connection.test.ts`](../../apps/desktop/src/main-connection.test.ts)验证，不改变
共享 supervisor 或普通 CLI 命令的停止边界。

### 11.10 原生项目、文件、凭据与迁移 bridge

Main 的原生 picker 生成路径，再用仅私有 socket 可用的 `native.registerProject()` 提交显式 access；Renderer 只接收安全 `ProjectSummary` 和 ID。当前注册源是共享 composition 的 `LocalProjectRegistry`，不再另建一个 Desktop profile 注册表。项目文件打开由 Main 解析 Host-bound root、验证 realpath/普通文件/containment 后交给系统应用；linked 项目移除只注销 metadata，worktree 删除成功后也会同步注销对应 metadata。

模型 Key 经固定 IPC write-only 到共享 Host `CredentialStore`；配置只保存引用。默认 macOS platform store 可读既有同 service Keychain refs，其他平台私有文件 backend 仍是 plaintext-at-rest，不等同硬件密钥库。隔离验收显式使用临时 private-file fixture，没有读写用户真实 Keychain。

当前已接入 [`conversation-routes.ts`](../../packages/host/src/conversation-routes.ts) 的四个模型连接方法、两个 Session 选项方法和两个本地授权方法，以及 [`project-files-feedback-routes.ts`](../../packages/host/src/project-files-feedback-routes.ts) 的六个文件/反馈方法。文件保存先核对相对路径、symlink/containment、策略和 expected SHA；`awaiting_approval` 要求用户用原 command ID/正文和签发 approval 明确确认，`unknown` 必须经 reconcile，均不能作为写入完成。Main 的 `copyText()` 只供显式复制操作，限制大小并确认自身写入结果，不向 Renderer 开放剪贴板读取。

迁移先 native picker 选择来源，预览只向 Renderer返回 source ID、label、相对路径/hash/bytes/冲突；commit 只能选择已预览 source ID。活动 Run、queued task、终端或 owned preview 存在时返回 `migration_busy`，要求先显式停止资源。成功流程停止 owner、保留原 source、备份目标和原格式、选择单源/quarantine 冲突、提交后重启；Main detach旧连接并重新 bootstrap。failed/unknown 保留 operation ID，查询持久 receipt 后才能决定重试，不能将传输错误算作成功。[迁移源码](../../packages/host/src/profile-migration.ts)、[迁移测试](../../packages/host/src/profile-migration.test.ts)。

### 11.11 Memory/Experience 与配置生效边界

Web、Desktop 和 CLI 现在经同一 Host route/`MemoryExperienceController`，scope 从当前共享注册表派生，不接受 renderer owner/actor。控制面审核不自行开启 Recall；默认 Memory/Experience recall 为 false，启用时还要求明确 project IDs。恢复继续重验 policy、credential、approval 和 Workspace authority。

设置使用 [`local-workbench.ts`](../../packages/contracts/src/local-workbench.ts) 的 version/revision/metadata，保存至 profile `workbench-settings.json`。general/appearance 立即生效；model reasoning 和 developer 并发设置影响新 Run；tools/telemetry/Memory 声明 restart 生效并在新 composition 真正应用，`pending_restart` 只在重启后清空。保存 Key、连接测试通过和 Run 业务完成是三个不同结果。[配置 owner](../../packages/host/src/composition/host-composition.ts)、[Workbench control](../../packages/host/src/workbench-control.ts)。

### 11.12 当前验证与平台边界

[`local-host.test.ts`](../../packages/host/src/local-host.test.ts) 使用真实构建产物、临时 profile 和 fake provider，验证 UDS/TCP 同源、并发 ensure 单 owner、不同 profile 共 data-root 拒绝、同 workspace queued→started/独立 workspace 并行、detach后 Run 继续、TCP 原生路由拒绝、busy迁移/备份/新 nonce，以及 stop 关闭三条 TCP SSE和 held model 后才能再启动 writer。配置重启/禁用工具、clear Key draft、MCP setup rollback、注销不删文件和排队取消也有窄 oracle。

[`terminal-job-control.test.ts`](../../packages/host/src/terminal-job-control.test.ts) 的真实 macOS PTY 验证 Ctrl-Z/jobs/fg/Ctrl-C、工作区写入与越界拒绝、正常关闭后独立 background job PID 消失，以及 Host SIGKILL 后 guardian 生命周期管道清理。这是观察到的 PTY 子任务清理，不承诺双重 fork/setsid 脱离终端后的全部进程隔离。[`recovery-policy.test.ts`](../../packages/host/src/composition/recovery-policy.test.ts) 验证活动 Run 冻结、降低 ceiling 后旧 Run 无法恢复、恢复后项目收紧拒绝审批且文件不变；[`local-policy.test.ts`](../../packages/host/src/local-policy.test.ts) 验证 authenticated UDS 的真实策略投影。

当前真实 OS 验收运行于 macOS；Linux 归档安装 smoke 与旧测试记录不等价于新增 PTY/UDS/完整 GUI 的 Linux 验收。Windows pipe 的实现契约不等价于实际 Windows 运行结果；Linux/Windows 原生 Sandbox backend、签名/公证/自动更新与独立非维护者从零安装仍须各自验证。已完成的源码、模拟测试和维护者环境真实 GUI 旅程不能代替外部发布验收。

当前连接恢复新增验收为 [`local-connection-owner.e2e.test.ts`](../../packages/host/src/local-connection-owner.e2e.test.ts) 的真实 Node worker/私有通道：外部 restart 后同 profile/新 nonce/共享配置可读，显式 stop 后新客户端不复活，SIGKILL 时两个客户端恢复到同一 owner，旧 Run 标为 interrupted 且 provider 不再调用。窄测试另验证 wake、generation、Replay 保持只读与 mutation 单次提交，记录在[本轮连接验证](../validation/current-workbench-recovery/host-connection-verification.md)。这些源码/targeted dist 检查尚不等于新安装包 GUI 已通过；完整 Main/preload/Renderer 恢复旅程由本轮最终验收另行记录。

---

## 12. 已知缺口

1. **live bearer 轮换与 replay authority 分离。** 8 小时 live token 到期后，allowed loopback/bootstrap 会轮换到新 token；SDK 只对 live GET/HEAD 做 401→bootstrap→一次 retry，写请求必须显式检查原命令回执后再决定重试。未到期 token 不轮换，避免另一窗口失效。只读 replay token 不经 bootstrap 升级。UDS discovery token 独立于 HTTP bearer，不能交给 Renderer。

2. **批准请求同步续跑，但没有 application-level handler deadline。** `approve` 在返回前会同步续跑：

```440:441:packages/core/src/domains/runtime/runtime.ts
    if (!state.stopped) await this.#continueRun(state);
    return this.getProjection(state.runId);
```

因此一次“批准”的 HTTP 时长包含后续全部模型调用与工具执行，直到下一个待批补丁或终态。Fastify 的 `requestTimeout: 30_000` 只限制服务端接收完整请求，并不限制 handler 执行；当前也没有配置 `handlerTimeout`，所以慢模型或长工具链可能让命令连接长时间保持打开。若客户端、代理或调用方自行超时，Runtime 工作仍可能已经推进，调用方必须重新读取 canonical Projection，不能把连接失败解释成自动撤销。

3. **重启后不会自动续跑普通非终态工作。** G-01 启动扫描会把旧 Run 明确落成 `run.interrupted`，因此不会再留下“账本非终态但 Host 毫无表示”的隐式状态；待审批 Patch 可用新 approval 恢复，待审批 Plan 可恢复原 revision 并继续等待。其它阶段只能打开只读恢复视图，重新启动任务需要用户作出新决定。

4. **`events/stream` 不在终态关闭。** 与 `live` / `model-surface` 两条流行为不一致。每个挂着的 canonical 流都持有一个账本订阅与一个 15 s 心跳定时器；前端若忘记断开，连接与定时器会累积。

5. **SSE 无背压处理。** `response.write(...)` 的返回值被忽略，慢客户端会让 Node 的写缓冲持续增长，Host 内存被单个客户端拖高。

6. **令牌没有项目粒度。** `assertRegisteredProject` 校验的是"Host 是否管理这个项目"，与令牌无关。任何拿到令牌的本地进程可操作全部已注册项目，没有按项目授权或审计主体区分。

7. **请求体有两档硬上限。** 全局 `bodyLimit` 是 256 KiB；允许携带 contract-bounded `conversation_history` 的 `POST /api/runs` 与 `POST /api/chat/runs` 单独放宽到 8 MiB。超过相应路由上限的请求会失败，而不是被截断或分片；契约仍没有为历史记录提供分页或增量提交入口。

8. **Origin 错误信息不区分"缺失"与"不允许"**（都是"Origin is required and must be allowed"）。自定义端口的 Web 端要接入必须显式扩 `allowedOrigins`，而报错不会告诉持有者"你的 origin 是 X，白名单是 Y"。

9. **Chat Run 在项目列表中不可见。** 它存在于 `projects`（所以能访问），但不在 `visibleProjects`（所以列不出来）。只由 `GET /api/projects` 驱动界面的客户端会出现"有 Run 但没有归属项目"的状态。

10. **`parseSseData` 与 Core 的模型侧 SSE 解析器是两份重复实现。** 两侧都各自处理 `\n\n` 分帧、`data:` 提取与 `\r\n` 归一化，规则若有一侧演进（例如支持注释行、`retry:` 字段或分包续传）就会漂移。

11. **丢失游标即丢失历史。** SDK 不持久化 `afterSequence` / `afterCursor`。客户端重启后只能从 0 开始重放（canonical 流可以，两条瞬时流则只能拿到运行时缓冲里还在的部分）。

12. **接收请求的 `requestTimeout: 30_000`、全局 256 KiB `bodyLimit` 与 Run 启动路由的 8 MiB override 都是硬编码常量**，不可通过 `TraceGraphHostOptions` 配置；其中 `requestTimeout` 不是 handler deadline。

13. **Rollback 保持受控策略。** SDK/CLI 与 Desktop adapter 调用同一目标 Action；`rollback.write` 按启动策略投影，默认 `policy-denied`。启用后仍为单目标，linked 工作区需 Host force 策略与显式确认，且需要 quiescent 和 WAL/hash/root binding。共享 UI 入口以实际组件与能力状态为准。WorkspaceCoordinator 协调本 Host 写者，但不锁外部编辑器或另一个产品的写入。Recovery Markdown 没有独立导出路由。

14. **Permission 设置不是 per-Run override 或 policy editor。** CLI/env ceiling 是 Host 启动边界，改变它仍需重启；用户 preset 选择可经 Host/SDK/Web 保存，但只影响随后创建的 Run，不能热改本进程活动 Run。共享 Host 恢复前按当前 ceiling、选择预设、项目规则和 trusted extension 规则重算 policy；digest 不同返回 `resume_policy_changed`，要求新 Run。恢复后审批再次校验；Core legacy 恢复保留冻结 policy 的兼容语义。客户端不能提交 rule/path/sandbox/approval/token，Host 响应也不公开完整策略。当前没有远程 policy negotiation/RBAC、Linux bwrap/Windows backend 或 Host 模型网络代理；Projection 徽标不能补足这些缺口。

15. **旧 stop 与 G-14 cancel 暂时并存。** `/stop` 是同步兼容命令；`POST /input {kind:"cancel"}` 才具有 durable queued/consumed 与安全边界语义。新客户端应使用后者，但删除旧接口会破坏已有 SDK/调用方，因此当前不能把两者当作完全相同的 receipt 流程。

16. **Telemetry status 不是交付确认或恢复数据。** 它只报告当前 Host 进程里的 sink kind/state/error count/last error；重启会清零进程内错误状态。共享 settings 可保存 exporter 配置并在重启生效，但不能证明外部 Collector 已经持久接收；授权值只在服务端解析，Telemetry 失败不改变 canonical Run。

17. **G-08 Team 控制面仍是单 Host、关系绑定且大体只读的产品面。** G-07 child ledger 读取继续依赖父投影和 child `run.created` provenance，普通 Session 列表默认隐藏 child；没有 Session 树编辑、child Resume、浏览器 send/interrupt 或任意 Run-id 查询。Team 路由增加 roster/mailbox/task board read、用户 steer/cancel 与 trusted heartbeat/sweep，但 `spawn_subagent` 仍在父 Tool call 内等待 child 终态，也没有跨 Host consensus、自动 worker 重启/重派或通用非阻塞父循环。

18. **G-17 API 不是插件商店。** Host 只能管理 composition 已安装的 trusted catalog；没有上传、npm/path 安装、签名校验、依赖解析或扩展 UI。命令幂等表也只在当前 Host 进程内，不是跨 Host 共识。
19. **API-061 只完成首个 Controller 切片。** Run start/read 与 Session list/read/resume 已由 `@tracegraph/api` 承载，Host 仍提供本地 HTTP/SSE transport；其它 route family 仍留在 Host。
20. **Desktop 的当前实现与发布验收分开。** 共享 owner/typed bridge/三条 SSE 和 Workbench 操作已接入；受 Host capabilities 与 policy 限制。打包归档、维护者 GUI/模拟旅程、签名/更新及独立外部用户验收是不同证据层，不能互相代替；平台边界见 §11.12。

---

## 13. 相关文档

- 模块 02（Runtime）：Run 与 Session 恢复方法如何映射到 Host 路由
- 模块 05（证据链）：`toWireEvent` 与 `WireSessionEvent` 的转换规则
- 模块 06（模型适配）：`modelSettings.configure()` 的校验与 `publicConfig()`
- 模块 10（Web）：三条 SSE 流在界面上的分工
- 模块 11（CLI）：`modelSettings`、项目 seams 与 G-15 sink/config 的真实装配；Host status 直接读取 Runtime
- 模块 15（插件与扩展系统）：trusted catalog、idle-only reload、Run lease 与 recovery v5
- 模块 16（Agent Team）：Team route、actor binding、optimistic task version 与 heartbeat/sweep 边界


## 14. 当前共享 owner 的版本升级边界（2026-10-05）

[local-host.ts](../../packages/host/src/local-host.ts) 校验私有 discovery 的 Profile/root/PID/nonce，并从经过验证的本机 runtime manifest 取得 `product_build_id`。当前支持 `outlive.local-upgrade.v1` 的 owner 可被新安装包在安全空闲点接替；Main 与内置 CLI 复用同一个 `ensureLocalHost()` 路径，Web 继续连接同 gateway 与 Runtime。源码模式单独指定 build ID 不获得安装包替换权威。已绑定旧 build 的 supervisor 不会反向替换其它 build；规范 retirement 记录阻止自动回到已退役源 build。

[LocalOwnerUpgrade](../../packages/host/src/local-host-upgrade.ts) 只接受私有认证 socket 的固定 `prepare` DTO：命令、Profile、预期 owner nonce 和 source/target build ID，不接受 renderer/model 路径、PID kill 或任意 RPC。旧 owner 先同步 seal mutation/Run 准入、暂停 scheduler/Memory/视觉清理和工作区 producer，再检查实际在途 handler、工作区 claims、Run/Goal/审批、工具/WAL/命令未结算事实、浏览器标签页、电脑输入租约与后台资源。繁忙或未知时重开准入、恢复 producer 并保留进程；不会取消工作来制造空闲。

两个客户端同时进入的私有 prepare 属于串行生命周期检查，不计为业务 write；第二个客户端只观察相同目标的准备回执，不重发事务。其它已准入 HTTP handler 在 socket abort 后仍保持 active，只有 handler 产生响应才释放计数。已完成的 `models.capabilities.test` 严格验证原命令与 DTO 后保留结果；缺 Token 用量和已终止的只读 unknown 测试不冒充项目写入未知。真实网络、回执投影与 controller `pending` 仍阻断升级。

准备与完整资源退役分别写入规范 `owner-upgrade-events`。prepared 不等于升级成功；客户端须验证 retired 回执、原 lease/discovery 退出和停止标记，才启动自身已核验的 bundled Node/worker，并验证目标 build、新 nonce 与同 Profile。重连、升级和 Web token preflight 都不重提任何旧 Run/写入。显式 `owner-stop.json` 优先，自动升级不会清除它。

[隔离验证](../validation/idle-local-host-upgrade/README.md) 的五个窄测试文件共 28 项通过，包含真实 detached 子进程接替、两客户端单 owner、完整 Run 时间线/配置字节保持、真实 provider 请求时间边界、断连 handler、活跃任务/未知效果、Replay、已退役版本和停止意图。测试 runtime 使用开发 Node 和严格临时 manifest，不是正式安装包验收。当前最终新包 GUI、Windows 原生及签名升级由整合发布验收另行记录。

没有固定升级协议的已运行旧 owner 不能被新代码安全追注入。此时 `local_host_upgrade_required` 保留旧进程，并指导先完成或明确停止旧工作、退出旧应用、通过其 Stop Host 操作退役后再启动新包。缺失/损坏/超界历史、prepared-only 回执、清理失败、waiting Memory job 与活跃资源保持阻断，不能据 GET health 或空列表猜测安全。
