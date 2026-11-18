---
title: "Sessions and hooks API"
description: "Harness hook and session lifecycle endpoints."
---

Harness hook and session lifecycle endpoints.

[Back to HTTP API overview](/api/).

## Hooks

Hook endpoints integrate with AI harness session lifecycle events. They are
used by connector packages to inject memory context and extract new memories.

The `x-signet-runtime-path` request header (or `runtimePath` body field)
declares whether the caller is the `plugin` or `legacy` runtime path. The
daemon enforces that only one path can be active per session — subsequent
calls from the other path return `409`.

Hooks that claim, renew, or end a session require `remember` permission:
`session-start`, `user-prompt-submit`, `session-end`,
`session-checkpoint-extract`, `pre-compaction`, and `compaction-complete`.
Before claiming or updating a session, they check that it is not held by
another agent and that its project, and any `project` in the request, is within
the credential's scope. A session key claimed only by other agents is
rejected. If a project-limited credential targets a session with no live
presence, for example after a daemon restart or claim expiry, the project comes
from the stored transcript. A session with a claim but no stored transcript is
rejected. A
failed check returns `403` without changing the session.

### POST /api/hooks/session-start

Called at the beginning of a session. Returns bounded Session Continuity previews,
identity, and context for injection into the harness system prompt. Requires
`remember` permission (via hook routing).

**Request body**

```json
{
  "harness": "claude-code",
  "project": "/workspace/repo",
  "agentId": "optional-signet-agent-id",
  "harnessAgentId": "optional-harness-subagent-id",
  "parentSessionKey": "optional-parent-session-key",
  "sessionKey": "session-uuid",
  "runtimePath": "plugin",
  "claimOnly": false
}
```

`harness` is required. `agentId` is the Signet persistence scope. First-seen
named agent IDs are registered in the `agents` table with `read_policy` set to
`isolated`, the same default as `POST /api/agents`; existing agent policy rows
are preserved. Granting `shared` or `group` access is an explicit operator
action (`signet agent set` or `PATCH /api/agents/:name`).
Harness native sub-agent identifiers, such as Claude Code's `agent_id`, must be
sent as `harnessAgentId`; they are lineage hints and are not used for Signet data
scoping. `parentSessionKey` may be provided when the harness exposes explicit
lineage. If it is absent, Signet infers parent context where possible from
harness-native signals such as OpenClaw lineage session keys or recent Claude
Code parent activity in the same project.

Set `claimOnly: true` only when recovering an already-running harness session
after a daemon restart. It requires a `plugin` or `legacy` runtime path in
`x-signet-runtime-path` or `runtimePath`; requests without one return `400`.
The daemon renews the runtime-path claim and returns `{ "sessionKnown": true }`
without rebuilding or returning startup context. The caller must not inject
startup memory or identity into an existing conversation: its original
session-start context is already in the system prompt, and changing it
mid-conversation invalidates prompt caching.

**Response** — ordinary starts return the implementation-defined context object
from `handleSessionStart`; claim-only recovery returns only
`{ "sessionKnown": true }`.

For ordinary starts, `memories` contains the records that survived final
Session Continuity rendering. Each item includes its full `id`, bounded
`content`, `type`, `importance`, `created_at`, tags/project, source metadata,
and a `truncated` flag. The model-facing `dynamicContext` labels these records
as historical reference material, not instructions. A truncated record retains
its full ID and can be retrieved with the `memory_get` MCP tool or
`GET /api/memory/:id`; records omitted by the configured limits are not reported
as delivered.

### POST /api/hooks/user-prompt-submit

Called on each user message. Returns compact entity current-view context only
when the prompt mentions a known ontology entity or active alias and at least
one current attribute clears the confidence gate. The entity mention scopes the
search; attribute relevance chooses which aspect context to inject.

**Request body**

```json
{
  "harness": "claude-code",
  "userMessage": "How do I set up dark mode?",
  "userPrompt": "How do I set up dark mode?",
  "lastAssistantMessage": "Earlier we discussed using CSS variables for theme tokens.",
  "sessionKey": "session-uuid",
  "transcriptPath": "/tmp/signet/session-transcript.txt",
  "runtimePath": "plugin"
}
```

`harness` is required.
`userMessage` is preferred when the harness can provide a cleaned user turn.
`userPrompt`, `lastAssistantMessage`, `transcriptPath`, and inline `transcript`
are optional.

