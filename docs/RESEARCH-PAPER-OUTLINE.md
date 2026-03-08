---
title: "Research Paper Outline"
description: "Skeleton for the Signet knowledge architecture paper."
status: "collecting-data"
target-venue: "EMNLP 2026 or NeurIPS workshop"
---

# Structured Traversal Over Knowledge Graphs as a Retrieval Floor for LLM Agent Memory

*Working title — refine after results are in.*

---

## Abstract (write last)

One paragraph. Core claim: structural traversal over an entity-aspect
graph provides a deterministic retrieval floor that probabilistic
embedding search cannot guarantee. Learned scoring over structurally
coherent candidates outperforms learned scoring over flat candidate
pools. Results on N sessions across M entities with NDCG@10 comparison.

---

## 1. Introduction

### Problem statement

Current LLM agent memory systems retrieve knowledge via embedding
similarity — encode the query, encode the memories, rank by cosine
distance. This is probabilistically strong but structurally blind: it
finds things that *sound* related, not things that are *structurally
required*.

A constraint ("never push directly to main") may not be semantically
similar to a query about deployment, but it is structurally required
whenever the deployment entity is in scope. Embedding search misses
this. Structural traversal does not.

### What we propose

A knowledge architecture where:
1. Facts are organized into entities, aspects, attributes, and
   constraints (not a flat memory store)
2. Primary retrieval is graph traversal — identify focal entities,
   walk their structure, collect candidates deterministically
3. Embedding search is the fallback for discovery, not the primary path
4. A learned scorer operates on the structurally coherent candidate
   pool, not a flat bag of facts
5. Behavioral feedback (FTS overlap, aspect decay, entity pinning)
   reshapes the graph over time

### Why this matters

- Deterministic retrieval floor (no probabilistic misses for
  structural requirements)
- Bounded context loading (cost is known before traversal starts)
- Constraints as a hard retrieval invariant (never suppressed by
  ranking)
- Database that gets smaller and smarter over time (refinement, not
  accumulation)

---

## 2. Related Work

### 2.1 LLM memory systems

- MemGPT / Letta — paging-based memory management
- Mem0 — embedding-first retrieval with user/session scoping
- Zep — temporal knowledge graphs + embedding search
- LangChain memory modules — buffer, summary, entity memory
- Reflexion — self-reflection for task improvement

**Key differentiator:** All of the above use embedding similarity as
the primary retrieval path. None organize knowledge into a structural
hierarchy with deterministic traversal.

### 2.2 Knowledge graphs for LLMs

- GraphRAG (Microsoft) — community summaries from text-extracted graphs
- KAPING — knowledge graph augmented generation
- KnowledGPT — knowledge graph integration for LLM prompting

**Key differentiator:** These extract graphs from documents for
one-shot retrieval. Signet's graph is persistent, evolving, and the
primary retrieval mechanism — not an augmentation layer.

### 2.3 Retrieval-augmented generation

- Standard RAG (chunk + embed + retrieve)
- HyDE — hypothetical document embeddings
- Reranking (cross-encoder, reciprocal rank fusion)

**Key differentiator:** RAG assumes a flat document store. Our
contribution is showing that organizing the store structurally
before retrieval produces better candidates for any downstream
ranking.

*TODO: Full literature review once we're writing. Keep this section
updated as we find papers during development.*

---

## 3. Architecture

### 3.1 Knowledge graph schema

Entity → Aspect → Attribute/Constraint hierarchy. Dependency edges.
Entity types (person, project, system, tool, concept, skill, task).

**Figure 1:** Schema diagram showing entity-aspect-attribute structure
with dependency edges. Use the existing ASCII art from
KNOWLEDGE-ARCHITECTURE.md as a starting point, formalize for the paper.

### 3.2 Knowledge lifecycle

Sparse facts → observational facts → atomic facts → procedural memory.
The extraction pipeline as a refinery. The "smaller and smarter"
property.

**Data point needed:** Measure database size over time during active
use vs idle refinement periods. Show the compression curve.

### 3.3 Structural assignment pipeline

Two-pass assignment: entity resolution → aspect/attribute classification.
How raw memories get organized into the graph.

### 3.4 Traversal retrieval

The walk: identify focal entities → load aspects (by weight) →
collect attributes → follow dependency edges → collect constraints.
Bounded, deterministic, no embedding calls.

**Figure 2:** Traversal diagram showing the walk from focal entity
through aspects to attributes, with dependency expansion.

### 3.5 Constraint surfacing invariant

Constraints always surface when their entity is in scope. Not ranked,
not suppressible. The hard retrieval guarantee.

### 3.6 Candidate pool composition

`traversal pool ∪ effectiveScore top-K ∪ embedding top-K`. The
structural floor plus the probabilistic ceiling.

---

## 4. Exploration and Feedback

### 4.1 The exploitation/exploration problem

Systems that only refine known knowledge become fossils. The need
for a mechanism to front-load importance before evidence accumulates.

### 4.2 Entity pinning (weight override)

Manual exploration mechanism. Pin = bet that matters before evidence.
Unpin = stop betting. Training data for the learned predictor.

### 4.3 Behavioral feedback loop

FTS overlap → aspect weight adjustment. The system learns which
structural bets paid off. Without feedback, structural weights
stagnate and diverge from user needs.

