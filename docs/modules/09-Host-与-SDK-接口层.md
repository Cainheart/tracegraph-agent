# 模块 09：Host 与 SDK 接口层

> 定位：把 Runtime 暴露成本地 HTTP + SSE 服务，并给 Web/CLI 一个类型安全的客户端。
> 代码：`packages/host/src/index.ts`、`packages/host/src/dev.ts`、`packages/sdk/src/index.ts`、对应测试
> 技术栈：Fastify 5 + `@fastify/cors` + Zod
> 最后核对：2026-09-19
> 实现状态：**已验证**（`packages/host/src/index.test.ts`、`packages/sdk/src/index.test.ts`）

---

## 1. 进程模型

```75:83:packages/host/src/index.ts
export async function createTraceGraphHost(
  options: TraceGraphHostOptions,
): Promise<TraceGraphHost> {
  const now = options.now ?? (() => new Date());
  const token = options.capabilityToken ?? randomBytes(32).toString("base64url");
  const tokenTtlMs = options.tokenTtlMs ?? 8 * 60 * 60 * 1_000;
```

| 项 | 默认 |
|---|---|
| 监听地址 | `127.0.0.1:4311`（host 类型只允许 `127.0.0.1` \| `::1`） |
| Web 端 origin | `http://127.0.0.1:4310`、`http://localhost:4310` |
| 能力令牌 | 32 字节 base64url 随机 |
| 令牌 TTL | 8 小时 |
| 全局 `bodyLimit` | 256 KiB；`POST /api/runs` 与 `POST /api/chat/runs` 单独放宽到 8 MiB；G-18 raw upload route 为 6 MiB transport hard cap |
| `requestTimeout` | 30 s（只限制接收完整请求，不是 handler 执行 deadline） |

`listen()` 的 host 参数被**类型**限制为回环地址——想监听 `0.0.0.0` 必须改代码，不是改配置。Host 是**单进程、单用户、纯本地**的服务。

启用 logger 时还有一条 G-19 最终边界：Pino 每条 JSON line 在写 stream 前先解析成结构，再对动态 key/value 运行统一脱敏，最后重新序列化；解析不了的自定义行退回纯文本 `redactSecrets()`。因此已登记 opaque Key 即使含引号或反斜杠，也不会因 JSON escaping 绕过精确匹配。`authorization`、cookie 与 `api_key` 路径另有 Pino redact 配置。

`dev.ts` 是一个小型开发装配：只读句柄指向 `process.cwd()`，数据目录 `.tracegraph`，默认模型（`DeterministicFakeModel`），开启了 logger。

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

