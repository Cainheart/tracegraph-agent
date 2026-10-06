# 本轮能力矩阵

本表依据当前控制器、typed SDK、固定 Desktop bridge 和 CLI 命令；“已接入”不代表已完成干净安装、真实付费模型或 Windows 原生验收。当前计划仍有未完成范围，历史 final8 安装验收不能覆盖新增功能。

| 能力 | 共用后端与三端入口 | 当前证据与边界 |
|---|---|---|
| 安全配置继承、历史、恢复 | ConversationControl / Workbench settings；Web/Desktop 设置；CLI config/session/defaults | 显式覆盖、CAS、来源、生效时机及运行快照有实际 HTTP/provider 反例；客户端偏好覆盖、代理与全部撤销路径待补 |
| 普通知识问答的计划终态与有限开发交付 | Runtime `finish_intent=answer`；共用 Composer/CLI chat | 实际 Plan 普通回答没有 Todo；执行计划仍需真实步骤与版本批准；[真实测试失败→检查→修复→独立复审](../delivery-review/README.md)计入有限预算。[同一中断 Run 的显式继续](../delivery-human-continuation/README.zh.md)已验证原预算、模型/权限/工作区绑定与未知写入拒绝；完整真实需求交付及付费模型质量仍待验收 |
| 项目命令发现与执行 | `discover_project_commands` / `run_project_command` | 真实 Node/npm 进程、磁盘字节、失败/超时/取消/未知回执；仅已有受支持 manifest 命令，不是完整环境自动修复 |
| 持续目标、预算、人工验收 | GoalController / shared budget；工作台目标页；CLI goal | 真实请求和子任务计入有限预算；检查点、人为继续、最终验收与未知不重试；连续自动开发和真实需求质量仍待验收 |
| 可写子 Agent 与只读交付审阅 | Core trusted resolver / Host managed worktree | [两个实际隔离写入及保留父原改动](../team-100/backend-slice.md)、[规范子任务终态和哈希绑定的独立审阅](../delivery-review/README.md)；父/子同一有限预算与独立凭据租约。[完整有界需求包](../delivery-human-continuation/README.zh.md)现包含完整公开任务、已消费指导、验证引用及可信 Goal 条件，并验证审阅者实际读完及保留在模型窗口；超限拒绝而不截断。完整生成产物清单、手动多模型、合并与关系图仍待补 |
| 显式模型能力测试 | ModelCapabilityControl；设置内分项测试；固定 Desktop bridge；CLI models capability-test/receipt | [协议、真实 HTTP、回执与旧结果失效](../model-capability-tests/README.zh.md)已验证；final2 包内 App 实际四项测试及 CLI 同回执见 checks/final2-cli-model-capability-receipt.json。受控服务结果不证明付费模型质量、通用能力或生成图片能力 |
| 内置浏览器 | BrowserControl / Runtime DOM tools；右侧浏览器页；CLI browser | 真实隔离 Chromium、精确 origin 授权、DOM 效果、PNG 与回执；当前 headless，可见接管视图和选定 Chrome 标签页扩展待补 |
| 原生电脑操作 | ComputerControl / native helper；电脑设置页；CLI computer | macOS helper 编译、身份/授权/输入协调/未知回执反例已实现；本机缺少 OS 辅助功能与输入监测授权，真实鼠标键盘旅程未完成；Windows 未原生验收 |
| 个人资料 | PersonalDataController；个人资料页；CLI profile | 实际本机 CAS 文件、重开和未知回执；姓名/简介不入模型，头像为首字与预设颜色 |
| 用量与活动热图 | bounded canonical Ledger queries；概览；CLI usage daily | UTC、真实 Token、缺失费用未知、部分扫描显式标注；不是供应商账单或完整无上限索引 |
| 公开会话搜索 | 同一查询控制器；搜索面板；CLI search sessions | 标题/公开任务/完成回答/文件引用及归档筛选；精确打开历史 Run，无工具执行；不索引私有推理、Key 或原始工具参数 |
| 截图保留与清理 | VisualEvidenceController；typed SDK、固定 Desktop bridge、CLI visual；记忆与隐私内六个真实操作 | [30 天默认、固定保留、实际 PNG/Run 副本清理与重开](../visual-evidence-retention/README.md)、[界面读写/预览/未知回执核对](../visual-evidence-retention/ui.zh.md)；陈旧投影拒绝，故障仅暂停清理；未登记旧截图保留，同用户恶意进程最终 unlink 竞态不宣称已解决 |
| 文件编辑、反馈、成果与附件 | 已有文件 CAS/rollback、feedback、Artifact/attachment 控制器 | 在 2026-10-05 arm64 DMG 实测 CLI→共享 Host→Desktop：本地流程图写入规范 Artifact，Desktop 只读打开并显示 SVG 预览/下载，真实 Run/Artifact ID、MIME、哈希见[包级报告](../codex-chat-2026-10-05/macos-packaged-smoke.md)及[CLI 回执](../codex-chat-2026-10-05/checks/macos-diagram-run.json)。final2 对同一隔离 Ledger 只读得到公开回答；空 Profile 的真实图像生成按 `image_provider_unconfigured` 失败且无 Artifact，见[负向回执](../codex-chat-2026-10-05/checks/macos-image-provider-unconfigured.json)。这不是模型光栅图片生成成功证据；默认用户 Profile 因旧 Host 版本冲突尚未升级 |
| Codex 式聊天过程、自由对话首页、记忆总览与媒体反馈 | Web/Desktop 共用 Workbench；真实 Run/Ledger、只读 Artifact 回执 | 当前源码补齐逐条命令折叠与回执输出读取、首页底部 Composer、鼠标焦点抑制/键盘焦点保留、来源明确的记忆候选草稿、真实召回状态、图像字节 SHA-256 校验与稳定生成占位；[整库测试](../codex-chat-2026-10-05/checks/mac-full-test-current.log)通过。新版原生多尺寸/明暗主题综合旅程仍待验收，不能据此关闭 UX-086/UXD-096 |
| MCP | local STDIO + remote Streamable HTTP transport；受校验配置表单；CLI mcp | 真实 JSON/SSE、凭据引用、超时和可选故障隔离；OAuth、完整配置生命周期与第三方服务器矩阵待补 |
| Skills | Core 同一 Markdown 校验/扫描器、SkillManagementController；全局/项目管理页；CLI skill | [真实创建/导入/编辑/校验/启停/移出/恢复与后续 Run 加载](../skill-management/README.md)；原文件保留、项目覆盖、来源与冲突，当前 macOS scoped writes 有真实越界反例；Windows scoped writes 未原生实现 |
| LSP / 扩展 | 现有扫描/状态、启停与重载；共享设置；CLI | 已有可信项与状态有效；完整添加/编辑/移除生命周期及可选故障矩阵仍待补 |
| Git、终端、预览、定时任务 | 现有 Workbench commands；右侧工具；CLI 等价操作 | [macOS 常驻预览源码只读与开发并行、实际多资源清理](../dev-readonly-preview/README.md)；交互终端隔离写入、完整新旅程和 Windows 行为待补 |
| 原生通知、托盘、防休眠与浮动展示 | Desktop Main 读取共享 facts/settings，不另建任务；原生菜单 | 生命周期单测及[实际 macOS 同一源码窗口尺寸切换/草稿保留](../app-105/backend-slice.md)；OS 通知投递、原生置顶层级、快捷附加与 Windows 待验 |
| 交互 CLI | `chat interactive`、斜杠命令与共享控制器、公开 SSE | [真实进程／同 Host 终态](checks/cli-interactive-process-proof.json)；历史继承与 CAS、精确审批、显式取消和退出不断后台；stdin 附件／凭据和 raw terminal attach 使用独立命令，非完整 TUI，Windows 原生未验 |
| 使用说明 | 22 个可搜索应用内主题 + 双语本地手册 | 实际能力状态、步骤、示例、限制与故障处理；后续功能须随实现更新，文档不能替代后端 |
| 安装与更新 | Electron + Node +匹配 Chromium/native helper manifests | 2026-10-06 最新源码 macOS app 已安装并复用默认 Profile；[安装记录](../desktop-install-2026-10-06/README.md)含 13 项隔离包冒烟；未签名/公证，Gatekeeper 正式发行、Windows 原生与独立用户验收仍待完成 |

