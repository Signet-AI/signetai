# Prompt context contract

Status: implemented

Signet memory context is an ephemeral delivery artifact. It is not a user turn and must not be written into the canonical user/assistant transcript.

## Wire contract

Every non-empty session-start or user-prompt-submit memory injection uses the same deterministic envelope:

```text
<signet-memory-context>
...context content...
</signet-memory-context>
```

The daemon also returns:

- `contextVersion`: the envelope version (`1`)
- `contextHash`: SHA-256 of the exact serialized `inject` bytes

The serializer normalizes CRLF/CR to LF, removes trailing transport whitespace, and always emits one terminal LF. Nested envelope markers in memory content are escaped before serialization. Replaying identical context therefore produces identical bytes and an identical hash. Compatible hook responses may append a structured cross-agent notification block after the envelope for legacy adapters; when present, `contextHash` covers the final returned `inject` bytes.

`user-prompt-submit` also returns `clockContext`, formatted as a line beginning
`Current date/time:` and ending with the explicit UTC offset plus IANA timezone.
This is computed once at request start and is explicitly dynamic. Adapters deliver
it through their hidden/provider-bound per-turn path, but it is never added to
`inject`, the `<signet-memory-context>` envelope, or `contextHash`. Therefore a
clock-only change does not change the memory-context hash.

## Delivery matrix

| Harness | Session context | Per-prompt context | Canonical transcript |
| --- | --- | --- | --- |
| Hermes | Connector caches session-start inject and sends it through its API-side context path | Connector prefetch is a replayable per-turn sidecar | Visible user/assistant transcript only |
| Claude Code | `SessionStart` hook additional context | `UserPromptSubmit` hook additional context | Hook context is not a transcript turn |
| Codex | Native hook `additionalContext` | Native hook `additionalContext` | Hook context is not a transcript turn |
| OpenCode | Session-start context is held by the plugin | Active-turn context is replayed for every system transform, including title and primary requests | SDK message parts only |
| Pi | Hidden custom session context | Hidden custom recall messages are consumed during `context` | Hidden custom messages are not visible transcript turns |
| Other hook integrations | Use the same daemon envelope and hash | Use the same daemon envelope and hash | Adapter must append only visible user/assistant content |

The system prefix remains harness-owned. Signet appends context rather than rewriting the existing system prompt. Session-start and per-prompt context contain no wall-clock metadata, so repeated transforms do not invalidate the context hash or prompt cache solely because time advanced.

## Transcript and scope rules

Adapters must keep the envelope out of canonical transcripts. Session, agent, branch, resume, compression, and rewind state remain the adapter's scope boundary; context from one session must not be reused by another session. A failed or stale prompt-submit response is discarded by the adapter rather than applied to a newer turn.

## Provider-output scrubbing

`@signet/core` exposes `PromptContextStreamScrubber` and `scrubPromptContext`. They remove complete envelopes and buffer a fence split across streaming chunks. Adapters that receive provider output before exposing it to a visible assistant callback should pass those chunks through the scrubber. The scrubber is deliberately separate from injection: it never changes the canonical transcript.

## Measurement

The daemon already records prompt-injection latency as `durationMs` and the injected byte count as `injectChars`. `contextHash` makes repeated delivery verifiable without treating a timing sample as proof of cache stability. Cache-hit/miss behavior remains provider- and harness-specific; the contract does not claim a cache hit where the harness exposes no cache telemetry.
