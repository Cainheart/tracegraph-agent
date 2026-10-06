---
id: 2026-10-05-cap-103-skill-lifecycle
title: 以规范回执管理有界本地 Skill
status: implemented
owners: [capabilities, host, workbench]
created: 2026-10-05
last_reviewed: 2026-10-05
affects: [CAP-103, packages/contracts, packages/core, packages/host, packages/sdk, packages/workbench, apps/cli, apps/desktop]
supersedes: []
language: zh-CN
---

# Agent Note：以规范回执管理有界本地 Skill

[English](2026-10-05-cap-103-skill-lifecycle.md)

## 问题与初始状态

既有 [SkillRegistry](../../../packages/core/src/domains/skill/skill.ts) 会校验并冻结本地 Markdown Skill，项目定义覆盖用户定义，allowed_tools 只能收紧既有工具与策略权限。设置页依赖已登记项目，无法在无项目时管理本机配置的全局 Skills；还缺少文件增删改、有界导入、分范围启停 CAS 和不确定写入核对。

## 已授权实施范围

用户已授权既有 CAP-103 计划。通过共享 Host 增加严格类型的列表、读取、校验、命令和回执查询。全局范围只访问当前私有配置的固定 skills 目录，项目范围只访问已登记工作区的固定 .tracegraph/skills 目录。浏览器或原生文件选择只提交用户明确选定的 UTF-8 SKILL.md 内容，最多 256 KiB。接口不接受来源路径、URL、下载、脚本或凭据配置。

复用既有解析器与扫描器。明确读取的正文留在本机；目录、列表和规范回执只记录元数据与哈希，不记录 Markdown 正文或私有配置路径。创建、导入、编辑绑定原文件 SHA；启停、可恢复移出与恢复同时绑定文件 SHA 和范围状态 SHA。移出仅写入 tombstone，保留原始本机文件；重启后仍生效，外部修改正文不会自动恢复技能。移出或停用项目覆盖项后，可继承已启用的全局定义。项目策略、本机不可变的选定权限、精确 ask 审批和工作区协调仍必须执行。模型与 API 设置不能授权。项目定义仍优先，禁用项目覆盖后可使用启用的全局定义；既有 disabled_skills 仍是额外限制。新任务读取最新启用目录，已受理任务保留冻结定义。

先按命令 ID 串行，再按范围串行，追加请求事实后再次校验意图摘要。每次修改使用既有 SessionEvent 账本记录意图摘要、策略摘要、必要的精确审批、派发和回执。响应丢失或部分写入保持未知，不得再次派发；明确核对回执时可读取当前文件与状态哈希，但观察不等于完成。修改不自动重试。范围状态有界并在派发前核对；Runtime 在同名优先级之前过滤来源启停状态，不引入第二套加载器。

## 备选与边界

拒绝第二套 Markdown 加载器及任意主机路径导入，因为会重复校验或新增路径权限。远程市场、自动下载、可执行辅助程序和含凭据的 Skill 归档暂缓。本切片仅管理一个有界 SKILL.md，不包含任意多文件包。Windows 写入仍不可用。Linux 通过目录 FD 绑定操作；macOS 探测 Darwin O_NOFOLLOW_ANY 并在最终文件/父目录 open 使用，同时核对文件与目录身份，不支持时明确拒绝。这里不声明原子 openat 事务，也不声称消除所有同 UID 真实目录替换窗口；身份漂移或派发后的不确定结果保持未知。

## 迁移与回滚

保留 @tracegraph 传输和包名及 .tracegraph 项目目录。共享服务明确使用所选配置的技能根目录；独立旧 scanner/CLI 默认根目录保留兼容，不自动导入。新增分范围启停状态，状态缺失表示启用；旧 disabled_skills 仍只能收紧。既有 Skill 内容无需重写。回滚可撤去新管理接口与界面，保留 Skill 文件和审计事件。

## 验收条件

- [x] 真实磁盘验证无项目全局管理、项目覆盖和启停生效时机。
- [x] 创建、导入、读取、编辑、移出、恢复、校验包含 CAS、冲突和精确范围审批。
- [x] 符号链接、硬链接、私有越界、UTF-8/大小、只读/拒绝及正文泄露负例。
- [x] 未知回执与只读核对不重发写入；传输、CLI 和界面等效测试。
- [x] 当前模块与双语证据区分本切片和完整 CAP-103。

## 证据

[当前证据](../../../docs/validation/skill-management/README.zh.md) 链接真实文件与原始日志：Host 控制器 11、已构建 Host/SDK HTTP 2、Core 4、SDK 2、CLI 28、共享 Skills 界面 7，以及 Skills 检查点时完整 Workbench 314 项。后续截图保留/帮助增量单独记录更新后的 Workbench 数量。

真实 HTTP 验收包含无项目全局管理、精确 ask 审批、原文件 CAS、重启后 tombstone、规范回执；受控模型夹具证明已受理任务读取旧冻结技能，而下一任务读取新版本。真实磁盘负例保留硬链接读取私有正文的修复前缺陷、最终 open 祖先符号链接攻击且私有目标没有文件（包括空文件）、跨全局/项目范围冲突命令 ID 仅首个效果。失败的决策与清理夹具尝试保留为测试夹具失败，不作为产品通过。

[模块 17](../../../docs/modules/17-Skill系统.md) 与[双语用户手册](../../../docs/user-guide/README.zh.md#topic-skills) 已对齐此源码切片。固定 Desktop 传输已实现并另有测试；安装包原生图形/Windows 验收仍待完成，不依据 callback 推断。完整 CAP-103 的市场、签名分发和多文件安装不在本次有界实施内，不作生产、付费模型质量或独立外部用户声明。
