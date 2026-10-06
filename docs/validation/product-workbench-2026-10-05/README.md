---
id: product-workbench-2026-10-05
status: proposed
last_reviewed: 2026-10-05
---

# 完整产品工作台增量实施

本报告只记录 2026-10-05 新计划的真实进展，旧验收不扩大范围。用户已明确确认逐页设计，可按稿实施界面。当前交付是多个已验证的实现切片，完整计划和正式发行仍未完成；逐项边界见[能力矩阵](capability-matrix.md)。
架构依据：[接受的目标 Note](../../../.agents/notes/proposed/2026-10-05-complete-product-workbench.md)。

**2026-10-06 安装更新：**最新源码 Desktop 已安装到 `/Users/cain/Applications/Outlive Agent.app`，完成默认 Profile 的本机安全交接并复用原聊天、项目与模型配置。Build ID、备份、13 项包级冒烟和签名/公证边界见[安装记录](../desktop-install-2026-10-06/README.md)。下方 2026-10-05 状态行保留当时证据，不代表安装后的 Windows、真实 Provider 或正式发行验收。

| 任务 | 当前状态 | 完成所需证据 |
|---|---|---|
| UXD-096 / UX-086 | 设计已确认；共用界面已实施，真实客户端复验中 | 紧凑聊天/侧栏/输入框、19 类设置、按需面板及每轮错误；新安装版多尺寸综合旅程待收口 |
| CFG-098 | 配置继承与历史切片已验证 | [Host/HTTP/运行快照证据](../cfg-098/backend-slice.md)；完整代理、客户端覆盖和撤销另验 |
| FLOW-097 | 计划终态、已有项目命令、有限开发审阅及同一 Run 人工继续切片已验证 | [真实进程/磁盘/失败反例](../flow-097/README.md)、[真实失败→修复→再次审阅](../delivery-review/README.md)、[原预算及准入绑定的人工继续](../delivery-human-continuation/README.zh.md)；完整真实需求质量仍待验收 |
| CAP-103 | 远程 MCP 传输、全局与项目 Skills 生命周期已验证 | [真实 Skills 文件/回执/新 Run 加载](../skill-management/README.md)；MCP OAuth 与完整服务管理仍待补 |
| GOAL-099 | 有限预算、持久目标与人工继续已验证 | [真实父子请求/暂停/重开证据](../goal-099/README.md)；完整自动需求交付待验 |
| TEAM-100 | 编译角色、隔离 worktree、模型凭据租约和完整有界需求包只读审阅已验证 | [脏基线、权限与实际隔离写](../team-100/backend-slice.md)、[共享预算与真实审阅子任务](../delivery-review/README.md)、[完整需求与实际模型窗口](../delivery-human-continuation/README.zh.md)；完整生成产物清单、手动多模型 Agent、合并及关系图仍待补 |
| BROW-101 | 产品内隔离浏览器和真实 DOM 切片已验证 | origin 授权、CAS、PNG、命令对账与关闭反例；可见接管/Chrome 扩展待补 |
| COMP-102 | macOS 后端与双平台接口已实施 | [身份/授权/输入协调反例](../comp-102/backend-slice.md)；OS 权限、真实前台操作与 Windows 原生验收待完成 |
| DATA-104 | 资料、用量、公开搜索与截图保留控制器及界面已验证 | [资料与查询](../data-104/README.md)、[实际截图副本清理/固定保留/陈旧投影拒绝](../visual-evidence-retention/README.md)、[六个真实操作的共用界面](../visual-evidence-retention/ui.zh.md)；新安装版综合旅程与完整记忆管理仍待补 |
| APP-105 | 原生后台入口与同一窗口浮动展示已验证 | [Desktop 固定桥/生命周期与实际 macOS 源码窗口证据](../app-105/backend-slice.md)；OS 通知送达、快捷附加及更新恢复待验 |
| HELP-106 | 22 个可搜索主题与本地双语手册已实施 | [使用手册](../../user-guide/README.zh.md)、实际能力状态和操作说明；随新增能力持续更新 |

## 验收边界

原型、外部 CUA/Playwright 验收、mock 模型、跨平台 EXE 构建均不能替代产品能力及原生验证。当前主机为 macOS；未取得 Windows 原生证据前，相关任务保持待验收。签名、干净安装升级和独立用户验收仍是正式发行条件。

## 实际验证

执行中的结果在本节追加；未执行或失败的命令不标通过。测试服务不证明真实付费 Provider 质量。安装包在新增范围及页面确认完成后重建。