Prompt-submit runs recall only after a direct entity hit and has no fallback
injection. A prompt that names a known person or project triggers the normal
daemon recall with the prompt as the query; results that clear
`hooks.userPromptSubmit.minScore` are injected once per session context epoch
and then claimed in the session recall dedupe ledger, so repeat prompts do not
re-inject them. Low-signal prompts are admitted before
automatic recall work, so they skip entity matching and recall while preserving
session bookkeeping and the stable per-prompt context contract (an empty
`inject`). Explicit recall is still available through `/api/memory/recall` and
MCP/CLI recall tools, including for the same prompt. Unknown entities,
ambiguous entity mentions, and prompts whose recall results do not clear
`hooks.userPromptSubmit.minScore` return `inject: ""`.
Raw transcript search is not injected on prompt-submit; use the dedicated
`session_search` MCP/API surface when a caller needs transcript evidence.

A normal successful response includes a separate dynamic clock field:

```json
{
  "clockContext": "Current date/time: 2026-08-16T14:35:00-06:00 (America/Denver)",
  "dynamicContext": "",
  "inject": "",
  "memoryCount": 0,
  "engine": "no-entity"
}
```

`clockContext` is computed once at prompt handling start and uses the daemon's
resolved IANA timezone with an explicit UTC offset. It is delivered through the
harness's hidden/provider-bound per-turn path. It is not included in the
cache-stable `<signet-memory-context>` envelope or `contextHash`, so a clock-only
change does not invalidate memory-context replay. Bypassed, internal, duplicate,
and other no-op responses retain their existing no-context shape.

Under sustained concurrency (many harnesses submitting at once), the daemon
caps in-flight prompt-submit work: once more than 8 submissions are processing
concurrently, the hook returns `503` with a `Retry shortly` error instead of
queueing indefinitely. Callers should treat `503` as backpressure and retry
with backoff.

### POST /api/hooks/stop

Called when the agent finishes a turn. Appends the turn's final assistant reply
to the session's live transcript: the canonical JSONL transcript first, then the
`session_transcripts` row. Requires `remember` permission (via hook routing).

**Request body**

```json
{
  "harness": "claude-code",
  "sessionKey": "session-uuid",
  "agentId": "optional-signet-agent-id",
  "cwd": "/workspace/repo",
  "lastAssistantMessage": "I've finished the refactor. The tests pass.",
  "runtimePath": "legacy"
}
```

`harness` and `sessionKey` are required; `sessionId` is accepted as an alias for
`sessionKey`. An empty `lastAssistantMessage` records nothing. `cwd` sets the
transcript's project. `agentId` follows the same scope and session-binding
rules as the other hooks.

**Response**: `{ "recorded": true }` confirms the reply's canonical evidence
has been synced. Newly appended evidence also updates the `session_transcripts`
projection before returning success. Consecutive retries are deduplicated by
whole structured records within a bounded transcript tail and skip the
projection append. If evidence committed before an earlier projection failure,
a retry can therefore succeed while the row still lacks the turn; a warning
names the session without content. Source capture does not currently rebuild
that row from canonical records. A retry after a new turn, or after other
sessions write beyond that tail, can append duplicate evidence; this is not an
exactly-once API. The daemon skips the write and returns `recorded: false` with
`skipped: true` when a claimed session has a different, missing, or invalid
runtime path (`duplicateRuntimePath`, `claimedBy`) or the session has ended
(`sessionEnded`), and with `bypassed: true` when the session is bypassed.

**Errors**

- `400`: missing `harness` or `sessionKey`, or a non-string `lastAssistantMessage`.
- `403`: an agent scope, project scope, or session-binding violation. A
  project-restricted token must match both `cwd` and the stored transcript's
  project. An omitted `cwd` uses the token's project.
- `413`: `lastAssistantMessage` longer than 262,144 characters, or an encoded
  request body larger than 2 MiB. Admission precedes body buffering.
- `503`: more than 8 stop calls in flight (`Retry-After: 1`), or database write
  pressure (`retryable: true` and a `Retry-After` header).

### POST /api/hooks/session-end

Called at session end. Captures immutable episodic transcript evidence for
later summary and Dreaming work; it does not save the raw transcript as a
retrieval memory.
Releases the session's runtime path claim.

**Request body**

```json
{
  "harness": "claude-code",
  "sessionKey": "session-uuid",
  "sessionId": "session-uuid",
  "transcriptPath": "/tmp/signet/session-transcript.txt",
  "capturedAt": "2026-08-03T20:00:00.000Z",
  "runtimePath": "plugin"
}
```

`harness` is required.
`transcriptPath` or inline `transcript` may be provided for transcript
capture. `capturedAt` is optional for live hooks; importers should supply the
original ISO-8601 event time so temporal reasoning retains source chronology.
Signet stores a cleaned conversation-only transcript as episodic evidence and
may retain raw auditable traces separately in daemon logs.

