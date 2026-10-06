---
id: 2026-10-05-app-105-background-entry
title: 原生常驻入口、通知与活动任务防睡眠
status: proposed
owners: [host, contracts, desktop]
created: 2026-10-05
last_reviewed: 2026-10-05
affects: [APP-105]
supersedes: []
---

# 原生常驻入口、通知与活动任务防睡眠

[English](2026-10-05-app-105-background-entry.md)

## 决策

Desktop Main 提供真实菜单栏/Tray 入口，独立本机 Host 仍是唯一 Runtime 所有者。支持平台关闭窗口保留 Main/Tray；显式退出只分离 Main，Host 任务继续。另一个用户明确确认范围的“停止后台并退出”操作派发现有 canonical `host.stop`，普通退出不能静默取消工作。

共享 profile 设置控制器保存自愿开启的 `general.prevent_sleep_during_tasks`（缺省为 false）。Main 复用类型设置 CAS/历史路由，不新增 renderer 可调用的 OS 电源或任意通知接口。仅开启选项且有 canonical 正在执行 Run 时持有 `prevent-app-suspension`，空闲、排队、等待审批、停止/离线或 Replay 不持有；不关闭锁屏，也不承诺阻止合盖、人工休眠或系统策略。

原生通知消费现有 canonical `resources.notifications`，按稳定 event ID 去重，核验 profile/owner 更换并遵守各状态通知偏好。首次读取只建立旧事件基线，不把历史当新通知弹出。通知正文不含任务内容。点击只表达读导航意图：Main 核验当前 live Run/project/session 后传闭合标识给 packaged renderer，不能执行/恢复历史任务、审批输入或清除显式停止意图。

## 验收与恢复

验证事件去重、首次历史不通知、偏好门禁、Replay/离线释放、仅活动任务电源生命周期、owner 变更、安全导航及停止与退出的区别。OS 通知不支持/权限缺失应如实返回 unavailable，`show()` 调用不能证明已送达。此切片不修改默认 profile，不注册登录/开机启动。真实 Mac Tray/通知送达与 Windows 原生验收独立记录。浮动窗口、快捷附加、快捷键注册、安全更新及安装/平台旅程不在此切片。
