---
title: "Knowledge Graph Navigation Interfaces"
question: "How should agents browse large structured memory graphs without dumping the whole graph into context?"
informed_by:
  - "https://github.com/mempalace/mempalace"
  - "https://mempalaceofficial.com/concepts/the-palace"
  - "https://mempalaceofficial.com/reference/mcp-tools"
relevance:
  - knowledge-architecture-navigation
  - knowledge-architecture-schema
---

Knowledge Graph Navigation Interfaces
=====================================

Signet's entity graph is useful only if agents can inspect it deliberately.
Flat recall answers "what might be relevant?" Navigation answers "what is in
this part of the graph?" Large knowledge graphs need both.

MemPalace is a useful reference because it exposes memory as a navigable
palace hierarchy: wings, rooms, halls, tunnels, and drawers. Its docs are clear
that the operational value is predictable scoping and traversal, not magic
retrieval. Its MCP reference exposes list/read tools for wings, rooms, drawers,
and graph traversal rather than requiring a model to search blindly every time.

Signet should preserve its own graph model, but expose the same class of
navigable operations:

```text
knowledge_tree("Nicholai")
entity.list()
entity.get("Nicholai")
entity.aspects("Nicholai")
entity.groups("Nicholai", "food")
entity.claims("Nicholai", "food", "restaurants")
entity.attributes("Nicholai", "food", "restaurants", "favorite_restaurant")
```

The practical hierarchy is:

```text
Entity     house / wing / top-level folder
Aspect     room / broad domain
Group      dresser / navigable subgroup
ClaimKey   drawer / updateable fact slot
Attribute  note / sourced observation
```

The important invariant is that a room is not a drawer. Aspects organize large
areas of an entity's life or structure. They are too broad for supersession and
too large for ergonomic scanning. A group layer gives agents a middle browsing
step before opening specific claim slots.

Design implications:

1. Search remains the way to discover unknown paths.
2. Navigation is the way to inspect known paths.
3. MCP tools should return compact summaries at each layer, with counts and
   previews, so agents can decide when to drill deeper.
4. Attribute reads should default to active/current observations, with an
   explicit way to request superseded history.
5. Group and claim keys are stable machine handles, while display names can be
   layered on later.
6. Tool names should optimize for agent visibility. A tool list should make the
   traversal obvious without requiring the agent to infer that generic
   `entity_*` tools are the knowledge graph browser.

The compact tree view is the bridge between search and stepwise traversal. It
does not replace precise list/read calls, but it gives an agent enough shape to
choose the right aspect, group, and claim slot before spending context on the
full attributes.