- 整库构建已通过，[完整构建日志](checks/product-full-build-final.log)保留前序失败迭代；最终来源发生后续修改时必须重新构建。
- 共用后端 8 个文件/54 项检查通过：[共享后端验证](checks/shared-backend-integration.log)。这包含原有测试，不是 54 项全新或 OS 原生操作。
- 公开历史与原生通知精确 Run 导航通过：[导航验证](checks/exact-run-navigation.log)。只打开目标历史范围，拒绝错误会话和失效连接，不 resume/提交新任务。
- 实际浏览器接管的重复命令和冲突 ID 在准入前无副作用：[4 项 Browser/runtime 验证](checks/browser-takeover-admission.log)。关闭与迟到授权的生命周期证据另行追加。
- 已完成历史不显示恢复横幅，真实失败仍显示原失败：[6 项 UI 检查](checks/restored-run-notice.log)。连接恢复不等于业务成功。
- 37 个 Workbench 文件/292 项检查及类型通过：[共享 UI](checks/workbench-help106-final-tests.log)、[类型](checks/help106-types.log)；个人资料身份等后续变更需另验。
- 实际受控服务旅程使用独立临时 Profile，通过真实 Host 和 Runtime 完成普通 Plan 回答，没有 Todo 或文件写入；实际复制文本匹配，赞反馈重开后仍存在，公开搜索命中并只打开历史 Run，用量为 1 次请求/140 Token、成本未知。使用 CUA 验收 Outlive 的真实产品页面，不将 CUA 当作 Outlive 的电脑能力。
- 实际源码 Desktop 在同一临时 Profile 中恢复连接，保留未发送草稿；权限设置读取真实生效值，没有将连接失败显示为“不支持”。通过原生“窗口”菜单将同一窗口切为 880×700，再恢复 1440×920，草稿保持。[实际客户端记录](checks/live-desktop-native-ui.json)、[恢复截图](screenshots/live-desktop-draft-after-rebind.jpg)、[浮动截图](screenshots/live-desktop-floating-first.jpg)。这些不是安装包或 Windows 原生验收。
- 常驻预览在 macOS 强制使用源码只读、私有缓存可写的执行环境；同一工作区的真实 Runtime 写入仍能完成，预览进程保持可访问。[实际进程/磁盘/清理反例](../dev-readonly-preview/README.md)。交互终端的隔离写入协调仍待完成；没有以释放可写终端租约规避冲突。
- 截图保留记录损坏或陈旧时只暂停截图清理并提供诊断，普通 Host 与计划问答继续可用；未知记录不自动修复、不删除原截图。[真实共享 Host 反例](../visual-evidence-retention/README.md)。
- Skills 和截图保留界面接入后，完整 Workbench 41 个文件/323 项检查通过；最后两项中文显示文案另有 29 项窄复验与类型检查。[共用界面证据](../visual-evidence-retention/ui.zh.md)。这些数量包含既有测试，不等于全新功能数量或安装验收。
- 有限软件开发切片使用真实本地 HTTP 模型夹具和磁盘/命令结果：正常测试通过后，独立只读审阅发现边界缺陷；新增回归真实失败，检查源码并修复，测试及第二次审阅通过。15 次实际请求、2 个审阅子任务计入同一预算；692 项独立证据检查通过。[交付审阅证据](../delivery-review/README.md)。受控服务不能证明真实付费模型交付质量、完整用户需求或 Windows 行为。
- 第一轮重建 macOS App 使用内置 Node 和相同 Profile，外部 `PATH=/usr/bin:/bin`。实际 Skills 校验、批准、创建、编辑、移出、恢复有四个规范完成回执；配套 CLI 读到同一 1.0.1 文件哈希和状态版本 2。截图保留通过实际界面保存为 31 天、再恢复 30 天，CLI 读取策略版本 2；没有触发手动删除。外部重启保持设置分类，真实读取恢复；原生退出返回 exit 0，后台 PID 保持。[Skill 创建回执](checks/live-packaged-skill-create-receipt.json)、[CLI 共享状态](checks/live-packaged-cli-skills.json)、[保留策略](checks/live-packaged-cli-retention.json)、[退出后后台](checks/live-packaged-host-after-quit.json)。这轮包的 build ID 是 `c3d948403041ddb92b5a801c334ced78598d392cc871f8ebefade9a316046e05`，后续文案修正需要重新打包，不把它当作最终字节验收。
- 2026-10-05 最新聊天包再次整库构建，并生成独立 Apple Silicon DMG/ZIP。DMG 校验和通过；从挂载的 DMG 启动真实桌面应用，在隔离 Profile 中测试真实 DeepSeek 连接并完成一条真实聊天。模型设置读到连接测试通过；历史超时只显示在失败轮次，后续成功回答保持正常。另以随包 CLI 生成带规范回执的流程图，安装版 Desktop 从公开历史只读打开并实际渲染同一 SVG Artifact、提供下载。[包级聊天、Artifact 证据与限制](../codex-chat-2026-10-05/macos-packaged-smoke.md)。该包和构建目录已清理；其中未签名/公证、系统辅助功能授权和完整尺寸/主题矩阵的边界仍适用。
- final2 重建包（build `d8b6f625ef8e384fec0ba58bf52eed92866cf84b0e06e8335c1771841765e43b`）的隔离安装冒烟通过 13 项；最新 CLI 从该包所连接的隔离 Ledger 读取出真实公开回答，且空 Profile 图片生成以 `image_provider_unconfigured` 失败、没有 Artifact。DMG SHA-256 为 `10f59409f53c34d4c1f716eb7477f51804b2b744c06595ec0440275cd7a4e308`。[final2 详细证据](../codex-chat-2026-10-05/macos-packaged-smoke.md)。默认用户 Profile 已保存 DeepSeek 模型配置，但在当时仍由旧 Host build `871f507b…` 所有；该历史包安全等待升级，未用于替换用户版本。2026-10-06 本机升级现已完成。final2 仅 ad-hoc 签名，`spctl` 拒绝；当前环境没有 Developer ID/公证凭据，正式发行仍未完成。

