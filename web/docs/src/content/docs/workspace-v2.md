---
title: "Workspace v2"
description: "Workspace ownership, import ingress, protection status, and the automatic v1 upgrade."
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

Root Git history, remotes, branches, index, and working state are not rewritten by the layout upgrade. Root `skills/` stays independently owned and discoverable by harnesses. Configured external Sources stay in place; Signet does not clone them into `files/` or managed import storage.

## `files/` import inbox

`files/` is ingress for manual drops and dashboard uploads. It is not a Source root and does not create a local-files provider. Both paths use one durable admission operation and the existing imported-source lifecycle. New imports retain exact original bytes in resolver-owned managed storage before acceptance, for reindexing, export, provenance verification, and recovery. Older imports without retained originals remain valid but are non-reindexable from original bytes. Setup and the layout upgrade never auto-ingest files that were already in the inbox.

## Transcripts

JSONL is the canonical transcript file representation. Normal capture does not create Markdown transcript copies. Markdown is available only through explicit export or view generation. Signet retains the indexed `session_transcripts` representation while episodic evidence, Dreaming, recall, or recovery use it. A mismatch is an explicit diagnostic state; richer evidence is never silently normalized away.

On historical backfill, completed JSONL turns are the authority for the same session. Signet compares ordered roles and content from legacy Markdown and DB rows, retains divergent sources unchanged, logs the disagreement, and withholds the completion marker until reconciled. Identical turns do not duplicate the JSONL record. Live-only turns can still be replaced by a fuller completed snapshot; later disagreements do not silently complete the backfill. Malformed JSONL rows and non-increasing session sequence numbers encountered during comparison also prevent the marker from being written until repaired.

## Upgrade a v1 workspace

New workspaces are created on the v2 layout. `workspace-layout.json` is written when the workspace is created.

An existing v1 workspace is upgraded in place the first time a v2-aware daemon starts on it. The workspace root does not change, and no configured workspace pointer changes. Before the daemon opens the database or binds any workspace path, it takes the daemon instance lock, then renames Signet-owned v1 paths to their v2 locations under the same root:

| v1 path | v2 path |
|---------|---------|
| `memory/memories.db` and its `-wal`, `-shm`, and `-journal` files | `data/signet.db` and matching files |
| contents of `memory/<harness>/transcripts/` | `transcripts/<harness>/` |
| top-level `memory/*--summary.md`, `*--transcript.md`, `*--compaction.md`, and `*--manifest.md` | `transcripts/` |
| `memory/cache/` | `cache/` |
| `memory/imports/` | `data/imports/` |
| remaining `memory/` contents | `data/legacy-memory/` |
| `.daemon/` | `runtime/` |

The daemon then writes `workspace-layout.json` with version 2 and preserves custom path overrides. Root identity files, `agent.yaml`, `skills/`, `files/`, `.secrets/`, root Git state, and everything else at the root stay where they are. External Sources stay external. Files are renamed, not copied, so the upgrade uses no extra space and the database file is moved intact.

Before the first rename, the daemon records the planned renames in `.workspace-layout-upgrade.json` at the workspace root. If the daemon is interrupted, the next start finishes the remaining renames.

If the upgrade cannot proceed safely, the daemon reverses any renames it made, leaves the workspace on v1, records the reason in `.workspace-layout-upgrade.json`, reports it in `signet status` and `GET /api/status` (field `workspaceLayout.upgrade`), and starts normally on v1. This happens when a v2 destination already exists, a new v2 directory is not empty, a path crosses a filesystem boundary or goes through a symlink, or a rename fails. The daemon retries on the next start, so fix the reported cause and restart.

A workspace whose daemon is still running under an older release is not upgraded until that daemon stops, because the new daemon cannot take the instance lock.

## Protection and restore status

CLI, API, and dashboard protection surfaces use one component-aware contract. Components include root-authored files, skills, managed originals, SQLite, transcripts, external Sources, runtime, filesystem cache, and secrets. States include protected, missing, stale, degraded, unknown, external, unverified, and excluded-rebuildable. Overall `protected` requires current protection for required components and valid restore evidence. Git sync alone cannot produce that result.

The restore comparison checks supplied claims for files, SQLite, daemon health, Source identities, transcript roles/provenance/order, recall scope, Dreaming frontier, ontology history/evidence, and harness identity/skills discovery. It does not itself establish independent recovery evidence or issue a valid receipt. The disposable real-daemon fixture currently checks workspace/database health, a persisted SQLite row and integrity, a restored memory through the daemon API, Source ID/generation, and skill discovery. Recall, Dreaming, ontology, and encrypted-secret continuity still require independent recovery probes; until those exist, restore status remains unverified and no valid receipt is published. Restore evidence is bounded; it does not make an older release safe to run against an upgraded workspace.

## Upgrades and downgrades

Install the new release and start the daemon; the layout upgrade runs on its own. Check `signet status` afterward. If `workspaceLayout.upgrade` reports a blocked upgrade, fix the reported cause and restart the daemon.

After the upgrade, do not run an older release that predates layout support against the workspace. Older binaries that do not understand the persisted layout version are unsupported.
