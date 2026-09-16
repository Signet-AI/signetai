---
title: "Workspace and identity"
description: "Select a workspace and configure identity, embeddings, and search."
---

The workspace contains authored context, daemon-owned state, and the operator configuration. Inspect the selected workspace with:

```bash
signet workspace status
```

Set a workspace explicitly with `signet workspace set /path/to/workspace`. The command persists the selection and may migrate workspace files; apply it to a running daemon with the canonical rule on [Configuration](/configuration/).

## Identity and embeddings

`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, and `USER.md` provide authored identity and operating context according to the active preset. `MEMORY.md` is generated working memory and is not an operator edit surface.

The `embedding` block defines the provider, model, dimensions, endpoint, and optional secret reference. Current providers include `local`, `native`, `llama-cpp`, `ollama`, `openai`, and `none`. Use `$secret:NAME` for remote credentials.

Changing an embedding profile can start an index migration. Verify the embedding and index status before retiring the previous profile. `search.alpha` and `min_score` are between 0 and 1; `top_k` is positive.

## Workspace state

The daemon owns `.daemon/` and `memory/memories.db`. Preserve these paths during backup and migration. If a configured workspace is missing or incomplete, inspect `signet workspace status`, restore the path, or perform an explicit setup action; do not substitute another workspace silently.
