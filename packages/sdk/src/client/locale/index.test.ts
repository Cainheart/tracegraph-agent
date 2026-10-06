import { describe, expect, it } from "vitest";
import { createTranslator, localeCatalogs, localeKeys, resolveLocale, terminalLocale, translate } from "./index.js";

describe("shared client locale contract", () => {
  it("keeps explicit model tests and uncertain receipts understandable without overstating compatibility", () => {
    for (const key of ["Test model capabilities", "Native tool calling", "Image input", "Schema-constrained output", "Inspect previous test", "Provider usage"]) expect(translate("zh-CN", key)).toMatch(/[\u4e00-\u9fff]/u);
    expect(translate("zh-CN", "These small probes check one exact model and configuration. A passing fixture does not guarantee general quality or grant tool permissions. Image declarations remain unchanged.")).toContain("不代表通用质量");
    expect(translate("zh-CN", "The test receipt is uncertain. Inspect the original command; it will not be repeated automatically.")).toContain("不会自动重发");
    expect(translate("zh-CN", "Schema-constrained testing is not implemented for Anthropic Messages in this version. Text, native tool and image tests are available.")).toContain("尚未实现");
    expect(translate("en", "Test model capabilities")).toBe("Test model capabilities");
    expect(translate("zh-CN", "model_probe_passed")).toBe("model_probe_passed");
  });
  it("keeps new Skill templates and known effect statuses readable without translating protocol fields",()=>{
    expect(translate("zh-CN","Describe when to use this Skill")).toBe("说明何时使用此技能");
    expect(translate("zh-CN","Write the local Skill instructions here.")).toBe("在这里编写本地技能的使用说明。");
    expect(translate("zh-CN","Skill change completed.")).toBe("技能变更已完成。");
    expect(translate("en","Write the local Skill instructions here.")).toBe("Write the local Skill instructions here.");
    expect(translate("zh-CN","Enabling…")).toBe("正在启用…");expect(translate("zh-CN","allowed_tools")).toBe("allowed_tools");
  });
  it("labels live answer drafts as unverified in both client locales", () => {
    expect(translate("en", "Answer draft — not verified")).toBe("Answer draft — not verified");
    expect(translate("zh-CN", "Answer draft — not verified")).toBe("回答草稿 · 尚未核验");
  });
  it("keeps screenshot scope, zero-deletion and unknown receipts distinct in Chinese",()=>{
    for(const key of ["Screenshots and visual evidence","Review screenshot cleanup scope","Inspect original screenshot command","Retain and clean screenshots","Built-in artifact tools","Built-in task status tools"])expect(translate("zh-CN",key)).toMatch(/[\u4e00-\u9fff]/u);
    expect(translate("zh-CN","The cleanup receipt reports no screenshots deleted.")).toContain("没有记录截图删除");
    expect(translate("zh-CN","No registered screenshots were found in this scope. This is not a cleanup receipt.")).toContain("不代表进行过清理");
    expect(translate("zh-CN","No settled screenshot receipt was found. Observed bytes do not prove cleanup completed.")).toContain("不证明清理已完成");
    expect(translate("zh-CN","Your current permissions allow viewing screenshots but not cleaning them up.")).toContain("不允许清理");
    expect(translate("zh-CN","Pinned screenshot")).toBe("固定保留截图");
    expect(translate("zh-CN","Screenshot deleted")).toBe("已删除截图");
  });
  it("explains scoped Skill removal, uncertain receipts and permission timing in product language",()=>{
    for(const key of ["Manage local Skills","Approve Skill change","Inspect Skill command result","Import local SKILL.md"])expect(translate("zh-CN",key)).toMatch(/[\u4e00-\u9fff]/u);
    expect(translate("zh-CN","Remove from loaded Skills (keep file)")).toContain("保留文件");
    expect(translate("zh-CN","No completed Skill receipt was found. Observed file hashes do not prove that the command completed.")).toContain("不代表命令已经完成");
    expect(translate("zh-CN","Changes apply to future tasks. Current tasks keep their recorded permissions.")).toContain("当前任务保留");
    expect(translate("zh-CN","Outlive Agent limits file and command operations according to your permission preset.")).not.toMatch(/Host|Runtime/u);
  });
  it("uses identical complete keys for Web, Desktop and terminal clients", () => {
    expect(localeKeys.length).toBeGreaterThan(300);
    expect(Object.keys(localeCatalogs.en)).toEqual(Object.keys(localeCatalogs["zh-CN"]));
    for (const locale of ["en", "zh-CN"] as const) {
      const web = createTranslator(locale);
      const desktop = createTranslator(locale);
      const terminal = createTranslator(terminalLocale({ TRACEGRAPH_LOCALE: locale }));
      for (const key of localeKeys) {
        expect(web(key)).toBe(desktop(key));
        expect(web(key)).toBe(terminal(key));
        expect(web(key).trim().length).toBeGreaterThan(0);
      }
    }
  });
  it("falls back without changing wire values, model text or prototype keys", () => {
    expect(translate("fr-FR", "Settings")).toBe("Settings");
    expect(translate("zh_CN.UTF-8", "Settings")).toBe("设置");
    for (const value of ["run.completed", "user supplied text", "constructor", "__proto__"]) {
      expect(translate("zh-CN", value)).toBe(value);
    }
    expect(resolveLocale(undefined)).toBe("en");
    expect(resolveLocale("C.UTF-8")).toBe("en");
  });
  it("honors explicit locale before POSIX environment and preserves missing placeholders", () => {
    expect(terminalLocale({ TRACEGRAPH_LOCALE: "en", LC_ALL: "zh_CN.UTF-8" })).toBe("en");
    expect(terminalLocale({ LC_MESSAGES: "zh_CN.UTF-8", LANG: "en_US" })).toBe("zh-CN");
    expect(translate("en", "{count} items for {name}", { count: 3 })).toBe("3 items for {name}");
    expect(translate("en", "{value}", { value: "$& <unsafe>" })).toBe("$& <unsafe>");
  });
  it("localizes product settings and native authority states without claiming unknown or posted input is completed work", () => {
    const pageLabels = ["General", "Profile", "Keyboard shortcuts", "Notifications", "Appearance", "Personalization", "Models", "Permissions", "Browser", "Computer", "Memory and privacy", "Development environment", "Git", "Skills and extensions", "MCP and LSP", "Tasks and Agents", "Usage and diagnostics", "Archive", "About and updates"];
    const actions = ["Load settings history", "Restore this revision", "Save project defaults", "Reset to inherited", "Add MCP server", "Request browser permission", "Request application permission", "Request input control", "Release input control", "Inspect original browser action", "Inspect original computer command", "Inspect original Goal command"];
    for (const key of [...pageLabels, ...actions]) expect(translate("zh-CN", key)).toMatch(/[\u4e00-\u9fff]/u);
    expect(translate("zh-CN", "Native input was posted. Observe the application to verify the result.")).toBe("输入已发送，请再次观察应用以核验结果。");
    expect(translate("zh-CN", "Native input has an unknown outcome. Observe external state and inspect the original receipt; it was not repeated.")).toContain("未重复发送");
    expect(translate("zh-CN", "Computer capture does not match its verified Artifact.")).toContain("不一致");
    expect(translate("zh-CN", "Allow Accessibility for the Outlive Agent helper in system privacy settings, then refresh.")).toContain("Outlive Agent 辅助程序");
    expect(translate("zh-CN", "Allow Input Monitoring for the Outlive Agent helper. Input control stays paused until user input can be detected.")).toContain("保持暂停");
    expect(translate("zh-CN", "Allow Screen Recording for the Outlive Agent helper before requesting window pixels. Text observation can work separately.")).toContain("可单独使用");
    expect(translate("zh-CN", "This Goal command has an unknown outcome. Refresh and inspect its original state before any further write. It was not repeated.")).toContain("未重复执行");
    for (const key of ["Reconnect to inspect Goals. Work is never resumed automatically by opening this page.", "Reconnect to inspect computer access. Input is never resumed automatically.", "Browser runtime diagnostics", "Computer availability has not been confirmed. Inspect installation diagnostics; ordinary chat remains available."]) expect(translate("zh-CN", key)).not.toMatch(/Host|Runtime/u);
    expect(translate("zh-CN", "Remote HTTPS")).toContain("HTTPS");
    expect(translate("zh-CN", "MCP and LSP")).toMatch(/MCP.*LSP/u);
  });
  it("keeps local profile, partial usage and public search limitations explicit in Chinese", () => {
    for (const key of ["Search public history", "Save profile", "Continue usage scan", "Keep this computer awake during active tasks", "Profile display name", "History search archive"]) expect(translate("zh-CN", key)).toMatch(/[\u4e00-\u9fff]/u);
    expect(translate("zh-CN", "Your name and bio stay on this device. They are not added to model prompts.")).toContain("不会加入模型提示词");
    expect(translate("zh-CN", "No recorded bucket was returned for this day. It is not treated as zero usage.")).toContain("不会将其当作零用量");
    expect(translate("zh-CN", "Observed profile is not a completed receipt")).toContain("不等于更新成功");
    expect(translate("zh-CN", "Results follow the saved inventory scan order; they are not a global relevance ranking.")).toContain("并非全局相关度排名");
    expect(translate("zh-CN", "The original profile update has a verified receipt. It was not repeated.")).toContain("未重复保存");
  });
  it("translates help navigation and actual browser, Goal and native recovery guidance", () => {
    for (const key of ["How to use", "Limits and recovery", "Control a native application", "Run a finite Goal", "Run real project checks", "Use an isolated browser", "Use background tasks and notifications", "Manage your local profile"]) expect(translate("zh-CN", key)).toMatch(/[\u4e00-\u9fff]/u);
    expect(translate("zh-CN", "Take over to pause Agent actions; return control explicitly or revoke the grant.")).toContain("明确交还");
    expect(translate("zh-CN", "A task finish does not accept the Goal. Unknown command or creation results require read-only inspection of the original command; opening this page never resumes work.")).toContain("不会自动续接");
    expect(translate("zh-CN", "Posted input only confirms delivery, not business success. Unknown input must be observed and reconciled. Native Windows and platform permissions require their own actual acceptance; file Full access never substitutes for them.")).toContain("不等于业务成功");
    expect(translate("zh-CN", "Open browser controls")).toBe("打开浏览器面板");
    expect(translate("zh-CN", "Select a project, expand Browser permissions and confirm the exact website origin in Desktop. Opening the panel does not request permission or open a tab.")).toContain("打开面板不会申请授权");
    expect(translate("zh-CN", "Take control pauses Agent actions; it does not open a visible browser window for manual input. This isolated browser shows verified snapshots and elements. Existing Chrome tabs and visible manual takeover are not available here; inspect unknown actions without repeating them.")).toContain("不会打开可人工输入");
    expect(translate("zh-CN", "A connection test sends one small text request using the saved default model. It does not test tools, image input, structured output or task quality.")).toContain("不测试工具调用");
  });
  it("separates personal identity from technical profile inheritance and translates composer mode labels", () => {
    expect(translate("zh-CN", "Personal profile")).toBe("个人资料");
    expect(translate("zh-CN", "Profile")).toBe("本地配置档案");
    expect(translate("zh-CN", "Inherit from profile")).toBe("继承本机默认设置");
    expect(translate("zh-CN", "Profile defaults are inherited unless a project or conversation explicitly overrides them. Running tasks keep their admitted settings.")).toContain("继承本机配置");
    expect(translate("zh-CN", "Model connection")).toBe("模型连接");
    expect(translate("zh-CN", "Conversation overrides")).toBe("对话覆盖设置");
    expect(translate("zh-CN", "Plan")).toBe("计划");
    expect(translate("zh-CN", "Local user")).toBe("本机用户");
  });
  it("localizes developer controls and keeps project selection distinct from connection and policy limitations", () => {
    for (const key of ["Developer panel", "Close panel", "Workspace", "Artifacts"]) expect(translate("zh-CN", key)).toMatch(/[\u4e00-\u9fff]/u);
    expect(translate("zh-CN", "Project preview")).toBe("项目预览");
    expect(translate("zh-CN", "Preview")).toBe("演示预览");
    expect(translate("zh-CN", "Choose a project first")).toBe("请先选择项目");
    expect(translate("zh-CN", "Reconnect to manage workspace resources.")).toContain("恢复连接");
    expect(translate("zh-CN", "Current permissions do not allow this workspace action.")).toContain("权限");
    expect(translate("zh-CN", "Configure this feature in Settings before using it.")).toContain("配置");
    expect(translate("zh-CN", "Workspace resources could not be verified. Refresh or repair the connection before trying again.")).toContain("核验");
    expect(translate("zh-CN", "Saved")).toBe("已保存");
    expect(translate("zh-CN", "Execute")).toBe("执行");
    expect(translate("zh-CN", "This task did not record file changes.")).toBe("这次任务没有记录文件变更。");
    expect(translate("zh-CN", "This task did not record test results.")).toBe("这次任务没有测试记录。");
  });
});
