---
title: "Refactor daemon.ts into Route Modules"
---

# Refactor daemon.ts into Route Modules

## Context

`packages/daemon/src/daemon.ts` is 7,746 lines — a single Hono app file
containing all HTTP routes, helpers, background services, and startup logic.
It's the single biggest maintenance burden in the codebase. Splitting it
into route modules improves readability, testability, and makes it possible
to work on one domain without scrolling through 7k lines.

## Pattern

Follow the existing `mountMcpRoute(app: Hono): void` pattern from
`packages/daemon/src/mcp/route.ts`. Each module gets the app and a shared
state object, registers its own routes and middleware guards.

## Shared State

Create a `DaemonState` interface that holds all cross-cutting mutable state
(auth config, rate limiters, provider tracker, analytics collector, etc.).
daemon.ts creates the object at module scope and passes it by reference to
every mount function. `main()` mutates auth fields before the server starts.

## File Plan

```
packages/daemon/src/
├── daemon.ts                              ~300 LOC (orchestrator only)
├── git-watcher.ts                         ~1,000 LOC (file watcher + git sync + ingestion)
├── routes/
│   ├── shared-state.ts                    ~60 LOC (DaemonState interface)
│   ├── shared-utils.ts                    ~200 LOC (fetchEmbedding, inferType, etc.)
│   ├── admin.ts                           ~300 LOC (health/status/auth/config/identity/harnesses/secrets/logs/update)
│   ├── memory.ts                          ~2,200 LOC (all memory CRUD + helpers)
│   ├── embeddings.ts                      ~750 LOC (embeddings + legacy + projection)
│   ├── documents-connectors.ts            ~550 LOC (documents + connectors)
│   ├── skills.ts                          ~420 LOC (skills + catalog cache)
│   ├── hooks.ts                           ~330 LOC (session lifecycle hooks)
│   └── tasks-diagnostics-analytics.ts     ~580 LOC (tasks + diagnostics + repair + analytics + timeline)
```

## Extraction Order

Each step is independently buildable/testable (`bun run build && bun test`).

### Step 1: `routes/shared-state.ts`
- Define `DaemonState` interface
- Export type only — no behavior

### Step 2: `routes/shared-utils.ts`
- Extract from daemon.ts: `fetchEmbedding`, `inferType`, `resolveMutationActor`,
  `blobToVector`, `parseBoundedInt`, `parseTagsField`, `chunkBySentence`,
  `checkEmbeddingProvider`, `EmbeddingStatus` interface
- Import them back into daemon.ts — no behavioral change yet

### Step 3: `git-watcher.ts`
- Extract: git sync system, commit debouncer, harness sync, file watcher,
  Claude memory watcher, markdown ingestion (~1,000 lines)
- Export: `startFileWatcher(state)`, `startGitSyncTimer()`, `stopGitSyncTimer()`,
  `getGitStatus()`, `gitSync()`, `gitPull()`, `gitPush()`, `getGitConfig()`,
  `setGitConfig()`, `loadGitConfig()`, `importExistingMemoryFiles()`,
  `syncExistingClaudeMemories()`
- The 6 thin git API routes (~55 lines) stay in daemon.ts

### Step 4: `routes/skills.ts`
- Extract: all `/api/skills/*` routes + `parseSkillFrontmatter`,
  `listInstalledSkills`, catalog cache state, `fetchCatalog`,
  `fetchClawhubCatalog`, `formatInstalls`
- Self-contained — only shared dep is `state.agentsDir`

### Step 5: `routes/documents-connectors.ts`
- Extract: all `/api/documents/*` and `/api/connectors/*` routes
- Uses `resolveMutationActor` from shared-utils
- Move permission guards for these routes inside the module

### Step 6: `routes/hooks.ts`
- Extract: all `/api/hooks/*` routes + `resolveRuntimePath`, `checkSessionClaim`
- Move `startSessionCleanup()` call inside mount function

### Step 7: `routes/tasks-diagnostics-analytics.ts`
- Extract: `/api/tasks/*`, `/api/diagnostics/*`, `/api/repair/*`,
  `/api/analytics/*`, `/api/timeline/*`
- Uses `state.providerTracker`, `state.analyticsCollector`, `state.repairLimiter`
- Move `resolveRepairContext` and permission guards inside

### Step 8: `routes/admin.ts`
- Extract: health, status, auth, config, identity, harnesses, secrets, logs, update
- These are all small routes grouped as "admin/dashboard" endpoints

### Step 9: `routes/embeddings.ts`
- Extract: `/api/embeddings/*` + all legacy embedding helpers, projection state
- Uses `fetchEmbedding`, `blobToVector`, `checkEmbeddingProvider` from shared-utils

### Step 10: `routes/memory.ts`
- Extract: all `/api/memory/*`, `/api/memories`, `/memory/search`, `/memory/similar`
- Move all private helpers: `parsePrefixes`, `buildForgetCandidatesWhere`,
  `loadForgetCandidates`, `buildWhere`, `buildWhereRaw`, `toRecord`,
  `readOptionalJsonObject`, `parseOptional*`, `parseModifyPatch`,
  `MAX_MUTATION_BATCH`, `FORGET_CONFIRM_THRESHOLD`, etc.
- Move permission guards for memory routes inside
- Largest extraction (~2,200 lines) — saved for last so all shared-utils
  are already proven

### Step 11: Cleanup daemon.ts
- Remove dead imports and any leftover helpers
- Verify daemon.ts is ~300 lines: imports, state creation, middleware, mount calls,
  git API routes, dashboard serving, main()

## Key Dependencies

- `packages/daemon/src/daemon.ts` — the file being split
- `packages/daemon/src/mcp/route.ts` — pattern to follow
- `packages/daemon/src/db-accessor.ts` — `getDbAccessor()` singleton, used by all routes
- `packages/daemon/src/auth/index.ts` — `AuthConfig`, `AuthRateLimiter` types for DaemonState
- `packages/daemon/src/diagnostics.ts` — `createProviderTracker` return type
- `packages/daemon/src/analytics.ts` — `AnalyticsCollector` type
- `packages/daemon/src/hooks.ts` — handler functions imported by routes/hooks.ts

## Cross-Cutting Concerns

- **fetchEmbedding**: used by memory (remember/recall/modify), embeddings, repair.
  Lives in shared-utils.ts
- **resolveMutationActor**: used by memory routes and documents DELETE.
  Lives in shared-utils.ts
- **inferType**: duplicated in daemon.ts and hooks.ts. Consolidate in shared-utils.ts
- **checkEmbeddingProvider + cache**: used by /api/status and /api/embeddings/status.
  Lives in shared-utils.ts

## Verification

After each step:
1. `bun run build` — confirms no import/type errors
2. `bun test` — confirms no behavioral regressions
3. `curl http://localhost:3850/health` — spot-check daemon still starts

After all steps:
1. Full `bun run typecheck` pass
2. Run daemon locally, hit a sampling of endpoints via curl
3. Verify dashboard still loads at localhost:3850
4. Verify MCP endpoint still works
