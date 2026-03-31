# Forge LLM Performance Roadmap

## Goal

Improve Forge runtime quality across three dimensions:

1. Token usage efficiency
2. Response time (TTFT + turn completion)
3. Loading/startup time

---

## 1) Token Usage Optimization

### Phase 1 (current wave)

- Add per-turn token guardrails for tool reinjection:
  - cap tool output injected back into the model loop
  - annotate truncation so the model can request narrower follow-up
- Keep cacheability high:
  - preserve stable system/context structure across calls
- Avoid avoidable reinjection bloat:
  - dedupe/trim repeated context blocks where safe

### Phase 2

- Adaptive context tiers (hot/warm/cold by remaining budget)
- Structured compaction artifacts over raw transcript chunks
- Tool-result compression policy for verbose outputs

### Phase 3

- Budget-aware planner (short/normal/deep)
- Provider/model-specific tokenizer accounting
- Telemetry-driven threshold auto-tuning
  - Status: implemented in `forge-agent` (PR #424)

---

## 2) Response Time Optimization

### Phase 1 (current wave)

- Expand overlap in hot path where possible
- Reduce tool-loop latency:
  - process read-only tool completions as they finish
- Fast-fail invalid tool calls with corrective guidance

### Phase 2

- Priority scheduling for blocking/non-blocking tool classes
- More consistent streaming-first status signaling
- Adaptive timeout tiers by operation class

### Phase 3

- Latency-aware model routing
- Optional provider hedging for first-token speed
- Continuous p50/p95 threshold tuning
  - Status: p95-aware adaptive tuning implemented; provider hedging remains future

---

## 3) Loading Time Optimization

### Phase 1 (current wave)

- Defer non-critical startup work
- Parallelize independent daemon fetches
- Add short startup timeouts for optional metrics

### Phase 2

- Persistent provider session pools / warm reuse
- Incremental model registry hydration
- Agent workspace hot index

### Phase 3

- Prelaunch warmers (optional service mode)
- Snapshot/restore recent runtime state
- Startup SLO tracking with CI regression gates
  - Status: startup SLO gate is future; this phase focused on runtime adaptive loop tuning
