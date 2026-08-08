---
title: "Knowledge and ontology API"
description: "Knowledge navigation, ontology proposal, dreaming, and checkpoint endpoints."
order: 19
section: "Reference"
---

# Knowledge and ontology API

Knowledge navigation, ontology proposal, dreaming, and checkpoint endpoints.

[Back to HTTP API overview](../API.md).

## Knowledge graph navigation

Signet exposes the structured memory graph as a navigable hierarchy for agents.
Search discovers unknown paths; navigation inspects known paths without loading
the full constellation graph.

```text
Entity -> Aspect -> Group -> ClaimKey -> Attributes
```

The house/filesystem analogy is intentional: entities are houses or top-level
folders, aspects are rooms, groups are dressers, claim keys are drawers, and
attributes are notes inside those drawers.

All routes accept optional `agent_id` and default to `default`.

### GET /api/knowledge/navigation/entities

List entities with structural counts. Query parameters: `q`, `type`, `limit`,
`offset`.

### GET /api/knowledge/navigation/entity

Resolve one entity by name.

```text
/api/knowledge/navigation/entity?name=Nicholai
```

### GET /api/knowledge/navigation/tree

Return a compact entity outline for agent browsing. The tree includes aspects,
groups, claim slots, counts, and active previews so agents can decide where to
drill next without loading the full constellation graph. Query parameters:
`entity`, `depth`, `max_aspects`, `max_groups`, `max_claims`.

Depth controls how far the outline expands: `1` returns aspects, `2` returns
aspects and groups, and `3` returns aspects, groups, and claim slots.

```text
/api/knowledge/navigation/tree?entity=Nicholai&depth=3
```

### GET /api/knowledge/navigation/aspects

List aspects for an entity.

```text
/api/knowledge/navigation/aspects?entity=Nicholai
```

### GET /api/knowledge/navigation/groups

List groups under an entity aspect. Attributes without `group_key` appear under
`general` for backward compatibility.

```text
/api/knowledge/navigation/groups?entity=Nicholai&aspect=food
```

### GET /api/knowledge/navigation/claims

List claim slots under an entity/aspect/group path.

```text
/api/knowledge/navigation/claims?entity=Nicholai&aspect=food&group=restaurants
```

### GET /api/knowledge/navigation/attributes

List attributes under an entity/aspect/group/claim path. Defaults to
`status=active`; pass `status=all` to include superseded history. Query
parameters: `entity`, `aspect`, `group`, `claim`, `status`, `kind`, `limit`,
`offset`.

```text
/api/knowledge/navigation/attributes?entity=Nicholai&aspect=food&group=restaurants&claim=favorite_restaurant
```

CLI equivalents:

```bash
signet knowledge tree Nicholai
signet knowledge entities --query Nicholai
signet knowledge entity Nicholai
signet knowledge aspects Nicholai
signet knowledge groups Nicholai food
signet knowledge claims Nicholai food restaurants
signet knowledge attributes Nicholai food restaurants favorite_restaurant
signet knowledge attributes Nicholai food restaurants favorite_restaurant --status all
signet knowledge hygiene
```

### GET /api/knowledge/constellation

Return the bounded graph overlay used by the dashboard Ontology constellation.
Query parameters: `agent_id`, `limit`, `max_aspects_per_entity`,
`max_attributes_per_aspect`, and `dependency_limit`. When `agent_id` is
omitted, the daemon uses the configured daemon agent ID (`SIGNET_AGENT_ID`, or
`default`). The read includes the requested agent plus agents whose
`read_policy` is `shared`, and clamps limits so dashboard navigation cannot
load the entire knowledge graph into one read response.

Defaults: `limit=150`, `max_aspects_per_entity=6`,
`max_attributes_per_aspect=4`, and `dependency_limit=500`.

### GET /api/knowledge/hygiene

Return a report-only graph hygiene scan. Query parameters: `agent_id`, `limit`,
and `memory_limit`.

The response includes suspicious entities, duplicate canonical entity groups,
attribute rows missing `group_key` or `claim_key`, attributes without source
memories, and safe mention-link candidates where an existing entity name appears
in a memory that is not yet linked. This endpoint does not mutate graph data.

MCP exposes the same report as `knowledge_hygiene_report`.

## Entity aliases

