# Regression check

Use this after any change to Dreaming, recall, ingestion, or the MemoryBench Signet provider. It answers one question: are results at least as good as the last comparable run?

## 1. Pick the baseline

Read `results/ledger.jsonl` and take the most recent entry with the same benchmark (`longmemeval`), sample (six questions), and Dreaming model. If the entry's commit is far behind, or the ledger has no comparable entry, run the baseline yourself on the base commit first: an unmeasured baseline is not a baseline.

## 2. Run the smoke

The default smoke is one LongMemEval question per question type (six questions) with GLM-5.3-Flash on the Z.ai coding plan answering, judging, and Dreaming. `memorybench/.env` must define `ZAI_API_KEY`.

```bash
SIGNET_BENCH_DREAMING_WAIT_SECS=10800 \
  bun run bench --keep-workspace run -r <run-id> --force \
  -j glm-5.3-flash -m glm-5.3-flash -b longmemeval --sample 1
```

- Use a new, descriptive `<run-id>` per run. Run ids name the run's memory scopes, so reusing one mixes runs.
- Add `--no-build` only when the build is already current for the code under test.
- `--keep-workspace` keeps the workspace for `pass-inspect.ts` and `recall-eval.ts`; note the `MemoryBench workspace:` line it prints.
- Dreaming settings come from environment variables read by `scripts/bench-memory.ts`, for example `SIGNET_BENCH_DREAMING_CODEMODE=1` and `SIGNET_BENCH_DREAMING_CONCURRENCY`. Keep them identical to the baseline unless they are what you are testing.
- A run takes roughly an hour on GLM. Run it in the background and check on it; do not poll in a tight loop.
- Independent runs (for example a GLM regression run and an OpenAI-model run) can run at the same time; each gets its own workspace and port.

The harness drains Dreaming before answering and aborts if Dreaming applies no mutations for many consecutive passes. An abort is a result: inspect it (see `diagnosing-results.md`) rather than rerunning blindly.

## 3. Compare

```bash
bun .agents/skills/benchmarking/scripts/run-summary.ts \
  <baseline-run>=<baseline-workspace> <new-run>=<new-workspace>
```

Read the result across all columns:

- **Score**: a one-question change on six questions is noise unless the retrieval columns move with it.
- **Hit@K and MRR**: whether gold sessions are recalled and how high. A drop here with a stable score is still a regression.
- **Entities and claims**: what Dreaming filed. A large drop usually explains a retrieval drop.
- **Dreaming tokens and wall time**: cost. Fewer tokens or less time with less filing is not an improvement.

If any column regressed beyond noise, diagnose before claiming the change is safe.

## 4. Record

Append the run right after it finishes, before changing code:

```bash
bun .agents/skills/benchmarking/scripts/run-summary.ts <new-run>=<new-workspace> \
  --append --note "<the change under test and the verdict>"
```

Report the comparison table, the verdict, and any run you could not do.
