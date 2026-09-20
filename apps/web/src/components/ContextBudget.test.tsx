import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../i18n";
import type { ContextArchiveLoadResult, ContextBudgetSnapshot, ContextSource } from "../model";
import { ContextBudget, loadContextArchiveOnOpen } from "./ContextBudget";

describe("ContextBudget", () => {
  it("renders an archived Context source behind an explicit disclosure", () => {
    const html = renderToStaticMarkup(<LanguageProvider><ContextBudget
      limit={1_024}
      reservedOutput={256}
      sources={[{
        itemId: "item:spill-1",
        name: "Spilled tool output",
        tokens: 24,
        originalTokens: 4_000,
        action: "externalized",
        reason: "spill_ref",
        color: "#4e9bea",
        archive: {
          artifactId: "artifact:spill-1",
          locator: "artifact:spill-1",
          status: "available",
          message: "verified",
          content: "archived exact source",
        },
      }]}
      used={24}
    /></LanguageProvider>);

    expect(html).toContain("View compressed source");
    expect(html).toContain("artifact:spill-1");
    expect(html).toContain("archived exact source");
  });

  it("loads an archived source only after its disclosure opens and then renders it", async () => {
    const source: ContextSource = {
      itemId: "item:lazy-archive",
      name: "Repeated source",
      tokens: 24,
      action: "externalized",
      reason: "spill_ref",
      color: "#4e9bea",
      archive: {
        artifactId: "artifact:lazy-archive",
        locator: "artifact:artifact:lazy-archive",
        status: "idle",
        message: "Open to load the archived Context source.",
      },
    };
    const load = vi.fn(async (): Promise<ContextArchiveLoadResult> => ({
      status: "available",
      message: "verified",
      content: "loaded only on demand",
    }));
    const initialHtml = renderToStaticMarkup(<LanguageProvider><ContextBudget
      limit={1_024}
      onLoadArchive={load}
      reservedOutput={256}
      sources={[source]}
      used={24}
    /></LanguageProvider>);

    expect(load).not.toHaveBeenCalled();
    expect(initialHtml).not.toContain("loaded only on demand");

    let result: ContextArchiveLoadResult | undefined;
    await loadContextArchiveOnOpen({
      open: false,
      artifactId: source.archive!.artifactId,
      load,
      update: (next) => { result = next; },
    });
    expect(load).not.toHaveBeenCalled();
    await loadContextArchiveOnOpen({
      open: true,
      artifactId: source.archive!.artifactId,
      load,
      update: (next) => { result = next; },
    });

    expect(load).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledWith("artifact:lazy-archive");
    const loadedHtml = renderToStaticMarkup(<LanguageProvider><ContextBudget
      limit={1_024}
      reservedOutput={256}
      sources={[{ ...source, archive: { ...source.archive!, ...result! } }]}
      used={24}
    /></LanguageProvider>);
    expect(loadedHtml).toContain("loaded only on demand");
  });

  it("uses stable item ids when display labels repeat", () => {
    const html = renderToStaticMarkup(<LanguageProvider><ContextBudget
      limit={1_024}
      reservedOutput={256}
      sources={[
        { itemId: "item:duplicate-a", name: "Duplicate label", tokens: 10, action: "kept", reason: "first", color: "#4e9bea" },
        { itemId: "item:duplicate-b", name: "Duplicate label", tokens: 12, action: "kept", reason: "second", color: "#48bfa5" },
      ]}
      used={22}
    /></LanguageProvider>);

    expect(html).toContain('data-context-item-id="item:duplicate-a"');
    expect(html).toContain('data-context-item-id="item:duplicate-b"');
    expect(html.match(/Duplicate label/gu)).toHaveLength(6);
  });

  it("renders retrieved memory from the real Context sources without a planned placeholder", () => {
    const html = renderToStaticMarkup(<LanguageProvider><ContextBudget
      limit={1_024}
      reservedOutput={256}
      sources={[{
        itemId: "memory:chunk-guide",
        name: "Retrieved memory · docs/guide.md:12-18",
        tokens: 42,
        action: "retrieved",
        reason: "retrieval_hit",
        color: "#9b8cff",
      }]}
      used={42}
    /></LanguageProvider>);

    expect(html).toContain("Retrieved memory · docs/guide.md:12-18");
    expect(html).toContain("retrieved");
    expect(html).not.toContain("Memory retrieval planned");
  });

  it("labels preflight estimates separately from provider reports and unavailable cost", () => {
    const estimate: NonNullable<ContextBudgetSnapshot["estimate"]> = {
      estimatorId: "heuristic:anthropic:model:r1",
      confidence: "estimated",
      inputTokens: 600,
      outputTokens: 256,
      perSection: { system: 100, goal: 100, history: 100, tool: 100, repo: 200, memory: 0 },
    };
    const providerUsage: NonNullable<ContextBudgetSnapshot["providerUsage"]> = {
      modelCallId: "model_call_context_budget",
      provider: "anthropic",
      model: "model",
      inputTokens: 610,
      outputTokens: 90,
      totalTokens: 700,
      requestKind: "initial",
      requestSequence: 1,
      cost: { status: "unavailable" },
      anomaly: false,
    };
    const html = renderToStaticMarkup(<LanguageProvider><ContextBudget
      estimate={estimate}
      estimator="heuristic_v2"
      limit={1_024}
      providerUsage={providerUsage}
      reservedOutput={256}
      sources={[]}
      used={600}
    /></LanguageProvider>);

    expect(html).toContain("Budget estimate");
    expect(html).toContain("Estimated");
    expect(html).toContain("heuristic:anthropic:model:r1");
    expect(html).toContain("Provider reported usage");
    expect(html).toContain("anthropic · model");
    expect(html).toContain("Cost unavailable");
    expect(html).not.toContain("Usage anomaly");
  });
});
