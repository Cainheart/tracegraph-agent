import { defineConfig } from "vitest/config";
import { BoundedEvalReporter } from "./evals/support/reporter.js";

const updateRequested = process.env.TRACEGRAPH_EVAL_UPDATE === "1"
  || process.argv.includes("--update")
  || process.argv.includes("-u");

if (updateRequested) process.env.TRACEGRAPH_EVAL_UPDATE = "1";

export default defineConfig({
  test: {
    name: "tracegraph-evals",
    environment: "node",
    env: {
      OPENAI_API_KEY: "g16-offline-guard-sentinel",
    },
    include: ["evals/**/*.eval.ts"],
    setupFiles: ["./evals/support/offline-guard.ts"],
    globalSetup: ["./evals/support/global-setup.ts"],
    reporters: ["default", new BoundedEvalReporter()],
    fileParallelism: false,
    maxWorkers: 1,
    isolate: true,
    passWithNoTests: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
