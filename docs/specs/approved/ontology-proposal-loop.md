---
title: "Ontology Proposal Loop"
id: ontology-proposal-loop
status: approved
informed_by:
  - "docs/research/technical/RESEARCH-ONTOLOGY-EVOLUTION.md"
  - "docs/specs/complete/memory-md-rolling-window-lineage.md"
  - "docs/specs/approved/dreaming-memory-consolidation.md"
  - "docs/specs/approved/model-provider-router.md"
section: "Knowledge Architecture"
depends_on:
  - "knowledge-architecture-schema"
  - "memory-md-rolling-window-lineage"
soft_depends_on:
  - "model-provider-router"
  - "dreaming-memory-consolidation"
success_criteria:
  - "Extraction and consolidation can persist proposed ontology operations without mutating ontology state"
  - "Operators and agents can list, inspect, apply, and reject proposals through daemon API and CLI surfaces"
  - "Applied proposals and direct applied operations record audit metadata and mutate ontology state only through explicit operation handlers"
  - "All proposal reads and writes are agent-scoped and preserve evidence references for later lineage inspection"
scope_boundary: "Defines the first reviewable mutation loop for ontology maintenance and the shared operation handlers used by direct applied maintenance paths. It does not define the full object-type/interface ontology, node-graph UI, or ACPX provider backend."
---

# Ontology Proposal Loop

## Problem

Signet already has entities, aspects, grouped claim slots, dependencies,
source-backed artifacts, and graph traversal. The missing first-class object is
the reviewable semantic proposal: a durable record that says, "based on this
evidence, here is an ontology change worth making."

Without proposal objects and audited operation handlers, extraction and
consolidation have only two bad choices:

1. write directly into ontology state and risk promoting weak evidence into
   truth; or
2. stay read-only and never complete the maintenance loop.

The proposal loop gives Signet a middle path. Agents can reason over
transcripts and source artifacts, emit candidate ontology operations, inspect
them, and apply or reject them explicitly. The same operation handlers are
also the allowed path for direct dreaming promotion when evidence is explicit
enough to skip a pending review queue.

## Goals

1. Make reviewable ontology maintenance proposal-first instead of ad hoc
   writes.
2. Keep the daemon responsible for durable storage, agent scoping, API
   contracts, and explicit mutation application.
3. Keep inference providers and harness-backed reasoning outside this first
   storage contract.
4. Preserve provenance references so every accepted semantic change can be
   traced back to source evidence.
5. Keep everyday recall and remember paths unchanged.

## Non-goals

- No full object-type or interface system in this slice.
- No node-graph dashboard UI in this slice.
- No ACPX execution backend in this slice.
- No automatic hidden consolidation worker that directly mutates ontology
  state.
- No broad rewrite of the existing knowledge graph schema.

## Proposal model

An ontology proposal is a durable, agent-scoped operation record:

```text
ontology_proposals
  id
  agent_id
  operation
  status
  payload
  confidence
  rationale
  evidence
  risk
  source_kind/source_id/source_path/source_root
  created_by
  applied_by/rejected_by
  result
  created_at/updated_at/applied_at/rejected_at
```

`payload`, `evidence`, and `result` are JSON strings at the database layer.
The API returns parsed objects.

When an operation promotes a claim value or link into the existing graph, the
applied `entity_attributes` or `entity_dependencies` row stores the applying
`proposal_id` plus copied `proposal_evidence`. Applied evidence reads resolve
that proposal lineage first, then fall back to the broader source provenance
columns. This keeps proposal review auditable after semantic promotion.

Allowed status values:

```text
pending -> applied
pending -> rejected
pending -> failed
```

Applied and rejected proposals are immutable except for future audit-only
repair metadata.

## Initial operation handlers

The first implementation supports a small, safe set:

- `create_entity`
- `merge_entities`
- `add_claim_value`
- `set_claim_value`
- `supersede_claim_value`
- `create_link`

Unsupported operations may still be stored as pending proposals, but applying
them returns a clear failure until a handler is added. This lets extraction and
consolidation produce forward-looking proposals without forcing every operation
to ship at once.

`create_link` accepts the existing graph dependency roles plus the first
ontology-facing semantic roles used by extraction: `contains`, `contains_note`,
`produced_artifact`, `supports_claim`, `authored_by`,
`requires_approval_from`, `links_to`, `owns`, `maintains`, `implements`, and
`may_execute`.

