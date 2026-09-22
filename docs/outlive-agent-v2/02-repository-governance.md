---
id: outlive-agent-v2-repository-governance
title: Outlive Agent V2 仓库治理
status: proposed
scope: repository
language: zh-CN
parent: ../outlive-agent-v2.md
last_reviewed: 2026-09-23
---

# 02 · 仓库治理

## 1. 目标

庞大工程最容易丢失的不是代码，而是三类上下文：

1. **为什么**做这个决定；
2. **如何**可靠地重复某种操作；
3. **哪些证据**说明当前行为真的成立。

V2 分别用 Agent Notes、Agent Skills 和 Verification/Fixtures 保存这三类信息。它们不能互相替代：Note 不是操作脚本，Skill 不是架构理由，测试通过也不能解释为什么选择这个方向。

## 2. 治理文件地图

```text
AGENTS.md                         项目级规则、阅读顺序、硬边界
.agents/
├── notes/
│   ├── README.md                 生命周期与格式
│   ├── TEMPLATE.md
│   ├── proposed/                 已提出，未成为当前现实
│   ├── implemented/              当前有效决策
│   ├── rejected/                 被否决并保留原因
│   └── archived/                 曾经有效，现已退出当前架构
└── skills/
    └── README.md                 可复用工作流目录与创建门槛
docs/
├── outlive-agent-v2.md           V2 主入口
├── outlive-agent-v2/             目标设计和任务 DAG
├── modules/                      当前已实现模块说明
├── postmortems/                  事故/回归复盘（目标）
└── generated/                    生成图和目录，不手工改（目标）
scripts/                          门禁、生成器、迁移器
benchmarks/                       跨包性能门（目标）
snapshots/                        录制 Session 回归（目标）
evals/                            行为/质量/检索效果
```

## 3. 根 `AGENTS.md` 的职责

根规则只保存所有任务都必须知道的内容：

- 先读哪些真源；
- current/target 的事实边界；
- 依赖方向和禁止项；
- 持久格式、模型可见内容和副作用的硬约束；
- 常用验证命令；
- 哪些子目录有更具体规则。

它不应复制模块文档、长篇设计或每个命令的完整说明。细节通过链接指向唯一真源。否则 Agent 每次加载的上下文不断膨胀，而且同一规则很快出现多个版本。

### 3.1 分层规则

当某个目录有特殊风险时，可以增加局部 `AGENTS.md`：

| 位置 | 应负责 |
|---|---|
| `packages/AGENTS.md` | package API、测试、跨包 import、README 契约 |
| `scripts/AGENTS.md` | 生成器、门禁、临时资源和跨平台规则 |
| `snapshots/AGENTS.md` | 录制、脱敏、fixture ownership、更新纪律 |
| `benchmarks/AGENTS.md` | 测量边界、预算、硬件校准、禁止网络 |
| `apps/desktop/AGENTS.md` | Electron/Tauri 安全、IPC、渲染器边界 |

局部规则只能补充或收紧，不能悄悄放宽根规则。

## 4. Agent Notes：保存“为什么”

### 4.1 生命周期

```text
proposed ──accepted+shipped──> implemented ──no longer current──> archived
    └────────rejected────────> rejected
```

- `proposed` 可以使用将来时，必须有验收标准和风险。
- `implemented` 只能描述当前已交付现实；从 proposed 移入时必须重写，不只是移动文件。
- `rejected` 保留原提案和明确拒绝原因，防止同一争论周期性重演。
- `archived` 是曾经成立、现在不再成立的历史，不应继续被 Agent 当作当前指令。

### 4.2 文件格式

每份 Note 使用稳定头部：

```markdown
# Agent Note: <title>

Status: proposed

## Problem
## Proposal
## Alternatives considered
## Acceptance criteria
## Risks
```

Implemented Note 改为 `Decision` 与 `Consequences`；Rejected 在状态行写一行原因。文件名以最初提出日期开头，例如：

```text
2026-09-23-outlive-agent-v2.md
```

Note 必须记录真实考虑过的替代方案，不能为了模板完整凭空编造。

### 4.3 何时必须写 Note

- 新增或改变公开协议、事件、持久格式；
- 更换状态 owner 或写入路径；
- 新增 package family 或打破现有依赖方向；
- 改变 Memory 的准入、召回、保留或删除语义；
- 引入新的权限、sandbox 或 credential 机制；
- 新增跨进程 app/profile；
- 修改 benchmark/snapshot 的事实口径；
- 接受会持续存在的重大限制。

修拼写、局部 bug 或无语义重构不必强制写 Note。

## 5. Agent Skills：保存“怎么重复做”

Skill 是可复用操作手册，适合稳定且多次重复的仓库流程。建议候选：

| Skill | 解决什么 | 前置真源 |
|---|---|---|
| `outlive-pre-push` | 按改动面选择最窄验证，不重复跑整仓 | root scripts + CI |
| `outlive-code-review` | 按事实、边界、恢复、兼容性审查 | AGENTS + module docs |
| `outlive-agent-note` | 创建、接受、拒绝、归档 Note | `.agents/notes/README.md` |
| `outlive-doc-sync` | 更新链接、目录、生成图和 current/target 标签 | docs manifest |
| `outlive-snapshot` | 录制、脱敏、刷新、审查 Session fixture | snapshots policy |
| `outlive-benchmark` | 运行/更新性能预算并生成对比报告 | benchmark policy |
| `outlive-translate-docs` | 维护中英文配对和 YAML hash | i18n policy |
| `outlive-release-proof` | 生成恢复、取消、证据包三条可演示证明 | release checklist |

### 5.1 Skill 创建门槛

