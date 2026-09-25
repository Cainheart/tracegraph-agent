---
id: outlive-agent-v2-reference-lineage
title: Outlive Agent V2 设计依据与取舍
status: internal-design-input
scope: design-lineage
language: zh-CN
parent: ../../outlive-agent-v2.md
last_reviewed: 2026-09-25
---

# 08 · 设计依据与取舍

## 子模块导航

```mermaid
flowchart LR
  S[源码观察] --> C[可迁移能力]
  C --> A[吸收 / 改造 / 拒绝]
  A --> D[Outlive 自有决定]
```

| 子模块 | 评审焦点 |
|---|---|
| [参考源码观察](01-source-observations.md) | 观察事实、适用上下文和证据强度 |
| [吸收与拒绝矩阵](02-adopt-reject-matrix.md) | 哪些模式采用、改造、延后或明确拒绝 |

> 本文是内部设计输入，允许明确写出参考项目。产品主文档只陈述 Outlive 自己的契约，不使用“因为某项目这样做所以我们照做”作为理由。

## 1. 审计范围

本次阅读的是源码快照，而不是只看项目首页：

| 项目 | 源码快照 | 重点阅读 |
|---|---|---|
| DeepSeek Harness | 源码归档快照（无 `.git` 元数据） | 根/局部 AGENTS、architecture、package groups、Agent Notes/Skills、benchmarks、snapshots、i18n、Desktop |
| ZCode | 源码归档快照（无 `.git` 元数据） | 根/CLI AGENTS、architecture policy、Desktop/Web/CLI、protocol/runtime 边界 |
| Codex | 源码归档快照（无 `.git` 元数据） | Rust crate 拆分、core 约束、app-server protocol、memories、rollout trace、sandbox |
| Claw Code | 源码快照（可追溯本地 commit） | PHILOSOPHY、Rust crate、runtime/tools、agent-managed workflow |
| Pi | 源码快照（可追溯本地 commit） | minimal agent core、event flow、session tree、extensions、RPC、permissions boundary |
| TraceGraph | 本仓 | README、modules、当前 tests/evals、源码体量与依赖、V2 迁移基线 |

前三个快照来自源码归档且没有 `.git` 元数据，不能声称精确 commit；Claw 和 Pi 的快照可追溯到本地 commit。未来再次设计时应记录新的 source snapshot date。

## 2. DeepSeek Harness

### 2.1 吸收

- **能力家族**：按 capability 分组，每组包含 Definition/Provider/Consumer，而不是按“frontend/backend/common”粗分。
- **组合优于特权内核**：profile/bundle 选择插件树，新能力走扩展点，不给 loop 不断加分支。
- **Model-visible iff logged**：所有进入模型的内容能从 Session 恢复。
- **Notes 与 Skills 分工**：决策记忆和操作手册分开，有 proposed/implemented/rejected/archived 生命周期。
- **Recorded Session snapshots**：真实会话作为回放输入，workspace 结果独立验证，模型说“完成”不算副作用证明。
- **Benchmarks 按用户路径**：不镜像 package tree。
- **Desktop 私有 Host**：Renderer/Main/Host 分权，桌面不需要默认开放 Web server。
- **双语配对和生成目录**：文档可被机器检查，而不是靠维护者记忆。

### 2.2 不复制

- 不引入 Cordis 或照搬插件 API；TraceGraph 已有 Extension Manager 和显式依赖注入基础。
- 不一次创建所有 package group；当前团队规模和仓库体量不需要上百 workspace。
- 不复制 `native/`、`python/`、`vendor/`；它们解决的是该项目自己的发行/兼容需求。
- 不把 website 提前当成核心工程。
- 不把每项规则都复制成长篇 AGENTS，优先薄指针和本仓可执行脚本。

## 3. ZCode

### 3.1 吸收

- **Desktop/Web/Terminal 共用 Agent Runtime**，客户端只做 transport 和 presentation。
- **Desktop Main 不承载 task/session 状态**，通过严格协议和 Host 通信。
- **traceId 高于 sessionId**，异步任务、子 Session、provider 和 I/O 不丢关联。
- **工具声明副作用、超时、取消、并发、输出上限和权限**，权限系统读取声明而非临时猜测。
- **architecture-policy 的渐进治理**：旧模块可标 legacy，新模块/迁移模块转 managed，规则不必一次压垮存量代码。
- **最大文件、公开方法、循环、深层 import** 等可机器化约束。
- **先 spec 再行为**：状态 owner、接口和验收场景先明确。

