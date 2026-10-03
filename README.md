# Outlive Agent

[English](README.en.md) · 简体中文

> 桌面安装包携带独立运行时与 CLI，无需用户安装 Node/pnpm。安装和当前签名、平台验收边界见[安装说明](docs/releases/README.md)。下文的 `pnpm dev` 和源码命令仅面向开发者；旧 Preview 归档仍使用其随包说明。

> **一个架构感知、全程可观测、Context、长期 Memory 与验证证据可检查的 Web Coding Agent。**
>
> 状态：`v0.1.0-alpha.0`。本地优先、单机运行、未发布 npm；P0 纵向链已实现。当前边界见对应的[模块文档](docs/modules/)与 [Outlive Agent 迁移基线](docs/outlive-agent-v2/10-tracegraph-to-outlive-migration/README.md)。

大多数 Coding Agent 只留给你一段聊天记录：改了什么、为什么改、依据是什么，散落在几十轮对话里，事后几乎无法复核。

Outlive Agent 把 Decision、Tool、Approval、Patch、Test、Context 和代码架构变化收进**同一条可回放的轨迹**。每个结论都能回溯到产生它的那次模型请求、那次工具执行和那份证据。

## 主要能力

- **可回放的事实链**：append-only JSONL Event Ledger + Artifact Store + Projection Replay。可按 Run 内 `sequence` 重建任意历史投影、比较两点的结构化差异并校验 canonical snapshot hash；Replay Debugger 支持逐事件单步前进/后退。
- **受控写入**：`Decision → Schema/Capability/Policy → Tool → Receipt → Observation` 全链可审计。写盘前有 PatchPreview、base/patch hash 绑定与一次性审批；`commit_patch` 另有 Action WAL，崩溃后重算 hash 对账，不匹配就停下报人工复核，不会覆盖你手改的文件。
- **可检查的 Context**：默认总窗口 258K、预留 32K 输出。压缩链 `tool_output_pruner → spill → model_summary → tiered_checkpoint` 逐步缩减，每一步变换、被替换的原文和 token 估算都留存且可按字节回读。
- **多提供商**：内置 OpenAI、DeepSeek、GLM、Qwen/Qwen Code、MiniMax、Claude 预设，可自定义 OpenAI Chat Completions 或 Anthropic Messages 端点，支持 `low` 到 `max` 的推理强度映射。
- **代码图与真实诊断**：TS/JS 静态 import/export 图与顶层 AST symbol、`contains` 关系，带 Delta 对比；原生 stdio LSP 客户端把真实诊断接进证据链。
- **有界子 Agent 与 Agent Team**：父 Run 冻结子 Agent 的 provider、角色 Prompt hash、工具白名单与预算；Team 的 roster、mailbox 和任务板完全由 root Ledger 重放，任务用 optimistic `version` 仲裁，成员失联只把任务退回 open，绝不自动重派。
- **本地 Skill、MCP 与扩展**：`.tracegraph/skills/*/SKILL.md` 按需披露正文；Host-owned stdio MCP 客户端与六个可逆扩展 seam。三者都不执行第三方代码，未开放路径一律 fail-closed。
- **长期 Memory**：保留 G-21 的 JSONL/BM25 来源检索；V2 提供候选审核、纠正、撤销、删除与 Memory/Experience 控制面。V2 Memory 和 Experience Recall 默认关闭，显式开启后仍检查当前 scope、状态和 policy，并记录 Context 来源及 Adapter hand-off。
- **三种工作模式**：Plain Chat（无项目文件与命令能力，可生成任务范围内的图片和图表）、Managed Project、Linked Local Folder。

G-01 至 G-23 的迁移去向见[Outlive Agent 迁移基线](docs/outlive-agent-v2/10-tracegraph-to-outlive-migration/README.md)；当前实现、源码与验证入口见[模块文档](docs/modules/)；每个源文件的职责见[目录说明](DIRECTORY.md)。

