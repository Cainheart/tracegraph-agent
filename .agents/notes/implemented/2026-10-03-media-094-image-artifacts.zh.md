---
id: 2026-10-03-media-094-image-artifacts
title: 通过类型化媒体工具和 scoped Artifact 证明图片输出
status: implemented
owners: [media-runtime]
created: 2026-10-03
last_reviewed: 2026-10-03
affects: [contracts, core, evidence, tool, host, sdk, cli, workbench]
supersedes: []
---

# Agent Note：通过类型化媒体工具和 scoped Artifact 证明图片输出

## 问题与此前状态

G-18 提供上传的 PNG/JPEG/PDF 输入。生成输出缺少类型化 provider/tool 链路与 scoped 二进制内容接口；声称图片存在的 prose 或代码不是媒体回执。

## 已实施决策

MEDIA-094 注册可信 Core 工具 `generate_image`、`render_diagram`、`render_chart`，输入闭合且有界。Runtime-owned 二进制发布先写入验证字节，再把引用加入既有 canonical Tool → Receipt → Observation → Ledger 链路。仅 Host 的一键指令适配器沿正常 Run/session admission、policy、取消和回执运行，不要求配置聊天模型。公开任务标题显示操作与 prompt/title 摘要；完整类型化 intent hash 绑定 command 重试，参数变化拒绝。

独立设置显式选择 OpenAI-compatible Images、OpenAI Responses image tool 或兼容原生 Chat 图片输出约定。凭据引用在 provider 边界解析；每 Run executor binding 冻结配置，旧凭据保留到 terminal/cancel。Binding 必须保持注册 descriptor 与权限相同，公共客户端不能传入 executor 或改变权限。

生成位图仅支持 PNG：完整 CRC/header/IDAT 校验、解压行有界、非隔行 8-bit 灰度/RGB/alpha；最多 20 MiB、边长 ≤8192、像素总数 ≤16,777,216。JPEG/WebP 生成明确返回不支持。本地流程图、bar/line chart 输出转义后的自包含 SVG，标签/XML 字符/有限数值范围均有界；不执行任意 SVG、脚本、shell 或外部资产。

显式媒体 Run 在 canonical `run.created` 记录可信 `background_model_derivation:false`。Memory worker 在运行结束与恢复时都尊重该事实，防止本地绘图隐式触发模型尾请求。普通聊天/任务抽取保持原行为；内部适配器决策事件不证明发送了网络 provider 请求。

## 不变量与边界

成功必须具有已验证的存储字节、project/Run scope、SHA-256 和一致的 canonical receipt/Event refs。公开 Event 和 Observation 保存 metadata，不保存字节、base64、凭据或 provider prose。Live 内容读取再次约束 canonical 关系与 hash/MIME/长度；SDK 校验收到的摘要。Replay 不能读取字节或写入。Plain Chat 媒体发布不会授予项目文件系统或命令权限。

Malformed/prose/仅远端 URL 的响应 fail closed。认证错误是安全失败；派发后超时/网络不确定/服务端错误保持 unknown，不自动重试。同 command 加完整 intent 返回原已接受 Run，不重复派发。显式取消不会记录输出成功，但不能保证远端没有计费。Policy deny/Plan Mode 的 provider 请求数为零。普通非 Patch ask 仍要求既有可信一次性 answerer；UI 手动审批未接通时 fail closed，不算已完成。

## 迁移、回退与 deferred 范围

既有文本 Artifact 和附件输入继续支持。新增二进制 MIME、API 和工具 seam 是 additive；删除媒体扩展会禁用未来生成，但历史 scoped 引用仍可读取。图片编辑、JPEG/WebP 生成、任意 SVG 导入、音视频、真实提供商质量/访问/费用及独立外部用户验收 deferred；未增加 native/media 依赖。

## 验收与证据

- [x] 三种显式图片协议返回真实外部夹具 PNG 字节与一致的 canonical Artifact hash。
- [x] Diagram/chart 在 chat/image 均未配置时可运行；配置聊天 provider 后额外图表仍零 chat/image/post-run 请求。
- [x] Malformed base64、prose/empty/invalid 响应、大小上限、auth、timeout/unknown、cancel、exact retry 均不能制造输出成功。
- [x] Scope mismatch、corruption、Replay、body/key 泄露、远端 URL、恶意 XML 和数值溢出 fail closed。
- [x] 当前文档区分受控 API 验证与未验证的外部模型质量/访问/费用。

[证据与能力矩阵](../../../docs/validation/media-094/README.md)：真实分离的认证 Host 与生产 CLI，`PATH=/usr/bin:/bin`，临时 private-file 凭据 profile，20 次 CLI / 94 断言 / 6 个实际文件；[独立校验](../../../docs/validation/media-094/evidence/source-final/independent-verification.json) 666 项通过，包含 12 个已加载生产模块的 hash。夹具图片是算法生成的协议字节，不是 AI 质量证据。首次夹具枚举失败及第一次完整通过记录均保留。

Core 媒体/Memory 测试 3 文件 / 50 测试；Host 协议集成 2；SDK 2；CLI 16。相关类型检查与 targeted build 通过。DMG 真实安装的 Mac 应用随后也通过同一[20 CLI / 94 断言 / 6 文件](../../../docs/validation/media-094/evidence/installed-mac-final/report.json)及[独立 666 检查](../../../docs/validation/media-094/evidence/installed-mac-final/independent-verification.json)，只用自带 Node 与安装依赖，不回退源码 import；资源清理通过。Web/Desktop UI 和安装产物证据由独立发布检查负责。

2026-10-03 核对官方 [Images API](https://developers.openai.com/api/reference/resources/images/methods/generate)、[图片生成](https://developers.openai.com/api/docs/guides/image-generation)、[Responses image tool](https://developers.openai.com/api/docs/guides/tools-image-generation)。兼容 Chat 是显式响应约定，不声称所有服务都实现此协议。
