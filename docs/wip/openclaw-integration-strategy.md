# Signet Strategy Split: Desktop Embeddings + OpenClaw Contributions

## Plan A: Desktop Embedding Dependency Tiers (Signet-wide)

### Objective

Ship a reliable desktop-first embedding architecture with clear quality
tiers while keeping the librarian tied to the user's existing LLM
provider/runtime.

### Scope

This plan is for Signet desktop installs and is independent of OpenClaw
upstream PR waves.

### Tier Model

Librarian rule (all tiers):

- The librarian always uses the user's existing runtime/provider LLM
  (OpenClaw/Claude Code/OpenCode/Ollama-hosted chat model, etc.).
- Tiering applies to **embeddings only**.

Tier definitions:

- Tier 0 (default): `transformers.js` local embeddings
  - No external process
  - No API key required
  - Best out-of-box reliability for desktop installs
- Tier 1: Ollama embeddings (example: `nomic-embed-text`)
  - Local model server required
  - Better quality than Tier 0 on many setups
  - No external API cost
- Tier 3: Remote API embeddings (example: OpenAI
  `text-embedding-3-large`)
  - API key required
  - Highest quality target
  - Network dependency and usage cost

### Selection + Fallback Behavior

1. Respect explicit user config if set.
2. If unset, default to Tier 0.
3. If Tier 1 is selected but Ollama is unavailable, fail over to Tier 0.
4. If Tier 3 is selected but API key/network check fails, fail over to
   Tier 1 when available, else Tier 0.

### Rollout Order

1. Ship Tier 0 as stable default for desktop.
2. Add Tier 1 with health check + connectivity diagnostics.
3. Add Tier 3 with key validation, budget/telemetry guardrails, and
   clear degraded-mode messaging.

## Plan B: OpenClaw Contribution Plan

### Primary Objective

Earn trust with steipete through consistently useful upstream
contributions so Signet is a credible option when OpenClaw converges on
its long-term memory path.

### Context

We reviewed 60+ memory-related OpenClaw PRs and studied the
`memory-lancedb` plugin (671 lines) plus `memory-core` (38 lines).
Current pattern:

- Small, focused, low-risk memory improvements are merged more often
- Large redesigns, dependency-heavy changes, and broad rewrites are
  usually rejected or stalled
- PRs under ~500 lines with clear test coverage and no migration impact
  are the highest-probability path

### Strategy

Do not lead with "use our plugin." Lead with concrete improvements that
help OpenClaw regardless of whether Signet is adopted.

Guiding posture:

- Helpful and technically precise
- No sales framing inside PRs
- Credit OpenClaw maintainers and existing design decisions
- Keep each PR independently valuable and easy to review

### What Stays Differentiated in Signet

- Secret store and vault workflow
- Cross-platform identity portability (`SOUL.md`, `IDENTITY.md`,
  `USER.md`)
- Full pipeline orchestration (extraction -> decision -> graph ->
  retention -> summarization)
- Daemon/connectors/harness config synchronization layer

### Micro-PR Campaign (ranked by acceptance probability)

Selection criteria: small scope, low coupling, no new dependencies,
clear tests, explicit rollback.

### Wave 1: Highest probability

**PR 1: Content normalization + stronger dedup hash**
- Files: `extensions/memory-lancedb/index.ts`
- What: normalize whitespace and casing/punctuation edge cases before
  hash generation; skip near-duplicates
- Why: reduces duplicate growth from formatting-only variance
- Size target: ~50 lines
- Migration: none
- Signet source: `packages/daemon/src/content-normalization.ts`

**PR 2: Importance-aware score calibration**
- Files: `extensions/memory-lancedb/index.ts` (`MemoryDB.search`)
- What: incorporate `importance` into final ranking (for example
  `score = (1 / (1 + distance)) * (0.5 + 0.5 * importance)`)
- Why: importance is stored but currently does not affect ordering
- Size target: ~20-30 lines
- Migration: none
- Signet source: `packages/core/src/search.ts` (ranking normalization patterns)

**PR 3: Provider availability tracker (ring buffer)**
- Files: new small utility + integration point in embedding call path
- What: fixed-size ring buffer for embedding outcomes
  (`success|failure|timeout`)
- Why: adds operational visibility without persistent storage changes
- Size target: ~80 lines
- Migration: none
- Signet source: `packages/daemon/src/diagnostics.ts`

### Wave 2: Medium complexity, still low-risk

**PR 4: Configurable recall threshold (`minScore`)**
- Files: `extensions/memory-lancedb/index.ts`
- What: expose optional `minScore` in `memory_recall`, validate range, and
  keep current default when omitted
- Why: lets operators tune precision/recall without changing code
- Size target: ~20-40 modified lines
- Migration: none

