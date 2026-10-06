---
id: visual-retention-workbench-ui
language: zh-CN
status: current
---

# 视觉证据保留：共享界面切片

[English](ui.md)

本记录是当前源码级界面验证。[保留控制器证据](README.zh.md) 仍是独立冻结检查点，这些结果不认证最新安装包原生应用或 Windows 行为。界面测试没有付费模型请求、图像生成或原生输入。

## 使用真实控件

设置 → 记忆与隐私 → 截图与视觉证据接入六个严格类型方法：getVisualRetentionSettings、updateVisualRetentionSettings、listVisualEvidence、pinVisualEvidence、cleanupVisualEvidence、getVisualEvidenceCommandReceipt。可用状态来自 visual.retention.read/write 与 visual.evidence.read/pin/cleanup/reconcile，不能仅根据 callback 存在推断。离线、回放、策略拒绝、组件缺失、加载失败和空列表分别展示。

默认保留 30 天，可设为 1–365 天。后台定期清理可配置；打开页面仅读取，不发起删除。保存绑定已加载版本，CAS 拒绝后刷新会保留编辑草稿，用户可明确按新版本重试。固定或取消固定绑定精确证据 ID/版本，最多固定 500 项仍由后端约束。

项目与可选任务筛选限定清理请求。查看过期截图仅预览已加载、保留中、未固定且已过期的记录。确认后仅发送最多 50 项的有界批次，控制器重新核对范围、期限和固定状态，也可能检查同一范围内其它已登记记录。仅删除有确切来源的截图副本，消息、事实记录、生成媒体和未登记旧图片均保留。空列表不会产生清理成功提示；零删除的完成回执明确显示没有删除。

响应丢失或清理不确定时保留原命令并锁定后续写入，同一客户端关闭后重新打开仍保留待核对编号。核对原始截图命令仅做只读查询，校验命令及操作类型，绝不重新派发。观察字节不等于完成回执；命令虽完成但清理结果未知时仍锁定。失败、确定的派发前拒绝/CAS 冲突与不确定结果分开处理，不展示私有内部地址。

## 验证

| 检查 | 实际结果 | 原始证据 |
|---|---|---|
| 保留控件、帮助与集成界面 | 3 文件、29 测试通过 | [targeted-final.log](ui-checks/targeted-final.log) |
| 完整 Workbench | 41 文件、323 测试通过 | [workbench-all-tests.log](ui-checks/workbench-all-tests.log) |
| 共享语言目录 | 10 测试通过 | [locale-tests.log](ui-checks/locale-tests.log) |
| 类型 | Workbench 与 SDK 通过 | [Workbench](ui-checks/types-final.log)、[SDK](ui-checks/sdk-types.log) |

七项新增保留界面旅程覆盖打开页面只读/默认值、精确固定命令且不把元数据假称图片、限定范围预览与零删除回执、重挂载后未知清理不重发、加载失败与空列表、策略/离线下停用旧控件，以及 CAS 拒绝后保留草稿、刷新版本并明确保存。帮助只导航到对应设置分类，不调用模型或控制器操作。已知内置扩展显示友好名；诊断包 ID、启停与重载仍使用精确受信标识，未知扩展名称不改变。

初始夹具类型错误把重载响应写成 void，而接口要求严格 ExtensionStatus。[修复前类型日志](ui-checks/types-fixture-before-fix.log) 已保留，最终夹具返回真实类型回执。较早[首次保留测试日志](ui-checks/tests.log) 不替代最终数量。界面测试不标为真实系统像素或独立用户验收；最终安装包构建与原生观察由主发行工作记录。

## 指南与范围

[应用内帮助](../../../packages/workbench/src/components/WorkbenchHelp.tsx) 和[用户手册](../../user-guide/README.zh.md#topic-visual) 提供英中操作指导。Skills 帮助已说明核验过的[有界单文件生命周期](../skill-management/README.zh.md)；浮动聊天复用同一已加载窗口，置顶默认关闭且仅本次应用会话生效。浏览器/电脑来源、旧图片保留、同 UID unlink 窗口限制仍以控制器证据为准，界面不会声明更强保证。
