# Inference Consumer Audit — #947 cutover

**Date:** 2026-07-22
**Question:** Do all Signet inference consumers still work through the pi-ai + ACPX backends, and is low-latency inference (aggregate recall in particular) preserved?

## Consumer model

Every daemon LLM call flows through one path:

```
consumer → getInferenceProvider(workload) | router.execute(...)
         → InferenceRouter → createRoutingProvider (inference-provider-factory.ts)
         → createPiModelProvider (pi-ai) | createAcpxProvider
```

There is no remaining direct use of the deleted per-provider factories. Two consumption styles, both satisfied by `createPiModelProvider`:

| Style | Used by | pi-provider method |
|---|---|---|
| **Streaming** (`router.execute` requires `streamWithUsage`) | aggregate recall, hook recall injection, any routed call | `streamWithUsage` ✅ |
| **One-shot** (`provider.generate` / `generateWithUsage`) | reranker-llm, structural workers, dreaming-worker (legacy) | `generate` + `generateWithUsage` ✅ |

`router.execute` **hard-rejects** providers without `streamWithUsage` (`inference-router.ts:746`). Because pi-provider implements it, every routed consumer — including aggregate recall — continues to work.

## Aggregate recall (the flagged risk)

`aggregate-recall.ts` uses `deps.router.execute(request, prompt, opts)` for both query planning and synthesis. Traced end to end:

- `aggregateRecall` → `planQueries` / `synthesize` → `router.execute` → `createProvider` → `createPiModelProvider` → `streamSimple` (pi-ai) → SSE over `globalThis.fetch`.

**Latency measured** (synthesis-sized call, ~700-token prompt, LM Studio `qwen3.5-0.8b`): 198–512ms warm. Well within aggregate recall's 30s synthesis / 20s planning timeouts, and indistinguishable from direct HTTP — pi-ai is a thin layer over `fetch`, and the router's ReadableStream pump adds negligible overhead.

The `acpxHooks: "disabled"` opt the router receives is honored: the pi-ai path never spawns a subprocess, so aggregate recall never pays harness-spawn cost.

## Provider-name coupling

Searched for any consumer that pattern-matches `provider.name` (e.g. `startsWith("anthropic:")`, `.split(":")[0]`). **None found** outside the rate-limiter's `shouldRateLimit` (which keys off the executor prefix and is unaffected). So the provider naming change is safe.

## Legacy dreaming-worker

`pipeline/dreaming-worker.ts` still calls `getSynthesisProvider()`. This is the **legacy daemon dreaming worker** (the "broken third path" per #913) — `enabled: false` by default, gated behind `!mutationsFrozen`, already inert. It is slated for deletion in #913's cutover, not a regression introduced here.

## Verification

- `inference-router.test.ts`: 5/5 pass (legacy credential resolution through pi-ai, including SSE).
- `pi-provider.live.test.ts`: 5/5 live checks (generate, usage, stream, abort, timeout).
- `acpx-harness.live.test.ts`: claude/codex reach ACP auth gate (chain works); opencode returns `PONG` end-to-end.
- Two adversarial `autoreview` passes: no findings.

## Conclusion

The cutover preserves every consumer contract. Aggregate recall works through pi-ai with no latency regression. The only behavioral changes are intentional (OpenRouter reasoning abstraction, keyless-local placeholder auth, `/models` availability probe) and are documented in the PR.
