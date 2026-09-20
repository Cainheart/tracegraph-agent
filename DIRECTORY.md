# TraceGraph Agent 目录结构说明

> 用途：说明本仓库每一个源文件/配置文件的职责，便于快速定位改动点。
> 范围：只列源码、配置与文档。`node_modules/`、`dist/`、`coverage/`、`*.map`、`*.tsbuildinfo`、`.vite-tracegraph/` 等构建与依赖产物不在说明范围内；与源码同目录的逐文件单元测试（`*.test.ts` / `*.test.tsx`）也不逐个列出，只保留三个跨层套件，约定见第 3 节第 5 条。
> 标注约定：行内 `**尚未接入**` 表示文件已存在但没有任何调用方 —— 这类文件不计入"已实现能力"。
> 最后核对：2026-09-19

## 0. 一句话背景

TraceGraph Agent 是一个本地优先（local-first）的 **Web Coding Agent**：pnpm workspace + strict TypeScript 单仓多包，核心把 Agent 的 Decision / Tool / Approval / Patch / Test / Context / 代码架构变化放进同一条可回放轨迹。Web 前端（React + Vite）通过 typed SDK 连本机 Fastify Host（`127.0.0.1:4311`），Host 驱动 Core Runtime。

数据流：

```text
apps/web (React)  --HTTP/SSE-->  apps/cli 组装的 Host (packages/host)
                                     |
                                     v
                              packages/core (Runtime)
                                     |
           ┌─────────┴─────────┬───────────┬──────────────┐
           v                   v           v              v
 packages/retrieval   packages/codegraph  contracts     telemetry
  (JSONL/BM25)                         (Zod 契约)     (旁路 sink)
```

## 1. 目录树

