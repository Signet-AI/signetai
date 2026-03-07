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


How Knowledge Works
-------------------

Most AI memory systems store conversations — they save what was said and
search it later. That works, but it gets noisier over time. More data
doesn't mean better understanding.

Signet takes a different approach. Instead of storing conversations, it
extracts knowledge from them. The extraction pipeline runs in the
background, continuously refining raw session data into structured
understanding:

- **Sparse facts** — raw observations, unprocessed, high volume
- **Observational facts** — extracted and validated, but not yet connected
- **Atomic facts** — the target form: standalone, named, useful in isolation
- **Procedural memory** — knowledge about how to do things (workflows, rules)

Over time, the database gets *smaller and smarter*, not larger and
noisier. A heavy week of sessions might produce thousands of memories.
Leave the system alone and the pipeline prunes, deduplicates, and
organizes — what remains is dense, connected, and useful.

This is the difference between "here's everything that was said" and
"here's what the system actually learned."


Entities and the Knowledge Graph
--------------------------------

Everything in Signet's knowledge base is organized around entities —
people, projects, tools, concepts. An entity is anything that can be
identified and that accumulates knowledge over time.

Each entity has aspects (dimensions of what matters about it), attributes
(specific facts organized under those aspects), and constraints (rules
that always surface, no matter what). Entities connect to each other
through explicit dependencies, forming a graph.

When a session starts, the system doesn't search through thousands of
memories looking for what's relevant. It identifies which entities matter
for this session and walks the graph — loading aspects, attributes,
constraints, and following dependencies. The result is a bounded,
structured context that's deterministic and fast.

This is the shift from search to traversal. Embedding search still
exists for discovering things the graph hasn't connected yet, but the
graph walk is the primary path. The floor is higher because structure
does the work.


The Predictive Scorer
---------------------

Today, Signet uses a decay formula and keyword matching to decide which
memories to surface. That's the baseline.

What we're building toward is a predictive model — a small neural network
unique to each user, trained on their own interaction patterns. It learns
which memories actually helped in past sessions, what time of day certain
projects matter, which aspects to prioritize, and which memories just
took up space.

The model runs locally. No cloud, no shared weights. It earns its
influence by proving it outperforms the baseline in controlled
comparisons. If it doesn't help, it gets rolled back automatically.

This is what transforms Signet from a memory system into something closer
to a mind — a system that doesn't just store what happened, but learns
to predict what you'll need next.


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

Signet is building toward a decentralized identity layer for agents.
Through EIP-8004 (Trustless Agents), agents can be discovered, verified,
and interacted with using blockchain-based identity — enabling open agent
economies where agents hire other agents and humans for real services.

This isn't about cryptocurrency. It's about provable identity. When an
agent acts on your behalf online, there needs to be a trust layer that
verifies who it is and what it's authorized to do. That trust layer is
built into Signet's architecture.


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
Not because it stores more data, but because it understands more deeply.
An agent that knows your projects, your preferences, your decision
patterns — and that gets sharper the longer you work together.

An agent that moves between tools and models without losing itself. That
maintains coherence across concurrent sessions. That accumulates real
expertise from the skills its operator develops.

An agent that is yours.

---

*The difference between a tool that remembers and a mind that persists.*
