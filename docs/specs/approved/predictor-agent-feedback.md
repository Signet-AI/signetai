# Agent Relevance Feedback -- Spec Addendum

**Parent spec**: `predictive-memory-scorer.md`
**Status**: Draft
**Priority**: P0 (training signal quality)

## Problem

The predictive memory scorer needs ground-truth relevance signals to
train effectively. Current signals are second-order:

1. **Continuity scorer** -- LLM judge at session end, guessing what
   helped. A model interpreting another model's behavior.
2. **FTS overlap** -- keyword matching between user prompts and
   injected memories. First-order but shallow -- catches explicit
   references, misses memories that shaped reasoning without being
   directly referenced.

Neither captures what the agent actually experienced: which memories
changed how it responded. The agent knows. We just need to ask.

Without this signal, the predictor trains on weak proxies and risks
misalignment before it ever converges.

## Design

### Core Mechanism

On every `userPromptSubmit` hook cycle, the daemon asks the agent to
rate the injected memories. The agent responds with lightweight
relevance scores. These accumulate across the session and become the
primary training label at session end.

### Hook Integration

The `userPromptSubmit` hook already injects context (memories,
working memory) into the agent's context window. We extend this with
a structured feedback request.

**Request** (appended to hook inject string):

```
<memory-feedback>
Rate how useful each injected memory was for your last response.
Respond with ONLY a JSON object mapping memory IDs to scores.
Scale: -1 (actively harmful/misleading) to 1 (directly shaped response).
0 = present but not used. Omit memories you can't evaluate.
Example: {"mem_abc": 0.8, "mem_def": -0.2, "mem_ghi": 0}
</memory-feedback>
```

**Response** (agent returns in hook response payload):

```json
{
  "memory_feedback": {
    "mem_abc123": 0.9,
    "mem_def456": 0.0,
    "mem_ghi789": 0.6
  }
}
```

The daemon parses this from the hook response. If the agent doesn't
include it (older harness, non-supporting model), the field is simply
absent -- fail-open.

### Data Storage

New column on `session_memories`:

```sql
ALTER TABLE session_memories
  ADD COLUMN agent_relevance_score REAL;
  -- NULL = no feedback received
  -- Accumulated: mean of all per-prompt scores for this memory
```

Per-prompt feedback is accumulated across the session:

```typescript
// On each userPromptSubmit with feedback:
for (const [memoryId, score] of Object.entries(feedback)) {
  // Running mean: (existing_sum + score) / (existing_count + 1)
  updateSessionMemory(sessionKey, memoryId, score);
}
```

Additional column for count:

```sql
ALTER TABLE session_memories
  ADD COLUMN agent_feedback_count INTEGER DEFAULT 0;
```

### Label Construction (modified)

Agent feedback becomes the primary training signal when available.
The hierarchy:

1. **Agent relevance score** (primary, when available)
   - Direct ground truth from the agent that used the memory
   - 10-20 data points per session per memory (one per prompt)
   - Replaces continuity scorer as primary label

