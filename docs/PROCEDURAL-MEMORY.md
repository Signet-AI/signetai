---
title: "Procedural Memory"
description: "Knowledge of how to act — workflows, repeatable processes, and task sequences."
order: 22
section: "Core Concepts"
---

# Procedural Memory

Procedural memory is the knowledge of how to act — workflows, repeatable processes,
and domain-specific capabilities. In Signet, skills encode procedural memory. Rather
than existing purely as filesystem artifacts, installed skills are promoted to
first-class nodes in the knowledge graph so they surface alongside memories when
their context is relevant.

## What It Is

The memory system distinguishes three tiers of knowledge:

- **Declarative (semantic/episodic)** — facts about the world, past events,
  observations. Stored as memories in the `memories` table, organized under entities
  and aspects.
- **Procedural** — knowledge of how to do things. Workflows, rules, repeatable
  processes. In Signet, this is represented by installed skills.

The critical distinction: declarative memory answers "what is true?" Procedural
memory answers "what should I do?" Embedding skills into the graph means the agent
can retrieve relevant capabilities the same way it retrieves relevant facts —
through traversal and embedding search — without the user having to explicitly
invoke a skill by name.

## skill_meta Table

Created by migration 018. Schema:

| Column | Type | Description |
|---|---|---|
| `entity_id` | TEXT PK | FK to `entities(id)`. Set to `skill:{agentId}:{skillName}` |
| `agent_id` | TEXT | Agent scope (default `'default'`) |
| `version` | TEXT | Version string from SKILL.md frontmatter |
| `author` | TEXT | Author from frontmatter |
| `license` | TEXT | License from frontmatter |
| `source` | TEXT NOT NULL | How the skill was registered (`'reconciler'`, install source) |
| `role` | TEXT | Role classification (default `'utility'`). See Role Classification below |
| `triggers` | TEXT | JSON array of trigger phrases |
| `tags` | TEXT | JSON array of domain tags |
| `permissions` | TEXT | JSON array of declared permissions |
| `enriched` | INTEGER | Always 0; retained for schema compatibility. LLM frontmatter enrichment is retired, skill frontmatter is used as authored |
| `installed_at` | TEXT | ISO timestamp of first install |
| `last_used_at` | TEXT | ISO timestamp of most recent tracked use |
| `use_count` | INTEGER | Number of tracked skill invocations |
| `importance` | REAL | Starting importance score (from `procCfg.importanceOnInstall`, default 0.7) |
| `decay_rate` | REAL | Per-period decay multiplier (from `procCfg.decayRate`, default 0.99) |
| `fs_path` | TEXT NOT NULL | Absolute path to the `SKILL.md` file |
| `uninstalled_at` | TEXT | Set when the skill node is removed; NULL means currently installed |

The `entity_id` column is the primary key and also serves as the FK into `entities`,
so each skill has exactly one entity node.

## How Skills Become Memory

### Skill Frontmatter Is Used As Authored