When transcript text is available, the daemon queues a capture receipt and
then writes the canonical conversation transcript as JSONL at
`$SIGNET_WORKSPACE/transcripts/{harness}/transcript.jsonl` and records
lineage through the session manifest. Existing markdown transcript artifacts
remain readable for backward compatibility and are backfilled into the JSONL
history.

The session-end marker completes the canonical transcript row. Dreaming reads
that completed row through a sanitized, read-time projection: tool calls remain
as markers, tool outputs are excluded, and the retained transcript is not
rewritten. There is no summary-worker job or generated session-summary artifact
in this path. The response includes `transcriptCaptureJobId` when transcript
capture was queued. Poll `GET /api/hooks/transcript-capture/:jobId?agentId=<agent>`
until the status is `completed`; the receipt never exposes transcript content.

### POST /api/hooks/remember

Explicit memory save from within a session. Requires `remember` permission.

**Request body**

```json
{
  "harness": "claude-code",
  "content": "User wants dark mode by default",
  "sessionKey": "session-uuid",
  "runtimePath": "plugin"
}
```

`harness` and `content` are required.

### POST /api/hooks/recall

Explicit memory query from within a session. Requires `recall` permission.

**Request body**

```json
{
  "harness": "claude-code",
  "query": "user UI preferences",
  "keywordQuery": "\"dark mode\" OR theme",
  "project": "/workspace/repo",
  "limit": 5,
  "type": "preference",
  "tags": "ui,editor",
  "who": "claude-code",
  "since": "2026-01-01T00:00:00Z",
  "until": "2026-04-01T00:00:00Z",
  "aggregate": true,
  "aggregateBudget": "small",
  "saveAggregate": true,
  "sessionKey": "session-uuid",
  "agentId": "alice",
  "includeRecalled": false,
  "runtimePath": "plugin"
}
```

`harness` and `query` are required.

This route is a hook-oriented wrapper around `POST /api/memory/recall`. It
accepts a narrower request surface, applies hook/session policy checks, and
then forwards the supported recall filters and explicit aggregate recall flags
into the shared recall path.
When `sessionKey` is present, it participates in the same context-epoch dedupe
ledger as `POST /api/memory/recall`.

`project` on this route is forwarded as the memory `project` filter. It is not
remapped to recall `scope`.

**Response**

Same recall-family shape as `POST /api/memory/recall`, plus legacy
compatibility fields during the transition period:

```json
{
  "results": [],
  "memories": [],
  "count": 0,
  "query": "user UI preferences",
  "method": "hybrid",
  "meta": {
    "totalReturned": 0,
    "hasSupplementary": false,
    "noHits": true
  },
  "message": "No matching memories found."
}
```

Special no-op cases preserve the same shape and add a flag:

- `{ ..., "bypassed": true }` when the session is bypassed
- `{ ..., "internal": true }` for internal no-hook calls

`memories` and `count` are legacy compatibility aliases for older hook
consumers and will mirror `results` and `results.length` during the
transition period. `message` is the canonical formatted recall brief used by
thin harness hooks so connectors do not reimplement ranking or presentation
rules.

### POST /api/hooks/pre-compaction

Called before context window compaction. Returns summary instructions for
the compaction prompt.
This endpoint does not advance the recall context epoch; only
`/api/hooks/compaction-complete` does.

**Request body**

```json
{
  "harness": "claude-code",
  "sessionKey": "session-uuid",
  "runtimePath": "plugin"
}
```

`harness` is required.

### POST /api/hooks/compaction-complete

Save a compaction summary as a memory row, as a temporal DAG artifact, and as a
canonical immutable markdown compaction artifact linked back through the
session manifest.

**Request body**

```json
{
  "harness": "claude-code",
  "summary": "Session covered dark mode setup and vim configuration...",
  "sessionKey": "session-uuid",
  "project": "/workspace/repo",
  "runtimePath": "plugin"
}
```

`harness` and `summary` are required. Optional `capturedAt` is the evidence's
original timestamp; malformed values return `400`. After deleting and reopening
a key, compaction summaries require a timestamp after the deletion watermark
and at or after the generation opening. Old or undated summaries are rejected
without memory, temporal-node, or artifact-file writes. Undated summaries for
never-deleted keys remain supported. Admission, the memory row, the temporal
node, and its thread head commit together in the database owner.

If `sessionKey` is present, the daemon uses it to preserve lineage:

- the memory row is agent-scoped
- `source_id` points back to the session lineage
- the temporal node keeps `session_key`
- the artifact can later be expanded through the temporal drill-down API
- transcript and temporal summary persistence are keyed by `agentId +
  sessionKey`, so identical session keys from different agents do not collide
- the canonical compaction file is written to
  `memory/{captured_at}--{session_token}--compaction.md`
- the mutable manifest for that session is backfilled with `compaction_path`
- the recall context epoch advances, so memories recalled before compaction are
  eligible again in the fresh context

