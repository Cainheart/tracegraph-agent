# 安装后直接使用的共享工作台验收

2026-10-03。本地维护者 Agent 的模拟验收；提供商是确定性 loopback HTTP fixture。界面、权限、审批、实际文件修改、测试、生成 Artifact 的字节、安装应用、自带 Node 与 CLI 都是真实路径。此记录不代表真实 AI 内容质量、独立外部用户验收或公开签名发布。

## 最终结果

| 消费者 | 结果 | 证据 |
| --- | --- | --- |
| 已构建 Web + 隔离真实 Host | 66 截图、22 状态 × 3 尺寸、12 个流程断言；独立验证 694 项通过；清理通过 | [最终报告](attempt007-final-web-with-approval/report.json)、[独立验证](attempt007-final-web-with-approval/independent-verification.json) |
| 从只读 DMG 复制到 `~/Applications/Outlive Agent.app` 的真实 Desktop | 66 截图、同样 22 状态 × 3 尺寸、12 个流程断言；独立验证 706 项通过；清理通过 | [最终报告](attempt009-final-installed-dmg-desktop/report.json)、[独立验证](attempt009-final-installed-dmg-desktop/independent-verification.json) |
| 安装应用的原生 Cmd+Q 与后台任务 | CUA 先观察真实运行窗口，再发送原生 Cmd+Q；Electron 退出 0，同一 owner PID/boot nonce 完成等待中的 Run；安装包 CLI 再读到完成；清理通过 | [最终报告](attempt011-installed-native-quit/report.json)、[原生动作记录](attempt011-installed-native-quit/native-quit-done.txt)、[运行证明](attempt011-installed-native-quit/native-quit-proof.json) |
| Workbench 单测与类型 | 28 文件 / 209 项通过，类型检查通过 | `packages/workbench/src` 中 SetupFlow、media、live-client、generated-media、unified-workbench 等测试 |

界面尺寸是实际 Web/Electron renderer 视口 1440×900、1280×800、1024×768。Desktop 通过真实安装 executable、固定 preload/Main bridge 与独立 owner；不模拟 bridge、不使用源码运行时兜底，环境 `PATH=/usr/bin:/bin`。最终安装 build ID 为 `c72a0a30a897dab039db2275ddcb839ce4dc617fdb16da92968867e619c507f2`。清单中的 Renderer、Main、Host、Core、CLI 与自带 Node 字节哈希在旅程前后保持一致。

## 覆盖的实际动线

首次使用选择模型、保存只写凭据、明确发起 16-token 小测试。错误密钥真实返回 401，界面不能继续；修正后显式测试成功才进入项目步骤。保存配置与打开窗口都不会自动请求模型。创建真实托管项目后可回到普通对话；未配置 MCP/LSP、未选择项目也能聊天。

图像设置保存不发生成请求。明确生成 PNG 后，真实工具 receipt 和 Artifact 定位符驱动预览，SDK 验证身份、MIME、长度及 SHA256，浏览器真实解码像素；点击实际 Download，保存字节与独立 provider fixture 一致。关系图与图表生成实际 scoped SVG，无通用模型/图像/Memory 尾抽取请求。Desktop 保持 `connect-src 'none'`，通过 native bridge 读取，再以 Blob 图片显示和实际下载，不放宽 CSP。

项目旅程执行真实 search/read_file/preview_patch。审批前外部文件哈希不变；界面 Allow once 提交准确审批，实际 patch.applied Action 修改 `src/add.ts`，真实 Node 测试返回 success。审批后仍显示对话，变更审阅由用户打开；三个尺寸下真实 panel 与关闭按钮都在视口。包内 `bin/outlive run get` 独立读取同 profile/Run/Action/test，无平行账本。安装版目录保留 `before-add.ts` / `applied-add.ts` 和 `patch-proof.json`，供独立计算 SHA256。

默认界面没有 Pinned、顶部 Settings、绿色 Local 标记或零长度队列；活动默认折叠，显示一句公开当前说明与一行配对的实际操作，模型/传输细节按需查看。普通 About 显示修复连接，Host Stop、版本、目录和 CLI 信息在安装诊断展开后才可见。共享中文设置实际生效并复验首次引导。保存失败、只读凭据、原生目录选择取消、未知媒体接受结果保持原命令、Replay、输入法、滚动以及重启接受与生效的区别由针对性的单测覆盖。

## 保留的失败与修复

| 尝试 | 结果与后续 |
| --- | --- |
| attempt001 / attempt002 | 实际发现本地媒体错误触发 Memory 派生模型请求；Core 为受信媒体持久化禁派生事实后重跑通过，普通 Run 仍可派生。 |
| attempt004 | 验收假设打包仍使用 monorepo `packages/host` 布局，读取清单失败；改用实际 `node_modules/@tracegraph/host`，应用未启动。 |
| attempt005 | 预览图片已解码，验收 `fetch(blob)` 被正确的 Desktop CSP 拒绝；改为点击实际 Download 并观察真实下载完成，不修改 CSP。 |
| attempt006 | 真实项目 Run 在修改文件前安全失败。TypeScript native `--version` 明确 panic 缺少运行时 `lib.d.ts`；打包保留标准库并从新 DMG 安装后，审批/测试通过。原失败和 stderr 保留。 |
| attempt008 | 69 截图与所有正常流程已过，但原生观察 marker 等待 120 秒超时；当时 CUA 未发送 Cmd+Q，不算成功。后续单独 300 秒小 fixture 通过。 |
| attempt010 | fixture 在 Main 初始 loadFile 期间过早 reload，ERR_ABORTED；等待真实 `.app` 挂载后重跑，产品字节不变。 |

各次失败都保留原始报告，并完成自身资源清理。最终成功目录是 attempt007、attempt009、attempt011；不要将旧失败目录或旧安装 build 当作最终成功。

## 重现

需项目已经构建，且提供 Playwright runtime 路径。脚本仅创建并清理自身临时 profile、项目、服务与 loopback provider；不读取或修改用户密钥。

```bash
OUTLIVE_PLAYWRIGHT_MODULE=<Playwright/index.mjs> env -u NODE_OPTIONS node docs/validation/install-use-workbench/ui-journey.mjs <new-web-output>
OUTLIVE_PLAYWRIGHT_MODULE=<Playwright/index.mjs> OUTLIVE_DESKTOP_BINARY='<installed app>/Contents/MacOS/Outlive Agent' env -u NODE_OPTIONS node docs/validation/install-use-workbench/ui-journey.mjs <new-desktop-output>
env -u NODE_OPTIONS node docs/validation/install-use-workbench/verify-ui-evidence.mjs <output>
```

原生退出单独运行 `native-quit.mjs`，等待 ready 文件，使用真实 CUA 观察正确 PID 的隔离窗口并发送 Cmd+Q，再写 native-quit-done marker；脚本验证实际退出、同 owner/boot 的任务完成、包内 CLI 和有界清理。marker 只是操作交接，不能单独构成退出或业务成功证据。

已实施架构 Note：[英文](../../../.agents/notes/implemented/2026-10-03-install-use-onboarding.md)、[中文](../../../.agents/notes/implemented/2026-10-03-install-use-onboarding.zh.md)。
