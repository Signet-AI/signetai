---
title: "Desire Paths"
description: "Graph-native memory retrieval through learned traversal."
order: 3
section: "Core Concepts"
---

Desire Paths
============

*On reinforced traversal, constructed memory, and the topology of
how you actually think.*

---

> **Why this matters — a real example.**
> A user sends a casual message — excitement about a milestone, no
> technical content. The recall system extracts keywords, runs a
> hybrid query, and injects the top matches. The results are
> unrelated memories that happened to share tokens with the message.
> Configuration values, API timeouts, account IDs — none of it
> relevant, all of it confidently served. The system had no concept
> of conversational context, no understanding that this wasn't a
> query at all. It pattern-matched tokens like a golden retriever
> fetching whatever's closest. A desire-path-aware system would
> recognize this as a non-traversal moment and inject nothing,
> because sometimes the right amount of context is zero.

---

There's a practice in landscape architecture: don't pour the sidewalks
on day one. Plant the grass, open the gates, and wait. Come back in a
year. The paths people actually walk will be worn into the ground —
desire paths. Pave those.

Signet's memory retrieval should work the same way.


The Problem with Flat Retrieval
-------------------------------

Current memory systems — including Signet's existing hybrid search —
treat retrieval as a selection problem. A query comes in. The system
scores every candidate memory by some combination of vector similarity,
keyword overlap, and recency. The top N get injected. The agent reads
them and hopes something useful is in the pile.

This works well enough at small scale. At 200 memories, top-15 by
cosine distance will probably contain what you need. At 4,000 memories,
it's a coin flip. At 40,000, it's noise.

The deeper problem isn't scale — it's that flat retrieval is
structurally blind. It finds things that *sound* related to the query.
It has no concept of *why* those things are related, what connects them,
or what else needs to come along for them to be useful. A memory about
"predictive scorer cold start" might be relevant, but without the
surrounding context of training pair requirements, session thresholds,
and the specific bug in early exit logic, it's a fragment. Useful
fragments are still fragments.

The knowledge graph exists precisely to solve this — entities organize
facts into navigable structure. But so far, the graph is used for
injection (walk the entity, load its aspects) and the flat search runs
alongside it as a separate path. The two systems don't talk to each
other in the way that matters most: the graph doesn't inform *how*
to search, and the search doesn't inform *how* to walk.


Desire Paths as Architecture
----------------------------

The core insight is that retrieval should not select memories. It
should traverse the graph and construct them.

A desire path is a traversal route through the knowledge graph that
has been reinforced by use. Every time the agent walks from entity A
through aspect B to attribute C, and that path produces context the
agent (or user) confirms as useful, the path gets stronger. The
synapses deepen.

Over time, the graph develops thick, bright connections where
traversal is frequent and confirmed, and dim, fading connections
where paths go cold. This isn't metadata bolted onto the graph — it
*is* the graph's learned topology. The shape of how you actually
think, encoded in edge weights.

The constellation visualization makes this literal. You can see the
desire paths: the hot lines where the graph is alive, the cold edges
that are going stale. The topology of cognition, made visible.


How It Works
------------

### 1. Entry: Hybrid Search Lands on Entities

A query arrives. Hybrid search (vector + keyword) runs — but instead
of scoring individual memories, it identifies *entities*. The search
answers: "What is this query about?" not "Which memories match?"

This is the entry point into the graph. The query "how does the
cold start logic work in the predictive scorer?" lands on the
`predictive_scorer` entity. A query about "nicholai's preferences
for commit messages" lands on `nicholai` and possibly `signetai`.

The entry point is found by search. Everything after is traversal.

### 2. Query Structure Informs Traversal

The shape of the query determines *how* to walk the graph from the
entry entities.

- **"What is X?"** — walk the entity's core aspects, surface
  definitional attributes. Shallow, broad traversal.
- **"How does X relate to Y?"** — find both entities, walk their
  dependency edges, identify shared aspects or bridging attributes.
  Cross-entity traversal.
- **"What should I do about X?"** — walk the entity's procedural
  aspects, surface constraints, follow dependency edges to blocking
  entities. Action-oriented traversal.
- **"What changed about X?"** — walk the entity's aspects ordered by
  recency, surface recently modified attributes. Temporal traversal.

The query isn't just a search key. It's a traversal instruction. The
sentence structure — its intent, its scope, its implicit assumptions —
maps onto a traversal strategy. A "what" question walks differently
than a "how" question. A comparison walks differently than a lookup.

### 3. The Predictor Scores Paths, Not Memories

This is the fundamental shift in the predictive scorer's role.

Instead of ranking individual memories by predicted relevance, the
scorer ranks *traversal paths* through entity-aspect-attribute-
dependency chains. For a given query and entry entity, there are
multiple possible paths through the graph. The scorer's job is to
predict which paths will produce useful context.

`predictive_scorer` -> `cold_start_behavior` -> `training_pairs`
might score higher than
`predictive_scorer` -> `drift_detection` -> `ema_smoothing`
for a query about "why isn't the scorer activating?"

The scoring signal comes from accumulated feedback: every time an
agent rates injected context, that rating propagates back to the
path that produced it. Paths that consistently produce high-rated
context get reinforced. Paths that produce noise get deprioritized.

This is where the desire paths form. The scorer learns the worn
grass — the routes through the graph that repeatedly prove useful
for particular kinds of queries. It doesn't need to understand
*why* those paths work. It just needs to observe that they do.