所有不可用、未配置、只读、故障和策略拒绝继续由操作级能力决定；连接故障不等于安装版本不支持。点击展开记录、查看历史、收到通知都不授权重新执行。


## 共享后台版本升级：源码切片与安装边界（2026-10-05）

[空闲 owner 更换协议](../idle-local-host-upgrade/README.md)已有五个文件 / 28 项聚焦验证：旧 owner 原子封闭接收、停用 producer，检查资源与未知事实；规范准备回执和旧 lease 退场后才启动核验 bundle。真实进程证明并发客户端连接同一新 PID/build，配置字节及已完成 Run 时间线保持，未重提任务。请求断开不会提前释放尚未结算的业务处理；显式停止、未知状态、活动资源及退回已退休 build 均受保护。

不支持该协议的旧 owner 仍保持 `upgrade-required`，不能注入代码或强制终止。聚焦进程证据与 final2 包字节审计不替代正式安装升级：新旧真实安装包自动交接、失败恢复、干净双平台及签名升级仍待验收。final2 验收准备曾通过受支持的显式 Stop 停止自有空闲旧 QA owner，这不是自动升级证据。

## 本次聊天替换范围（2026-10-05）

[公开聊天流增量记录](../codex-chat-2026-10-05/README.md)已实现共享只读投影、逐轮错误、完成过程折叠、输入框及前三项变更卡片。SDK/CLI 从真实后台读取事实，Web 实际历史截图覆盖三尺寸与明暗。原生 Desktop、新安装包、完整交互矩阵及真实 DeepSeek 问题仍未闭环；旧截图不证明本次 Codex 参考设计已完成。
