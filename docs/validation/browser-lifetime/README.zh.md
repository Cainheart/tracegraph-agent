# 浏览器授权与关闭生命周期

[English](README.md)

这是已验证的 BROW-101 生命周期修复，不是整项浏览器能力或原生平台验收。检查使用隔离临时 profile、本地 HTTP 服务和开发 Chromium。未使用默认 profile、真实密钥、付费模型或实体鼠标键盘。

## 行为与回执

控制器关闭后阻止新请求与排队请求准入。可信用户确认接收 AbortSignal；即使回调忽略取消，关闭也会让其包装操作收敛。迟到同意不能持久化授权。迟到启动的浏览器被关闭，不创建上下文。关闭是幂等的，并等待已准入工作；浏览器关闭失败返回 `browser_cleanup_failed`，不能报告成功。生产启动最多 15 秒，确认最多 30 秒。仅可信构造可提供启动器，传输或模型不能选择。

操作使用现有 WorkbenchJournal，不改变授权与回执契约。准入前拒绝的排队请求没有回执；已准入后取消的确认有失败回执。真实导航已经发出外部请求后被中断，保留 `browser_effect_unknown` 并要求核对。重启保留持久授权与回执，不创建 tab，也不重复请求。清理不能证明已派发外部副作用被撤销。

## 证据

| 检查 | 范围 |
| --- | --- |
| [修复前待完成授权](pending-grant-before-fix.log) | 失败负例：关闭返回后，迟到同意产生有效持久授权 |
| [修复后窄例](pending-grant-after-fix.log) | 完整测试集增加前，待完成确认已被阻止 |
| [最终 Browser 测试](focused-browser-final.log) | 三文件九项；真实 DOM/服务副作用与中断导航、规范接管重试、确定性迟到启动/清理失败负例、原有 Runtime 完整性及模拟原生提示进程边界 |
| [最终 Host 类型](host-typecheck-after-team-fix.log) | 当前 Host 源码通过 |
| [更早 Host 类型](host-typecheck-final.log) | 不相关 Team 策略 API 字段导致失败，已保留并由对应切片负责人修复 |

提示测试仅证明信号转发，没有启动原生权限对话框。迟到启动测试显式使用可信假 Browser，证明并发不变量，不证明操作系统进程清理质量。真实 Chromium 测试单独在 `finally` 中关闭浏览器、服务并删除隔离 profile。数量包含原有测试，不代表九项全是新增测试。本回执没有执行完整构建或安装后原生验收。

## 复现与边界

```bash
env -u NODE_OPTIONS pnpm --filter @tracegraph/host exec vitest run src/browser-control.test.ts src/browser-runtime.test.ts src/browser-grant-prompt.test.ts
env -u NODE_OPTIONS pnpm --filter @tracegraph/host typecheck
```

实现位于 [BrowserControl](../../../packages/host/src/browser-control.ts)、[可信提示](../../../packages/host/src/browser-grant-prompt.ts)及[双语已实现 Note](../../../.agents/notes/implemented/2026-10-05-browser-grant-lifetime.zh.md)。整项 BROW-101、选中 Chrome 接入、原生输入交接及独立 macOS/Windows 验收仍属独立工作。本修复不扩大浏览器权限或回放访问范围。
