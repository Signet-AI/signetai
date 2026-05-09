---
title: "ACP and ACPX Integration"
description: "How Signet uses ACPX as a first-class inference backend today, and how ACP fits into future agent coordination."
order: 5
section: "Architecture"
---

ACP and ACPX Integration
========================

*Signet handles identity, memory, routing, and policy. ACPX handles how to talk to agent harnesses.*

> **Current status:** Signet has a first-class `executor: acpx` inference
> backend for daemon/background inference. The older “scheduler uses raw
> `Bun.spawn` through ACPX” plan is obsolete.

This document explains the current ACPX integration, how to configure it, what
it deliberately does *not* do yet, and how it relates to longer-term Agent
Client Protocol (ACP) coordination work.

Terminology
-----------

- **ACP (Agent Client Protocol)** is the protocol layer for structured agent
  sessions: prompts, session lifecycle, cancellation, permissions, and
  capability exchange.
- **ACPX** is the CLI/runtime Signet uses to drive ACP-capable harnesses such
  as Codex, Claude Code, OpenCode, OpenClaw, Gemini, and others.
- **Signet inference routing** is Signet's daemon-owned control plane for
  choosing a target/model for workloads such as memory extraction and session
  synthesis.

The important boundary is:

```text
Signet daemon
  owns identity, memory, workload policy, routing, and context injection mode

ACPX
  owns harness adapter invocation, ACP session mechanics, CLI args, and agent IO

Agent harness
  owns actual reasoning, model execution, and tools
```

Why ACPX is a backend, not an integration
-----------------------------------------

ACPX is not treated as a one-off command hook. It is a first-class Signet
inference executor alongside `ollama`, `openai-compatible`, `anthropic`,
`openrouter`, `claude-code`, `codex`, `opencode`, and `command`.

That distinction matters:

- Signet workloads bind to `inference.workloads`, not scattered CLI glue.
- The daemon's `InferenceRouter` constructs the ACPX provider just like any
  other inference provider.
- Background memory tasks can move to ACPX without each worker knowing how to
  spawn Codex, Claude Code, or OpenCode directly.
- Direct harness executors remain available as legacy/direct escape hatches,
  but ACPX is the recommended harness-backed route for background inference.
- OpenAI-compatible endpoints, Ollama/local runtimes, OpenRouter, Anthropic,
  and `command` remain explicit alternatives for users who do not want ACPX.

Current implementation
----------------------

Signet currently supports ACPX in the top-level `inference:` block:

```yaml
inference:
  defaultPolicy: background-acpx
  targets:
    background-acpx:
      executor: acpx
      acpx:
        agent: codex          # codex, claude (Claude Code), opencode, or another ACPX agent
        version: "0.7.0"      # pinned by default
        mode: exec            # current default: one-shot exec
        permissions: deny-all
        hooks: disabled       # sets SIGNET_NO_HOOKS=1
        terminal: false       # passes --no-terminal
      models:
        default:
          model: gpt-5-codex-mini
          reasoning: medium
          toolUse: true

  taskClasses:
    memory_extraction:
      reasoning: medium
      toolsRequired: true
      privacy: restricted_remote
    session_synthesis:
      reasoning: medium
      toolsRequired: true
      privacy: restricted_remote

  workloads:
    memoryExtraction:
      target: background-acpx/default
      taskClass: memory_extraction
    sessionSynthesis:
      target: background-acpx/default
      taskClass: session_synthesis
```

When a routed workload uses that target, the daemon builds a command equivalent
to:

```bash
npx -y acpx@0.7.0 \
  --format quiet \
  --timeout 120 \
  --model gpt-5-codex-mini \
  --deny-all \
  --no-terminal \
  codex exec --file -
```

The prompt is written to stdin. The final text response is read from stdout and
returned to the current `LlmProvider` abstraction.

### JSON event capture

Signet can also ask ACPX for JSON output:

```yaml
inference:
  targets:
    background-acpx:
      executor: acpx
      acpx:
        agent: codex
        format: json
        captureEvents: true
        maxCapturedEvents: 200
      models:
        default:
          model: gpt-5-codex-mini
```

With `format: json`, the daemon reads ACPX stdout as newline-delimited JSON
events. Each event is parsed and validated. The provider still returns a plain
final string to existing callers by extracting the final response from the last
result-like event, so background memory extraction does not need a new provider
API.

`captureEvents: true` is a convenience flag that defaults the ACPX output format
to JSON when `format` is omitted. Provider-level callers can also attach an
event callback; Signet limits callback delivery with `maxCapturedEvents`
(default `200`) while still scanning the full stream for the final response.

This is intentionally the first Zed-inspired step, not the whole session model:
Signet now has a typed ACPX event parsing seam, but durable dashboard-visible
event/session storage is still future work.

If `mode: session` and `session: <name>` are configured, Signet still uses the
one-shot `exec --file -` prompt path, but attaches the named ACPX session:

```bash
npx -y acpx@0.7.0 codex -s background exec --file -
```

This preserves the current final-text provider contract while allowing ACPX to
associate the run with a named session where supported.

Configuration reference
-----------------------

ACPX target config lives under `inference.targets.<name>.acpx`.

