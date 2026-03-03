---
title: "Knowledge Architecture"
description: "How Signet turns experience into understanding."
order: 2
section: "Core Concepts"
---

Knowledge Architecture
======================

The difference between a memory system and an intelligent one is structure.
Any system can store facts. The question is whether those facts are
organized in a way that makes them *useful* — findable at the right moment,
connected to the right things, and trimmed of everything that doesn't
serve the goal.

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

The extraction pipeline is the refinery. Over time, continuously and in the
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
the agent follows that edge and nicholai's relevant aspects become available.
This is how the graph retrieves without searching — it walks.


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


The Graph That Walks Itself
----------------------------

The fundamental shift this architecture makes is from *search* to *traversal*.

Current memory systems find relevant knowledge by asking: what is
semantically similar to this query? They embed the query, embed the
memories, compute cosine distances, retrieve the closest matches. This
works. It's also expensive, probabilistic, and structurally blind — it
finds things that *sound related*, not things that *are structurally
required*.

In Signet's knowledge architecture, session-start can ask a different
question: what entity is this session about? Walk its aspects. Pull its
attributes and constraints. Follow its dependencies. You now have the
minimum structured context needed to act — without an embedding call,
without a vector search, without scoring 4,000 candidates.

The predictive scorer still runs on top of this. It learns which aspects
matter most for which kinds of sessions, which attributes to prioritize,
which dependencies are worth following. It adds the learned intelligence
layer. But it operates on a candidate pool that's already structurally
coherent — not a flat bag of facts.

The floor is better. The ceiling is higher.


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

*This document describes the architectural concepts. For the implementation
contract, see [Knowledge Architecture Schema and Traversal Spec](./specs/planning/knowledge-architecture-schema.md).
For predictive ranking integration, see [Signet Predictive Memory Scorer](./specs/planning/predictive-memory-scorer.md).
For extraction pipeline behavior, see [Memory Pipeline](./PIPELINE.md).*

---

*Written by Nicholai and Mr. Claude, the first Signet agent.*
*March 3, 2026*


---
*Addendum — March 3, 2026*

---


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

In the constellation view, this manifests as node brightness. Entities
with dense constraint graphs are luminous. New entities are dim. The
visual tells you, at a glance, where the agent is operating on solid
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
similar to the query. The graph walk finds everything that is
structurally required, deterministically, every time.

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