```text
tracegraph-agent/
├── README.md                    项目说明：已实现能力、快速运行、项目模式与边界声明
├── README.en.md                 英文入口：五分钟启动、验证、私有发布与安全边界
├── CHANGELOG.md                 双语版本变更记录；发布校验要求当前版本有带日期条目
├── KNOWN_LIMITATIONS.md         已知限制的唯一事实源（Runtime/Context/Evals/Host/Web）
├── NOTICE.md                    独立实现声明：不复制 DeepSeek Harness/Claude Code/Codex/Pi 源码与品牌
├── LICENSE                       MIT 许可证
├── DIRECTORY.md                  本文件：目录与文件职责说明
├── package.json                  根脚本：clean build、typecheck、unit/E2E/evals、coverage、供应链校验、私有 release bundle、dev/serve 与可选 retrieval:serve；Node ^22.19
├── pnpm-workspace.yaml           workspace/catalog/allowBuilds，以及 exact、time-based、24h 冷却、exotic subdep 阻断与 exact override
├── pnpm-lock.yaml                依赖锁文件（由 pnpm install 生成，勿手改）
├── tsconfig.base.json            共享 TS 编译选项（ES2023、NodeNext、strict、exactOptionalPropertyTypes 等）
├── tsconfig.evals.json           G-16 评测源码 strict 静态检查，由根 typecheck 调用
├── vitest.evals.config.ts        G-16 独立 Vitest 收集/离线守卫/有界 reporter；不进入 pnpm test
├── vitest.coverage.config.ts     G-22 V8 全量生产源码覆盖率配置；summary 交给独立 fail-closed checker
├── .npmrc                        `save-exact=true` 的 npm/pnpm 兼容兜底；完整供应链策略在 pnpm-workspace.yaml
├── .editorconfig                 编码/换行/缩进统一规范（2 空格、lf、md 保留行尾空格）
├── .env.example                  模型与 Host 配置模板：provider/protocol/Base URL/模型名/Key、G-06 Permission、G-17 extension-config 路径、G-18 显式 image-input capability、轮次/rollback，以及仅在 telemetry.json 显式启用后读取的 OTLP endpoint 示例
├── .gitignore                    忽略 node_modules、dist、coverage、.tracegraph、.env.local 等
│
├── .github/workflows/
│   ├── ci.yml                    三个独立 job：typecheck / test+coverage+supply-chain / offline evals；安装前先校验 manifests
│   └── release.yml               仅 v* tag：跑完整门禁并上传 checksummed private workspace bundle
│
├── scripts/                      G-22 工程门的仓库自有实现与失败注入测试
│   ├── clean-dist.mjs            只清理 apps/*、packages/* 中 manifest-owned 的非 symlink dist；build 前消除陈旧产物
│   ├── clean-dist.test.mjs       注入 rogue 目录与 symlink，证明清理边界 fail-closed
│   ├── check-coverage.mjs        重发现全部生产 TS/TSX 并核对 summary、全局/关键域 line coverage 门
│   ├── check-coverage.test.ts    缺文件、伪造 total、路径与阈值下降等失败注入
│   ├── verify-lockfile.mjs       exact/catalog/workspace、pnpm/config/lockfile、来源与 frozen drift 审计
│   ├── verify-lockfile.test.mjs  manifest、config、source、override 与 stale lockfile 反例
│   ├── verify-release.mjs        版本/tag/CHANGELOG/bin/export/体积校验、SHA-256 manifest 与 clean staging bundle
│   └── verify-release.test.mjs   rogue dist、tag/changelog/出口缺失、非 dist target 与 staged bytes 反例
│
├── .tracegraph/                  【运行时数据目录，已 gitignore，非源码】
│   ├── events/                   每个 Run 一份 run_*.jsonl：append-only 的 canonical Event Ledger
│   ├── artifacts/                不可变 Artifact：Diff、Context Manifest、G-02 外置原文/spill、内部 recovery_state；root 0700、data/meta 0600，拒绝 symlink root
│   ├── attachments/              G-18 私有 staging/claim/ingested/lookup；默认 15 分钟 staging TTL，原始文件最终进入 scoped Artifact
│   ├── wal/                      G-04 Patch Action WAL 与私有 before-image；hash chain、0600、原子替换与 fsync
│   ├── recovery/                 G-04 恢复 recipe 尝试台账；自动尝试上限、失败/升级状态与 Markdown 导出来源
│   ├── memory/records.jsonl      G-21 canonical Memory records；通过候选 scope/source/trust 评估后 append
│   ├── retrieval-index/          G-21 按 project hash 隔离的原子 JSONL/BM25 可重建索引；保留 last-good backup
│   ├── projects/                 Host 创建的受管项目（含 .tracegraph-project.json 元数据）
│   ├── chat-workspace/           Plain Chat 绑定的隐藏空工作区（无 Workspace 文件能力；仅可回读本 Run Context archive）
│   ├── local-projects.json       本机原生选择器登记过的本地目录表（权限 0600），Host 重启后据此恢复
│   ├── model-config.json         模型配置持久化（权限 0600，只含 `${secret:NAME}` 引用，不含明文 Key）
│   ├── token-calibration.json    G-03 provider/model 滑动窗口校准（默认 Runtime 路径；0600、原子替换）
│   ├── extensions.json           G-17 可选 strict data-only 配置；只选择 Host 内置 trusted catalog id，不是可执行模块路径
│   └── telemetry.json            G-15 可选服务端 sink 配置；缺失即 noop，endpoint 只写环境变量名、authorization 只写 G-19 secret reference
│
├── ~/.tracegraph/                【用户级运行时目录，位于仓库外；这里只说明默认布局】
│   ├── sessions/                 versioned Session JSONL：按 project hash 分目录，只含 header + Event 引用；目录 0700/文件 0600
│   ├── sessions-trash/           Session 软删除目标，与 sessions 为彼此独立的同级树
│   ├── harness-config.json       G-06 Host 私有权限选择（`config_version` + `permission_preset`，0600）；设置 API 经临时文件 + rename 原子更新
│   └── credentials.json          非 macOS 凭据回退文件（0600，仍是 plaintext-at-rest）
│
├── <受管 workspace 根>/.tracegraph/
│   └── policy.json               G-06 可选的项目级策略文档：每个新 Run 解析；只允许 ask/deny 收紧，拒绝 symlink、越界路径、超限或非法结构
│
├── evals/                      G-07/G-16/G-17/G-18/G-21/G-22/G-23 与 unit/E2E 分离的离线可执行评测
│   ├── README.md              运行、离线边界、报告、检索质量、性能基线与 Replay 确定性说明
│   ├── runtime/               9 条真实 Runtime 行为路径：approval / compaction / parallel tools / recovery / refusal / G-07 subagent / G-17 extension / G-18 attachment / G-08 Agent Team
│   │   ├── subagent-delegation.eval.ts  两个 child 的 6 条父账本回执、独立 Session/Ledger 与重放一致性
│   │   ├── extension-system.eval.ts      G-17 hook 错误隔离、内置扩展卸载后的 Tool surface 与 API mismatch
│   │   ├── attachment-multimodal.eval.ts G-18 超限拒绝、unsupported 零图片 block 与 PDF reference-only 降级
│   │   └── agent-team.eval.ts             G-08 mailbox restart、并发 claim 单 owner、member lost 原子 reopen 且不自动重派
│   ├── quality/               Context/CodeGraph 确定性对比，以及生产 retrieval 包的有/无检索任务成功率与引用准确率
│   │   ├── memory-context-quality.eval.ts      受控 Memory record 对 Context 选择的隔离评测
│   │   ├── codegraph-diagnostics-quality.eval.ts CodeGraph diagnostics 基线/增强对比
│   │   └── retrieval-rag-quality.eval.ts       G-21 真实 ingest/search/read-back 链与 citation line 核验
│   ├── replay/
│   │   └── time-travel.eval.ts  G-23 重启后逐 sequence projection/hash/anchor、结构化 forward diff 与只读 Ledger 回归
│   ├── perf/
│   │   └── performance.eval.ts  Context token、model call、Tool P95、loopback SSE 首字节四门，含过低门限反例
│   ├── docs/
│   │   ├── implementation-consistency.eval.ts  白名单式标识符/版本/Event/Host route/script 审计
│   │   └── g22-release-consistency.eval.ts     CI pin/order、发布 staging、公开命令与 known-limitations map 一致性审计
│   ├── baselines/
│   │   └── performance.json  需显式 update mode 才能改写的已提交性能上限
│   └── support/               临时路径、清理、凭据清除/非 loopback 拦截、metric/baseline 验证与有界 JSON reporter
│
├── apps/
│   ├── web/                      React + Vite Web Workbench（默认 http://127.0.0.1:4310）
│   │   ├── package.json          依赖 react/react-dom/mermaid + @tracegraph/sdk、contracts；脚本 dev/build/typecheck/test:unit
│   │   ├── index.html            HTML 壳：挂载点 #root、color-scheme、meta description
│   │   ├── vite.config.ts        Vite 配置：端口 4310、/api 代理到 4311 并注入受信 Origin、vitest 配置、缓存目录隔离
│   │   ├── tsconfig.json         前端 TS 配置（含 DOM lib、jsx）
│   │   └── src/
│   │       ├── main.tsx          React 挂载入口（StrictMode + createRoot + 引入 styles.css）
│   │       ├── App.tsx           顶层装配：布局、Session/项目/运行状态编排、Plan/Todo、G-07 child 账本视图、G-08 Team、G-14 steering/取消、G-17 extension 状态/reload、G-18 新 Run 附件、G-23 Replay 进入/步进/返回、Run 权限与 Telemetry status
│   │       ├── model.ts          前端视图模型：Run/Event/Plan/Todo/subagent/team/attachment/extension/权限/input queue/证据槽，以及 live/replay 分离状态与相邻 sequence 导航
│   │       ├── client.ts         WorkbenchClient 接口定义（含 Session、Plan/Todo、G-07 child 读、G-08 Team、steering、G-17 extension、Telemetry 与 Replay）+ DemoTraceGraphClient
│   │       ├── demo.ts           Demo 用的固定轨迹/Context/Diff/Graph/审批假数据（仅显式启用时使用）
│   │       ├── live-client.ts    LiveTraceGraphClient：经 SDK 连真实 Host；维护 live/replay 分离、generation gate、G-07 relation-scoped child 账本缓存，同时处理 G-08 Team create/steer/cancel、G-17 extension list/reload、G-18 staging/preview、steering、Telemetry、Context/usage 与 Artifact hydration
│   │       ├── i18n.tsx          中英文案表 + LanguageProvider/useI18n
│   │       ├── styles.css        全局样式与主题变量（light/dark）
│   │       └── components/
│   │           ├── ReplayBanner.tsx           G-23 回放条：sequence/head/hash、相邻步差异、前后步进与回到现在
│   │           ├── SandboxBadge.tsx            G-13 enforcement 徽标：full/partial/none 与报告详情
│   │           ├── Trajectory.tsx            轨迹主视图：按事件类型渲染，并按需展开 G-07 只读 child Run Ledger 与 G-18 verified attachment 卡片
│   │           ├── AttachmentComposer.tsx     G-18 新 Run PNG/JPEG/PDF 选择/拖放、上限提示、默认 offload 与显式 inline
│   │           ├── Inspector.tsx             事件检查器：按 tab（Summary/I-O/Context/Memory/Changes...）加载该事件证据
│   │           ├── ChangesView.tsx           Diff 与 Graph Before/After 视图，含证据加载中/缺失占位
│   │           ├── ContextBudget.tsx         Context 预算条：preflight/逐 section、provider usage、压缩链与外置原文展开查看
│   │           ├── ApprovalStrip.tsx         Patch 审批操作条（批准/拒绝）
│   │           ├── PlanApprovalBanner.tsx    G-09 待审批 Plan 横幅：精确 revision 审批后同 Run 继续
│   │           ├── TodoPanel.tsx             G-09 Todo 面板：状态/依赖/证据及用户勾选与重开
│   │           ├── TeamPanel.tsx             G-08 canonical roster/task board/mailbox；只开放 create、active-member steer 与 task cancel
│   │           ├── SteeringComposer.tsx      G-14 运行中排队输入：pending/last consumed step、message/approve_hint 与安全取消
│   │           ├── Sidebar.tsx               左侧栏：项目与 durable Session 列表/搜索/恢复/删除确认、运行状态
│   │           ├── SettingsPanel.tsx         设置面板：提供商与权限预设、协议/Base URL/模型名/Key、主题、Telemetry 只读状态，以及 G-17 extension state/generation/registration/error 与 idle-only reload
│   │           ├── ReasoningEffortPicker.tsx 推理强度选择（default/low/medium/high/xhigh/max）
│   │           ├── MarkdownContent.tsx       Markdown 渲染 + fenced mermaid 代码块渲染为 SVG（失败显示源码与错误）
│   │           ├── Primitives.tsx            基础 UI 原子：BrandMark/StatusPill/IconButton/SectionLabel/Notice
│   │           ├── Icon.tsx                  内联 SVG 图标集合（IconName 枚举）
│   │           └── WorkbenchStates.tsx       页面级状态视图：NoProject / ProjectReady / ChatView 等
│   │
│   ├── retrieval-service/        G-21 可选 loopback HTTP 检索 seam；当前后端仍是本地 JSONL/BM25
│   │   ├── package.json          bin/serve/dev/test，依赖 retrieval + Fastify + Zod
│   │   ├── tsconfig.json / tsconfig.test.json
│   │   ├── src/
│   │   │   ├── contracts.ts      strict ingest/search/health/error wire schema
│   │   │   ├── server.ts         loopback-only Fastify server、可选 bearer、body/timeout/scope 边界与可替换 backend/embed seam
│   │   │   ├── client.ts         strict bounded client；hash/rank/scope 校验，仅 availability/deadline/502/503/504 可回退
│   │   │   ├── dev.ts            端口/数据目录/token 环境配置与优雅关停
│   │   │   └── index.ts          汇总导出 public service/client API
│   │   └── tests/                路由、鉴权、超时、大小、scope、client integrity 与错误分类
│   │
│   └── cli/                      Composition Root：把各包组装成可运行的 Host
│       ├── package.json          bin: tracegraph；脚本 serve/dev/test:e2e/test:unit；依赖全部 workspace 包
│       ├── tsconfig.json         该 app 的 TS 配置
│       ├── .tracegraph/          【空残留目录】历史上从该 cwd 启动过一次 Host 留下的空数据目录，非 canonical 数据
│       └── src/
│           ├── index.ts          CLI 入口：解析 serve、`extensions list|reload|run` 与 `team`，组装 G-17 Extension Controller、权限 resolver/Runtime/Session Controller/Host/模型/项目/Telemetry/G-21 retrieval，并在关停时 best-effort flush
│           ├── composition.ts    把 codegraph 的 analyze/diff 适配成 core 需要的 CodeGraphProvider 接缝；Host close 后以默认 5 s 预算等待 Telemetry flush
│           ├── model-config.ts   环境引用推导、旧明文配置迁移、只含 secret reference 的原子持久化与 .env.local 加载
│           ├── sandbox-config.ts G-13 旧模式解析器；生产装配已由 `permission-config.ts` 统一接管，保留兼容测试与迁移语义
│           ├── permission-config.ts G-06 Host 侧权限配置：CLI/env ceiling + `~/.tracegraph/harness-config.json` 用户选择 + 项目 `<root>/.tracegraph/policy.json` 收紧层；私有原子持久化并为每个新 Run 产出分层 policy digest 快照
│           ├── telemetry-config.ts G-15 服务端装配：读取 `<dataDir>/telemetry.json`，缺失保持 noop；endpoint 经环境变量、authorization reference 经 G-19 CredentialStore 解析
│           ├── retrieval-config.ts G-21 默认本地索引；可选 strict service client、写穿本地镜像，并只对 availability/deadline/gateway 失败回退
│           ├── subagent-config.ts  G-07 受信本地 profile catalog：CLI/env 仅选 profile 和收窄 limits，role prompt/provider key/tool allowlist 由 composition root 决定
│           ├── subagent-config.test.ts G-07 CLI 正反例：默认 depth/parallel/budget、profile 选择、边界与未知 profile 拒绝
│           ├── extension-config.ts G-17 strict JSON/no-symlink/256 KiB loader、Host-owned catalog、默认内置扩展，以及 list/reload/command controller
│           ├── extension-config.test.ts G-17 缺省配置、合法启停与未知 module/symlink/超限/重复等拒绝用例
│           ├── extension-command.ts G-17 `extensions list|reload|run` 的 SDK/bootstrap/Host URL 薄客户端；不读取或加载 module
│           ├── extension-command.test.ts G-17 CLI bootstrap 顺序、Host URL/参数分离与缺参时不发请求
│           ├── team-command.ts  G-08 `team` 的 SDK/bootstrap/Host URL 薄客户端；show 只读，所有 mutation 可用稳定 command id 重试，scope/actor/time 由 Host 绑定
│           ├── team-command.test.ts G-08 CLI 全 mutation 分派、command-id 透传，以及 show/authority/owner/clock/timeout 夹带在 bootstrap 前拒绝
│           ├── project-registry.ts 本地目录登记表：原生目录选择器、realpath 规范化、原子写、失效告警、reveal
│           └── e2e.test.ts       纵向 E2E（真实 Host + Runtime）：默认 noop 与 configured memory Telemetry 状态链；SDK → Approval → Patch → Test → Graph Delta
│
├── packages/
│   ├── contracts/                所有边界的 Zod Contract（canonical 与 wire），无运行时依赖
│   │   ├── package.json          仅依赖 zod；build/typecheck/test:unit
│   │   ├── tsconfig.json         产物配置
│   │   ├── tsconfig.test.json    含测试的类型检查配置
│   │   └── src/
│   │       ├── common.ts         基础标量 Schema、SCHEMA_VERSION/PROJECTOR_VERSION、ArtifactKind/Ref 与 Wire 响应
│   │       ├── action.ts         十九种 ToolName（含 4 个 G-07 控制工具与 5 个 G-08 Team 工具）、兼容单调用/批调用的 Decision、Action/Patch/Approval 完整绑定与 legacy 可读联合、Receipt/Observation
│   │       ├── tool.ts           G-05 strict 有界 JSON Schema、Host/模型工具描述、标准失败类与批次审计载荷
│   │       ├── action-wal.ts     G-04 WAL phase/target/record 与 Recovery recipe/attempt 的 strict v1 契约
│   │       ├── commands.ts       命令与请求契约：StartRun/StartChat/Plan Approval/Tool Approval/Stop/Rollback/OpenLocalProject/Reveal/RemoveProject、`plan|execute`、ReasoningEffort、会话消息
│   │       ├── todo.ts           G-09 Todo item/list、模型分页 read、strict write、状态事件、Plan ready/approved 与 browser request 契约
│   │       ├── context.ts        Context Policy、G-02 策略开关/摘要契约/表面节点、预算状态、CompactionStep 与 Manifest
│   │       ├── token.ts          G-03 TokenEstimate/usage/calibration 契约：preflight、provider report、逐 section 与持久格式
│   │       ├── credentials.ts    Credential backend/name、`${secret:NAME}`、安全元数据、模型配置请求/公开响应契约
│   │       ├── sandbox.ts        G-13 三档 mode、enforcement/platform、versioned report 与 lifecycle Event data
│   │       ├── permission.ts     G-06 契约：三种内置权限预设（兼容 custom 快照）、安全 workspace 相对 glob、双层生效策略、可解释决策、公开设置与审批令牌
│   │       ├── steering.ts       G-14 UserInput/queue/event/request/result strict 契约：100 条 pending、8,000 字符正文、消费 step 与幂等 digest
│   │       ├── subagent.ts       G-07 trusted profile/spec/task packet/budget/link/result、4 个控制工具 input 与 5 种 lifecycle payload
│   │       ├── team.ts           G-08 roster/mailbox/task board/limits、13 种 Event payload（含 durable sweep receipt）、section/offset/limit/snapshot-pinned 模型分页读入、5 个 Tool input 与 Host/SDK command/result strict 契约
│   │       ├── attachment.ts     G-18 PNG/JPEG/PDF、5 MiB/8 个上限、staging receipt、offload/inline、模型能力、PDF extraction 与 Projection item
│   │       ├── telemetry.ts      G-15 浏览器安全的 strict 只读状态：schema v1、sink/state、error_count 与可选 last_error_at；不含 endpoint/header/credential/path/payload
│   │       ├── extension.ts      G-17 API/config/status/reload/command/error/recovery snapshot strict 契约；`tracegraph.extension.v1`
│   │       ├── replay.ts         G-23 Replay request/snapshot/session/diff v1：Run 内 sequence、canonical hash 与结构化变化
│   │       ├── event.ts          90 种 EventType（含 G-08 的 13 种 team lifecycle，以及 G-17 extension、G-07 subagent、G-18 attachment、Plan/Todo、Tool batch、Sandbox、input queue 与 Memory/retrieval）、终态判定、SessionEvent 判别联合、Event Proposal、Wire 事件
│   │       ├── session.ts        G-01 Session JSONL v1：root/all 查询、parent-child header/event-ref 与恢复响应；当前 recovery state v5 在 G-07 v4 上冻结 G-17 extension snapshot，v1–v4 继续可读
│   │       ├── graph.ts          GraphNode/Edge/Snapshot/Delta 与 change 枚举
│   │       ├── live-event.ts     LivePublicActivity：仅内存的公开执行活动投影（run/context/model/tool × 状态）
│   │       ├── memory.ts         G-21 Memory scope/status/record/candidate/admission、recall budget/hit/attribution 与 index update 的 strict 契约
│   │       ├── model-stream.ts   ModelSurfaceEvent：模型请求阶段与状态的公开表达
│   │       ├── projection.ts     RunStatus、PendingPlan/Approval、Todo、input_queue、G-07 subagents、G-18 attachments 与可选 G-08 team，及 permission/sandbox report（当前 projector v8）
│   │       ├── workspace.ts      WorkspaceKind/CapabilityProfile/WorkspaceHandle/ProjectLocation/ProjectSummary 与三种能力预设
│   │       └── index.ts          汇总再导出（`export *` 于上述全部模块）
│   │
│   ├── core/                     Runtime 与执行内核（本仓最核心的包）
│   │   ├── package.json          依赖 contracts + telemetry + zod
│   │   ├── tsconfig.json / tsconfig.test.json
│   │   └── src/
│   │       ├── runtime.ts        AgentRuntime：Run 生命周期、Plan/Execute/Todo、Decision/Policy/Approval、G-07 有界父子 Run、G-08 Agent Team、G-14 steering、G-17 extension lease/hook/context/error/recovery、G-18 attachment、批调度、Sandbox、WAL、Memory 与 Telemetry
│   │       ├── attachment.ts     G-18 私有两阶段 staging/claim、MIME magic/hash/scope/TTL、去重、PDF 文本提取、Artifact 与 content lookup
│   │       ├── subagent.ts       G-07 Host-owned profile registry、role hash/工具白名单解析、公平并发 permit pool 与预算默认值
│   │       ├── team.ts           G-08 root-Ledger Team service：命令幂等/内部命名空间、actor 权限、mailbox claim、optimistic task version、owner child evidence resolver、heartbeat sweep 与 member-loss 原子 reopen
│   │       ├── replay.ts         G-23 完整 Ledger 校验后按 Run/sequence 投影、稳定 snapshot hash 与同次读取的正反向结构化 diff
│   │       ├── runtime-telemetry.ts G-15 提交后派生器：只从已落 Ledger 的 SessionEvent 白名单字段生成 bounded span/metric/log；去重与关联表有界，不转发 Event summary/任意 data
│   │       ├── todo.ts           TodoDomainService：账本重放、依赖图/迁移、eligible 独立执行证据校验、命令幂等与确定性成环路径
│   │       ├── action-wal.ts     ActionWal/RecoveryLedger：私有 before-image、hash-chained phase/attempt、durable replace 与报告导出
│   │       ├── session-store.ts  JsonlSessionStore：v0→v1、引用索引、列表/搜索/原子改名/软删、单写者 lease 与 tail repair
│   │       ├── session-controller.ts 启动恢复编排：tail 审计、已注册 workspace 的 Action WAL 对账、无终态 Run 中断与安全 resume
│   │       ├── extension.ts      G-17 六 seam ExtensionManager：可逆注册、生命周期 timeout、LIFO dispose、atomic reload rollback、Run lease、snapshot、错误隔离与有界贡献
│   │       ├── tool-registry.ts  六个最小核心工具 + 两个可逆内置扩展贡献的十三个 Artifact/Todo/子 Agent/Team 工具；`team_read` 无损分页与写工具紧凑回执；默认 19-Tool 组装
│   │       ├── tool-output-limits.ts G-02/G-05 共用的逐工具 raw/summary/facts/result 字节上限；`todo_read` / `team_read` content/result 为 512/640 KiB、模型 excerpt 为 4,000 UTF-8 bytes
│   │       ├── sandbox/          G-13 子进程边界（4 个实现文件 + 1 个用例）
│   │       │   ├── index.ts      汇总再导出（platform/process-runner/runner/seatbelt）
│   │       │   ├── platform.ts   probeNativeSandbox、validateSandboxPaths（symlink/越界校验）、disabled/unavailable report、SandboxPathError
│   │       │   ├── seatbelt.ts   macOS `/usr/bin/sandbox-exec` profile 生成与参数拼装、SeatbeltParameterError
│   │       │   ├── process-runner.ts runBoundedProcess：独立进程组、超时、输出上限与 SIGTERM→SIGKILL 回收
│   │       │   └── runner.ts     SandboxRunner/NativeSandboxRunner/createSandboxRunner：组装 probe + profile + bounded process 并产出 versioned report
│   │       ├── context.ts        DeterministicContextBuilder、同步兼容入口与 async buildWithStrategies、DEFAULT_CONTEXT_POLICY、preflight 对账
│   │       ├── context-compaction.ts G-02 有序 surface strategy chain、原文归档/可见 locator、结构化 summary 校验、timeout/降级与 Context nodes
│   │       ├── token-meter.ts    CalibratedTokenMeter：可选 section TokenCounter、provider/model 滑动校准、缓存失效与安全原子落盘
│   │       ├── credentials.ts    CredentialStore、macOS Keychain、非 macOS 0600 私有文件、只读环境层、引用解析与迁移审计
│   │       ├── policy-engine.ts  G-06 生效策略推导与规则求值：hard constraint、Host/project 分层规则、稳定排序与 policy/action digest；恢复可保留已给定 digest
│   │       ├── approval-token-store.ts G-06 进程内一次性审批令牌：同步原子 issue/consume、TTL/容量上限、精确绑定 project/run/action/approval/digest/scope，失配先消费再拒绝
│   │       ├── model-provider.ts ConfigurableModelAdapter：动态模型工具白名单、单/批 Decision、独立 Context summary、显式 image capability 与 OpenAI/Anthropic 图片 block、协议/推理强度/脱敏/JSON-SSE usage
│   │       ├── fake-model.ts     DeterministicFakeModel：无需 API Key 的确定性模型（Core Gate）
│   │       ├── event-ledger.ts   JsonlEventLedger：append-only、hash chain、同 Run `appendAtomic()` 单次 durable replace、不变量校验、损坏检测与错误类型
│   │       ├── projection.ts     projectRun 事件→RunProjection 投影（含 strict attachment proof replay）、toWireEvent 出口脱敏、ProjectionError
│   │       ├── artifact-store.ts Artifact 落盘/读取：文本/JSON 与 G-18 binary bytes，公开 1 MiB、Runtime internal 8 MiB 单工件硬上限，scope/hash/MIME/脱敏与权限校验
│   │       ├── crypto.ts         sha256、id 工厂、stableStringify、密钥与敏感文本/结构化数据脱敏
│   │       ├── workspace.ts      工作区句柄创建（只读/受管/fixture）、路径边界校验、受控临时目录清理
│   │       ├── memory.ts         G-21 JsonlMemoryStore 与 MemoryManager：候选评估/去重、canonical record、索引更新、scope/expiry 过滤、预算 recall 与 durable 事件
│   │       ├── types.ts          ModelAdapter/ModelInput/ContextSummaryInput/ModelObservation/ToolDefinition/CodeGraphProvider/AgentRuntimeHooks 等内部类型
│   │       └── index.ts          汇总再导出（Runtime、Extension、Context、Tools、Policy、Approval Token、Ledger、Artifacts、Workspace、Memory、Provider、Session、Sandbox、WAL、Token...）
│   │
│   ├── retrieval/                G-21 零外部服务依赖的本地 Markdown/JSONL/BM25 检索包
│   │   ├── package.json          build/typecheck/test:unit；运行时只依赖 Node 标准库
│   │   ├── tsconfig.json / tsconfig.test.json
│   │   ├── src/
│   │   │   ├── chunker.ts        标题/段落分块、代码围栏完整性、原文 substring 与精确 1-based 行号
│   │   │   ├── index-store.ts    project hash 隔离、strict JSONL/hash/footer、fsync+rename 原子更新、last-good backup 恢复与同进程写队列
│   │   │   ├── retriever.ts      中英文确定性分词、倒排 BM25、topK/稳定排序、内容 hash 去重与审计型 hit
│   │   │   ├── local-retrieval.ts ingest/search/readChunk/health 组合 API；兼容 Core MemoryRetriever seam
│   │   │   ├── validation.ts     project/source/content/query/topK/chunk/hash/路径与上限的 fail-closed 校验
│   │   │   ├── types.ts          v1 请求/响应、chunk/source/snapshot/backend 类型
│   │   │   ├── errors.ts         不回显输入内容的 typed RetrievalError code
│   │   │   ├── hash.ts           SHA-256 helper
│   │   │   └── index.ts          汇总导出本地 backend/store/retriever/chunker 与类型
│   │   └── tests/                fence/行号、原子恢复、项目隔离、伪造拒绝、BM25/中文/topK/回读/abort
│   │
│   ├── telemetry/                G-15 vendor-neutral、best-effort Telemetry 包（不依赖 canonical Ledger 存储）
│   │   ├── package.json          包导出、build/typecheck/test:unit；运行时零第三方 OTel SDK 依赖
│   │   ├── tsconfig.json / tsconfig.test.json
│   │   ├── src/
│   │   │   ├── types.ts          bounded span/metric/log Event、sink kind 与 process-local status 类型
│   │   │   ├── sink.ts           TelemetryEmitter/TelemetrySink 最小接口
│   │   │   ├── safe.ts           SafeTelemetry：吞掉 emit/flush 错误、累计状态、best-effort `telemetry.sink_errors`
│   │   │   ├── validation.ts     事件名称、时间、属性、body、duration/unit 的有界运行时校验
│   │   │   ├── config.ts         strict noop/memory/otlp_http 配置、65,536-byte no-symlink loader、环境 endpoint 与 secret resolver 装配
│   │   │   ├── errors.ts         不泄露配置/secret 的 TelemetryError code
│   │   │   ├── sinks/
│   │   │   │   ├── noop.ts       默认 disabled、零 I/O sink
│   │   │   │   ├── memory.ts     有界进程内测试/嵌入 sink
│   │   │   │   └── otlp.ts       有界进程内 OTLP-HTTP JSON batch；识别 200 partialSuccess，仅网络/超时与 429/502/503/504 重排队，partial/non-retryable 计错后丢弃；无自动 retry/backoff/persistence
│   │   │   ├── testing/conformance.ts 可复用 sink 一致性套件；用 `deliverySnapshot` 实测空 flush 不重复交付
│   │   │   └── index.ts          汇总导出公共 API 与 conformance helper
│   │   └── tests/                noop/memory/OTLP/config/safe wrapper 与三 sink conformance
│   │
│   ├── codegraph/                TS/JS 静态 Module Graph（架构变化分析）
│   │   ├── package.json          依赖 contracts + typescript（用 Compiler API 解析）
│   │   ├── tsconfig.json / tsconfig.test.json
│   │   └── src/
│   │       ├── analyze.ts        analyzeCodeGraph：扫描 TS/JS，产出 file/module/static import/export 的 GraphSnapshot，含覆盖度与诊断
│   │       ├── diff.ts           diffGraphSnapshots：两个 Snapshot → GraphDelta（added/removed/changed/unknown/partial）
│   │       ├── impact.ts         getImpactNeighborhood：给定节点的受影响邻域
│   │       ├── hash.ts           sha256 / stableJson（Graph 稳定指纹）
│   │       ├── path.ts           工作区相对路径规范化、越界判定、file/directory/module 节点 id 生成
│   │       ├── types.ts          诊断码、coverage、分析/差分选项、Impact 类型，并再导出 contracts 的 Graph 类型
│   │       └── index.ts          对外导出（analyzeCodeGraph/diffGraphSnapshots/getImpactNeighborhood + 类型）
│   │
│   ├── host/                     Fastify Host：本机 HTTP/SSE 边界
│   │   ├── package.json          依赖 contracts/core + fastify + @fastify/cors
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts          createTraceGraphHost：Command/Query/Artifact/Attachment/SSE、Session/Permission/Plan/Todo/steering、G-08 Team、G-17 extension list/reload/command 路由、child Run 查询与 Telemetry status；启动恢复、scope/auth/origin 校验
│   │       └── dev.ts            调试用独立启动脚本：读取当前目录为只读项目并监听，打印地址与 token 过期时间
│   │
│   ├── sdk/                      Typed TypeScript Client
│   │   ├── package.json          仅依赖 contracts
│   │   ├── tsconfig.json
│   │   └── src/
│   │       └── index.ts          TraceGraphClient：命令/查询/Session/Artifact/Attachment/Permission/Plan/Todo/steering、G-08 Team read/create/mailbox/task/heartbeat/sweep、G-17 list/reload/run command、`getSubagent()` child 读取、Telemetry/Replay typed 请求、bootstrap recovery、SSE 与 HTTP 错误
│   │
│   └── test-support/             测试夹具与纵向集成测试
│       ├── package.json          依赖 contracts/core + zod
│       ├── tsconfig.json / tsconfig.test.json
│       └── src/
│           ├── index.ts          FAILING_TYPESCRIPT_FIXTURE_ROOT、顺序 id 工厂、fixture 工作区、临时数据目录与 ScriptedMockProvider 导出
│           ├── mock-provider.ts  G-16 有界零网络 ModelAdapter：固定/非法输出、usage、超时、Abort 与耗尽 fail-closed
│           ├── runtime.integration.test.ts  Runtime 纵向集成测试（含 G-05 安全波并行、写隔离、批预校验、preview barrier、失败顺序）
│           └── sandbox.integration.test.ts  G-13 Host/Runtime 整链：report consistency、fail-closed、danger 与 read-only write policy
│
├── examples/
│   └── failing-typescript-repo/  内置「故意有 bug」的不可变 Demo 模板，每次运行会复制成一次性工作区
│       ├── README.md             说明这是不可变模板、bug 是刻意的
│       ├── package.json          仅含 test 脚本（node test/run.mjs）
│       ├── tsconfig.json         strict + noEmit
│       ├── src/index.ts          再导出 add
│       ├── src/add.ts            刻意写错（left - right）的待修复函数，带 TRACEGRAPH_FIXTURE_BUG 注释
│       └── test/run.mjs          断言 add(2,3)=5、add(-2,2)=0，补丁提交前必然失败
│
└── docs/
    ├── README.md                   中英文文档入口与模块索引
    ├── modules/                    01–16 模块实现说明；14 为附件与多模态，15 为插件与扩展系统，16 为 G-08 Agent Team
    ├── supply-chain-policy.md      exact/time-based/24h、manifest/lockfile guard、audit 与例外纪律
    ├── known-limitations-map.json  显式限制到实现/测试证据的 mapped/unmapped 机器可审计映射
    └── verification-map.md         已完成 G-xx（含 G-08/G-17/G-22/G-23）的实现文件、自动化断言、命令与明确边界映射
```

