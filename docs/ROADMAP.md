---
title: "Roadmap"
description: "Current focus and planned features."
order: 25
section: "Project"
---

Roadmap
===

Public roadmap for Signet, updated manually as priorities shift. For
detailed history, see CHANGELOG.md. For the internal spec build
sequence, see [Spec Index](./specs/INDEX.md).

Status markers: `[done]` shipped, `[wip]` in progress, `[next]` planned,
`[idea]` exploring.


Current Focus (0.71.x)
---

- [wip] Desire Paths Phase 4 — path-level feedback propagation, traversal
  path scoring (evolves predictor from ranking memories to ranking paths)
- [wip] Procedural memory P2–P5 — usage tracking, implicit relation
  computation, retrieval and suggestion endpoints, dashboard visualization
- [wip] Multi-agent support — multiple agent identities per daemon,
  shared skills pool, fully scoped memory isolation
- [wip] Signet Runtime — standalone runtime channel independent of
  harness-specific connectors


Planned
---

- [next] Desire Paths Phase 5 — explorer bees, cross-entity boundary
  traversal, discovered principles, entity health dashboard
- [next] Cryptographic identity and trust layer — portable agent
  identity, verification, and encrypted sync
- [next] Agent branching — version-control-like identity branching
  and merging across parallel sessions
- [next] Gemini CLI connector — platform adapter


Exploring
---

- [idea] Agent marketplace — discover and hire other Signet agents
- [idea] Mobile companion — lightweight agent presence on mobile devices
- [idea] Collaborative memory — shared memory pools across agent teams
- [idea] Federated predictor — anonymized community training signals
  for cold-start improvement


Recently Shipped
---

- [done] 0.71.0 — Desire Paths Phase 3 complete: traversal-primary
  retrieval, prospective indexing (hypothetical query hints at write
  time), cosine re-scoring, scoped vector search with 2x over-fetch
- [done] 0.70.x — Predictive memory scorer integration: sidecar,
  training pairs, comparison reporting, and default config enablement
- [done] 0.69.x — Knowledge Architecture KA-1 through KA-6: entity/
  aspect/attribute schema, graph traversal, behavioral feedback loop,
  entity pinning, constraint surfacing
- [done] 0.68.x — Desire Paths Phase 1–2: significance gate, edge
  confidence, bounded traversal, MCP tool registration, Leiden community
  detection
- [done] 0.67.x — Session continuity: checkpoint-based recovery,
  structural snapshots, 2000-char recovery budget
- [done] 0.66.x — ClawHub marketplace integration, skills.sh aggregation
- [done] 0.65.x — Codex connector
- [done] 0.64.x — OpenClaw runtime plugin, NemoClaw compatibility
- [done] 0.63.x — Memory Pipeline V2: LLM-based extraction, knowledge
  graph, retention decay, document ingest
