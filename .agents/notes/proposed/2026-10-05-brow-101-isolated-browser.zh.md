---
id: 2026-10-05-brow-101-isolated-browser
title: Host 管理的隔离浏览器与明确站点授权
status: proposed
language: zh-CN
owners: [host, workbench]
created: 2026-10-05
last_reviewed: 2026-10-05
affects: [BROW-101, packages/contracts, packages/host]
supersedes: []
---

# Host 管理的隔离浏览器

[English](2026-10-05-brow-101-isolated-browser.md)

## 当前与目标

Outlive 已有本地网页预览，但没有自身的 DOM 浏览器操作能力。
外部验收工具不算产品能力。新增独立 Host 控制器，使用固定配套的
Playwright/Chromium；客户端与 Runtime 工具共用控制器，不允许任意 JS、
复制浏览器资料或调试端口接入。

可信用户操作明确授权 HTTP(S) origin，选择隔离标签页、撤销、接管与交还。
模型工具不能授予权限或在用户接管后自行交还。页面请求、跳转及弹窗均检查
授权范围。观察产生有界、绑定版本的 DOM 引用及视口证据；旧引用和脱离节点
拒绝执行。密码值不进入 DOM 元数据。写操作使用命令 ID 与规范回执；失去
回执后的结果保持未知，不能自动回放。

## 边界与待验收范围

首个切片使用隔离的 headless Chromium，通过客户端明确接管；不存在可能
误判物理输入的可见浏览器窗口。原生输入监测及 headed 整合依赖 COMP-102。
现有 Chrome 选定标签页扩展、代理、安装包浏览器资源、证据保留及完整三端
入口仍待 BROW-101 验收。计划工具可以观察；点击、输入、按键及导航都需
明确用户权限。文件完全访问不能授予浏览器权限。重启不重建标签页或重发命令。

## 取舍、迁移与恢复

不复用用户 Chrome 资料目录，不暴露 CDP 地址。只持久化明确授权及证据引用；
浏览器上下文归当前进程。崩溃保留旧回执与授权，不自动恢复上下文。旧版本忽略
独立授权文件。撤销关闭对应上下文，阻止后续操作，但不声称已经分派的效果回滚。

## 验收

- [ ] 真实浏览器/服务器 DOM、输入与外部计数器验证。
- [ ] 请求/跳转越界、旧引用和只读回放拒绝。
- [ ] 可信授权、接管、撤销、关闭与重启不重复。
- [ ] Runtime Artifact、共享传输与如实界面。
- [ ] 配套浏览器打包及 macOS/Windows 独立原生验收。

接口依据：[Playwright BrowserType](https://playwright.dev/docs/api/class-browsertype)。
证据进入本轮产品工作台验收目录。