## API contract

```text
GET  /api/ontology/proposals
GET  /api/ontology/proposals/conflicts
GET  /api/ontology/proposals/:id
GET  /api/ontology/proposals/:id/evidence
GET  /api/ontology/claims/evidence
GET  /api/ontology/links/:id/evidence
POST /api/ontology/extract
POST /api/ontology/consolidate
POST /api/ontology/proposals
POST /api/ontology/proposals/batch
POST /api/ontology/proposals/repair/duplicates
POST /api/ontology/proposals/:id/apply
POST /api/ontology/proposals/:id/reject
POST /api/ontology/operations/batch
POST /api/dream/promote
```

Read routes require recall permission. Mutation routes require modify
permission. All routes take `agent_id` and default to the current/default agent
scope when absent.

`repair/duplicates` is deterministic and proposal-first. It scans same-agent
entities for duplicate `canonical_name` values, picks the strongest existing
entity as the merge target, and returns candidate `merge_entities` operations.
It writes pending proposals only when `write_proposals` is true.

`/api/dream/promote` is a direct applied maintenance path for the dreaming
skill. It reads memories, memory artifacts, and transcripts as evidence and
emits `set_claim_value` operations. The default non-provider path only
mechanically promotes natural-language statements from confidence-bearing memory
rows; artifacts and transcripts can provide structured operation JSON for
preview, but raw source JSON cannot self-attest confidence for direct apply.
Plain prose in artifacts or transcripts requires provider extraction or the
proposal review path. The default mode is dry-run. When `apply` is true, the
route uses the same audited operation handlers and stores applied lineage, but it
does not create pending proposal work items.

## CLI contract

```text
signet ontology proposals
signet ontology proposal <id>
signet ontology objects --type source
signet ontology object <id>
signet ontology object "Signet" --name
signet ontology links <object-id> --direction outgoing
signet ontology claims <entity> <aspect> <group>
signet ontology conflicts
signet ontology evidence <id>
signet ontology claim-evidence <entity> <aspect> <group> <claim>
signet ontology link-evidence <link-id>
signet ontology extract --from transcript:<id> --dry-run
signet ontology extract --from transcript:<id> --use-provider --dry-run
signet ontology extract --from transcript:<id> --write-proposals
signet ontology consolidate --proposals pending --use-provider --dry-run
signet ontology consolidate --proposals pending --use-provider --write-proposals
signet ontology propose --operation add_claim_value --payload-file proposal.json
signet ontology import-proposals --file extraction-output.json
signet ontology repair --duplicates --dry-run
signet ontology repair --duplicates --write-proposals
signet ontology apply <id>
signet ontology reject <id> --reason "weak evidence"
signet dream promote --from all
signet dream promote --from all --apply
```

The CLI is a thin wrapper over the daemon API. It should not apply ontology
changes locally.

The initial object, link, and claim inspection commands are aliases over the
existing knowledge navigation APIs. They intentionally use ontology vocabulary
without introducing a second read model before typed object interfaces exist.

`import-proposals` accepts either explicit proposal JSON:

```json
{
  "proposals": [
    {
      "operation": "add_claim_value",
      "payload": {
        "entity": "Signet",
        "aspect": "architecture",
        "claim_key": "proposal_loop",
        "value": "Extraction emits proposals before mutation."
      }
    }
  ]
}
```

or the extraction-output shape from this spec's prompt examples
(`entities`, `claim_values`, `links`, and `actions_or_policies`). Importing
only creates pending proposals. It does not apply them. Dreaming promotion is
intentionally separate: it previews direct operations by default and only
applies them when called with `--apply`.

Provider extraction may also return `questions`. This slice surfaces those
questions in the extraction result for operator or later stronger-model review;
it does not yet create durable `Question` ontology objects.

## Integration contracts

### Knowledge architecture

Proposal application uses existing graph tables:

- `entities`
- `entity_aspects`
- `entity_attributes`
- `entity_dependencies`

Every operation handler must preserve `agent_id` scoping and must not hardcode
`default` below the route boundary.

