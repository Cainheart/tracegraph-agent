---
id: client-locale-and-docs
language: zh-CN
status: current
---

# Client locale 与文档检查

共享 locale 目录位于 [SDK client locale](../../packages/sdk/src/client/locale/index.ts)。Web 和 Desktop 使用同一个 Workbench provider。终端使用相同目录，语言优先级为显式 `TRACEGRAPH_LOCALE`，然后是 `LC_ALL`、`LC_MESSAGES`、`LANG`。仓库现有 CLI，尚无完整 TUI。CLI 的人类可读启动标签消费共享目录；JSON 协议输出保持原值。

## 回退与术语

英语 key 是真源。不支持的语言回退到英语；中文语言变体选择简体中文。未知 key 保留原字符串，缺失插值保留占位符。[术语表](terminology.md) 定义展示词汇。翻译不改变事件名、工具名、权限值、模型正文或 receipt。

## 配对校验

[配对清单](pairs.yaml) 记录源文件和译文的精确摘要、源语言和审校状态。在仓库根目录运行 `node scripts/verify-translation-pairs.mjs --check`。检查器验证两份摘要、段落/列表/表格/标题结构、代码块、行内代码、YAML 元数据、本地链接和锚点。外链标记为未检查。草稿配对可以通过机械检查。历史配对使用 `legacy-unreviewed`：两份文件分别记录结构与元数据指纹，因为历史排版可能不同。所有发现的双语配对都必须登记；未登记会失败。通过不等于语义等价或人工审校完成。

更新配对时，先修改源文档并同步译文，检查差异，再使用精确文件字节的 SHA-256 显式更新清单中两份摘要。人工审校者可以将 `review_state` 设为 `reviewed` 并登记姓名与审校日期。检查器不会修改正文或自动批准变更摘要。`--require-reviewed` 会拒绝草稿；发布时声称人工审校译文必须通过该检查。只在显式初次登记历史配对时使用 `node scripts/record-translation-baseline.mjs --register-unreviewed`；此命令不会刷新既有指纹。检查变更配对后，使用 `node scripts/record-translation-baseline.mjs --refresh <source-path> --acknowledge-unreviewed` 显式刷新该配对，并撤销其既有人审记录。生命周期移动必须更新清单的源与译文路径。包括历史配对在内的全部登记文件均检查本地链接和 YAML。此工具不认证历史译文。

## 生成目录

事件枚举、内置工具声明、workspace 模块或入口 profile 改变后，运行 `node scripts/gen-reference-catalogs.mjs --write`。运行 `node scripts/gen-reference-catalogs.mjs --check` 只读比较全部归属输出。[生成索引](../generated/README.md) 记录源摘要与链接。这些是静态源目录；动态 MCP/扩展工具清单以及特定机器的 resolved 配置不在范围内。