### 3.2 不复制

- 不把 UI Design System 和产品 Runtime 规则混成一个 V2 核心文档。
- 不延续 services 大包或 CLI runtime 独立成第二套架构。
- 远程 Workspace/手机远控不进入当前范围；先做 local-first 一致性。

## 4. Codex

### 4.1 吸收

- **抵抗 core 膨胀**：新概念先找 owner 或新 crate/package，而不是继续塞进最大内核。
- **Context 有硬上限且增量构建**：不重写历史，关注缓存前缀和单项大小。
- **App-server v2 式协议纪律**：资源/动作命名、schema 生成、集成测试和兼容面审计。
- **跨平台 sandbox 是真实实现差异**，无法满足时 fail closed，而不是统一显示“已沙箱”。
- **Observe first, interpret later**：热路径写原始 ordered events 和 payload refs，离线 reducer 生成语义图。
- **Trace 与产品 Session identity 分开**，一个父子 Agent 树可以共享 trace writer。
- **Memory 两阶段**：每 Session 提取与全局合并分开，claim/lease/backoff 避免重复后台工作。

### 4.2 不复制

- 不迁移到 Rust；语言选择不是当前瓶颈。
- 不把 app-server 的全部产品面复制进早期 API。
- 不用“best-effort trace”替代 TraceGraph canonical Ledger；诊断 Trace 与业务事实强度不同。
- 不假定本仓需要 Codex 的云任务、账户或连接器规模。

## 5. Pi

以下入口形态描述的是 Pi 的产品，不代表 Outlive Agent 的入口规划；Outlive Agent V2 当前只规划 Desktop、Web UI、CLI。

### 5.1 吸收

- **极小 Agent Core**：状态、tool loop、event stream 与 provider API 分离。
- **AgentMessage 与 LLM Message 分开**：UI/业务消息经过显式 transform/convert 才进入模型。
- **清晰事件流**：agent/turn/message/tool start-update-end 可构建响应式客户端。
- **JSONL tree Session**：parentId 支持原位分支，compaction 不删除完整历史。
- **Extension/Skill/Prompt/Theme 可塑性**：产品不必内置每种工作流。
- **SDK、RPC、interactive、print/JSON 四种入口**共用核心。
- **明确说不做什么**：保持内核最小本身是一种产品哲学。

### 5.2 不复制

- Pi 默认不提供权限系统，建议外部容器化；Outlive 的核心承诺要求 policy/approval/sandbox 成为一等能力，不能外包。
- 不采用“No MCP / No subagent / No plan mode”的具体产品取舍；我们采用的是“可插拔而非塞进 loop”的方法。
- 不把扩展代码默认视为可信；本仓当前继续使用受限声明式扩展。

## 6. Claw Code

### 6.1 吸收

- **人定方向，Agent 完成劳动**：人不应在终端里微操每一步。
- **计划→执行→复核→重试**成为自动循环，而不是人手工串联多个 Agent。
- **通知路由离开 coding context**：状态和 attention signal 不占用模型工作上下文。
- **Chat/手机是有效的人机入口**：人可以离开机器，系统继续有界工作。
- **仓库本身是 Agent 可维护的产品证据**：规则、doctor、machine JSON、parity harness 都可检查。

### 6.2 不复制

- 当前 Rust runtime 仍有较多 flat modules 和巨型文件，不适合作为包拓扑模板。
- 其价值重点是自主协作哲学和兼容/展示，不是 Outlive 的 canonical evidence 模型。
- 不把 Discord 设为核心依赖；它只是可选通知/控制 adapter。
- 不以“兼容某闭源产品的工具数量”衡量 V2 成功。

## 7. 社区问题证据

这些链接用于证明“有人提出过问题”，不构成全 GitHub 热度排名，也不自动成为产品需求。只有能与本仓证据、产品定位和可验收任务对齐的诉求才进入 roadmap。

