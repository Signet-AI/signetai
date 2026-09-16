---
title: "Benchmarks"
description: "Signet memory benchmark operations and progress."
---

Signet is a MemoryBench provider. The `memorybench/` harness owns datasets,
checkpointing, answer generation, judging, retrieval metrics, and reports.

Use this section for two jobs:

- [Run a benchmark](./benchmarking/operations/) — choose a run, resume a checkpoint, tune locally, or inspect reports.
- [Review progress](./benchmarking/progress/) — read the current local status and the clearly labeled development ledger.

Benchmark results are only comparable when the profile, model configuration,
dataset selection, and workspace state are recorded. Do not treat a warmed
development run as a publishable score.
