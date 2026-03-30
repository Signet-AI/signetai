# Groundswell: Consolidated Spec

**Status:** Planning (consolidated from PRD, gap analyses, 5-agent debate, 7-agent lossless memory debate, and team corrections)  
**Last updated:** March 29, 2026  
**Authors:** Nicholai, Jake, Ant, Buba, Oogie  

---

## 1. What we're building

A universal data ingestion layer for Signet that takes structured conversation data from any source (Discord, Reddit, CRM, email) and feeds it through the existing distillation pipeline to build knowledge graphs. The pipeline stays mostly untouched. The work is in the adapters, the chunking, and a handful of targeted pipeline improvements.

The first target is Discord (via discrawl). Reddit communities (via Pushshift) follow after Discord validates the approach. CRM/email are phase 3+.

---

## 2. Final decisions (team consensus)

These were decided during the sessions and are not open for re-debate:

| Decision | Source | Rationale |
|---|---|---|
| **12K extraction limit is intentional, stays** | Nicholai | Controls prompt size and cost. Adapters chunk upstream to fit within it. Make the limit configurable per profile, don't remove it. |
| **Don't change the extraction model** | Nicholai | "Haiku is so much smarter than 4o. You will hit rate limits, it would be a lot of cost for very little improvement." |
| **Entity type taxonomy stays narrow** | Nicholai | "Too many types and you destroy heuristic queries." Use aspects for specificity, not new types. |
| **Existing chunking logic gets improved, not replaced** | Nicholai | "The existing chunking logic is not great, and it could easily be given a variable limit. It's better to tune the one we have than to make an entirely different one." |
| **Import must be observational, not purely analytical** | Nicholai | Distillation catches entity types naturally. Don't pre-define "comment" or "upvote" as types. |
| **Simpler is better** | Nicholai | "The simpler the system is the better. That is the key to maintainability. The simpler the primitives are, the more we can do with them." |
| **Adapter feeds into `enqueueSummaryJob()`** | All (Architect agent confirmed) | Single integration point. Zero modifications to downstream pipeline files. |
| **Conversation grouping before extraction** | All | Individual messages have zero context. Grouped conversations give the extractor full context, attribution, and reasoning. |
| **Speaker attribution is mandatory** | All | Format as `Speaker (timestamp): message`. 15-25% extraction quality improvement per research. |
| **Models stay private until team agrees** | Nicholai + Jake | No public release of trained models without consensus after testing. |
| **Start with 2-3 communities for Reddit validation** | Nicholai | "Two or three, just for validation." Not 100, not 10,000. |
| **Discord adapter ships first, everything else defers** | 7-agent debate verdict | Reddit, CRM, Gmail all wait until Discord validates the approach. |

---

## 3. What already exists (discovered during code review)

These are NOT new builds. They're already in the codebase:

| Component | Migration/File | What it does |
|---|---|---|
| `session_transcripts` table | Migration 040 | Stores raw transcripts with agent_id, session_key, project, harness |
| `session_transcripts_fts` | Migration 047 | FTS5 virtual table on transcripts with BM25, auto-sync triggers, snippet generation |
| `searchTranscriptFallback()` | hooks.ts | Queries transcript FTS during recall (currently fallback-only) |
| `memories_cold` | Migration 028 | Archives full JSON snapshots of memories before deletion. Lossless. |
| `memories_fts` | Migration 001 | FTS5 on extracted memories |
| `entities_fts` | Migration 035 | FTS5 on entity names |
| Multi-agent scoping | agent-id.ts, agents.ts | `community:r/ollama` as agentId works out of the box |
| `enqueueSummaryJob()` | summary-worker.ts | Entry point for async extraction. Adapters hook in here. |
| Significance gate | significance-gate.ts | Turn count, entity overlap, novelty filtering |
| Contradiction detection | contradiction.ts | Binary (detected: boolean). Syntactic + semantic paths. |
| Supersession | supersession.ts | Marks old attributes as superseded when new ones contradict |
| Dampening (hub/gravity/resolution) | dampening.ts | P90 global thresholds, stop-word lists, resolution boost |
| Knowledge graph persistence | graph-transactions.ts | Entity upsert by canonical name, scoped by agent_id |
| Summarization hierarchy | summary-worker.ts, summary-condensation.ts | Session -> arc (8 sessions) -> epoch (4 arcs) |

