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

> *Simple systems. Emergent behaviors. Don't build the brain —
> build the conditions.*

Signet is a zibaldone — prediction market algorithms next to birthday
plans, a prayer next to an architecture diagram. No artificial
separation between domains. The connections emerge from use, not from
taxonomy imposed at write time. Desire paths are how those connections
are discovered, reinforced, and navigated.

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

Current [[memory]] systems — including Signet's existing [[memory|hybrid search]] —
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

The [[knowledge-graph|knowledge graph]] exists precisely to solve this — entities organize
facts into navigable structure. But so far, the graph is used for
injection (walk the entity, load its aspects) and the flat search runs
alongside it as a separate path. The two systems don't talk to each
other in the way that matters most: the graph doesn't inform *how*
to search, and the search doesn't inform *how* to walk.


Desire Paths as Architecture
----------------------------

The core insight is that retrieval should not select memories. It
should traverse the graph and construct them.

A desire path is a traversal route through the [[knowledge-graph|knowledge graph]] that
has been reinforced by use. Every time the agent walks from entity A
through aspect B to attribute C, and that path produces context the
agent (or user) confirms as useful, the path gets stronger. The
synapses deepen.

Over time, the graph develops thick, bright connections where
traversal is frequent and confirmed, and dim, fading connections
where paths go cold. This isn't metadata bolted onto the graph — it
*is* the graph's learned topology. The shape of how you actually
think, encoded in edge weights.

The [[dashboard|constellation visualization]] makes this literal. You can see the
desire paths: the hot lines where the graph is alive, the cold edges
that are going stale. The topology of cognition, made visible.


How It Works
------------

### 1. Entry: Hybrid Search Lands on Entities

A query arrives. [[memory|Hybrid search]] (vector + keyword) runs — but instead
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

This is the fundamental shift in the [[pipeline|predictive scorer]]'s role.

Instead of ranking individual [[memory|memories]] by predicted relevance, the
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


User Role: Correct, Confirm, Reject
------------------------------------

The user's relationship to the system is observability without
control. They can see the constellation, see the desire paths
forming, see the discovered principles. Full transparency. But
seeing is not the same as steering.

The user can:

- **Correct** — "that's not what I meant, here's what I actually
  mean." Natural language refinement that the system interprets
  and propagates.
- **Confirm** — "yes, that's accurate." Positive signal that
  reinforces the path.
- **Reject** — "no, that's wrong." Negative signal that weakens
  the path.

That's it. Users never touch weights, scores, edge strengths, or
graph topology directly. There is no weight override. There is no
manual importance slider.

This is a deliberate design constraint. Users who can manually set
weights will set everything to maximum because everything feels
important in the moment. The system becomes useless because the
human optimized for their feelings instead of for retrieval quality.
Users will happily take on the role of maintenance simply because
the system allowed them to — commandeering the system and exercising
opinions formed with a limited understanding of what the system is
actually doing. That's how you end up with a poisoned, useless
memory.

The observability and trust layer exists so the user and the agent
can understand that there is a process and that this process is
there to help them. It is to build trust. It is not for them to
maintain. Some aspects should not be customizable because it is
that customization that will cause the system to not work.

Trust through transparency, not through control.


Temporal Reinforcement
----------------------

Desire paths aren't just about frequency — they're about rhythm.

If the agent consistently traverses `signet` -> `memory_pipeline`
-> `extraction` every morning, that pattern burns in. The scorer
learns: "when nicholai starts his day, this is the path that
matters." It can begin synthesizing context from those nodes before
the query even arrives — predictive traversal based on temporal
patterns.

This connects directly to the [[pipeline|predictive scorer]]'s existing temporal
features (session time, day of week, recency). But instead of using
those features to rank flat memories, they inform which traversal
paths to pre-warm. The daily rhythm of work becomes a traversal
rhythm through the graph.

The morning path is different from the late-night path. The Monday
path is different from the Friday path. The graph doesn't just
encode what you know — it encodes *when* different parts of what
you know become relevant.


Cross-Entity Boundary Traversal
-------------------------------

Entities are not islands. An attribute belonging to one entity can
also belong to an aspect of an entirely separate entity. This is
cumulative knowledge.

Consider: `nicholai` has an attribute `prefers-minimal-ui` under a
`design_preferences` aspect. `signet_dashboard` has an aspect
`ui_patterns`. These should find each other — not because someone
explicitly linked them, but because the attribute is semantically
the same knowledge serving two different entities.

This cross-entity traversal isn't a separate feature bolted onto
the system. It's already a requirement for deduplication. When the
extraction pipeline stores a new fact and checks for contradictions
and duplicates, it already asks "does this fact exist elsewhere?"
Adding one more step — "does this fact bridge to an entity it isn't
currently linked to?" — is a natural extension of what's already
running. No new infrastructure, just a wider lens on the same
process.

The same mechanism that deduplicates can ideate. The pipeline that
prevents redundancy is the pipeline that discovers connections.

