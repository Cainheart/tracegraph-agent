# 当前源码验证与失败记录

以下检查在本轮工作区执行。安装包验收另见[交付报告](README.md)，不能用源码单测或旧归档证明新安装包通过。保留完整输出与失败候选，未执行的外部验收没有记为通过。

| 检查 | 实际结果 | 证据与范围 |
| --- | --- | --- |
| 当前源码构建与类型 | 通过 | [最终全量构建及基线生成](checks/final-baseline-generation.log)、[workspace 类型](checks/final-typecheck.log)；22 包、230 个测试/eval 文件、108 个 event schema 分支。生成器中的 G16 三项诊断通过。 |
| workspace 单元测试分段汇总 | 1379/1379，20 个包 | [前 16 包](checks/final-workspace-units-timeout-attempt.log)共 1125 项通过；[Host](checks/final-host-units.log)113、[CLI/Desktop Host/Desktop](checks/final-app-units.log)88/18/35。完整串联首次到 Host 超时，故不能称那一次命令全绿。 |
| 工程脚本与 coverage gate 单测 | 101 + 8 通过 | [最终输出](checks/final-engineering.log)；包括运行时哈希、跨平台原生二进制、签名配置拒绝、闭合真实依赖 inventory、打包安全、边界与文档检查。这不是全量 coverage 结果。 |
| 离线 eval | 32/32，17 文件 | [最终稳定运行](checks/final-stable-evals.log)，不调用真实付费提供商。 |
| 规范 recorded-session | 五项通过 | [回放输出](checks/snapshots.log)：最小完成、恢复、取消、记忆召回、子 Agent。回放不执行副作用。 |
| 模型错误纠正与连接配置租约 | 通过 | Core plan-mode 12 项覆盖整批参数拒绝、零执行及三次上限；Host 测试覆盖在 journal dispatch 前更换 Key，旧测试保留旧租约且不会把新 Key 标为已测试。均纳入上方全量单测。 |

最终结构与文档门禁：

| 门禁 | 结果 |
| --- | --- |
| [边界](checks/final-boundaries.log)与[不变量](checks/final-invariants.log) | 22 包/58 依赖/2568 import references/0 legacy findings；335 source files 通过。 |
| [package README](checks/final-package-readmes.log)、[manifest](checks/final-manifests.log)、[V2 DAG](checks/final-v2-docs.log) | 全通过；74 项路线图任务。 |
| [派生 catalog](checks/final-catalog.log)、[结构 baseline](checks/final-baseline.log)、[module graph](checks/final-graph.log) | 刷新后 check 全通过。没有手改生成文件绕过检查。 |
| [双语注册](checks/final-i18n.log) | 61 组注册，0 未注册；57 组为明确未人工审校状态。指纹通过不等于译文人工审校。 |
| [静态站点输入与引用](checks/final-site-check.log)、[diff](checks/final-diff.log) | 通过；不证明远端链接或公网发布。 |

## 保留的失败与处理

- 安装候选曾漏掉 TypeScript 原生运行时必需的标准库 `.d.ts`；安装版真实项目创建触发 CodeGraph 时失败。最终打包保留受信目标平台完整标准库，最终 Mac-v2 的 bundled Node CodeGraph smoke 和真实项目旅程通过。旧安装回执在 [attempts](attempts/installed-dmg-001-pre-stdlib-fix.json)，失败 GUI 记录在 [attempt006](../install-use-workbench/attempt006-installed-dmg-desktop/report.json)。
- 本地纯图表曾在 Run 结束后隐式触发 Memory 模型尾请求；显式媒体 Run 现在记录 `background_model_derivation:false`，恢复沿用该耐久事实。普通聊天仍保留原 Memory 管线。源测试、最终媒体与真实 UI 验收覆盖修正。
- 大量安装压缩与单测并发时，130 次真实通知事实/260 个 fsync Ledger 事件的保留测试超过原 5 秒预算；[首次全量失败](checks/final-workspace-units-timeout-attempt.log)保留。该功能测试明确为 20 秒，不减少事件、不 mock 文件、不改变产品超时、G16 或性能基准，最终独立 Host 113 项通过。
- 首次 release eval 对旧 CI 单一 preinstall guard 的数量断言已过时；更新为每个 native job 的实际 guard，并补齐新增安装 job 的 guard。[首次失败](checks/eval-before-release-CI-fix.log)保留。另一次 eval 与清理 `dist` 的构建并发造成导入失败，[竞态失败](checks/eval-build-race.log)保留；构建稳定后 32 项通过。
- 真实 Electron CSP 禁止页面 `fetch(blob:)`，早期下载验收夹具误用该方式而失败。最终通过实际 download 文件检查字节/哈希；应用 CSP 没有放宽。
- 额外 native Cmd+Q 观察曾因计算机控制工具不可用而未实际发送退出操作；[attempt008](../install-use-workbench/attempt008-final-installed-dmg-nativequit/report.json)保留为失败，69 张截图与 12 项先前旅程断言不能使该整体报告变成通过。
- 分开的[实际 native Cmd+Q 验收](../install-use-workbench/attempt011-installed-native-quit/report.json)已通过：正常退出 Electron 为 0，同一 Host PID/nonce 保留并完成 held Run，实际随包 CLI 再次读取完成事实。未将 SIGTERM/SIGKILL 测试清理冒充正常 Quit。

## 品牌与边界

四个原创 SVG 已由真实 Chromium 渲染，[候选 PNG](../../brand/logo-candidates.png)经过视觉检查；ICNS 使用系统 `iconutil`，ICO 含 256px PNG。A 是预览默认标志，最终商业标志等待用户选择。

本轮采用私有临时 profile、假密钥、真实本地 HTTP Provider 夹具和实际文件/进程/PNG/SVG 外部结果。它证明实现链路与失败处理，不证明真实提供商账号权限、生成质量、成本、签名、干净 Windows/macOS 环境或非维护者体验。后者仍属于 DIST-095/REL-083/P8 待验收边界。
