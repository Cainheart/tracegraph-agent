import { defineConfig } from "vitest/config";

const productionSources = [
  "apps/*/src/**/*.{ts,tsx}",
  "packages/*/src/**/*.{ts,tsx}",
];

const nonProductionSources = [
  "**/*.d.ts",
  "**/*.test.{ts,tsx}",
  "**/*.spec.{ts,tsx}",
];

export default defineConfig({
  test: {
    name: "tracegraph-coverage",
    environment: "node",
    include: [
      "apps/*/src/**/*.test.{ts,tsx}",
      "apps/*/tests/**/*.test.{ts,tsx}",
      "packages/*/src/**/*.test.{ts,tsx}",
      "packages/*/tests/**/*.test.{ts,tsx}",
      "scripts/check-coverage.test.ts",
    ],
    exclude: ["apps/cli/src/e2e.test.ts"],
    isolate: true,
    passWithNoTests: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      enabled: true,
      provider: "v8",
      clean: true,
      reportOnFailure: true,
      reportsDirectory: "coverage",
      include: productionSources,
      exclude: nonProductionSources,
      reporter: [
        ["text", { skipFull: true }],
        ["json", { file: "coverage-final.json" }],
        ["json-summary", { file: "coverage-summary.json" }],
      ],
      // These native thresholds provide an early, defense-in-depth failure.
      // scripts/check-coverage.mjs independently rediscovers every production
      // source and recomputes the gates from raw per-file line counts.
      thresholds: {
        lines: 70,
        "packages/contracts/src/**/*.ts": { lines: 90 },
        "packages/core/src/context.ts": { lines: 90 },
        "packages/core/src/policy*.ts": { lines: 90 },
      },
    },
  },
});
