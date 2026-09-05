# Portable import containment brief

Status: implementer-ready preparation only. This brief does not change production code, the format, the daemon, or user data.

## Problem and evidence

On commit `d28e4e88` (Bun 1.4.0), a disposable source workspace containing two private memories (`alpha`, `beta`) and one `memory_artifacts` row was exported and imported into a fresh disposable target. The real command registrar printed `2 memories imported` and `Import complete`; the target query returned zero memories and zero artifacts. The bundle had `manifest.json`, `agent.yaml`, one identity file, and three JSONL files, but memory records omitted `agent_id` and `visibility`; `DREAMING.md` was not exported. The source and target lived under disposable `/tmp`; credentials were not inherited and the worktree was cleaned after inspection.

The runnable reproduction is committed at `scripts/evals/product-reconsideration/portable-import-containment-current.ts`. Run `bun scripts/evals/product-reconsideration/portable-import-containment-current.ts` from this worktree with credentials cleared. Receipt from the exact script on current main: export `2 memories`; import `2 memories imported`; target `after: []`, artifact count `0`; memory fields excluded `agent_id`/`visibility`; `identity/DREAMING.md` was absent. The probe uses only disposable temporary source/target workspaces and removes them in `finally`.

## Canonical path and authority

Today `surfaces/cli/src/commands/portable.ts:35-87` opens the source database directly for export, while `:93-173` opens, migrates, and writes the target database directly for import. It writes `identity/*` and `agent.yaml` at `:110-123`, creates the memory directory at `:125`, then calls core importers at `:140-144`. `platform/core/src/export.ts:121-132` selects a narrow memory projection, its manifest (`:22-31`) has no custody scope, and `:332-351` counts `INSERT OR IGNORE` as imported. The CLI discards importer error fields. `recordImportedMemoryContentSafety` (`:77-104`) hard-codes agent `default`.

The eventual authority is the daemon workspace lifecycle and sole database owner. The existing owner protocol is in `platform/daemon/src/db-owner-protocol.ts`; transaction and source snapshot import dispatch through `platform/daemon/src/db-owner-runtime.ts:456-481`. This task must not add a CLI importer or a second daemon executor. Core may retain deterministic serialization and validation helpers; only the daemon/owner performs durable restore.

The public contract at `web/docs/src/content/docs/cli/data-portability.md:16-24` currently says bundles carry workspace identity, memory, ontology, and skills and that import restores a bundle. Until complete custody exists, narrow that wording to an inspectable/limited format or reject it as unsupported. Do not call it a complete backup.

## Recommendation: fail closed before mutation

Contain the unsafe path while owner migration is pending. Make the current CLI `import <path>` exit nonzero with the fixed error `Portable import is temporarily unsupported: complete daemon-owned restore is unavailable. Preserve the bundle and target; use a complete daemon restore when available.` before opening `AGENTS_DIR/memory/memories.db`, creating `memory/`, or writing any identity/config/skill file. This immediate change intentionally performs no bundle inspection and adds no accepted import path. Keep export available, but describe its output as a limited, inspectable export rather than a complete backup.

## Strongest rejected alternative

Do not “quick fix” `portable.ts`/`export.ts` by defaulting omitted records into one namespace or treating `INSERT OR IGNORE` as success. That could make one synthetic count green while preserving direct CLI database ownership, losing original scope, omitting artifacts/corrections, and writing configuration before validation. It violates the one-owner and explicit-scope contracts and creates a second importer for D to displace.

## Scope and non-goals

Minimal deletion-oriented containment changes:

1. Close the executable CLI import writer in `surfaces/cli/src/commands/portable.ts`: reject before database access or any target write, with the exact recovery error above. Remove now-unreachable import-specific SQL/counter execution from this command, while preserving the public command registration and option parsing needed to emit the retirement error.
2. Update portability docs to state that current export is limited/inspectable and current import is unsupported pending daemon-owned complete restore. Preserve original bundles and targets.
3. Do not remove exported core helpers in this task. Inventory found `importMemories`, `importEntities`, and `importRelations` are exported by `platform/core/src/index.ts:420-424` and have only one production caller, `portable.ts:140-144`, plus no test/runtime callers in the repository search. Their API removal or deprecation can follow the daemon restore implementation after checking package consumers; it must not silently break public APIs here. `collectExportData` and `serializeExportData` remain used by the CLI export path.

This does not implement complete workspace export, manifest/JSONL validation, scope merge, schema migration, secret transfer, derived-index rebuild, owner cutover, or an accepted legacy mapping. It does not delete the source bundle or target workspace. Legacy input is unsupported until D defines one canonical owner restore; no user decision is needed now because repository evidence shows no supported essential caller requiring legacy import.

## Later D format, migration, and rollback decisions

The eventual owner (D) must define a versioned manifest with export generation, workspace/agent/group scope, checksums and counts; all authoritative tables/assets and their source lifecycle; provenance, supersession/corrections and pinned state; identity/skills; and secrets/tokens requiring re-authorization. Conflict policy (`skip`, `overwrite`, `merge`) needs a collision plan; merge cannot mean `INSERT OR IGNORE`. Interruption must produce a reconciliable outcome-unknown state or no mutation. These are later D requirements, not work to pre-build in the containment patch.

For D, preserve the original bundle byte-for-byte and the existing target, stage and validate a fresh generation before activation, and prove source/target bytes and durable counts on staging failure. D rollback is a generation/pointer operation under the owner lease; after new writes, export/reconcile or repair forward. These staging and pointer mechanics are explicitly outside immediate containment.

## Acceptance checks

Immediate containment acceptance (real CLI boundary, disposable HOME/XDG/SIGNET_PATH, credentials cleared, Bun 1.3.11 when available):

- any existing bundle path, including malformed JSON, malformed JSONL, omitted scope, and conflict options, returns the exact unsupported error before opening the target DB or writing any target file;
- pre/post filesystem hashes and DB counts prove the target remains byte-for-byte/durably unchanged, and the source bundle remains unchanged;
- the command does not report imported/restored counts, leaves no temporary target directory or DB handle, and documents export as limited. Path/symlink/byte/count validation belongs to D, where an accepted format exists.

Later D acceptance (separate complete-restore task): supported-format manifest/record validation, multiple private agents/groups, artifact/provenance/correction/purge round trip, conflict outcomes, interruption at activation boundaries, owner death/reconciliation, derived rebuild, and secret re-authorization. Do not require these from the immediate containment patch.

## Unresolved product decisions

Compatibility consequence: `signet import` is intentionally unavailable for current and legacy narrow bundles until D lands the daemon-owned restore contract. Existing bundles remain preserved for later inspection/translation. The repository search found no additional in-repo caller for the exported core import helpers, but external package consumers are unknown; retain those public exports for now and treat the CLI behavior change as a deliberate compatibility break requiring release notes. Immediate code rollback is a normal revert of the CLI rejection and documentation change; the generation/pointer rollback above applies only to later D restore implementation. Complete custody remains conditional on the table/asset inventory and owner snapshot proof; this brief does not invent precision for that larger migration.
