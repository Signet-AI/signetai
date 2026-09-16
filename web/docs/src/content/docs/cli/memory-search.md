---
title: "Memory and search commands"
description: "Use remember, recall, and session search from the Signet CLI."
---

## `signet remember`

Save a memory to the database. The daemon embeds it for vector search if
an embedding provider is configured.

```bash
signet remember "User prefers dark mode"
signet remember "critical: never push to main" --critical
signet remember "deploy runs on Friday" --tags devops,deploy --who user
signet remember "deploy incident started before it was written down" --occurred-at 2026-05-13T18:00:00Z
```

Options:

| Option | Description |
|--------|-------------|
| `-w, --who <who>` | Who is remembering (default: `user`) |
| `-t, --tags <tags>` | Comma-separated tags |
| `-i, --importance <n>` | Importance score, 0-1 (default: 0.7) |
| `--critical` | Mark as critical/pinned |
| `--occurred-at <iso>` | Event time this memory is about |
| `--observed-at <iso>` | Observation time this memory records |
| `--source-created-at <iso>` | Source-system creation time for this memory |
| `--valid-from <iso>` | Start of validity window for this memory |
| `--valid-until <iso>` | End of validity window for this memory |
| `--review-after <iso>` | Surface a future temporal claim for review after this timestamp |

Output:

```
✔ Saved memory: mem_abc123 (embedded)
  Tags: devops,deploy
```

---

## `signet recall`

Search memories using hybrid vector + keyword search.

```bash
signet recall "user preferences"
signet recall "release notes" --project /path/to/project
signet recall "deploy process" --limit 5 --type decision
signet recall "auth" --tags backend --who claude-code --since 2026-01-01
signet recall "deploy checklist" --keyword-query "deploy OR rollback" --min-score 0.8
signet recall "2026/05/13"
signet recall "temporal recall" --time-start 2026-05-13T00:00:00Z --time-end 2026-05-14T00:00:00Z
signet recall "project history" --aggregate --aggregate-budget small
signet recall "secrets" --json
```

Primary controls:

| Option | Description |
|--------|-------------|
| `-l, --limit <n>` | Max results (default: 10) |
| `--project <project>` | Filter by project |

Common refinements:

| Option | Description |
|--------|-------------|
| `-t, --type <type>` | Filter by memory type |
| `--tags <tags>` | Filter by tags (comma-separated) |
| `--who <who>` | Filter by author |
| `--since <date>` | Only include memories created after this date |
| `--until <date>` | Only include memories created before this date |
| `--time-start <iso>` | Temporal recall lower bound |
| `--time-end <iso>` | Temporal recall upper bound |
| `--time-facets <facets>` | Temporal facets to search: `session`, `source`, `captured`, `observed`, `occurred`, `valid` |
| `--time-mode <mode>` | Temporal mode: `auto`, `timeline`, or `filter` |

Exact date queries such as `2026/05/13`, `2026-05-13`, and `May 13 2026`
activate temporal recall automatically. Date-only queries return a timeline;
date plus topic filters recall to matching temporal rows. Date ranges accept
full `YYYY-MM-DD/YYYY-MM-DD` or abbreviated same-month `YYYY-MM-DD/DD`
notation, and named ranges such as `July 25/26 2026`.

Advanced controls:

| Option | Description |
|--------|-------------|
| `--keyword-query <query>` | Override the keyword/FTS query used for recall |
| `--pinned` | Only return pinned memories |
| `--importance-min <n>` | Only return memories at or above this importance |
| `--min-score <n>` | Minimum recall score threshold, applied at the daemon response boundary |
| `--agent <name>` | Filter by agent ID |
| `--aggregate` | Synthesize one aggregate answer from bounded recall evidence |
| `--aggregate-budget <budget>` | Aggregate recall budget: `small`, `medium`, or `large` |
| `--no-save-aggregate` | Return the aggregate answer without saving it as a memory; saving requires `remember` permission |
| `--json` | Print the recall response as JSON |

JSON recall responses may include `meta.partial: true` when the daemon is
serving bounded lexical-bridge results while the memory FTS index is incomplete.
This is a successful `200` response with incomplete lexical coverage, not the
aggregate-recall `aggregate.partial` flag. Treat the results as partial and
retry after indexing recovery.

---

## `signet session search`

Search active or completed session transcripts. This is separate from
`signet recall`, which searches stored memories only.

```bash
signet session search "Juniper trunk ports"
signet session search "handoff notes" --session-key parent-session --limit 5
signet session search "delegated task" --current-session-key child-session --agent research-agent --json
```

Options:

| Option | Description |
|--------|-------------|
| `--session-key <key>` | Search one transcript session |
| `--current-session-key <key>` | Current session key; sub-agent lineage may resolve to the parent |
| `--agent <name>` | Agent ID scope |
| `--project <project>` | Filter by project |
| `-l, --limit <n>` | Max results (default: 10, max: 20) |
| `--json` | Print the transcript search response as JSON |

### Transcript limits

The transcript-search `--limit` controls only the number of search results returned;
it does not control transcript ingestion or recovery. The legacy `POST
/api/sources/import` multipart route accepts up to 25 files per request, 25 MiB per file,
and 100 MiB per upload batch. The durable `POST /api/sources/imports` route creates a
job with up to 25 file entries and accepts up to 64 GiB per resumable file upload. Its
`PATCH` chunks are limited to 1 MiB; this is a chunk limit, not a whole-file or batch
limit. Each transcript record may be up to 16 MiB and each message up to 4 MiB, with at
most 50,000 messages per record. The worker commits at most 25 records per internal
batch and caps each canonical batch at 8 MiB; those worker bounds are separate from the
route upload limits. See the [canonical durable transcript import API](/api/documents-sources/#durable-transcript-imports)
for the route contract and upload workflow.

Automatic recovery scans examine at most 50 MiB per discovered file, 50 files per scan,
and 50,000 discovered files per scan. These recovery-scan bounds are separate from both
search-result pagination and durable import limits.

---
