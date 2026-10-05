---
title: Workspace v2 ownership and upgrade contract
status: approved
---

# Workspace v2 ownership and upgrade contract

Workspace v2 separates user-authored files, durable state, runtime state, rebuildable cache, imports, transcripts, skills, and secrets. It changes filesystem ownership, not Signet's evidence → Dreaming → ontology architecture.

## Default layout

```text
<workspace>/
  AGENTS.md  SOUL.md  IDENTITY.md  USER.md  MEMORY.md  agent.yaml  .sigignore  .gitignore
  skills/                         # root discovery path; independent Git repository by default
  files/                         # import ingress only; not a Source
  data/signet.db                 # durable SQLite authority
  data/imports/                  # resolver-owned retained import originals
  data/snapshots/                # verified database snapshots
  transcripts/<harness>/transcript.jsonl
  runtime/                       # logs, locks, temporary files
  cache/                         # only tested rebuildable filesystem products
  .secrets/                      # provider-owned or encrypted file-backed secrets
  workspace-layout.json          # persisted layout version and overrides
```

The persisted resolver maps v1 to `memory/memories.db`, `memory/<harness>/transcripts/`, `.daemon/`, and legacy cache paths. It maps v2 to the paths above. Custom database, transcript, runtime, cache, inbox, managed-import, secret, skills, data, and workspace paths remain authoritative. Readers and writers use the persisted version; they do not infer layout from directory existence. Unknown or newer versions fail closed.

Root Git history and working state are preserved. `skills/` remains independently owned and discoverable by harnesses. Existing external Sources, such as an Obsidian vault, remain external and are never copied into the workspace.

## Import ingress and retention

`files/` is a pending inbox for dashboard uploads and manual drops. It is not a `local-files` Source, Source root, watcher-backed provider, or long-lived authority. Both upload paths enter one durable admission boundary, then the existing imported-source lifecycle. New imports retain exact original bytes under resolver-owned managed storage before acceptance; that storage supports reindexing, export, provenance verification, and recovery. Existing imports without retained originals remain valid but are reported as non-reindexable from original bytes. The inbox does not auto-ingest pre-existing files during setup or the layout upgrade.

Transcript JSONL uses the dedicated transcript importer and canonical transcript lifecycle, not generic document normalization.

## Transcript authority

JSONL is the canonical transcript file representation. Normal capture does not generate ordinary Markdown transcript copies. Markdown is explicit/on-demand export or view output. The indexed `session_transcripts` representation remains while episodic evidence, Dreaming, recall, recovery, or other consumers require it; it is not silently discarded. Reconciliation must state which representation is authoritative, preserve fidelity and provenance, and surface disagreement rather than normalize away richer evidence.

During historical backfill, an existing completed JSONL session remains authoritative for its own ordered roles and content. Markdown and DB turns are compared against it; divergent source artifacts and rows are retained unchanged, a diagnostic identifies the source, and the backfill completion marker is withheld for reconciliation. Matching representations do not duplicate JSONL turns. Live-only JSONL turns may still be promoted to a fuller completed Markdown or DB snapshot; a later divergent source cannot silently settle the marker. Malformed JSONL records or non-increasing session sequence numbers encountered during comparison also withhold the marker until the canonical file is repaired.

## Upgrading a v1 workspace

New workspaces are created on the v2 layout. `workspace-layout.json` is written when the workspace is created.

An existing v1 workspace is upgraded in place the first time a v2-aware daemon starts on it. The workspace root does not change, and no configured workspace pointer changes. Before the daemon opens the database or binds any workspace path, it takes the daemon instance lock, then renames Signet-owned v1 paths to their v2 locations under the same root:

| v1 path | v2 path |
|---------|---------|
| `memory/memories.db` and its `-wal`, `-shm`, and `-journal` files | `data/signet.db` and matching files |
| Signet's `transcript.jsonl` files in `memory/<harness>/transcripts/` | `transcripts/<harness>/` |
| top-level `memory/*--summary.md`, `*--transcript.md`, `*--compaction.md`, and `*--manifest.md` | `transcripts/` |
| `memory/cache/` | `cache/` |
| `memory/imports/` | `data/imports/` |
| Signet's own leftovers in `memory/`: schema backups (`memories.db.bak-v*` and their sidecars), transcript backfill markers, `backups/`, and the retired `scripts/`, `tests/`, and `requirements*.txt` templates | `data/legacy-memory/` |
| `.daemon/` | `runtime/` |

