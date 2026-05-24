---
title: "Sources"
description: "Connect read-only knowledge bases like Obsidian vaults directly into Signet recall."
order: 9
section: "Core Concepts"
---

Sources
=======

Sources are external knowledge bases that Signet can read, index, and recall from without turning them into ordinary saved memories.

Sources currently support **Obsidian** vaults, **Discord** guilds, and **GitHub** repositories. Point Signet at an Obsidian vault and the daemon mounts that vault as a read-only knowledge base: Markdown files become searchable artifacts, the vault structure becomes graph topology, and heading-aware chunks participate in semantic recall. Add Discord with a bot-token secret reference and Signet indexes guild topology, channels, threads, members, message windows, and Discord metadata through the same source-owned artifact lifecycle. Add GitHub repositories to index issues, pull requests, discussions, selected Markdown docs, comments, and source failure artifacts through the shared source provider pipeline.

The important rule is simple: **the source stays canonical**. Signet reads from the vault. It does not edit notes, rewrite frontmatter, create files, or move anything inside the source directory.

Why Sources exist
-----------------

Saved memories are durable facts that Signet owns. Sources are different: they are existing bodies of knowledge that already have their own structure and lifecycle.

Use Sources when you want Signet to recall from:

- an Obsidian vault;
- a local folder of Markdown knowledge;
- documentation or research notes that should stay under their original editor/workflow;
- future cloud, code, or document connectors.

A source hit is marked as source-backed recall, not as a native saved memory. Obsidian recall results include a canonical `source_path` so agents and tools can inspect the original file directly.

Discord v1
----------

Discord Sources v1 indexes bot-accessible guild context through Discord REST API v10 and local Discord Desktop cache artifacts:

```bash
signet secret put DISCORD_BOT_TOKEN
signet sources add discord --guild 123456789012345678 --token-ref DISCORD_BOT_TOKEN --name "Team Discord"
signet sources add discord --guild 123456789012345678 --token-ref DISCORD_BOT_TOKEN --channel general --since 2026-01-01
signet sources add discord --mode desktop-cache --name "Local Discord Cache"
signet sources add discord --mode desktop-cache --desktop-cache-path ~/.config/discord --full-cache
signet sources list
signet sources snapshot export discord:... --out discord-source.snapshot.json
signet sources snapshot import discord:... discord-source.snapshot.json
signet sources remove discord:...
```

The daemon rejects raw Discord tokens in source config. Store the bot token in Signet Secrets or an external secret reference, then pass the secret name with `--token-ref`.

The dashboard Sources tab exposes both modes. Open Discord, choose Connect,
then select Bot REST for guild indexing or Desktop cache for local cache import.
Desktop cache mode can use the platform default Discord Desktop data folder or
a picked folder path, and Signet queues the shared source index job in the
background.

The REST sync path indexes:

- multiple guilds per source;
- guilds, categories, text channels, announcement channels, forums, media channels, active threads, and archived public/private thread catalogs;
- guild member snapshots and thread member snapshots;
- per-message artifacts and message windows with reply references, pins, mentions, attachment metadata, embed metadata, poll metadata, reactions metadata, and message lifecycle fields;
- source checkpoints with latest/backfill cursors and authoritative vs partial status;
- source failure artifacts for unavailable or partial fetches.

The desktop-cache sync path indexes classifiable local Discord Desktop cache
messages without a bot token or user-token automation:

- route-bearing cached guild and DM messages;
- local-only direct messages under the synthetic guild id `@me`;
- cached channel metadata, selected-DM route hints, and inferred DM names;
- message windows, per-message artifacts, mentions, attachment metadata, embed
  metadata, poll metadata, and cache-observed checkpoints;
- an import stats artifact with scanned/skipped counts.

Desktop cache imports are cache-observed, not authoritative. Cache eviction or
missing local files do not delete previously indexed cache artifacts; removing
the source still purges all Signet-owned rows for that source.

Partial Discord listings are never treated as authoritative deletes. If a channel, thread, member, or message fetch fails, Signet records a source failure artifact and preserves existing source-owned rows until a successful sync can refresh them.