- **Pi**：[durable orchestration / scheduled-agent platform](https://github.com/earendil-works/pi/discussions/3337)、[Agent Loop 与可复用执行库](https://github.com/earendil-works/pi/issues/552)、[无进展循环](https://github.com/earendil-works/pi/issues/4338)。
- **DeepSeek Harness**：[loop budget 与 no-progress 检测](https://github.com/deepseek-ai/deepseek-harness/discussions/5072)、[取消与未知副作用](https://github.com/deepseek-ai/deepseek-harness/discussions/2283)、[Context 生命周期](https://github.com/deepseek-ai/deepseek-harness/discussions/5310)、[指令来源追溯](https://github.com/deepseek-ai/deepseek-harness/discussions/6378)。
- **ZCode**：[远程连接与插件](https://github.com/zai-org/feedback/issues/77)、[远程子 Agent 权限降级](https://github.com/zai-org/feedback/issues/73)。
- **Claw Code**：[项目 hooks 绕过只读模式](https://github.com/ultraworkers/claw-code/issues/3301)、[结构化 JSON 输出](https://github.com/ultraworkers/claw-code/issues/3262)。
- **Codex / GitHub Community**：[持久角色 Agent](https://github.com/openai/codex/issues/36224)、[长任务 checkpoint](https://github.com/openai/codex/issues/27008)、[子 Agent 状态与容量](https://github.com/openai/codex/issues/23479)、[Copilot coding agent 状态 API](https://github.com/orgs/community/discussions/185347)。

归并后的共同需求是：任务可恢复、停止真正生效、无进展可识别、状态可被 API 消费、子 Agent 可治理、Context 来源可解释，以及 Memory 可纠正/删除。对应验收位于主文档 §8 和 `roadmap.yaml`。

## 8. TraceGraph 已有优势

外部项目不是起点替代品。本仓当前已经拥有：

- append-only hash-chained Event Ledger；
- Artifact、Projection、Replay 与时间旅行；
- Action WAL、before-image、恢复对账；
- policy/approval 在副作用前强制；
- Context surface、spill、summary 与 token 计量；
- Memory origin/trust/source refs + BM25；
- Agent Team、Subagent、Skill、MCP、LSP、CodeGraph；
- Web/Host/SDK/CLI 的纵向链；
- owning module 文档与实现一致性检查/门禁。

因此 V2 不应重写 Runtime。最优策略是：**保留可信数据链，拆出能力 owner，再把 Memory/Experience 生命周期建立在这条证据链上。**

## 9. 综合取舍矩阵

| 设计问题 | 选择 | 原因 |
|---|---|---|
| 大内核还是插件化 | 小 loop + 显式 capability seam | 避免 `runtime.ts` 继续吸收功能 |
| 直接物理拆几十包 | 否，先逻辑 family + managed gate | 控制迁移风险和构建成本 |
| Memory 由模型直接写 | 否，模型只提 candidate | 防污染、可 review、可撤销 |
| 只存摘要 | 否，raw evidence 与 projection 分离 | 摘要可错且需重建 |
| 多客户端各自状态 | 否，共用 protocol/controller/runtime | 防语义漂移 |
| Desktop 复用 Web server | 默认否，私有 framed bridge | 降低本机端口和鉴权风险 |
| MCP 作为权限层 | 否 | MCP 是连接协议，不拥有 policy |
| 所有 Agent 控制平面 | 延后且有前置条件 | 非结构化适配会降低证据强度 |
| 个人数字永生 | 不进入 V2 MVP | 伦理、身份、同意和产品风险远高于工程记忆 |
| 网站 | 延后 | 先建立文档真源与门禁 |

## 10. 独有设计，而非参考拼装

V2 自己的中心不是任一参考项目已有的单点功能，而是以下闭环：

```text
可恢复的 Runtime
  + canonical Evidence
  + Memory candidate/review/lineage/forget
  + Experience applicability/counterexample
  + portable Legacy Capsule
  + “记忆延续、权限不延续”
```

这条闭环把人的愿景、Agent 社区的可靠性痛点和 TraceGraph 的既有工程资产连成同一产品，而不是把五个项目的功能列表合并。
