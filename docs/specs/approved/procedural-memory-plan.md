---
title: "Procedural Memory: Skills as Knowledge Graph Nodes"
---

# Procedural Memory: Skills as Knowledge Graph Nodes

Status: Proposed Spec (implementation-targeted)

Audience: Core + Daemon maintainers

Dependency: Memory Pipeline v2 (phases A-E minimum)

Reference: arscontexta kernel (references/arscontexta/)

---

## 0) Current Baseline and Scope

This spec is written against the current Signet codebase state:

- Skills are filesystem artifacts only (`~/.agents/skills/*/SKILL.md`).
- Graph tables exist (`entities`, `relations`, `memory_entity_mentions`).
- Graph retrieval currently boosts memory recall via one-hop entity
  expansion.
- Hooks currently inject AGENTS/MEMORY/recalled memories, not skills.
- No watcher currently reconciles skill filesystem changes into graph
  state.

This document defines the **required contract additions** to bridge
that gap. Where existing behavior differs, this spec is normative.

---

## 1) North Star

**Problem**: Agents forget to use their installed skills. Skills exist
as filesystem artifacts outside the memory system, so they're only
found when the agent (or user) explicitly searches for them. If nobody
remembers the skill exists, it doesn't get used.

**Solution**: By embedding skills into Signet's memory and hooks
system, relevant skills are proactively injected into context —
the agent never has to go search for them. The skill surfaces
alongside memories when the working context is relevant.

---

## 2) Purpose

Skills in Signet are currently filesystem artifacts — a directory with
a SKILL.md file, discovered at runtime, with no database presence.
They exist outside the memory system entirely.

This plan promotes skills to first-class nodes in the knowledge graph,
treating them as **procedural memory** alongside the existing semantic
and episodic tiers. The result is a unified knowledge substrate where
facts, experiences, and capabilities all live in the same graph and
reinforce each other through usage.

The key insight: a skill is just procedural knowledge. "I know how to
deploy to Cloudflare" belongs in the same graph as "Nicholai prefers
bun over npm." One is a capability, the other is a fact, but they're
both things the agent *knows*.

This aligns with the arscontexta finding that "every note is basically
a skill — highly curated knowledge that gets injected when relevant."
The same progressive disclosure pattern governs both memory retrieval
and skill loading, driven by the same context window constraint. We're
making the structural claim in the other direction: every skill is
also a memory.

---

## 3) Product Objectives

### Primary goals

1. Skills become nodes in the entity graph with their own embeddings.
2. Skill nodes link to memories (and entities) through the same
   relation system used for semantic memory.
3. The graph accumulates contextual knowledge around skills through
   natural usage — when to use them, what they pair with, user
   preferences about them.
4. Contextual skill discovery emerges from graph proximity: if the
   agent is working in a domain, relevant skills surface without
   explicit invocation.
5. Skill-to-skill relationships form organically through shared memory
   neighborhoods, enabling emergent clustering (e.g. "devops" skills
   naturally group together).
6. Procedural memories decay at a significantly lower rate than
   semantic or episodic memories, reflecting how humans retain
   procedural knowledge.

### Non-goals (for this release)

- Skill auto-installation based on graph suggestions.
- Skill composition or chaining based on graph paths.
- Cross-agent skill sharing or skill marketplace ranking.
- Replacing the filesystem as the skill runtime — SKILL.md files
  remain the executable artifact; the graph is the knowledge layer.

---

## 4) Design Principles

### Skills are knowledge, not just tools

The filesystem artifact (SKILL.md, permissions, executable code) is
the *infrastructure*. The graph node is the *knowledge* — the agent's
understanding of what the skill does, when it's useful, and how it
relates to everything else the agent knows.

### Same graph, different decay

Procedural memory uses the same graph tables, same relation types,
same embedding space. The only structural difference is the decay
coefficient: procedural memories are stickier.

### Installation creates the node, usage enriches it

When a skill is installed, a graph node is created with the skill's
metadata embedded. This is a cold start — the node exists but has
minimal connections. As the agent uses the skill, episodic memories
from those sessions link to the skill node. Over time, the graph
accumulates rich context around each skill.

### The graph learns what you don't tell it

If `browser-use` and `web-perf` keep appearing near the same
memories, the graph discovers they're related even though nobody
explicitly linked them. Emergent skill clustering is a natural
consequence of shared memory neighborhoods.

### Embed the frontmatter, not the body