Discord sources stay read-only. Signet does not write to Discord, automate user tokens, or selfbot against user accounts.

Source snapshots
----------------

Source snapshots export Signet source artifacts with their provenance so a
Discord-backed source can be backed up or moved without adopting Discrawl's
standalone SQLite archive model. Snapshots use `memory_artifacts` rows and are
imported back through the shared artifact path, which keeps source paths,
external IDs, FTS indexing, and purge-by-source behavior intact.

Discord Desktop cache DMs are local-only. Snapshot export/import excludes
artifacts under the synthetic `@me` guild by default; use
`--include-local-discord` only when intentionally moving that private local
cache data.

GitHub v1
---------

GitHub Sources v1 indexes configured repositories through the shared Sources job pipeline:

```bash
signet sources add github --repo Signet-AI/signetai --name "Signet GitHub"
signet sources add github --repo Signet-AI/signetai --token-ref GITHUB_TOKEN --resource-type issues --resource-type discussions
signet sources add github --repo Signet-AI/* --resource-type docs --doc-path "docs/**/*.md" --max-items 50
signet sources list
signet sources remove github:...
```

Without `--token-ref`, GitHub sources default to REST-fetchable resources:
issues, pull requests, and selected Markdown docs. Discussions use the GitHub
GraphQL API and require a token reference. Tokens must be stored in Signet
Secrets or an external secret reference; Signet does not store raw GitHub
tokens in source config.

GitHub source config is bounded by `maxItemsPerRepo`. Repo globs, issue/PR
fetches, discussion fetches, and wildcard docs paths all honor configured caps.
Direct docs paths are limited to Markdown paths or Markdown globs, so GitHub v1
does not become arbitrary source-code indexing by accident.

Partial GitHub failures are written as source-owned failure artifacts and cause
the shared source job to report failure instead of silently marking incomplete
data as fully indexed.

Obsidian v1
-----------

Obsidian Sources v1 indexes Markdown files below a vault root:

```bash
signet sources add obsidian /path/to/ObsidianVault --name "Research Vault"
signet sources add obsidian /path/to/ObsidianVault --exclude "private/**" --exclude "*.tmp"
signet sources list
signet sources remove obsidian:...
```

By default, Obsidian sources ignore Obsidian internals, trash, Hermes metadata, hidden dot-folders, and hidden files. Add more ignore globs from the dashboard connect form or repeat `--exclude` in the CLI when a vault contains tool folders or file types that should stay outside source recall.

The dashboard also includes a Sources browser for connecting and removing knowledge bases. In the desktop app, **Browse** opens the native folder picker. In browser/dev mode, Signet tries a daemon-backed OS picker and falls back to asking you to paste the path if no picker is available.

Signet intentionally skips vault metadata and local agent scratch space:

- `.obsidian/`
- `.trash/`
- `.hermes/`

What gets indexed
-----------------

A connected Obsidian vault is represented at several layers.

### 1. Source artifacts

Each Markdown file is indexed as a read-only source artifact:

- `harness = "obsidian"`
- `source_kind = "source_obsidian_markdown"`
- `source_path = /absolute/path/to/file.md`

This gives Signet fast lexical recall and preserves exact file provenance.

### 2. Source-native graph

Signet mounts the vault's shape into the graph instead of flattening it into a bag of notes:

| Obsidian structure | Signet graph representation |
|--------------------|-----------------------------|
| Vault root | source / knowledge-base root entity |
| Folder | source folder entity and community/group |
| Markdown file | source document entity |
| Wiki link / backlink | source-owned dependency/relationship |
| Heading | aspect |
| Paragraph or durable block | attribute / claim |

The physical vault hierarchy is the primary topology. Semantic enrichment attaches to that topology; it does not replace it.

Source-owned graph rows carry provenance columns where available:

- `source_id`
- `source_kind`
- `source_path`
- `source_root`

### 3. Source chunks and embeddings

Markdown files are also chunked by heading/section for semantic recall. These chunks are retrieval views, not saved memories.

Source chunk embeddings use:

- `source_type = "source_obsidian_chunk"`
- stable source-owned chunk IDs;
- chunk text that includes provenance (`source_id`, `source_path`, vault-relative path, heading, and line range);
- sqlite-vec mirroring when the vector extension is available, with a daemon-side cosine fallback when it is not.

This means a recall can return either a whole source artifact or a tighter source chunk. Both remain clearly marked as Obsidian/source-backed hits.

Recall behavior
---------------

When you recall against Signet, Obsidian source results can appear alongside native memories. Source hits are labeled so callers can tell them apart:

```json
{
  "source": "source_obsidian",
  "type": "source_obsidian_chunk",
  "source_path": "/path/to/vault/permanent/Idea.md"
}
```

For whole-file artifact hits, the content includes a visible header like:

```text
[Obsidian vault note: /path/to/vault/permanent/Idea.md]
```

Agents should treat `source_path` as the canonical inspection handle. If a task requires exact context, read the source file rather than guessing from the recall snippet.

Updating in place
-----------------

Connected knowledge bases update in place. When files change, the daemon re-reads the source and refreshes Signet-owned artifacts, graph rows, and chunks.

The watcher path is deliberately conservative:

- source config is refreshed dynamically so newly connected/disconnected sources are picked up;
- scans are single-flight to avoid overlapping source-wide reindex storms;
- overlapping sync requests are coalesced into one trailing resync;
- content fingerprints prevent unchanged files from being reprocessed;
- removed files are soft-deleted from source artifacts and have their source-owned chunks purged;
- disconnected sources stop participating in future configured-source scans.

The v1 safety model is deliberately conservative rather than a general-purpose queue. It serializes source-wide scans with single-flight state and collapses overlapping requests into one trailing resync. It does not expose tunable queue depth or backpressure settings yet.

Renames are treated as delete + add in v1. That keeps the lifecycle safe and predictable.

Removing a source
-----------------

Removing a source is symmetrical with connecting it:

1. remove the source config;
2. purge Signet-owned source artifacts;
3. purge source-owned graph rows;
4. purge source chunk embeddings and sqlite-vec mirror rows when available;
5. leave source files untouched.

From the dashboard and daemon API, removal performs the full purge. From the CLI, `signet sources remove <sourceId>` tries the daemon first. If the daemon is unavailable, the CLI falls back to local config-only removal and prints an explicit warning that already indexed database rows were not purged.

API surface
-----------

The daemon exposes the Sources lifecycle under `/api/sources`:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sources` | List configured sources. |
| `POST` | `/api/sources/obsidian` | Add/update an Obsidian vault source and index it. |
| `POST` | `/api/sources/discord` | Add/update a Discord source and queue a shared source index job. |
| `POST` | `/api/sources/github` | Add/update a GitHub source and queue a shared source index job. |
| `DELETE` | `/api/sources/:sourceId` | Remove a source config and purge Signet-owned source rows. |
| `POST` | `/api/sources/pick-directory` | Development/browser fallback for choosing a local directory. |

The desktop shell uses native folder selection through IPC. The daemon picker route is best-effort and may return `501` on systems without `zenity`, `kdialog`, `osascript`, or a configured `SIGNET_DIRECTORY_PICKER`.

Limitations in v1
-----------------

- Discord gateway tailing is represented in config but not active yet. Supported
  Discord sync modes are REST and local desktop cache import.
- Sources are local/operator-managed. Permissions and RBAC are intentionally out of scope for v1.
- Signet does not write back to Obsidian or Discord.
- Rename handling is delete + add.
- Non-Markdown Obsidian attachments are not indexed by the Obsidian v1 source path.
- Discord attachment binary/media extraction is disabled by default; v1 indexes attachment metadata.

Operational safety
------------------

Sources are designed to be easy to remove and safe to experiment with:

- source files are never deleted or modified by Signet;
- source-owned database rows carry provenance so they can be purged by source;
- source recall is visibly distinct from saved memory recall;
- chunk embeddings are source-owned retrieval views and can be rebuilt from the vault at any time.

If in doubt, remove the source and reconnect it. The vault remains the source of truth.