```176:185:packages/host/src/index.ts
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

**501 是一个明确的契约**：相关 seam 未注入时，项目创建/选择/揭示/移除、模型/权限配置、扩展管理或 Session 控制返回 501，而不是静默失败。Telemetry status 不另设 Host seam：Host 直接读取 Runtime 拥有的 process-local 状态；Runtime 默认 Noop sink，因此未显式配置时自然返回 `noop / disabled / error_count:0`。

Session 路由在 HTTP 边界重复检查 session id 与 project scope；列表默认 `view=roots`，先排除带 `parent_session_id` 的 child，再按 Host 可见项目过滤并分页，避免 child 污染普通历史以及 cursor/页大小侧信道泄漏其它项目。`view=all` 只供受信调用方检查完整 Session 树；Web 普通列表始终显式请求 roots。租约冲突返回脱敏 409，并写只含 operation/code/status/method/route 的 `session.operation_rejected` structured audit；Host 不记录可能含 lock path/PID/hostname 的底层错误，也不绕过 lease 向目标 Session 账本写冲突事件。

G-07 child 读取不接受客户端直接提交 child Run/Session/project scope。Host 先从 parent canonical Projection 找到精确 `subagent_id`，再加载该 link 指向的 child，并核对 parent run/session、child run/session、project、depth，以及 child 首条 `run.created` 中的 parent/subagent provenance；任何不一致都 fail-closed。该路由不会列出任意 child，也不提供写入、Resume 或消息入口；replay bearer 继续被统一只读 capability 规则拒绝访问 live child route，不能借历史视图换回 live authority。

G-08 Team 路由同样不信任 path 中的 Run 就是 coordinator/member authority。Host 先读取 canonical Projection 与 G-07 parent-child link，把 actor Run 映射到 root Team 和固定 `user|member` 身份，再调用 Runtime；request body 只保留 command id 与最小业务 input，没有 project/session/team/actor/from/owner/server time。所有 Team 写在 Replay capability 下统一 403。Heartbeat 与 sweep 都是显式请求；sweep 只使用 `team.created` 冻结的 timeout，`team.member_lost` 同一 Event 携带 `reopened_task_ids`，Host 不自动选新 owner。

G-18 上传端点 `POST /api/attachments` 不接受 JSON/base64 body：SDK 把 bytes 作为 `application/octet-stream` 发送，metadata 放在 strict query，并复用同一个 command id 做 401 refresh 后的原 body 重放。Host 从自身的项目注册表或隐藏 chat workspace 绑定 scope；若请求带 Session id，还要确认 Session 与目标 project 一致。公开 staging receipt 不含 project/session id。内容读取端点 `GET /api/runs/:runId/attachments/:attachmentId/content` 只允许当前 live bearer，并先从 `RunProjection.attachments` 证明该 attachment 与 Run 相关，再让 Runtime/Artifact Store 复核 project/run/MIME/bytes/hash；响应使用 `private, no-store`、`nosniff`、same-origin、sandbox CSP 与固定安全文件名。PDF 由 Web 下载，不嵌进 iframe。

Rollback 路由不接受 project id、workspace id 或 filesystem path。Host 先从 canonical Run projection 解析 project，再要求它仍在注册表，最后注入对应的 Host-owned `WorkspaceHandle`；Runtime 才执行默认关闭的 policy、WAL/binding/hash 检查。客户端的 `force:true` 因此既不能选择别的工作区，也不能绕过 after-hash。

G-23 replay bearer 不是客户端自报的 `replayMode`：Host 只保存随机 token 的 SHA-256 与 claims，claims 绑定 Session、Project、Run、进入时冻结的 head、当前 sequence、expiry 和该前缀可见 Artifact id。它只能 POST 同 scope/head 内的新回放点、GET diff 或读取当前前缀 Artifact；latest Run、三条 SSE 及全部领域写在统一 preHandler 返回 `403 replay_read_only`。每次步进会轮换 token，默认 TTL 10 分钟、同时最多 64 个；响应均 `private, no-store`。

---

## 4. 命令一致性：两道交叉校验

```722:737:packages/host/src/index.ts
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

`StartRunRequestSchema`、`StartChatRequestSchema` 与 SDK 的 start payload 都没有 permission preset、`sandboxMode`、approval policy、rule、path scope 或 token 字段。CLI flag/environment 在 Host 启动时建立不可热提升的 ceiling；`POST /api/permission-config` 只是让用户从 Host 返回的 `available_presets` 中选一个 key，并由 composition 持久化。选择只影响之后创建的 Run；活动 Run 与恢复 Run 使用已冻结的 `EffectivePermissionPolicy`。由于 schema strict，浏览器不能靠额外字段拆开 preset、提交 custom policy 或把 ceiling 提高到 `full-write`。

Run Projection 与 canonical SSE 会带 durable `permission` snapshot、`permission.configured` / `policy.evaluated` / `policy.denied`，以及 `sandbox_report` / `sandbox.*` lifecycle Event，供客户端观察“哪份策略作了什么决定、实际 enforcement 是什么”；这是证据面，不是规则编辑器。模型 provider `fetch` 也在 Host 进程内完成，当前不经过 child SandboxRunner 或网络代理。

审批面保持刻意分流：非 Patch policy `ask` 只能由 Runtime 的可信 Host `approvalAnswerer` 自动回答（默认 CLI 未注入时 fail-closed）；Patch `ask` 才会形成 pending approval，继续由 Web/SDK 的手工 `approve/reject` 命令处理；Plan approval 是第三条独立控制流，绑定最新 `plan_event_id`，不签发 Patch capability token。policy `allow`（包括未被规则收紧的 `full-write`）不会产生 approval request/grant/token。

`x-tracegraph-command-id` 头**必须**与 body 里的 `command_id` 相同，路径里的 `runId` **必须**与 body 里的 `run_id` 相同。两者都返回 409。SDK 侧自动保证（`#command()` 同时写两处），因此这层校验对正常客户端零成本，对构造型请求是硬拦。