The SKILL.md body is execution context — prompt instructions, examples,
formatting rules. That's what the agent needs *after* a skill is
selected, not what helps it *find* the skill. Embedding the body adds
noise without improving retrieval precision.

The frontmatter is the discovery surface. It should carry rich semantic
signal: description, triggers/use-cases, tags. If the frontmatter is
good enough, embedding it alone produces better recall than embedding
a random 500-char slice of the body. This also means frontmatter
quality is the critical investment, which is why skill installation
includes an automated enrichment step (see section 7.1).

### Discovery-first

Everything created must be optimized for future agent discovery. If
the agent can't find a skill node, it doesn't exist. This means
frontmatter quality is the critical investment — rich descriptions
and trigger keywords make skills findable; vague one-liners don't.

### Skills have a lifecycle

Knowledge hardens over time. The natural trajectory is:
documentation → skill → hook. Instructions start as documented
patterns, get promoted to skills as they prove useful, and eventually
become hooks when they're fully deterministic. The graph should
reflect where a skill sits in this lifecycle through its `role` field.

---

## 5) Memory Taxonomy Update

The existing taxonomy defines four tiers but only treats three:

| Tier | Decay rate | Current status |
|------|-----------|----------------|
| Session | N/A (ephemeral) | Implemented |
| Episodic | `0.95^days` | Pipeline v2 |
| Semantic | `0.95^days` | Pipeline v2 |
| Procedural | `0.99^days` | **This plan** |

Procedural memories decay at roughly 1/5 the rate of semantic
memories. A semantic fact loses ~40% relevance after 10 days idle.
A procedural skill loses ~10% in the same period.

The decay coefficient should be configurable per-skill or globally:

```yaml
# pipeline config extension
procedural:
  decayRate: 0.99          # default for procedural memories
  minImportance: 0.3       # floor — skills never fully decay
  importanceOnInstall: 0.7  # initial importance for new skills
```

The `minImportance` floor is critical: unlike semantic memories which
can decay to irrelevance, installed skills should always remain
discoverable. They can become *less prominent* but never invisible.

---

## 6) Data Model

### 6.1 Skill nodes in the entity graph

Skills are stored as entities with `entity_type = 'skill'`:

```sql
-- No new base graph table needed. Skills use entities + skill_meta.
-- name: skill name (e.g. 'browser-use')
-- canonical_name: normalized skill name
-- description: from SKILL.md frontmatter
-- mentions: graph mention count

INSERT INTO entities (
  id, name, canonical_name, entity_type, description, mentions,
  created_at, updated_at
) VALUES (
  'skill:browser-use', 'browser-use', 'browser-use', 'skill',
  'Automates browser interactions for web testing...', 1,
  datetime('now'), datetime('now')
);
```

#### Skill embeddings (normative)

Skill retrieval vectors are persisted in the existing `embeddings`
pipeline path so they can use sqlite-vec indexing consistently.

```sql
INSERT INTO embeddings (
  id, source_type, source_id, content_hash, model, dimensions,
  vector, created_at
) VALUES (
  '<embedding-id>', 'skill', 'skill:browser-use', '<hash>',
  '<embedding-model>', <dims>, <blob>, datetime('now')
);
```

The frontmatter embedding may also be mirrored to `entities.embedding`
for inspection/debug convenience, but ranking/search must use the
`embeddings` + `vec_embeddings` path.

### 6.2 Skill metadata table (new)

The entity row captures the graph-facing data. Skill-specific
metadata lives in a dedicated table that links back:

```sql
CREATE TABLE skill_meta (
  entity_id     TEXT PRIMARY KEY REFERENCES entities(id),
  version       TEXT,
  author        TEXT,
  license       TEXT,
  source        TEXT NOT NULL,  -- 'openclaw' | 'claude-code' | 'manual' | 'skills.sh'
  role          TEXT NOT NULL DEFAULT 'utility',
                -- 'orchestrator' | 'processor' | 'utility' | 'hook-candidate'
  triggers      TEXT,           -- JSON array of discovery phrases
  tags          TEXT,           -- JSON array (e.g. ["devops", "testing"])
  permissions   TEXT,           -- JSON array of declared permissions
  enriched      INTEGER DEFAULT 0, -- 1 if frontmatter was auto-enriched
  installed_at  TEXT NOT NULL,
  last_used_at  TEXT,
  use_count     INTEGER DEFAULT 0,
  decay_rate    REAL DEFAULT 0.99,
  fs_path       TEXT NOT NULL,  -- path to SKILL.md on disk
  uninstalled_at TEXT,           -- null while installed
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
```

