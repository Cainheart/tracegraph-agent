---
id: 2026-10-05-cfg-098-model-capability-tests
title: 显式且有界的模型能力测试
status: implemented
language: zh-CN
owners: [host, model, workbench]
created: 2026-10-05
last_reviewed: 2026-10-05
affects: [packages/contracts, packages/core, packages/host, packages/sdk, packages/workbench, apps/desktop, apps/cli]
supersedes: []
---

# Agent Note：显式且有界的模型能力测试

[English](2026-10-05-cfg-098-model-capability-tests.md)

## 问题与已批准范围

现有连接测试只发送一个小文本请求，不能证明原生工具调用、图片理解或符合指定结构的输出。用户已授权逐项显式小测试；实现验收不使用用户的付费凭据。

## 决定

独立类型化命令选择已保存连接、具体模型、配置版本和一至四个不重复测试项。只有用户明确确认后，选中项才依次各发送至多一个有界请求。输入是生成的专用夹具，不含项目、聊天、记忆或个人资料。原文字连接 API 保持兼容。

OpenAI Chat Completions 使用真实 function 工具调用、图片内容块和严格 JSON Schema response_format。Anthropic Messages 使用原生 tool_use 和 base64 图片块。本切片明确不支持 Anthropic 结构化输出，因为现有适配器尚未实现其原生格式；不能用提示词要求 JSON 冒充。OpenAI 兼容端点可以拒绝相应原生格式，该结果是测试失败，不能泛化为全协议支持。

通过条件是返回的原生结构及生成夹具的精确答案，不是 HTTP 200 或模型自行宣称支持。结果仅保留安全错误分类、耗时、有效的供应商用量和有界证据标签；不保存原始输出、凭据或图片字节。缺失用量与成本保持未知。图片夹具通过只是一项有限证据，不是视觉质量评估，也不自动开启图片输入权限。

控制器在派发前捕获现有不可变配置及凭据租约。测试或已接纳任务运行期间修改配置，不会改变原租约。规范命令 ID 绑定完整选择意图，并提供持久回执与只读核对。丢失响应和超时不能自动重发。已完成结果仍可查看，但新连接版本使旧结果不再代表当前配置。

规范命令完成后，才保存当前版本的设置摘要。投影持久化失败不能伪造供应商成败或重发请求，原已完成回执仍可读取。环境管理连接在 owner 重开时清除摘要，因为外部凭据/端点变化没有保存的版本；不改变任务版本或租约。已挂载控件丢弃旧 owner 读取/结果，重置已移除模型；同版本环境历史仅在命令匹配当前 owner 摘要或未重连的显式测试时可代表当前，否则明确显示历史。

## 验证与边界

本机可控 HTTP 夹具验证原生请求和返回结构、精确挑战值、畸形/拒绝/截断/错误答案、不支持格式零请求、用量存在与缺失、安全鉴权/限流/传输错误、幂等与租约/CAS 边界。SDK、固定 Desktop 桥、CLI 和真实设置控件使用同一契约。夹具不证明付费模型质量、安装或原生验收。本 Note 仅记录显式测试切片，完整 CFG-098 与产品范围仍单独追踪。

证据：[切片报告](../../../docs/validation/model-capability-tests/README.zh.md)、[原生协议负例](../../../packages/core/src/domains/model/model-capability-probe.test.ts)、[真实共享装配 HTTP](../../../packages/host/src/model-capability-http.test.ts)、[规范回执/投影顺序和失败](../../../packages/host/src/model-capability-control.test.ts)、[设置挂载恢复检查](../../../packages/workbench/src/model-capability-tests.test.tsx)、[真实 CLI HTTP](../../../apps/cli/src/model-capability-http.test.ts)。最终窄检查包括 Core 58、Host 10、SDK/语言 15、Desktop 7、CLI 31、Workbench 38 与契约 2 项，报告链接准确原始输出与保留的失败尝试。

协议依据：[OpenAI 工具调用](https://developers.openai.com/api/docs/guides/function-calling)、[结构化输出](https://developers.openai.com/api/docs/guides/structured-outputs)、[图片输入](https://developers.openai.com/api/docs/guides/images-vision)、[Anthropic 工具定义](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)、[图片输入](https://platform.claude.com/docs/en/build-with-claude/vision)。

## 恢复与兼容

测试不创建任务或执行工具，不修改模型能力声明、权限、当前任务配置或凭据。未知结果按原命令 ID 只读核对；用户了解前次请求可能已产生用量后，才能自行选择新的测试。原连接测试 DTO 不变。

## 验收

- [x] 有界原生协议测试与负例证据。
- [x] 持久意图与回执、不自动重试、只读核对。
- [x] 共享设置、CLI、SDK 与固定 Desktop 通道接入。
- [x] 当前文档与未支持边界和实测一致。