If compaction fires before transcript persistence lands, callers should also
send `project`. The daemon uses that explicit project as the fallback lineage
scope until transcript storage catches up.

**Response**

```json
{ "success": true, "memoryId": "uuid", "contextEpoch": 1 }
```

### POST /api/hooks/session-checkpoint-extract

Record a mid-session checkpoint for long-lived sessions (Discord bots,
persistent agents) that never call `session-end`. Computes a delta since the
last extraction cursor, retains it in the canonical transcript/checkpoint
records, and does not release the session claim. Checkpoints are not delivered
to Dreaming until the transcript receives its completion marker.

**Request body**

```json
{
  "harness": "openclaw",
  "sessionKey": "session-uuid",
  "agentId": "agent-id",
  "project": "/workspace/repo",
  "transcriptPath": "/tmp/signet/session.jsonl",
  "runtimePath": "plugin"
}
```

`harness` and `sessionKey` are required. `transcript` (inline string) takes
precedence over `transcriptPath`; both fall back to the stored session
transcript from a prior `session-end` or `user-prompt-submit` call. Native
daemon file-backed transcript reads require `transcriptPath` to resolve under
the connector staging root `/tmp/signet`, point to a regular file, and fit
within the transcript size limit.

The endpoint skips silently when:
- The delta since the last extraction cursor is < 500 characters
- No transcript is available
- The session is bypassed

On a checkpoint with transcript content, the daemon retains a full snapshot
when it is at least as complete as the stored canonical row, writes the
continuity checkpoint, and resets the live continuity window. The endpoint
intentionally returns `{ "skipped": true }` for every request after this
bookkeeping: the retired summary worker is no longer a production path and no
`jobId` is created. It also returns that response when no transcript is
available, the pipeline is disabled, or the session is bypassed.

### GET /api/hooks/synthesis/config

Return the current synthesis configuration (thresholds, model, schedule).

### POST /api/hooks/synthesis

Request a `MEMORY.md` synthesis run. Implementation-defined request body
and response from `handleSynthesisRequest`.

Current `MEMORY.md` generation is a deterministic projection, not a free-form
LLM rewrite:

- scored durable memories come from the memory database
- rolling session-ledger rows come from canonical artifact frontmatter in
  `memory_artifacts`
- temporal context comes from `session_summaries` DAG artifacts
- the response keeps the rendered markdown in `prompt` for backward
  compatibility, with `model: "projection"`
- `indexBlock` contains the exact `## Temporal Index` block already included in
  the rendered projection

The rendered file contains these required sections:

- `## Global Head (Tier 1)`
- `## Thread Heads (Tier 2)`
- `## Session Ledger (Last 30 Days)`
- `## Open Threads`
- `## Durable Notes & Constraints`
- `## Temporal Index`

Optional `agentId` / `sessionKey` inputs may be provided so synthesis resolves
the correct agent-scoped head.

### POST /api/hooks/synthesis/complete

Retired. This compatibility boundary returns HTTP 410 with a structured,
versioned migration payload. Dreaming owns manifest-gated `MEMORY.md` head
publication; callers must not submit generated content directly.

Use `POST /api/synthesis/trigger` to request the supported Dreaming flow.


## Sessions

The sessions API exposes active session state, including per-session bypass
toggles. When bypass is enabled for a session, all hook endpoints return
empty no-op responses with `bypassed: true` — but MCP tools (memory_search,
memory_store, etc.) continue to work normally.

### GET /api/sessions

List active sessions for the requesting agent with their bypass status.
The response merges live tracker claims with live cross-agent presence so
sessions do not disappear just because one surface has not claimed the
session yet. Results are scoped to the authenticated agent; for
cross-agent visibility use `GET /api/cross-agent/presence`.

**Response**

```json
{
  "sessions": [
    {
      "key": "session-uuid",
      "runtimePath": "plugin",
      "claimedAt": "2026-03-08T10:00:00.000Z",
      "expiresAt": "2026-03-08T14:00:00.000Z",
      "bypassed": false
    }
  ],
  "count": 1
}
```

### GET /api/sessions/:key

Get a single session's status by its session key.

Both raw keys (`abc123`) and prefixed keys (`session:abc123`) are accepted.

**Response**

```json
{
  "key": "session-uuid",
  "runtimePath": "plugin",
  "claimedAt": "2026-03-08T10:00:00.000Z",
  "expiresAt": "2026-03-08T14:00:00.000Z",
  "bypassed": false
}
```

Returns `404` if the session key is not found.

### GET /api/sessions/:key/transcript

Return the canonical cleaned transcript for a session. Results are scoped to
the authenticated agent; pass `agent_id` only when calling with an authorized
agent scope. A credential scoped to a project only reads transcripts recorded
under that project; `project` narrows the lookup the same way for other callers.