## 2. 按职责定位改动点

| 想改什么 | 主要落点 |
|---|---|
| 命令/请求/事件/投影的数据结构 | `packages/contracts/src/*.ts` |
| Agent 主循环、审批、Patch 提交、事件写入 | `packages/core/src/runtime.ts` |
| 新增或收紧工具契约、权限与限额 | `packages/contracts/src/{action,tool}.ts`、`packages/core/src/{tool-registry,tool-output-limits,runtime}.ts` |
| 子进程 Sandbox mode/report、平台探测与 Seatbelt | `packages/contracts/src/sandbox.ts`、`packages/core/src/sandbox/`、`runtime.ts`、`tool-registry.ts`、`apps/cli/src/sandbox-config.ts` |
| 权限预设、策略规则求值、审批令牌与 Host/Web 配置（G-06） | `packages/contracts/src/{permission,action,event,projection,session}.ts`、`packages/core/src/{policy-engine,approval-token-store,runtime}.ts`、`apps/cli/src/permission-config.ts`、`packages/{host,sdk}/src/index.ts`、`apps/web/src/live-client.ts`、`apps/web/src/App.tsx`、`apps/web/src/components/SettingsPanel.tsx` |
| 有界子 Agent 委派、受信 profile、独立 child Session/Ledger 与只读回放（G-07） | `packages/contracts/src/{subagent,event,projection,session,steering}.ts`、`packages/core/src/{subagent,runtime,projection}.ts`、`apps/cli/src/{index,subagent-config}.ts`、`packages/{host,sdk}/src/index.ts`、`apps/web/src/{client,live-client,model}.ts`、`apps/web/src/components/Trajectory.tsx`、`evals/runtime/subagent-delegation.eval.ts` |
| Agent Team roster/mailbox/task board、heartbeat/sweep、CLI 运维入口与用户 steer/cancel（G-08） | `packages/contracts/src/{team,event,projection,action}.ts`、`packages/core/src/{team,runtime,projection,tool-registry}.ts`、`apps/cli/src/{index,team-command}.ts`、`packages/{host,sdk}/src/index.ts`、`apps/web/src/{App,client,live-client,model}.ts`、`apps/web/src/components/TeamPanel.tsx`、`evals/runtime/agent-team.eval.ts` |
| 附件 staging/claim、图片能力、PDF 文本与 Web 卡片（G-18） | `packages/contracts/src/{attachment,commands,event,projection,common}.ts`、`packages/core/src/{attachment,artifact-store,model-provider,runtime,projection}.ts`、`apps/cli/src/index.ts`、`packages/{host,sdk}/src/index.ts`、`apps/web/src/{App,client,live-client,model}.ts`、`apps/web/src/components/{AttachmentComposer,Trajectory}.tsx`、`evals/runtime/attachment-multimodal.eval.ts` |
| Plan Mode、Todo 依赖/证据、审批与面板（G-09） | `packages/contracts/src/{todo,commands,event,projection,session}.ts`、`packages/core/src/{todo,runtime,projection,policy-engine,tool-registry}.ts`、`packages/{host,sdk}/src/index.ts`、`apps/web/src/App.tsx`、`apps/web/src/{client,live-client,model}.ts`、`apps/web/src/components/{TodoPanel,PlanApprovalBanner}.tsx` |
| 运行中 steering、durable input queue、安全点消费与取消（G-14） | `packages/contracts/src/{steering,event,projection,commands}.ts`、`packages/core/src/{runtime,projection}.ts`、`packages/{host,sdk}/src/index.ts`、`apps/web/src/App.tsx`、`apps/web/src/{client,live-client,model}.ts`、`apps/web/src/components/SteeringComposer.tsx` |
| Telemetry 事件/sink/config、Ledger 提交后派生、只读状态（G-15） | `packages/telemetry/src/`、`packages/contracts/src/telemetry.ts`、`packages/core/src/{runtime,runtime-telemetry}.ts`、`apps/cli/src/{index,telemetry-config}.ts`、`packages/{host,sdk}/src/index.ts`、`apps/web/src/{client.ts,live-client.ts,App.tsx}`、`apps/web/src/components/SettingsPanel.tsx` |
| 离线行为/质量/性能/文档评测（G-16） | `vitest.evals.config.ts`、`tsconfig.evals.json`、`evals/{runtime,quality,perf,docs,support,baselines}/`、`packages/test-support/src/mock-provider.ts` |
| 插件/扩展契约、可逆生命周期、Run lease、可信配置与控制面（G-17） | `packages/contracts/src/{extension,event,session}.ts`、`packages/core/src/{extension,runtime,tool-registry}.ts`、`apps/cli/src/{index,extension-config,extension-command}.ts`、`packages/{host,sdk}/src/index.ts`、`apps/web/src/{App,client,live-client,model}.ts`、`apps/web/src/components/SettingsPanel.tsx`、`evals/runtime/extension-system.eval.ts` |
| 长期 Memory、Markdown/JSONL/BM25、引用注入与可选检索服务（G-21） | `packages/contracts/src/{memory,context,event}.ts`、`packages/core/src/{memory,context,context-compaction,runtime}.ts`、`packages/retrieval/src/`、`apps/retrieval-service/src/`、`apps/cli/src/{index,retrieval-config}.ts`、`evals/quality/retrieval-rag-quality.eval.ts` |
| CI、覆盖率、供应链与私有发布门（G-22） | `.github/workflows/{ci,release}.yml`、`vitest.coverage.config.ts`、`scripts/{clean-dist,check-coverage,verify-lockfile,verify-release}*`、`pnpm-workspace.yaml`、`.npmrc`、`evals/docs/g22-release-consistency.eval.ts` |
| 逐事件 Trace Replay、差异、只读 capability 与 Web 时间旅行（G-23） | `packages/contracts/src/replay.ts`、`packages/core/src/{replay,runtime}.ts`、`packages/{host,sdk}/src/index.ts`、`apps/web/src/{client,live-client,model}.ts`、`apps/web/src/App.tsx`、`apps/web/src/components/ReplayBanner.tsx`、`evals/replay/time-travel.eval.ts` |
| Context 预算、策略链、模型摘要、原文外置与 preflight token 记账 | `packages/core/src/{context,context-compaction,runtime,model-provider}.ts` + `packages/contracts/src/{context,token,event}.ts` |
| provider usage、校准与异常 | `packages/core/src/{model-provider,token-meter,runtime}.ts` + `packages/contracts/src/token.ts` |
| 模型提供商预设、协议适配、推理强度 | `packages/core/src/model-provider.ts` |
| 凭据契约、存储、迁移与引用解析 | `packages/contracts/src/credentials.ts`、`packages/core/src/credentials.ts`、`apps/cli/src/model-config.ts` |
| Session 契约、JSONL/lease、启动恢复与 resume | `packages/contracts/src/session.ts`、`packages/core/src/session-store.ts`、`session-controller.ts`、`runtime.ts` |
| Session 浏览/搜索/软删除的前端入口 | `apps/web/src/components/Sidebar.tsx`、`App.tsx`、`client.ts`、`model.ts` |
| Patch 崩溃一致性、恢复 recipe 与显式回滚 | `packages/contracts/src/{action-wal,commands,event,projection}.ts`、`packages/core/src/{action-wal,runtime,session-controller}.ts`、`packages/host/src/index.ts`、`packages/sdk/src/index.ts` |
| 事件存储与回放 | `packages/core/src/{event-ledger,projection,artifact-store,replay}.ts`、`packages/contracts/src/replay.ts` |
| 架构图快照与差分 | `packages/codegraph/src/analyze.ts`、`diff.ts` |
| HTTP/SSE 路由、鉴权与脱敏 | `packages/host/src/index.ts` |
| 前端调用后端的方式 | `packages/sdk/src/index.ts` |
| 前端界面与证据联动 | `apps/web/src/App.tsx`、`components/`、`model.ts`、`live-client.ts` |
| Host 启动、项目/目录/模型/Permission/Extension/Team/Telemetry/Retrieval/Subagent 配置与控制入口 | `apps/cli/src/index.ts`、`project-registry.ts`、`model-config.ts`、`permission-config.ts`、`extension-config.ts`、`extension-command.ts`、`team-command.ts`、`telemetry-config.ts`、`retrieval-config.ts`、`subagent-config.ts`（`sandbox-config.ts` 仅旧接口兼容） |
| 端到端与独立评测断言 | `apps/cli/src/e2e.test.ts`、`packages/test-support/src/runtime.integration.test.ts`、`evals/**/*.eval.ts` |

