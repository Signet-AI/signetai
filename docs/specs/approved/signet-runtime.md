---
title: "Signet Native Runtime"
description: "Spec for the Signet reference agent runtime — a first-class execution harness owned and controlled by Signet"
informed_by: []
success_criteria:
  - "Signet operates as a standalone runtime channel independent of harness-specific connectors"
scope_boundary: "Runtime scaffold and CLI/HTTP channels — does not replace existing connectors or define memory logic"
---

Signet Native Runtime
=====================

Context
-------

Signet currently runs as a cognitive maintenance layer on top of external
runtimes — OpenClaw, Claude Code, OpenCode. These are first-class harness
integrations and remain so. The problem is that Signet's capability growth
is gated on what each harness exposes: if a harness deprecates a plugin
interface, changes its hook model, or simply doesn't support a new
lifecycle event, Signet loses the surface.

The deeper issue is definitional. Every harness integration has to answer
the question "what does a Signet harness need to implement?" — right now
there is no canonical answer. Each connector is a bespoke translation layer.

The solution is a reference runtime: a Signet-owned, Signet-controlled
execution environment that defines what it means to run an agent on Signet.
Existing harnesses don't become secondary — they copy the pattern. When the
reference implementation adds a new capability, the harness adapters have a
clear spec to implement against. The reference runtime is the source of
truth for what the integration contract is.

Key constraints:
- All actions in the runtime are Daemon API calls first. The runtime is a
  thin orchestration layer over the daemon HTTP API, not a parallel
  implementation of daemon functionality.
- Harnesses are thin clients. They translate platform-specific events into
  Daemon API calls using the same interfaces the reference runtime uses.
- SDKs for TypeScript, Rust, and Python continue to be first-class. The
  runtime expands what the SDKs expose, not replaces them.
- Forge is the canonical reference implementation of this runtime
  contract. The contract is language-agnostic; the implementation is
  currently Rust, not TypeScript.


What the Runtime Is
-------------------

The Signet runtime is a session execution loop that:

1. Assembles context (memory injection, system prompt, identity) via daemon
2. Sends a turn to a configured LLM provider
3. Dispatches tool calls through a registered tool registry
4. Manages the session lifecycle (start, prompt, end, compaction)
5. Records behavioral signals back to the daemon (FTS hits, continuity)

Every one of those steps is a daemon API call or a thin wrapper around one.
The runtime doesn't store state — the daemon does.

The runtime's only owned concern is the execution loop: taking a user
message, assembling what the agent needs to respond, calling the model,
handling tools, and returning output. Everything else is delegated.


Core Interfaces
---------------

These interfaces define the integration contract. Implementing them is what
it means to be a Signet harness.

### Provider

```typescript
interface Provider {
  id: string
  complete(messages: Message[], opts?: CompletionOptions): Promise<CompletionResult>
  stream(messages: Message[], opts?: CompletionOptions): AsyncIterable<CompletionChunk>
  available(): Promise<boolean>
}

interface CompletionOptions {
  model?: string
  maxTokens?: number
  temperature?: number
  tools?: ToolDefinition[]
  systemPrompt?: string
}

interface CompletionResult {
  content: string
  toolCalls?: ToolCall[]
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'
  usage: { inputTokens: number; outputTokens: number }
}
```

Implementations: Anthropic, OpenAI, OpenAI-compatible (Ollama, local).
The runtime ships a default Anthropic provider. Additional providers are
registered at startup or loaded from config.

### Tool

```typescript
interface Tool {
  name: string
  description: string
  inputSchema: JsonSchema
  runBeforeGeneration?: boolean  // opt-in to pre-generation research phase
  execute(input: unknown, context: ToolContext): Promise<unknown>
}

interface ToolContext {
  sessionKey: string
  project: string
  daemonUrl: string  // all daemon calls go through context, never direct
}
```