### 4.4 Aspect weight decay

Passive decay on stale aspects. Ensures the graph reflects current
reality, not historical accumulation.

### 4.5 Constraint confidence

Constraint density as a confidence signal. Entities with rich
constraint sets → agent acts more autonomously. Sparse constraints →
agent proceeds cautiously.

---

## 5. Evaluation

### 5.1 Experimental setup

- System: Signet daemon with KA-1 through KA-6 active
- Users: real usage data (anonymized) across multiple projects
- Sessions: N total sessions, M unique entities, P unique projects
- Comparison framework: KA-4 predictor comparison pipeline

**Data collection requirements:**
- [ ] Minimum 4 weeks of real usage data post-KA-6
- [ ] At least 3 distinct projects with different entity graphs
- [ ] Minimum 100 sessions with traversal + comparison data
- [ ] FTS overlap feedback running for at least 2 weeks

### 5.2 Metrics

**Primary:** NDCG@10 — normalized discounted cumulative gain for
memory retrieval ranking, scored against continuity labels.

**Secondary:**
- Constraint recall — % of relevant constraints surfaced
- Traversal coverage — % of memories with structural assignment
- Retrieval latency — traversal time vs embedding search time
- Context budget utilization — tokens used vs tokens available

### 5.3 Baselines

1. **Embedding-only:** Pure vector similarity search (current industry
   standard)
2. **Heuristic scoring:** effectiveScore() without structural features
   (Signet's pre-KA baseline)
3. **Traversal-only:** Graph walk without learned scoring
4. **Full system:** Traversal + learned scoring + feedback

### 5.4 Ablation studies

- Traversal without constraints → measure constraint recall drop
- Traversal without dependency expansion → measure coverage drop
- Feedback without decay → measure weight stagnation
- Pinning disabled → measure exploration gap

### 5.5 Per-entity and per-project analysis

The comparison pipeline slices by entity and project. Report:
- Per-entity win rates (traversal+scorer vs heuristic)
- Per-project retrieval quality variance
- Entity health trends over time
- Pinned vs unpinned entity retrieval quality

**Data point needed:** Show that per-entity slicing reveals patterns
that global averages hide. Some entities benefit enormously from
structural retrieval while others see little difference — that's
expected and interesting.

---

## 6. Results

*To be filled after data collection period.*

### 6.1 Overall retrieval quality (NDCG@10)

Table: baseline comparisons across all four conditions.

### 6.2 Constraint surfacing

Table: constraint recall by condition. Expect 100% for traversal
conditions, <100% for embedding-only.

### 6.3 Database compression

Graph: memory count over time showing the "smaller and smarter"
refinement curve.

### 6.4 Feedback effects

Graph: aspect weight distribution before and after FTS feedback.
Show that weights shift toward user-confirmed aspects.

### 6.5 Exploration mechanism

Analysis of pinned entities: how many were manually pinned, how
many did the predictor learn to prioritize, what was the win rate
difference.

---

## 7. Discussion

### 7.1 When traversal wins

Structured domains with clear entity relationships. Projects with
constraints. Returning to familiar entities after absence.

### 7.2 When embedding wins

Discovery of connections the graph hasn't mapped yet. Novel queries
that don't match known entity structure. Early sessions before the
graph has density.

### 7.3 The complementary argument

Not traversal OR embedding — traversal AND embedding, with traversal
as the floor and embedding as discovery. The candidate pool composition
is the key insight.

### 7.4 Limitations

- Single-user evaluation (not multi-user study)
- SQLite-based (scalability not tested)
- English-only entity resolution
- Structural assignment quality depends on LLM extraction accuracy

---

## 8. Conclusion

Structural organization of agent memory into an entity-aspect-attribute
hierarchy with deterministic traversal provides a retrieval floor that
probabilistic embedding search cannot match. Learned scoring over
structurally coherent candidates outperforms scoring over flat pools.
Behavioral feedback keeps the structure aligned with user needs.

The contribution is not a better embedding model or a better ranker.
It is the argument — backed by empirical results — that organizing
the memory store structurally before retrieval is more important than
improving the retrieval algorithm itself.

---

## Data Collection Checklist

Track these as KA-6 ships and the system runs:

- [ ] Total sessions with traversal active
- [ ] Total predictor comparisons recorded
- [ ] Per-entity comparison distribution (need breadth)
- [ ] Per-project comparison distribution
- [ ] FTS overlap events recorded
- [ ] Aspect weight changes from feedback
- [ ] Aspect weight changes from decay
- [ ] Entity pin/unpin events
- [ ] Database size over time (memory count snapshots)
- [ ] Traversal latency distribution
- [ ] Constraint surfacing rate
- [ ] Structural coverage percentage over time

---

## Timeline

1. **Now:** Outline complete. Collecting data points as we build.
2. **KA-6 ships:** Feedback loop active. Start accumulating real data.
3. **+4 weeks:** Minimum viable dataset. Preliminary analysis.
4. **+6 weeks:** Full analysis. Draft paper.
5. **+8 weeks:** Revisions, figures, submission prep.

---

*This is a living document. Update as architecture evolves and data
accumulates. The paper is written when the numbers are ready, not
before.*
