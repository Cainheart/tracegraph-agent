// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../i18n";
import type { ModelSurfaceSnapshot, TraceEvent } from "../model";
import { PUBLIC_ACTIVITY_PAGE_SIZE, PublicModelSurface } from "./WorkbenchStates";
import { Trajectory } from "./Trajectory";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.localStorage.clear(); window.localStorage.setItem("tracegraph.language", "en");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

function operation(index: number, failed = false): TraceEvent[] {
  const common = { kind: "tool" as const, operationId: `operation-${index}`, timestamp: "09:41:12", toolName: "read_file", target: `src/file-${index}.ts` };
  return [{ ...common, id: `start-${index}`, sequence: index * 2, state: "running", sourceType: "tool.started", title: "Tool started", summary: `Read file ${index}` },
    { ...common, id: `result-${index}`, sequence: index * 2 + 1, state: failed ? "failed" : "succeeded", sourceType: failed ? "tool.failed" : "tool.completed", title: failed ? "Tool failed" : "Tool completed", summary: failed ? `Permission denied for file ${index}` : `Read completed for file ${index}`, input: "PRIVATE_RAW_ARGUMENTS", output: "PRIVATE_RAW_OUTPUT" }];
}

describe("Compact public activity", () => {
  it("bounds a 2,002-event ledger, preserves earlier failure discoverability and expands exactly one operation on demand", async () => {
    const events = Array.from({ length: 1_001 }, (_, index) => operation(index, index === 0)).flat();
    const inspect = vi.fn();
    const surfaces: ModelSurfaceSnapshot[] = [{ id: "private", modelCallId: "private-call", cursor: 1, timestamp: "09:41:12", type: "thinking_snapshot", status: "completed", text: "PRIVATE_REASONING_NEVER_PUBLIC" }];
    await act(async () => root.render(<LanguageProvider><PublicModelSurface active={false} events={events} surface={surfaces} language="en" onInspectEvent={inspect} /></LanguageProvider>));
    expect(container.querySelectorAll(".public-progress-item")).toHaveLength(PUBLIC_ACTIVITY_PAGE_SIZE);
    expect(container.textContent).toContain("1 earlier failed or unknown outcomes");
    expect(container.textContent).toContain("Read completed for file 1000");
    expect(container.textContent).not.toContain("PRIVATE_REASONING_NEVER_PUBLIC");
    expect(container.textContent).not.toContain("PRIVATE_RAW_ARGUMENTS");
    expect(container.textContent).not.toContain("PRIVATE_RAW_OUTPUT");
    expect(inspect).not.toHaveBeenCalled();
    const last = [...container.querySelectorAll<HTMLDetailsElement>(".public-progress-item")].at(-1)!;
    await act(async () => { last.open = true; last.dispatchEvent(new Event("toggle", { bubbles: true })); });
    expect(last.textContent).toContain("src/file-1000.ts");
    expect(container.querySelectorAll('.public-progress-detail:not([hidden])')).toHaveLength(1);
    const evidence = [...last.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Inspect evidence"))!;
    await act(async () => evidence.click());
    expect(inspect).toHaveBeenCalledExactlyOnceWith(events.at(-1));
    expect(container.querySelector(".event-list")).toBeNull();
    const earlier = container.querySelector<HTMLButtonElement>(".public-activity-pagination button")!;
    await act(async () => earlier.click());
    expect(container.querySelectorAll(".public-progress-item")).toHaveLength(PUBLIC_ACTIVITY_PAGE_SIZE * 2);
    expect(container.textContent).toContain("1 earlier failed or unknown outcomes");
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it("keeps empty Todo/Team cards out of inline progress while preserving their actual errors", async () => {
    const props = { compactControls: true, events: operation(0), selectedId: null, tailFollowing: true, onSelect: vi.fn(), onResumeLive: vi.fn(), teamControlsDisabled: true };
    await act(async () => root.render(<LanguageProvider><Trajectory {...props} /></LanguageProvider>));
    expect(container.querySelector(".todo-panel")).toBeNull();
    expect(container.querySelector(".team-panel")).toBeNull();
    expect(container.querySelector(".event-list")).toBeNull();
    expect(container.querySelector(".trajectory-heading")).toBeNull();
    await act(async () => root.render(<LanguageProvider><Trajectory {...props} todoError="Todo revision conflict" teamError="Team request failed" /></LanguageProvider>));
    const alerts = [...container.querySelectorAll('[role="alert"]')].map((node) => node.textContent);
    expect(alerts).toEqual(["Todo revision conflict", "Team request failed"]);
    expect(container.textContent).not.toContain("No Todo items");
    expect(container.textContent).not.toContain("No durable Team");
  });

  it("keeps real Todo controls and failure details reachable without starting replay or dispatch", async () => {
    const select = vi.fn(), stateChange = vi.fn();
    await act(async () => root.render(<LanguageProvider><Trajectory compactControls events={operation(0)} selectedId={null} tailFollowing onSelect={select} onResumeLive={vi.fn()} teamControlsDisabled todos={[{ todo_id: "todo-1", title: "Check login", state: "blocked", depends_on: [], evidence_event_ids: ["result-0"], created_by: "model" }]} onTodoStateChange={stateChange} /></LanguageProvider>));
    expect(container.querySelector(".todo-panel")).not.toBeNull();
    expect(container.textContent).toContain("Check login");
    expect(container.querySelector(".event-list")).toBeNull();
    expect(select).not.toHaveBeenCalled();
    expect(stateChange).not.toHaveBeenCalled();
  });
});
