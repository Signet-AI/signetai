# Dashboard rewrite — Svelte API surface → React/mockup mapping

Reference for issue #948. Captures what the **current Svelte dashboard** actually
talks to (so M2 can reimplement it in React), maps that onto what the **locked
mockup** (`web/marketing/public/redesign-home-mockup.html`) has already staged,
and then lists what the Svelte app does that the mockup does **not** stage.

> **Scope rule.** Per #948 the mockup is the definitive visual spec. This doc is
> a *porting reference*, not a spec change. Anything listed in §4 as "missing
> from the mockup" is **assumed intentionally absent** and must NOT be
> implemented ad-hoc. If a Svelte feature has no mockup home, it either waits for
> a later milestone or for the mockup to be extended — it is not auto-restored.

## Recovering the Svelte source

The Svelte app was removed from the working tree on the M1 branch but is **fully
recoverable from git** (uncommitted deletion; intact in history):

```bash
git show main:surfaces/dashboard/src/lib/api.ts                 # central client, 3924 lines
git show main:surfaces/dashboard/src/lib/components/<File>.svelte
git grep -n 'fetch' main -- surfaces/dashboard/src
```

If a browsable copy is wanted during M2, restore the tree into a reference path
(e.g. `references/svelte-dashboard/`) — see §5.

---

## 1. Svelte API inventory (by domain)

Method shows what the client issues. **🔐** = auth-gated (`authFetch`, requires
dashboard auth token). All paths are relative to `API_BASE` (daemon root; `app://signet/` proxies `/health`, `/api/*`, `/memory/*` to the daemon in Electron).
SSE streams use a custom `AuthEventStream` (the sandboxed renderer can't use
native `EventSource` with headers, so auth is pumped manually).

### 1.1 Auth, identity & status
| Fn | Method | Path | Purpose |
|---|---|---|---|
| `getAuthStatus` | GET 🔐 | `/api/auth/whoami` | Current auth state (logged in / role) |
| `loginWithPassword` | POST 🔐 | `/api/auth/login` | Password login |
| — (auth surface) | GET 🔐 | `/api/auth/sso/start`, `/api/auth/saml/start` | SSO/SAML entry (referenced) |
| `getStatus` | GET | `/api/status` | Daemon status (mode, pipeline, resources) |
| `getHealth` | GET | `/health` | Liveness/health |
| `getIdentity` | GET 🔐 | `/api/identity` | SOUL/IDENTITY/USER/AGENTS parsed |
| `getConfigFiles` | GET 🔐 | `/api/config` | Read config files |
| `saveConfigFile` / `saveConfigFileResult` | POST 🔐 | `/api/config` | Write config (identity, memory cfg, etc.) |
| `getDiagnostics` | GET | `/api/diagnostics` | Provider/embedding diagnostics report |
| `getDatabaseSchema` | GET | `/api/diagnostics/database/schema` | DB schema introspection |
| `getDatabaseTableSample` | GET | `/api/diagnostics/database/tables/{t}/sample` | Row sample per table |
| `getGitStatus` | GET | `/api/git/status` | Workspace git sync state |

### 1.2 Memory
| Fn | Method | Path | Purpose |
|---|---|---|---|
| `getMemories` | GET 🔐 | `/api/memories` | Paginated memory list (filters: agent, type, source, pinned, who, …) |
| `getMemoryTimeline` | GET | `/api/memory/timeline` | Per-day counts (activity chart source) |
| `searchMemories` | GET | `/memory/search` | Similarity/keyword search |
| `recallMemories` | POST | `/api/memory/recall` | Scoped recall (canonical path) |
| `getDistinctWho` | GET | `/memory/search?distinct=who` | Agent/author facets |
| `getSimilarMemories` | GET | `/memory/similar` | Nearest neighbors of a memory |
| `setMemoryPinned` | PATCH | `/api/memory/{id}` | Pin toggle |
| `updateMemory` | PATCH | `/api/memory/{id}` | Edit memory text/metadata |
| `deleteMemory` | DELETE | `/api/memory/{id}` | Delete memory |

