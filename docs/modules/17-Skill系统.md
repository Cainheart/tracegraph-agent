# 模块 17：Skill 系统（G-10）

> 定位：把 Agent Skill 作为可审计的本地 Markdown 能力目录，先向模型公开有限的目录元数据，再由 `load_skill` 按需载入正文；Skill 不能扩大 G-06 权限，只能在当前 Run 内进一步收紧工具面。
> 代码：`packages/contracts/src/skill.ts`、`packages/core/src/domains/skill/skill.ts`、`packages/core/src/domains/tools/registry.ts`、`packages/context/src/{context,context-compaction}.ts`、`packages/core/src/domains/runtime/runtime.ts`、`apps/cli/src/skill-command.ts`、`packages/host/src/webserver/index.ts`、`packages/sdk/src/index.ts`、`packages/workbench/src/components/SettingsPanel.tsx`
> 实现状态：**已实现/已验证**；G-10 追加 3 个 canonical Event，G-11 再追加 5 个 MCP Event，G-12 再追加 2 个 LSP Event，G-20 再追加 2 个 CodeIntel Event，MEM-042 再追加 `memory.use_status`，当前为 103 种 Event、20 个内置 Tool（含 `load_skill`）；`PROJECTOR_VERSION = "tracegraph.projector.v9"`。

## 1. 文件布局与安全边界

Skill 只是一组数据文件，不会被 `import()`、`require()` 或执行。扫描两个固定范围：

- 项目级：`<project>/.tracegraph/skills/<skill-name>/SKILL.md`；
- 用户级：`~/.tracegraph/skills/<skill-name>/SKILL.md`，CLI 和嵌入式 Host 可显式注入测试根目录。

扫描只接受真实目录、真实 `SKILL.md` 普通文件和根目录内的路径。符号链接、越界路径、读取失败和超过 256 KiB 的文件都会跳过并记录诊断。单次最多收集 256 个直接子目录，frontmatter 最多 32 KiB。

`SKILL.md` 使用受限 YAML frontmatter，必须以 `---` 开始和结束，并包含与目录名相同的 `name`、`description`、`version`。可选 `allowed_tools` 使用内联列表或缩进列表：

```markdown
---
name: review
description: Review changed files
version: 1.0.0
allowed_tools: [read_file, search]
---
先读取变更，再给出审查结论。
```

未知字段、坏列表、空正文或不合法的工具/名称会 fail-closed。坏文件不会阻止 Host 启动；它只产生 `skill.load_failed` 的诊断事实。

## 2. 注册、冲突与可重放事实

`SkillRegistry.scan()` 先读用户目录，再读项目目录。相同 `name` 时项目级定义胜出，并写入 `skill.conflict`，而非静默覆盖。选中的元数据、正文 hash、路径、冲突和诊断共同形成 `registry_digest`。

Run 启动时把不含正文的目录快照写入 `skill.registry_loaded`：模型只会看到 `name`、`description` 和 `version`。每个冲突和跳过项分别追加对应的审计事件。恢复时重新扫描并比较 recovery v5 中冻结的 `registry_digest`；文件发生漂移会 fail-closed，不会用另一份 Skill 重跑旧 Run。

这三类事件均追加在既有 Event literal 之后：

| Event | 含义 |
|---|---|
| `skill.registry_loaded` | 本 Run 采用的目录摘要、技能数量、冲突和诊断数量 |
| `skill.conflict` | 用户级/项目级同名 Skill 的胜负关系与路径 |
| `skill.load_failed` | 坏文件、找不到 Skill 或加载/权限失败的有界原因 |

## 3. 渐进披露与 Token/Context 计量

系统 Context 只渲染目录 catalog，不把 Skill 正文提前塞进 system prompt。模型需要正文时调用 `load_skill({"name":"review"})`：

1. Runtime 在冻结的 registry snapshot 中查找并校验名称；
2. 读取正文并通过标准 `RawToolResult` 返回，正文位于 tool section 的 `raw/content`，仍受 G-02 工具输出上限、excerpt 和 spill 规则约束；
3. tool Observation 中的正文摘要进入下一轮 Context，因而由现有 G-03 Token Meter 和 Context Manifest 计量；
4. 返回的 facts 带有 skill/version/body hash、声明工具、实际生效工具和被忽略的未知工具，便于回放与恢复诊断。

未调用 `load_skill` 时，正文不会出现在模型可见 Context。正文不会复制进 `skill.registry_loaded`，避免启动事件泄漏完整指令。

## 4. 工具白名单与权限交集

`allowed_tools` 是临时的 Run-level 收紧，不是授权来源。加载后有效工具集合为：

```text
parent/subagent allowlist
∩ G-06 全局 Permission/Policy allowlist
∩ Skill allowed_tools
```

未知工具名会被忽略并在 load receipt 中说明；如果 `allowed_tools` 为空，除 `load_skill` 外不开放其它工具。任何模型伪造的越权 Tool call 都在预检、执行前授权和最终授权三处 fail-closed，写入 `policy.denied{reason:"skill_tool_allowlist"}`，不会产生 `tool.started`、WAL 或 workspace mutation。Skill 也不能放宽 Workspace capability、Plan Mode、approval 或 Sandbox hard constraint。