This slice intentionally stops at the proposal layer. `Observation` is still
represented by proposal drafts and evidence refs, and reducer policy is still
implicit in proposal status plus supersession handlers. A future claim-slot
lifecycle should make `Observation`, `ClaimSlot`, `ClaimValue`, `Reducer`, and
`Question` first-class without changing the review-before-mutation rule here.

### Transcript and source artifacts

Proposals may reference source evidence through `evidence` and optional
`source_*` columns. The proposal table does not own transcript or source
artifact content. Raw artifacts remain the source of truth.

### Dreaming memory consolidation

Dreaming and future consolidation passes should emit proposals first. Direct
graph mutation remains a compatibility path, not the preferred architecture for
high-impact semantic maintenance.

### Model provider router

This spec does not require new provider routes. Future extraction and
consolidation commands should request capabilities through the shared inference
router rather than binding directly to a vendor or harness.

## Rollout

### Phase 1

- Add proposal storage and types.
- Add daemon CRUD/apply/reject routes.
- Add CLI wrappers.
- Support `create_entity`, `merge_entities`, `add_claim_value`, and
  `create_link`.
- `merge_entities` requires an explicit target entity and one or more source
  entities in the same agent scope.
- Support `supersede_claim_value` so reviewed maintenance can retire stale
  claim values without deleting their provenance.
- Support batch proposal creation so extractor/consolidator JSON can become
  durable pending proposals without direct ontology mutation.
- Support transcript and artifact extraction into candidate proposals, with
  dry-run as the default and explicit `write_proposals` for persistence.
- Support opt-in provider-backed extraction through the configured
  `memory_extraction` inference workload, with deterministic extraction as the
  safe fallback when no provider proposals parse.
- Support provider-backed consolidation over pending proposals, producing new
  pending proposals rather than directly mutating the ontology.
- Support proposal evidence lookup for embedded quotes, session transcripts,
  and indexed memory artifacts.
- Support applied claim evidence lookup so accepted claim values remain
  traceable after proposal application.
- Support applied link evidence lookup so accepted semantic edges remain
  traceable after proposal application.
- Support pending proposal conflict inspection for claim slots with competing
  values before any proposal is applied.
- Support deterministic duplicate-entity repair candidates that can be previewed
  as dry-run merge proposals or persisted as pending `merge_entities`
  proposals.

### Phase 2

- Add extractor and consolidator commands that write proposals from transcripts
  and source artifacts.
- Add stronger evidence lookup helpers.
- Add orphan repair, stale-claim pruning, and broader maintenance proposal
  handlers.

### Phase 3

- Add dashboard/node-graph review surface.
- Add MCP maintenance tool pack behind explicit loading.
- Add ACPX as a provider backend through the unified inference registry.

## Validation

- Migration is idempotent and creates `ontology_proposals`.
- Proposal list/detail endpoints are agent-scoped.
- Applying `add_claim_value` creates or reuses the entity/aspect and writes a
  grouped claim value with confidence, importance, and provenance.
- Applying `merge_entities` moves source aspects and edges to the explicit
  target entity, then deletes the duplicate source entity.
- Applying `supersede_claim_value` marks the old active value as superseded and
  optionally creates a new active replacement with provenance.
- Rejection records reviewer metadata without mutating graph state.
- Auth guard tests cover new ontology proposal routes.
- Evidence lookup resolves transcript and source artifact references without
  reading arbitrary filesystem paths.
- Extraction loads agent-scoped transcript/artifact rows, emits candidates by
  parsing explicit extraction JSON and conservative mechanical transcript
  signals, and writes pending proposals only when explicitly requested.
- Provider-backed extraction is opt-in from the CLI/API, returns provider mode
  and warnings in the response, and does not mutate ontology state unless
  `write_proposals` is set.
- Provider-backed consolidation reads pending proposal batches and conflicts,
  returns summary/rejection/conflict/maintenance notes, and writes only pending
  proposals when explicitly requested.
- Applied claim evidence lookup resolves stored attribute provenance and memory
  references without reading arbitrary filesystem paths.
- Applied link evidence lookup resolves stored dependency provenance without
  reading arbitrary filesystem paths.
- Conflict lookup groups pending `add_claim_value` proposals by
  entity/aspect/group/claim slot and reports only slots with competing values.
- Duplicate repair lookup detects same-agent duplicate canonical entity names
  without writing graph state unless pending proposals are explicitly requested.