## 3. 注意事项

1. **`.tracegraph/` 与 `~/.tracegraph/` 都是运行时数据不是源码**；前者由仓库 `.gitignore` 排除，后者本来就在仓库外。`.tracegraph/artifacts` 同时保存公开证据、G-02 外置 Context 原文与不进入公开 Wire 的恢复工件；`.tracegraph/wal/backups` 保存 rollback 所需的精确 before-image，`.tracegraph/recovery` 保存恢复尝试；`.tracegraph/memory/records.jsonl` 是 G-21 canonical Memory record，`.tracegraph/retrieval-index` 是可由其重建的 JSONL/BM25 投影。Artifact/WAL 等各自按实现收紧目录/文件权限并做 symlink/hash 校验，但这些运行数据整体仍不是静态加密或跨 Host 锁；Memory record 只在创建时请求 `0600`，当前 append store 不复核已有文件的 owner/mode/symlink，检索索引也只做单进程写队列而没有跨进程 writer lock，因此尤其不要让 CLI 本地镜像与独立 retrieval-service 直接共享同一个索引目录。`.tracegraph/model-config.json` 只含 `${secret:NAME}` 引用；`.tracegraph/token-calibration.json` 只含 provider/model、比例样本与 revision；可选 `.tracegraph/extensions.json` 只允许选择 Host 内置 trusted catalog id，`module` 不是可执行路径；可选 `.tracegraph/telemetry.json` 只应保存 sink 选项、endpoint 环境变量名与 `${secret:NAME}` authorization reference，不能保存明文 endpoint authorization/header。默认 Session 索引在 `~/.tracegraph/sessions`，只存 header + Event 引用，删除移到同级 `sessions-trash`。Session 引用不含 ledger locator，所以一个 Session root 必须固定配对一个 `dataDir`；多数据目录部署必须分别指定 `--session-dir`。macOS 的值在 Keychain；非 macOS 的 `~/.tracegraph/credentials.json` 强制 `0600`，但仍是 plaintext-at-rest。这些运行数据都不要提交或外发。Telemetry 的队列/错误状态也不在这些 durable 数据里；它们只在当前进程内且不参与恢复。
2. **`apps/cli/.tracegraph/` 是残留空目录**：历史上从 `apps/cli` 作为 cwd 启动过一次 Host 留下的 `artifacts/events/projects` 三个空目录，不是 canonical 数据目录（canonical 是仓库根 `.tracegraph`），可以安全删除。
3. **模块说明统一在 `docs/modules/01`–`16`**；`docs/` 根目录保留入口、verification map、供应链策略与机器可审计 limitation map。已知限制的唯一人类可读事实源仍是根目录 `KNOWN_LIMITATIONS.md`，不要再创建第二份叙述清单。
4. **`examples/failing-typescript-repo` 是刻意失败模板**，其中的 bug 是设计的一部分，不要"顺手修好"；运行时会复制成一次性工作区再打补丁。
5. **单元测试不逐个列在目录树里**：`apps/web` 与 `packages/{contracts,core,host,sdk,test-support}` 的 `*.test.ts(x)` 与源码同目录（`packages/codegraph` 例外，放在独立 `tests/` 目录）；只有三个跨层套件单列——`apps/cli/src/e2e.test.ts`（纵向 E2E）、`packages/test-support/src/runtime.integration.test.ts`（Runtime 集成）与 `packages/test-support/src/sandbox.integration.test.ts`（G-13 Host/Runtime 整链）。找用例时按这三条路径约定定位。
6. **G-06（权限预设/策略引擎/审批令牌）已经接入主链**：
   - CLI flag / environment 只确定不可热提升的 Host ceiling；用户/Web 选择持久化后只影响新 Run，项目 `policy.json` 是独立的 ask/deny 收紧层。Runtime 把分层 effective policy 与 digest 固化进 Run/recovery state，恢复时不按当前设置重算。
   - 每次 Tool action 都先过不可被 allow 覆盖的 capability/plan/preset/path hard constraint，再按稳定优先级求值 Host 与 project rules；决策写 `policy.evaluated`，拒绝另写 `policy.denied`。执行前的最终重评若为 deny，会在 `tool.started`、WAL 与 mutation 前终止。最终 `ask` 的 Patch approval 绑定 action/policy digest，并使用进程内单次 token；重启不恢复 token，只能重新签发审批。policy `allow`（包括未被规则收紧的 full-write）不产生 approval request/grant/token，但仍受 canonical digest 与 WAL 约束。
   - 浏览器仅能从 Host 返回的 `available_presets` 中提交 preset key；不能提交规则、路径、sandbox mode、approval policy 或 token。公开设置也不返回 Host/project rules 与本机路径。
   - 契约、policy engine、token store、CLI 配置、Runtime、Host/SDK 与 Web 均有正反例；验证命令与文件映射见 `docs/verification-map.md`。不要把进程内 token、逻辑 glob 匹配或 `full-write` 误写成远程 RBAC、真实路径防逃逸或 Host 容器隔离。