Files in `memory/` that Signet did not create stay there, including your own notes and harness daily logs such as OpenClaw's `memory/YYYY-MM-DD.md`. Harnesses still find them, and Signet's Git backup still includes them. The daemon removes `memory/` only when the upgrade leaves it empty.

Custom path overrides stay authoritative: an overridden component is not moved, and a custom database keeps its `-wal`, `-shm`, and `-journal` files beside it. Inside a custom transcript or data root outside the workspace, the daemon only renames Signet's own files within that root: `<root>/<harness>/transcripts/transcript.jsonl` becomes `<root>/<harness>/transcript.jsonl`, and a custom data root's `memories.db` becomes `signet.db`. Other files there are left alone. The daemon then writes `workspace-layout.json` with version 2 and preserves the overrides. Root identity files, `agent.yaml`, `skills/`, `files/`, `.secrets/`, root Git state, and everything else at the root stay where they are. External Sources stay external. Files are renamed, not copied, so the upgrade uses no extra space and the database file is moved intact.

Before the first rename, the daemon records planned moves and each source item's filesystem identity in `.workspace-layout-upgrade.json` at the workspace root. `.daemon/` moves last. After an interruption, the next start accepts an already-moved item only when its destination matches the recorded identity. The record may only move paths from Signet's v1 storage into its v2 storage, and the daemon writes layout v2 only after no v1 storage path remains. If the daemon stopped after writing layout v2 but before removing `.workspace-layout-upgrade.json`, the next start only finishes that cleanup. If an older journal lacks enough identity to verify a completed move, the daemon leaves the workspace on v1 and refuses to start rather than guessing; the journal lists the planned moves for manual recovery.

If the upgrade cannot proceed safely, the daemon reverses any renames it made, leaves the workspace on v1, records the reason in `.workspace-layout-upgrade.json`, reports it in `signet status` and `GET /api/status` (field `workspaceLayout.upgrade`), and starts normally on v1. This happens when a v2 destination already exists, a new v2 directory is not empty, a path is on a different filesystem than the workspace, a path sits inside a symlinked directory or is itself a relative symlink, a v1 directory cannot be read, or a rename fails. The daemon retries on the next start, so fix the reported cause and restart.

Setup refuses to modify a workspace marked v2 when its configured v2 database is missing but the corresponding v1 database still exists. Preserve both locations and restore or migrate the database before retrying setup; setup does not infer which database is authoritative.

If a launcher recreated `.daemon/` after an interruption (for example with startup logs, a pid file, or telemetry), the next start merges its new files into `runtime/` only when the runtime directory matches the identity recorded for the completed move. When a name already exists there, the older file is kept beside it with a `.before-<timestamp>` suffix. Nothing is overwritten. A mismatched runtime directory, or an interrupted record without enough identity to verify it, makes the daemon refuse to start and report the problem. It does not start on a partially moved workspace or guess which copy is current; `.workspace-layout-upgrade.json` lists the planned renames for manual recovery.

A workspace whose daemon is still running under an older release is not upgraded until that daemon stops, because the new daemon cannot take the instance lock.

## Protection and restore evidence

Protection is component-aware across root-authored files, skills, managed originals, SQLite, transcripts, external Sources, runtime, filesystem cache, and secrets. The shared status contract distinguishes protected, missing, stale, degraded, unknown, external, unverified, and excluded-rebuildable. An overall protected result requires current protection for required components and a valid restore receipt; Git synchronization alone is not protection for the workspace.

Restore verification records a `signet.restore.v1` receipt and checks files, SQLite consistency, daemon readiness, Source identities/generations, transcript roles/provenance/order, recall scope/currentness, Dreaming frontier, ontology history/evidence links, and harness identity/skills discovery. Secret continuity is verified only through the provider contract; otherwise it is external or unverified. Restore verification is bounded; it does not make an older release safe to run against an upgraded workspace.

## Upgrade and downgrade guidance

Install the new release and start the daemon; the layout upgrade runs on its own. Check `signet status` afterward. If `workspaceLayout.upgrade` reports a blocked upgrade, fix the reported cause and restart the daemon. Keep custom paths and external Sources configured; do not disconnect and reconnect Sources to upgrade them.

After the upgrade, do not run an older release that predates layout support against the workspace. Older binaries that do not understand `workspace-layout.json` may refuse or misroute state and are unsupported.
