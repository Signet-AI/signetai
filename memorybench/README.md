# MemoryBench

A pluggable benchmarking framework for evaluating memory and context systems.

<img width="3584" height="2154" alt="original" src="https://github.com/user-attachments/assets/7fe49b7e-ed0b-4861-92a5-fa5d199cfc72" />


## Features

- 🔌 Interoperable: mix and match any provider with any benchmark
- 🧩 Bring your own benchmarks: plug in custom datasets and tasks
- ♻️ Checkpointed runs: resume from any pipeline stage (ingest → index → search → answer → evaluate)
- 🆚 Multi‑provider comparison: run the same benchmark across providers side‑by‑side
- 🧪 Judge‑agnostic: swap GPT‑4o, Claude, Gemini, etc. without code changes
- 📊 Structured reports: export run status, failures, and metrics for analysis
- 🖥️ Web UI: inspect runs, questions, and failures interactively, in real-time!


```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  Benchmarks │    │  Providers  │    │   Judges    │
│  (LoCoMo,   │    │ (Supermem,  │    │  (GPT-4o,   │
│  LongMem..) │    │  Mem0, Zep) │    │  Claude..)  │
└──────┬──────┘    └──────┬──────┘    └──────┬──────┘
       └──────────────────┼──────────────────┘
                         ▼
             ┌───────────────────────┐
             │      MemoryBench      │
             └───────────┬───────────┘
                         ▼
   ┌────────┬─────────┬────────┬──────────┬────────┐
   │ Ingest │ Indexing│ Search │  Answer  │Evaluate│
   └────────┴─────────┴────────┴──────────┴────────┘
```

## Quick Start

```bash
bun install
cp .env.example .env.local  # Add your API keys
bun run src/index.ts run -p supermemory -b locomo
```

## Configuration

```bash
# Providers (at least one)
SUPERMEMORY_API_KEY=
MEM0_API_KEY=
ZEP_API_KEY=

# Judges and answering models (at least one)
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GOOGLE_API_KEY=
ZAI_API_KEY=
# Optional: defaults to the GLM Coding Plan endpoint, https://open.bigmodel.cn/api/coding/paas/v4
ZAI_BASE_URL=
```

Every model role (answering, judging, and memory extraction through
`MEMORYBENCH_EXTRACTION_MODEL`) resolves through one client in
`src/utils/models.ts` and `src/utils/llm.ts`, so a run can use GLM end to end:

```bash
ZAI_API_KEY=... MEMORYBENCH_EXTRACTION_MODEL=glm-5.3-flash \
  bun run src/index.ts run -p filesystem -b longmemeval -m glm-5.3-flash -j glm-5.3-flash
```

| Alias | Request |
|-------|---------|
| `glm-5.3-flash` | Chat Completions, `thinking: disabled`, temperature 0, 1,000 output tokens |
| `glm-5.3-flash-thinking` | Chat Completions, `thinking: enabled`, no temperature, 16,000 output tokens |

Results produced with a different answering or judging model than a published
number are not a like-for-like comparison. Run the same-model baselines
(`filesystem`, `rag`) alongside Signet so the comparison that matters shares a
model.

## Commands

| Command | Description |
|---------|-------------|
| `run` | Full pipeline: ingest → index → search → answer → evaluate → report |
| `compare` | Run benchmark across multiple providers simultaneously |
| `ingest` | Ingest benchmark data into provider |
| `search` | Run search phase only |
| `test` | Test single question |
| `status` | Check run progress |
| `list-questions` | Browse benchmark questions |
| `show-failures` | Debug failed questions |
| `serve` | Start web UI |
| `beam prepare` | Download, verify, and convert the pinned public BEAM dataset |
| `help` | Show help (`help providers`, `help models`, `help benchmarks`) |

## Options

```
-p, --provider         Memory provider (supermemory, mem0, zep)
-b, --benchmark        Benchmark (locomo, longmemeval, convomem, beam-1m, beam-10m)
-j, --judge            Judge model (gpt-4o, sonnet-4, gemini-2.5-flash, etc.)
-r, --run-id           Run identifier (auto-generated if omitted)
-m, --answering-model  Model for answer generation (default: gpt-4o)
-l, --limit            Limit number of questions
-q, --question-id      Specific question (for test command)
--force                Clear checkpoint and restart
--data-path            Prepared BEAM snapshot root
--dataset-revision     BEAM dataset fingerprint printed by `beam prepare`
--retrieval-top-k      BEAM evidence count (paper profile: 5, 10, 15, 20; default 5)
--evaluation-profile   BEAM scoring: `paper` (default) or `custom-judge`
```

Benchmark options are stored in the checkpoint. A resumed run reuses them and
rejects a conflicting value instead of mixing two configurations in one report.

## Examples

```bash
# Full run
bun run src/index.ts run -p mem0 -b locomo

# With custom run ID
bun run src/index.ts run -p mem0 -b locomo -r my-test

# Resume existing run
bun run src/index.ts run -r my-test

# Limited questions
bun run src/index.ts run -p supermemory -b locomo -l 10

# Different models
bun run src/index.ts run -p zep -b longmemeval -j sonnet-4 -m gemini-2.5-flash

# Compare multiple providers
bun run src/index.ts compare -p supermemory,mem0,zep -b locomo -s 5

# Test single question
bun run src/index.ts test -r my-test -q question_42

# Debug
bun run src/index.ts status -r my-test
bun run src/index.ts show-failures -r my-test
```

## Pipeline