Tools are registered in a `ToolRegistry`. The runtime dispatches tool calls
from model responses through the registry. Built-in tools: `memory_search`,
`memory_store`, `memory_get`, `memory_modify`, `memory_forget` — thin
wrappers over daemon API endpoints, identical to what the MCP server exposes.

### Channel

```typescript
interface Channel {
  kind: string
  receive(): Promise<UserTurn>
  send(output: AgentOutput): Promise<void>
  onClose(handler: () => void): void
}

interface UserTurn {
  content: string
  attachments?: Attachment[]
  metadata?: Record<string, unknown>
}

interface AgentOutput {
  content: string
  toolResults?: ToolResult[]
  streaming?: boolean
}
```

First channel: CLI (stdin/stdout). Subsequent: HTTP (for harness adapter
attachment). Channel is the only interface that varies between the reference
runtime and a harness adapter — everything else (provider, tools, lifecycle)
is identical.

### RuntimeAdapter

This is the interface a harness implements to integrate with Signet. It maps
platform-specific lifecycle events to daemon API calls.

```typescript
interface RuntimeAdapter {
  harness: string  // 'openclaw' | 'claude-code' | 'opencode' | 'signet-cli' | ...

  onSessionStart(params: SessionStartParams): Promise<SessionStartResult>
  onUserPromptSubmit(params: PromptSubmitParams): Promise<PromptSubmitResult>
  onSessionEnd(params: SessionEndParams): Promise<void>
  onPreCompaction(params: PreCompactionParams): Promise<PreCompactionResult>
  onCompactionComplete(params: CompactionCompleteParams): Promise<void>
}
```

All `RuntimeAdapter` implementations are thin clients: every method body is
a daemon API call. The reference runtime (`signet-cli` harness) implements
this interface using the full execution loop. OpenClaw's adapter implements
the same interface by calling the same daemon endpoints via its plugin system.

A harness adapter is a `RuntimeAdapter` implementation. Nothing more.


Package Structure
-----------------

```
packages/forge/
  Cargo.toml                (Forge Rust workspace root)
  crates/
    forge-cli/             (primary `forge` binary)
    forge-agent/           (execution loop)
    forge-provider/        (provider registry + clients)
    forge-tools/           (tool registry + built-in tools)
    forge-signet/          (daemon client / Signet integration)
    forge-tui/             (terminal channel / UI)
```

Forge is the monorepo-owned reference implementation of the runtime
contract. The public contract stays the same even though the concrete
implementation lives in `packages/forge/`.

`forge` remains the primary end-user command. Signet may additionally
manage Forge installs through `signet forge ...`, but the runtime itself
is the Forge product.


Session Lifecycle
-----------------

Each turn in the execution loop:

```
1. Channel.receive()
     → get user message

2. executor.preGeneration()   [research phase]
     → query daemon for relevant memories (FTS + vector)
     → execute tools with runBeforeGeneration: true
     → results available to model before generation starts

3. context.assemble()
     → system prompt: identity + SOUL.md content + injected memories
     → conversation history
     → pre-generation tool results

4. Provider.complete()
     → call the model with assembled context

5. executor.dispatch()        [tool loop]
     → for each tool call in response: ToolRegistry.execute()
     → append results to messages
     → loop back to Provider.complete() until stop_reason = end_turn

6. daemon POST /api/hooks/user-prompt-submit
     → record FTS hits for behavioral signals (predictive scorer training)

7. Channel.send()
     → deliver output to user
```

Session start:
```
daemon POST /api/hooks/session-start
  → memories injected into first-turn system prompt
  → continuity checkpoint loaded if session resumed
```

Session end:
```
daemon POST /api/hooks/session-end
  → triggers continuity scoring job
  → memory extraction pipeline enqueued
  → session checkpoint saved
```

The pre-generation research phase (step 2) is the key architectural
difference from a naive chat loop. Tools that declare `runBeforeGeneration:
true` execute before the model sees the user message. The model gets
grounded context instead of generating then correcting.


