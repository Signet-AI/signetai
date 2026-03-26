---
title: AI Agent Memory Landscape — Deep Research (March 2026)
date: 2026-03-22
source: SearXNG + Lightpanda (blog posts, arxiv papers, product pages, Reddit, press)
section: "Research"
order: 91
question: "What is the current state of the agent memory competitive landscape, with benchmarks, architectures, and costs?"
informs: ["competitive-landscape"]
---

# AI Agent Memory Landscape — Comprehensive Research (March 22, 2026)

## Executive Summary

The agent memory space has exploded in Q1 2026. At least 8 serious systems now
compete on LongMemEval, with scores climbing from ~60% (full-context GPT-4o
baseline) to ~99% (Supermemory ASMR experimental). The field is splitting into
three architectural camps: **agentic retrieval** (Supermemory ASMR, Letta),
**temporal knowledge graphs** (Zep/Graphiti), and **observational compression**
(Mastra OM). A fourth approach -- **hybrid extract+graph** -- is used by Mem0,
Hindsight, and MemMachine.

The open space for Signet is narrower and more specific: use structured
memory, continuity data, and agent-in-the-loop feedback to build a system
that learns what context should be surfaced automatically, not merely how to
store and retrieve more of it.

---

## 1. The Benchmarks

### LongMemEval (ICLR 2025)

- **Source:** UCLA + Tencent AI Lab (Di Wu et al.), arXiv:2410.10813
- **URL:** https://xiaowu0162.github.io/long-mem-eval/
- **What it tests:** 500 human-curated QA pairs across 5 abilities:
  1. Information extraction (single-session user/assistant/preference facts)
  2. Multi-session reasoning (synthesize across sessions)
  3. Knowledge updates (recognize changed facts)
  4. Temporal reasoning (time-aware queries)
  5. Abstention (refuse when information not present)
- **Two scales:**
  - LongMemEval_S: ~115k tokens per question (~30-40 sessions)
  - LongMemEval_M: ~1.5M tokens per question (~500 sessions)
- **Key finding:** Long-context LLMs show 30-60% performance drop. Even GPT-4o
  with full context only gets ~60.2%. "Even the most capable long-context LLMs
  currently would require an effective memory mechanism."
- **Design insights from the paper:**
  - Round-level granularity > session-level for storage
  - Expanding index keys with extracted user facts: +4% recall, +5% accuracy
  - Time-aware indexing + query expansion: +7-11% temporal recall
  - Chain-of-Note + structured JSON prompt: +10 points reading accuracy
- **Criticism:** Only tests ~40 sessions per question. Does not test 1000+
  session scaling. OMEGA's MemoryStress benchmark (1000 sessions) reportedly
  craters scores. Benchmark does not capture production concerns: latency,
  cost, concurrent users, failure recovery.

### LoCoMo (ACL 2024)

- **Source:** Snap Research (Maharana et al.), arXiv:2402.17753
- **URL:** https://snap-research.github.io/locomo/
- **What it tests:** QA over long conversations between two fictional speakers.
  4 categories used in most evaluations:
  1. Multi-hop (synthesize across sessions)
  2. Temporal reasoning
  3. Open-domain (integrate with world knowledge)
  4. Single-hop (direct fact recall)
- **Dataset:** 10 conversations, ~1540 questions total (4 categories).
  Average conversation ~600 turns.
- **Key distinction from LongMemEval:** LoCoMo tests conversation between
  two speakers; LongMemEval tests user-assistant interaction. LoCoMo has
  fewer questions but longer individual conversations. LoCoMo includes
  event summarization and multi-modal dialog tasks beyond just QA.
- **Criticism from Letta:** Mem0 published controversial benchmark results
  claiming to have run MemGPT/Letta on LoCoMo, but Letta's team "was
  unable to determine a way to backfill LoCoMo data into MemGPT/Letta
  without significant refactoring." Mem0 did not respond to GitHub issue
  #3004 requesting clarification. Letta views LoCoMo as primarily a
  retrieval benchmark, not an agentic memory benchmark.

### Other Benchmarks

- **DMR (Deep Memory Retrieval):** Established by Letta/MemGPT team. Zep
  showed it was too easy for modern LLMs -- gpt-4o-mini and gpt-4-turbo
  both surpassed MemGPT's reported results with full context in window.