## 一眼看清边界

当前产品入口是 CLI、Web Workbench 与本地 Electron Desktop。三端连接同一后台 Host 和共享 profile，调用同一组控制器；Desktop 使用隔离 Renderer、固定 preload 桥和鉴权私有通道，Web 使用本机 HTTP，实时事件来自规范 Ledger 的 SSE。共享界面以对话为主，活动和审阅按需打开，详见 [Desktop 边界](apps/desktop/README.md)及[本轮验收](docs/validation/unified-local-workbench/README.md)。Memory V2 生命周期、控制面和显式开关的 Runtime Recall 已实现；G-21 的 V1 store 仍独立保留。公开分发与外部安装验证以发布证据为准。

这里的“本地优先”表示 Workspace、Host 和 canonical Memory 由单机上的一个 Host 管理，并不表示所有请求都留在本机：模型请求会发送到用户配置的 provider；设置 `TRACEGRAPH_RETRIEVAL_URL` 时，检索内容也会发送到该检索端点。内置 retrieval-service 默认只监听 loopback；把 CLI 指向外部端点不会把它变成远程 Runtime 或多人协作服务。`project_id` 是检索分区键而非租户授权；可选 bearer token 是服务级凭据。

这个项目现在**不是**：

- **不是生产级沙箱**。OS 级隔离目前只覆盖 `run_test` 子进程，且仅 macOS Seatbelt 生效；Linux/Windows 的受限模式会以 `unmet_constraints` 拒绝启动，不会假装隔离成功。
- **不是语义检索**。Memory 是词法 BM25，没有 embedding、向量库或 reranker；同义改写与跨语言语义匹配不在能力内。
- **不是分布式 Runtime**。Ledger、Artifact 与 canonical Memory 由单机 Host 管理；没有跨 Host 锁、consensus、可靠消息队列或多人共享 Workspace。可选 retrieval-service 只提供独立的索引/搜索 API，不改变该边界。
- **不是 npm 包**。所有 workspace 包保持 `private`，发布工作流产出的是带 SHA-256 的私有 bundle，不是发布、签名或 provenance。
- **不是完整的代码理解**。CodeGraph 是静态 import/export 与顶层 symbol，不是动态调用、DI、路由或跨语言调用图。
- **不是 token 级流式输出**。模型返回的结构化 Decision 必须整体校验通过后才进入 Ledger；不暴露、也不伪造模型私有思维链。

更完整的迁移期边界及其 V2 处理决定见[迁移基线](docs/outlive-agent-v2/10-tracegraph-to-outlive-migration/README.md)——上面几条只是让你五分钟内知道哪些事不该指望。

## 安装后使用

打开 Outlive Agent 后，应用自动连接或启动随包运行时。首次引导依次保存模型配置、显式测试连接，再选择项目或开始普通对话。模型保存与连接成功是两种独立状态；可选 MCP/LSP 不阻塞普通对话。关闭窗口后任务继续，重新打开后恢复查看，不会自动重跑历史任务。升级时若发现旧版本仍拥有运行时，会拒绝混用并提供修复操作。

图片服务是可选项；设置中保存专用图片接口、Responses 图片工具或兼容聊天图片输出配置。实际生成的 PNG 与本地绘制的 SVG 图表均保存为任务 Artifact，Web/Desktop 可校验预览和下载，CLI 可导出；仅返回文字、代码或图片地址不算生成成功。完整协议与验证边界见[媒体说明](docs/modules/14-附件与多模态.md)。

本轮产品交付与真实操作证据见[安装即用验收](docs/validation/installable-product/README.md)。最终标志待选择：[四幅自然色候选](docs/brand/logo-candidates.png)。当前应用采用 A 作为预览。

## 共享本机工作台

