import { DecisionSchema, type Decision } from "@tracegraph/contracts";
import { defaultIdFactory } from "./crypto.js";
import type { ModelAdapter, ModelInput, ModelObservation } from "./types.js";

export class DeterministicFakeModel implements ModelAdapter {
  readonly name = "deterministic-fake-model";
  readonly #idFactory: (prefix: string) => string;

  constructor(options: { idFactory?: (prefix: string) => string } = {}) {
    this.#idFactory = options.idFactory ?? defaultIdFactory;
  }

  async decide(input: ModelInput): Promise<Decision> {
    const last = input.observations.at(-1);
    if (last === undefined) {
      return this.#tool("search", { pattern: "return left - right;" }, "Locate the deterministic fixture defect.", "low");
    }
    const toolName = readString(last, "tool_name");
    if (toolName === "search") {
      const path = readString(last, "first_match_path") ?? "src/add.ts";
      return this.#tool("read_file", { path }, "Read the matched source before proposing a change.", "low");
    }
    if (toolName === "read_file") {
      const excerpt = readString(last, "content_excerpt");
      if (!excerpt?.includes("return left - right;")) {
        return this.#finish(
          "The expected fixture defect was not present in the bounded read evidence, so no patch was proposed.",
        );
      }
      if (input.mode === "plan") {
        return this.#finish("The defect is in src/add.ts; plan mode did not modify the workspace.");
      }
      return this.#tool(
        "preview_patch",
        { path: readString(last, "path") ?? "src/add.ts", expected: "return left - right;", replacement: "return left + right;" },
        "Replace subtraction with addition and request approval for the exact diff.",
        "high",
      );
    }
    if (toolName === "commit_patch") {
      return this.#tool("run_test", { suite: "fixture" }, "Verify the approved patch with the registered fixture test.", "medium");
    }
    if (toolName === "run_test" && last.status === "success") {
      return this.#finish("The isolated fixture was patched and its registered tests passed.");
    }
    return this.#finish(`Stopped after ${last.summary}`);
  }

  #tool(
    toolName: "search" | "read_file" | "preview_patch" | "run_test",
    arguments_: Record<string, unknown>,
    reason: string,
    risk: "low" | "medium" | "high",
  ): Decision {
    return DecisionSchema.parse({
      decision_id: this.#idFactory("decision"),
      kind: "tool_call",
      public_reason: reason,
      evidence_refs: [],
      risk,
      expected_effect: reason,
      tool_call: {
        action_id: this.#idFactory("action"),
        tool_name: toolName,
        arguments: arguments_,
      },
    });
  }

  #finish(answer: string): Decision {
    return DecisionSchema.parse({
      decision_id: this.#idFactory("decision"),
      kind: "finish",
      public_reason: "The available observation is sufficient to stop.",
      evidence_refs: [],
      risk: "none",
      final_answer: answer,
    });
  }
}

function readString(observation: ModelObservation, key: string): string | undefined {
  const value = observation.facts[key];
  return typeof value === "string" ? value : undefined;
}
