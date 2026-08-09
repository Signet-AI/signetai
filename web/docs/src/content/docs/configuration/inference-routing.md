---
title: "Inference and routing"
description: "Configure inference accounts, targets, policies, workloads, and agent routes."
---

## Inference

Signet's shared inference control plane is configured under the top-level
`inference` key in `agent.yaml`.

If `inference` is omitted, Signet preserves the old behavior by compiling
`memory.pipelineV2.extraction` and `memory.pipelineV2.synthesis` into an
implicit inference profile. That keeps existing agents working without change.

Use `inference` when you want Signet to choose models across harnesses,
accounts, APIs, and local runtimes per turn or per subtask.

Example:

```yaml
inference:
  enabled: true
  defaultPolicy: auto

  accounts:
    claude-dot:
      kind: subscription_session
      providerFamily: anthropic
      label: Dot Claude Connected
      sessionRef: CLAUDE_DOT_SESSION
    openrouter-main:
      kind: api
      providerFamily: openrouter
      credentialRef: OPENROUTER_API_KEY
    codex-subscription:
      kind: subscription_session
      providerFamily: openai-codex

  targets:
    opus:
      executor: claude-code
      account: claude-dot
      models:
        opus46:
          model: opus-4.6
          reasoning: high
          toolUse: true
          streaming: true
    sonnet:
      executor: openrouter
      account: openrouter-main
      privacy: remote_ok
      endpoint: https://openrouter.ai/api/v1
      models:
        default:
          model: anthropic/claude-sonnet-4-6
          reasoning: medium
          toolUse: true
          streaming: true
          costTier: medium
    local:
      executor: ollama
      endpoint: http://127.0.0.1:11434
      privacy: local_only
      models:
        gemma4:
          model: gemma4
          reasoning: medium
          streaming: true
          costTier: low
    codex-direct:
      executor: openai-codex
      account: codex-subscription
      models:
        default:
          model: gpt-5.4
          reasoning: high

  policies:
    auto:
      mode: automatic
      defaultTargets:
        - opus/opus46
        - sonnet/default
        - local/gemma4

  taskClasses:
    casual_chat:
      reasoning: medium
      preferredTargets:
        - sonnet/default
    hard_coding:
      reasoning: high
      toolsRequired: true
      preferredTargets:
        - opus/opus46
    hipaa_sensitive:
      privacy: local_only
      preferredTargets:
        - local/gemma4

  workloads:
    interactive:
      policy: auto
      taskClass: casual_chat
    memoryExtraction:
      policy: auto
      taskClass: casual_chat

  agents:
    rose:
      defaultPolicy: auto
      roster:
        - opus/opus46
        - sonnet/default
        - local/gemma4
      pinnedTargets:
        hard_coding: opus/opus46
```

### inference.accounts

Named account or credential identities used by targets.

| Field | Type | Description |
|-------|------|-------------|
| `kind` | string | `subscription_session` or `api` |
| `providerFamily` | string | pi-ai provider id, for example `anthropic`, `openai-codex`, `github-copilot`, or `openrouter` |
| `label` | string | Human-readable account label |
| `credentialRef` | string | Secret name or env var name for API-backed targets |
| `sessionRef` | string | Session identifier for subscription-backed targets |
| `usageTier` | string | Optional account tier label |

For an OAuth subscription, set `kind: subscription_session`, use the pi-ai
OAuth provider id as `providerFamily`, and omit `credentialRef`. Connect the
account through `/api/inference/oauth/login/:id`. Signet stores the resulting
OAuth credential in its encrypted secret store and asks pi-ai to refresh it at
request time. For a conventional API-key account, use `kind: api` and set
`credentialRef`; environment variables continue to take precedence over the
encrypted secret with the same name.

### inference.targets

Executable route targets. A target can be a local runtime, API backend,
subscription-backed CLI session, or gateway.

| Field | Type | Description |
|-------|------|-------------|
| `executor` | string | `acpx`, a local compatibility executor, or a provider id returned by `/api/inference/catalog` |
| `kind` | string | Optional explicit target kind. Inferred when omitted |
| `account` | string | Account id from `inference.accounts` |
| `endpoint` | string | Optional base URL override |
| `command` | object | Command executor config with `bin`, optional `args`, `cwd`, and `env` |
| `agent` | string | For `executor: acpx`, the ACPX adapter command to run, for example `codex`, `claude` for Claude Code, or `opencode`. Signet normalizes legacy `claude-code` values to ACPX's `claude` command. |
| `acpxVersion` / `version` | string | Optional ACPX package version. Defaults to Signet's pinned ACPX version |
| `mode` | string | Optional ACPX execution mode. Defaults to one-shot exec |
| `cwd` | string | Optional working directory for harness execution |
| `session` | string | Optional ACPX session identifier when a persistent session is desired |
| `permissions` | string | Optional ACPX permission policy passed through to the harness |
| `hooks` | string | Set to `disabled` for sterile/background execution (`SIGNET_NO_HOOKS=1` and `SIGNET_ENABLED=false`) |
| `terminal` | boolean | For ACPX, set `false` to pass `--no-terminal` |
| `allowedTools` | array | Optional ACPX allowed-tool list |
| `format` / `outputFormat` | string | ACPX output format. `quiet` is the default; `json` parses ACPX JSON events and extracts the final response |
| `captureEvents` | boolean | When true, defaults ACPX to JSON output and enables the provider event-capture path |
| `maxCapturedEvents` | number | Maximum number of JSON events delivered to the provider-side event callback; defaults to 200 |
| `emptyResponseRetries` | number | Fresh-session retries after an exit-0 empty response. Defaults to 1 and is capped at 3; retries run only for sterile deny-all targets with hooks and tools disabled |
| `modelSelection` | string | `acp` passes the routed model through ACPX negotiation; `agent` lets the ACP agent's native configuration choose it. Defaults to `agent` for OpenCode and `acp` for other agents |
| `timeoutMs` | number | Per-call ACPX subprocess deadline |
| `extraArgs` | array | Additional ACPX CLI args appended after Signet-managed args |
| `privacy` | string | `remote_ok`, `restricted_remote`, or `local_only` |
| `models` | map | Named model entries for this target |

