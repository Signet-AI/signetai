# Groundswell Spec Gap Analysis

**Status:** Planning  
**Date:** 2026-03-27  
**Scope:** Determine which pipeline components need new specs, existing spec changes, or are already covered for the community knowledge graphs project (codename: Groundswell).

---

## Classification Key

- **DONE** — implemented and working in current codebase
- **SPECCED** — has an approved or planning spec, not yet implemented
- **NEEDS CHANGES** — infrastructure exists but needs community-specific adaptation spec
- **NEEDS PLANNING** — no spec exists, needs new spec work

---

## Pipeline Area Analysis

### 1. Extraction Profiles / Attention Weighting

**Classification: NEEDS PLANNING**

The extraction infrastructure is done (memory-pipeline-v2, complete). However, the community extraction profile described in PRD section 5.3 is meaningfully different from the individual-agent prompt:

- New attention priorities: recurring problems, expert identification by upvote pattern, community norms as constraints, opinion evolution, disagreement topology, jargon
- Entity and fact limits need adjusting (MAX_ENTITIES 15->25-30, MAX_FACTS 20->40)
- Profile dispatch logic: `agentId` prefix `community:` routes to community profile
- Metadata embedding in transcript text (upvotes, karma, timestamps embedded so LLM observes them during extraction — not the current approach)

The closest existing coverage is the extraction stage in memory-pipeline-v2, but community profiles are a new configurable surface that doesn't exist in any current spec.

**Needs:** New spec `groundswell-extraction-profile` covering the community prompt, limit overrides, and profile dispatch by agentId prefix.

**Overlaps:** memory-pipeline-v2 (extraction stage), knowledge-architecture-schema (entity type taxonomy constraint).

---

### 2. Decision Engine (ADD/SUPERSEDE/CONFLICT)

**Classification: NEEDS CHANGES**

Current pipeline uses ADD/UPDATE/DELETE/SKIP. The PRD wants ADD/SUPERSEDE/CONFLICT/SKIP.

- **SUPERSEDE path** is specced in `retroactive-supersession` (planning status). It covers chronological supersession detection, attribute marking, audit trail, and shadow mode. This is directly applicable.
- **CONFLICT path** is new. It creates parallel attributes on the same aspect representing divergent community positions ("60% say X, 40% say Y") rather than resolving contradictions. This is NOT covered by retroactive-supersession.
- Karma-weighted override in SUPERSEDE decisions (high-karma facts override low-karma predecessors) is not in any current spec.
- `CANDIDATE_LIMIT` increase from 5 to 10-15 is a configuration change.

**Needs:** Extend `retroactive-supersession` spec to include the CONFLICT decision mode and community validation score wiring. OR create `groundswell-decision-engine` as a community-specific extension spec that depends on retroactive-supersession.

**Overlaps:** retroactive-supersession (planning), ontology-evolution-core (planning, covers confidence/provenance edges which inform SUPERSEDE).

---

### 3. Contradiction Detection (Divergence vs Supersession)

**Classification: NEEDS PLANNING**

Current pipeline has a two-pass contradiction check (syntactic negation/antonyms -> LLM semantic check) that treats contradictions as errors to resolve. The PRD adds a type classification layer:

- `supersession`: factual update, same entity, newer info replaces older -> existing retroactive-supersession path
- `divergence`: community genuinely disagrees -> creates parallel attributes, NOT resolved

The divergence classification is not covered by any existing spec. The closest is `ontology-evolution-core` (planning, covers temporal lineage and co-occurrence signals), but OEC doesn't spec parallel-attribute divergence storage or the LLM classification prompt changes.

Domain-aware antonym expansion (REST vs GraphQL = preference cluster, not contradiction) is also new.

**Needs:** New spec `groundswell-contradiction-classifier` covering: classification prompt changes, divergence storage model (parallel attributes tagged with community support + provenance), domain-aware antonym suppression, and integration with retroactive-supersession for the supersession path.

**Overlaps:** retroactive-supersession (planning), ontology-evolution-core (planning), knowledge-architecture-schema (entity_attributes for parallel attribute storage).

---

### 4. Significance Gating

**Classification: NEEDS CHANGES**

DP-1 (significance gate, zero-cost continuity) is COMPLETE. DP-19 (adaptive write gate, per-memory surprisal) is NOT STARTED.

