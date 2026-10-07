---
title: "Memory content safety"
status: approved
---

# Memory Content Safety

## Problem

Memories, native harness artifacts, transcripts, summaries and source chunks
are retained as source-backed evidence and later projected into recall,
reranking, Dreaming, `MEMORY.md`, MCP tools and LLM prompts. Users paste API
keys, tokens and private keys into conversations and documents. Those
credentials must not be repeated into prompts or agent-facing output merely
because they were captured as evidence.

An earlier version of this contract tried to classify content as hostile
(prompt injection, exfiltration, tool directives, shell payloads, invisible
Unicode) with text heuristics and withheld whole items. Heuristics cannot
decide whether content is safe; in practice they withheld ordinary
conversation (2.7% of benign LongMemEval sessions) and silently dropped it
from Dreaming. That policy and its per-item ledger are retired (#2045).

## Contract

1. One credential detector, `findCredentialSpans` / `redactCredentials` in
   `@signet/core`, finds high-confidence credentials: provider API keys and
   tokens with known prefixes, private-key blocks, JWTs, bearer tokens, and
   values assigned to secret-named keys. It is the only secret detector;
   checkpoint, subagent-context and plugin-audit redaction use it.
2. Every prompt-facing or agent-facing projection of stored content replaces
   each detected credential span with `[redacted credential]`: recall
   results, Dreaming evidence, `MEMORY.md` and head rendering, identity
   synchronization, MCP memory and knowledge tools, chat recall, and derived
   LLM stages (prospective hints, reflections, artifact sentences).
   Structured projections use `redactCredentialsDeep`.
3. Nothing is withheld or filtered for content-safety reasons. Items with a
   credential are still recalled, delivered to Dreaming and rendered, with
   only the credential span replaced.
4. Stored evidence is never rewritten. Redaction happens on the way out; the
   original content, source path, timestamps, ownership and provenance stay
   intact and remain available to user-facing inspection.
5. There is no per-item safety ledger. Redaction is computed from the content
   at projection time, so there is no derived state to rebuild or purge.

## False-positive boundary

Detection is intentionally narrow. Ordinary prose about secrets, passwords or
tokens, variable names, placeholders, code that computes a token, commit
SHAs, content hashes and UUIDs are not credentials. Secret-named assignments
are redacted only when the value contains a digit and no code punctuation.
A false positive replaces a short span, never a whole item.

## Non-goals

- classifying content as hostile, injected or unsafe;
- withholding, deleting or rewriting stored evidence;
- claiming that unredacted content is free of secrets or safe for every use;
- replacing provenance, agent scoping or permission checks.

## Verification

- Core detector tests cover each credential kind, value-only redaction of
  assignments, private-key blocks, and benign text that must stay unchanged.
- Migration tests prove migration 163 drops the retired ledger and its
  triggers without touching evidence.
- Daemon tests prove a stored credential is redacted in recall, Dreaming
  evidence and MCP projections while the stored row is unchanged.
