# COMP-102：原生应用授权与输入交还后端切片

状态：**已实现并验证控制器/进程边界；真实 macOS 输入旅程与 Windows 原生构建/旅程未验收。** 本记录不代表完整 COMP-102、安装包或普通用户验收完成。

## 当前实现

- [电脑控制契约](../../../packages/contracts/src/computer.ts)闭合应用、窗口、授权、租约、观察、输入和命令对账字段。用户/模型 DTO 没有 `confirmed`、自由执行路径、shell 或 AppleScript。
- [ComputerControl](../../../packages/host/src/computer-control.ts)独立于文件 Full Access；由受信人工组合回调授予指定应用 once/always 权限，再由人工取得或恢复全局独占输入租约。持久授权绑定应用 ID 与实际 executable SHA-256；每次操作复核 PID/窗口。一次授权不写入持久配置，交还时撤销；输入租约不在 Host 重启后恢复。
- 人工确认可明确允许切换到精确授权窗口。私有 `focusTarget` 只给人工组合层调用，HTTP/SDK/模型工具不暴露。确认前检查身份，确认后及每次输入检查精确前台窗口。窗口切换、输入监听丢失、外部输入、锁屏、撤销、到期或任务取消都会暂停输入；自动动作不能代替人工恢复。
- Outlive 授权界面、系统权限设置以及 Script Editor/osascript、Windows 脚本授权载体被排除。助手独立排除 `Outlive Agent` 标题的授权窗口，避免模型点击自己的授权对话框。
- [私有助手后端](../../../packages/host/src/native-computer.ts)只执行固定安装/source 路径中的匹配平台、架构和 SHA 清单助手。它清除调用方 Node 注入与秘密环境字段；一次请求有 10 秒上限，监控 readiness 有 3 秒上限。监控进程由 Host stdin 生命周期和显式关闭收束。任务取消会终止实际助手子进程。
- [macOS Swift 助手](../../../packages/host/native/computer/mac-helper.swift)使用真实 AX、窗口专属 ScreenCaptureKit、被标记的 Quartz 输入以及 listen-only 用户输入监控；不读取 secure AX 输入值。窗口观察最多 256 元素/5 层，截图最多 16 MiB。坐标在所选窗口内；鼠标/键盘/滚动必须保持所选前台窗口。
- [Windows UIA/Win32 源码](../../../packages/host/native/computer/Program.cs)提供窗口身份、UIA、窗口截图、闭合 SendInput 与用户输入 hook 实现。**本机没有 dotnet、不是 Windows，因此源码未编译，真实 Windows 可用性未知。**
- 观察保存经过结构化脱敏的 AX Artifact 和真实 PNG Artifact；canonical 命令回执保存来源关系。读取像素要再次核验应用授权、精确窗口的回执关系和 Artifact 哈希。输入 `posted` 只证明事件已发出，不证明界面业务成功；中断结果为 `unknown`，同 command ID 不自动重发。`reconcile` 只读 canonical 回执。Plan Mode 只观察，不允许发送输入。

## 当前证据

| 检查 | 当前结果 | 原始记录 |
| --- | --- | --- |
| Host 控制器 + 原生协议边界 | 20 测试通过：人工授权、前台复核、独占/CAS、早期监控事件、撤销、锁屏、到期、Plan 拒写、命令回执、脱敏/像素范围、真实子进程取消与关闭 | [host-focused.log](checks/host-focused.log) |
| 闭合电脑契约 | 2 测试通过：拒绝自批准、任意执行、不支持键、过长文本和伪造回执 | [contracts-focused.log](checks/contracts-focused.log) |
| 交付组装负例 | 2 测试通过：拒绝错误 Mach-O/PE 架构；非原生构建声明不可用并删除残留其他平台可执行文件 | [delivery-focused.log](checks/delivery-focused.log) |
| 实际 macOS arm64 助手编译及 ad-hoc 资源签名 | 退出 0；此资源签名不等于正式应用 Developer ID 签名/公证 | [mac-helper-build.log](checks/mac-helper-build.log) |
| 实际编译助手只读系统状态 | backend=true、screen_capture=true、locked=false；**accessibility=false、input_monitoring=false** | [mac-native-status.json](checks/mac-native-status.json) |

Host 类型日志 [host-types.log](checks/host-types.log)是当前工作树的真实结果；曾有另一并行 Goal 契约产物尚未同步导致 `execution_session_id` 类型错误，不能把该失败记录称为整体类型通过。依赖同步后[最终 Host 类型日志](checks/host-types-final.log)退出 0；根任务还会保存统一最终类型/测试结果。初次协议测试日志 [host-focused-first-attempt.log](checks/host-focused-first-attempt.log)保留了测试对整个子进程环境键数量过严的失败；最终用实际秘密/Node 注入字段不传递和可执行身份断言验证边界，未放宽产品环境白名单。

执行命令：

```bash
env -u NODE_OPTIONS pnpm --filter @tracegraph/contracts build
env -u NODE_OPTIONS pnpm --filter @tracegraph/host exec vitest run src/computer-control.test.ts src/native-computer.test.ts --maxWorkers=1
env -u NODE_OPTIONS pnpm --filter @tracegraph/contracts exec vitest run src/computer.test.ts --maxWorkers=1
node --test scripts/build-native-computer.test.mjs
env -u NODE_OPTIONS pnpm --filter @tracegraph/host typecheck
node scripts/build-native-computer.mjs
```

## 交付与剩余边界

[组装脚本](../../../scripts/build-native-computer.mjs)在原生 macOS 用 Swift 编译助手，在原生 Windows 用 dotnet 发布自包含助手；安装运行时不要求用户安装编译工具。跨系统组装不会把 Mac 二进制塞进 Windows 包，只输出 `available:false/native-runner-required` 清单。产品安装组装需要将助手与清单复制到 `runtime/computer`，把清单纳入产品构建身份；source 模式固定使用 `packages/host/native/computer/build/<platform>-<arch>`，不能通过环境变量改执行路径。

本次没有启动/停止默认 profile、没有修改系统权限、没有向用户应用发输入。没有 AX 或输入监控系统授权时控制器真实拒绝派发，所以本证据不能升级为实际用户应用点击、键入或业务结果通过。人工 Desktop 授权 GUI、Runtime 工具/三端路由、最终安装树和双系统系统权限旅程由根任务继续集成与验收。不能保证限制已经完全授权的外部程序、单个不可分输入事件中的硬件操作或独立第三方自动化。

API 依据：[Apple 指定窗口 ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit/sccontentfilter/init(desktopindependentwindow:))、[Apple SCScreenshotManager](https://developer.apple.com/documentation/ScreenCaptureKit/SCScreenshotManager)、[Microsoft UIA FromHandle](https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.automationelement.fromhandle)、[Microsoft 输入 hook](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowshookexw)。这些文档是实现依据，不能替代本产品实际操作验收。
