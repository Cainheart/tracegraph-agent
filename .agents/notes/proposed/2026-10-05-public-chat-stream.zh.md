---
id: 2026-10-05-public-chat-stream
title: 从已记录事实生成公开聊天流
status: proposed
language: zh-CN
owners: [contracts, workbench]
created: 2026-10-05
last_reviewed: 2026-10-05
affects: [packages/contracts, packages/workbench, apps/cli]
supersedes: []
---

# Agent Note：公开聊天流

## 问题与当前实现

聊天展开仍显示内部生命周期与上下文时间线，当前 Run 失败又在轮次外重复展示。旧截图不能证明本次新增视觉范围已通过。

## 提案

将明确公开计划和配对工具事实投影为只读有序流，在公开说明之间合并相邻操作。内部生命周期与用量留在诊断。错误解释属于对应轮次；Run 完成不能将未知工具结果判为成功。完成后默认折叠，用户主动展开状态不因刷新丢失。

## 实际考虑过的替代方案

用户已否决在聊天展开内保留完整时间线；时间线仍作为证据检查器存在。

## 不变量与边界

Ledger 仍是真源。说明只来自 Runtime 的 `public_plan`，不将私有推理、原始参数、输出或通用摘要转为说明。只按显式身份配对操作。展开不执行。不新增持久事件格式；三端共享增量投影。

## 迁移与回滚

直接读取旧事件，不重写历史。不认识的历史类型仍可在诊断查看。回退呈现不改变事实。

## 验收

- [x] 顺序、显式配对、未知结果和私密字段过滤
- [ ] 完成折叠、历史错误、长消息与真实变更卡片
- [ ] 当前文档及 Web/Desktop 视觉证据

## 风险与延后范围

真实模型与网络失败原因另行诊断；本呈现改动不关闭安装、Windows、全部设置及其他路线图缺口。

## 证据

共享投影、Workbench、SDK 与 CLI 检查通过。[增量证据](../../../docs/validation/codex-chat-2026-10-05/README.md)。原生 Desktop 与完整视觉验收待补。

显式小型文本连接测试仅在该测试请求中关闭 DeepSeek 思考模式，保留有界输出，不改动正常任务配置。依据[DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)；这不能证明历史超时原因，也不代表安装版 Host 已修复。
