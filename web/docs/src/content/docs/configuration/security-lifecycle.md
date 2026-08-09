---
title: "Security and lifecycle"
description: "Configure authentication, retention, hooks, and environment variables."
---

## Auth Config

Auth configuration lives under the `auth` key in `agent.yaml`. Signet
uses short-lived signed tokens for dashboard and API access.

```yaml
auth:
  mode: local
  defaultTokenTtlSeconds: 604800    # 7 days
  sessionTokenTtlSeconds: 86400     # 24 hours
  login:
    password:
      username: admin
      passwordHash: null            # prefer env or a pbkdf2-sha256$... hash
    sso:
      enabled: false                # reserved provider path
    saml:
      enabled: false                # reserved provider path
  rateLimits:
    forget:
      windowMs: 60000
      max: 30
    modify:
      windowMs: 60000
      max: 60
    inferenceExplain:
      windowMs: 60000
      max: 120
    inferenceExecute:
      windowMs: 60000
      max: 20
    inferenceGateway:
      windowMs: 60000
      max: 30
```

| Field | Default | Description |
|-------|---------|-------------|
| `mode` | `"local"` | Auth mode: `"local"`, `"team"`, or `"hybrid"` |
| `defaultTokenTtlSeconds` | `604800` | API token lifetime (7 days) |
| `sessionTokenTtlSeconds` | `86400` | Session token lifetime (24 hours) |
| `login.password.username` | `"admin"` | Dashboard password-login username; `SIGNET_ADMIN_USERNAME` overrides it |
| `login.password.passwordHash` | `null` | Optional persisted `pbkdf2-sha256$...` password hash; `SIGNET_ADMIN_PASSWORD_HASH` overrides it |
| `login.sso.enabled` | `false` | Reserved SSO provider toggle; `/api/auth/sso/*` is open but returns `501` until configured |
| `login.saml.enabled` | `false` | Reserved SAML provider toggle; `/api/auth/saml/*` is open but returns `501` until configured |

Password login is enabled when `SIGNET_ADMIN_PASSWORD`,
`SIGNET_ADMIN_PASSWORD_HASH`, or `auth.login.password.passwordHash` is set.
Plaintext passwords are only accepted from the environment.

In `"local"` mode the token secret is generated automatically and stored
at `$SIGNET_WORKSPACE/.daemon/auth-secret`. In `"team"` and `"hybrid"` modes,
the daemon validates HMAC-signed bearer tokens with role and scope
claims.


### Rate limits

Rate limits are sliding-window counters that reset on daemon restart.
Each key controls a category of potentially destructive operations.

| Operation | Default window | Default max | Description |
|-----------|---------------|-------------|-------------|
| `forget` | 60 s | 30 | Soft-delete a memory |
| `modify` | 60 s | 60 | Update memory content |
| `batchForget` | 60 s | 5 | Bulk soft-delete |
| `forceDelete` | 60 s | 3 | Hard-delete (bypasses tombstone) |
| `admin` | 60 s | 10 | Admin API operations |
| `login` | 60 s | 5 | Password dashboard login attempts |
| `inferenceExplain` | 60 s | 120 | Dry-run route decisions |
| `inferenceExecute` | 60 s | 20 | Native routed prompt execution |
| `inferenceGateway` | 60 s | 30 | OpenAI-compatible gateway completions |
| `recallLlm` | 60 s | 60 | LLM-backed recall summarization |

Override any limit under `auth.rateLimits.<operation>`:

```yaml
auth:
  rateLimits:
    forceDelete:
      windowMs: 60000
      max: 1
```

## Retention Config

The retention worker runs on a fixed interval and purges data that has
exceeded its retention window. It is not directly configurable in
`agent.yaml`; the defaults below are compiled in and apply unconditionally
when the pipeline is running.

| Field | Default | Description |
|-------|---------|-------------|
| `intervalMs` | `21600000` | Sweep frequency (6 hours) |
| `tombstoneRetentionMs` | `2592000000` | Soft-deleted memories kept for 30 days before hard purge |
| `historyRetentionMs` | `15552000000` | Memory history events kept for 180 days |
| `completedJobRetentionMs` | `1209600000` | Completed pipeline jobs kept for 14 days |
| `deadJobRetentionMs` | `2592000000` | Dead-letter jobs kept for 30 days |
| `batchLimit` | `500` | Max rows purged per step per sweep (backpressure) |

The retention worker also cleans up graph links and embeddings that
belong to purged tombstones, and orphans entity nodes with no remaining
mentions. The `batchLimit` prevents a single sweep from locking the
database for too long under high load.

Soft-deleted memories remain recoverable via `POST /api/memory/:id/recover`
until their tombstone window expires.

## Hooks Config

Controls what Signet injects during [harness](/harnesses/) lifecycle events.
See [Hooks](/hooks/) for full details.

```yaml
hooks:
  sessionStart:
    recallLimit: 10
    includeIdentity: true
    includeRecentContext: true
    recencyBias: 0.7
  userPromptSubmit:
    enabled: true
    recallLimit: 10
    maxInjectChars: 500
    minScore: 0.8
  contextProfiles:
    coding:
      sessionStart:
        recallLimit: 5
        maxInjectTokens: 5000
      userPromptSubmit:
        maxInjectChars: 300
      identity:
        files:
          - path: context-profiles/coding/AGENTS.md
            maxChars: 2200
    rich:
      sessionStart:
        recallLimit: 50
        maxInjectTokens: 20000
  harnessProfiles:
    pi: coding
    codex: coding
    hermes-agent: rich
    openclaw: rich
  preCompaction:
    includeRecentMemories: true
    memoryLimit: 5
    summaryGuidelines: "Focus on technical decisions."
```

