---
title: "MEMORY.md Rolling Window Lineage"
id: memory-md-rolling-window-lineage
status: complete
informed_by:
  - docs/research/technical/RESEARCH-MEMORY-MD-ROLLING-WINDOW-LINKAGE.md
  - docs/research/technical/RESEARCH-LCM-ACP.md
  - docs/specs/approved/memory-md-temporal-head.md
section: "Memory"
depends_on:
  - "memory-md-temporal-head"
  - "lossless-working-memory-runtime"
  - "session-continuity-protocol"
success_criteria:
  - "Canonical historical content consists of immutable markdown summary/transcript/compaction artifacts, and MEMORY.md is a rebuildable derived projection"
  - "Session-end and compaction persist canonical artifacts with deterministic workspace-root-relative Obsidian wikilinks"
  - "Content-linked DB lineage/search rows are rebuildable from markdown artifacts while runtime temporal telemetry remains DB-native"
  - "MEMORY.md renders a strict rolling 30-day UTC ledger with one high-signal sentence per in-window session and no clipping"
scope_boundary: "Defines markdown-canonical history, derived DB indexing, and MEMORY.md rendering contracts; does not replace DB-native graph and runtime telemetry systems"
draft_quality: "implementation-ready planning spec"
---

# MEMORY.md Rolling Window Lineage

Spec metadata:
- ID: `memory-md-rolling-window-lineage`
- Status: `complete`
- Hard depends on: `memory-md-temporal-head`, `lossless-working-memory-runtime`, `session-continuity-protocol`
- Registry: `docs/specs/INDEX.md`

## Problem

`MEMORY.md` currently compresses too aggressively for high-frequency usage.
Under 50+ sessions/day, in-window sessions can be omitted or reduced to weak
truncations, and drill-down can depend on tool surfaces instead of stable file
lineage.

The deeper failure mode is source-of-truth ambiguity between markdown and DB
history representations.

## Core decisions (normative)

1. Canonical historical content consists only of summary, transcript, and
   compaction markdown artifacts.
2. `MEMORY.md` is a derived, rebuildable projection and is not canonical
   history.
3. Window membership and day grouping use UTC and are computed from
   `ended_at`, or `captured_at` when `ended_at` is null.
4. Metadata that can appear after session end (for example later compaction
   linkage) must not require mutation of immutable content artifacts.
5. LLM usage in this lane is scoped to generating one sentence stored in
   artifact frontmatter; `MEMORY.md` rendering itself is programmatic.

## Workspace root and link model

### Workspace root

Workspace root is `SIGNET_WORKSPACE` (default `~/.agents`).

Canonical artifacts live under:
- `<workspace_root>/memory/`

### Link format

All cross-document links MUST use Obsidian wikilinks with paths relative to
workspace root.

Valid examples:
- `[[memory/2026-03-28T22-34-06.792Z--h7k3n4p9m2x1q8r5--summary.md]]`
- `[[memory/2026-03-28T22-34-06.792Z--h7k3n4p9m2x1q8r5--transcript.md|transcript]]`

## Authority split

### Markdown authority (canonical)

Markdown is authoritative for historical content:
- summary narratives
- sanitized transcript text
- compaction narratives
- canonical cross-document lineage links

### Database authority (DB-native)

Database is authoritative for runtime state that markdown cannot model
faithfully:
- temporal telemetry (timing, decay, ranking, access counters)
- runtime execution metadata and queues
- graph state (entities, aspects, attributes, dependencies, relations)

### Conflict policy

- For historical content fields: markdown wins, DB is repaired by re-index.
- For runtime telemetry fields: DB wins.

## Canonical artifact model

### Immutable content artifacts

Kinds:
1. `summary` (`--summary.md`)
2. `transcript` (`--transcript.md`) sanitized form only
3. `compaction` (`--compaction.md`)

These files are immutable after first successful commit.

### Mutable session manifest

Each session gets one mutable manifest file:
- `--manifest.md`

The manifest is the only file that may gain new links after session end
(for example compaction arriving later).

### File naming

`{captured_at_iso_fs}--{session_token}--{kind}.md`

- `captured_at_iso_fs`: UTC timestamp with filesystem-safe separators
- `session_token`: deterministic token (see token contract below)
- `kind`: `summary`, `transcript`, `compaction`, `manifest`

### Frontmatter contract

#### Immutable content artifact frontmatter

