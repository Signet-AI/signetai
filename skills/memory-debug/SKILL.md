---
name: memory-debug
description: Diagnose Signet memory, recall, source, session, embedding, and graph issues from runtime truth without bypassing scope or provenance.
user_invocable: true
arg_hint: "[symptom or query]"
builtin: true
---

# /memory-debug

Use this skill when Signet memory behavior looks wrong: recall is empty,
results are stale, a saved memory is missing, source-backed results are not
appearing, prompt-submit context is missing, embeddings are unhealthy, or a
session is bypassed.

Debug from runtime truth. Do not infer from `MEMORY.md` alone; it is generated
working context, not the database or the full source of truth.

## Triage Model

Classify the symptom before running broad checks:

- **Daemon/runtime**: CLI cannot reach Signet, dashboard/API is down, hooks fail.
- **Session path**: prompt-submit context is empty, bypass is enabled, runtime
  path conflict, session dedupe suppresses repeats.
- **Write path**: explicit remember fails, dedupes unexpectedly, or writes under
  the wrong `agentId` / `visibility`.
- **Recall path**: explicit recall has no hits, weak ranking, missing source
  labels, aggregate synthesis fails, or scoped recall looks too broad/thin.
- **Embeddings**: semantic recall is weak, embedding coverage is low, provider
  or dimension config changed.
- **Sources**: Obsidian/source results are missing, stale, disconnected, or lack
  provenance.
- **Ontology/graph**: graph traversal, entity linking, assertions, or hygiene
  is wrong.
- **Transcript fallback**: the evidence exists in transcripts but not in memory
  or source recall.

## 1. Runtime And Scope

Start with the live daemon and workspace:

```bash
signet status
signet daemon status --json
curl -s http://localhost:3850/health
curl -s http://localhost:3850/api/status
```

Check the workspace and config:

```bash
printf '%s\n' "${SIGNET_WORKSPACE:-$HOME/.agents}"
test -f "${SIGNET_WORKSPACE:-$HOME/.agents}/agent.yaml"
test -f "${SIGNET_WORKSPACE:-$HOME/.agents}/memory/memories.db"
```

If the daemon is down:

```bash
signet daemon start
signet daemon restart
```

If extraction workers are intentionally paused:

```bash
signet daemon resume
```

Read recent logs when runtime state is unclear:

```bash
signet daemon logs --tail 200
```

## 2. Session And Hook State

If prompt-submit recall or automatic context injection is missing, inspect the
session layer before blaming retrieval:

```bash
signet bypass --list
```

If the current session is bypassed:

```bash
signet bypass <session-key> --off
```

For repeated recall complaints, check session dedupe. Explicit recall with a
`sessionKey` suppresses rows already returned in the current context epoch
unless `--include-recalled` is set:

```bash
signet recall "<query>" --session-key <session-key> --include-recalled --json
```

If direct explicit recall works but prompt-submit context is empty, compare the
hook wrapper:

```bash
curl -s http://localhost:3850/api/hooks/recall \
  -H 'content-type: application/json' \
  -d '{
    "harness": "codex",
    "query": "the missing context",
    "agentId": "codex",
    "sessionKey": "session-key",
    "includeRecalled": true,
    "runtimePath": "plugin"
  }'
```

`/api/hooks/recall` should remain a hook-oriented wrapper around
`/api/memory/recall`, not a separate retrieval engine.

## 3. Explicit Write Path

When a save is suspect, create a scoped smoke row with a unique phrase:

```bash
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
signet remember "memory-debug smoke ${stamp}" \
  --agent codex \
  --tags debug,smoke \
  --hint "memory debug smoke ${stamp}" \
  --importance 0.7
```

Expected: a saved memory id plus embedded/no-embedding status. If it dedupes,
the response should say so.

Rules:

- use `--agent` when debugging agent-scoped behavior
- use `--private` when testing owner-only visibility
- preserve `sourcePath`, `runtimePath`, `sourceId`, and `idempotencyKey` when
  debugging imported/source-derived writes through the API
- do not use remember to debug ontology maintenance or source ingestion

For lower-level checks, call the canonical endpoint:

```bash
curl -s http://localhost:3850/api/memory/remember \
  -H 'content-type: application/json' \
  -d '{
    "content": "memory-debug API smoke",
    "agentId": "codex",
    "visibility": "global",
    "tags": "debug,smoke",
    "idempotencyKey": "memory-debug-api-smoke"
  }'
```

