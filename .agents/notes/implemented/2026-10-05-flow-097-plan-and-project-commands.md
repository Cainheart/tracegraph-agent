---
id: 2026-10-05-flow-097-plan-and-project-commands
status: implemented
date: 2026-10-05
language: en
---

# FLOW-097: explicit Plan completion and bounded project commands

## Context

This is a narrow implementation slice of [the accepted product workbench plan](../proposed/2026-10-05-complete-product-workbench.md), not completion of FLOW-097. Before this slice, every Plan finish required Todos, including an ordinary knowledge answer. The existing executable built-in only runs `test/run.mjs` through `run_test({suite:"fixture"})`.

## Decision

Add a typed `finish_intent` to model Decisions: `answer` is the compatibility default; `submit_plan` explicitly requests the Plan approval boundary. An answer may terminate a Plan Run without executing anything. An explicit execution plan still requires canonical Todos and records `plan.ready`; approval remains bound to that exact event. Legacy finishes with Todos do not acquire execution authority. Queued user input and cancellation retain priority over a stale finish.

Discover existing project commands from bounded public manifests and execute a selected manifest-bound entry using a typed Tool, the existing workspace capability, permission policy, SandboxRunner, and canonical pre-dispatch Events. The model cannot supply a shell string, environment, absolute executable, elevated privilege, or an unregistered command. Existing package scripts and explicitly declared argv commands remain untrusted project content; discovery never grants permission or installs dependencies. A changed manifest requires fresh discovery. Process output, exit, cancellation, timeout, and unavailable sandbox are real facts; uncertain external outcomes are not retried automatically.

## Scope and compatibility

Retain fixture `run_test` and existing patch/Plan policy. Add public project command tools without moving product execution into scripts or apps. Preserve the configured OS isolation; platforms without proven enforcement fail closed under restricted sandbox modes. A successful exit is a command result, not proof of the requested software task being complete. Broader FLOW features, native computer operation, UI design, and final user acceptance belong to separate slices.

## Validation

Require direct Plan answers with and without legacy Todos, explicit plan submission without Todos, exact approval revision, blocked writes/commands in Plan, queued input, cancellation, and terminal consistency. Project command tests must use actual temporary project manifests and external disk effects, plus changed manifests, scope/symlink rejection, nonzero exits, timeout, abort, output limits, and actual Run Receipt/Observation/pre-dispatch Event evidence. Verified focused Core: 9 files / 119 tests; contracts: 4 files / 28 tests. After adding private-path rejection and catalog pagination, the provider compatibility/command check passed 3 files / 64 tests. See [reproducible evidence](../../../docs/validation/flow-097/README.md). The private Patch WAL remains patch-specific; arbitrary command side effects are not automatically rolled back. The whole FLOW task remains partial.
