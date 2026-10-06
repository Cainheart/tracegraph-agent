---
id: 2026-10-05-desktop-quit-lifetime
title: 窗口确认离开后再断开 Desktop 客户端
status: proposed
owners: [desktop, sdk]
created: 2026-10-05
last_reviewed: 2026-10-05
affects: [APP-105, HOST-087]
supersedes: []
---

# 窗口确认离开后再断开 Desktop 客户端

[English](2026-10-05-desktop-quit-lifetime.md)

## 当前证据

实际 Source Electron PID 47891 在原生 Quit 后仍活着，私有 socket 已消失，独立测试 Host 23666 保持健康。原始失败的原因尚未确定。真实私有 UDS 空闲 SSE 的 abort 正常完成；没有脏文件的实际 Main Quit 也正常退出。这些结果不支持“所有 pending SSE abort 都会挂起”。

另两个独立缺陷已经复现：真实私有 SSE 在事件后 return 不关闭 response；实际 Main renderer 的 beforeunload 否决退出后，窗口仍活着，但 before-quit 已先断开客户端。后者采用与未保存项目文件相同的 guard；原报告会话没有文件编辑，因此不能称为原始故障的已证实原因。保留负例日志，并单独标明最初无效的顶层 await 测试入口。

## 决策

客户端异步释放移到窗口同意离开后的 will-quit，不在 before-quit 提前断开。资源释放后使用 setImmediate 安排最终 app.quit，等待原生 Quit 事务退出；同轮 promise 重入被忽略已有独立实证。记录请求退出与最终退出状态，避免 shutdown 时 activation 或通知重新创建窗口。原生未保存编辑提示提供“继续编辑”或“丢弃并退出”；只有用户明确丢弃才绕过 renderer 否决。取消退出保留同一 renderer 与鉴权连接。有 Tray 时普通关窗仅隐藏同一窗口、保留草稿，不退出或停止 Host。

SDK SSE reader 在 abort 或 iterator return 时主动 cancel response，移除 abort listener，在取消完成后释放 reader lock。私有传输与 Run 权限不变。关闭客户端或 stream 不调用 Run cancel 或 host.stop。不增加超时、恢复预算、协议、权限上限或持久格式。

## 验证与恢复

使用真实 UDS HTTP SSE socket 与实际 Electron/Main 窗口事件，不能只靠监听 abort 的 mock。证明空闲取消、return 释放 response、正常退出、脏编辑取消保留已连接客户端、明确丢弃退出和后台 Host 存活。保留真实失败与通过命令日志。原始失败的原生复验仍是独立关卡。本 Note 保持 proposed/未人工审阅；不代表最终安装或 Windows 原生验收通过。

## 范围内验证

[真实失败与通过证据](../../../docs/validation/desktop-quit/README.md)：真实 UDS SSE return 负例、实际 dirty 否决与同轮原生 Quit 负例；SDK 55、私有 SSE/supervisor 15、Desktop 77 测试通过。实际 Source Main 普通 Quit、dirty 取消（连接保留）与明确丢弃均 exit0，测试 Host 存活；对话框选项是固定 fixture 响应，不代表人工 OS 对话框验收。SDK/Desktop types 和窄构建通过。Host types 等待并行 Core delivery-review 声明构建。原 PID 47891 仅按授权 SIGTERM 清理，确切原因保持未知。联合安装与原生 Quit 验收是另外的关卡。
