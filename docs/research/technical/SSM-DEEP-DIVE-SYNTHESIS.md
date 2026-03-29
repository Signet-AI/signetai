# Signet SSM Deep Dive: Complete Architecture Synthesis

**Prepared for:** Nicholai (creator) and Jake (co-founder)  
**Date:** March 27, 2026  
**Sources:** 8 research documents, 5 planning specs, 1 approved epic — all read in full  

---

## Table of Contents

1. [Architecture Summary](#1-architecture-summary)
2. [Key Research Findings](#2-key-research-findings)
3. [Synthetic Data Strategy](#3-synthetic-data-strategy)
4. [Implementation Roadmap](#4-implementation-roadmap)
5. [Novel Insights](#5-novel-insights)
6. [Open Questions](#6-open-questions)
7. [Connection to CRM + Gmail Scaling](#7-connection-to-crm--gmail-scaling)

---

## 1. Architecture Summary

### The Thesis

Signet's VISION.md describes the endgame: *"A neural network unique to each user, trained on their own interaction patterns, that gets sharper the longer you use it. No shared personal weights. Your weights never leave your machine."*

The current pipeline approximates this with ~19,800 LOC of hand-tuned heuristics across 52+ files: a fixed `importance * 0.95^ageDays` decay curve, 34 hardcoded antonym pairs for contradiction detection, static traversal weights, a broken cross-attention scorer sidecar, and stateless per-turn search. Each stage was built independently because no single model could hold state across time.

**The SSM is that model.** The proposal isn't "sprinkle SSMs in a few places." It's: **SSMs become the learned temporal backbone that every pipeline stage consults.** The graph stays. SQLite stays. FTS5 stays. But temporal reasoning — what's important now, what will matter next, what should decay, what contradicts what — moves from hardcoded rules to a model that learns from each user's interaction patterns.

### What Replaces What

The architecture defines three distinct SSM components, each targeting a different kind of reasoning:

#### Component 1: Signet Neural Backbone (SNB) — Temporal Interaction Model

**Replaces:** The cross-attention scorer sidecar (~1.1M params, 3 critical bugs), the `0.95^ageDays` decay heuristic, the significance gate's fixed thresholds, the stateless per-turn search paradigm.

**Architecture:** Mamba-3 selective SSM (MIMO, trapezoidal discretization, complex-valued state). 5-10M parameters, 4-8 layers, d_model=128-256, N=32-64. Heterogeneous quantization (A matrix fp16, projections int8). ~10-15MB binary in Rust. <1ms per event on CPU.

**What it does:** Processes the sequence of interaction events across a session (and across sessions via persistent hidden state). At each turn, produces:
- Memory relevance scores (which memories to inject)
- Aspect bias weights (which graph traversal paths to prioritize)
- Predicted next entities (proactive embedding prefetch)
- Retention adjustment (per-memory decay rate modifiers)
- Significance score (is this session worth extracting?)
- Contradiction probability (does a new fact conflict with stored ones?)

**Why Mamba-3 specifically:** The March 2026 ICLR paper introduced three features that directly serve Signet: (1) complex-valued state updates that naturally model cyclical patterns like daily/weekly usage rhythms, (2) MIMO formulation that packs more computation into the memory-bound decode step without increasing state or latency, and (3) trapezoidal discretization that achieves Mamba-2 quality with half the state size — critical for keeping the sidecar small.

#### Component 2: Path SSM — Graph Traversal Scorer

**Replaces:** The static `strength * confidence * association_weight` path scoring in graph traversal (DP-6).

**Architecture:** S4D (non-selective structured SSM). ~50-60K parameters. 1-3 layers, d_model=32-64, state_dim=16-32. Processes sequences of edge features along traversal paths.

**Why S4 and not Mamba:** GraphSSM (NeurIPS 2024) ran a controlled experiment: S4 scored 49.21% vs Mamba's 43.11% on Reddit temporal graphs. The paper explains why: Mamba's selective mechanism (input-dependent gating) is powerful for language where you want to ignore irrelevant tokens, but counterproductive for graph topology where every node's structural position matters. S4's fixed HiPPO-initialized state transitions act as stable structural filters that preserve graph information.

**What it does:** Takes a traversal path (sequence of 3-5 edges, each encoded as a 12-dim feature vector including source/target types, confidence, strength, co-occurrence weight, edge age, traversal count, community boundary crossing, hop position, structural densities) and produces a path quality score conditioned on the current session context. Learns which edge patterns historically lead to useful memory retrieval.

#### Component 3: Hierarchical Multi-Scale SSM (Future)

**Replaces:** Hardcoded session-arc-epoch boundaries (8 sessions per arc, 4 arcs per epoch).

**Architecture:** Stacked HiSS-style hierarchy. Low-level SSM processes within-session interactions (fast dynamics, small eigenvalues). High-level SSM processes session summaries (slow dynamics, eigenvalues near 1). Optional third level for epoch-scale patterns. Based on MS-SSM's finding of 2x improvement on hierarchical reasoning tasks.

**What it does:** Replaces the rigid session/arc/epoch thresholds with learned boundaries. A session ends an arc when the high-level SSM's state shift exceeds a learned threshold, not when a counter hits 8.

### How the Pieces Compose

```
Session Turn Arrives
       │
       ▼
  [Embed query] ──────────────────────────────┐
       │                                       │
       ▼                                       ▼
  [SNB.step(hidden, features)]          [Hybrid Search]
       │                                       │
       ├── aspect_bias ──► [Graph Traversal] ◄─┘
       │                        │
       │                   [Path SSM scores paths]
       │                        │
       ├── relevance_scores ──► [Reranking with path scores]
       ├── predicted_entities ──► [Prefetch Embeddings]
       ├── significance ──► [Gate Extraction]
       ├── retention_adj ──► [Decay Update]
       ├── contradiction_prob ──► [Contradiction Check]
       │
       ▼
  [Inject Context to Agent]
       │
       ▼
  [Agent Responds]
       │
       ▼
  [Collect Feedback] ──► [SSM Training Signal]
```

**The SSM never blocks the critical path.** It biases it. If the SSM is unavailable, slow (>5ms), or returns NaN, the system falls back to baseline heuristics with zero degradation. This is the fail-open pattern.

### Per-User Adaptation Architecture

**Shared base model** (Mamba-3, 5-10M params): Pre-trained on synthetic data, then refined via federated learning from anonymized community signals. Shipped with every Signet release.

**Per-user LoRA adapters** (150KB-1.5MB per user): Applied to linear projection matrices ONLY (in_proj, out_proj, dt_proj), NOT to SSM state matrices (A, B, C, Delta). Critical constraint from NeurIPS 2024 PEFT research: LoRA on SSM parameters drops to 76.9 GLUE (near random), while LoRA on projections achieves 87.0 (near full fine-tuning at 89.4).

**Per-session hidden state** (16KB per agent): The SSM's compressed representation of interaction history. Serialized at session end, restored at session start. At d_model=64, state_dim=32, 2 layers = 4,096 f32 values = 16KB.

**Session-level TTT (Test-Time Training):** At session start, restore adapter. During session, accumulate self-supervised loss on predictions vs actual memory usage. At session end, one gradient step updates the LoRA adapter. Cost: one backward pass per session (~3.4x forward cost), negligible amortized over a full session.

**Sleep/Consolidation Cycle:** Maps to SleepGate's three-phase model:
- **Wake** (active sessions): Forward inference, accumulate gradients
- **NREM** (idle periods, no active sessions): Apply gradient updates, compress replay buffer, run adapter refinement
- **REM** (scheduled maintenance): Synthetic data exploration, canary re-validation

Consolidation triggers on parameter-space drift (FOREVER metric), not clock time. The SSM retrains when predictions diverge from observations.

---

## 2. Key Research Findings

### Tier 1: Papers That Define the Architecture

**Mamba / Mamba-2 / Mamba-3 (Gu & Dao, 2023-2026)** — The foundational architecture. Mamba introduced selective (input-dependent) state transitions, enabling the model to choose what to remember vs forget per timestep. Mamba-2 proved the mathematical duality between SSMs and linear attention, enabling much larger state dimensions. Mamba-3 (March 16, 2026 — 11 days before this document) introduced inference-first design: complex-valued state (tracks cyclical patterns), MIMO (better predictions at same memory cost), trapezoidal discretization (achieves Mamba-2 quality with half the state). **For Signet:** Mamba's selective mechanism is exactly what the memory scorer needs — a learned function deciding what to retain, operating in constant memory with linear time. The 5x throughput advantage over transformers matters for a sidecar that must not impact the host.

**IBM FlowState (September 2025, NeurIPS Workshop)** — At 9.1M parameters, FlowState is the smallest model in the GIFT-Eval top 10 for zero-shot time-series forecasting, outperforming models 20x its size. S5-based encoder + basis-function decoder. **For Signet:** This is the proof that sub-10M SSMs are viable for temporal prediction. The timescale-invariant encoding is relevant for modeling agent interactions at varying frequencies. This sets the parameter budget: 5-10M, not 100M+.

**Albert Gu's "Tradeoffs" Analysis (July 2025)** — The most useful conceptual framework. *"Transformers are like databases: every observation is filed for future reference. SSMs are like brains: finite-sized memories, always on, processing in real-time."* For maintaining continual relationships: *"what matters is a long, persistent summary of context, remembering the shape and flow of interactions without needing to recall every specific detail. No one needs a scratchpad to have a continual relationship with their friend. This is exactly where the more brain-like nature of SSMs is more suitable."* **For Signet:** This IS Signet's use case. The SSM provides the "brain" (compressed temporal state). SQLite + FTS5 + vector search provides the "database" (exact recall). They complement.

**GraphSSM (NeurIPS 2024)** — The most principled treatment of SSMs on temporal graphs. Introduces GHIPPO: Laplacian-regularized online function approximation extending HiPPO theory to graphs. The key finding: S4 outperforms Mamba on graph-structured data (Reddit: 49.21% vs 43.11%). The selectivity mechanism doesn't help when processing topology. **For Signet:** This is why the architecture has TWO SSM types — S4D for graph path scoring, Mamba for sequential interaction modeling. Also establishes mixed discretization for handling unobserved graph mutations between sessions.

**Jamba (ICLR 2025)** — Ablation study proving removing attention from SSM hybrids drops retrieval accuracy to 0%. SSM layers contribute NOTHING to associative recall. **For Signet:** This is a hard architectural constraint. The SSM is a prediction/bias layer only. Retrieval stays in SQLite + FTS5 + vector search. The SSM tells the retrieval system *where to look*, not *what to find*.

### Tier 2: Papers That Solve Specific Signet Problems

**DyGMamba / DyG-Mamba (2024)** — Two-level SSM for continuous-time dynamic graphs. DyGMamba's node-level SSM encodes entity interaction histories; time-level SSM captures temporal access patterns. DyG-Mamba's key innovation: replacing Mamba's data-dependent step-size with time-span-dependent control signals inspired by the Ebbinghaus Forgetting Curve. Small time-spans preserve state; large gaps enable exponential decay — proven formally (Theorem 2). **For Signet:** DyG-Mamba is the direct, mathematical replacement for `importance * 0.95^ageDays`. Instead of a fixed decay constant, the model learns entity-specific forgetting curves from the actual time gaps between interactions. The Ebbinghaus formalization means this isn't ad hoc — it's grounded in cognitive science.

**SleepGate (March 15, 2026)** — Three biologically-inspired modules for memory consolidation: conflict-aware temporal tagger (detects supersession via semantic signatures + cosine similarity > 0.85), forgetting gate (2-layer MLP assigning retention scores), consolidation module (clusters and compresses similar entries). Achieves 99.5% retrieval accuracy at interference depth 5 where all baselines remain below 18%. **For Signet:** Maps directly to three Signet needs: (1) supersession detection replaces 34 hardcoded antonym pairs, (2) forgetting gate replaces fixed retention windows, (3) consolidation replaces fixed-threshold session summarization.

**TTT4Rec (September 2024)** — Test-Time Training for sequential recommendation. Achieves meaningful personalization from as few as 5-10 interactions. Limited training data actually shows *larger* TTT benefits (4-6%) than abundant data (1-4%). **For Signet:** Validates the claim that the predictor will improve within single-digit sessions. TTT's inner-loop gradient updates provide immediate adaptation; the cold-start problem evaporates quickly.

**NeuralWalker (2024)** — Treats graphs as collections of random walk sequences. Bidirectional Mamba emerged as top-performing model, consistently outperforming S4, 1D CNNs, and even Transformers. With sufficiently long walks (>= 4n³), strictly more expressive than WL test and ordinary MPNNs. **For Signet:** This validates DP-6's traversal-primary architecture. Walk sequences through the knowledge graph should be processed by bidirectional Mamba for entity representation, not just used for ordering.

**KDD 2024 nDCG finding** — Proved nDCG shows -0.91 correlation with actual online reward when aggregated across sessions. **For Signet:** Hard constraint. Use unnormalized DCG for model selection. Report nDCG for literature comparability only. Never use nDCG to decide whether the SSM is working.

**GenTKG (NeurIPS 2023)** — Temporal ascending order is the only effective arrangement for temporal KG facts. Importance-ordered injection destroys the temporal signal. **For Signet:** Hard constraint. Memory injection order must be chronological within each relevance tier, not sorted by importance score.

### Tier 3: Papers That Enable Practical Deployment

**Quantization for Edge (Zhao et al., 2025)** — Post-training quantization at 8-bit drops SSM performance to 40%, but quantization-aware training recovers to 96%. A matrix and hidden state require higher precision than weights. Heterogeneous quantization (fp16 for A/state, int8 for weights) achieves 6x memory reduction. **For Signet:** A 10M-param SSM fits in ~7MB. Recipe: QAT (not PTQ), fp16 for A matrix and state, int8 for projections.

**Mamba Pruning for Edge (EMNLP 2025)** — 70% parameter reduction with only 3-9% performance drop. 1.77x faster inference, 46% memory reduction. Mamba is more robust to pruning than transformers. **For Signet:** A 130M Mamba pruned 70% = ~39M params. Combined with int8 = sub-20MB binary.

**1.58-bit Mamba (COLING 2025)** — Ternary weights (-1, 0, 1). All multiplications become additions/subtractions. **For Signet:** A 10M-param SSM at 1.58 bits = ~2MB. Small enough to ship inside the npm package. Performance degrades, but for coarse tasks (significance gating, importance decay), ternary may suffice.

**Rust Ecosystem** — Three Mamba implementations exist: mamba.rs (pure Rust, memory-mapped weights, Apache 2.0/MIT), mamba-ssm (Candle-based, Apple Silicon tested, ~6.5 tok/s on M3 Max), oxidizr/blazr (full training + inference stack, production-grade, supports Mamba-2/3). Plus web-rwkv for RWKV-7. The path: train in PyTorch → export safetensors → infer in Rust.

**Zep/Graphiti (January 2025)** — Most directly comparable system. Three-tier temporal KG (episode → semantic entity → community), bi-temporal data model (4 timestamps per edge: system created/expired, world valid/invalid), contradiction handling via edge invalidation with preserved history. 94.8% accuracy on DMR, 71.2% on LongMemEval. **For Signet:** The bi-temporal data model should be adopted regardless of SSM work. The contradiction handling mechanism (invalidate old edges, don't delete) is the right pattern. However, Zep uses LLM calls throughout; Signet's thesis is that an SSM handles temporal reasoning locally.

---

## 3. Synthetic Data Strategy

### Why Synthetic First

Real session data with feedback labels doesn't exist in volume yet. The pipeline to collect it (turn-level telemetry, prompt_memory_rankings table) hasn't been built. Synthetic data with planted ground truth patterns lets us:
1. Prove the model learns temporal patterns (canary tests)
2. Measure the noise floor (SNR curves)
3. Validate the training pipeline end-to-end
4. Establish baseline metrics before touching real data

### The PoC Already Proved Viability

The standalone benchmark (`packages/predictor/bench/ssm_proof_of_concept.py`) ran a 50K-parameter selective SSM against an MLP baseline and the production heuristic on synthetic data matching the exact 17-dim feature layout from `protocol.rs`:

| Metric | Heuristic | MLP (3.2K) | SSM (50K) | SSM vs Heuristic |
|--------|-----------|------------|-----------|------------------|
| HR@5 | 0.545 | 0.574 | **0.724** | **+32.8%** |
| MRR@5 | 0.312 | 0.323 | **0.475** | **+52.2%** |
| DCG@5 | 0.754 | 0.784 | **1.009** | **+33.7%** |

All four Phase 0 gates passed: HR@K ≥ 0.60 ✓ (0.724), DCG improvement ≥ 10% ✓ (33.7%), p95 latency ≤ 5ms ✓ (4.42ms), canary pass ≥ 5/7 ✓ (6/7).

Critical finding: **29 LLM-generated scenarios outperformed 2000 hand-crafted sequences on generalization** (gen gap -3.6% vs +9.4%). The negative gen gap means zero memorization. DR4SR (KDD 2024 Best Student Paper) corroborates: quality and diversity matter more than quantity — their regenerated datasets with fewer but more diverse interactions improved performance 5-43% across 5 architectures.

### Seven Canary Patterns

Planted in synthetic interaction sequences. The SSM must find all seven:

| # | Pattern | Description | Pass Criteria | PoC Status |
|---|---------|-------------|---------------|------------|
| 1 | Temporal cycle | Entity X relevant every Monday | Relevance X on Monday > Thursday by 2x | **PASS** (0.910) |
| 2 | Recency decay | Recently accessed memories score higher | Learned decay within 20% of planted rate | **PASS** (0.920) |
| 3 | Entity selectivity | Memory Y only relevant when focal entity is Z | Relevance Y\|Z > Y\|W by 3x | **PASS** (0.930) |
| 4 | Supersession chain | A superseded by B superseded by C | C > B > A at all test points | **PASS** (0.720) |
| 5 | Burst pattern | Cluster of accesses predicts near-future relevance | Recall@10 for post-burst > 0.8 | **PASS** (0.770) |
| 6 | Cross-entity dependency | When P active, Q's memories become relevant | Co-activation >0.7 correlation | **PASS** (0.550) |
| 7 | Combined multi-signal | Cycle + selectivity + recency together | All three contribute (ablation: removing any drops >10%) | **FAIL** (0.460) |

The importance_threshold failure is structural — SSMs process *across* positions (temporal relationships), not *within* positions (pointwise thresholds). Fix: add a parallel pointwise MLP branch (~2K params) for threshold decisions.

### SNR Degradation Protocol

From SynTSBench (NeurIPS 2025): inject noise at 30dB, 20dB, 10dB, 0dB, -10dB. Measure accuracy at each level. The model must:
- Maintain >90% canary detection at 20dB
- Maintain >70% canary detection at 10dB
- Degrade gracefully (no cliff-edge failure)
- Document the noise floor where detection drops below 50%

### TSTR Validation

Train on Synthetic, Test on Real (once real data exists):
1. Train synthetic only, test real → must achieve >60% of baseline
2. Train real only, test real → baseline
3. Train synthetic + real, test real → must exceed baseline

### Curriculum Learning Schedule

Based on Pythia findings that curriculum effects matter most for small models (~100K params is exactly where this applies):

| Stage | Candidates | SNR | Hard Negatives | Duration |
|-------|-----------|-----|----------------|----------|
| 1: Trivial | 5 per session | 30dB | 0% | 20% of training |
| 2: Two-feature | 10 per session | 20dB | 25% | 30% of training |
| 3: Multi-feature | 20 per session | 10dB | 50% | 30% of training |
| 4: Realistic | 50 per session | 0-10dB mixed | 75% | 20% of training |

### Hard Negative Generation

Critical for teaching discrimination between relevant and nearly-relevant:
- **Entity-neighbor negatives:** Memories from entities adjacent to focal entity (structurally similar, semantically wrong)
- **Temporal-neighbor negatives:** Memories from correct entity but wrong time window (right topic, stale)
- **Semantic-neighbor negatives:** High embedding similarity but different entity context
- **Superseded negatives:** Old versions of facts that have been updated

Following FENRec (AAAI 2025): mixed negatives via interpolation maintain consistently challenging difficulty throughout training, unlike random negatives which become trivial.

### Data Budget Across Phases

| Phase | Synthetic | Real | Total | Purpose |
|-------|-----------|------|-------|---------|
| Phase 0 | 50K sequences | 0 | 50K | Canary validation |
| Phase 1 | 50K | ~500 sessions | ~55K | Bootstrap |
| Phase 2 | 25K | ~2K sessions | ~27K | Mixed training |
| Phase 3 | 10K (augmentation) | ~5K+ | ~15K+ | Real-dominant |

---

## 4. Implementation Roadmap

### Current State (as of March 27, 2026)

**Completed:**
- ✅ 8 research documents (literature review, graph intersection, integration synthesis, synthetic data, novel applications, continual learning, implementations survey, reference repos)
- ✅ 5 planning specs (SSM foundation evaluation, temporal backbone, graph traversal model, Engram-informed predictor track, deep memory search)
- ✅ Desire paths epic Phase 1-3 (13 of 21 stories complete)
- ✅ DP-8 predictor bug fixes (complete)
- ✅ SSM proof of concept (Phase 0 gates passed)
- ✅ LLM-based synthetic data generator (`generate_scenarios.py`)
- ✅ Knowledge graph schema (KA-1 through KA-6)
- ✅ Predictive memory scorer sidecar (1.1M params, cross-attention, working but suboptimal)
- ✅ Session continuity protocol

**Not started:**
- ❌ DP-9 (path feedback propagation) — THE critical dependency
- ❌ DP-10 (path scoring)
- ❌ DP-11 (temporal reinforcement)
- ❌ DP-12 through DP-20 (Phase 5 emergence)
- ❌ SSM foundation evaluation harness (ssm-foundation-evaluation spec)
- ❌ SSM temporal backbone shadow deployment (ssm-temporal-backbone spec)
- ❌ SSM graph traversal model (ssm-graph-traversal-model spec)
- ❌ Engram-informed predictor ablations
- ❌ Turn-level telemetry (prompt_memory_rankings table)
- ❌ Deep memory search (agentic escalation)
- ❌ Per-user LoRA adapter infrastructure
- ❌ Rust SSM inference implementation

### The Exact Sequence

```
CURRENT STATE
    │
    ▼
PHASE 0: SSM Foundation & Evaluation ──────────────────────────
│  (spec: ssm-foundation-evaluation)
│
│  0a. Fix PoC known issues [1-2 days]
│      - Replace BCE with ListNet loss (KL divergence over softmax)
│      - Remove dead heads or add supervision for multi-head
│      - Fair MLP baseline with ListNet loss
│
│  0b. Build benchmark harness [2-3 days]
│      - Standalone Python (packages/predictor/bench/)
│      - Loads synthetic JSONL or real session exports
│      - Trains both SSM and cross-attention on identical splits
│      - Reports: HR@5/10, MRR@10, DCG@10, per-canary pass/fail,
│        SNR curve, dual-error test
│
│  0c. Engram-informed ablations [2-3 days]
│      - Multi-head hashing (K=2,4)
│      - Prime bucket count (16,381 vs 16,384)
│      - NFKC + lowercase normalization
│      - Parameter rebalancing (8K buckets + 128-dim internal)
│      - Separate gating (Engram-style alpha gate)
│      - Causal Conv1d post-gating (kernel=4, SiLU)
│
│  0d. Run all canary tests + SNR curves [1 day]
│      - 7/7 canary detection at 20dB
│      - MSE_True < MSE_Obs on all canaries
│      - Document per-pattern results
│
│  GATE: Canary detection >90% at 20dB, >70% at 10dB
│        MSE_True < MSE_Obs (learning, not memorizing)
│        No latency regression: p95 < 5ms
│
    ▼
DP-9: PATH FEEDBACK PROPAGATION ──────────────────────────────
│  (desire-paths-epic Phase 4) [3-5 days]
│
│  - Tag injected context with traversal path provenance
│  - Positive/negative feedback propagates along path edges
│  - Co-occurrence edge creation (Hebbian, NPMI-normalized)
│  - Q-value reward vocabulary (forward citation +1.0,
│    update after retrieval +0.5, downstream creation +0.6,
│    dead-end -0.15)
│  - Store path feedback history for SSM training data
│
│  THIS IS THE CRITICAL DEPENDENCY. Without DP-9, the SSM trains
│  on memory-level labels. With DP-9, it trains on path-level
│  labels where temporal modeling excels.
│
    ▼
PHASE 1: TURN-LEVEL TELEMETRY + REAL DATA ────────────────────
│  [1-2 weeks]
│
│  1a. New migration: prompt_memory_rankings table
│      (session_key, prompt_index, memory_id, rank, score, was_injected)
│
│  1b. Daemon export endpoint: GET /api/predictor/export-training-data
│      - Exports training pairs as JSONL matching harness format
│      - 17-dim feature vectors + labels + context embeddings
│
│  1c. Extend feature vector from 17-dim to 24-dim
│      - Add path-level features: hop_count, min_edge_confidence,
│        avg_aspect_weight, community_crossings, path_feedback_score,
│        log(dependency_strength_product), focal_distance
│
│  1d. Collect real data for 2-4 weeks
│
│  1e. Run TSTR protocol on accumulated real data
│
│  GATE: TSTR ratio >60% (synthetic-only achieves >60% of
│        real-only baseline)
│
    ▼
DP-10: PATH SCORING ──────────────────────────────────────────
│  (desire-paths-epic Phase 4) [3-5 days]
│
│  - Define TraversalPath type (ordered hops)
│  - Compute path-level features
│  - Scorer ranks paths, not individual memories
│  - Training signal: "was this path useful?" (from DP-9)
│
    ▼
PHASE 2: SHADOW MODE DEPLOYMENT ──────────────────────────────
│  (spec: ssm-temporal-backbone) [2-3 weeks]
│
│  2a. Deploy SSM temporal sidecar alongside current scorer
│      - Python first (faster iteration), Rust later
│      - Wire into daemon shadowMode infrastructure
│      - Log predictions, don't affect production scoring
│
│  2b. Enable per-user LoRA adaptation
│      - Adapter storage: ~/.daemon/ssm/lora-{agent_id}.bin
│      - Session-level TTT: one gradient step at session end
│      - Rank sweep: test rank 4, 8, 16
│
│  2c. Add drift detection (ADWIN-based)
│      - Prediction accuracy EMA
│      - Session volatility
│      - Adapter gradient magnitude
│
│  2d. Dashboard panel for SSM diagnostics
│      - SSM vs production agreement rate
│      - Per-canary performance
│      - Latency distribution
│      - Drift score
│
│  GATE: SSM's predicted top-K receives statistically better
│        agent feedback than production's top-K (p<0.05)
│        over minimum 50 sessions (SNIPS counterfactual)
│
    ▼
DP-11: TEMPORAL REINFORCEMENT ────────────────────────────────
│  (desire-paths-epic Phase 4) [3-4 days]
│
│  - Temporal features on paths (time of day, day of week,
│    session gap since last success)
│  - Pre-warming: predict and pre-traverse before query arrives
│  - Intent-aware signal weighting (episodic/procedural/
│    semantic/decision classification via regex)
│
    ▼
PHASE 3: PATH SSM DEPLOYMENT ─────────────────────────────────
│  (spec: ssm-graph-traversal-model) [2-3 weeks]
│
│  3a. Implement path feature encoder (12-dim per edge)
│  3b. Train path SSM (S4D, ~50K params) on synthetic + LoCoMo
│  3c. Shadow deployment alongside static path scorer
│  3d. Wire DP-9 path feedback into training pipeline
│  3e. Implement explainability (gradient attribution for
│      dominant edge/feature)
│
│  GATE: Multi-hop MRR improvement >10% on 3+ hop paths
│        Zero constraint suppression incidents
│        Path scoring adds <5ms p95
│
    ▼
PHASE 4: ONLINE A/B DEPLOYMENT ───────────────────────────────
│  [2-4 weeks]
│
│  4a. Blend SSM scores into production RRF
│      - Start alpha_ssm=0.1
│      - Increase based on shadow metrics
│  4b. Track agent feedback per arm
│      - Minimum 100 sessions per arm
│  4c. Automatic rollback on regression
│
│  GATE: Statistically significant improvement in
│        agent_relevance_score, no latency/contradiction
│        regression
│
    ▼
PHASE 5: RUST PORT + PRODUCTION ──────────────────────────────
│  [3-4 weeks]
│
│  5a. Port winning SSM configuration to Rust
│      - S4D for path scoring (diagonal complex multiply, no CUDA)
│      - Mamba-3 for temporal modeling (using mamba.rs/oxidizr/blazr)
│  5b. Quantize with heterogeneous INT8/INT4
│  5c. Replace current CrossAttentionScorer entirely
│  5d. Ship as part of signetai binary
│
    ▼
PHASE 6: FEDERATED BASE MODEL (FUTURE) ──────────────────────
│
│  - Per-user LoRA deltas (150KB-1.5MB) as communication payload
│  - Differential privacy noise at client before transmission
│  - Server averages deltas into base model update
│  - Ship updated base model with next Signet release
│
    ▼
CONTINUOUS OPERATION
```

### Critical Path

**DP-9 → DP-10 → DP-11** is the critical path through the desire paths epic. Everything in the SSM stack benefits from path-level feedback (DP-9) and path-level scoring (DP-10). The SSM specs explicitly depend on these.

**Estimated timeline to Phase 4 (online deployment):** ~3-4 months with focused effort. Phase 0 is 1-2 weeks. DP-9 is 1 week. Telemetry + data collection is 3-4 weeks. Shadow deployment is 2-3 weeks. A/B testing requires 100+ sessions.

---

## 5. Novel Insights

These emerged from deep reading of the complete spec library — they weren't obvious from surface summaries.

### 5.1 The Dual-SSM Constraint Is Real, Not Aesthetic

GraphSSM's S4 > Mamba result on graph data isn't a minor preference — it's a consistent 6-12% gap across multiple datasets. The explanation is architectural: Mamba's selectivity (deciding what to gate per input) is actively harmful for graph topology because it can learn to ignore structurally important but content-poor nodes. S4's fixed HiPPO transitions preserve structural information uniformly. This means Signet genuinely needs two different SSM variants: S4D for path/graph scoring and Mamba for sequential interaction modeling. This adds implementation complexity but the research is unambiguous.

### 5.2 29 > 2000: The Diversity Paradox

The PoC's most counterintuitive finding: 29 LLM-generated scenarios outgeneralized 2000 hand-crafted sequences. The gen gap was *negative* (-3.6%), meaning the model performed better on unseen data than training data — zero memorization. This aligns with DR4SR (KDD 2024 Best Paper): quality and diversity beat quantity. The implication is that the synthetic data pipeline should optimize for scenario diversity (more behavioral archetypes from LLM generation) rather than volume (more numpy-distributed sequences). An overnight LLM run generating 500 diverse scenarios should dramatically outperform the current hand-crafted corpus.

### 5.3 Contradiction Detection as Anomaly Detection

The specs frame contradiction detection as a classification problem (34 antonym pairs, temporal marker regex). The research reframes it as anomaly detection: model the normal pattern of entity evolution with an SSM, and contradictions appear as anomalies — spikes in reconstruction error. Mamba-TSAD achieves 75.37% F1 on time series anomaly detection. If the knowledge graph update stream is modeled as a time series of (entity, attribute, value, timestamp) tuples, contradictions are deviations from learned normal evolution. This transforms a rule-based problem into a learned, adaptive one — and it gets better as the SSM sees more data.

### 5.4 The Tokenization Insight Matters for Signet

Gu's analysis reveals: *"The inductive bias of soft attention is hard attention."* Transformers work best on pre-compressed, semantically meaningful tokens. When data is high-resolution and individual elements aren't independently meaningful, SSMs have a clear modeling advantage because they naturally compress into meaningful abstractions. Agent interaction data — timestamps, memory accesses, feedback signals — is exactly this regime: high-resolution, irregularly-sampled, individual data points not independently meaningful. This isn't just a theoretical fit; it's the precise regime where SSMs consistently outperform transformers in benchmarks.

### 5.5 The SSM State IS the Identity Embedding

An unresolved but powerful idea: the persistent SSM hidden state could serve as a compact representation of agent identity/personality. An agent's "feel" — interaction patterns, topic preferences, temporal rhythms, knowledge domain strengths — encoded in ~256 floats that evolve with every session. This complements SOUL.md (declarative personality) with learned behavioral personality. No paper has explored this for agent identity coherence — it's a potential novel research contribution.

### 5.6 The Wake-Sleep Cycle Maps Perfectly to Daemon Lifecycle

The SleepGate / WSCL research describes a biological learning pattern: Wake (process input, accumulate signals), NREM (consolidate, replay, strengthen important patterns), REM (explore, generate novel scenarios). The daemon lifecycle already has these phases: active sessions (wake), idle periods (natural NREM trigger), and scheduled maintenance (potential REM). The insight is that SSM training should NOT happen on a clock — it should happen when the daemon transitions between lifecycle phases. Active: inference only. Idle: gradient updates + adapter refinement. Maintenance: canary re-validation + synthetic exploration.

### 5.7 The Reference Systems Validate Signet's Architecture

Ori-Mnemos (TypeScript, 12K LOC) and Zikkaron (Python, 26 subsystems) are the closest open-source competitors. Both validate Signet's architectural choices (multi-signal fusion, knowledge graphs, decay models) while revealing specific gaps. The most actionable patterns from each:

From **Ori-Mnemos**: Q-value reward vocabulary for path feedback (already folded into DP-9), co-occurrence Hebbian edge growth (folded into DP-9), post-fusion dampening (DP-16), intent-aware query routing (folded into DP-11). Benchmark: 90% Recall@5 on HotpotQA, 9.5x faster than Mem0.

From **Zikkaron**: Reconsolidation on retrieval (folded into DP-13), predictive coding write gate (DP-19), hippocampal replay compaction (DP-17), decision auto-protection (DP-18), bi-temporal data model. Benchmark: 96.7% Recall@10 on LongMemEval, MRR 0.945.

Neither uses SSMs. Signet's SSM integration would be genuinely novel in this space.

### 5.8 Passive Recall ≠ Agentic Performance

MemoryArena (2026) showed models scoring near-perfect on passive recall tests dropped to 40-60% on agentic tasks requiring memory-informed *decisions*. This means Signet's evaluation must include end-to-end agent task outcomes (does memory injection improve task completion?), not just retrieval metrics (did the right memory appear in top-K?). The evaluation spec addresses this via shadow mode comparison of agent feedback signals, not just retrieval accuracy.

---

## 6. Open Questions

### Critical (Must Resolve Before Phase 2)

**6.1 Python or Rust for Shadow SSM?** PyTorch is faster to iterate (existing PoC, mature ecosystem, debugging tools) but adds a heavy runtime dependency. Rust keeps deployment lightweight but requires implementing selective scan from scratch (or using immature mamba.rs/oxidizr). **Recommendation from the research:** Python for shadow mode evaluation, Rust port only for the winning configuration. The specs agree with this — ssm-foundation-evaluation explicitly recommends "PyTorch for evaluation, port winning configuration to Rust afterward."

**6.2 Parameter budget: 1M or 5M?** The current cross-attention scorer is 1.1M params. The research suggests 5-10M for meaningful temporal learning (FlowState proves viability at 9.1M). But the PoC showed gains at 50K params. **Tension:** At 1M, the SSM is a drop-in replacement for the existing scorer. At 5M, it's a qualitatively different model that requires more training data and compute. The foundation evaluation spec lists this as open decision #3.

**6.3 Multi-head readout or single-head?** The PoC has 5 output heads (relevance, significance, retention, traversal, contradiction) but only relevance is supervised. Multi-head without multi-target is dead weight. **The honest question:** Do we have training signal for the other heads? Significance can use extraction outcomes. Retention can use access patterns. Contradiction can use supersession events. Traversal needs DP-9 path feedback. The answer determines whether to ship a 1-head model now or invest in multi-head from the start.

### Important (Should Resolve Before Phase 3)

**6.4 Complex-valued state for cyclical patterns:** Mamba-3's complex state models oscillations naturally. How much does this actually help for daily/weekly patterns? Testable: plant cyclical canary patterns, compare complex vs real state detection rates. No one has benchmarked this at our scale.

**6.5 MIMO for multi-task prediction:** Can MIMO SSMs predict relevance, retention, and significance from a single forward pass without task interference? Or do the tasks compete for state capacity? Testable: compare multi-head MIMO vs separate models.

**6.6 Dual-SSM combiner design:** The S4D (paths) + Mamba (sequences) dual architecture needs a combiner. Options: learned weighted sum, gated mixture, cross-attention between state vectors. Simplest viable option: concatenate both outputs into the readout head input. Research doesn't clearly resolve this.

**6.7 Minimum sessions for learned decay to beat 0.95^ageDays:** DyG-Mamba learns entity-specific forgetting curves, but how many sessions does each entity need before the learned curve outperforms the fixed one? If it's 50+ sessions per entity, most entities will never accumulate enough data. The foundation evaluation should include a cold-start stratified analysis specifically for the decay head.

### Forward-Looking (Phase 5+)

**6.8 Federated aggregation heterogeneity:** Users have wildly different interaction patterns. FedSSM handles heterogeneous data but hasn't been tested at Signet's behavioral diversity scale.

**6.9 Privacy-preserving SSM states:** SSM hidden states compress user data. What information leaks from the state? Can differential privacy be applied to state updates? No published research addresses this.

**6.10 SSM state merging for multi-agent identity:** When multiple agents share an identity, how do you merge their hidden states into a coherent whole? No published research addresses this either.

**6.11 Can a 2-10M parameter SSM learn contradiction detection?** Currently requires LLM calls (Zep's approach). The anomaly detection framing is promising but unproven for semantic contradictions at this scale.

---

## 7. Connection to CRM + Gmail Scaling

### What Jake Asked

How does the SSM research map to scaling Signet via CRM (GoHighLevel) and Gmail integration? What's already designed vs what needs new work?

### What's Already Designed

The SSM architecture is designed to be **data-source agnostic.** The model consumes a 17-dim (soon 24-dim) feature vector per memory candidate. Where the memory *came from* — a coding session, a CRM contact record, a Gmail thread — doesn't change the model architecture. The features that matter are temporal (when was it accessed, how often, what's the session gap), structural (entity connections, graph density), and behavioral (was it useful when injected). All of these apply regardless of data source.

**Specific pieces already designed for scale:**

1. **The event-driven SSM architecture** (from Novel Applications research, §6.2): The SSM activates only when hooks fire, not on a clock. CRM webhook events and Gmail notifications are hooks. The SSM processes each event, updates its hidden state, and goes idle. Zero CPU between events. This means adding CRM/Gmail as data sources doesn't increase baseline resource consumption — only event-processing cost, which is O(1) per event.

2. **Multi-scale temporal hierarchy** (HiSS/MS-SSM): CRM and Gmail have different temporal rhythms than coding sessions. CRM contacts cycle on sales-pipeline timescales (days to weeks). Gmail threads cycle on conversation timescales (hours to days). Coding sessions cycle on focus timescales (minutes to hours). The multi-scale SSM architecture handles this natively — different scales capture different rhythms. A CRM-focused user would have slow high-level dynamics; a coding-focused user would have fast low-level dynamics. The SSM learns the user's actual temporal mix.

3. **Entity graph generalization:** The KA schema (entities → aspects → attributes → dependencies) works for CRM contacts (entity: "John Smith", aspect: "deal status", attribute: "closed won $50K") and Gmail threads (entity: "Q1 Planning Thread", aspect: "decisions", attribute: "approved budget increase") exactly as it does for code entities. The knowledge graph doesn't know or care about the data source.

4. **Per-user LoRA adapters:** A user who primarily uses CRM will develop different adapter weights than a user who primarily codes. The shared base model captures universal temporal patterns (recency, cyclicality, burst access). The per-user adapter captures domain-specific patterns (CRM users care about deal stage transitions; developers care about dependency changes). This personalizes automatically.

5. **Federated learning path:** CRM/Gmail users contribute to the shared base model via anonymized LoRA deltas. The base model improves for all users as more diverse interaction patterns flow in. A CRM-heavy user base teaches the model about relationship management patterns; a developer-heavy base teaches code knowledge patterns. Both benefit from cross-pollination.

### What Would Need New Work

1. **Data source-specific feature engineering:** The current 17-dim (soon 24-dim) feature vector is implicitly optimized for coding sessions. CRM data would benefit from additional features:
   - `deal_stage_velocity` — how fast is this entity moving through pipeline stages?
   - `contact_last_interaction_channel` — email, phone, meeting, form submission?
   - `contact_relationship_depth` — number of interactions, duration of relationship
   - `pipeline_position` — where in the sales funnel is this relevant?

   Gmail would benefit from:
   - `thread_length` — number of messages in the thread
   - `participant_count` — how many people involved
   - `reply_latency` — how quickly are responses coming
   - `thread_recency_vs_volume` — high-volume old threads vs low-volume recent ones

   These could be added as optional dimensions (25-30 total) that are zero when the data source doesn't provide them. The SSM learns to ignore zero dimensions via its selective mechanism.

2. **CRM/Gmail-specific extraction:** The current extraction pipeline is optimized for coding conversations (function signatures, API references, architecture decisions). CRM data needs: contact attribute extraction, deal stage detection, relationship mapping, objection tracking. Gmail needs: action item extraction, decision detection, commitment tracking, thread summarization. These are extraction pipeline changes, not SSM changes — the SSM consumes whatever the extraction pipeline produces.

3. **Cross-source entity resolution:** When the same person appears in CRM (as a contact), Gmail (as a sender), and coding sessions (as a collaborator mentioned by name), those three entity records need to merge. The inline entity linker (DP-6a) handles within-source resolution; cross-source resolution needs additional heuristics (email match, name fuzzy match, explicit user linking).

4. **Webhook/sync infrastructure:** CRM (GoHighLevel) and Gmail APIs need webhook receivers and sync workers to ingest data into Signet's pipeline. This is plumbing, not ML — but it's necessary plumbing. The SSM architecture assumes data arrives as events via the hook pipeline; the infrastructure to generate those events from external APIs doesn't exist yet.

5. **Data volume considerations:** A single CRM account might have thousands of contacts with tens of thousands of interactions. A Gmail account has years of threads. The current entity graph already has a bloat problem (43,520 entities, target <1,000). CRM/Gmail would make this dramatically worse without aggressive entity pruning. The DG-Mamba PRI regularization (learned graph pruning) would become essential, not optional. The SSM's ability to learn which entities matter (via selective gating) would be the primary defense against entity explosion.

### The Bottom Line

**~70% of what's needed for CRM/Gmail scaling is already in the SSM architecture design.** The temporal backbone, per-user adaptation, event-driven processing, multi-scale hierarchy, and entity graph all generalize to new data sources without redesign. The remaining ~30% is: source-specific feature engineering (a few extra dimensions), extraction pipeline adaptation (prompts and patterns for CRM/Gmail data types), cross-source entity resolution (a dedup challenge), and sync infrastructure (API plumbing). None of this requires rethinking the SSM architecture — it's about feeding it data from new sources.

The SSM actually makes CRM/Gmail integration *more* feasible than without it. The current heuristic-based pipeline would need per-source tuning of every threshold (significance gate, decay rate, traversal weights). The SSM learns these automatically from each user's interaction patterns with each data source. A CRM-heavy user gets CRM-optimized memory without anyone writing CRM-specific heuristics.

---

## Appendix: Document Index

### Research Documents (in `docs/research/technical/`)
| # | Document | Key Contribution |
|---|----------|-----------------|
| 1 | SSM-LITERATURE-REVIEW.md | 26 foundational papers, parameter budgets, personalization strategy |
| 2 | SSM-GRAPH-INTERSECTION.md | 30+ papers on SSMs × knowledge graphs, DyGMamba, GraphSSM, NeuralWalker |
| 3 | RESEARCH-SSM-INTEGRATION.md | Full integration map, validation contracts, PoC results, implementation plan |
| 4 | SYNTHETIC-DATA-GENERATION.md | Data generation architecture, curriculum learning, TSTR protocol |
| 5 | SSM-NOVEL-APPLICATIONS.md | 35+ papers: anomaly detection, causal discovery, world models, 1.58-bit |
| 6 | SSM-CONTINUAL-LEARNING-DEEP-DIVE.md | TTT, catastrophic forgetting, LoRA, federated learning, sleep cycles |
| 7 | ssm-implementations-survey.md | 20+ repos, Rust ecosystem, production deployments, deployment patterns |
| 8 | RESEARCH-REFERENCE-REPOS.md | Ori-Mnemos, Zikkaron, Supermemory ASMR pattern analysis |

### Planning Specs (in `docs/specs/planning/`)
| # | Document | Purpose |
|---|----------|---------|
| 9 | ssm-foundation-evaluation.md | Benchmark harness, PoC fixes, Engram ablations, acceptance gates |
| 10 | ssm-temporal-backbone.md | Shadow sidecar deployment, per-user LoRA, drift detection |
| 11 | ssm-graph-traversal-model.md | S4D path scorer, edge feature encoding, explainability |
| 12 | engram-informed-predictor-track.md | Engram pattern translations, hash/gate experiments, handoff contract |
| 13 | deep-memory-search.md | LLM escalation for low-confidence retrieval, confidence thresholds |

### Approved Spec
| # | Document | Purpose |
|---|----------|---------|
| 14 | desire-paths-epic.md | 21-story epic from flat retrieval to learned traversal, Phase 1-3 complete |
