# Spike Findings: Pi SDK as the Inference Backend (#947, Phase 0)

**Date:** 2026-07-21
**Status:** GATE PASSED — hard cutover is viable.
**Scope:** Verify the real `@earendil-works/pi-ai` API against live local models, confirm the OpenAI-compatible coverage path, and prove usage/abort/streaming parity. This document gates the hard cutover decision in #947.

## Method

- Cloned the pi mono repo into `references/pi-mono/` (sibling-harness inspection per AGENTS.md). Source inspected: `packages/ai/src/{types,models,compat,stream}.ts`, `packages/ai/src/providers/`, `packages/coding-agent/src/extensions/llama/provider.ts`.
- Built a standalone spike (`bun add @earendil-works/pi-ai@0.79.2` — the exact version we will depend on) that imports the real published package and calls live models.
- Tested against **LM Studio** (`localhost:1234`, OpenAI-compatible) and **Ollama** (`localhost:11434`, OpenAI-compatible `/v1`).

## Finding 1 — The API in #947 does not exist as described

#947 referenced `ModelRuntime.create()`. That symbol does not exist in the installed SDK (v0.79.2, verified against `dist/index.d.ts` and `dist/core/sdk.d.ts`). The real substrate is:

- **`Model<TApi>`** (`pi-ai/types.ts`) — carries `id`, `api`, `provider`, `baseUrl`, `headers`, `compat`, `contextWindow`, `maxTokens`, `cost`. A custom OpenAI-compatible endpoint is a `Model<"openai-completions">` with a custom `baseUrl` + `compat` flags. **This is exactly the pattern pi's own `coding-agent/extensions/llama/provider.ts` uses for local llama.cpp servers.**
- **`completeSimple` / `streamSimple`** (`pi-ai/stream.ts`, re-exported from the package root) — the one-shot and streaming call primitives. Signature: `(model, context, options?) => Promise<AssistantMessage> | AssistantMessageEventStream`.
- **`registerBuiltInApiProviders()`** — must be called once before any call; registers the per-API stream functions (anthropic, openai-completions, openai-responses, google, etc.).
- **`AuthStorage`** / `CredentialStore` — pluggable auth backend. **Workstream B** (`createAgentSession`) builds on this; A constructs `Model` objects directly from `agent.yaml` and bypasses Pi's config system.

## Finding 2 — Local models (LM Studio / Ollama / llama.cpp) are covered

`pi-ai` ships **no native Ollama or llama.cpp provider**. This was the flagged coverage risk. It is closed by the OpenAI-compatible path, which is pi's own canonical pattern (see their llama.cpp extension). All three local servers expose `/v1/chat/completions` and route through `Model<"openai-completions">`.

Live test results (real calls, not mocked):

| Test | Result |
|---|---|
| `completeSimple` → LM Studio (`qwen3.5-0.8b`) | `stopReason=stop`, answer "68", 2011ms |
| `streamSimple` → LM Studio | streamed "68", TTFT 73ms, usage in `done` event |
| `streamSimple` + `AbortSignal` (120ms) | fired at 119ms → `reason=aborted` at 121ms (**2ms cancel latency**), clean loop exit |
| `streamSimple` + `AbortSignal` (400ms) | `reason=aborted` at 400ms, 468 chars produced, clean exit |
| `streamSimple` → Ollama (`qwen3.5:4b`) | "The sky is usually blue at noon.", usage `input=30 output=220 total=250` |

**Keyless servers work** by passing a dummy `apiKey` in options (LM Studio / Ollama ignore the header). The credential resolver short-circuits on any non-empty string.

## Finding 3 — Usage / stopReason / abort parity is clean

`pi-ai` `Usage` → Signet `LlmUsage` (`platform/core/src/types.ts`) is a field-for-field map:

| `pi-ai Usage` | Signet `LlmUsage` |
|---|---|
| `input` | `inputTokens` |
| `output` | `outputTokens` |
| `cacheRead` | `cacheReadTokens` |
| `cacheWrite` | `cacheCreationTokens` |
| `cost.total` | `totalCost` |
| — (tracked by adapter) | `totalDurationMs` |

`AssistantMessage.stopReason` (`stop` / `length` / `toolUse` / `error` / `aborted`) maps to adapter error handling: `error`/`aborted` throw; the rest return. `AbortSignal` propagates through `options.signal` and terminates the stream with `reason=aborted` — **no swallowed errors, no orphaned connections**. This satisfies AGENTS.md "Silent Failure And Fallbacks."

## Finding 4 — The adapter is small

The `createPiModelProvider(): LlmProvider` adapter is ~100–150 LOC:

- `generate(prompt, opts)` → `completeSimple(model, { messages: [...] }, { apiKey, signal, maxTokens, temperature })` → join text content → return string.
- `generateWithUsage(prompt, opts)` → same → `{ text, usage }` via the map above.
- `available()` → `true` (model is constructed from config; no live ping needed).
- `responseFormat: "json"` and `think` map to pi-ai options (openai-completions `response_format`; `reasoning` thinking level) — detail to nail in Phase 1.

The 35 `LlmProvider` call sites are unchanged. `LlmProvider` stays the internal seam; Pi is the single implementation behind it (plus the retained/promoted ACPX backend).

## Gate verdict

**Hard cutover is viable.** The flagged coverage gap (no native Ollama/llama.cpp) is closed by the OpenAI-compatible path, which is pi's own canonical pattern for local servers. Usage, streaming, and abort all behave correctly against live models. No load-bearing gap was found that would force a fallback path.

**Carry-forward to Phase 1:**
1. `registerBuiltInApiProviders()` must run once at daemon init, before any provider call.
2. Keyless local servers need a dummy `apiKey` (not a special code path — the resolver short-circuits on it).
3. `compat` flags per model matter (LM Studio/Ollama: `supportsStore:false`, `maxTokensField:"max_tokens"`, etc.) — derive from the server, not hardcode.
4. `responseFormat:"json"` and `think` mapping to confirm against a real cloud provider (not testable locally) during Phase 1.

The deprecated providers (Claude Code subprocess, OpenCode, Codex CLI, generic command-line, native Ollama/llama.cpp HTTP) are folded: their capability is provided by Pi's API providers and the OpenAI-compatible local path, plus the retained ACPX backend.
