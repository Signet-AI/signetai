---
title: AI Agent Memory & Identity Competitive Landscape
date: 2026-03-17
source: SearXNG research (GitHub, press, product sites, analyst reports)
section: "Research"
order: 90
question: "Who are Signet's competitors and how do they compare?"
informs: []
---

# AI Agent Memory & Identity Competitive Landscape — March 2026

---

## 1. NemoClaw (NVIDIA)

**What it is:** An open-source alpha-stage stack announced at GTC 2026 (March 16) that wraps NVIDIA's OpenShell runtime around the OpenClaw agent platform. Jensen Huang positioned OpenClaw as "probably the single most important release of software...probably ever."

**Architecture:**
- **OpenShell runtime** provides process-level sandboxing via Landlock (filesystem), seccomp (syscall filtering), and network namespaces. Deny-by-default access model.
- **Policy Engine** enforces constraints at the binary, destination, method, and path level. Policies are defined in YAML. Network and inference policies are hot-reloadable; filesystem and process restrictions are locked at sandbox creation.
- **Privacy Router** routes sensitive data based on organizational policy — keeps context on-device with local Nemotron models or routes to frontier models (Claude, GPT) only when policy allows.
- **Inference Gateway** transparently intercepts model API calls and routes through NVIDIA cloud. Currently only supports `nvidia/nemotron-3-super-120b-a12b`.
- **Deployment targets:** GeForce RTX PCs, RTX PRO workstations, DGX Spark, DGX Station.

**What ships vs. roadmap:**
- Ships today (alpha): Host CLI for sandbox lifecycle, blueprint orchestration with policy application, NVIDIA cloud inference routing, Landlock+seccomp+netns isolation, interactive TUI.
- Not production-ready. OpenClaw plugin commands are incomplete. Interfaces subject to change.

**What layer it occupies:** Execution security and isolation. Does not provide memory, identity, or persistence. Answers "how do we safely run agents?" not "how do agents remember and learn?" Its privacy router is about data routing, not data retention. No memory extraction pipeline, no knowledge graph, no session persistence, no cross-platform identity.

**Key distinction from Signet:** NemoClaw sits *below* Signet in the stack. Sandboxes the runtime; Signet provides the cognitive layer that persists across runtimes. Complementary, not competitive.

---

## 2. Dedicated Agent Memory Solutions

### Mem0
- **Positioning:** "Universal memory layer for AI agents." Most widely adopted (~48K GitHub stars). Cloud-managed with self-hosted option.
- **Architecture:** Vector embeddings + knowledge graph (graph locked behind $249/mo Pro tier). Dynamic extraction, consolidation, and retrieval. Python/TypeScript SDKs.
- **Performance:** 26% relative improvement over OpenAI on LLM-as-a-Judge. 91% lower p95 latency, 90%+ token savings. 49% on LongMemEval.
- **Gaps:** No agent identity. No local-first option. No cross-platform harness integration. Graph behind paywall.

### Zep / Graphiti
- **Positioning:** "Context engineering and agent memory platform." Temporal knowledge graph architecture.
- **Architecture:** Graphiti is the open-source temporal knowledge graph engine. Zep Cloud is managed (Community Edition deprecated).
- **Performance:** 94.8% on DMR benchmark. 63.8% on LongMemEval. Sub-200ms retrieval.
- **Gaps:** Cloud-only for Zep. Credit-based pricing. No agent identity. No local-first. No cross-platform harness support.

### Letta (formerly MemGPT)
- **Positioning:** "Platform for building stateful agents." Frames memory as integral to the agent runtime.
- **Architecture:** OS-inspired tiered hierarchy: core memory (in-context editable blocks), recall memory (searchable conversation history), archival memory (external knowledge). Self-editing memory. Sleep-time compute via background memory subagents.
- **Letta Code:** Memory-first coding harness claiming #1 on Terminal-Bench among model-agnostic tools.
- **Funding:** $10M seed.
- **Gaps:** Requires adopting the entire Letta runtime — cannot use Letta memory with Claude Code or other harnesses. Not a portable memory layer. No local-first SQLite. No cross-platform identity files.

