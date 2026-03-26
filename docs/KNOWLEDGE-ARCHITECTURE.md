---
title: "Knowledge Architecture"
description: "How Signet turns experience into understanding."
order: 2
section: "Core Concepts"
---

Knowledge Architecture
======================

This document describes Signet's structural memory substrate.

That distinction matters. Signet is not novel because it has a knowledge
graph, structured facts, or graph traversal. Those are implementation
primitives. They exist here to support the real job: building a bounded,
useful candidate pool for context selection.

The difference between a [[memory]] system and an intelligent one is not
just that it stores structure. It is that the structure is organized in
a way that makes later context selection more useful — findable at the
right moment, connected to the right things, and trimmed of everything
that does not serve the goal.

Signet's knowledge architecture is built around one question:

**What is the minimum amount of knowledge the agent needs to act correctly
right now?**

Everything else — how facts are stored, how they're connected, how the
database evolves over time — is in service of answering that question as
efficiently as possible.


The Knowledge Lifecycle
-----------------------

Knowledge doesn't arrive structured. It arrives messy.

A session produces hundreds of observations. A document produces thousands
of sentences. The agent encounters facts in passing, half-formed, buried in
context. None of it is immediately useful in the form it arrives.

The extraction [[pipeline]] is the refinery. Over time, continuously and in the
background, it takes raw material and distills it:

```
sparse facts
    ↓
observational facts
    ↓
atomic facts  ←—— the target form
    ↓
procedural memory
```

**Sparse facts** are the raw input — unprocessed, high volume, low signal.
Things the agent heard or saw but hasn't evaluated yet.

**Observational facts** are extracted and validated, but not yet grounded.
The agent knows them, but they haven't been connected to anything yet.

**Atomic facts** are the goal. A well-formed atomic fact stands alone. It
names what it's about, captures the relationship, and carries enough context
to be useful in isolation — without the session that produced it, without
the document it came from.

**Procedural memory** is knowledge about how to do things. Workflows, rules,
repeatable processes. These live slightly differently from facts — they're
closer to skills than statements.

The pipeline never stops running. It processes asynchronously, in the
background, while the agent is idle or active. The result: a database that
gets *smaller and smarter over time*, not larger and noisier.

A heavy week of sessions might balloon the database to 7,000 memories. Leave
it alone for two weeks. Come back to find 1,000 — but those 1,000 are dense,
properly connected, constraint-aware, and organized around the things that
actually matter. The noise has been refined away. What remains is structure.


Entities
--------

Everything in the database is either an entity, or it belongs to one.

An entity is anything that can be identified — a person, a project, a
system, a tool, a concept. Entities are persistent. They accumulate
knowledge over time. They never expire. They are the organizing scope of
the entire knowledge graph.

`nicholai` is an entity. `ooIDE` is an entity. `WorkOS` is an entity.
Their relationships to each other — that nicholai works on ooIDE, that
ooIDE uses WorkOS for auth — are not separate facts floating loose in the
database. They are *properties of those entities*, organized under the
dimensions that make them intelligible.

Entity weight reflects how central an entity is to the user's world. It's
partly structural — an entity with twelve aspects and forty attributes is
more important than one with two — and partly learned, built from how often
the entity appears in sessions and how useful its knowledge proves to be.
Both signals matter. Frequency is real signal. But frequency alone misses
the contextual dimension: some entities are universally important, others
only matter for certain kinds of work.

**Entity dependencies carry confidence signals:**

Every dependency edge (`uses`, `requires`, `owned_by`, `blocks`, `informs`) carries two
quality signals:

- **Strength** (0-1): How *important* is this dependency? Higher = more structurally critical.
- **Confidence** (0-1): How *certain* are we that this dependency exists? Higher = more trustworthy.

A dependency extracted once by an LLM from an ambiguous mention might have
`strength: 0.8` (important if real) but `confidence: 0.3` (uncertain extraction).
A dependency explicitly stated by the user has `confidence: 1.0`.

This separation matters for traversal. The predictor can route along high-confidence
edges immediately, while low-confidence edges become exploration targets — speculative
paths that might pay off but need validation. Feedback from sessions upgrades or
downgrades confidence over time, reshaping which edges the system trusts.