### 1.3 Embeddings & repair
| Fn | Method | Path | Purpose |
|---|---|---|---|
| `getEmbeddings` | GET | `/api/embeddings` | Raw embedding vectors (paginated) |
| `getProjection` | GET | `/api/embeddings/projection` | UMAP 2D/3D projection |
| `getEmbeddingHealth` | GET | `/api/embeddings/health` | Embedding health report |
| `getEmbeddingGapStats` | GET | `/api/repair/embedding-gaps` | Missing-vector gaps |
| `repairCleanOrphans` | POST | `/api/repair/clean-orphans` | Remove orphan rows |
| `repairReEmbed` | POST | `/api/repair/re-embed` | Re-embed memories |
| `repairResyncVectorIndex` | POST | `/api/repair/resync-vec` | Rebuild vector index |
| + repair actions | POST | `/api/repair/{retention-sweep, requeue-dead, release-leases, reclassify-entities, prune-singleton-entities, prune-chunk-groups, deduplicate, dedup-stats, cold-stats, check-fts, backfill-skipped}` | Maintenance ops surfaced in Audit tab |

### 1.4 Knowledge graph / ontology
| Fn | Method | Path | Purpose |
|---|---|---|---|
| `getKnowledgeEntities` | GET | `/api/knowledge/entities` | Entity list (paginated, scoped) |
| `getKnowledgeEntity` | GET | `/api/knowledge/entities/{id}` | Entity detail |
| `getKnowledgeAspects` | GET | `/api/knowledge/entities/{id}/aspects` | Aspects per entity |
| `getKnowledgeAttributes` | GET | `/api/knowledge/entities/{id}/aspects/{a}/attributes` | Attributes |
| `getKnowledgeDependencies` | GET | `/api/knowledge/entities/{id}/dependencies` | Entity dependency edges |
| `getKnowledgeStats` | GET | `/api/knowledge/stats` | Node counts (KPI source) |
| `getKnowledgeTraversalStatus` | GET | `/api/knowledge/traversal/status` | Graph build progress |
| `getPinnedKnowledgeEntities` | GET | `/api/knowledge/entities/pinned` | Pinned cluster |
| `pinKnowledgeEntity` / `unpinKnowledgeEntity` | POST/DELETE | `/api/knowledge/entities/{id}/pin` | Pin toggle |
| `getKnowledgeEntityHealth` | GET | `/api/knowledge/entities/health` | Per-entity health |
| `getConstellationOverlay` | GET | `/api/knowledge/constellation` | Force-graph overlay data |
| `getPredictor*` | GET | (predictor slices/runs) | ML predictor panels |

### 1.5 Sources & connectors
| Fn | Method | Path | Purpose |
|---|---|---|---|
| `getSources` | GET | `/api/sources` | Connected sources list |
| `getConnectors` | GET | `/api/connectors` | Connector list |
| `pickSourceDirectory` | POST | `/api/sources/pick-directory` | Native folder picker (desktop) |
| `addObsidianSource` | POST | `/api/sources/obsidian` | Add Obsidian vault |
| `addDiscordSource` | POST | `/api/sources/discord` | Add Discord source |
| `addGitHubSource` | POST | `/api/sources/github` | Add GitHub source |
| `removeSource` | DELETE | `/api/sources/{id}` | Disconnect source |
| `getSourceSnapshot` | GET | `/api/sources/{id}/snapshot` | Source snapshot/export |
| `importSourceSnapshot` | POST | `/api/sources/{id}/snapshot/import` | Re-import snapshot |
| `syncConnector` / `syncConnectorFull` | POST | `/api/connectors/{id}/sync(/full)` | Trigger connector sync |
| `resyncConnectors` | POST | `/api/connectors/resync` | Bulk resync |

### 1.6 Secrets (incl. 1Password)
| Fn | Method | Path | Purpose |
|---|---|---|---|
| `getSecrets` | GET | `/api/secrets` | Secret name list |
| `putSecret` | PUT | `/api/secrets/{name}` | Create/update secret |
| `deleteSecret` | DELETE | `/api/secrets/{name}` | Delete secret |
| `getOnePasswordStatus` | GET | `/api/secrets/1password/status` | 1Password connected? |
| `connectOnePassword` / `disconnectOnePassword` | POST | `/api/secrets/1password/connect` | Bind/unbind 1Password |
| `listOnePasswordVaults` | GET | `/api/secrets/1password/vaults` | List vaults |
| `importOnePasswordSecrets` | POST | `/api/secrets/1password/import` | Import from vault |

