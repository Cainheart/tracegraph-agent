# Final Desktop checks after the independent-Node Host correction

Recorded: 2026-10-02T23:40:13Z (2026-10-03, Asia/Shanghai). Working directory: `tracegraph-agent/`.

These commands ran against the final shared build at approximately 07:38–07:39 local time, after the root agent completed `pnpm baseline:current` and its clean build. No build or source mutation occurred during these checks. This file is a retrospective record of commands and tool-returned results observed in that run; separate raw stdout files were not captured for these commands. It does not claim to be an original terminal log, and writing this record did not repeat the tests.

| Executed command | Observed result |
| --- | --- |
| `env -u NODE_OPTIONS node --test apps/desktop/src/host-node-regression.test.mjs` | Exit 0; 1 test passed, 0 failed, 0 skipped; actual Electron-origin regression took about 2.15 seconds. |
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/desktop-host test:unit` | Exit 0; 6 test files passed, 18 tests passed. |
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/desktop-host exec vitest run src/desktop-host.e2e.test.ts` | Exit 0; 1 test file passed, 4 tests passed. This invocation runs the built-child tests without another build. |
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/desktop test:unit` | Exit 0; 4 test files passed, 12 tests passed. |
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/desktop typecheck` | Exit 0; `tsc -p tsconfig.test.json --noEmit`. |
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/desktop-host typecheck` | Exit 0; `tsc -p tsconfig.test.json --noEmit`. |

The Electron-origin regression uses a real Electron parent to launch the built private Host and verifies the selected executable is independent Node. It then uses that same Node executable for a separate isolated Runtime fixture worker, whose model decisions are synthetic. Actual public Run commands execute patch preview, approval, committed fixture changes, builtin `run_test`, and scoped test-log reads. Its assertions require a completed Run, changed fixture bytes, a test receipt, `2/2 fixture assertions passed` in the Artifact, and full macOS Seatbelt enforcement. This is separate from the final real GUI acceptance journey and does not claim the GUI itself was tested by this command.

The 18 Host unit tests include the real framed Runtime journeys and 8 focused standalone-Node resolver/launcher tests. Those negative tests cover Electron identity, unsupported versions, mismatched executable identity, malformed probes, unavailable/non-file executables, relative PATH rejection, explicit child `execPath`, and exclusion of Electron mode, preload flags and provider credentials. Core's environment allowlist and Seatbelt scope were not widened.

The native workspace-write regression explicitly skips outside macOS because the currently enabled backend is Seatbelt. The observed run was on macOS and skipped zero tests. Maintainer Agent checks and synthetic model fixtures are engineering evidence; they are not independent non-maintainer installation evidence or provider-quality evaluation.
