---
id: 2026-10-03-client-locale-docs-catalogs
title: 共享 Client locale 与可验证文档投影
status: implemented
owners: [client, docs]
created: 2026-10-03
last_reviewed: 2026-10-03
language: zh-CN
affects: [packages/sdk, packages/workbench, docs/i18n, docs/generated, scripts]
supersedes: []
---

# 共享 Client locale 与可验证文档投影

## 决策

locale 放在现有 SDK client 公开导出下，作为不依赖传输的逻辑模块。Web 与 Desktop 消费共享 Workbench；终端客户端不依赖 React 即可使用同一目录。不为 locale 单独建立物理 client 包。保留既有英文字符串 key 和本地偏好 key，避免全组件迁移。

配对校验记录精确源文档/译文摘要、结构指纹、本地链接与 YAML 元数据。明确区分已通过机械检查的草稿与人工审校译文。全部历史配对显式登记为 legacy-unreviewed，并独立记录结构和元数据指纹；未知配对会失败。门禁通过绝不代表仓库译文均已人工校对。

事件、内置工具、模块与 profile 目录由版本化源确定性生成。只读检查比较全部归属输出，并报告所有陈旧文件。动态 MCP/扩展工具和依赖具体机器的 resolved profile 不属于静态目录。

## 不变量与回滚

locale 只影响展示；wire 值、账本事件、工具标识符、模型正文与 receipt 不翻译。不支持的语言回退到英语，未知 key 回退到输入 key，缺失插值值保留可见。运行时权限不迁移。回滚恢复原 Workbench 目录并移除新增文档命令，无需持久化数据迁移。

## 验收与证据

共享 Workbench（Web/Desktop）与 CLI 启动标签消费同一目录。目前没有完整 TUI，本任务也不宣称创建了完整 TUI。当前行为和审校边界记录于 [locale 治理](../../../docs/i18n/README.md)。

- 实现：[共享 locale](../../../packages/sdk/src/client/locale/index.ts)、[配对检查器](../../../scripts/verify-translation-pairs.mjs)、[目录生成器](../../../scripts/gen-reference-catalogs.mjs)。
- 契约证据：SDK locale 测试 3/3；Workbench provider 渲染测试 3/3；工程负例 14/14。SDK、CLI 构建及 Workbench 类型检查通过。
- 负例证据：源/译摘要变化、结构或元数据漂移、断链/锚点失效、新配对未登记、缺少审校证据、目录篡改/删除和源清单变化均会失败。显式刷新指纹会撤销既有 reviewed 状态。
- 验证命令：`node --test scripts/verify-translation-pairs.test.mjs scripts/gen-reference-catalogs.test.mjs`、`node scripts/verify-translation-pairs.mjs --check`、`node scripts/gen-reference-catalogs.mjs --check`。

Profile 参考复制真实版本化声明并绑定源摘要，不虚构 live resolved 设置或无声明界面的 profile。外链可用性与译文人工语义审校不属于机械门禁。
