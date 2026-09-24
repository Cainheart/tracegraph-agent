---
id: repository-skills-catalog
status: implemented
owner: repository-governance
last_reviewed: 2026-09-23
---

# Repository Skills / 仓库维护技能

These are operating manuals for **maintaining this repository**, not the
product's runtime Skills loaded from project/user .tracegraph/skills/.
以下 Skill 是维护仓库的操作手册，不是产品运行时加载的 .tracegraph/skills/。
Each language has its own callable SKILL.md. Choose **one** language for a
task; the paired files describe the same workflow and must change together.
每项操作有中英两个可调用入口；一次任务只选一种语言，修改时同步另一种。

| Workflow / 流程 | 中文入口 | English entry | Current boundary / 当前边界 |
|---|---|---|---|
| Pre-push verification / 推送前验证 | [outlive-pre-push-zh](outlive-pre-push-zh/SKILL.md) | [outlive-pre-push-en](outlive-pre-push-en/SKILL.md) | Select checks; does not authorize a push / 选门禁，不授权推送 |
| Code review / 代码评审 | [outlive-code-review-zh](outlive-code-review-zh/SKILL.md) | [outlive-code-review-en](outlive-code-review-en/SKILL.md) | Evidence-backed findings / 基于证据给出发现 |
| Agent Note lifecycle / 决策记录 | [outlive-agent-note-zh](outlive-agent-note-zh/SKILL.md) | [outlive-agent-note-en](outlive-agent-note-en/SKILL.md) | Uses existing Note policy and template / 使用现有策略与模板 |
| Documentation sync / 文档同步 | [outlive-doc-sync-zh](outlive-doc-sync-zh/SKILL.md) | [outlive-doc-sync-en](outlive-doc-sync-en/SKILL.md) | Existing docs eval plus manual link/YAML checks / 现有评估加人工检查 |
| Offline performance eval / 离线性能评估 | [outlive-perf-eval-zh](outlive-perf-eval-zh/SKILL.md) | [outlive-perf-eval-en](outlive-perf-eval-en/SKILL.md) | Existing G16 fixture, not a full benchmark suite / 现有 G16 用例，非完整基准库 |
| Paired docs / 双语文档 | [outlive-translate-docs-zh](outlive-translate-docs-zh/SKILL.md) | [outlive-translate-docs-en](outlive-translate-docs-en/SKILL.md) | Human semantic comparison; no pair manifest yet / 人工语义核对，尚无配对清单 |
| Release check / 发布检查 | [outlive-release-check-zh](outlive-release-check-zh/SKILL.md) | [outlive-release-check-en](outlive-release-check-en/SKILL.md) | Private bundle checks, not publication or product proof / 私有产物检查，非发布或产品证明 |

These are initial operating manuals. Format and links are checked, but the
proposed V2 rule of two real uses has not yet been met; refine each pair after
observed use before treating its procedure as a stable governance standard.
这些是初版操作手册：格式和链接已校验，V2 提案要求的“两次真实使用”尚未完成。

## Deferred / 暂缓

- Recorded-session snapshot skill: no recording, scrubbing, or replay contract
  exists yet. / 尚无会话录制、脱敏和回放契约。
- Full benchmark skill: the G16 offline performance eval exists, but the V2
  calibrated benchmark harness does not. / 已有 G16 离线评估，尚无 V2 基准框架。
- Release-proof skill: release verification exists, but recovery/cancellation/
  evidence demos are not yet reproducible release gates. / 发布检查已存在，三类
  产品演示尚未形成可重复门禁。
- Automated docs/i18n pairing: V2 manifest and roadmap exist, but the proposed
  full docs checker, translation pair manifest, and source-digest gate do not.
  / V2 清单和路线图已存在，完整文档检查器及翻译摘要门禁尚未实现。

Do not turn a target-state design into a current capability claim. Each skill
must reference existing commands and truth sources, state its write/failure
boundary, and leave an inspectable result. Do not copy a DeepSeek Harness
command into this repository unless its implementation exists here.
不得把目标设计当作现状；不得引用本仓库不存在的 DeepSeek Harness 命令。