Entity aliases are reviewed ontology metadata used by prompt-submit entity
detection and navigation tooling. They do not create duplicate entities. Active
aliases are matched as exact normalized phrases and resolve back to the
canonical entity current view.

### GET /api/ontology/entities/:id/aliases

List aliases for an entity id. Query parameters: `agent_id` and `status`.
`status` may be `active`, `archived`, or `all`; it defaults to `active`.

```text
/api/ontology/entities/entity_signet/aliases?agent_id=ant&status=all
```

### POST /api/ontology/entities/:id/aliases

Create an active alias for an entity id. Body parameters: `alias`,
`confidence`, and `source`. `confidence` is clamped to `0..1` and defaults to
`1.0`.

```json
{
  "alias": "SignetAI",
  "confidence": 0.95,
  "source": "operator"
}
```

### DELETE /api/ontology/entities/:id/aliases/:aliasId

Archive an alias. Archived aliases are retained for inspection but are ignored
by prompt-submit entity matching.

CLI equivalents:

```bash
signet ontology entity alias list entity_signet --status all
signet ontology entity alias add entity_signet SignetAI --confidence 0.95 --source operator
signet ontology entity alias archive entity_signet alias_123
```


## Ontology proposal loop

Ontology maintenance writes reviewable proposals before mutating semantic graph
state. Read routes require `recall`; mutation routes require `modify`. All
routes accept optional `agent_id`.

### GET /api/ontology/proposals

List proposal records. Query parameters: `status`, `operation`, `limit`,
`offset`.

### GET /api/ontology/proposals/:id

Return one ontology proposal by id, scoped to the resolved `agent_id`. Returns
`404` when the proposal does not exist in that agent scope. Use this before
apply/reject flows when an operator needs to inspect the exact operation,
payload, rationale, risk, status, source provenance, and evidence that will be
promoted or rejected.

```text
/api/ontology/proposals/prop_123?agent_id=ant
```

### GET /api/ontology/proposals/conflicts

List pending `add_claim_value` proposal conflicts grouped by claim slot. Query
parameters: `agent_id` and `limit`. Each conflict group includes the entity,
aspect, group, claim key, competing values, and proposal ids so operators can
review contradictory pending proposals before consolidation or apply.

```text
/api/ontology/proposals/conflicts?agent_id=ant&limit=100
```

### GET /api/ontology/proposals/:id/evidence

Resolve a proposal's evidence references against session transcripts and
indexed memory artifacts. The endpoint never reads arbitrary filesystem paths.

### GET /api/ontology/claims/evidence

Resolve evidence for already-applied claim values from stored attribute
provenance. Applied rows include the applying proposal id and copied proposal
evidence when the value was promoted through the proposal loop, so this endpoint
returns exact proposal lineage before broader source fallback evidence. Query
parameters: `entity`, `aspect`, `group`, `claim`, `status`, `kind`, `limit`,
`offset`.

```text
/api/ontology/claims/evidence?entity=Signet&aspect=architecture&group=ontology&claim=proposal_loop
```

### GET /api/ontology/links/:id/evidence

Resolve evidence for an already-applied ontology link from stored dependency
provenance. Links applied through proposals include the applying proposal id and
copied proposal evidence before broader source fallback evidence.

### GET /api/ontology/assertions

List source-attributed epistemic assertions. Assertions record who claimed,
believed, observed, decided, preferred, denied, or questioned something about an
entity without promoting that statement into current ontology truth. Query
parameters: `agent_id`, `entity`, `entity_id`, `predicate`, `status`,
`speaker`, `source_kind`, `source_id`, `query`, `limit`, and `offset`.

Valid predicates are `claims`, `believes`, `observed`, `decided`, `prefers`,
`denies`, and `questions`. Valid statuses are `active`, `archived`,
`superseded`, and `all` for list reads.

```text
/api/ontology/assertions?entity=Signet&predicate=believes&speaker=Nicholai
```

### GET /api/ontology/assertions/:id

Return one epistemic assertion by id, scoped to the resolved `agent_id`.
Returns `404` when the assertion does not exist in that agent scope.

### POST /api/ontology/assertions

Create a source-attributed epistemic assertion. Body parameters: `agent_id`,
`entity` or `entity_id`, `predicate`, `content`, `speaker`, `asserted_at`,
`confidence`, `evidence`, `source_kind`, `source_id`, `source_path`,
`source_root`, `claim_attribute_id`, and `created_by`.

