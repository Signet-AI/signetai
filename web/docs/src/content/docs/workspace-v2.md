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

## Migrate v1 to v2

Migration is stopped, drained, copy-and-verify, journaled, and resumable:

```bash
signet migration preflight --source <v1-root> --destination <v2-root>
signet migration run --source <v1-root> --destination <v2-root>
signet migration resume --source <v1-root> --destination <v2-root>
signet migration status --source <v1-root> --destination <v2-root>
signet migration rollback --source <v1-root> --destination <v2-root>
signet migration cleanup --accept --source <v1-root> --destination <v2-root>
```

- `preflight` makes no changes. It resolves custom paths, inventories ownership/Git/transcripts, checks space and writers, and returns a redacted plan.
- `run` acquires an exclusive lease, drains supported writers, copies and verifies state, snapshots SQLite, and publishes the v2 resolver cutover.
- `resume` continues from the durable journal without duplicate evidence, Sources, or Dreaming consumption.
- `status` shows phase, copied count, blockers, destination writes, and rollback eligibility.
- `rollback` is available only before destination durable writes. After that, reconcile forward; the old directory is not a safe rollback target.
- `cleanup` requires explicit acceptance after destination startup and semantic verification. It removes the migration journal, not necessarily legacy Markdown/manifests; retain or quarantine them while consumers exist.

Migration refuses ambiguous ownership, insufficient space, inconsistent snapshots, unsafe symlinks or special files, active writers that cannot drain, and unsupported custom layouts. It preserves Source IDs and generations rather than disconnecting and reconnecting Sources.

## Protection and restore status

CLI, API, and dashboard protection surfaces use one component-aware contract. Components include root-authored files, skills, managed originals, SQLite, transcripts, external Sources, runtime, filesystem cache, and secrets. States include protected, missing, stale, degraded, unknown, external, unverified, and excluded-rebuildable. Overall `protected` requires current protection for required components and valid restore evidence. Git sync alone cannot produce that result.

A restore receipt records checks for files, SQLite consistency, daemon readiness, Source identities, transcript roles/provenance/order, recall scope, Dreaming frontier, ontology history/evidence, and harness identity/skills discovery. Secret continuity is verified through its provider or reported external/unverified. Restore evidence is bounded and does not make post-write rollback safe.

## Upgrades and downgrades

Run preflight before upgrading, review the plan and protection status, run the migration, verify daemon readiness and restore evidence, then accept cleanup. An interrupted pre-cutover migration can resume or roll back. An interrupted post-cutover migration must resume or reconcile forward.

Downgrade only to a resolver-aware release before destination writes. After v2 writes, older binaries that do not understand the persisted layout version are unsupported and must not be pointed at the workspace.
