# Agent Loop Comparison: Forge, Codex, Hermes

Comparative analysis of agentic loop architectures across three harnesses,
identifying best-of-breed patterns to inform Forge's evolution.

**Harnesses analyzed:**
- **Forge** (Rust, ~1,400 LOC across 6 modules) -- Signet's native terminal client
- **Codex** (Rust, multi-crate workspace) -- OpenAI's CLI agent
- **Hermes** (Python, ~7,500+ LOC in run_agent.py alone) -- RL-oriented research agent

**Date:** 2026-03-27

---

## 1. Core Loop Structure

All three share the same fundamental skeleton:

```
user input -> build prompt -> call LLM -> stream response
    -> tool calls? -> execute tools -> append results -> loop back
    -> no tool calls? -> turn complete
```

The differences lie in how each harness handles the transitions, failures,
and resource constraints within that skeleton.

### Forge

Entry point: `agent_loop.rs:process_message()` (~575 lines).

A single `loop {}` that calls the provider, streams the response, collects
tool calls, executes them sequentially, appends results, and loops. Exits
when the model responds without tool calls, or on error/loop detection.
Memory recall and provider preconnect run in parallel via `tokio::join!`
on the first pass, then memory context is cleared for subsequent iterations.

Clean, linear, easy to reason about.

### Codex

Entry point: `codex.rs:run_turn()` with an outer `submission_loop`.

The loop is embedded in a larger task/submission architecture. `RegularTask`
wraps turns in a task context, and a submission loop dispatches user input,
exec approvals, and user answers as separate `Op` variants. Pre-sampling
compaction runs before the LLM call; post-sampling compaction runs after
heavy tool use. Pending user input queued during model execution is consumed
on the next iteration.

More ceremony, but handles concurrent user interaction gracefully.

### Hermes

Entry point: `run_agent.py:run_conversation()` (~7,500+ lines).

The most feature-dense loop. Bounded by both `max_iterations` (default 90)
and a shared `iteration_budget` that subagents draw from. Includes preflight
compression, Honcho context injection, prompt caching for Claude models via
OpenRouter, and turn-based skill/memory nudge triggers. The loop body handles
tool validation, deduplication, parallel dispatch decisions, and categorized
error recovery, all inline.

Powerful but dense. The single-file approach makes it hard to isolate concerns.

---

## 2. Context Window Management

This is where the harnesses diverge most significantly.

### Forge (Reactive, Simple)

- **Trigger:** estimated tokens > 90% of context window
- **Estimation:** `text_length / 4` heuristic (no tokenizer)
- **Strategy:** keep last 2 messages, summarize everything older via LLM
- **Failure mode:** log warning, continue without compaction
- **Timing:** checked at end of turn (when no tool calls remain)

Pros: simple, predictable, low overhead.
Cons: reactive only, so a single heavy tool response could blow the window
before compaction runs. no proactive check before the LLM call.

### Codex (Dual-Pass, Proactive)

- **Pre-sampling compact:** runs BEFORE the LLM call if approaching limits
- **Post-sampling compact:** runs AFTER if token usage exceeds `auto_compact_limit` and follow-up is needed
- **Model switch detection:** reinjects context when model/window size changes mid-session
- **History reinjection:** rebuilds prompt when `previous_turn_settings` differ

Pros: proactive compaction prevents wasted LLM calls on oversized prompts.
model switch handling is a real-world concern most harnesses ignore.
Cons: more complex state tracking.

### Hermes (Adaptive, Resilient)

