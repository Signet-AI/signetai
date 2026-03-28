# PRD: Reddit Community Knowledge Graph Training Pipeline
### Signet × Pushshift → Community-Pretrained SSM

**Authors:** Jake, Nicholai, Buba, Ant, Oogie
**Date:** March 28, 2026
**Status:** Draft v1

---

## 1. Objective

Build a pipeline that:
1. Ingests Reddit community data (Pushshift archive + Reddit API)
2. Processes it through Signet's adapted distillation pipeline
3. Constructs knowledge graphs for each community
4. Generates training signal via LLM-scored retrieval
5. Trains an SSM-based model on traversal patterns across community graphs
6. Ships as a pretrained base model with every Signet install (cold start killer)

**Starting scope:** 2-3 communities for validation. Scale to 100, then 10,000.

---

## 2. Data Acquisition

### 2.1 Pushshift Archive (Historical: 2005-2023)

**Source:** Academic Torrents / Internet Archive
- Submissions: zstandard-compressed JSONL, ~1 file per month
- Comments: zstandard-compressed JSONL, ~1 file per month
- Total archive: ~2-3 TB compressed

**Per-item fields (submissions):**
`id, subreddit, author, title, selftext, score, upvote_ratio, num_comments, created_utc, link_flair_text, is_self, over_18, distinguished, stickied, author_flair_text, gilded, domain`

**Per-item fields (comments):**
`id, subreddit, author, body, score, controversiality, created_utc, parent_id, link_id, distinguished, gilded`

**Acquisition steps:**
1. Download submission + comment dumps for target subreddits
2. Filter by subreddit name during decompression (avoid processing entire archive)
3. Store filtered data as per-subreddit JSONL files
4. Index by `created_utc` for chronological processing

**Tools:** `zstd` for decompression, `jq` or custom Rust/Node parser for filtering

**Legal note:** Pushshift data has been used in 500+ published academic papers. Commercial use is gray area under Reddit ToS. For validation phase (2-3 communities), risk is negligible.

### 2.2 Reddit API (Recent: 2023-present)

**Access:** OAuth app registration → 100 requests/min
**Alternative:** Reddit Academic Data API (higher limits, requires application)

**Acquisition steps:**
1. Register OAuth app on Reddit
2. Paginate through subreddit history (submissions + comments)
3. Backfill from July 2023 to present
4. Store in same JSONL format as Pushshift data

**Rate limit math:** 100 req/min × 100 items/req = 10,000 items/min. One large subreddit (~500K comments/year) takes ~50 min to fully backfill.

### 2.3 Pilot Communities (Start Here)

Pick 2-3 communities that are:
- Technical (rich entity/relationship content)
- Active (enough volume for meaningful graphs)
- Mid-size (not r/AskReddit scale, not dead)

**Recommended pilot set:**
| Subreddit | Subscribers | Why |
|---|---|---|
| r/ollama | ~100K | Directly relevant to Signet's user base, technical, active |
| r/selfhosted | ~400K | Infrastructure-focused, strong opinions (constraint-rich), long history |
| r/LocalLLaMA | ~300K | AI/ML focused, fast-moving (good temporal evolution testing) |

**Data volume per community (estimated):**
- ~50K-200K submissions over 3-5 years
- ~500K-5M comments
- After significance gate filtering: ~10K-50K threads worth processing

---

## 3. Data Processing Pipeline

### 3.1 Pre-processing (New Module: `batch-ingest/`)

```
pushshift-dump.jsonl.zst
  → zstd decompress
  → filter by subreddit
  → sort by created_utc (CRITICAL: chronological order)
  → group submissions with their comments (join on link_id)
  → format as pseudo-sessions
  → write to processing queue
```

**Pseudo-session format:**
```json
{
  "transcript": "Post by u/user1 (score: 847, 234 comments):\n[Title]: How I migrated from Docker Compose to Kubernetes\n[Body]: After 3 years of running...\n\n---\nReply by u/user2 (score: 92):\nGreat writeup. One thing I'd add...\n\nReply by u/user3 (score: -12):\nThis is overkill for most people...",
  "sessionKey": "reddit:r/selfhosted:thread:abc123",
  "agentId": "community:r/selfhosted",
  "metadata": {
    "source": "pushshift",
    "subreddit": "selfhosted",
    "thread_id": "abc123",
    "thread_score": 847,
    "num_comments": 234,
    "created_utc": 1648000000,
    "top_comment_scores": [92, 45, 38, -12]
  }
}
```

