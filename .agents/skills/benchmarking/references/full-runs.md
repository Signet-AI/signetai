# Full runs

Full LongMemEval and BEAM runs produce numbers people may cite, so they follow stricter rules than a smoke.

## Before running

- Read `web/docs/src/content/docs/benchmarking.md` and `memorybench/README.md` for current commands, profiles, and options. BEAM details are in `memorybench/src/benchmarks/README.md`; judge rules are in `memorybench/src/judges/README.md`.
- Estimate the cost with the cost model below and get approval for the spend before starting.
- Confirm provider limits for the whole run, not just a smoke: subscription rate limits, coding-plan weekly quotas, and throttling at the chosen concurrency.

## Cost model

Dreaming dominates the cost of a run; answering and judging are well under 1% of it. Dreaming cost scales with the amount of conversation history ingested, so estimate it per million history tokens (counted with `o200k_base`, the tokenizer MemoryBench reports with) and multiply by prices.

**History sizes**

| Benchmark | Questions | History tokens |
| --- | ---: | ---: |
| LongMemEval smoke (`--sample 1`) | 6 | 0.62M |
| LongMemEval full (`--full`) | 500 | 51.3M |
| BEAM 1M | 700 (35 chats) | 36.1M |
| BEAM 10M | 200 (10 chats) | about 100M (nominal) |

**Dreaming tokens per million history tokens** (GLM-5.3-Flash, codemode off, from `smoke-lme-6k`, `6l`, and `6n`, plus 7% for passes that reported no usage):

| Fresh input | Output | Cached input |
| ---: | ---: | ---: |
| 5.1M | 1.4M | 79M |

Cost ≈ history (millions) × (5.1 × input price + 1.4 × output price + 79 × cached price), with prices per million tokens. At Z.ai's October 2026 list price for GLM-5.3-Flash ($0.15 input, $0.50 output, $0.03 cached) that is about $3.85 per million history tokens: roughly $200 for full LongMemEval, $140 for BEAM 1M, and $385 for BEAM 10M.

Recompute the rates from the ledger's most recent comparable runs (`dreamingInputTokens`, `dreamingOutputTokens`, `dreamingCacheReadTokens`, divided by the run's history size) whenever the Dreaming prompt, model, or settings change, and check current provider prices rather than reusing these.

What moves the estimate:

- **Prompt caching.** Cached input is about 94% of Dreaming's input tokens. A provider without prompt caching bills those at the full input price and costs about 3.5 times as much. Pin a provider that caches; marketplace routing can silently land on one that does not, or on a quantized deployment.
- **BEAM's history shape.** LongMemEval is many independent ~100k-token histories like the smoke's, so it scales close to linearly. A BEAM chat is one history of 1M tokens or more, and per-pass context grows with its graph, so cached tokens may grow faster than linearly. Before a full BEAM run, run one chat and measure the rate.
- **Coding plans.** One GLM smoke used about 1% of a Z.ai coding plan's weekly allowance, so a full LongMemEval run takes most of a week's quota. Use a pay-per-token API for full runs.
- **Wall time.** A smoke takes about 70 minutes at 6 concurrent passes; full LongMemEval at that concurrency takes days. Raise `SIGNET_BENCH_DREAMING_CONCURRENCY` within the provider's rate limits.

## LongMemEval

`--full` runs every question instead of the six-question sample. Runs checkpoint per question; resume with `-r <run-id>` and no `--force` after an interruption, and never mix code changes into a resumed run.

## BEAM

Prepare the pinned dataset with `bun run src/index.ts beam prepare` (from `memorybench/`), which verifies its hash. The `paper` profile requires the paper's judge and allowed Top-K values and fails before ingest otherwise; a score from any other judge is a `custom-judge` rubric score and must not be labeled a paper score. A BEAM conversation is shared by its questions, so it is ingested and dreamed once per conversation.

## Reporting

- Results are not published until the team decides to publish them. Run artifacts under `memorybench/data/runs/` stay uncommitted.
- Append the run to the ledger with a note that names the profile, judge, sample, and anything nonstandard.
- Report the configuration with the number: benchmark and profile, question count, answering model, judge, Dreaming model and settings, commit, and the honest count where the judge erred.