- **Trigger:** ~80% of discovered context threshold
- **Discovery:** parses error messages to detect actual limits, probes smaller tiers, caches results to `~/.hermes/context_lengths.json`
- **Strategy:** iterative compression that updates previous summaries to avoid info loss, protects head and tail messages
- **Retries:** up to 3 compression attempts per conversation
- **Auxiliary LLM:** uses a cheap/fast model for summarization (doesn't burn primary model tokens)

Pros: adapts to unknown models without hardcoded limits. iterative summary
updates preserve more context than single-pass summarization. separate
summarization model is cost-efficient.
Cons: error-message parsing for limit detection is fragile.

### Best Approach

Combine Codex's **proactive pre-sampling check** with Hermes' **iterative
compression** and **auxiliary model for summarization**. The pre-sampling
check prevents wasted calls; iterative compression preserves more signal;
and a cheap summarization model keeps costs down.

Forge's current reactive-only approach is the most significant gap.

---

## 3. Tool Execution

### Forge (Sequential, Interactive)

Tools execute one at a time in a `for` loop. Each tool gets its own
permission check and TUI progress update. Results are batched into a
single message after all tools complete.

Pros: simple, debuggable, great UX for interactive use. per-tool permission
prompts are natural.
Cons: serial execution of independent read-only tools is unnecessary latency.

### Codex (Parallel, Coordinated)

`ToolCallRuntime` coordinates concurrent execution of multiple tool calls
from a single LLM response. Results collected and streamed back as a batch.
Sandbox denial triggers retry without sandbox if policy permits.

Pros: significant throughput improvement when the model requests multiple
independent operations (common with read/grep/glob batches).
Cons: parallel execution complicates error attribution and permission flow.

### Hermes (Conditional Parallel)

`_should_parallelize_tool_batch()` analyzes the batch to determine safety:
- Read-only tools (read_file, search_files, web_search) always parallelize
- File tools parallelize when targeting independent paths
- Interactive tools (terminal, browser) always sequential
- Falls back to sequential for anything with side effects

Thread pool with configurable workers. Deduplicates identical tool calls
before execution. Caps `delegate_task` calls to prevent agent-stack explosion.

Pros: best of both worlds. gets parallel throughput where safe, sequential
correctness where needed. deduplication catches a real failure mode.
Cons: the safety analysis adds complexity and can be wrong for edge cases.

### Best Approach

Hermes' **conditional parallelism** is the right model. Forge should
parallelize read-only tool batches (read, grep, glob, websearch, webfetch)
while keeping write/bash/edit sequential. This captures most of the
throughput benefit with minimal risk.

Tool call **deduplication** before execution is also worth adopting. models
sometimes emit identical calls in the same response.

---

## 4. Error Handling and Retry Strategy

### Forge (Fail Fast)

- Provider errors terminate the turn immediately
- Loop detection (3 identical tool calls) is the primary safety valve
- Tool JSON parse failures get empty-object fallbacks
- No retry on LLM failures
- No fallback models

Pros: predictable, no hidden retry loops burning tokens.
Cons: a single transient 500 from the provider kills the entire turn.
the user has to manually retry.

### Codex (Targeted Recovery)

- **Sandbox denial:** retry without sandbox if policy allows
- **Invalid image:** sanitize and retry
- **Approval caching:** similar commands reuse cached decisions
- **Turn abort:** clean shutdown on user interrupt
- Network proxy failures trigger auth refresh with 10s timeout

Pros: handles the most common real-world failure modes. approval caching
reduces friction without reducing safety.
Cons: doesn't address transient provider failures.

### Hermes (Categorized, Exhaustive)

Errors are bucketed into distinct categories with tailored recovery:

| Category | Strategy | Backoff |
|----------|----------|---------|
| Rate limit / empty response | Extended backoff, eager model fallback | 5s, 10s, 20s, 40s, 80s, 120s |
| Context length exceeded | Trigger compression, retry up to 3x | Immediate |
| Client errors (4xx) | Try fallback model, then give up with diagnostics | None |
| Transient errors (5xx, timeout) | Exponential backoff with interrupt check | 2s, 4s, 8s, 16s, 32s, 60s |
| Invalid tool calls | Return error to model for self-correction (3x) | Immediate |
| Length truncation | Request continuation (3x), rollback if unrecoverable | Immediate |
| Incomplete scratchpad | Retry up to 2x | Immediate |

Fallback model system: on repeated failures, switches to a secondary model,
resets retry counter.

Pros: remarkably resilient. handles every failure mode the real world throws
at a multi-provider agent. the fallback model system is genuinely useful for
production reliability.
Cons: the complexity is substantial. 7,500 lines in a single file is partly
because of this exhaustive error handling.

### Best Approach

Forge should adopt a **tiered retry strategy** without going full Hermes:

1. **Transient errors (5xx, timeouts):** exponential backoff, 3 retries max.
   this alone would fix the most common pain point.
2. **Rate limits (429):** longer backoff with a budget cap.
3. **Invalid tool calls:** return the error to the model for self-correction
   (up to 3 attempts). models are good at fixing their own tool call JSON
   when told what went wrong.
4. **Context overflow:** trigger compaction and retry once.

Fallback models are worth considering but add provider-management complexity
that may not justify itself yet.

---

## 5. Permission Systems

### Forge (Three-Tier Interactive)

Three levels: ReadOnly (auto-approve), Write (check approval list or prompt),
Dangerous (always prompt). Approvals are session-scoped via `Arc<Mutex<>>`.
The TUI can modify approval state mid-turn.

### Codex (Policy-Based Sandboxing)

Four sandbox levels: ReadOnly, WorkspaceWrite, DangerFullAccess,
ExternalSandbox. Approval decisions cached by command hash, so similar
commands reuse prior decisions. Network requests audited separately via
`NetworkApprovalService`.

### Hermes (Task-Scoped Isolation)

Each tool call gets a unique `task_id` for terminal/browser isolation.
Parallel tools run in isolated threads. Resource cleanup on conversation end.
Less about explicit permission prompts, more about execution isolation.

### Best Approach

Forge's interactive model is the right fit for a terminal client. The
improvement worth borrowing from Codex is **approval caching by command
hash**. If the user approves `bash: bun test`, subsequent `bash: bun test`
calls in the same session shouldn't re-prompt. Forge already has
session-scoped "always allow" per tool name, but command-level granularity
would reduce friction for repetitive workflows.

---

## 6. Streaming and Backpressure

### Forge

Simple channel send from agent loop to TUI. No explicit backpressure
handling. Tool detail extraction (file paths, commands, patterns) provides
rich TUI context. Path shortening shows last 2 segments.

### Codex

Bounded channels (8192 capacity). Critical events (`TurnCompleted`) use
blocking sends for guaranteed delivery. Non-critical notifications dropped
with warning on queue saturation. Dual `tokio::select!` architecture
multiplexes client requests and server events.

### Hermes

90s stale-stream detection, 60s read timeout. Reconstructs tool calls from
streamed JSON fragments. Always prefers streaming even without consumers for
health checking purposes.

### Best Approach

Forge should adopt **bounded channels with priority delivery** from Codex.
`TurnComplete` and error events should never be dropped. Hermes' **stale
stream detection** is also worth considering: if no tokens arrive for 90s,
something is wrong, and the user should know rather than staring at a
frozen screen.

---

## 7. Unique Strengths Worth Noting

### Forge

- **Runtime-configurable effort and bypass** via shared `Arc<Mutex<>>`. the
  TUI can change reasoning effort mid-turn without interrupting the loop.
  neither reference harness does this.
- **Cached tool definitions** computed once at init. small optimization but
  it matters when the tool registry is large.
- **Signet-native integration** for memory, identity, secrets, skills, and
  MCP. the daemon communication layer is clean and purpose-built.

### Codex

- **Model switch detection** with context reinjection. if the user changes
  models mid-session, Codex detects the window size change and rebuilds the
  prompt accordingly. this is a real-world edge case that causes silent
  failures in other harnesses.
- **Pending input queue** for messages submitted during model execution.
  the submission loop consumes them on the next iteration rather than
  dropping or blocking.
- **Hook system** with pre-turn, user-prompt, stop, and after-agent hooks.
  stop hooks can intercept model completion and inject continuation prompts.

### Hermes

- **Prompt caching for Anthropic models** via OpenRouter. auto-injects
  cache_control breakpoints on system prompt and last 3 messages. reports
  hit rate. reduces input tokens by ~75% on multi-turn conversations.
- **Fallback model system** that switches providers on repeated failures.
  genuine production resilience.
- **Dynamic context limit discovery** that adapts to unknown models.
  especially useful for open-source models with undocumented context windows.
- **Tool call deduplication and delegate_task capping** to prevent runaway
  subagent spawning.

---

## 8. Recommendations for Forge

Ordered by impact relative to implementation cost.

### High Impact, Moderate Effort

1. **Proactive context compaction.** Check token estimate before the LLM call,
   not just after. Prevents wasted calls on oversized prompts. Codex does
   this and it's the single most effective context management improvement.

2. **Tiered retry with exponential backoff.** Three retries for transient
   5xx/timeout errors, with 2s/4s/8s backoff. Covers the most common failure
   mode (provider hiccups) without adding significant complexity.

3. **Conditional parallel tool execution.** Parallelize read-only tool
   batches (read, grep, glob, websearch, webfetch). Keep write/bash/edit
   sequential. Biggest throughput win for common workflows where the model
   requests multiple file reads.

### Medium Impact, Low Effort

4. **Stale stream detection.** If no tokens arrive for N seconds (60-90s),
   surface a warning in the TUI. Users shouldn't have to guess whether the
   model is thinking or the connection died.

5. **Tool call deduplication.** Before executing a batch, deduplicate by
   (name, input) hash. Models sometimes emit identical calls. Cheap to
   implement, prevents wasted work.

6. **Invalid tool call self-correction.** Instead of falling back to an
   empty object on JSON parse failure, return the error to the model with
   the schema it should have used. Models are good at fixing this. Cap at
   3 retries.

### Lower Priority, Higher Effort

7. **Approval caching by command hash.** Cache permission decisions for
   specific commands within a session, not just by tool name. Reduces
   friction for repetitive workflows.

8. **Bounded event channels with priority delivery.** Guarantee delivery of
   critical events (TurnComplete, errors) even under backpressure.

9. **Auxiliary model for summarization.** Use a cheap/fast model for context
   compaction instead of the primary model. Cost optimization for long
   sessions.

10. **Model switch detection.** Detect when the user changes models
    mid-session and adjust context window expectations accordingly.

---

## Appendix: Architecture Comparison

| Dimension | Forge | Codex | Hermes |
|-----------|-------|-------|--------|
| Language | Rust | Rust | Python |
| Loop LOC | ~575 | ~1,500+ | ~7,500+ |
| Tool execution | Sequential | Parallel | Conditional parallel |
| Context compaction | Reactive (90%) | Dual-pass (pre+post) | Adaptive (80%, iterative) |
| Token estimation | text/4 heuristic | Token counter | Token counter + error parsing |
| Retry strategy | None (fail fast) | Targeted (sandbox, images) | Categorized (6+ categories) |
| Permission model | 3-tier interactive | Policy + sandbox + cache | Task-scoped isolation |
| Streaming backpressure | None | Bounded channels | Timeout detection |
| Parallel tool exec | No | Yes | Conditional |
| Fallback models | No | No | Yes |
| Loop detection | Hash-based (3x) | No | No |
| Context limit discovery | Hardcoded | Hardcoded | Dynamic (error parsing) |
| Prompt caching | No | No | Yes (Anthropic via OpenRouter) |
| Model switch handling | No | Yes | No |
