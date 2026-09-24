---
id: agent-notes-policy
status: proposed
owner: repository-governance
last_reviewed: 2026-09-23
---

# Agent Notes

[English](README.md) · 中文

Agent Note 保存一项持久仓库决策**为什么**被提出、接受、否决、取代或归档。它补充源码与测试，但不是运行时指令。

## 生命周期

```text
proposed ──接受且已交付──> implemented ──被取代──> archived
    └──────────被否决────────> rejected
```

- `proposed/`：仍在评审中的设计，可使用将来时。
- `implemented/`：已验证的当前决策，必须链接实现与测试。
- `rejected/`：保留了具体否决理由的提案。
- `archived/`：曾经已实现、如今不再适用的决策。

只移动文件还不够。必须改写其状态、决定、后果、链接与日期，使新位置的内容准确反映事实。

## 哪些变更必须写 Note

- 改变公开命令、查询、事件或持久化格式；
- 转移状态所有权或引入包家族；
- 改变 Memory 准入、召回、保留、导出或删除规则；
- 改变策略、审批、凭据、沙箱或权限行为；
- 新增进程边界、产品入口或运行时 profile；
- 改变 benchmark/snapshot 的含义，或接受一项长期存在的限制。

使用[英文模板](TEMPLATE.md)或[中文模板](TEMPLATE.zh.md)。不要为了填满模板而编造备选方案。
当 Note 有 `.zh.md` 对照文件时，两份文件代表同一个决策 ID，生命周期迁移必须同步进行。在配对门禁落地前，译文分歧以英文原文为准。

## 评审规则

1. 提案必须区分 Current、Target 和 Deferred 行为。
2. 验收标准必须可观察，并包含失败与恢复场景。
3. 已交付的决策需要链接代码、测试和当前文档。
4. 被否决和归档的 Note 仍要可搜索，避免旧争论在不知情的情况下重演。
5. Note 中绝不能出现秘密、私人 prompt、个人记忆内容或原始凭据。
