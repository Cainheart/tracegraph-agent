# @tracegraph/cli

## Purpose

`outlive` is the installed Workbench command-line entry point (`tracegraph` remains a compatibility alias). Default commands use the same authenticated private UDS/Windows-pipe Host, profile, typed SDK and Runtime as Desktop and Web. They do not compose another owner or read a user's credential values.

## Public API

After building, run from the repository root:

```sh
env -u NODE_OPTIONS node apps/cli/dist/index.js host start
env -u NODE_OPTIONS node apps/cli/dist/index.js host status
env -u NODE_OPTIONS node apps/cli/dist/index.js doctor
env -u NODE_OPTIONS node apps/cli/dist/index.js capabilities
```

`host start` discovers or starts the owner and prints safe status including the loopback Web address. `host status`, `host restart` and `host stop` connect only to an existing owner. `--profile-root <directory>` and trusted `OUTLIVE_PROFILE_ROOT` override the shared default `~/.outlive/profiles/default`. Bare `serve` follows this shared path; legacy explicit storage flags remain a compatibility composition protected by exclusive owner/root leases.

## Dependencies

The shared route uses Host, typed SDK and Contracts. Compatibility composition retains Core, Codegraph, Retrieval, Session-related Host stores, Telemetry, MCP/LSP and Test Support behind the exclusive owner leases.

## State ownership

Exit/closing a CLI client detaches only its subscriptions. Runs, PTYs, previews and schedules stay in the Host. `host stop` is explicit and stops those resources. Startup validates a standalone Node 22.19+ within 22.x or Node 24+.

## Extension points

Every new command supports `--help`; query/command output is JSON and public event streams are JSONL. Mutations accept `--command-id` for exact retries.

| Family | Supported workflows |
|---|---|
| `host`, `doctor`, `capabilities`, `resources` | Start/status/stop, safe diagnostics, effective capabilities and background resources |
| `config`, `model` | Revision/CAS settings, bounded permission presets, write-only model configuration, separate connection test and clear-key |
| `projects`, `chat`, `run`, `sessions` | Project registration/create/remove/reveal; chat/task start, reads, follow-up/steering, explicit cancellation, approval/plan approval, session list/read/rename/delete/resume/archive |
| `todo`, `artifact`, `attachments` | Scoped Todo mutations, Artifact reads, bounded image/PDF upload and scoped binary download |
| `replay`, `rollback`, `experience` | Read-only replay/diff, exact rollback action, Experience lifecycle review with sequence |
| `team`, `memory`, `skills`, `mcp`, `extensions`, `lsp` | Existing named workflows through the same authenticated SDK; safe status, validation/reload/restart as advertised |
| `usage`, `telemetry` | Usage/cost and optional project/session/time filters; actual telemetry state |
| `terminal`, `preview` | Host PTY create/input/resize/attach/close; loopback preview start/register/stop |
| `git`, `schedule` | Scoped status/diff/stage/unstage/reviewed discard/commit/branch/worktrees; schedule create/update/pause/run/history/delete |

Commands are implemented in `workbench-command.ts` over the shared typed SDK. Capability states can be available, unconfigured, read-only, policy-denied or unavailable; an installed command does not imply a configured backend.

## Examples

```sh
node apps/cli/dist/index.js projects register /absolute/repository
node apps/cli/dist/index.js run start --project-id PROJECT --task 'Inspect failing tests' --mode plan
node apps/cli/dist/index.js run model RUN --after-cursor 0 --jsonl
node apps/cli/dist/index.js run input RUN --body 'Keep the edit in src/' --command-id command:steer
node apps/cli/dist/index.js run cancel RUN
node apps/cli/dist/index.js run cancel queued:ORIGINAL_COMMAND_ID
node apps/cli/dist/index.js todo create RUN --todo-id todo:check --title 'Read test receipt'
node apps/cli/dist/index.js artifact get RUN ARTIFACT
node apps/cli/dist/index.js terminal create --project-id PROJECT
node apps/cli/dist/index.js terminal attach TERMINAL
node apps/cli/dist/index.js usage --project-id PROJECT --from 2026-10-01T00:00:00Z
node apps/cli/dist/index.js lsp restart SERVER_NAME
```

SIGINT on a public stream ends the client subscription without cancelling a Run. `run cancel queued:...` removes the waiting workspace holder; the pending start command reports the actual cancellation and no Core Run is fabricated. PTY attach forwards actual input/output; Ctrl+] detaches without closing the terminal. `terminal close` is the separate resource stop.

## Model effect

Use `model configure ... --key-stdin` to supply credentials from standard input. Keys are rejected in arguments and are never printed. Saving configuration is distinct from `model test`. `config set --input-file settings-change.json` requires `command_id`, `expected_revision` and a bounded section patch; conflicts reject stale writes without resetting omitted settings.