Daemon API Dependency Map
--------------------------

Every runtime action maps to a daemon endpoint. This table defines the
integration surface a harness adapter must cover for full parity:

| Runtime Action              | Daemon Endpoint                      | Phase |
|-----------------------------|--------------------------------------|-------|
| Session start context       | POST /api/hooks/session-start        | start |
| Per-prompt context + FTS    | POST /api/hooks/user-prompt-submit   | turn  |
| Session end / extraction    | POST /api/hooks/session-end          | end   |
| Pre-compaction summary      | POST /api/hooks/pre-compaction       | cmpct |
| Save compaction result      | POST /api/hooks/compaction-complete  | cmpct |
| Memory search (tool)        | POST /api/memory/recall              | any   |
| Memory store (tool)         | POST /api/hooks/remember             | any   |
| Memory get (tool)           | GET  /api/memory/:id                 | any   |
| Memory modify (tool)        | POST /api/memory/modify              | any   |
| Memory forget (tool)        | POST /api/memory/forget              | any   |
| Secret injection            | POST /api/secrets/exec               | tool  |
| Daemon health check         | GET  /health                         | start |

A harness adapter that covers all rows has full parity with the reference
runtime. Partial coverage is valid — the delta is explicit and auditable.


SDK Surface Additions
---------------------

The runtime expands SDK surface without breaking existing API.

**TypeScript SDK (@signet/sdk)**

New exports:
- `RuntimeAdapter` interface
- `createAdapter(harness, daemonUrl?)` — factory returning a pre-wired
  client implementing each lifecycle method as a daemon API call
- `RuntimeAdapterServer` — HTTP server exposing adapter lifecycle as
  endpoints (for harnesses that prefer HTTP over library import)

**Rust SDK**

- `RuntimeAdapter` trait
- `AdapterClient` struct — pre-wired daemon HTTP client
- `RuntimeAdapterServer` — axum-based server for HTTP attachment

**Python SDK**

- `RuntimeAdapter` abstract base class
- `AdapterClient` — aiohttp-based daemon client
- `RuntimeAdapterServer` — FastAPI-based server for HTTP attachment

Any harness in any language can implement `RuntimeAdapter` using the
appropriate SDK, call the same daemon endpoints, and have full parity
with the reference runtime.


Harness Adapter Pattern
-----------------------

An adapter is a translation layer with no business logic. Example:

```typescript
// @signetai/adapter-openclaw — full implementation
import { createAdapter } from '@signet/sdk'

export default function createPlugin(opts: { daemonUrl?: string }) {
  const adapter = createAdapter('openclaw', opts.daemonUrl)

  return {
    onSessionStart:     (ctx) => adapter.onSessionStart({
      sessionKey: ctx.session.id, project: ctx.workspace
    }),
    onUserPromptSubmit: (ctx) => adapter.onUserPromptSubmit({
      sessionKey: ctx.session.id, prompt: ctx.prompt
    }),
    onSessionEnd:       (ctx) => adapter.onSessionEnd({
      sessionKey: ctx.session.id
    }),
    onPreCompaction:    (ctx) => adapter.onPreCompaction({
      sessionKey: ctx.session.id, messageCount: ctx.messages.length
    }),
    onCompactionComplete: (ctx) => adapter.onCompactionComplete({
      sessionKey: ctx.session.id, summary: ctx.summary
    }),
  }
}
```

When Signet adds a new capability, it adds a daemon endpoint and a new
`RuntimeAdapter` method. The reference runtime calls it. Each harness
adapter adds one translation. There is no harness-specific logic to reason
about or diverge.


Build Sequence
--------------

**Phase 1: scaffold + CLI channel**
- Create `packages/runtime/` with all interfaces
- Implement Anthropic provider
- Implement CLI channel (stdin/stdout, streaming)
- Wire session lifecycle to daemon API
- Add `signet chat` to CLI
- Deliverable: `signet chat` works as a native terminal session with full
  memory injection, tool use, and session continuity

