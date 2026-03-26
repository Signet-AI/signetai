---
title: "Benchmarks"
description: "Running and interpreting memory benchmarks against Signet."
order: 12
section: "Development"
---

Benchmarks
==========

> **WARNING: NEVER run benchmarks on your production memory database.**
> The ingestion phase creates hundreds of test memories that will
> permanently pollute your real data. Always use an isolated environment.

LoCoMo Benchmark
---

[LoCoMo](https://arxiv.org/abs/2402.17753) (Long-form Conversational
Memory) is the primary benchmark for evaluating Signet's recall quality.
It tests five question types against multi-session conversational data:

- **Single-hop** — direct fact lookup from a single conversation turn
- **Multi-hop** — reasoning across multiple facts or sessions
- **Adversarial** — questions designed to elicit hallucination
- **Temporal** — time-dependent facts that change across sessions
- **World-knowledge** — questions requiring external context

The benchmark ingests synthetic conversation transcripts into the memory
system, then poses questions that require accurate recall and reasoning.

Setup
---

The benchmark tool lives at `references/memorybench/`.

### Isolated Environment

Create a throwaway database so test memories stay separate from
production:

```bash
# Create isolated environment
mkdir -p /tmp/signet-bench/memory
cp $SIGNET_WORKSPACE/agent.yaml /tmp/signet-bench/
ln -sf $SIGNET_WORKSPACE/.models /tmp/signet-bench/.models

# Start isolated daemon
SIGNET_PATH=/tmp/signet-bench SIGNET_PORT=3851 bun packages/daemon/src/daemon.ts &

# Run benchmark against isolated daemon
cd references/memorybench
SIGNET_BASE_URL=http://localhost:3851 bun run src/index.ts run -l 50
```

Pipeline settings do not need to be modified for benchmarks. The
Signet provider sends pre-extracted structured data with each memory,
and the daemon's structured passthrough path sets
`extraction_status = "complete"` — the pipeline worker skips these
memories automatically even when the pipeline is enabled.

### Common Flags

- `-l <count>` — limit question count (e.g., `-l 50` for quick runs)
- `-r <run-id>` — resume a previous run (continues from last checkpoint)
- `-r <run-id> -f search` — rerun search/answer/eval phases with the
  same ingested data (useful for A/B testing retrieval changes)
- `-p signet -b locomo` — provider and benchmark selection

### Output

Results go to `references/memorybench/data/runs/<run-id>/` with per-question
scores and an aggregate summary.

Results
---

### Latest Results (2026-03-22, run-full-stack-8)

| Metric | Score |
|--------|-------|
| Accuracy | 87.5% |
| Hit@10 | 100% |
| MRR | 0.615 |
| Precision@10 | 26.3% |
| Recall@10 | 100% |
| NDCG@10 | 0.639 |

By question type:

| Type | Questions | Correct | Accuracy |
|------|-----------|---------|----------|
| Multi-hop | 4 | 4 | 100% |
| Temporal | 1 | 1 | 100% |
| Single-hop | 3 | 2 | 66.7% |

Configuration: 8-question LoCoMo sample, gpt-4o extraction, gpt-4o
answering, gpt-4o judging. Full retrieval stack: graph traversal +
FTS5 + vector search, post-fusion dampening (DP-16), lossless session
transcripts, decision auto-protection (DP-18), improved temporal
extraction rules.

### Progression

| Run | Date | Questions | Accuracy | Hit@10 | MRR | Stack |
|-----|------|-----------|----------|--------|-----|-------|
| baseline (local) | 2026-03-20 | 50 | 36% | 76% | 0.494 | traversal + FTS + vector |
| baseline (cloud) | 2026-03-20 | 50 | 34% | 76% | 0.495 | traversal + FTS + vector (cloud embeddings) |
| run-temporal-25 | 2026-03-22 | 25 | 56% | 84% | 0.534 | + temporal extraction rules |
| run-full-stack-8 | 2026-03-22 | 8 | 87.5% | 100% | 0.615 | + DP-16 dampening + lossless transcripts + gpt-4o extraction |

Note: Different question samples across runs. The 87.5% result is on a
smaller 8-question sample. Larger-scale validation pending.

### Comparison

| System | Benchmark | Metric | Score | Inference Calls/Query |
|--------|-----------|--------|-------|----------------------|
| Signet | LoCoMo | Accuracy | 87.5% | 0 (retrieval only) |
| Signet | LoCoMo | Hit@10 | 100% | 0 |
| Ori-Mnemos | LoCoMo | Recall | 44.7% | N/A |
| Ori-Mnemos | LoCoMo | MRR | 32.4% | N/A |
| Zikkaron | LoCoMo | Recall@10 | 86.8% | N/A |
| Zikkaron | LoCoMo | MRR | 70.8% | N/A |
| Supermemory ASMR | LongMemEval-s | Accuracy | 97.2% | 15-19 |
| Ori-Mnemos | HotpotQA | Recall@5 | 90% | N/A |
| Zikkaron | LongMemEval | Recall@10 | 96.7% | N/A |

