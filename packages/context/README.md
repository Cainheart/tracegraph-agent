# `@tracegraph/context`

## Purpose

Build the bounded model-visible Context projection, its replayable manifest, deterministic compaction surface, and spill references behind a stable package API.

## Public API

[`src/index.ts`](src/index.ts) is the only package entrypoint. It exports the deterministic builder, manifest-to-model-context reconstruction helper, compaction ports, the `TokenMeter` consumer port, and Context-owned structural model ports. New manifests bind the exact rendered string digest to their token estimate; the string still reconstructs from ordered included items. There are no supported deep imports.

## Dependencies

The package depends on `@tracegraph/contracts` for persisted Context schemas and `@tracegraph/tool` for canonical digest/ID helpers and the shared Tool-output compaction threshold, plus Node platform APIs. It does not import Core, Runtime, Host, apps, model providers, or ArtifactStore implementations.

## State ownership

Context owns only the model-visible projection and its construction evidence. Core Runtime remains responsible for canonical event writes, ArtifactStore lifecycle, provider selection, cancellation settlement, Run authority, and the calibrated token-meter implementation. Context policy and manifest schemas remain owned by `@tracegraph/contracts`.

## Model effect

`DeterministicContextBuilder` emits both a model-visible string and structured observations. Included manifest items are the source for reconstructing the visible string in stable order; summary output is validated and untrusted. Compaction creates manifest/node lineage without rewriting Ledger events.

## Extension points

Callers provide the Context artifact port, optional summary adapter, cancellation signal, token-meter implementation, clock, and ID factory. The package does not choose a provider or persist artifacts itself.

## Verification

Run `pnpm --filter @tracegraph/context build`, `pnpm --filter @tracegraph/context typecheck`, and `pnpm --filter @tracegraph/context test:unit`. Core integration tests exercise the package with the real ArtifactStore and Runtime composition.

## Known limitations

The package currently exposes one deterministic compaction chain. The local calibration-file implementation stays in Core pending the LLM family extraction. Additional Context providers and policy changes remain deferred; Runtime is its only production consumer today, justified by the explicit model-visible trust-boundary isolation requirement.
