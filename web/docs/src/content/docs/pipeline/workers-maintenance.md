---
title: "Workers and maintenance"
description: "Current non-semantic workers and their bounded lifecycle."
---

This page covers active supporting work. It does not describe the retired extraction or decision runtime.

## Active responsibilities

- **Document ingest** leases `document_ingest` jobs, fetches or prepares content, chunks it, refreshes embeddings, and updates document indexes. At most two document jobs run in flight across the daemon.
- **Retention** purges expired source-owned and derived rows in bounded batches while preserving referential safety.
- **Maintenance** reports queue, index, storage, and graph health. Its repair recommendations are observed or executed according to explicit controls and rate limits.
- **Synthesis and projections** maintain session-derived artifacts such as `MEMORY.md`; they do not replace canonical evidence.
- **Prospective indexing** creates alternate query hints for existing memories. Hints are retrieval state, not semantic claims.
- **Embedding tracking** refreshes missing or stale embeddings in bounded batches outside write transactions. Canonical vectors and any ANN mirror remain derived from memory content.

The durable queue records job type, lease, retry, terminal state, and errors. Current document work follows a bounded `pending -> leased -> completed` lifecycle with explicit retry or dead outcomes. Stale leases are recoverable; terminal history is retained according to maintenance and retention policy.

## Runtime boundaries

Pipeline work runs under daemon-owned lifecycle handles. Promise-based I/O does not create a process; `Worker` is an in-process thread boundary. The database owner remains the only synchronous SQLite owner. Native embedding and selected integrity or recovery operations retain separate killable boundaries when their model, crash, or deadline requirements justify one. This is not a general subprocess-per-job design.

Admission, deadlines, cancellation, retry budgets, and cleanup are observable. A job that cannot complete within its boundary reports failure, cancellation, timeout, or owner loss rather than remaining detached.

## Retired terminology

Historical `extract` jobs and old extraction, decision, structural-classification, dependency-synthesis, and session-end summary executors may remain in database history or migration code. They are not leased as active work. Compatibility status may report “Pipeline V2,” but that label does not restore those executors.

See [Daemon](/daemon/) for process lifecycle and [Pipeline configuration](/configuration/pipeline/) for supported controls.
