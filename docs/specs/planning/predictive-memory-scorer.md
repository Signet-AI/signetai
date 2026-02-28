---
title: "Signet Predictive Memory Scorer"
---

# Signet Predictive Memory Scorer

## The North Star

Signet isn't just a memory database with search. It's a prediction
algorithm. Every time an agent wakes up, it faces the same question:
*"what do I need to remember right now to be the most useful version
of myself?"*

Today, that question is answered with a decay formula and keyword
matching. Tomorrow, it's answered by a model that *knows you* -- one
that has learned from every session what makes a memory relevant,
what patterns matter, what time of day you work on what project, and
which memories actually helped versus which ones just took up context
window space.

This is the feature that transforms Signet from a memory system into
a mind. A model unique to each user, trained on their own interaction
patterns, that gets better at predicting what they need the longer
they use it. No cloud. No shared weights. Your model, your patterns,
running locally, earning its influence by proving it's better than
the baseline.

If we ship this right, it's the clearest proof that Signet delivers
on its vision: "the difference between a tool that remembers and a
mind that persists."

## Context

Signet's memory injection is currently naive: `importance * 0.95^days` with a
recurring-terms BM25 fallback. `access_count` and `last_accessed` are tracked
but unused. The continuity scorer evaluates session outcomes but doesn't feed
back into future scoring. Meanwhile, recent research (ACAN, Memory-R1) shows
that learned memory retrieval dramatically outperforms heuristic approaches -
but nobody is training a per-user model that progressively improves on their
personal memory corpus. That's what we're building.

## Research Foundation

- **ACAN** (cloned to `references/acan/`): Cross-attention scorer with
  LLM-based comparative loss. 3 linear projections + softmax. ~7M params.
  Trains in 5 epochs. Key insight: use LLM to score memory quality instead
  of human labels.
- **Memory-R1** (paper only, arxiv:2508.19828): RL-trained memory manager.
  Only 152 training pairs needed. Outcome-driven reward (did memories help?).
  Key insight: don't label operations, measure final outcomes.
- **microgpt** (`references/microgpt/`): From-scratch Rust transformer with
  operation-level autograd, zero deps. Training + inference in ~720 LOC.
- **X/Twitter For You Algorithm** (`references/x-algorithm/`): Production
  recommendation pipeline — Phoenix ranker (Grok-1 transformer with candidate
  isolation attention mask), two-tower retrieval, weighted multi-action scoring,
  author diversity decay, Rust candidate pipeline framework. Key insights:
  candidate-set-independent scoring via attention masking, multi-action
  prediction heads with tunable weights, topic diversity as a post-scoring
  pass, behavioral signals (not LLM judges) as training ground truth.

## Architecture

Standalone Rust binary at `packages/predictor/` (new crate). Daemon spawns
it as a sidecar, communicates via stdin/stdout JSON-RPC 2.0.

### Candidate Pre-Filtering

Heavy users accumulate 2,000-4,000 memories/month. The cross-attention
scorer operates on a pre-filtered candidate pool of ~50-100 memories, not
the full corpus. The pre-filtering stage narrows the corpus before the
predictor sees it:

```
Full corpus (2,000-4,000 memories)
  |
  +-- effectiveScore() ranks all memories (existing, fast)
  |
  +-- Embedding similarity: cosine(session_context, memory_embedding)
  |   for top-200 by effectiveScore (pre-computed embeddings, ~2ms)
  |
  +-- Union of top-50 by effectiveScore + top-50 by embedding similarity
  |   (deduped, typically ~70-90 candidates)
  |
  +-- This candidate pool is sent to the predictor for scoring
```

Two pre-filter paths catch different kinds of relevance: effectiveScore
captures recently important memories (recency + importance decay), while
embedding similarity captures topically relevant memories that may have
low importance scores but match the current session context. The union
ensures neither signal dominates.

At 4,000 memories, the bottleneck is JSON serialization over stdin/stdout,
not computation. Sending ~80 candidate embeddings (768-dim float32) is
~245KB of JSON. The pre-filter keeps this bounded regardless of corpus
size.

### Model: Cross-Attention Memory Scorer (inspired by ACAN)

Not a full transformer. The task is *ranking*, not *generation*. Simpler
architecture, faster inference, easier to train on limited data.

```
Query (session context embedding)     Memory Bank (N memory embeddings)
        |                                       |
   Linear(d, d)                           Linear(d, d)  [key]
        |                                 Linear(d, d)  [value]
        Q                                    K, V
        |                                     |
        +-------> Scaled Dot-Product --------+
                  Attention(Q, K, V)
                        |
                   softmax scores
                        |
                  top-k selection
                        |
              scored memory rankings
```

Where `d` = internal embedding dimension.

**Two encoding paths** (supporting both pre-embedded and raw text memories):

1. **Pre-embedded path**: When Signet has stored vector embeddings, use a
   learned downprojection: `native_dim -> d` (e.g., 768 -> 64)
2. **Text path**: HashTrick tokenizer (word-level, 16,384 buckets, d-dim
   embeddings) + mean pooling. No vocabulary to maintain, fixed memory,
   zero OOV problem. Works immediately on any text. Bucket count is
   sized for code-heavy memories where vocabulary entropy is high —
   4096 buckets caused frequent collisions on variable names and
   technical jargon; 16K reduces collision rate ~4x while staying
   comfortably in lower cache hierarchy on most modern CPUs.

**Path normalization** (handling mixed candidate sets):

When candidate memories are a mix of pre-embedded and text-only, the
two encoding paths can produce representations on different scales.
Without normalization, the model may silently learn path-dependent
scoring artifacts (e.g., "text path scores lower"). Mitigations:

- `is_embedded` indicator feature (1 dim) added to the scoring signals,
  allowing the gate to learn path-specific calibration
- Per-path layer normalization applied after projection into shared `d`
  space, before attention. This ensures both paths produce
  zero-mean/unit-variance representations regardless of source.
- The downprojection (pre-embedded) and HashTrick+mean-pool (text) are
  separate projections that merge into the same `d`-dimensional space
  — the layer norm after each ensures distributional compatibility.

**Additional scoring signals** (concatenated before final gate):
- `log(age_days)` - recency
- `importance` - existing importance score
- `log(access_count + 1)` - usage frequency (currently tracked but UNUSED)
- time-of-day encoding (2 dims, sin/cos)
- day-of-week encoding (2 dims, sin/cos)
- month-of-year encoding (2 dims, sin/cos) - captures quarterly/seasonal
  patterns; at 50 sessions/day, learnable within 2-3 months
- session gap duration (1 dim, log-scaled)
- `is_embedded` indicator (1 dim, path normalization signal)
- `is_superseded` indicator (1 dim) - memory has been superseded or
  deprecated; strong negative signal (see Negative Memory Signals below)
- project embedding (d dims) - learned embedding for the current project,
  allowing the model to discover project-specific relevance patterns.
  Projects are hashed to a small embedding table (32 entries x d dims).
  At 50 sessions/day across multiple projects, the model has enough data
  to specialize. (Inspired by X algorithm's `product_surface` embedding
  which encodes interaction context as a categorical feature shared
  between history and candidates.)

This is effectively a **learned MoE-style gate** (per the research) that
discovers per-user weights for similarity vs recency vs importance vs
access patterns vs project context. The model learns temporal patterns
like "nicholai works on ooIDE in the evenings" and project patterns like
"signetai sessions need pipeline memories, ooIDE sessions need UI state."

### Parameter Budget (d=64 internal dim)

- HashTrick embeddings: 16,384 x 64 = 1,048K
- Downprojection (for pre-embedded): 768 x 64 = 49K (768 = current embedding dim)
- Q projection: 64 x 64 = 4K
- K projection: 64 x 64 = 4K
- V projection: 64 x 32 = 2K
- Layer norm (2 paths, scale+shift): 2 x 64 x 2 = 256 params
- Project embedding table: 32 x 64 = 2K
- Gate layer: (32 + 12 features) x 1 = 44 params
  (12 = age + importance + access_count + tod_sin + tod_cos + dow_sin +
  dow_cos + moy_sin + moy_cos + session_gap + is_embedded + is_superseded)
- **Total: ~1.11M parameters** (sub-2M target)

Note: downprojection sized for current 768-dim embeddings. If embedding
provider changes to 1536-dim, this grows by ~49K — still well within budget.

### Training Signals

**Primary signal: Continuity Score** (already exists in `session_scores` table)
- `score` (0-1): how well did injected memories help?
- `memories_used`: count of memories that were actually relevant
- `novel_context_count`: how many times user had to re-explain things

**Training data format:**
```json
{
  "session_id": "abc123",
  "project": "signetai",
  "context_embedding": [0.1, 0.2, ...],
  "candidate_memory_ids": ["mem_1", "mem_2", ...],
  "injected_memory_ids": ["mem_1", "mem_5", ...],
  "continuity_score": 0.85,
  "memories_used": 4,
  "novel_context_count": 1,
  "timestamp": "2026-02-25T06:00:00Z"
}
```

**Label construction** (inspired by ACAN + Memory-R1 + X algorithm behavioral signals):
- Memories injected in high-scoring sessions: label = continuity_score
- Memories injected in low-scoring sessions: label = continuity_score * 0.5
- Memories that existed but weren't injected, where novel_context_count > 0
  (user had to re-explain things): label = 0.7 default (or higher when
  continuity scorer marks them as clearly missing context)
- Non-injected memories (3:1 negative:positive ratio): label depends on
  embedding similarity to session context:
  - cosine_sim > `negativeSimilarityThreshold` (default 0.6): label = 0.25
    (possible baseline miss — the heuristic scorer may have overlooked a
    relevant memory, so we avoid training the predictor to repeat that mistake)
  - cosine_sim <= threshold: label = 0.0 (true negative)
  - Embeddings are already stored per-memory, so this filter is nearly free
- **Superseded/deprecated memories**: label = -0.3 (negative label). These
  are the equivalent of X algorithm's `not_interested` / `block_author`
  negative action signals. A memory that was once important but has been
  explicitly superseded is *actively harmful* to inject — it contains
  outdated context. The memory pipeline already tracks `superseded_by`
  and importance decay. Negative labels teach the predictor what NOT to
  surface, not just what to surface.

### Behavioral Training Signals (from hooks)

The continuity scorer (LLM judge) is the primary training signal but
not the only one. `handleUserPromptSubmit()` in `hooks.ts` already runs
FTS + effectiveScore on every user prompt during a session. At 50
sessions/day with 10-20 prompts/session, this produces 500-1,000
behavioral observation points per day — observed behavior, not inferred
quality from an LLM judge.

**FTS overlap signal**: The strongest behavioral signal available.

```
Session Start:
  predictor injects memories [A, B, C, D, E] into context

During Session (userPromptSubmit, multiple times):
  user prompt 1 → FTS matches [A, F, G]
  user prompt 2 → FTS matches [B, H]
  user prompt 3 → FTS matches [F, A, I]

Session End:
  FTS hit analysis:
  - A: injected AND matched by FTS 2x → strong positive
  - B: injected AND matched by FTS 1x → positive
  - C, D, E: injected but NEVER matched → weak signal (useful as
    background context? or deadweight?)
  - F: NOT injected but matched by FTS 2x → strong negative for
    predictor (should have been injected, user had to retrieve manually)
  - G, H, I: NOT injected, matched 1x → mild negative
```

**Label adjustment from behavioral signals:**

FTS overlap is combined with continuity scorer labels as a weighted
anchor. The behavioral signal doesn't replace the LLM judge — it
grounds it in observed behavior:

- Memory injected AND matched by FTS during session: continuity label
  gets a +0.1 boost (capped at 1.0). Behavioral confirmation.
