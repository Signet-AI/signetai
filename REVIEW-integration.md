# Integration Review — Memory Signing / Web3 Identity

**Reviewer:** Claude (subagent)  
**Date:** 2025-07-25  
**Scope:** Files added/modified for DID, memory signing, and Merkle anchoring  
**Codebase state:** After 2 prior fix rounds

---

## 🔴 CRITICAL — Will crash or produce wrong results at runtime

### 1. `pipelineCfg.extractionModel` does not exist on `PipelineV2Config` (daemon.ts:1901, 2041)

**File:** `packages/daemon/src/daemon.ts`  
**Lines:** 1901, 2041

`PipelineV2Config` nests extraction config: the correct path is `pipelineCfg.extraction.model`, not `pipelineCfg.extractionModel`.

```ts
// Line 1901 — envelope construction (inside remember route)
extractionModel: pipelineEnqueueEnabled
    ? pipelineCfg.extractionModel   // ❌ TS2551 — property doesn't exist
    : null,

// Line 2041 — pipeline job failure handler
.run(pipelineCfg.extractionModel, id);  // ❌ same issue
```

**Impact:** TypeScript won't compile. At runtime (if JS is shipped untyped), `extractionModel` resolves to `undefined`, so every memory gets `extraction_model = NULL` even when the pipeline is on, and failed extraction jobs write NULL into the column.

**Fix:**
```ts
// Line 1901
pipelineCfg.extraction.model

// Line 2041
pipelineCfg.extraction.model
```

---

### 2. `isAutoSignEnabled()` is never checked — signing ignores user config

**File:** `packages/daemon/src/memory-signing.ts`  
**Lines:** `signEnvelope()` function (~line 98)

The module docstring says *"The `autoSign` flag in agent.yaml controls whether signing is attempted"*, and `isAutoSignEnabled()` is exported from `@signet/core/did-setup`. But `signEnvelope()` only checks `isSigningAvailable()` (keypair exists), never `isAutoSignEnabled()`.

**Impact:** If a user has a keypair but sets `signing.autoSign: false` in agent.yaml, memories are **still signed** — violating documented behavior and user expectation.

**Fix:** Add to `signEnvelope()`:
```ts
import { isAutoSignEnabled } from "@signet/core";

export async function signEnvelope(envelope: IngestEnvelope): Promise<IngestEnvelope> {
    if (!isAutoSignEnabled()) return envelope;   // ← add this
    if (!isSigningAvailable()) return envelope;
    // ...
}
```

---

## 🟡 MODERATE — Functional but incorrect/lossy

### 3. CLI `merkle --save` doesn't persist `leaf_hashes`

**File:** `packages/cli/src/cli.ts`  
**Line:** ~5396

The `merkle` command computes `leafHashes` (array of all BLAKE2b-hashed content hashes), but the INSERT statement omits the `leaf_hashes` column. The migration schema includes `leaf_hashes TEXT` in `merkle_roots`, and the `MerkleRootRecord` type has `leafHashes?: string`.

```sql
-- Current (missing leaf_hashes):
INSERT INTO merkle_roots
  (root_hash, memory_count, computed_at, signer_did, signature, created_at)
  VALUES (?, ?, ?, ?, ?, ?)

-- Should be:
INSERT INTO merkle_roots
  (root_hash, memory_count, leaf_hashes, computed_at, signer_did, signature, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
```

**Impact:** `leaf_hashes` is always NULL in saved Merkle roots. This makes it impossible to regenerate individual membership proofs from a stored root without recomputing from scratch — defeats part of the provenance design.

**Fix:** Add `leaf_hashes` to the INSERT and pass `JSON.stringify(leafHashes)` as the value.

---

### 4. CLI backfill constructs signing payload manually — bypasses `buildSignablePayload` validation

**File:** `packages/cli/src/cli.ts`  
**Line:** ~5252

The `sign-backfill` command constructs the payload inline:
```ts
const payload = `${row.content_hash}|${row.created_at}|${did}`;
```

Meanwhile `memory-signing.ts` exports `buildSignablePayload()` which validates:
- `contentHash` is lowercase hex only
- No pipe characters in fields (prevents delimiter injection)

The CLI doesn't import or use `buildSignablePayload`, so it:
1. Skips input validation on existing DB content
2. Creates a maintenance risk if the signing format ever changes

**Fix:** Import and use `buildSignablePayload` from `@signet/core` or from the daemon's `memory-signing.ts`. Note: `buildSignablePayload` is currently only exported from the daemon package, not from `@signet/core`. Consider moving it to core so both CLI and daemon share it.

---

## 🟢 LOW / INFORMATIONAL

### 5. `buildSignablePayload` is only exported from daemon — not from core

**File:** `packages/daemon/src/memory-signing.ts`

The CLI can't import it without cross-package dependency on the daemon. Since it's a pure function with no daemon-specific deps, it belongs in `@signet/core` alongside the other crypto/signing utilities.

### 6. `MigrationDb.prepare().get()` type incompatibility with better-sqlite3

**File:** `packages/daemon/src/db-accessor.ts:102`

The `MigrationDb` interface defines `.get()` as returning `Record<string, unknown> | undefined`, but better-sqlite3's `.get()` returns `... | null | undefined`. This causes TS2345 at migration runner initialization. Pre-existing issue, not introduced by this PR, but it will block `tsc --noEmit`.

### 7. Numerous pre-existing TS errors unrelated to signing

The `tsc --noEmit` run shows ~30 errors, most pre-existing (LogCategory missing `"documents"`, `"connectors"`, `"auth"`, `"projection"`, `"llm"`; missing properties on types in test files, etc.). These are not caused by the signing changes but will block a clean build.

---

## ✅ Things that look CORRECT

| Item | Status |
|------|--------|
| `txIngestEnvelope` SQL: 22 columns, 22 placeholders, 22 `.run()` args | ✅ Matched |
| `IngestEnvelope` type has `signature?` and `signerDid?` (optional) | ✅ Correct |
| Migration 012 uses `addColumnIfMissing` for safe idempotent ALTER TABLE | ✅ Safe |
| Migration 012 uses `CREATE TABLE IF NOT EXISTS` for `merkle_roots` | ✅ Safe |
| Migration 012 is registered in `MIGRATIONS` array at version 12 | ✅ Correct |
| `MerkleRootRecord` type in `types.ts` matches migration schema | ✅ Matches |
| `Memory` type in `types.ts` has `signature?` and `signerDid?` | ✅ Matches |
| All new crypto/DID/merkle functions exported from `@signet/core/index.ts` | ✅ Complete |
| `signEnvelope` called BEFORE `withWriteTx` (async outside sync tx) | ✅ Correct pattern |
| `signEnvelope` returns envelope unchanged on failure (non-blocking) | ✅ Graceful degradation |
| `verifyMemorySignature` uses `didToPublicKey` (static import, not dynamic) | ✅ Correct |
| CLI `did init/show/document/verify` commands — proper error handling, awaits | ✅ Correct |
| CLI `memory sign-backfill/verify-signatures/merkle/status` — proper error handling | ✅ Correct |
| `signEnvelope` returns a new object instead of mutating input | ✅ Immutability |

---

## Summary

| Severity | Count | Action needed |
|----------|-------|---------------|
| 🔴 Critical | 2 | Fix before merge |
| 🟡 Moderate | 2 | Fix before merge (data correctness) |
| 🟢 Low | 3 | Can address in follow-up |
