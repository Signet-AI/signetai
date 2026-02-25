---
title: "Multi-agent support for Signet"
---

Multi-agent support for Signet
===

Context
---

Solvr deployment needs 3 agents (Dot, Rose, Miles) running on a
single Mac Studio with one Signet daemon and one OpenClaw gateway.
Today Signet is single-agent only — one identity, one memory pool,
one personality per ~/.agents/ install. OpenClaw already supports
multi-agent natively (agents.list + bindings in openclaw.json),
so the gap is entirely on the Signet side.

User decisions:
- **Memory**: Hybrid — single SQLite DB, daemon enforces scope at
  API level (agent_id column + scope flag: global vs private)
- **Directory**: `~/.agents/agents/{name}/` subdirectories, each
  with their own identity files (SOUL.md, IDENTITY.md, etc.)
- **Skills**: Shared pool at `~/.agents/skills/`, per-agent
  allowlist in agent.yaml
- **Harness scope**: OpenClaw + Compass only. Claude Code stays
  single-agent (it's the operator's personal agent).

Critical files
---

- `packages/daemon/src/daemon.ts` — HTTP server, memory schema,
  file watcher, harness sync (~4650 LOC)
- `packages/daemon/src/hooks.ts` — Request/response interfaces
- `packages/daemon/src/memory-config.ts` — Config loading
- `packages/core/src/types.ts` — AgentManifest, Memory types
- `packages/core/src/identity.ts` — Identity file detection,
  IDENTITY_FILES spec (line 56-97), loadIdentityFiles (line 206)
- `packages/core/src/skills.ts` — Skill registry, unification
- `packages/cli/src/cli.ts` — CLI commands (~4650 LOC)
- `packages/cli/dashboard/src/` — SvelteKit dashboard
- `packages/connector-openclaw/src/index.ts` — OpenClaw sync
- `packages/adapters/openclaw/src/index.ts` — Runtime plugin
- `~/.agents/agent.yaml` — User config manifest


Implementation phases
---

### Phase 1: Core types — AgentDefinition + roster

File: `packages/core/src/types.ts`

```typescript
interface AgentDefinition {
  readonly name: string;
  readonly model?: string;
  readonly skills?: readonly string[];
  readonly personality?: string;  // relative path to SOUL.md
}
```

Extend AgentManifest with optional `agents` field:
```typescript
readonly agents?: {
  readonly roster: readonly AgentDefinition[];
};
```

### Phase 2: Agent registry — discovery + scaffold + inheritance

New file: `packages/core/src/agents.ts`

- `discoverAgents(agentsDir)` — scan `~/.agents/agents/*/`
  for subdirs, return AgentDefinition[]
- `scaffoldAgent(name, agentsDir)` — create directory +
  template SOUL.md, IDENTITY.md
- `getAgentIdentityFiles(name, agentsDir)` — resolve identity
  file paths with **inheritance fallback**: check agent subdir
  first, fall back to root-level `~/.agents/` for any missing
  file. Only SOUL.md and IDENTITY.md are expected to be
  overridden per agent. AGENTS.md, USER.md, TOOLS.md inherit
  from root by default.
- `resolveAgentSkills(agent, sharedSkills)` — filter shared
  pool by agent's allowlist. Empty/missing list = all skills.

**Identity inheritance** (addresses current gap in identity.ts
where loadIdentityFiles only checks one basePath):
```
resolve(file, agentName):
  1. ~/.agents/agents/{agentName}/{file}  ← agent override
  2. ~/.agents/{file}                     ← root default
```

### Phase 3: DB schema — add agent scoping columns

File: `packages/daemon/src/daemon.ts`

Add to `requiredColumns` array at line ~4509:
```
{ table: 'memories', column: 'agent_id', type: 'TEXT DEFAULT "default"' }
{ table: 'memories', column: 'scope',    type: 'TEXT DEFAULT "global"' }
```

Existing memories get agent_id='default', scope='global'.
Fully backwards compatible via ALTER TABLE — no migration.

**FTS5 handling** — the FTS5 virtual table does NOT get an
agent_id column. Instead, agent scoping is done as a post-join
filter on the memories table after the FTS5 MATCH:

```sql
SELECT m.* FROM memories_fts
JOIN memories m ON memories_fts.rowid = m.rowid
WHERE memories_fts MATCH ?
  AND (m.scope = 'global' OR m.agent_id = ?)
ORDER BY bm25(memories_fts) LIMIT ?
```

This avoids rebuilding the FTS5 virtual table and its 3
triggers (INSERT/UPDATE/DELETE at lines 4560-4584), which
would be a breaking migration for existing databases. The
post-join filter is slightly less efficient but the memories
table is small enough (3441 rows currently) that it won't
matter.