- Memory NOT injected but matched by FTS >= 2 times: label = max(0.6,
  similarity_label). The user actively searched for this — the predictor
  missed it.
- Memory injected but never matched by FTS AND continuity score < 0.3:
  label reduced by 0.1. Both signals agree it wasn't useful.

**Why this matters**: The LLM judge is a second-order signal (a model
interpreting another model's behavior). FTS hits are first-order — the
user's actual prompts naturally match memories they need. This is the
closest analog to X algorithm's behavioral signals (clicks, dwells,
favorites). X never leaves a behavioral signal on the floor.

**Additional behavioral signals** (lower weight, supplementary):

| Signal | Label Effect | Source |
|--------|-------------|--------|
| `access_count` high + not injected | +0.05 to label | memories table |
| Memory edited/updated recently | +0.05 to label | memory_history |
| Memory superseded since session | -0.3 (negative) | memories table |
| `novel_context_count` > 0 | +0.1 to missing memory labels | session_scores |

**Recording**: Per-session FTS hits are recorded in a new column on
`session_memories`: `fts_hit_count INTEGER DEFAULT 0`. Updated by
`handleUserPromptSubmit()` each time a memory matches an FTS query
during the session. This requires no schema change to the FTS system
itself — just an UPDATE on existing `session_memories` rows.

### Negative Memory Signals

Inspired by X algorithm's explicit negative action prediction (P(block),
P(mute), P(report), P(not_interested)) with negative weights in the
weighted scorer. X's best design decision is modeling what users DON'T
want alongside what they do.

Signet's equivalent negative signals:

- **Superseded memories**: `superseded_by IS NOT NULL` in the memories
  table. Once-important, now actively wrong. Label = -0.3.
- **Low-importance decayed memories**: importance < 0.1 after decay.
  The pipeline already decided these aren't worth keeping prominent.
  Label = 0.0 (true negative), excluded from candidate pool entirely
  during pre-filtering.
- **Memories the user explicitly deleted or marked obsolete**: strongest
  negative signal. If a memory was deleted within 24h of being injected
  in a session, that's a clear "don't show me this" signal. Label = -0.5.

These negative labels serve the same purpose as X's negative action
weights: they actively push the model away from bad predictions, not
just toward good ones. A predictor that only learns "what's relevant"
without learning "what's harmful to inject" will eventually surface
outdated context that confuses the agent.

**Training data SQL assembly** (predictor reads memories.db directly):
```sql
-- Sessions with outcome scores
SELECT sj.session_key, sj.project, sj.transcript,
       ss.score, ss.memories_used, ss.novel_context_count
FROM summary_jobs sj
JOIN session_scores ss ON sj.session_key = ss.session_key
WHERE sj.status = 'completed'
ORDER BY sj.created_at DESC LIMIT 500;
```

**Training schedule:**
- Triggered by daemon sending `train` command after every N sessions
  (configurable, default 10)
- Training runs in-process with strict concurrency isolation:
  - Inference always runs against an immutable weight snapshot
  - Training operates on a cloned parameter set, never the live one
  - On training completion, validation gates must ALL pass before swap:
    - All losses finite (no NaN/Inf)
    - Score variance > 0 on a fixed canary batch (10 sessions,
      refreshed weekly from highest-confidence scored sessions)
    - Top-k stability: overlap between new and old model's top-5 on
      canary batch >= 60% (catches catastrophic forgetting)
    - NDCG on canary batch does not decrease by more than 0.15
  - If validation passes: atomic pointer swap to new weights
  - If validation fails: discard trained weights, log failure, keep
    serving previous model, increment `train_validation_failures`
    counter in predictor_training_log
  - No partial state mutation is ever possible — the swap is all or
    nothing
- Max training time: 30 seconds, early stop if exceeded
- Full retrain: weekly maintenance or when >50 new pairs accumulate

### Cold Start

Before the predictor has been trained:
- Predictor responds with `model_ready: false`
- Daemon uses pure `effectiveScore()` + BM25 (zero blend weight)
- Both predictor and baseline recommendations are still *recorded* so
  comparisons can begin as soon as the first training completes
- Training data silently accumulates in background
- First training triggers after `trainIntervalSessions` (default 10)
  completed sessions with continuity scores

**Cold start exit conditions** (all three must be met):
1. First training has completed successfully
2. `session_count >= minTrainingSessions` (default 10)
3. `success_rate > 0.4` over last 10 comparisons

Until all three are met, α remains locked at 1.0 (pure baseline). The
predictor trains and its scores get recorded for comparison, but it has
zero influence on actual memory injection. This prevents a barely-trained
model from degrading the user experience.

**Early active phase ramp:** Even after cold start exit, predictor
influence is capped during early active sessions:
- Sessions 1-10 after cold start exit: max predictor influence = 0.2
  (α floor = 0.8, regardless of success_rate)
- Sessions 11-20: max influence = 0.4 (α floor = 0.6)
- Sessions 21+: no cap, α fully determined by success_rate

This extra seatbelt prevents a predictor that got lucky on a few early
comparisons from gaining outsized influence before it has a meaningful
track record. The cap is a floor on α, not a ceiling on success_rate
— the EMA continues updating normally, it just can't push α below the
floor until enough sessions accumulate.

Realistic expectation: the predictor starts producing non-uniform scores
quickly (~10 sessions), but beating a tuned heuristic baseline likely
takes 30-50 sessions. Listwise loss gives one gradient step per session,
which is more stable than RL but needs more data.

## Integration: Parallel Scoring Layer

The predictor runs alongside existing scoring, not replacing it.

### Hook Flow (session-start)

```
handleSessionStart() in hooks.ts
  |
  +-- Pre-filter: effectiveScore top-50 ∪ embedding sim top-50
  |   (narrows 2,000-4,000 corpus to ~70-90 candidates)
  |
  +-- effectiveScore() rankings on candidate pool  -- always runs
  |
  +-- predictor.score(context, candidates)         -- always runs (after cold start)
  |
  +-- BOTH sets of recommendations are recorded
  |
  +-- RRF fusion with α from predictor success rate
  |
  +-- Topic diversity decay on fused rankings
  |
  +-- top-k from diversity-adjusted ranks
```

**No fixed blend weights.** The predictor earns its influence through
demonstrated performance, measured at the end of each session.

### Exploration Sampling

Because the predictor influences what gets injected, it also influences
what gets judged, which influences training. This feedback loop can
collapse exploration: the model becomes overconfident in its current
top picks and never discovers that a lower-ranked memory would have
been more useful.

**Mitigation:** Reserve one injection slot (configurable) for
exploration at a low rate:
- With probability `explorationRate` (default 0.05, ~1 in 20 sessions),
  replace the lowest-ranked injected memory with a high-uncertainty
  candidate: one where predictor and baseline disagree most on ranking
  (largest rank delta)
- The explored memory is tagged in `session_memories` with
  `source = 'exploration'`
- Exploration memories receive normal continuity scoring, providing
  ground truth for candidates the model otherwise would never see
- Exploration is disabled during cold start (no predictor rankings to
  disagree with)

This is epsilon-greedy exploration applied to memory ranking. The rate
is low enough to be invisible to the user but high enough to prevent
the predictor from creating a self-reinforcing bubble.

### Topic Diversity (post-scoring)

Inspired by X algorithm's `AuthorDiversityScorer`, which applies
exponential decay to prevent feed domination by a single author.
Without diversity enforcement, a corpus with 15 memories about the
same refactoring effort could fill the entire injection window with
overlapping information — wasting context window budget.

After RRF fusion produces the final ranked list, apply topic diversity
before top-k selection:

```
Sort candidates by fused_score descending.
For each candidate in order:
  For each already-selected candidate:
    if cosine_sim(candidate.embedding, selected.embedding) > 0.85:
      candidate.score *= (1 - floor) * decay^overlap_count + floor
      overlap_count += 1
```

Where:
- `decay = 0.5` — second memory on same topic gets half credit
- `floor = 0.1` — never fully suppress, even the 4th overlapping memory
- `overlap_count` = how many already-selected memories are >0.85 similar
- Similarity computed on pre-stored embeddings (no extra embedding calls)

This is a simple post-scoring pass, exactly like X's author diversity:
deterministic, no state, just attenuates redundancy. First memory on
a topic gets full score; second gets ~0.55x; third gets ~0.33x.

The 0.85 cosine threshold is high enough that genuinely distinct memories
about related topics (e.g., "pipeline architecture" vs "pipeline bug fix")
won't trigger diversity decay. Only near-duplicates and heavily overlapping
content get attenuated.

### Ranking Fusion: Reciprocal Rank Fusion (RRF)

Instead of linear score blending (`w*a + (1-w)*b`), use Reciprocal Rank
Fusion (from Hindsight / IR literature). RRF works on *ranks* not raw
scores, so it's robust even when the predictor and baseline produce
scores on different scales:

```
RRF_score(memory) = α/(k + rank_baseline) + (1-α)/(k + rank_predictor)
```

Where:
- `k = 12` (tuned for ~50 candidate memories; the standard k=60 is sized
  for 1000+ candidate document retrieval and compresses rank variance at
  our scale — with k=12, rank 1 vs rank 50 has ~4.8x score spread vs
  only ~1.8x at k=60)
- `α` = baseline's earned weight (starts at 1.0, decreases as predictor wins)
- `rank_baseline` = memory's position in effectiveScore ranking
- `rank_predictor` = memory's position in predictor ranking
- If a memory is missing from one ranker, use `rank = candidate_count + 1`
  for that side

### Success Rate Tracking (the predictor earns α)

At session-end, after per-memory continuity scoring completes, we compare
quality using **NDCG@10 (Normalized Discounted Cumulative Gain)** over a
single labeled evaluation pool:
- `evaluation_pool = union(top10_baseline, top10_predictor, injected_ids)`
- Continuity scorer provides per-memory scores for injected memories
- Non-injected memories in the pool are scored in a second lightweight
  pass, or defaulted to `0.0` if confidently irrelevant

```
// Only update EMA from high-confidence sessions
if continuity_confidence < 0.6:
  record comparison for audit but skip EMA update
  return

// Compute NDCG for each system's ranking against actual relevance scores
predictor_ndcg = ndcg(predictor_ranking, per_memory_relevance_scores)
baseline_ndcg  = ndcg(baseline_ranking, per_memory_relevance_scores)

// Did the predictor produce a better ordering?
session_win = predictor_ndcg > baseline_ndcg ? 1 : 0
margin = predictor_ndcg - baseline_ndcg  // how much better/worse

// Running success rate (EMA)
success_rate = ema(session_wins, alpha=0.1)

// α adjusts: as predictor wins more, baseline yields influence
α = 1.0 - success_rate  // predictor at 80% win rate -> α=0.2
```

NDCG@10 is a proper ranking metric (unlike hit-count) that rewards getting
the *ordering* right, not just the set membership. A predictor that
correctly puts the most relevant memory first scores higher than one
that includes it but ranks it 5th.

**Cold start**: α starts at 1.0 (pure baseline). The predictor's rankings
are still *recorded* during cold start (for comparison at session-end) but
have zero influence until it starts winning. Both systems' full candidate
lists are stored in `session_memories` for post-hoc comparison.