---

## 4. What needs to be built or changed

### Tier 1: Discord adapter (ship in 2-3 days)

**New code:**

- **discrawl adapter** — reads from discrawl's local SQLite, groups messages into conversations using gap-based segmentation (30-min silence = boundary), formats with speaker attribution and timestamps, chunks to fit within 12K, feeds into `enqueueSummaryJob()`.
- **message-level noise filter** — skip bot messages, emoji-only, slash commands, messages under 30 chars with no replies. Eliminates ~50% of input for free.
- **batch orchestrator** — chronological processing, progress checkpointing, resumability, rate limiting.

**Pipeline changes:**

- **Make 12K limit configurable per extraction profile** — boolean/number in extraction config. Normal sessions keep 12K. Community/Discord profiles can set their own. Change to extraction.ts.
- **Improve existing chunking** — add variable limit support and 3-message overlap at chunk boundaries. Tune, don't replace.

**Migration:**

- **Add `event_start` and `event_end` to `session_transcripts`** — adapter fills from first/last message timestamps per segment. Enables temporal range queries (`WHERE event_start >= ? AND event_end <= ?`).

**Estimated cost:** $8-15 per full Discord history run (local ollama for embedding, cloud for extraction).

### Tier 2: Pipeline improvements (after Discord validates)

**Promote transcript FTS from fallback to parallel:**

Currently `searchTranscriptFallback()` only fires when vector + temporal search return nothing. Change to fire in parallel and merge via reciprocal rank fusion (RRF). FTS wins on rare terms (BM25 IDF boosts unique content). Graph wins on structured relationships. Vector wins on semantic similarity. All three, every time.

**ADD/SUPERSEDE/CONFLICT decision model:**

Current `DECISION_ACTIONS` = `["add", "update", "delete", "none"]`. For multi-author data:
- **SUPERSEDE** — same entity, newer factual info replaces older (requires chronological processing)
- **CONFLICT** — legitimate disagreement. Creates parallel attributes on the same aspect with provenance. "60% say X, 40% say Y" coexists.

Requires coordinated change across `core/src/types.ts`, `decision.ts`, and the decision prompt. `DEPENDENCY_TYPES` already includes `contradicts` and `supersedes` in the graph layer, so partial support exists.

**Contradiction type classification:**

Evolve `detectSemanticContradiction` from `{ detected: boolean }` to `{ detected: boolean, type: "supersession" | "divergence" }`. Divergence creates parallel attributes instead of superseding.

**Community-mode dampening:**

