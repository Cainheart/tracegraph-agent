---
id: outlive-model-capability-tests
language: zh-CN
status: current
---

# 显式模型能力测试：已验证源码切片

[English](README.md)

2026-10-05 核验。本切片完成 CFG-098 的显式小型测试控制器、传输与设置入口，不代表全部配置、备用服务、产品、付费模型质量或原生安装验收已完成。

## 使用入口与结果含义

在设置 → 模型中，展开已保存连接的**测试模型能力**，选择其具体已配置模型及测试项，再确认**运行所选测试**。环境管理的只读连接也能测试。选中的受支持项依次各发送至多一个有界请求，输入仅为生成数据，不含项目、聊天、记忆或个人资料。通过不授予工具权限，不改变图片声明，也不改变已接纳任务配置。

| 项目 | OpenAI Chat Completions | Anthropic Messages | 必须具备的证据 |
| --- | --- | --- | --- |
| text | 原生文字消息 | 原生文字消息 | 精确返回生成挑战值 |
| tools | 原生 function tool call | 原生 tool_use 内容块 | 工具和参数与声明一致，不执行调用 |
| image | PNG image_url data URI | PNG base64 图片块 | 正确返回生成图片的四象限颜色顺序 |
| structured | strict JSON Schema response_format | 当前不支持，零请求 | 原生格式请求及一个精确返回样例对象 |

HTTP 200 或普通文字宣称支持均不能通过。结构化样例不证明供应商强制所有 schema 约束；生成的 32×32 PNG 只测试有限输入，不是视觉基准。OpenAI 兼容端点可能拒绝原生格式，失败不能被提升为整个协议已支持。

每个请求输出最多 192 tokens、响应最多 64 KiB，控制器期限为 15 秒。只有有效供应商返回才计为已报告用量；缺失用量或成本保持**未知**。回执不保存原始输出、生成图片字节、凭据或私有存储错误详情。原生结构、精确挑战值、拒绝、截断、错误工具参数、额外结构字段、HTTP 错误及缺失计量均有独立检查。

## 权威来源、持久化与恢复

命令绑定连接 ID、配置版本、精确模型、所选项目和显式确认。[控制器](../../../packages/host/src/model-capability-control.ts)使用独立规范 Journal，并捕获配置/凭据租约。同 ID 同意图合并派发或读回原结果，改变意图会冲突。测试等待期间更换已保存 Key，不改变原请求绑定的模型/Key。

规范命令完成后，才更新可选的当前版本设置投影。投影错误返回安全失败，但已完成回执仍可读取；同命令再核对不会重复供应商请求。失败、不支持和未知项目如实保留，命令已完成不等于全部测试通过。只有尚未 settle 的当前请求和回执写入使控制器忙；历史未知供应商用量不代表未知项目写入。

本机保存的连接重开后可读取当前版本摘要，更换模型或 Key 会使其失效，历史回执保持可读。环境管理连接在每次 owner 重开时清除摘要，因为外部凭据或端点可能绕过保存的版本改变。用户重新明确测试后可生成当前 owner 的摘要，不改变任务版本或租约。

**核对上次测试**只读原回执，不再次请求供应商。未知命令指针通过 session storage 跨设置重挂载保留，它仅用于对账，不是成功事实。已挂载控件也会丢弃旧 owner 延迟读取/结果，重置已移除模型，不依赖重新挂载。同版本环境回执仅在命令匹配当前 owner 摘要或未重连的显式测试时代表当前，否则明确显示历史。超时、断连、缺少回执或投影失败均不自动重发。CLI 对应入口为：

```text
outlive models capability-test <connection-id> --input-file test.json --command-id <id>
outlive models capability-receipt <id>
```

JSON 只选择 `expected_revision`、`model`、不重复 `features` 和 `confirmed:true`，不能注入提示词、文件路径、项目范围或秘密。CLI 全部通过退出 0，存在失败/不支持退出 1，存在未知退出 3；completed 回执使用相同业务分类。原小文字连接测试保持兼容。

## 验证证据

下列检查均在当前工作区运行，使用本机回环供应商及合成凭据，不使用付费供应商或用户 Key。这里是源码、单元及真实本机 HTTP 检查，不能当作新安装包截图。

| 检查 | 实际结果 | 原始输出 |
| --- | --- | --- |
| Core 原生测试与既有适配器 | 2 文件、58 测试通过 | [core-final.log](checks/core-final.log) |
| 真实共享装配/HTTP、Journal 投影与租约 | 3 文件、10 测试通过 | [host-final.log](checks/host-final.log) |
| 能力装配存在/缺失负例 | 1 通过、21 明确跳过 | [capabilities-final.log](checks/capabilities-final.log) |
| 严格请求与证据契约 | 1 文件、2 测试通过 | [contracts-final.log](checks/contracts-final.log) |
| SDK 意图校验与共享中英语言 | 2 文件、15 测试通过 | [sdk-locale-final.log](checks/sdk-locale-final.log) |
| 固定 Desktop 桥与既有严格路由 | 2 文件、7 测试通过 | [desktop-final.log](checks/desktop-final.log) |
| CLI 解析与真实 CLI→owner→HTTP 供应商 | 2 文件、31 测试通过 | [cli-final.log](checks/cli-final.log) |
| 设置控件、既有对话与帮助 | 3 文件、38 测试通过 | [ui-final.log](checks/ui-final.log) |
| Contracts/Core/Host/SDK/Workbench/Desktop 类型 | 六个包检查通过 | [Contracts](checks/contracts-types-final.log)、[Core](checks/core-types-final.log)、[Host](checks/host-types-final.log)、[SDK](checks/sdk-types-final.log)、[Workbench](checks/workbench-types-final.log)、[Desktop](checks/desktop-types-final.log) |

CLI 最终类型检查曾遇到与本切片无关的交互聊天 legacy 可选 session ID，失败保留在 [cli-types-final.log](checks/cli-types-final.log)。负责人 root 已修复并另行验证 [CLI 类型](../product-workbench-2026-10-05/checks/cli-interactive-types.log)和 [12 项交互检查](../product-workbench-2026-10-05/checks/cli-interactive-current.log)。不要把保留的失败尝试当成通过。

早期尝试保留了真实夹具错误：HTTP 最初漏 bootstrap，随后漏 workbench 路由装配；UI 最初用了未安装的帮助包、把 aria-label 当正文，以及断言旧说明。语言负例发现真实缺失的**图片输入**标签，现已翻译。`checks/` 同时保留修前日志和最终通过输出。

## 剩余范围与源码定位

真实付费供应商行为/质量、账单对账、新安装包三个尺寸与明暗主题的实际界面，以及 root 全仓构建/发布验收，均需独立证据。没有增加自动备用服务、广泛能力推断或全协议可靠性保证。

- [类型契约](../../../packages/contracts/src/model-capability-tests.ts)、[原生协议实现](../../../packages/core/src/domains/model/model-capability-probe.ts)、[实际 HTTP 检查](../../../packages/host/src/model-capability-http.test.ts)。
- [版本与结果投影](../../../packages/host/src/conversation-control.ts)、[共享控件](../../../packages/workbench/src/components/ModelCapabilityTests.tsx)、[CLI 命令](../../../apps/cli/src/workbench-command.ts)。
- [模型模块](../../modules/06-模型适配与推理强度.md)、[Host/SDK 模块](../../modules/09-Host-与-SDK-接口层.md)、[用户手册](../../user-guide/README.zh.md)。