**Phase 2: built-in tools + pre-generation phase**
- Implement memory tools as Tool wrappers over daemon API
- Implement pre-generation research phase in executor
- Dynamic tool registry (register/unregister at runtime)
- Deliverable: `signet chat` has native memory tools; pre-generation phase
  active

**Phase 3: HTTP channel + adapter retrofit**
- Implement HTTP channel for harness attachment
- Add `createAdapter` factory and `RuntimeAdapterServer` to TypeScript SDK
- Retrofit openclaw, claude-code, opencode connectors to use `createAdapter`
- Deliverable: all existing harnesses use the same integration path;
  new harnesses have a minimal, documented integration pattern

**Phase 4: SDK parity**
- Rust SDK: `RuntimeAdapter` trait + `AdapterClient`
- Python SDK: `RuntimeAdapter` ABC + `AdapterClient`
- Deliverable: harness in any supported language has first-class SDK support

**Phase 5: Rust runtime** (when daemon-rs reaches phase 3+)
- Rewrite `packages/runtime/` as `packages/runtime-rs/` Rust crate
- TypeScript runtime stays supported during transition
- Rust binary bundles daemon-rs + runtime-rs: single static binary
- Deliverable: `signet chat` is <10MB binary, <10ms startup, <5MB RAM


What This Is Not
----------------

- Not a replacement for the daemon. All state lives in the daemon.
  The runtime is stateless.
- Not a new memory system. Memory is still pipeline v2 + predictive scorer
  + knowledge graph, owned by the daemon.
- Not breaking for existing harnesses. OpenClaw/Claude Code/OpenCode work
  exactly as today. Phase 3 retrofit is additive and non-breaking.
- Not a config system. Config lives in agent.yaml, read by the daemon.
  The runtime reads provider/channel config from daemon API at startup.


Critical Files
--------------

New:
- `packages/runtime/src/index.ts`
- `packages/runtime/src/runtime.ts`
- `packages/runtime/src/executor.ts`
- `packages/runtime/src/context.ts`
- `packages/runtime/src/channels/cli.ts`
- `packages/runtime/src/providers/anthropic.ts`
- `packages/runtime/src/tools/memory.ts`
- `packages/sdk/src/adapter.ts`

Modified:
- `packages/cli/src/cli.ts` — add `signet chat`
- `packages/sdk/src/index.ts` — export adapter utilities
- `packages/connector-openclaw/src/index.ts` — retrofit to createAdapter
- `packages/connector-claude-code/src/index.ts` — retrofit to createAdapter
- `packages/connector-opencode/src/index.ts` — retrofit to createAdapter


Open Questions
--------------

1. **Provider config** — provider selection and model live in agent.yaml.
   Define the `runtime` config section schema before Phase 1 ships.

2. **Multi-provider routing** — route different task types to different
   providers (Haiku for tool calls, Sonnet for generation)? Defer to Phase 2
   unless the predictive scorer pre-filter needs it sooner.

3. **Streaming in adapters** — CLI channel streams via stdout. HTTP channel
   streams via SSE. Harness adapters (OpenClaw) handle their own streaming —
   the adapter only covers lifecycle hooks, not output delivery. Confirm this
   holds for all current harnesses before Phase 3.

4. **Tool sandboxing** — third-party tools run in-process by default.
   Consider subprocess sandbox for untrusted tools. Defer until there is a
   third-party tool ecosystem to sandbox.

5. **Session resume** — conversation history lives in memory during a
   session; the daemon stores checkpoints. Resume loads the last checkpoint
   as initial context. Document this behavior clearly for users before
   Phase 1 ships.


HTTP-Server-First Architecture
-------------------------------

The runtime is an HTTP server. Not a library with an optional HTTP mode —
an HTTP server that happens to ship with a CLI client attached. This is the
same pattern OpenCode uses: `opencode` is a server, the TUI is a client,
the SDK is a typed HTTP client, and the community builds additional clients
on top.

