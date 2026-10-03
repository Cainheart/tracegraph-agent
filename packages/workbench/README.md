# @tracegraph/workbench

## Purpose

Owns the shared Outlive conversation-centered shell, project/Session navigation, pinned view preferences, keyboard controls, anchored composer, Run activity, Tool state, contextual review, replay views, and language preferences used by Web and Desktop.

## Public API

- `App` renders the shared workbench and requires an injected `WorkbenchClient`.
- `DemoTraceGraphClient` supplies deterministic preview fixtures.
- `LiveTraceGraphClient` adapts a `TraceGraphSdkPort` into the shared view contract.
- `./styles.css` and `./workbench.css` provide the shared presentation styles.

## Dependencies

- `@tracegraph/contracts` supplies shared Run, Session, Tool, and event data types.
- `@tracegraph/sdk` supplies the browser SDK adapter contract types and the shared locale catalog through `./client`; Web/Desktop use the same language provider.
- React and React DOM render the shared UI; Mermaid renders evidence diagrams.

## State ownership

The package owns presentation state only. Canonical Workspace, Run, Session, event, policy, and Tool facts come from the injected client and its Host; browser storage contains only local view preferences.

## Extension points

New app surfaces inject a `WorkbenchClient` into `App`. Platform operations stay in app adapters and cross explicit transport contracts rather than importing another app's source.

## Model effect

The shared UI does not call a model or execute Tools. It renders explicit public plans and observed Host facts; private provider reasoning is not a UI data source.

## Verification

- `pnpm --filter @tracegraph/workbench build`
- `pnpm --filter @tracegraph/workbench typecheck`
- `pnpm --filter @tracegraph/workbench test:unit`
- `pnpm --filter @tracegraph/web build`

## Known limitations

Platform capabilities depend on each injected adapter. Desktop supports native linked-project registration, conversation/Session/Run controls, approvals, Todo and Artifact reads. Optional replay, attachment upload, Team and provider-surface streaming are not available through its current adapter. Unsupported operations display explicit errors; Preview uses labelled synthetic state.
