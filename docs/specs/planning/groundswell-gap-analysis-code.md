# Groundswell: Code Gap Analysis

**Status:** Planning  
**Date:** March 27, 2026  
**Scope:** Codebase audit against community-knowledge-graphs.md PRD  
**Audited by:** Subagent (groundswell-code-analysis)

---

## Summary

The pipeline is structurally sound and the PRD's framing holds up. Most components need targeted modifications rather than rewrites. The two genuinely new builds are the Input Adapter and the Batch Orchestrator. A few components need non-trivial surgical changes (decision engine action set, contradiction classification, significance gate replacement). Everything else is configuration-level or prompt-level work.

---

## Component-by-Component Analysis

---

### 1. Extraction (`packages/daemon/src/pipeline/extraction.ts`)

**What exists:**
- Hard-coded constants at file top: `MAX_FACTS = 20`, `MAX_ENTITIES = 15`, `MAX_INPUT_CHARS = 12000`
- Single `buildExtractionPrompt(content)` function -- no profile parameter, no agentId-based dispatch
- Truncates input at 12,000 chars with a `[truncated]` suffix, no smart chunking
- Validation enforces the `MAX_FACTS`/`MAX_ENTITIES` limits with warnings
- `extractFactsAndEntities(input, provider, opts?)` takes no profile/context arg

**Gaps for community processing:**
- No profile dispatch: community extraction needs a completely different prompt (subreddit context, attention priorities, karma metadata)
- Limits are hard-coded: community mode needs `MAX_FACTS` 30-40, `MAX_ENTITIES` 25-30
- No chunking strategy: 12k char truncation discards high-signal comments at the tail. PRD wants highest-score comments first, then by reply depth
- `buildExtractionPrompt` doesn't accept metadata (score, num_comments, author karma) to embed in prompt
- No `agentId` passed through -- can't detect `community:` prefix to select profile

**Complexity:** Moderate. Refactor `buildExtractionPrompt` to accept a profile type + metadata. Add limits as config rather than constants. Add chunking logic (re-sort by score before slicing). ~2-3 days as PRD estimates.

---

### 2. Decision Engine (`packages/daemon/src/pipeline/decision.ts`)

**What exists:**
- `DECISION_ACTIONS` in `packages/core/src/types.ts`: `["add", "update", "delete", "none"]`
- `DecisionAction` type is a union of those four strings
- `CANDIDATE_LIMIT = 5` hard-coded
- Decision prompt asks LLM to choose add/update/delete/none
- `parseDecision()` validates against `VALID_ACTIONS = new Set(DECISION_ACTIONS)`
- No community validation score passed to the decision prompt

**Gaps for community processing:**
- `SUPERSEDE` and `CONFLICT` actions don't exist in the type system or prompt
- `CANDIDATE_LIMIT = 5` needs to be 10-15 for community graphs
- Decision prompt doesn't receive karma/community validation context to weight SUPERSEDE decisions
- `parseDecision()` will reject `"supersede"` or `"conflict"` as invalid actions

**Complexity:** Moderate. Add `"supersede"` and `"conflict"` to `DECISION_ACTIONS` in types.ts, update prompt, add validation logic for new actions (CONFLICT creates parallel attributes). Update `CANDIDATE_LIMIT` to be config-driven. Wire karma score into decision prompt. ~2-3 days as PRD estimates.

---

### 3. Contradiction Detection (`packages/daemon/src/pipeline/contradiction.ts`)

**What exists:**
- `detectSemanticContradiction(factContent, targetContent, provider, timeoutMs)`
- Binary output: `{ detected: boolean, confidence: number, reasoning: string }`
- Prompt asks: "Do these two statements contradict each other?"
- No classification of contradiction *type*

**Gaps for community processing:**
- No `type` field in `SemanticContradictionResult` -- PRD needs `"supersession"` vs `"divergence"`
- Prompt doesn't ask "Is this factual update or community disagreement?"
- No domain-aware antonym expansion for preference clusters (REST vs GraphQL, monolith vs microservices)
- `supersession.ts` calls `detectSemanticContradiction` and acts on `detected: boolean` only -- would need to handle the new type distinction

**Complexity:** Moderate. Add `type: "supersession" | "divergence" | "contradiction"` to result. Update prompt to classify. Update `supersession.ts` to branch on type (divergence -> parallel attributes, supersession -> existing behavior). ~2-3 days.

---

### 4. Significance Gate (`packages/daemon/src/pipeline/significance-gate.ts`)

**What exists:**
- Three-signal assessment: turn count, entity overlap, content novelty
- `assessSignificance(transcript, db, agentId, config)` 
- All three must fail to skip a session
- Turn counting looks for `Human:|User:|Assistant:` prefixes
- Entity overlap queries `entities` table with `mentions >= 3`
- Novelty compares token sets against last 5 completed sessions

