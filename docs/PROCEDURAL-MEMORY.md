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
| `enriched` | INTEGER | 1 if LLM enrichment ran; 0 otherwise |
| `installed_at` | TEXT | ISO timestamp of first install |
| `last_used_at` | TEXT | ISO timestamp of most recent use (P2, not yet populated) |
| `use_count` | INTEGER | Number of times the skill has been used (P2, not yet populated) |
| `importance` | REAL | Starting importance score (from `procCfg.importanceOnInstall`, default 0.7) |
| `decay_rate` | REAL | Per-period decay multiplier (from `procCfg.decayRate`, default 0.99) |
| `fs_path` | TEXT NOT NULL | Absolute path to the `SKILL.md` file |
| `uninstalled_at` | TEXT | Set when the skill node is removed; NULL means currently installed |

The `entity_id` column is the primary key and also serves as the FK into `entities`,
so each skill has exactly one entity node.

## How Skills Become Memory

### Skill Enrichment

Source: `packages/daemon/src/pipeline/skill-enrichment.ts`

When a skill is installed with thin frontmatter (description shorter than
`procCfg.enrichMinDescription` characters, or no triggers defined), the enrichment
step calls the configured LLM provider to generate richer metadata.

The prompt asks the model for three outputs:
- `description` — 1-2 sentences explaining what the skill does and when to use it
- `triggers` — 3-8 short phrases a user might say when they need the skill
  (discovery keywords, not commands)
- `tags` — 2-5 lowercase domain tags

The enriched values are merged into the in-memory frontmatter before writing to
the graph. The original SKILL.md file is not modified by enrichment; the enriched
data lives only in `skill_meta`.

The enrichment result is parsed with `<think>` tag stripping and JSON fence
unwrapping before being validated. If the LLM call fails or returns unparseable
output, enrichment is skipped silently and the skill is still installed with
whatever frontmatter is available.

### YAML Frontmatter Parsing

Source: `packages/daemon/src/pipeline/skill-frontmatter.ts`

`parseSkillFile(content)` extracts YAML frontmatter from a SKILL.md file using
the `yaml` package's Document API. It recognizes both `name` and `title` fields
(with `name` taking precedence), and accepts `triggers` and `tags` as either
arrays or comma-separated strings.

`patchSkillFrontmatter(fileContent, patch)` rewrites frontmatter in a round-trip
preserving manner — comments and unrelated fields are kept. This is used if
enrichment data needs to be written back to the file (currently only used
externally; the reconciler does not patch SKILL.md files).

### Skill Graph Nodes

Source: `packages/daemon/src/pipeline/skill-graph.ts`

`installSkillNode(input, accessor, config, embeddingCfg, fetchEmbedding, provider)`
performs the full install sequence:

1. **Enrich** (optional) — if enrichment is enabled and the frontmatter is thin,
   calls `enrichSkillFrontmatter`
2. **Write entity + skill_meta** — in a single `withWriteTx`. If the entity ID
   already exists, updates `entities.description` and all `skill_meta` fields;
   otherwise inserts both rows. Sets `entity_type = 'skill'` on the entity
3. **Generate embedding** — builds embedding text as
   `"{name} — {description} — {triggers joined by ', '}"`, fetches the vector,
   replaces any existing `source_type = 'skill'` embedding for this entity, and
   syncs to the vec table
4. **Extract entities from SKILL.md body** — if `config.graph.enabled` is true
   and a provider is available and the body is at least 20 characters, calls
   `extractFactsAndEntities` on the body content and persists the results via
   `txPersistEntities`. This creates graph relations between the skill and any
   entities mentioned in its instructions

`uninstallSkillNode(input, accessor)` removes relations, mention links, embeddings
(with vec sync), skill_meta, and the entity row — all in a single transaction.
This is a hard delete; skill nodes do not use soft-delete.

### Skill Reconciler

Source: `packages/daemon/src/pipeline/skill-reconciler.ts`

The reconciler keeps `skill_meta` in sync with the `~/.agents/skills/` directory.
It runs in three modes:

1. **Startup backfill** — `reconcileOnce` is called immediately on daemon start
   (async, non-blocking). Scans `~/.agents/skills/*/SKILL.md`, installs any skill
   whose entity ID is missing from `entities`, and updates skills whose embedding
   text has changed (detected by comparing stored `chunk_text` in the `embeddings`
   table against the freshly computed embedding text from current frontmatter)

2. **Periodic reconciliation** — `setInterval` runs `reconcileOnce` at
   `procCfg.reconcileIntervalMs`. Guarded against overlapping runs with a
   `reconciling` flag

3. **Chokidar file watcher** — watches `~/.agents/skills/*/SKILL.md` for add,
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
at install time from `PipelineV2Config.procedural`. However, the usage tracking
fields (`use_count`, `last_used_at`) are **not yet populated** by any running code
— this is P2 work defined in the procedural memory spec. The decay model exists in
the schema but is not active.

When P2 is implemented, a "use" will be defined as a skill node being retrieved
and injected into agent context. `use_count` will increment and `last_used_at`
will be updated each time. `decay_rate` will be applied periodically to importance
to let unused skills fade.

## Current Status

- **P1 (complete)**: `skill_meta` table (migration 018), YAML frontmatter parsing,
  LLM enrichment, skill graph node install/uninstall, skill reconciler with startup
  backfill + periodic + chokidar watcher
- **P2 (not started)**: Usage tracking (`use_count`, `last_used_at`), importance
  decay application
- **P3–P5 (not started)**: Relation computation between skills, retrieval endpoints
  for skill search, dashboard integration showing skills in the constellation view

## See Also

- [KNOWLEDGE-GRAPH.md](./KNOWLEDGE-GRAPH.md) — graph data model that skill nodes
  participate in
- [KNOWLEDGE-ARCHITECTURE.md](./KNOWLEDGE-ARCHITECTURE.md) — conceptual rationale
  for the procedural memory tier
- [SKILLS.md](./SKILLS.md) — user-facing skills documentation (install, browse,
  search)
