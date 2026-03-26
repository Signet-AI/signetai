# Signet Forge — Implementation Roadmap

Six phases from scaffold to production. All core phases complete. Phase 6 tracks future vision.

**Current version: v1.1.0** | **16+ built-in tools** | **8-crate workspace** | **Full roadmap delivered**

---

## Phase 1: Foundation ✅

- [x] 8-crate Cargo workspace (core, provider, tools, mcp, signet, agent, tui, cli)
- [x] Anthropic Messages API with SSE streaming
- [x] Signet daemon HTTP client, secret resolution, identity file loading
- [x] Session lifecycle hooks (start, prompt-submit, pre-compaction, end)
- [x] Memory recall and store via daemon API
- [x] 6 core tools (Bash, Read, Write, Edit, Glob, Grep)
- [x] Agentic loop (prompt → recall → LLM → tools → execute → loop)
- [x] Chat TUI with status bar, input handling, key bindings

---

## Phase 2: Tool Execution + Memory Integration ✅

- [x] Tool use parsing, execution, result loop-back
- [x] Permission system (auto-approve read, dialog for write, confirm for dangerous)
- [x] Permission approval dialog (Allow / Deny / Always Allow)
- [x] Context window management (auto-compact at 90%)
- [x] Markdown rendering (pulldown-cmark: headers, code blocks, bold/italic, lists, quotes)
- [x] Tool output rendering (status cards with ✓/✗/⟳ indicators)

---

## Phase 3: Multi-Provider + Model Switching ✅

- [x] 8 provider implementations: Anthropic, OpenAI, Gemini, Groq, Ollama, OpenRouter, xAI, CLI
- [x] CLI providers via PTY (portable-pty): Claude Code, Codex, Gemini — 64KB buffer, cross-platform
- [x] PTY watcher thread — drops master on child exit, prevents reader freeze
- [x] ANSI escape stripping for clean JSON parsing from CLI output
- [x] Model picker (Ctrl+O) — shows API + CLI models, daemon registry models
- [x] `/extraction-model` command — view/change Signet extraction pipeline model
- [x] Session browser (Ctrl+H) — list 20 recent sessions, resume any
- [x] Session persistence in SQLite — auto-save, `--resume`
- [x] Persistent settings (`~/.config/forge/settings.json`) — model, provider, effort, theme, bypass
- [x] CLI tool detection at startup — auto-discovers installed `claude`, `codex`, `gemini`
- [x] Config file watching (notify crate) — real-time agent.yaml reload

---

## Phase 4: MCP + Skills + Dashboard ✅

- [x] MCP stdio client with JSON-RPC 2.0 handshake
- [x] MCP tool routing — agent loop tries MCP clients as fallback for unknown tools
- [x] Skill loading from `~/.agents/skills/` — SKILL.md frontmatter → slash commands
- [x] Command palette (Ctrl+K) — fuzzy search over commands + skills
- [x] CLI tool visibility — content_block_start/delta/stop + tool_result events render as cards
- [x] Signet native tools — memory_search, memory_store, knowledge_expand, secret_exec via daemon HTTP
- [x] Dashboard panel (F2) — tabbed overlay: Memory, Pipeline, Embeddings, Health
- [x] WebSearch tool — DuckDuckGo HTML search, no API key
- [x] WebFetch tool — fetch + strip HTML to text, 50K char limit
- [x] **12 built-in tools total**

---

## Phase 5: Polish + Cross-Platform Release ✅

