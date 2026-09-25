---
id: outlive-agent-v2-cli-web-ui
title: CLI 与 Web UI 入口设计
status: proposed
scope: client-surfaces
language: zh-CN
parent: README.md
last_reviewed: 2026-09-25
---

# CLI 与 Web UI 入口设计

## 1. 共享与差异

```mermaid
flowchart TB
  P[Internal Protocol/Client] --> CLI[CLI Adapter]
  P --> WEB[Web UI]
  CLI --> H[Host]
  WEB --> H
```

CLI 与 Web UI 共享 Command/Query/Event 语义，但不强迫共享交互层。CLI 优先脚本可组合，Web UI 优先可视化与多任务导航。Desktop 复用同一内部协议，进程边界见 [Desktop 进程与安全](03-desktop-process-security.md)。

## 2. CLI/TUI

| 模式 | 输出规则 | 错误规则 |
|---|---|---|
| human | 进度、颜色、建议，stderr/exit code 明确 | 终端错误可读 |
| `--json` | 单一 versioned result envelope | stdout 不混日志 |
| streaming | JSONL 或 TUI event renderer | 断线/中断有最后 cursor |
| non-interactive | 需要 approval 时 fail 或按显式 policy | 不暗自默认确认 |

CLI 可以嵌入本地 Host，也可连接已有 Host，但两种模式使用同一 Controller conformance。

## 3. Web UI

Web UI 持有 normalized client projection、窗口/筛选/草稿等 UI 状态，不持有 Session/Run 真源。关键页面建议：workspace/session 导航、run timeline、approval inbox、Evidence/Artifact inspector、Memory review、settings/profile。

```mermaid
sequenceDiagram
  participant U as User
  participant W as Web Store
  participant S as Internal Client
  participant H as Local Host
  U->>W: command intent
  W->>S: submit(command_id)
  W->>W: reversible optimistic marker
  S->>H: command
  H-->>S: operation + cursor
  H-->>S: events
  S-->>W: reconcile projection
  W-->>U: authoritative state/error
```

## 4. 参数

| 参数 | CLI | Web UI |
|---|---|---|
| reconnect | 用户重跑/`--follow` | 自动退避 + cursor |
| approval | TTY 可交互；脚本 fail/explicit flag | inbox + notification |
| stream backpressure | bounded renderer | client buffer + snapshot reset |
| offline | 查看本地缓存需标 stale | Web 只允许草稿，不伪造已提交状态 |
| logs | stderr/diagnostic file | server logs，协议返回 correlation id |

## 5. 验收

Golden conformance 场景覆盖 start/cancel/approval/reconnect/error；CLI JSON 可机器解析；Web UI 刷新不会丢 Run；三种产品入口对同一终态和错误码含义一致。HTTP/RPC 仅是本机 Host transport 选项，不构成外部 API 产品承诺。
