---
title: "Persisted Ontology Contradiction State"
id: ontology-contradiction-state
status: approved
informed_by:
  - "docs/specs/complete/knowledge-architecture-schema.md"
  - "docs/specs/approved/ontology-proposal-loop.md"
  - "docs/specs/approved/dreaming-memory-consolidation.md"
section: "Knowledge Architecture"
depends_on:
  - "knowledge-architecture-schema"
  - "ontology-proposal-loop"
soft_depends_on:
  - "dreaming-memory-consolidation"
success_criteria:
  - "High-signal competing claim values persist one agent-scoped contradiction observation with both claim ids, content snapshots, provenance, and evidence references"
  - "Contradiction reads expose active conflicts without selecting a competing truth value or changing current-claim governance"
  - "Supersession, archival, restoration, and source deletion reconcile active contradiction state while retaining the resolved observation"
  - "Different source provenance remains visible and contradictory observations cannot cross agent scope"
  - "A bounded deterministic evaluation covers a claim followed by its negation, source removal, and agent isolation"
scope_boundary: "Persists and exposes deterministic contradiction observations between active non-constraint claim values in one entity/aspect/group/claim slot. It does not rank sources, replace proposal review, infer semantic contradictions through a new provider call, or create contradiction entities/edges in the navigable graph."
---

# Persisted Ontology Contradiction State

## Problem

Signet already has two useful protections around competing claims:

- the ontology apply path preserves claim versioning, proposal audit, source
  provenance, and explicit supersession; and
- Dreaming can run a conservative lexical contradiction guard before it writes.

The guard is transient, however. Once two active claim values are present,
there is no durable answer to “what evidence conflicts?” and no state that can
be re-evaluated when a source-backed claim is removed. Pending proposal
conflicts are not sufficient because applied claims are the rows used by
recall.

## Decision

Add an `ontology_contradictions` table as a derived observation ledger. A row
links two active `entity_attributes` claim values in the same agent-scoped
entity/aspect/group/claim slot and records:

- stable claim ids plus immutable content snapshots;
- confidence, memory scope/visibility, source provenance, and copied proposal
  evidence for both sides;
- the detector and bounded reason; and
- `active` or `resolved` lifecycle state with resolution metadata.

Attribute ids are soft links. A source purge may remove the claim row, but the
resolved contradiction observation remains queryable with its captured
provenance and evidence references. A later reappearance of the same claim
pair may reactivate its observation with current snapshots.

The first implementation persists only the existing deterministic lexical
guard (`negation_mismatch` and the supported antonym pairs). It requires
lexical overlap and excludes constraints. It does not call an inference
provider, turn a contradiction into a `contradicts` graph edge, or add a new
entity. This keeps graph noise and inference cost bounded while leaving the
record shape ready for future explicitly labeled detectors.

Signet has no normalized source-authority ranking contract in the current
schema. Source kind/id/path/root, confidence, scope, and visibility remain
visible on both sides so callers can compare differently authoritative or
scoped evidence without the contradiction ledger silently choosing a winner.

## Governance and answer semantics

Contradiction state is advisory evidence about competing observations, not a
third truth value. Both claims retain their normal attribute status and
proposal lineage. `set_claim_value`, explicit `supersede_claim_value`, archive,
restore, and current-claim reads continue to use the existing governance rules.
The contradiction endpoint lets a caller answer that evidence conflicts and
inspect both sides; it never chooses a winner based on source kind or
confidence.

Active state requires both claim rows to remain active, remain in the same
slot, and continue to satisfy the deterministic detector. Supersession,
archival, claim deletion, source purge, or a changed claim resolves the row.
Resolved observations are retained for audit and are hidden from the default
active list.

## API and CLI

```text
GET /api/ontology/contradictions
GET /api/ontology/contradictions/:id
signet ontology contradictions
```

Reads are recall-authorized and always agent-scoped. The list supports active,
resolved, or all state plus entity, aspect, group, claim, source, and bounded
pagination filters. The response includes both claim values and each side's
provenance/evidence references.

## Lifecycle integration

Contradiction creation is part of the audited ontology apply transaction for
`add_claim_value` and the source-backed graph indexers that write claim rows
directly. Reconciliation runs after every ontology operation and after
source-owned graph purge paths. It is idempotent: the same pair produces one
observation, and refreshing a source updates only the derived snapshot while
resolving or reactivating it does not rewrite source evidence rows.

## Evaluation contract

The regression/evaluation fixture must prove:

1. an active claim followed by a negated claim creates one active observation;
2. the observation includes both claim ids, both source references, and the
   exact competing content;
3. replacing or removing one claim resolves the observation without deleting
   its snapshot;
4. identical values in another agent scope do not appear in the first scope;
5. normal claim reads still expose current-claim state rather than treating
   contradiction as a competing value.

The evaluation is deterministic and does not require an LLM or external source
provider.
