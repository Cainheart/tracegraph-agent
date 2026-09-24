---
name: outlive-translate-docs-zh
description: 当 TraceGraph 或 Outlive 的中英文成对文档需要新增或更新时，同步含义、链接、代码与状态；中文流程。
---

# 中英文文档同步

仓库根 README.md ↔ README.en.md 是公开文档对；AGENTS、CHANGELOG、evals/README、Agent Notes 和示例 README 现也有 .zh.md 对照，本仓库维护 Skill 则采用 -zh ↔ -en 配对。V2 正文多数仍只有中文，没有自动翻译清单；不能只凭文件名推断其他文档已配对。英文等价入口见 [outlive-translate-docs-en](../outlive-translate-docs-en/SKILL.md)。

1. 先确定实际配对和本次改动的源语言。只同步发生变化的语义单元，不重译已审阅的未变段落；若另一语言尚不存在，先确认需要新增整篇译文，不能凭文件名推断自动配对。
2. 两边逐段核对事实、Current/Target/Deferred、限制、命令、配置键、事件名、链接和代码块。技术标识符保持原样；中文解释其含义，英文要自然准确。翻译不能把目标能力写成现有能力。
3. 同步语言切换链接、索引与入站引用。运行[文档同步](../outlive-doc-sync-zh/SKILL.md)的现有评估，人工核对语义与本地链接；目前没有 i18n pair manifest、source digest 或自动译文新鲜度门禁，不得声称它们已通过。
4. 输出配对路径、源语言、改动范围、待定术语与人工核对结果。若无法确认某个技术事实，标为待核实，不编造译文。
