---
name: signet
description: "Operate Signet as the local source-backed substrate for agent identity, scoped memory, provenance, ontology, skills, secrets, sources, and harness integrations."
user_invocable: true
arg_hint: ""
builtin: true
---

# Signet

Signet is the local substrate for agent continuity. It is not just a memory
app, and it is not a hidden daemon that gets to rewrite truth on its own.

The practical boundary is:

- sources and transcripts remain inspectable evidence
- memories are scoped, searchable recall rows
- ontology stores reviewed structure, currentness, versions, and links
- epistemic assertions preserve who claimed or believed something
- skills own repeated procedures
- identity and AGENTS files hold operating policy
- secrets stay out of chat, memory, logs, and source files
- connectors keep harnesses attached to the same local substrate

When Signet behavior is unclear, inspect the real checkout, daemon, API,
database-derived outputs, and installed harness config before guessing.

## Current Mental Model

Use this model when explaining or operating Signet:

1. **Source truth**: transcripts, source artifacts, imported files, notes,
   configs, and documents are evidence. They should keep provenance,
   timestamps, paths, and ids.
2. **Recall**: `POST /api/memory/recall` is the canonical explicit recall
   surface. It preserves score, source, type, supplementary context, and
   session-dedupe metadata.
3. **Remember**: `POST /api/memory/remember` writes explicit scoped memory
   rows. Raw remember does not create arbitrary ontology structure.
4. **Ontology**: graph and knowledge updates go through audited
   `signet ontology ...` operations with evidence, actor, confidence, and
   version/proposal history.
5. **Dreaming**: bulk maintenance uses the `dreaming` skill. It applies
   high-confidence ontology operations directly with provenance and reserves
   pending proposals for risky refactors or explicit review queues.
6. **Skills**: repeated cognition should become reviewed skill behavior, not
   invisible memory magic.

Do not collapse these layers into "the pipeline remembers everything." The
pipeline is a substrate component. The user-facing system is source-backed
control over what is accepted, recalled, structured, and repeated.

## Repo And Runtime Truth

Important paths:

```text
$SIGNET_WORKSPACE/           default ~/.agents/
  AGENTS.md                  operator instructions synced to harnesses
  SOUL.md                    personality/voice, when the chosen preset uses it
  IDENTITY.md                structured identity
  USER.md                    user profile
  MEMORY.md                  generated working summary, not raw truth
  agent.yaml                 config and harness state
  memory/memories.db         SQLite database
  skills/                    installed skills
  .secrets/                  encrypted secret material
```

Repo package map:

```text
platform/core                shared types, database, recall helpers, migrations
platform/daemon              Hono API, pipeline, hooks, workers, dashboard server
surfaces/cli                 signet command line
surfaces/dashboard           Svelte dashboard
surfaces/desktop             Electron desktop shell
integrations/*/connector     install-time harness connectors
integrations/*/plugin        runtime plugin/adapters where applicable
libs/sdk                     daemon API SDK
plugins/core/secrets         Signet-native secrets plugin
memorybench                  benchmark harness
web/marketing                Astro marketing/docs site
```

Before making product or architecture claims, prefer these checks:

```bash
git status --short
signet status
curl -s http://localhost:3850/health
curl -s http://localhost:3850/api/status
```

## Memory And Recall

Explicit memory save:

```bash
signet remember "User prefers vim keybindings." --agent codex --tags preference,editor
signet remember "Never delete production data without approval." --critical --private
```

Explicit recall:

```bash
signet recall "editor preferences" --agent codex --limit 10
signet recall "what did we decide about source truth" --aggregate --no-save-aggregate
signet recall "ontology policy" --session-key "$SESSION_KEY" --json
```

Rules:

- Thread `agentId` and `visibility` intentionally.
- Use provenance fields for imports and source-backed records.
- Use `--json` when another tool needs ids, source labels, dedupe metadata, or
  aggregate metadata.
- Do not use remember as a shortcut for ontology, source ingestion, dreaming,
  or skill updates.

See the `remember` and `recall` skills for the current detailed contracts.