`hooks.sessionStart` controls what is injected at the start of a new
harness session:

| Field | Default | Description |
|-------|---------|-------------|
| `recallLimit` | `50` | Number of memories to inject |
| `candidatePoolLimit` | `100` | Number of candidate memories to rank before token budgeting |
| `includeIdentity` | `true` | Include agent name and description |
| `includeRecentContext` | `true` | Include `MEMORY.md` content |
| `recencyBias` | `0.7` | Weight toward recent vs. important memories (0-1) |
| `maxInjectTokens` | `12000` | Maximum session-start injection budget after context assembly |

Context profiles let a workspace set different session-start and
prompt-submit budgets per harness. A profile can override
`sessionStart`, `userPromptSubmit`, and the ordered identity/context
files loaded at session start. `identity.files[].maxTokens` is a token
budget for that source file; `maxChars` is also accepted when a character
budget is easier to reason about. Map harness names to profile names with
`hooks.harnessProfiles`; `hooks.defaultContextProfile` can provide a
fallback for unmapped harnesses.

For lean coding harnesses, compile the canonical identity files into a
single bounded startup artifact and point the profile at that generated
file:

```bash
signet context compile --profile coding --max-chars 2200
```

The compiler reads `AGENTS.md`, `USER.md`, `IDENTITY.md`, and `SOUL.md`,
runs the configured inference `memoryExtraction` route, hard-caps the
result, and writes `context-profiles/coding/AGENTS.md`. Session-start
hooks only read that artifact; they do not perform model synthesis at
runtime.

Predicted context from recent session summaries is scoped to the active
project. If the harness does not provide a project path, Signet skips
predicted-context FTS at session start to avoid global broad-term scans
over large memory stores.

`hooks.preCompaction` controls what is included when the harness triggers
a pre-compaction summary:

| Field | Default | Description |
|-------|---------|-------------|
| `includeRecentMemories` | `true` | Include recent memories in the prompt |
| `memoryLimit` | `5` | How many recent memories to include |
| `summaryGuidelines` | built-in | Custom instructions for session summary |

`hooks.userPromptSubmit` controls per-prompt entity current-view injection:

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Enable per-prompt entity context injection |
| `recallLimit` | `10` | Legacy field retained for config compatibility; prompt-submit no longer runs generic recall |
| `maxInjectChars` | `500` | Prompt-time entity-context character budget |
| `minScore` | `0.8` | Minimum attribute relevance score required before injecting current-view aspect context |

## Environment Variables

Environment variables take precedence over `agent.yaml` for runtime
overrides. They are useful in containerized or CI environments where
editing the config file is impractical.

| Variable | Default | Description |
|----------|---------|-------------|
| `SIGNET_PATH` | — | Runtime override for agents directory |
| `SIGNET_PORT` | `3850` | Daemon HTTP port |
| `SIGNET_HOST` | `127.0.0.1` | Daemon host for local calls |
| `SIGNET_BIND` | network mode bind | Explicit bind address override (`0.0.0.0`, etc.); defaults to `127.0.0.1` in localhost mode and `0.0.0.0` in tailscale mode |
| `SIGNET_LOG_FILE` | — | Optional explicit daemon log file path |
| `SIGNET_LOG_DIR` | `$SIGNET_WORKSPACE/.daemon/logs` | Optional daemon log directory override |
| `SIGNET_SQLITE_PATH` | — | macOS explicit SQLite dylib override used before Bun opens the database |
| `SIGNET_SESSION_START_TIMEOUT` | `15000` | Session-start daemon wait budget in ms for Signet-managed clients. Generated Claude Code hook config writes this value directly. Generated Codex hook config rounds up to seconds and adds 5 seconds of harness grace |
| `SIGNET_FETCH_TIMEOUT` | `15000` | Legacy fallback for session-start timeout in ms when `SIGNET_SESSION_START_TIMEOUT` is unset |
| `SIGNET_PROMPT_SUBMIT_TIMEOUT` | `5000` | Prompt-submit daemon wait budget in ms; OpenCode uses this value directly, generated Claude Code hook config writes this value + 2000 ms grace, and generated Codex hook config rounds up to seconds and adds 2 seconds of harness grace |
| `SIGNET_TRUSTED_PROVIDER_ENDPOINT_HOSTS` | — | Comma-separated host allowlist for Anthropic endpoint overrides used during credentialed startup preflight (supports entries like `proxy.example.com` and `*.example.com`) |
| `OPENAI_API_KEY` | — | OpenAI key when embedding provider is `openai` |

`SIGNET_PATH` changes where Signet reads and writes all agent data for
that process, including the config file itself. Use this for temporary
overrides in CI or isolated local testing.

On macOS, `SIGNET_SQLITE_PATH` can point at a `libsqlite3.dylib` build
that supports `loadExtension()`. If it is set, Signet treats it as an
authoritative override and refuses fallback if the file is missing. If
it is unset, Signet checks `$SIGNET_WORKSPACE/libsqlite3.dylib`, where
`$SIGNET_WORKSPACE` resolves from `SIGNET_PATH`, then
`~/.config/signet/workspace.json`, then the default `~/.agents`, before
trying standard Homebrew SQLite locations and finally falling back to
Apple's system SQLite.

For non-loopback Anthropic endpoint overrides, the daemon
only sends provider credentials during startup preflight when the host
is trusted. Official provider hosts are trusted by default. Add trusted
proxy/gateway hosts through `SIGNET_TRUSTED_PROVIDER_ENDPOINT_HOSTS`.
