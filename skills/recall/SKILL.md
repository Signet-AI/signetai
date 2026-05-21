---
name: recall
description: "Run explicit Signet recall through the canonical scoped recall path, preserving scores, sources, provenance, supplementary context, and session dedupe metadata."
user_invocable: true
arg_hint: "search query"
builtin: true
---

# /recall

Use this skill for targeted explicit recall. It is not the same surface as
prompt-submit context injection.

Signet's canonical explicit recall endpoint is `POST /api/memory/recall`.
The CLI, MCP, and hook recall surfaces should stay thin wrappers around that
contract. Recall combines FTS5, prospective hints, vector similarity,
structured path evidence, graph traversal, optional reranking, source-backed
fallbacks, currentness shaping, and session context dedupe where configured.
Do not describe it as a fixed 70/30 vector/BM25 search.

## When To Use

Use `/recall` when:

- the user asks what Signet remembers or asks for a targeted memory search
- current context is missing an old decision, preference, project fact, or
  prior source
- you need provenance, source labels, scores, ids, or no-hit metadata
- you need aggregate recall to synthesize a bounded answer from evidence
- you are debugging recall quality, scoping, or session-dedupe behavior

Do not use `/recall` as a ritual before every task. Session-start and
prompt-submit injection already provide lightweight context. Use explicit
recall when there is a concrete retrieval question.

## CLI

```bash
signet recall "<query>"
```

Useful options:

```bash
signet recall "Signet ontology policy" --agent codex --limit 10
signet recall "vim keybindings" --type preference --tags editor
signet recall "OpenMarketUI evaluator health" --project /mnt/work/openmarketui
signet recall "what did we decide about source truth" --aggregate --no-save-aggregate
signet recall "recent Signet failures" --session-key "$SESSION_KEY" --include-recalled
signet recall "ontology" --keyword-query '"ontology" OR "graph"' --json
```

Options:

- `--agent <name>` filters/authorizes by Signet agent scope
- `--project <path>` filters by project
- `--type`, `--tags`, `--who`, `--pinned`, `--importance-min`, `--since`, and
  `--until` filter memory rows
- `--keyword-query <query>` overrides the FTS query while keeping the recall
  query intact
- `--aggregate` asks Signet to synthesize a bounded answer from recall evidence
- `--aggregate-budget <small|medium|large>` caps follow-up recall breadth
- `--no-save-aggregate` avoids persisting the aggregate answer
- `--session-key <key>` enables context-epoch dedupe
- `--include-recalled` returns rows already recalled in the current epoch
- `--json` preserves the full response contract for tooling

## API

```bash
curl -s http://localhost:3850/api/memory/recall \
  -H 'content-type: application/json' \
  -d '{
    "query": "user preferences for editor",
    "limit": 10,
    "agentId": "codex",
    "sessionKey": "session-uuid",
    "includeRecalled": false,
    "aggregate": false
  }'
```

The hook route `POST /api/hooks/recall` is a compatibility wrapper. It applies
hook/session policy and forwards supported filters to the same recall family
contract. Do not add separate retrieval behavior to hook or connector
formatters.

## Response Contract

Preserve and show useful metadata. A normal response looks like:

```json
{
  "results": [
    {
      "id": "uuid",
      "content": "User prefers vim keybindings.",
      "score": 0.92,
      "source": "hybrid",
      "type": "preference",
      "tags": "preference,editor",
      "pinned": false,
      "importance": 0.9,
      "who": "codex",
      "project": null,
      "created_at": "2026-02-21T10:00:00.000Z",
      "supplementary": false,
      "already_recalled": false
    }
  ],
  "query": "user preferences for editor",
  "method": "hybrid",
  "meta": {
    "totalReturned": 1,
    "hasSupplementary": false,
    "noHits": false
  }
}
```

Common `source` values include `hybrid`, `vector`, `keyword`, `hint`,
`structured`, `traversal`, `ka_traversal`, `source_obsidian`,
`native_memory`, `constructed`, `graph`, and `llm_summary`.

Display results with:

- content
- id when available
- score when available
- source label
- type/tags
- created date
- `supplementary` status
- `already_recalled` when session dedupe is active

Do not flatten recall into anonymous bullets when metadata is present.

## Aggregate Recall

Aggregate recall first runs normal recall, may ask the inference router for
bounded follow-up queries, synthesizes one concise answer from unique evidence
rows, and returns aggregate metadata. Saving aggregate answers requires
`remember` permission; recall-only callers can set `saveAggregate: false`.

Use aggregate mode when the user asks a broad question over prior memory and a
source-backed synthesis is more useful than a ranked list.

## Hard Rules

- Treat `/api/memory/recall` as the canonical explicit recall contract.
- Keep prompt-submit recall separate; it is a lightweight injection path.
- Thread `agentId`, project, visibility policy, and session key deliberately.
- Respect no-hit responses instead of inventing memory.
- Preserve provenance and source labels in summaries.
- If scoped recall looks wrong, debug authorization and dedupe before assuming
  the memory is missing.
