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
run gives a clean per-type breakdown without extra commands. Benchmark reports
and run artifacts stay under ignored paths and should not be committed until the
team explicitly decides to publish a score.

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

The MemoryBench Signet provider scopes every write and search with:

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

During ingest, the provider performs MemoryBench-side structured extraction
from each session, then calls the full remember endpoint with:

- extracted memory content
- structured entities
- structured aspects and attributes
- hint questions
- source metadata and per-question scope
- the lossless source transcript

The isolated daemon does not run background extraction or synthesis workers for
benchmark ingestion. Those stages stay disabled so the benchmark is not racing
async background work or depending on local daemon timing. Graph and traversal
are enabled only so recall can use the structured data that was explicitly sent
to `/api/memory/remember`.

MemoryBench still performs the answer and judge phases itself. This keeps the
benchmark comparable with the other providers and avoids benchmark-specific
changes to MemoryBench scoring logic.

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
SIGNET_BENCH_EMBEDDING_MODEL=<m>    Generated daemon embedding model.
SIGNET_BENCH_EMBEDDING_DIMENSIONS=<n> Generated daemon embedding dimensions.
SIGNET_BENCH_AGENT_ID=<id>          Signet agent scope, default memorybench.
SIGNET_BENCH_PROJECT=<name>         Signet project scope, default memorybench.
SIGNET_BENCH_REQUEST_TIMEOUT_MS=<n> Daemon request timeout, default 60000.
MEMORYBENCH_EXTRACTION_MODEL=<m>    Structured extraction model, default gpt-4o.
```

## Reports

MemoryBench writes checkpoints and reports under `memorybench/data/runs/`.
That directory is ignored by Git. Reports should be attached to PRs or release
notes only when benchmark numbers are being used to justify a memory-system
change.