### Hindsight (by Vectorize)
- **Positioning:** "Agent memory that learns." MCP-first design, newest entrant.
- **Architecture:** Multi-strategy hybrid: semantic search, BM25, entity graphs, temporal filtering. `reflect` tool synthesizes across memories. Embedded Postgres.
- **Performance:** 91.4% on LongMemEval (highest in market). MCP server released March 2026.
- **Gaps:** Very new (~4K stars). Synthesis adds latency. No agent identity. No local-first (requires Postgres).

### Cognee
- **Positioning:** "Open-source AI memory engine." Knowledge graph + vector search.
- **Architecture:** Local-first by default (SQLite, LanceDB, Kuzu graph DB). 30+ data connectors. Multimodal. Python-only.
- **Funding:** 7.5M EUR.
- **Gaps:** Python-only. No agent identity. No harness integration. No session management.

### SuperMemory
- **Positioning:** "Universal memory API for AI apps." One-call API bundling memory + RAG.
- **Performance:** 81.6% on LongMemEval.
- **Funding:** $3M.
- **Gaps:** Closed source. Cloud-only. No local-first. No agent identity.

### LangMem
- **Positioning:** LangChain's official long-term memory SDK.
- **Architecture:** Flat key-value + vector search. Tightly coupled to LangGraph.
- **Gaps:** Framework lock-in. No knowledge graphs. Python-only. No agent identity.

### Sediment
- **Positioning:** "Semantic memory for AI agents. Local-first, MCP-native." Rust single binary.
- **Architecture:** Hybrid LanceDB (vectors) + SQLite (relationship graph, access tracking, decay). Four MCP tools. Local embedding models. 30-day half-life decay. `~/.sediment/` data directory.
- **Performance:** 50ms store, 103ms recall (p50). 50% Recall@1.
- **Gaps:** Very small project. Limited accuracy. No agent identity. No harness integration. No extraction pipeline.

### OpenViking (ByteDance/Volcengine)
- **Positioning:** "Context database for AI agents." Open-sourced March 2026.
- **Architecture:** Filesystem-based context hierarchy. Native glob/grep + hybrid vector retrieval. Designed for OpenClaw.
- **Gaps:** Default config points to Volcengine cloud — effectively a vendor funnel. No agent identity. Very new.

### CASS Memory System
- **Positioning:** "Procedural memory for AI coding agents."
- **Architecture:** Three-layer cognitive: Episodic (experiences), Working (active context), Procedural (skills). Cross-agent memory sharing.
- **Gaps:** Side project. No identity layer. No harness integration.

---

## 3. Platform Vendor Memory

### OpenAI — ChatGPT Memory + Frontier
**Consumer:** Four-layer system: session metadata (ephemeral), user memory (permanent facts), recent conversation summaries (~15 chats), current session messages. Entirely cloud-hosted, OpenAI-controlled.

**Frontier (enterprise, launched Feb 5 2026):** "Business Context" as institutional memory — unified knowledge base connecting data warehouses, CRM, internal apps. Agents are "durable entities that exist over time, with memory, role boundaries, and ownership." Task context persists across sessions.

**Limitation:** Entirely cloud-hosted, OpenAI-locked. No local-first. No cross-platform portability. Memory is a feature of OpenAI's platform, not an independent layer.

### Anthropic — Claude Memory + Claude Code
**Consumer:** Rolled out September 2025. Retains preferences and context across sessions. Cloud-stored.

**Claude Code:** Two systems:
1. **CLAUDE.md files** — human-written persistent instructions. Scoped to policy, project, or user level. Support imports via `@path`.
2. **Auto memory** — Claude writes notes based on corrections/preferences. `~/.claude/projects/<project>/memory/MEMORY.md`. Machine-local, per-git-repo scoped.

**Limitation:** Memory is per-harness (Claude Code only). CLAUDE.md does not sync to other agents/platforms. No extraction pipeline. No knowledge graph. No vector search. No cross-platform portability.