## 待完成条件

2026-10-05 状态核对：完整计划仍未完成。final2 对应构建、类型复验、292 个文件 / 2,088 项单元检查、109 项 Node 工程检查加八项 Vitest 检查、32 项离线评估及五条快照均有通过日志；首次类型与 Web 模块解析失败日志保留，后续复验通过。整合文档检查曾报告生成目录陈旧，不能将这次整合宣称为全部门禁通过。

final2 包内 App 使用自有临时 Profile 与内置 Node 启动，实际模型分项测试和 CLI 读取同一完成回执，后台重启后权限设置恢复，未发送草稿保持；[包字节审计](package-audit-final2.md)仅证明归档和来源一致。默认安装目录仍是旧包。最终多尺寸明暗主题综合验收、默认安装切换与完整升级尚未收口。

本机不能产生 Windows 原生证据，也不能替用户授予 OS 辅助功能/输入监测权限。签名账户、干净双平台、独立参与者仍需对应环境与人工动作。除此之外，能力矩阵明确列出的产品实现缺口也保持未完成；不能仅因本轮构建或截图通过便关闭任务。

- 交互 CLI 的十二项窄检查及真实进程旅程通过：读取同一临时 Profile 的规范 Plan 终态、六条公开活动，退出码 0 后 Host PID/nonce 保持；模式变更走同一 CAS 会话控制器，历史打开不恢复执行，后台活动序号重置不会丢新事件。[实际 CLI 对账](checks/cli-interactive-process-proof.json)、[窄检查](checks/cli-interactive-current.log)。模型服务为受控本地夹具，未证明付费模型质量或 Windows 原生行为。

## 2026-10-05 Mac 优先聊天/记忆增量

本轮按用户最新说明补齐了共享工作台中的几项交互：工具组下每个命令可以单独展开；命令行、目标路径、退出状态和真实输出由同一 Run 的只读事件/Artifact 通道按需读取，内部摘要不会冒充命令输出；运行活动使用轻量状态动效，失败仍留在其所属轮次。无项目首页移除“本地仓库/项目权限”提示和建议按钮，Composer 固定于主区域底部；鼠标焦点不再加粗描边，键盘 `focus-visible` 保留清晰提示。

记忆页先展示真实记录计数、待审核候选、Experience 和后台任务，并显示 Memory/Experience 的实际召回授权状态。由回答创建的候选会预填可编辑内容及来源描述；确认只创建候选，不自动审核或开启召回。媒体生成在收到 Artifact 前显示稳定占位，Artifact 下载后同时校验响应元数据和实际字节 SHA-256，失败不会显示伪造图片。

这些改动通过了 [整库单元/工程测试及构建](../codex-chat-2026-10-05/checks/mac-full-test-current.log)，其中 Workbench 为 46 个测试文件/370 项；[历史源码 macOS 包](../codex-chat-2026-10-05/macos-current-package.md)通过 13 项隔离安装冒烟。工作台类型、V2 文档、生成目录、翻译目录与 B Current 资源也分别通过并有单独日志。2026-10-06 最新源码已安装并接管默认 Host，详见[安装报告](../desktop-install-2026-10-06/README.md)。本地安装包未签名/公证；Gatekeeper 正式发行、全尺寸明暗主题、完整真实模型 UI 旅程、Windows 原生及独立用户验收仍未完成，因此 UX-086、UXD-096 及完整跨平台计划保持打开。
