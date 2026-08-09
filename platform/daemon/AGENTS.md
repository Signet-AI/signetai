# Daemon guidance

The daemon owns Signet's HTTP surface, pipeline, hooks, auth enforcement,
background work, and dashboard serving. Load only the references relevant to
the task: `web/docs/src/content/docs/api.md`, `web/docs/src/content/docs/auth.md`, `web/docs/src/content/docs/pipeline.md`,
`web/docs/src/content/docs/sources.md`, and `web/docs/src/content/docs/architecture.md`.

## Scope and provenance

- Carry the resolved agent identity through requests, jobs, database queries,
  derived rows, analytics, and diagnostics. HTTP and TypeScript commonly use
  `agentId`; SQLite uses `agent_id`. Preserve `visibility` when the data model
  supports it.
- Bind session operations to the resolved agent. Reject cross-agent reads,
  links, proposal applies, claim mutations, and token use unless the policy
  explicitly authorizes them.
- Source ingestion stores and indexes evidence; it does not rewrite that
  evidence into semantic truth. Derived memory and ontology changes retain
  attribution, and source-backed data remains purgeable when a source is
  disconnected.

## Boundaries and failure behavior

- Validate route bodies, query parameters, headers, configuration, and
  environment values at their boundary using the existing schema helpers.
  Bound limits, offsets, intervals, retry counts, and timeouts before use.
- Auth, source access, mutation gates, and publish or install integrity fail
  closed. Team and hybrid deployments need permission checks and appropriate
  rate limiting on privileged or expensive routes.
- Return structured errors and log enough non-secret context to identify the
  route, runtime path, agent, session, or source. Do not swallow failures or
  silently switch execution paths.
- Retry, refresh, watcher, and background loops need bounded timing,
  serialization or single-flight where overlap is unsafe, and cleanup for
  timers and resources.

## API and runtime proof

- Keep `web/docs/src/content/docs/api.md` synchronized with route methods, bodies, responses, and
  auth behavior. Update the other daemon references when pipeline, source, or
  lifecycle contracts change.
- Add focused behavioral coverage near the changed route or pipeline stage,
  including scope and invalid-input cases where relevant.
- A passing unit test does not prove daemon lifecycle, file watching,
  generated dashboard serving, connector behavior, or installed-package
  behavior. Start and exercise the real daemon path when the failure depends
  on it.
- Common focused commands include:

```bash
bun test platform/daemon/src/<area>.test.ts
bun run --filter '@signet/daemon' build
```
