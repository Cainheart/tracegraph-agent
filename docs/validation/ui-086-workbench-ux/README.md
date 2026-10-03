# UX-086 工作台与 Desktop 流程验收

状态：UX-086 已完成，REL-083 新归档与 REL-084 用户授权模拟已完成各自本地范围。Linux 保留一次未定位的 Session 读取时序失败和一次全新环境重跑通过；不声称零失败或外部独立验收。原工作树与历史验收均保留。

验收对象是本地 Outlive Agent `0.1.0-alpha.0`，没有 commit、push、公开部署或签名发布。本文和回执是验证工件；工作流事实由父工作区 canonical trace `run:063d7fd23806` 写入 `.agent-traces/run-0f68b401a7ed927b42b4.events.jsonl`。

## 实现与范围

共享 Workbench 默认展示对话，侧栏包含项目、固定会话与最近会话，输入区固定在任务底部。活动、变更与详情由明确入口打开。1024×768 保留核心操作，支持键盘导航与输入法组合保护；模型 effort 标签可读，主题沿用已保存偏好，初次打开跟随系统主题。

Desktop 经固定、schema 校验的 Main/preload/私有 Host 协议提供普通对话、Session 管理与恢复、后续输入、steer/cancel/stop、补丁与计划审批、Todo 读写、Artifact 内容。`RunInteractionController` 当前由 Desktop 消费；Web 保留既有 Runtime ingress。协议保留原有 16 条固定 fixture，追加 14 条；权限、审批、Memory/export consent 与 renderer 隔离继续成立。

[参考与旅程对照](reference-and-journeys.md)记录实际读取的官方交互来源、Outlive 对应能力与范围外功能。没有读取 Codex 内部源码或绕过被拒绝的 CUA 访问。

## 可复核证据

- [真实 client/Host 旅程回执](evidence/report.json)与[可复跑脚本](journey-harness.mjs)：本地合成 HTTP 模型，真实 Runtime、Ledger、补丁、测试、Artifact、Host 重启和取消。
- [新归档安装验收](release/README.md)：冻结摘要、macOS 新目录安装、隔离 Linux 安装、CLI/Host smoke、三条实际公开证明与原生 Preview 观察。
- [失败与修复的窄证据](attempts/desktop-tests-failed/electron-process-oracle.json)：同一补丁 fixture 和 full Seatbelt 策略，Electron 测试进程被阻止加载 Framework；本机 Node 通过两项断言。保留失败，不以放宽沙箱或等待超时处理。

24 张截图分别覆盖 Web/Desktop、1440×900/1280×800/1024×768、空态/活动 Run/工具结果/变更审阅，完整两端旅程与独立校验均通过；[逐张视觉复核](visual-review.md)和[复跑方法](harness.md)记录实际交互。Preview 单独标记，不混入真实 Host 旅程。

完整旅程在独立 Node 修复后的源码运行。收尾仅给共享 locale 增加输入框中文提示，不改业务、CSS、Main/Host 或权限逻辑；SDK/Workbench/Web/Desktop renderer 局部重建与 locale 三项测试通过，真实用户 Web 窗口已看到“输入问题…”。最终归档包含该补译；完整英文截图的业务断言和呈现不受这条映射影响。

## 工程验证

