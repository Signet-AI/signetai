---
title: "Benchmark operations"
description: "Run and interpret Signet memory benchmarks."
---

Signet memory benchmarks run through `memorybench/`. This page is organized by
task; the harness remains the source of truth for scoring and report formats.

## Choose a task

| Task | Command or section |
| --- | --- |
| Run the default developer sample | [`bun run bench`](#run-a-small-developer-sample) |
| Run a larger or focused LongMemEval set | [`--full`, `--limit`, `--sample`, or `--type`](#select-the-dataset) |
| Resume a two-stage local run | [`bench:ingest` then `bench:evaluate`](#resume-a-two-stage-run) |
| Compare profiles or graph retrieval | [Profiles and ablations](#choose-a-profile) |
| Tune without paying ingestion cost again | [Warmed development workspace](#reuse-a-development-workspace) |
| Check safety and result handling | [Isolation and reports](#keep-runs-isolated) |

## Run a small developer sample

From the repository root:

```bash
bun run bench
```

The wrapper builds the workspace, creates a temporary isolated Signet workspace,
starts a daemon on `127.0.0.1`, runs LongMemEval, then removes the workspace.
Use a preview when checking arguments:

```bash
bun run bench -- --dry-run
bun run bench -- --no-build --limit 10
bun run bench -- --keep-workspace --limit 5
```

The default sample is intended for iteration, not for publishing a score.

## Select the dataset

Run the full set, a fixed-size sample, or one question type:

```bash
bun run bench -- --full
bun run bench -- --limit 20
bun run bench -- --sample 3
bun run bench -- --type temporal-reasoning --limit 20
bun run bench -- --type knowledge-update --sample 5
```

Valid question types are `single-session-user`, `single-session-assistant`,
`single-session-preference`, `multi-session`, `temporal-reasoning`, and
`knowledge-update`. `--limit` and `--sample` select questions, not sessions.

For a fixed canary, pass repeatable question IDs or a file containing one ID per
line (blank lines and `#` comments are ignored):

```bash
bun run bench -- --question-id 32260d93 --question-id 54026fce
bun run bench:ingest -- --question-ids-file memorybench/config/autoresearch/longmemeval-canary-12.txt
```

## Choose a profile

```bash
bun run bench -- --profile rules
bun run bench -- --profile dreaming
bun run bench -- --profile supermemory-parity
```

`rules` is the default structured-ingest profile. `dreaming` saves lossless
sessions and runs one bounded Dreaming pass before retrieval; it requires an
explicit Dreaming model and endpoint configuration. `supermemory-parity` is a
diagnostic comparison, not a fair or publishable score, because its adapter has
different retrieval behavior. Keep profile results separate.

For retrieval ablation, keep the same run and workspace, then repeat from the
search phase:

```bash
export RUN_ID="dreaming-uplift-$(date -u +%Y%m%dT%H%M%SZ)"
export WORKSPACE=".bench/workspaces/dreaming-uplift"
SIGNET_BENCH_RUN_ID="$RUN_ID" bun scripts/bench-memory.ts --profile dreaming --graph on --workspace "$WORKSPACE" --full
SIGNET_BENCH_RUN_ID="$RUN_ID" bun scripts/bench-memory.ts --profile dreaming --graph off --workspace "$WORKSPACE" --resume -r "$RUN_ID" -f search
```

Compare retrieval aggregates from the two reports, not answer scores alone.

## Resume a two-stage run

Use one run ID and workspace so ingest is not repeated:

```bash
export RUN_ID="lme-dev-$(date -u +%Y%m%dT%H%M%SZ)"
export WORKSPACE=".bench/workspaces/longmemeval-structured"
SIGNET_BENCH_RUN_ID="$RUN_ID" bun run bench:ingest -- --no-build --workspace "$WORKSPACE" --limit 6 --concurrency-ingest 1
SIGNET_BENCH_RUN_ID="$RUN_ID" bun run bench:evaluate -- --no-build --workspace "$WORKSPACE"
```

Set the extraction and answer/judge OpenAI-compatible endpoints and model
variables in the environment for your local servers. `--resume` preserves an
existing checkpoint; do not add `--force` when continuing it.

## Reuse a development workspace

A persistent workspace is useful for tuning recall, ranking, context packing,
answering, or judging:

```bash
SIGNET_BENCH_EMBEDDING_PROVIDER=ollama bun run bench -- --workspace .bench/workspaces/longmemeval-structured --sample 1
```

Call it a **warmed development workspace** in notes and reports. Re-ingest when
changing extraction, the structured remember payload, graph persistence,
embeddings, indexing, dataset selection, or question sampling. Reuse is valid
for changes that only affect recall, reranking, context packing, answer prompts,
or judging.

Use the fixed canary helper when changing one hypothesis at a time:

```bash
bun scripts/autoresearch-memorybench.ts status
bun scripts/autoresearch-memorybench.ts ids
bun scripts/autoresearch-memorybench.ts triage --run-id <run-id> --write-queue
bun scripts/autoresearch-memorybench.ts compare --base <old-run-id> --candidate <new-run-id>
bun scripts/autoresearch-memorybench.ts run-canary
```

Add `run-canary --execute` only when the configured local model servers are
running. Use `--ingest-only` and `--skip-ingest --run-id <same-run-id>` when
servers must be swapped between phases.

## Keep runs isolated

Benchmark runs must not read or write `~/.agents/memory/memories.db`. The wrapper
sets temporary `SIGNET_PATH` and `HOME` values and scopes provider requests with
`agentId: memorybench`, `project: memorybench`, a question-specific `scope`, and
`sourceType: memorybench-session`.

Do not commit run artifacts. Checkpoints and reports live under
`memorybench/data/runs/`, an ignored path. Attach a report to a PR or release
note only when the result is intentionally being used as evidence, with its
profile, models, dataset, and fresh/warmed workspace state stated.

## Prompt-submit gate benchmark

To measure the prompt-submit hot path in a temporary database:

```bash
bun run build:core
bun scripts/bench-prompt-submit.ts
```

This reports prompt-submit latency, recall timing, and synthetic embedding-call
counts. It does not read the live workspace.

## Environment knobs

Common controls are:

```text
SIGNET_BENCH_FULL=1
SIGNET_BENCH_SKIP_BUILD=1
SIGNET_BENCH_KEEP_WORKSPACE=1
SIGNET_BENCH_PROFILE=rules|dreaming|supermemory-parity
SIGNET_BENCH_GRAPH=on|off
SIGNET_BENCH_RUN_ID=<id>
SIGNET_BENCH_JUDGE=<model>
SIGNET_BENCH_ANSWERING_MODEL=<model>
SIGNET_BENCH_EMBEDDING_PROVIDER=<provider>
SIGNET_BENCH_EMBEDDING_MODEL=<model>
SIGNET_BENCH_SESSION_CONCURRENCY=<n>
MEMORYBENCH_EXTRACTION_MODEL=<model>
MEMORYBENCH_EXTRACTION_MAX_TOKENS=<n>
MEMORYBENCH_STRUCTURED_EXTRACTION_MAX_TOKENS=<n>
OPENAI_BASE_URL=<url>
```

Profile-specific and Dreaming controls are defined by the benchmark runner. Use
`bun scripts/bench-memory.ts --help` when a command needs the complete current
flag set; this page intentionally does not duplicate the runner's implementation
contract.
