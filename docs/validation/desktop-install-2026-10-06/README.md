# macOS Desktop 安装与清理记录（2026-10-06）

> 本记录描述较早的本机安装（Build ID `05497c…`），已由[后续重建与安装记录](../desktop-install-2026-10-06-rebuild/README.md)取代。原始报告和清理证据保留作历史记录。

## 安装结果

- 安装位置：`/Users/cain/Applications/Outlive Agent.app`
- 应用版本：`0.1.0-alpha.0`
- Bundle ID：`com.outlive.agent`
- Product Build ID：`05497c906eb674213d5db0104b304a14287450adebc7cd2a57d261e2707e3dd9`
- 平台：macOS ARM64；应用携带 Node.js `24.21.0`，正常运行不依赖系统 Node 或 pnpm。
- 安装后应用已从上述路径启动，默认 Profile 的 Host PID 为 `28142`，进程使用安装包内的 Runtime。
- 原默认 Profile ID `54b5faa9-13ca-4a7b-adf7-31b42e1cbf4b` 和已有聊天、项目及模型连接配置均保留。当前配置仍指向 DeepSeek `deepseek-v4-flash`；凭据保存在 macOS Keychain，本记录不包含密钥。
- 安装前的默认 Profile 备份：`/Users/cain/.outlive/backups/default-before-desktop-20261006-a28efc77b050`。备份包含 115 个文件，不包含 Host owner/discovery 运行时文件及密钥明文。

## 验证范围

全量 workspace 构建成功。独立 macOS ARM64 产品包冒烟测试通过 13 项，包括真实打包窗口、共享 Host、模型设置（隔离 fixture）、内置 CLI、项目创建、内置 Node/PTY、关闭窗口后后台 Run 继续、重开窗口复用 Host 及安全设置重启交接。完整结果见 [`report.json`](./report.json)，窗口证据见 [`first-window.png`](./first-window.png)。

上述 Provider 调用使用隔离的确定性 loopback fixture，不代表 DeepSeek 外部服务连通性；本次没有发送真实模型请求。打开的桌面应用仍可由用户继续体验。

## 清理范围

- 移除了仓库 `_tmp_release` 下所有旧/重复构建、Windows 交叉构建、临时安装包和可重建 Runtime 缓存。清理前约 `93,075,268 KB`（约 88.7 GiB）；最新 macOS 包已安装到上方路径，打包清单和发布元数据保存在本目录。
- 移除了替换前的旧应用副本 `/Users/cain/Applications/.Outlive Agent.app-previous-a28efc77b050`。
- 移除了本轮隔离预览使用的 Profile 和 Application Support 数据：`/Users/cain/.outlive/profiles/desktop-preview-2026-10-06` 与 `/Users/cain/Library/Application Support/Outlive Agent Desktop Preview 2026-10-06`。
- 默认 Profile、聊天记录、项目数据、安装前备份、`node_modules`、常规构建输出及本目录的验收证据均保留。
- 清理前已确认默认 Profile 无活动 Run；应用启动后确认其 Host 来自安装包 Runtime。清理时没有运行中的进程使用 `_tmp_release`。

清理前顶层目录与空间统计见 [`cleanup-inventory.json`](./cleanup-inventory.json)。`product-release.json` 和 `packaged-inventory.json` 记录本次已安装构建的发布元数据及包内文件清单。

## 尚待外部验收

本地构建未使用 Developer ID 签名和公证。`codesign`/Gatekeeper 正式发行检查未通过，因此这只证明本机可启动和体验，不能视为可公开分发的签名安装包。Windows 原生安装与电脑操作验收由用户之后在 Windows 环境执行；届时应从当前源码重新构建，旧交叉构建已清理。