- **Letta Leaderboard / Context-Bench:** Evaluates how well LLMs manage
  agentic memory. Keeps framework (Letta) and tools constant, varies
  the model. Tests memory in dynamic context, not just retrieval.
- **Terminal-Bench:** Long-running coding tasks that require memory to
  track state/progress. Letta's OSS agent is #1 for OSS, #4 overall.
- **MemoryStress (OMEGA):** 1000-session stress test. Numbers reportedly
  crater compared to LongMemEval's ~40 sessions.

---

## 2. The Competitors

### 2.1 Supermemory

- **URL:** https://supermemory.ai
- **GitHub:** https://github.com/supermemoryai/supermemory
- **Founder:** Dhravya Shah, 20 years old. Dropped out of Arizona State.
- **Funding:** $3M seed from Jeff Dean (Google AI chief), Dane Knecht
  (Cloudflare CTO), David Cramer (Sentry founder). Source: TechCrunch
  Oct 2025.
- **Products:** Cloud memory API, plugins for Claude Code, Cursor,
  OpenCode. MemoryBench benchmarking framework.

**Architecture (Production):**
- Cloud-hosted memory API
- Vector embeddings + structured extraction
- Production score: ~85% on LongMemEval_S (reported Sep 2025)

**Architecture (ASMR -- Experimental, published March 22, 2026):**
- ASMR = "Agentic Search and Memory Retrieval"
- **No vector database.** Replaces embedding similarity with active
  agent reasoning.
- **Ingestion:** 3 parallel "reader" agents (Gemini 2.0 Flash) process
  raw sessions concurrently (agent 1 takes sessions 1,3,5; agent 2
  takes 2,4,6). Extract structured knowledge across 6 vectors: Personal
  Info, Preferences, Events, Temporal Data, Updates, Assistant Info.
- **Retrieval:** 3 parallel "search" agents fan out across findings:
  - Agent 1: direct facts and explicit statements
  - Agent 2: related context, social cues, implications
  - Agent 3: temporal timelines and relationship maps
- **Answering (Run 1 -- 98.6%):** 8 specialized prompt variants in
  parallel (Precise Counter, Time Specialist, Context Deep Dive, etc.).
  If ANY of 8 gets the right answer, question counts as correct.
  **This is a generous scoring methodology.**
- **Answering (Run 2 -- 97.2%):** 12 specialist agents (GPT-4o-mini)
  feed into an aggregator LLM for single consensus answer via majority
  voting. More defensible as real-world metric.

**Benchmark Results (LongMemEval_S):**
| Config | Model | Score |
|---|---|---|
| Production | gpt-4o | 81.6% |
| Production | gpt-5 | 84.6% |
| Production | gemini-3 | 85.2% |
| ASMR 8-ensemble | mixed | 98.6% |
| ASMR 12-forest | GPT-4o-mini | 97.2% |

**Cost/Latency Implications:**
- ASMR fires 6 parallel agents for ingestion, 3 for search, then 8-12
  for answering. Per-query compute is enormous.
- Shah acknowledged this is experimental, not production. "This is not
  our main production Supermemory engine (yet)."
- Open-source release promised early April 2026.

**Critical Assessment (from aiHola):**
- "Eight independent shots at each question, and you only need one hit.
  That is a generous scoring methodology."
- "You're swapping one cost (embedding storage and retrieval) for
  another (a dozen frontier-model API calls per query)."
- Production outage March 6, 2026 from API key tracking queries under
  heavy load -- "the kind of real-world scaling problem benchmarks
  don't capture."

**What it DOES NOT do:** Identity files, personality persistence,
predictive memory, skill management, harness-specific config generation,
git sync, knowledge graph pruning, local-first operation.

---

### 2.2 Mem0

- **URL:** https://mem0.ai
- **GitHub:** https://github.com/mem0ai/mem0 (~48K stars as of March 2026)
- **Paper:** arXiv:2504.19413 (accepted at ECAI)
- **Products:** Mem0 Platform (managed cloud), Mem0 Open Source
  (self-hosted), OpenMemory (team workspace)

**Architecture:**
- Dynamic extraction, consolidation, and retrieval from conversations
- Base: vector embeddings with LLM-based extraction
- Enhanced variant (Mem0_g): graph-based memory representations for
  complex relational structures. Graph memory locked behind Pro tier.
- Supports 20+ framework integrations (LangChain, CrewAI, Vercel AI SDK)
- Python and TypeScript SDKs