### 1.7 Skills
| Fn | Method | Path | Purpose |
|---|---|---|---|
| `getSkills` | GET | `/api/skills` | Installed skills |
| `getSkill` | GET | `/api/skills/{name}` | Skill detail |
| `searchSkills` | GET | `/api/skills/search` | Skill search |
| `browseSkills` | GET | `/api/skills/browse` | Registry browse |
| `installSkill` / `uninstallSkill` | POST/DELETE | `/api/skills/{name}` | Install/remove |
| `getSkillAnalytics` | GET | `/api/skills/analytics` | Usage analytics |

### 1.8 Plugins, Graphiq, Marketplace (MCP + reviews), Tasks
| Domain | Methods | Paths | Purpose |
|---|---|---|---|
| Plugins | GET/POST/PATCH | `/api/plugins`, `/api/plugins/{id}`, `…/diagnostics`, `…/audit` | Plugin enable/disable, diagnostics, audit log |
| Graphiq | GET/POST | `/api/graphiq/{status,install,update,uninstall,index}` | Code indexer lifecycle |
| Marketplace MCP | GET/POST/PUT/DELETE | `/api/marketplace/mcp{,/browse,/detail,/install,/register,/tools,/test,/{id}}` | MCP server marketplace |
| Marketplace reviews | GET/POST/DELETE | `/api/marketplace/reviews{,/config,/sync,/{id}}` | Reviews + Cloudflare worker sync |
| Tasks | GET/POST/PUT/DELETE | `/api/tasks{,/{id},/{id}/run,/{id}/runs}` | Scheduled/cortex tasks |

### 1.9 Pipeline, harnesses, inference, MCP analytics, OS
| Fn | Method | Path | Purpose |
|---|---|---|---|
| `getPipelineStatus` / `pausePipeline` / `resumePipeline` | GET/POST | `/api/pipeline/{status,pause,resume}` | Pipeline control |
| `getModelsByProvider` | GET | `/api/pipeline/models/by-provider` | Model registry grouped by provider |
| `getHarnesses` | GET 🔐 | `/api/harnesses` | Discovered harnesses |
| `regenerateHarnesses` | POST | `/api/harnesses/regenerate` | Regenerate harness configs |
| `getInferenceCatalog` | GET 🔐 | `/api/inference/catalog` | Model/provider catalog |
| `getInferenceStatus` | GET 🔐 | `/api/inference/status` | Active provider/auth status |
| `startOAuthLogin` | POST 🔐 (SSE) | `/api/inference/oauth/login/{provider}` | OAuth login stream (pi-ai: Claude Max/Codex/Copilot) |
| `completeOAuthInteraction` | POST 🔐 | `/api/inference/oauth/complete` | Finish OAuth |
| `disconnectOAuthProvider` | POST 🔐 | `/api/inference/oauth/disconnect/{provider}` | Revoke |
| `getMcpAnalytics` / `getMcpServerAnalytics` | GET | `/api/mcp/analytics{,/{server}}` | MCP usage |
| `installMcp` | POST | `/api/os/install` | Install MCP/OS widget |