- [x] Cross-platform CI/CD — macOS ARM64/x64, Linux x64 (GitHub Actions)
- [x] 4 themes: signet-dark, signet-light, midnight, amber — with dedicated spinner colors
- [x] Keybind editor (Ctrl+B) — interactive overlay, saves to `~/.config/forge/keybinds.json`
- [x] Dynamic header — keybind hints update in real-time, overflow-aware for narrow terminals
- [x] Agent name display — reads `**name:**` from IDENTITY.md, shows `[Boogy]` on responses
- [x] Type-ahead input — compose while model is thinking/streaming
- [x] Expanding input box — grows with content, wraps, scrolls to cursor, snaps back on send
- [x] Tab autocomplete — predictive completion for all commands and arguments
- [x] `/forge-bypass` — toggle CLI permission bypass mid-session
- [x] `/effort` — reasoning effort with cross-session persistence
- [x] Contextual animated verbs — Thinking, Deliberating, Hypothesizing, Riddling, Constructing, Squandering, Galloping, Fiddling (~4s cycle, 8+ verbs per phase)
- [x] Chat auto-scroll — hidden buffer render for exact wrapped height measurement
- [x] Content padding — 2-line gap from header, 2-line gap before input
- [x] Terminal resize handling — Event::Resize resets scroll, hints truncate to fit
- [x] Unicode-width scroll — proper emoji/CJK display width calculations
- [x] File path detection — `/Users/...` not misidentified as slash commands
- [x] Non-interactive mode — `forge -p "prompt"` streams to stdout

---

## Phase 6: Future Vision

Stretch goals and next-generation features.

### Near-term ✅
- [x] **Error recovery** — daemon GET/POST retry on connection/timeout errors (1 retry, 500ms delay)
- [x] **Syntax highlighting** — syntect-based code block coloring (language-aware, dark/light theme)
- [x] **SSE event stream** — background log stream from `/api/logs/stream`, Logs tab in dashboard panel
- [x] **Interactive CLI prompts** — PTY write-back, approval pattern detection, auto-respond with bypass ON, TUI dialog for manual approval
- [x] **Session import** — `/import-claude` parses Claude Code JSONL conversations from `~/.claude/projects/`, maps roles/content types

### Medium-term ✅
- [x] **Multi-agent support** — `agent_id` threading on all daemon GET/POST, `--agent <name>` CLI flag, per-agent identity files from `~/.agents/agents/{name}/`, `/agent` command
- [x] **Sub-agent tool** — SubAgent spawns restricted provider call for research tasks, 60s timeout, read-only system prompt
- [x] **Marketplace MCP proxy** — MarketplaceTool proxies calls to daemon marketplace endpoint, tools discovered at startup
- [x] **External MCP config** — `~/.config/forge/mcp.json` for arbitrary MCP servers, McpStdioClient per entry, tools merged into agent loop
- [x] **Installer script** — `install.sh` with OS/arch detection, GitHub release download, PATH check

### Long-term ✅
- [x] **Multi-tab sessions** — Tab struct refactor, Ctrl+T/W/Right/Left, tab bar, background processing on all tabs
- [x] **Image display** — half-block ANSI art (▄ with fg/bg colors), works in ALL terminals, PNG support
- [x] **Voice input** — fully local via whisper-rs + cpal, Metal GPU on Apple Silicon, 142MB model auto-download, interim transcription every ~2s
- [x] **Agent-to-agent** — presence heartbeat, /peers /send /inbox commands, 3 native tools, SSE message listener
- [x] **Remote sessions** — works natively via SSH (Forge is a TUI)
- [x] **Plugin system** — executable plugins from ~/.config/forge/plugins/, --manifest discovery, --execute protocol

---

## Crate Dependency Graph

```
forge-cli
  ├── forge-tui
  │     ├── forge-agent
  │     │     ├── forge-provider (+ portable-pty)
  │     │     │     └── forge-core
  │     │     ├── forge-tools (+ reqwest, urlencoding)
  │     │     │     └── forge-core
  │     │     ├── forge-mcp
  │     │     │     └── forge-core
  │     │     └── forge-signet
  │     │           └── forge-core
  │     ├── forge-provider
  │     └── forge-signet
  └── forge-signet
```

Each crate is independently testable. `forge-core` has zero external runtime dependencies beyond serde.