2. **FTS overlap** (secondary, always available)
   - Behavioral confirmation/contradiction
   - Used to adjust agent scores or fill gaps:
     - Memory scored 0 by agent but matched by FTS 2x: bump to 0.3
       (agent may not have noticed its influence)
     - Memory scored 0.8 by agent but never FTS-matched: keep 0.8
       (agent reasoning doesn't require explicit reference)

3. **Continuity scorer** (tertiary, session-level)
   - Session-level quality signal
   - Scales agent scores: high continuity score = trust agent
     feedback more; low = discount slightly
   - Fallback when agent feedback unavailable

**Combined label**:

```
if agent_relevance_score is not null:
  label = agent_relevance_score * 0.7
        + fts_adjustment * 0.2
        + continuity_modifier * 0.1
else:
  // Existing path: continuity + FTS (no change)
  label = continuity_label + fts_adjustment
```

### Signal Properties

| Signal | Order | Frequency | Coverage | Reliability |
|--------|-------|-----------|----------|-------------|
| Agent feedback | 1st (direct) | Per-prompt (10-20/session) | Injected memories only | High -- agent knows |
| FTS overlap | 1st (behavioral) | Per-prompt | All memories (injected + missed) | Medium -- keyword-limited |
| Continuity scorer | 2nd (inferred) | Per-session | All memories | Lower -- model judging model |

### Harness Support

Each connector needs to:
1. Include the `<memory-feedback>` block in `userPromptSubmit` inject
2. Parse `memory_feedback` from the hook response
3. Forward scores to daemon API

**Claude Code**: `userPromptSubmit` hook already returns structured
data. Add `memory_feedback` as optional field in response.

**OpenCode**: Plugin `userPromptSubmit` handler can include feedback
request in system prompt injection.

**OpenClaw**: Runtime plugin handles hook lifecycle, same pattern.

Connectors that don't support it yet simply don't send the field.
The daemon handles absence gracefully (null scores, existing label
path).

### Latency Considerations

- Feedback request adds ~50 tokens to the inject string
- Agent response adds ~20-50 tokens (just a JSON object)
- No additional LLM calls -- the agent rates memories as part of
  its normal response cycle
- Parsing is trivial -- JSON.parse on a small object
- DB writes are batched with existing session_memories updates

### Cold Start Interaction

During predictor cold start (alpha=1.0), agent feedback still
accumulates. This is valuable because:
- Training data builds up before the predictor is active
- When cold start exits, the predictor has real ground truth
  to train on, not just continuity scorer guesses
- Faster convergence on first training run

### Privacy / Safety

- Feedback stays local (daemon SQLite, never sent externally)
- Agent sees only memory IDs it was already given
- Scores are numerical, no content duplication
- User can disable via config: `predictor.agentFeedback: false`

### Training Telemetry Opt-In

Anonymized training pairs (feature vectors + labels, NO content) can
be collected locally for eventual upstream contribution to a shared
base model. Opt-in is handled conversationally by the agent:

**State machine**:
- `telemetry.trainingDataOptIn`: `null` (unasked) | `true` | `false`
- `telemetry.lastPromptedAt`: ISO timestamp
- `telemetry.installDate`: set on first daemon startup

**Prompt schedule**:
- Only when `optIn === null` (never asked or no answer yet)
- At most once per 24 hours
- Only during the first 7 days after install
- Injected into session-start hook as a one-time block
- After 7 days with no answer, defaults to `false` silently

**Agent prompt** (injected into session start):
```
<signet-telemetry-prompt>
At a natural moment early in this session, ask the user if they'd
like to opt in to anonymous training telemetry. Signet collects
only numerical feature vectors and relevance scores (never memory
content) to train a shared memory relevance model that ships with
future updates. This makes memory better for everyone. Users can
opt out anytime via `signet telemetry off`. If they decline,
respect it and don't mention it again.
</signet-telemetry-prompt>
```

**User response handling**:
- Agent calls `POST /api/telemetry/opt-in` with `{ enabled: bool }`
- Or user runs `signet telemetry on` / `signet telemetry off`
- Either path sets `trainingDataOptIn` permanently
- `false` is respected permanently -- no re-prompting, ever

**What is NOT collected**:
- Memory text content
- User prompts or agent responses
- File paths or project names
- Any personally identifiable information

**What IS collected** (when opted in):
- Numerical feature vectors (recency, importance, decay, etc.)
- Numerical relevance labels (agent score, FTS score, continuity)
- Structural metadata (was_injected, rank positions)
- Session-level aggregate stats (candidate count, injection count)

## Migration

```sql
ALTER TABLE session_memories
  ADD COLUMN agent_relevance_score REAL;
ALTER TABLE session_memories
  ADD COLUMN agent_feedback_count INTEGER DEFAULT 0;
```

## Config

```yaml
pipelineV2:
  predictor:
    agentFeedback: true          # Enable agent relevance feedback
    feedbackWeight: 0.7          # Weight of agent feedback in label
    ftsWeight: 0.2               # Weight of FTS adjustment
    continuityWeight: 0.1        # Weight of continuity modifier
```

## Implementation Order

1. Migration: add columns to session_memories
2. Daemon: parse feedback from userPromptSubmit hook response
3. Daemon: accumulate scores in session_memories
4. Daemon: modified label construction in summary-worker
5. Connectors: add feedback request to inject strings
6. Training: pass combined labels to predictor sidecar

## Open Questions

- Should the feedback request be every prompt or every Nth prompt
  to reduce token overhead? (Probably every prompt -- 50 tokens is
  negligible compared to the memory inject itself)
- Should we weight early-session feedback differently from
  late-session? (Early feedback may be less informed since the
  agent hasn't used the memories yet)
- Negative scores (actively harmful memories) -- should these
  trigger immediate removal from context on next prompt?
