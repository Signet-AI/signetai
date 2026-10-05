---
name: benchmarking
description: "Benchmark Signet memory with MemoryBench: regression-check Dreaming and recall changes, compare models, diagnose score drops, and record results; NOT for the prompt-submit latency benchmark."
---

# Benchmarking

Signet's memory quality is measured with MemoryBench (`memorybench/`) running against an isolated Signet daemon. This skill covers the workflows for running and interpreting those benchmarks. `web/docs/src/content/docs/benchmarking.md` and `memorybench/README.md` own the command, flag, and benchmark documentation; read them rather than relying on this file for flags.

## When to Use

- A change touches Dreaming (prompt, tools, operations, evidence delivery), recall (search, ranking, SEC, dampening), ingestion, or the MemoryBench Signet provider, and needs proof that results did not get worse.
- Comparing Dreaming models or settings (provider, codemode, concurrency, input budget).
- A benchmark score dropped and the cause is unknown.
- Running full LongMemEval or BEAM for a number someone will cite.

## Workflows

Pick the workflow, then read its reference before running anything:

| Goal | Reference |
| --- | --- |
| Check that a change did not regress results (the default) | [`references/regression-check.md`](references/regression-check.md) |
| Run Dreaming on another model, or check a prompt change across models | [`references/model-portability.md`](references/model-portability.md) |
| Find out why a score, retrieval metric, or claim count moved | [`references/diagnosing-results.md`](references/diagnosing-results.md) |
| Full LongMemEval or BEAM runs, published numbers, cost estimates | [`references/full-runs.md`](references/full-runs.md) |

## Tools

All scripts run from the repository root with `bun` and only read their inputs:

- `scripts/run-summary.ts <runId>[=<workspace>] ...` prints score, Hit@K, MRR, entities, claims, Dreaming passes and tokens, and wall time side by side. `--append --note "..."` records the runs in the ledger.
- `scripts/pass-inspect.ts <workspace>` summarizes Dreaming passes: outcomes, tool-call failures, grouped filing errors, exclusion reasons, graph size per scope, and the latest pass logs.
- `scripts/recall-eval.ts --run <runId> --workspace <workspace>` replays a finished run's questions through recall on a copy of its workspace and reports gold-session and answer ranks. Use it to separate a filing miss from a ranking miss without rerunning Dreaming.

A `<workspace>` is the bench workspace root printed as `MemoryBench workspace:` (it contains `agents/` and `home/`); keep it with `--keep-workspace`.

## Results ledger

`results/ledger.jsonl` is the record of benchmark runs, one JSON object per line. Before a run, read the latest comparable entries (same benchmark, sample, and Dreaming model) to pick the baseline. After a run finishes, append it with `run-summary.ts --append --note "<what the run tested>"` before changing any code, so the recorded commit and dirty flag describe what ran. Record failed and aborted runs too when they taught something; say so in the note. `docs/BENCHMARKING-PROGRESS.md` is a historical log from an older harness and is no longer appended to.

## Hard rules

**Secrets**
- Never print, log, echo, or commit an API key, OAuth token, or credential. Keys live in the gitignored `memorybench/.env`, which the bench loads itself; do not read it aloud or copy it elsewhere.
- Never read credentials out of a user's own Signet install (`~/.agents`) or copy its secrets store into a bench workspace.
- OAuth and subscription sign-ins (for example ChatGPT for `openai-codex`) are done by a human in the bench daemon's dashboard. Agents start the daemon, give the human the URL, and wait; they never drive the sign-in flow.

**Subscription and provider limits**
- Cap Dreaming concurrency on subscription plans: ChatGPT plans at 8 to 12 concurrent passes (`SIGNET_BENCH_DREAMING_CONCURRENCY`), never more.
- Z.ai coding plans throttle bursts with HTTP 429 code 1302. Concurrency spends no extra quota, but more throttling means slower passes; the default of 6 is the tested setting.

**Workspace hygiene**
- Run only in isolated temporary workspaces created by `bun run bench`. Never point the bench at a user's real Signet workspace.
- MemoryBench's Signet provider does not clear data between runs (`clear()` is a no-op; the workspace owns cleanup). Reusing a workspace means stopping its daemon and moving `agents/data/signet.db*` and `agents/transcripts` aside before the next run; otherwise the old run's backlog competes with the new one. Move, do not delete, so the old run stays inspectable.
- Stop every daemon you start. A bench run that is interrupted can leave its daemon on the port; check before starting another run on it.

**Honest reporting**
- A six-question smoke is a regression signal, not a benchmark result. Never quote it as Signet's score.
- One question flipping on a six-question smoke is within run-to-run noise. A change helps only when it beats the baseline beyond that noise, ideally repeated or confirmed with `recall-eval.ts`; say when a conclusion rests on one run.
- Read the judge's verdicts, not only the totals. A judge can mark an answer correct that does not contain the answer; report the honest count alongside the reported one.
- Report score, Hit@K, MRR, claim count, tokens, and wall time together. Speed bought by filing less is not a speedup.
- When a required run could not be done (no provider access, quota, time), say which run is missing instead of implying it passed.
