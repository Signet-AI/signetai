---
title: "Data and portability commands"
description: "Export, import, migrate, and embed Signet data."
---

## `signet export` / `signet import`

Export and import portable Signet bundles. This is the supported path
for moving an agent between machines or backing up identity + memory
state from the CLI.

```bash
signet export
signet export --json
signet export bundle
signet import ./signet-export-2026-03-22
signet import ./signet-export-2026-03-22.json --json --conflict merge
```

`signet export` (equivalent to `signet export bundle`) writes a portable
bundle containing:

- identity files
- `agent.yaml`
- memories
- entities
- relations
- installed skills

`signet import` restores those files into `$SIGNET_WORKSPACE/`. Conflict
handling for memories is controlled with `--conflict`:

- `skip` — keep existing memories and skip duplicates
- `overwrite` — replace matching memories
- `merge` — merge compatible records when supported

---

## `signet export transcripts`

Export stored session transcripts as JSONL (one conversation per line) for
training and fine-tuning pipelines. Output is written to stdout by default so
it can be piped, or to a file with `--output`.

```bash
# Export all transcripts as JSONL to stdout
signet export transcripts

# Write to a file
signet export transcripts --output ./training-data/conversations.jsonl

# Filter by harness and agent
signet export transcripts --harness hermes-agent --harness codex --agent ant

# Filter by creation date range
signet export transcripts --since 2026-06-01 --until 2026-07-01

# Resumable export
signet export transcripts --limit 5000 --offset 5000 --output ./part-2.jsonl

# Skip system and tool messages
signet export transcripts --messages-only

# Pretty-printed JSON array instead of JSONL
signet export transcripts --json
```

Each line has the shape:

```json
{
  "id": "signet-db-<session-key>",
  "source": "signet",
  "harness": "hermes-agent",
  "agent_id": "ant",
  "session_key": "<session-key>",
  "project": "/path/to/project",
  "timestamp": "2026-07-01T12:00:00.000Z",
  "message_count": 12,
  "messages": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ]
}
```

The `id` is derived from the session key, so re-exporting the same data
produces identical ids and downstream dedup by id stays stable. Transcript
content is parsed as JSONL first (one `{role, content}` object per line);
content without JSONL structure is parsed as role-prefixed text
(`User:`/`Assistant:`/`System:`/`tool_result:` lines, with continuation lines
accumulated into the previous message). Carriage returns split lines exactly
like the training-data aggregator's parser, so export output is a drop-in
replacement for its SQLite reader.

Date boundaries: `--since 2026-07-01` includes the whole of July 1;
`--until 2026-07-31` is treated as the end of July 31 (a date-only until
compared raw would exclude the entire until day).

Options:

| Flag | Default | Purpose |
|------|---------|---------|
| `-o, --output <path>` | stdout | Write to a file instead of stdout |
| `--harness <name>` | all | Filter by harness (repeatable) |
| `--agent <name>` | all | Filter by agent ID (repeatable) |
| `--since <iso>` | earliest | Only transcripts created at or after this ISO timestamp |
| `--until <iso>` | now | Only transcripts created at or before this ISO timestamp |
| `--limit <n>` | unlimited | Max conversations to export |
| `--offset <n>` | 0 | Skip N conversations (for resumable export) |
| `--messages-only` | false | Drop system and tool messages |
| `--json` | false | Output a JSON array instead of JSONL |

---

## `signet migrate-schema`

Migrate an existing memory database to Signet's unified schema. Useful
when upgrading from an older version or copying `$SIGNET_WORKSPACE/` between
machines.

```bash
signet migrate-schema
signet migrate-schema --path /custom/path
```

Supported source schemas:

| Schema | Source |
|--------|--------|
| `python` | Original Python memory system |
| `cli-v1` | Early Signet CLI (v0.1.x) |
| `core` | Current unified schema (no migration needed) |

Migration is idempotent - safe to run multiple times. All existing
memories are preserved. The daemon is stopped and restarted automatically
during the process.

Output:

```
- Checking database schema...
  Migrating from python schema...
  ✓ Migrated 261 memories from python to core

  Migration complete!
```

---

## `signet migrate-vectors`

Migrate existing BLOB-format embeddings to the sqlite-vec format. Run
this once after upgrading from a version that stored vectors as raw BLOBs.

```bash
signet migrate-vectors
signet migrate-vectors --keep-blobs
signet migrate-vectors --dry-run
```

Options:

| Option | Description |
|--------|-------------|
| `--keep-blobs` | Keep the old BLOB column after migration (safer rollback) |
| `--remove-zvec` | Delete `vectors.zvec` file after successful migration |
| `--dry-run` | Show what would be migrated without making changes |

---

## `signet embed`

Manage memory embeddings. Requires the daemon to be running.

```bash
signet embed backfill
signet embed backfill --batch-size 100
signet embed backfill --dry-run
signet embed backfill --model-mismatch --dry-run
signet embed backfill --all --dry-run
signet embed gaps
```

Subcommands:

| Command | Description |
|---------|-------------|
| `signet embed backfill` | Generate missing vectors; use `--model-mismatch` for a model/dimension migration or `--all` to force active memories |
| `signet embed gaps` | Show count of memories missing embeddings |

`signet embed backfill` options:

| Option | Description |
|--------|-------------|
| `--batch-size <n>` | Memories per batch (default: 50) |
| `--dry-run` | Preview without calling the embedding provider |
| `--model-mismatch` | Re-embed vectors whose stored model or dimensions differ from the configured target |
| `--all` | Re-embed all active memories in bounded resumable batches |

Migration dry runs report source model/dimension labels (historical provider identity is not recorded), the configured target, estimated batches, and whether dimensions require a vector-index rebuild.

After `backfill` completes, coverage is printed:

```
  Coverage: 100.0% (1200/1200 embedded)
```

---