**Gaps for community processing:**
- Turn counting is meaningless for Reddit threads (no `Human:`/`Assistant:` format)
- Content novelty against last 5 sessions is wrong for bulk batch processing (all threads from the same subreddit will look similar)
- Entity overlap requires a warm entity table -- empty on cold start
- PRD wants a simple metadata filter: `score >= 50 OR num_comments >= 20 OR gilded > 0 OR has_code_block`
- The metadata needed (score, num_comments, gilded) isn't currently passed into `assessSignificance`

**Complexity:** Moderate. Either add a community-mode path with metadata-based filtering (preferred -- leave existing path intact), or make the config accept a custom filter function. Thread metadata would need to flow through the input adapter into the gate. ~0.5 days as PRD estimates.

---

### 5. Behavioral Feedback (`packages/daemon/src/pipeline/aspect-feedback.ts`)

**What exists:**
- `applyFtsOverlapFeedback()` -- FTS hit count drives aspect weight deltas
- `decayAspectWeights()` -- time-based decay on stale aspects
- `shouldRunSessionDecay()` -- session-interval throttling
- Config: `{ delta, maxWeight, minWeight }` and `{ decayRate, minWeight, staleDays }`

**Gaps for community processing:**
- FTS overlap as feedback signal doesn't apply to batch Reddit processing (no live search sessions)
- No karma-based feedback path: PRD maps `score >= 50 -> +full delta`, `score >= 10 -> +half delta`, `score < 0 -> -delta`, `gilded -> +1.5x delta`
- No mechanism to inject score/karma at the time of attribute creation
- The `applyFtsOverlapFeedback()` function reads `session_memories` table -- won't exist for batch-processed threads

**Complexity:** Moderate. Add `applyKarmaFeedback(accessor, memoryId, score, gilded, agentId, config)` as a parallel function. Existing FTS feedback path stays for live use. Karma path called from batch pipeline after each thread. ~1-2 days.

---

### 6. Dampening (`packages/daemon/src/pipeline/dampening.ts`)

**What exists:**
- Three stages: gravity, hub, resolution
- Hub dampening uses P90 global threshold from entity mention counts
- Gravity penalizes vector results with zero query-term overlap
- Resolution boosts `constraint` and `decision` types, temporal anchors
- `DampeningConfig` is a flat struct -- no scope or per-entity-type thresholds

**Gaps for community processing:**
- Hub dampening with P90 global threshold breaks when one subreddit mentions "Python" 10,000 times -- "Python" would always be a hub and always get penalized
- No per-entity-type scope thresholds: community-normal high-frequency terms need to be exempted
- No community-specific stop-word lists (e.g. "meta" in r/facebook vs r/gaming)
- No `community_norm` or `expert_consensus` multipliers in resolution boost
- `DampeningConfig` has no `scope` field; hub threshold is computed globally across all entities

**Complexity:** Moderate. Add scope-aware hub threshold (per-agent or per-entity-type normalization instead of global P90). Add community stop-word config. Add community multiplier fields to resolution stage. ~1-2 days.

---

### 7. Prospective Indexing (`packages/daemon/src/pipeline/prospective-index.ts`)

**What exists:**
- `buildPrompt(content, max)` generates "what would a user search for?" hints
- Prompt: "Generate N diverse questions or cues a user might use in the future when this fact would be helpful"
- `generateHints(provider, content, cfg)` is called from a job queue worker
- No agentId-based prompt dispatch

**Gaps for community processing:**
- Prompt is individual-memory-oriented ("a user might use"), not community-FAQ-oriented
- PRD wants community agent prompt: "what questions would someone ask about this community?"
- No mechanism to select prompt by agentId prefix
- The FAQ layer is conceptually useful as a community onboarding surface -- the job queue infrastructure already exists

**Complexity:** Trivial. Add profile-based prompt dispatch in `buildPrompt`. Pass agentId into `generateHints` and select prompt based on `community:` prefix. ~0.5 days.

---

### 8. Summarization (`packages/daemon/src/pipeline/summary-worker.ts` + `summary-condensation.ts`)

**What exists in `summary-condensation.ts`:**
- Two-tier hierarchy: `session` -> `arc` (threshold: 8 sessions) -> `epoch` (threshold: 4 arcs)
- `CondensationConfig { arcThreshold, epochThreshold }`
- `checkAndCondense()` checks uncondensed `session` summaries and uncondensed `arc` summaries
- `kind` field in `session_summaries` table distinguishes `session`, `arc`, `epoch`