**PR 5: Token-aware recall budget (optional parameter)**
- Files: `extensions/memory-lancedb/index.ts`
- What: optional `contextTokenBudget`; stop adding recalls when budget
  is reached; default behavior remains current limit-based recall
- Why: better context-size control with backward compatibility
- Size target: ~40 lines
- Migration: none

**PR 6: Degraded-mode error signaling when embeddings fail**
- Files: `extensions/memory-lancedb/index.ts`
- What: on embedding failure, return explicit degraded-mode status and
  actionable guidance in tool details/logs (instead of generic/no-result
  behavior)
- Why: memory availability failures should be diagnosable and not look
  like "no memories exist"
- Size target: ~40-60 lines
- Migration: none in initial PR scope
- Note: if lexical fallback is desired later, ship it as a separate PR
  with isolated indexing scope

### Wave 3: Submit only after trust is established

**PR 7: TTL support for temporary memories**
- Files: `extensions/memory-lancedb/index.ts`
- What: optional `expiresAt`, filter expired rows, cleanup path
- Size target: ~60 lines
- Migration: likely yes (new column)
- Signet source: `packages/daemon/src/pipeline/retention-worker.ts`

**PR 8: Rate-limited repair actions**
- Files: new utility + minimal call-site integration
- What: cooldown + hourly budget for maintenance actions
- Size target: ~100 lines
- Migration: none
- Signet source: `packages/daemon/src/repair-actions.ts`

**PR 9: Optional reranking with timeout guard**
- Files: new utility + search integration
- What: rerank top-N with strict timeout and fallback to original order
- Size target: ~120 lines
- Migration: none
- Signet source: `packages/daemon/src/pipeline/reranker.ts`

### PR Quality Bar (required for every submission)

Each PR must use OpenClaw's canonical PR template sections
(`.github/pull_request_template.md`) with complete, concrete answers:

1. Problem statement
2. Scope (what is intentionally out of scope)
3. Test plan
4. Rollback plan
5. Risk notes
6. Security impact
7. Repro + verification
8. Human verification
9. Compatibility / migration
10. Failure recovery

Minimum test expectations:

- Unit test for new behavior
- Regression test covering the bug/path fixed
- No behavior change in default path unless explicitly intended
- Local validation command succeeds:
  `pnpm build && pnpm check && pnpm test`

Rollback requirement:

- Each PR should be reversible with a small, isolated revert
- Avoid touching multiple subsystems in one PR

AI-assisted disclosure requirement:

- Mark PR as AI-assisted in title or description
- State testing level (untested / lightly tested / fully tested)
- Include prompts/session notes when possible

### Signet Plugin Improvements (parallel track)

While contributing upstream, improve `@signetai/adapter-openclaw` in
parallel:

1. Finalize `openclaw.plugin.json` (`kind: "memory"`, complete
   `configSchema`, clear `uiHints`)
2. Enforce token budget cap for injected memories
3. Verify identity injection (`SOUL.md`/`IDENTITY.md`/`USER.md`) at
   session start
4. Integrate health reporting with OpenClaw doctor flow
5. Tight README: 3-command setup + architecture diagram
6. Ensure librarian/provider bridge follows OpenClaw provider settings

### Community Engagement Plan

### GitHub (after Wave 1 PRs are live)

1. Comment on issue `#12880` with implementation notes from identity
   file handling
2. Comment on PR `#24154` with concrete interoperability learnings
3. Open one technical discussion: cross-platform identity portability
   (non-promotional)

### X/Twitter (after positive review signal)

- Post concise engineering updates tied to shipped upstream improvements
- Highlight contribution intent first, Signet second
- Keep tone factual and collaborative

### Demo (after initial trust is established)

- Same agent persona/context across Claude Code and OpenClaw
- Same memory continuity with no manual reconfiguration
- Short recording showing portability and operational stability

### Anti-Patterns

- PRs over ~500 lines
- New core dependencies without prior maintainer buy-in
- Architecture rewrites framed as "replacement"
- Marketing language in technical review threads
- Giving away core Signet differentiators prematurely

### Execution Timeline

1. Now: finalize Wave 1 specs, exact target functions/files, and tests
2. Week 1: submit Wave 1 PRs (small, independent, reversible)
3. Week 1-2: continue adapter hardening in parallel
4. Week 2-3: submit Wave 2 PRs based on review feedback
5. Week 3-4: technical engagement in issues/discussions
6. Week 4+: demo and public narrative once upstream trust is visible

### Success Metrics

Primary success metric:

- steipete sees Signet as a high-signal contributor and includes us in
  memory-path shortlist discussions

Leading indicators (measurable):

- Wave 1 merge rate
- Median time to first maintainer response
- Number of requested rework cycles per PR
- Number of follow-up PR invitations or direct maintainer pings
- OpenClaw discussion references to Signet work (technical, not
  promotional)
