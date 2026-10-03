# Outlive Benchmarks

Benchmarks are offline performance/resource evidence organized by user path.
They measure behavior; they do not replace correctness assertions or model
quality evals.

## Harness (BENCH-072)

Run a checked-in scenario with:

```sh
pnpm benchmark -- --scenario benchmarks/scenarios/<scenario>.json
```

Run all checked-in user paths and fixed budgets with:

```sh
pnpm benchmark:check
```

This command builds production packages first, then executes every manifest in
sorted order. CI runs the same command on Ubuntu 24.04 with Node 22.19.0 and
uploads one bounded JSON report per path.

The manifest fixes a correctness command, working directory, warmup/sample
counts, timeout, and wall-time P95 budget. Correctness runs first. Warmups and
samples each run in a new Node process, with an isolated temporary root that is
removed after the process exits. The report keeps each raw duration and exit
state, summary statistics, budget decision, scenario digest, Git commit/dirty
state, and non-identifying OS/CPU/runtime metadata. Reports are written under
`_tmp_benchmarks/reports/` and are ignored by Git.

Scenario JSON uses the strict `tracegraph.benchmark-scenario.v1` shape:

| Field | Meaning |
| --- | --- |
| `id`, `version`, `description` | Stable scenario identity and review context |
| `working_directory` | Repository-relative process working directory |
| `correctness_command.args` | Node arguments for a deterministic assertion; nonzero skips measurement |
| `command.args` | Node arguments for one measured invocation |
| `warmup_iterations`, `sample_iterations` | Fixed counts (0–20 warmups; 3–100 samples) |
| `timeout_ms` | Per-process timeout (100–120,000 ms) |
| `budget.wall_time_ms_p95_max` | Fixed nearest-rank P95 ceiling in milliseconds; changing it requires a reviewed manifest edit |

The Node executable is the current `process.execPath`; command argument text is
not copied into reports, while the manifest SHA-256 is recorded. Correctness
and measured commands should assert their expected outcome themselves and keep
all workspace/data writes inside `TRACEGRAPH_BENCHMARK_TEMP_ROOT`.

Node subprocesses are offline by default: fetch, TCP, TLS, UDP, and DNS access is
limited to loopback; credential-like and proxy environment variables are
removed, and inherited `NODE_OPTIONS` is replaced with the controlled guard.
This guard is not an OS sandbox; scenario commands must not launch
network-capable non-Node clients. Scenario-owned data and workspace writes stay
under `TRACEGRAPH_BENCHMARK_TEMP_ROOT` so the checkout remains unchanged. The
report omits command output, environment values, hostnames, usernames, and
absolute paths. The runner does not attempt to measure memory; resource metrics
require a separately validated adapter.

## BENCH-073 user-path budgets

Each manifest is the reviewed source for its fixed P95 ceiling. Workloads are
synthetic and bounded:

| Path | Correctness oracle | Initial local P95 | P95 ceiling |
| --- | --- | ---: | ---: |
| `cold-start` | Runtime and Host start on an ephemeral loopback port; `/health` is ready | 197 ms | 1,500 ms |
| `ledger-append` | 50 Run events append, hash-chain reads, and project as running | 559 ms | 3,000 ms |
| `run-replay` | A Tool-backed Run completes and its final replay snapshot includes the receipt | 362 ms | 2,000 ms |
| `context-compaction` | Long fixed history compacts and the Run completes | 339 ms | 2,500 ms |
| `memory-recall` | Governance admits the fixed eligible records and ranking returns the expected claim | 148 ms | 1,000 ms |
| `tool-execution` | Public `read_file` returns the fixed sentinel from a read-only workspace | 148 ms | 1,000 ms |
| `cancel-quiescence` | A blocked model Run becomes cancelled with no active subagents or queued inputs | 302 ms | 1,800 ms |
| `run-recovery` | A child process is terminated with a plan pending; session recovery, resume, approval, and completion succeed | 1,055 ms | 6,000 ms |

The initial local P95 column uses five samples after one warmup on macOS ARM64 /
Node 24.21.0. CI is pinned separately to Ubuntu 24.04 / Node 22.19.0; its first reports should be reviewed
before tightening the ceilings. These are hard guardrails with headroom, not
cross-commit statistical deltas. A regression that stays below its ceiling is
visible in the uploaded report but does not fail the gate. Budget changes are
explicit manifest edits; there is no baseline rewrite command.

Reports remain in ignored `_tmp_benchmarks/reports/` locally and are uploaded as
CI artifacts. `evals/perf/` remains a separate G16 quality gate. RSS/CPU and
cross-commit trend analysis remain deferred; the runner does not infer memory
usage from machine capacity.
