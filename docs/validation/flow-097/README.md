# FLOW-097 core slice: Plan intent and existing project commands

This receipt covers the core slice implemented on 2026-10-05. FLOW-097 remains partial: end-to-end software development, complete Goal workflow, native verification, and final user acceptance are separate obligations. The later [GOAL-099 controller/budget slice](../goal-099/README.md) verifies shared request admission and human continuation without claiming those broader outcomes. All process proofs here use controlled temporary projects and deterministic model adapters; no paid model quality claim is made.

Ordinary Plan answers now complete with a canonical `run.completed` Event. `Decision.finish_intent=submit_plan` requires canonical Todos and produces `plan.ready`, retaining the exact revision approval boundary. Omitted intent remains an answer for compatibility; even a legacy answer with pending Todos does not execute them or mark them complete. Queued input and cancellation retain priority. An explicit submission outside Plan fails, and write/command Tools remain blocked in Plan.

`discover_project_commands` reads existing `package.json` scripts or the strict `outlive.commands.json` format. Discovery is paged, bounded to a 64 KiB manifest, never executes, and returns command names plus exact manifest hashes. `run_project_command` accepts only the relative source path, command name, expected hash, and a 100..120000 ms timeout. A changed manifest, symlink/hardlink, escaping working directory, unavailable runtime, or unknown command fails closed. It cannot receive model-authored shell/env/argv. Declared executable names are closed; Node uses the actual Runtime executable and other runtimes must already be available outside the project in the Host PATH.

Actual process stdout/stderr and exit become a bounded, redacted JSON Artifact linked by the canonical Receipt and Observation. Nonzero, timeout, cancellation, and output limit are failures; a dispatched runner error remains unknown and stops further model/command attempts. The later [finite delivery-review slice](../delivery-review/README.md) allows trusted budgeted root software Runs to inspect and repair a settled POSIX-quiescent nonzero verification failure; it never automatically retries a command. Other failures, children and compatible embeddings still stop. The existing sandbox is preserved. A `tool.started` Event is written before executor dispatch and carries `operation_id`; it alone does not prove process start. Arbitrary command effects have no automatic rollback: the private Patch WAL remains specific to before/after images. Read-only replay never executes commands.

Controlled external oracles cover Node-created bytes, actual npm pre/post hooks, nonzero partial effects, timeout/cancel output, output bounds, missing/changed manifests, scope, unavailable sandbox, canonical Run/Artifact scope, and unknown no-retry. See [the raw Core check](focused-core.log) and [contracts/Tool checks](focused-contracts-tool.log). The owning tests are `project-commands.test.ts`, `runtime.project-commands.test.ts`, `runtime.plan-mode.test.ts`, `run-state-machine.test.ts`, `runtime.steering.test.ts`, `runtime.extension.test.ts`, and `runtime-feature-drivers.test.ts`.

Example explicit project config:

```json
{"version":1,"commands":{"build":{"executable":"node","args":["scripts/build.mjs"],"cwd":"."}}}
```

This declaration is untrusted project content, not permission approval. A successful command exit proves only that command's result, not completion of all user requirements. Package manager availability and restricted OS sandbox support remain platform prerequisites; these local proofs do not establish clean Windows installation or descendant isolation under an unrestricted Windows process mode.