Todo 路由同样只接收 `command_id + input`，不接收 project、actor 或 Ledger scope；Host 先由 Run Projection 解析已登记 project，再固定 `updated_by:"user"`。是否允许新写、是否为已落账命令的幂等重放，以及相同 id 不同 payload 的冲突，都由 Runtime 按 canonical Event 判断；Host 不做会遮挡 durable replay 的状态预判。

G-14 input 路由采用同一 authority 模式：浏览器只能提交 `command_id/input_id/kind/body`，不能提交 project、run body scope、actor、消费时间或 step。Host 从 path 和 canonical Projection 绑定 `run_id/project_id`，固定 `actor:"user"`，再调用 `submitUserInput()`；响应还会复验 input/run/kind/actor 身份。`message` 与 `approve_hint` 只进入 durable mailbox，后者是给下一模型安全点的提示，**不等于** Plan/Patch approval，也不会签发 capability。只读项目同样可以提交，因为该命令只追加 Run Ledger，不写 Workspace。

Runtime 的 command idempotency key 使用 hash namespace，原始 command/input payload digest 留在 wire 不可见的 `_internal_*` 字段；同输入换 command id 的 duplicate 会追加可折叠的 durable alias receipt，使改绑冲突在再次重启后仍可检测。SDK 若调用方未给 id 会生成新值；Web 因此在一次尚未确认的提交尝试内显式保留并复用两种 id，覆盖“Host 已提交、transport 丢响应”的 retry 窗口。

`kind:"cancel"` 是 G-14 的新取消入口：先落 `user.input_queued`，模型阶段可立即请求中断；工具阶段则等 Tool/WAL 的安全边界后落 `user.input_consumed` 与 canonical `run.cancelled`。提交响应只证明取消已排队，不能假定 Run 已终态。旧 `/stop` 与 SDK `stop()` 仍保留兼容，但新 Web 不再用它表达 G-14 中断语义。

---

## 5. 单活动 Run 闸门

```321:329:packages/host/src/index.ts
    if (activeRunId !== undefined) {
      const active = await options.runtime.getProjection(activeRunId);
      if (!isTerminalStatus(active.status)) {
        throw Object.assign(new Error("P0 allows only one active run"), {
          statusCode: 409,
        });
      }
      activeRunId = undefined;
    }
```

`activeRunId` 是**进程内单变量**，所有启动路由都经过 `serializeStart` 串行化，避免并发启动竞态。

- 已有一个非终态 Run → 409 `P0 allows only one active run`。
- Run 转为终态后（approve/reject/stop 返回终态投影时）自动清空，允许下一个 Run。
- `startCommands` 提供真正的启动幂等：

```760:774:packages/host/src/index.ts
function startRequestFingerprint(input: {
  session_id?: string | undefined;
  project_id: string;
  task: string;
  mode: string;
  reasoning_effort?: string | undefined;
  conversation_history?: readonly unknown[] | undefined;
}): string {
  return JSON.stringify([
    input.session_id ?? "new-session",
    input.project_id,
    input.task,
    input.mode,
    input.reasoning_effort ?? "default",
    input.conversation_history ?? [],
  ]);
}
```

同 `command_id` + 同指纹 → 直接返回既有投影（**网络重试不会产生第二个 Run**）；同 `command_id` + 异指纹 → 409。把 `session_id` 纳入指纹可防止相同命令 id 被重放到另一会话。

---

## 6. 项目可见性与越权防护

Host 维护**两个 Map**：

| Map | 内容 | 用途 |
|---|---|---|
| `visibleProjects` | 仅注册项目 | `GET /api/projects` |
| `projects` | 注册项目 **+ chatProject** | 所有资源访问校验 |

每个读 Run / 工件 / 建流的路由都会做：

```786:795:packages/host/src/index.ts
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

```436:443:packages/host/src/index.ts
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

```369:374:packages/host/src/index.ts
    const wireInput = StartRunRequestSchema.parse({
      ...chatInput,
      project_id: options.chatProject.workspace.project_id,
      mode: "execute",
    });
```

`/api/chat/runs` **覆写** `project_id` 与 `mode`：客户端无法指定项目，也无法选择 plan。聊天永远落在专用隔离工作区，并以 `execute` 运行；它的只读性来自 Host-owned chat Workspace capability，而不是借用 Plan Mode。这样普通对话可以正常回答并终态，又不能触碰用户代码——**不做客户端校验，直接改写**。