LLM-based frontmatter enrichment was retired: the description, triggers, and
tags authored in the SKILL.md frontmatter are the discovery metadata, used
verbatim. Installed skills with thin frontmatter simply get a thinner
embedding; no LLM call is made during install or reconcile. (The enrichment
pass previously added an LLM call per skill per reconcile cycle and was a
primary driver of the skill reconciler hot-loop, Signet-AI/signetai#1086.)

### YAML Frontmatter Parsing

Source: `platform/daemon/src/pipeline/skill-frontmatter.ts`

`parseSkillFile(content)` extracts YAML frontmatter from a SKILL.md file using
the `yaml` package's Document API. It recognizes both `name` and `title` fields
(with `name` taking precedence), and accepts `triggers` and `tags` as either
arrays or comma-separated strings.

`patchSkillFrontmatter(fileContent, patch)` rewrites frontmatter in a round-trip
preserving manner — comments and unrelated fields are kept. It is no longer used
by the daemon (the enrichment write-back path was removed) and remains available
for external callers.

### Skill Graph Nodes

Source: `platform/daemon/src/pipeline/skill-graph.ts`

`installSkillNode(input, accessor, config, embeddingCfg, fetchEmbedding)`
performs the full install sequence:

1. **Write entity + skill_meta** — in a single `withWriteTx`. If the entity ID
   already exists, updates `entities.description` and all `skill_meta` fields;
   otherwise inserts both rows. Sets `entity_type = 'skill'` on the entity
2. **Generate embedding** — builds embedding text as
   `"{name} — {description} — {triggers joined by ', '}"`, fetches the vector,
   replaces any existing `source_type = 'skill'` embedding for this entity, and
   syncs to the vec table

Skill nodes are source/native topology: the SKILL.md frontmatter is the
authoritative source and `installSkillNode` writes the skill entity and its
metadata directly. It does **not** perform LLM-driven semantic extraction from
the SKILL.md body. Cross-skill semantic relations are owned by the audited
Dreaming apply path, so skill install never authors extracted entities,
relations, or mention links (see the #946 semantic-writer cutover).

`uninstallSkillNode(input, accessor)` removes relations, mention links, embeddings
(with vec sync), skill_meta, and the entity row — all in a single transaction.
This is a hard delete; skill nodes do not use soft-delete.

### Skill Reconciler

Source: `platform/daemon/src/pipeline/skill-reconciler.ts`

The reconciler keeps `skill_meta` in sync with the `$SIGNET_WORKSPACE/skills/` directory.
It runs in three modes:

1. **Startup backfill** — `reconcileOnce` is called immediately on daemon start
   (async, non-blocking). Scans `$SIGNET_WORKSPACE/skills/*/SKILL.md`, installs any skill
   whose entity ID is missing from `entities`, and updates skills whose embedding
   text has changed (detected by comparing stored `chunk_text` in the `embeddings`
   table against the freshly computed embedding text from current frontmatter)

2. **Periodic reconciliation** — `setInterval` runs `reconcileOnce` at
   `procCfg.reconcileIntervalMs`. Guarded against overlapping runs with a
   `reconciling` flag. Skills that fail to reconcile keep a per-skill failure
   counter: after three consecutive failures the skill enters exponential
   backoff (10s base, capped at 10min) and is skipped until the window elapses,
   so a wedged skill cannot re-run the install pipeline (or saturate the daemon
   event loop) every cycle. A successful pass or a watcher event clears the
   state (#1086).

3. **Chokidar file watcher** — watches `$SIGNET_WORKSPACE/skills/*/SKILL.md` for add,
   change, and unlink events. On add/change, calls `reconcileSkill` (single-skill
   reconciliation with the same fingerprint check). On unlink, calls
   `uninstallSkillNode` immediately

Skill entity IDs are computed as `skill:{agentId}:{skillName}`. The reconciler
hardcodes `agentId = 'default'` when querying orphan detection from `skill_meta`.

## Role Classification

The `role` field in `skill_meta` classifies what kind of procedural knowledge a
skill represents. It is read from the SKILL.md frontmatter `role` field, defaulting
to `'utility'` if absent.

The role is stored as a free-text field with no enforced enum; the procedural memory
spec describes planned values including `'utility'`, `'workflow'`, `'protocol'`, and
`'reference'`, but the database does not constrain them.

## Decay and Usage Tracking

The `skill_meta` schema includes `decay_rate`, `importance`, `use_count`, and
`last_used_at` to support a usage-based decay model for skill relevance.

The `decay_rate` (default 0.99) and `importance` (default 0.7) values are written
at install time from `PipelineV2Config.procedural`. The usage tracking fields
(`use_count`, `last_used_at`) are now populated from tracked daemon-mediated skill
invocations. The broader decay model still exists in the schema but is not yet
actively applied.

When P2 is implemented, a "use" will be defined as a skill node being retrieved
and injected into agent context. `use_count` will increment and `last_used_at`
will be updated each time. `decay_rate` will be applied periodically to importance
to let unused skills fade.

## Current Status

- **P1 (complete)**: `skill_meta` table (migration 018), YAML frontmatter parsing,
  skill graph node install/uninstall, skill reconciler with startup
  backfill + periodic + chokidar watcher
- **P2 (partial)**: Usage tracking ledger + `skill_meta` updates shipped. Importance
  decay application and richer cross-memory linking still pending
- **P3–P5 (not started)**: Relation computation between skills, retrieval endpoints
  for skill search, dashboard integration showing skills in the constellation view

## See Also

- [KNOWLEDGE-GRAPH.md](./KNOWLEDGE-GRAPH.md) — graph data model that skill nodes
  participate in
- [KNOWLEDGE-ARCHITECTURE.md](./KNOWLEDGE-ARCHITECTURE.md) — conceptual rationale
  for the procedural memory tier
- [SKILLS.md](./SKILLS.md) — user-facing skills documentation (install, browse,
  search)
