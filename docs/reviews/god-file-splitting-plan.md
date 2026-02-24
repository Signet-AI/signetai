# God File Splitting Plan

**daemon.ts** (7,142 lines) → target ~10 modules, ~300-700 lines each  
**cli.ts** (8,377 lines) → target ~12 modules, ~200-700 lines each

**Date:** 2025-02-24  
**Status:** Draft  

---

## Table of Contents

1. [Design Principles](#design-principles)
2. [Daemon Modules](#daemon-modules-daemonts)
3. [CLI Modules](#cli-modules-clits)
4. [Shared State Management](#shared-state-management)
5. [Migration Strategy](#migration-strategy)
6. [Upstream Convention Alignment](#upstream-convention-alignment)
7. [Risk Assessment](#risk-assessment)

---

## Design Principles

### Hono Best Practice: `app.route()` for Modular Routing

Per [Hono's official best practices](https://hono.dev/docs/guides/best-practices), large applications should split routes into sub-Hono instances and mount them with `app.route()`. Each route module creates its own `new Hono()` and exports it. The parent app mounts them at a prefix.

**Pattern (already used for MCP):**
```ts
// routes/memory.ts
import { Hono } from "hono";
const app = new Hono();
app.get("/", (c) => c.json({ ... }));
app.post("/remember", async (c) => { ... });
export default app;

// daemon.ts
import memoryRoutes from "./routes/memory";
app.route("/api/memory", memoryRoutes);
```

### Commander.js: Separate Command Files

Commander.js supports `.command()` on a sub-command object exported from separate files. Each file creates a `Command` instance and registers its `.action()` handlers. The parent program adds them with `program.addCommand()` or imports a function that registers on the program.

**Pattern:**
```ts
// commands/did.ts
import { Command } from "commander";
export function registerDidCommands(program: Command) {
  const didCmd = program.command("did").description("...");
  didCmd.command("init").action(async () => { ... });
  didCmd.command("show").action(async () => { ... });
}

// cli.ts
import { registerDidCommands } from "./commands/did";
registerDidCommands(program);
```

### Guiding Rules

1. **No behavioral changes.** Every route/command must produce identical output before and after.
2. **One section = one file.** The existing `// ============` section comments are natural boundaries.
3. **Shared state via function parameters**, not globals. Route factories receive `{ getDbAccessor, authConfig, ... }` via closures.
4. **Incremental migration.** Move one section per PR. Each PR is independently shippable and testable.
5. **Match existing patterns.** The codebase already has `mcp/route.ts`, `auth/`, `pipeline/`, `connectors/` modules. New route modules go under `routes/`.

---

## Daemon Modules (daemon.ts)

### Current Structure (7,142 lines)

| Lines | Section | Proposed Module |
|-------|---------|-----------------|
| 1–236 | Imports, constants, singletons | `daemon.ts` (remains) |
| 237–827 | Memory helpers (embedding, parsing, legacy compat) | `routes/_memory-helpers.ts` |
| 828–834 | MCP mount | `mcp/route.ts` (already extracted ✓) |
| 835–895 | Auth API (`/api/auth/*`) | `routes/auth.ts` |
| 896–1038 | Route-level permission guards | `routes/_guards.ts` |
| 1039–1092 | Logs API (`/api/logs/*`) | `routes/logs.ts` |
| 1093–1178 | Config API (`/api/config`) | `routes/config.ts` |
| 1179–1207 | Identity API (`/api/identity`) | `routes/config.ts` (small, co-locate) |
| 1208–1265 | Memories API (`/api/memories`) | `routes/memories.ts` |
| 1266–3336 | Memory Search + Native Memory API (remember/recall/forget/modify) | `routes/memory.ts` |
| 3337–3437 | Memory Similar API | `routes/memory.ts` |
| 3438–3648 | Embeddings API (`/api/embeddings/*`) | `routes/embeddings.ts` |
| 3649–3915 | Documents API (`/api/documents/*`) | `routes/documents.ts` |
| 3916–4193 | Connectors API (`/api/connectors/*`) | `routes/connectors.ts` |
| 4194–4523 | Skills API (`/api/skills/*`) | `routes/skills.ts` |
| 4524–4601 | Harnesses API (`/api/harnesses`) | `routes/skills.ts` (co-locate) |
| 4602–4679 | Secrets API (`/api/secrets/*`) | `routes/secrets.ts` |
| 4683–5007 | Hooks API (`/api/hooks/*`) | `routes/hooks.ts` |
| 5008–5061 | Git Sync API (`/api/git/*`) | `routes/git.ts` |
| 5062–5189 | Update System API (`/api/update/*`) | `routes/update.ts` |
| 5190–5242 | Daemon Info (`/api/status`) | `routes/status.ts` |
| 5243–5369 | Diagnostics & Repair (`/api/diagnostics/*`, `/api/repair/*`) | `routes/diagnostics.ts` |
| 5370–5534 | Analytics & Timeline (`/api/analytics/*`, `/api/timeline/*`) | `routes/analytics.ts` |
| 5535–5589 | Static Dashboard | `daemon.ts` (remains) |
| 5590–5595 | File Watcher | `file-watcher.ts` |
| 5596–6613 | Git Sync System (internal logic) | `git-sync.ts` |
| 6614–6926 | OpenClaw Memory Markdown Ingestion | `memory-ingestion.ts` |
| 6927–6974 | Shutdown Handling | `daemon.ts` (remains) |
| 6975–7142 | Main function | `daemon.ts` (remains) |

### New File Layout

```
packages/daemon/src/
├── daemon.ts              (~500 lines) — app creation, middleware, mount all routes, main()
├── routes/
│   ├── _types.ts          (~40 lines)  — DaemonContext interface, shared types
│   ├── _memory-helpers.ts (~590 lines) — fetchEmbedding, vectorToBlob, parsePrefixes, etc.
│   ├── _guards.ts         (~150 lines) — permission guard middleware factories
│   ├── auth.ts            (~70 lines)  — /api/auth/whoami, /api/auth/token
│   ├── logs.ts            (~60 lines)  — /api/logs, /api/logs/stream
│   ├── config.ts          (~120 lines) — /api/config, /api/identity
│   ├── memories.ts        (~60 lines)  — /api/memories (list endpoint)
│   ├── memory.ts          (~2100 lines)— /api/memory/* (remember, recall, forget, modify, search, similar)
│   ├── embeddings.ts      (~220 lines) — /api/embeddings, /api/embeddings/status, /api/embeddings/projection
│   ├── documents.ts       (~270 lines) — /api/documents/*
│   ├── connectors.ts      (~280 lines) — /api/connectors/*
│   ├── skills.ts          (~410 lines) — /api/skills/*, /api/harnesses
│   ├── secrets.ts         (~80 lines)  — /api/secrets/*
│   ├── hooks.ts           (~330 lines) — /api/hooks/*
│   ├── git.ts             (~60 lines)  — /api/git/*
│   ├── update.ts          (~130 lines) — /api/update/*
│   ├── status.ts          (~60 lines)  — /api/status
│   ├── diagnostics.ts     (~130 lines) — /api/diagnostics/*, /api/repair/*
│   └── analytics.ts       (~170 lines) — /api/analytics/*, /api/timeline/*
├── git-sync.ts            (~1020 lines)— Git credential resolution, sync logic, timers
├── memory-ingestion.ts    (~320 lines) — OpenClaw markdown file ingestion
├── file-watcher.ts        (~50 lines)  — chokidar watcher setup
├── (existing files unchanged)
│   ├── auth/
│   ├── connectors/
│   ├── db-accessor.ts
│   ├── hooks.ts
│   ├── mcp/
│   ├── pipeline/
│   ├── transactions.ts
│   └── ...
```

### Module Boundary Details

#### `routes/_types.ts` (~40 lines)
Shared context type passed to every route factory:

```ts
import type { DbAccessor } from "../db-accessor";
import type { AuthConfig, AuthRateLimiter } from "../auth";
import type { AnalyticsCollector } from "../analytics";
import type { EmbeddingConfig } from "../memory-config";

export interface DaemonContext {
  getDbAccessor: () => DbAccessor;
  authConfig: AuthConfig;
  authSecret: Buffer | null;
  rateLimiters: {
    forget: AuthRateLimiter;
    modify: AuthRateLimiter;
    batchForget: AuthRateLimiter;
    admin: AuthRateLimiter;
  };
  agentsDir: string;
  memoryDb: string;
  providerTracker: ReturnType<typeof createProviderTracker>;
  analyticsCollector: AnalyticsCollector;
  repairLimiter: ReturnType<typeof createRateLimiter>;
  embeddingConfig: EmbeddingConfig;
  fetchEmbedding: (text: string, cfg: EmbeddingConfig) => Promise<number[] | null>;
  currentVersion: string;
}
```

#### `routes/memory.ts` (~2,100 lines) — THE BIG ONE
This is the core domain logic and is justifiably the largest module. It encompasses:
- `buildWhereRaw()` / `buildWhere()` — SQL filter builders
- `GET /memory/search` — FTS + filter search
- `POST /api/memory/remember` — full ingest with embedding, dedup, envelope signing
- `POST /api/memory/save` — alias
- `POST /api/hook/remember` — alias
- `GET /api/memory/:id` — single memory fetch
- `GET /api/memory/:id/history` — audit trail
- `POST /api/memory/:id/recover` — restore deleted
- `PATCH /api/memory/:id` — modify  
- `DELETE /api/memory/:id` — soft delete
- `POST /api/memory/forget` — natural language forget
- `POST /api/memory/modify` — natural language modify
- `POST /api/memory/recall` — hybrid search (the big one: ~450 lines)
- `GET /api/memory/search` — query string search
- `GET /memory/similar` — vector similarity

**Future split candidate:** If 2,100 lines still feels too big, recall/search (lines 2895-3336, ~440 lines) could be split into `routes/memory-search.ts`. But better to do this in a second pass after the initial split stabilizes.

#### `routes/hooks.ts` (~330 lines)
All `/api/hooks/*` endpoints. Most hook logic already lives in `src/hooks.ts` — the route file just does request parsing, session claim checking, and delegates. Keep the session tracker imports inline.

#### `git-sync.ts` (~1,020 lines)  
The git credential resolution system (`resolveGitCredentials`, `getGhCliToken`, etc.), sync/pull/push functions, and the timer management. This is internal infrastructure, not a route — it gets imported by `routes/git.ts` for the API surface and by `daemon.ts` for timer lifecycle.

#### `memory-ingestion.ts` (~320 lines)
The OpenClaw markdown chunking and ingestion system (`chunkMarkdownHierarchically`, `ingestMemoryMarkdown`, `importExistingMemoryFiles`, `syncExistingClaudeMemories`). Called from `main()` after server starts.

---

## CLI Modules (cli.ts)

### Current Structure (8,377 lines)

| Lines | Section | Proposed Module |
|-------|---------|-----------------|
| 1–175 | Imports, template helpers | `cli.ts` (remains) |
| 176–240 | Git helpers | `commands/_helpers.ts` |
| 241–409 | Daemon management (start/stop/status) | `commands/_daemon-mgmt.ts` |
| 410–480 | Harness hook configuration | `commands/_harness-hooks.ts` |
| 481–853 | Helpers (logo, version, signetLogo, detection) | `commands/_helpers.ts` |
| 854–1119 | Interactive TUI Menu | `commands/setup.ts` |
| 1120–1423 | Existing Setup Migration | `commands/setup.ts` |
| 1424–2119 | Setup Wizard | `commands/setup.ts` |
| 2120–2302 | Import from GitHub | `commands/setup.ts` |
| 2303–2702 | Dashboard, migrate-schema, status, logs, CLI def start | `commands/daemon.ts` |
| 2703–3187 | CLI definition (program, daemon subcommands, sync, config) | `cli.ts` (registration) + `commands/config.ts` |
| 3188–3338 | Secrets management | `commands/secrets.ts` |
| 3339–3714 | Skills commands | `commands/skills.ts` |
| 3715–3851 | Remember / recall | `commands/memory.ts` |
| 3852–4096 | Document ingest | `commands/memory.ts` |
| 4097–4309 | Knowledge health | `commands/memory.ts` |
| 4310–4468 | Session stats | `commands/memory.ts` |
| 4469–4604 | Embed audit/backfill | `commands/memory.ts` |
| 4605–4800 | Export / import | `commands/bundles.ts` |
| 4801–5078 | Hook lifecycle commands | `commands/hooks.ts` |
| 5079–5426 | Update commands | `commands/update.ts` |
| 5427–5611 | Git sync commands | `commands/git.ts` |
| 5612–5710 | Migrate vectors | `commands/migrate.ts` |
| 5711–5873 | DID commands | `commands/did.ts` |
| 5874–6490 | Memory signing | `commands/signing.ts` |
| 6491–6936 | On-chain identity | `commands/chain.ts` |
| 6937–7100 | Session keys | `commands/chain.ts` |
| 7101–7158 | Payments | `commands/chain.ts` |
| 7159–7306 | Bundle export/import (signed) | `commands/chain.ts` |
| 7307–7788 | Perception layer + perceive subcommands | `commands/perceive.ts` |
| 7789–8358 | Federation commands | `commands/federation.ts` |
| 8359–8377 | Default action + parse | `cli.ts` (remains) |

### New File Layout

```
packages/cli/src/
├── cli.ts                    (~300 lines) — program definition, mount all commands, parse
├── commands/
│   ├── _helpers.ts           (~450 lines) — signetLogo, detection, git helpers, daemon API utils
│   ├── _daemon-mgmt.ts       (~170 lines) — isDaemonRunning, startDaemon, stopDaemon, formatUptime
│   ├── _harness-hooks.ts     (~70 lines)  — configureHarnessHooks
│   ├── setup.ts              (~1300 lines)— setup wizard, migration, TUI menu, GitHub import
│   ├── daemon.ts             (~400 lines) — daemon start/stop/restart/status/logs, dashboard, migrate-schema
│   ├── config.ts             (~300 lines) — interactive config editor
│   ├── secrets.ts            (~150 lines) — secret put/list/delete/has
│   ├── skills.ts             (~380 lines) — skill list/install/uninstall/search/show
│   ├── memory.ts             (~750 lines) — remember, recall, ingest, knowledge, session-stats, embed
│   ├── bundles.ts            (~200 lines) — export/import portable bundles
│   ├── hooks.ts              (~280 lines) — hook session-start/end/remember/recall/synthesis
│   ├── update.ts             (~350 lines) — update check/install/status/enable/disable
│   ├── git.ts                (~190 lines) — git status/sync/pull/push/enable/disable
│   ├── migrate.ts            (~100 lines) — migrate-vectors
│   ├── did.ts                (~170 lines) — did init/show/document/verify
│   ├── signing.ts            (~620 lines) — memory sign-backfill/verify/verify-all
│   ├── chain.ts              (~610 lines) — chain register/anchor, session create/list/revoke, payments, bundles
│   ├── perceive.ts           (~480 lines) — perceive observe/profile/export/graph + perception commands
│   └── federation.ts         (~570 lines) — federation start/status, peer add/list/trust/block/remove, sync, publish
├── python.ts                 (unchanged)
└── sqlite.ts                 (unchanged)
```

### Module Boundary Details

#### `commands/_helpers.ts` (~450 lines)
Shared utilities used across many commands:
- `signetLogo()` — ASCII art banner
- `getCliVersion()`, `getVersionFromPackageJson()`
- `getTemplatesDir()`, `copyDirRecursive()`, `isBuiltinSkillDir()`, `syncBuiltinSkills()`
- `isGitRepo()`, `gitInit()`, `gitAddAndCommit()`
- `detectExistingSetup()`
- `fetchFromDaemon<T>()` — typed daemon API client
- `secretApiCall()` — daemon API call helper
- `ensureDaemonForSecrets()` — daemon check wrapper
- `daemonAuthHeaders()`, `getLocalToken()`

#### `commands/setup.ts` (~1,300 lines)
The largest CLI module, but it's a cohesive unit — the entire setup flow:
- Interactive TUI menu (`interactiveMenu()`)
- OpenClaw migration wizard (`migrateFromExisting()`)
- Main setup wizard (`setupWizard()`)
- GitHub import (`importFromGitHub()`)

These are tightly coupled (setup calls migration, TUI calls setup). Splitting further would create artificial boundaries.

#### `commands/chain.ts` (~610 lines)
All blockchain/web3 commands grouped together:
- `chain register` — ERC-8004 identity registration
- `chain anchor` — memory Merkle root anchoring
- `chain session create/list/revoke` — session key management
- `chain payments` — x402 payment history
- `chain bundle export/import` — signed bundle commands

#### `commands/memory.ts` (~750 lines)
All memory-related CLI commands:
- `remember <content>` — save memory via daemon
- `recall <query>` — search memories via daemon
- `ingest <path>` — document ingestion
- `knowledge status` — knowledge health dashboard
- `session-stats` — session continuity trend
- `embed audit/backfill` — embedding management

#### Registration Pattern for CLI Modules

Each module exports a `register` function:

```ts
// commands/did.ts
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import type { CLIContext } from "./_helpers";

export function registerDidCommands(program: Command, ctx: CLIContext) {
  const didCmd = program.command("did").description("Manage agent DID");
  
  didCmd.command("init").action(async () => {
    const { initializeAgentDid } = await import("@signet/core");
    console.log(ctx.logo());
    // ... rest of handler
  });
  
  // ... more subcommands
}
```

```ts
// cli.ts (slimmed down)
import { Command } from "commander";
import { createCLIContext } from "./commands/_helpers";
import { registerSetupCommands } from "./commands/setup";
import { registerDaemonCommands } from "./commands/daemon";
import { registerDidCommands } from "./commands/did";
// ... etc

const program = new Command();
const ctx = createCLIContext();

program.name("signet").version(ctx.version);

registerSetupCommands(program, ctx);
registerDaemonCommands(program, ctx);
registerDidCommands(program, ctx);
// ... mount all command modules

program.parse();
```

---

## Shared State Management

### Daemon: Dependency Injection via Context Object

The daemon's biggest challenge is shared mutable state: `authConfig`, `authSecret`, rate limiters, `getDbAccessor()`, `analyticsCollector`, `providerTracker`, etc.

**Solution:** Create a `DaemonContext` object in `main()` and pass it to each route factory. Routes close over the context.

```ts
// routes/memory.ts
import { Hono } from "hono";
import type { DaemonContext } from "./_types";

export function createMemoryRoutes(ctx: DaemonContext): Hono {
  const app = new Hono();
  
  app.post("/remember", async (c) => {
    const db = ctx.getDbAccessor();
    // ... use ctx.authConfig, ctx.fetchEmbedding, etc.
  });
  
  return app;
}
```

```ts
// daemon.ts
import { createMemoryRoutes } from "./routes/memory";

// In main():
const ctx: DaemonContext = { getDbAccessor, authConfig, authSecret, ... };
app.route("/api/memory", createMemoryRoutes(ctx));
```

**Why factory functions, not plain `new Hono()` exports:**
- Auth config is initialized in `main()` — route modules can't statically import it
- The db accessor is initialized after `main()` runs
- Rate limiters are rebuilt from config at startup
- This matches the Hono best practice of "don't make controllers" while still allowing dependency injection

### CLI: Lighter Context

The CLI's shared state is simpler — mostly constants and utility functions:

```ts
// commands/_helpers.ts
export interface CLIContext {
  agentsDir: string;
  daemonDir: string;
  daemonPort: number;
  version: string;
  logo: () => string;
  daemonAuthHeaders: () => Record<string, string>;
  fetchFromDaemon: <T>(path: string, opts?: RequestInit) => Promise<T | null>;
  secretApiCall: (method: string, path: string, body?: unknown) => Promise<{ ok: boolean; data: unknown }>;
  ensureDaemonForSecrets: () => Promise<boolean>;
}
```

---

## Migration Strategy

### Phase 0: Preparation (1 PR)

1. Create `routes/` directory in daemon, `commands/` directory in CLI
2. Create `routes/_types.ts` with `DaemonContext` interface
3. Create `commands/_helpers.ts` with `CLIContext` interface
4. **No behavior changes** — just scaffolding

### Phase 1: Extract Internal Logic First (2-3 PRs)

Extract non-route logic from daemon.ts that doesn't touch the Hono app:

1. **PR: `git-sync.ts`** — Move the entire Git Sync System (lines 5596–6613, ~1,020 lines). This is pure internal logic with no route handlers. The git API routes will import from this module.

2. **PR: `memory-ingestion.ts`** — Move OpenClaw markdown ingestion (lines 6614–6926, ~310 lines). Called from `main()` but self-contained.

3. **PR: `routes/_memory-helpers.ts`** — Move memory helper functions (lines 237–827, ~590 lines). These are utility functions used by multiple route modules. Must move before route modules.

**Validation:** Run full test suite after each PR. The daemon's behavior must be identical.

### Phase 2: Extract Small Route Modules (4-5 PRs)

Start with the smallest, most self-contained route modules:

1. **PR: `routes/auth.ts` + `routes/logs.ts` + `routes/config.ts`** — Small endpoints, low risk. ~250 lines total.

2. **PR: `routes/secrets.ts` + `routes/status.ts`** — Tiny modules, ~140 lines total.

3. **PR: `routes/skills.ts` + `routes/documents.ts`** — Medium modules with no cross-dependencies. ~680 lines total.

4. **PR: `routes/connectors.ts`** — Self-contained, already imports from `connectors/registry`. ~280 lines.

5. **PR: `routes/git.ts` + `routes/update.ts` + `routes/diagnostics.ts` + `routes/analytics.ts`** — Admin/ops routes. ~490 lines total.

### Phase 3: Extract Large Route Modules (2-3 PRs)

1. **PR: `routes/hooks.ts`** — Most logic lives in `src/hooks.ts`, so this is mostly request parsing. ~330 lines.

2. **PR: `routes/embeddings.ts` + `routes/memories.ts`** — Medium complexity, some shared helpers. ~280 lines.

3. **PR: `routes/memory.ts`** — The big one. ~2,100 lines. This is the core business logic. Move last because it depends on the most shared state. Test extensively.

### Phase 4: Extract CLI Command Modules (4-5 PRs)

1. **PR: `commands/_helpers.ts` + `commands/_daemon-mgmt.ts`** — Shared utilities first.

2. **PR: `commands/did.ts` + `commands/signing.ts` + `commands/chain.ts`** — Web3 commands are self-contained, use dynamic imports. ~1,400 lines.

3. **PR: `commands/federation.ts` + `commands/perceive.ts`** — Also self-contained with dynamic imports. ~1,050 lines.

4. **PR: `commands/memory.ts` + `commands/skills.ts` + `commands/secrets.ts`** — Core functionality. ~1,280 lines.

5. **PR: `commands/setup.ts` + `commands/config.ts` + `commands/daemon.ts`** — The setup wizard is complex but cohesive. ~2,000 lines.

6. **PR: `commands/hooks.ts` + `commands/update.ts` + `commands/git.ts` + `commands/bundles.ts` + `commands/migrate.ts`** — Remaining commands. ~1,120 lines.

### Phase 5: Cleanup (1 PR)

1. Verify daemon.ts is ~500 lines (imports, middleware, route mounting, main)
2. Verify cli.ts is ~300 lines (imports, program setup, command registration, parse)
3. Update any documentation referencing file locations
4. Add barrel exports if needed

---

## Upstream Convention Alignment

### Existing Patterns in the Codebase

| Pattern | Where Used | How We Align |
|---------|-----------|--------------|
| `mountXxxRoute(app)` | `mcp/route.ts` | Route factories follow this pattern but return a Hono instance for `app.route()` instead of mutating the parent |
| Subdirectory modules with `index.ts` | `auth/`, `pipeline/`, `mcp/` | `routes/` gets no barrel — each file is imported directly |
| `getDbAccessor()` singleton | `db-accessor.ts` | Context object wraps the accessor; route modules don't import the singleton directly |
| Dynamic `await import()` for heavy deps | CLI commands like `did`, `chain`, `federation` | Preserve this pattern — it keeps CLI startup fast |
| Test files co-located with source | `transactions.test.ts`, `pipeline/*.test.ts` | Route tests go in `routes/*.test.ts` |
| `_` prefix for internal files | Not yet used | Introduce for private helpers: `_types.ts`, `_memory-helpers.ts`, `_guards.ts` |

### Hono Typing Pattern

The codebase currently uses `app.get("/api/foo", (c) => { ... })` directly on the global app. When splitting into route modules, Hono's type inference works best with inline handlers (no controller pattern). Each route module creates its own `Hono<{ Variables: { auth: AuthState } }>` to preserve the `c.get("auth")` typing.

```ts
// routes/auth.ts
import { Hono } from "hono";
import type { DaemonContext } from "./_types";

type Env = { Variables: { auth: AuthState } };

export function createAuthRoutes(ctx: DaemonContext): Hono<Env> {
  const app = new Hono<Env>();
  // c.get("auth") is typed correctly
  app.get("/whoami", (c) => { ... });
  return app;
}
```

### Route Prefix Convention

When mounting with `app.route("/api/memory", memoryRoutes)`, the routes inside `memory.ts` use relative paths:
- `app.post("/remember", ...)` → serves `/api/memory/remember`
- `app.get("/:id", ...)` → serves `/api/memory/:id`

**Exception:** A few routes don't follow the `/api/` prefix pattern:
- `GET /memory/search` (legacy)
- `GET /memory/similar` (legacy)
- `GET /health`

These stay in `daemon.ts` directly, or get a `routes/legacy.ts` module.

---

## Risk Assessment

### Low Risk
- Extracting `git-sync.ts`, `memory-ingestion.ts`, `file-watcher.ts` — pure internal logic, no route changes
- Extracting small route modules (auth, logs, config, secrets, status) — minimal shared state
- Extracting CLI web3 commands (did, chain, federation) — already use dynamic imports, minimal coupling

### Medium Risk  
- Extracting `routes/memory.ts` — largest module, most shared state, most complex business logic
- Extracting CLI setup wizard — complex interactive flow with many dependencies
- The `DaemonContext` interface — if it gets wrong, many modules break

### Mitigations
- **Integration tests first:** Before splitting, add integration tests that hit every route. The existing `mutation-api.test.ts` is a good model. If routes return the same responses after extraction, the split is correct.
- **Git blame preservation:** Use `git mv` where possible so blame history transfers.
- **Feature flags:** During migration, `daemon.ts` can import route modules conditionally — if the module file exists, use it; otherwise fall back to the inline handler.
- **Type checking as guardrail:** The `DaemonContext` interface enforces that all shared state is explicitly declared. If a route module tries to access something not in the context, TypeScript will catch it.

---

## Estimated Total Effort

| Phase | PRs | Lines Moved | Risk |
|-------|-----|-------------|------|
| Phase 0: Scaffolding | 1 | ~100 new | None |
| Phase 1: Internal logic | 3 | ~1,920 | Low |
| Phase 2: Small routes | 5 | ~1,840 | Low |
| Phase 3: Large routes | 3 | ~2,710 | Medium |
| Phase 4: CLI commands | 6 | ~7,850 | Low-Medium |
| Phase 5: Cleanup | 1 | 0 | None |
| **Total** | **~19** | **~14,420** | |

Estimated calendar time: 2-3 weeks if done as focused work, or 4-6 weeks interleaved with feature work.

### Post-Split File Sizes

**Daemon:** daemon.ts drops from **7,142 → ~500 lines**. Largest new module: `routes/memory.ts` at ~2,100 lines (candidate for future split).

**CLI:** cli.ts drops from **8,377 → ~300 lines**. Largest new module: `commands/setup.ts` at ~1,300 lines (cohesive wizard flow).