**Benchmark Results (from their ECAI paper on LoCoMo):**
- 26% higher response accuracy vs OpenAI's memory
- 91% lower p95 latency vs full-context
- 90%+ token cost savings vs full-context
- Mem0_g (with graph): ~2% higher than base config
- LoCoMo overall: ~68.5% (as reported by competitors using their eval code)
  -- though Mem0's own paper claims higher numbers.

**Controversy:**
- Letta directly challenged Mem0's benchmark claims: "Mem0 published
  controversial results claiming to have run MemGPT on LoCoMo... did not
  respond to requests for clarification on how the benchmarking numbers
  were computed" (GitHub issue #3004 unanswered).
- Reddit thread: "Lies, Damn Lies, & Statistics: Is Mem0 Really SOTA in
  Agent Memory?" -- questioning methodology.
- MemMachine showed Mem0 using 4.6x more tokens (19.2M vs 4.2M input
  tokens) to achieve lower scores on LoCoMo with gpt-4.1-mini.

**Pricing:**
- Open source: self-hosted, bring your own infra
- Platform: managed cloud (pricing not publicly listed, contact sales)
- Graph memory requires paid tier
- Compare: OMEGA claims Mem0's graph is $249/mo

**What it DOES NOT do:** Identity files, personality, harness configs,
local-first without self-hosting setup, predictive scoring, skill
management, git sync.

---

### 2.3 Zep

- **URL:** https://www.getzep.com
- **GitHub:** https://github.com/getzep/graphiti (open source library)
- **Paper:** arXiv:2501.13956 "Zep: A Temporal Knowledge Graph
  Architecture for Agent Memory"

**Architecture:**
- **Temporal knowledge graph** built continuously from user interactions
  and business data
- **Graphiti** is the open-source library underneath -- builds dynamic,
  temporally-aware knowledge graphs
- Entities, relationships, and facts with temporal versioning
- When facts change/are superseded, graph updates to reflect new state
- Ingests both unstructured and structured data
- Query fusion: time + full-text + semantic + graph algorithms
- Auto-constructs graph from agent interactions (no manual schema)

**Benchmark Results (LongMemEval_S):**
| Config | Model | Score |
|---|---|---|
| Zep | gpt-4o | 71.2% |
| Zep | gpt-4o-mini | ~66% (estimated from category data) |
| Full-context baseline | gpt-4o | 60.2% |

- Outperformed MemGPT on DMR benchmark
- Aggregate accuracy improvements up to 18.5% over full-context
- Individual evaluations showing gains exceeding 100% (e.g.
  single-session-preference: 20% baseline -> 56.7% with Zep+gpt-4o)
- Zep context used ~1.6k tokens vs 115k for full-context (2% of tokens)
- Median latency: 2.58s (Zep+gpt-4o) vs 28.9s (full-context+gpt-4o)

**Pricing:**
- Free: 1,000 credits/month (low rate limits, lower priority)
- Flex: $25/month (20,000 credits, 600 req/min)
- Flex Plus: $475/month (300,000 credits, 1,000 req/min, custom
  extraction instructions, webhooks)
- Enterprise: contact sales (SOC 2 Type II, HIPAA BAA, BYOK/BYOM/BYOC)
- 1 credit = 1 episode (350 bytes). Larger episodes cost multiple credits.

**Key Strengths:**
- Temporal reasoning is genuinely strong (handles fact supersession)
- Graphiti is truly open source
- SOC 2 Type II certified
- Low token usage (2% of full-context)

**Key Weaknesses:**
- 71.2% on LongMemEval_S is well below newer competitors
- single-session-assistant performance actually decreases vs baseline
  (-17.7% with gpt-4o)
- Cloud-first; self-hosting requires running Graphiti + own infrastructure
- Not fully open source (Zep service is proprietary, Graphiti is OSS)

**What it DOES NOT do:** Identity files, personality, harness configs,
local-first daemon, predictive scoring, skill management, git sync.

---

### 2.4 Letta (formerly MemGPT)

- **URL:** https://www.letta.com
- **GitHub:** https://github.com/cpacker/MemGPT (~21.7K stars)
- **Origin:** MemGPT paper (arXiv:2310.08560) introduced OS-inspired
  memory hierarchy for LLM agents.

**Architecture:**
- **Memory hierarchy inspired by OS design:**
  - Core memory (immediate context, always present)
  - Conversational memory (stored externally, retrieved on demand)
  - Archival memory (long-term storage)
  - External files (Letta Filesystem)
