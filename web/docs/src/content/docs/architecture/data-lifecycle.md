---
title: "Data lifecycle"
description: "Normalization, projection, retention, and user-data layout."
---

## Content Normalization

`platform/daemon/src/content-normalization.ts` provides deterministic
normalization and hashing for deduplication.

The pipeline is:

1. `normalizeContentForStorage`: trim whitespace, collapse internal
   runs of whitespace to a single space. This is what gets stored in
   the `content` column.
2. `deriveNormalizedContent`: lowercase the storage content, strip
   trailing punctuation. This is the canonical form used for hashing.
3. Hash: SHA-256 of the normalized content. If normalization produces
   an empty string, the hash falls back to the lowercased storage
   content.

The returned `contentHash` is stored in `memories.content_hash`. The
unique partial index on that column ensures that two memories with
semantically identical content (differing only in case or trailing
punctuation) cannot both exist as non-deleted rows. Collision at insert
time (UNIQUE constraint violation) is handled gracefully — the worker
treats it as a dedup hit and records a `dedupedExistingId` in history.

Contradiction detection in the worker (`detectContradictionRisk`) runs
a lightweight token-level analysis: it checks for negation token
asymmetry (one side has a negation word, the other doesn't) and
antonym pair conflicts across a predefined set of boolean pairs
(`enabled`/`disabled`, `allow`/`deny`, etc.). At least two tokens must
overlap before either check is applied.

---

## UMAP Projection

`platform/daemon/src/umap-projection.ts` computes server-side 2D or 3D
projections from stored embeddings using the UMAP algorithm.

Key implementation details:

- `nNeighbors = min(15, max(2, n-1))` — adapts to dataset size to prevent
  UMAP from requesting more neighbors than data points.
- **Exact KNN** for ≤ 450 embeddings (`O(n²)` distance matrix).
  **Approximate KNN** for larger sets — uses sliding windows over the
  X- and Y-sorted projected points, trading a small accuracy loss for
  much faster edge construction.
- Output coordinates are min-max normalized to the range `[-210, 210]`
  on each axis.
- Results are cached in `umap_cache`. Cache is invalidated when the
  embedding count changes between requests. `GET /api/embeddings/projection`
  returns `202 Accepted` while computing, then the full result once cached.

---

## Retention

`platform/daemon/src/pipeline/retention-worker.ts` purges expired data
on a configurable interval (default 6 hours). Each purge step runs in
its own short `withWriteTx` to avoid holding write locks across the
full sweep.

**Purge order** (from spec section 32.5 D2.3):

1. **Graph links**: delete `memory_entity_mentions` rows for tombstoned
   memories past `tombstoneRetentionMs` (default 30 days). Decrement
   `entities.mentions` for affected entities; remove entities whose
   count reaches zero.
2. **Embeddings**: delete `embeddings` rows for those same expired
   tombstone IDs.
3. **Tombstones**: hard-delete the `memories` rows. The `memories_ad`
   trigger fires synchronously and cleans the FTS index. Row count is
   taken from the pre-delete ID list to avoid FTS trigger inflation in
   the change count.
4. **History**: delete `memory_history` rows older than
   `historyRetentionMs` (default 180 days).
5. **Completed jobs**: delete `memory_jobs` rows with
   `status = 'completed'` older than `completedJobRetentionMs`
   (default 14 days).
6. **Dead jobs**: delete `memory_jobs` rows with `status = 'dead'`
   older than `deadJobRetentionMs` (default 30 days).

Each step is capped at `batchLimit` rows (default 500) per sweep to
bound latency. Backpressure accumulates until the next interval fires.

Default retention windows:

| Data | Default |
|------|---------|
| Soft-deleted memories (tombstones) | 30 days |
| History events | 180 days |
| Completed jobs | 14 days |
| Dead-letter jobs | 30 days |

---

## User Data Layout

All agent data lives at `$SIGNET_WORKSPACE/`:

```
$SIGNET_WORKSPACE/
├── agent.yaml           # Config manifest
├── AGENTS.md            # Agent identity and instructions
├── SOUL.md              # Personality and tone
├── IDENTITY.md          # Structured identity metadata
├── USER.md              # User profile
├── MEMORY.md            # Generated working memory summary
├── memory/
│   ├── memories.db      # SQLite database (source of truth)
│   └── scripts/         # Optional batch tools (Python)
├── signetai/            # Managed local Signet source checkout
├── skills/              # Installed skills (subdirs)
├── .secrets/            # Encrypted secret store
└── .daemon/
    ├── pid
    └── logs/
        └── daemon-YYYY-MM-DD.log
```

By default the daemon binds to loopback. It can also bind for a configured
network mode such as Tailscale, with auth and CORS controls governing remote
access. All data stays local by design. The daemon collects local operational
telemetry (latency histograms, usage counters, error ring buffer) accessible
at `/api/telemetry/*`. Anonymous telemetry events never include prompts or
memory content. Optional recall QA capture writes a separate local-only search
ledger with query text and result snapshots for manual review.

---