Every assertion must include either structured `evidence` or source provenance
fields. If `claim_attribute_id` is supplied, the referenced applied claim value
must be active and belong to the same agent and subject entity.

### POST /api/ontology/assertions/:id/link-claim

Link an existing assertion to an applied claim attribute. Body parameters:
`agent_id` and `attribute_id`. The daemon rejects cross-agent and cross-entity
links, and it only accepts active claim attribute rows.

### POST /api/ontology/assertions/:id/archive

Archive an assertion without deleting evidence. Body parameters: `agent_id`,
`actor`, and `reason`.

### POST /api/ontology/assertions/:id/supersede

Create a replacement assertion and mark the old assertion `superseded`. Body
parameters match assertion creation plus `agent_id`. Omitting `predicate`
preserves the old assertion predicate; pass a predicate only when the epistemic
meaning is intentionally changing. Omitting source fields inherits source
provenance from the old assertion, but replacement content is still required.
Supersede keeps the old subject entity; use a new assertion when the subject
entity changes.

CLI equivalents:

```bash
signet ontology assertions --entity Signet --predicate believes --speaker Nicholai
signet ontology assertion create --entity Signet --predicate believes --content "Signet should model attributed beliefs." --source-kind transcript
signet ontology assertion show <assertion-id>
signet ontology assertion link-claim <assertion-id> --attribute-id <claim-attribute-id>
signet ontology assertion archive <assertion-id> --reason "superseded by newer evidence"
signet ontology assertion supersede <assertion-id> --content "Updated attributed belief." --source-kind transcript
signet ontology assertion import --file assertions.json
```

### POST /api/ontology/extract

Extract candidate ontology proposals and source-attributed assertions from an
agent-scoped transcript or memory artifact. Body parameters: `from`, `agent_id`,
`write_proposals`, `write_assertions`, `created_by`, `limit`, `use_provider`,
`provider_timeout_ms`, and `provider_max_tokens`. `from` accepts refs such as
`transcript:<id>`, `artifact:<source_path>`, or `source:<source_path>`.

The route dry-runs by default. It writes pending proposals only when
`write_proposals` is true and writes epistemic assertions only when
`write_assertions` is true. If both write flags are set, proposal and assertion
inserts share one transaction and roll back together on invalid extracted
items. When `use_provider` is true, the route uses the configured
`memory_extraction` inference workload and falls back to deterministic
extraction if no valid provider proposals are returned. Provider-returned
`questions` are surfaced in the response for review; this route does not persist
first-class question objects yet.

### POST /api/ontology/consolidate

Consolidate pending ontology proposals into higher-confidence pending proposals.
Body parameters: `agent_id`, `status`, `limit`, `write_proposals`, `created_by`,
`use_provider`, `provider_timeout_ms`, and `provider_max_tokens`. The route
dry-runs by default. Provider-backed consolidation uses the configured
`memory_extraction` inference workload and never mutates ontology state directly;
it writes only pending proposals when `write_proposals` is true.

### POST /api/ontology/proposals

Create one pending ontology proposal.

### POST /api/ontology/proposals/batch

Create multiple pending proposals atomically.

### POST /api/ontology/proposals/:id/apply

Apply one pending proposal through its explicit operation handler.

### POST /api/ontology/proposals/:id/reject

Reject one pending proposal without mutating graph state.

### POST /api/ontology/proposals/repair/duplicates

Detect duplicate same-agent entities and optionally write merge proposals.


## Dreaming

Dreaming is a periodic knowledge-graph consolidation process that uses a
smart model to merge, prune, and enrich the entity graph.

### GET /api/dream/status

Return the current dreaming worker state, configuration, recent passes,
quarantined evidence, and pending agent-scoped semantic attention. Attention
is operational context for work such as due reviews, hygiene, contested claims,
or an explicitly requeued evidence source; it never copies or replaces
episodic evidence. Requires `admin` permission.

**Query parameters**

| Parameter  | Type   | Required | Description                                  |
|------------|--------|----------|----------------------------------------------|
| `agentId`  | string | no       | Agent ID (default: daemon configured agent)  |
| `agent_id` | string | no       | Alias for `agentId`                          |

**Response**