Both raw keys (`abc123`) and prefixed keys (`session:abc123`) are accepted.

**Response**

```json
{
  "sessionKey": "session-uuid",
  "agentId": "default",
  "content": "User: ...\nAssistant: ..."
}
```

Returns `404` if no transcript exists for that session and agent scope.

### DELETE /api/sessions/:key/transcript

Delete a session's stored transcript without writing a session summary. Requires
`forget` permission in soft mode. Hard purge requires `admin` permission instead,
plus an authenticated admin role in team and hybrid modes. Explicit permission
lists are restrictive: `["admin"]` allows hard purge but not soft deletion;
`["forget"]` allows soft deletion but not hard purge. The session must belong to
the resolved agent and project.
Unknown keys and keys outside that scope both return `404` without changing
capture state.

Query parameters:

- `agent_id`: the owning agent. `agentId` and `x-signet-agent-id` are accepted
  aliases, but conflicting aliases and malformed identities return `400`.
- `project`: optional additional restriction. A credential's project scope is
  always enforced, even when this parameter is omitted.
- `generation`: optional positive safe integer. If it differs from the current
  capture generation, return `409` with the current `generation`, without
  changing evidence or bypass state. Omit it to target the current generation.
- `purge=hard`: hard-delete eligible derived memories and their history,
  embeddings, and search projections. In team and hybrid modes this requires an
  authenticated admin credential, including on localhost. Omit it for existing
  soft-forget behavior. Other values return `400`.

Outside local mode, identity must be explicit in the request or in the
credential's agent scope; an unscoped credential does not default to `default`.
Soft deletion uses the forget rate limit; hard purge uses the admin rate limit.

```json
{
  "status": "complete",
  "counts": {
    "transcripts": 1,
    "memories": 2,
    "retainedMixed": 1,
    "retainedPinned": 1,
    "records": 12,
    "filePathsCleaned": 1
  },
  "retainedPinned": 1,
  "generation": 1,
  "bypassed": true
}
```

Counts are cumulative for this deletion generation. Omitted categories are zero.
Other categories include `artifacts`, `summaries`, `captureJobs`, `sourceEdges`,
`embeddings`, and `uploadedBytes`. `filePathsCleaned` counts recorded targets
that have been cleaned or are already absent, not files removed in full.

A memory is deleted only when all its evidence sources belong to this session.
For memories with other sources, only the removed session's source edges are
detached; the memory is marked stale and queued for Dreaming re-evaluation.
Pinned memories keep their content, freshness, and recall visibility in both
modes. Only their links to removed evidence are detached; they are reported in
`retainedPinned` and are not queued for re-evaluation by this operation.

The database owner records a generation and deletion watermark before cleanup.
Capture retries, recovery, canonical backfills, snapshots, and imports cannot
restore the deleted generation. A live session remains bypassed until it ends,
including across daemon restarts. Normal session-end hooks and canonical TTL
finalization end the bypass. Attempting to disable that bypass returns
`409`. A later explicit session start with the same key opens a new generation
for new records. A start received during pending cleanup is remembered; its new
generation opens when cleanup completes. Owner-side admission still requires an
original capture timestamp after the watermark and at or after the new
generation's opening, including deferred end-of-session capture. Within a
resumed snapshot, each record's usable harness `timestamp` (or canonical
`captured_at`) is checked separately: records at or before the deletion watermark
are dropped, even if the snapshot was captured later. For each deleted generation,
the owner retains an ordered SHA-256 chain hash at every position. For a deleted
prefix of length `N` and a replay of length `L`, it compares the first
`k = min(L, N)` records with the stored hash at position `k`. Only a match removes
those leading records, and only if they are undated or dated at or before the
watermark. Dated records after the watermark survive even a matching prefix.
A mismatch admits the entire prefix subject to the timestamp cutoff; content
matches never remove interior or later turns. For example, deleting undated
`[user:A, assistant:B]` fences a shorter replay `[user:A]`, but admits both turns
of `[user:A, user:C]` because its two-record chain differs. Successive deletion
receipts are checked in generation order against the remaining leading records.
New live turns are not replayed snapshots. Receipts retain per-origin counts and chain
hashes, not deleted content. The owner reads `N` from the prefix receipt, not
by aggregating positional rows. Per-position hashes support shorter replays,
live as long as their deletion generation, and are purged with that generation. Do not relabel historical records with a new timestamp.

