---
id: 2026-10-03-installed-local-product
title: 自带独立运行时的可安装本机产品
status: implemented
language: zh-CN
owners: [host, desktop, distribution]
created: 2026-10-03
last_reviewed: 2026-10-03
affects: [packages/host, apps/desktop, apps/desktop-host, apps/cli, scripts, .github/workflows]
supersedes: []
---

# Agent Note：可安装本机产品

## 问题与已接受目标

现有未签名工作区归档依赖外部 Node.js 和 pnpm。用户要求安装即可使用的本机应用。保留共享认证 Host 与类型化 Web/Desktop/CLI 客户端，同时随应用交付独立的受支持 Node 二进制。Electron-as-Node 的框架资源超出沙箱内嵌套 Node 任务的权限范围，因此不适合此用途。

Desktop 使用固定的内置可执行文件，由可信装配层验证其清单、哈希、身份与版本。安装版启动不回退到 PATH。源码开发保留现有受支持 Node 解析器。打包脚本只组装产物，不承载产品行为。保留 @tracegraph 包作用域与持久协议词汇。

未显式指定端口时，Host 选择动态 loopback 端口。安装版 Web 资源与 HTTP 网关连接和私有本机通道相同的 Runtime。CLI 启动器使用内置 Node，发现同一 profile。关闭窗口只断开客户端。显式停止 Host 才关闭后台资源；默认不安装开机启动项。

显式 host.restart 只在没有活跃 Run、排队任务、自有终端/预览或其他进行中写请求时应用需要重启的设置。先冻结 admission 再检查空闲状态，直到替换 owner 就绪前拒绝新写请求。忙碌时拒绝重启，不取消任务。重启请求回执不等于就绪：Desktop 看到不同 boot nonce 后才重绑私有客户端和流；Web 与 CLI 验证替换 owner 与已清除的待重启设置。安装客户端比较内容派生的 build identity，不自动停止不同版本的活跃 owner。内置 Node 仅追加到 owner/启动器进程的 PATH，使子 Node 任务使用相同独立运行时。

品牌默认 profile 为 ~/.outlive/profiles/default。显式指定的既有 profile 目录继续可用。既有 ~/.tracegraph 来源通过现有扫描、备份、选择迁移流程呈现；启动不会静默合并或删除它们。恢复必须重新获得显式权限，不能自动恢复已导入或被中断的副作用。

v2 打包资源策略保留固定目标的 TypeScript 原生编译器与完整标准库目录。尽管打包器通常会裁剪声明文件，这些 `.d.ts` 是实际运行输入。目标原生可选依赖按锁文件的准确版本与 integrity 选择，并校验 OS/CPU 与可执行文件头。build identity 包含应用 stage、固定 Node 与此资源策略。独立的打包后清单记录实际交付文件和已解析依赖图，不声称依赖重排、元数据规范化和裁剪后仍与 stage 完全相同。

## 不变量与失败策略

- 保留私有目录权限、owner lease、bearer 认证、renderer 隔离和权限上限。
- 内置运行时身份或完整性失败返回 setup-unavailable；模型凭据与任意环境参数不能选择可执行文件。
- 安装版 Web 同源请求需要准确的 loopback 网关身份和浏览器来源证据。缺失或外部 Origin 不获得写权限。
- 模型配置保存与有界连接测试分别表达结果。可选 MCP/LSP 配置不能阻止首次对话。
- 安装产物包含固定应用代码、Web 资源、CLI、原生运行时依赖和许可证材料，不包含用户数据或凭据。
- 未签名、签名/公证与独立平台验证结果分别标注。macOS 跨平台构建不能证明 Windows 或全新机器验收。

## 兼容与回滚

保留旧私有 framed Host 和源码启动 seam 的兼容测试。旧归档证据保留为历史，不能证明新安装包。升级保留应用包外的 profile。不支持的 discovery 协议、不安全 profile 或活跃竞争写入者应 fail closed。替换应用不重写账本，也不自动授予执行权限。

## 验收条件

- [x] 内置运行时验证拒绝缺失、损坏、不支持和 Electron 可执行文件，且不回退 PATH。
- [x] 真实本机通道证明默认动态端口、owner 复用、客户端断开和显式停止。
- [x] 安装版 Web bootstrap 与写请求具备同源保护；外部和缺失浏览器来源证据的请求被拒绝。
- [x] macOS 应用在无外部 Node/pnpm 条件下启动，并与内置 CLI 共享真实状态。
- [x] 组装路径构建自包含 macOS 与 Windows 产物及校验和；已配置原生 CI，签名与实际平台边界准确标注。
- [x] macOS 实际安装版首次启动可保存模型、显式测试连接并开始首次对话；可选集成不构成阻塞。

## 证据

实现与当前证据在 [installed-local-product](../../../docs/validation/installed-local-product/README.md) 索引。运行时/通道负例、真实忙碌/空闲重启与安装器完整性/依赖负例已通过。macOS v2 真实应用 smoke 有 13 条断言，覆盖实际原生 CodeGraph、私有 owner、内置 CLI、Web、PTY、后台完成和重启。实际 DMG 安装版 UI 在三种尺寸验证设置、对话、精确审批、真实 patch/test/review 与媒体；安装版媒体有 94 条 oracle 和 666 条独立验证检查。使用合成 loopback provider 和维护者范围均明确标注。

早期候选缺少 TypeScript 标准库，导致真实项目分析失败；该证据保留，不计入最终验收。Windows x64 NSIS/ZIP 已跨平台构建并验证 PE、图标和目标运行时清单，但 Windows 原生安装/启动/PTY 与独立外部用户全新环境验收仍未验证。未使用签名凭据，默认产物未签名/未公证。macOS 正常退出应用观察与关闭窗口、harness 信号清理单独记录，信号不能作为 Cmd-Q 成功声明。先前 unified-local-workbench 证据仅证明其之前源码/归档范围。
