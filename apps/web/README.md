# @tracegraph/web

Browser workbench for inspecting TraceGraph runs and issuing explicit user commands. See [module 10](../../docs/modules/10-Web-工作台.md) for the current UI and trust boundaries.

## Purpose

Render Host-provided Run projections, Sessions, events, and live streams, and let the user submit bounded commands such as starting, approving, or steering a Run.

## Public API

This package builds a Vite browser application; it does not expose a package library API. Its browser-to-Host interface is the `@tracegraph/sdk` client and shared schemas from `@tracegraph/contracts`.

## Dependencies

The Web composition root depends on `@tracegraph/workbench`, `@tracegraph/contracts`, `@tracegraph/sdk`, React, and React DOM. The shared package owns Mermaid and the Workbench UI dependency set.

## State ownership

The UI's `WorkbenchSnapshot` is a view of Host data, not a durable business store. Canonical Run and Session state stays with the local Host; browser storage is not used as a second fact source.

## Extension points

UI components consume the SDK's client surface and shared contracts. New screens should render Host facts or issue supported commands; provider construction and tool execution belong in the CLI/Core composition.

## Model effect

Web does not call a model or execute tools. User-entered task and steering text can be sent to Host and become Runtime input; model output is displayed from Host projections and the model-surface stream.

## Verification

Run `pnpm run build && pnpm --filter @tracegraph/web test:unit` from the repository root.

## Known limitations

The workbench requires a compatible local Host and cannot provide Runtime capabilities the Host did not compose. Its Memory control panel reads and writes through the shared Host/SDK seam; it does not own canonical Memory state or the retrieval index. A client-to-Host command is not evidence of a completed business action until canonical state is read back.
