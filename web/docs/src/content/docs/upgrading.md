---
title: "Upgrading"
description: "Signet documentation: Upgrading."
---

**Breaking change.** This release replaces Signet's hand-rolled inference
providers with two backends: **Pi** (`@earendil-works/pi-ai`) for every direct
API call, and **ACPX** for harness subprocess calls. Existing installs **must
verify their background pipeline still functions after updating.**

If you are upgrading from a release before this change, read this entire page.

## What changed

Before this release, Signet shipped six hand-rolled LLM providers in a
4,000-line `provider.ts`: Claude Code (subprocess), OpenCode (HTTP server),
Codex (subprocess), a generic command-line provider, and direct HTTP for
Anthropic / OpenAI-compatible / Ollama / llama.cpp / OpenRouter.

After this release there are exactly **two backends** behind the same
`LlmProvider` interface:

- **Pi** (`pi-ai`) — every direct API call: Anthropic, OpenAI (incl. Codex),
  Google, Bedrock, Mistral, Azure, Cloudflare, Copilot, OpenRouter, and all
  OpenAI-compatible local servers (LM Studio, Ollama, llama.cpp).
- **ACPX** — the retained harness-subprocess backend, now a bundled dependency
  (`acpx@0.12.0`) and a first-class peer endpoint in the routing registry. It
  drives Claude Code, Codex, OpenCode, Gemini, and the rest of the ACP agent
  family, plus a `--agent <binary>` escape hatch for custom harnesses.

The following routing executors have been **removed** and will now fail with a
structured error pointing at this page:

| Removed executor | Replace with |
|---|---|
| `claude-code` | `acpx` (agent: `claude`), or `anthropic` for direct API |
| `codex` | `acpx` (agent: `codex`), or `openrouter`/`openai-compatible` for direct API |
| `opencode` | `acpx` (agent: `opencode`), or an OpenAI-compatible direct target |
| `command` | `acpx` with `--agent <binary>`, or re-implement as an OpenAI-compatible target |
| `anthropic` | unchanged (now Pi-backed; same config) |
| `openrouter` | unchanged (now Pi-backed) |
| `ollama` | unchanged (now Pi-backed via OpenAI-compatible) |
| `llama-cpp` | unchanged (now Pi-backed via OpenAI-compatible) |
| `openai-compatible` | unchanged (now Pi-backed) |

`memory.pipelineV2.extraction.provider: command` is also retired. Configure a
canonical `inference.workloads.memoryExtraction` target instead; the daemon
will reject the retired command configuration rather than silently falling
back to another provider.

## Action required after updating

1. **Check the daemon log on first start.** If your `agent.yaml` references a
   removed executor, the daemon logs a structured error naming the target and
   the executor to replace. Background extraction/synthesis will not run until
   you fix it.
2. **Reconfigure the target.** In nearly every case the replacement is a
   one-line edit: change `executor: claude-code` to `executor: acpx` (and add
   `acpx: { agent: claude }`), or `executor: codex` to `executor: acpx`
   (with `acpx: { agent: codex }`). Direct-API targets (`anthropic`,
   `openrouter`, `ollama`, `llama-cpp`, `openai-compatible`) keep working as-is
   — only the underlying engine changed.
3. **Verify a background call.** Trigger a Dreaming pass or session summary
   (`signet memory ingest ...`, or send a session through the pipeline) and
   confirm it completes.
4. **Verify aggregate recall** if you use it: `signet recall "<query>" --aggregate`.
   It now flows through pi-ai; latency is unchanged (verified at ~200–500ms for
   synthesis-sized calls on a local model).

## Behavioral changes to expect

These are intentional consequences of the cutover, not bugs:

- **OpenRouter reasoning controls.** The `{ enabled, maxTokens }` reasoning
  block is now translated by pi-ai into its own `{ effort }` abstraction
  (omitted entirely when reasoning is disabled) rather than forwarded verbatim.
  pi-ai owns the reasoning wire format now.
- **Keyless local servers** (LM Studio, Ollama, llama.cpp) receive a placeholder
  `Authorization` header. pi-ai's credential resolver requires a non-empty API
  key; local servers ignore it. No real credential is sent.
- **Availability probes.** Each target now does a `/models` reachability check
  so the router can skip unreachable targets before attempting a real call
  (this also makes fallback attribution correct).

## ACPX as a harness replacement

ACPX is bundled with the daemon (no separate install, no `npx` fetch). It
replaces the removed harness subprocess providers. Verified to drive each:

- `acpx claude` — replaces `executor: claude-code`
- `acpx codex` — replaces `executor: codex`
- `acpx opencode` — replaces `executor: opencode`
- `acpx --agent <binary>` — replaces `executor: command`

Configure it as a routing target:

```yaml
inference:
  targets:
    claude-harness:
      executor: acpx
      acpx:
        agent: claude        # or codex, opencode, gemini, ...
      models:
        default:
          model: claude-sonnet-4
```

## daemon-rs removed

The experimental Rust daemon rewrite (`platform/daemon-rs`) and its shadow
proxy, CLI runtime switch (`SIGNET_DAEMON_RUNTIME`), and route-parity harness
have been removed. The TypeScript/Bun daemon is the sole runtime. Rust
accelerators (`@signet/native`) are unaffected.

## Need help

If a background pipeline operation does not resume after updating, run
`signet doctor` and check the daemon log for the structured "folded executor"
error — it names the exact target and executor to change.