- Hub dampening: per-entity-type scope-aware thresholds instead of global P90 (r/python mentioning "Python" 10,000 times isn't noise)
- Gravity dampening: per-community stop-word lists ("meta" = company in r/facebook, metagame in r/gaming)
- Resolution boost: expert_consensus multiplier for high-karma validated facts

### Tier 3: Reddit community graphs (after Discord + Tier 2)

- Pushshift archive ingestion (2005-2023, Academic Torrents)
- Community extraction profiles (different attention priorities than individual)
- Karma as behavioral feedback proxy (replaces FTS overlap for community data)
- Yearly summarization tier (thread -> daily -> weekly -> monthly -> yearly)
- Prospective indexing as community FAQ layer
- SSM training on traversal patterns across community KGs

### Tier 4: Universal connectors (after Reddit validates)

- CRM (GHL, Salesforce, HubSpot) — objects -> entities, associations -> dependencies, custom fields -> aspects
- Gmail — thread segmentation, relationship extraction
- GitHub — issues, PRs, discussions as conversation sources

---

## 5. Entity MD files

**Approved by 7-agent debate. Not blocking, but planned.**

Pre-computed graph traversals rendered as readable per-entity summaries:
- `people/nicholai.md` — everything the agent knows about Nicholai
- `projects/signet.md` — full project knowledge distilled from all sources

Auto-resynthesized when entities update. Read at session start for instant context assembly instead of graph walk.

---

## 6. Retrieval architecture (final)

Three-path retrieval, all firing in parallel on every query:

1. **Knowledge graph traversal** — walk entities, aspects, attributes, dependency edges. Deterministic, bounded.
2. **Vector search** — cosine similarity against pre-embedded memories. Catches semantic relationships the graph hasn't connected.
3. **FTS5 keyword search** — BM25 on both `memories_fts` AND `session_transcripts_fts`. Catches rare terms, niche details, things extraction missed. IDF naturally prioritizes unique content.

Results merged via reciprocal rank fusion (RRF). Post-fusion dampening (hub, gravity, resolution) cleans the output.

---

## 7. Spec index mapping

| Groundswell component | Existing spec | Status |
|---|---|---|
| Discord adapter + batch orchestration | `groundswell-batch-orchestrator.md` (planning) | Specced, needs approval |
| Community extraction profiles | `groundswell-extraction-profile.md` (planning) | Specced, needs approval |
| SUPERSEDE/CONFLICT model | `groundswell-decision-engine.md` (planning) | Specced, needs approval. Extends `retroactive-supersession` (approved) |
| Dampening adaptations | `desire-paths-epic` DP-16 (approved) | Needs extension for community mode |
| Transcript FTS parallel promotion | None | NEEDS NEW SPEC (micro-spec or addendum to desire-paths) |
| event_start/event_end migration | None | NEEDS MIGRATION SPEC |
| SSM training pipeline | `ssm-foundation-evaluation`, `ssm-temporal-backbone`, `ssm-graph-traversal-model` (all planning) | Partially covered. Existing specs cover deployment, not training from community data. |
| Lossless working memory | `lossless-working-memory-closure`, `lossless-working-memory-runtime` (approved) | Already implemented |
| Multi-agent support | `multi-agent-support` (approved) | Already implemented |
| Entity MD files | None | NEEDS NEW SPEC |
| Community knowledge graphs PRD | `community-knowledge-graphs.md` (planning) | Specced |
| Gap analysis (specs) | `groundswell-gap-analysis-specs.md` | Complete |
| Gap analysis (code) | `groundswell-gap-analysis-code.md` | Complete |

---

## 8. Build order

```
Phase 1: Discord (weeks 1-3)
├── discrawl adapter (gap segmentation, speaker attribution, noise filter)
├── batch orchestrator (chronological, checkpointed, resumable)
├── configurable extraction limit per profile
├── improve existing chunking (variable limit, overlap)
├── event_start/event_end migration
└── validate: does the pipeline produce useful knowledge from Discord data?

Phase 2: Pipeline hardening (weeks 4-5)
├── promote transcript FTS to parallel recall path
├── ADD/SUPERSEDE/CONFLICT decision model
├── contradiction type classification (supersession vs divergence)
├── community-mode dampening
└── entity MD files (people/, projects/)

Phase 3: Reddit community graphs (weeks 6-9)
├── Pushshift ingestion adapter
├── community extraction profiles
├── karma behavioral feedback
├── yearly summarization tier
├── validate on 2-3 pilot communities (r/ollama, r/selfhosted, r/LocalLLaMA)
└── SSM training on traversal patterns

Phase 4: Scale + product (weeks 10-12)
├── scale to 100 communities, then 10K
├── community intelligence API (B2B)
├── cold start integration into Signet predictor
└── universal connectors (CRM, email, GitHub)
```

---

## 9. Cost estimates

| Phase | Estimated cost |
|---|---|
| Discord adapter (Tier 1) | $8-15 per full history run |
| Discord adapter (Tier 2 with frontier segmentation) | $40-75 per run |
| Reddit pilot (2-3 communities) | $90-250 cloud, $20-50 local |
| Reddit 100 communities | $2-5K |
| Reddit 10K communities | $15-50K cloud, much less local |
| SSM training (A6000) | $1.69/hr, single GPU handles all |

---

## 10. Open questions

1. Who owns the discrawl adapter build?
2. What's the acceptance criteria for "good knowledge graph quality" after Discord import?
3. Should entity MD files auto-regenerate on every entity update or on a schedule?
4. For the FTS parallel promotion, what weight should transcript FTS get in RRF vs memory FTS vs vector?
5. Does the existing `policy_group` mechanism in the schema handle cross-community entity linking for phase 3, or do we need new tables?

---

*"the simpler the system is the better. the simpler the primitives are, the more we can do with them. we're close to perfect structure."*
