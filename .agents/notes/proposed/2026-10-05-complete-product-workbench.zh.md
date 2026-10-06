---
id: 2026-10-05-complete-product-workbench
title: 真实软件交付与受治理的电脑工作台
status: proposed
owners: [host, runtime, workbench]
created: 2026-10-05
last_reviewed: 2026-10-05
affects: [FLOW-097, CFG-098, GOAL-099, TEAM-100, BROW-101, COMP-102, CAP-103, DATA-104, APP-105, HELP-106, UXD-096]
supersedes: []
---

# Agent Note：真实软件交付与受治理的电脑工作台

[English](2026-10-05-complete-product-workbench.md)

## 问题与当前状态

用户于 2026-10-05 授权实施完整产品计划。已有桌面连接恢复、模型连接、文件编辑和开发资源继续有效，但不能证明原生电脑操作、远程 MCP、持续目标或完整开发交付。计划模式无 Todo 直接回答的状态机缺陷已通过显式终态意图修复；配置继承、目标预算、隔离 Agent、远程 MCP、浏览器及资料查询已有专项实现证据。完整能力仍按增量报告区分已验证范围与缺口，Windows 原生验收仍待完成。

## 已接受的目标

使用同一个认证本机 Host/Profile/Runtime 和规范 Ledger。为配置解析与历史、有限预算任务/目标、受限 Agent、浏览器/电脑操作及能力管理增加类型契约和控制器。先实现控制器和可核对的外部效果，再宣称客户端入口可用。计划模式允许直接回答完成，执行计划保留 Todo 与显式审批。配置更新不改变运行快照；撤权阻止后续派发。

各能力按纵向切片交付并记录失败、取消、恢复证据。用户已明确确认逐页设计，现按确认稿实施共享界面及状态；新增范围仍需相应后端与实际操作验收。电脑操作有独立应用授权、输入租约和用户输入后的手动交还。DOM、可访问控件、视觉动作分别记录，未知写入先核对再重试。安装包携带自身运行时，macOS 与 Windows 原生验收分别提供证据。

## 备选与延后

拒绝仅前端、虚假能力可用、把跨平台构建或外部验收工具算作产品电脑操作、复制 Codex 私有实现，以及把文件完全访问当成电脑授权。Office 编辑、语音、草图、技能录制、宠物、专用连接器和云端任务延后。

## 不变量与边界

- apps 保持装配层，业务在类型接缝和控制器中。
- Ledger 追加事实，回执及外部结果决定成功；私有推理不进入公开进度。
- 保留技术包名及用户原改动；不自动提交、推送、创建 PR 或公开发布。
- 总预算包含子任务、重试和验证；后台模型调用需同意及有限预算。
- 回放只读，恢复与重连不自动重发历史副作用。
- 实现与原生验收分别标记，历史证据不扩大覆盖范围。

## 迁移与回退

保留旧配置和凭据引用，新格式版本化，迁移前预览冲突并备份。增加契约保持旧记录读取与回放兼容。保留原事件，新计划终态使用显式意图。回退停用新操作并保留数据和未知回执，不删除历史。不可逆操作必须有具体可审阅的授权路径。

## 验收

- [ ] 两个原生平台的真实开发与界面验证。
- [ ] 普通计划回答、执行计划审批、越权拒绝和终态一致。
- [ ] 配置继承/历史、撤权、恢复及运行快照。
- [ ] 三端同控制器/真实回执，草稿及编辑状态恢复。
- [ ] 目标、Agent 总预算、隔离写入及人工验收。
- [ ] 浏览器/电脑授权、交还、锁屏暂停与证据保留。
- [ ] 当前文档、路线图、能力矩阵及安装包证据一致。

## 证据与待验收

用户已确认设计；实现及测试见[增量交付报告](../../../docs/validation/product-workbench-2026-10-05/README.md)和[当前能力矩阵](../../../docs/validation/product-workbench-2026-10-05/capability-matrix.md)。整体计划仍待完成。签名发行、干净双平台升级及独立用户验收不能由本地测试推断。

### 设置焦点与初始连接修正

实际安装页观察发现，编辑 Skill 后辅助功能树出现底层聊天。源码确认设置仅覆盖工作台，焦点循环遗漏展开标题，也不能收回逃出的焦点。共用设置现在先记录原焦点，再将工作台设为 inert；纳入可见原生及显式焦点目标，收回越界焦点，关闭时撤销自身 inert 状态并恢复原目标。关闭设置保留会话草稿与分类行为，设置打开时底层导航快捷键不执行。

客户端初始快照是 `connecting`，不是已确认的安装失败。新对话、项目入口和输入框现在区分正在连接/恢复连接与离线失败。连接中只显示状态，不提供修复命令；真实离线失败仍保留错误详情和明确修复操作。未改变传输重试、任务派发或权限语义。

四个新增负例在修前失败；[最终五文件 UI 回归](../../../docs/validation/product-workbench-2026-10-05/checks/settings-focus-connection-ui-final.log)通过 32 项，[Workbench 类型](../../../docs/validation/product-workbench-2026-10-05/checks/settings-focus-connection-types-final.log)通过。[修前输出](../../../docs/validation/product-workbench-2026-10-05/checks/settings-focus-connection-before-fix.log)保留。这些是源码级 DOM/键盘夹具，重建后的原生辅助功能树和安装版初次加载仍需重新观察。

应用内开始任务/浏览器帮助现明确从侧栏选择项目，在工作区工具 → 浏览器 → 浏览器权限申请授权。浏览器设置通过固定导航回调明确打开已有面板，不申请授权、不打开标签页、不派发操作。无可见窗口的接管与默认模型小文字测试保留真实限制。两个[修前导航负例](../../../docs/validation/product-workbench-2026-10-05/checks/browser-help-before-fix.log)保留；[三文件帮助/设置回归](../../../docs/validation/product-workbench-2026-10-05/checks/browser-help-ui-final.log)通过 18 项，[共用语言目录](../../../docs/validation/product-workbench-2026-10-05/checks/browser-help-locale-final.log)通过 12 项，[Workbench 类型](../../../docs/validation/product-workbench-2026-10-05/checks/browser-help-types-final.log)与[SDK 类型](../../../docs/validation/product-workbench-2026-10-05/checks/browser-help-sdk-types-final.log)通过。导航不会新增浏览器授权或模型请求。
