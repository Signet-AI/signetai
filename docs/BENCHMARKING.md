# Benchmarking

Signet memory benchmarks run through `memorybench/`. The benchmark harness owns
the datasets, checkpointing, answer generation, judging, retrieval metrics, and
reports. Signet is only a MemoryBench provider.

## Default developer run

```bash
bun run bench
```

This command:

1. Builds the workspace with `bun run build`.
2. Creates a temporary isolated Signet workspace under `/tmp`.
3. Starts a Signet daemon bound to `127.0.0.1` on a free port.
4. Runs MemoryBench against LongMemEval using the `signet` provider.
5. Shuts the daemon down and removes the temporary workspace.

The default run uses a small LongMemEval sample, one question per question type,
so developers can run it while iterating. The command prints the exact
MemoryBench command and run id before executing.

MemoryBench reports scores by question type in `report.json`, so the default
run gives a clean per-type breakdown without extra commands.

## Larger runs

Run the full LongMemEval benchmark:

```bash
bun run bench -- --full
```

Run a fixed-size sample:

```bash
bun run bench -- --limit 20
bun run bench -- --sample 3
```

Run one LongMemEval question type:

```bash
bun run bench -- --type temporal-reasoning --limit 20
bun run bench -- --type knowledge-update --sample 5
```

Valid LongMemEval types include:

```text
single-session-user
single-session-assistant
single-session-preference
multi-session
temporal-reasoning
knowledge-update
```

Skip the workspace build when you already built locally:

```bash
bun run bench -- --no-build --limit 10
```

Keep the isolated workspace for inspection:

```bash
bun run bench -- --keep-workspace --limit 5
```

Preview the command without building, starting the daemon, or running the
benchmark:

```bash
bun run bench -- --dry-run
```

## Isolation rules

Benchmarks must never read from or write to `~/.agents/memory/memories.db`.
The wrapper sets `SIGNET_PATH` and `HOME` to temporary benchmark directories
before starting the daemon. This prevents production memory, Claude project
memory, and user identity files from being mounted into benchmark runs.

The MemoryBench Signet provider also scopes every write and search with:

```text
agentId: memorybench
project: memorybench
scope: <question-id>-<data-source-run-id>
sourceType: memorybench-session
```

That scope is per question, matching MemoryBench's provider isolation model.

## What is being measured

The default `signet` provider uses the public Signet daemon HTTP API:

- ingest: `POST /api/memory/remember`
- search: `POST /api/memory/recall`
- health: `GET /health`

MemoryBench still performs the answer and judge phases itself. This keeps the
benchmark comparable with the other providers and avoids benchmark-specific
changes to MemoryBench scoring logic.

The default isolated daemon disables background extraction/synthesis workers in
its generated `agent.yaml`. That makes the developer benchmark a retrieval-path
benchmark over daemon-ingested benchmark sessions. If we add full extraction
benchmarks later, they should use a separate mode and report that mode in the
run metadata rather than changing MemoryBench's scoring code.

## Environment knobs

```text
SIGNET_BENCH_FULL=1                 Run the full benchmark by default.
SIGNET_BENCH_SKIP_BUILD=1           Skip `bun run build`.
SIGNET_BENCH_KEEP_WORKSPACE=1       Keep the isolated workspace after the run.
SIGNET_BENCH_RUN_ID=<id>            Override the MemoryBench run id.
SIGNET_BENCH_JUDGE=<model>          Default judge model, default gpt-4o.
SIGNET_BENCH_ANSWERING_MODEL=<m>    Default answering model, default gpt-4o.
SIGNET_BENCH_SAMPLE_PER_TYPE=<n>    Default dev sample size, default 1.
SIGNET_BENCH_EMBEDDING_PROVIDER=<p> Generated daemon embedding provider, default native.
```

## Reports

MemoryBench writes checkpoints and reports under `memorybench/data/runs/`.
That directory is ignored by Git. Reports should be attached to PRs or release
notes when benchmark numbers are used to justify a memory-system change.