Web、Desktop 和 CLI 默认连接同一个后台 Host，使用 `~/.outlive/profiles/default` 中的共享 profile。设置、模型凭据引用、项目、会话、Memory 和任务由 Host 管理；关窗口不取消任务。停止 Host 会终止后台执行，不默认安装开机启动。旧数据从设置“关于 → 安装诊断”的原生迁移入口或 `host migration preview|commit` 显式迁入，先检查冲突和备份；不会自动合并两个旧目录。

全页面工作台以对话为主：左侧新对话/记忆/项目/最近会话，左下角头像进入十类设置；运行默认一段公开说明和一行实际活动。按需展开工具结果、审阅变更，开发工具入口提供 Git/worktree、终端、本地预览和定时任务。每项操作的支持状态来自 Host 能力清单。模型保存后单独点击“测试连接”；测试只发送一句短文本。

随包 CLI 使用 `outlive`，普通命令自动发现或启动相同运行时；`host status`、`host restart`、`host stop` 用于明确的生命周期操作。源码 checkout 可使用 `env -u NODE_OPTIONS node apps/cli/dist/index.js doctor --json`。这些诊断命令不是安装用户的首次使用要求。

CLI 完整操作见 [CLI 说明](apps/cli/README.md)，三端能力与验收见[本机工作台报告](docs/validation/unified-local-workbench/README.md)。

## 源码开发运行

要求 Node.js `^22.19.0` 或 `>=24.0.0`，pnpm `11.19.0`。

```bash
pnpm install --frozen-lockfile
pnpm dev
```

打开 `http://127.0.0.1:4310` 使用 Web Workbench，新 profile 的开发网关请求 4311；已有后台运行时复用其实际地址，端口被占用时会明确报错。桌面安装包使用动态端口。

源码目录也可启动真实 Desktop（先完成 `pnpm build`）：

```bash
pnpm --filter @tracegraph/desktop start
```

`pnpm --filter @tracegraph/desktop preview` 打开明确标记的合成数据演示；[独立预览归档安装](docs/releases/README.md)提供无源码运行步骤。

在设置页选择提供商并填入 API Key，然后创建项目、提交任务。Key 是 write-only：只随本次保存请求发送，不写浏览器存储，Host/SDK 响应也不会回显。

以下环境变量配置用于保留的显式单次/legacy serve 入口；共享 profile 的持久模型配置使用设置页或 CLI config 命令。可复制 [`.env.example`](.env.example) 为 `.env.local`。例如 DeepSeek 只需：

```dotenv
DEEPSEEK_API_KEY=your-key
```

此时使用默认预设 `deepseek-v4-flash`；需要更大模型时再加 `TRACEGRAPH_MODEL=deepseek-v4-pro`。环境变量优先级高于持久化配置，且是只读来源——设置页会显示来源并禁止覆盖，修改后需重启。

只读浏览一个已有仓库：

```bash
pnpm --filter @tracegraph/cli run serve -- --readonly /absolute/repository/path
pnpm --filter @tracegraph/web run dev
```

权限预设由本机 Host 控制，默认 ceiling 为 `workspace-write`：

```bash
pnpm --filter @tracegraph/cli run serve -- --permission-preset workspace-write
```

也可在 `.env.local` 设置 `TRACEGRAPH_PERMISSION_PRESET=read-only|workspace-write|full-write`。Web 上的选择只能等于或低于 ceiling，项目内 `.tracegraph/policy.json` 只能进一步收紧；配置变更只影响之后创建的 Run。`full-write` 会明确显示 `enforcement:none`，不能理解成"沙箱已开启"。

正常三端数据和 Session 归共享 profile 管理。显式 legacy serve 的数据默认在仓库根 `.tracegraph/`，Session 在 `~/.tracegraph/sessions`；这两条兼容路径不代表新产品默认。`dataDir` 与 Session root 是一对：多实例部署时必须为每个实例同时指定独立且稳定的 `--session-dir`，否则启动恢复会 fail-closed。

## 项目模式

