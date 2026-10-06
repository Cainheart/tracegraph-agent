# UXD-096 页面设计审阅

这是**目标设计原型**，不是当前产品能力或验收证明。最终页面视觉实现等待用户逐页确认。后端独立实施不由本页判断完成。

入口：[index.html](index.html)。文件包含全部 HTML/CSS/JavaScript 与 B Current 标志，可直接打开，不需要启动服务。顶部可选页面、状态、1440/1280/1024 和浅/深主题。URL hash 保存所选设计页，例如 `#page=settings&category=computer&state=handover&theme=dark&width=1024`。原型 CSP 禁止网络连接；不会读取 Key、请求模型/Host、访问文件、调用剪贴板或观察操作电脑。所有确认、通过与回执均为模拟。

依据：[已接受 Note](../../../../.agents/notes/proposed/2026-10-05-complete-product-workbench.md)和 2026-10-05 用户已锁定的产品选择。配色使用中性灰蓝，品牌沿用 [Current SVG](../../../brand/current.svg)，不复制 Codex 私有实现或资产。

## 逐页检查

| 页/区域 | 需要确认的视觉与交互 | 状态重点 |
| --- | --- | --- |
| 新/项目/历史对话 | 同一个 composer；左 +/权限/Plan，右模型/推理/发送停止；项目展开会话和全局最近 | ready/running/queued/failed/offline/recovering；历史证据不执行 |
| 公开活动 | 一句公开说明＋一行真实活动；展开为简洁操作行，逐项钻取 | started/completed/failed/unknown；不显示私有推理或空 Todo/Team |
| 具体审批/执行计划 | 同一任务内联；批准范围、变更预览、拒绝路径明确 | plan/approval/unknown |
| 工作区面板 | Files/Changes/Terminal/Preview/Artifacts；≥1200 右栏，窄尺寸整页 | 草稿、冲突、回执、只读、关闭后回到对话 |
| Agent | 默认列表，可切关系/依赖/消息/工具；角色模型预算/Worktree/集中审阅 | running/completed/failed/pending |
| Goal | 完成条件、有限 token/time、费用可选、批准范围/检查点/人工验收 | queued/approval/unknown/failed/recovering |
| Memory/Experience | 个人与项目范围、来源版本、审核修正撤销、Recall 默认关闭 | offline/readonly；后台模型调用默认关闭＋有限预算 |
| Skills/扩展 | 全局＋项目覆盖，安装导入创建编辑，来源权限/更新扩权 | unconfigured/readonly/pending/conflict |
| MCP/LSP | 常用表单与模板，本机/远程，高级 JSON 按需 | 具体修复、任务级依赖阻塞、凭据只写 |
| 浏览器 | 内置/已有 Chrome tab，范围预览，DOM/Accessibility/visual 区分 | approval/unknown/handover |
| 电脑 | 独立应用授权、系统能力、一次/始终授权撤销、输入租约 | handover/locked；用户输入立即停手且手动交还 |
| 资料/用量 | 本机私有、选择导出、tokens/峰值/最长任务/热力图/详细用量 | 事实/估计/报告成本未知分开 |
| 搜索/归档 | 公开全文/项目文件引用/时间状态归档定位 | 离线不当空结果；历史定位不执行 |
| 帮助/安装 | 用途/示例/当前状态/范围有效值来源/具体修复 | 普通路径不用手工起服务；后台停止明确 |

## 设置分类（19）

常规、个人资料、快捷键、通知与后台、外观、个性化、模型与连接、权限与网络、浏览器、电脑操作、记忆与隐私、开发环境、Git 与审阅、Skills 与扩展、MCP/LSP、任务与 Agent、用量与诊断、归档与搜索、关于与更新。

每类有范围/来源/有效值/生效条件与上下文帮助。通用状态选择器可查看离线、只读、未配置、恢复、版本冲突和安全空闲应用。模型有明确文本/工具/vision/structured 小测试入口与备用授权；网络/代理分层；快捷键冲突/重置；外观即时预览；托盘/后台通知/防睡眠/浮动聊天；视觉证据默认30天与 pin；版本历史/差异与具体修复均呈现在设计中。

## 确认边界

- 清单 checkbox 只存在于当前设计稿内存，不记录用户正式同意。
- 原型按钮只切换模拟状态/显示目标流程；不据此宣称 native/远程 MCP/Goal/Agent 交付已完成。
- 原型截图仅证明设计稿渲染，不是 Web/Desktop/CLI 真正操作验收。
- UX-086 和整项产品计划的状态由 owning roadmap、真实实现及独立验收决定；本原型不改变它们。

## 验证边界

`env -u NODE_OPTIONS node docs/validation/product-workbench-2026-10-05/design/validate-design.mjs` 只检查脚本语法、禁止连接的 CSP、路由/19类设置/尺寸声明和 B Current 路径一致性。静态检查不能证明页面像素布局通过。

工具无法打开本地 HTML，且不允许切换浏览器或临时提供 HTTP 来绕过该限制。消息到达前已开始的初次自动检查在 hash 导航未刷新选页时失败，记录与6张初步截图保留于 `attempts/initial-automatic-check/`；其 `finally` 已关闭浏览器，`cleanupPassed=true`。这些图不作为逐页视觉验收。后续不再自动打开，视觉与交互由用户实际打开文件审阅。