```json
{
  "enabled": true,
  "worker": { "running": true, "active": false, "activeAgentId": null },
  "episodicTokensPending": 42000,
  "state": {
    "tokensSinceLastPass": 42000,
    "lastPassAt": "2026-04-01T12:00:00.000Z",
    "lastPassId": "abc-123",
    "lastPassMode": "incremental"
  },
  "config": {
    "tokenThreshold": 100000,
    "backfillOnFirstRun": true,
    "maxInputTokens": 128000,
    "maxOutputTokens": 16000,
    "timeout": 300000
  },
  "passes": [
    {
      "id": "pass-uuid",
      "mode": "incremental",
      "status": "completed",
      "startedAt": "2026-04-01T12:00:00.000Z",
      "completedAt": "2026-04-01T12:05:00.000Z",
      "tokensConsumed": 8000,
      "mutationsApplied": 12,
      "mutationsSkipped": 3,
      "mutationsFailed": 1,
      "summary": "Merged 3 duplicate entities, pruned 5 junk attributes",
      "error": null
    }
  ],
  "exclusions": [
    {
      "sourceKind": "artifact",
      "sourceId": "sources/notebook/large-export.md",
      "reason": "semantic_operation_rejected",
      "passId": "pass-uuid",
      "excludedAt": "2026-04-01 12:00:00",
      "requeueRequestedAt": null,
      "resolvedAt": null
    }
  ],
  "attention": [
    {
      "id": "attention-uuid",
      "kind": "review_due",
      "subjectRef": "entity:aster",
      "details": { "reason": "review_after reached" },
      "priority": 90,
      "createdAt": "2026-04-01 12:00:00"
    }
  ]
}
```

An exclusion preserves only the source identity and processing status; it does
not modify or discard the underlying episodic evidence. Current Dreaming passes
record `semantic_operation_rejected` when the daemon rejects an agent's cited
semantic operation. Oversized immutable evidence is instead resumed at a safe
boundary across passes and is not quarantined.

An attention item is selected with the next scoped pass and rendered as
non-evidentiary context. It resolves when the pass applies a hygiene operation
citing it, or when the agent explicitly declines it (the `decline_attention`
operation, used when the agent inspects the target and judges it should stay as
is). Records the agent could not complete stay pending, and a failed pass
leaves everything pending. The worker can run for pending attention even
when no new episodic evidence has arrived, while normal failure backoff still
applies.

### POST /api/dream/exclusions/requeue

Request one quarantined evidence source be considered again after correcting
the model or configuration issue that caused a rejected semantic operation.
Requires `admin` permission.

**Request body**

```json
{
  "sourceKind": "artifact",
  "sourceId": "sources/notebook/large-export.md",
  "agentId": "noam"
}
```

`sourceKind` must be one of `memory`, `artifact`, `transcript`, or `summary`.
`sourceId` is the identifier returned by `GET /api/dream/status`. `agentId`
uses the same scoped-agent resolution as Dreaming trigger requests.

Returns `404` when the scoped exclusion is no longer active.
Requeueing also records an `evidence_requeue` attention item, so it can wake a
scoped Dreaming pass without waiting for unrelated new evidence.

### POST /api/dream/operations

Apply a batch of cited ontology operations for an external Dreaming agent.
Requires `modify` permission. This is the daemon-owned semantic apply seam:
the caller supplies operations and evidence, but the daemon resolves every
episodic source in the credential's agent scope before it writes graph state.

**Request body**

```json
{
  "agentId": "noam",
  "actor": "dreaming-agent",
  "operations": [
    {
      "operation": "set_claim_value",
      "payload": { "entityId": "entity-id", "aspect": "role", "value": "Engineer" },
      "reason": "The cited note explicitly identifies this role.",
      "evidence": [{ "sourceKind": "artifact", "sourceId": "note.md", "quote": "..." }],
      "confidence": 0.9
    }
  ]
}
```

`operations` must be non-empty. Each entry must use one of the same closed,
payload-validated ontology operation schemas exposed by `apply_ontology_ops`
from `GET /api/dream/tools`; a write requires a canonical episodic source and
an exact supporting quote. The response is `200` for a fully accepted batch or
`400` with structured rejection details. `agentId` uses scoped-agent
resolution and cannot cross the credential's agent scope.

### GET /api/dream/passes/:passId/tools

Return the local, ordered Pi capability trace for one Dreaming pass: every
tool's input, output, success result, and latency. The route is agent-scoped
and requires `admin` permission. It is intended for reviewing whether the
agent searched graph or episodic evidence before proposing semantic writes.

