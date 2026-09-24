---
name: outlive-agent-note-zh
description: 当 TraceGraph 或 Outlive 的持久架构决定需要提出、验收、否决或归档时，维护有证据的 Agent Note；中文流程。
---

# Agent Note 生命周期

先读[生命周期策略](../../notes/README.md)、[模板](../../notes/TEMPLATE.md)和[仓库规则](../../../AGENTS.md)；英文等价入口见 [outlive-agent-note-en](../outlive-agent-note-en/SKILL.md)。Note 记录“为什么”，不是产品运行时指令。

1. 确认变更是否真的改变公共契约、状态所有权、Memory 治理、权限/沙箱、进程边界、基准意义或持久限制；一次性实现细节不另造 Note。
2. 搜索同主题 Note 和源码/测试，写清 Current、Target、Deferred 与真实备选方案。新提案放在 .agents/notes/proposed/，按模板给出不变量、迁移/回滚、失败与恢复验收；不知道的事实标 pending。
3. 只有代码、测试和当前模块文档已经对齐，才把决策改成 implemented 并移入 .agents/notes/implemented/；仅移动文件不算完成。被否决的写明原因移入 rejected/；不再当前有效的 implemented Note 才能归档，并说明被什么取代或为什么退役。迁移时修正 status、时间、上下游链接，不删除历史证据。
4. 检查改动的相对链接、frontmatter、入站引用和 git diff --check；按[文档同步](../outlive-doc-sync-zh/SKILL.md)核对受影响索引。

输出 Note 路径、状态变化、证据链接和未解决的问题。若是否接受某个重大决策仍需维护者裁决，保留 proposed；不要自行把设计标为已实现。