```
1. INGEST    Load benchmark sessions → Push to provider
2. INDEX     Wait for provider indexing
3. SEARCH    Query provider → Retrieve context
4. ANSWER    Build prompt → Generate answer via LLM
5. EVALUATE  Compare to ground truth → Score via judge
6. REPORT    Aggregate scores → Output accuracy + latency
```

Each phase checkpoints independently. Failed runs resume from last successful point.

## BEAM

BEAM (arXiv:2510.27246) tests ten memory abilities over 1M- and 10M-token
conversations. The adapter, dataset preparation, and scoring are ported from
the unmerged `codex/beam-integration-hardening` branch of
supermemoryai/memorybench and adapted to this harness.

```bash
bun run src/index.ts beam prepare --tiers 1M
bun run src/index.ts run -p signet -b beam-1m -m glm-5.3-flash -j glm-5.3-flash \
  --evaluation-profile custom-judge --data-path ./data/benchmarks/beam \
  --dataset-revision <fingerprint printed by beam prepare>
```

- `beam prepare` downloads the pinned Hugging Face revision, verifies its
  SHA-256, validates 35 chats / 700 questions for 1M (10 / 200 for 10M), and
  writes an immutable snapshot named by its fingerprint. Runs never download.
- The 20 questions of a conversation share one ingest. Sessions are ingested in
  order; provider readiness then applies.
- Questions are scored per rubric nugget (0, 0.5, or 1) with the paper's judge
  prompt; event ordering uses normalized Kendall tau-b. The score is the
  macro-average over the ten abilities; pass accuracy (score >= 0.5) is
  reported separately.
- The `paper` profile requires `gpt-4.1-mini` as judge and allows Top-K 5, 10,
  15, or 20. It reports `beamScore` only for a complete tier and
  `beamScorePartial` otherwise.
- The `custom-judge` profile uses the same prompts and scoring with any judge
  and Top-K 1-100, and reports `beamRubricScore`/`beamRubricScorePartial`, so a
  GLM-judged number is never labeled as a paper score.

BEAM-1M is about 36M tokens across 37,315 sessions. Budget ingest accordingly.

## Usage and cost

`report.json` records API-reported token usage for every model role:

| Field | Source |
|-------|--------|
| `usage.answer` | Answering model, summed per question |
| `usage.judge` | Judge model, including every rubric and retry call |
| `usage.extraction` | Harness-side memory extraction (filesystem, rag, signet structured) |
| `usage.dreaming` | Signet Dreaming passes observed through `/api/dream/status` |
| `estimatedCostUsd` | List-price estimate for models with pricing in `src/utils/models.ts` |

Requests whose response omitted usage are counted in `unreportedRequests`, and
no cost estimate is produced for them. Dreaming totals cover the passes the
provider observed while draining; `passesWithoutUsage` counts passes the daemon
reported without token accounting.

## MemScore

MemScore is a composite metric that captures three dimensions of provider performance in a single line:

```
accuracy% / latencyMs / contextTokens
```

| Component | What it measures |
|-----------|-----------------|
| **Quality** | Answer accuracy, or the benchmark's primary metric when it defines one (BEAM's rubric score) |
| **Latency** | Average search response time in milliseconds |
| **Tokens** | Average context tokens sent to the answering model (counted client-side; GLM uses the `o200k_base` tokenizer as a GPT-4o proxy, recorded as `contextTokenizer`) |

After a run completes, MemScore appears in the CLI summary:

```
Summary:
  Total Questions: 50
  Correct: 43
  Accuracy: 86.00%
  MemScore: 86% / 145ms / 1823tok
```

MemScore is intentionally a triple, not a single number — collapsing quality, latency, and cost into one score hides important tradeoffs. Use it to compare providers side-by-side on the same benchmark:

```bash
bun run src/index.ts compare -p supermemory,mem0,zep -b locomo -j gpt-4o
```

The `report.json` includes both a display string and structured `memscoreComponents` for programmatic use.

> **[Full MemScore documentation →](https://supermemory.ai/docs/memorybench/memscore)**

## Dreaming contract scenarios

`dreaming-scenarios` is a committed synthetic corpus for the canonical Signet
Dreaming path. It is deliberately separate from LongMemEval: it does not
download data and does not treat a mocked judge verdict as quality evidence.

Each scenario has fixed source text, scopes, relevant sessions, and exact
supporting quotes. The deterministic CI gate validates that the corpus is
well-formed and that the Signet Dreaming provider preserves per-session
transcript-capture and recall scopes. A live run still uses the ordinary
`signet-dreaming` provider and the standard MemoryBench evaluation/report
phases:

```bash
bun run src/index.ts run -p signet-dreaming -b dreaming-scenarios -r dreaming-contract
```

The gate has no production endpoint, model, or judge dependency. A scheduled
quality lane must pin its model and judge configuration and record a baseline
before it can make a pass/fail quality claim.

## Checkpointing

Runs persist to `data/runs/{runId}/`:
- `checkpoint.json` - Run state and progress
- `results/` - Search results per question
- `report.json` - Final report

Re-running same ID resumes. Use `--force` to restart.

## Extending

| Component | Guide |
|-----------|-------|
| Add Provider | [src/providers/README.md](src/providers/README.md) |
| Add Benchmark | [src/benchmarks/README.md](src/benchmarks/README.md) |
| Add Judge | [src/judges/README.md](src/judges/README.md) |
| Project Structure | [src/README.md](src/README.md) |

## License

MIT