## 4. Explicit Recall Path

Use the canonical recall path and preserve metadata:

```bash
signet recall "memory debug smoke" --agent codex --limit 10 --json
```

If there are no hits:

```bash
signet recall "memory debug smoke" --agent codex --keyword-query '"memory-debug" OR "smoke"' --json
signet recall "memory debug smoke" --agent codex --include-recalled --json
```

Inspect:

- `results[].id`
- `results[].source`
- `results[].score`
- `results[].type`
- `results[].created_at`
- `results[].supplementary`
- `results[].already_recalled`
- `meta.noHits`
- `meta.timings`
- `meta.dedupe`

Do not describe recall as a fixed vector/BM25 blend. Current explicit recall
combines FTS5, prospective hints, vectors, structured evidence, traversal,
source-backed recall, optional reranking, and session dedupe.

For broad questions, test aggregate recall separately:

```bash
signet recall "what does Signet know about source truth" \
  --agent codex \
  --aggregate \
  --no-save-aggregate \
  --json
```

If aggregate fails, inspect `aggregate.stoppedReason` and whether the router or
source evidence is unavailable.

## 5. Embedding Health

Use the built-in audit/backfill commands:

```bash
signet embed audit --json
signet embed backfill --dry-run --json
```

Only run a real backfill after confirming provider config and expected batch
size:

```bash
signet embed backfill --batch-size 50
```

Check `agent.yaml` for:

- `embedding.provider`
- `embedding.model`
- `embedding.dimensions`
- `embedding.base_url`

Common root causes:

- provider is offline or unreachable
- model name changed
- dimensions changed after a model swap
- OpenAI key is missing for OpenAI embeddings
- native/llama.cpp/Ollama fallback is unavailable

Semantic recall can still return keyword/source results when embeddings are
missing. Treat "no embedding" as degraded retrieval, not necessarily failed
memory persistence.

## 6. Source-Backed Recall

If a result should come from an external knowledge base, inspect sources:

```bash
signet sources list
```

For Obsidian:

```bash
signet sources add obsidian /path/to/vault --name "Research Vault"
signet recall "exact source phrase" --agent codex --json
```

Source results should preserve source labels such as `source_obsidian` and
canonical `source_path` provenance. If exact context matters, read the source
file directly instead of trusting the snippet.

If source results are stale or absent:

- confirm the source is still configured and enabled
- confirm the file is not excluded by a source ignore glob
- confirm hidden/dot folders are intentionally skipped
- check daemon logs for source scan errors
- disconnect/reconnect only when the config is wrong or source-owned rows need
  a clean purge

```bash
signet sources remove <source-id>
```

Removing a source purges Signet-owned source artifacts, graph rows, and chunks.
It must not modify source files.

## 7. Ontology And Graph Health

If recall returns facts but graph traversal, entities, claims, or assertions
look wrong, switch to graph diagnostics:

```bash
signet knowledge entities --json
signet knowledge tree "Signet" --depth 3 --json
signet knowledge hygiene --json
signet ontology assertions --limit 50 --json
signet ontology proposals --status pending --json
signet ontology pipeline explain --json
```

Use `knowledge hygiene` for suspicious entities, duplicate candidates, missing
claim structure, and safe mention-link candidates. Do not edit SQLite directly.
Graph repairs should go through audited `signet ontology ...` operations or
the `dreaming` skill.

## 8. Transcript Evidence

If the user remembers a prior conversation but recall does not, search
transcripts:

```bash
signet session search "phrase from the conversation" --agent codex --limit 10 --json
```

Transcript hits are evidence, not automatically accepted memory or ontology.
If the transcript supports a durable fact, choose the right route:

- explicit user-requested memory -> `signet remember`
- structured source-backed graph fact -> `signet ontology ...`
- attributed belief/claim/decision -> `signet ontology assertion ...`
- repeatable procedure -> skill patch
- broad maintenance -> `dreaming` skill

## Report Format

Report back with:

1. Symptom and classification.
2. Exact commands run.
3. Key evidence from JSON/log output.
4. Root cause or narrowed suspects.
5. Fix applied or exact next command.
6. Verification command and result.

Prefer small, reproducible checks over broad speculation. Keep source labels,
agent scope, session key, and provenance visible in the report.
