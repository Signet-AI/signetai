# Community Knowledge Graphs: Product Requirements Document

**Status:** Planning  
**Authors:** Nicholai, Jake, Ant, Buba, Oogie  
**Date:** March 27, 2026  
**Codename:** Groundswell

---

## 1. Vision

Build knowledge graphs from the top Reddit communities using Signet's distillation pipeline, then train a lightweight SSM on the resulting structured data. The model learns how communities think, evolve, disagree, and adopt, and that knowledge feeds back into Signet's core product (cold start elimination, predictive recall) and potentially becomes a standalone intelligence product.

## 2. Value Propositions (ranked by likelihood)

1. **Cold start elimination.** A pretrained community model ships with every Signet install. New users get smart recall from session one instead of waiting 30-50 sessions for the predictor to learn. Directly implements VISION.md.
2. **Community intelligence API.** Structured knowledge about how communities think, adopt tools, resist changes, and evolve over time. Sold to product teams, DevRel, VCs doing due diligence. B2B revenue at $500-5K/month per vertical.
3. **Predictive community behavior.** Discourse fingerprinting: the model has seen thousands of technology adoption curves and can identify where any tool sits on that curve. Useful for launch timing, competitive intelligence, and trend detection.
4. **Persuasion and argument topology.** Reddit upvotes as crowdsourced RLHF for argument quality. A model that knows which structures of argument land in which contexts.
5. **Cross-community expert discovery.** Bridge users active in multiple subreddits reveal latent expertise networks validated by community feedback, not self-declared skills.

## 3. Constraints

- **Models stay private until all contributors agree to release after testing.** No public release without team consensus.
- **Entity type system stays small.** No new entity types (user, subreddit, thread, event, norm). Use aspects and attributes on existing types (person, project, system, tool, concept, skill, task, unknown).
- **Start with 2-3 communities for validation**, not 100, not 10,000.
- **Cost awareness.** RTX Pro 6000 Ada at $1.69/hr for training. LLM extraction costs must be estimated per community before scaling.
- **Schema changes like SUPERSEDE/CONFLICT are already planned**, just not implemented. This project accelerates existing roadmap items.

## 4. Data Source: Pushshift Reddit Archive

### What it is
Bulk archive of nearly all public Reddit data from 2005 through mid-2023. Collected by Jason Baumgartner's Pushshift project before Reddit killed third-party API access.

### What's in it
- Every public submission (title, body, author, score, num_comments, timestamp, subreddit, flair, awards, upvote_ratio)
- Every public comment (body, author, score, controversiality, timestamp, parent_id, link_id, gilded)
- Subreddit metadata (subscriber counts, descriptions, rules, creation dates)
- Full reply tree structure via parent_id chains

### What's NOT in it
- Private messages, private/quarantined subreddits
- Vote breakdowns (net score only, not up/down split)
- Data after mid-2023 (requires Reddit API for recent data)

### Where to get it
- Academic Torrents and archive.org
- ~2-3 TB compressed (zstandard), ~20-30 TB decompressed
- Filtering to target communities cuts volume by ~95%

### Legal situation
- Gray area for commercial use. Reddit ToS claims ownership but archives have been publicly available for a decade and used in hundreds of papers.
- For recent data: Reddit's official Data API or academic researcher program.
- Decision: use archive for historical (pre-2023), API for recent. Consult legal before any commercial product ships.

## 5. Pipeline Adaptation (the "last 20%")

### 5.1 Input Adapter (NEW)

**Purpose:** Convert Pushshift JSONL into pseudo-sessions the pipeline can consume.

**Format:**
```
{
  transcript: "Post by u/user1 (847 upvotes, 234 comments): [title + body]
               Reply by u/user2 (92 upvotes): [comment]
               Reply by u/user3 (-12 upvotes): [comment]..."
  sessionKey: "reddit:r/ollama:thread:abc123"
  agentId: "community:r/ollama"
}
```

**Key decisions:**
- Metadata (upvotes, comment count, timestamps, author karma) embedded IN the transcript text so the LLM observes it during extraction
- Each community = its own agentId (multi-agent scoping already built)
- Threads sorted chronologically before processing (critical for supersession)

**Input chunking:** Threads exceeding `MAX_INPUT_CHARS` (12,000) get segmented. Strategy: highest-signal comments first (by score), then by reply depth. Each chunk processed as a separate mini-session linked by thread ID.

**Estimate:** 1-2 days

### 5.2 Significance Gate Adaptation

**Current:** Checks turn count, entity overlap, content novelty. All three must be low to skip.

**Adapted:** Replace with engagement-based metadata filter:
- PASS if score >= 50 OR num_comments >= 20 OR gilded > 0 OR contains code blocks
- SKIP otherwise

Reddit's metadata does the filtering that the LLM-based novelty check does today. Millions of humans already curated the signal.

**Estimate:** 0.5 days

### 5.3 Extraction Profile

**Current prompt** is tuned for individual agent conversations ("extract facts, preferences, decisions").

