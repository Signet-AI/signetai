# Forge v1.1.8

## Highlights

- Forge now auto-discovers API keys stored in **Signet secrets**
- discovered Signet secrets are synced into Forge local credentials automatically
- Forge refreshes the **Signet model registry** after secret sync
- the model picker now shows only **connected/authenticated providers**
- authenticated CLI providers are detected more accurately:
  - `claude-cli` via `claude auth status`
  - `codex-cli` via `codex login status`
  - `gemini-cli` via saved/env auth
- registry-backed model selection now maps Signet provider families into Forge CLI providers:
  - `claude-code` → `claude-cli`
  - `codex` → `codex-cli`

## Why this matters

Forge now follows the Signet pipeline more cleanly:

1. auth is discovered from Forge-local setup **and** Signet secrets
2. Signet remains the upstream secret source of truth
3. model availability reflects what is actually connected
4. newer registry models can surface automatically without waiting for Forge hardcoded lists to catch up

## Included fixes from local auth work

- Claude CLI login no longer gets overridden by stale locally injected auth tokens
- Codex auth paste flow accepts `auth.json`, access tokens, and id tokens
- auth prompts use the interactive selector UI