**Input chunking (for threads > 12K chars):**
- Strategy: Top-N comments by score, fitting within 12K char budget
- Include: post title + body + top 10-20 comments (by score)
- Exclude: low-score comments, bot comments, deleted content
- If thread still exceeds limit after filtering: split into multiple pseudo-sessions with shared post context

**Checkpoint/resumability:**
- Track last processed `created_utc` per subreddit
- On restart, resume from checkpoint
- Write checkpoint every 100 threads

### 3.2 Significance Gate (Adapted)

**Replace turn-count logic with engagement filter:**

```
PASS if ANY of:
  thread_score >= 50
  num_comments >= 20
  any comment controversiality > 0.5
  thread contains code block (``` detected)
  thread gilded > 0
  thread is stickied or distinguished
SKIP otherwise
```

**Expected pass rate:** ~10-20% of all threads (the high-signal minority)

### 3.3 Extraction (Adapted)

**New extraction profile: `community_intelligence`**

```
You are analyzing a Reddit thread from r/{subreddit}.

Thread metadata:
- Score: {score} | Comments: {num_comments} | Created: {date}
- Author: u/{author}

Extract the following:

ENTITIES (up to 30):
- Tools, projects, and technologies mentioned
- Users who demonstrated notable expertise (backed by upvotes)
- Concepts and techniques discussed
- Problems identified and solutions proposed

RELATIONSHIPS:
- Who corrected whom (expertise signal)
- What tools are compared to what (dependency edges)
- What problems relate to what solutions (depends_on edges)

COMMUNITY SIGNALS:
- Implicit norms or strong preferences (→ constraints)
- Points of agreement (high-upvote consensus)
- Points of disagreement (split opinions with engagement on both sides)
- Temporal markers ("since v2.0", "used to work but now...")

Weight your extraction by community validation:
- High-score comments (>50) = high confidence facts
- Negative-score comments = low confidence or contested claims
- Gilded comments = community-certified high value

Output JSON with facts[] and entities[] arrays.
```

**Limits for community mode:**
- `MAX_ENTITIES`: 30 (up from 15)
- `MAX_FACTS`: 40 (up from 20)
- `MAX_INPUT_CHARS`: 12000 (unchanged, handled by chunking)

### 3.4 Decision Engine (Adapted)

**New decision vocabulary for community data:**

| Decision | When | Effect |
|---|---|---|
| ADD | New fact, no existing match | Create new memory + entity attributes |
| SUPERSEDE | Same topic, newer info replaces older | Create new memory, mark old as `superseded_by` |
| CONFLICT | Different users hold opposing views | Create both as parallel attributes with provenance |
| SKIP | Duplicate or low-value | No action |

**Key change:** No DELETE for community data. Community knowledge should preserve disagreement, not collapse it.

**Candidate limit:** Increase to 10-15 (from 5) for community graphs with more entities.

**Scoring weight:** Pass thread/comment score into decision prompt so the LLM can weight higher-karma content.

### 3.5 Contradiction Detection (Adapted → Debate Detection)

**New contradiction types:**
- `supersession`: Factual update (same or different user). "Docker Compose v2 is now stable" supersedes "Docker Compose v2 is buggy"
- `disagreement`: Legitimate community split. "Use Kubernetes" vs "Kubernetes is overkill" — both preserved with provenance and strength
- `correction`: Expert corrects non-expert. Higher-karma correction supersedes lower-karma claim

**Disagreement strength:** Track the ratio of upvotes on each side. 80/20 split = weak disagreement. 50/50 = strong disagreement. Strong disagreements become dual attributes on the same aspect.

### 3.6 Graph Persistence (Minor Changes)

- Wire `thread_score` → `confidence` on dependency edges
- Wire `comment_score` → `confidence` on entity attributes
- Co-mention frequency naturally builds `strength` via running average
- Keep existing entity type taxonomy (person, project, system, tool, concept, skill, task, unknown)
- Community-specific context lives in aspects, not types

### 3.7 Behavioral Feedback (Adapted)

**Karma as FTS proxy:**

| Signal | Effect | Equivalent |
|---|---|---|
| Comment score >= 50 | `+delta` to aspect weight | Strong FTS confirmation |
| Comment score >= 10 | `+delta * 0.5` | Mild FTS confirmation |
| Comment score < 0 | `-delta` to aspect weight | Negative signal |
| Gilded/awarded | `+delta * 1.5` | Strong confirmation |
| Controversial (high vote count, ~50% ratio) | `-0.1x` modifier | Contested signal |

**Aspect decay:** Processes chronologically, so aspects from 2020 that aren't reinforced by 2023 data decay naturally via the existing `staleDays` mechanism.

### 3.8 Dampening Adaptations

**Hub dampening:** Scope-aware thresholds
- Entities appearing in >50% of a subreddit's threads: `hubPenalty` at community level
- Global entities (appear across >100 subreddits): higher `hubPercentile` threshold (0.99 vs 0.90)

**Gravity dampening:** Community-specific stop-word lists
- Load per-subreddit jargon lists (can be auto-generated from highest-TF terms)
- Prevents common subreddit terms from triggering false gravity penalties

**Resolution boost:** Add community consensus multipliers
- `community_norm` type (mod posts, wiki, stickied): 1.2x
- `expert_consensus` (high-karma + temporal anchor): 1.15x

### 3.9 Prospective Indexing (Community FAQ Layer)

**Prompt adaptation:**
```
What questions would someone ask about r/{subreddit} where this
post/comment would be a useful answer?