7. **G-09（Plan Mode / Todo）已经接入主链**：
   - `plan.ready` 是非终态暂停点；审批绑定当前 `plan_event_id`，并在原 `run_id` 继续 execute。等待期 Todo 变更会刷新 revision，旧审批失效。
   - Todo 状态由 canonical Ledger 重放；模型完成必须引用同 Run、早于本次 mutation 的 eligible 独立成功执行事实。成功非 Todo Tool、严格成功 Test Receipt 与 Patch/Graph/Action allowlist 可用；Todo/Plan/Model/Policy/Approval/lifecycle 不能自证。已有证据的 done Todo 保持 done 时不能清空证据。该门只证明 durable execution fact，不是逐 Todo 的语义验收器；用户勾选以 actor-bound Event 确认该 Todo。浏览器 request 不能自选 project/run/actor。
   - 模型侧 `todo_read` 默认 25、最多 100 项并沿 `next_offset` 分页；512/640 KiB content/result envelope 可容纳最大合法单项，模型可见 excerpt 仍按 UTF-8 截到 4,000 bytes，完整页经 Artifact 回读。
   - 新请求只接受 `plan|execute`；旧 `manual` 仅在 legacy Event/recovery 重放边界映射为 execute。Plain Chat 由 Host 强制 execute，不会停在没有项目意义的 Plan 审批点。