### 1.10 Home, reflections, sessions, logs, content
| Fn | Method | Path | Purpose |
|---|---|---|---|
| `getHomeGreeting` | GET | `/api/home/greeting` | Home greeting copy |
| `getContinuityLatest` | GET | `/api/analytics/continuity/latest` | Daily-brief continuity entries |
| `getTodayReflection` / `generateReflection` | GET/POST | `/api/reflections/today`, `/api/reflections/generate` | Daily reflection prompts |
| `answerReflection` | POST | `/api/reflections/{id}/answer` | Answer a reflection |
| `fetchSessions` | GET | `/api/sessions` | Session list |
| `getBlackBoxSessions` / `getBlackBoxSession` | GET 🔐 | `/api/sessions/blackbox{,/{key}}` | Black-box session traces |
| `toggleSessionBypass` | POST | `/api/sessions/{key}/bypass` | Toggle hook bypass |
| Logs | GET (SSE) | `/api/logs/stream` | Live log tail (`AuthEventStream`) |
| Presence | GET | `/api/cross-agent/presence` | Cross-agent presence (issue #944) |
| `fetchChangelog` / `fetchRoadmap` / `fetchReadme` | GET | `/api/changelog`, `/api/roadmap`, `/api/readme` | Docs tabs (+ raw GitHub fetch) |

---

## 2. Mockup view inventory (what is actually staged)

Line density of each `data-view` in the mockup (only **Home** is fully designed;
the rest are thin stubs/empty-states):

| View | Staged content | Density |
|---|---|---|
| **home** | 4 KPI cards (Memories, Ontology nodes, Agents, Sources w/ trend + sync rings); Daily brief (paginated); Activity chart; Sources panel (4 connected); Review suggestions (Discard/Confirm/Merge/New agent/Skip/Link) | **427 lines — full** |
| **memory** | Memory-type filter only | 57 — stub |
| **graph** | Empty state w/ "Signet" watermark | 61 — stub |
| **sources** | Empty | 17 — stub |
| **secrets** | Vault + Unlock password gate + **Bitwarden** integration | 34 — partial |
| **skills** | Skill list structure | 37 — partial |
| **agents** | Empty | 22 — stub |
| **dreaming** | "Cortex buffer" label only | 27 — stub |
| **Settings modal** | Network (Listen port, Bind address), Cloud sync, Auto-commit, **15 inference providers** (Anthropic, OpenAI, Voyage, Google, Cohere, Mistral, Groq, Together, DeepSeek, Fireworks, OpenRouter, Ollama, ACPX, Perplexity, LocalAI), Identity stack (read-only + Edit), + modals (Connect a source, Add secret) | moderate |

---

## 3. Endpoint → mockup mapping (ports over directly)

What the M2 React build needs to wire up to match the staged pixels.

### Home (the only fully-staged view)
| Mockup element | Svelte endpoint(s) to port |
|---|---|
| KPI **Memories** count + "+N today" trend | `getMemories` (count) + `getMemoryTimeline` (delta) |
| KPI **Ontology nodes** | `getKnowledgeStats` |
| KPI **Agents** (3, "2 of 3 active", ring) | `getDistinctWho` and/or `/api/cross-agent/presence` |
| KPI **Sources** ("7, 4 of 7 syncing", ring) | `getSources` + `getConnectors` (sync state) |
| **Daily brief** (synthesized from memories) | `getContinuityLatest` + `getHomeGreeting`; pipeline generates it on dashboard-open |
| **Activity** chart (126 memories · 14d) | `getMemoryTimeline` |
| **Sources** panel (Obsidian/Drive/Notion/GitHub) | `getSources` |
| **Review suggestions** (Merge/New agent/Skip/Link) | `GET /api/memory/review-queue`, `GET /api/ontology/proposals?status=pending`, `POST /api/ontology/proposals/:id/{apply,reject}`, `POST /api/ontology/proposals/repair/merge-plan` — **see §6.1** (corrects the earlier "needs new endpoint" note; the control plane is fully HTTP-exposed, Svelte just never used it). |

### Settings modal
| Mockup element | Svelte endpoint(s) to port |
|---|---|
| Network (Listen port, Bind address) | `getStatus` (mode/bind) + `getConfigFiles`/`saveConfigFile` (network cfg) |
| Cloud sync, Auto-commit | `getGitStatus` + config write |
| 15 inference providers | `getInferenceCatalog` + `getInferenceStatus` + provider key config via `saveConfigFile`; OAuth flow (`startOAuthLogin`/`completeOAuthInteraction`) for pi-ai providers (#966) |
| Identity stack (Read-only/Config/Edit) | `getIdentity` + `getConfigFiles`/`saveConfigFile` |

### Secrets view
| Mockup element | Svelte endpoint(s) to port |
|---|---|
| Vault + Unlock gate | `getSecrets` (the unlock maps to dashboard auth, not 1Password) |
| **Bitwarden** integration shown | ⚠️ Mockup references **both** Bitwarden and 1Password; Svelte implemented **only 1Password**. Which secret backend(s) to ship is open — see §4 |

### Thin views (need design before porting)
memory / graph / sources / skills / agents / dreaming are stubs; their endpoints
are listed in §4 as "Svelte has it, mockup doesn't stage it."

---

## 4. Svelte features with NO mockup representation (the gap list)

These exist in the Svelte app today but are **not staged in the mockup**. Per the
scope rule, they are **assumed intentionally absent** — listed here so M2 knows
what is *not* being rebuilt yet and where future mockup work would slot in.

| Svelte feature (domain) | Svelte surface | Mockup home |
|---|---|---|
| **Embeddings viewer** (2D/3D canvas, inspector, UMAP) | `getEmbeddings`, `getProjection`, `getEmbeddingHealth` | none |
| **Repair / Audit** (re-embed, clean-orphans, retention-sweep, dedup, FTS check, DB schema/sample) | `/api/repair/*`, `/api/diagnostics/database/*` | none (Audit/Database tabs gone) |
| **Plugins management** (enable/disable, diagnostics, audit log) | `/api/plugins/*` | none |
| **Graphiq** (code indexer lifecycle) | `/api/graphiq/*` | none |
| **Marketplace — MCP servers** (browse/install/register/test) | `/api/marketplace/mcp/*` | none |
| **Marketplace — reviews** (+ Cloudflare worker sync) | `/api/marketplace/reviews/*` | none |
| **Tasks / Cortex** (create/run/schedule) | `/api/tasks/*` | "Cortex buffer" label only (dreaming) |
| **Pipeline control** (status graph, pause/resume) | `/api/pipeline/*` | none |
| **Logs viewer** (live SSE tail) | `/api/logs/stream` | none |
| **Sessions / Black-box traces / hook bypass** | `/api/sessions/*`, `/api/sessions/{key}/bypass` | none |
| **Reflections** (daily Q&A generate/answer) | `/api/reflections/*` | none (Home "Daily brief" is continuity, ≠ reflection Q&A) |
| **Harness discovery + regenerate** | `/api/harnesses`, `/api/harnesses/regenerate` | none (Settings "Connected harnesses" is read-only) |
| **OS / widget sandbox** (install, AppDock, AutoCard, AgentChat) | `/api/os/install`, `os/*` components | none |
| **Changelog / Roadmap / Readme tabs** | `/api/changelog`, `/api/roadmap`, `/api/readme` | none |
| **Onboarding flow** (the core #948 ask) | (Svelte had none — LoginScreen only) | not staged |
| **Multi-tenancy** (agents/projects/workspaces switcher) | (Svelte had agent scoping only) | sidebar implies it, not staged |

### Open clarifications — RESOLVED in §6 (audit against daemon route files)
- **Bitwarden vs 1Password** → **both ship** as daemon integrations
  (`/api/secrets/{bitwarden,1password}/*`). See §6.1, §6.3.
- **Review suggestions / merge queue** → backed by existing
  `/api/memory/review-queue` + `/api/ontology/proposals` endpoints. See §6.1.
- **OAuth providers in inference** → same surface as API-key providers; OAuth
  uses the SSE login path. See §6.3. No split needed.

---

## 5. Recommendation: keep Svelte browsable during M2

The deletions are uncommitted and fully recoverable, but a browsable copy is more
useful than `git show` lookups while reimplementing. Lowest-clutter option:

```bash
# restore into a reference path the React build + tsconfig ignore
git checkout main -- surfaces/dashboard/src surfaces/dashboard/static
git mv surfaces/dashboard/src references/svelte-dashboard/src   # (illustrative)
```

Then exclude it from the new `tsconfig.json` `include` and Vite processing so it
never affects the React build. The tradeoff: ~317 files live in-tree as inert
reference. If that clutter isn't worth it, leave it in history and consult via
`git show main:...` — the §1 inventory above is the index.

**Default recommendation:** leave Svelte in git history (not restored to tree),
use this doc as the index, and `git show` the specific component when porting it.
Restoring 317 inert files risks confusion about which dashboard is active.

---

## 6. Backend integration gaps — where the mockup needs daemon work

This section corrects and supersedes the "Open clarifications" note in §4.
Audited against the **actual daemon route files** in `platform/daemon/src/routes/`
(cross-referenced with the running daemon). The surprise: most of what the
mockup stages is **already backed by real endpoints** the Svelte client never
wired up. The genuine gaps are narrow and listed at the end.

### 6.1 Mockup surfaces that ALREADY have daemon support (port directly)

These need no daemon changes — the React dashboard just needs to call them.

| Mockup surface | Endpoint(s) that exist | Notes |
|---|---|---|
| **Home → Review suggestions** (Merge/Skip/New agent/Link) | `GET /api/memory/review-queue`, `GET /api/ontology/proposals?status=pending`, `POST /api/ontology/proposals/:id/{apply,reject}`, `POST /api/ontology/proposals/repair/merge-plan` | **Corrects §4** — this is NOT a new endpoint. The merge-queue / pending-proposals control plane is fully exposed over HTTP; Svelte just never used it. |
| **Home → Daily brief** | `GET /api/analytics/continuity/latest`, `GET /api/home/greeting` | Pipeline generates briefs on dashboard-open. |
| **Graph view → "Ask Signet" chat dock** | `POST /api/os/chat`, `GET /api/os/agent-events` (SSE) | os-chat routes inference through the router + MCP tool-calling. Full RAG chat is available. |
| **Secrets → Bitwarden** | `GET /api/secrets/bitwarden/status`, `POST /api/secrets/bitwarden/{connect,provider,migrate}`, `DELETE /api/secrets/bitwarden/connect`, `GET /api/secrets/bitwarden/folders` | **Corrects §4** — Bitwarden is a real backed integration, not a "decide which." The mockup naming Bitwarden is accurate; both 1Password and Bitwarden suites ship. |
| **Dreaming → Cortex buffer / gauge** | `GET /api/dream/status`, `POST /api/dream/{trigger,promote}` | Pipeline admin guard (`pipelineAdminGuard`) gates the mutating ones. |
| **Settings → Inference providers** | `GET /api/inference/{catalog,status}`, `POST /api/inference/oauth/login/:id` (SSE), `POST /api/inference/oauth/{complete,disconnect/:id}` | OAuth SSE for pi-ai (Claude Max/Codex/Copilot) — see issue #966. |
| **Logs viewer** | `GET /api/logs/stream` (SSE) | Exists; needs the `AuthEventStream` auth-pump pattern from Svelte (sandboxed renderer can't header a native EventSource). |
| **Memory feed** | full `/api/memories`, `/memory/search`, `/api/memory/timeline`, pin/edit/delete | all exist. |

### 6.2 Genuine daemon gaps (mockup shows something with NO backing endpoint)

These are the only places where fully realizing the mockup's interaction would
require **new daemon work**. Each is small and localized.

| Mockup surface | What's missing | Severity |
|---|---|---|
| **Dreaming → Cortex buffer token gauge** (`dr-buffer-tokens`, `dr-gauge`, `dr-pct`) | No endpoint exposes a live cortex-buffer token count / fill percentage. `/api/dream/status` returns status but not a token budget metric. Needs a new field on `/api/dream/status` or a `/api/dream/buffer` endpoint. | low — gauge can show `status` text until added |
| **Home KPI → "Agents" count + "N of M active" ring** | No `/api/agents` roster endpoint. `getDistinctWho` derives agents from memory rows; presence/active-state (the ring) has no source. Cross-agent presence is partial (`/api/cross-agent/presance`, issue #944) but not a full agent list. Needs an agents CRUD surface for multi-tenancy (issue #948 goal #4). | **medium** — multi-tenancy is a stated milestone goal |
| **Sidebar → workspace switcher** (`brand__switcher`, "Personal · 3 agents") | No `/api/workspaces` or multi-workspace switching. The daemon is single-workspace (`$SIGNET_WORKSPACE`). True multi-tenancy workspace switching needs new daemon + CLI support. | **medium** — multi-tenancy milestone |
| **Onboarding flow** (#948 goal #3, #967) | No `/api/onboarding` step-state endpoint. The wizard output writes into existing config endpoints, but there's no guided-setup state machine. | medium — #967 tracks this |
| **Session transcript export** (#984) | CLI-only today (`signet sessions export`). Dashboard "download" button needs either a daemon `/api/sessions/:key/export` route or a CLI bridge. | low — #984 tracks this |

### 6.3 Contract clarifications already resolved

- **Bitwarden vs 1Password** (was open in §4): **both ship.** Secrets view should
  surface both backends via `/api/secrets/bitwarden/status` and
  `/api/secrets/1password/status`.
- **OAuth providers in inference**: the 15 API-key providers + pi-ai OAuth flow
  are the same surface; OAuth providers just use the SSE login path. No split needed.
- **Review suggestions backing**: `review-queue` + `ontology/proposals` — not new.

### 6.4 Recommendation

For M2 surface rebuild, wire §6.1 first (zero daemon risk). Track §6.2 as
follow-up daemon tickets — the multi-tenancy gaps (agents roster, workspaces)
are the only blockers for the stated #948 multi-tenancy goal, and they predate
this dashboard work.