只有满足以下条件才创建 Skill：

- 流程至少重复两次，步骤已经稳定；
- 可以指出唯一脚本/文档真源；
- Skill 能减少错误，而不是复制一份 README；
- 触发条件明确，不会在普通任务里自动执行高成本操作；
- 输出可验证，失败会停止而不是继续声称成功。

Skill 应是“薄指针”：调用仓库脚本并解释选择，不重新实现脚本逻辑。

## 6. `scripts/`：维护工程，不承载产品 Runtime

`scripts/` 负责：

- 架构和依赖门禁；
- 生成 module/service/event/tool 目录；
- 文档链接与 current/target 一致性检查；
- package/manifest/lockfile/release hygiene；
- Session format migration 和 fixture normalization；
- benchmark/snapshot orchestration；
- 临时开发数据清理。

它不负责：

- Agent Loop、工具执行、Memory recall 等生产行为；
- 被产品运行时隐式 import 的业务逻辑；
- 只能在维护者机器上成立的秘密步骤。

门禁脚本必须有自己的反向测试：构造一个最小违规 fixture，证明脚本会失败。

## 7. 文档真源与生成物

### 7.1 四类文档

| 类别 | 示例 | 写作时态 |
|---|---|---|
| Current reference | `README.md`、`docs/modules/*` | 现在时，只写已验证事实，并直接指向源码、测试与命令 |
| Target design | `docs/outlive-agent-v2/*` | 明确 proposed/target/deferred |
| Decision record | `.agents/notes/*` | 随生命周期变化 |
| Generated catalog | module graph、event/tool catalog | 由脚本写，不手工编辑 |

不再维护覆盖全仓的手工 verification map 或独立限制清单。迁移期边界统一收敛到 `10-tracegraph-to-outlive-migration.md`，稳定后的当前事实回写 owning module；一致性由 eval、架构门禁和生成目录证明。

### 7.2 每个 package README 的最低契约

每个物理 package 应说明：

1. Purpose：它唯一拥有的责任；
2. Public API：导出与稳定性；
3. Dependencies：允许依赖什么；
4. State ownership：是否拥有持久/运行时状态；
5. Extension points：Definition/Provider/Consumer 中扮演什么角色；
6. Model experience：是否改变 Prompt、tool schema、token 和 cache；
7. Verification：最窄可执行命令；
8. Known limitations：长期边界，不把普通 TODO 塞进来。

### 7.3 自动生成内容

建议逐步生成：

- package dependency DAG；
- capability Definition/Provider/Consumer 图；
- event producer/consumer 表；
- tool catalog；
- profile resolved composition；
- protocol schema；
- source-to-doc ownership map。

CI 使用 `--check` 比较生成结果的新鲜度；生成器不能在普通检查中静默改文件。

## 8. 变更工作流

```text
1. 定位 current truth + target design
2. 判断是否需要 Agent Note
3. 写失败场景/验收标准
4. 先加边界或行为测试
5. 做一个最小 coherent change
6. 跑最窄验证
7. 更新 owning module docs / migration baseline
8. 若跨架构，再跑生成与门禁
9. 报告执行过的命令和未验证项
```

### 8.1 PR 切片纪律

- 非机械变更尽量小于 500 行，通常不超过 800 行。
- “移动文件”“更改行为”“改协议”“更新基线”分开。
- 每个 PR 只有一个主要工程支柱。
- 任何持久 schema 变化先增加 reader/migration，再切 writer，最后清理旧兼容路径。
- 基线或 snapshot 更新必须能指出哪个行为变化导致 diff；禁止“全部接受”。

## 9. Repository hygiene

### 9.1 包与依赖

- 禁止跨 package 深层 import，只走公开 exports。
- 禁止依赖环；依赖图由门禁生成并检查。
- 新 package 不得只有 barrel re-export。
- 新依赖必须说明删除了哪些自有代码/测试，以及供应链代价。
- 可选 provider 不得成为核心包的强制运行依赖。

### 9.2 状态与并发

- 一个状态一个 owner，一个写入入口。
- 命令 idempotency、operation idempotency 和 provider idempotency 分开。
- 进程、端口、临时目录、watcher 都必须有明确 owner 和 teardown。
- 只在测试单独运行时通过，视为测试缺陷。

### 9.3 Secret 与隐私

- 凭据只以 reference 穿过公共契约，不回显值。
- Snapshot、Evidence Bundle 和 Memory Export 默认执行敏感信息检查。
- 禁止把用户仓库、真实 Session 或网络服务直接当 benchmark 输入。
- Telemetry 与本地 Trace 分开；上传必须 opt-in 且有字段白名单。

## 10. Website 是否需要

当前不需要立即复制一个 `website/`。网站只有在以下条件同时满足时进入路线：

- 公共文档已超过 README 能承载的规模；
- 有可发布版本和稳定安装路径；
- docs 链接、双语配对和生成目录已有 CI 门禁；
- website 可以从 `docs/` 投影，不会形成第二份正文。

届时建议使用静态文档站（例如 VitePress），职责仅是导航、搜索、版本切换和演示入口。顺带澄清：所参考工程的 `website/` 是 VitePress 投影，不是 WordPress 站点。

## 11. 治理完成标准

- 根 `AGENTS.md` 存在且只引用真源；
- 至少一个 proposed Note 完整走完 implemented/rejected 生命周期；
- package DAG、文档链接和 current/target 标签可由 CI 检查；
- 每个新增 package 有 README 契约和最窄验证；
- snapshot/benchmark 更新均需要显式命令和 reviewable diff；
- Agent 能在不读取整个仓库的情况下，从主入口定位 owner、约束和测试。