`load_skill` 本身是 read-only、不可并发、10 秒超时的内置 Tool，并接受标准 strict input/output。它包含在 G-06 预设的全局工具名集合中，但成功加载后只能缩小后续工具面。

## 5. CLI、Host、SDK 与 Web

```bash
tracegraph skills list --project-root <path> --user-root <path>
tracegraph skills validate --project-root <path> --user-root <path>
```

`runSkillsCommand` 实现 `list`/`validate`：输出 registry digest、去正文 catalog、冲突和诊断；`validate` 在存在诊断时返回非零退出码。Host 的 `GET /api/skills` 为每个已登记项目返回严格的 `SkillProjectInspectionSchema` project inspection，SDK `listSkills()` 重新做 schema 校验。Web Settings 展示已加载技能、版本/来源、冲突和跳过诊断，不显示正文。

## 6. 验证与边界

| 层 | 主要证据 |
|---|---|
| Contracts | `packages/contracts/src/skill-g10.test.ts`：名称/路径、strict snapshot、诊断/冲突、三种 Event |
| Core | `packages/core/src/domains/skill/skill.test.ts`：坏 frontmatter 跳过、项目优先、目录渐进披露、正文进入 tool Context、白名单拒绝伪造调用 |
| Tool/Context | `tool-registry.test.ts`、Context/Token tests：20-tool surface、`load_skill` output bound、Manifest/Observation 链路 |
| Host/SDK/CLI/Web | `/api/skills`、typed `listSkills()`、`tracegraph skills list|validate` 与 Settings loaded-skills/conflicts 面板 |
| Evals/docs | `evals/docs/implementation-consistency.eval.ts` 核对 100 Event、20 Tool、G-10/G-11/G-12 文件、路由和 CLI 命令 |

当前明确不支持：从网络/npm/任意路径动态安装 Skill、Skill 脚本执行、签名分发、跨 Host Skill registry、正文的长期 Memory 写入，以及完整 IDE 级 LSP platform。G-12 已接入 Host 管理的原生 stdio LSP seam，但完整 workspace indexing、自动 Context 注入、HTTP/SSE 与跨 Host session 仍未开放。MCP 已由 G-11 接入，但只支持 Host 管理的 stdio/native bridge，PTC、HTTP/SSE 和 resources/instructions 仍未开放。Skill 正文仍是本地受信数据，真正的外部副作用必须走独立的 Tool、Policy、Sandbox/WAL 与崩溃对账边界。


## 7. 当前增量：本机 Skills 生命周期（2026-10-05）

以上 G-10 说明保留其历史基线。当前共享后台服务在**所选本机配置**的 `<profileRoot>/skills/<name>/SKILL.md` 管理全局技能；无项目也可操作。项目覆盖仍是 `<workspace>/.tracegraph/skills/<name>/SKILL.md`。独立旧 CLI/嵌入式 `SkillRegistry` 的 `~/.tracegraph/skills` 默认来源仍保留兼容，并不会自动把旧目录或凭据迁入新配置。

新增 [typed contract](../../packages/contracts/src/skill-management.ts)、[控制器](../../packages/host/src/skill-management.ts)、[认证路由](../../packages/host/src/skill-management-routes.ts) 和 [共享表单](../../packages/workbench/src/components/SkillsManager.tsx) 复用原 parser/scanner，提供 list/read/validate/command/receipt 五方法。通过界面或 `outlive skills ...` 可创建、编辑、明确导入本机 UTF-8 SKILL.md、校验、启停、移出和恢复。导入仅接收有界正文，不接受下载 URL、任意来源路径或可执行安装包。

正文保存绑定原文件 SHA-256；启停、移出、恢复还绑定当前范围状态 SHA。`remove` 写入可恢复 tombstone，保留原文件，并持续到重启后；外部修改正文不会默默恢复。移出或停用项目覆盖后可继承有效全局技能。旧共享 `disabled_skills` 仍是额外限制。新任务采用当前有效版本，已经接受的任务继续使用冻结快照。

每次变更以全局命令 ID 锁、范围锁和 canonical SessionEvent 记录意图、权限及回执；相同 ID 跨范围不同正文只能有首次效果。项目写入遵循原权限、精确审批和工作区协调。未知结果不能自动重发，只能按原命令核对；读到文件哈希不等于完成回执。技能声明不会扩大工具、模型、文件或原生应用权限。

文件读取拒绝 symlink/hardlink、无效 UTF-8 和超限正文。Linux 用已固定父目录 FD；macOS 使用实际支持检测后的 Darwin `O_NOFOLLOW_ANY` 并核对目录/文件身份。macOS 真实最后 open 祖先 symlink 替换负例证明私有目标没有被创建文件（包括空文件）。这不是完整 openat/目录事务声明；同一用户恶意替换真实目录的剩余窗口按身份漂移返回未知，不再写入。Windows 管理写入目前明确不可用。

实际源码验证包括控制器 11、真实 Host/SDK HTTP 2、Core 4、SDK 2、CLI 28，以及共享 Skills 表单 7 项测试；安装包图形工作流需要发行阶段另外验证。这只是 CAP-103 的有界本机单文件管理切片，远程市场、签名分发、多文件 Skill 包和 Windows 原生写入没有闭环。完整命令、负例和原始日志见 [验证记录](../validation/skill-management/README.zh.md)。
