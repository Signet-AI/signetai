---
title: "Quickstart"
description: "Install Signet, connect a harness, and give your agent persistent memory."
---

Install Signet, connect a harness, and give your agent memory that survives the session.

<figure class="quickstart-dashboard">
  <img
    src="/dashboard-home-16x9.png"
    alt="Signet Dashboard showing memory, ontology, agent, source, activity, and review data"
    width="1920"
    height="1080"
    loading="eager"
    decoding="async"
  />
</figure>

## Why Signet

An agent's memory records your projects, relationships, habits, preferences, decisions, and constraints. Together, this is your pattern of life.

Memory storage and retrieval are becoming commodity capabilities. Ownership is not. Whoever owns the memory owns the record of your pattern-of-life behavior. They can also control whether your agents keep working when you change models, tools, or vendors.

For agents deployed at scale, memory is infrastructure. Keep it outside the model and the harness. Keep it in a system that you can inspect, move, and operate.

Signet stores this state in a local-first workspace that you control. The same memory can support multiple models, harnesses, and agents without locking the accumulated context inside one platform.

## Dreaming

Dreaming turns new evidence into useful semantic knowledge. It reads episodic records, compares them with the current semantic state, and applies audited ontology operations.

Dreaming can use local inference or a provider that you configure. You control the provider and model. Dreaming does not replace the source evidence. It derives semantic state from it.

Read [Memory lifecycle and Dreaming](/memory/#dreaming) for the full processing model.

## The semantic ontology

The semantic ontology is Signet's current model of people, projects, systems, tools, decisions, constraints, and relationships.

It organizes knowledge as entities, aspects, groups, and claims. Claims are scoped, versioned, and auditable. This structure lets Signet follow relevant relationships without treating memory as a flat list of text fragments.

The Dashboard shows this ontology as a navigable graph. Read [Knowledge architecture](/knowledge-architecture/) for the data model and retrieval role.

## Episodic

Episodic memory is the source record. It includes transcripts, summaries, explicit memories, notes, documents, and connected source artifacts.

Signet stores these records as immutable evidence with source information. Dreaming can derive new semantic knowledge from them, but it does not rewrite what happened.

Read [Memory lifecycle](/memory/#memory-lifecycle) for the write path.

## Semantic

Semantic memory is the current operational view of the episodic record. It includes entities, aspects, claims, relationships, keywords, and embeddings.

Dreaming maintains this layer through audited operations. Each claim can keep its evidence and version history. This makes the semantic state useful and repairable.

Read [Knowledge architecture](/knowledge-architecture/#source-truth-and-current-truth) for the boundary between evidence and current truth.

## Query

At query time, Signet selects a bounded set of context for the current task. It combines keyword search, vector similarity, semantic ontology traversal, source evidence, recency, and feedback.

Signet checks agent and project scope before it reads candidate content. It then ranks and shapes the permitted evidence. If an optional search stage fails, recall falls back to simpler channels instead of failing the full request.

Read [Hybrid recall](/memory/#hybrid-recall) for the retrieval path and [Recall API](/api/memory/recall-search/) for the request surface.

## Sources

Signet can index local documents, URLs, Obsidian vaults, Discord servers, and GitHub repositories. Source artifacts stay separate from semantic claims, so you can inspect where the knowledge came from.

Read [Sources](/sources/) for supported connectors and source behavior.

## Safety

- Raw evidence is stored before LLM processing starts.
- Pinned memories cannot be changed by Dreaming.
- Deletes are recoverable and recorded in the audit history.
- Memory reads and writes follow agent scope.
- Secrets stay encrypted and outside model context.

Automatic destructive changes remain conservative. Use explicit repair operations when the semantic state is wrong.

## Continuity

The same agent state can work across Claude Code, OpenCode, OpenClaw, Codex, and Hermes Agent. You can change the model or harness without resetting the agent's memory.

## Start

- [Install](/getting-started/install/): Install the Signet binary.
- [Set up Signet](/getting-started/setup/): Create the workspace and connect a harness.
- [Your first session](/getting-started/first-session/): Use memory, secrets, skills, and the Dashboard.
- [Operate your installation](/getting-started/operate/): Run, secure, update, and troubleshoot Signet.
