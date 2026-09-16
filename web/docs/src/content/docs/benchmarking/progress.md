---
title: "Benchmark progress"
description: "Current benchmark status and clearly labeled development history."
---

## Current status

No publishable benchmark score is recorded on this page. The benchmark harness
and its generated reports are the authority for current results. Before using a
number as evidence, run the intended profile from a fresh isolated workspace and
record the dataset, models, run ID, and report path.

The fixed LongMemEval canary is the preferred local ratchet for comparing one
change at a time:

```text
memorybench/config/autoresearch/longmemeval-canary-12.txt
```

Use the [operations guide](../operations/) to run it, distinguish a warmed
development workspace from a fresh run, and preserve the exact run metadata.

## Development and history ledger

The repository's internal ledger is historical development context. It contains
selected local tuning runs and may include warmed workspaces, changing model
configurations, and non-comparable samples. It is **not** release evidence and
must not be read as a current product claim:

- [`docs/BENCHMARKING-PROGRESS.md`](https://github.com/Signet-AI/signetai/blob/main/docs/BENCHMARKING-PROGRESS.md)

Generated checkpoints and reports remain under the ignored
`memorybench/data/runs/` directory. If a historical entry conflicts with a
fresh report, prefer the fresh report and document the changed setup.