Required:
- `kind`
- `agent_id`
- `session_id`
- `session_key`
- `project`
- `harness`
- `captured_at`
- `started_at` (nullable)
- `ended_at` (nullable)
- `manifest_path`
- `source_node_id` (nullable)
- `content_sha256`
- `hash_scope` (must equal `body-normalized-v1`)
- `sanitizer_version` (required for transcript kind)
- `memory_sentence` (one-sentence session summary used by `MEMORY.md`)
- `memory_sentence_version` (prompt/schema version for sentence generation)
- `memory_sentence_quality` (`ok` or `fallback`)
- `memory_sentence_generated_at`

Not required on immutable files:
- `compaction_path`

#### Mutable manifest frontmatter

Required:
- `kind` (value `manifest`)
- `agent_id`
- `session_id`
- `session_key`
- `project`
- `harness`
- `captured_at`
- `summary_path`
- `transcript_path`
- `compaction_path` (nullable, may be set later)
- `memory_md_refs` (list of `MEMORY.md` entries that include this session)
- `updated_at`

### Checksum scope

`content_sha256` hashes normalized markdown body only, excluding frontmatter.
Normalization contract:
1. LF line endings
2. trailing whitespace removed per line
3. no trailing blank lines at EOF
4. UTF-8 bytes over normalized body

## Session token contract

Token derivation (deterministic, collision-resistant):

- canonical session identity = `session_key` when present, else `session_id`
- seed = `${agent_id}:${canonical_session_identity}`
- token = first 16 chars of lowercase base32(sha256(seed))

Display short IDs (for UI readability) are non-authoritative aliases and must
never be used as primary storage keys.

## MEMORY.md projection contract

### Status

`MEMORY.md` is a derived view over canonical artifacts plus DB-native runtime
signals. It is always rebuildable.

## Required section

`## Session Ledger (Last 30 Days)` is mandatory.

## Window semantics (strict)

At render time `t_now` in UTC:

- include sessions where `membership_ts` is in `[t_now - 30 days, t_now]`
- `membership_ts = ended_at` when present, else `captured_at`
- day buckets use `membership_ts` UTC date

No in-window session may be dropped due to rank, token budget, or top-N caps.

## Per-session sentence quality floor

Each in-window row uses `memory_sentence` from artifact frontmatter.
`memory_sentence` must satisfy all checks:

1. 12-48 words
2. terminal punctuation (`.` `!` `?`)
3. contains at least one concrete anchor from session context:
   - project basename, or
   - file/package path token, or
   - issue/PR/task identifier, or
   - named component/system token
4. not equal to known low-signal templates
   (`"Investigated issue."`, `"Worked on task."`, `"Reviewed code."`)

If LLM output fails checks, runtime must store a deterministic fallback sentence
and set `memory_sentence_quality: fallback`.

## Canonical row shape

```md
- 2026-03-28T22:34:06.792Z | session=a245b4fc-b607-4c50-8566-ebe23264272f | project=/home/nicholai/signet/signetai | Finalized DP-19 write-gate clamping decisions and queued scope-aware dedup parity validation before merge. [[memory/2026-03-28T22-34-06.792Z--h7k3n4p9m2x1q8r5--summary.md|summary]] [[memory/2026-03-28T22-34-06.792Z--h7k3n4p9m2x1q8r5--transcript.md|transcript]] [[memory/2026-03-28T22-34-06.792Z--h7k3n4p9m2x1q8r5--manifest.md|manifest]]
```

## Write and crash state model

### Write ordering (source-of-truth first)

Session-end:
1. sanitize transcript (deterministic sanitizer)
2. generate one-sentence `memory_sentence` via LLM
3. validate `memory_sentence` against quality floor, else deterministic fallback
4. write immutable transcript artifact with sentence metadata in frontmatter
5. write immutable summary artifact with sentence metadata in frontmatter
6. write/create manifest with summary+transcript paths
7. update `MEMORY.md` projection from frontmatter + deterministic metadata
8. upsert derived content-linked DB rows
9. continue DB-native telemetry updates

Compaction-complete:
1. generate compaction `memory_sentence` via LLM
2. validate sentence, else deterministic fallback
3. write immutable compaction artifact with sentence metadata in frontmatter
4. update manifest `compaction_path` + `updated_at`
5. update `MEMORY.md` projection from frontmatter + deterministic metadata
6. upsert derived content-linked DB rows
7. reset live transcript buffers only after canonical writes commit

### Partial-failure states

Implementation must model and recover these states explicitly:
- transcript written, summary failed
- sentence generated, artifact write failed
- sentence generation failed, fallback path engaged
- summary/transcript written, manifest failed
- artifacts+manifest written, MEMORY.md update failed
- canonical writes done, DB index update failed

