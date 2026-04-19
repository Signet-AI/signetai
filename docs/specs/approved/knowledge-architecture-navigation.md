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
GET /api/knowledge/navigation/aspects?entity=Nicholai
GET /api/knowledge/navigation/groups?entity=Nicholai&aspect=food
GET /api/knowledge/navigation/claims?entity=Nicholai&aspect=food&group=restaurants
GET /api/knowledge/navigation/attributes?entity=Nicholai&aspect=food&group=restaurants&claim=favorite_restaurant
```

Attribute reads default to active attributes. Passing `status=all` returns active
and historical rows for that claim slot.

## MCP contract

The daemon MCP server exposes matching read tools:

```text
entity_list
entity_get
entity_aspects
entity_groups
entity_claims
entity_attributes
```

Tools return compact JSON summaries and preserve `agent_id` scoping.

## Success criteria

1. Agents can list entities, aspects, groups, claims, and attributes without
   loading the full constellation graph.
2. Grouped claim navigation works with existing structured remember payloads and
   backwards-compatible ungrouped attributes.
3. Supersession remains scoped and cannot clobber unrelated groups under the
   same aspect.
4. Navigation tools are read-only and safe for regular agent exploration.
