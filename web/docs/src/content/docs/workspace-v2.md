---
title: "Workspace v2"
description: "Workspace ownership, import ingress, protection status, and safe v1 migration."
---

Signet workspace v2 separates authored files, durable state, runtime files, rebuildable cache, imports, transcripts, skills, and secrets. It preserves the existing evidence, Dreaming, ontology, and Source lifecycle.

## Layout and ownership

```text
<workspace>/
  AGENTS.md  SOUL.md  IDENTITY.md  USER.md  MEMORY.md  agent.yaml  .sigignore  .gitignore
  skills/                         # root discovery path; independent Git repository
  files/                          # import inbox, not a Source
  data/signet.db                 # SQLite authority
  data/imports/                  # retained managed import originals
  data/snapshots/                # verified snapshots
  transcripts/<harness>/transcript.jsonl
  runtime/                        # logs, locks, temporary files
  cache/                         # tested rebuildable files only
  .secrets/                       # provider-owned or encrypted secrets
```

The persisted `workspace-layout.json` selects v1 or v2. v1 uses `memory/memories.db`, `memory/<harness>/transcripts/`, `.daemon/`, and legacy cache paths. v2 uses the layout above. Custom database, transcript, runtime, cache, inbox, managed-import, secret, skills, data, and workspace paths override defaults. Signet refuses unknown or newer layout versions instead of falling back to legacy paths.

Root Git history, remotes, branches, index, and working state are not rewritten by migration. Root `skills/` stays independently owned and discoverable by harnesses. Configured external Sources stay in place; Signet does not clone them into `files/` or managed import storage.

## `files/` import inbox

`files/` is ingress for manual drops and dashboard uploads. It is not a Source root and does not create a local-files provider. Both paths use one durable admission operation and the existing imported-source lifecycle. New imports retain exact original bytes in resolver-owned managed storage before acceptance, for reindexing, export, provenance verification, and recovery. Older imports without retained originals remain valid but are non-reindexable from original bytes. Setup and migration never auto-ingest files that were already in the inbox.

## Transcripts

JSONL is the canonical transcript file representation. Normal capture does not create Markdown transcript copies. Markdown is available only through explicit export or view generation. Signet retains the indexed `session_transcripts` representation while episodic evidence, Dreaming, recall, or recovery use it. A mismatch is an explicit diagnostic state; richer evidence is never silently normalized away.

On historical backfill, completed JSONL turns are the authority for the same session. Signet compares ordered roles and content from legacy Markdown and DB rows, retains divergent sources unchanged, logs the disagreement, and withholds the completion marker until reconciled. Identical turns do not duplicate the JSONL record. Live-only turns can still be replaced by a fuller completed snapshot; later disagreements do not silently complete the backfill. Malformed JSONL rows and non-increasing session sequence numbers encountered during comparison also prevent the marker from being written until repaired.

## Migrate v1 to v2

Migration upgrades the existing workspace in place. It is not a workspace relocation command. The journal records component progress, fingerprints, receipts, cutover, rollback eligibility, cleanup acceptance, and redacted errors outside the workspace.

```bash
signet workspace layout migrate preflight [--source <workspace>]
signet workspace layout migrate run       [--source <workspace>] [--dry-run] [--yes]
signet workspace layout migrate resume    [--source <workspace>]
signet workspace layout migrate status    [--source <workspace>]
signet workspace layout migrate rollback  [--source <workspace>]
signet workspace layout migrate cleanup   --accept [--source <workspace>]
```

The workspace path does not change. `--source` selects a workspace only when upgrading a non-default location; there is no destination path. The previous top-level `signet migration` command remains available as a compatibility alias.

On Windows, migration checks native file identities and refuses reparse-point traversal. New entries inherit the workspace's Windows ACLs; POSIX mode bits are not reproduced, though read-only file state is preserved. Copying symbolic links requires Windows permission to create them, such as Developer Mode or the symbolic-link privilege.

- `preflight` is read-only. It resolves overrides, inspects only registered Signet-managed entries and their Git state, checks the configured source database read-only, reports required space, and produces a redacted plan. Unregistered entries and the rebuildable v1 cache are reported as untouched; their contents are not traversed or fingerprinted. Writer draining occurs during `run`.
- `run` displays the in-place plan and asks for confirmation before writing; the prompt defaults to no. `--dry-run` prints the plan without prompting or writing, and `--yes` skips the prompt for automation. After confirmation, run acquires the migration lease, drains supported writers, copies and verifies only registered entries, snapshots SQLite, and publishes the v2 resolver cutover without changing the workspace path.
- `resume` continues from the durable journal without duplicate evidence, Sources, or Dreaming consumption.
- `status` reports phase, copied count, blockers, workspace-write state, and whether rollback remains eligible.
- `rollback` is safe only before cutover begins. If the journal records an unreceipted in-place write, rollback fails closed and requires `resume` to reconcile it. After cutover, resume or reconcile forward; the workspace is not a rollback target.
- `cleanup` requires explicit acceptance after destination startup and verification. It removes the migration journal, not necessarily legacy Markdown/manifests; retain or quarantine them while consumers exist.

Before cutover, copied files are hash-checked and the SQLite snapshot is compared table by table against the source database, including row counts and typed row values. Registered v1 transcript and artifact files are copied into `transcripts/`; their legacy source files remain unchanged, and migration does not rewrite database artifact references. Unknown workspace data, including unregistered `memory/` entries, remains at its original path and is not traversed, hashed, copied, or made searchable by migration.

Migration refuses ambiguous ownership, insufficient space, inconsistent snapshots, unsafe symlinks or special files, unsupported filesystems or custom layouts, and active writers that cannot drain. Before requesting a daemon drain, migration checks that the daemon serves the source workspace and that its PID matches the source's managed PID; unrelated daemons are not drained or stopped. It preserves Source IDs and generations rather than disconnecting and reconnecting Sources.

The daemon exposes `GET /api/workspace/migration-control` for the current
writer-drain generation, state, and blockers. The migration CLI invokes
`POST /api/workspace/migration-control/drain` to close admission and drain
supported writers before copying. These are lifecycle coordination endpoints;
use the CLI commands above rather than calling the daemon endpoints directly.

## Protection and restore status

CLI, API, and dashboard protection surfaces use one component-aware contract. Components include root-authored files, skills, managed originals, SQLite, transcripts, external Sources, runtime, filesystem cache, and secrets. States include protected, missing, stale, degraded, unknown, external, unverified, and excluded-rebuildable. Overall `protected` requires current protection for required components and valid restore evidence. Git sync alone cannot produce that result.

The restore comparison checks supplied claims for files, SQLite, daemon health, Source identities, transcript roles/provenance/order, recall scope, Dreaming frontier, ontology history/evidence, and harness identity/skills discovery. It does not itself establish independent recovery evidence or issue a valid receipt. The disposable real-daemon fixture currently checks workspace/database health, a persisted SQLite row and integrity, a restored memory through the daemon API, Source ID/generation, and skill discovery. Recall, Dreaming, ontology, and encrypted-secret continuity still require independent recovery probes; until those exist, restore status remains unverified and no valid receipt is published. Restore evidence is bounded and does not make post-write rollback safe.

## Upgrades and downgrades

Run preflight before upgrading, review the plan and protection status, run the migration, verify daemon readiness and restore evidence, then accept cleanup. An interrupted pre-cutover migration can resume or roll back. An interrupted post-cutover migration must resume or reconcile forward.

Downgrade only to a resolver-aware release before destination writes. After v2 writes, older binaries that do not understand the persisted layout version are unsupported and must not be pointed at the workspace.
