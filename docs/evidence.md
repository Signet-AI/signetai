# Evidence and derived state

## Stored evidence is never rewritten

Content-safety redaction happens on the way out of recall, search, and tools. The original content, source path, timestamps, ownership, and provenance stay intact and remain available to user-facing inspection.

Why: redacting at rest would destroy the only copy of user-owned evidence and make the redaction itself unauditable.

## Proposals reference evidence; they do not own it

Ontology proposals point at evidence through `evidence` and `source_*` columns. The proposal table never holds transcript or source-artifact content. Raw artifacts remain the source of truth.

Owner: `platform/daemon/src/ontology-proposals.ts`, `platform/daemon/src/ontology-evidence.ts`.

## Native harness memory is indexed, not adopted

When a harness has its own memory system, Signet indexes that harness's memory files as external, provenance-bearing artifacts. It does not re-extract, rewrite, or claim ownership of them.

Why: Signet offers one portable memory interface across harnesses without becoming a second writer of another tool's state.

Owner: `platform/daemon/src/native-memory-sources.ts`.

## Claim premises must resolve to real evidence

A claim premise is accepted only when it names a canonical episodic source kind (`memory`, `artifact`, `transcript`, or `summary`) and the row exists for the same agent. A supplied quote must occur in the immutable source content. A missing source or mismatched quote is a conflict; a source owned by another agent or outside the authorized project or session is forbidden. Session-scoped calls fail closed when the source's session cannot be proven.

Owner: `platform/daemon/src/ontology-claim-trace.ts`.

## Contradictions are advisory

Contradiction state records that two observations conflict. It is not a third truth value: both claims keep their status and lineage, and the contradiction endpoint never picks a winner by source kind or confidence. Claim governance stays with the existing set, supersede, archive, and restore rules.

The only persisted detector is the deterministic lexical guard (negation mismatch and supported antonym pairs). It requires lexical overlap, excludes constraints, calls no inference provider, and creates no edges or entities.

Why: graph noise and inference cost stay bounded, and nothing automatic resolves a conflict the evidence does not resolve.

Owner: `platform/daemon/src/ontology-contradictions.ts`.

## Attention is not evidence

Dreaming attention signals, including the opt-in `surprisal` hint about unusual embedding regions, are hints for where to look. They are never claims, evidence records, or confidence scores. A pass never cites `attention:<id>` as provenance, never creates an entity or claim from geometry alone, and never bypasses the evidence cursor and resolver.

Owner: `platform/daemon/src/pipeline/dreaming-policies.ts`.

## `MEMORY.md` is a projection

`MEMORY.md` is derived and rebuildable from the database; it is not canonical history. If a process dies between replacing the file and committing the transaction, the database wins, and delivery never trusts the file as committed state. A user-authored file blocks projection with an explicit pending result; Signet reports the conflict and never overwrites it.

Owner: `platform/daemon/src/memory-head-owner.ts`, `platform/daemon/src/memory-lineage.ts`.

## Deletion leaves tombstones

Privacy-driven removal writes a tombstone and removes the linked rows. Reindexing filters tombstoned sessions so deleted content is not resurrected.

Trap: if the `memory_artifact_tombstones` table is missing, native source reindex logs a warning and proceeds without the filter. Anything that can drop or skip that table can resurrect deleted content.

Owner: `platform/daemon/src/memory-lineage.ts`.

## Upload files live under a purge epoch

Hook transcript uploads write to `transcripts/uploads/<agent>/e<epoch>/<session>/<generation>.jsonl`. An agent purge bumps the epoch in `session_transcript_upload_purges`, and the drain removes only directories of older epochs. An upload holds its agent's lock in shared mode from its scope read to its commit, and the purge holds it exclusively around the epoch bump. So every byte an upload writes lands before the bump, and the drain after the bump removes it, whatever the commit outcome was. The commit keeps an epoch fence that returns `purge_pending` if the lock is ever bypassed.

Trap: deleting the whole agent directory also deletes files of a new agent with the same id. Without the lock, an upload that read the old epoch could write into a directory the drain had already cleared.

Owner: `platform/daemon/src/transcript-upload-agent-lock.ts`, `platform/daemon/src/session-transcripts.ts` (`drainTranscriptUploadPurgesOwned`), `platform/daemon/src/transcript-upload-paths.ts`.

## Dependency history belongs to triggers

SQLite triggers on `entity_dependencies` (insert, update, delete) write the dependency audit rows. Application code must not write those rows.

Why: only triggers see foreign-key cascades and direct SQL, so they are the only writer that can guarantee complete history.

Owner: `platform/core/src/migrations/050-related-to-audit.ts`.