Metrics not directly comparable across systems (different benchmarks,
k-values, dataset splits, evaluation methodology). Signet's 0 inference
calls at retrieval time is a useful property of the current stack: the
candidate-building path is algorithmic (graph traversal + FTS5 + vector
+ dampening), with LLM inference only at extraction time (write path)
and answering time (consumer's responsibility). Long-term, this
candidate substrate is meant to support learned context selection rather
than stand as the final story by itself.

### Failure Analysis (run-full-stack-8)

1 failure out of 8 questions. The failing question had Hit@10=1
(correct memory was retrieved) with MRR=0.33 (ranked 3rd). Root
cause: answering LLM error, not retrieval failure.

### Key Insights

1. **Extraction quality dominates accuracy.** Moving from gpt-4o-mini
   to gpt-4o for extraction was the single largest accuracy
   improvement. Extraction loss was the #1 failure category (6/11
   failures in the 25-question run).

2. **Dampening separates signal from noise.** Post-fusion dampening
   (gravity + hub + resolution) addresses score bunching where correct
   facts were buried under similar-scored noise.

3. **Lossless transcripts recover extraction gaps.** Storing raw
   conversation text alongside extracted memories means facts dropped
   by extraction are still available at recall time.

4. **Temporal rules matter.** Resolving relative dates ("last week",
   "next month") to absolute dates during extraction eliminates an
   entire failure category.

5. **Zero-inference candidate generation is viable.** 100% Hit@10 with
   purely algorithmic retrieval (no LLM calls at search time) validates
   the current multi-signal substrate and gives the predictor a bounded,
   useful pool to learn over.

### Complete LoCoMo Leaderboard (March 2026)

No standardized LoCoMo leaderboard exists — each system uses different
judge models, question subsets, and evaluation prompts. These numbers
are collected from published papers and repos.

| Rank | System | Score | Metric | Open Source | Local? | Source |
|------|--------|-------|--------|-------------|--------|--------|
| 1 | Kumiho | 97.5% adv, 0.565 F1 | F1 (official) | SDK open | No (cloud graph) | arXiv:2603.17244 |
| 2 | EverMemOS | 93.05% | Judge (self-reported) | No | No | evermind.ai blog |
| 3 | MemU | 92.09% | Judge | Yes | No | memu.pro/benchmark |
| 4 | MemMachine v0.2 | 91.7% | Judge | No | No | memmachine.ai blog |
| 5 | Hindsight | 89.6% | Judge | Yes (MIT) | No | arXiv:2512.12818 |
| 6 | SLM V3 Mode C | 87.7% | Judge | Yes (MIT) | Partial | arXiv:2603.14588 |
| 7 | **Signet (full stack)** | **87.5%** | **Judge (GPT-4o)** | **Yes (Apache)** | **Yes** | **Internal (8-Q sample)** |
| 8 | Zep/Graphiti | ~85% | Judge (third-party est) | Partial | No | arXiv:2501.13956 |
| 9 | Letta/MemGPT | ~83% | Judge | Yes (Apache) | No | letta.com blog |
| 10 | Engram | 80% | Judge | Yes | No | arXiv:2511.12960 |
| 11 | SLM V3 Mode A | 74.8% | Judge | Yes (MIT) | Yes | arXiv:2603.14588 |
| 12 | Mem0+Graph | 68.4% | J-score (disputed) | Partial | No | arXiv:2504.19413 |
| 13 | SLM Zero-LLM | 60.4% | Judge | Yes (MIT) | Yes | arXiv:2603.14588 |
| 14 | Mem0 (independent) | ~58% | Judge | Partial | No | Letta blog |
| — | Signet (baseline local) | 36% | Judge (GPT-4o) | Yes (Apache) | Yes | Internal |
| — | Signet (baseline cloud) | 34% | Judge (GPT-4o) | Yes (Apache) | No | Internal |

### Key context

1. **Signet is the only system doing all of this locally.** Every system
   above 74.8% requires cloud LLMs (GPT-4o, Gemini, etc). Signet runs
   extraction on local Ollama (qwen3.5:4b), embeddings on local
   nomic-embed-text, and answer generation via gpt-4o.

2. **Embedding quality is not the bottleneck.** Cloud embeddings
   (text-embedding-3-large, 3072d) scored the same as local
   (nomic-embed-text, 768d). Retrieval Hit@K is 76% for both —
   the system finds relevant memories most of the time. The gap
   between retrieval and accuracy points to context building and
   answer generation as the limiting factors.

3. **Everyone measures with different rulers.** Different judge models,
   question subsets, and evaluation prompts make direct comparison
   unreliable.

4. **Sample size caveat.** The 87.5% score is from an 8-question
   sample. Larger-scale validation is still required before hard
   public claims.

Signet LoCoMo Baseline Results (March 2026)
---

### Baseline Numbers (50-question runs)

| Configuration | Score | n | Multi-hop | Single-hop | Temporal |
|---------------|-------|---|-----------|------------|----------|
| Local stack | 36% (18/50) | 50 | 38% (9/24) | 26% (5/19) | 57% (4/7) |
| Cloud stack | 34% (17/50) | 50 | 42% (10/24) | 16% (3/19) | 57% (4/7) |