`chatProject` 的 id 与已注册项目冲突时 Host 启动就失败：

```91:96:packages/host/src/index.ts
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

因此**响应里永远不含 `api_key`**：密钥只从 POST 进入本机 loopback Host，不会经 HTTP 回流到前端。backend 的实际选择、环境来源的只读 `409` 和旧配置迁移属于 CLI composition 责任，Host 路由只消费 `modelSettings` seam。

### 8.1 权限配置

Host 的 `permissionSettings` seam 只有 `get()` 与 `configure({command_id,preset_key})`。GET/POST 返回同一 `PermissionSettingsResponseSchema`：active preset、其固定 sandbox/approval pair、policy digest、Host ceiling、最多三个 available built-in presets、source/locked/lock reason。完整 preset tool/path scope、Host/project rules、配置文件路径和 approval token 从结构上不在公开响应里。

POST 与其它 command 一样要求 Bearer、allowed Origin、`x-tracegraph-command-id === body.command_id`。同一 command id + 同一 preset 幂等；同 id 换 preset 返回 409。该绑定表只在当前 Host 进程内，durable 用户选择由 CLI composition 的私有原子配置负责。Host seam 返回不符合 strict schema、泄漏 rule/path 等字段时，路由在出站前 fail-closed。

### 8.2 G-15 Telemetry 状态：只有 GET，没有浏览器配置面

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

该响应只是当前进程健康快照：`error_count` 与 `last_error_at` 重启会重置，不进入 Session/Run Projection，不用于恢复。真正的 `<dataDir>/telemetry.json`、endpoint 环境变量和 G-19 authorization reference 由 CLI composition 持有，浏览器不可见。当前 SDK 若连到没有该路由的旧 Host，请求会显式失败；Web 不会把这种“未知/不支持”伪装成 Runtime 已证实的 `noop / disabled`。

### 8.3 G-17 扩展控制面：Host 只接收名字，不接收代码

`GET /api/extensions` 返回 strict 状态、generation、registration count 与有界错误；`POST /api/extensions/reload` 只接受扩展名和可选旧 config digest，真正的 replacement 由 Host-owned trusted catalog 解析。HTTP body、query 和 path 都没有 module/file/npm 字段，因此浏览器不能借 reload 让 Host 执行仓库代码。

`POST /api/extensions/commands/:name` 的 path/body name 必须一致，args 最多 64 个且每项最多 2,000 字符。reload/command 都把 `command_id` 同时绑定 header/body，并用 fingerprint 防止同 id 换参数；并发重复请求共享同一个 Promise，失败会移除内存幂等项供显式重试。Replay bearer 在统一 authority gate 上只能读取历史 snapshot，不能调用这些 live 管理路由。

---

## 9. 三条 SSE 通道

三条流的骨架相同（hijack → 手写响应头 → 订阅 → 补发 → 心跳），但语义分工明确。

### 9.1 canonical 事件流（`/events/stream`）

```620:623:packages/host/src/index.ts
    const unsubscribe = options.runtime.subscribe(request.params.runId, (event) => {
      if (!live || write === undefined) buffered.push(event);
      else write(event);
    });
```

**先订阅、再读投影、再接流**，用一个小缓冲消除"Run 已启动但流还没接上"的竞态窗口。补发阶段用 `projection.timeline`（也就是账本重放），随后 `live = true` 并冲刷缓冲。去重靠 `event.sequence <= lastSequence`。

这一条流**不因终态而关闭**，客户端可以一直挂着等新事件（对已完成的 Run 则只有心跳）。心跳间隔 15 s。响应头包含 `x-accel-buffering: no`，避免反向代理缓冲住 SSE。

### 9.2 展示活动流（`/live/stream`）

```456:462:packages/host/src/index.ts
    // Subscribe before the projection/access check. The small runtime buffer
    // below then closes the start-run -> attach-stream race without making a
    // second durable event ledger or replaying provider output.
    const unsubscribe = options.runtime.subscribeLive(request.params.runId, (activity) => {
      if (!live || write === undefined) buffered.push(activity);
      else write(activity);
    });