| 检查 | 当前结果与证据 |
| --- | --- |
| Workspace build / recursive typecheck | 通过；[构建](checks/build.log)、[类型检查](checks/typecheck.log) |
| Workbench | 20 文件、161 测试通过；含导航、状态、快捷键、布局入口和旅程 DOM 操作 |
| API / SDK / Desktop / Desktop Host | API 15、SDK 64、Desktop 12、Host 初轮 10 通过；Host 含三个真实 Runtime/framed RPC 旅程，最终独立 Node launcher 修复后 Host 18、Desktop 12、真实 Electron-origin 1 与 Host E2E 4 项均通过；[命令回执](checks/desktop-final.md) |
| Host / SDK / CLI / Web | 191 测试通过；[客户端回归](checks/client-tests.log) |
| Core / Tool | Core 单 worker 56 文件、468 测试通过；Tool 24 通过；[Core 回归](checks/core-sequential.log) |
| CLI / Desktop Host E2E | 各四项通过；[CLI](checks/e2e.log)、[Desktop Host](checks/desktop-e2e-rerun.log) |
| Engineering / docs evals | Node 94 + Vitest 8、docs/release/replay 11 项通过；[工程门](checks/engineering.log)、[文档评估](checks/docs-evals.log) |
| Architecture / generated docs / baseline | boundary、invariant、README、65-task DAG、module graph、catalog、198 test/eval-file baseline 检查通过；双语登记 56 对零漏登记、65-task DAG 与当前生成目录复验通过 |

初次 Core 并发运行有一项 5 秒 permission timeout，随后独立 permission 13 项与完整单 worker Core 468 项均通过。初次 Desktop Host E2E 与 baseline 的 clean/build 冲突造成 worker 路径缺失，停止并行重建后完整四项通过。重复 locale `Files` key 已修正并通过类型检查。GUI fixture 的启动与恢复时序错误保留在失败记录；真实 Electron 沙箱错误则由窄 oracle 单独确认并修复，不归为 fixture。宽屏隐藏 review tabs 的 locator 假设曾导致脚本失败，实际三种尺寸的 Files/Diff/Architecture 可见性复验通过，没有为该脚本假设修改产品 CSS。

## 发布与外部边界

这是维护者工作区 Agent 验证。合成模型证明工程流程，不证明真实 Provider 质量。归档未签名，没有 `.dmg`、自动更新或公开部署；Desktop 仍缺附件、瞬时模型输出流、replay/rollback 与可选 Team/扩展设置。新归档模拟可以闭环当前 REL-084 范围，P8 的真实外部用户从零安装退出条件仍未满足。BENCH-073 远端首次 CI 报告仍待运行与审查；真实分布质量仍未知。

## 最终归档与已启动入口

冻结归档 SHA-256：`41622f1719467850475d583115357d21ba0aa69e8469f27ab8b1e6cf0140298a`。当前 [归档](../../../_tmp_release/2026-10-03-ux086-final-preview/outlive-agent-0.1.0-alpha.0-preview.tar.gz)仍保留在工作树，安装与失败/重跑见[发布回执](release/attempts/final-archive/report.json)。先前两个摘要分别保留在 release/attempts，不能用于证明最终字节。

macOS 最终归档实际 Main 启动了独立 Node worker；workspace-write Seatbelt 下真实测试写出外部文件 oracle，原始日志为 2/2 assertions passed。原生 Preview 经 CUA 实际窗口观察，持续展示 Preview 与 deterministic example data；之后安装测试的 Main/Host/test/Preview PID 全部消失，唯一合成凭据删除，所有验证容器移除。Linux 首次 DEMO-080 在 crash 注入之前触发 fail-closed SessionPathSafetyError；一次全新容器重跑安装、smoke 与三条证明均通过。该原因仍未定位，Core 没有为该错误修改；记录保留并列为残余验证限制。

用户入口已实际启动：Web [http://127.0.0.1:4310/](http://127.0.0.1:4310/)，Host health 返回 ok。用户真实 Desktop 窗口标题 Outlive Agent，加载源码构建的本地 renderer（没有 preview 参数），显示“本地”与中文新对话输入。它与安装验证的合成临时配置隔离；用户会话和凭据保持原样。服务和用户 Desktop 留运行供试用。

![Desktop 变更审阅，1024×768，合成模型与真实 Host](evidence/desktop-change-review-1024x768.png)

最终文档检查：V2 11 个 manifest/65 个任务、56 对双语机械配对（52 legacy-unreviewed、4 draft）、module graph/catalog/baseline 与独立 UI evidence verifier 通过；站点投影 32 页、547 条本地引用、5 块 Mermaid，构建通过。配对检查不代表人工译文审校，站点仍为本机预览。