The behaviors that emerge from this are significant: style
preferences surfacing across unrelated projects. Skills from one
domain being recognized as applicable to a task in another. The
system doesn't just remember what you know — it discovers that
things you know in different contexts are the same thing.


Explorer Bees: Insurance Against Local Optima
---------------------------------------------

Desire paths solve the common case beautifully. But they have a
failure mode: everyone walks the same worn trail and nobody
discovers the shortcut through the woods.

There's a pattern in bee colonies: 70% of foragers follow the
waggle dance to known flower patches. 30% ignore the dance and
explore on their own. The colony calls them scout bees. They're
the reason the colony doesn't starve when the known flowers die.

The exploration layer is the 30%. It deliberately walks unfamiliar
paths through the graph — crosses entity boundaries that haven't
been linked before, surfaces connections that the scorer would
normally deprioritize, and presents the collision to the agent.

This isn't random. It's serendipity with structure. The system
finds entities that are semantically adjacent (close in embedding
space) but graph-distant (no dependency edges between them), walks
between them, and asks: "is this useful?"

If the feedback says yes — congratulations, a new desire path was
discovered that nobody explicitly created. If the feedback says
no, the path fades. No harm done.

The implementation is simple: one explorer traversal per session,
maybe two. Tagged so the agent knows it's speculative. If a
particular cross-domain bridge consistently produces positive
feedback, promote it to a real dependency edge in the graph.

The exploration layer isn't ideation. It isn't a feature. It's
insurance against local optima — the system's way of making sure
the desire paths it paved are actually the best routes, not just
the first ones it found.

If the system can detect staleness — same paths every session, no
new entities being created, no new connections forming — it can
respond by increasing exploration. A self-regulating mechanism:
when the graph gets too comfortable, the scout bees wake up.


Discovered Principles
---------------------

When the system detects a pattern that spans multiple unrelated
entities, it has discovered something that isn't a memory, isn't
an attribute, and isn't an aspect. It's a *principle*.

"Sovereignty over convenience" isn't stored in any single memory.
It emerges from decisions across `signet` (local-first architecture),
`infrastructure` (self-hosted servers), `data_storage` (plain text
over databases), and `identity` (portable, user-owned). No single
entity contains it. The pattern lives in the space between them.

A discovered principle is a new entity — type `principle` — that
gets auto-created when the system detects this kind of cross-entity
pattern. It appears in the constellation as a distinct shape, with
dependency edges reaching down to the entities it was extracted from.

The user sees the discovery through a notification: "Signet noticed
something." The principle is presented with its evidence trail —
the specific decisions across specific projects that led to the
conclusion. Trust comes from showing your work.

The user can then:

- **Correct** it — "it's not sovereignty, it's control over my own
  data specifically." The system refines the principle, adjusts the
  entity, and the corrected version influences future retrieval.
- **Confirm** it — the principle becomes a first-class entity that
  influences path scoring. Traversals that touch this principle get
  boosted.
- **Reject** it — the principle entity fades. The pattern was
  coincidental, not meaningful.

Discovered principles are how the system moves from remembering
facts to understanding values. From "what happened" to "what
matters." The desire paths that cross entity boundaries aren't just
finding duplicate attributes — they're finding the shape of how
you think.


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

- **[[knowledge-graph|Entity/aspect/attribute structure]]** remains the foundation. Desire
  paths traverse the structure that already exists.
- **Constraints** still surface unconditionally. A constraint is a
  path that is always walked, regardless of scorer recommendation.
- **The [[pipeline|extraction pipeline]]** still populates the graph. Desire paths
  don't change how knowledge enters the system — they change how it's
  retrieved. Cross-entity boundary detection is a natural extension
  of the existing deduplication step.
- **[[memory|Hybrid search]]** becomes the entry mechanism rather than the
  retrieval mechanism. It finds the door; the graph walk goes through it.
- **The [[pipeline|predictive scorer]]** evolves from a memory ranker to a path
  scorer. Its training signal changes from "was this memory useful?"
  to "was this traversal path useful?"
- **The behavioral feedback loop** (FTS overlap, aspect decay) feeds
  into path reinforcement. These are compatible signals — FTS overlap
  confirms that a path's output was actively searched for, which is
  strong positive signal.
- **The exploration layer** extends the [[pipeline|extraction pipeline]] with one
  additional step: checking whether new facts bridge to unlinked
  entities. No new infrastructure required.


The Convergence
---------------

The [[pipeline|predictive scorer]] and the [[knowledge-graph|knowledge graph]] were designed as
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

The system doesn't just remember better. It thinks laterally.

Small. Dense. Connected. Correct. And now: *learned*.

---

*This document describes the concept. Implementation details,
data structures, and integration points will follow in a separate
specification once the concept is validated.*

---

*Written by Nicholai, Mr. Claude, PatchyToes, and Jake. March 7, 2026.*