Vector search (sqlite-vec) already joins through the
embeddings table, so adding the same WHERE clause to the
final JOIN is trivial.

**Orphaned memory cleanup**: When an agent is removed via CLI,
don't auto-delete memories. Instead mark them scope='archived'.
A `signet agent purge <name>` command explicitly deletes.

### Phase 4: Daemon API — scoped memory + agent endpoints

File: `packages/daemon/src/daemon.ts`

a) Helper: `buildAgentScopeClause(agentId?)` — returns SQL
   WHERE fragment. If agentId is provided, returns memories
   where scope='global' OR agent_id matches. If omitted,
   returns only scope='global' (safe default).

b) Update `/memory/search` (line ~1300), `/api/memories`,
   remember/recall handlers to accept `agentId` query param.

c) New endpoints:
   - `GET /api/agents` — list discovered agents + roster
   - `GET /api/agents/:name` — agent detail, resolved
     identity files, effective skills
   - `POST /api/agents` — scaffold new agent
   - `DELETE /api/agents/:name` — archive agent (marks
     memories, doesn't delete directory — CLI handles that)

File: `packages/daemon/src/hooks.ts`

Add to RememberRequest and RecallRequest:
```typescript
agentId?: string;
scope?: 'global' | 'private';
```
(SessionStartRequest already has agentId.)

### Phase 5: File watcher — watch agent subdirectories

File: `packages/daemon/src/daemon.ts`, `startFileWatcher()`

Add `~/.agents/agents/` to chokidar watch paths. On change
inside an agent subdir, trigger sync for that agent only
(not a full harness rebuild). Parse the agent name from the
changed file path.

### Phase 6: Harness sync — per-agent OpenClaw workspaces

File: `packages/daemon/src/daemon.ts`

New function `syncAgentsToOpenClaw()` called from
`syncHarnessConfigs()` (line ~3750):

For each agent in the roster:
1. Resolve merged identity (root defaults + agent overrides)
2. Write assembled AGENTS.md to a per-agent workspace dir
   at `~/.agents/agents/{name}/workspace/`
3. Call connector to patch openclaw.json (see Phase 8)

### Phase 7: CLI — `signet agent` commands

File: `packages/cli/src/cli.ts`

New subcommand group:
- `signet agent list` — discovered agents + roster status
- `signet agent add <name>` — scaffold, prompt for SOUL.md
  personality description, add to roster in agent.yaml
- `signet agent remove <name>` — archive memories, remove
  from roster, optionally delete directory
- `signet agent purge <name>` — permanently delete agent
  memories and directory
- `signet agent info <name>` — resolved identity, skills,
  memory stats

Add `--agent <name>` flag to:
- `signet remember` — sets agent_id + scope on memory
- `signet recall` — scopes search to agent's visible memories

### Phase 8: OpenClaw connector — multi-agent sync

File: `packages/connector-openclaw/src/index.ts`

New `syncMultipleAgents(roster, basePath)` method:

Currently the connector patches `agents.defaults.workspace`
to `~/.agents` (line 257-275, deep merge). For multi-agent:

a) Build `agents.list` array from roster:
```typescript
{
  agents: {
    defaults: { workspace: basePath },
    list: roster.map(agent => ({
      id: agent.name,
      name: agent.name,
      workspace: join(basePath, 'agents', agent.name, 'workspace'),
      skills: agent.skills ?? undefined,
      identity: {
        // resolved SOUL.md content for this agent
      }
    }))
  }
}
```

b) Optionally generate `bindings` array if user provides
   channel routing config in agent.yaml.

c) Keep the deep-merge pattern — idempotent, safe to re-run.

File: `packages/adapters/openclaw/src/index.ts`

The adapter already accepts `agentId` on `onSessionStart()`
(line 66-100). The gap is that `createPlugin()` (line 274)
doesn't extract agentId from the OpenClaw session context.
Fix: read `ctx.agentId` (provided by OpenClaw when it
resolves which agent handles the current chat) and pass it
through to all daemon calls.

### Phase 9: Dashboard — agent roster view

File: `packages/cli/dashboard/src/`

a) New API functions in `lib/api.ts`:
   - `listAgents()` → GET /api/agents
   - `getAgent(name)` → GET /api/agents/:name
   - `createAgent(name)` → POST /api/agents

b) Add agent context to LeftSidebar.svelte (section 01,
   currently just "Identity"). Show a dropdown/switcher
   listing discovered agents. Selected agent scopes the
   Memory tab's queries.

c) New "Agents" tab in center panel (7th tab alongside
   Config, Memory, Embeddings, Logs, Secrets, Skills):
   - Agent cards showing name, personality summary, skill
     count, memory count
   - Add/remove agent actions
   - Per-agent memory stats

d) Update `+page.ts` data loader to fetch agent list on
   initial load.

### Phase 10: Setup wizard — multi-agent configuration

