# CLI Commands Code Review — DID & Memory Signing

**Reviewer:** Senior TypeScript Architect (automated review)
**Date:** 2025-07-17
**Scope:** `did init|show|document|verify`, `memory sign-backfill|verify-signatures|merkle|status`
**Files:** `cli.ts` (lines 5042–5520), `did-setup.ts`, `memory-signing.ts`
**Fix round:** 7 (prior 6 rounds completed)

---

## Summary

The code is surprisingly solid for its round count. The signing payload format is consistent between `sign-backfill` (CLI) and `buildSignablePayload` (daemon). DB close paths are handled on most branches. The DID commands are clean and correct. However, I found **3 real bugs, 2 resource leak patterns, and several hardening gaps** that prior rounds missed.

---

## 🔴 BUGS (Will cause incorrect behavior)

### BUG-1: `sign-backfill` — DB left open on `getPublicKeyBytes()` / `publicKeyToDid()` throw

**File:** `cli.ts` ~line 5217–5219
```ts
const db = new Database(dbPath);          // ← DB opened
const pubKey = await getPublicKeyBytes(); // ← can throw (corrupted keypair file, decryption failure)
const did = publicKeyToDid(pubKey);       // ← can throw (invalid key length)
```

If `getPublicKeyBytes()` throws (corrupted `.keys/signing.enc`, wrong passphrase, etc.), the `db` handle is **never closed**. The error propagates to Commander's top-level handler, and the SQLite connection leaks.

