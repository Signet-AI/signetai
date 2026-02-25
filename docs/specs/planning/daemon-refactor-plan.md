---
title: "Refactor daemon.ts (7194 LOC → ~800 LOC coordinator)"
---

Refactor daemon.ts (7194 LOC → ~800 LOC coordinator)
===

Context
---

daemon.ts is 7194 lines — 10x the soft limit. It contains the entire
HTTP server, all route handlers, git sync, file watchers, memory
ingestion, update system, and utility functions in a single file.
Every feature change touches it, and the lack of separation makes it
hard to reason about individual subsystems.

The refactor is pure code motion: extract self-contained blocks into
modules, import them back into a lean coordinator. No behavior changes,
no API changes, no route renames.

Safety nets: TypeScript strict mode, existing test suite (mutation API,
hooks, auth, pipeline, transactions), manual smoke tests for uncovered
routes via dashboard/curl.

Strategy
---

Use Hono sub-routers. Each extracted route module creates its own
`new Hono()`, registers its routes, then daemon.ts mounts it via
`app.route("/api", memoryRoutes)` (or similar). This preserves the
single `export const app` that tests depend on.

Shared state (db accessor, auth config, rate limiters, analytics
collector, etc.) gets passed into each module via a factory function
or context object — not global imports.

Extraction Order
---

Each step is one commit. After each, run typecheck + tests + smoke.

**Step 1: Extract embedding helpers → `src/embedding-helpers.ts`**

Move from daemon.ts (lines ~186-580):
- `fetchEmbedding()`, `vectorToBlob()`, `blobToVector()`
- `parseTagsField()`, `parseBoundedInt()`
- Tag/metadata parsing utilities
- Legacy embedding normalization pipeline

These are pure functions with no side effects and no dependency on
Hono or app state. Easiest possible extraction. ~400 lines removed.

**Step 2: Extract git sync → `src/git-sync.ts`**

Move from daemon.ts (lines ~5720-6311):
- `resolveGitCredentials()`, `runGitCommand()`
- `gitPull()`, `gitPush()`, `gitSync()`, `getGitStatus()`
- `gitAutoCommit()` — refactor callback pyramid to async/await
  using the existing `runGitCommand` helper
- Periodic sync timer setup

Dependencies: `logger`, `AGENTS_DIR`, secrets API. Pass as config.
~590 lines removed.

**Step 3: Extract update manager → `src/update-manager.ts`**

Move from daemon.ts (lines ~4847-5286):
- Update config types and load/persist
- GitHub release check, npm version check
- Update runner (spawn package manager)
- Periodic check timer

Dependencies: `AGENTS_DIR`, `logger`. Self-contained. ~440 lines.

**Step 4: Extract memory ingestion → `src/memory-ingestion.ts`**

Move from daemon.ts (lines ~6466-7030):
- `syncExistingClaudeMemories()`, `syncClaudeMemoryFile()`
- `importExistingMemoryFiles()`, `ingestMemoryMarkdown()`
- `chunkMarkdownHierarchically()`, `estimateTokens()`
- `ingestedMemoryFiles` tracking map

Dependencies: db accessor, embedding helpers, pipeline enqueue.
~560 lines removed.

**Step 5: Extract file watcher → `src/file-watcher.ts`**

Move from daemon.ts (lines ~6312-6465):
- `startFileWatcher()`, `startClaudeMemoryWatcher()`
- `syncHarnessConfigs()`
- Debounce logic

Dependencies: git-sync (auto-commit), memory-ingestion. ~150 lines.

**Step 6: Extract route groups into `src/routes/`**

This is the big one. Create sub-routers for each logical group:

- `src/routes/memory.ts` — /api/memory/*, /api/memories (~1745 lines)
  - Includes FilterParams, buildWhere*, recall hybrid search
  - Rate limiters passed via factory/context
- `src/routes/embeddings.ts` — /api/embeddings/* (~310 lines)
- `src/routes/documents.ts` — /api/documents/* (~270 lines)
- `src/routes/connectors.ts` — /api/connectors/* (~280 lines)
- `src/routes/skills.ts` — /api/skills/* (~330 lines)
  - Includes parseSkillFrontmatter, catalog cache
- `src/routes/config.ts` — /api/config, /api/identity, /api/logs (~200 lines)
- `src/routes/auth.ts` — /api/auth/* (~100 lines)
- `src/routes/hooks.ts` — /api/hooks/* (~330 lines)
- `src/routes/git.ts` — /api/git/* (~50 lines, delegates to git-sync)
- `src/routes/update.ts` — /api/update/* (~120 lines)
- `src/routes/admin.ts` — /api/status, diagnostics, repair,
  analytics, timeline, harnesses, secrets (~350 lines)

Each route file exports a function like:
```typescript
export function createMemoryRoutes(ctx: DaemonContext): Hono {
  const routes = new Hono();
  // ... register routes ...
  return routes;
}
```

**Step 7: Clean up daemon.ts as coordinator**

What remains in daemon.ts (~800 lines):
- Imports and path constants
- DaemonContext type + initialization
- Hono app creation + global middleware (CORS, auth, analytics)
- Sub-router mounting
- Dashboard static serving
- main() — startup sequence, shutdown handler
- `export const app`

Shared Context Pattern
---

```typescript
interface DaemonContext {
  agentsDir: string
  daemonDir: string
  skillsDir: string
  port: number
  host: string
  authConfig: AuthConfig
  authSecret: Buffer | null
  analyticsCollector: AnalyticsCollector
  providerTracker: ProviderTracker
  repairLimiter: RateLimiter
  getEmbeddingConfig: () => EmbeddingConfig
}
```

Route modules receive this via their factory function. No globals
needed beyond the db accessor singleton (already has its own module).

Test Coverage Notes
---

**Covered by tests (safe to refactor confidently):**
- Mutation routes (PATCH/DELETE/history/recover) — mutation-api.test.ts
- Hook system — test/hooks.test.ts (1084 lines)
- Auth middleware — auth/auth.test.ts (643 lines)
- Pipeline stages — 5000+ lines across 8 test files
- Transactions — transactions.test.ts (665 lines)

**NOT covered (need manual smoke testing after changes):**
- Git sync, file watcher, update system
- Embedding/projection endpoints
- Config/secrets/skills/connectors/diagnostics routes
- Memory list, remember, recall routes

Verification Plan
---

After each step:

1. `bun run typecheck` — must pass clean
2. `bun test` — all existing tests must pass
3. `bun run build` — daemon builds successfully
4. Manual smoke test:
   - Start daemon: `bun packages/daemon/src/daemon.ts`
   - Dashboard loads at localhost:3850
   - `curl localhost:3850/health` returns ok
   - `curl localhost:3850/api/status` returns status
   - `signet recall "test"` works (exercises memory routes)
   - `signet remember "refactor test" -t test` works

After step 2 (git-sync): verify `gitAutoCommit` still fires on
file changes (edit a file in ~/.agents/, check daemon logs).

After step 6 (routes): full endpoint sweep — hit each route
category once via curl or dashboard tab navigation.

After final step: `bun run build` succeeds, daemon starts clean,
dashboard fully functional, all tests green.
