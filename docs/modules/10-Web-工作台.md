# 模块 10：Web 工作台（`apps/web`）

> **定位**：浏览器侧的**审查与显式命令工作台**。它不执行工具、不充当事实源，也不把业务状态持久化到浏览器；durable Session/Run 事实来自本地 Host，实时过程来自三条流。Web 负责浏览、呈现并发送受约束的用户命令。
> **代码**：`apps/web/src`（精确文件/行数以当前工作树命令输出为准）
> **技术栈**：React + TypeScript + Vite + 原生 CSS（无 UI 组件库）+ vitest/jsdom
> **最后核对**：2026-09-19
> **上游依赖**：模块 09（Host 与 SDK 接口层）；**交叉引用**：模块 03（Context 与预算）、模块 05（证据链）、模块 06（模型适配与推理强度）

---

## 1. 职责边界

Web 是整条链路的**末端消费者**，三条硬边界：

| 边界 | 具体表现 | 代码位置 |
| --- | --- | --- |
| **不装配能力** | Web 侧不存在 `CodeGraphProvider`、模型 provider、工具执行器等任何 provider 的装配代码；装配只发生在 CLI 的 composition | 全仓 `codeGraph` 仅出现在 `apps/cli/src/composition.ts` |
| **不执行副作用** | 打开 durable Session 只加载最后一个 Run 的投影；显式 Resume 也不会自动重跑工具，待审批恢复后仍需用户使用新 approval | `apps/web/src/live-client.ts`、`App.tsx` |
| **不持有真相** | 唯一状态是 `WorkbenchSnapshot`；组件通过 `useSyncExternalStore` 订阅，没有本地业务状态机 | `apps/web/src/App.tsx:37:43` |

凭据边界同理：设置页用 password input 临时收集用户输入，并只在一次 loopback POST 中把它作为 write-only 字段发送；前端不写 localStorage、不保留保存后的值，Host/SDK 响应也绝不回显。浏览器只显示安全状态元数据。

权限边界也由 Host 决定：Web 只能读取 `PermissionSettingsResponse` 并回传其中一个 `available_presets[].key`。它不能提交或读取 Host/project rules、path scope、本机配置路径、sandbox/approval 的任意组合或 approval token；设置变化只影响新 Run，当前 Run 顶栏显示的是 durable、冻结的 permission snapshot。

## 2. 构建与运行

### 2.1 脚本与依赖

```json:6:12:apps/web/package.json
"scripts": {
  "dev": "vite --host 127.0.0.1",
  "build": "tsc --noEmit && vite build",
  "typecheck": "tsc --noEmit",
  "test:unit": "vitest run src",
  "test:watch": "vitest"
}
```

- `build` **先类型检查再打包**，类型不过则不出产物。
- 运行时依赖只有三项：`@tracegraph/contracts`（schema）、`@tracegraph/sdk`（Host 客户端）、`react`/`react-dom`；`mermaid` 为图渲染依赖。**没有 UI 组件库、没有状态管理库、没有路由库**——页面切换靠 `MainView` 枚举。

### 2.2 端口与同源约束

```15:32:apps/web/vite.config.ts
server: {
  host: "127.0.0.1",
  port: 4310,
  strictPort: true,
  proxy: {
    "/api": {
      target: "http://127.0.0.1:4311",
      configure(proxy) {
        // Browser requests are same-origin with Vite, so they do not carry
        // an Origin header. Inject the exact dev-server origin at this
        // trusted reverse-proxy boundary; the Host allowlist remains strict.
        proxy.on("proxyReq", (proxyRequest) => {
          proxyRequest.setHeader("origin", "http://127.0.0.1:4310");
        });
      },
    },
  },
}
```

- Web dev server 固定 `127.0.0.1:4310`（`strictPort`，端口被占直接失败而不是漂移），Host 在 `4311`。
- 因为浏览器与 Vite 同源，请求**不带 `Origin` 头**；由代理这一"可信边界"补上精确来源，Host 侧的白名单校验**不被放松**。这是本模块唯一一处安全相关的设计取舍。
- `cacheDir` 与 `build.emptyOutDir: false` 都写明理由：避免与工作区共享缓存冲突、避免构建时递归删除（工作区安全护栏不允许）。

```5:14:apps/web/vite.config.ts
cacheDir: "node_modules/.vite-tracegraph",
plugins: [react()],
build: {
  // Preserve prior artifacts so workspace safety guards never need a recursive
  // delete during a normal build. Vite's hashed manifest still points at the
  // current bundle.
  emptyOutDir: false,
},
```

### 2.3 入口

`index.html` 只声明 `color-scheme: dark light` 与 `theme-color`，样式与逻辑全在 `main.tsx` 之后的 React 树里；`main.tsx` 在 `StrictMode` 下挂载 `<App />`，根节点缺失时**直接抛错**而不是静默失败。

```6:16:apps/web/src/main.tsx
const root = document.getElementById("root");
if (!root) {
  throw new Error("TraceGraph Web root element was not found");
}
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

### 2.4 后端地址

`VITE_TRACEGRAPH_API_URL` 为空即同源（生产/一体部署），显式设置则直连指定 Host（`App.tsx` 中装配 `LiveTraceGraphClient`）。**浏览器不接收 Host 保存的项目真实路径或凭据值**；用户新输入的 Key 只存在于设置组件状态和当次保存请求。

## 3. 数据契约：`model.ts` 是前后端唯一接缝

`apps/web/src/model.ts` 只有类型与纯函数——**没有 I/O、没有副作用、没有默认值**，因此它可以被 Host 侧的实现直接对齐引用。这是 Web 与 Host 之间真正的"薄指针"。

### 3.1 枚举即协议

```1:29:apps/web/src/model.ts
export type WorkspaceKind = "disposable_fixture" | "readonly_local" | "managed_local";
export type RunMode = "plan" | "execute";
export type ReasoningEffort = "default" | "low" | "medium" | "high" | "xhigh" | "max";

export type RunStatus =
  | "empty" | "ready" | "indexing" | "running" | "needs_approval"
  | "awaiting_plan_approval" | "needs_manual_review" | "ready_for_review" | "completed" | "failed" | "cancelled" | "interrupted"
  | "historical" | "reconnecting";

export type EventKind = "query" | "context" | "decision" | "tool" | "approval" | "patch" | "graph" | "test" | "permission" | "sandbox" | "todo" | "subagent" | "attachment" | "team" | "run";
export type EventState = "waiting" | "running" | "succeeded" | "failed" | "denied";
```

- `RunStatus` 14 态是**界面全部呈现分支的来源**；G-09 的 `awaiting_plan_approval` 与 Patch 的 `needs_approval` 明确分开，G-01 的 `interrupted` 有 Resume 入口，G-04 的 `needs_manual_review` 则是静态人工复核态。
- `EventKind` 15 类与账本事件族对应；G-09 的 `todo`、G-06 的 `permission`、G-13 的 `sandbox`、G-07 的 `subagent`、G-08 的 `team` 与 G-18 的 `attachment` 独立成类，Web 不发明新的事件类型。

### 3.2 两类数据的区分是刻意的

`model.ts` 用注释明确了"可重放"与"易失"的边界：

```63:92:apps/web/src/model.ts
/**
 * A volatile public-process item received over the Host live SSE channel.
 * It is intentionally separate from TraceEvent: TraceEvent is replayable
 * ledger history, while this is a short-lived display projection.
 */
export interface PublicActivitySnapshot { ... }

/**
 * A volatile model surface snapshot. `thinking_snapshot` is retained only so
 * older Host payloads remain parseable; the browser deliberately filters it
 * because provider-native reasoning is not a public explanation.
 */
export interface ModelSurfaceSnapshot { ... }
```

- `TraceEvent` = 账本历史，可重放、可持久化、序列号权威。
- `PublicActivitySnapshot` = 快速流投影，**仅当前 Run 在飞期间存在**，同一个 `sequence` 上的持久事件到达后即被替换。
- `ModelSurfaceSnapshot` = 模型公开面，`thinking_snapshot` 只是**重连兼容用的线上字段**，浏览器主动过滤。

### 3.3 证据必须"逐事件"解析

```276:281:apps/web/src/model.ts
/**
 * Evidence resolved from the canonical relations on each event. This is
 * deliberately separate from the run-level latest projection above: a
 * selected event must never inherit unrelated newer evidence.
 */