Recovery must resume idempotently using manifest + checksums.

## Sanitization contract

Transcript sanitization must be deterministic and versioned.

Required:
- function id: `sanitize_transcript_v1`
- stable redaction policy and normalization order
- explicit upgrades via new versions (`v2`, `v3`) with migration notes

Sentence generation must also be deterministic at contract level:
- function id: `memory_sentence_v1`
- strict output target: exactly one sentence
- quality gate + deterministic fallback path

## Derived DB contract

DB rows for content lineage/search are derived indexes over canonical files.

Required:
1. `source_path` (workspace-root-relative)
2. `source_sha256`
3. `source_kind`
4. `agent_id`
5. session identity fields

Re-index rebuilds content-linked rows from canonical artifacts for target scope.
Runtime telemetry rows are preserved unless explicitly reset by operator action.

## Re-index, deletion, and privacy removal

### Re-index

1. scan canonical artifacts in scope
2. validate frontmatter + link graph + checksums
3. rebuild content-linked DB rows
4. regenerate `MEMORY.md`

### Deletion/removal

Privacy-driven removal must write tombstones and remove linked DB rows for
content lineage.

Tombstone fields:
- `agent_id`
- `session_token`
- `removed_at`
- `reason`
- `removed_paths`

Re-index must honor tombstones so deleted content is not resurrected.

## Concurrency contract

High-volume workloads require explicit write coordination.

Required:
1. lease-based writer lock for `MEMORY.md` projection updates
2. per-session manifest compare-and-swap revisioning
3. atomic file replace semantics for canonical writes
4. retry-safe idempotency keys for session-end and compaction flows

## Implementation plan

### Phase 0: contracts and helpers

1. add canonical naming + token helper
2. add body hash helper (`body-normalized-v1`)
3. add wikilink helper (workspace-root-relative)
4. add deterministic sanitizer version plumbing
5. add `memory_sentence` frontmatter schema + quality gate helpers

### Phase 1: canonical artifact + manifest writers

1. write immutable summary/transcript artifacts
2. add mutable manifest lifecycle
3. write immutable compaction artifacts + manifest backfill
4. add crash-recovery state handling
5. wire LLM one-sentence generation into summary/compaction artifact frontmatter

### Phase 2: MEMORY.md renderer

1. render strict rolling 30-day UTC ledger
2. read per-session sentence from frontmatter
3. enforce per-session sentence quality floor + fallback flag handling
4. enforce no clipping/no top-N omission

### Phase 3: derived DB indexing and re-index

1. upsert content-linked DB rows with path+hash pointers
2. implement idempotent re-index from markdown
3. add tombstone-aware deletion handling

### Phase 4: docs and safeguards

1. document authority split in API/HOOKS/HARNESSES docs
2. add operator docs for re-index + privacy removal
3. add regression suite for contracts above

## Validation and regression tests

1. 1,500-session window test (50/day x 30) yields 1,500 ledger rows.
2. sentence floor test rejects low-signal rows.
3. wikilink format test enforces workspace-root-relative links.
4. immutable artifact test rejects post-commit mutation.
5. manifest mutability test allows late `compaction_path` updates only in
   manifest.
6. checksum scope test verifies `body-normalized-v1` behavior.
7. sanitizer determinism test ensures stable output for same input.
8. partial-failure recovery tests cover each state model branch.
9. re-index parity test rebuilds content-linked DB rows from markdown.
10. runtime telemetry preservation test proves re-index does not clobber
    DB-native temporal counters/ranks.
11. tombstone test proves deletion/removal survives re-index.
12. multi-agent scoping test proves no cross-agent bleed.
13. frontmatter sentence projection test proves `MEMORY.md` rows are sourced
    from artifact `memory_sentence` fields (not full-file LLM rewrites).

## Risks and mitigations

1. **Risk:** large `MEMORY.md` at extreme session volume.
   **Mitigation:** enforce sentence length band, keep deep detail in linked
   artifacts.

2. **Risk:** disk growth from transcript artifacts.
   **Mitigation:** sanitized content only, plus out-of-window archival policy.

3. **Risk:** operational complexity from manifest + recovery states.
   **Mitigation:** explicit state machine tests and idempotent replay tooling.

4. **Risk:** future regressions reintroduce dual-canonical ambiguity.
   **Mitigation:** CI guardrails on authority split and path/hash contracts.

## Open design questions

1. Should sentence length band be global or recency-tiered?
2. Should out-of-window archival produce monthly markdown bundles?
3. Should CLI ship `signet memory reindex` and `signet memory open <session>`
   in this wave or follow-up?
