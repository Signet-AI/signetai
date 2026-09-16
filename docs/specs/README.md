# Specs: internal design records

This directory is for Signet developers and reviewers. Specs are internal records of proposed or accepted design intent; their status does **not** prove that work is implemented, released, supported, or available to users.

## Authority boundary

- `approved/`, `planning/`, `drafts/`, and `complete/` describe different points in the design workflow, not release channels.
- The spec text is authoritative only for the design decision it explicitly records. It does not override source code, tests, schemas, manifests, or public documentation for current behavior.
- For availability, consult the owning implementation and its release/public contract, then verify the runtime boundary.
- Preserve historical specs and reports when superseded; link the replacement or implementation evidence instead of treating deletion as cleanup.

## Navigation

- [`INDEX.md`](INDEX.md) — map of spec families and authority pointers.
- [`approved/`](approved/) — accepted design records pending or undergoing implementation verification.
- [`planning/`](planning/) — active planning records.
- [`drafts/`](drafts/) — unaccepted proposals.
- [`complete/`](complete/) — completed or historically closed design records; verify current implementation separately.
- [`dependencies.yaml`](dependencies.yaml) — machine-readable dependency metadata used by repository checks.

Research that informed a spec lives in [`../research/`](../research/). Public product contracts live under `web/docs/`.