Example ACPX background target (see also `docs/ACP-INTEGRATION.md` for the architecture and current limitations):

```yaml
inference:
  targets:
    background-codex:
      executor: acpx
      agent: codex
      hooks: disabled
      terminal: false
      format: json
      captureEvents: true
      timeoutMs: 120000
      models:
        mini:
          model: gpt-5.4-mini
          reasoning: medium
          toolUse: true
```

Direct Codex CLI targets use the `codex` binary in the daemon runtime. The Docker image includes the CLI;
mount a logged-in Codex config directory only when you opt into this executor:

```bash
SIGNET_CODEX_HOME="$HOME/.codex" docker compose -f compose.yml -f compose.codex.yml up -d
```

```yaml
inference:
  targets:
    codex-cli:
      executor: codex
      models:
        default:
          model: gpt-5.4-mini
          reasoning: medium
  workloads:
    memoryExtraction:
      target: codex-cli/default
      taskClass: memory_extraction
```

Signet marks the target unavailable unless `codex --version` works and either `CODEX_HOME/auth.json`
is mounted or `OPENAI_API_KEY` is present. The auth cache is copied into a sterile temporary home for
each call; the mounted Codex config stays read-only.

Model fields:

| Field | Type | Description |
|-------|------|-------------|
| `model` | string | Provider-native model identifier |
| `label` | string | Optional display label |
| `reasoning` | string | `low`, `medium`, or `high` |
| `contextWindow` | number | Maximum prompt tokens the model can accept |
| `toolUse` | boolean | Whether tool use is supported |
| `streaming` | boolean | Whether streaming is supported |
| `multimodal` | boolean | Whether multimodal input is supported |
| `costTier` | string | `low`, `medium`, or `high` |
| `averageLatencyMs` | number | Optional routing latency hint |

### inference.policies

Named routing policies that agents and workloads reference.

| Field | Type | Description |
|-------|------|-------------|
| `mode` | string | `strict`, `automatic`, or `hybrid` |
| `allow` | array | Route refs allowed by the policy |
| `deny` | array | Route refs denied by the policy |
| `defaultTargets` | array | Ordered preferred target refs |
| `taskTargets` | map | Task-class specific preferred target refs |
| `fallbackTargets` | array | Explicit fallback refs |
| `maxLatencyMs` | number | Hard latency ceiling used by routing |
| `costCeiling` | string | Hard cost ceiling used by routing |

Policies are optional: when targets exist but no `policies` (and no
`defaultPolicy`) are configured, the router synthesizes an implicit
`default` policy (`mode: automatic`, `defaultTargets`/`fallbackTargets` over
all configured target refs) so every generation path keeps working. `signet
route list` shows it like any other policy. Add an explicit policy to pin
routing deterministically; `signet route doctor` warns when agent.yaml relies
on the synthesized policy.

### inference.taskClasses

Task-family hints for automatic routing.

| Field | Type | Description |
|-------|------|-------------|
| `reasoning` | string | Required reasoning depth |
| `toolsRequired` | boolean | Require tool use support |
| `streamingPreferred` | boolean | Prefer or require streaming support |
| `multimodalRequired` | boolean | Require multimodal support |
| `privacy` | string | Hard privacy tier, including `local_only` |
| `maxLatencyMs` | number | Task latency budget |
| `costCeiling` | string | Task cost ceiling |
| `expectedInputTokens` | number | Prompt-size hint |
| `expectedOutputTokens` | number | Output-size hint |
| `preferredTargets` | array | Preferred target refs |
| `keywords` | array | Lightweight classifier keywords |

### inference.workloads

Binds Signet-owned workloads to router policies or explicit targets.

Supported workload keys:

- `interactive`
- `memoryExtraction`

Each workload can define:

| Field | Type | Description |
|-------|------|-------------|
| `policy` | string | Named policy id |
| `taskClass` | string | Default task class for this workload |
| `target` | string | Explicit `target/model` pin |

### inference.agents

Per-agent routing overrides.

| Field | Type | Description |
|-------|------|-------------|
| `defaultPolicy` | string | Default policy for that agent |
| `roster` | array | Allowed target refs for that agent |
| `preferredTargets` | map | Task-class target preferences |
| `pinnedTargets` | map | Hard pins, usually managed by `signet route pin` |
