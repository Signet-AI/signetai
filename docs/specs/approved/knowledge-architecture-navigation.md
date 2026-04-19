---
title: "Knowledge Architecture Navigation"
status: approved
id: knowledge-architecture-navigation
informed_by:
  - docs/research/technical/RESEARCH-KNOWLEDGE-GRAPH-NAVIGATION.md
  - docs/specs/complete/knowledge-architecture-schema.md
---

Knowledge Architecture Navigation
=================================

## Goal

Expose Signet's structured memory graph as a navigable hierarchy for agents.
Recall should not be the only way to inspect memory. Agents need cheap listing
operations that let them walk from entity to aspect to group to claim to
attributes.

## Mental model

```text
Entity     = house / top-level folder
Aspect     = room / broad domain
Group      = dresser / navigable subgroup
ClaimKey   = drawer / updateable fact slot
Attribute  = note / sourced observation
```

Signet should never treat a room like a drawer. Supersession and precise
inspection happen at the claim slot, optionally scoped by group. Aspects remain
broad organization, not replacement identity.

The default memory pipeline should help navigation mechanically without trying
to author the graph. It may link new memories to known entities, but entities,
aspects, groups, claim keys, attributes, and dependencies are semantic
structure. They should come from structured remember payloads, explicit
agent/user writes, or reviewed normalization passes. Graph reads may be enabled
independently from background extraction graph writes.

## Schema contract

`entity_attributes` gains nullable `group_key TEXT`.

`group_key` is a stable normalized handle for the subgroup inside an aspect.
Examples:

```text
food/restaurants/favorite_restaurant
food/dietary_constraints/shellfish_allergy
music/listening_habits/recent_artists
```

`claim_key` remains the updateable slot. Automatic supersession is scoped to:

```text
entity + aspect + group_key + claim_key
```

Attributes without `group_key` are grouped as `general` in navigation reads for
backward compatibility. They are not rewritten on migration.

## API contract

Navigation reads are exposed under `/api/knowledge/navigation/*`:

```text
GET /api/knowledge/navigation/entities
GET /api/knowledge/navigation/entity?name=Nicholai
GET /api/knowledge/navigation/tree?entity=Nicholai&depth=3
GET /api/knowledge/navigation/aspects?entity=Nicholai
GET /api/knowledge/navigation/groups?entity=Nicholai&aspect=food
GET /api/knowledge/navigation/claims?entity=Nicholai&aspect=food&group=restaurants
GET /api/knowledge/navigation/attributes?entity=Nicholai&aspect=food&group=restaurants&claim=favorite_restaurant
```

The tree endpoint is the agent-friendly overview. It returns a bounded outline
of one entity with aspects, groups, claim slots, counts, and active previews.
`depth=1` stops at aspects, `depth=2` includes groups, and `depth=3` includes
claim slots.

Attribute reads default to active attributes. Passing `status=all` returns active
and historical rows for that claim slot.

## MCP contract

The daemon MCP server exposes matching read tools:

```text
knowledge_tree
knowledge_list_entities
knowledge_get_entity
knowledge_list_aspects
knowledge_list_groups
knowledge_list_claims
knowledge_list_attributes
entity_list
entity_get
entity_aspects
entity_groups
entity_claims
entity_attributes
```

The `knowledge_*` tools are the preferred agent-facing surface because the
names make the domain and traversal order obvious in tool lists. The `entity_*`
tools remain compatibility aliases. Tools return compact JSON summaries and
preserve `agent_id` scoping.

## CLI contract

The CLI exposes the same navigation path under `signet knowledge`:

```text
signet knowledge tree [entity]
signet knowledge entities
signet knowledge entity <name>
signet knowledge aspects <entity>
signet knowledge groups <entity> <aspect>
signet knowledge claims <entity> <aspect> <group>
signet knowledge attributes <entity> <aspect> <group> <claim>
```

Every command supports `--json` and `--agent <name>`. Attribute reads accept
`--status all` for superseded history.

## Success criteria

1. Agents can list entities, aspects, groups, claims, and attributes without
   loading the full constellation graph.
2. Grouped claim navigation works with existing structured remember payloads and
   backwards-compatible ungrouped attributes.
3. Supersession remains scoped and cannot clobber unrelated groups under the
   same aspect.
4. Navigation tools are read-only and safe for regular agent exploration.
5. Agents have an obvious first tool, `knowledge_tree`, for scanning graph
   structure before choosing a narrower list/read operation.
6. Developers have the same affordance in the CLI, so human debugging and agent
   browsing inspect the same daemon endpoints.
7. Default background remember/linking never creates new graph claims from raw
   text; structured remember remains the semantic write path.
8. Developers can inspect graph hygiene with a report-only scan before applying
   any cleanup or normalization.