`attachments content RUN ATTACHMENT --output /new/file` creates a private new file and refuses overwrite. `git discard --project-id PROJECT --path relative/file --expected-head HASH` requires the current reviewed Git head; inspect `git diff` first. Native project authority remains Host-owned.

## Backup-first migration and unknown results

```sh
node apps/cli/dist/index.js host migrate --dry-run --inventory-json sources.json
node apps/cli/dist/index.js host migrate --commit --inventory-json sources.json --source chosen-source
node apps/cli/dist/index.js host migration result OPERATION_ID
```

The inventory explicitly declares `sources: [{id, dataRoot, sessionRoot?, modelConfigPath?, permissionConfigPath?, credentialFile?}]` with native absolute paths. Preview reports metadata/hashes/conflicts without credential values. Commit requires one selected source, preserves original data, backs up the target and isolates untrusted registrations/conflicting sources. Active Runs, PTYs and previews reject migration with `migration_busy`. Existing owners process the native operation and restart; idle offline profiles use the same backup-first migration implementation.

Errors are structured stderr JSON with a bounded `code`, optional HTTP `status`, safe message and optional `operation_id`. An unknown result is not success and must not be resubmitted before querying the durable receipt.

| Exit code | Meaning |
|---|---|
| 0 | Successful query/operation or natural terminal stream; explicit `run stop/cancel` requires a canonical `cancelled` reply and means cancellation completed |
| 1 | Business/transport failure; `run get` or `run start --wait` reports a cancelled task as failure |
| 2 | Invalid arguments; no credential arguments accepted |
| 3 | Migration receipt still queued, or an explicit cancellation reply remains pending/running; inspect its state |
| 124 | Stream/wait timeout; background work is preserved |
| 130 | Interrupted client subscription; it does not cancel the Run |

## Verification

Run package `build`, `typecheck`, `test:unit` and `test:e2e`. [Desktop transport acceptance](../../docs/validation/unified-workbench/desktop-transport.mjs) additionally launches the actual packaged CLI against one disposable Host shared by Electron and the loopback Web gateway; synthetic model decisions lead to real fixture patch/test, attachment and resource effects.

## Known limitations

Independent external-user acceptance and production model quality remain outside deterministic local verification. Credential storage uses the platform backend (macOS Keychain by default); tests explicitly choose disposable private-file profiles. Remote retrieval does not move the Runtime or workspace to a remote host.

## Image generation and local media (MEDIA-094)

Image generation uses a dedicated provider configuration; it does not silently reuse the chat key. Supply the key on stdin, then start a normal governed media Run:

```bash
outlive image configure --protocol openai-images --base-url https://api.openai.com/v1 --model gpt-image-1 --key-stdin
outlive image get --json
outlive media generate --prompt 'A simple landscape illustration' --output ./landscape.png --json
outlive image clear --json
```

`--key-stdin` reads stdin to EOF. Use a secure input/pipeline; the key is never an argument. `openai-responses` selects Responses with a main model and optional `--image-model`; `openai-chat-images` selects the explicitly compatible native Chat PNG-output convention. Provider access and actual model quality/cost depend on the selected account and have not been validated with a live key. Current generated raster output is PNG only.

Local diagram/chart rendering needs neither a chat nor an image provider. An input file contains the closed structured data, without a `kind` field:

```bash
outlive media diagram --input-file ./diagram.json --output ./diagram.svg --json
outlive media chart --input-file ./chart.json --output ./chart.svg --json
outlive media export --run-id RUN_ID --artifact-id ARTIFACT_ID --output ./copy.png --json
```

Diagram example: `{"title":"Flow","nodes":[{"id":"a","label":"Request"},{"id":"b","label":"Artifact"}],"edges":[{"from":"a","to":"b"}]}`. Chart example: `{"title":"Counts","chart_type":"bar","labels":["PNG","SVG"],"values":[3,2]}`. Add `--project-id PROJECT_ID` to use a registered project; otherwise the Host isolates media in the chat workspace. Media tools grant no filesystem/command capability.

Success requires a canonical business-success receipt and verified Artifact bytes; prose/code is not accepted as image output. Output files use exclusive creation and never overwrite an existing file. `--command-id` binds the entire typed intent: retrying the same intent returns its old Run; changing parameters returns conflict. Failure exits 1, unknown/pending exits 3, successful verified media export exits 0. Inspect unknown Run receipts before another request; cancellation cannot promise an external provider did not charge. Replay cannot read live binary output or generate media.

[Current capability and external protocol evidence](../../docs/validation/media-094/README.md) records deterministic HTTP validation, limits and the remaining real-provider boundary.