```

与其他两条的关键差别：**终态活动或当前 `plan.ready` 边界过线后立即 `close()`**，避免浏览器/SDK 永远停在"运行中"等心跳。Plan 判断还会核对 activity 的 Event id 等于 Projection 当前 `pending_plan.plan_event_id`，历史 revision 不会错误关掉新连接：

```500:504:packages/host/src/index.ts
      // A live feed belongs to one Run. Once its real terminal activity has
      // crossed the wire there will be no later activity for this stream, so
      // close it instead of leaving the browser/SDK in an apparent "running"
      // state waiting for heartbeats forever.
      if (isCurrentPlanBoundary || isTerminalLiveWaitBoundary(safeActivity)) close();
```

SDK 对终态活动可立即结束；对 `plan.ready` 则不会在 yield 时武断结束，因为它可能是 execute 阶段从旧 cursor 补发的历史活动。即使响应恰在该帧后 EOF，SDK 还会读取 durable Projection，只有 `status === awaiting_plan_approval` 且 `pending_plan.plan_event_id` 精确等于该活动 Event id 时才停止重连；否则从已推进的 sequence 继续接收 `plan.approved`、Tool 与终态活动。Projection 核验失败按瞬时断线退避重试，不把网络 EOF 冒充 Plan 状态。

取消提交本身不会关闭任何 SSE。Web 保持 canonical/live 消费，直到真正收到/读取 `run.cancelled`；这避免把“cancel 已排队”误显示成“已经安全停止”，也让等待写工具越过 WAL/rename/Receipt 边界的过程仍可观察。

### 9.3 模型公开画面（`/model-surface/stream`）

```525:529:packages/host/src/index.ts
  /**
   * A separate, volatile model surface. It uses a cursor unrelated to the
   * JSONL ledger sequence so a high-frequency public text stream can neither
   * reorder nor suppress durable runtime events.
   */
```

**独立游标是本模块最重要的架构决策之一。** 模型的高频公开文本（`public_reason` / `final_answer` 的增量）如果与账本 `sequence` 共用编号，就会污染持久事件的顺序语义。用 `after_cursor` 隔离后，瞬时流的频率与持久账本完全解耦。

这条流同时订阅两个源：`subscribeModelSurface`（数据）与 `subscribe`（用于感知终态或 `plan.ready` 等待边界）：

```547:552:packages/host/src/index.ts
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

```132:165:packages/host/src/index.ts
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

**5xx 一律不泄露内部消息**（"TraceGraph Host failed to process the request"）。SSE 中途出错用导出的 `sendSseError()` 发送 `event: error` 帧。

---

## 11. SDK 客户端

`packages/sdk/src/index.ts` 是唯一的官方客户端；网络层使用平台 `fetch`，响应通过 `@tracegraph/contracts` 的 Zod schema 校验。

| 能力 | 实现 |
|---|---|
| 默认地址 | `http://127.0.0.1:4311` |
| Node 侧 Origin | 默认注入 `origin: http://127.0.0.1:4310`；浏览器不注入（由浏览器自管）；`nodeOrigin: false` 关闭 |
| 令牌刷新 | 401 → `#refreshCapabilityToken()` → 重试一次 |
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
| Telemetry | `getTelemetryStatus()` 对 `GET /api/telemetry-status` 再做 `TelemetryStatusSchema` strict parse；没有配置/写入方法，不公开 endpoint/header/credential/path/payload；旧 Host 缺路由时保留显式 HTTP 失败，不合成 noop |
| Extensions | `listExtensions()` / `reloadExtension()` / `runExtensionCommand()` 对 G-17 strict schema 双向校验；401 重放沿用相同 command id，客户端不能提交 module path |
| Replay | `createReplay()` 切换到 Host 签发的只读 bearer，`getReplayDiff()` 自动补绑定的 session/run scope，`exitReplay()` 才恢复保留的 live bearer；replay 401 直接失败，禁止 bootstrap 自动升级 authority |
| Sandbox | 解析 Projection/Event 中的 `sandbox_report`；mode 只能随 Host 广告的 G-06 preset 间接选择，不能逐 Run 覆盖 |
| bootstrap recovery | 可选 `SessionRecoveryReportSchema`，旧 Host 无该字段仍可兼容 |

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

普通 live capability 仍可在 401 后 bootstrap 一次；replay capability 明确走 fixed-authority 分支，过期或被步进轮换后直接返回错误。否则共享的自动刷新代码会把只读 token 换成 live token，等价于权限提升。SDK 在内存中保留进入回放前的 live token，但回放期间所有请求头使用 replay token；因此遗漏的 UI 写入口仍会被 Host 403，而不是只依赖按钮 `disabled`。