### Google Gemini
No specific agent memory architecture found. Focus appears on model capabilities, not persistence.

---

## 4. The Gap Analysis — Where Signet Sits

### The Three-Layer Model

| Layer | What it provides | Who occupies it |
|-------|-----------------|-----------------|
| **Execution Security** | Sandboxing, policy enforcement, privacy routing | NemoClaw/OpenShell, CrowdStrike, enterprise IAM |
| **Memory & Context** | Extraction, storage, retrieval, knowledge graphs | Mem0, Zep, Letta, Hindsight, Cognee, SuperMemory |
| **Cognitive Identity** | Persistent identity, cross-platform continuity, local ownership | **Largely empty** |

### What Nobody Else Does

**1. Local-first + cross-platform:** Sediment and Cognee are local-first but have no cross-platform harness integration. Mem0, Zep, Hindsight are cross-platform but cloud-first. Nobody provides local-first storage that syncs identity across Claude Code, OpenClaw, Cursor, and others simultaneously.

**2. Agent identity (not just memory):** Every memory solution stores facts. None maintain persistent agent identity — personality files (SOUL.md), behavioral guidelines (AGENTS.md), structured identity metadata (IDENTITY.md), user profiles (USER.md).

**3. Memory extraction pipeline + identity + local storage:** Letta has the deepest memory architecture but requires its runtime. Mem0 has ecosystem reach but is cloud-hosted. Claude Code has auto-memory but is harness-locked. No solution combines LLM-driven extraction, structured memory substrate, retention/repair loops, local-first SQLite, cross-platform connectors, and persistent identity files in one portable layer.

**4. Learned context selection as the endgame:** Many systems compete on storing and retrieving memory better. Far fewer are clearly building toward a model that learns, from real session outcomes, what context should be surfaced automatically and what should count as negative evidence when it does not help.

### Supporting Industry Framing

**Futurum Group:** "Model capability may attract attention, but governance determines deployment."

**LinkedIn 2026 Predictions:** "Agent identity, provenance, and authorization won't be academic ideas, they become table stakes for enterprises adopting agentic-AI."

**Augmented Mind (Substack):** "Whoever controls the memory controls the intelligence."

**Sparkco market analysis:** Agent memory market projected at USD 6.27B in 2025, growing to USD 28.45B by 2030 at 35.32% CAGR. Gartner forecasts 80% of enterprises deploying AI agents by 2026.

### Positioning Matrix

| Capability | Mem0 | Zep | Letta | Hindsight | Cognee | ChatGPT | Claude Code | NemoClaw | **Signet** |
|-----------|------|-----|-------|-----------|--------|---------|-------------|----------|-----------|
| Local-first storage | No | No | Partial | No | Yes | No | Partial | N/A | **Yes** |
| Cross-platform harness | Agnostic | Agnostic | Locked | MCP | Agnostic | Locked | Locked | N/A | **Yes** |
| Agent identity files | No | No | No | No | No | No | CLAUDE.md only | No | **Yes** |
| LLM extraction pipeline | Yes | Yes | Yes | Yes | Yes | Yes | Auto-notes | No | **Yes** |
| Knowledge graph | Pro tier | Yes | Via archival | Yes | Yes | No | No | No | **Yes** |
| Retention decay | No | Temporal | Summarization | Temporal | No | Auto-archive | No | No | **Yes** |
| Session summaries | No | No | Yes | No | No | Chat summaries | No | No | **Yes** |
| Git-synced state | No | No | No | No | No | No | No | No | **Yes** |
| User owns all data | Self-host | No | Self-host | No | Yes | No | Partial | Yes | **Yes** |
| Execution sandboxing | No | No | No | No | No | No | No | **Yes** | No |

**The clearest framing:** every other solution treats memory as an API service or framework feature. Signet treats it as infrastructure that belongs to the user — a home directory for agents where identity, memory, skills, and configuration are portable across harnesses, and where the long-term goal is not just better retrieval but learned context selection.