The hook-side lifecycle check is advisory on owner timeout or unavailability;
it does not fail the harness. The owner is called first. Only failed start/end
contacts create an intent outbox file, replayed in order on the next successful
lifecycle contact and removed when drained. The `.seq` counter is written only
when a failed contact is journaled. Its next value is one greater than the maximum
of the saved counter, journal sequence, cached owner high-water, and
`Date.now() * 1024`. Every successful lifecycle contact returns the owner's
high-water for the daemon's in-memory cache. Corrupt counters are discarded and
logged once without blocking owner contact. Normal sessions leave the outbox
directory empty. The outbox holds at most 256 session
files and 1,024 intents per file. At capacity, Signet logs the rejected intent and
relies on canonical TTL finalization. Normal sessions and failed status checks
create no journal files. These files contain pending requests, not deletion
state: only the database owner changes deletion state. Status checks do not clear user bypasses.
Owner-side admission at each evidence write remains the enforcement point, so
an advisory timeout does not reopen a deleted generation. Losing `.seq`, a
backward clock, and an owner outage across a restart together can still order an
intent behind a later deletion. The owner logs skipped intents with the key hash,
intent sequence, and owner high-water.

The owner persists positional hashes in batches of 512, yielding between batches
and retaining the fenced transcript row until its hashes are durable. Other
cleanup processes at most 64 database items, one uploaded-byte chunk, and four
4 MiB file slices per request. Canonical cleanup carries a constant-size chain
checkpoint and persists positional hashes in batches of 512; there is no
record-count deletion limit. Giant JSONL records stream
across slices without being loaded whole. A missing, replaced, or shortened
rewrite temp restarts that file from its beginning. Replacing the canonical file
also removes other pending deletion temps registered in the database for that path, without
scanning unrelated directory entries, so they restart from
the redacted canonical file. Shared JSONL files are rewritten under the
canonical transcript lock, preserving other sessions' records and concurrent
appends. Only the session's recorded targets and its harness's canonical file
are visited. The harness's original files and user backups remain after either
mode. Hard purge does not securely erase SQLite free pages or storage media.

Admitted artifact writers hold a session lease until their writes finish.
Deletion waits up to 15 seconds (the summary LLM timeout plus five seconds) for
that lease. Lease expiry returns `{ "status": "pending", "pendingReason": "..." }`
without claiming deletion admission or completion; retry after the writer drains.

A contended transcript lock returns `pending` after 250 ms instead of occupying
the database owner indefinitely. The operation uses the remaining owner-job
budget, including time spent queued, and yields `pending` before starting a file
batch that would consume the remaining budget. If work remains, retry the same
DELETE with its `generation` to resume its durable checkpoints. A `pendingReason` explains a blocked file cleanup,
including unsafe paths or unsupported descriptor-filesystem operations. Do not
treat pending as completion. A retry after completion returns `200` with the
same receipt and counts while the capture generation is unchanged. After key
reuse, a retry without `generation` targets the new generation; use the returned
generation for safe retries. An admin can retry a completed soft deletion with
`purge=hard` to purge its eligible soft-deleted memories.

### GET /api/sessions/blackbox

List sessions with replayable Black Box evidence for the requesting agent.
This is a dashboard-oriented flight recorder index assembled from existing
recall telemetry, context injection events, source artifacts, and epistemic
assertions. Results are scoped to the authenticated agent and may be narrowed
with `project`.

**Query parameters**

- `agent_id` / `agentId` — optional scoped agent selector when authorized.
- `project` — optional project path filter.
- `limit` — optional maximum session count.

**Response**

```json
{
  "agentId": "default",
  "sessions": [
    {
      "sessionKey": "session-uuid",
      "agentId": "default",
      "project": "/workspace/repo",
      "lastAt": "2026-03-08T10:00:00.000Z",
      "recallEvents": 3,
      "artifactEvents": 1
    }
  ],
  "count": 1
}
```

### GET /api/sessions/:key/blackbox

Return a session-scoped Black Box replay for a specific session key. The replay
preserves the raw session key supplied by the caller so persisted `session:`
prefixes continue to resolve. It explains what evidence was visible to Signet
at each point in the session; it does not claim deterministic model causality.

**Query parameters**

- `agent_id` / `agentId` — optional scoped agent selector when authorized.
- `project` — optional project path filter. When present, unprojected recall
  context rows are omitted unless they can be joined through project artifacts.

**Response**

```json
{
  "sessionKey": "session-uuid",
  "agentId": "default",
  "generatedAt": "2026-03-08T10:05:00.000Z",
  "eventCount": 2,
  "events": [
    {
      "id": "telemetry:abc:query",
      "kind": "recall.requested",
      "at": "2026-03-08T10:00:00.000Z",
      "title": "Recall requested",
      "detail": "dashboard provenance",
      "refs": [],
      "payload": {
        "route": "/api/memory/recall",
        "resultCount": 3
      }
    }
  ],
  "frame": {
    "at": "2026-03-08T10:00:00.000Z",
    "activeRefCount": 0,
    "activeRefs": [],
    "likelyInfluences": [],
    "warnings": []
  }
}
```