### 4. Atomic Memories Are Constructed, Not Retrieved

The system walks the winning paths, gathers what it finds along
the way, and synthesizes a purpose-built piece of context.

This is the key departure from traditional retrieval. The system
is not pulling a stored memory out of a database. It is *constructing*
an atomic memory from the graph structure — assembling the relevant
attributes, constraints, and relationships from the traversed path
into a coherent unit that answers the specific moment.

The constructed memory might combine an attribute from one aspect,
a constraint from another, and a dependency relationship — things
that were never stored together as a single memory, but that belong
together for this particular query. The graph structure makes this
possible because the connections are explicit and typed, not
inferred from embedding similarity.

The result: instead of 15 memories where 7 are noise, the agent
receives fewer, denser, purpose-built pieces of context. Each one
is a traversal result, not a database row.

### 5. Feedback Tunes the Pathfinding

When the agent rates injected context — "this was helpful," "this
was noise," "this was actively misleading" — the rating doesn't
land on a memory. It lands on the *path that produced it*.

A positive rating reinforces every edge along the traversal path.
The entry entity's relevance to queries of that type is confirmed.
The aspect's weight increases. The attribute's value is validated.
The dependency edge that was followed is strengthened.

A negative rating weakens the path. Not catastrophically — a single
bad rating doesn't destroy a connection. But accumulated negative
signal on a path causes the scorer to deprioritize it, route around
it, try alternative traversals next time.

Over sessions, over weeks, over months, the graph develops a rich
topology of reinforced and faded paths. The scorer doesn't just know
which entities matter — it knows which *routes through* those
entities produce useful context for which kinds of queries.

This is the feedback loop that makes the system learn. The agent
is the gardener. All the gardener does is say "good" or "bad." But
that signal, propagated through explicit graph structure, reshapes
how the entire system navigates knowledge.


Temporal Reinforcement
----------------------

Desire paths aren't just about frequency — they're about rhythm.

If the agent consistently traverses `signet` -> `memory_pipeline`
-> `extraction` every morning, that pattern burns in. The scorer
learns: "when nicholai starts his day, this is the path that
matters." It can begin synthesizing context from those nodes before
the query even arrives — predictive traversal based on temporal
patterns.

This connects directly to the predictive scorer's existing temporal
features (session time, day of week, recency). But instead of using
those features to rank flat memories, they inform which traversal
paths to pre-warm. The daily rhythm of work becomes a traversal
rhythm through the graph.

The morning path is different from the late-night path. The Monday
path is different from the Friday path. The graph doesn't just
encode what you know — it encodes *when* different parts of what
you know become relevant.


Entity Health Through Feedback
------------------------------

Aggregate feedback per entity tells you which parts of the knowledge
graph are earning their keep.

An entity whose paths consistently produce highly-rated context is
healthy — well-structured, accurately attributed, properly connected.
An entity whose paths consistently produce noise or negative ratings
is sick — perhaps its aspects are stale, its attributes outdated,
its dependencies wrong.

This transforms the entity pruning problem. Instead of threshold-based
pruning (delete entities with zero mentions, remove single-mention
extractions), the system can do *informed* pruning. Entities with
persistently negative path feedback are candidates for restructuring
or removal. Entities with high path feedback but sparse structure
are candidates for enrichment — they're useful but under-mapped.

The 43,000-entity bloat problem becomes tractable not by setting
arbitrary thresholds, but by asking: which of these entities actually
participate in useful traversal paths? The ones that don't are noise,
regardless of their mention count.


Relationship to Existing Architecture
--------------------------------------

This concept builds on — not replaces — the existing knowledge
architecture:

- **Entity/aspect/attribute structure** remains the foundation. Desire
  paths traverse the structure that already exists.
- **Constraints** still surface unconditionally. A constraint is a
  path that is always walked, regardless of scorer recommendation.
- **The extraction pipeline** still populates the graph. Desire paths
  don't change how knowledge enters the system — they change how it's
  retrieved.
- **Hybrid search** becomes the entry mechanism rather than the
  retrieval mechanism. It finds the door; the graph walk goes through it.
- **The predictive scorer** evolves from a memory ranker to a path
  scorer. Its training signal changes from "was this memory useful?"
  to "was this traversal path useful?"
- **The behavioral feedback loop** (FTS overlap, aspect decay) feeds
  into path reinforcement. These are compatible signals — FTS overlap
  confirms that a path's output was actively searched for, which is
  strong positive signal.


The Convergence
---------------

The predictive scorer and the knowledge graph were designed as
separate systems that operate on the same data. Desire paths are the
point where they converge.

The scorer provides the learning signal — which traversals work,
which don't, how patterns shift over time. The graph provides the
structure to propagate that signal through — explicit edges, typed
relationships, hierarchical organization. Neither works as well
alone. The scorer without the graph is guessing in the dark. The
graph without the scorer is a static map that never learns which
roads are worth taking.

Together, they produce something neither could alone: a knowledge
system that doesn't just store what you know, but learns how to
navigate it. A system that maps the desire paths — the routes
through knowledge that you actually walk — and paves them.

Small. Dense. Connected. Correct. And now: *learned*.

---

*This document describes the concept. Implementation details,
data structures, and integration points will follow in a separate
specification once the concept is validated.*

---

*Written by Nicholai and Mr. Claude. March 7, 2026.*