- Agent actively manages what stays in context vs what gets stored
- **Letta Code:** Memory-first coding harness with git-backed memory,
  skills, subagents. #1 model-agnostic OSS agent on Terminal-Bench.
- **Context Repositories (Feb 2026):** Git-based versioning for memory.
  Programmatic context management.
- **Sleep-time Compute (Apr 2025):** Agents "think" during downtime,
  processing information and forming connections by rewriting memory state.
- **Skill Learning (Dec 2025):** Dynamically learn skills through
  experience. Agents use past experience to improve.
- **Agent File (.af):** Open file format for serializing stateful agents
  with persistent memory and behavior.
- **Conversations API:** Shared agent memory across concurrent experiences.

**Benchmark Results:**
- Letta Filesystem + gpt-4o-mini on LoCoMo: **74.0%** (just using files,
  no specialized memory tools)
- This beat Mem0's reported 68.5% for their top graph variant on same
  benchmark

**Key Philosophical Position:**
- "Memory is more about how agents manage context than the exact
  retrieval mechanism used."
- "Agents today are highly effective at using tools, especially those
  likely to have been in their training data (such as filesystem
  operations). As a result, specialized memory tools... are less
  effective than simply allowing the agent to autonomously search."
- "Simpler tools are more likely to be in the training data of an agent
  and therefore more likely to be used effectively."
- "LoCoMo is primarily a retrieval benchmark, not an agentic memory
  benchmark." Letta advocates for their own Letta Leaderboard and
  Terminal-Bench instead.

**Cost Model:**
- Letta Platform (managed API) + Letta Code (local CLI)
- Open source core
- Pricing not publicly detailed for platform

