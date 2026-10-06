# Codex 聊天重设计：增量实现与未完成验收

2026-10-05。本报告包含历史 final2 证据和当前源码验收；完整产品计划、UX-086、UXD-096 与发行验收仍待完成。2026-10-06 已将当前源码 Desktop 安装到默认应用路径，并安全复用默认 Profile；详情见[最新安装记录](../desktop-install-2026-10-06/README.md)。该本机升级不替代 Windows 原生或正式发行验收。

## 当前源码增量：聊天、首页、记忆与媒体

本轮在共享 Web/Desktop 工作台落实了新的体验要求：自由对话的空白首页把输入框固定在主区域底部，不提示本地项目权限；真实工具活动可逐条展开并按需只读加载关联命令 Artifact；记忆总览展示实际记录和召回状态，并允许从回答创建带来源、可编辑、默认待审核的候选；媒体 Artifact 通过字节摘要核验，生成中和失败时保持稳定占位。新增针对性用例与整库测试通过。

这些实现尚不等于整份 UI 或能力计划闭环。默认 Profile 的本机安全升级已于 2026-10-06 完成；Web/Desktop 尺寸与主题全矩阵、macOS 系统授权、从新安装版本完成真实 DeepSeek 对话、签名公证以及 Windows 实机验收仍未完成。当前安装事实见[macOS 安装记录](../desktop-install-2026-10-06/README.md)，历史隔离安装边界见[macOS 当前源码包报告](macos-current-package.md)。

## 已实现

公开聊天投影从已有 Ledger 事实提取明确公开说明与工具操作，按开始顺序交错，完成事件更新同一操作。没有明确操作 ID 的记录不强行配对；Run 完成不会把未知工具结果变成成功。初始化、索引、用量、上下文和私有推理不进入公开过程。

Web/Desktop 的共享组件采用右侧用户气泡、长消息展开、正文回答、紧凑操作组和完成后的“用时”折叠入口；手动展开状态在事件更新时保留。工具列表按需挂载，输出通过只读证据检查器查看。失败位于对应轮次，分类中文说明与技术诊断分开；删除轮次外全局失败横幅。文件卡片默认前三项；输入来源/覆盖入口移入加号菜单，输入区自动增高，向上阅读后可回到底部。

SDK 从真实 Run 读取同一纯投影；CLI 使用 `outlive run public-chat <run-id> --json`。该命令只读取，不派发、恢复或重提任务。现有 HTTP 和固定 Desktop 桥仍提供 canonical Run 事实，本切片没有新增独立事件日志或持久化格式。

## 使用与证据

完成任务后点击“用时”查看公开过程，点击操作组查看文件或命令；有证据检查入口时再查看对应原记录。失败轮次展开“查看诊断”；继续任务必须由用户明确提交，展开不会重新执行。

当前源码 Web 验收入口为 `http://127.0.0.1:4325/`，连接自有验收 Profile。这个开发入口不代表安装版已更新，也不代表用户 Profile。真实历史包括明确标记的受控模型成功回答及真实 DeepSeek 失败，未把前者当成真实服务成功。

- [Web 深色 1440×900](screenshots/web-dark-1440x900.png)
- [Web 深色 1280×800](screenshots/web-dark-1280x800.png)
- [Web 深色 1024×768](screenshots/web-dark-1024x768.png)
- [Web 浅色 1440×900](screenshots/web-light-1440x900.png)
- [Web 浅色 1280×800](screenshots/web-light-1280x800.png)
- [Web 浅色 1024×768](screenshots/web-light-1024x768.png)
- [共享界面测试](checks/workbench-tests.log)、[契约测试](checks/contracts-tests.log)、[SDK 测试](checks/sdk-tests.log)、[CLI 测试](checks/cli-tests.log)
- 本次 macOS 冒烟后复验：[聊天组件历史完整切片 43 项](checks/macos-workbench-chat-tests.log)、[final2 聊天流针对性 25 项](checks/macos-chat-flow-final2.log)、[Host 升级/监督器 17 项](checks/macos-host-upgrade-tests.log)、[V2 文档](checks/macos-verify-v2-docs-final2.log)、[翻译注册](checks/macos-verify-i18n-final2.log)、[生成目录](checks/macos-docs-check-final2.log)、[B Current 资源](checks/macos-brand-check-final2.log)、[diff 检查](checks/macos-diff-check-final2.log)。
- [真实 CLI 只读公开投影](checks/cli-public-chat.json)
- [真实 DeepSeek 小请求结果](checks/deepseek-connection-test.json)
- [macOS 挂载 DMG 实际运行、真实 DeepSeek 对话及升级边界](macos-packaged-smoke.md)
- [当前源码构建、13 项隔离安装冒烟与签名边界](macos-current-package.md)

## 未完成边界

本轮 Web 截图只覆盖真实历史和逐轮失败展示。正在执行、多附件、长记录、审批、后续成功、右侧编辑的完整视觉矩阵，以及原生 Desktop、Windows 和最终安装产物尚未验收。组件测试覆盖部分交互，不替代原生操作。

真实 DeepSeek 配置为 `https://api.deepseek.com`、`deepseek-v4-flash`。历史连接超时与另一次小请求的 `model_response_invalid` 分别记录。当前测试输出限额为 16 Token；该预算与思考模式可能有关，但没有捕获完整响应来证明因果，不能宣布已修复或擅自更换模型。源码已按官方协议仅为 DeepSeek 的小型连接测试关闭思考模式，仍限定 16 Token，正常任务配置不变；聚焦请求断言通过。隔离 Profile 中另有真实服务 `connection_ok` 回执，但最新 final2 Desktop 对默认 Profile 的原生检查遇到旧 Host build 冲突；不能据此声称 final2 已在默认安装中完成真实聊天。参考[官方说明](https://api-docs.deepseek.com/guides/thinking_mode/)。密钥没有进入本报告或截图。

final2 包内的 13 项隔离安装检查、只读公共回答投影和“未配置图片 Provider 时必须失败”的负向检查已追加到 [历史 macOS 安装包记录](macos-packaged-smoke.md)。其中“默认 Profile 仍由旧 Host 持有”是 2026-10-05 的历史状态；2026-10-06 已完成本机安全交接。其余配置、目标、多 Agent、终端隔离、可见浏览器、Chrome 扩展、双平台电脑操作、完整管理、签名、公证和独立用户验收继续按能力矩阵待完成项处理。本报告不关闭整份计划。