File: `packages/cli/src/cli.ts`, `setupWizard()` (line 1413)

Add a new path in the existing setup wizard decision tree:

After detecting an existing Signet install (line 1447), add
option 7: "Configure multiple agents". This launches a
sub-wizard:

1. "How many agents?" → prompt for count
2. For each agent: name, personality description (writes
   SOUL.md), skill allowlist (from available skills)
3. "Configure OpenClaw routing?" → optional bindings setup
4. Writes agents.roster to agent.yaml
5. Scaffolds directories, triggers sync

For fresh installs (line 1552), after single-agent identity
creation, ask: "Set up additional agents?" → enters the same
sub-wizard.


Updates and migrations
---

**Existing installs upgrading to multi-agent Signet**:

- DB columns added via `requiredColumns` ALTER TABLE — this
  is the established live-upgrade pattern (daemon.ts:4509).
  No migration script needed. Existing memories get
  agent_id='default', scope='global' automatically.
- FTS5 virtual table is NOT modified — no rebuild needed.
- agent.yaml gains optional `agents.roster` field — old
  configs without it continue working (single-agent mode).
- The `signet setup` wizard detects whether agents.roster
  exists and shows appropriate options.
- Dashboard gracefully handles zero agents (shows single
  identity view as today).

**Version compatibility**: The daemon serves both single-agent
and multi-agent installs. All new API params are optional with
sensible defaults (no agentId = default agent = current
single-agent behavior).

**Update checker** (daemon.ts:2652-2710) is unaffected — it
checks npm/GitHub for new versions, not schema changes.


Edge cases
---

**FTS5 + agent scoping**: Post-join filter instead of FTS5
column. Slightly less efficient but avoids breaking migration.
At 3441 memories this is negligible. If scale becomes an issue
later, rebuild FTS5 with agent_id column behind a flag.

**Concurrent agent writes**: SQLite WAL mode + busy_timeout=5s
(daemon.ts:1098) handles this. Two agents writing
simultaneously: one waits up to 5s. At expected write volumes
(a few memories per session) this is fine. Not a hot path.

**Deleted agent with orphaned memories**: Memories are NOT
auto-deleted when an agent is removed. They're marked
scope='archived' and excluded from search. Explicit
`signet agent purge` deletes permanently. This prevents
accidental data loss.

**Agent with no SOUL.md override**: Falls back to root
~/.agents/SOUL.md via inheritance chain. Agent still works
but has the default personality. `signet agent info` shows
which files are inherited vs overridden.

**Empty skills allowlist**: Means "all skills" (same as
OpenClaw convention where omitting `skills` = all). An
explicit empty array `skills: []` means no skills.

**Config validation**: agent.yaml parsing currently has no
schema validation (memory-config.ts uses unsafe casts, yaml.ts
silently produces NaN). This is a pre-existing issue, not
caused by multi-agent. We should add basic validation for the
new `agents.roster` field (name required, unique names,
allowlist entries exist in skills pool) but a full validation
overhaul is out of scope.

**Race in harness sync**: If two agent identity files change
within the 2s debounce window, both trigger sync. The sync
function is idempotent (writes final state, not incremental),
so this is safe — worst case is two syncs instead of one.


What we are NOT doing
---

- NOT creating multiple daemon instances
- NOT creating multiple OpenClaw instances
- NOT changing Claude Code behavior (stays single-agent)
- NOT rebuilding FTS5 virtual table (post-join filter instead)
- NOT adding per-agent databases (single DB, column scoping)
- NOT adding crypto-level memory isolation (API-enforced scope
  is sufficient — HIPAA compliance comes from on-prem + FDE,
  not from memory partitioning within a trusted daemon)
- NOT overhauling config validation (out of scope, pre-existing)


Verification
---

1. `bun test` passes after each phase
2. `bun run build` succeeds
3. `bun run lint` clean
4. Single-agent regression: existing install with no
   agents.roster works identically to before
5. `signet agent add dot` scaffolds ~/.agents/agents/dot/
   with template SOUL.md, IDENTITY.md
6. `signet agent list` shows roster with resolved skills
7. `signet remember "test" --agent dot` stores with
   agent_id='dot', scope defaults to 'global'
8. `signet remember "private note" --agent dot --private`
   stores with scope='private'
9. `signet recall "test" --agent dot` returns global +
   dot's private memories
10. `signet recall "test"` without --agent returns global only
11. Dashboard shows agent roster in sidebar, agent tab with
    cards, memory tab respects agent selector
12. `GET /api/agents` returns discovered agents from daemon
13. OpenClaw config gets agents.list entries after sync
14. File changes in ~/.agents/agents/dot/ trigger sync for
    dot only (check daemon logs)
15. `signet agent remove dot` archives memories, removes
    from roster
