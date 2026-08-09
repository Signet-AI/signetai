---
title: "Quickstart"
description: "Get Signet running in about five minutes."
---

Get Signet running in about five minutes.

## Why Signet

Your agent starts every session from zero. It doesn't know what you
worked on yesterday. It doesn't know your preferences, your projects,
or the decisions you've already made together. Every session is a
first date.

The industry's answer to this has often been to give agents memory tools
— "remember this," "recall that." That's not memory. That's a filing
cabinet the agent sometimes opens. It puts the LLM in charge of
micromanaging what to store and when to retrieve it.

Signet takes a different approach. The goal is ambient context
selection: turn interactions into durable memory substrate, preserve the
record of what actually happened, and surface the right pieces when the
next session begins.

### The distillation layer

At the end of every conversation, Signet reviews the session and
distills it. A local LLM breaks the conversation into atomic facts,
checks them against what's already known, and decides whether to add new
facts, skip duplicates, or record proposals for more complex changes.
Your agent won't store "prefers dark mode" fourteen times.

### The knowledge graph

Named entities — people, projects, tools, concepts — are extracted
and linked. When you ask about a project, Signet traverses the graph:
the project's architecture, the people involved, the tools it depends
on, the constraints that apply. This structure improves the quality of
candidate context instead of treating memory as a flat pile of fragments.

### Context selection

The structured candidate pool gives Signet something better than a flat
list of snippets. Retrieval can combine graph traversal, keyword search,
semantic similarity, provenance, scope, recency, and feedback without
hiding the result behind an opaque ranking model.

The aim is practical precision: surface the context that helps the agent
work now, and keep noisy or repeatedly unhelpful memories from haunting
the context window forever.

### Retrieval

Retrieval blends graph traversal, keyword search, and semantic
similarity into a bounded candidate set, then reranks and filters it.
The constellation view in the dashboard lets you inspect the agent's
knowledge topology.

### Document ingest

Feed any document into the distillation layer. PDFs, specs, reference
pages, URLs. They're chunked, embedded, and indexed alongside your
agent's insights.

### Safety guarantees

- **Raw-first**: content is persisted before any LLM processing begins
- **Pinned insights are sacred**: the distillation layer cannot modify
  them. Only you can.
- **Everything is recoverable**: deletions are soft, with a recovery
  window and full audit trail

Automatic destructive memory mutations remain conservative and gated in
the current implementation. Explicit user/operator repair flows are the
reliable path today.

The same agent follows you across Claude Code, OpenCode, and OpenClaw.
Same personality, same knowledge, same secrets. Switch tools without
starting over.

For deeper technical details, see [Architecture](/architecture/). For the long-term
vision, see [VISION.md](https://github.com/Signet-AI/signetai/blob/main/VISION.md).

---

## In this section

- [Install](/getting-started/install/)
  Install Signet and choose the right distribution path.
- [Set up Signet](/getting-started/setup/)
  Run the setup wizard and understand the workspace it creates.
- [Your first session](/getting-started/first-session/)
  Use memory, secrets, skills, and the dashboard in a first Signet session.
- [Operate your installation](/getting-started/operate/)
  Run Signet as a service, edit the agent, secure access, and troubleshoot it.
