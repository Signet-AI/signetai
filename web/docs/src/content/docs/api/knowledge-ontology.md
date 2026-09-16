---
title: "Knowledge and ontology API"
description: "Scoped evidence, ontology state, proposals, and Dreaming control."
---

[Back to HTTP API](/api/).

## Ontology contract

Ontology reads and writes are scoped to the authenticated agent. Pass `agent_id` only when authorized. Route guards and route types define complete response shapes.

| Method | Route | Contract |
|---|---|---|
| GET | `/api/ontology/proposals`, `/api/ontology/proposals/:id` | List or inspect proposals; `status` is validated. |
| POST | `/api/ontology/proposals` | Create a proposal from cited evidence. |
| POST | `/api/ontology/proposals/batch` | Submit a bounded proposal batch with per-item outcomes. |
| POST | `/api/ontology/proposals/:id/apply`, `/reject` | Apply or reject one proposal. |
| GET | `/api/ontology/proposals/:id/evidence`, `/api/ontology/claims/evidence`, `/api/ontology/links/:id/evidence` | Inspect source-backed evidence and lineage. |
| POST | `/api/ontology/operations/apply`, `/batch` | Apply one or a bounded batch of ontology operations. |
| GET/POST | `/api/ontology/assertions` and `/:id/*` | Read, create, link claims, archive, and supersede assertions. |

Evidence is source-backed and scoped. Batch endpoints report per-item outcomes;
do not assume every item applied atomically. Proposal and operation responses
expose status, conflicts, and validation errors.

`POST /api/ontology/extract` is a **current, canonical** route. It requires
`from` and can dry-run or explicitly write bounded proposals and/or assertions;
provider-backed extraction is opt-in with `use_provider`. It is an operator/API
seam for the ontology extraction service, not a client-side extraction worker or
a replacement for Dreaming. `POST /api/ontology/consolidate` is likewise a
current, explicit proposal-consolidation seam. See [memory write lifecycle](/api/memory/write-lifecycle/).

## Dreaming observation and control

Dreaming is the sole automatic writer of semantic truth for eligible,
source-backed episodic evidence. Its API is evidence-first and scoped to the
authenticated agent:

- `GET /api/dream/status` returns worker state, configuration, passes,
  exclusions, reviewed evidence, attention, and the cached episodic backlog.
- `GET /api/dream/passes/active` lists active passes. `GET
  /api/dream/passes/:passId/events` is a read-only SSE stream; it sends an
  initial snapshot, optional replay, live events, and a terminal event.
- The events stream accepts `after=<non-negative integer>` or the
  `Last-Event-ID` header. `after` takes precedence. Snapshot and gap frames do
  not advance the resume cursor; only replay/live event IDs do. `verbose=1`
  (or `true`) opts into the verbose event view.
- `GET /api/dream/passes/:passId/tools` audits capability calls for a scoped
  pass. `GET /api/dream/quality` returns deterministic quality measures.
- `GET /api/dream/tools` returns the capability manifest. `POST
  /api/dream/tools/:capability` invokes one manifest-declared capability.
- `POST /api/dream/operations` is the external apply seam. Each write must
  carry a canonical episodic source reference, an exact quote, and evidence.
- `POST /api/dream/trigger` starts a bounded incremental or compact pass and
  returns `202` with `status: "running"` and a `passId`.
- `POST /api/dream/exclusions/requeue` requeues scoped evidence exclusions.
  Summary requeue is retired (`410`); requeue the completed transcript instead.

`/api/dream/operations`, `/api/dream/tools`, and
`/api/dream/tools/:capability` use the `modify` permission. Status, pass,
quality, trigger, and exclusion routes use the `admin` permission. Retired
extraction and synthesis publishers are not part of this API.
