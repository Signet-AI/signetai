---
title: Workspace v2 ownership and migration contract
status: approved
---

# Workspace v2 ownership and migration contract

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

`files/` is a pending inbox for dashboard uploads and manual drops. It is not a `local-files` Source, Source root, watcher-backed provider, or long-lived authority. Both upload paths enter one durable admission boundary, then the existing imported-source lifecycle. New imports retain exact original bytes under resolver-owned managed storage before acceptance; that storage supports reindexing, export, provenance verification, and recovery. Existing imports without retained originals remain valid but are reported as non-reindexable from original bytes. The inbox does not auto-ingest pre-existing files during setup or migration.

Transcript JSONL uses the dedicated transcript importer and canonical transcript lifecycle, not generic document normalization.

## Transcript authority

JSONL is the canonical transcript file representation. Normal capture does not generate ordinary Markdown transcript copies. Markdown is explicit/on-demand export or view output. The indexed `session_transcripts` representation remains while episodic evidence, Dreaming, recall, recovery, or other consumers require it; it is not silently discarded. Reconciliation must state which representation is authoritative, preserve fidelity and provenance, and surface disagreement rather than normalize away richer evidence.

## Migration lifecycle

Migration is stopped, drained, copy-and-verify, resumable, and journaled outside both workspaces. The journal records component progress, fingerprints, receipts, cutover, rollback eligibility, cleanup acceptance, and redacted errors.

```bash
signet migration preflight [--source <v1-root>] [--destination <v2-root>]
signet migration run       [--source <v1-root>] [--destination <v2-root>]
signet migration resume    [--source <v1-root>] [--destination <v2-root>]
signet migration status    [--source <v1-root>] [--destination <v2-root>]
signet migration rollback  [--source <v1-root>] [--destination <v2-root>]
signet migration cleanup   --accept [--source <v1-root>] [--destination <v2-root>]
```

- **preflight** is read-only. It resolves overrides, inventories ownership and Git state, checks space and writers, and produces a redacted plan.
- **run** acquires the migration lease, drains supported writers, copies regular files and in-boundary symlinks with hash verification, compares typed row values and counts for every table in the copied SQLite snapshot, then publishes v2 cutover. v1 harness transcript files and top-level transcript/manifest/summary/compaction artifacts move to `transcripts/`; unknown `memory/` payloads survive under `data/legacy-memory/` as retained, non-indexed material.
- **resume** reruns the journaled operation idempotently; it does not duplicate evidence or reset Dreaming state.
- **status** reports phase, copied count, blockers, destination-write state, and whether rollback remains eligible.
- **rollback** is safe only before the destination accepts durable writes. After that point, the old workspace is not a rollback target; use controlled forward reconciliation.
- **cleanup** requires an explicit `--accept` after destination startup and semantic verification. It removes the migration journal; cleanup is not proof that legacy artifacts may be deleted. Retain or quarantine legacy Markdown/manifests when their consumers are not retired.

Migration refuses ambiguous ownership, insufficient space, inconsistent snapshots, unsafe or escaping symlinks, special files, unsupported custom layouts, and active writers that do not drain. Binaries that predate layout-version support are not safe downgrade targets after cutover.

## Protection and restore evidence

Protection is component-aware across root-authored files, skills, managed originals, SQLite, transcripts, external Sources, runtime, filesystem cache, and secrets. The shared status contract distinguishes protected, missing, stale, degraded, unknown, external, unverified, and excluded-rebuildable. An overall protected result requires current protection for required components and a valid restore receipt; Git synchronization alone is not protection for the workspace.

Restore verification records a `signet.restore.v1` receipt and checks files, SQLite consistency, daemon readiness, Source identities/generations, transcript roles/provenance/order, recall scope/currentness, Dreaming frontier, ontology history/evidence links, and harness identity/skills discovery. Secret continuity is verified only through the provider contract; otherwise it is external or unverified. Restore and cleanup remain bounded: automatic rollback stops at the first destination write, and retaining the old directory is not a safe rollback mechanism.

## Upgrade and downgrade guidance

For a clean upgrade, run preflight, review the redacted plan and protection status, stop competing writers, run migration, verify status and restore evidence, then explicitly accept cleanup. Interrupted pre-cutover work can resume or roll back. Interrupted post-cutover work must resume or reconcile forward. Keep custom paths and external Sources configured; do not disconnect and reconnect Sources to migrate them.

Downgrade only to a resolver-aware release before destination writes. After v2 writes, do not point an older binary at the workspace. Older binaries that do not understand `workspace-layout.json` may refuse or misroute state and are unsupported.