## Sources

Sources connect read-only knowledge bases to Signet recall without turning the
source files into ordinary saved memories.

```bash
signet sources list
signet sources add obsidian /path/to/vault --name "Research Vault"
signet sources remove <source-id>
```

Source-owned rows carry provenance so they can be purged by source. Source
files are not modified by removing a source.

## Ontology And Dreaming

Use ontology operations for structured knowledge maintenance:

```bash
signet ontology pipeline explain --json
signet knowledge entities --json
signet knowledge hygiene --json
signet ontology assertions --limit 50 --json
signet ontology proposals --status pending --json
```

Apply exact graph operations through the audited control plane:

```bash
signet ontology stream apply ops.jsonl --json
signet ontology entity merge "Canonical Entity" "Duplicate Entity" \
  --reason "Same source-backed entity after canonicalization" \
  --evidence-file evidence.json \
  --json
```

Use epistemic assertions when the source says who claimed, believed, observed,
decided, preferred, denied, or questioned something:

```bash
signet ontology assertion create \
  --entity "Signet" \
  --predicate claims \
  --speaker "Nicholai" \
  --content "Signet should preserve who believes what over time." \
  --confidence 0.91 \
  --source-kind transcript \
  --source-id session-key
```

Use pending proposals only for large graph refactors, risky/destructive
changes, or explicit review queues:

```bash
signet ontology stream apply proposals.jsonl --propose --json
signet ontology apply <proposal-id> --actor operator --json
signet ontology reject <proposal-id> --reason "weak evidence" --actor operator --json
```

For bulk source and transcript maintenance, use the `dreaming` skill.

## Secrets

Secrets are for reusable credentials that should not appear in chat, memory,
logs, or source files.

```bash
signet secret list
signet secret get OPENAI_API_KEY
signet secret put SERVICE_TOKEN
```

List commands show names only. Secret values should be consumed through the
secret tooling path, not pasted into transcripts.

## Skills

Built-in skills live in the repo under `skills/` and sync into
`$SIGNET_WORKSPACE/skills/`.

```bash
signet skill list
signet skill show recall
signet skill install owner/repo
signet sync
```

Use skills for reviewed, repeatable work. If repeated behavior is not yet
reviewed, treat it as a skill patch candidate rather than trusted procedural
memory.

## Setup And Sync

Interactive setup:

```bash
signet setup
```

Agent-driven setup:

```bash
signet setup --non-interactive \
  --name "My Agent" \
  --harness claude-code \
  --embedding-provider <ollama|openai|none> \
  --extraction-provider <claude-code|codex|opencode|ollama|none>
```

Sync built-in templates, skills, source checkout, native assets, and harness
hooks:

```bash
signet sync
```

Do not hand-edit generated copies in harness config directories when the source
file in `$SIGNET_WORKSPACE/` or the repo built-in skill should be updated
instead.

## Harness Integration

Connectors attach harnesses to the same local Signet workspace. Runtime paths
can differ by harness, but the rule is the same: verify the installed config
and active runtime before diagnosing behavior.

Useful checks:

```bash
signet status
signet sync
cat ~/.agents/agent.yaml
```

For OpenClaw-style memory duplication or high-token reports, inspect the real
config and confirm native memory is disabled and the Signet runtime plugin or
hook path is the only active memory provider. The daemon should reject
conflicting runtime paths for one session.

## Hard Rules

- Do not present `MEMORY.md` as the database or the full truth.
- Do not describe Signet as a fixed vector/BM25 memory searcher.
- Do not treat automatic extraction as permission to silently author policy,
  ontology, identity, or skill behavior.
- Do not hardcode `default` for scoped data when a real agent id is known.
- Do not bypass source provenance for imported or source-derived facts.
- Do not rewrite raw transcripts, source artifacts, or external source files
  when derived graph or memory rows change.
- Do not use pending proposals for ordinary high-confidence ontology
  maintenance when audited apply-first operations are available.
- If claims matter, verify against code, API docs, daemon health, or local
  runtime state.
