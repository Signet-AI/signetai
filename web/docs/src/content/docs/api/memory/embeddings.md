---
title: "Memory embeddings"
description: "Inspect embedding records, provider status, health, and projections."
---

Embedding inspection routes require `recall` permission and resolved-agent
scope. Vector data is derived state; memory/source rows remain authoritative.

### GET /api/embeddings

Lists stored embedding records with parent metadata. Query supports `limit`,
`offset`, and `vectors`; vectors are omitted unless explicitly requested. The
response envelope contains `embeddings`, `count`, `total`, `limit`, `offset`,
and `hasMore`. Records identify their source type and source ID, model/profile
metadata, dimensions, and timestamps when available.

### GET /api/embeddings/status

Reports configured provider availability and embedding-index coverage. The
response includes provider/model configuration, `available`, dimensions,
`checkedAt`, and `index` state/coverage. Provider failures include `error` and
are not reported as ready.

### GET /api/embeddings/health

Returns provider and embedding-index health metrics, including coverage and
staleness fields exposed by the handler.

### GET /api/embeddings/projection

Returns a cached server-computed projection. Query `dimensions` selects the
registered 2D or 3D output. A ready response contains `status`, `dimensions`,
`count`, `total`, `nodes`, `edges`, and cache metadata. While computation is
pending, the route returns `202` with `status: "computing"` and no fabricated
coordinates.

Embedding and source-index jobs may remain pending when the provider is
unavailable. The status/health routes expose that degraded state; callers must
not infer that missing vectors are zero vectors.
