# TraceGraph Agent 文档 / Documentation

[English index](#english-index) · [中文索引](#中文索引)

## 中文索引

### 开始使用

- [主 README](../README.md)：产品定位、已实现能力、五分钟启动和项目模式。
- [已知限制](../KNOWN_LIMITATIONS.md)：当前真实边界及未完成项映射。
- [目录说明](../DIRECTORY.md)：源码、配置和验证文件职责。
- [能力路线图](12-能力差距对标与补强路线图.md)：G-01 至 G-23 的状态、依赖与验收。
- [验证映射](verification-map.md)：需求、不变量、实现文件和可执行命令。

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

## English index

- [English README](../README.en.md): positioning, capabilities, five-minute
  setup, verification commands, and boundaries.
- [Chinese README](../README.md): the same content in Chinese.
- [Known limitations](../KNOWN_LIMITATIONS.md): authoritative current boundaries.
- [Repository map](../DIRECTORY.md): responsibility of source/configuration files.
- [Capability roadmap](12-能力差距对标与补强路线图.md): G-01 through G-23.
- [Verification map](verification-map.md): requirement-to-code-to-command evidence.
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

The detailed module documentation is maintained in Chinese so that one
technical source of truth is reviewed instead of two drifting copies. Public
setup and release boundaries are available in both languages.