The PRD replaces the current turn-count/entity-overlap/content-novelty gate with engagement metadata filtering:
- PASS if score >= 50 OR num_comments >= 20 OR gilded > 0 OR contains code blocks
- SKIP otherwise

This is a community-mode gate, not a replacement for the existing gate — existing sessions still use DP-1. The gate needs to dispatch on context (community vs. individual session).

DP-19 (adaptive surprisal) is related but different — it's about per-memory surprisal filtering post-extraction, not pre-extraction engagement gating.

**Needs:** Spec the community gate as a configurable gate mode (gateMode: 'engagement' | 'surprisal' | 'standard') selected by agentId prefix, extending DP-1 without breaking it. Can be folded into the broader `groundswell-extraction-profile` spec or treated as a small standalone spec.

**Overlaps:** desire-paths-epic DP-1 (complete), desire-paths-epic DP-19 (not started).

---

### 5. Behavioral Feedback

**Classification: NEEDS CHANGES**

KA-6 (behavioral feedback loop: FTS overlap -> aspect weights) is COMPLETE. The underlying mechanism exists.

The PRD maps karma directly to aspect weight deltas:
- Score >= 50: +full delta
- Score >= 10: +half delta
- Score < 0: -delta  
- Gilded/awarded: +1.5x delta

This is a new feedback source. The feedback infrastructure (aspect_weight updates, FTS overlap signals) is built, but karma as an input signal is not plumbed anywhere. It requires:
- Karma scores persisted alongside thread metadata during ingestion
- Behavioral feedback pass after every ~100 threads (batch mode, not session-end)
- Temporal decay still applies over chronological processing order

**Needs:** Spec the karma feedback extension as a community feedback mode. Likely folds into `groundswell-batch-orchestration` (section 11 below) with a sub-section on feedback scheduling.

**Overlaps:** knowledge-architecture-schema KA-6 (complete), desire-paths-epic DP-9 (path feedback, complete).

---

### 6. Dampening (Hub, Gravity, Resolution)

**Classification: NEEDS CHANGES**

DP-16 (post-fusion dampening: gravity, hub, resolution) is COMPLETE, implemented in `packages/daemon/src/pipeline/dampening.ts`.

The PRD wants three community-specific adaptations:

- **Hub dampening**: current P90 global threshold breaks on community topology (r/python mentions "Python" 10,000 times, not noise). Needs per-entity-type scope-aware thresholds.
- **Gravity dampening**: needs per-community stop-word lists. "meta" = company in r/facebook, metagame in r/gaming.
- **Resolution boost**: add community_norm and expert_consensus multipliers for high-karma expert agreement.

These are parametric extensions to the existing dampening module, not a rewrite. But they need to be specced to define the new config surface and how community identity flows into the dampening layer.

**Needs:** Extend DP-16 with a community dampening config extension spec (or fold into `groundswell-extraction-profile`). Define: scope-aware hub thresholds, per-community stop-word config, expert_consensus multiplier. Can be lightweight.

**Overlaps:** desire-paths-epic DP-16 (complete).

---

### 7. Prospective Indexing

**Classification: NEEDS CHANGES**

DP-6.1 (prospective indexing, hypothetical query hints at write time) is COMPLETE.

The PRD adaptation is simple: change the hint prompt for community agents from "what would this user search for?" to "what questions would someone ask about this community?" This turns prospective indexing into a pre-built FAQ surface per subreddit.

The infrastructure is there. Just needs profile dispatch on the hint prompt, same mechanism as the extraction profile change.

**Needs:** Minor spec note in `groundswell-extraction-profile` covering prospective indexing prompt override for community agents. Not a standalone spec.

**Overlaps:** desire-paths-epic DP-6.1 (complete).

---

### 8. Summarization Hierarchy

**Classification: NEEDS PLANNING**

Current hierarchy: Session -> arc (8 sessions) -> epoch (4 arcs)

PRD wants: Thread -> daily digest -> weekly arc -> monthly epoch -> yearly summary

The yearly condensation tier doesn't exist anywhere in the spec tree. The existing summarization is session-count-based; community summarization needs to be temporal-boundary-based (daily/weekly/monthly/yearly). For multi-year Pushshift data (2005-2023), this is a real architectural change.

No existing spec covers:
- Temporal boundary triggers (vs. session count triggers)
- Yearly condensation tier
- Threshold adjustments for community volume (a busy subreddit generates more sessions in a day than an individual agent does in a month)