**What exists in `summary-worker.ts`:**
- Transcript chunking at `CHUNK_TARGET_CHARS = 20,000` chars
- Each chunk summarized independently, then combined

**Gaps for community processing:**
- No `yearly` condensation tier -- PRD wants thread -> daily -> weekly -> monthly -> yearly hierarchy
- Arc threshold of 8 is arbitrary for session-based data; daily/weekly boundaries need temporal triggers not count-based triggers
- `checkAndCondense()` groups by `project` not by temporal boundary -- daily/weekly grouping needs date-range queries
- `CondensationConfig` doesn't expose a third tier (year)
- Arc/epoch thresholds need to be dramatically higher for community volume (thousands of threads per day)

**Complexity:** Significant. Adding yearly tier is a schema change (new `kind` value) plus a new condensation pass. More importantly, pivoting from count-based to temporal-boundary triggers requires restructuring `checkAndCondense()`. ~1 day for yearly tier alone, but temporal boundary logic is more.

---

### 9. Supersession (`packages/daemon/src/pipeline/supersession.ts`)

**What exists:**
- `detectAttributeContradiction()` -- four-signal heuristic (negation, antonyms, value conflict, temporal markers)
- `checkAndSupersedeForAttributes()` -- inline pass after structural classify
- `sweepRetroactiveSupersession()` -- periodic sweep across all aspects
- Shadow mode support via `cfg.shadowMode || cfg.mutationsFrozen`
- Semantic fallback via `detectSemanticContradiction()`
- No awareness of `divergence` vs `supersession` distinction

**Gaps for community processing:**
- The heuristic `detectAttributeContradiction()` will treat all contradictions as supersession candidates -- no divergence path
- Community disagreements (parallel positions held by different users/groups) should create parallel attributes, not mark one as superseded
- The sweep processes `agentId`-scoped aspects -- but community agent scope (`community:r/ollama`) works with existing `agentId` isolation
- No bulk/batch mode: inline pass runs per-attribute, which is fine; sweep runs per-agentId, which is fine
- The result type `SupersessionResult` doesn't distinguish what type of conflict was detected

**Complexity:** Moderate. Supersession infrastructure is solid. Main work is integrating the contradiction type classification from component 3, then branching: divergence creates parallel attributes (new behavior), supersession marks old as superseded (existing behavior). ~included in contradiction work.

---

### 10. Graph Persistence (`packages/daemon/src/pipeline/graph-transactions.ts`)

**What exists:**
- `txPersistEntities()` -- upserts entity triples, increments mention counts
- `upsertRelation()` -- running average confidence on `relations.confidence`
- `txPersistStructured()` -- writes aspects + attributes in one transaction
- Mention counting works naturally: same entity seen in 1000 threads = 1000 increments

**Gaps for community processing:**
- `confidence` field on relations uses running average of extraction confidence -- not wired to karma/community validation score
- No `karma_weight` or `community_score` field on entity_attributes
- Entity upsert ignores source metadata entirely -- the karma signal from the input transcript isn't passed through to the persistence layer
- `txPersistEntities` has no params for community metadata; adding karma wiring requires threaded metadata down from extraction

**Complexity:** Moderate. The natural mention-counting and running-average confidence already do 80% of what PRD needs. The remaining gap is threading karma scores from the input adapter through extraction, decision, and into the attribute `importance` or a new `community_score` field. ~0.5 days for existing field wiring; more if a schema change is needed.

---

### 11. Batch Processing Infrastructure

**What exists:**
- Job queue pattern: `memory_jobs` table with `status`, `attempts`, `leased_at` -- used by prospective-index, structural-classify workers
- Worker loop pattern: poll -> lease -> process -> complete/fail with exponential backoff
- `summary_jobs` table for transcript summarization
- Session checkpoint infrastructure (`session-checkpoints.ts`)
- No bulk input adapter, no Pushshift decompression, no progress tracking across thousands of threads

**Gaps for community processing:**
- No batch orchestrator exists. This is the largest new-build component.
- No Pushshift JSONL decompressor / parser
- No chronological sort guarantee for thread ordering
- No per-community progress checkpointing (resume after interruption)
- No per-community parallelization (each community as independent worker)
- No LLM rate limiting / budget-aware throttle
- No temporal boundary tracking for summarization triggers (daily/weekly/monthly)
- The existing `memory_jobs` worker pattern is the right model to extend -- but the batch layer sits above it

**Complexity:** New-build. The job queue pattern and worker loop are reusable primitives. But the orchestrator, input adapter, progress checkpointing, and rate limiting are all new. ~3-4 days as PRD estimates, probably accurate.

---

### 12. Multi-Agent Scoping (`packages/daemon/src/agent-id.ts` + `packages/core/src/agents.ts`)