**Community extraction profile:**
```
You are analyzing a Reddit thread from r/{subreddit}.

Thread metadata: Score: {score}, Comments: {num_comments}, Age: {age}
Author: u/{author} (karma: {karma})

Attention priorities:
- Recurring problems and proposed solutions
- Expert identification (who gets upvoted, who corrects others)
- Community norms and implicit rules (what gets downvoted = constraints)
- Opinion evolution and temporal shifts
- Disagreement patterns (where the community splits and why)
- Terminology and jargon specific to this community

For each entity, note community validation based on vote data.
```

**Limit changes for community mode:**
- `MAX_ENTITIES`: 15 -> 25-30
- `MAX_FACTS`: 20 -> 30-40
- Profile selected based on agentId prefix (`community:` -> community profile)

**Estimate:** 2-3 days

### 5.4 Decision Engine: ADD/SUPERSEDE/CONFLICT

**Current:** ADD/UPDATE/DELETE/SKIP

**Adapted:** ADD/SUPERSEDE/CONFLICT/SKIP
- **ADD:** New knowledge, no existing match
- **SUPERSEDE:** Same entity, newer factual information replaces older (tool X replaced by tool Y). Requires chronological processing.
- **CONFLICT:** Community genuinely split. Creates parallel attributes on the same aspect representing both positions, tagged with relative community support and provenance. "r/golang: 60% say generics are overused, 40% say they're the future" coexists, not supersedes.
- **SKIP:** Duplicate or insignificant

Wire community validation score into the decision prompt so high-karma facts can override low-karma predecessors in SUPERSEDE decisions.

Increase `CANDIDATE_LIMIT` from 5 to 10-15 for community graphs.

**Estimate:** 2-3 days

### 5.5 Contradiction Detection: Debate Detector Mode

**Current:** Two-pass (syntactic negation/antonyms, then LLM semantic check). Treats contradictions as errors to resolve.

**Adapted:** Add contradiction type classification:
- `supersession`: factual update (same entity, newer info replaces older)
- `divergence`: legitimate community disagreement (different users/groups hold different positions)

Divergence creates parallel attributes on the same aspect. Supersession marks the old attribute as superseded (existing behavior).

The LLM slow path prompt adds: "Is this a factual update or a community disagreement? If different groups hold different views, classify as divergence."

Domain-aware antonym expansion (REST vs GraphQL, monolith vs microservices are preference clusters in community context, not contradictions).

**Estimate:** 2-3 days

### 5.6 Dampening Adaptations

**Hub dampening:** Current P90 global threshold breaks on reddit topology. r/python mentioning "Python" 10,000 times isn't noise. Adapt to per-entity-type scope-aware thresholds instead of one global number.

**Gravity dampening:** Add community-specific stop-word lists. "meta" means the company in r/facebook and metagame in r/gaming. Per-community tokenizer config.

**Resolution boost:** Add community_norm and expert_consensus multipliers. Facts backed by high-karma expert agreement get boosted during recall.

**Estimate:** 1-2 days

### 5.7 Behavioral Feedback: Karma as FTS Proxy

**Current:** FTS overlap feedback (memories that get searched for gain weight).

**Adapted:** Reddit karma maps directly onto aspect weights:
- Comment score >= 50: strong confirmation (+full delta)
- Score >= 10: mild confirmation (+half delta)
- Score < 0: community rejection (-delta)
- Gilded/awarded: boosted confirmation (+1.5x delta)

Temporal decay still applies. Aspects from 2020 that aren't reinforced by 2023 threads fade naturally through chronological processing.

**Estimate:** 1-2 days

### 5.8 Prospective Indexing: Community FAQ Layer

**Current:** Hint prompt asks "what would this user search for?"

**Adapted:** For community agents, prompt becomes "what questions would someone ask about this community?" Turns prospective indexing into a pre-built FAQ surface per subreddit.

**Estimate:** 0.5 days

### 5.9 Summarization: Yearly Tier

**Current hierarchy:** Session -> arc (8 sessions) -> epoch (4 arcs)

**Adapted hierarchy:** Thread -> daily digest -> weekly arc -> monthly epoch -> yearly summary

Add yearly condensation tier for multi-year pushshift data. Adjust arc/epoch thresholds for community volume.

**Estimate:** 1 day

### 5.10 Graph Persistence

Mostly unchanged. Wire karma into confidence fields during entity persistence. Mention counting works naturally at volume. Co-mention frequency builds dependency edge strength organically.

Keep the narrow entity type taxonomy. A subreddit is a "concept" entity. A community norm is a "constraint" attribute. No new types.

**Estimate:** 0.5 days

### 5.11 Batch Orchestration (NEW)

**Purpose:** Process thousands of threads per community in chronological order with progress tracking and resumability.

**Components:**
1. Pushshift decompression and filtering (zstandard JSONL -> filtered by subreddit)
2. Chronological sort guarantee per community
3. Input adapter formatting threads as pseudo-sessions
4. Progress checkpointing (resume after interruption)
5. Per-community parallelization (each community = independent worker)
6. LLM rate limiting (budget-aware, configurable calls/minute)
7. Behavioral feedback runs after every ~100 threads
8. Summarization triggers at temporal boundaries (daily/weekly/monthly)
9. Embedding throughput management (local nomic-embed via ollama)

