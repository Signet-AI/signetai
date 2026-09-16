---
title: "Recall and search"
description: "Search memory with recall, lexical, vector, and similarity routes."
---

All search routes enforce `recall` permission and the resolved agent, visibility,
project, and scope policy before hydrating or reranking content. Deleted,
superseded, stale, and content-safety-ineligible rows are not ordinary recall
context.

### POST /api/memory/recall

Hybrid recall. Body requires `query`; optional fields include `limit`, type/tags,
`who`, `pinned`, `importance_min`, `since`, `time`, `agentId`, `sessionKey`,
`scope`, `aggregate`, `aggregateBudget`, `saveAggregate`, and
`includeRecalled`. The response contains `results`, `query`, `method`, and
`meta`. Result rows may include `id`, `content`, `score`, `source`, metadata,
temporal fields, `supplementary`, and `already_recalled`. `meta` may include
partial/degradation, timings, dedupe, temporal, graph, and aggregate fields.
Aggregate saving additionally requires `remember`.

### GET /api/memory/search

Direct search endpoint. Query parameters and response fields follow the
registered search handler; callers should use `query`, pagination/filter fields,
and `agentId`/scope selectors supported by that handler. It returns a structured
result envelope rather than an HTML page.

### GET /memory/search

Legacy compatibility path for direct memory search. It is distinct from
`GET /api/memory/search`; preserve it only for clients already using that slug.

### GET /memory/similar

Legacy similarity path. It applies the same resolved-agent and visibility policy
and returns similar memory records. It does not authorize access by vector
identity alone.

Recall can fall back to source artifacts and chunks. Those results retain source
provenance and the same content-safety filtering as memory rows. A partial
result is a successful but incomplete response; provider or owner failures are
reported with their registered HTTP error shape.
