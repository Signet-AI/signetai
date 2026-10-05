# Full runs

Full LongMemEval and BEAM runs produce numbers people may cite, so they follow stricter rules than a smoke.

## Before running

- Read `web/docs/src/content/docs/benchmarking.md` and `memorybench/README.md` for current commands, profiles, and options. BEAM details are in `memorybench/src/benchmarks/README.md`; judge rules are in `memorybench/src/judges/README.md`.
- Estimate cost from a comparable smoke: the ledger's Dreaming tokens per question, times the number of questions, plus answer and judge usage from the smoke's `report.json` (`usage`). Get approval for the spend before starting.
- Confirm provider limits for the whole run, not just a smoke: subscription rate limits, coding-plan weekly quotas, and throttling at the chosen concurrency.

## LongMemEval

`--full` runs every question instead of the six-question sample. Runs checkpoint per question; resume with `-r <run-id>` and no `--force` after an interruption, and never mix code changes into a resumed run.

## BEAM

Prepare the pinned dataset with `bun run src/index.ts beam prepare` (from `memorybench/`), which verifies its hash. The `paper` profile requires the paper's judge and allowed Top-K values and fails before ingest otherwise; a score from any other judge is a `custom-judge` rubric score and must not be labeled a paper score. A BEAM conversation is shared by its questions, so it is ingested and dreamed once per conversation.

## Reporting

- Results are not published until the team decides to publish them. Run artifacts under `memorybench/data/runs/` stay uncommitted.
- Append the run to the ledger with a note that names the profile, judge, sample, and anything nonstandard.
- Report the configuration with the number: benchmark and profile, question count, answering model, judge, Dreaming model and settings, commit, and the honest count where the judge erred.