| Field | Type | Description |
|---|---|---|
| `agent` | string | ACPX agent command, for example `codex`, `claude` for Claude Code, or `opencode`. Legacy `claude-code` values are normalized to `claude` before spawning ACPX. |
| `version` / `acpxVersion` | string | ACPX npm package version. Defaults to Signet's pinned `0.7.0`. |
| `bin` | string | Optional executable override. If omitted, Signet runs `npx -y acpx@<version>`. |
| `cwd` | string | Working directory for ACPX and the harness. |
| `mode` | `exec` or `session` | `exec` is the default. `session` only adds `-s <session>` before `exec --file -`. |
| `session` | string | Named ACPX session used when `mode: session`. |
| `permissions` | `inherit`, `deny-all`, `approve-reads`, or `approve-all` | Maps to ACPX permission flags. |
| `hooks` | `inherit`, `disabled`, or `enabled` | `disabled` sets `SIGNET_NO_HOOKS=1`; `enabled` removes it; `inherit` leaves the environment alone. |
| `terminal` | boolean or string | `false` or `disabled` passes `--no-terminal`; `true` maps to `enabled`; string modes `inherit`, `disabled`, `enabled` are accepted. |
| `allowedTools` | string[] | Passed as comma-separated `--allowed-tools`. |
| `timeoutMs` | number | Per-call subprocess deadline in milliseconds. Also converted to ACPX `--timeout` seconds. |
| `extraArgs` | string[] | Additional ACPX args appended after Signet-managed global args and before the agent command. |

Context and hook modes
----------------------

Background inference can accidentally bloat itself if it receives Signet's
normal session-start memory context. For that reason, setup-generated ACPX
background targets use:

```yaml
hooks: disabled
```

That maps to `SIGNET_NO_HOOKS=1`, which prevents Signet harness hooks from
injecting session-start context into the ACPX subprocess.

This is intentionally configurable, not global:

- **Memory extraction / summarization:** usually `hooks: disabled` so the model
  only sees the worker prompt and source transcript.
- **Dreaming / reflection / maintenance:** may want `hooks: enabled` or
  `inherit` when the workload intentionally uses Signet memory context.
- **Interactive agent work:** should generally keep the normal harness context
  path unless a caller explicitly wants sterile execution.

Setup behavior
---------------

The setup flow can choose ACPX when an ACPX-capable harness is detected or
selected. The generated config writes an explicit `inference:` block rather
than relying on legacy `memory.pipelineV2.extraction.provider` alone.

Agent selection is based on the same evidence used to choose ACPX:

- If the user selected a supported harness, setup uses that harness first.
- If no harness was explicitly selected but a supported command was detected,
  setup uses the detected harness.
- It does not hard-code Codex when only Claude Code or OpenCode was found.

Legacy pipeline compatibility
-----------------------------

`memory.pipelineV2.extraction.provider: acpx` can appear as a setup
compatibility marker, but by itself it is not enough to run ACPX.

ACPX needs an agent, model, hook mode, permission mode, timeout, and workload
binding. Those belong in top-level `inference:` routing. Keep the generated
`inference.targets.*.executor: acpx` block, or write one manually.

This is different from old direct providers:

```yaml
memory:
  pipelineV2:
    extraction:
      provider: claude-code   # legacy/direct provider
      model: haiku
```

Direct providers like `claude-code`, `codex`, and `opencode` still work, but
ACPX is the recommended harness-neutral path for background inference.

What is not implemented yet
---------------------------

The current ACPX backend is deliberately narrow. It does **not** yet implement:

- Durable ACPX JSON event ingestion into Signet's trace/session store. The
  provider can parse JSON events and preserve the final text contract, but raw
  events are not yet persisted as dashboard-visible session history.
- Persistent multi-turn ACPX conversations as a first-class daemon session
  abstraction.
- A `signet acp --agent <name>` ACP server/proxy command.
- `platform/daemon/src/acp-bridge/`.
- Scheduler task spawning through ACPX session management.
- `acpxRecordId` persistence in task/session tables.
- Dashboard views of ACPX sessions, queues, or typed ACP events.

Those ideas were part of the older phase plan. They remain plausible future
work, but they are not the current shipped integration.

Relationship to MCP cross-agent messaging
-----------------------------------------

Signet also has MCP tools for cross-agent messages. `agent_message_send` can use
local daemon delivery or an ACP relay path:

```json
{
  "via": "acp",
  "acp_base_url": "https://acp.example.com",
  "acp_target_agent_name": "peer-helper",
  "message": "Can you review this?"
}
```

That path is about message delivery between agents. The ACPX inference backend
is about daemon-owned background LLM calls. They are complementary:

- **MCP messaging / ACP relay:** agent-to-agent communication.
- **ACPX inference target:** daemon-to-harness inference for Signet workloads.

Roadmap
-------

The current useful path is incremental:

1. **Done: ACPX inference target.** Route background Signet workloads through
   `executor: acpx` and keep direct providers as fallbacks.
2. **Done: ACPX JSON parsing seam.** ACPX targets can request JSON output,
   validate each event, optionally deliver bounded provider callbacks, and still
   return a final text response to existing callers.
3. **Next: durable ACPX telemetry.** Persist selected JSON event output,
   tool-call structure, usage, and request/session ids into the daemon's trace
   or session store.
4. **Next: persistent session semantics.** Make named ACPX sessions a daemon
   concept rather than only a CLI flag passthrough.
5. **Later: Signet ACP proxy.** Add a real ACP server/proxy that can inject
   identity and memory at the protocol boundary for any ACP-compatible client.
6. **Later: multi-agent coordination.** Use Signet's agent registry, skills,
   memory graph, and workload policies to delegate work across ACP sessions.

Migration guidance
------------------

For background inference, prefer this progression:

```text
legacy direct harness provider
  memory.pipelineV2.extraction.provider: codex | claude-code | opencode

        ↓

explicit ACPX inference target
  inference.targets.<name>.executor: acpx
  inference.workloads.memoryExtraction.target: <name>/<model>

        ↓

future ACPX event/session-aware daemon integration
```

Nothing in the current ACPX backend requires removing hooks, MCP tools, direct
providers, local Ollama, OpenAI-compatible endpoints, or custom `command`
executors. ACPX is the recommended default harness abstraction for background
inference, not the only inference path.