**New table: `predictor_comparisons`**
```sql
CREATE TABLE predictor_comparisons (
  id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  predictor_ndcg REAL NOT NULL,
  baseline_ndcg REAL NOT NULL,
  predictor_won INTEGER NOT NULL,       -- 1 or 0 (null if low-confidence, excluded from EMA)
  margin REAL NOT NULL,                 -- ndcg difference
  scorer_confidence REAL NOT NULL,      -- continuity scorer confidence (sessions < 0.6 excluded from EMA)
  ema_updated INTEGER NOT NULL,         -- 1 if this session updated the EMA, 0 if excluded
  success_rate REAL NOT NULL,           -- running EMA at time of record
  alpha REAL NOT NULL,                  -- baseline weight used this session
  predictor_top_ids TEXT NOT NULL,      -- JSON array (ordered)
  baseline_top_ids TEXT NOT NULL,       -- JSON array (ordered)
  relevance_scores TEXT NOT NULL,       -- JSON map {memory_id: score}
  fts_overlap_score REAL,              -- behavioral signal: % of injected memories matched by FTS
  created_at TEXT NOT NULL
);
```

Full audit trail: every session records both systems' rankings, the
actual relevance scores, NDCG for each, and whether the predictor won.

### Daemon Communication Protocol

stdin/stdout JSON-RPC 2.0. Daemon spawns predictor on startup, keeps it alive.

**Commands:**

```jsonc
// Score memories for injection
{"jsonrpc":"2.0","id":"req-1","method":"score","params": {
  "context_embedding": [...],
  "candidate_ids": ["mem_1", ...],
  "candidate_embeddings": [[...], ...],
  "signals": {"time_of_day": 0.25, "day_of_week": 2, "month_of_year": 1, "project": "signetai", "session_gap_hours": 8.5, "is_superseded": [false, false, true, ...]}
}}
// Response: {"jsonrpc":"2.0","id":"req-1","result":{"scores":[{"id":"mem_1","score":0.92}, ...]}}

// Train on session outcome
{"jsonrpc":"2.0","id":"req-2","method":"train","params": {
  "context_embedding": [...],
  "candidate_embeddings": [[...], ...],
  "labels": [1.0, 0.0, 0.8, ...],  // per-memory relevance scores
  "continuity_score": 0.85
}}
// Response: {"jsonrpc":"2.0","id":"req-2","result":{"loss":0.23,"step":142}}

// Status
{"jsonrpc":"2.0","id":"req-3","method":"status"}
// Response: {"jsonrpc":"2.0","id":"req-3","result":{"trained":true,"training_pairs":87,"model_version":3,"last_trained":"..."}}
```

### User-Prompt-Submit Integration: FTS Hit Tracking

On each `userPromptSubmit`, the daemon already runs FTS + effectiveScore
to find prompt-relevant memories (hooks.ts:913-1019). This produces
behavioral signal that the predictor captures for training:

1. For each memory matched by FTS during the prompt, increment
   `fts_hit_count` in `session_memories`:
   ```sql
   UPDATE session_memories SET fts_hit_count = fts_hit_count + 1
   WHERE session_key = ? AND memory_id = ?;
   ```