See [GitNexus Pattern Analysis](./RESEARCH-GITNEXUS-PATTERNS.md#pattern-2-confidence--reason-on-every-dependency-edge) for implementation details.


Aspects, Attributes, and Constraints
-------------------------------------

If entities are the *what*, aspects are the *what you need to know about it*.

An aspect is a named dimension of an entity. `ooIDE` has an auth aspect,
a build pipeline aspect, a data model aspect. `nicholai` has a technical
preferences aspect, a decision-making aspect, a communication style aspect.
Aspects don't store facts — they organize them.

Attributes are the facts organized under aspects. "ooIDE uses WorkOS for
auth" is an attribute of the auth aspect of ooIDE. "Bun is the package
manager" is an attribute of the build pipeline aspect. Attributes are atomic
facts. They have a home.

Constraints are attributes that are non-negotiable. They gate action
regardless of anything else. "Never push directly to main" is a constraint
on ooIDE's development aspect. When the agent is about to do anything
involving ooIDE's codebase, that constraint surfaces — not because it ranked
highly in a similarity search, but because constraints always surface.
That's the rule.

```
entity: ooIDE
  ├── aspect: auth system
  │     ├── attribute: uses WorkOS for authentication
  │     ├── attribute: WorkOS dashboard at [url]
  │     └── constraint: never store auth tokens in client code
  ├── aspect: build pipeline
  │     ├── attribute: bun is the package manager
  │     ├── attribute: `bun run dev` starts frontend and backend
  │     └── constraint: run typecheck before committing
  └── aspect: team
        ├── attribute: nicholai is the primary developer
        └── dependency → nicholai [entity]
```

The dependency on `nicholai` is not a semantic link inferred from word
similarity. It is an explicit structural edge. When reasoning about ooIDE,
the agent can follow that edge and make nicholai's relevant aspects
available. This is one of the ways the graph helps shape a bounded candidate
pool before flatter retrieval layers or learned ranking take over.


Tasks
-----

Tasks behave like entities in structure but not in lifecycle.

A task can have aspects, dependencies, and relationships. "Deploy the new
auth flow" can depend on the ooIDE entity, reference the auth aspect, and
require nicholai's approval. The vocabulary is the same.

But tasks are built to expire. They complete, they get cancelled, they age
out. They don't accumulate weight over time. When a task is done, it's done —
it gets retained briefly for context, then released. It doesn't persist the
way entities do.

This distinction matters because conflating the two would mean completed
tasks accumulating importance scores forever, cluttering the graph with
finished work. Entities grow. Tasks close.


Traversal as Candidate Shaping
------------------------------

The fundamental retrieval shift in this architecture is from *flat
search only* to *structure-aware candidate shaping*.

Current memory systems find relevant knowledge by asking: what is
semantically similar to this query? They embed the query, embed the
memories, compute cosine distances, retrieve the closest matches. This
works. It's also expensive, probabilistic, and structurally blind — it
finds things that *sound related*, not things that *are structurally
required*.

In Signet's knowledge architecture, session-start can ask a different
question: what entity is this session about? Walk its aspects. Pull its
attributes and constraints. Follow its dependencies. You now have a
bounded, structurally coherent candidate pool — without scoring 4,000
flat memories first.

The predictive scorer still runs on top of this. It learns which aspects
matter most for which kinds of sessions, which attributes to prioritize,
which dependencies are worth following. It adds the learned intelligence
layer. But it operates on a candidate pool that's already structurally
coherent — not a flat bag of facts.

This is also where negative evidence matters. The system should not only
reinforce what gets reused. It should learn from regret: if injected
context repeatedly fails to help, its influence should decay rather than
become permanent residue in the window.

That is the value of the graph here. The floor is better because the
candidate pool is cleaner. The ceiling is higher because the predictor
has better structure to learn over.


Constraint Confidence
---------------------

Constraints don't just gate action — they tell the agent how much it
knows about an entity.

An entity with a rich constraint set is one the agent understands well.
It knows what's allowed, what's forbidden, what requires care. It can
move confidently. An entity with no constraints is one the agent has
barely met — it should slow down, assume less, and verify more.

This is an internal signal, not a user-facing one. The agent uses
constraint density to calibrate how autonomously it acts on a given
entity. The user never manages it, configures it, or even sees it
directly. It's just behavior: the agent is more cautious around
unfamiliar entities, more decisive around well-mapped ones.

In the [[dashboard|constellation view]], this manifests as node brightness.
Entities with dense constraint graphs are luminous. New entities are dim.
The visual tells you, at a glance, where the agent is operating on solid
ground.


Context Is Bounded by Design
-----------------------------

One of the structural advantages of this architecture is that context
loading is deterministic.

When the agent identifies which entities are active in a session, it
loads their graphs: aspects, attributes, constraints, and first-degree
dependencies. The cost is known before it starts. The result is
bounded. There are no threshold knobs to tune, no candidate pools to
score — just a walk through a finite, pre-organized structure.

This is the practical case for the entity graph over pure embedding
search. Embedding search scales with database size. It's probabilistic.
It can miss structurally critical facts that don't happen to *sound*
similar to the query. The graph walk helps recover what is structurally
required before learned ranking and flat retrieval finish the job.

Embedding search still has a role — it's how the agent discovers things
the graph hasn't connected yet. But it's the fallback, not the primary
path. The graph walk loads the known context. Search fills the gaps.


Constraints Evolve Without Your Help
--------------------------------------

Constraints are the most stable part of the knowledge graph, but they
aren't frozen.

The system observes how constraints interact with reality over time.
If a constraint is consistently relevant — the agent encounters it,
respects it, acts accordingly — it stays exactly as it is. If a
constraint is consistently contradicted by the user's actual behavior,
its effective weight decays. Not to zero. Constraints have a floor.
But a constraint that no longer reflects how someone actually works
gradually loses the urgency it once had.

The user doesn't manage this. There are no review prompts, no
"this constraint hasn't been used in 30 days" notifications, no
settings panel for constraint lifecycle. The system observes. The
system adapts. If the user says something that explicitly supersedes
a constraint, the agent updates it in the moment — as a natural part
of the conversation, not as a maintenance task.

This is the broader principle: the memory system is set and forget.
The user talks to the agent. The agent handles everything else.
Constraints, weights, entity graphs, decay rates — none of that is
the user's job. The user's job is to work. The system's job is to
remember, organize, and get out of the way.


How the Pipeline Builds This
-----------------------------

The extraction pipeline runs continuously in the background. Its job is
not just to extract facts from raw input — it's to identify the entity
each fact belongs to, assign it to the right aspect, flag constraints, and
establish dependencies.

Over time, this process back-propagates through the existing database.
Legacy memories get entity assignments. Orphaned facts get organized.
Duplicate attributes get collapsed. The graph gets denser and more
connected as the pipeline processes what's already there.

The visual effect is striking: a database that balloons during heavy use
shrinks and crystallizes during idle time. The knowledge becomes *more
organized* the longer the system runs — not less.

And in the constellation view, this becomes visible. Instead of clouds of
semantically similar memories, you see entities with distinct structure —
aspects radiating out, attributes attached to those aspects, dependencies
connecting entities to each other. The difference between a person and an
aspect of a person. The difference between an attribute and a constraint.
The actual shape of what the agent knows.


Love, Hate, and the Exploration Problem
-----------------------------------------

Everything described above is exploitation. The system refines what it
already knows. It walks known structure, surfaces known constraints,
decays what isn't confirmed. It gets better at navigating a map it has
already drawn.

But maps go stale. The world moves. New entities appear that deserve
attention before the evidence accumulates. The system needs a mechanism
to bet on something mattering before it can prove it — to front-load
importance on an entity and then watch whether that bet pays off.

That mechanism is weight override. A user (or eventually, the predictor
itself) can pin an entity as focal, ensuring it is always traversed
regardless of project path or query matching. This is a pre-commitment:
"this matters to me, explore it." In graph terms, it creates an entity
with high starting weight before the density, the behavioral signals,
or the structural assignment has any reason to justify it.

This is the exploration mechanism. Without it, the system only maps
what it has evidence is worth mapping. With it, the system maps the
unknown because something in there matters to the user even before
they know what they will find.

The dangerous side is real. Weight override at maximum is love — an
unconditional bet that can build enormous infrastructure around an
entity that turns out to be wrong. The most catastrophic load-bearing
failures in any knowledge system come from betting too hard on the
wrong entity. Weight override at minimum is hate — "stop surfacing
this, it is wrong, it does not serve me." Both forces reshape the
graph. Both are necessary. Love creates new territory. Hate prunes
what doesn't belong.

In many ways, the predictive memory scorer is the automated form of
this same force. The heuristic pipeline (effective scores, structural
density, traversal) seeds the database and provides baseline
performance. The predictor learns patterns the heuristics can't see —
it assigns weight to memories before the pipeline can justify it.
When the predictor outperforms the baseline, it is making the same
bet that weight override makes manually: "this matters, even though
the evidence isn't there yet."

The manual pin and the learned prediction are the same mechanism at
different scales. The pin is training data for the predictor. The
user pins entity X, the predictor watches whether that bet pays off
through the normal comparison pipeline, learns the pattern, and
starts making those bets itself.

A healthy system needs both exploitation and exploration. The current
architecture (traversal, structural features, decay) is exploitation.
Weight override and the predictor's learned intuition are exploration.
The ratio matters — too much exploitation and the system becomes a
fossil, perfectly optimized for a reality that no longer exists. Too
much exploration and the system never builds the infrastructure
needed to survive the unknown.

Like a colony of bees: most of the colony works to keep it fed and
organized, maintaining the known structure. But a significant portion
goes out and explores, finding new opportunities, mapping new
territory. The explorers need the infrastructure to survive. The
infrastructure needs the explorers to stay relevant. Neither works
alone.

The feedback loop closes this: FTS overlap (memories the user
actually searched for) feeds back to aspect weights, confirming which
bets paid off. Per-entity predictor win rates surface which entities
the system understands well and which it doesn't. Superseded memories
propagate to entity attributes, pruning what's no longer true. The
graph reshapes itself based on outcomes, not just structure.

If we only build the technical pipeline without understanding why,
we build a system that optimizes metrics without serving the user.
The technical architecture exists to answer one question: what does
the user need to know right now? Weight override exists to answer a
different question: what does the user need to *explore* right now?
Both questions require the same infrastructure. Both require the
same graph. But they pull in opposite directions — and the tension
between them is what makes the system alive rather than merely
efficient.


The Goal
--------

The goal of this architecture is not to build the most complete knowledge
graph. It is to build the most *useful* one.

A database full of atomic facts, organized under entities, structured by
aspects, connected through explicit dependencies, with constraints that
always surface — that database needs almost no search to be useful. The
structure does the work. The agent walks to what it needs.

Everything else — the predictive scorer, the hybrid search, the reranker —
is enhancement. They make a good system better. But the foundation is the
structure itself.

Small. Dense. Connected. Correct.

---

Entity Pinning
--------------

Pinning is the implementation of weight override. A pinned entity carries
`pinned = 1` and a `pinned_at` timestamp on the `entities` row.

During traversal, pinned entities are resolved unconditionally — before
project path matching, before query token matching — and merged into the
focal entity set. This means a pinned entity is always walked at session
start, regardless of what the session appears to be about.

The effect is that pinning bypasses the normal relevance heuristics entirely.
It is a manual declaration that this entity belongs in every context load.
Use it for entities that are structurally universal to the agent's work: the
primary project, a key collaborator, a central tool or system.

Pinned entities sort to the top of all list views and are marked visually
in the constellation. `pinned_at` records when the pin was set; entities
pinned more recently appear above those pinned earlier in tied cases.

Unpinning restores normal traversal behavior immediately — the entity remains
in the graph with all its aspects and attributes intact; it just stops being
injected unconditionally.


Behavioral Feedback Loop
------------------------

The behavioral feedback loop closes the gap between structural importance
(how well-organized an entity is) and empirical importance (how useful it
actually proves to be during sessions).

Two mechanisms run at session end:

**FTS overlap feedback** — memories that were injected at session start and
later retrieved via full-text search (`fts_hit_count > 0` in `session_memories`)
are treated as behavioral confirmation that the injection was correct. Each
confirmed memory traces back to its source aspect via `entity_attributes`, and
that aspect's weight is incremented by a configured delta. Aspects that produce
memories the user actually searches for accumulate higher weight over time;
aspects that produce injections the user ignores do not.

**Aspect decay** — aspects that have not received an FTS confirmation within a
configurable number of days have their weight decremented by a fixed decay
amount (floor: `minWeight`). Decay runs on a per-session throttle (every N
sessions per agent) to avoid running every session when idle. Without decay,
weights only accumulate; decay ensures the graph reflects current relevance
rather than historical importance that no longer applies.

Together, these mechanisms form a signal pathway from session outcomes back to
graph structure: confirmed injections raise weights, stale aspects lose weight,
and the graph continuously reshapes itself based on what actually serves the
agent rather than what was important when the aspect was first created.

The implementation lives in `packages/daemon/src/pipeline/aspect-feedback.ts`.
Telemetry is tracked via `getFeedbackTelemetry()` and exposed in the pipeline
status endpoint.


---

*This document describes the architectural concepts. For the implementation
contract, see [Knowledge Architecture Schema and Traversal Spec](./specs/approved/knowledge-architecture-schema.md).
For predictive ranking integration, see [Signet Predictive Memory Scorer](./specs/approved/predictive-memory-scorer.md).
For extraction pipeline behavior, see [Memory Pipeline](./PIPELINE.md).
For the behavioral feedback loop, see [KA-6 Sprint Brief](./specs/SPRINT-BRIEF-KA6.md).*

## See Also

- [KNOWLEDGE-GRAPH.md](./KNOWLEDGE-GRAPH.md) — implementation reference: tables,
  traversal algorithm, API endpoints, and graph persistence
- [PROCEDURAL-MEMORY.md](./PROCEDURAL-MEMORY.md) — skills as first-class graph
  nodes; the procedural memory tier
- [PIPELINE.md](./PIPELINE.md) — how the extraction pipeline populates the graph
- [RESEARCH-GITNEXUS-PATTERNS.md](./RESEARCH-GITNEXUS-PATTERNS.md) — engineering
  patterns from GitNexus applicable to Signet's architecture: Leiden clustering,
  confidence scoring, bounded traversal, and evaluation methodology

---

*Written by [Nicholai](https://nicholai.work) and Mr. Claude, the first Signet agent. Structured relationships, constraints methodology, and entity/aspect/attribute framework co-developed with [Micheal Luigi Pacitto (PatchyToes)](https://patchytoes.substack.com/). March 3, 2026.*
