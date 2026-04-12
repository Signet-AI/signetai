---
title: "What Is Signet"
description: "A plain-language explanation of what Signet is, how it works, and what it's building toward."
order: 0
section: "Core Concepts"
---

What Is Signet
==============

Signet holds an AI agent's identity, memory, secrets, and skills outside
any single model or harness. The agent survives vendor changes, model
upgrades, tool switches, and new sessions because its state lives in a
place the user controls.

Models provide inference. Harnesses provide an interface. Signet provides
the local services that let an agent remain the same entity over time.

That distinction matters because the most valuable thing an agent builds
with a user is behavioral context: the accumulated understanding of how
the user works, what they care about, what projects exist, which
constraints matter, and what has already been tried. Losing that context
means starting over with a brilliant stranger.

Signet is built so that context travels with the agent.


Why This Matters
----------------

AI platforms are moving toward always-on agents with built-in memory,
tools, and automation. That is useful, but it creates a new kind of
lock-in. Older lock-in was about files, messages, customer records, or
source code. Agent lock-in is about the learned model of how you work.

If six months of agent memory lives inside one company's product, you do
not merely lose chat history when you switch. You lose the relationship
the agent built with you. You lose the project map, the operating
patterns, the small preferences, the hard-earned context, and the
continuity that made the agent useful.

Signet moves that state to a local-first workspace. Your agent's
identity and knowledge live in files and SQLite you can inspect, back up,
edit, sync, and move. A platform can provide the interface. A model can
provide the reasoning. The agent's accumulated context remains yours.


The Four-Layer Model
--------------------

Signet uses a simple model for the agent stack:

```text
Harness = shell       where the user interacts
Agent   = kernel      the persistent entity with identity and memory
Signet  = OS services memory, identity, secrets, IPC, skills, policies
LLM     = compute     stateless reasoning invoked by the agent
```

The harness might be Claude Code, OpenCode, OpenClaw, Codex, Hermes
Agent, or another tool. The model might be Claude, GPT, GLM, Gemma, or a
local model. Those choices can change.

The agent is the persistent thing. Signet provides the services that let
that persistence work in practice.

This framing keeps Signet focused on the boring, durable infrastructure
every agent needs: memory, identity, secret handling, policy, provenance,
and eventually stronger verification and coordination.


What Lives in Signet
--------------------

A Signet workspace contains the pieces that make an agent portable:

- **Identity files**: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`,
  and working summaries that tell the agent who it is and who it serves.
- **Memory**: structured facts, decisions, preferences, constraints,
  relationships, and session-derived knowledge.
- **Episodic records**: transcripts, summaries, markdown files, and
  source artifacts that preserve what actually happened.
- **Semantic indexes**: SQLite, FTS, embeddings, entities, aspects, and
  graph links that make the record searchable and useful.
- **Secrets**: encrypted credentials that can be injected into execution
  environments without exposing raw values to the model.
- **Skills and tools**: portable capabilities and MCP integrations that
  travel with the agent instead of being trapped in one harness.
- **Policies**: agent scoping, visibility rules, token policy, and other
  controls that decide what can be seen or used.

The workspace is deliberately inspectable. The user should be able to see
what the agent knows, why something was recalled, where it came from,
and how to repair it when it is wrong.


Memory Architecture
-------------------

Signet treats memory as two layers working together.

The first layer is the exact record: transcripts, notes, summaries, and
workspace files. This is the episodic source of truth. It gives the
system something to audit when extracted memory is wrong or incomplete.

The second layer is semantic: entities, relationships, embeddings,
keywords, procedural knowledge, and retrieval indexes. This layer makes
the record useful at the moment of work.

Semantic memory alone will drift. Raw transcripts alone are too heavy to
use directly. The combination matters: preserve the exact record, build a
semantic layer from it, and keep enough provenance to repair mistakes.

That is why Signet emphasizes write-side intelligence. The extraction
pipeline turns messy session output into durable memory structure,
deduplicates repeated facts, links entities, records constraints, and
keeps provenance attached. Better extraction makes retrieval simpler and
more reliable over time.


Context Selection
-----------------

Useful memory requires more than storage. The right context has to appear
at the right time, in the right amount, with enough provenance to trust
it.

Signet builds context from several signals:

- graph traversal across projects, people, tools, constraints, and
  dependencies
- keyword and semantic search over memories and documents
- session transcripts and summaries when exact history matters
- scoped visibility rules for multi-agent deployments
- feedback, recency, importance, and dampening to reduce repeated noise

The goal is practical precision. An agent should wake up with the context
it needs for the current task, without flooding the model window with
everything it has ever learned.

Learned ranking remains an experimental direction, but the product does
not depend on a black-box scorer being right. The baseline path must stay
inspectable, bounded, and useful on its own.


Secrets and Safety
------------------

Agents need access to real tools. Real tools need credentials. Raw
credentials should not be placed in the model context.

Signet stores secrets encrypted at rest and injects them into subprocess
environments at runtime. Outputs are redacted so secret values do not
leak back into transcripts or tool logs. This gives the agent practical
access to infrastructure while keeping a boundary between the model and
the credential itself.

That same principle extends to agent policy. Multi-agent deployments need
clear scoping: which agent can see which memory, which tools are
available, which actions require approval, and which operations should be
logged for later review.


Cross-Harness Continuity
------------------------

A useful agent may run in more than one place. It might code in Claude
Code, respond in Discord through OpenClaw, run a Hermes gateway, and use
Codex for a focused implementation task.

Those should not become separate half-agents with separate memories.
Signet provides one shared state layer underneath the harnesses. Sessions
can start, branch, end, and consolidate while the agent remains one
continuous entity.

This is especially important for teams. Multiple named agents can share
one daemon and database while retaining isolated, shared, or group memory
visibility. The point is controlled continuity, not a global pile of
context everyone can read.


Local-First and Open
--------------------

Signet runs local-first. The default workspace lives on the user's
machine. SQLite and markdown are inspectable. Git sync can version the
workspace to a remote the user controls. Docker and self-hosted
deployments keep the same ownership model.

Local-first means the user owns the root of trust. Sync, backup,
sharing, and team deployment can be added while the agent's identity and
behavioral context remain portable.

The longer-term standardization goal is behavioral context portability:
an agent should be exportable from one compliant platform and importable
into another without losing identity, memory, or provenance. Signet is
the reference implementation path toward that goal.


Where This Is Going
-------------------

The near-term job is reliability: better extraction, better provenance,
better scoping, better connector support, better inspection, and less
noise in the context window.

The larger goal is a portable agent state layer that works across models,
harnesses, machines, and teams. Identity, memory, secrets, skills,
policies, and verification should belong to the agent and its owner.

When the model changes, the agent should remain itself.
When the harness changes, the agent should remain itself.
When a platform disappears, the agent should not disappear with it.

That is the core promise of Signet: your agent is yours.