readonly eventEvidence: Readonly<Record<string, EventEvidenceSnapshot>>;
```

`evidenceForSelection()` 是这条规则唯一的执行点：选中事件时**只**读 `eventEvidence[event.id]`，取不到就返回"该事件没有链接证据"的空投影，**绝不回退到 run 级最新证据**；只有未选中任何事件（跟随尾部）时才用 run 级投影。

```384:397:apps/web/src/model.ts
export function evidenceForSelection(snapshot, event): EventEvidenceSnapshot {
  if (event) {
    return snapshot.eventEvidence[event.id] ?? emptyEventEvidence(
      "The selected event has no linked evidence projection.",
    );
  }
  // 仅在跟随尾部时才回退到 run 级最新投影
```

空投影的文案同样是显式的（`not_present` + 逐槽位说明），不伪造"暂无数据"以外的语义。

### 3.4 纯函数层

| 函数 | 作用 | 位置 |
| --- | --- | --- |
| `canUseExecuteMode()` | 判定工作区是否可写（只有 `disposable_fixture` / `managed_local` 可进入 execute） | `apps/web/src/model.ts` |
| `getInspectorTabs()` | 由事件字段**推导** Inspector 标签页（有 `contextManifestRef` 才有 context 页，有 `duration` 才有 timing 页） | `apps/web/src/model.ts:300` |
| `getStatusLabel/getStatusTone` | 状态 → i18n key / 色调 | `apps/web/src/model.ts:314` |
| `getEventIcon()` | 事件类型 → 图标名 | `apps/web/src/model.ts:339` |
| `totalDiff()` | 变更文件汇总 | `apps/web/src/model.ts:354` |
| `graphForVersion()` | 架构增量按 `before`/`after` 拆平 | `apps/web/src/model.ts:364` |

Inspector 标签页由数据推导而非硬编码，意味着**Host 少发字段时界面自动收窄**，不会出现点开就空的面板。

## 4. 客户端接口与两种实现

`client.ts` 用**一个接口 + 两个实现**切断了"界面"与"传输"的耦合：

```4:21:apps/web/src/client.ts
export interface WorkbenchClient {
  getSnapshot(): WorkbenchSnapshot;
  subscribe(listener: (snapshot: WorkbenchSnapshot) => void): () => void;
  chooseProject(kind: WorkspaceKind): Promise<void>;
  chooseProjectById(projectId: string): Promise<void>;
  openLocalProject(access?: "read_write" | "read_only"): Promise<void>;
  revealProject(projectId: string): Promise<void>;
  searchSessions(query: string): Promise<void>;
  openSession(sessionId: string): Promise<void>;
  renameSession(sessionId: string, title: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  resumeSession(sessionId: string): Promise<void>;
  loadSubagent(subagentId: string): Promise<void>;
  createTeam(): Promise<void>;
  steerTeamMember(subagentId: string, payload: string): Promise<void>;
  cancelTeamTask(task: TaskBoardItem): Promise<void>;
  returnHome(): Promise<void>;
  startRun(task: string, mode: RunMode, reasoningEffort?: ReasoningEffort): Promise<void>;
  submitUserInput(kind: UserInputKind, body: string): Promise<void>;
  startChat(task: string, reasoningEffort?: ReasoningEffort): Promise<void>;
  approve(approvalId: string): Promise<void>;
  reject(approvalId: string): Promise<void>;
  stop(): Promise<void>;
  previewState(status: RunStatus): Promise<void>;
  createProject(name: string): Promise<void>;
  getModelConfig(): Promise<ModelConfigSnapshot>;
  configureModel(input: ConfigureModelInput): Promise<ModelConfigSnapshot>;
  getTelemetryStatus(): Promise<TelemetryStatusSnapshot>;
}
```

- **生产实现** = `LiveTraceGraphClient`（`apps/web/src/live-client.ts`，见 §5）。
- **Demo 实现** = `DemoTraceGraphClient`（`apps/web/src/client.ts:40`），纯浏览器内定时器 + `demo.ts` 固定快照，无需 Host 即可演示全部界面分支。
- 装配点在 `App.tsx:17`：baseUrl 来自 `import.meta.env.VITE_TRACEGRAPH_API_URL`，为空即同源。

两种实现都满足 G-15 的只读状态接口：Live 经 SDK `GET /api/telemetry-status` 并再次 strict parse；Demo 返回固定 `noop / disabled / 0`。该接口没有 configure 对偶，也不允许浏览器接触 endpoint、header、credential、配置 path 或 pending payload。

Demo 适配器同时也充当**能力边界的可执行声明**：它明确对两项操作抛错，而不是假装成功——

```113:115:apps/web/src/client.ts
async createProject(_name: string): Promise<void> { throw new Error("Project creation is unavailable in browser demo mode"); }
async getModelConfig(): Promise<ModelConfigSnapshot> { return { provider: "openai", protocol: "openai-chat-completions", configured: false, base_url: "https://api.openai.com/v1", model: "gpt-4.1-mini" }; }
async configureModel(_input: ConfigureModelInput): Promise<ModelConfigSnapshot> { throw new Error("Model configuration is unavailable in browser demo mode"); }
```

`ModelProvider`（openai/deepseek/glm/qwen/minimax/anthropic/custom）与 `ModelProtocol`（`openai-chat-completions` / `anthropic-messages`）在 `client.ts:32:33` 定义为传输契约；对应的服务端实现与两条协议路径的差异见模块 06。

Demo 的时序完全确定性（`indexing → 420ms → running|completed → 650ms → needs_approval`），这使它成为**渲染分支的测试夹具**而非"假后端"。

G-07 的 `loadSubagent()` 也是刻意收窄的只读接口：调用方只给当前父 Run 投影中已有的 `subagent_id`，Live client 再通过 SDK relation-scoped route 取 child；Demo 明确不提供真实 child ledger。它不是任意 Run 查询，也没有浏览器 send/interrupt/Resume 写控制面。

G-08 的三个 UI mutation 也刻意收窄：浏览器只能为当前 root Run 创建 Team、向当前投影中的 active member 发送 `kind:"steer"` 消息，以及用当前 task `version` 取消 open/claimed/blocked task。它不能提交 project/team/actor/from/owner、claim/heartbeat/sweep 或任意任务 owner 变更；Host/Core 是最终 authority。

## 5. 实时通道与三条流（`live-client.ts`）

`live-client.ts` 是本模块的引擎：它把 SDK 的流式接口收敛成一份**可订阅的快照**。

### 5.1 依赖的是一个窄接口，不是 SDK 本体

```43:52:apps/web/src/live-client.ts
export interface TraceGraphSdkPort {
  bootstrap(): Promise<{ token: string; expiresAt: string }>;
  listProjects(): Promise<readonly ProjectSummary[]>;
  ...
  startRun(input: { command_id: string; project_id: string; task: string; mode: RunMode; reasoning_effort?: ReasoningEffort; conversation_history?: { role: "user" | "assistant"; content: string }[] }): Promise<RunProjection>;
```

canonical `streamEvents` 是必需接口；`streamLiveActivities?` / `streamModelSurface?` 两条瞬时流与 `getTelemetryStatus?` 是可选的兼容 seam。缺失瞬时流时对应画面可静默降级；但 Live SDK 缺失 `getTelemetryStatus` 时会显式抛出 `This Host client does not support telemetry status`，不把未知远端状态伪装成 `noop / disabled`。只有独立 `DemoTraceGraphClient` 固定返回 `noop / disabled / 0`。默认实现是 `new SdkTraceGraphClient(...)`。

状态全部住在类实例里，**不经 React state**：

```140:155:apps/web/src/live-client.ts
  private snapshot: WorkbenchSnapshot = emptyLiveSnapshot({
    state: "connecting",
    message: "Connecting to the local TraceGraph Host…",
    lastSequence: 0,
  });
  private readonly listeners = new Set<(snapshot: WorkbenchSnapshot) => void>();
  private projects: readonly ProjectSummary[] = [];
  private selectedProjectId: string | null = null;
  private initialization: Promise<void> | null = null;
  private streamController: AbortController | null = null;
  private streamGeneration = 0;
  private readonly artifactCache = new Map<string, Promise<ArtifactFetchResult | null>>();
  private readonly conversations = new Map<string, ConversationTurn[]>();
  private readonly liveActivities = new Map<string, PublicActivitySnapshot[]>();
  private readonly modelSurface = new Map<string, ModelSurfaceSnapshot[]>();
```

`initialize()` 幂等（`initialization` 只赋一次）；bootstrap 失败**不抛异常**，而是把连接置为 `offline` 并写入原因——界面因此永远有可渲染状态。

### 5.2 三条流的分工与失败归属

```424:432:apps/web/src/live-client.ts
private startStream(runId: string): void {
  this.stopStream();
  const controller = new AbortController();
  const generation = ++this.streamGeneration;
  this.streamController = controller;
  void this.consumeLiveProcess(runId, controller, generation);
  void this.consumeModelSurface(runId, controller, generation);
  void this.consumeStream(runId, controller, generation);
}
```

| 流 | 方法 | 权威性 | 失败后果 |
| --- | --- | --- | --- |
| 持久事件流 | `streamEvents` | **唯一权威**（决定 Run 终态与投影） | 进入 `reconnecting`，指数退避重试 |
| 快速公开活动流 | `streamLiveActivities` | 易失展示投影 | **吞掉异常**，不影响 Run 状态 |
| 模型公开面流 | `streamModelSurface` | 易失文本投影 | **吞掉异常**，不影响 Run 状态 |

快速流与公开面流的注释把这条纪律写死了：

```435:439:apps/web/src/live-client.ts
/**
 * Fast UI-only feed: it is intentionally independent of projection reloads
 * so a user can see an in-flight request/tool immediately. The durable SSE
 * stream below remains the only authority for a final RunProjection.
 */
```

```451:454:apps/web/src/live-client.ts
} catch {
  // The durable projection stream owns connection state and retry UI. A
  // transient presentation stream failure must never mark a Run failed.
}
```

### 5.3 持久流的重试循环

```479:519:apps/web/src/live-client.ts
private async consumeStream(runId, controller, generation): Promise<void> {
  let retryMs = this.minRetryMs;                       // 默认 300ms
  let afterSequence = this.projection?.last_sequence ?? 0;
  while (!controller.signal.aborted && generation === this.streamGeneration) {
    try {
      const refreshed = await this.sdk.getRun(runId);
      afterSequence = Math.max(afterSequence, refreshed.last_sequence);   // 只前进
      await this.acceptProjection(refreshed, { state: "live", ... });
      if (isTerminal(refreshed)) {
        if (this.streamController === controller) this.stopStream();
        return;
      }
      retryMs = this.minRetryMs;                        // 连上即重置退避
      for await (const event of this.sdk.streamEvents(runId, { afterSequence, reconnect: false })) {
        afterSequence = Math.max(afterSequence, event.sequence);
        const projection = await this.sdk.getRun(runId); // 每条事件后重新取投影
        ...
      }
      if (!controller.signal.aborted) throw new Error("The event stream closed before the run reached a terminal state");
    } catch (error) {
      if (controller.signal.aborted || generation !== this.streamGeneration) return;
      const stableRun = this.snapshot.run;
      this.commit({
        ...this.snapshot,
        connection: { state: "reconnecting", message: publicMessage(error), lastSequence: afterSequence },
        run: stableRun ? { ...stableRun, status: "reconnecting", lastSequence: afterSequence } : null,
      });
      await delay(retryMs, controller.signal);
      retryMs = Math.min(this.maxRetryMs, retryMs * 2);  // 300 → … → 2500 封顶
    }
  }
}
```

要点：

- **序号只增不减**：`afterSequence = max(本地, 服务端)`，重连不会重复消费也不会跳号。
- **非终态断流被当成错误**（`stream closed before the run reached a terminal state`），因此"静默断开"不会伪装成"运行结束"。
- **退避**：300ms 起、翻倍、2500ms 封顶；`delay()` 监听 `AbortSignal`，取消时立即返回，不留下悬挂定时器。
- 断线时**保留 `stableRun` 的其余字段**，只把状态改为 `reconnecting` 并更新 `lastSequence`——用户仍能看到断线前的完整轨迹（对应 §6.5 的提示文案）。

### 5.4 代号取消（generation）

```521:525:apps/web/src/live-client.ts
private stopStream(): void {
  this.streamController?.abort();
  this.streamController = null;
  this.streamGeneration += 1;
}
```

每条流都持有一个 `generation`，与当前值不等时立即 `return`。这样**切项目 / 开新 Run / 停止**都不会让旧流的迟到数据写进新 Run 的快照——比单纯的 `abort()` 多一层保险（`abort` 后仍可能有一次已在执行的 `await` 返回）。

### 5.5 与投影的合并：先给临时态，再用水合结果替换

```403:421:apps/web/src/live-client.ts
const publicActivities = this.liveActivities.get(projection.run_id) ?? [];
const modelSurface = this.modelSurface.get(projection.run_id) ?? [];
const base = { ...mapped, run: { ...mapped.run, ...(publicActivities.length === 0 ? {} : { publicActivities }), ...(modelSurface.length === 0 ? {} : { modelSurface }) }, ... };
this.commit(base);
const hydrated = await hydrateProjection(this.sdk, projection, base, this.artifactCache);
if (this.projection?.run_id === projection.run_id && this.projection.last_sequence === projection.last_sequence) {
  this.commit(hydrated);
}
```

- 第一次 `commit` 用**立即可得的数据**渲染（时间线、状态、快速流缓存），产物（Context Manifest / PatchPreview / Graph Delta / Test Log）随后并发拉取。
- 第二次 `commit` 有**门禁**：只有当投影的 `run_id` 与 `last_sequence` 都没变（即期间没有更新的投影到达）才提交水合结果——否则丢弃，防止旧水合覆盖新状态。
- 事件级证据先统一占位为"加载中"（`mapProjection` 为每个事件写入 `emptyEventEvidence("Linked evidence is still loading.")`），再由 `hydrateEventEvidence()` 并发逐事件解析引用后整体替换，因此 §3.3 的"逐事件证据"在 UI 上不会出现继承错位。

### 5.6 两条易失流的去重与幂等

```527:537:apps/web/src/live-client.ts
private recordLiveActivity(runId: string, activity: LivePublicActivity): void {
  const current = this.liveActivities.get(runId) ?? [];
  if (current.some((item) => item.sourceEventId === activity.source_event_id)) return;   // 按来源事件去重
  const next = [...current, mapLiveActivity(activity)].slice(-96);                        // 上限 96 条
  ...
}
```

模型公开面流额外做两件事（`recordModelSurface`）：

```542:556:apps/web/src/live-client.ts
// Provider-native reasoning is a private scratchpad. Older Hosts may still emit
// the legacy wire type, so reject it at the client boundary as well as in Runtime and the React renderer.
if (nextSnapshot.type === "thinking_snapshot") return;
// Each newer snapshot supersedes the same model-call surface. Keeping the
// reducer keyed this way makes reconnects idempotent and avoids a React entry for every provider token.
const keyMatches = (item) => item.modelCallId === nextSnapshot.modelCallId && item.type === nextSnapshot.type;
const next = existing && existing.cursor >= nextSnapshot.cursor ? current : [...current.filter((item) => !keyMatches(item)), nextSnapshot].sort(...).slice(-24);
```

- 归并键是 `(modelCallId, type)`，旧 cursor 的迟到快照被**丢弃而不是追加**，所以重连幂等。
- 上限 24 条 = 每个模型调用的"公开面"只保留最新一版，避免每个 token 都变成一次 React 更新。
- `thinking_snapshot` 在此被**第三次**拒绝（Runtime、渲染器、客户端边界各一次），注释里明确这是"三处防线"。
- cursor 相等但不更旧的情况也算命中，只有**更旧**才丢弃（`existing.cursor >= nextSnapshot.cursor`）。

### 5.7 命令面：幂等命令 + 客户端复核

写操作全部携带 `command_id`（`crypto.randomUUID`，无 crypto 时回退时间戳+随机数），Host 侧可据此去重：

```319:334:apps/web/src/live-client.ts
async approve(approvalId: string): Promise<void> {
  const projection = this.requireProjection();
  const pending = projection.pending_approval;
  if (!pending || pending.approval_id !== approvalId) throw new Error("Approval is no longer pending");
  if (!this.snapshot.run?.approval?.reviewReady || this.snapshot.evidence.diff.status !== "available") {
    throw new Error("The complete PatchPreview Artifact must be verified before approval");
  }
  const next = await this.sdk.approve(projection.run_id, { type: "approve", command_id: commandId(), ..., approval_id: pending.approval_id, action_id: pending.action_id });
  await this.acceptProjection(next, { state: "live", message: "Approval committed by the Host", lastSequence: next.last_sequence });
}
```

- 批准前的**二次校验**：审批仍是待处理、且完整 PatchPreview 产物已校验（`reviewReady` + diff 槽位 `available`）。这与 §6.4 的按钮禁用是同一规则的两层落点——**UI 禁用可以被绕过，客户端这道不会**。
- Patch 拒绝仍通过专用 `reject` 命令；G-14 以后 Web 的 Stop 改为 `submitUserInput("cancel", "")`。提交只表示取消已 durable 排队，client 不提前 `stopStream()`，而是继续等待 canonical `run.cancelled`。SDK/Host 的 legacy `stop()` 路径仍为旧调用方保留，但不是新 Web 的中断入口。
- `stop()` 现在只排队 cancel；只有切项目/返回首页/启动别的 Run，或 canonical Projection 真正终态时才停止当前流。`approve/reject` 同样由返回或随后读取的 canonical 投影决定流生命周期。
- `previewState()` 在 live 模式下**只有一个合法动作**：对进行中的 Run 重新 `startStream`（即"立即重试"）。原型状态切换是 demo 专属（`live-client.ts:366:372`）。

### 5.8 会话连续性

G-01 增加了两层不同含义的“连续性”，不能混为一谈：

1. **durable Session 浏览/恢复**：bootstrap 拉取 Session 摘要；侧栏可按标题/ID 搜索、打开最后一个 Run、删除确认。`openSession()` 只做 `getSession → last run id → getRun`，标为 `restored`，不执行工具。`resumeSession()` 是显式命令；Patch 等待态只取得新 approval，Plan 等待态恢复原 `plan_event_id` 并继续等待用户批准。
2. **新 Run 的多轮对话上下文**：`archiveCurrentRun()` 仍把完成轮次保存在 Web 内存 `conversations` Map，下一轮摊平为 user/assistant `conversation_history` 并 `.slice(-160)`。刷新页面后，Session 列表和 Run 投影可以从 Host 恢复，但 Web **不会从所有历史 Run 自动重建完整多轮 conversation_history**。

因此 Session 持久化证明的是“可发现、可审查、可安全恢复审批”，不是长期 Memory，也不是任意阶段的自动 agent continuation。

### 5.9 契约校验一律 fail-soft

```1529:1536:apps/web/src/live-client.ts
function parseJson<T>(content: string, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
```

产物内容必须**通过 `ContextManifestSchema` / `GraphDeltaSchema` 校验**才被信任；JSON 坏掉或字段不符时，槽位变成 `unavailable` 且带上说明（`Context Artifact did not match ContextManifestSchema`），`corrupt`（哈希不符）则显示 `Artifact hash mismatch: …`。同理 `contextBudgetFromEvent()` 对任何未知枚举值一律返回 `undefined`——**宁可少画一条进度条，也不猜 Host 的语义**。

### 5.10 事件映射层的几个关键约定

`mapWireEvent`（`live-client.ts:965:1017`）把线上事件压成 `TraceEvent`，其中三处约定值得记住：

- **`started` 类事件按运行终态回填**：若 Run 已完成/失败/取消，则 `tool.started` / `tool.batch_started` 等事件分别显示为 `succeeded`/`failed`/`denied`，而不是永远转圈。历史重放因此不会出现"卡在运行中"。
- **G-05 batch 生命周期有显式呈现**：`tool.batch_started` 在活动 Run 中映射为 `running`、标题 `Tool batch started`；`tool.batch_completed` 映射为 `succeeded`、标题 `Tool batch completed`。逐调用成功/失败仍由各自 Tool Event 表达，Web 不从 batch summary 猜测隐藏执行内容。
- **G-06 只呈现 typed policy**：`permission.configured` 更新 Run 的 permission snapshot；`policy.evaluated/denied` 只有通过 `PolicyEvaluatedDataSchema/PolicyDeniedDataSchema` 才进入 decision 行，显示 kind、explanation 以及 matched rule id 或 source。浏览器不从 summary 猜规则，也不接收完整 policy document。
- **G-13 报告只做受控解析**：run header 优先读 `projection.sandbox_report`；逐行依次解析顶层 `event.data.sandbox_report`、Receipt metadata 与 Observation facts。任何候选都必须过 `SandboxReportSchema`，`sandbox.configured/enforced/disabled` 有独立标题和 `sandbox` kind，浏览器不会从 mode 字符串自行猜 enforcement。
- **G-09 Plan/Todo 只消费 canonical 字段**：`projection.todos` 与 `pending_plan` 经 Contracts schema 后映射；`plan.ready/approved` 和 `todo.*` 有独立标题/状态，浏览器不会从聊天文本抽取 checklist，也不会自己推断 Plan revision。
- **G-14 mailbox 只消费 canonical 字段**：`projection.input_queue.pending/last_consumed` 直接映射为 `RunSnapshot.inputQueue`；`user.input_queued/consumed` 经 typed data schema 解析成 input id/kind，消费事件把 durable `at_step` 显示在 Trajectory。浏览器不根据 textarea 本地猜“已消费”。
- **G-07 child 只消费 canonical parent projection**：`projection.subagents.items` 映射为受限 `SubagentSnapshot`，`subagent.*` 进入独立 event kind；Web 不从聊天文本或 child id 猜父子关系，也不把 child timeline 复制进父事件列表。
- **G-08 Team 只消费 canonical root projection**：`projection.team` 原样保留 strict roster/mailbox/task board；13 个 `team.*`（含 `team.sweep_completed` receipt）进入独立 event kind。浏览器不从 subagent 卡片、消息正文或本地数组合成 Team，也不做本地 owner 仲裁。
- **目标字段的兜底链**：`tool_name` 依次从 `data.tool_name`、`receipt.tool_name`、`decision.tool_call.tool_name`、`observation.facts.tool_name` 取；`target` 在 `path/pattern/query/suite` 之间按同一顺序回退。旧 Host 的部分字段缺失因此不会让行信息为空。
- **`patch.preview_created` / `patch.applied` 自身的 `event_id` 就是 `patchRef`**，其他事件则用 `patch_event_id` 引用——与 §3.3 的逐事件证据解析保持一致。

### 5.11 G-23 时间旅行：live head 与 replay view 分离

Trajectory Event 现在既是 Inspector 选择点，也是明确的 replay 入口。`enterReplay(sequence)` 会先把界面切成只读 loading 并中止 canonical、live activity、model surface 三条 SSE，再向 Host 请求该 `session_id + run_id + sequence` 的 canonical snapshot。现有 live projection 不会被低 sequence 覆盖；replay projection 只负责当前显示。

这条路径另有独立 `viewGeneration`。它会淘汰进入回放前已在飞的 `getRun()`、Artifact hydration，以及快速连续单步中较旧的 replay 响应。历史视图不带 `publicActivities` / `modelSurface`，因为两者从未进入 Ledger，不能伪装成当时的事实。“回到现在”也不恢复旧缓存，而是先让 SDK 退出 replay authority，再 fresh `getRun()`，最后从新的 `last_sequence` 重开 SSE。

`ReplayBanner` 始终展示当前 sequence、进入回放时冻结的 head 与 canonical hash，并提供上一步、下一步和“回到现在”。`ArrowLeft/ArrowRight` 只在 replay active 时生效；input、textarea、select、contenteditable、IME composing、modifier 或已被消费的键盘事件不会被劫持。回放进入 loading 的同一刻，client mutation guard 与 Stop、Steering、Todo、Plan/Action approval、follow-up、设置/项目/Session mutation 控件一起只读；Host 的 replay bearer 403 是最终边界。

### 5.12 G-07 child ledger：按关系加载、只读且主动失效

父 Projection 只提供 child link、冻结 spec 摘要、预算、状态、消息数与有界 result；Trajectory 的“子任务”卡片展开时才调用 `getSubagent(parentRunId, subagentId)` 加载 child canonical Projection。client 会再次核对 child run/session/project 与父 link，一致后只映射 task、status、outcome 和 child Event 列表；不会把 child Artifact authority、写命令或恢复能力暴露给组件。

G-18 的 `AttachmentComposer` 只出现在创建下一项新任务的三个入口：Plain Chat、项目 Ready 和终态 follow-up。拖放/文件选择只接受 PNG/JPEG/PDF，本地先提示空文件、5 MiB/个与 8 个/Run，但 Host/Core 仍独立重验。每个图片默认 offload，只有用户显式勾选才请求 inline；Web 不判断某个模型“应该”支持图片。`LiveTraceGraphClient` 先依序 staging，收集 opaque upload ids，再随 StartRun/StartChat 提交；只有新 Run 成功后才清空 pending list。

Trajectory 顶部的附件卡片来自 `projection.attachments`，展示 added/rejected/offloaded、MIME、大小、delivery、拒绝码与 PDF 抽取状态。展开在线图片时才取 verified bytes 并创建 Blob URL；PDF 只提供下载，不在 iframe 里执行，URL 在替换/卸载时撤销。进入 Replay 后卡片仍显示 canonical metadata/status，但 `attachmentPreviewsDisabled` 阻止二进制请求并明确说明不可预览。运行中的 `SteeringComposer` 刻意没有附件入口，因此排队消息不能借附件扩大当前 Run 的模型输入或 authority。

child detail cache 以 `parentRunId + subagentId` 为键。父投影里的 child status、message count 或 finished time 改变时，旧 detail 立即失效；切项目、返回首页、切 Run 或进入 replay 也会递增 generation 并清空缓存，已在飞的旧响应不得回写新界面。replay 中 child 展开明确禁用，因为 replay bearer 不能读取 live child route，Web 也不会把进入历史视图前的缓存冒充该 sequence 的 child 快照。

### 5.13 G-08 Agent Team：证据展示优先、三项受限写入口

`RunProjection.team` 存在时，`TeamPanel` 分三段显示 roster、shared task board 与 mailbox；不存在时只显示“尚未创建”与 create 按钮。roster 展示 role/id/status/last heartbeat/active-task count，task 展示 state/version/owner/acceptance/evidence，mailbox 倒序展示 from→to/kind/payload/delivered/claimed。所有内容都来自 canonical Projection，不在组件内维护一份可持久化副本。

Web 只允许三种 mutation：创建当前 root Team、向投影中 active member 发送 durable steer、取消当前 version 的 open/claimed/blocked task。`LiveTraceGraphClient` 为一次未确认的尝试保留稳定 command id，解析 `TeamMutationResultSchema`，复核 coordinator run，再 fresh `getRun()`；响应丢失后的用户 retry 命中 Core durable idempotency，而不是重复投递。terminal/interrupted/manual-review、reconnecting、在途同项 mutation 与 Replay 都禁写。

steer 输入框遵循“确认成功后才消费草稿”：只有 Host 操作明确返回成功，且当前 draft 仍等于本次提交的文本时才清空。显式失败、异常或 response-lost 这类不确定结果都会保留原 draft，便于用稳定 command id 重试；若用户在请求期间已经继续编辑，旧请求即使随后成功也不能覆盖新 draft。

浏览器没有 member join、mailbox claim、heartbeat、sweep、task create/claim/complete/block/reopen、任意 owner 指派或 spawn/send/interrupt 控件。Demo client 的 Team 仅用于静态交互预览，不能作为 Host durable 证据；Live client/Host/Core 才提供实际账本路径。

## 6. 界面装配：`App.tsx` 与组件地图

`App.tsx` 只做三件事：装 `LanguageProvider`、用 `useSyncExternalStore` 订阅快照、把快照分发给组件。

```37:43:apps/web/src/App.tsx
function useSnapshot(client: WorkbenchClient) {
  return useSyncExternalStore(
    (listener) => client.subscribe(listener),
    () => client.getSnapshot(),
    () => client.getSnapshot(),
  );
}
```

### 6.1 三视图与装配点

根节点 `<div className={`app theme-${theme} ${view === "changes" ? "changes-mode" : ""}`}>`（`App.tsx:222`）内部依次是：`compact-gate`（<1024px 只读栅栏，223:230）→ `desktop-app`（231）→ `workspace`（233:291）→ 两个抽屉（293:298）→ `SettingsPanel`（300）。工作台内的互斥分支：

```233:237:apps/web/src/App.tsx
        <div className={`workspace ${view === "changes" ? "workspace-changes" : ""}`}>
          <Sidebar onChooseProject={chooseProject} onPreviewState={previewState} onReturnHome={() => void clie…} />

          {!snapshot.project && !run && <NoProject availableProjects={snapshot.availableProjects} connection={…} />}
          {snapshot.project && !run && <ProjectReady key={snapshot.project.id} onReasoningEffortChange={setRea…} />}
```

```281:289:apps/web/src/App.tsx
          {run && view !== "changes" && (
            <Inspector event={displayedEvent} scope={selectedEvidence} />
          )}

          {run && view === "changes" && (
            <main className="changes-workbench">
              <ChangesView diffs={selectedEvidence.diffs} edges={selectedEvidence.graphEdges} evidence={selectedEvidence.evidence} files={selectedEvidence.changedFiles} nodes={selectedEvidence.graphNodes} onJumpToPatch={jumpToPatch} onOpenDetails={() => setDetailsOpen(true)} patchId={selectedEvidence.patchEventId} verified={["available", "demo"].includes(selectedEvidence.evidence.test.status)} />
            </main>
          )}
```

- `MainView = "chat" | "trajectory" | "changes"`（`model.ts:294`），导航在 `RunHeader` 内渲染。
- 状态页与工作台页互斥：无项目无 Run → `NoProject`（236）；有项目无 Run → `ProjectReady`（237）；有 Run → 工作台（239）。
- **Inspector 有两种挂载方式**：常驻右栏（281:283，`view !== "changes"` 时）与抽屉（293:295，窄屏 / Changes 视图下复用同一份 `scope`）；测试日志用独立的底部抽屉（296:298）。同一份 `selectedEvidence` 既喂 Inspector 也喂 ChangesView，**证据投影只有一份**。
- **ChangesView 的 `verified` prop 直接来自测试证据槽位状态**（`["available","demo"].includes(...)`），验证标记不是本地布尔量。
- Chat / Trajectory 二选一在同一 `<main className="main-workbench">` 内切换（242:259），其中 `Trajectory` 的"回到尾部"由 `setTailFollowing(true); setSelectedId(null)` 两个动作共同表达（259）。

### 6.2 输入区：G-14 排队模式与审批控制面并存

运行中的 composer 不再消失。`running`、`indexing`、`awaiting_plan_approval` 与 Patch `needs_approval` 都渲染 `SteeringComposer`；Plan/Patch 审批组件仍独立保留，因此排队 `message` 或 `approve_hint` 不会绕过审批。`approve_hint` 只是下一模型安全点的用户提示，不是批准命令。只读项目也能使用 composer，因为输入只追加 Run Ledger，不扩大 Workspace capability。

composer 明示“将在下一步发送”，展示 canonical pending 队列和最近一次 `at_step`；普通提交、Plan/Patch/Todo mutation 各有 busy 门，但紧急 cancel 使用独立 busy 状态，不会因另一条普通命令在途而被误禁用。队列满或已有 cancel 时相应控件仍 fail-closed。`interrupted` / `needs_manual_review` 保留已恢复的 pending 队列展示，但 textarea 与 cancel 禁用；终态不再向旧 Run steering，而恢复为“新任务”输入。`reconnecting` 时 composer 与 Header Stop 都禁用，避免把网络未知状态误当成功。Stop 按钮与 composer 的“安全取消”均排队 `kind:"cancel"`，在 canonical `run.cancelled` 到达前不终止 SSE 或伪造终态。

```apps/web/src/App.tsx
<SteeringComposer
  disabledReason={run.status === "interrupted" ? "Resume the Run first." : null}
  pending={run.inputQueue.pending}
  onSubmit={() => void submitSteering()}
  onCancel={() => void cancelRun()}
/>
```

输入框的回车提交显式排除输入法组合态（`!event.nativeEvent.isComposing`），避免中文输入法选词时误提交。

### 6.3 组件地图

| 组件 | 行数 | 职责 |
| --- | --- | --- |
| `WorkbenchStates.tsx` | 354 | `NoProject` / `ProjectReady` / `ChatView` / `ChatTurn` / `PublicModelSurface` / `ContextBudgetStrip` |
| `MarkdownContent.tsx` | 293 | 回答渲染：代码块、表格、列表，` ```mermaid ` 块渲染为图形（`MarkdownContent.tsx:44`，懒加载后在主题切换时重绘） |
| `ChangesView.tsx` | 195 | 变更视图：diff、架构增量、验证证据 |
| `Inspector.tsx` | 170 | 事件详情（按 §3.4 推导出的标签页） |
| `SettingsPanel.tsx` | — | 主题、模型配置、G-19 凭据安全状态、G-06 权限 preset/ceiling/source/lock、G-15 sink 健康，以及 G-17 扩展状态/reload |
| `Sidebar.tsx` | 133 | 项目列表、状态预览切换、返回首页 |
| `Trajectory.tsx` | — | 持久化事件轨迹（可选中、可回到尾部）、G-07 只读 child ledger 与 G-18 verified attachment 折叠卡片 |
| `AttachmentComposer.tsx` | — | G-18 新 Run 文件选择/拖放、本地类型/大小/数量提示、默认 offload 与显式 image inline |
| `SandboxBadge.tsx` | — | mode/enforcement/platform 与 mechanisms/unmet 详情；full/partial/none 分别绿/黄/红 |
| `ContextBudget.tsx` | 88 | 上下文预算详情（来源分色条 + 阈值 + 压缩说明） |
| `Icon.tsx` | 87 | 图标集合（内联 SVG） |
| `Primitives.tsx` | 80 | `BrandMark` / `StatusPill` / `IconButton` / `SectionLabel` / `Notice` |
| `ApprovalStrip.tsx` | 35 | 审批条（风险、文件数、+/−、过期时间、回滚可用性、证据就绪状态） |
| `TodoPanel.tsx` | — | canonical Todo 列表、依赖、证据跳转与用户状态修改；终态/中断/人工复核时禁写 |
| `TeamPanel.tsx` | — | G-08 canonical roster/task board/mailbox；只开放 create、active-member steer 与 task cancel，Replay/不可变 Run 禁写 |
| `PlanApprovalBanner.tsx` | — | 展示并批准精确 `plan_event_id`；Todo 写入或批准提交期间交叉禁用 |
| `SteeringComposer.tsx` | — | G-14 message/approve_hint 排队、pending/last-consumed 展示与安全 cancel；不提供 dequeue |
| `ReasoningEffortPicker.tsx` | 34 | 推理强度选择（6 档） |

#### 6.3.1 G-19 凭据状态

`SettingsPanel` 把 Host 返回的 `credential` 映射成四项只读信息：backend（macOS Keychain / Private local file / Environment）、source name、writable、last updated。它不接收 secret reference，也没有 value 字段。

- `credentialStatusForProvider()` 只在快照 provider 与当前选择一致时复用状态，切换 provider 不会误把旧 Key 显示为可用。
- 环境 backend 的 `writable: false` 会把整组模型设置视为进程级只读；即使用户切到另一 provider，Key 输入和保存按钮仍禁用并提示修改环境变量后重启。Web 不伪装成能覆盖只读来源，Host 也独立返回 `409`。
- 保存成功后立即清空组件内 `apiKey`；有现存可写凭据时，留空表示复用同一 provider 的已有引用，输入新值表示轮换。
- `SettingsPanel.test.tsx` 断言安全来源元数据与环境只读提示、渲染结果不含 secret value，并验证切换 provider 时不会复用上一家的凭据状态。

#### 6.3.2 G-13 Sandbox 徽标

`App.tsx` 在 Run header 渲染最新 durable `sandboxReport`；`Trajectory` 在 sandbox lifecycle 与携带执行期报告的 Tool 行渲染 compact 徽标。`SandboxBadge` 的 title 展开 mode、enforcement、platform、active mechanisms 与 unmet constraints。绿色只代表报告为 `full`，黄色代表 `partial`，红色代表 `none`（包括显式 danger），颜色不会把 requested mode 冒充成实际隔离。

StartRun/StartChat 的 Web/SDK 输入没有 permission/sandbox 字段。设置页虽然能切换 G-06 preset，但只能提交 Host 广告的 key，不能逐 Run 指定 mode，也不能超过 CLI/env ceiling；因此它不能把受限 Host 升级为 full-write。Run 顶栏的 permission badge 与 sandbox badge 分开：前者说明冻结的请求策略，后者说明平台实际 enforcement。

#### 6.3.3 G-06 权限设置与解释

`PermissionSettingsSection` 只渲染 strict 公共快照：当前 preset、固定的 sandbox/approval pair、source、ceiling、available presets 与 lock reason。按钮只来自 `available_presets`；locked 时全部禁用，选择 `full-write` 时明确警告“关闭 sandbox isolation 且写入不询问”。保存经 `configurePermissionPreset({preset_key})` 进入 Host，成功后刷新同一 bounded snapshot。

设置页不会展示/编辑 Host/project rule 或 path scope。文案明确“changes apply only to new runs”；活动与历史 Run 继续显示其 `permission.configured` 快照。Trajectory 的 policy 行展示 Host 提供的人类可读 explanation 与 rule/source，但这只是可审计解释，不是浏览器自行求值。非 Patch policy `ask` 不在 Web 弹出通用审批框：它由可信 Host `approvalAnswerer` 自动处理；Patch `ask` 仍由现有 `ApprovalStrip` + Web/SDK 手工 `approve/reject`。policy `allow`（包括未被规则收紧的 `full-write`）不会产生 pending approval，因此也不会显示审批条或伪造 request/grant/token。

#### 6.3.4 G-09 Todo 面板与 Plan revision

`Trajectory` 顶部直接渲染 `run.todos`。每项展示 state、`depends_on` 与 `evidence_event_ids`；证据按钮跳到对应 durable Event。用户勾选或选择状态时只提交 strict Todo mutation，project/run/actor 仍由 Host 绑定。`completed/failed/cancelled/historical/interrupted/needs_manual_review` 禁写；Plan 批准请求在途时 Todo 也禁写，反方向上 Todo mutation 在途会禁用批准按钮，避免页面内并发制造陈旧 revision。

`PlanApprovalBanner` 显示 Todo 数与当前 `plan_event_id`，按钮语义是“批准这一版并执行”。若另一客户端先修改 Todo，Host 会拒绝旧 revision；live client 随即刷新 Projection，展示新的 pending revision，而不是盲重试。等待审批期间 canonical stream 保持连接，以接收跨客户端 Todo/Plan 更新；批准成功后从返回 Projection 的 `last_sequence` 继续消费 execute 阶段，避免旧 `plan.ready` 被重放成新的暂停边界。

#### 6.3.5 G-14 Steering、队列与取消

`LiveTraceGraphClient.submitUserInput()` 先检查 Run 可变状态，再调用 typed SDK，随后重新读取 canonical Projection；网络响应中的 queued receipt 与最终 consumed/terminal 是两个事实。每个 `{run_id,kind,body}` 提交尝试在完整确认前保留同一组 `input_id/command_id`，因此 Host 已提交但响应丢失时，用户 retry 会命中 durable duplicate 而不是新增输入。pending 输入可跨刷新/恢复由 Ledger 投影回来，页面不把本地 React state 当队列。消息只在 Runtime 安全点消费；`Trajectory` 的 `step N` 徽标来自 `user.input_consumed.data.at_step`。

所有同 Run Projection 只允许 `last_sequence` 单调前进；SSE refresh 与 steering 后 refresh 还要同时通过 stream generation 与 current-run guard。用户切换 Project/Run 后，旧流或旧请求的晚响应会被丢弃，不能用较老状态覆盖已观察到的 cancellation，也不能把工作台导航回旧 Run。

取消也走同一路径，但不会从 pending 列表“删除一条消息”：`cancel` 的含义是取消整个 Run，也是普通 FIFO 的 control-lane 例外。它可越过更早普通输入；这些输入仍留在 cancelled Projection 中，明确表示未交给模型。模型流可尽快中断，工具/WAL 则必须到安全边界；Web 保持 SSE，直到 canonical `run.cancelled`。已提交 patch 不由这里自动回滚，回滚仍是 G-04 的独立控制面。

#### 6.3.6 G-15 Telemetry 只读状态

`App.tsx` 只把 `client.getTelemetryStatus()` 作为 `onGetTelemetryStatus` 交给 `SettingsPanel`。面板打开时读取一次 strict `TelemetryStatusSnapshot`，`TelemetrySettingsSection` 展示当前 `disabled|active|degraded`、sink label、export error count 与可选 last error；加载/失败也只影响该诊断区，不影响模型/权限设置。旧 Host 返回 404 或旧 SDK port 缺失方法时，面板呈现 unavailable/错误文案，不显示伪造的 noop 健康快照。

这里没有 endpoint 输入框、header/authorization 控件、启停按钮或保存请求。浏览器不能看到 `<dataDir>/telemetry.json` 路径、环境变量值、G-19 secret reference 或 OTLP queue payload。该状态也是进程内快照：刷新可重新读取，但 Host 重启后的 error count/last error 会重置；Web 不把它存进 Run、Session 或本地恢复数据。

#### 6.3.7 G-17 扩展状态与 idle-only reload

设置面板打开时通过 `listExtensions()` 读取 Host 的 strict 状态，只显示 name、state、generation、registration count 与有界错误。reload 只提交选中的扩展名；module、配置路径与代码内容从不进入浏览器。按钮在任一 reload 在途时统一禁用，Host 若因 active Run lease 返回冲突，页面只展示错误，不伪造已切换状态。

Replay 模式下设置入口和面板本身都关闭，`LiveTraceGraphClient.reloadExtension()` 还会经过 `assertLiveWritable()`，Host 的 replay authority gate 则提供第三道拒绝。因此“按钮不可见”不是唯一安全边界。当前 Web 没有安装/上传插件、编辑 `extensions.json`、运行任意 extension command 或注入扩展 UI 的能力。

#### 6.3.8 G-08 Team 面板

`App.tsx` 把 `run.team`、每项 busy key、错误和不可写原因交给 `TeamPanel`。create/steer/cancel 都由 App 统一捕获错误并保持失败可见；组件不会先乐观改 owner/message/task state。`TeamPanel` 还会在 steer 失败/异常/响应不确定时保留 draft，仅在确认成功且 draft 未被用户继续编辑时清空。Replay 一进入 loading 就用与 Todo/审批相同的全局只读原因禁用 Team，Host replay bearer 再提供最终 403 防线。

### 6.4 审批条：把"能不能点"做成数据

审批按钮的可用性不是 CSS 层面的置灰，而是由 Host 给出的 `reviewReady` 决定：

```31:31:apps/web/src/components/ApprovalStrip.tsx
<button className="button primary" disabled={busy || !approval.reviewReady} onClick={onApprove} type="button">{t(busy ? "Applying…" : approval.reviewReady ? "Allow once" : "Verify full diff")}</button>
```

证据未就绪时按钮文案本身就是**下一步动作**（"Verify full diff"），点击被禁止；这就是"证据链先于批准"在界面上的落点（详见模块 05）。

### 6.5 状态提示条：每种异常都有稳定的解释

`StateNotice` 为每个非正常态给出固定措辞，其中 G-04 增加了独立人工复核提示：

```94:99:apps/web/src/App.tsx
  if (status === "indexing") return <Notice icon="search" title={t("Building the baseline graph")} tone="info">{scanScope ? … : currentStep}{indexedFiles === undefined ? ` · ${t("progress is event-based")}` : …} · {t("no percentage estimated")}</Notice>;
  if (status === "reconnecting") return <Notice action={<button className="button subtle" onClick={onRefresh} type="button"><Icon name="refresh" size={13} />{t("Retry now")}</button>} icon="refresh" title={t("Reconnecting to the local host")} tone="warning">{language === "zh-CN" ? `已保留最后一个持久化事件 #${lastSequence}。` : `Last durable event #${lastSequence} is preserved.`} {connectionMessage}</Notice>;
  if (status === "needs_manual_review") return <Notice icon="alert" title={t("Needs manual review")} tone="warning">{t("The workspace no longer matches the Action WAL. TraceGraph did not change files automatically.")}</Notice>;
  if (status === "failed") return <Notice icon="alert" title={t("Run stopped safely")} tone="danger">{currentStep}{language === "zh-CN" ? "。此前已提交的事件仍可检查。" : ". Earlier committed events remain available for inspection."}</Notice>;
  if (status === "cancelled") return <Notice icon="stop" title={t("Run cancelled")} tone="warning">{currentStep}</Notice>;
  if (status === "ready_for_review") return <Notice action={<button className="button primary" onClick={onReview} type="button">{t("Review changes")} <Icon name="chevron" size={13} /></button>} icon="check" title={t("Ready for review")} tone="success">{t("Patch, graph delta, and test receipt are linked and ready to inspect.")}</Notice>;
  if (status === "historical") return <Notice icon="clock" title={t("Historical run")} tone="info">{t("This projection is read-only. Opening it never executes tools.")}</Notice>;
```

- `indexing`：**明确声明不给百分比估计**（`no percentage estimated`、"progress is event-based"）。有文件计数就显示计数，没有就退回当前步骤——**不生成假进度**。
- `reconnecting`：**显示已保留的最后一个持久事件序号**并提供"立即重试"。UI 因此明确区分"连接断了"与"事件丢了"。
- `needs_manual_review`：明确说明 workspace 与 Action WAL 不一致、TraceGraph 没有自动修改文件；聊天内容也从 durable timeline 展示最后原因，不把 divergence 伪装成失败或完成。
- `failed`：强调"此前已提交的事件仍可检查"，不给"重试即恢复"的错觉；与之对称，`cancelled` 只显示停在哪一步。
- `ready_for_review`：提示"补丁、图增量、测试回执已链接且可检查"，并给一个直达 Changes 视图的按钮——把"三件证据齐了"当作一个可点击的事实。
- `historical`：打开历史投影**永不执行工具**，这条承诺写在界面上。

### 6.6 窄屏只读门槛

小于 1024px 时工作台整体降级为只读提示（`.compact-gate`，`App.tsx:223:230`），不提供隐藏功能的移动端布局——这是刻意的能力声明，避免"在手机上看起来能用但看不到 diff"的误导。

## 7. 会话呈现：公开面规则

Chat 视图的难点不是排版，而是**"哪些内容有资格出现在用户面前"**。

### 7.1 三层内容来源

```209:228:apps/web/src/components/WorkbenchStates.tsx
const persistedPlans = process
  .filter((event) => event.kind === "decision" && event.state === "succeeded" && Boolean(event.rationale ?? event.summary))
  .map((event) => ({ ... type: "public_plan_snapshot", text: event.rationale ?? event.summary }));
// Older Hosts may still send a `thinking_snapshot` … Treat it as compatibility data, never as public UI content.
const safeModelSurface = modelSurface?.filter((item) => item.type !== "thinking_snapshot") ?? [];
const visibleSurface = safeModelSurface.length > 0 ? safeModelSurface : persistedPlans;
```

1. **模型公开面流**（`public_plan_snapshot` / `answer_snapshot`）——优先级最高。
2. **持久 Decision 事件**——快速流缺失时，用已落账的计划文本兜底（`persistedPlans`），因此断线重连后不会出现"过程空白"。
3. **供应商私有思考**——**永不出现在 UI 中**，`thinking_snapshot` 只被解析、不复用。

### 7.2 快速流与持久流在同一序列号上合并

```277:291:apps/web/src/components/WorkbenchStates.tsx
function publicProcess(events, liveActivities = []): TraceEvent[] {
  const visibleKinds = ["run","context","decision","tool","approval","patch","graph","test"] as const;
  // The rapid feed arrives before the durable event projection. As soon as
  // the canonical source event is available, it replaces the compact live
  // row at the same sequence. This avoids fake thinking text and duplicates.
  const process = new Map<string, TraceEvent>();
  for (const activity of liveActivities) process.set(activity.sourceEventId, traceFromLiveActivity(activity));
  for (const event of events) if (visibleKinds.includes(event.kind)) process.set(event.id, event);
  return [...process.values()].sort((l, r) => l.sequence - r.sequence);
}
```

合并键是 `sourceEventId`，与快照事件的 `id` 同源，所以**先到者被后到的权威版本覆盖，不产生重复行**。`traceFromLiveActivity()` 把活动状态映射为 `TraceEvent.state`（`started→running`、`cancelled→denied`），并把 `kind: "model"` 归一为 `decision`。

### 7.3 回答与"正在进行的回答"

- 未结束前：若有 `answer_snapshot` 文本，直接流式渲染（带光标 `▍`）；否则显示"正在分析请求并等待下一步公开计划…"。
- 结束后：渲染 `outcome`；`needs_approval` 时回答位置改为**审批关口说明**（提示先审查 diff 与证据再放行）。
- 失败/取消：优先 `outcome`，否则回退到最后一个事件的 `summary`，并明确"本次运行没有生成最终回答"。

### 7.4 上下文预算条

`ContextBudgetStrip` 用一条进度轨显示 `usedTokens / inputBudgetTokens`，并在轨上标出**预警阈值**与**压缩阈值**两个刻度，页脚给出窗口、输出预留、`turnsCompleted / turnLimit`（编排轮次硬上限，与 token 预算相互独立）。详情面板 `ContextBudget.tsx` 则按来源分色、逐行给出 `originalTokens→tokens`、动作（pinned/kept/truncated/masked/externalized/retrieved）与原因，并说明本次压缩实际生效的旧单策略或 G-02 `strategy_chain`。字段语义与阈值计算见模块 03。

G-02 不会在加载 Manifest 时预取所有被替代原文。`mapContextSources()` 只把**当前 Manifest active item** 的 `artifact_ref` 映射成 `status:"idle"` 的 locator；用户真正展开 `View compressed source` 的 `<details>` 后，`ContextBudget` 才调用 `LiveTraceGraphClient.loadContextArchive()`。client 会再次确认 run id，并确认该 Artifact 仍被当前快照或所选历史事件的 active Manifest item 引用，才走公开 Artifact API；仅出现在旧 `compaction_steps[].archived_artifact_refs`、但不再属于 active item 的工件不能借 UI 直接加载。超过公开 1 MiB 上限、不可用或 hash 损坏时显示对应状态，不用浏览器绕过 Host Artifact 边界。

G-03 在同一面板明确分成两块：

- **Budget estimate** 来自 Context Manifest / `context.built.data.token_estimate`，显示 estimator、`estimated|calibrated` confidence、input/estimated output 与六类 `perSection`。真正的输出预留另由 `reservedOutputTokens` 展示；这里的 `output_tokens` 不是 allowance。这是 preflight allocation，不是 provider-exact section breakdown；当前实现不会显示 preflight `exact`。
- **Provider reported usage** 来自 durable `model.usage_reported`，显示 provider/model、initial / repair / summary、input/output/total、可选 cache/reasoning、成本可用性与 anomaly。只有 provider 明确返回 amount + currency 才显示成本，否则显示 `Cost unavailable`。Decision Context 与 summary 使用不同 `model_call_id`，不会合并成一笔伪总账。

`LiveTraceGraphClient` 不按数组位置随意拼接：它用 Context 的 `model_call_id` 反查相同 call 中 sequence 最大的 usage，anomaly 还必须同时匹配 `request_kind` / `request_sequence` 并明确为 true。因此打开历史 Session 后仍能从 canonical timeline 重建；同一 call 若发生 repair，界面展示最新 repair 这一个请求的 usage，并标出 `Repair request #N`，不会继承较早 initial 的 anomaly。这里不是 initial+repair 的会话聚合账；两条原始事实仍都保留在 durable timeline。`ModelSurfaceEvent` 仍只是易失回答画面，不承载 usage 真相。

> `ContextBudget` 只展示真实存在的 Context source。Runtime 注入 `memory` / `retrieved` 项时，它们会按普通来源显示；未命中时不会伪造占位项。

## 8. i18n 与主题

### 8.1 文案即 key

`Language = "zh-CN" | "en"`（`i18n.tsx:3`），但仓库里**只有 zh-CN 词典**（`zhCN`，`i18n.tsx:7:342`）。`t(text)` 以英文原文为 key 查表，查不到就原样返回：

```344:354:apps/web/src/i18n.tsx
interface I18nValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (text: string) => string;
}

const I18nContext = createContext<I18nValue>({
  language: "en",
  setLanguage: () => undefined,
  t: (text) => text,
});
```

- 好处：不需要维护 key 命名与英文词典两份产物。
- 代价：漏翻译时**静默回落英文**而不是报错（评审时靠肉眼）。
- `t()` 不做模板变量插值；需要拼数字/字符串的地方直接用 `language === "zh-CN" ? … : …`（§6.5 已见），这也是 `language` 会出现在组件 props 里的原因。

### 8.2 语言持久化

```356:368:apps/web/src/i18n.tsx
function initialLanguage(): Language {
  if (typeof window === "undefined") return "en";
  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (saved === "zh-CN" || saved === "en") return saved;
  return window.navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(initialLanguage);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, language);
    document.documentElement.lang = language;
  }, [language]);
```

存档键为 `tracegraph.language`（`i18n.tsx:5`）；判定顺序是**存档 → 浏览器语言（zh 前缀）→ 兜底 `en`**；`typeof window === "undefined"` 时直接返回 `en`，这正是组件测试能在 node 环境下跑的前提。

### 8.3 主题：必须靠事件而不是 CSS 提醒图表重绘

主题与推理强度分别存在 `tracegraph.theme` / `tracegraph.reasoning-effort`（`App.tsx:19:20`，读取见 24 / 33，写回见 127 / 133）。主题变更不只是写存档：

```127:130:apps/web/src/App.tsx
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    document.documentElement.style.colorScheme = theme;
    window.dispatchEvent(new CustomEvent("tracegraph:themechange", { detail: theme }));
```

- 同步 `colorScheme` 让浏览器原生控件跟随。
- 广播 `tracegraph:themechange` 的唯一订阅者是图表层（`MarkdownContent.tsx:249`，卸载时在 252 移除）：**mermaid 渲染出的 SVG 配色不会随 CSS 变量自动变化**，必须显式重绘。这是一条"样式系统边界"上的必然妥协。
- 调色板集中在 `styles.css` 顶部：共享字体令牌与基础色在 `:root`，组件级颜色令牌定义在 `.app` 作用域内；主题切换依赖根元素类名 `app theme-${theme}`。
- 设置面板里的"外观"是两张带小样预览的按钮（`SettingsPanel.tsx:126:135`），`aria-pressed` 标记当前项。

## 9. 测试

```33:36:apps/web/vite.config.ts
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
```

测试环境是 **node，不是 jsdom**；组件测试用 `renderToStaticMarkup` 出静态标记再断言字符串：

```1:6:apps/web/src/components/WorkbenchStates.test.tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../i18n";
import type { EvidenceSnapshot, TraceEvent } from "../model";
import { ReasoningEffortPicker } from "./ReasoningEffortPicker";
import { ChatView } from "./WorkbenchStates";
```

| 测试文件 | 重心 |
| --- | --- |
| `src/live-client.test.ts` | 三条流、重连/投影合并、审批前置校验；G-02 archive；G-03 usage；G-05 batch；G-06 bounded preset；G-13 sandbox；G-08 create/steer/cancel 的稳定 command id、scope 复核与 Replay 拒写；G-09 Plan wait；G-14 readonly queue/cancel、lost-response stable id、单调 Projection、跨 Run 晚响应、canonical `at_step` 与 cancel 不提前 abort SSE；G-15 strict 只读 status；G-17 strict extension list/reload 与 Replay 写拒绝；旧 SDK 缺方法时显式 unsupported |
| `src/live-client.test.ts`（G-07） | Session 查询显式 `view:roots`；child 按父关系懒加载；父状态变化、return-home 与 replay 清除 stale cache；replay 下拒绝 child 读取 |
| `src/App.test.tsx` | G-14 active/approval 状态 composer 可用；readonly 可用；terminal/interrupted/manual/reconnecting 禁用，Header Stop 与 composer 一致 |
| `src/components/SteeringComposer.test.tsx` | pending/last-consumed 展示、queue kind、queue-full/cancel 去重语义、恢复态禁用与普通命令 busy 时紧急 cancel 仍可用 |
| `src/components/SandboxBadge.test.tsx` | full/partial/none 色调、mode 文案与相关 Trajectory 行的 compact badge |
| `src/components/ContextBudget.test.tsx` / `WorkbenchStates.test.tsx` | G-02 外置原文只有 disclosure 打开后才加载并用稳定 item id 渲染；preflight/provider report 标签、成本/anomaly 分离 |
| `src/components/WorkbenchStates.test.tsx` | Chat 公开面规则、calibrated estimate 与 provider usage/cost/anomaly 同屏但不混淆；WAL divergence 呈现为静态人工复核态 |
| `src/model.test.ts` | 纯函数与选中证据解析 |
| `src/components/ChangesView.test.tsx` | 变更视图与验证标记 |
| `src/components/SettingsPanel.test.tsx` | 设置面板；只显示 Host-advertised permission presets、full-write 警告、locked 禁用、安全凭据状态、Telemetry sink/state/error/last-error，以及扩展 state/generation/contribution/error/reload；断言敏感配置不进入标记 |
| `src/components/MarkdownContent.test.tsx` | Markdown 与 mermaid 分支 |
| `src/components/ApprovalStrip.test.tsx` | 审批条可用性 |
| `src/components/SessionNavigation.test.tsx` | Session 搜索/恢复/删除控件，中断与只读恢复提示 |
| `src/components/TodoPanel.test.tsx` | Todo 状态、依赖/证据呈现、禁写原因、Plan approval banner 的 exact revision 与 busy 交叉禁用 |
| `src/components/TeamPanel.test.tsx` | roster/heartbeat/task version/acceptance/evidence/mailbox 呈现；steer/cancel/create 的状态禁用与 Replay 只读文案；steer 仅在确认成功后清空，失败/异常/不确定结果与并发编辑保留 draft |

`live-client.test.ts` 自带一个实现 `TraceGraphSdkPort` 的**假 SDK**，并用 `@tracegraph/contracts` 的 `PROJECTOR_VERSION` / `SCHEMA_VERSION` 构造符合 schema 的 `RunProjection` / `WireSessionEvent`，同时准备 `disposable_fixture`（全能力）与 `readonly_local`（`commit_patch: false`）两类项目。它还断言只读项目可以追加 Ledger-only steering、cancel 不调用 legacy stop 且不提前 abort SSE，以及 consumed `at_step` 来自 canonical Projection；具体写工具的 capability/policy 拒绝仍由 Core 测试覆盖。

用例名直接写意图，例如 `renders actual durable tool facts without inventing a model thought narration`（`WorkbenchStates.test.tsx:17`），与 §7.1 的规则一一对应。

**测试缺口**：有 SSR 结构与 live-client 行为测试，但没有 jsdom/testing-library 的真实 DOM 键盘与连续点击测试；回车组合态和按钮事件处理仍主要靠代码审查。

## 10. 已知缺口

1. **Web 不装配任何 provider**：`codeGraph` 全仓仅出现在 `apps/cli/src/composition.ts`，`packages/host/src` 零引用。走 Web / 一体部署路径时，Architecture Delta 只能来自 Host 已装配的投影；若 Host 未装配 `CodeGraphProvider`，界面上这一块没有数据来源（详见模块 07、模块 11）。
2. **每条持久事件后都做一次全量 `getRun`**（`live-client.ts:497:499`）：事件密集时是 O(N) 次投影往返，没有合并或去抖。这是本模块最明显的性能债。
3. **浏览器仍无本地持久化**：`conversations` / `liveActivities` / `modelSurface` 在内存 Map，刷新即丢；Host 的 durable Session 能恢复列表、最后一个 Run 投影和特定的待审批状态，但不会替 Web 自动重建跨多个 Run 的完整 conversation transcript。瞬时活动/模型面也不会被 Session JSONL 复制。
4. **`previewState` 语义双关**：demo 下是"切换原型状态"（并**硬编码选中 `evt_012`**，`App.tsx:156:160`），live 下只等价于"立即重试 SSE"（`live-client.ts:366:372`）。同名方法承载两套语义，对读代码的人是负担。
5. **`thinking_snapshot` 仍在线上协议里**：旧 Host 仍可能发，Web 侧靠三处防线拒绝（Runtime / 渲染器 / 客户端边界，`live-client.ts:542:545`）。属于应收敛的历史字段。
6. **ContextBudget 不伪造来源**：它只展示真实存在的 Context source；Runtime 注入 `memory` / `retrieved` 项时按普通来源显示，未命中时不会伪造占位项。
7. **窄屏只读**：<1024px 只给一张提示卡（`App.tsx:223:230`）。这是能力声明而非缺陷，但它是"Web 不是 vscode/IDE 替代品"的边界说明。
8. **没有浏览器 DOM 级交互测试**：见 §9。SSR 已覆盖状态分支，live-client 已覆盖行为，但输入法组合、焦点与快速连续点击仍没有 jsdom/testing-library 或真实浏览器回归。
9. **快速流在旧 Host 下静默缺失**：`streamLiveActivities` / `streamModelSurface` 在 `TraceGraphSdkPort` 上是可选方法，缺失时 Chat 视图回落到 `persistedPlans`（§7.1）——用户看到的是"滞后的计划公开面"而不是"在飞的活动"，且降级不提示，只写在代码注释里。

10. **Web 没有 provider-exact 逐 section 数据。** 它忠实展示 Manifest 的 preflight allocation 与 provider 回报总量，不能把后者反推到 system/history/tool 等 section；provider 已返回但 usage Event 尚未持久化的崩溃窗口也只能显示 estimate。

11. **Web 尚无 rollback 操作控件或 Recovery report 导出。** 客户端已能映射 `action.verified/reconciled/diverged/rollback_refused`、`patch.rolled_back` 与 `needs_manual_review`，SDK 也有 rollback 方法，但页面只负责展示这些 durable 事实；显式回滚当前必须直接调用 Host API/SDK，且 Runtime 策略默认关闭。

12. **Sandbox 徽标不是控制面或平台保证。** 它只呈现 Host 已记录的 report；Linux/Windows `none` 不会因红色徽标变成可执行 backend，模型网络/`commit_patch` 也不在 child sandbox。<1024px 的既有 compact gate 会隐藏 header metrics，因此顶栏徽标可能不可见，但相关 Trajectory 行仍显示 report。

13. **Permission UI 不是 policy editor。** 浏览器只能选择 Host 广告且不高于 ceiling 的 built-in preset；不能查看/修改完整 rules/path scope，也不能逐 Run 热覆盖。选择保存后只影响新 Run，恢复继续使用冻结 policy。`full-write` 警告不能替代 OS 隔离；该 preset 本身就是显式 opt-out。

14. **Todo UI 不是完整计划编辑器。** 当前页面能查看依赖/证据并修改既有 Todo 状态，但没有创建 Todo、改标题/详情或可视化编辑依赖图的表单；这些能力存在于 strict Host/SDK 契约与模型工具面。Plan 也只有整版批准，没有局部批准或多方案对比。

15. **Steering UI 没有 dequeue/reorder。** G-14 普通输入按 durable FIFO 消费；`cancel` 是可越过普通输入的控制通道，用来取消整个 Run，不是删除 pending item。页面支持 `message`、`approve_hint` 与安全 cancel，但不会改写已经排队的输入；legacy stop 仅留在 SDK/Host 兼容面。

16. **Telemetry UI 只有当前进程的只读快照。** 它不能修改 sink、endpoint 或 authorization，也不能证明 Collector 已收到/持久化数据；Host 重启会丢失 error count/last error 与内存 queue。旧 Host/SDK 不支持 status 时 Web 显式报错，不伪造 noop。Web 不从 status 恢复 Run，更不会把它与 durable Ledger 混为一谈。

17. **G-08 Team 面板不是完整 worker scheduler。** G-07 子任务卡仍只能展开父投影已记录的 direct child，不能 spawn、send、interrupt、resume、重排或编辑 Session 树；进入 replay 时也不加载 child。Team 面板新增 durable roster/task board/mailbox 的证据视图与用户 steer/cancel，但没有 worker join/claim/heartbeat/sweep、自动重启/重派或跨 Host 调度控件，单个 spawn 仍由 Runtime 同步阻塞。

18. **G-17 设置区不是插件管理器或扩展 UI host。** 页面只能查看 trusted catalog 状态并请求 idle-only reload；不能安装/卸载任意 package、编辑配置、执行扩展命令、注入菜单/面板或在活动 Run 中 HMR。

## 11. 相关文档

- 模块 09 §13：三条流在界面上的分工（本模块是其消费者）
- 模块 05：证据链与账本投影（`eventEvidence` 的上游语义）
- 模块 06：模型适配与推理强度（`ModelProvider` / `ModelProtocol` 与 Anthropic 路径差异）
- 模块 03：Context 预算与压缩阈值
- 模块 11：CLI 与装配（Web 不在该装配路径上；`codeGraph` 仅于此处装配）
- 根目录 `KNOWN_LIMITATIONS.md`：Telemetry best-effort、进程内状态与外部 Collector 未验证边界
- 模块 15：G-17 受信扩展生命周期、配置安全与 Web 控制面边界
- 模块 16：G-08 root-Ledger Team、Web 三项受限 mutation 与明确调度边界
