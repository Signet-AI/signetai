---
name: remember
description: "Save an explicit scoped memory through Signet. Use only when the user clearly asks to remember something or when a tool/harness must persist an explicit memory row."
user_invocable: true
arg_hint: "[critical:] [[tag1,tag2]:] content to remember"
builtin: true
---

# /remember

Use this skill for explicit memory writes. Do not use it as a general
extraction, ontology, or dreaming path.

Signet's current memory model is source-backed and scoped. A direct remember
call creates or deduplicates a memory row, records provenance fields when
provided, embeds the content when the daemon can, links mechanically
recognizable mentions to existing same-agent entities, and enqueues the normal
pipeline work. Raw text does not automatically create new ontology entities,
aspects, grouped claims, dependencies, or supersession chains.

## When To Use

Use `/remember` when:

- the user explicitly says to remember, save, persist, or store something
- a harness compatibility path needs to write an explicit memory inside a
  session
- you need a durable recall row with clear tags, hints, scope, or provenance
- you are importing a single explicit fact and can supply source metadata

Do not use `/remember` when:

- the task is ontology maintenance or dreaming; use the `dreaming` skill and
  `signet ontology ...` commands
- the task is source ingestion; use `signet sources ...` or the connector
  import path so provenance remains inspectable
- the content is a vague behavioral lesson; propose an AGENTS.md, identity, or
  skill patch instead
- the user did not ask for persistence and normal session capture is enough

## CLI

The common path is the CLI wrapper:

```bash
signet remember "<content>"
```

Useful options:

```bash
signet remember "<content>" --agent codex --private
signet remember "<content>" --tags signet,recall --hint "future search cue"
signet remember "<content>" --importance 0.9
signet remember "<content>" --critical
```

Options:

- `--agent <name>` sets the owning `agentId`
- `--private` sets `visibility: "private"` instead of global
- `--tags <tags>` stores comma-separated tags
- `--hint <hint>` adds prospective recall hints; repeat for multiple hints
- `--importance <n>` sets importance from 0 to 1
- `--critical` pins the memory
- `--who <who>` records who is remembering

The daemon must be running:

```bash
signet status
curl -s http://localhost:3850/health
```

## API

For provenance, imports, or structured callers, use the canonical endpoint:

```bash
curl -s http://localhost:3850/api/memory/remember \
  -H 'content-type: application/json' \
  -d '{
    "content": "User prefers vim keybindings.",
    "agentId": "codex",
    "visibility": "global",
    "tags": "preference,editor",
    "sourceType": "manual",
    "sourceId": "session-key",
    "sourcePath": "memory/codex/transcripts/session.jsonl",
    "idempotencyKey": "stable-import-key",
    "hints": ["editor preference", "vim keybindings"]
  }'
```

Important fields:

- `agentId` scopes ownership; do not hardcode `default` when a real agent is
  known
- `visibility` is `global` or `private`
- `sourceType`, `sourceId`, `sourcePath`, `runtimePath`, and
  `idempotencyKey` preserve import/source provenance
- `createdAt` should reflect source time for older imported records
- `structured.entities`, `structured.aspects`, and `structured.hints` are for
  callers that intentionally author structured graph-adjacent data

When `structured` is omitted, Signet stores the memory conservatively. It does
not invent new graph structure from raw text.

## Response Handling

A successful response includes the memory id and whether the row was embedded
or deduplicated:

```json
{
  "id": "uuid",
  "type": "preference",
  "tags": "preference,editor",
  "pinned": false,
  "importance": 0.9,
  "content": "User prefers vim keybindings.",
  "embedded": true,
  "deduped": false
}
```

Confirm the write plainly:

```text
saved: uuid (embedded)
```

If `deduped: true`, say that Signet returned the existing row instead of
creating a duplicate.

## Hard Rules

- Thread `agentId` and `visibility` deliberately.
- Preserve source provenance when the memory came from an artifact, transcript,
  note, import, or external system.
- Use idempotency keys for repeatable imports.
- Do not use remember as a shortcut around ontology operations, source import,
  or reviewed skill/identity patches.
- Do not silently persist private, sensitive, or authority-changing content
  without a clear user request or explicit tool contract.
