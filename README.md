# TraceGraph Agent

[English](README.en.md) · 简体中文

> **一个架构感知、全程可观测、Context、长期 Memory 与验证证据可检查的 Web Coding Agent。**
>
> 状态：`v0.1-alpha.0`。本地优先、单机运行、未发布 npm；P0 纵向链已实现。当前边界见对应的[模块文档](docs/modules/)与 [TraceGraph → Outlive 迁移基线](docs/outlive-agent-v2/10-tracegraph-to-outlive-migration.md)。

大多数 Coding Agent 只留给你一段聊天记录：改了什么、为什么改、依据是什么，散落在几十轮对话里，事后几乎无法复核。

TraceGraph Agent 把 Decision、Tool、Approval、Patch、Test、Context 和代码架构变化收进**同一条可回放的轨迹**。每个结论都能回溯到产生它的那次模型请求、那次工具执行和那份证据。

## 主要能力

- **可回放的事实链**：append-only JSONL Event Ledger + Artifact Store + Projection Replay。可按 Run 内 `sequence` 重建任意历史投影、比较两点的结构化差异并校验 canonical snapshot hash；Replay Debugger 支持逐事件单步前进/后退。
- **受控写入**：`Decision → Schema/Capability/Policy → Tool → Receipt → Observation` 全链可审计。写盘前有 PatchPreview、base/patch hash 绑定与一次性审批；`commit_patch` 另有 Action WAL，崩溃后重算 hash 对账，不匹配就停下报人工复核，不会覆盖你手改的文件。
- **可检查的 Context**：默认总窗口 258K、预留 32K 输出。压缩链 `tool_output_pruner → spill → model_summary → tiered_checkpoint` 逐步缩减，每一步变换、被替换的原文和 token 估算都留存且可按字节回读。
- **多提供商**：内置 OpenAI、DeepSeek、GLM、Qwen/Qwen Code、MiniMax、Claude 预设，可自定义 OpenAI Chat Completions 或 Anthropic Messages 端点，支持 `low` 到 `max` 的推理强度映射。
- **代码图与真实诊断**：TS/JS 静态 import/export 图与顶层 AST symbol、`contains` 关系，带 Delta 对比；原生 stdio LSP 客户端把真实诊断接进证据链。
- **有界子 Agent 与 Agent Team**：父 Run 冻结子 Agent 的 provider、角色 Prompt hash、工具白名单与预算；Team 的 roster、mailbox 和任务板完全由 root Ledger 重放，任务用 optimistic `version` 仲裁，成员失联只把任务退回 open，绝不自动重派。
- **本地 Skill、MCP 与扩展**：`.tracegraph/skills/*/SKILL.md` 按需披露正文；Host-owned stdio MCP 客户端与六个可逆扩展 seam。三者都不执行第三方代码，未开放路径一律 fail-closed。
- **长期 Memory**：Markdown 按标题/段落分块、原子 JSONL 索引、本地 BM25 检索，命中带来源路径、精确行号与内容 hash，每轮模型请求前自动注入带引用的上下文。
- **三种工作模式**：Plain Chat（无任何文件与命令能力）、Managed Project、Linked Local Folder。

G-01 至 G-23 的迁移去向见[TraceGraph → Outlive 迁移基线](docs/outlive-agent-v2/10-tracegraph-to-outlive-migration.md)；当前实现、源码与验证入口见[模块文档](docs/modules/)；每个源文件的职责见[目录说明](DIRECTORY.md)。

## 一眼看清边界

这个项目现在**不是**：

- **不是生产级沙箱**。OS 级隔离目前只覆盖 `run_test` 子进程，且仅 macOS Seatbelt 生效；Linux/Windows 的受限模式会以 `unmet_constraints` 拒绝启动，不会假装隔离成功。
- **不是语义检索**。Memory 是词法 BM25，没有 embedding、向量库或 reranker；同义改写与跨语言语义匹配不在能力内。
- **不是分布式系统**。Ledger、Artifact、Memory 与检索索引只协调本进程，没有跨 Host 锁、consensus 或可靠消息队列。
- **不是 npm 包**。所有 workspace 包保持 `private`，发布工作流产出的是带 SHA-256 的私有 bundle，不是发布、签名或 provenance。
- **不是完整的代码理解**。CodeGraph 是静态 import/export 与顶层 symbol，不是动态调用、DI、路由或跨语言调用图。
- **不是 token 级流式输出**。模型返回的结构化 Decision 必须整体校验通过后才进入 Ledger；不暴露、也不伪造模型私有思维链。

更完整的迁移期边界及其 V2 处理决定见[迁移基线](docs/outlive-agent-v2/10-tracegraph-to-outlive-migration.md)——上面几条只是让你五分钟内知道哪些事不该指望。

## 快速运行

要求 Node.js `22.19+` 与 pnpm `11.19.0`。

```bash
pnpm install --frozen-lockfile
pnpm dev
```

打开 `http://127.0.0.1:4310` 使用 Web Workbench，Host API 在 `http://127.0.0.1:4311`。

在设置页选择提供商并填入 API Key，然后创建项目、提交任务。Key 是 write-only：只随本次保存请求发送，不写浏览器存储，Host/SDK 响应也不会回显。

也可以复制 [`.env.example`](.env.example) 为 `.env.local`，优先通过环境变量配置。例如 DeepSeek 只需：

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

数据默认落在仓库根的 `.tracegraph/`，Session 默认在 `~/.tracegraph/sessions`，两者均已加入 `.gitignore`。`dataDir` 与 Session root 是一对：多实例部署时必须为每个实例同时指定独立且稳定的 `--session-dir`，否则启动恢复会 fail-closed。

## 项目模式

| 模式 | 当前能力 | 安全边界 |
|---|---|---|
| Plain Chat | 不选择项目即可多轮问答、公开执行进度、Markdown/Mermaid 输出；可分页回读当前 Run 自己的压缩 archive | 隐藏工作区的所有文件与命令能力均关闭；`read_artifact` 不是工作区读权限，不能读取或修改本机项目或其它 Run |
| Managed Project | 持久化项目、真实模型问答、read/search、创建或修改文件、Preview/Approval、Graph Delta | 位于 `.tracegraph/projects`；默认 `workspace-write` 下写入需一次性审批，`read-only` 禁写，显式 `full-write` 不询问但仍受 Workspace/schema/WAL 约束；API Key 只由本机 Host 解析 |
| Linked Local Folder | 由本机原生目录选择器打开已有目录；可选读写或只读；显示并可在系统文件管理器中定位目录 | 浏览器不能提交任意路径；Host 规范化并登记目录；Workspace capability 与 hard constraint 不可被 preset/rule 提权，默认 `workspace-write` 写入需一次性审批 |

原生选择过的目录登记在 `.tracegraph/local-projects.json`，Host 重启后恢复可用项目。移除本机目录只撤销 TraceGraph 登记、不删除真实目录；由 Host 创建的托管项目会在确认后删除其 `.tracegraph/projects` 下的副本。目录被外部删除、移动或撤销权限后，Host 会跳过不可用记录并告警，不会把失效路径伪装成可用项目。

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
- [TraceGraph → Outlive 迁移基线](docs/outlive-agent-v2/10-tracegraph-to-outlive-migration.md) —— 旧能力、边界及其 V2 去向
- [文档索引](docs/README.md) —— 模块 01–19 与全部参考文档的入口
- [目录说明](DIRECTORY.md) —— 每个源文件与配置文件的职责
- [变更记录](CHANGELOG.md)

## License

MIT，见 [LICENSE](LICENSE)。
