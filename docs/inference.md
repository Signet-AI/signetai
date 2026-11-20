# Inference

## No failover after output starts

Once a streaming response has emitted output, the router does not switch to another backend. It returns the partial output with degraded metadata.

Why: a second backend would continue text it did not write, and the caller has already consumed the first part.

Owner: `platform/daemon/src/inference-router.ts`.

## Only sterile ACPX targets retry empty responses

ACPX agents sometimes finish with `end_turn` and no assistant message. Signet retries that in a fresh one-shot session only when the target is sterile: deny-all permissions, hooks disabled, and an empty tool catalog. Tool or permission activity is never treated as an empty completion.

Why: a target that can act may already have caused side effects, and a retry would repeat them.

Owner: `platform/daemon/src/pipeline/provider.ts`.
