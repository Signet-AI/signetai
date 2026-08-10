---
title: "Authorized Claim Trace"
id: authorized-claim-trace
status: approved
informed_by:
  - "docs/specs/complete/knowledge-architecture-schema.md"
  - "docs/specs/approved/knowledge-architecture-navigation.md"
  - "docs/specs/approved/multi-agent-support.md"
  - "docs/specs/approved/dreaming-memory-consolidation.md"
section: "Knowledge Architecture"
depends_on:
  - "knowledge-architecture-schema"
  - "knowledge-architecture-navigation"
  - "multi-agent-support"
  - "signet-runtime"
success_criteria:
  - "An authorized caller can inspect current truth, bounded claim history, competing assertions, exact source spans, and derived-memory premises through one read-only contract."
  - "Every returned premise is resolved through the existing agent-scoped source and session authorization path; fabricated, cross-agent, cross-project, or cross-session references fail closed."
  - "Deleted, superseded, stale, and incomplete evidence is reported as invalidated or unverified rather than presented as current truth."
  - "Reverse lineage and version traversal remain bounded and expose truncation and traversal limits."
  - "HTTP, CLI, and MCP consumers expose the same trace operation without creating a second provenance store."
scope_boundary: "Read-only claim explanation over existing entity_attributes, epistemic_assertions, ontology_proposals, memories, episodic sources, and derived_memory_sources. No new derivation store, cross-agent read policy, or claim mutation behavior."
---

# Authorized Claim Trace

## Problem

The ontology already stores the pieces needed to explain a claim: version
links on `entity_attributes`, proposal evidence, source-attributed
`epistemic_assertions`, semantic memories, and the canonical
`derived_memory_sources` relation. Existing claim evidence and version
endpoints expose those pieces separately, while a caller still has to join
them manually. That makes it easy to mistake a superseded value for current
truth or to accept an embedded quote whose source no longer exists.

Issue #1318 adds one bounded, read-only explanation operation. It is an
authorized view over existing rows, not a new lineage database.

## Contract

`GET /api/ontology/claims/explain` accepts:

| Query | Required | Bounds |
|---|---:|---|
| `entity`, `aspect`, `group`, `claim` | yes | non-empty path selectors |
| `kind` | no | `attribute` or `constraint` |
| `version_limit` | no | 1–50, default 20 |
| `premise_limit` | no | 1–100, default 50 |
| `reverse_limit` | no | 1–100, default 50 |
| `max_depth` | no | 0–3, default 3 |
| `agent_id` | no | resolved through the normal scoped-agent path |
| `session_key` | no | optional fail-closed session boundary |

The same `session_key` may be supplied as `x-signet-session-key`; conflicting
values are rejected. Remote calls must bind the session to the resolved
agent before the trace is read.

The response contains:

- `current`: active claim versions and a status of `active`, `competing`, or
  `historical`;
- `versions`: prior and superseded versions, with `truncated`;
- `competing`: active competing values and linked `denies` assertions;
- `assertions`: linked, agent-scoped epistemic assertions;
- `premises.items`: source kind/id/path, exact verified quote when supplied,
  bounded excerpt, lifecycle state, source scope metadata, and the owning
  derived-memory id when the premise came from a derived-memory relation
  (`null` for assertion-only evidence);
- `reverse`: bounded derived claims that cite the returned claim's semantic
  memory;
- `authorization`: resolved agent/project/session decisions and the fact that
  the read path is `recall`;
- `integrity`: `verified`, `unverified`, or `invalidated`, plus counts and a
  reason when exact evidence cannot support current certainty;
- `traversal`: all limits, visited counts, and bounded traversal metadata;
- `latencyMs`: local operation latency for evaluation.

`premises` are not accepted merely because a JSON object contains a quote. A
reference must identify one of the canonical episodic source kinds
(`memory`, `artifact`, `transcript`, or `summary`) and the referenced row must
exist for the same agent. If an exact quote is provided, it must occur in the
immutable source content. A missing source id or a mismatched quote returns a
conflict error; a source owned by another agent or outside the authorized
project/session returns forbidden. Session-scoped calls fail closed when a
source's session cannot be proven or does not match the requested session.

Deleted or stale source rows remain visible only as bounded lifecycle metadata
when the caller is authorized to see that row. They never contribute a
verified quote. The response therefore distinguishes an explanation of what
was once believed from a current, verified claim.

## Source of truth and invariants

1. `entity_attributes` remains the current/history claim store.
2. `epistemic_assertions` remains the attributed statement store; `denies`
   assertions are contradictory context, not current truth.
3. `derived_memory_sources` remains the only reverse-indexed premise relation
   for derived semantic memories.
4. Every ontology query filters by the resolved `agent_id`; the operation does
   not reuse shared/global recall to widen graph visibility.
5. Project authorization follows the token project scope used by recall for
   linked semantic claim memories, source premises, and reverse dependents.
6. Session authorization uses the existing session-agent binding and requires
   a provable source session for session-scoped traces.
7. Limits are enforced before traversal and truncation is explicit.

## Surface parity

- HTTP is the canonical operation.
- CLI: `signet ontology explain-claim <entity> <aspect> <group> <claim>`.
- MCP: `signet_explain_claim`.

All three surfaces pass the same selectors, limits, agent scope, and optional
session boundary to the HTTP operation. They do not perform local joins or
source authorization.

## Evaluation

The runnable claim-trace evaluation uses fixed local rows and pass/fail
assertions for:

1. changed preferences: current and prior versions are both present;
2. competing values and contradictory assertions: both are surfaced without
   collapsing them into one unsupported truth;
3. multi-session derivations: an allowlisted session cannot read a premise
   from another session;
4. deleted evidence: dependent claims report invalidated integrity;
5. cross-agent sources and fabricated source ids: both fail closed;
6. reverse traversal: dependent claims are bounded and report limits.

The evaluation prints scenario accuracy (passed expected outcomes divided by
scenario count), unsupported-certainty count, latency, and one canonical
operation count. A non-zero exit status means any expected pass/fail assertion
failed.