**Needs:** New spec `groundswell-summarization-hierarchy` covering: temporal boundary trigger model, yearly tier schema, threshold calibration for community volume, integration with batch orchestration scheduling.

**Overlaps:** memory-pipeline-v2 (base summarization), session-continuity-protocol (checkpoint/continuity model).

---

### 9. Batch Processing / Batch Orchestration

**Classification: NEEDS PLANNING**

Nothing in the existing spec tree covers bulk processing. This is the largest new component. The PRD section 5.11 describes:

1. Pushshift decompression and filtering (zstandard JSONL -> filtered by subreddit)
2. Chronological sort guarantee per community
3. Input adapter (Pushshift thread -> pseudo-session format)
4. Progress checkpointing with resume-after-interruption
5. Per-community parallelization (each community = independent worker)
6. LLM rate limiting (budget-aware, configurable calls/minute)
7. Behavioral feedback runs after every ~100 threads
8. Summarization triggers at temporal boundaries
9. Embedding throughput management (local nomic-embed via ollama)

The Input Adapter (section 5.1) is also net-new. The sessionKey format (`reddit:r/ollama:thread:abc123`), agentId convention (`community:r/ollama`), and chunking strategy (highest-signal comments first by score) are all unspecced.

Multi-agent scoping is DONE (multi-agent-support complete) — each community as its own agentId is ready.

**Needs:** New spec `groundswell-batch-orchestration` covering the input adapter, orchestration loop, chronological guarantees, checkpointing, parallelism model, rate limiting, and scheduling integration with summarization and behavioral feedback.

This is the biggest single spec gap.

**Overlaps:** multi-agent-support (complete, agentId scoping foundation), memory-pipeline-v2 (pipeline entry points).

---

### 10. Cross-Community Entity Resolution

**Classification: NEEDS PLANNING**

Flagged as Phase 2 in the PRD. Nothing in the existing spec tree covers:

- Cross-community entity resolution by canonical name
- community_memberships table (user -> subreddit participation)
- co_participation scoring (subreddit overlap by shared users)
- Cross-community intelligence queries

The closest foundation is multi-agent-support's `visibility=global` memory sharing model, but cross-community entity resolution is a different problem — it's about merging knowledge about the same entity observed in different community graphs, not about sharing memories between agents.

**Needs:** New spec `groundswell-cross-community-resolution` for Phase 2. Not on the critical path for Phase 1. Dependencies: groundswell-batch-orchestration, multi-agent-support.

**Overlaps:** multi-agent-support (approved, global visibility foundation), ontology-evolution-core (planning, provenance tracking).

---

### 11. SSM Training Pipeline

**Classification: NEEDS PLANNING**

The existing SSM specs (ssm-foundation-evaluation, ssm-temporal-backbone, ssm-graph-traversal-model, engram-informed-predictor-track) are all in planning status, but they address a different problem: deploying an SSM for retrieval within Signet's existing single/multi-user agent graphs.

The Groundswell SSM training pipeline is about:
1. Building community knowledge graphs from Pushshift data
2. Using the graphs as a retrieval surface
3. Having LLMs score traversal quality (synthetic RLHF for graph navigation)
4. Using scored traversal patterns as SSM training signal
5. Evaluating transfer to individual agent graphs (cold start elimination)

None of the existing SSM specs cover training a model FROM community graphs or the synthetic RLHF loop described in PRD section 7. The existing specs are evaluation/benchmarking frameworks for deploying SSMs that already exist.

**Needs:** New spec `groundswell-ssm-training-pipeline` covering: synthetic retrieval scoring via LLM evaluator, training data format (traversal patterns through graphs, not raw text), model size targets, training loop, transfer validation approach. Should reference ssm-foundation-evaluation for benchmark infrastructure overlap.

**Overlaps:** ssm-foundation-evaluation (planning, benchmark infrastructure reusable), ssm-graph-traversal-model (planning, traversal path representation).

---

## What's Already Covered (No New Specs Needed)

These areas from the PRD work out of the box with existing implementations:

| PRD Area | What's Already There |
|---|---|
| Multi-agent scoping per community | multi-agent-support complete. `agentId = "community:r/ollama"` just works. |
| Graph persistence | KA-1 through KA-6 complete. Entity/aspect/attribute hierarchy ready. |
| Entity type taxonomy | KA invariant 3, no new types. Subreddit = "concept" entity, norm = "constraint" attribute. |
| Edge confidence | DP-2 complete. Wire karma into confidence fields during persistence. |
| Community detection (Louvain) | DP-5 complete. Natural fit for community topology analysis. |
| Traversal-primary retrieval | DP-6 complete. Handles community graphs as-is. |
| Constructed memories with provenance | DP-7 complete. |
| Co-occurrence edge strength | DP-9 complete. Mention counting builds edge strength naturally at volume. |
| Decision auto-protection (constraints) | DP-18 complete. Community norms captured as constraints surface automatically. |
| Constraint surfacing invariant | Cross-cutting invariant 5. Always on. |
| Per-memory significance gate (baseline) | DP-1 complete. Community gate extends it, not replaces it. |

---

## Spec Work Summary

| Area | Classification | New Spec | Extend Existing |
|---|---|---|---|
| Extraction profiles / attention weighting | NEEDS PLANNING | `groundswell-extraction-profile` | memory-pipeline-v2 |
| Decision engine ADD/SUPERSEDE/CONFLICT | NEEDS CHANGES | — | retroactive-supersession |
| Contradiction detection (divergence/supersession) | NEEDS PLANNING | `groundswell-contradiction-classifier` | retroactive-supersession |
| Significance gating (engagement mode) | NEEDS CHANGES | — | groundswell-extraction-profile (subfolder) |
| Behavioral feedback (karma) | NEEDS CHANGES | — | groundswell-batch-orchestration (section) |
| Dampening adaptations | NEEDS CHANGES | — | groundswell-extraction-profile OR DP-16 extension |
| Prospective indexing (FAQ mode) | NEEDS CHANGES | — | groundswell-extraction-profile (note) |
| Summarization hierarchy (yearly tier) | NEEDS PLANNING | `groundswell-summarization-hierarchy` | memory-pipeline-v2 |
| Batch processing / input adapter | NEEDS PLANNING | `groundswell-batch-orchestration` | multi-agent-support |
| Cross-community entity resolution | NEEDS PLANNING | `groundswell-cross-community-resolution` | multi-agent-support |
| SSM training pipeline | NEEDS PLANNING | `groundswell-ssm-training-pipeline` | ssm-foundation-evaluation |

---

## New Specs Required (5 total)

1. **`groundswell-extraction-profile`** — community extraction prompt, entity/fact limits, profile dispatch by agentId prefix, engagement-based significance gate, prospective FAQ hint, dampening config extension. Folds 4 "NEEDS CHANGES" items that are all about the extraction/ingestion surface.

2. **`groundswell-contradiction-classifier`** — divergence vs supersession classification, parallel attribute storage for divergent positions, domain-aware antonym suppression, integration with retroactive-supersession.

3. **`groundswell-summarization-hierarchy`** — temporal boundary triggers, yearly tier, threshold calibration for community volume, batch scheduling integration.

4. **`groundswell-batch-orchestration`** — input adapter (Pushshift JSONL -> pseudo-session), orchestration loop, chronological sort guarantee, progress checkpointing, per-community parallelism, LLM rate limiting, karma feedback scheduling, embedding throughput management.

5. **`groundswell-ssm-training-pipeline`** — synthetic RLHF loop (LLM-scored traversal), training data format (traversal patterns), model size targets, cold start transfer validation. Phase 3+ dependency.

### Existing Specs to Extend

- **`retroactive-supersession`** (planning) — add CONFLICT mode for community disagreements, karma-weighted override in SUPERSEDE decisions.
- **`desire-paths-epic`** (approved) — note DP-16 community dampening adaptations as a community-mode extension (scope-aware hub thresholds, per-community stop-words, expert_consensus multiplier).

---

## Phase-Aligned Execution Order

**Phase 1 (Weeks 1-3, 2-3 communities):**
- `groundswell-extraction-profile` — highest priority, gates everything
- `groundswell-contradiction-classifier` — needed for SUPERSEDE/CONFLICT model
- Extend `retroactive-supersession` for CONFLICT mode
- `groundswell-batch-orchestration` — needed to process Pushshift at all
- `groundswell-summarization-hierarchy` — needed for multi-year data

**Phase 2 (Weeks 4-6, 100 communities):**
- `groundswell-cross-community-resolution`

**Phase 3+ (SSM training):**
- `groundswell-ssm-training-pipeline`

---

*Generated by gap analysis subagent, 2026-03-27. Based on INDEX.md, dependencies.yaml, and community-knowledge-graphs.md PRD.*
