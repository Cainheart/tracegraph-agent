// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatProcess, TurnFailure, UserMessageText } from "./ChatProcess";
import { LanguageProvider } from "../i18n";
import type { TraceEvent } from "../model";
import type { WorkbenchClient } from "../client";
let root: Root, node: HTMLDivElement;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); localStorage.setItem("tracegraph.language", "zh-CN"); node = document.createElement("div"); document.body.append(node); root = createRoot(node); });
afterEach(async () => { await act(async () => root.unmount()); node.remove(); });
const events: TraceEvent[] = [
  { id: "internal", sequence: 1, kind: "run", state: "succeeded", title: "Run created", summary: "PRIVATE_INTERNAL_DIAGNOSTIC", timestamp: "12:00", sourceType: "run.created" },
  { id: "plan", sequence: 2, kind: "decision", state: "succeeded", title: "Decision", summary: "PRIVATE_SUMMARY", publicPlan: "我会先检查入口文件。", timestamp: "12:00", sourceType: "model.decision", operationId: "call" },
  { id: "read", sequence: 3, kind: "tool", state: "succeeded", title: "Read", summary: "PRIVATE_SUMMARY", timestamp: "12:00", sourceType: "tool.completed", operationId: "read", toolName: "read_file", target: "src/main.ts", input: "PRIVATE_ARGUMENTS", output: "PRIVATE_OUTPUT" },
];
function render(active: boolean, extra: TraceEvent[] = []) { return <LanguageProvider><ChatProcess events={[...events, ...extra]} plans={[]} active={active} elapsed="00:12" onInspectEvent={vi.fn()} /></LanguageProvider>; }
describe("reference chat process", () => {
  it("defaults terminal history closed; explicitly opening survives a new fact", async () => {
    await act(async () => root.render(render(false)));
    expect(node.textContent).toContain("用时 00:12"); expect(node.textContent).not.toContain("我会先检查入口文件");
    const button = node.querySelector<HTMLButtonElement>("button")!;
    await act(async () => button.click());
    expect(node.querySelectorAll(".chat-public-statement")).toHaveLength(1);
    expect(node.textContent).not.toContain("src/main.ts");
    await act(async () => root.render(render(false, [{ ...events[2]!, id: "read2", sequence: 4, operationId: "read2" }])));
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(node.querySelectorAll(".chat-operation-group")).toHaveLength(1);
    expect(node.textContent).not.toMatch(/PRIVATE_/);
  });
  it("shows statement then one collapsed operation group, and explicit closure survives completion", async () => {
    await act(async () => root.render(render(true)));
    expect(node.querySelector(".chat-public-statement")?.textContent).toContain("我会先检查入口文件");
    const group = node.querySelector<HTMLDetailsElement>(".chat-operation-group")!;
    expect(group.open).toBe(false);
    await act(async () => group.querySelector("summary")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(group.open).toBe(true);
    expect(node.textContent).toContain("src/main.ts"); expect(node.textContent).not.toMatch(/PRIVATE_/);
    await act(async () => root.render(render(false)));
    expect(node.querySelector(".chat-process-body")).toBeNull();
  });
  it("keeps Chinese timeout explanation separate from diagnostic text and does not execute anything", async () => {
    const inspect = vi.fn();
    await act(async () => root.render(<LanguageProvider><TurnFailure status="failed" message="UND_ERR_CONNECT_TIMEOUT" onInspect={inspect} /></LanguageProvider>));
    expect(node.querySelector('[role="alert"]')?.textContent).toContain("连接模型服务超时");
    expect(node.querySelector("pre")?.textContent).toBe("UND_ERR_CONNECT_TIMEOUT"); expect(inspect).not.toHaveBeenCalled();
  });
  it("explains a legacy budget stop without claiming that the user cancelled it", async () => {
    await act(async () => root.render(<LanguageProvider><TurnFailure status="cancelled" message="Goal budget stopped" /></LanguageProvider>));
    expect(node.querySelector('[role="alert"]')?.textContent).toContain("预算已停止");
    expect(node.querySelector('[role="alert"]')?.textContent).not.toContain("停止请求已记录");
    await act(async () => root.render(<LanguageProvider><TurnFailure status="cancelled" message="Run token budget cannot fit the next model request" /></LanguageProvider>));
    expect(node.querySelector('[role="alert"]')?.textContent).toContain("本轮剩余 Token 预算不足以容纳下一次模型请求");
  });
  it("keeps a long message intact while letting the user explicitly expand it", async () => {
    const text = "完整需求，包含原始换行。\n".repeat(100);
    await act(async () => root.render(<LanguageProvider><UserMessageText text={text} /></LanguageProvider>));
    expect(node.querySelector("p")?.textContent).toBe(text); expect(node.querySelector("p")?.classList.contains("is-collapsed")).toBe(true);
    await act(async () => node.querySelector<HTMLButtonElement>("button")!.click());
    expect(node.querySelector("p")?.classList.contains("is-collapsed")).toBe(false);
  });
  it("opens each real command receipt and loads only its referenced, bounded output", async () => {
    const command: TraceEvent = { id: "command", sequence: 4, kind: "tool", state: "succeeded", title: "Command complete", summary: "PRIVATE_TOOL_SUMMARY", timestamp: "12:01", sourceType: "tool.completed", operationId: "command-call", toolName: "run_project_command", target: "outlive.commands.json", commandName: "pnpm test", exitCode: 0, receiptCode: "project_command_passed", outputArtifactIds: ["artifact:output"] };
    const client = { loadCommandOutput: vi.fn(async () => ({ content: "PASS suite\n[redacted]", sha256: "sha256:recorded", byteLength: 24, truncated: false })) } as unknown as WorkbenchClient;
    await act(async () => root.render(<LanguageProvider><ChatProcess events={[...events, command]} plans={[]} active onInspectEvent={vi.fn()} runId="run-1" client={client} /></LanguageProvider>));
    const group = node.querySelector<HTMLDetailsElement>(".chat-operation-group")!;
    expect(group.open).toBe(false);
    await act(async () => group.querySelector("summary")!.click());
    const item = [...node.querySelectorAll<HTMLElement>(".chat-operation")].find((candidate) => candidate.querySelector(".chat-operation-toggle")?.textContent?.includes("运行项目命令"))!;
    await act(async () => { item.querySelector<HTMLButtonElement>(".chat-operation-toggle")!.click(); await Promise.resolve(); });
    expect(client.loadCommandOutput).toHaveBeenCalledWith("run-1", "command", "artifact:output");
    expect(node.textContent).toContain("pnpm test"); expect(node.textContent).toContain("outlive.commands.json");
    expect(node.textContent).toContain("PASS suite"); expect(node.textContent).not.toContain("PRIVATE_TOOL_SUMMARY");
    expect(node.querySelector(".chat-command-output pre")?.textContent).toContain("[redacted]");
    expect(node.querySelector(".chat-command-output")?.textContent).toContain("sha256:recorded");
  });
  it("shows the full project path accessibly and opens it through the workbench callback", async () => {
    const openFile = vi.fn();
    await act(async () => root.render(<LanguageProvider><ChatProcess events={events} plans={[]} active onInspectEvent={vi.fn()} onOpenProjectFile={openFile} /></LanguageProvider>));
    const group = node.querySelector<HTMLDetailsElement>(".chat-operation-group")!;
    expect(group.open).toBe(false);
    await act(async () => group.querySelector("summary")!.click());
    const path = node.querySelector<HTMLButtonElement>(".chat-project-path")!;
    expect(path.title).toBe("src/main.ts");
    expect(path.getAttribute("aria-label")).toContain("src/main.ts");
    await act(async () => path.click());
    expect(openFile).toHaveBeenCalledWith("src/main.ts");
  });
  it("keeps an in-progress operation expanded with a live status and its actual target", async () => {
    const started: TraceEvent = { id: "read-started", sequence: 4, kind: "tool", state: "running", title: "Read started", summary: "PRIVATE_SUMMARY", timestamp: "12:00:00", sourceType: "tool.started", operationId: "read", toolName: "read_file", target: "src/main.ts" };
    await act(async () => root.render(<LanguageProvider><ChatProcess events={[...events, started]} plans={[]} active /></LanguageProvider>));
    expect(node.querySelector<HTMLDetailsElement>(".chat-operation-group")?.open).toBe(true);
    expect(node.textContent).toContain("进行中");
    expect(node.textContent).toContain("src/main.ts");
    expect(node.textContent).not.toContain("PRIVATE_SUMMARY");
  });
  it("marks a running group and operation with the live affordances that animate the row", async () => {
    const started: TraceEvent = { id: "read-started", sequence: 4, kind: "tool", state: "running", title: "Read started", summary: "PRIVATE_SUMMARY", timestamp: "12:00:00", sourceType: "tool.started", operationId: "read", toolName: "read_file", target: "src/main.ts" };
    const done: TraceEvent = { ...events[2]!, id: "search-done", sequence: 5, operationId: "search", toolName: "search", target: "src" };
    await act(async () => root.render(<LanguageProvider><ChatProcess events={[...events, started, done]} plans={[]} active /></LanguageProvider>));
    const group = node.querySelector<HTMLDetailsElement>(".chat-operation-group")!;
    expect(group.classList.contains("is-running")).toBe(true);
    // The group row itself carries the spinner and the explicit running state,
    // because that row is what a reader sees while a tool executes.
    expect(group.querySelector("summary > .chat-operation-spinner")).not.toBeNull();
    expect(group.querySelector("summary > .chat-running-state")?.textContent).toBe("运行中");
    const running = node.querySelector<HTMLElement>(".chat-operation.is-running")!;
    expect(running.querySelector(".chat-operation-label")).not.toBeNull();
    expect(running.querySelector(".chat-operation-toggle .chat-operation-spinner")).not.toBeNull();
    expect(running.querySelector(".chat-operation-status.is-running .chat-running-dot")).not.toBeNull();
    // A completed operation never keeps the live markers.
    const completed = [...node.querySelectorAll<HTMLElement>(".chat-operation.is-completed")];
    expect(completed.length).toBeGreaterThan(0);
    expect(completed.every((item) => item.querySelector(".chat-running-dot") === null)).toBe(true);
  });
  it("ships the running animation rules in the workbench stylesheet", async () => {
    const css = await readFile(resolve(process.cwd(), "src/workbench.css"), "utf8");
    for (const marker of ["@keyframes chat-activity-spin", "@keyframes chat-activity-sweep", "@keyframes chat-activity-breathe",
      ".chat-operation.is-running .chat-operation-label", ".chat-operation-group.is-running > summary > span", "prefers-reduced-motion: reduce"]) {
      expect(css).toContain(marker);
    }
  });
});