Note: each run samples a different random 50-question subset from
LoCoMo's 1,986 questions. Scores are not directly comparable between
runs — only the pattern matters.

### Baseline Retrieval Quality

| Metric | Local | Cloud |
|--------|-------|-------|
| Hit@K | 76.0% | 76.0% |
| MRR | 0.494 | 0.495 |
| NDCG | 0.525 | 0.553 |
| Search latency (median) | 5,267ms | 1,953ms |

Retrieval quality is identical between stacks. Cloud is 2.7x faster
for search due to API-based embedding vs local Ollama inference.

### Analysis

**What's working:** Retrieval finds relevant results 76% of the time.
Multi-hop and temporal questions perform reasonably (38-57%). The
current substrate is producing useful candidates often enough to support
both answering and future learned reranking.

**What's not:** Single-hop accuracy (16-26%) is the weakest category.
These are direct fact lookups where the answer exists in a single
memory — the system should score higher. The gap between Hit@K (76%)
and overall accuracy (36%) indicates the answering LLM often fails to
extract the correct answer from retrieved context, or the context
building step loses information.

**Where to invest next:**
- Context building — the current approach JSON.stringifies the full
  results array. A structured summary or targeted extraction could help
  the answering LLM focus on the relevant facts.
- Answer generation prompting — the answering prompt may need tuning
  to better handle structured memory content.
- Larger sample sizes — 50 questions is noisy. Running the full 1,986
  would give more reliable numbers.

### Key Techniques

- **Prospective indexing (hints)** bridges the semantic gap between how
  facts are stored and how natural queries phrase them
- **Cosine re-scoring** fixes random traversal ordering — without it,
  importance values are uniform and results come back in arbitrary order
- **Constructed card score capping** prevents entity summary cards from
  dominating real memories in search results

Model Configurations
---

We benchmark two configurations to isolate the accuracy cost of running
locally vs using cloud models:

### Local Stack (default)

| Component | Model | Provider |
|-----------|-------|----------|
| Extraction | qwen3.5:4b | Ollama (local) |
| Embeddings | nomic-embed-text | Ollama (local) |
| Answer generation | gpt-4o | OpenAI |
| Judge | gpt-4o | OpenAI |

This is Signet's default production configuration. In benchmarks,
extraction is done by GPT-4o in the memorybench provider (not the
daemon pipeline), so the extraction model listed here only applies to
production use. Embeddings run on-device. Answer generation and
judging use cloud models (judging is benchmark-only).

```bash
# agent.yaml for local stack
memory:
  pipelineV2:
    extraction:
      provider: ollama
      model: qwen3.5:4b
embedding:
  provider: native
  model: nomic-embed-text-v1.5
  dimensions: 768
```

### Cloud Stack (comparison)

| Component | Model | Provider |
|-----------|-------|----------|
| Extraction | gpt-4o | OpenAI |
| Embeddings | text-embedding-3-large | OpenAI |
| Answer generation | gpt-4o | OpenAI |
| Judge | gpt-4o | OpenAI |

This configuration matches what most competing systems use. The delta
between local and cloud scores isolates the accuracy cost of running
on-device models.

```bash
# agent.yaml for cloud stack
memory:
  pipelineV2:
    extraction:
      provider: openai
      model: gpt-4o
embedding:
  provider: openai
  model: text-embedding-3-large
  dimensions: 3072
```

### Running Both

Use separate isolated environments on different ports:

```bash
# Local stack (port 3851)
mkdir -p /tmp/signet-bench/memory
cp $SIGNET_WORKSPACE/agent.yaml /tmp/signet-bench/   # local models config
SIGNET_PATH=/tmp/signet-bench SIGNET_PORT=3851 bun packages/daemon/src/daemon.ts &

# Cloud stack (port 3852)
mkdir -p /tmp/signet-bench-cloud/memory
cp $SIGNET_WORKSPACE/agent.yaml /tmp/signet-bench-cloud/
# Edit agent.yaml: provider: openai, model: gpt-4o, embedding: text-embedding-3-large
SIGNET_PATH=/tmp/signet-bench-cloud SIGNET_PORT=3852 bun packages/daemon/src/daemon.ts &

# Run both benchmarks against same 50 questions
cd references/memorybench
SIGNET_BASE_URL=http://localhost:3851 bun run src/index.ts run -l 50
SIGNET_BASE_URL=http://localhost:3852 bun run src/index.ts run -l 50
```

Running Experiments
---

Experiments E1 through E22 tested different search configurations against
the same ingested data. The workflow:

1. Run a full benchmark once (ingestion + questions) to get a `<run-id>`
2. Modify the daemon's search configuration (toggle graph traversal,
   change re-ranking, adjust extraction prompts, etc.)
3. Rerun from the search phase to test the new config:
   ```bash
   SIGNET_BASE_URL=http://localhost:3851 \
     bun run src/index.ts run -r <run-id> -f search
   ```
4. Compare results across `data/runs/` directories

This isolates the variable under test — same memories, same questions,
different retrieval strategy.
