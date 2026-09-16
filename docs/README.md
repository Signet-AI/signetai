# Internal engineering documentation

This directory is an internal engineering record, not the public product documentation.

## Audience and status

- **Audience:** Signet developers, reviewers, maintainers, and operators.
- **Specs and plans** describe proposed or accepted design intent. `approved/` means accepted for implementation planning; it does not mean implemented, released, or supported.
- **Research** records evidence and design input. It is not a product commitment.
- **Progress logs and audits** record work performed, observations, and remaining risk. They are historical evidence, not release notes or availability claims.
- **Implementation and release authority:** use the owning source, tests, package manifests, generated-file headers, and public documentation. Verify behavior at the relevant runtime boundary before calling it available.

## Navigation

- [`specs/`](specs/README.md) — internal proposals, plans, and accepted design records.
- [`research/`](research/) — internal research and provenance.
- [`REPO_MAP.md`](REPO_MAP.md) — repository navigation and ownership pointers.
- [`BENCHMARKING-PROGRESS.md`](BENCHMARKING-PROGRESS.md) — developer benchmark history; not publishable claims.
- [`ontology-control-plane-progress.md`](ontology-control-plane-progress.md) — developer implementation checkpoints.
- [`event-loop-contract-audit.md`](event-loop-contract-audit.md) — developer/operator audit evidence.

For user-facing behavior and supported availability, start with `web/docs/` and the owning runtime/package contract rather than this directory.
