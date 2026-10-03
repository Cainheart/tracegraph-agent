# Benchmark workspace

This directory owns offline, user-path performance measurements. Keep paths
organized by user-visible workflow rather than mirroring package boundaries.

- Use fixed synthetic and de-identified inputs. Do not put credentials, real
  user data, absolute home paths, or raw command output in reports.
- Keep budgets and scenario versions in reviewed JSON manifests. The runner has
  no CLI/environment override for a budget.
- Every scenario declares correctness separately; correctness must pass before
  any warmup or measured iteration starts.
- Each invocation is a fresh Node process with a private temporary home and
  temp directory. Node fetch/TCP/TLS/UDP and DNS access are restricted to
  loopback; credentials and inherited `NODE_OPTIONS` are removed. This is not
  an OS sandbox: scenarios must not spawn network-capable non-Node clients.
- Direct all scenario-owned data and workspace writes to
  `TRACEGRAPH_BENCHMARK_TEMP_ROOT`; do not mutate the checkout.
- Use production entrypoints. A benchmark must not copy the product algorithm
  it intends to measure.
- Treat generated reports as measurement evidence. Reports go under the
  ignored `_tmp_benchmarks/` directory and CI retains them as artifacts. The
  reviewed P95 ceilings live in scenario manifests; a budget change must be an
  explicit manifest diff. Do not add automatic baseline rewriting.
- Keep CPU/wall-time and memory/resource measurements as separate metrics.
  V1 reports wall time only; do not infer memory from host capacity or RSS
  sampled from the runner process.

Run one path with `pnpm benchmark -- --scenario benchmarks/scenarios/<scenario>.json`;
run the full build-plus-suite gate with `pnpm benchmark:check`. BENCH-073 owns
the eight manifests and production-path adapters; BENCH-072 owns the runner
contract and contract tests.