This distinction matters because it separates the runtime from any specific
interface. The runtime defines what a Signet agent session *is* — the
interface on top is whoever decides to build it.

### Server API

The runtime exposes a local HTTP API (default: localhost:7700). Endpoints:

```
POST   /session                  create a new session
GET    /session/:id              get session state
DELETE /session/:id              end a session
POST   /session/:id/prompt       send a user message, receive response
GET    /session/:id/stream       SSE stream of session events
GET    /session/:id/messages     conversation history

GET    /providers                list configured providers
GET    /providers/:id/status     provider health check

GET    /tools                    list registered tools
POST   /tools/:name              execute a tool directly

GET    /health                   runtime health + daemon connectivity
GET    /info                     runtime version, config summary
```

All endpoints use JSON. Streaming responses use SSE (text/event-stream).
The runtime binds to localhost only — not exposed to the network.

### SDK is a typed HTTP client

`@signet/sdk` grows a `RuntimeClient` that is just a typed wrapper over
the runtime HTTP API — the same relationship as OpenCode's SDK to its server:

```typescript
import { createRuntime, createRuntimeClient } from '@signet/sdk'

// Start runtime + get client (development / CLI use)
const { client, server } = await createRuntime({ port: 7700 })

// Connect to already-running runtime (harness adapters, community tools)
const client = createRuntimeClient({ baseUrl: 'http://localhost:7700' })

// Use it
const session = await client.session.create()
const response = await client.session.prompt(session.id, {
  content: 'what are we working on today?'
})
for await (const event of client.session.stream(session.id)) {
  process.stdout.write(event.content ?? '')
}
```

### What this enables

- **CLI client**: `signet chat` starts the runtime server and attaches a
  CLI client. It's not the runtime — it's a client of the runtime.
- **TUI**: a terminal UI that connects to a running runtime instance, same
  as OpenCode's TUI against its server.
- **Web UI**: a browser app connecting to the local runtime. The dashboard
  already runs on localhost — the runtime server can serve alongside it.
- **VSCode extension**: extension connects to the runtime server on a
  known port. No special integration mode needed.
- **Harness adapters**: adapters can attach as HTTP clients rather than
  importing the library. A Rust harness can attach to the TypeScript runtime
  over HTTP before the Rust runtime exists.
- **Community tooling**: anyone can build against the runtime HTTP API in
  any language. The runtime becomes a platform.

### Channel model revision

With the HTTP-server-first design, the Channel interface changes:

```typescript
// Before: channel is a direct IO interface
interface Channel {
  receive(): Promise<UserTurn>
  send(output: AgentOutput): Promise<void>
}

// After: channel is a client connection to the runtime server
interface RuntimeClient {
  // connects to POST /session/:id/prompt + GET /session/:id/stream
  prompt(sessionId: string, turn: UserTurn): Promise<void>
  stream(sessionId: string): AsyncIterable<SessionEvent>
}
```

The runtime's internal execution loop doesn't change — it still does
pre-generation → context assembly → provider call → tool dispatch → record.
What changes is the I/O boundary: user messages come in via HTTP POST, output
goes out via SSE stream. The CLI client is just readline + HTTP.

### Port convention

Runtime server: `7700` (default, configurable)
Daemon server: `3850` (existing, unchanged)

Both bind to localhost. The runtime talks to the daemon at 3850. Clients
talk to the runtime at 7700. Clean separation — the daemon is never exposed
to clients directly through the runtime.

### OpenAPI spec

The runtime generates and serves an OpenAPI spec at `GET /openapi.json`.
This enables:
- Auto-generated SDK clients in any language (the same way OpenCode's
  TypeScript SDK is generated from its OpenAPI spec)
- Community documentation
- Type-safe integrations without the official SDK

The spec is generated at build time from TypeScript types (using the same
pattern as the daemon's existing API surface).