---

## 12. 已知缺口

1. **能力令牌 8 小时后无法续期。** `token` 与 `expiresAt` 在 Host 启动时算定并被闭包固定：

```79:82:packages/host/src/index.ts
  const token = options.capabilityToken ?? randomBytes(32).toString("base64url");
  const tokenTtlMs = options.tokenTtlMs ?? 8 * 60 * 60 * 1_000;
  const expiresAtMs = now().getTime() + tokenTtlMs;
  const expiresAt = new Date(expiresAtMs).toISOString();
```

`/api/bootstrap` 永远返回**同一对**值。TTL 过后 `assertBearer` 恒定 401，SDK 的 401 重试会重新 bootstrap 拿到同一个已过期令牌，然后再次失败。**没有任何轮换或续期机制，唯一恢复手段是重启 Host。** 对一个"开着写一整天代码"的本地工具来说，这是必然会遇到的可用性问题。

2. **批准请求同步续跑，但没有 application-level handler deadline。** `approve` 在返回前会同步续跑：

```440:441:packages/core/src/runtime.ts
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

13. **Rollback API 已有但产品面有限。** Runtime/CLI 默认关闭，P0 仅单目标；Web 没有调用控件，Recovery Markdown 也没有 Host/SDK 导出路由。Host 的 registered-project check 不是跨进程 workspace lock。

14. **Permission 设置不是 per-Run override 或 policy editor。** CLI/env ceiling 是 Host 启动边界，改变它仍需重启；用户 preset 选择可经 Host/SDK/Web 保存，但只影响随后创建的 Run，不能热改活动 Run，恢复也继续使用冻结 policy。客户端不能提交 rule/path/sandbox/approval/token，Host 响应也不公开完整策略。当前没有远程 policy negotiation/RBAC、Linux bwrap/Windows backend 或 Host 模型网络代理；Projection 徽标不能补足这些缺口。

15. **旧 stop 与 G-14 cancel 暂时并存。** `/stop` 是同步兼容命令；`POST /input {kind:"cancel"}` 才具有 durable queued/consumed 与安全边界语义。新客户端应使用后者，但删除旧接口会破坏已有 SDK/调用方，因此当前不能把两者当作完全相同的 receipt 流程。

16. **Telemetry status 不是交付确认或恢复数据。** 它只报告当前 Host 进程里的 sink kind/state/error count/last error；重启会清零进程内错误状态。Host/SDK 没有 exporter 配置 API，也不能证明外部 Collector 已经持久接收；真实配置只在服务端 CLI composition，Telemetry 失败不改变 canonical Run。

17. **G-08 Team 控制面仍是单 Host、关系绑定且大体只读的产品面。** G-07 child ledger 读取继续依赖父投影和 child `run.created` provenance，普通 Session 列表默认隐藏 child；没有 Session 树编辑、child Resume、浏览器 send/interrupt 或任意 Run-id 查询。Team 路由增加 roster/mailbox/task board read、用户 steer/cancel 与 trusted heartbeat/sweep，但 `spawn_subagent` 仍在父 Tool call 内等待 child 终态，也没有跨 Host consensus、自动 worker 重启/重派或通用非阻塞父循环。

18. **G-17 API 不是插件商店。** Host 只能管理 composition 已安装的 trusted catalog；没有上传、npm/path 安装、签名校验、依赖解析或扩展 UI。命令幂等表也只在当前 Host 进程内，不是跨 Host 共识。

---

## 13. 相关文档

- 模块 02（Runtime）：Run 与 Session 恢复方法如何映射到 Host 路由
- 模块 05（证据链）：`toWireEvent` 与 `WireSessionEvent` 的转换规则
- 模块 06（模型适配）：`modelSettings.configure()` 的校验与 `publicConfig()`
- 模块 10（Web）：三条 SSE 流在界面上的分工
- 模块 11（CLI）：`modelSettings`、项目 seams 与 G-15 sink/config 的真实装配；Host status 直接读取 Runtime
- 模块 15（插件与扩展系统）：trusted catalog、idle-only reload、Run lease 与 recovery v5
- 模块 16（Agent Team）：Team route、actor binding、optimistic task version 与 heartbeat/sweep 边界