2. For memories matched by FTS that are NOT in `session_memories`
   (they weren't in the candidate pool at session-start), insert them
   with `source = 'fts_only'` and `was_injected = 0`. This captures
   memories the predictor's pre-filtering missed entirely — the
   strongest negative signal for the pre-filter.

3. At session-end, FTS hit patterns feed into label construction
   (see Behavioral Training Signals above).

This requires zero changes to the FTS system or the prompt injection
flow. The only addition is an UPDATE after each FTS query and a
session-end aggregation pass.

### A/B Preference Injection (deferred to post-V1)

An earlier version of this design included a real-time A/B comparison
system where the agent would signal memory preferences via structured
tags. This is deferred because:

- At 50 sessions/day with ~5% disagreement rate, it yields ~2.5
  preference signals/day vs 50 full label sets from the continuity scorer
- The FTS behavioral signal (500-1,000 observation points/day) provides
  stronger, more abundant real-time signal without any agent prompt
  overhead
- The machinery (randomized A/B assignment, structured tag parsing,
  comparison ID gating, preference weight capping) is substantial for
  marginal signal improvement
- Vulnerable to content-level steering that A/B randomization doesn't
  mitigate

If post-V1 analysis shows the continuity scorer + FTS overlap signals
are insufficient, the A/B system can be added without architectural
changes — `session_memories` already has the `agent_preference` column.

## Phase 0: Data Pipeline Prerequisites

Before any model work, we need training data that doesn't exist yet.

### Problem: No Session-to-Memory Linkage

Currently `access_count` and `last_accessed` are global (not per-session).
`memories_recalled` in `session_scores` is **hardcoded to 0**. The
continuity scorer reads transcripts blind — it doesn't know which
memories were actually injected. We cannot train a predictor without
knowing what was served and whether it helped.

### Solution: `session_memories` Table

New migration: `014-session-memories.ts`

**Migration numbering rule:** always check `packages/core/src/migrations/index.ts`
before assigning version numbers. As of this plan, `013` already exists.

```sql
CREATE TABLE session_memories (
  id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  source TEXT NOT NULL,          -- 'effective', 'predictor', 'both', 'exploration', or 'fts_only'
  effective_score REAL,          -- score from effectiveScore()
  predictor_score REAL,          -- score from predictor (null if cold start)
  final_score REAL NOT NULL,     -- blended score used for injection
  rank INTEGER NOT NULL,         -- position in final ranking
  was_injected INTEGER NOT NULL, -- 1 if within top-k cutoff, 0 if candidate only
  relevance_score REAL,          -- filled by continuity scorer post-session
  fts_hit_count INTEGER DEFAULT 0, -- incremented by userPromptSubmit FTS matches
  agent_preference TEXT,          -- 'predictor', 'baseline', 'tie', or null (post-V1)
  created_at TEXT NOT NULL,
  UNIQUE(session_key, memory_id)
);
CREATE INDEX idx_session_memories_session ON session_memories(session_key);
CREATE INDEX idx_session_memories_memory ON session_memories(memory_id);
```

### Improved Continuity Scoring

Pass the actual injected memory list to the continuity scorer prompt:

```
These memories were pre-loaded for this session:
1. [memory_id]: "memory content preview..."
2. [memory_id]: "memory content preview..."
...

For each memory, rate its relevance to what was actually discussed (0.0-1.0).
Also identify any topics where the user had to re-explain things that
memory SHOULD have covered but didn't.

Return JSON:
{
  "overall_score": 0.0-1.0,
  "confidence": 0.0-1.0,
  "per_memory_scores": {"memory_id": 0.85, ...},
  "missing_topics": ["topic that should have been in memory"],
  "novel_context_count": <number>,
  "reasoning": "explanation"
}
```

This gives us **per-memory relevance labels within each session context**.
These are the real training labels for the predictor.

The `reasoning` field from the continuity scorer response is stored in a
new `continuity_reasoning` column on `session_scores`, making judge
reasoning auditable via the dashboard without any additional LLM calls.

The `confidence` field gates training data quality. Sessions where
`confidence < 0.6` are still recorded in `session_memories` (for audit
and dashboard display) but are excluded from:
- NDCG comparison (no EMA update — prevents a noisy session from
  swinging success_rate, especially in the critical first 20 sessions)
- Training labels (no gradient step — prevents learning from garbage)

Additionally, sessions where per-memory score variance is below a
threshold (e.g., all memories scored ~0.5) indicate the scorer wasn't
confident about relative ordering. These are also excluded from training.
A `confidence` column on `session_scores` stores this for filtering.

### Judge Calibration

The continuity scorer is the sole judge for both predictor and baseline.
Because it operates downstream of the injected context and transcript,
it can inherit agent style quirks, prompt framing bias, verbosity bias,
recency bias, and judge model drift. Confidence gating and auditability
(above) mitigate noisy sessions, but they don't catch systematic bias.

**Periodic human spot-check calibration set** (20-50 sessions):
- Not used for training — solely for validating the judge
- Sampled from recent sessions with high-confidence continuity scores
- Human reviews: did the continuity scorer's per-memory relevance
  scores match what a human would have assigned?
- Stored in `predictor_calibration` table with human labels + scorer
  labels + delta
- Dashboard surfaces calibration drift: mean absolute error between
  human and scorer labels over time
- Run cadence: every 50 scored sessions, or manually triggered
- If MAE exceeds threshold (default 0.2), flag in diagnostics and
  consider prompt refinement

This catches the classic reward hacking failure mode: the system
learning to please the judge instead of helping the user.

### Data Flow After Fix

```
Session Start:
  1. Pre-filter: effectiveScore top-50 ∪ embedding similarity top-50
     → ~70-90 candidate pool from 2,000-4,000 corpus
  2. Score candidates (effectiveScore + predictor + RRF fusion)
  3. Apply topic diversity decay to fused rankings
  4. Record ALL candidates in session_memories (injected + non-injected)
  5. Inject top-k into agent context

During Session (per userPromptSubmit):
  6. FTS query matches memories → increment fts_hit_count in session_memories
  7. FTS matches NOT in session_memories → insert with source='fts_only'

Session End:
  8. Aggregate FTS hit patterns for behavioral label adjustment
  9. Continuity scorer receives transcript + injected memory list
  10. Scores each memory individually for relevance
  11. Combine continuity labels with behavioral signals (FTS overlap,
      superseded status, access patterns) → final training labels
  12. Writes per-memory relevance_score back to session_memories
  13. Predictor comparison runs (predictor recs vs baseline recs vs actual useful)
  14. Training data is now: (context, memory_features, blended_label) tuples
```

## Implementation Phases

**Sequencing principle: debug the pipes before the brain.** Each phase
should be independently testable before the next begins. In particular,
Phase 3 (daemon integration) should first be validated with a mock
predictor that returns random scores — this tests all the plumbing
(session_memories recording, RRF fusion, comparison logging, dashboard
rendering) without requiring a working model. Only after the pipes are
verified should real model inference be connected.

### Phase 1: Rust Crate Scaffold + Autograd (from microgpt)

Create `packages/predictor/` with:
- `Cargo.toml` - deps: `serde`, `serde_json`, `rusqlite` (minimal, no ML framework)
- `src/main.rs` - stdin/stdout JSON-line server, command dispatch
- `src/autograd.rs` - Operation-level tape from microgpt (adapt existing)
- `src/model.rs` - CrossAttentionScorer architecture
- `src/tokenizer.rs` - HashTrick tokenizer (word-level + hash buckets)
- `src/training.rs` - Training loop, data assembly, Adam optimizer
- `src/data.rs` - SQLite reader, training pair construction
- `src/protocol.rs` - JSON request/response serde types
- `src/checkpoint.rs` - Model save/load to `~/.agents/memory/predictor/model.bin`

Adapt from microgpt `src/main.rs`:
- Lines 10-57: `Rng` struct (xorshift64) - copy directly
- Lines 60-83: `Param` struct (data + grad) - copy directly
- Lines 87-496: `Tape` + `Op` enum - port with modifications:
  - Add: `Op::Sigmoid`, `Op::MeanPool`, `Op::FeatureConcat`, `Op::ListwiseLoss`
  - Remove: `Op::NegLogProb` (generative-specific)
- Lines 610-673: Adam optimizer loop - adapt for our parameter layout

### Loss Function: Listwise Ranking Loss

Research shows listwise > pairwise > pointwise for ranking tasks. We use
**ListNet-style loss** (probability distribution over rankings):

```
// Model outputs scores for all candidates in a session
model_scores = [s1, s2, ..., sN]
// True relevance from continuity scorer
true_scores  = [r1, r2, ..., rN]

// Convert both to probability distributions via softmax
// Temperature controls distribution sharpness (default 0.5)
P_model = softmax(model_scores / temperature)
P_true  = softmax(true_scores / temperature)

// Loss = KL divergence between distributions
loss = sum(P_true * log(P_true / P_model))
```

**Temperature tuning** (`lossTemperature`, default 0.5): The continuity
scorer often produces soft labels clustered in the 0.4-0.7 range. At
T=1.0, the resulting P_true distribution is nearly uniform, washing out
gradient signal. T=0.5 sharpens the distribution so the model learns to
discriminate "somewhat relevant" (0.5) from "highly relevant" (0.8).
When per-session label variance is very low (all scores within 0.1 of
each other), apply more aggressive sharpening (T=0.3) or skip the
session as a low-signal training example.

This trains the model to produce a ranking distribution that matches
the true relevance distribution. Key advantages over pointwise BCE:
- Captures relative ordering, not just absolute scores
- Handles soft labels naturally (relevance 0.8 vs 0.3, not just 1/0)
- More sample-efficient (one training step per session, not per memory)

### Phase 2: Training Pipeline

- Read training pairs from `~/.agents/memory/memories.db`
- Daemon-owned table: `predictor_training_log` for model_version, loss,
  sample_count, and training timestamps (predictor remains read-only on DB)
- Background training triggered by session-end hook
- Model checkpoints saved to `~/.agents/memory/predictor/model.bin`

### Canary Evaluation Set

A fixed internal mini-benchmark of 25 historical sessions (selected
from highest-confidence continuity scores) serves as a regression
check after every retrain.

**Computed after each training run:**
- NDCG@10 delta vs previous model version
- Score variance (non-zero confirms model isn't collapsed)
- Top-k churn: % of canary sessions where top-5 changed from
  previous model

**Stored in `predictor_training_log`:**
```sql
ALTER TABLE predictor_training_log ADD COLUMN canary_ndcg REAL;
ALTER TABLE predictor_training_log ADD COLUMN canary_ndcg_delta REAL;
ALTER TABLE predictor_training_log ADD COLUMN canary_score_variance REAL;
ALTER TABLE predictor_training_log ADD COLUMN canary_topk_churn REAL;
```

The canary set is refreshed weekly during maintenance (replace oldest
sessions with recent high-confidence ones, keeping set size at 25).
This catches "training completed successfully but the model got worse"
— a failure mode that loss alone does not surface.

Canary metrics are displayed on the dashboard's training curve and
surfaced in `/api/predictor/training` responses.

### Phase 3: Daemon Integration

Files to modify:
- `packages/daemon/src/daemon.ts` - Spawn predictor sidecar on startup
- `packages/daemon/src/hooks.ts` - Wire parallel scoring into
  `handleSessionStart()` and `handleUserPromptSubmit()`
- `packages/daemon/src/pipeline/summary-worker.ts` - After continuity
  scoring: compare predictor vs baseline recommendations, record to
  `predictor_comparisons`, update success_rate EMA, trigger retrain
  if interval reached
- `packages/core/src/migrations/015-predictor.ts` - New migration for
  `predictor_comparisons` + `predictor_training_log` tables

New files:
- `packages/daemon/src/predictor-client.ts` - JSON-RPC 2.0 client for
  communicating with the Rust sidecar

### Phase 4: Observability + Dashboard

Three audiences for observability: **user** (dashboard), **agent** (structured
context injection), and **developer** (pipeline audit).

The predictor is not a standalone system — it plugs into the existing
observability infrastructure. The daemon already has diagnostics health
domains, latency histograms, error ring buffers, timeline tracing, and
pipeline status. The predictor extends each of these, not replaces them.

#### 4.1 Diagnostics Health Domain

Add a `predictor` domain to the existing `DiagnosticsReport` (which
already covers queue, storage, index, provider, mutation, duplicate,
connector, update). Same scoring convention: >= 0.8 healthy, 0.5-0.8
degraded, < 0.5 unhealthy.

```typescript
predictor: PredictorHealth {
  score: number,           // composite health 0.0-1.0
  status: 'healthy' | 'degraded' | 'unhealthy' | 'cold_start' | 'disabled',
  sidecarAlive: boolean,   // is the Rust process responding?
  sidecarPid: number | null,
  lastScoreLatencyMs: number,
  avgScoreLatencyMs: number,     // rolling average
  p95ScoreLatencyMs: number,
  crashCount: number,            // crashes this hour
  crashDisabled: boolean,        // true if crashDisableThreshold hit
  modelVersion: number,
  trainingSessions: number,      // scored sessions available
  minTrainingSessions: number,   // from config
  successRate: number,           // current EMA
  alpha: number,                 // current baseline weight
  lastTrainedAt: string | null,
  lastTrainLoss: number | null,
  driftResets: number,           // lifetime drift reset count
  scorerDriftSignal: number,     // calibration drift metric
  projectSuccessRates: Record<string, number>,  // per-project EMA slices
}
```

**Health score computation:**
- sidecar dead or crash-disabled: 0.0
- sidecar alive but cold start: 0.6 (degraded is expected)
- sidecar alive, trained, success_rate > 0.4: 0.8+
- scoring latency > scoreTimeoutMs: subtract 0.2
- drift signal above threshold: subtract 0.1

Accessible at `GET /api/diagnostics/predictor` (single domain) and
included in `GET /api/diagnostics` (full report). Also appears in
`GET /api/pipeline/status` alongside extraction/summary/retention/
maintenance/scheduler workers.

#### 4.2 Latency Tracking

The analytics module already tracks p50/p95/p99 latency histograms for
`remember`, `recall`, `mutate`, and `jobs` operations. Add two new
tracked operations:

- `predictor_score` — time from sending score request to receiving
  response (including JSON serialization overhead)
- `predictor_train` — time for a training run to complete

These flow into the existing `/api/analytics/latency` endpoint and
the Pipeline tab's latency display. No new UI needed — they show up
alongside existing operations automatically.

The `scoreTimeoutMs` config (default 120ms) uses these histograms to
set the right value: if p95 is regularly approaching the timeout, the
dashboard shows a warning in the diagnostics card.

#### 4.3 Error Ring Integration

The analytics error ring buffer (500 entries) already categorizes errors
by stage: `extraction`, `decision`, `embedding`, `mutation`, `connector`.
Add a new stage: `predictor`.

Predictor errors to capture:
- `predictor_timeout` — score request exceeded `scoreTimeoutMs`
- `predictor_crash` — sidecar process exited unexpectedly
- `predictor_parse_error` — invalid JSON-RPC response from sidecar
- `predictor_train_failure` — training failed (bad data, NaN loss, etc.)
- `predictor_checkpoint_error` — failed to save/load model checkpoint

These appear in `GET /api/analytics/errors`, the Pipeline tab's error
feed, and the Logs tab with `category: predictor` filtering. No new
UI components — the existing error display handles them.

#### 4.4 Timeline Integration

The timeline builder (`timeline.ts`) already joins memory_history + jobs
+ logs + errors for a given session/memory/request ID. Extend it to
include predictor decisions when queried by session_key:

```typescript
// New timeline event types for predictor
{ source: 'predictor', event: 'scored', details: {
    candidates: 50, topPick: 'mem_xyz', latencyMs: 14, alpha: 0.3
}}
{ source: 'predictor', event: 'comparison', details: {
    predictorNdcg: 0.82, baselineNdcg: 0.71, predictorWon: true, margin: 0.11
}}
{ source: 'predictor', event: 'trained', details: {
    loss: 0.23, step: 142, modelVersion: 3, durationMs: 4200
}}
{ source: 'predictor', event: 'drift_reset', details: {
    successRate: 0.22, consecutiveLosses: 10, replayBufferSize: 20
}}
{ source: 'predictor', event: 'fts_overlap', details: {
    sessionKey: 'sess_xyz', injectedMatched: 3, injectedTotal: 8, ftsOnlyInserts: 2
}}
```

These interleave chronologically with existing memory/job/log events,
giving a complete picture of what happened during any session. Accessible
via `GET /api/timeline/:session_key` — the existing endpoint, no new
routes needed.

#### 4.5 Pipeline Status Integration

`GET /api/pipeline/status` returns worker states for extraction,
summary, retention, maintenance, and scheduler. Add the predictor
sidecar as another worker:

```typescript
workers: {
  // ...existing workers...
  predictor: {
    running: boolean,          // sidecar process alive
    pid: number | null,
    modelReady: boolean,       // trained and past cold start
    scoresProcessed: number,   // lifetime score requests served
    trainingsCompleted: number,
    lastScoreLatencyMs: number,
    uptime: number,            // seconds since last (re)start
  }
}
```

This means the Pipeline tab's worker status display shows the predictor
alongside everything else with no special handling.

#### 4.6 Dashboard (user-facing)

New "Predictor" tab in the Svelte dashboard. The tab has two modes:
**cold start mode** (data collection) and **active mode** (predictor
is influencing).

**Cold Start Mode** displays:
- **Training Data Progress**: progress bar with session count vs
  minimum needed
  ```
  Collecting training data: 12/30 sessions
  [████████░░░░░░░░] 40%
  First prediction available after 30 scored sessions
  ```
- **Recent Sessions**: list of sessions with their continuity scores
  and confidence levels, so the user can see data quality flowing in
- **Diagnostics Card**: sidecar status, config summary, what's needed
  before the predictor activates

**Active Mode** displays:
- **Split Gauge**: side-by-side bar chart showing predictor vs baseline
  adoption rate (α visualized). two colored bars that shift as the
  predictor earns influence. updated after every session.
- **Win/Loss Timeline**: session-by-session dots (green = predictor won,
  red = baseline won, gray = tie, hollow = low-confidence/excluded) with
  running success rate line overlay. hover shows NDCG values and margin.
- **Training Curve**: loss over training steps, model version markers,
  drift reset markers (vertical dashed lines)
- **Comparison Inspector**: click any session in the win/loss timeline
  to expand a detailed breakdown:
  - which memories each system recommended (ranked lists side by side)
  - which were actually injected
  - per-memory relevance scores from continuity scorer
  - FTS hit overlay: which injected memories were also matched by FTS
    during the session (behavioral confirmation)
  - FTS-only memories: memories the user searched for that weren't in
    the candidate pool (missed by pre-filter)
  - whether the session's confidence passed the gate (and if not, why)
  - whether this session updated the EMA
  - full continuity scorer reasoning text
  - topic diversity adjustments applied
- **Status Card**: success_rate, α, model version, training pairs count,
  last trained timestamp, parameter count, drift resets, scorer drift
  signal, sidecar latency (p50/p95), per-project success rates (top 3
  projects by session count, each with their own EMA — not used for
  alpha control, but surfaces "predictor is great on signetai but
  terrible on ooIDE" hiding behind a global average)
- **Latency Sparkline**: inline sparkline of recent scoring latencies
  next to the status card, yellow if approaching timeout, red if
  timeouts have occurred

**Both modes** show:
- **Diagnostics Health Badge**: the predictor health score from the
  diagnostics domain, using the same color coding as other domains
  (green/yellow/red)
- **Error Feed**: recent predictor errors from the error ring, if any

#### 4.7 Agent-Facing (structured injection at session-start)

The session-start hook output includes predictor status so the agent
(and the user reading the context) understands what's influencing
memory selection. The format adapts to the predictor's state:

```
# Cold start (collecting data)
[predictor: collecting | 12/30 sessions | baseline only]

# Cold start (trained but not yet earning influence)
[predictor: warming | success_rate=0.38 | model_v1 | baseline only]

# Active (earning influence)
[predictor: active | success_rate=0.72 | α=0.28 | model_v3 | 142 sessions]

# Disabled (crash threshold hit)
[predictor: disabled | crashes=3/hr | baseline fallback]

# Drift reset in progress
[predictor: retraining | drift detected | baseline fallback]
```

This is one line in the system reminder, near-zero context cost. The
agent doesn't need to act on it — it's informational for both the agent
and the human reading the injected context.

#### 4.8 Developer/Audit (API endpoints)

New endpoints under `/api/predictor/`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/predictor/status` | GET | Current model state, config, health |
| `/api/predictor/comparisons` | GET | Paginated comparison history with filters |
| `/api/predictor/comparisons/:id` | GET | Single comparison with full detail |
| `/api/predictor/audit/:session_key` | GET | Full session breakdown (both rankings, relevance scores, FTS overlap, confidence gate, EMA update) |
| `/api/predictor/training` | GET | Training history (loss curve, model versions, drift resets) |
| `/api/predictor/drift` | GET | Current drift signal, historical drift signals, reset history |

**Comparison list filters** (`GET /api/predictor/comparisons`):
- `?winner=predictor|baseline|tie` — filter by outcome
- `?ema_updated=true|false` — filter by confidence gate
- `?min_margin=0.1` — filter by NDCG margin
- `?since=2026-02-01` / `?until=2026-02-25` — date range
- `?limit=50&offset=0` — pagination

These endpoints return data from `predictor_comparisons` and
`predictor_training_log` tables. The comparison detail endpoint joins
with `session_memories` to include the full memory lists and scores.

**Structured logging**: every predictor event gets a structured JSON log
entry with `category: 'predictor'` so it can be filtered in the Logs
tab. Events logged:

- `predictor.score` — scored N candidates in Xms, top pick, α used
- `predictor.train` — training completed, loss, step, duration
- `predictor.compare` — NDCG comparison result, winner, margin
- `predictor.ema_update` — success rate changed from X to Y
- `predictor.ema_skip` — session excluded (low confidence), reason
- `predictor.fts_overlap` — FTS hit summary for session (injected matched, fts-only inserts)
- `predictor.diversity` — topic diversity attenuated N candidates
- `predictor.prefilter` — narrowed corpus from N to M candidates
- `predictor.crash` — sidecar died, exit code, restart attempt
- `predictor.timeout` — score request timed out, fallback to baseline
- `predictor.drift_reset` — drift detected, retrain triggered
- `predictor.cold_start_exit` — all three conditions met, predictor now active

#### 4.9 Fair Scoring Audit

The continuity scorer (LLM) determines which memories were "useful" —
this is the judge for both predictor and baseline. To ensure fairness:

- The continuity scorer does NOT know which memories came from the
  predictor vs baseline. It evaluates the full set blindly.
- Every comparison record includes the raw continuity scorer output
  (reasoning text + scores) so we can audit for bias
- Dashboard Comparison Inspector shows the full LLM reasoning for
  each session so humans can verify the judge is fair
- If we notice systematic bias, the EMA alpha can be adjusted or
  the scoring prompt can be refined

#### 4.10 Calibration Drift Detection

The continuity scorer's `reasoning` text is stored in a
`continuity_reasoning` column on `session_scores`. This makes judge
reasoning human-auditable via the Comparison Inspector for free — no
second LLM pass or separate scheduled task required.

For automated drift detection, the maintenance worker tracks the
continuity scorer's relevance score distribution over a rolling window:

```
drift_signal = avg_relevance(memories < 7 days old) - avg_relevance(memories > 30 days old)
```

If this gap widens over time independent of actual usage patterns, the
judge is exhibiting recency bias (or other systematic bias). Flagged in
`/api/diagnostics/predictor` and surfaced in the dashboard status card.
One SQL query on `session_memories`, runs in the existing maintenance
worker. The drift signal value is also available at
`GET /api/predictor/drift` alongside the historical trend.

### Phase 5: Config

- `agent.yaml` additions (V1 — exposed params only):
  ```yaml
  predictor:
    enabled: false                # rollout: off by default, opt-in first
    trainIntervalSessions: 10     # retrain every N sessions
    minTrainingSessions: 10       # minimum sessions before predictor can influence
    scoreTimeoutMs: 120           # fail open to baseline on timeout
    crashDisableThreshold: 3      # disable predictor after N crashes/hour
    rrfK: 12                      # RRF constant (tuned for ~50 candidate scale)
    explorationRate: 0.05          # probability of exploration injection per session
    driftResetWindow: 10          # consecutive sessions below threshold before reset
  ```

  **Hardcoded defaults** (not user-configurable in V1 — revisit if needed):
  ```
  internalDim: 64                # internal embedding dimension
  hashBuckets: 16384             # HashTrick bucket count
  emaAlpha: 0.1                  # success rate smoothing factor
  driftResetThreshold: 0.3       # success rate below which retrain triggers
  replayBufferSize: 20           # top historical sessions for drift retraining
  minScorerConfidence: 0.6       # continuity scorer confidence gate
  lossTemperature: 0.5           # softmax temperature for listwise loss
  negativeSimilarityThreshold: 0.6  # cosine sim for soft negative labels
  maxProjectSlices: 5            # per-project EMA slices
  earlyActiveRampSessions: 20    # sessions before influence cap lifts
  earlyActiveMaxInfluence: [0.2, 0.4]  # max influence at [0-10, 11-20]
  topicDiversityDecay: 0.5       # decay factor for topic diversity
  topicDiversityFloor: 0.1       # minimum score multiplier
  topicSimilarityThreshold: 0.85 # cosine sim for topic overlap detection
  candidatePoolSize: 100         # max candidates after pre-filtering
  ```

  This reduces exposed configuration from 22 to 8 parameters. The
  hardcoded defaults are chosen to be robust across a wide range of usage
  patterns. If a specific default proves wrong for certain users, it can
  be promoted to the exposed config in a future version.

### Phase 5b: Concept Drift Detection

When a user's workflow changes significantly (new project, abandoned old
one), the predictor trained on old patterns may actively fight the new
usage. Rather than building a separate drift detection system, piggyback
on the success rate EMA that already exists:

```
if success_rate < driftResetThreshold for driftResetWindow consecutive sessions:
  log warning "predictor drift detected"
  reset α to 1.0 (pure baseline)
  trigger full retrain at standard learning rate with replay buffer
  reset success_rate EMA to 0.5 (neutral)
  increment drift_resets counter in predictor_training_log
```

**Replay buffer for drift recovery**: A naive approach would retrain with
a higher learning rate to escape old patterns faster, but this risks
catastrophic forgetting — the model quickly learns new project patterns
but forgets temporal patterns ("nicholai works on ooIDE in the evenings")
that took 200 sessions to learn. Instead, the predictor maintains a
replay buffer of the top `replayBufferSize` (default 20) historical
sessions by continuity score. On drift reset (and during normal training),
each training batch is composed of ~80% recent sessions and ~20% replay
buffer samples. This preserves learned temporal and behavioral patterns
while allowing the model to adapt to new usage.

Key insight: you don't need to detect *what* changed. You just need to
detect that the predictor stopped being useful, and give it a fresh shot
at learning the new patterns. The RRF fusion with earned α already
provides graceful degradation — the predictor just loses influence until
it catches up.

**Known tradeoff**: this approach is reactive, not proactive. By the time
drift is detected, the user has already experienced `driftResetWindow`
sessions of degraded prediction. The damage is bounded because: (1) α
naturally rises toward 1.0 as the predictor loses, so baseline absorbs
most of the influence during the decline, and (2) RRF fusion means even
a "wrong" predictor only gets partial influence, never full control.
Proactive detection (embedding space monitoring, topic clustering) would
catch drift earlier but adds significant complexity. Not worth it at
this stage — revisit if users report noticeable degradation during
workflow transitions.

The `drift_resets` counter in `predictor_training_log` is surfaced in
the dashboard status card so the user can see how often this happens.

### Phase 6: Pre-Trained Model Path (future-proofing)

The architecture must support: **load base weights -> fine-tune on user data.**

**Checkpoint format** (`~/.agents/memory/predictor/model.bin`):
```
[magic: u32]["SGPT"]
[version: u32][1]
[flags: u32]  -- bit 0: is_pretrained_base, bit 1: is_finetuned
[config_json_len: u32][config_json: bytes]  -- model config (dims, buckets, etc)
[param_data: f64[]]  -- raw parameter values
```

**How pre-training will work** (not building now, just designing for it):
1. Collect anonymized memory-session interaction data from opt-in users
2. Train a base model on the general "what makes a memory useful" task
3. Ship `predictor-base.bin` with the Signet release
4. On first run, user's predictor starts from base weights instead of
   random init -> much faster convergence, higher initial success rate
5. Fine-tuning = same training loop, just starting from better weights

**What this requires now:**
- Checkpoint format includes a `is_pretrained_base` flag
- Training loop accepts an optional `--base-weights` path
- HashTrick bucket count is fixed across all users (16,384) so base
  model embeddings transfer correctly

### Phase 7: Documentation (subagent task)

After implementation, launch a `markdown-docs` subagent to generate:
- `packages/predictor/README.md` - architecture, build, usage
- `docs/predictor.md` - how the predictive scorer works, training
  pipeline, observability, dashboard guide
- `docs/predictor-architecture.md` - technical deep dive with diagrams
- Update `CLAUDE.md` with predictor-related sections

## Critical Files

### Phase 0: Data Pipeline (prerequisite - must ship first)

| File | Action | Purpose |
|------|--------|---------|
| `packages/core/src/migrations/014-session-memories.ts` | CREATE | `session_memories` join table (includes `fts_hit_count`) |
| `packages/daemon/src/hooks.ts` | MODIFY | Pre-filter candidates, record all candidates + injected per session, FTS hit tracking in userPromptSubmit, topic diversity post-scoring |
| `packages/daemon/src/pipeline/summary-worker.ts` | MODIFY | Per-memory relevance scoring via continuity scorer, behavioral label adjustment from FTS overlap |

### Phases 1-3: Predictor + Integration

| File | Action | Purpose |
|------|--------|---------|
| `packages/predictor/` | CREATE | New Rust crate (all src/ files below) |
| `packages/predictor/src/main.rs` | CREATE | JSON-line stdin/stdout server |
| `packages/predictor/src/autograd.rs` | CREATE | Operation-level tape from microgpt |
| `packages/predictor/src/model.rs` | CREATE | Cross-attention scorer + listwise loss |
| `packages/predictor/src/data.rs` | CREATE | SQLite reader for session_memories |
| `packages/predictor/src/tokenizer.rs` | CREATE | HashTrick (16K buckets) |
| `packages/predictor/src/training.rs` | CREATE | Training loop + Adam |
| `packages/predictor/src/protocol.rs` | CREATE | Serde types for JSON-line protocol |
| `packages/predictor/src/checkpoint.rs` | CREATE | Model save/load + pre-train flag |
| `packages/daemon/src/hooks.ts` | MODIFY | RRF fusion, α from success rate |
| `packages/daemon/src/daemon.ts` | MODIFY | Spawn predictor sidecar |
| `packages/daemon/src/predictor-client.ts` | CREATE | JSON-RPC 2.0 client for sidecar |
| `packages/daemon/src/pipeline/summary-worker.ts` | MODIFY | NDCG comparison + success rate EMA |
| `packages/core/src/migrations/015-predictor.ts` | CREATE | `predictor_comparisons` + `predictor_training_log` |
| `packages/core/src/types.ts` | MODIFY | PredictorConfig, SessionMemory types |

### Phases 4-5: Observability + Dashboard

| File | Action | Purpose |
|------|--------|---------|
| `packages/cli/dashboard/src/lib/components/tabs/PredictorTab.svelte` | CREATE | Main predictor dashboard (cold start + active modes) |
| `packages/cli/dashboard/src/lib/components/SplitGauge.svelte` | CREATE | Adoption rate gauge (α visualized) |
| `packages/cli/dashboard/src/lib/components/ComparisonInspector.svelte` | CREATE | Per-session deep dive with FTS overlay + confidence gate |
| `packages/cli/dashboard/src/lib/components/WinLossTimeline.svelte` | CREATE | Session dots with success rate overlay |
| `packages/cli/dashboard/src/lib/components/TrainingProgress.svelte` | CREATE | Cold start progress bar + session list |
| `packages/daemon/src/diagnostics.ts` | MODIFY | Add `predictor` health domain to DiagnosticsReport |
| `packages/daemon/src/analytics.ts` | MODIFY | Add `predictor` error stage + `predictor_score`/`predictor_train` latency ops |
| `packages/daemon/src/timeline.ts` | MODIFY | Add predictor event types to timeline builder |
| `packages/daemon/src/daemon.ts` | MODIFY | Add `/api/predictor/*` routes, extend pipeline status with predictor worker |
| `packages/core/src/types.ts` | MODIFY | PredictorHealth, PredictorTimelineEvent types |

## Existing Code to Reuse

### Model + Training References
- `references/microgpt/src/main.rs` - Autograd tape, Adam optimizer, matrix ops
- `references/acan/train/model.py` - Cross-attention architecture reference
- `references/acan/train/train.py` - LLM-based scoring loss reference

### Scoring + Memory Selection
- `packages/daemon/src/hooks.ts:effectiveScore()` (line 205) - Existing scorer
- `packages/daemon/src/hooks.ts:getPredictedContextMemories()` (line 432) - Current prediction (to be replaced)
- `packages/daemon/src/hooks.ts:updateAccessTracking()` (line 538) - Access tracking pattern
- `packages/daemon/src/pipeline/reranker-embedding.ts` - Embedding cosine sim pattern
- `packages/daemon/src/pipeline/summary-worker.ts` - Continuity scoring flow (lines 254-362)

### Infrastructure
- `packages/daemon/src/db-helpers.ts` - `vectorToBlob()`/`blobToVector()` for embedding I/O
- `packages/daemon/src/scheduler/spawn.ts` - Child process spawning pattern
- `packages/core/src/database.ts` - SQLite wrapper patterns
- `packages/core/src/migrations/011-session-scores.ts` - Migration pattern reference

### Observability (extend these, don't reinvent)
- `packages/daemon/src/analytics.ts` - Error ring buffer (500 entries, stage-categorized), latency histograms (p50/p95/p99), endpoint/actor/provider/connector metrics
- `packages/daemon/src/diagnostics.ts` - Health domain pattern (8 domains, composite score, status enum), `ProviderTracker` ring buffer pattern for availability
- `packages/daemon/src/timeline.ts` - Timeline builder joining memory_history + jobs + logs + errors by ID
- `packages/daemon/src/repair-actions.ts` - Policy-gated idempotent repair pattern with rate limiting and audit trail
- `packages/cli/dashboard/src/lib/components/tabs/PipelineTab.svelte` - Pipeline worker status display, live log feed, error display
- `packages/cli/dashboard/src/lib/components/tabs/LogsTab.svelte` - Structured log filtering by level/category
- `packages/cli/dashboard/src/lib/api.ts` - Dashboard API client patterns

## Inference Latency Analysis

Target: <100ms total for session-start scoring.

**Pre-filtering** (daemon-side, before predictor):
- effectiveScore on full corpus: O(N) scan, ~2ms for 4,000 memories
- Embedding similarity top-50: cosine sim of 200 stored embeddings vs
  session context, ~1ms (pre-computed embeddings, no model calls)
- Union + dedup: negligible
- Pre-filter total: ~3-5ms

**Predictor scoring** (~80 candidates after pre-filter):
- JSON serialization: ~80 candidates x 768-dim embeddings = ~245KB.
  Serialization + stdin write + stdout read: ~5-10ms
- Computation per-candidate: HashTrick encode (~50 words, 16K bucket
  lookup) + Q/K/V projections (64x64 matmuls) + dot product + gate =
  ~12K FLOPs. Total for 80 candidates: ~960K FLOPs. On any modern CPU:
  <1ms. The embedding table (16K x 64 = 4MB) fits in L2 cache.
- Predictor total: ~8-15ms

**Topic diversity** (daemon-side, after predictor):
- Pairwise cosine similarity on top-k (~20 candidates): trivial, <1ms

**End-to-end realistic**: 15-25ms. Well within 100ms budget even with
4,000-memory corpora. JSON serialization is the bottleneck, not compute.

**Training** (at 50 sessions/day, retrain every 10 sessions = 5x/day):
- 500 samples, 50 epochs: ~50B FLOPs = ~5 seconds on laptop
- Concurrent inference isolation ensures scoring continues during training
- 30-second training cap provides hard safety net

## Technical Notes

**WAL mode + crash safety**: The database MUST use `PRAGMA journal_mode=WAL`
for concurrent read safety (predictor sidecar reading while daemon writes).
Session-start candidate recording is wrapped in a transaction and uses
`INSERT OR REPLACE` so daemon restarts that re-run session-start for the
same session are idempotent (the UNIQUE constraint on `(session_key,
memory_id)` handles this). Rows with null `relevance_score` after a crash
simply mean "session didn't complete" — the training pipeline filters on
`relevance_score IS NOT NULL`. No special recovery logic needed.

**Embedding blob format** (from `db-helpers.ts`): Float32Array in native
little-endian byte order, no length prefix. Read in Rust as:
```rust
let blob: Vec<u8> = row.get(col)?;
let floats: Vec<f32> = blob.chunks_exact(4)
    .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
    .collect();
```
Current dimension: 768 (from embeddings table `dimensions` column).

**Transcript size**: Max 12,000 chars stored in `summary_jobs.transcript`.
Continuity scorer uses last 4,000 chars. Sessions < 500 chars are dropped.

**NDCG implementation** (for comparison scoring):
```
DCG@k = sum_i(relevance_i / log2(i + 2))  for i in 0..k
NDCG@k = DCG@k / IDCG@k  where IDCG is DCG of perfect ordering
```
Use `k=10` for predictor comparisons and compute over the labeled
`evaluation_pool` defined above.

## Verification

### Phase 0 (data pipeline)
1. **session_memories populated**: After a session-start hook, verify rows
   appear in `session_memories` with correct memory_ids and scores
2. **Pre-filtering**: Verify candidate pool is bounded (~70-90) regardless
   of corpus size (test with 4,000 memories)
3. **Per-memory scoring**: After session-end, verify `relevance_score` is
   filled for each injected memory (not just overall continuity score)
4. **FTS hit tracking**: After userPromptSubmit, verify `fts_hit_count`
   increments for matched memories in session_memories
5. **FTS-only inserts**: Verify memories matched by FTS but not in
   candidate pool get inserted with `source='fts_only'`
6. **Behavioral label adjustment**: Verify FTS overlap modifies training
   labels (injected + FTS-matched gets boost, not-injected + FTS-matched
   gets elevated label)
7. **Blind evaluation**: Verify continuity scorer prompt doesn't indicate
   which memories came from predictor vs baseline

### Phases 1-3 (predictor)
4. **Autograd**: Rust unit tests for forward/backward pass correctness on
   known inputs (compare against Python microgpt output)
5. **Training**: After 10+ sessions with per-memory labels, model trains
   and produces non-uniform scores that reflect relevance patterns
6. **NDCG comparison**: Verify predictor_comparisons records created with
   correct NDCG@10 values over the shared evaluation_pool
7. **RRF fusion**: Verify final rankings use RRF formula with correct α
8. **Success rate**: EMA updates correctly, α adjusts as predictor wins
9. **Latency**: Score request < 100ms for 50 candidates
10. **Checkpoint**: Model persists across daemon restarts
11. **Pre-train path**: `--base-weights` loads external checkpoint correctly
12. **Build**: `cargo build --release`, binary < 5MB
13. **Read-only boundary**: predictor cannot write to SQLite; daemon owns all
    DB writes
14. **Guardrails**: predictor auto-disables after crash threshold; baseline
    fallback remains healthy
15. **Drift detection**: success rate below threshold for N sessions triggers
    retrain with replay buffer (80/20 recent/historical), α resets to 1.0,
    `drift_resets` counter increments
16. **Replay buffer**: top-K historical sessions by continuity score are
    preserved and mixed into training batches; verify buffer updates when
    higher-scoring sessions arrive
17. **Negative label filtering**: non-injected memories with high cosine
    similarity to session context receive soft labels (0.25) not hard 0.0
18. **Negative memory signals**: superseded memories receive label -0.3,
    recently-deleted memories receive label -0.5 in training data
19. **Topic diversity**: after RRF fusion, memories with >0.85 cosine
    similarity to already-selected memories get attenuated scores;
    verify top-k doesn't contain near-duplicate memories
20. **Project embedding**: model produces different score distributions
    when project signal changes (test with two projects, verify the
    model learns to prefer project-relevant memories)
21. **WAL mode**: database uses WAL journal mode, session_memories writes
    are transactional and idempotent via `INSERT OR REPLACE`
22. **Confidence gating**: low-confidence continuity scores are recorded but
    excluded from EMA updates and training labels

### Phases 4-5 (observability)
19. **Diagnostics domain**: `GET /api/diagnostics/predictor` returns valid
    health score, sidecar status, latency stats, training progress
20. **Diagnostics composite**: predictor health domain included in full
    `GET /api/diagnostics` report and composite score
21. **Latency tracking**: `predictor_score` and `predictor_train` appear
    in `GET /api/analytics/latency` with correct p50/p95/p99 values
22. **Error ring**: predictor errors (timeout, crash, parse) appear in
    `GET /api/analytics/errors` with stage `predictor`
23. **Timeline**: predictor events (scored, comparison, trained, drift_reset,
    fts_overlap, diversity, prefilter) appear in
    `GET /api/timeline/:session_key` chronologically interleaved with
    existing events
24. **Pipeline status**: predictor worker appears in
    `GET /api/pipeline/status` with running/pid/modelReady/scores stats
25. **Dashboard cold start**: progress bar shows scored session count vs
    minimum, recent sessions list, transitions to active mode
26. **Dashboard active**: split gauge, win/loss timeline, training curve,
    comparison inspector all render with real data
27. **Comparison inspector**: click any session to see full breakdown —
    both ranked lists, relevance scores, FTS hit overlay, FTS-only misses,
    confidence gate, EMA update status, continuity reasoning text, topic
    diversity adjustments
28. **API endpoints**: all 6 `/api/predictor/*` routes return correct data,
    comparison filters work, pagination works
29. **Agent injection**: session-start output adapts to predictor state
    (collecting/warming/active/disabled/retraining)
30. **Drift diagnostics**: calibration drift signal surfaced in both
    `/api/diagnostics/predictor` and `/api/predictor/drift`
31. **Structured logs**: all predictor events logged with `category:
    'predictor'`, filterable in Logs tab
32. **Judge calibration**: calibration set populated, MAE computed,
    surfaced in dashboard and diagnostics
33. **Per-project slices**: project-level success rates appear in
    status card and `/api/predictor/status`
34. **Influence ramp**: during early active phase, α respects floor
    even when success_rate would push it lower
35. **Exploration sampling**: exploration memories appear in
    session_memories with `source='exploration'`, receive relevance
    scores, and contribute to training
36. **Canary regression**: canary NDCG/variance/churn computed after
    each training run, stored in predictor_training_log, visible in
    dashboard training curve
37. **Training validation gates**: intentionally corrupt training data
    triggers gate failure, weights are not swapped, failure is logged
38. **Mixed path normalization**: model produces consistent score
    distributions regardless of whether candidates are pre-embedded
    or text-only
39. **FTS overlap in comparison**: `fts_overlap_score` populated in
    `predictor_comparisons`, visible in comparison inspector
40. **Behavioral label blending**: training labels reflect both continuity
    scorer output and FTS overlap adjustments; verified by inspecting
    final labels in session_memories vs raw continuity labels
41. **Pre-filter scaling**: with 4,000 memories, session-start latency
    stays under 100ms total (pre-filter + predictor + diversity)
42. **Month encoding**: model receives month-of-year sin/cos features,
    verified in JSON-RPC score request

## Delegation Plan

This is not a feature we can afford to ship incrementally and hope it
works. Each piece needs to be done right. The delegation below is
explicit: what each agent does, what it delivers, and what "done" means.

### Agent 1: Data Pipeline Foundation (opus, foreground)
**Scope**: Phase 0 — the prerequisite that everything depends on.
- Create migration `014-session-memories.ts` (includes `fts_hit_count`)
- Implement candidate pre-filtering in `hooks.ts:handleSessionStart()`:
  effectiveScore top-50 ∪ embedding similarity top-50, deduped
- Record all candidates with their scores to `session_memories`
- Implement FTS hit tracking in `hooks.ts:handleUserPromptSubmit()`:
  increment `fts_hit_count`, insert `source='fts_only'` for misses
- Implement topic diversity post-scoring pass in `handleSessionStart()`
- Modify `summary-worker.ts:scoreContinuity()` to pass injected memory
  list and receive per-memory relevance scores
- Implement behavioral label adjustment: combine continuity scorer labels
  with FTS overlap signals and negative memory indicators
- Update the continuity prompt to evaluate individual memories
- Write tests: verify pre-filtering bounds candidate pool, verify FTS
  hits track, verify behavioral labels adjust correctly, verify topic
  diversity attenuates near-duplicates
- **Acceptance**: `bun test` passes, `bun run typecheck` clean, migration
  runs idempotently, session_memories table populated with real data after
  a manual session-start hook call, candidate pool bounded to ~100 even
  with 4,000 memories in corpus

### Agent 2: Rust Autograd + Model Core (opus, foreground)
**Scope**: Phases 1 — the Rust crate scaffold and autograd engine.
- Port microgpt's Tape/Op/Param/Adam to `packages/predictor/src/autograd.rs`
- Add new ops: Sigmoid, MeanPool, FeatureConcat, ListwiseLoss (KL div)
- Implement CrossAttentionScorer in `model.rs`
- Implement HashTrick tokenizer in `tokenizer.rs`
- Write comprehensive unit tests: verify forward pass produces correct
  shapes, backward pass computes correct gradients (compare against
  Python reference), Adam updates parameters correctly
- **Acceptance**: `cargo test` all pass, forward/backward numerically
  verified against Python microgpt output on known inputs, no unsafe code

### Agent 3: Training Pipeline + SQLite Reader (opus, foreground)
**Scope**: Phase 2 — reading training data and running the training loop.
- Implement `data.rs`: read session_memories + embeddings + session_scores
  from SQLite via rusqlite (read-only)
- Implement `training.rs`: assemble training batches, run listwise loss,
  Adam update, checkpoint saving
- Implement `checkpoint.rs`: binary format with pre-train flag support
- Write `protocol.rs`: serde types for JSON-line communication
- Test: create mock SQLite database, train for 50 epochs, verify loss
  decreases, checkpoint saves and loads correctly
- **Acceptance**: Training on mock data produces decreasing loss curve,
  checkpoint round-trips correctly, `--base-weights` flag works

### Agent 4: Daemon Integration + Observability Backend (opus, foreground)
**Scope**: Phase 3 + Phase 4 backend — wiring the predictor into the
daemon and extending the existing observability infrastructure.

**Core integration:**
- Create `predictor-client.ts`: spawn sidecar, JSON-line communication,
  health checking, graceful degradation on timeout/crash
- Modify `daemon.ts`: spawn predictor on startup, add `/api/predictor/*`
  routes (status, comparisons, comparisons/:id, audit/:session_key,
  training, drift), extend pipeline status with predictor worker
- Modify `hooks.ts`: implement RRF fusion, α from success_rate, record
  both systems' rankings in session_memories, confidence gating
- Modify `summary-worker.ts`: compute NDCG for both systems, record
  comparison (including `fts_overlap_score`), update success_rate EMA,
  trigger training
- Create migration `015-predictor.ts`

**Observability backend integration:**
- Modify `diagnostics.ts`: add `predictor` health domain with composite
  score (sidecar alive, latency, training progress, drift signal)
- Modify `analytics.ts`: add `predictor` error stage to ring buffer,
  add `predictor_score` and `predictor_train` latency operations
- Modify `timeline.ts`: add predictor event types (scored, comparison,
  trained, drift_reset, preference) to timeline builder
- Add structured logging for all predictor events with
  `category: 'predictor'`
- Extend session-start hook output with adaptive predictor status line

**Security audit**: verify predictor can only READ memories.db (no write
access), JSON-RPC 2.0 protocol validates all input, no command injection
via memory content

**Acceptance**: `bun test` passes, `bun run typecheck` clean, daemon
starts with predictor sidecar, scoring request returns results in
<100ms, cold start falls back gracefully, `/api/diagnostics/predictor`
returns valid health data, predictor events appear in timeline,
latency histograms track predictor operations

### Agent 5: Observability Dashboard (direct — no delegation per rules)
**Scope**: Phase 4 frontend — dashboard components consuming the
observability backend from Agent 4.
- This is UI work, so per the hard rules I implement it directly, not
  delegated to a subagent

**Components:**
- `PredictorTab.svelte`: main predictor dashboard with cold start / active
  mode switching. Cold start shows TrainingProgress + recent sessions +
  diagnostics card. Active shows full predictor analytics.
- `TrainingProgress.svelte`: progress bar, scored session count vs minimum,
  recent sessions list with continuity scores and confidence levels
- `SplitGauge.svelte`: animated adoption rate gauge showing α as the
  split between predictor and baseline influence
- `WinLossTimeline.svelte`: session dots (green/red/gray/hollow) with
  running success rate line overlay. Hover shows NDCG + margin. Hollow
  dots for low-confidence excluded sessions.
- `ComparisonInspector.svelte`: per-session deep dive — both ranked
  memory lists side by side, per-memory relevance scores, FTS hit overlay,
  FTS-only misses, confidence gate decision, EMA update status, full
  continuity reasoning text, topic diversity adjustments
- Training curve with loss, model version markers, drift reset markers
- Status card with success_rate, α, model version, training pairs,
  last trained, parameter count, drift resets, drift signal, latency
  sparkline (p50/p95)
- Diagnostics health badge (reuses existing health score color coding)
- Error feed showing recent predictor errors from the error ring

**Data sources**: all from existing API endpoints — no new backend work.
Uses `/api/predictor/*`, `/api/diagnostics/predictor`,
`/api/analytics/latency`, `/api/analytics/errors?stage=predictor`,
`/api/pipeline/status`.

### Agent 6: Documentation (markdown-docs agent, background)
**Scope**: Phase 7 — comprehensive documentation.
- `packages/predictor/README.md`: build, run, architecture
- `docs/predictor.md`: user-facing guide
- `docs/predictor-architecture.md`: technical deep dive with diagrams
- Update `CLAUDE.md` with predictor sections
- **Acceptance**: docs accurately reflect implementation, all code paths
  documented, diagrams match actual data flow

### Agent 7: Code Review + Security Audit (code-reviewer, foreground)
**Scope**: Cross-cutting — runs after agents 1-4 complete.
- Review all new Rust code for memory safety, panic paths, edge cases
- Review daemon integration for injection vulnerabilities (memory content
  passed through JSON could contain malicious payloads)
- Review migration for data integrity (foreign keys, indexes, constraints)
- Review FTS-based behavioral signals for gaming potential (can crafted
  memory content cause spurious FTS matches that inflate training labels?)
- Verify training data can't be poisoned via crafted memories
- Verify negative memory labels (superseded, deleted) can't be exploited
  to suppress legitimate memories
- **Acceptance**: no high-confidence issues, all security concerns addressed

### Agent 8: Integration Testing (general-purpose, foreground)
**Scope**: End-to-end verification after all pieces are assembled.
- Full lifecycle test: session-start (pre-filter → score → diversity →
  inject) → user-prompt-submit (FTS hit tracking) → session-end →
  behavioral label adjustment → continuity scoring → NDCG comparison →
  training trigger → next session uses updated model
- Pre-filter scaling test: seed 4,000 memories, verify candidate pool
  bounded and latency under 100ms
- Topic diversity test: seed overlapping memories, verify top-k doesn't
  contain near-duplicates
- FTS overlap test: verify memories matched by FTS during session get
  label adjustments, FTS-only memories get inserted
- Negative memory test: superseded memories get negative labels, excluded
  from injection
- Cold start → warm start transition test
- Checkpoint persistence across daemon restart
- Latency benchmarks: scoring <100ms, training <30s
- Dashboard renders with real data (including FTS overlay in inspector)
- **Acceptance**: all verification items from the plan pass

### Execution Order

```
Agent 1 (data pipeline)  ──────────────────────→  Agent 4 (daemon + observability backend)
Agent 2 (Rust autograd)  ──→  Agent 3 (training)  ──→  ↗         |
                                                    Agent 7 (security review)
                                                       ↗         |
Agent 5 (dashboard — me, direct, after Agent 4)  ──→  ↗
                                                    Agent 8 (integration test)
Agent 6 (docs — background, starts after Agent 4)
```

Agents 1 and 2 can run in parallel (no dependencies). Agent 3 depends
on Agent 2. Agent 4 depends on Agents 1 and 3; it now includes the
observability backend (diagnostics domain, analytics integration,
timeline events, API routes). Agent 5 (dashboard) depends on Agent 4
since the frontend needs the API endpoints to consume — I do this
directly per the hard rules. Agent 7 runs after 1-5. Agent 8 runs
after everything. Agent 6 runs in background after Agent 4.

## Sources

- [X/Twitter For You Algorithm](references/x-algorithm/) - Phoenix ranker,
  two-tower retrieval, candidate pipeline framework, weighted multi-action
  scoring. Informed: candidate pre-filtering, topic diversity, negative
  memory signals, behavioral training signals, project embedding, config
  simplification. See evaluation at `~/.claude/plans/soft-wishing-whistle.md`.
- [ACAN: Enhancing memory retrieval in generative agents through LLM-trained cross attention networks](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2025.1591618/full)
- [Memory-R1: Enhancing LLM Agents to Manage and Utilize Memories via RL](https://arxiv.org/abs/2508.19828)
- [Memory in the Age of AI Agents: A Survey](https://arxiv.org/abs/2512.13564)
- [Agent Memory Paper List](https://github.com/Shichun-Liu/Agent-Memory-Paper-List)
- [MemR3: Memory Retrieval via Reflective Reasoning](https://arxiv.org/abs/2512.20237)
- [A-MEM: Agentic Memory for LLM Agents](https://arxiv.org/abs/2502.12110)
- [Hindsight: Agent Memory That Learns](https://github.com/vectorize-io/hindsight) (RRF + cross-encoder reranking reference)
- [Generalized Contrastive Learning for Multi-Modal Retrieval and Ranking](https://dl.acm.org/doi/10.1145/3701716.3715227) (listwise loss reference)
- [Solving Freshness in RAG: A Simple Recency Prior](https://arxiv.org/html/2509.19376) (recency fusion reference)

---

## Phase 0 Implementation Notes

### What was implemented

**Migration 015-session-memories** (`packages/core/src/migrations/015-session-memories.ts`)
- `session_memories` table with full schema as planned (id, session_key,
  memory_id, source, effective_score, predictor_score, final_score, rank,
  was_injected, relevance_score, fts_hit_count, agent_preference, created_at)
- UNIQUE constraint on (session_key, memory_id)
- Indexes on session_key and memory_id
- Two new columns on session_scores: `confidence REAL`, `continuity_reasoning TEXT`
- Registered as version 15 in migration index

**Session memory recording** (`packages/daemon/src/session-memories.ts`)
- `recordSessionCandidates()`: batch INSERT OR IGNORE in a single write transaction
- `trackFtsHits()`: UPDATE existing + INSERT OR IGNORE for new fts_only rows
- Both bail early on missing sessionKey or empty inputs
- All failures are non-fatal (warn + continue)

**hooks.ts refactoring**
- `ScoredMemory` interface exported for use by session-memories.ts
- `selectWithBudget()` made generic: `<T extends { content: string }>`
- `getProjectMemories()` split into `getAllScoredCandidates()` (no budget)
  + wrapper that applies budget. Preserves existing behavior exactly.
- `handleSessionStart()`: calls `getAllScoredCandidates()`, applies budget
  via `selectWithBudget()`, records full candidate pool + injected set
- `handleUserPromptSubmit()`: calls `trackFtsHits()` with all scored FTS matches
- Predicted context memories that aren't in the main candidate pool are
  included in recording with source="effective"

**Enhanced continuity scoring** (`packages/daemon/src/pipeline/summary-worker.ts`)
- `loadInjectedMemories()`: joins session_memories + memories to get injected
  memory content previews. Falls back to empty array for old sessions.
- `writePerMemoryRelevance()`: maps 8-char ID prefixes from LLM response
  back to full memory IDs, writes relevance_score to session_memories.
- `buildContinuityPrompt()` now includes injected memory list with truncated
  previews and 8-char ID prefixes. Asks for confidence + per_memory array.
- `ContinuityResult` extended with `confidence` and `per_memory` fields.
- `scoreContinuity()` writes `memories_recalled` from actual injected count
  (was hardcoded 0), writes `confidence` and `continuity_reasoning` to
  session_scores.

**Logger categories** — added `"summary-worker"` and `"session-memories"` to
LogCategory union in logger.ts.

### Why it was done this way

- `getAllScoredCandidates()` was extracted as a separate exported function
  rather than modifying `getProjectMemories()` in-place because the original
  function tightly couples scoring with budget selection. The wrapper
  `getProjectMemories()` was kept for backward compatibility with any internal
  callers — minimal diff, same behavior.
- `final_score` is set equal to `effective_score` until the predictor exists.
  This means Phase 1 can simply start writing predictor_score and updating
  final_score without schema changes.
- FTS tracking uses UPDATE + INSERT OR IGNORE pair rather than UPSERT because
  SQLite's UPSERT syntax would need the full column list and is harder to
  read for the "increment if exists, create if not" pattern.
- Per-memory relevance uses 8-char ID prefixes in the LLM prompt to keep
  token count down while still being unambiguous (collision probability is
  negligible for <50 memories per session).

### What was different than planned

- The plan suggested the UPDATE in trackFtsHits would be a "no-op if row
  doesn't exist" — this is correct for SQLite (UPDATE WHERE with no match
  returns 0 rows affected, no error), but worth noting explicitly.
- Added LogCategory entries for the new modules — not in the original plan
  but necessary since the codebase was using string literals that didn't
  match the union type.
- Migration test assertions needed updating (14 → 15 migration count).

### Next steps

1. **Phase 1: Rust crate scaffold + autograd** — the training data pipeline
   is now in place. Next is building the Rust predictor crate with a small
   MLP, autograd, and the training loop that reads from session_memories.
2. **Phase 0 follow-ups** (optional, before Phase 1):
   - Add a dashboard widget showing session_memories stats (candidate count,
     injection rate, average relevance scores)
   - Add an API endpoint to query session_memories for debugging
   - Consider adding `source='predicted'` for predicted context memories
     (currently all recorded as "effective")

---

## Phase 1 Implementation Notes (Updated 2026-02-27)

### What was implemented

**New Rust crate scaffold** (`packages/predictor/`)
- Added `Cargo.toml`, `Cargo.lock`, and module structure:
  `autograd.rs`, `model.rs`, `tokenizer.rs`, `training.rs`, `data.rs`,
  `protocol.rs`, `checkpoint.rs`, `main.rs`, `lib.rs`
- Stdin/stdout JSON-RPC service with `score`, `train`, and `status`
  methods in `main.rs`

**Autograd core** (`packages/predictor/src/autograd.rs`)
- Implemented operation-level tape with parameter storage and gradients
- Added ops required by Phase 1 plan:
  - `Sigmoid`
  - `MeanPool`
  - `FeatureConcat`
  - `ListwiseLoss` (KL divergence over temperature-scaled softmax)
- Added additional ops needed to support plan-aligned model evolution:
  - `Embed` (trainable row lookup for hash/project embedding tables)
  - `LayerNorm` (per-path normalization before attention)
- Backward pass now consumes op tape via `std::mem::take` and iterates
  by ownership (no per-iteration `Op` clone in reverse loop)

**Model core** (`packages/predictor/src/model.rs`)
- Implemented cross-attention style scorer with:
  - pre-embedded path (`native_dim -> internal_dim` downprojection)
  - attention projections (`Q`, `K`, `V`)
  - learned gate over similarity + feature signals
- Added both encoding paths from the planning spec:
  - pre-embedded path
  - text path (HashTrick token IDs -> embedding lookup -> mean pool)
- Added per-path layer normalization before attention for both paths
- Added project embedding table (`project_slots x internal_dim`) and
  included project signal in gate input

**Training execution** (`packages/predictor/src/training.rs`, `main.rs`)
- Implemented Adam optimizer
- Implemented `train_batch()` with listwise loss and model update
- JSON-RPC `train` now performs real gradient updates (no longer stub),
  returns non-zero loss, and updates model status counters/version

**Checkpoint + protocol**
- Implemented checkpoint format with `SGPT` magic/version/flags/config/params
- Extended protocol params to support:
  - optional text candidates (`candidate_texts`)
  - optional feature matrix (`candidate_features`)
  - `project_slot`

### What was different than planned

- `LayerNorm` and project embeddings were initially deferred but were
  pulled into Phase 1 to align model behavior with the architecture
  section (path normalization + project context) before daemon wiring.
- `train` RPC was initially scaffolded as a placeholder; it now executes
  real training updates to avoid false-positive integration confidence.
- `data.rs` remains a Phase 2 placeholder; it currently discovers session
  keys only and does not yet assemble training tensors from
  `session_memories` + embeddings.

### Verification completed

- `cargo fmt --all`
- `cargo test --offline` passes (12 tests)
  - includes autograd gradient tests, model path tests, protocol parse,
    tokenizer tests, and training-step parameter update test
- Manual JSON-RPC smoke:
  - `train` returns finite/non-zero loss
  - `status` transitions to `trained: true` and increments model version

### Open gaps vs full plan

- `data.rs` does not yet build real `TrainingSample` rows from SQLite joins
- Daemon sidecar integration (`predictor-client.ts`, spawn lifecycle,
  fallback/timeout/crash handling) not started
- RRF fusion, EMA success tracking, and `predictor_comparisons` migration
  not started
- Dashboard/observability predictor domain not started

### Next steps

1. **Phase 2 (data + training pipeline)**
   - Implement SQLite joins in `data.rs` for
     `session_memories`/`session_scores`/embeddings
   - Map behavioral + continuity labels into final training labels
   - Add checkpoint load path (`--base-weights`) and periodic save hooks
2. **Phase 3 (daemon integration)**
   - Add predictor sidecar lifecycle manager and JSON-RPC client
   - Wire scoring into session-start flow with bounded candidate pool
   - Add training trigger from session-end and comparison logging
3. **Phase 4 (observability + dashboard)**
   - Add diagnostics domain, analytics stages, timeline events, and
     `/api/predictor/*` routes
   - Add dashboard Predictor tab with cold-start and active modes

---

## Phase 2 Implementation Notes

Completed: 2026-02-27

### What was built

`data.rs` — complete rewrite (~480 LOC) implementing the SQLite data
pipeline for autonomous training:

- **DataConfig** — min_scorer_confidence (0.6), loss_temperature (0.5),
  native_dim (768)
- **LoadResult** — returns both samples and `sessions_skipped` count
  for accurate telemetry
- **3-query pipeline**: scored sessions → per-session candidates
  (session_memories + memories + embeddings join) → session gap
- **12-dim feature vector**: recency (log), importance, access frequency
  (log), cyclical time encodings (hour/dow/month sin+cos), session gap
  (log), embedding flag, deletion flag
- **Blended label construction**: deleted → -0.3, injected with
  per-memory relevance ± FTS adjustment, non-injected with graduated
  FTS signal (0/1/2+ hits → 0.0/0.3/0.6)
- **Synthetic query embedding**: mean of injected candidate embeddings
- **FNV1a project slot hashing**: 32 slots via public fnv1a_hash from
  tokenizer
- **Manual ISO 8601 parsing**: Howard Hinnant civil date algorithm,
  Tomohiko Sakamoto day-of-week — no chrono dependency

`training.rs` — extended with:
- `build_candidates_for_sample` helper (shared by train_batch,
  record_top5, evaluate_canary)
- `train_epochs` — multi-epoch training with early stopping at loss <
  1e-6
- `CanaryMetrics` + `record_top5` + `evaluate_canary` — pre/post
  training top-5 overlap stability and score variance

`protocol.rs` — new types:
- `TrainFromDbParams` (db_path, checkpoint_path, limit, epochs,
  temperature, min_confidence)
- `TrainFromDbResult` (loss, step, samples_used/skipped, duration_ms,
  canary metrics, checkpoint_saved)
- `SaveCheckpointParams` / `SaveCheckpointResult`

`main.rs` — new capabilities:
- `--checkpoint` CLI arg for checkpoint restore at startup
- `train_from_db` RPC method: SQLite load → canary/training split →
  multi-epoch training → canary evaluation → validation gates → auto
  checkpoint save
- `save_checkpoint` RPC method
- `handle_rpc` generic helper to DRY up JSON-RPC dispatch
- `format_timestamp()` producing RFC3339 via Howard Hinnant civil_from_days

`tokenizer.rs` — `fnv1a64` → `pub fn fnv1a_hash` for cross-module use

### Test results

29 tests passing, 0 clippy warnings. Test coverage:
- Embedding blob parsing (valid, wrong size, empty)
- Feature vector construction (12 dims, known values)
- Label construction (all 5 branches)
- Project slot hashing (determinism, None → 0)
- Query embedding (mean of 2, no injected → zero vec)
- Timestamp parsing, days_since_epoch (epoch 0, Y2K)
- Integration test with in-memory SQLite + VACUUM INTO
- train_epochs loss reduction

### Smoke test

```
echo '{"jsonrpc":"2.0","id":1,"method":"train_from_db","params":{...}}' \
  | ./target/release/predictor
```
Returns valid JSON-RPC response. Current production DB has 0
session_memories rows (Phase 0 table exists but not yet populated by
running daemon), so samples_used=0 is expected. Pipeline correctly
queries, filters by confidence, and handles empty candidate sets.

### Schema deviations (documented)

1. **No `superseded_by` column** — using `is_deleted` (migration 002)
   as the negative signal. Label is -0.3.
2. **No session context embedding** — using FTS hit count as proxy for
   topical relevance of non-injected memories. Phase 3 will compute
   real context embeddings.
3. **`fts_hit_count == 1 → 0.3`** — graduated signal not in original
   spec. Provides smoother gradient between "never matched" (0.0) and
   "matched 2+ times" (0.6).

### Open gaps (deferred to Phase 3+)

- Daemon sidecar lifecycle (spawn, health, restart)
- `predictor-client.ts` JSON-RPC client
- RRF fusion in hooks.ts
- NDCG comparison + success rate EMA
- `predictor_comparisons` / `predictor_training_log` migrations
- Cosine similarity threshold for non-injected negatives
- Dashboard predictor tab
