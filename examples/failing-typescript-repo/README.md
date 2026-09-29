# Failing TypeScript Fixture

[中文](README.zh.md) · English

This directory is an immutable demo template. TraceGraph copies it into a disposable workspace before running the patch-and-test flow. The checked-in bug is intentional: `add()` subtracts its second argument, so `test/run.mjs` fails until the approved patch is committed in the copy.

## Purpose

Provide a small, reproducible failing project for the `run_test` and patch workflow. This is a fixture package, not a production dependency.

## Public API

The fixture has no published library API. Its `src/add.ts` function and `test/run.mjs` script are the controlled repair target and oracle.

## Dependencies

The fixture has no runtime or workspace-package dependencies. It uses the Node runtime to execute its test script.

## State ownership

The checked-in directory is the source template. Agent execution copies it into a disposable workspace; edits and test results belong to that copy, not to this template.

## Extension points

The fixture is intentionally fixed to the `test/run.mjs` entry point selected by the built-in `run_test` tool. New scenarios should use a separate explicit fixture and contract.

## Model effect

The fixture does not call a model. Runtime may provide its source as workspace context, and the bounded test result may become an observation for a later model decision.

## Verification

Run `node test/run.mjs` from this directory to confirm the template's expected failure. After an approved repair is applied to a disposable copy, the same command is the success oracle.

## Known limitations

This fixture covers one TypeScript arithmetic defect only. It is not a general-purpose test runner and does not validate arbitrary project commands, languages, or build systems.