The `role` field classifies where the skill sits in the knowledge
hardening lifecycle. Orchestrator skills coordinate others (like a
pipeline runner). Processors do domain-specific work. Utilities are
general-purpose tools. Hook-candidates are skills whose behavior has
hardened enough that they could become deterministic hooks.

The `tags` field provides a flat categorization vocabulary for
domain grouping (e.g. "devops", "testing", "knowledge-management").
Tags from SKILL.md frontmatter (if present) are imported directly;
the affinity computation in Phase P3 can also suggest tags based on
cluster membership.

### 6.3 Skill-memory links

When the agent uses a skill during a session, the episodic memories
from that session link to the skill entity through the existing
`memory_entity_mentions` table:

```sql
-- Existing table, no changes needed:
-- memory_entity_mentions(memory_id, entity_id, mention_text, confidence)

INSERT INTO memory_entity_mentions (
  memory_id, entity_id, mention_text, confidence
) VALUES (
  '<episodic-memory-id>', 'skill:browser-use',
  'used browser-use to scrape pricing data', 0.9
);
```

### 6.4 Skill-to-skill relations

Skill relations use a typed vocabulary that distinguishes how and
why two skills are connected. This is informed by arscontexta's
propositional link semantics, adapted for procedural knowledge.

#### Relation type vocabulary

| Type | Source | Meaning |
|------|--------|---------|
| `requires` | explicit | Skill A cannot function without skill B |
| `complements` | explicit | Skill A works better alongside skill B |
| `extends` | explicit | Skill A adds capabilities to skill B |
| `often_used_with` | implicit | Skills frequently co-occur in usage |
| `enables` | explicit | Skill A's output feeds skill B's input |
| `supersedes` | explicit | Skill A replaces skill B for most cases |

**Explicit relations** are extracted during skill installation from
SKILL.md content (e.g. "works well with web-perf" → `complements`).
These are tagged `source = 'extracted'` in metadata.

**Implicit relations** are computed by analyzing shared memory
neighborhoods via open triangle detection: if skill A and skill B
are both mentioned in memories M1, M2, M3 but have no direct edge,
that's an open triangle — a candidate `often_used_with` relation.
These are tagged `source = 'computed'`.

The distinction matters for query power: "find all skills that
extend X" and "find all skills used alongside X" are fundamentally
different queries with different use cases.

Both use the existing `relations` table:

```sql
INSERT INTO relations (
  source_entity_id, target_entity_id, relation_type,
  strength, mentions, confidence, metadata
) VALUES (
  'skill:browser-use', 'skill:web-perf', 'often_used_with',
  0.7, 3, 0.8, '{"source": "computed"}'
);
```

---

## 7) Lifecycle

### 7.1 Skill installation (with frontmatter enrichment)

When a skill is installed (via `signet skill install`, manual copy,
or harness unification):

