# Core guidance

`@signet/core` owns shared types, SQLite access, migrations, search, manifests,
and identity primitives consumed by multiple runtimes. Read the owning source,
its consumers, and `web/docs/src/content/docs/architecture.md` or `web/docs/src/content/docs/sources.md` when the change
touches their contracts.

## SQLite and migrations

- `Database` supports `bun:sqlite` under Bun and `better-sqlite3` under Node.
  Keep shared database behavior valid through the common adapter rather than
  relying on one runtime's private API.
- Schema changes are append-only numbered files in `src/migrations/` and are
  registered at the end of `MIGRATIONS` in `src/migrations/index.ts`. Use the
  next contiguous version; do not renumber or reuse a shipped version.
- Migration `up` functions need to tolerate the legacy and partially repaired
  schemas they can encounter. Declare verifiable tables and columns in
  `artifacts` so phantom-migration detection can check them.
- Cover a fresh database, a second idempotent run, and a representative upgrade
  or backfill path. Preserve existing user data, agent scope, visibility, and
  provenance while repairing uniqueness or deduplication.

## Shared data behavior

- Keep `agentId`/`agent_id`, project, scope, and visibility aligned in reads,
  writes, joins, uniqueness constraints, FTS synchronization, and derived
  records. Test isolation behavior rather than only checking returned shapes.
- Source-backed records retain stable source identifiers and attribution.
  Deletion and reindexing must not leave unscoped or orphaned derived rows.
- Treat SQLite rows as canonical state. Search indexes, vectors, caches, and
  generated ledgers are derived surfaces and should not become competing
  sources of truth.

## Public package proof

- Keep exports and types compatible with current consumers in the daemon, CLI,
  integrations, and SDK-facing packages. Avoid exporting helpers needed by
  only one internal caller.
- Run focused tests first, then build the public package when its exports,
  runtime adapter, or generated declarations change:

```bash
bun test platform/core/src/<area>.test.ts
bun test platform/core/src/migrations/migrations.test.ts
bun run --filter '@signet/core' build
```
