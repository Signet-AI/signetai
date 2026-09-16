---
title: "Knowledge and ontology API"
description: "Knowledge navigation, ontology proposals, claims, assertions, and dreaming."
---

[Back to HTTP API](/api/).

## Knowledge navigation

Canonical read routes include `/api/knowledge/entities`,
`/api/knowledge/navigation/*`,
`/api/knowledge/entities/:id`, `/api/knowledge/entities/:id/aspects`,
`/api/knowledge/entities/:id/dependencies`, `/api/knowledge/entities/pinned`,
`/api/knowledge/communities`, `/api/knowledge/constellation`,
`/api/knowledge/stats`, and `/api/knowledge/traversal/status`. Pin/unpin and
expand routes are mutations and require their registered knowledge permissions.

## Ontology

| Family | Operations |
|---|---|
| `/api/ontology/proposals` | list, create, inspect, apply, reject, batch, conflicts, repair |
| `/api/ontology/claims/*` | evidence, versions, explain, version |
| `/api/ontology/assertions` | list, inspect, create, link claim, archive, supersede |
| `/api/ontology/contradictions` | list and inspect |
| `/api/ontology/links` | evidence |
| `/api/ontology/operations` | apply and batch |
| `/api/ontology/extract` and `/api/ontology/consolidate` | canonical mutations |

Reads and mutations are separately guarded. Proposal and ontology operations
are canonical; response fields and allowed operation names come from the route
types. Knowledge expansion is exposed separately at `POST /api/knowledge/expand`
and `POST /api/knowledge/expand/session`.
