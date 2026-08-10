---
title: "Dreaming: Fair Progress Across Agent Scopes"
description: "Bound one-universe Dreaming passes so independent agent scopes receive fair, isolated progress without creating a second semantic writer."
order: 2
section: "Memory Architecture"
informed_by:
  - "docs/specs/approved/dreaming-memory-consolidation.md"
  - "docs/specs/approved/multi-agent-support.md"
success_criteria:
  - "Every eligible agent scope receives one sequential Dreaming turn in a pass, regardless of another scope's backlog size"
  - "Evidence and output budgets are divided deterministically across eligible scopes"
  - "Higher-priority pending attention is handled first without removing another eligible scope's turn"
  - "Scope-bound Dreaming tools reject cross-scope reads and writes"
  - "A failed scope turn does not prevent remaining scopes from making progress"
  - "One dreaming_passes row, one audited operation seam, and one evidence cursor remain authoritative"
scope_boundary: "This spec covers fairness inside the existing one-universe Dreaming worker. It does not add parallel semantic writers, a new queue, or a dashboard surface."
---

# Dreaming: Fair Progress Across Agent Scopes

## Problem

The one-universe Dreaming worker intentionally uses one persisted pass and one
bounded agent session to maintain every agent scope in an installation. The
shared session is the correct writer boundary, but it gives the model control
over which scope it reads next. A scope with a large evidence backlog can spend
the pass's tool and model budget before a smaller scope's pending evidence or
attention is inspected.

This is starvation, not merely uneven throughput: an independently healthy
scope can remain untouched while another scope continually receives new work.
The failure is most visible with a synthetic 100:1 evidence imbalance, but the
same mechanism affects hygiene and overdue temporal attention.

## Decision

Keep one Dreaming universe and divide it into **sequential scope turns** inside
the existing persisted pass:

1. At pass start, resolve each scope's pending attention, evidence backlog, and
   last successful watermark.
2. Exclude scopes with no work for the selected mode. Compact mode retains its
   existing explicit all-scope behavior.
3. Give every eligible scope exactly one turn. Pending attention priority and
   age determine order only; they cannot remove another scope's turn.
4. Divide the configured output, timeout, and evidence budgets across turns.
   The remainder is assigned deterministically to the earlier turns.
5. Build a scope-bound capability registry for each turn. A turn can read and
   write only its own `agent_id`; its runbook remains attached to the single
   pass owner and its operations use the existing audited apply seam.
6. Continue with later turns when one scope's provider call fails. The failed
   scope keeps its evidence cursor/backlog for retry; successful scopes alone
   advance their watermarks.

Turns are sequential, not parallel. This preserves SQLite serialization,
one canonical semantic writer, attention provenance, and bounded operation
batches while making time-to-first-progress independent of backlog size in a
different scope.

## Scheduling and budgets

The scheduler uses deterministic inputs already owned by Dreaming:

- highest pending attention priority, then oldest pending attention;
- scopes that have never completed a pass before older completed scopes;
- stable `agent_id` order as the final tie breaker.

The first factor gives overdue or explicitly urgent maintenance priority. It is
not a weighted share: every eligible scope still receives one turn. Evidence
returned by `search_evidence` consumes that turn's evidence budget, so repeated
searches from a dominant scope return a bounded page and cannot spend another
scope's allowance. The existing `apply_ontology_ops` schema continues to cap
each operation batch at 100 operations.

The configured `maxOutputTokens`, `timeout`, and `maxInputTokens` values remain
the pass-level controls. Their deterministic shares are sent to each turn;
the provider therefore cannot receive the full pass output budget repeatedly
for every scope. A very large installation may produce a minimum one-token
share for a late scope; it is still attempted and its backlog is never marked
processed without a successful turn.

## State, provenance, and failure behavior

- There is still exactly one `dreaming_passes` row for a trigger.
- Every semantic operation still goes through `applyDreamingOperations` with
  the turn's scope and the same pass id.
- Evidence remains immutable. A scope watermark advances only to evidence
  surfaced by that scope's successful turn.
- A failed turn is recorded as a pass failure contribution and leaves that
  scope eligible for the normal failure backoff/retry path. It must not block
  healthy scopes in the same pass.
- A scope-bound tool rejects a requested `agentId` that differs from the turn,
  including both read and mutation capabilities. Cross-agent isolation remains
  enforced by the database and operation applicators as a second boundary.
- Existing system-pressure deferral, failure halts, attention provenance,
  and operation caps remain unchanged.

## Evaluation contract

The regression fixture uses two independent scopes with a 100:1 evidence
imbalance and a deterministic executor. It records:

- scope turn order and time-to-first-turn;
- evidence pages surfaced per scope;
- applied operations per scope and exact source provenance;
- remaining backlog/watermark after a pass;
- per-turn output/evidence budgets and aggregate token usage;
- behavior when the dominant scope repeatedly searches or its provider fails.

The minimum pass condition is that the smaller scope receives a turn and can
surface or apply its own evidence in the same persisted pass, while the
dominant scope cannot read or mutate the smaller scope and cannot consume its
budget.