`events[].kind` is one of `recall.requested`, `recall.result`,
`context.recalled`, `artifact.written`, or `assertion.created`.

### POST /api/sessions/search

Search active or completed session transcripts. This route powers the
`session_search` MCP tool and is intended for sub-agents that need to inspect
the parent session without forcing a large token snapshot into every spawn.
Results are agent-scoped and require `recall` permission.

**Request body**

```json
{
  "query": "Juniper trunk ports",
  "sessionKey": "optional-specific-session",
  "currentSessionKey": "agent:nicholai:subagent:abc123",
  "agentId": "nicholai",
  "project": "/workspace/repo",
  "limit": 5
}
```

`query` is required. `limit` is clamped to `1..20`. If `sessionKey` is absent
and `currentSessionKey` encodes OpenClaw sub-agent lineage, Signet defaults the
search to the inferred parent session. Otherwise, Signet searches transcripts
in the requested agent and project scope while excluding `currentSessionKey`.

**Response**

```json
{
  "query": "Juniper trunk ports",
  "hits": [
    {
      "sessionKey": "agent:nicholai:main",
      "project": "/workspace/repo",
      "updatedAt": "2026-03-25T10:05:00.000Z",
      "excerpt": "keep the Juniper EX4300 VLAN audit focused on trunk ports",
      "rank": -1.2
    }
  ],
  "count": 1
}
```

### GET /api/sessions/summaries

List temporal manifest nodes used for drill-down and `MEMORY.md` synthesis.
Completed transcript nodes are written by Dreaming's content pass; historical
summary nodes remain readable for provenance. Results are agent-scoped.

**Response**

```json
{
  "summaries": [
    {
      "id": "sess-1",
      "kind": "session",
      "depth": 0,
      "source_type": "transcript",
      "source_ref": "session-uuid",
      "meta_json": "{\"source\":\"dreaming-content-pass\"}"
    }
  ]
}
```

### POST /api/sessions/summaries/expand

Expand a temporal node by id. Returns lineage, linked memories, and transcript
context for `MEMORY.md` drill-down and LCM-style expansion. Expansion is
agent-scoped.

**Request body**

```json
{
  "id": "node-id",
  "includeTranscript": true,
  "transcriptCharLimit": 2000
}
```

**Response**

```json
{
  "node": {
    "id": "node-id",
    "kind": "session",
    "depth": 0,
    "sourceType": "summary"
  },
  "parents": [],
  "children": [],
  "linkedMemories": [],
  "transcript": {
    "sessionKey": "session-uuid",
    "excerpt": "..."
  }
}
```

### POST /api/sessions/:key/bypass

Toggle bypass for a session. When enabled, all hook endpoints for this session
return empty no-op responses with `bypassed: true`. MCP tools are not affected.
Both raw keys and `session:<uuid>` forms are accepted. Requires `remember`
permission, as does `POST /api/sessions/:key/renew`. A project-scoped
credential can only control sessions in its project.

**Request body**

```json
{
  "enabled": true
}
```

`enabled` is required (boolean).

**Response**

```json
{
  "key": "session-uuid",
  "bypassed": true
}
```

Returns `404` if the session key is not found.

## Cross-agent presence and peer context

Active sessions register presence so peers can find them. Presence may carry
self-reported context so an agent can choose which of many sessions to message.
Context is untrusted text from the session or its harness; it is not verified
OS state, a complete list of changed files, or a resource lock.

### POST /api/cross-agent/presence

Registers or refreshes a session and optionally updates its context.

**Request body**

```json
{
  "harness": "pi",
  "sessionKey": "session-uuid",
  "agentId": "default",
  "project": "/work/render",
  "context": {
    "cwd": "/work/render",
    "hostname": "box-a",
    "title": "render",
    "task": "training a LoRA",
    "modifiedFiles": ["train.py"],
    "resources": ["gpu:0"]
  }
}
```

`harness` is optional when the session is already registered for the same
agent. `context` and every field in it are optional. Omitted fields keep their
stored value, including on a heartbeat with no `context`; an empty string or
empty array clears a field. Limits: `cwd` 512, `hostname` 128, `title` 160,
`task` 500 characters; `modifiedFiles` up to 20 entries of 300 characters;
`resources` up to 20 entries of 160 characters. Wrong types, unknown fields,
or over-limit values return `400` and change nothing. Control and bidi
characters are removed. The agent is resolved from the authenticated scope, and
a session owned by another agent returns `403`.

