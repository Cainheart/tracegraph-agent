---
id: 2026-10-05-cap-103-remote-mcp
title: 有界 Streamable HTTP MCP 与功能局部启动失败
status: proposed
language: zh-CN
owners: [mcp, host]
created: 2026-10-05
last_reviewed: 2026-10-05
affects: [CAP-103, packages/contracts, packages/mcp, packages/host]
supersedes: []
---

# 有界 Streamable HTTP MCP

[English](2026-10-05-cap-103-remote-mcp.md)

## 决策与当前状态

当前 MCP 仅 STDIO，required 服务失败会关闭健康服务并阻断 Host 启动。增加明确的 Streamable HTTP 配置变体，使用 HTTPS（或回环 HTTP）及凭据仓库 bearer 引用，不接受 Shell/env/进程参数。旧 STDIO 与默认值兼容。复用 manager/catalog/tool 接缝，保留保守权限和网络派发后未知效果。

## 目标与边界

协商协议及会话头，接受有界 JSON/SSE POST 响应、工具列表通知、超时/取消及明确 DELETE 会话。认证请求不重定向，工具写入不自动重新初始化或重试，错误体不泄露诊断秘密。共享 Host 开启功能局部启动隔离；通用 manager 默认保留原 required 严格语义。失败功能标 degraded，不伪装 ready。OAuth 授权界面、完整管理引导、独立 GET 事件订阅及代理分层仍是 CAP-103 待交付范围。

## 备选、迁移与回退

独立第二套 MCP 栈会重复生命周期和权限，故增加传输变体。旧事件和 STDIO 配置含义保留。回退旧构建前停用远程项，不改变 Ledger 或凭据。远程 hints 不视为可信授权。

## 验收

- [ ] 真实回环 JSON/SSE 初始化、会话头和工具结果。
- [ ] 配置及错误无明文凭据，拒绝重定向。
- [ ] 派发后超时/断线/取消记 unknown 且不重试。
- [ ] 功能局部失败保留健康服务，原严格模式不变。
- [ ] 当前模块文档与待验收 OAuth/界面/平台范围明确。

证据：待切片交付报告。
