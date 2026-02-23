# Changelog

All notable changes to Signet are documented here.

## [0.1.80] - 2026-02-22

### Features
- **dashboard**: make session logs scrollable and inspectable

## [0.1.79] - 2026-02-22

### Docs
- update AGENTS.md with architecture gaps

## [0.1.78] - 2026-02-21

### Bug Fixes
- **dashboard**: break projection polling loop on error

## [0.1.77] - 2026-02-21

### Bug Fixes
- **daemon**: handle bun:sqlite Uint8Array blobs

## [0.1.76] - 2026-02-21

### Performance
- **dashboard**: move UMAP projection server-side

### Features
- **daemon**: add re-embed repair endpoint and CLI

## [0.1.75] - 2026-02-20

### Refactoring
- **dashboard**: migrate to shadcn-svelte

### Features
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration

## [0.1.74] - 2026-02-19

### Features
- refine session end hook

### Bug Fixes
- **core**: compute __dirname at runtime

## [0.1.73] - 2026-02-19

### Features
- **daemon**: add Claude Code headless LLM provider

## [0.1.72] - 2026-02-18

### Bug Fixes
- **docs**: correct license to Apache-2.0 in READMEs

## [0.1.71] - 2026-02-18

### Bug Fixes
- **daemon**: sync vec_embeddings on write

## [0.1.70] - 2026-02-17

### Bug Fixes
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