The same optional `context` object is accepted by `POST /api/hooks/session-start`
(as an object; a string value is ignored), `POST /api/hooks/user-prompt-submit`,
`POST /api/hooks/notifications`, and `POST /api/cross-agent/wake`. When a hook
creates a session's presence, `context.cwd` defaults to the hook's `cwd` or
`project`.

**Response**

```json
{
  "presence": {
    "key": "session:session-uuid",
    "sessionKey": "session-uuid",
    "agentId": "default",
    "harness": "pi",
    "project": "/work/render",
    "startedAt": "2026-11-03T18:00:00.000Z",
    "lastSeenAt": "2026-11-03T18:05:00.000Z",
    "context": { "cwd": "/work/render", "task": "training a LoRA", "resources": ["gpu:0"] },
    "contextUpdatedAt": "2026-11-03T18:04:30.000Z"
  }
}
```

`contextUpdatedAt` changes only when context changes; `lastSeenAt` advances on
every heartbeat.

### GET /api/cross-agent/presence

Lists active sessions the caller may read. Each session includes its `context`
and `contextUpdatedAt` when set. No transcript content is returned here.

**Visibility.** The caller's read policy is applied before `limit`, so hidden
newer sessions cannot crowd out visible ones: `shared` sees every agent,
`group` sees its own agent and agents in the same policy group (regardless of
the target's own policy), and `isolated` (or an unknown agent) sees only its
own sessions. Other sessions of the caller's own agent are listed when
`session_key` names the caller's session. `project` filters only when given.
`scope=all` bypasses the policy and is limited to local mode or an admin token.
The same policy filters `GET /api/cross-agent/stream` presence snapshots and
live presence events, and the automatic peer list injected at session start.
Policy lookup failures fail closed to the caller's own sessions.

### GET /api/cross-agent/sessions/:sessionKey/context

Bounded drilldown into one active session. URL-encode the session key.

**Query parameters:** `target_agent_id` (owner; `404` on mismatch), `agent_id`
and `caller_session_key` (the caller, resolved against the authenticated
scope), `max_messages` (1 to 5, default 3), and `scope=all` (local mode or an
admin token only).

**Response**

```json
{
  "presence": { "sessionKey": "session-uuid", "agentId": "beta", "harness": "pi" },
  "recentMessages": [{ "role": "user", "content": "how is it going" }],
  "truncated": true,
  "provenance": {
    "presence": "self-reported",
    "transcript": "signet-captured-tail",
    "transcriptUpdatedAt": "2026-11-03T18:05:00.000Z",
    "transcriptBytes": 812345,
    "bytesRead": 32768,
    "roles": "user-and-assistant-only",
    "untrusted": true
  }
}
```

Only user and assistant turns from the transcript Signet already captured are
returned, at most 5 messages and about 4000 characters in total, with
credentials redacted. Reasoning, tool output, system turns, and the full
transcript are never returned. The database owner reads only a bounded tail
(32 KiB); `truncated` is true when anything older or longer was left out.
`transcript` is `unavailable` when no transcript has been captured yet. The
tail is parsed conservatively: the possibly cut first line is dropped, and
plain `User:`/`Assistant:` turns and Claude, Pi, Hermes, and Codex JSONL
records are read for user and assistant text blocks only. `<thinking>` markup,
`Assistant reasoning:` lines, tool, system, and unknown structured rows are
dropped, never returned raw. Visible hidden-block delimiters are processed before
role labels or JSONL records, so forged roles inside a recognized hidden block
are omitted. An unclosed block suppresses the remaining tail, including apparent
JSONL records. A cut tail discards content up to any orphan closing tag. If a
plain-text tail starts inside a block longer than 32 KiB and no delimiters occur
in the returned tail, its prior hidden state cannot be reconstructed; this
best-effort preview is not a complete hidden-content filtering guarantee.
The query still reads the stored value server-side (the 32 KiB bound applies to
returned content, not database I/O). Presence keys are global per session key:
when another agent registers a key, the old owner's presence and context are
discarded, a removal event is emitted for the old audience, and a fresh presence
is created. The lookup is the exact `(sessionKey, owner)` tuple;
`target_agent_id` never falls back to another agent's session.

Hermes retains explicit task/resource metadata for same-id refreshes and verified
compression continuations (`reason=compression`, parent equal to the active key,
no reset). A new conversation, branch, unrelated rotation or explicit reset
clears it; a parent id alone is not evidence of continuity.

**Access.** The caller can inspect sessions of its own agent. Otherwise its
read policy applies: `shared` may inspect any agent, `group` only agents in the
same policy group, `isolated` only itself, and denial returns `403`. A missing
session, or a `target_agent_id` that does not own the key, returns `404`. A
scoped token cannot name another agent as the caller. `scope=all` bypasses the
read policy and is limited to local mode or an admin token.