### GET /api/dream/quality

Return deterministic, agent-scoped semantic quality measures for the current
Dreaming graph. `citationCoverage` counts active claim values that retain an
exact quote in canonical proposal evidence plus a resolvable episodic source;
a source pointer without a quote is not citation coverage. `graphGarbageRate` applies the shared
entity-quality classifier and detects possessive duplicates, excluding
source-native topology. `structureQuality` reports the unknown entity-type
rate, exact `profile` aspect rate, and generic-aspect rate (`profile`,
`details`, `general`, and `information`) for model-ablation comparisons.
Requires `admin` permission.

### GET /api/dream/tools

List the canonical Dreaming capability registry, including each capability's
JSON Schema. Pi sessions, restricted Dreaming MCP, and `signet dream` bind
this same registry; clients must not reproduce a separate tool list. Requires
`modify` permission.

### POST /api/dream/tools/:capability

Invoke one canonical Dreaming capability through the daemon. This is the
transport binding for restricted MCP and shell-driven harnesses; the daemon
validates the registry schema and pins all reads and writes to the credential's
agent scope. Requires `modify` permission.

**Request body**

```json
{
  "agentId": "noam",
  "input": { "query": "deployment target" }
}
```

`input` must satisfy the selected capability's schema from `GET /api/dream/tools`.
For example, `search_entities` accepts `query`, `type`, `limit`, and `offset`;
`apply_ontology_ops` accepts a cited `operations` batch. Its schema is a
closed union of the 19 audited ontology operations and each operation's
payload fields, so clients can validate an operation before attempting a
write. `check_entity_label`, `find_duplicate_entities`, and
`check_contradiction` expose the daemon's read-only deterministic guards so a
reasoner can consult them before proposing a write; cited operation validation
and semantic writes remain daemon-owned. The request body cannot supply a
second agent scope inside `input`. `runbook_read` returns recent scoped pass
outcomes, applied/rejected operations, evidence windows, unresolved
quarantines, and notes; `runbook_write` stores one short structured note on a
currently running pass. CLI callers supply that pass with `--pass-id`; the Pi
and restricted ACPX bindings receive it from the daemon-owned pass context.

### POST /api/dream/trigger

Manually trigger a dreaming pass. Requires `admin` permission.
Returns `202 Accepted` immediately and runs the pass in the background
(passes can take up to several minutes on large graphs).
Returns 409 if a pass is already running. Returns 503 if the
dreaming worker is not started.

Poll `GET /api/dream/status` and check `passes[0].status` for completion.

**Request body**

```json
{
  "mode": "incremental",
  "agentId": "noam"
}
```

`mode` is `"incremental"` (default) or `"compact"`. `agentId` is optional
and defaults to the daemon configured agent; `agent_id`, the `agentId` query
parameter, the `agent_id` query parameter, and `x-signet-agent-id` are also
accepted.

Explicit triggers always run the combined `incremental` runbook (hygiene
queue first, then content ingestion). The worker's scheduled sweep passes,
in contrast, alternate between two focused runbooks when both kinds of work
are pending — `incremental-hygiene` (attention queue only) and
`incremental-content` (new evidence only) — so content ingestion gets a
guaranteed turn even while the hygiene queue stays full (#1098). The pass
row's `mode` column and the status response's `state.lastPassMode` record
the runbook that actually ran.

**Response** — `202 Accepted`

```json
{
  "accepted": true,
  "passId": "pass-uuid",
  "status": "running",
  "mode": "incremental",
  "agentId": "noam"
}
```


## Checkpoints

Session checkpoints track continuity state at compaction boundaries.

### GET /api/checkpoints

List session checkpoints for a project.

**Query parameters**

| Parameter | Type   | Required | Description                          |
|-----------|--------|----------|--------------------------------------|
| `project` | string | yes      | Project path to filter by            |
| `limit`   | integer | no      | Max results (default: 10, max: 100)  |

**Response**

```json
{
  "checkpoints": [
    {
      "session_key": "abc-123",
      "project": "/path/to/project",
      "trigger": "periodic",
      "created_at": "2026-02-21T10:00:00.000Z"
    }
  ],
  "count": 1
}
```

### GET /api/checkpoints/:sessionKey

Get all checkpoints for a specific session.

**Response**

```json
{
  "checkpoints": [ ... ],
  "count": 3
}
```
