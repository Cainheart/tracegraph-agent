# macOS 安装包聊天冒烟验收

日期：2026-10-05。此记录补充聊天重设计报告，范围是 Apple Silicon 包从只读 DMG 挂载后真实启动的桌面应用和隔离验收 Profile；它不代表覆盖默认用户 Profile、完整安装升级或发布验收。

## 构建与包

- `env -u NODE_OPTIONS pnpm run build`：整库构建通过。
- 产品版本 `0.1.0-alpha.0`，macOS `arm64`，build ID `7d4170c0f6a845a2b4f96cd0c1980d79b72b9336f04c14174b7c8f8c03fecd20`。
- 历史 DMG（SHA-256 `ef1e0984c26dcef0f4a67a838acfc347a1e2736703fd206b2fa2b193b7d4e616`；当时 `hdiutil verify` 通过）已于 2026-10-06 清理，不再保留构建包字节。
- 历史 ZIP（SHA-256 `a2bf09a86ba50408b93cc5d3665be0a88ead5ce1d0128d999d885e8091ab4779`）已于 2026-10-06 清理；本页操作回执和摘要仍保留。
- 包清单确认随包 Node 24.21.0、Chromium 1.63.0 和 macOS arm64 电脑助手；`external_node_required=false`、`external_pnpm_required=false`。包未签名且未公证。

## 实际操作结果

- 从只读挂载的 DMG 启动 Electron 主进程和随包 Host，Host build ID 与包清单一致；使用独立验收 Profile，没有启动或改写默认用户 Profile。
- 使用该隔离 Profile 中已保存的真实 DeepSeek 连接 `deepseek-v4-flash` 运行独立小请求。两次操作均返回 `connection_ok`，结果文件保存于 [最新连接测试](checks/macos-packaged-deepseek-test.json)；第二次耗时 602 ms。密钥未返回界面或写入记录。
- 在同一打包应用输入“请只回复：连接测试通过。”并提交给真实 DeepSeek；模型返回“连接测试通过。”。界面显示右侧用户消息、正文回答、折叠的“用时 00:01”过程、赞/踩和底部统一输入框。
- 使用该包内 CLI 通过共享 Host 执行一次有界的本地流程图渲染。Run `run:d1f8d362-ff4d-4afb-9b38-2a4edeff09f6` 以 `completed` 结束，Host 回执关联 Artifact `attachment:ea4d64c4-385c-45f6-bc0f-7ff3e7268c86`，MIME 为 `image/svg+xml`，规范哈希为 `sha256:b0572813be79da19944f7845d71f51c02c34ac1eb003ba74afaec588323a5ee0`。CLI 按回执校验输出字节后写入 [SVG](artifacts/macos-generated-diagram.svg)。
- 在打包 Desktop 的公开历史中搜索该任务并只读打开；成果卡读回同一 SVG Artifact，实际显示图形预览和“下载”链接，没有重新执行任务。[输入](checks/macos-diagram-input.json)、[Run/Artifact 回执](checks/macos-diagram-run.json)。这是本地确定性图表/示意图的生成与跨端预览，不是 DeepSeek 或专用图像 Provider 生成的光栅图片。
- 在实际桌面检查旧会话时，三轮内容分别显示：受控验收响应、DeepSeek 超时失败、后续完整回答。超时原因与“检查模型设置”入口仅属于失败轮次，展开诊断可见该轮网络超时详情；后续回答没有被旧失败横幅覆盖。
- 打开设置确认分类入口、模型连接真实测试状态及 19 类设置导航。切到“电脑操作”后，页面明确区分辅助功能、屏幕录制与输入监控权限，并给出系统设置说明；状态读取显示这些 macOS 权限当前未授予。

## 尚未覆盖

- 这次实际运行的是 DMG 挂载路径，不是覆盖默认 `/Applications` 或 `~/Applications` 中的旧应用。默认 Profile 的旧 Host 仍由原安装版持有；旧 Host 明确不支持新版本的安全升级握手。保留了旧应用、Host、Profile 与用户数据，未自动停止或替换它们。需要通过旧应用安全退役后再进行实际覆盖安装与 Profile 升级验证。
- 辅助功能、屏幕录制和输入监控未获系统授权，因此没有执行应用外的键盘/鼠标操作或屏幕捕获，也没有将外部 CUA 操作伪称为 Outlive 的内置电脑能力。
- 只完成聊天/设置和 CLI→Host→Desktop Artifact 预览的单窗口实测；未完成 1440×900、1280×800、1024×768 明暗主题的打包 Desktop 全矩阵，也未覆盖附件、审批、编辑、终端、预览、通知或升级恢复。
- 包的签名/公证及独立用户安装验证未完成。Windows 原生安装、运行与 PTY 由用户后续验证；跨平台构建不替代原生证据。