1. Parse SKILL.md frontmatter and body.
2. **Enrich frontmatter** (if needed). If the frontmatter lacks a
   rich `description` or has no `triggers` field, run an LLM pass
   over the full SKILL.md body to generate them. This uses the
   existing pipeline `LlmProvider` (same model and provider config
   as the extraction worker in `decision.ts`) — no new inference
   path, just a new prompt function alongside
   `extractFactsAndEntities()`. The enrichment prompt asks the
   model to produce:
   - A 1-2 sentence description that explains *what the skill does*
     and *when you'd use it* (mechanism + use-case, not restating
     the skill name).
   - A `triggers` list of 3-8 short phrases representing contexts
     where this skill is relevant (e.g. "web scraping", "form
     filling", "screenshot capture", "browser testing").
   - `tags` for domain grouping if not already present.
   The enriched frontmatter is written back to SKILL.md so it's
   durable and human-editable. Skills that already have rich
   frontmatter skip this step (determined by checking that
   `description` is >30 chars and `triggers` exists).
   Implementation requirement: this step must use YAML-aware
   parse/serialize (round-trip) behavior, not regex-only extraction.
3. Generate embedding from the enriched frontmatter only:
   `name + description + triggers`. The body is not embedded.
4. Create entity row with `entity_type = 'skill'`.
5. Create `skill_meta` row with installation metadata, including
   `role` (from frontmatter or default 'utility') and `tags`.
6. Run extraction on SKILL.md body to find entity references
   (e.g. if the skill mentions "Cloudflare", link to the
   Cloudflare entity if it exists) and explicit skill relations
   (e.g. "works with web-perf" → `complements` edge).
7. Set initial importance to `importanceOnInstall` (default 0.7).

The enrichment step is the key quality gate. A skill with a vague
one-liner description ("browser automation") becomes findable only
after enrichment produces the semantic detail ("Automates browser
interactions via Playwright for web scraping, form filling, visual
testing, and screenshot capture"). This means discovery quality
scales with frontmatter quality, which is now a machine-assisted
process rather than relying on skill authors to write good metadata.

### 7.2 Skill usage

When the agent invokes a skill during a session:

1. Emit a structured usage event at invocation time.
2. Increment `use_count` and update `last_used_at` in `skill_meta`.
3. Upsert a `memory_entity_mentions` link when a memory id is known,
   otherwise queue link creation until session-end summaries are
   persisted.
4. Boost procedural importance/recency score used by suggestions.

Normative API contract:

```http
POST /api/skills/used
Content-Type: application/json

{
  "skill": "browser-use",
  "sessionKey": "optional",
  "memoryId": "optional",
  "project": "optional",
  "runtimePath": "plugin|legacy"
}
```

This endpoint is idempotent per `(skill, sessionKey, memoryId, day)`
to avoid inflated usage counts from retries.

### 7.3 Skill uninstallation

When a skill is removed:

1. Remove filesystem artifact (existing behavior).
2. Set `skill_meta.uninstalled_at`.
3. Immediately remove skill relation edges (`relations` where source or
   target is the skill entity).
4. Remove skill mention links from `memory_entity_mentions`.
5. Hard-delete skill entity row and `skill_meta` row in same write
   transaction.

Rationale: current graph retention/orphan cleanup is hard-delete
oriented; this spec keeps skill lifecycle consistent with current graph
semantics and avoids introducing a second tombstone model.

### 7.4 Filesystem reconciliation (self-healing)

A periodic reconciler (and startup backfill) must sync filesystem and
graph state:

1. List installed skills from `~/.agents/skills/*/SKILL.md`.
2. Ensure each installed skill has entity + `skill_meta` + embedding.
3. Mark any indexed skill whose file is missing as uninstalled, then
   execute uninstallation flow.
4. Emit metrics (`skillsIndexed`, `skillsReconciled`, `skillsRemoved`).

The daemon file watcher should also watch `~/.agents/skills/**/SKILL.md`
for low-latency reconciliation.

### 7.5 Relation discovery (open triangle detection)

Implicit skill-to-skill relations are discovered through open
triangle detection in the graph, inspired by arscontexta's graph
analysis primitives.

An **open triangle** exists when skill A and skill B both have edges
to shared memories (or shared entities) but no direct edge between
them. When the co-occurrence count crosses `affinityThreshold`
(default: 3 shared memories), the system creates a candidate
`often_used_with` relation.

This runs as an **event-driven job**, not a fixed interval timer.
The trigger fires when any skill's new co-occurrence count with
another skill crosses the threshold since the last computation.
This avoids wasted cycles when skill usage is sparse, and responds
quickly during active periods.

Steps:

1. For each skill entity, find all memories linked to it.
2. For each pair of skills sharing N+ linked memories, compute
   affinity score based on co-occurrence frequency and recency.
3. Distinguish the structural finding (triangle exists) from the
   semantic judgment (should these be connected?). For v1, create
   the relation automatically. Future: surface candidates for
   human review before committing.
4. Create or update `often_used_with` relations with
   `source = 'computed'`.
5. Decay existing implicit relations that haven't been reinforced.
6. Optionally suggest `tags` for skills based on cluster membership
   (skills in the same dense neighborhood likely share a domain).

---

## 8) Retrieval Integration

### 8.1 Skill-aware recall

When `signet recall` runs, the existing graph-augmented retrieval
(section 13 of pipeline v2) already expands one-hop from matched
entities. If skill entities are in the graph, they participate in
expansion automatically.

Example: user recalls "deploy process" → matches entity "Cloudflare"
→ one-hop expansion finds skill:wrangler → wrangler skill surfaces
in results alongside relevant memories.

### 8.2 Contextual skill suggestions

New endpoint for proactive skill discovery:

```
GET /api/skills/suggest?context=<text>
```

1. Embed the context text.
2. Query nearest vectors from `embeddings` where `source_type = 'skill'`.
3. Resolve to entities (`entity_type = 'skill'`) and join `skill_meta`.
4. Rank by: embedding similarity × importance × recency boost.
5. Return top-K skill suggestions with reasoning.

Hook integration (normative):

- `handleSessionStart` should call `/api/skills/suggest` when
  `context` is present and append a `## Relevant Skills` block.
- `handleUserPromptSubmit` may also call suggestions with a tighter
  character budget for per-turn hints.

### 8.3 Skill search enhancement

The existing `/api/skills` list endpoint gains an optional
`?ranked=true` parameter that sorts installed skills by graph
importance rather than alphabetically. Skills with richer graph
neighborhoods (more linked memories, more relations) rank higher.
Response shape remains backward-compatible with existing consumers;
ranking metadata is additive (`score`, `reason`).

---

## 9) Dashboard Integration

### 9.1 Graph visualization

The existing embeddings/graph view in the dashboard gains
skill-specific rendering:

- Skill nodes rendered with a distinct icon/color.
- Skill-to-skill edges shown as a separate layer.
- Skill-to-memory edges shown on hover/select.
- Cluster detection highlights skill neighborhoods.

### 9.2 Skill detail view

Each skill's detail page in the dashboard gains a "Knowledge" tab
showing:

- Linked memories (most recent, most relevant).
- Related skills (with affinity scores).
- Usage timeline (from `use_count` and linked episodic memories).
- Importance trend over time.

---

## 10) Implementation Phases

### Phase P1: Schema, enrichment, and node creation

- Add `skill_meta` table via migration.
- Implement frontmatter enrichment: LLM pass to generate rich
  `description` and `triggers` fields for skills with thin metadata.
- On skill install, enrich → embed → create entity + skill_meta rows.
- Persist skill vectors through `embeddings` (`source_type = 'skill'`)
  and sync into sqlite-vec.
- On skill uninstall, execute hard-delete lifecycle (section 7.3).
- Backfill: scan existing installed skills, enrich frontmatter where
  needed, and create nodes for them.
- Embed enriched frontmatter using configured embedding provider.
- Add YAML round-trip frontmatter writer for enrichment output.
- Add reconciler job (startup + interval) and watcher coverage for
  `~/.agents/skills/**/SKILL.md`.

**Depends on**: Pipeline v2 Phase A (migration infrastructure),
Phase E (graph tables exist).

### Phase P2: Usage tracking and linking

- Add `POST /api/skills/used` usage event endpoint.
- Wire connectors/hook paths to emit usage events on actual skill
  invocation.
- Increment `use_count`, `last_used_at`, and procedural recency score.
- Link usage to memory rows when memory ids are available; defer link
  when they are not.
- Optionally add installed skill names as extraction context hints.

**Depends on**: Phase P1, Pipeline v2 Phase B (extraction pipeline).

### Phase P3: Implicit relation computation

- Background job for skill-to-skill affinity computation.
- Co-occurrence analysis across shared memory neighborhoods.
- Relation creation/update/decay for implicit `often_used_with` edges.

**Depends on**: Phase P2 (needs usage data to compute relations).

### Phase P4: Retrieval and suggestion

- Skill-aware recall (mostly free from existing graph expansion).
- `/api/skills/suggest` endpoint.
- `?ranked=true` parameter for skill listing.
- Session-start hook integration for proactive suggestions.
- Optional user-prompt-submit integration with tighter budget.

**Depends on**: Phase P3, Pipeline v2 Phase E (graph retrieval).

### Phase P5: Dashboard and visualization

- Skill nodes in graph view.
- Skill detail knowledge tab.
- Cluster visualization.

**Depends on**: Phase P4.

---

## 11) Configuration

Extension to the existing `memory.pipelineV2` config block:

```yaml
memory:
  pipelineV2:
    # ... existing config ...
    procedural:
      enabled: true
      decayRate: 0.99
      minImportance: 0.3
      importanceOnInstall: 0.7
      affinityThreshold: 3       # min shared memories for implicit relation
      affinityMode: event        # 'event' or 'interval'
      affinityIntervalMs: 21600000
      suggestionLimit: 5
      enrichOnInstall: true
      enrichMinDescription: 30
      reconcileIntervalMs: 60000
```

---

## 12) Safety and Invariants

1. **Skill nodes are not deletable by LLM decisions.** Only explicit
   install/uninstall or reconciler logic can create/remove skill nodes.
   Extraction may increment graph mention counters but may not modify
   lifecycle fields (`installed_at`, `uninstalled_at`, `use_count`).

2. **Filesystem remains authoritative for skill runtime.** If a
   SKILL.md exists on disk but has no graph node, reconciler creates
   one. If a graph node exists but file is missing, reconciler executes
   uninstallation flow.

3. **Skill importance has a floor.** Unlike semantic memories,
   installed skills never decay below `minImportance`. They can
   become less prominent but remain discoverable.

4. **Implicit relations are always labeled.** Relations computed by
   affinity analysis are tagged `source = 'computed'` to distinguish
   them from explicit relations extracted from SKILL.md content.

5. **Backfill is idempotent.** Running skill node creation on an
   already-indexed skill is a no-op (matched by canonical name and
   frontmatter hash).

6. **No regex-only frontmatter rewrites.** Metadata enrichment must use
   YAML round-trip serialization so existing fields/comments are
   preserved as much as possible.

---

## 13) Success Criteria

1. All installed skills have corresponding entity nodes in the graph.
2. Skill usage during sessions creates linked episodic memories.
3. Skills with shared usage patterns develop implicit relations.
4. `signet recall` surfaces relevant skills alongside memories.
5. Skill importance decays at the configured procedural rate.
6. Skill nodes survive extraction pipeline decisions (LLM cannot
   delete them).
7. Dashboard graph view renders skill nodes distinctly.

---

## 14) Open Questions

1. **Skill versioning in the graph**: when a skill updates, should the
   node be replaced or versioned? Current lean: replace in place,
   re-embed, preserve relations. Version history in `skill_meta`.

2. **Cross-agent skill sharing**: if multi-agent support lands (see
   `multi-agent-support.md`), should skill nodes be shared across
   agents or scoped per-agent? Current lean: shared by default since
   skills are global filesystem artifacts.

3. **Skill quality signal**: should the graph track skill success/
   failure rates? e.g. if memories linked to a skill are frequently
   negative ("wrangler deploy failed again"), should that affect the
   skill's importance? Arscontexta captures this explicitly via
   "agent notes" during execution rather than inferring it from
   sentiment later. Consider: a dedicated `skill_observations` field
   or linked observation memories. Not in v1, but the data model
   supports it.

4. **Human review for implicit relations**: should computed
   `often_used_with` relations be auto-committed, or surfaced as
   "synthesis opportunities" for human review first? v1 auto-commits
   for simplicity, but the structural/semantic distinction from
   arscontexta's triangle detection suggests a review step may
   produce higher quality edges.

5. **Module ceiling**: arscontexta documents a ~15-20 active module
   ceiling before context budget strains (at 16k chars). If skills
   are surfaced via descriptions during session-start, the same
   budget applies. Should `suggestionLimit` be configurable per
   session type, or is a single global limit sufficient?

---

## 15) Resolved Decisions

1. **Embedding strategy**: Embed enriched
   frontmatter only (`name + description + triggers`). The SKILL.md
   body is execution context, not retrieval signal. Frontmatter is
   auto-enriched via LLM on install when descriptions are thin or
   `triggers` are missing, ensuring discovery quality without relying
   on skill authors to write perfect metadata.

2. **Affinity computation trigger**: event-driven (threshold-based)
   rather than fixed interval. Fires when co-occurrence count crosses
   `affinityThreshold`. Falls back to interval mode if configured.

3. **Relation type vocabulary**: typed relations (`requires`,
   `complements`, `extends`, `often_used_with`, `enables`,
   `supersedes`) with source tagging (`extracted` vs `computed`).

4. **Skill role classification**: `orchestrator / processor /
   utility / hook-candidate` reflecting the knowledge hardening
   lifecycle (documentation → skill → hook).

---

## 16) References

- arscontexta kernel: `references/arscontexta/reference/kernel.yaml`
  — 15 primitives with dependency DAG. Informed phase ordering.
- "notes are skills": `references/arscontexta/methodology/notes are
  skills — curated knowledge injected when relevant.md` — theoretical
  grounding for the "skills are memory" claim.
- propositional link semantics: `references/arscontexta/methodology/
  propositional link semantics transform wiki links from associative
  to reasoned.md` — typed relation vocabulary.
- skill context budgets: `references/arscontexta/methodology/skill
  context budgets constrain knowledge system complexity on agent
  platforms.md` — module ceiling math and lifecycle thresholds.
- graph operations: `references/arscontexta/skill-sources/graph/
  SKILL.md` — triangle detection, bridge identification, cluster
  analysis.
- three-spaces architecture: `references/arscontexta/reference/
  three-spaces.md` — memory routing decision tree, content promotion
  rules.
