# TraceGraph Agent 文档 / Documentation

[English index](#english-index) · [中文索引](#中文索引)

## 中文索引

### V2 设计入口（提案）

- [Outlive Agent V2 设计总纲](outlive-agent-v2.md)：产品哲学、目标架构、包家族、Memory/Experience、Desktop、质量体系与迁移边界。
- [V2 文档清单](outlive-agent-v2/manifest.yaml)：机器可读的文档职责与状态。
- [V2 设计文档索引](outlive-agent-v2/README.md)：11 个模块目录及其决策级子模块设计。
- [V2 实施路线](outlive-agent-v2/09-implementation-roadmap/README.md)与[任务 DAG](outlive-agent-v2/roadmap.yaml)：按依赖执行的阶段、任务与验收标准。
- [V2 工程研发与维护 SOP](outlive-agent-v2/02-repository-governance/04-engineering-sop.md)：把现有验证资产、目标门禁和每次改动的交付证据串成可执行流程。
- [TraceGraph → Outlive 迁移基线](outlive-agent-v2/10-tracegraph-to-outlive-migration/README.md)：旧能力、现存边界、不可重做资产及其 V2 去向。

> V2 文档描述目标状态，不代表功能已经实现。迁移完成前，当前事实仍以 README、对应模块文档及其链接的源码/测试为准。

### 开始使用

- [主 README](../README.md)：产品定位、已实现能力、五分钟启动和项目模式。
- [目录说明](../DIRECTORY.md)：源码、配置和验证文件职责。
- [当前模块说明](modules/)：每个已实现模块的职责、边界、代码和验证入口。

### 模块文档

1. [契约层](modules/01-契约层-contracts.md)
2. [Agent Runtime](modules/02-Agent-Runtime.md)
3. [Context 与预算压缩](modules/03-Context-与预算压缩.md)
4. [工具、策略与审批](modules/04-工具与策略审批.md)
5. [证据链、账本、投影与工件](modules/05-证据链-账本投影工件.md)
6. [模型适配与推理强度](modules/06-模型适配与推理强度.md)
7. [CodeGraph](modules/07-CodeGraph-代码图.md)
8. [Memory](modules/08-Memory-记忆子系统.md)
9. [Host 与 SDK](modules/09-Host-与-SDK-接口层.md)
10. [Web 工作台](modules/10-Web-工作台.md)
11. [CLI 与装配](modules/11-CLI-与装配.md)
12. [评测体系](modules/12-评测体系.md)
13. [工程化与发布](modules/13-工程化与发布.md)
14. [附件与多模态](modules/14-附件与多模态.md)
15. [插件与扩展系统](modules/15-插件与扩展系统.md)
16. [Agent Team](modules/16-Agent-Team.md)
17. [Skill 系统](modules/17-Skill系统.md)
18. [MCP 客户端](modules/18-MCP客户端.md)
19. [LSP 客户端](modules/19-LSP客户端.md)

## English index

- [Outlive Agent V2 design entry](outlive-agent-v2.md): proposed target state;
  it is not evidence that the capabilities have shipped.

- [English README](../README.en.md): positioning, capabilities, five-minute
  setup, verification commands, and boundaries.
- [Chinese README](../README.md): the same content in Chinese.
- [Repository map](../DIRECTORY.md): responsibility of source/configuration files.
- [TraceGraph to Outlive migration baseline](outlive-agent-v2/10-tracegraph-to-outlive-migration/README.md): retained capabilities, current boundaries, and V2 disposition.
- [Engineering and release](modules/13-工程化与发布.md): CI, coverage,
  supply-chain, and tag artifact contract.
- [Attachments and multimodal input](modules/14-附件与多模态.md): durable
  staging/claim, image capability gating, PDF extraction, and replay boundaries.
- [Plugins and extensions](modules/15-插件与扩展系统.md): reversible
  trusted extension lifecycle, six bounded seams, safe configuration, and reload boundaries.
- [Agent Team](modules/16-Agent-Team.md): ledger-driven roster, mailbox,
  optimistic task board, heartbeat/loss reconciliation, and bounded worker controls.
- [Skill system](modules/17-Skill系统.md): local `SKILL.md` discovery,
  progressive disclosure, fail-closed tool narrowing, and registry diagnostics.
- [MCP client](modules/18-MCP客户端.md): bounded Host-owned stdio lifecycle and tool bridge.
- [LSP client](modules/19-LSP客户端.md): bounded native stdio diagnostics and semantic locations.

The detailed module documentation is maintained in Chinese so that one
technical source of truth is reviewed instead of two drifting copies. Public
setup and release boundaries are available in both languages.