**What exists in `agent-id.ts`:**
- `resolveAgentId()` -- extracts agentId from body, session key parse (`agent:{id}:...`), fallback to `"default"`
- `getAgentScope()` -- reads `agents` table for `read_policy` and `policy_group`
- No community-specific parsing or validation

**What exists in `agents.ts`:**
- `discoverAgents()`, `scaffoldAgent()`, `getAgentIdentityFiles()`, `resolveAgentSkills()`
- Agent directory structure: `{agentsDir}/agents/{name}/`
- No concept of community agents or `community:` prefix semantics

**Gaps for community processing:**
- No `community:r/ollama` format recognition in `resolveAgentId()` -- but it would work as-is (arbitrary strings are accepted)
- No DB row pre-seeding for community agents: `getAgentScope()` returns `isolated` for unknown agents, which is probably right
- No tooling to scaffold 2-3 community agent directories
- The `isolated` read policy means community agents won't see each other's memories by default -- which is correct for phase 1
- Phase 2 cross-community linking would need `policy_group` support, which is already in the schema

**Complexity:** Trivial for phase 1. The existing agentId isolation works correctly for community: prefix out of the box. No code changes needed -- just use `community:r/subreddit` as the agentId. Phase 2 cross-community scoping uses the existing `policy_group` mechanism.

---

## Core Types Assessment (`packages/core/src/types.ts`)

| Type | Current State | Gap |
|------|--------------|-----|
| `DECISION_ACTIONS` | `["add", "update", "delete", "none"]` | Missing `"supersede"` and `"conflict"` |
| `DecisionAction` | Union of above | Needs expansion |
| `MEMORY_TYPES` | `["fact", "preference", "decision", "rationale", "daily-log", "episodic", "procedural", "semantic", "system"]` | No community-specific types needed (PRD explicitly says no new types) |
| `ENTITY_TYPES` | `["person", "project", "system", "tool", "concept", "skill", "task", "unknown"]` | No new types needed per PRD constraint |
| `SemanticContradictionResult` | `{ detected, confidence, reasoning }` | Needs `type: "supersession" | "divergence"` field |
| `CondensationConfig` | `{ arcThreshold, epochThreshold }` | Needs `yearThreshold` for yearly tier |

---

## Effort Summary

| Component | Status | Complexity | Notes |
|-----------|--------|------------|-------|
| Input Adapter | Does not exist | **New-build** | Pushshift JSONL -> pseudo-session format |
| Extraction profile | No profile support | **Moderate** | Refactor prompt dispatch, make limits config-driven |
| Significance gate | Exists, wrong signals | **Moderate** | Add community metadata filter path |
| Decision engine | Missing SUPERSEDE/CONFLICT | **Moderate** | Type system + prompt + validation changes |
| Contradiction classification | Binary only | **Moderate** | Add divergence type, update supersession branch |
| Dampening scope | Global P90 only | **Moderate** | Per-scope thresholds, community stop-words |
| Behavioral feedback (karma) | FTS-only | **Moderate** | Add karma feedback function |
| Prospective indexing (FAQ) | Single prompt | **Trivial** | Profile-based prompt dispatch |
| Summarization (yearly tier) | 2-tier only | **Significant** | Temporal boundary triggers + new tier |
| Supersession (divergence) | Supersession only | **Moderate** | Parallel attribute path (tied to contradiction) |
| Graph persistence (karma wiring) | Confidence averaging | **Moderate** | Thread karma through to importance/confidence |
| Batch orchestration | Does not exist | **New-build** | Largest new module |
| Multi-agent scoping | Fully functional | **Trivial** | Works as-is; community: prefix just works |

**Total new-build work:** Input adapter + batch orchestrator (~4-6 days)  
**Total modification work:** 8 moderate components + 1 significant (~10-15 days)  
**Total:** ~14-21 days, consistent with PRD estimate of 15-22 days

---

## Recommended Implementation Order

1. **Input Adapter** (new-build) -- nothing else can be tested without Reddit data flowing in
2. **Significance Gate** adaptation -- gate determines what runs through the pipeline
3. **Extraction profile** -- community data needs community prompt before meaningful extraction
4. **Decision Engine** -- SUPERSEDE/CONFLICT types needed before any graph quality is assessable
5. **Contradiction + Supersession** -- tied together, do concurrently
6. **Karma Feedback + Graph Persistence wiring** -- can share a sprint
7. **Dampening + Prospective FAQ** -- lower priority, tuning layer
8. **Summarization yearly tier** -- needed before multi-year Pushshift runs
9. **Batch Orchestration** -- the wrapper that drives everything at scale

---

*Generated from codebase audit of `/home/nicholai/signet/signetai/packages/` on 2026-03-27*