结论：上面的 `7d4170c…` 历史包证据确认该构建可启动、可连接真实 DeepSeek，并能完成一次真实桌面聊天；下方 final2 补充是更新包的最新验收。两者的 Profile 与调用类型分别列明，不能合并成 final2 默认安装的实时 Provider 验收。它们只关闭各自明确列出的检查，不关闭 UX-086、HOST-087、DIST-095、REL-083 或完整计划。

## final2 最新包补充（2026-10-05）

本节覆盖修正公开聊天投影后的最新 Apple Silicon 包；上面的 `7d4170c…` 记录保留为历史包证据，不能与新包混为同一次运行。

- 最新产品 build ID：`d8b6f625ef8e384fec0ba58bf52eed92866cf84b0e06e8335c1771841765e43b`。DMG SHA-256：`10f59409f53c34d4c1f716eb7477f51804b2b744c06595ec0440275cd7a4e308`；ZIP SHA-256：`a08d11af621ef6fe0586e6b2271a1a1c8b6185a08ca542c023a0f2b68a102b14`。DMG 校验有效。包内 Node/Chromium/电脑助手齐全，不要求外部 Node 或 pnpm；包仍未签名、公证。
- [签名评估](checks/macos-signing-assessment.json)：本构建为 ad-hoc、无 Team Identifier；`spctl --assess` 拒绝此 App，因此它仅适合受控本地 QA，不能当作正常安装发行版。当前进程没有配置 Developer ID 签名或 Apple 公证凭据；不会通过关闭 Gatekeeper 或绕过系统警告伪装成可发布包。
- [final2 隔离安装冒烟](checks/macos-installed-smoke-2026-10-05-final2/report.json)在 Darwin arm64 上通过 13 项：随包 CodeGraph、实际窗口、共享 Web/Host、模型设置与受控连接、同 Host CLI、项目创建、随包 Node PTY、关窗后台运行、重新打开复用 owner、空闲设置重启重绑。此组模型调用使用确定性的本地夹具，不证明真实 Provider 质量。[首屏图像](checks/macos-installed-smoke-2026-10-05-final2/first-window.png)展示真实打包窗口的首次模型配置向导。
- [公开聊天投影](checks/macos-final-public-chat.json)从 final2 所连接隔离 Profile 中只读得到真实已完成 Run `run:37576a62-ae57-4657-a3bd-30f988ad8e4b`，其中公开回答为“macOS 最新包对话通过。”。该事实证明 CLI 对同一 Ledger 的只读投影；它不是 final2 窗口向真实 Provider 发出的新请求。
- 独立真实 DeepSeek 连接测试仍由[连接回执](checks/macos-packaged-deepseek-test.json)记录，模型为 `deepseek-v4-flash`、结果 `connection_ok`、耗时 602ms。该回执来自此前隔离 Profile 的测试，不能单独证明 final2 Desktop 新发起了实时 DeepSeek 对话。
- [图片生成负向检查](checks/macos-image-provider-unconfigured.json)用全新空 Profile 调用随包 CLI，真实 Run 以 `image_provider_unconfigured` 失败、退出码 1、没有 Artifact；应用未将文本/代码伪称为已生成图片。要得到光栅图片，仍需用户配置支持的图片 Provider 并完成真实输出验收。
- 最后对 final2 窗口进行实际原生检查时，它绑定到用户默认 Profile；该 Profile 已配置 `deepseek-v4-flash`（仅记录配置状态，不记录 Key），但已安装旧 Host build `871f507b…` 仍在运行，新包按安全升级策略展示“等待验证安全升级”，聊天输入禁用。只读资源查询时 Run、终端、预览和定时任务均为 0。详见[默认 Profile 阻塞证据](checks/macos-default-profile-owner-blocker.json)。没有停止旧 Host、替换已安装应用或更改用户 Profile。

因此 final2 已证明隔离 Profile 的安装包流程和真实文件/事件读取，但**默认 macOS 安装尚未切换到新包并完成 Profile 升级**。只读检查确认旧 Host 当前没有 Run、终端、预览或定时任务；仍需在安装前备份 Profile、经用户确认后退役旧 owner、更新应用并验证升级。正式使用前还需 Apple Developer ID 签名和公证；系统辅助功能/屏幕录制/输入监控授权、完整安装版尺寸主题矩阵及独立用户验收也仍开放。Windows 原生验证由用户后续完成。
