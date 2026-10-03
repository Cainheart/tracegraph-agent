# Reproducing the UX-086 acceptance

Build once and run serially. `typecheck` and `baseline:current` also build; running them concurrently can temporarily remove the generated distributions.

```bash
env -u NODE_OPTIONS pnpm build
env -u NODE_OPTIONS OUTLIVE_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node docs/validation/ui-086-workbench-ux/journey-harness.mjs
env -u NODE_OPTIONS node docs/validation/ui-086-workbench-ux/verify-evidence.mjs
```

On this workspace the bundled module is `/Users/cain/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs`. The default binaries are installed Google Chrome and the repository's macOS Electron distribution. Other hosts can supply `OUTLIVE_CHROME_BINARY` and `OUTLIVE_ELECTRON_BINARY`. An optional positional output directory creates a separate receipt. `OUTLIVE_SKIP_DESKTOP=1` runs only the Web subset, which is not full UX-086 acceptance.

The provider is a synthetic deterministic loopback HTTP server named `synthetic-ux086-local`. The Web/Electron renderers, HTTP/private framed Hosts, Runtime, Session/Event ledgers, source files, process cancellation, fixture tests, and Artifact reads are real. The scenario checks Enter submission, plain chat, project tasks, durable steering, tool results, Todo changes, recovery without writes, explicit resume with a regenerated approval, exact diff approval, file/test oracles, raw output, same-Session follow-up, Session switching without a dispatch, and cancellation during an in-flight request. Web recovery kills a real Host child with `SIGKILL`; Electron closes and relaunches its isolated real application.

The 24 stateful PNGs cover two surfaces, four states, and three viewports. Each viewport exercises keyboard navigation/search/settings, IME Enter and Shift+Enter, enabled input/submit controls, active steering/cancel control availability, conversation/activity navigation, and file/architecture/diff review navigation. Layout checks measure viewport and document/body width, reject a compact read-only gate, and confirm interactive controls. Tool screenshots bring the real completed receipt into view. Preview runs separately with its explicit synthetic-data marker.

Only disposable fixtures and temporary Electron user data are used. Desktop configuration creates a uniquely named synthetic credential and deletes that exact entry during teardown. User data and provider credentials are never loaded. A final passing receipt requires completed assertions, zero uncaught renderer errors, and successful cleanup. The verifier checks the complete matrix, canonical search/patch/test facts, actual PNG dimensions, SHA-256 hashes, and cleanup. Failed attempts remain under `attempts/`; they must not be relabelled as passed.

The [Electron negative oracle](electron-process-repro.mjs) proves that the embedded executable fails the same Seatbelt fixture which an installed Node executable passes:

```bash
env -u NODE_OPTIONS ELECTRON_RUN_AS_NODE=1 apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron docs/validation/ui-086-workbench-ux/electron-process-repro.mjs /absolute/path/to/oracle.json
```

These receipts measure engineering workflows, not provider quality or independent external-user acceptance. Current completion and release boundaries are recorded in the [owning validation report](README.md).