Similarly for `publicKeyToDid()` — if the returned pubKey is somehow not 32 bytes (shouldn't happen but defense-in-depth), the DB leaks.

**Fix:** Wrap in try/finally, or move db open after the async crypto operations:
```ts
// Option A: Move DB open after crypto (preferred — no DB needed yet)
const pubKey = await getPublicKeyBytes();
const did = publicKeyToDid(pubKey);
const db = new Database(dbPath);

// Option B: try/finally
const db = new Database(dbPath);
try {
  const pubKey = await getPublicKeyBytes();
  const did = publicKeyToDid(pubKey);
  // ... rest of function
} finally {
  db.close();
}
```

**Severity:** Medium. In practice `hasSigningKeypair()` is checked first, so `getPublicKeyBytes()` rarely throws. But a corrupted keypair file would trigger this.

---

### BUG-2: `sign-backfill` — DB left open if signing loop throws unexpectedly

**File:** `cli.ts` ~lines 5258–5286

The main signing loop has individual `try/catch` blocks inside, but the outer loop and `db.transaction()()` call have **no** wrapping try/finally:

```ts
const BATCH_SIZE = 500;
for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    // ...
    db.transaction(() => {        // ← if this throws (e.g., SQLITE_BUSY, disk full)
        for (const s of signedBatch) {
            updateStmt.run(s.signature, did, s.id);
        }
    })();                          // ← DB never closed on throw
    // ...
}
db.close();  // ← unreachable if transaction throws
```

If `db.transaction(...)()` throws (disk full, database locked by another process, schema mismatch), the DB connection leaks and `db.close()` is never reached.

**Fix:** Wrap the entire post-`db = new Database()` block in `try/finally { db.close() }`.

**Severity:** Medium. Transaction failures are rare but real (concurrent daemon access, disk full).

---

### BUG-3: `merkle --save` signs the raw Merkle root, but the Merkle root is already a hash — inconsistent with memory signing format

**File:** `cli.ts` ~line 5413

```ts
if (did) {
    sig = await signContent(root);  // signs raw hex hash
}
```

The `root` value is a hex-encoded BLAKE2b hash. The signature is over that raw hex string. This is **technically correct** but **inconsistent** with how memory signatures work (which use `buildSignablePayload` with `contentHash|createdAt|signerDid` format).

There's no `signer_did` or `computed_at` bound into the signed content, so:
- A merkle root signature can be **replayed** — if the same set of memories produces the same root at a different time, the old signature validates for the new row.
- There's no identity binding — you can't prove *who* computed the root from the signature alone (the DID is stored alongside but not in the signed payload).

**Fix:**
```ts
const payload = `merkle|${root}|${rows.length}|${now}|${did}`;
sig = await signContent(payload);
```

**Severity:** Low-Medium. The root is stored with `signer_did` in the DB, so attribution works. But for on-chain anchoring, the signature should bind identity and time.

---

## 🟡 RESOURCE LEAKS

### LEAK-1: `verify-signatures` — DB left open on `didToPublicKey()` or `verifySignature()` exceptions escaping the catch

**File:** `cli.ts` ~lines 5338–5353

```ts
for (const row of rows) {
    try {
        const pubKey = didToPublicKey(row.signer_did);
        const payload = `${row.content_hash}|${row.created_at}|${row.signer_did}`;
        const isValid = await verifySignature(payload, row.signature, pubKey);
        // ...
    } catch {
        invalid++;
    }
}
db.close();
```

This is actually **OK** — the try/catch around each row is correct. But if an unrelated error occurs between `db = new Database()` (line 5311) and `db.close()` (line 5353) — for example, `parseInt(options.limit, 10)` somehow throwing, or a `db.prepare()` failing because the `signature` column doesn't exist (pre-migration DB) — the DB leaks.

**Specific pre-migration failure:** If the DB hasn't had migration 012 applied, `SELECT ... signature, signer_did FROM memories` will throw `SqliteError: no such column: signature`, and the DB is never closed.

**Fix:** All four memory commands should use try/finally for the DB handle:
```ts
const db = new Database(dbPath);
try {
    // ... all logic
} finally {
    db.close();
}
```

**Severity:** Medium for pre-migration scenario — a user with an old DB running `signet memory verify-signatures` will leak a connection and get an ugly stack trace.

---

### LEAK-2: `status` — Same pre-migration column issue

**File:** `cli.ts` ~line 5451

```ts
const signed = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE signature IS NOT NULL AND is_deleted = 0").get() as any)?.c ?? 0;
```

If `signature` column doesn't exist (pre-migration), this throws. The `db.close()` on line 5466 is never reached.

The `merkle_roots` query has a try/catch (good!), but the `signature` column query doesn't.

**Fix:** Either wrap everything in try/finally, or add a try/catch around the signed-count query with a fallback of 0.

---

## 🟠 HARDENING ISSUES

### HARD-1: `AGENTS_DIR` inconsistency between CLI and core

**CLI (`cli.ts` line 245):**
```ts
const AGENTS_DIR = join(homedir(), ".agents");  // IGNORES SIGNET_PATH env var
```

**Core (`crypto.ts` line 24, `did-setup.ts` line 20):**
```ts
const AGENTS_DIR = process.env.SIGNET_PATH || join(homedir(), ".agents");  // RESPECTS SIGNET_PATH
```

If a user sets `SIGNET_PATH` to a custom directory, the core crypto functions will look for keypairs in the custom path, but the CLI memory commands will look for `memories.db` in `~/.agents/memory/`. This means:
- `signet did init` generates keys in `$SIGNET_PATH/.keys/`
- `signet memory sign-backfill` looks for the DB in `~/.agents/memory/`
- The keypair and DB could be in completely different trees

**Fix:** CLI should respect `SIGNET_PATH`:
```ts
const AGENTS_DIR = process.env.SIGNET_PATH || join(homedir(), ".agents");
```

**Severity:** Low in practice (most users don't set SIGNET_PATH), but a correctness issue.

---

### HARD-2: `did show` imports `hasSigningKeypair` but never uses it

**File:** `cli.ts` ~line 5086

```ts
const { getConfiguredDid, hasSigningKeypair } = await import("@signet/core");
```

`hasSigningKeypair` is imported but never called. This is a dead import — no runtime impact but suggests an incomplete feature (was this meant to show keypair status?).

**Fix:** Remove unused import or add keypair existence check to the output.

---

### HARD-3: `did document` generates a DID Document from `getConfiguredDid()` but doesn't verify the keypair still matches

**File:** `cli.ts` ~lines 5103–5127

```ts
const did = getConfiguredDid();
// ...
const publicKey = didToPublicKey(did);
const doc = generateDidDocument(did, publicKey);
```

This extracts the public key from the DID string itself (pure math, no keypair file involved). If the keypair file has been rotated/deleted but `agent.yaml` still has the old DID, this will happily generate a DID Document for a key the agent can no longer sign with.

This isn't necessarily wrong (DID Documents are static descriptions), but it could be confusing. Consider adding a warning if `hasSigningKeypair()` is false or if the keypair-derived DID doesn't match.

---

### HARD-4: `did verify` — no try/catch around the main body

**File:** `cli.ts` ~lines 5129–5184

The `did verify` command has no top-level error handler. If `getPublicKeyBytes()` throws (keypair decryption failure), the error propagates as an unhandled rejection with a raw stack trace instead of a user-friendly message.

Compare with `did init` which has `try/catch` around the whole operation. `did verify` should do the same.

---

### HARD-5: `sign-backfill` doesn't use `buildSignablePayload` from memory-signing.ts

**File:** `cli.ts` ~line 5272

```ts
const payload = `${row.content_hash}|${row.created_at}|${did}`;
```

**File:** `memory-signing.ts` ~line 96:
```ts
return `${contentHash}|${createdAt}|${signerDid}`;
```

The format is **identical** — this is correct. But `sign-backfill` inline-constructs the payload instead of calling `buildSignablePayload()`. This means:
- The input validation in `buildSignablePayload` (hex check, pipe-in-fields check) is only partially replicated (hex check exists, pipe check is missing)
- If the payload format ever changes in `buildSignablePayload`, the backfill command will produce signatures in the old format

**Fix:** Import and use `buildSignablePayload` from `@signet/daemon` (or move it to `@signet/core`):
```ts
const payload = buildSignablePayload(row.content_hash, row.created_at, did);
```

This would also add the `createdAt.includes("|")` validation that's currently missing in the backfill path.

---

### HARD-6: `merkle` double-hashes content hashes unnecessarily

**File:** `cli.ts` ~lines 5396–5399

```ts
for (const row of rows) {
    leafHashes.push(await hashContent(row.content_hash));  // hash of a hash
}
```

`content_hash` is already a SHA-256 hash stored in the DB. The code then hashes it again with BLAKE2b before feeding it to the Merkle tree. This is intentional (comment says "for consistent Merkle leaves") and **not a bug**, but it means:
- The leaf hashes stored in `merkle_roots.leaf_hashes` are BLAKE2b(content_hash), not the content hashes themselves
- Any external verifier needs to know about this double-hashing

This is fine as long as it's documented. Just flagging for awareness.

---

## ✅ THINGS THAT ARE CORRECT (verified)

1. **Payload format consistency**: `sign-backfill` uses `contentHash|createdAt|did` — identical to `buildSignablePayload`. ✓
2. **`verify-signatures` payload reconstruction**: Uses the same `contentHash|createdAt|signerDid` format as signing. ✓
3. **`verify-signatures` uses `didToPublicKey(row.signer_did)`**: Correctly extracts the public key from each memory's stored DID, not the agent's current key. This means it can verify memories signed by different agents. ✓
4. **`did init` is idempotent**: `initializeAgentDid()` checks for existing keypair and DID, skips if present. ✓
5. **`did init` detects DID mismatch**: If agent.yaml has a different DID than the keypair derives, it throws a clear error. ✓
6. **`did verify` sign/verify round-trip**: Tests actual cryptographic operations end-to-end. ✓
7. **`sign-backfill` batched transactions**: Correctly separates async signing (outside transaction) from synchronous DB writes (inside transaction). ✓
8. **`sign-backfill` hex validation**: Validates `content_hash` is hex-only before signing. ✓
9. **`status` handles missing `merkle_roots` table**: Wrapped in try/catch. ✓
10. **`status` closes DB before doing non-DB work**: DB is closed at line 5466, then identity info is fetched. ✓
11. **All async functions are properly async**: Every `await` is inside an `async` action handler. No fire-and-forget promises. ✓
12. **`did-setup.ts` is clean**: Proper error handling, DID mismatch detection, yaml safety. ✓
13. **`memory-signing.ts` caching is thread-safe enough**: Single-threaded Node.js, TTL-based cache invalidation. ✓
14. **`verifyMemorySignature` catches all errors**: Returns false on any exception. ✓
15. **`signEnvelope` doesn't mutate input**: Creates a new object with spread. ✓

---

## 📋 RECOMMENDED FIXES (Priority Order)

| # | Issue | Severity | Effort |
|---|-------|----------|--------|
| 1 | LEAK-1/LEAK-2: Add try/finally around all DB handles in all 4 memory commands | Medium | 30 min |
| 2 | BUG-1/BUG-2: Move `sign-backfill` DB open after crypto ops, add try/finally | Medium | 15 min |
| 3 | HARD-1: CLI should respect `SIGNET_PATH` env var | Low-Med | 5 min |
| 4 | HARD-5: Use `buildSignablePayload` in `sign-backfill` (single source of truth) | Low-Med | 10 min |
| 5 | BUG-3: Bind identity + timestamp into merkle root signature | Low-Med | 10 min |
| 6 | HARD-4: Add try/catch to `did verify` for user-friendly errors | Low | 10 min |
| 7 | HARD-2: Remove dead `hasSigningKeypair` import in `did show` | Trivial | 1 min |
| 8 | HARD-3: Add warning in `did document` if keypair is missing/mismatched | Low | 5 min |

---

## Concrete Fix: try/finally pattern for all memory commands

The single highest-impact fix is wrapping all 4 memory commands with try/finally. Here's the pattern:

```ts
const db = new Database(dbPath);
try {
    // ... all command logic ...
} finally {
    db.close();
}
```

Remove all other `db.close()` calls inside the try block (early returns become just `return` since `finally` handles cleanup).

This fixes BUG-1, BUG-2, LEAK-1, LEAK-2 in one pass and is the standard resource management pattern.