**Estimate:** 3-4 days

### 5.12 Cross-Community Linking (Phase 2)

Not needed for initial validation but planned for phase 2:
- Cross-community entity resolution by canonical name
- community_memberships table (user -> subreddit participation)
- co_participation scoring (subreddit overlap by shared users)
- Cross-community intelligence queries

## 6. Infrastructure

### Pilot (2-3 communities)
- SQLite (existing)
- Local embedding (nomic-embed via ollama)
- Single machine
- Nicholai's existing hardware

### Validation (100 communities)
- SQLite still probably fine
- May need dedicated embedding throughput
- Single machine with good storage

### Scale (10,000 communities)
- Evaluate SQLite -> Postgres migration for write path
- Job queue for batch orchestration (BullMQ or similar, kafka only if volume demands)
- Parallel processing across multiple workers
- Cloud GPU for SSM training (RTX Pro 6000 Ada, $1.69/hr)

## 7. Training Approach

Nicholai's framing: the model trains on how the data is used with an agent in the loop.

**Bootstrap approach (no live users needed):**
1. Build community knowledge graphs from pushshift data
2. Use the graphs as a baseline search surface
3. Have LLMs query the graphs and score retrieval quality (which traversal paths produced the best answers?)
4. That scored retrieval data becomes the SSM training signal

This is synthetic RLHF for graph traversal. The LLM acts as the "user" evaluating whether the retrieved context was useful. The SSM learns which traversal patterns produce high-quality retrievals.

**Model size:** Small. Nicholai estimates a single A6000 handles all training. The predictor model is ~370K params (cross-attention). Community-pretrained version may be larger but still modest by current standards.

**Training data:** Traversal patterns through the graphs, not raw text. The model learns graph navigation, not language.

## 8. Timeline

### Phase 1: Prove it works (Weeks 1-3)
- Week 1: Input adapter, significance gate, chunking, extraction profile
- Week 2: SUPERSEDE/CONFLICT model, contradiction types, karma feedback, dampening
- Week 3: Batch orchestrator, FAQ indexing, yearly summarization, run on 2-3 communities

**Deliverable:** 2-3 community knowledge graphs. Qualitative assessment. Cost/time numbers.

### Phase 2: Validate at scale (Weeks 4-6)
- Run on 100 hand-picked communities
- Cross-community entity resolution and linking
- Community intelligence query layer
- Validate graph quality and usefulness

**Deliverable:** 100 community graphs. Working cross-community queries. Proof of value.

### Phase 3: Scale to 10K (Weeks 7-9)
- Infrastructure migration if needed (postgres, job queue)
- Process all 10,000 communities
- Train the SSM on the resulting corpus

**Deliverable:** 10,000 community knowledge graphs. Trained SSM.

### Phase 4: Product (Weeks 10-12)
- Cold start integration into Signet predictor
- Community intelligence API (if pursuing B2B)
- Validation of predictive behavior
- Team decision on public release

**Deliverable:** Shipped product integration or API. Team consensus on release.

## 9. Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Graph quality is poor after phase 1 | Medium | High | Start with 2-3 communities, validate before scaling |
| LLM extraction cost blows budget | Medium | Medium | Sample highest-signal threads, not all threads |
| Pushshift legal issues | Low-Medium | High | Consult legal before commercial use, use Reddit API for recent data |
| SSM doesn't learn useful traversal patterns from community data | Medium | High | Bootstrap with LLM-scored retrieval, validate transfer to individual graphs |
| SQLite chokes at 10K scale | High | Low | Known migration path to Postgres, only needed at phase 3 |
| Community graphs don't transfer to individual agent improvement | Medium | Medium | Community intelligence API is valuable independent of transfer |

## 10. Engineering Estimates

| Component | Days |
|-----------|------|
| Input adapter + chunking | 1-2 |
| Significance gate adaptation | 0.5 |
| Community extraction profile | 2-3 |
| ADD/SUPERSEDE/CONFLICT model | 2-3 |
| Contradiction type classification | 2-3 |
| Dampening adaptations | 1-2 |
| Karma behavioral feedback | 1-2 |
| Prospective FAQ layer | 0.5 |
| Summarization yearly tier | 1 |
| Graph persistence wiring | 0.5 |
| Batch orchestration | 3-4 |
| **Total pipeline adaptation** | **~15-22 days** |
| Cross-community linking (phase 2) | 3-5 |
| SSM training pipeline | 3-5 |
| **Total to trained model** | **~21-32 days** |

## 11. Open Questions

1. Which 2-3 subreddits for phase 1 validation? Suggestions: r/LocalLLaMA (technical, high signal), r/selfhosted (practical, decision-heavy), r/ExperiencedDevs (professional, opinion-rich)
2. What's the LLM cost estimate per community? Need to benchmark on first community before committing to 100.
3. Do we need Reddit API access for post-2023 data, or is 2005-2023 sufficient for training?
4. Who owns the batch orchestration build? This is the biggest new module.
5. What's the acceptance criteria for "good graph quality" after phase 1?

---

*"the pipeline was built for this kind of extension even if it wasn't designed for it explicitly."*