| 模式 | 当前能力 | 安全边界 |
|---|---|---|
| Plain Chat | 不选择项目即可多轮问答、公开执行进度、Markdown/Mermaid 与任务范围图片/图表输出；可分页回读当前 Run 自己的压缩 archive | 隐藏工作区的所有文件与命令能力均关闭；`read_artifact` 不是工作区读权限，不能读取或修改本机项目或其它 Run |
| Managed Project | 持久化项目、真实模型问答、read/search、创建或修改文件、Preview/Approval、Graph Delta | 位于 `.tracegraph/projects`；默认 `workspace-write` 下写入需一次性审批，`read-only` 禁写，显式 `full-write` 不询问但仍受 Workspace/schema/WAL 约束；API Key 只由本机 Host 解析 |
| Linked Local Folder | 由本机原生目录选择器打开已有目录；可选读写或只读；显示并可在系统文件管理器中定位目录 | 浏览器不能提交任意路径；Host 规范化并登记目录；Workspace capability 与 hard constraint 不可被 preset/rule 提权，默认 `workspace-write` 写入需一次性审批 |

原生选择过的目录登记在 `.tracegraph/local-projects.json`，Host 重启后恢复可用项目。移除本机目录只撤销 Outlive Agent 登记、不删除真实目录；由 Host 创建的托管项目会在确认后删除其 `.tracegraph/projects` 下的副本。目录被外部删除、移动或撤销权限后，Host 会跳过不可用记录并告警，不会把失效路径伪装成可用项目。

## 工程结构

```text
apps/web              React/Vite Web Workbench
apps/cli              Composition Root 与 Host 启动
apps/retrieval-service 可选 loopback HTTP 检索服务与 strict client
packages/contracts    Canonical/Wire Zod Contracts
packages/core         Runtime、Extension Manager、Context、Policy、Tools、Ledger、Artifacts、Session Store/Recovery
packages/retrieval    Markdown chunk、原子 JSONL 索引、本地 BM25 与原文回读
packages/telemetry    Vendor-neutral Telemetry、noop/memory/OTLP-HTTP sink 与 conformance suite
packages/codegraph    TS/JS 静态 Module Graph
packages/host         Fastify Command/Query/Artifact/SSE 边界
packages/sdk          Typed TypeScript Client
packages/test-support Fixture、纵向集成测试与有界 ScriptedMockProvider
evals/                离线行为、扩展、检索质量、性能、文档与时间旅行评测
examples/             内置 failing TypeScript repository
```

## 开发与验证

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm evals
pnpm coverage
pnpm supply-chain:check
pnpm release:check
```

`test` 是各包单测加工程门测试；`test:e2e` 走 `SDK → Host → Runtime → Approval → Patch → Test → Graph Delta` 纵向链；`evals` 是独立的离线评测面（行为回归、检索质量对比、性能门、文档一致性），不替代单测或 E2E，也不需要 API key。性能基线只允许显式 `pnpm evals:update` 改写，且改动应人工评审。

CI 由三个独立 job 组成（`typecheck` / `test` / `evals`），另设覆盖率门、fail-closed 锁文件与供应链校验、私有发布清单检查；第三方 Actions 固定到完整 commit SHA。

每个能力的实现文件与验证入口由对应[模块文档](docs/modules/)维护；跨模块一致性继续由离线文档评测检查。

## 文档

- [Outlive Agent V2 设计总纲](docs/outlive-agent-v2.md) —— 产品哲学与目标架构提案；不代表相关能力已经实现
- [Outlive Agent 迁移基线](docs/outlive-agent-v2/10-tracegraph-to-outlive-migration/README.md) —— 旧能力、边界及其 V2 去向
- [文档索引](docs/README.md) —— 模块 01–19 与全部参考文档的入口
- [目录说明](DIRECTORY.md) —— 每个源文件与配置文件的职责
- [变更记录](CHANGELOG.md)

## License

MIT，见 [LICENSE](LICENSE)。
