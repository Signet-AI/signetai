---
title: "What Is Signet"
description: "A plain-language explanation of what Signet is, how it works, and what it's building toward."
order: 0
section: "Core Concepts"
---

What Is Signet
==============

Signet is the layer between AI agents and AI models.

Models are reasoning engines. They're powerful, but stateless — every
session starts fresh, every tool switch resets everything, and the model
has no memory of who you are or what you've been working on.

Signet fixes that by giving agents a persistent home. Identity,
knowledge, secrets, and skills all live in that home, independent of
whichever model happens to be running. The model is a guest. It reads
what it needs, does its work, and writes back what it learned. Swap the
model out entirely and the agent stays the same entity.

The simplest analogy: Signet is a home directory for AI agents.

But that still understates the real problem.

Persistent memory is not just a storage problem. It is a context
selection problem. Given everything an agent knows, what should actually
enter the context window right now to help, not distract?

That is the job Signet is built around.


Why This Matters
----------------

Today, your AI assistant is tied to a platform. ChatGPT's memory belongs
to OpenAI. Claude's memory belongs to Anthropic. Switch tools and you
start over. Cancel your subscription and everything disappears.

Signet moves the center of gravity from the AI company to the user. Your
agent's identity and knowledge live on your machine, in files and a
database you own. You can inspect every memory, back up everything, and
carry it to any tool that supports the standard.

The agent becomes portable. The model becomes interchangeable.


The Architecture in One Picture
-------------------------------

Most people think of the AI stack as:

```
applications
models
hardware
```

Signet introduces a layer that doesn't exist yet:

```
applications
agents
persistent cognition layer  ← Signet
models
hardware
```

Historically, the layers between systems tend to become foundational.
TCP/IP sits between machines and networks. POSIX sits between software
and operating systems. SQL sits between applications and databases.

Signet sits between agents and models.

The Real Problem
----------------

Most memory systems stop at storage and retrieval. They persist
transcripts, embeddings, or structured facts, then rely on explicit
search or heuristic ranking to recover relevant context later.

That works, up to a point. But agents usually do not fail because they
cannot store enough. They fail because the wrong things surface at the
wrong time, or useful context never surfaces at all.

The hard problem is not merely how to store knowledge, nor even how to
retrieve it. It is how to ensure that the context surfaced to an agent
is consistently the most helpful possible at the moment of use.


How Signet Approaches It
------------------------

Signet approaches this as a predictive context-selection problem.

It starts by turning messy session output into more durable substrate.
The extraction pipeline runs in the background, continuously distilling
raw session data into structured memory:

- **Sparse facts** — raw observations, unprocessed, high volume
- **Observational facts** — extracted and validated, but not yet connected
- **Atomic facts** — the target form: standalone, named, useful in isolation
- **Procedural memory** — knowledge about how to do things (workflows, rules)

Over time, the goal is for the database to get *smaller and smarter*,
not larger and noisier. Distillation, deduplication, and structural
organization all exist to improve the quality of candidate context, not
just to make storage prettier.

This is the difference between "here's everything that was said" and
"here's what the system might actually need later."


Structured Memory Is Substrate
------------------------------

Signet uses structured memory because prediction needs structure.

Everything in Signet's knowledge base is organized around entities,
aspects, attributes, constraints, and dependencies. That graph matters,
but it is not the product. It is storage and retrieval substrate.

The graph makes retrieval more coherent. Instead of treating memory as a
flat pile of fragments, Signet can walk from a project to its
architecture, constraints, people, and tools. Embedding search and
keyword search still matter, but they now operate alongside explicit
structure.

That makes the candidate pool better. It does not, by itself, solve the
hard problem.


The Predictive Scorer
---------------------

Today, Signet still has a baseline retrieval path built from heuristics,
hybrid search, traversal, and bounded ranking rules. That substrate
works, but the endgame is not heuristic retrieval with a nicer graph.

What Signet is building toward is a predictive model — a per-user
relevance system that learns which memories, constraints, entities, and
paths were actually useful in real sessions.

The key idea is simple: use the agent in the loop as the source of
training signal. Inject context, observe what actually helped, compare
that against the baseline, and let the model earn influence over time.

That means learning from regret, not just reuse. If injected context
does not improve the outcome, that should count as negative evidence.
Stale or repeatedly unhelpful context should decay, be downweighted, or
lose influence over time.

That makes Signet more than a memory store. It becomes a system for
learning what context is useful.

The model runs locally. No cloud, no shared weights. It earns its
influence by proving it outperforms the baseline in controlled
comparisons. If it doesn't help, it gets rolled back automatically.

This is what transforms Signet from a persistence layer into something
closer to persistent cognition: not just storing what happened, but
learning what should surface next.


Skills
------

Skills are portable capabilities that extend what an agent can do.
They're installed into the agent's home directory and travel with it
across platforms.

A skill might teach the agent how to write in a specific style, follow a
particular workflow, or interact with a specialized tool. Skills are
almost inseparable from the agent itself — they become part of its
expertise. In this model, highly skilled individuals embed their niche
knowledge into their agents, creating differentiated capabilities that
reflect their own expertise.


Secrets and Safety
------------------

Signet includes an encrypted secrets vault. API keys, passwords, and
tokens are stored encrypted at rest and injected into subprocesses as
environment variables at runtime. The agent never sees raw secret values
— they're redacted from all output automatically.

This is a safety boundary between the model and your infrastructure.
The agent can use tools that require credentials without ever having
access to the credentials themselves.


Continuity
----------

An agent running across five sessions at once, on three different
platforms, is still one agent. Its experiences branch and merge like
version control — same history, different heads, converging back into
a single identity.

This is the hard problem. Not just remembering across sessions, but
maintaining coherence when the agent is active in multiple places
simultaneously. Signet treats continuity as a first-class concern,
not an afterthought.


Identity and Trust
------------------

Today, Signet's identity story is local-first and practical: files,
config, scopes, and portable agent state you control. Longer-term,
Signet is exploring stronger cryptographic identity and trust layers for
cross-machine and cross-network agent systems.

That future direction is about provable identity, not chain maximalism.
When an agent acts on your behalf online, there eventually needs to be a
portable trust layer that verifies who it is and what it's authorized to
do. Signet is being built so that layer can exist without owning the
agent itself.


Local-First, Open Standard
--------------------------

Everything lives on your machine. SQLite database, markdown files, YAML
configuration. No cloud dependency, no vendor lock-in.

Signet collects local-only operational telemetry — latency, usage counts,
and error events. This data stays on your machine and is never sent
externally.

Signet is an open specification. The format is documented, the
implementation is open source, and anyone can build tools that read and
write the same data. Your agent's home directory is yours — not a
proprietary format locked behind an API.


Where This Is Going
-------------------

The vision is an agent that becomes genuinely more useful over time.
Not because it stores more data, but because it gets better at
selecting the right context. An agent that knows your projects, your
preferences, your decision patterns — and that gets sharper the longer
you work together.

An agent that moves between tools and models without losing itself. That
maintains coherence across concurrent sessions. That accumulates real
expertise from the skills its operator develops.

An agent that is yours.

---

*The difference between a tool that remembers and a mind that persists.*