**What makes Letta unique:**
- Most theoretically grounded (from academic MemGPT paper)
- Emphasizes agent capabilities over retrieval mechanisms
- Git-backed context repositories (closest to Signet's approach)
- Sleep-time compute is a novel concept
- Skill learning from experience

**What it DOES NOT do:** Unified identity files (AGENTS.md/SOUL.md etc.),
daemon-based background service, harness-specific config generation,
predictive memory scoring, auto-commit file watching.

---

### 2.5 Mastra Observational Memory (OM)

- **URL:** https://mastra.ai/research/observational-memory
- **Company:** Mastra (from the team behind Gatsby). YC-backed.
  22.2K GitHub stars.
- **Published:** February 9, 2026

**Architecture:**
- **Two background agents -- Observer and Reflector -- watch the
  conversation continuously**
- Context window has two sections: observations at start, message
  history at end
- As messages grow, Observer converts them into dense observations,
  original messages are dropped
- **Three-tier representation:**
  1. Message history (raw conversation, recent)
  2. Observations (Observer output, 3-6x compression for text, 5-40x
     for tool-heavy workloads)
  3. Reflections (Reflector condenses accumulated observations)
- **Temporal anchoring:** Each observation carries 3 dates: observation
  date, referenced date, relative date
- **Token-budget triggered:** Runs on token counts, not time/message counts
- Uses gemini-2.5-flash for observation/reflection
- **Key insight: stable, prompt-cacheable context window.** No per-turn
  dynamic retrieval. No dynamic injection. Just an append-only log.

**Benchmark Results (LongMemEval_S):**
| Model | Score | Notes |
|---|---|---|
| gpt-4o | 84.23% | Highest openly reproducible gpt-4o score |
| gemini-3-pro | 93.27% | +9 points over gpt-4o |
| gpt-5-mini | **94.87%** | Highest single-system score on record |
| gemini-3-flash | 89.20% | -- |

- Beats the **oracle** (which gets only the 1-3 correct sessions):
  84.23% vs 82.4%. OM ingested all ~50 sessions yet matches/beats
  the oracle that only sees the answers.
- Context window averaged ~30k tokens for entire benchmark run.
- gpt-5-mini achieved 100% on single-session-preference.

**Scaling insight:**
- Supermemory went from 81.6% (gpt-4o) to 85.2% (gemini-3-pro) = 3.6pt
- Mastra OM went from 84.23% (gpt-4o) to 93.27% (gemini-3-pro) = 9pt
- OM's architecture extracts more value from better models.

**Cost Advantages:**
- Stable context = high prompt cache hit rates (4-10x cost reduction
  from caching)
- No per-query retrieval API calls
- VentureBeat: "cuts AI agent costs 10x and outscores RAG"

**Limitations (from their own paper):**
- Multi-session is hardest category (87.2% ceiling -- same as Hindsight)
- "Observations are lossy by design. When the Observer compresses
  messages, some detail is lost."
- Not designed for very long-horizon tasks where all details matter

**What it DOES NOT do:** Knowledge graphs, identity files, personality
persistence, harness configs, daemon, predictive scoring, git sync,
skill management.

---

### 2.6 Hindsight (Vectorize.io)

- **URL:** https://vectorize.io/blog/introducing-hindsight-agent-memory-that-works-like-human-memory
- **GitHub:** https://github.com/vectorize-io/hindsight (open source)
- **Paper:** arXiv:2512.12818, co-authored with Virginia Tech + The
  Washington Post
- **Published:** December 16, 2025

**Architecture:**
- Three core operations: **Retain**, **Recall**, **Reflect**
- Memory organized into distinct networks: facts, experiences,
  observations, opinions (separating evidence from inference)
- Time-and-entity-aware recall
- Learning: agents form opinions with confidence scores, update
  beliefs as new info arrives
- Structured memory, not raw logs
- Retrieval optimized for downstream reasoning, not generic search

**Benchmark Results (LongMemEval_S):**
| Model | Score |
|---|---|
| OSS-20B | 83.6% |
| OSS-120B | 89.0% |
| Gemini-3 | **91.4%** |

- +44.6 points over full-context baseline
- Often outperforms using smaller or open-source models
- Press: VentureBeat "With 91% accuracy, open source Hindsight agentic
  memory provides 20/20 vision for AI agents stuck on failing RAG"

**Key Strengths:**
- Fully open source (Apache 2.0 or similar)
- Strong performance with open-source models
- Opinions with confidence scores (belief updating)
- Co-authored with academic institution

**What it DOES NOT do:** Identity, personality, harness configs, daemon,
predictive scoring, skill management, git sync.

---

### 2.7 MemMachine (MemVerge)

- **URL:** https://memmachine.ai
- **GitHub:** https://github.com/MemMachine/MemMachine (open source)
- **Company:** MemVerge (enterprise AI memory company)

**Architecture:**
- Episodic memory with optimized retrieval, embedding, and reranking
- Two modes: memory mode (direct context) and agent mode (agentic
  tool-use retrieval)
- Uses reranking (AWS cohere.rerank-v3-5:0)
- Optimized for token efficiency

**Benchmark Results (LoCoMo):**
| Config | LLM | Score |
|---|---|---|
| Memory mode | gpt-4.1-mini | 0.9123 |
| Agent mode | gpt-4.1-mini | **0.9169** |
| Memory mode | gpt-4o-mini | 0.8747 |
| Agent mode | gpt-4o-mini | 0.8812 |
| Mem0 (comparison) | gpt-4.1-mini | 0.8000 |

**Token Efficiency:**
- ~80% reduction in token usage vs Mem0
- Input tokens: 4.2M (MemMachine memory) vs 19.2M (Mem0) for same
  benchmark
- Up to 75% faster add/search times

**What it DOES NOT do:** LongMemEval results not published.
Identity, personality, harness configs, daemon, etc.

---

### 2.8 OMEGA

- **URL:** https://github.com/omega-memory/omega-memory
- **Claims:** 95.4% on LongMemEval, #1 on LongMemEval (per their listing)
- **Architecture:** MCP server for Claude Code. 25 memory tools.
  Local-first, SQLite + sqlite-vec. ONNX embedding model (~90MB,
  bge-small-en-v1.5). No cloud, no API keys.

**Key Features:**
- 25 MCP tools for memory operations
- Semantic search (384-dim vectors) + FTS5 + type-weighted scoring +
  contextual re-ranking + dedup
- Memory lifecycle: dedup, evolution, TTL, auto-relate, compaction
- Session hooks for Claude Code
- omega-pro adds: multi-agent coordination (29 tools), LLM routing
  (10 tools), entity registry, knowledge base, encrypted profiles

**Architecture Details:**
- ~31MB RSS at startup, ~337MB after first query (ONNX model loaded)
- Single SQLite database
- Memory types: decision, lesson, error, summary
- Contradiction detection, memory decay

**Pricing:** Free (Apache 2.0). omega-pro for advanced features.

**What it DOES NOT do:** Harness-agnostic (Claude Code only), no unified
identity files, no git sync, no multi-harness support, no web dashboard.

---

### 2.9 LangMem (LangChain)

- **URL:** https://langchain-ai.github.io/langmem/
- **Blog:** https://blog.langchain.com/langmem-sdk-launch/

**Architecture:**
- SDK for agent long-term memory within LangGraph ecosystem
- Three memory types modeled on human cognition:
  1. **Semantic memory:** Facts/knowledge (collections or profiles)
  2. **Episodic memory:** Past experiences as learning examples
  3. **Procedural memory:** System instructions and behavioral patterns
- Two formation modes:
  - **Conscious:** Explicit tool calls to store (hot path)
  - **Subconscious:** Background extraction after conversation (background)
- Memory enrichment: balances creation and consolidation
- Storage via LangGraph's BaseStore (pluggable backends)
- Profiles (single doc, latest state) vs Collections (append-only)

**Key Design:**
- Developer-customizable extraction instructions
- Flexible retrieval combining similarity + importance + recency/frequency
- Integration with LangGraph checkpointing

**Benchmark Results:** None published on LongMemEval or LoCoMo.
Referenced in Letta's blog as one of the memory tools they benchmarked
against.

**What it DOES NOT do:** Identity files, personality persistence, daemon,
harness configs, git sync, knowledge graphs, temporal reasoning
(beyond what the LLM handles natively).

---

## 3. Consolidated Leaderboard (LongMemEval_S)

| System | Model | Overall | Date | Notes |
|---|---|---|---|---|
| Supermemory ASMR (8-ensemble) | mixed | **~98.6%** | 2026-03-22 | Experimental. Any-of-8 scoring. |
| Supermemory ASMR (12-forest) | GPT-4o-mini | **97.2%** | 2026-03-22 | Experimental. Consensus scoring. |
| OMEGA | ? | 95.4% | 2026-03 | Self-reported, methodology unclear |
| Mastra OM | gpt-5-mini | **94.87%** | 2026-02-09 | Highest single-system production score |
| Mastra OM | gemini-3-pro | 93.27% | 2026-02-09 | |
| Hindsight | Gemini-3 | 91.4% | 2025-12-16 | Open source |
| Mastra OM | gemini-3-flash | 89.20% | 2026-02-09 | |
| Hindsight | OSS-120B | 89.0% | 2025-12-16 | |
| EmergenceMem Internal* | gpt-4o | 86.0% | ? | Not publicly reproducible |
| Supermemory | gemini-3 | 85.2% | 2025 | Production |
| Supermemory | gpt-5 | 84.6% | 2025 | Production |
| Mastra OM | gpt-4o | **84.23%** | 2026-02-09 | Highest reproducible gpt-4o |
| Hindsight | OSS-20B | 83.6% | 2025-12-16 | |
| Oracle (correct sessions only) | gpt-4o | 82.4% | -- | Theoretical ceiling |
| Supermemory | gpt-4o | 81.6% | 2025 | Production |
| Mastra RAG (topK 20) | gpt-4o | 80.05% | 2026 | |
| Zep | gpt-4o | 71.2% | 2025-01 | |
| Full-context baseline | gpt-4o | 60.2% | -- | No memory system |

*EmergenceMem "Internal" is a closed config; public configs score 82.4%
(Simple) and 79.0% (Simple Fast).

---

## 4. Consolidated Leaderboard (LoCoMo)

| System | LLM | Score | Notes |
|---|---|---|---|
| MemMachine v0.2 agent | gpt-4.1-mini | **0.9169** | |
| MemMachine v0.2 memory | gpt-4.1-mini | 0.9123 | |
| MemMachine v0.2 agent | gpt-4o-mini | 0.8812 | |
| MemMachine v0.2 memory | gpt-4o-mini | 0.8747 | |
| Signet (run-full-stack-8) | gpt-4o extraction | **0.875** | 8 questions only |
| Mem0 | gpt-4.1-mini | 0.8000 | |
| Letta Filesystem | gpt-4o-mini | 0.7400 | No specialized memory tools |
| Mem0 (graph) | gpt-4o-mini | ~0.685 | As reported by competitors |

---

## 5. Architectural Taxonomy

### Camp 1: Agentic Retrieval (agent-as-search)
- **Who:** Supermemory ASMR, Letta Filesystem
- **How:** Replace vector search with LLM agents that actively read and
  reason over stored data
- **Pro:** Highest ceiling on benchmarks, handles temporal nuance
- **Con:** Enormous per-query compute cost, latency, unpredictable cost
  scaling. Supermemory ASMR fires 6+3+8 agents per query.
- **Production readiness:** Experimental (Supermemory ASMR). Letta's
  filesystem approach is simpler but less capable.

### Camp 2: Temporal Knowledge Graphs
- **Who:** Zep/Graphiti
- **How:** Continuously build a time-versioned knowledge graph from
  interactions. Old facts are superseded, not deleted.
- **Pro:** Excellent temporal reasoning, very low token usage (~2% of
  full context), fast retrieval (~2.5s)
- **Con:** Lower absolute accuracy (71.2% on LongMemEval), graph
  construction accuracy depends on LLM quality
- **Production readiness:** Most production-ready. SOC 2 Type II,
  HIPAA BAA, enterprise deployment options.

### Camp 3: Observational Compression
- **Who:** Mastra OM
- **How:** Background agents observe conversation and produce
  progressively compressed representations. Stable, cacheable context.
- **Pro:** Excellent cost efficiency (prompt caching), stable latency,
  scales well with model improvements, highest reproducible gpt-4o score
- **Con:** Lossy by design (observation compression drops detail),
  multi-session reasoning hits ~87% ceiling
- **Production readiness:** Production-ready. Part of Mastra framework.

### Camp 4: Hybrid Extract + Graph + Search
- **Who:** Mem0, Hindsight, MemMachine, OMEGA
- **How:** Extract structured facts, optionally build graph, use
  vector + keyword + graph search
- **Pro:** Balanced approach, good token efficiency, works with
  existing infra
- **Con:** Graph quality varies, extraction quality is bottleneck
- **Production readiness:** Mem0 most widely deployed (~48K stars),
  Hindsight open source, MemMachine production-focused

### Camp 5: What Signet Does (Cognitive Persistence Layer)
- **How Signet differs from ALL of the above:**
  - **Identity:** AGENTS.md, SOUL.md, IDENTITY.md, USER.md, MEMORY.md
    -- structured identity files that define who the agent is, not just
    what it remembers
  - **Cross-platform:** Works across Claude Code, OpenCode, OpenClaw,
    Codex -- not locked to one harness
  - **Harness sync:** Auto-generates harness-specific config files
  - **Local-first daemon:** Background service with HTTP API, file
    watching, auto-commit
  - **Pipeline-based extraction:** LLM extraction -> decision ->
    knowledge graph -> retention decay -> session summary
  - **Predictive scoring:** Scorer sidecar that predicts what memories
    will be relevant before they're requested
  - **Git sync:** Version-controlled memory with remote sync
  - **Skills management:** Installable, shareable agent capabilities
  - **Beyond retrieval:** Personality, tone, working context, user
    preferences are first-class -- not just remembered facts

---

## 6. The "Beyond Retrieval" Gap

**Every competitor focuses on the same problem: "given a long conversation
history, retrieve the right facts to answer a question."**

None of them address:
1. **Agent identity continuity** -- who the agent is across sessions
2. **Personality/tone persistence** -- how the agent communicates
3. **User modeling** -- structured understanding of who the user is
4. **Predictive memory** -- anticipating what will be needed
5. **Skill accumulation** -- learning capabilities, not just facts
6. **Cross-platform portability** -- same memory across different tools
7. **Git-versioned memory** -- trackable, reviewable memory changes
8. **Developer workflow integration** -- harness configs, hook lifecycle

This is Signet's moat. The competitors are building memory-as-retrieval.
Signet is building memory-as-cognition.

---

## 7. Cost Analysis

| System | Per-Query Cost Profile | Token Usage | Latency |
|---|---|---|---|
| Supermemory ASMR | Very high (6+3+8-12 LLM calls) | Not published | Not published |
| Supermemory Prod | Medium (API call) | Not published | Not published |
| Mastra OM | Low (stable context, cacheable) | ~30k avg | Low (cached) |
| Zep | Low (graph query + small context) | ~1.6k | 2.58s median |
| Mem0 | Medium (extraction + retrieval) | 19.2M/benchmark | Not published |
| MemMachine | Low-Medium | 4.2M/benchmark | Fast |
| Letta FS | Medium (agent tool calls) | Varies | Varies |
| Hindsight | Medium (retain+recall+reflect) | Not published | Not published |
| OMEGA | Low (local, no API) | Local inference | ~337MB RAM |
| **Signet** | Low (local daemon, single extraction) | Local | Sub-second search |

---

## 8. Key Quotes for Blog Use

**Letta (on benchmarks):**
> "With a well-designed agent, even simple filesystem tools are sufficient
> to perform well on retrieval benchmarks such as LoCoMo. More complex
> memory tools can be plugged into agent frameworks like Letta via MCP or
> custom tools."

**Letta (on what matters):**
> "Whether an agent 'remembers' something depends on whether it
> successfully retrieves the right information when needed. Therefore,
> it's much more important to consider whether an agent will be able
> to effectively use a retrieval tool... rather than focusing on the
> exact retrieval mechanisms."

**aiHola (on Supermemory ASMR):**
> "A 99% score on any benchmark sounds like the problem is solved.
> Shah even flirts with this framing... It isn't solved. LongMemEval
> tests 500 questions across roughly 40 sessions. OMEGA's creator
> built a separate benchmark called MemoryStress that throws 1,000
> sessions at memory systems, and the numbers crater."

**aiHola (on cost):**
> "OMEGA runs locally with zero API calls. Mastra's system uses a
> stable, prompt-cacheable context window. Supermemory's ASMR pipeline
> fires off six parallel agents for ingestion, three more for search,
> then eight or twelve more for answering. The compute budget is not
> comparable."

**Mastra (on context economics):**
> "OM's context window is append-only and stable, the prefix doesn't
> change between turns. This means high prompt cache hit rates. Many
> model providers reduce token costs by 4-10x vs uncached prompts."

**Mastra (on scaling with models):**
> "Supermemory went from 81.6% to 85.2% -- a 3.6 point gain.
> Observational Memory went from 84.23% to 93.27% -- a 9 point gain.
> Better models extract more value from the same structured observations."

**LongMemEval authors:**
> "Even the most capable long-context LLMs currently would require an
> effective memory mechanism to manage an ever-growing interaction history."

---

## 9. Sources

1. Supermemory ASMR blog: https://supermemory.ai/blog/we-broke-the-frontier-in-agent-memory-introducing-99-sota-memory-system/
2. Supermemory research: https://supermemory.ai/research/
3. aiHola analysis: https://aihola.com/article/supermemory-99-longmemeval-agentic-memory
4. Mem0 paper: https://arxiv.org/abs/2504.19413
5. Mem0 research: https://mem0.ai/research
6. Zep SOTA blog: https://blog.getzep.com/state-of-the-art-agent-memory/
7. Zep paper: https://arxiv.org/abs/2501.13956
8. Letta benchmarking: https://www.letta.com/blog/benchmarking-ai-agent-memory
9. Letta Leaderboard: https://www.letta.com/blog/letta-leaderboard
10. Letta context repos: https://www.letta.com/blog/context-repositories
11. Mastra OM research: https://mastra.ai/research/observational-memory
12. Mastra OM blog: https://mastra.ai/blog/observational-memory
13. VentureBeat on Mastra: https://venturebeat.com/data/observational-memory-cuts-ai-agent-costs-10x-and-outscores-rag-on-long
14. Hindsight blog: https://vectorize.io/blog/introducing-hindsight-agent-memory-that-works-like-human-memory
15. Hindsight paper: https://arxiv.org/abs/2512.12818
16. VentureBeat on Hindsight: https://venturebeat.com/data/with-91-accuracy-open-source-hindsight-agentic-memory-provides-20-20-vision
17. MemMachine LoCoMo: https://memmachine.ai/blog/2025/12/memmachine-v0.2-delivers-top-scores-and-efficiency-on-locomo-benchmark/
18. OMEGA MCP: https://mcpservers.org/servers/omega-memory/omega-memory
19. LangMem guide: https://langchain-ai.github.io/langmem/concepts/conceptual_guide/
20. LongMemEval: https://xiaowu0162.github.io/long-mem-eval/ (arXiv:2410.10813)
21. LoCoMo: https://snap-research.github.io/locomo/ (arXiv:2402.17753)
22. Zep pricing: https://www.getzep.com/pricing/
23. Reddit criticism: https://www.reddit.com/r/LangChain/comments/1q0dpty/
24. Reddit Mem0 controversy: https://www.reddit.com/r/LangChain/comments/1kg5qas/
25. Reddit benchmarking: https://www.reddit.com/r/LangChain/comments/1kash7b/
