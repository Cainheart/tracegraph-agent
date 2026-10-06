---
id: 2026-10-05-browser-grant-lifetime
title: 浏览器授权与启动的生命周期围栏
status: implemented
language: zh-CN
owners: [host]
created: 2026-10-05
last_reviewed: 2026-10-05
affects: [BROW-101, packages/host]
supersedes: []
---

# 浏览器授权与启动的生命周期

[English](2026-10-05-browser-grant-lifetime.md)

## 当前问题与决策

修复前，隔离 Browser 控制器只关闭已经启动的浏览器。待完成的可信用户确认可
在关闭之后持久化授权；迟到的浏览器启动也可继续创建上下文。确定性负例实际
复现了迟到授权落盘。

控制器现在给可信原生确认传递生命周期 AbortSignal；关闭后拒绝新请求和排队
请求准入，在异步确认之后、创建浏览器上下文和证据派发之前再次检查生命周期。
它跟踪已准入工作，在幂等关闭期间等待其收敛。迟到启动关闭浏览器，不能创建
上下文。浏览器清理失败要明确报告，不能忽略后宣称成功。生产启动与用户确认
保留有界超时。内部可信启动接口仅供确定性的并发测试，客户端不能选择启动器
或授权。

## 权限、兼容与恢复

HTTP 契约、授权存储格式和规范 WorkbenchJournal 回执保持原语义。关闭不删除
回执，也不声称已经派发的页面副作用已撤销。关闭前已经准入的写入可收敛原有
回执；迟到确认不能准入新授权。重启保留持久授权，绝不重建浏览器上下文或重放
中断写入。现有可信确认回调可忽略新增信号，控制器仍阻止其迟到结果；原生提示
应遵循信号以关闭提示进程。

## 验收与剩余范围

- [x] 待完成用户确认被中止，迟到同意不创建授权文件。
- [x] 关闭后的排队与新请求在准入前被拒绝。
- [x] 迟到启动只关闭一次、没有新上下文；清理失败可见。
- [x] 原有真实 DOM 副作用、接管重试及规范回执继续成立。

实现：[控制器](../../../packages/host/src/browser-control.ts)和
[原生提示](../../../packages/host/src/browser-grant-prompt.ts)。
[控制器测试](../../../packages/host/src/browser-control.test.ts)、原有 Runtime
完整性测试和模拟提示进程的信号转发测试共三文件九项通过。
[证据](../../../docs/validation/browser-lifetime/README.zh.md)保留了修复前失败负例和
最终 Host 类型检查。真实 Chromium 导航被中断后保留 unknown 回执，外部 HTTP
请求只发生一次。

这只是[隔离浏览器切片](../proposed/2026-10-05-brow-101-isolated-browser.zh.md)内的生命周期修复。
它不代表 BROW-101 全部完成，不证明原生权限对话框或选中 Chrome 接入，也不
替代独立安装后的 macOS/Windows 验收。