8. **G-07（子 Agent 委派）与 G-08（Agent Team）均已接入主链，但执行边界仍有界**：父 Runtime 只能用 model-visible profile name/task packet/context scope/请求预算选择 Host-owned trusted profile；provider key、role prompt hash、tool allowlist、depth 与有效预算作为冻结 spec 落账并进入当前 recovery v5（G-07 首次引入这些字段的历史版本是 v4）。每个 child 有独立 Run/Session/Ledger，默认 `max_depth=1` / `max_parallel_subagents=2`；普通 Session 历史默认 `view=roots`，Web 只能通过父子关系按需读 child Ledger。G-08 以 root Ledger 重放 roster/mailbox/shared task board，optimistic version 保证单 Host 并发 claim 只有一个 owner；complete 写 root receipt 前从当前 owner 的 canonical child Ledger 验证 eligible evidence，伪造/其他 child id 拒绝，receipt durable 后 root replay 不跨文件复验；显式 heartbeat+sweep 用一条 `team.member_lost` 原子 reopen 失联成员的 claimed tasks，但不自动重派。`spawn_subagent` 仍同步等到 child 终态，Team 并行只来自 G-05 batch + G-07 permit；没有跨 Host consensus、旧 worker 自动重启、任意模型轮次续聊或通用非阻塞父循环。启动恢复只按 Ledger 收口且不重启旧 child；父 terminal receipt 持久失败时同进程 fail-stop，保留 running parent/permit，需重启 Host 后再对账。
9. **G-14（运行中 Steering）已经接入主链**：每 Run mailbox 只在单 Host 进程内并发串行；每个工具批次后/下一 model request 前的 safe step 仅消费普通输入 FIFO 队头一条，紧急 cancel 走 control lane 并可越过普通输入。队列最多 100 条，单条 body 最多 8,000 字符，并为 cancel 保留最后一槽。`approve_hint` 仅是 model context，不是 Plan/Patch 审批。重启保留 pending；普通 `interrupted` Run 仍是只读视图，只有已 durable 的 pending cancel 可在显式 resume 时做最小终结而不重启旧工作。cancel 等待写 Tool 安全收口且不回滚已提交 Patch；SSE 只呈现 canonical activity，不是 provider token stream。
10. **G-15（Telemetry）已经接入主链，但仍是旁路**：Runtime 只在 Ledger append 成功后投影 allowlisted bounded 属性；SafeTelemetry 吞掉 sink 错误，默认 Noop sink 零网络。CLI 才负责从 `<dataDir>/telemetry.json`、环境 endpoint 与 G-19 authorization reference 组装 sink；Core 不读取配置。Host/SDK/Web 只暴露不含 endpoint/header/credential/path/payload 的 strict 状态。Ledger 才是事实源；不要用 Telemetry 做恢复、审计替代或写回依据。
11. **G-16（Evals）与正常测试分离**：`pnpm test` 不收集 `*.eval.ts`，`pnpm evals` 使用独立 config 且必须无 API key/无外网完成。默认模式不改基线；只有 `evals:update` / `--update` 允许更新，且必须 review diff。`_tmp_evals` 报告只是诊断产物；fixture 质量增益不得写成生产 Memory 或真实模型质量证明。G-22 的 CI `evals` job 会显式清空 provider/OTLP 凭据后执行这条门。
12. **G-17（插件/扩展系统）是 trusted in-process composition，不是任意代码插件沙箱**：`ExtensionManager` 提供 Tool、Telemetry sink、Context strategy、Policy rule、Command 与 Event hook 六个可逆 seam；每个 Run 冻结 extension snapshot 并持有 lease，reload/deactivate 只能在 idle 时进行，recovery v5 漂移会 fail-closed。CLI 的 strict JSON 配置最大 256 KiB、拒绝 symlink/未知字段/重复项，只能选择 Host 编译时 catalog 中的两个内置扩展；`module` 不会触发 npm、本机路径或仓库 JS/TS 加载。Host/SDK/CLI 暴露 list/reload/有界 command，Web 当前只展示状态并触发 reload。MCP 仍是未实现的 G-11，不能由 G-17 推导为已有能力。
13. **G-22（工程化与发布）是私有 workspace artifact 流程**：Actions setup 禁止自动安装，三个 CI job 都直接运行 `node scripts/verify-lockfile.mjs --skip-frozen`、再 frozen install，避免宿主 `pnpm <script>` 包装器先隐式安装；`pnpm build` 先以 `clean:dist` 只清理 manifest-owned 输出，发布再把 manifest 列出的 bytes 复制到 `_tmp_release/bundle` 并复核 SHA-256。它不是 npm publish、代码签名、provenance、容器镜像或生产部署。当前仓库能证明 workflow 定义与同构本地命令通过，不能在没有 GitHub-hosted run URL 时声称远端 CI 已运行成功。
14. **G-23（Trace Replay）是只读历史投影，不是执行分支**：sequence 只在 Run 内定位；snapshot hash 只覆盖 canonical Ledger → `RunProjection`。Replay bearer 绑定 session/project/Run、冻结 head 与 Artifact 前缀，不能访问 latest/SSE/领域写；进入 Web Replay 只停止当前页面订阅，不暂停后台 Agent，也不撤销其它 live bearer。当前没有历史 fork、跨 Run 合并、持久 replay cursor 或 Playwright 真实浏览器 E2E。
15. **`docs/` 与目录树的同步义务**：`docs/modules/01`–`16` 描述的是模块职责，本文件描述的是文件职责；新增/移动源文件后请同时更新本文件的目录树与第 2 节落点表，避免两者漂移。
