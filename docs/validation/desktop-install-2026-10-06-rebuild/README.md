# macOS Desktop 重建与安装验收（2026-10-06）

## 安装与配置

新版已安装并启动：`/Users/cain/Applications/Outlive Agent.app`。应用版本为 `0.1.0-alpha.0`，Bundle ID 为 `com.outlive.agent`，macOS arm64 Product Build ID 为 `311840e5a1e81e0d83c75f6f56aa5fef3987fe5749ca405922e9353c3a37f15f`。应用进程 PID 为 `50657`；新版 Host PID 为 `50697`，从应用自带 Node.js `24.21.0` 启动。Host `/health` 返回 `ok`，Host 身份报告的 Product Build ID 与包内 runtime manifest 一致。实际窗口已从该安装路径打开，渲染器可访问，新对话、项目侧栏和底部输入框均已载入。

安装前确认默认 Profile 没有活动 Run。升级后继续使用原 Profile ID `54b5faa9-13ca-4a7b-adf7-31b42e1cbf4b`，两条历史会话和三个 Run 仍可读取。安装前备份 `/Users/cain/.outlive/backups/default-before-desktop-20261006-a28efc77b050` 保留。被替换的上一版安装包留在 `/Users/cain/Applications/Outlive Agent.previous-20261006-before-311840e5`，用于回滚。

## 构建与检查

全仓构建、工作区 TypeScript 检查、工程检查均通过。工程检查 109 项通过，覆盖率检查 8 项通过；Workbench 回归 50 项、Host 模型目录 fixture 2 项、历史有限预算恢复 38 项通过。DMG `hdiutil verify` 和 ZIP 完整性检查均通过。完整产品元数据与 11,831 项包内文件清单见 [`product-release.json`](./product-release.json) 和 [`packaged-inventory.json`](./packaged-inventory.json)。

普通 Run 已不再注入累计 Token、总时长或固定轮数上限。上下文在约 80% 压力处压缩；响应前暂时性模型请求错误最多重试五次，Goal 的明确预算、无进展保护、工具超时、审批和取消仍保留。相关历史诊断见[Run 提前停止记录](../runtime-budget-stop-2026-10-06.md)。

新版使用默认 Profile 中保存的 DeepSeek 凭据，经 Host 对 `https://api.deepseek.com` 执行了只读模型目录发现，真实服务返回 `deepseek-flash` 和 `deepseek-v4-pro`，能力数据已写入 Profile；未发起生成式模型请求。当前已保存选择仍为 `deepseek-v4-flash`，该 ID 不在这次目录响应中。为保留用户设置，没有自动切换模型；在发送真实模型请求前，请在模型菜单中选择目录中的型号或手动配置模型 ID。凭据未写入报告或日志。完整回执见 [`real-provider-model-catalog.json`](./real-provider-model-catalog.json)。

## 发行状态与清理

此包未签名、未公证；`spctl --assess` 拒绝该目录包。因此本机可打开体验，但不能作为可公开分发的正式 macOS 安装包。Developer ID 与公证凭据仍是发行验收的外部依赖。Windows 原生安装与 UI 验收留待用户在 Windows 环境验证。

为减少磁盘占用，已核对 6 个相同 Bundle ID、旧版本的 2026-10-03 `.previous-*` 应用均无活动进程后删除；本次可重建的 `_tmp_release/desktop-product/stage` 和与安装包 Build ID 相同的重复解包 `.app` 也已移除。默认 Profile、安装前备份、当前回滚包、本次 DMG/ZIP、SHA256 清单、包内文件清单和历史验收记录均保留。清理没有触碰用户配置或历史对话。

## 2026-10-06 r2 增量

聊天 Artifact UTF-8 分页恢复与安装版正文布局修复已随新版包重建并安装。当前安装包 build 为 `d0f461a4e8c59d5466cfd4d6ed43c7d1f5b8d58e12809f8dd754fa7ba79530df`，默认 Host 已由该包接管，原 Profile 与凭据保留。17 页真实 DeepSeek 项目只读 Run 完成。安装产物、SHA256、测试范围、一次错误的自由对话验证和剩余发行边界见[增量验收记录](../chat-cursor-recovery-2026-10-06/README.md)。r2 仍未签名/公证，`spctl` 未通过；Windows 与独立用户验收仍待完成。
