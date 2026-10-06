// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryCandidateCreateRequest, MemoryControlItem } from "@tracegraph/contracts";
import { MemoryControlPanel } from "./MemoryControlPanel";
import { LanguageProvider } from "../i18n";

let root: Root;
let node: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.setItem("tracegraph.language", "en");
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); });

const item = {} as MemoryControlItem;
type CandidateInput = Omit<MemoryCandidateCreateRequest, "command_id">;
function panel(onCreate: (input: CandidateInput) => Promise<MemoryControlItem>, initialDraft: { claim: string; sourceDescription: string } | null = null) {
  return (
    <LanguageProvider>
      <MemoryControlPanel
        page={true} online={true} readable={true} writable={true} experienceWritable={true}
        initialDraft={initialDraft} memoryRecall={false} experienceRecall={false} onClose={vi.fn()}
        onList={async () => ({ items: [], conflicts: [], backgroundJobs: [] })}
        onCreate={onCreate} onReview={async () => item} onCorrect={async () => item}
        onRevoke={async () => item} onDelete={async () => ({ deletedMemoryIds: [] })}
        onListExperiences={async () => ({ items: [] })}
        onReviewExperience={async () => ({ case: {} as never, lifecycleSequence: 1, replayed: false })}
      />
    </LanguageProvider>
  );
}

describe("memory overview and answer candidate draft", () => {
  it("explains recall consent and reports counts from loaded records", async () => {
    await act(async () => { root.render(panel(vi.fn())); await Promise.resolve(); });
    expect(node.textContent).toContain("Memory recall"); expect(node.textContent).toContain("Off");
    expect(node.textContent).toContain("Creating a candidate does not approve it");
    expect([...node.querySelectorAll(".memory-overview-card strong")].map((element) => element.textContent)).toEqual(["0", "0", "0", "0"]);
  });

  it("prefills an editable source-linked draft and creates a candidate without enabling recall", async () => {
    const create = vi.fn(async (_input: CandidateInput) => item);
    await act(async () => { root.render(panel(create, { claim: "The user prefers a compact command summary.", sourceDescription: "From Run run-7 final answer event event-8" })); await Promise.resolve(); });
    const fields = node.querySelectorAll<HTMLTextAreaElement>(".memory-candidate-form textarea");
    expect(fields[0]?.value).toBe("The user prefers a compact command summary.");
    expect(fields[1]?.value).toContain("Run run-7");
    await act(async () => { node.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ claim: "The user prefers a compact command summary.", source_description: "From Run run-7 final answer event event-8", allow_model_use: false, allow_export: false }));
  });
});