Think about:
- "What does r/{subreddit} think about [topic]?"
- "What's the community consensus on [tool/approach]?"
- "What problems do people have with [technology]?"
- "Who are the experts on [topic] in r/{subreddit}?"
```

This creates a community FAQ layer on top of raw content — queryable community intelligence.

### 3.10 Summarization Hierarchy

```
Thread          = 1 session
Daily digest    = all threads from 1 day (arc equivalent)
Weekly arc      = 7 daily digests condensed
Monthly epoch   = 4 weekly arcs condensed
Yearly summary  = 12 monthly epochs condensed (NEW tier)
```

Condensation logic unchanged. Add yearly tier for multi-year data.

---

## 4. Training Signal Generation

### 4.1 Nicholai's Approach: LLM-Scored Retrieval

Rather than waiting for agent-in-the-loop feedback (which requires live users), simulate the feedback loop:

1. **Build the community KGs** (steps above)
2. **Generate evaluation queries** — LLM creates questions someone might ask about the community:
   - "What's the best self-hosted alternative to Google Photos?"
   - "Has r/selfhosted's opinion on Immich changed in the last year?"
   - "Who are the most knowledgeable users about Docker networking?"
3. **Run traversal** — For each query, run Signet's traversal engine against the community KG. Record the traversal paths taken.
4. **LLM judges the results** — An LLM scores each traversal output: "Did this path produce relevant, helpful context for the query?" Score 0.0-1.0.
5. **Generate training pairs** — `(query, traversal_path, helpfulness_score)` tuples become training data for the SSM path scorer.

**Why this works:** The LLM acts as a proxy for human judgment. Nicholai's research shows 29 LLM-generated scenarios outperform 2,000 hand-crafted ones for training. The LLM doesn't need to be perfect — it needs to be directionally correct at scale.

**Volume:** 100-500 evaluation queries per community × traversal paths per query = thousands of training pairs from just 2-3 communities.

### 4.2 Canary Patterns (from SYNTHETIC-DATA-GENERATION.md)

Plant known-good patterns in the evaluation set:
1. **Temporal recency** — recent facts should score higher for "what's the current consensus?" queries
2. **Constraint surfacing** — community norms should always surface when relevant entities are in scope
3. **Expert authority** — paths through high-karma user entities should score higher
4. **Disagreement preservation** — queries about controversial topics should surface both sides

If the model fails any canary after training, something is wrong with the training data.

---

## 5. Model Architecture

### 5.1 Path SSM (~50K params)

From `ssm-graph-traversal-model.md`:

**Level 1: Edge-level SSM** (S4D, not Mamba — S4 beats Mamba on graph data by 6-12%)
- Input: 12-dim feature vector per edge (entity types, confidence, strength, co-occurrence, traversal count, community boundary crossing)
- Architecture: `Linear(12, 32) → Selective SSM (1 layer, state_dim=16, conv_kernel=3) → last hidden state (32-dim)`

**Level 2: Path comparison**
- Query conditioning: `dot(query_embedding_down, path_embedding)`
- Score head: `Linear(32, 1)`
- Loss: ListNet over path rankings

### 5.2 Temporal Backbone (~5-10M params, future)

Mamba-3 based. Trained after path SSM is validated.

### 5.3 Hardware

**Nicholai's spec:** RTX Pro 6000 Ada — $1.69/hr cloud rental
- Path SSM (50K params): trains in hours
- Temporal backbone (5-10M params): trains in a day
- Total compute for pilot: ~$20-50

---

## 6. Validation & Evaluation

### 6.1 Pilot Validation (2-3 communities)

**Gate 1: Graph Quality**
- [ ] Entities extracted match human expectations (spot check 50 entities per community)
- [ ] Dependency edges are structurally correct (spot check 50 edges)
- [ ] Constraints identified match actual community norms
- [ ] Temporal supersession works (old facts correctly marked when new info appears)
- [ ] Disagreements preserved (both sides of debates captured)

**Gate 2: Training Signal Quality**
- [ ] LLM-scored retrieval produces non-uniform scores (variance > 0)
- [ ] Canary patterns pass
- [ ] Training pairs have reasonable label distribution (not all 0.5)

**Gate 3: Model Performance**
- [ ] Path SSM produces non-uniform scores after training
- [ ] Path SSM beats heuristic baseline on held-out evaluation queries
- [ ] Top-k stability: model's top paths overlap >60% across retrains
- [ ] Transfer test: does community-trained model improve path scoring on real Signet user graphs?

### 6.2 Scale Validation (100 communities)

**Gate 4: Pipeline Scalability**
- [ ] Batch processing handles 100 communities without OOM or corruption
- [ ] Chronological ordering maintained under parallel processing
- [ ] Graph sizes are reasonable (not exploding with noise entities)
- [ ] Training improves monotonically with more communities (not degrading)

### 6.3 Full Scale (10,000 communities)

**Gate 5: Infrastructure**
- [ ] Storage solution handles 10K community graphs
- [ ] Training completes within reasonable time/cost budget
- [ ] Model performance continues improving (no plateau at 1K communities)

---

## 7. Integration with Signet

### 7.1 Pretrained Base Model

Ship the community-trained SSM weights as a file bundled with Signet installs:
- `~/.agents/memory/predictor/community-base.bin` (~200KB-2MB)
- Loaded on first install, used as initialization weights for the per-user predictor
- Per-user LoRA adapter trains on top of this base

### 7.2 Cold Start Impact

**Before:** 30-50 sessions for predictor to be useful
**After:** 3-5 sessions (community base provides structural priors, LoRA adapts to individual)

### 7.3 Community Intelligence API (Future)

Expose community KGs as queryable endpoints for B2B customers:
- `GET /api/community/{subreddit}/entities` — entity graph
- `GET /api/community/{subreddit}/trends` — temporal trends
- `GET /api/community/{subreddit}/experts` — authority mapping
- `POST /api/community/{subreddit}/query` — traversal-based Q&A

---

## 8. Privacy & Ethics

### 8.1 Data Handling
- Pushshift data is already public — no private information
- Reddit usernames are public but consider pseudonymity expectations
- For the pretrained model: train on graph structure and traversal patterns, NOT on user-identifiable content
- The model learns "how communities evolve" not "what u/specificuser said"

### 8.2 Transparency (Nicholai's Point)
- If the community model ships with Signet, users should know it exists
- Option A: Disclose in docs/changelog that a community-pretrained base model is included
- Option B: Make it opt-in ("Enable community pretraining for faster cold start?")
- **Decision needed from team before public release**

### 8.3 Reddit ToS
- Pushshift historical data: widely used, gray area for commercial
- Reddit API data: must comply with API terms (no resale of raw data, but model weights derived from data are a different question)
- For pilot: zero risk (internal research only)
- For production: consult legal before shipping community model publicly

---

## 9. Timeline & Milestones

### Phase 0: Data Acquisition (Week 1)
- [ ] Download Pushshift dumps for pilot communities (r/ollama, r/selfhosted, r/LocalLLaMA)
- [ ] Filter and index by subreddit
- [ ] Backfill recent data via Reddit API
- [ ] Validate data completeness

### Phase 1: Pipeline Adaptation (Weeks 2-4)
- [ ] Build batch ingest module (`batch-ingest/`)
- [ ] Build input adapter (Reddit thread → pseudo-session)
- [ ] Create community extraction profile
- [ ] Implement ADD/SUPERSEDE/CONFLICT decision model
- [ ] Adapt contradiction detection → debate detection
- [ ] Wire karma → confidence/feedback signals
- [ ] Add hub dampening scope awareness
- [ ] Add community-specific stop-words for gravity dampening
- [ ] Add resolution boost for community consensus
- [ ] Adapt prospective indexing prompts
- [ ] Add yearly summarization tier
- [ ] Build progress tracking + resumability

### Phase 2: Graph Construction (Week 4-5)
- [ ] Run pipeline on first community (r/ollama)
- [ ] Validate graph quality (Gate 1)
- [ ] Iterate on extraction profile based on results
- [ ] Run on remaining 2 pilot communities
- [ ] Spot-check cross-community consistency

### Phase 3: Training Signal Generation (Week 5-6)
- [ ] Generate evaluation queries (100-500 per community)
- [ ] Run traversal engine against community KGs
- [ ] LLM-score traversal outputs
- [ ] Validate training signal quality (Gate 2)
- [ ] Plant and verify canary patterns

### Phase 4: Model Training (Week 6-7)
- [ ] Train path SSM on community traversal data
- [ ] Validate model performance (Gate 3)
- [ ] Transfer test: evaluate on real Signet user graphs
- [ ] Iterate on architecture/hyperparams if needed

### Phase 5: Scale Decision (Week 7-8)
- [ ] Review pilot results as team
- [ ] Decide: scale to 100 communities or iterate on pipeline
- [ ] If scaling: plan infrastructure (SQLite → Postgres migration?)
- [ ] Discuss public/private model distribution

### Phase 6: Integration (Week 8-10, if pilot succeeds)
- [ ] Package model weights as Signet-bundled file
- [ ] Wire into predictor cold-start path
- [ ] Test cold-start improvement on new Signet installs
- [ ] Documentation + changelog

---

## 10. Cost Breakdown

### Pilot (2-3 communities)

| Item | Cost |
|---|---|
| Pushshift data download | Free |
| Reddit API (backfill) | Free (within rate limits) |
| LLM extraction (sampled, ~10K threads) | $50-150 (GPT-4o-mini) or $0 (local Ollama) |
| LLM scoring (training signal, ~1K queries) | $20-50 |
| GPU training (path SSM, A6000) | $20-50 (~12-30 hrs × $1.69/hr) |
| Storage | Negligible (local SSD) |
| **Total pilot** | **$90-250** (cloud LLM) or **$20-50** (local + GPU only) |

### Scale (100 communities)

| Item | Cost |
|---|---|
| LLM extraction (~100K threads) | $500-1,500 |
| LLM scoring (~10K queries) | $200-500 |
| GPU training | $50-100 |
| Storage (Postgres if needed) | $20-50/mo |
| **Total 100-community** | **$770-2,150** |

### Full Scale (10,000 communities)

| Item | Cost |
|---|---|
| LLM extraction (~1M threads) | $5K-15K |
| LLM scoring (~100K queries) | $2K-5K |
| GPU training | $100-500 |
| Infrastructure (Postgres + queue) | $200-500/mo |
| **Total 10K-community** | **$7.3K-21K** |

---

## 11. Open Questions (Decisions Needed)

| # | Question | Owner | Urgency |
|---|---|---|---|
| 1 | Which 2-3 pilot communities? (recommended above but team should confirm) | Jake + Nicholai | Before Phase 0 |
| 2 | Local LLM (Ollama) vs cloud (GPT-4o-mini) for extraction? | Nicholai | Before Phase 1 |
| 3 | SQLite for pilot or Postgres from the start? | Nicholai | Before Phase 1 |
| 4 | Community model transparency: opt-in, disclosed, or silent? | All (Jake's call) | Before Phase 6 |
| 5 | Reddit ToS: consult legal before production? | Jake | Before scaling |
| 6 | Who builds the batch ingest module? (Nicholai, contributor, or agent?) | Nicholai | Before Phase 1 |
| 7 | Cross-community linking: separate feature or part of pilot? | Nicholai | Before Phase 2 |
| 8 | What's the NDCG@10 target for Gate 3 (model beats heuristic)? | Nicholai | Before Phase 4 |

---

## 12. Success Criteria

**The project succeeds if:**

1. Community KGs are structurally coherent (entities, aspects, attributes, constraints, dependencies all populated correctly)
2. The path SSM trained on community data beats the heuristic baseline on held-out community queries
3. **CRITICAL:** The community-trained model improves cold start on *real Signet user graphs* — this is the transfer test that proves the whole thesis
4. Cost to produce stays under $250 for the pilot
5. The pipeline is reusable for any future data source (CRM, email, Discord, etc.) with a new input adapter

**The project fails if:**
- Community graph structure doesn't map to Signet's schema (schema is wrong for community data)
- Training signal from LLM scoring is too noisy (no meaningful gradient)
- No transfer: community-trained model doesn't help individual user graphs
- Cost explodes beyond projections (LLM extraction too expensive at scale)

---

*FER DA BOYYYSSSSS* (╯°□°)╯︵ ┻━┻

Built from tonight's 3-agent roundtable. Jake, Nicholai, Buba, Ant, Oogie.
March 28, 2026, 2:00 AM ET.
