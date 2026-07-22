# Recall request contract

`recall-request-v1.json` is the transport-neutral contract for turning a recall
intent into the JSON body sent to `POST /api/memory/recall`.

`buildRecallRequestBody()` in `platform/core/src/recall.ts` is the sole
TypeScript implementation. TypeScript clients call it directly. Native clients
implement only the subset exposed by their harness and consume the applicable
vectors in tests so defaults, bounds, field names, and omission rules cannot
drift silently.

The request contract bounds `limit` to `1..100`. The daemon currently applies a
separate execution cap of 50 while searching; that backend safeguard does not
change the client request contract.

The `unreal` entry records deliberate gameplay policy rather than a second
generic contract: NPC recall defaults to 6, is capped at 20, always includes
previously recalled rows, and uses world/player scope strings. Repository-native
Unreal automation receives this file through `SIGNET_RECALL_CONTRACT_VECTORS`;
installed plugins skip that repository-only vector assertion when the variable
is unset.

When the wire contract changes, add a new version instead of rewriting vectors
that released native clients may still use.
