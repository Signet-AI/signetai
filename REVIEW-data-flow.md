# Data Flow Review: Memory Creation → Signing → Storage → Verification

**Reviewer:** Systems Integration Engineer (Claude)  
**Date:** 2025-07-15  
**Scope:** Full trace of every path a memory takes, with scenario analysis

---

## 1. Architecture Overview

```
User/Agent
    │
    ▼
POST /api/memory/remember  (daemon.ts:1819)
    │
    ├─ Parse body, normalize content, build IngestEnvelope
    │
    ▼
signEnvelope(envelope)     (memory-signing.ts:100)
    │
    ├─ isSigningAvailable()  → hasSigningKeypair() [60s TTL cache]
    ├─ isAutoSignEnabled()   → reads agent.yaml signing.autoSign
    ├─ getAgentDid()         → loads keypair → derives DID (cached forever)
    ├─ buildSignablePayload  → "contentHash|createdAt|signerDid"
    └─ signContent(payload)  → Ed25519 detached sig → base64
    │
    ▼
withWriteTx → txIngestEnvelope(db, signedEnvelope)  (transactions.ts:215)
    │
    ├─ INSERT INTO memories (22 columns including signature, signer_did)
    └─ Return memory ID
```

---

## 2. All Memory Creation Paths

### Path A: `/api/memory/remember` handler (daemon.ts:1819)
- **Signs:** ✅ Yes — calls `signEnvelope()` before DB write
- **Dedupe:** content_hash + sourceId checked inside write tx
- **Fields mapped:** All 22 columns explicitly set

### Path B: Pipeline v2 worker — new fact insertion (worker.ts:479)
- **Signs:** ❌ **NO** — calls `txIngestEnvelope()` directly, no `signEnvelope()`
- **Impact:** Pipeline-extracted facts are always unsigned
- **Missing fields in envelope:** `signature` and `signerDid` not set → defaults to `null`
- **Assessment:** Intentional design? Pipeline facts are derived, not human-authored. But this means only ~manual memories get signatures.

### Path C: Pipeline v2 worker — entity-to-memory (worker.ts:595+ area)
- **Signs:** ❌ **NO** — same pattern as Path B
- **Assessment:** Same as above.

### Path D: Document worker — chunk ingestion (document-worker.ts:331)
- **Signs:** ❌ **NO** — direct `txIngestEnvelope()` inside write tx
- **Assessment:** Document chunks are unsigned. Consistent with Path B/C.

### Summary Table

| Entry Point | Signs? | Source |
|---|---|---|
| POST /api/memory/remember | ✅ | daemon.ts:1908 |
| Pipeline v2 fact extraction | ❌ | worker.ts:479 |
| Pipeline v2 entity promotion | ❌ | worker.ts:~595 |
| Document chunk ingestion | ❌ | document-worker.ts:331 |

> **Finding 1:** Only the manual `/api/memory/remember` path signs memories. All autonomous paths skip signing. This is a design decision but should be documented — `verify-signatures` will only ever find memories created via the HTTP API.

---

## 3. Scenario A: Happy Path

**Flow:** `POST /api/memory/remember → signEnvelope → txIngestEnvelope → DB`

### Step-by-step trace

1. **HTTP Parse** (daemon.ts:1819-1862)
   - `body.content` → `parsePrefixes()` → `normalizeAndHashContent()` 
   - Produces: `storageContent`, `normalizedContent`, `hashBasis`, `contentHash` (SHA-256 of lowercase normalized)

2. **Envelope Construction** (daemon.ts:1884-1907)
   ```
   envelope = {
     id: UUID, content: storageContent, normalizedContent: normalizedContentForInsert,
     contentHash, who, why, project, importance, type, tags, pinned,
     isDeleted: 0, extractionStatus, embeddingModel: null, extractionModel,
     updatedBy: who, sourceType, sourceId, createdAt: now
   }
   ```
   - Note: `signature` and `signerDid` **not set** on initial envelope (they're optional in the type)

3. **Signing** (memory-signing.ts:100-130)
   - `isSigningAvailable()` → checks `existsSync(SIGNING_KEY_FILE)` with 60s TTL cache
   - `isAutoSignEnabled()` → reads `agent.yaml` → `signing.autoSign === true` (no cache — reads file every call!)
   - `getAgentDid()` → loads keypair → derives DID from public key (cached forever after first success)
   - `buildSignablePayload(contentHash, createdAt, signerDid)` → `"<sha256hex>|<ISO8601>|<did:key:z6Mk...>"`
     - Validates: contentHash is lowercase hex, no `|` in createdAt or signerDid
   - `signContent(payload)` → `crypto_sign_detached(UTF8(payload), privateKey)` → base64
   - Returns `{ ...envelope, signerDid: did, signature: base64sig }`

4. **DB Insert** (transactions.ts:215-250)
   - 22-column INSERT into `memories` table
   - Column order matches envelope fields exactly

### Field Mapping Verification

| Envelope Field | DB Column | Match? |
|---|---|---|
| `id` | `id` | ✅ |
| `content` | `content` | ✅ |
| `normalizedContent` | `normalized_content` | ✅ (falls back to `content`) |
| `contentHash` | `content_hash` | ✅ |
| `who` | `who` | ✅ |
| `why` | `why` | ✅ |
| `project` | `project` | ✅ |
| `importance` | `importance` | ✅ |
| `type` | `type` | ✅ |
| `tags` | `tags` | ✅ |
| `pinned` | `pinned` | ✅ |
| `isDeleted` | `is_deleted` | ✅ (defaults to 0) |
| `extractionStatus` | `extraction_status` | ✅ (defaults to "none") |
| `embeddingModel` | `embedding_model` | ✅ |
| `extractionModel` | `extraction_model` | ✅ |
| `createdAt` | `created_at` | ✅ |
| `createdAt` | `updated_at` | ✅ (same value) |
| `updatedBy` | `updated_by` | ✅ (falls back to `who`) |
| `sourceType` | `source_type` | ✅ |
| `sourceId` | `source_id` | ✅ |
| `signature` | `signature` | ✅ (nullable) |
| `signerDid` | `signer_did` | ✅ (nullable) |

> **Finding 2:** ✅ All 22 fields map correctly from HTTP → envelope → DB. No mismatches.

### Missing from `IngestEnvelope` but in DB schema:
- `category` — never set during ingest (defaults to NULL)
- `confidence` — never set (defaults to 1.0 from migration 001)
- `vector_clock` — never set (defaults to `'{}'`)
- `version` — never set (defaults to 1)
- `manual_override` — never set (defaults to 0)
- `update_count` — never set (defaults to 0)
- `access_count` — never set (defaults to 0)
- `last_accessed` — never set
- `deleted_at` — never set

These are all handled by SQLite DEFAULT values or managed by separate transaction functions. ✅ Correct.

---

## 4. Scenario B: No Keypair (signing.enc doesn't exist)

### Trace

1. `signEnvelope(envelope)` called
2. `isSigningAvailable()` → `hasSigningKeypair()` → `existsSync("~/.agents/.keys/signing.enc")` → **false**
3. `_signingAvailable = false`, cached for 60s
4. Returns `envelope` unchanged (no signature, no signerDid)
5. `txIngestEnvelope()` runs — `signature` and `signerDid` both `undefined` → `null` in SQL via `?? null`

> **Finding 3:** ✅ Graceful degradation works perfectly. The `?? null` fallback in `txIngestEnvelope` handles the undefined → NULL mapping correctly.

### Edge case: `isAutoSignEnabled()` 
- Even if a keypair existed, `isAutoSignEnabled()` reads `agent.yaml` and checks `signing.autoSign === true`
- If `agent.yaml` doesn't exist or `signing.autoSign` is missing/false → returns false → signing skipped
- **No cache** on this check — reads the YAML file on every call

> **Finding 4 (Minor Perf):** `isAutoSignEnabled()` reads and parses `agent.yaml` from disk on every memory creation. Unlike `isSigningAvailable()` which has a 60s TTL cache, this hits the filesystem every time. For high-throughput scenarios this is suboptimal but not a bug — YAML files are tiny and OS-cached.

---

## 5. Scenario C: Key Created Mid-Process

**Setup:** Daemon running with no keypair → user runs `signet did init` → creates memory

### Trace

1. **Before `signet did init`:**
   - `isSigningAvailable()` returns `false` (cached)
   - `_signingCheckedAt` = timestamp of last check
   - `_signingAvailable` = `false`

2. **User runs `signet did init`** (did-setup.ts):
   - `initializeAgentDid()` → `generateSigningKeypair()` → writes `signing.enc`
   - Updates `agent.yaml` with `did` and `signing: { autoSign: true }`
   - Writes `did.json`
   - **Does NOT notify the daemon** — no IPC, no signal, no cache invalidation

3. **Memory created within 60s of last check:**
   - `isSigningAvailable()` → cache hit → still `false` → **signing skipped** ❌
   - Memory stored unsigned despite keypair existing

4. **Memory created after 60s TTL expires:**
   - `isSigningAvailable()` → cache expired → re-checks `existsSync()` → `true`
   - `_signingAvailable = true`
   - `isAutoSignEnabled()` → reads `agent.yaml` → `signing.autoSign === true` ✅
   - `getAgentDid()` → `_cachedDid` is null → loads keypair → derives DID → caches forever
   - Memory signed correctly ✅

### Does the 60s TTL cache actually work?

> **Finding 5:** The 60s TTL cache **does work as designed** — it re-polls `existsSync()` every 60s. However, there's a worst-case 60s window where memories created right after `signet did init` will be unsigned. This is a documented trade-off.

### Subtle issue: `_cachedDid` has NO TTL

- `_cachedDid` in `memory-signing.ts:28` is cached **forever** (no expiry, no TTL)
- If a key is somehow rotated (delete + regenerate), `_cachedDid` would still hold the old DID
- `resetSigningCache()` exists but is **never called** from `did-setup.ts`

> **Finding 6 (Bug):** `initializeAgentDid()` in `did-setup.ts` does NOT call `resetSigningCache()` after generating a keypair. If `signet did init` runs in the same process as the daemon (unlikely but possible via programmatic API), the DID cache would be stale. In practice this is a non-issue because `signet did init` runs as a CLI process (separate from daemon), but the cache design is fragile.

### Another subtlety: crypto.ts `_cachedKeypair` is also forever-cached

- `ensureKeypair()` in `crypto.ts` caches the decrypted keypair forever
- If the daemon process loads the keypair, it never re-reads from disk
- Key rotation would require daemon restart

> **Finding 7:** Key rotation requires daemon restart. The `clearCachedKeypair()` function exists but is only called on process exit signals. No hot-reload path exists.

---

## 6. Scenario D: Verification Round-Trip

**Flow:** Memory signed and stored → later verified via `signet memory verify-signatures`

### Signing (at creation time):
```
payload = buildSignablePayload(contentHash, createdAt, signerDid)
       = "${contentHash}|${createdAt}|${signerDid}"
signature = base64(crypto_sign_detached(UTF8(payload), privateKey))
```

Stored in DB:
- `content_hash` = contentHash (SHA-256 hex of normalized lowercase content)
- `created_at` = createdAt (ISO-8601)
- `signer_did` = signerDid (did:key:z6Mk...)
- `signature` = base64 signature

### Verification (cli.ts:5294):
```typescript
const payload = `${row.content_hash}|${row.created_at}|${row.signer_did}`;
const pubKey = didToPublicKey(row.signer_did);
const isValid = await verifySignature(payload, row.signature, pubKey);
```

### Does the payload reconstruction match exactly?

**Signing path (memory-signing.ts):**
```typescript
buildSignablePayload(envelope.contentHash, envelope.createdAt, did)
// = `${contentHash}|${createdAt}|${signerDid}`
```

**Verification path (cli.ts):**
```typescript
`${row.content_hash}|${row.created_at}|${row.signer_did}`
```

> **Finding 8:** ✅ The payload reconstruction is **identical**. Both use `contentHash|createdAt|signerDid` with pipe delimiters. The CLI reads the exact same columns that were written.

### But wait — the CLI does NOT use `buildSignablePayload()`!

The CLI reconstructs the payload inline:
```typescript
const payload = `${row.content_hash}|${row.created_at}|${row.signer_did}`;
```

While `memory-signing.ts` uses:
```typescript
buildSignablePayload(contentHash, createdAt, signerDid)
```

Which includes validation:
- `contentHash` must be lowercase hex (`/^[0-9a-f]+$/`)
- `createdAt` and `signerDid` must not contain `|`

> **Finding 9 (Code Quality):** The CLI verification path **bypasses `buildSignablePayload()` validation** and manually constructs the same string. If the payload format ever changes in `buildSignablePayload()`, the CLI would silently produce wrong payloads. **Recommendation:** Import and use `buildSignablePayload()` in the CLI, or at minimum extract a shared `buildPayloadString()` utility.

### DID → PublicKey round-trip:

- **At signing:** `publicKeyToDid(rawPubKey)` → `did:key:z6Mk...` (multibase + multicodec Ed25519 prefix)
- **At verification:** `didToPublicKey("did:key:z6Mk...")` → raw 32-byte Ed25519 public key
- Both use the standard `did:key` multicodec encoding (`0xed01` prefix for Ed25519)

> **Finding 10:** ✅ DID encoding/decoding is symmetric and standards-compliant. Round-trip is correct.

### `verifySignature()` trace (crypto.ts):
```typescript
const message = new TextEncoder().encode(content);  // UTF-8
const sigBytes = sodium.from_base64(signature, ORIGINAL);
return sodium.crypto_sign_verify_detached(sigBytes, message, publicKey);
```

This matches `signContent()`:
```typescript
const message = new TextEncoder().encode(content);  // UTF-8
const signature = sodium.crypto_sign_detached(message, kp.privateKey);
return sodium.to_base64(signature, ORIGINAL);
```

> **Finding 11:** ✅ Sign and verify are symmetric. Same encoding (UTF-8), same base64 variant (ORIGINAL), same libsodium primitives.

---

## 7. Scenario E: Migration 012 on Existing DB

### What migration 012 does:
1. `ALTER TABLE memories ADD COLUMN signature TEXT` (if not exists)
2. `ALTER TABLE memories ADD COLUMN signer_did TEXT` (if not exists)
3. `CREATE TABLE IF NOT EXISTS merkle_roots` (7 columns + indexes)
4. `CREATE INDEX idx_memories_signer_did ON memories(signer_did)`

### Impact on existing queries:

**The critical question:** Do any `SELECT *` queries break?

SQLite `ALTER TABLE ADD COLUMN` sets the default value to `NULL` for all existing rows. This means:

- Existing 10K memories → `signature = NULL`, `signer_did = NULL`
- Any `SELECT *` now returns 2 more columns
- Any INSERT that doesn't specify `signature`/`signer_did` → gets NULL

### Checking for `SELECT *` usage:

The `txIngestEnvelope` function uses an explicit column list:
```sql
INSERT INTO memories (id, content, normalized_content, ..., signature, signer_did)
VALUES (?, ?, ?, ..., ?, ?)
```
✅ Not affected by column additions.

The `txModifyMemory` and `txForgetMemory` functions use explicit `SELECT id, content, ...` queries — ✅ not affected.

### Potential issues:

1. **Type interface mismatch:** The `Memory` interface in `types.ts` has `signature?: string` and `signerDid?: string` as optional. ✅ Correct — existing code that doesn't handle these fields won't break.

2. **Index cost:** `idx_memories_signer_did` on 10K rows with all NULLs — negligible cost. SQLite handles sparse indexes well.

3. **FTS triggers:** The `memories_ai AFTER INSERT` trigger (from migration 001/004) fires on INSERT — it only indexes `content`, not `signature`/`signer_did`. ✅ Not affected.

> **Finding 12:** ✅ Migration 012 is safe on existing databases. `ALTER TABLE ADD COLUMN` with NULL default is non-destructive. No `SELECT *` in critical paths. All INSERT statements use explicit column lists.

---

## 8. Types vs DB Schema Comparison

### `IngestEnvelope` (transactions.ts) vs DB columns

| IngestEnvelope | DB Column | Type Match? |
|---|---|---|
| `id: string` | `id TEXT PK` | ✅ |
| `content: string` | `content TEXT NOT NULL` | ✅ |
| `normalizedContent?: string \| null` | `normalized_content TEXT` | ✅ |
| `contentHash: string` | `content_hash TEXT` | ✅ |
| `who: string` | `who TEXT` | ✅ |
| `why: string \| null` | `why TEXT` | ✅ |
| `project: string \| null` | `project TEXT` | ✅ |
| `importance: number` | `importance REAL` | ✅ |
| `type: string` | `type TEXT NOT NULL` | ✅ |
| `tags: string \| null` | `tags TEXT` | ✅ |
| `pinned: number` | `pinned INTEGER` | ✅ |
| `isDeleted?: number` | `is_deleted INTEGER DEFAULT 0` | ✅ |
| `extractionStatus?: string` | `extraction_status TEXT DEFAULT 'none'` | ✅ |
| `embeddingModel?: string \| null` | `embedding_model TEXT` | ✅ |
| `extractionModel?: string \| null` | `extraction_model TEXT` | ✅ |
| `updatedBy?: string` | `updated_by TEXT NOT NULL` | ✅ |
| `sourceType: string` | `source_type TEXT` | ✅ |
| `sourceId: string \| null` | `source_id TEXT` | ✅ |
| `createdAt: string` | `created_at TEXT NOT NULL` | ✅ |
| `signature?: string \| null` | `signature TEXT` | ✅ |
| `signerDid?: string \| null` | `signer_did TEXT` | ✅ |

### `Memory` interface (types.ts) vs DB schema

| Memory Field | DB Column | Issue? |
|---|---|---|
| `confidence: number` | `confidence REAL DEFAULT 1.0` | ⚠️ `IngestEnvelope` never sets this — always 1.0 |
| `category?: string` | `category TEXT` | ⚠️ Never set during ingest |
| `vectorClock: Record<string, number>` | `vector_clock TEXT DEFAULT '{}'` | ⚠️ Never set during ingest |
| `manualOverride: boolean` | `manual_override INTEGER DEFAULT 0` | ⚠️ Never set during ingest |
| `tags: string[]` | `tags TEXT` | ⚠️ **Type mismatch**: TS says `string[]` but DB stores comma-separated string |

> **Finding 13 (Type Mismatch):** The `Memory.tags` field is typed as `string[]` but the DB stores tags as a comma-separated `TEXT` string. The `IngestEnvelope.tags` is correctly typed as `string | null`. This means code reading memories via the `Memory` interface needs to split the string — a deserialization step that's easy to forget.

> **Finding 14:** The `Memory` interface includes several legacy fields (`confidence`, `category`, `vectorClock`, `manualOverride`) that are never populated by the current ingest path. These are vestiges of v1 and maintained for backward compatibility. Not a bug, but the interface is over-specified relative to what the system actually uses.

---

## 9. Summary of Findings

### 🔴 Issues (Action Required)

| # | Severity | Finding |
|---|---|---|
| 9 | **Medium** | CLI `verify-signatures` manually reconstructs signing payload instead of using `buildSignablePayload()`. Fragile — format changes would silently break verification. |
| 13 | **Medium** | `Memory.tags` typed as `string[]` but DB stores `string \| null`. Type lie can cause runtime bugs in consumers. |

### 🟡 Design Notes (Acceptable but worth documenting)

| # | Severity | Finding |
|---|---|---|
| 1 | **Info** | Only HTTP API path signs memories; pipeline/document paths are unsigned. By design, but should be documented. |
| 4 | **Low** | `isAutoSignEnabled()` reads `agent.yaml` from disk on every call (no cache). Minor perf concern at high throughput. |
| 5 | **Info** | 60s TTL on signing availability means up to 60s of unsigned memories after `signet did init`. |
| 6 | **Low** | `initializeAgentDid()` doesn't call `resetSigningCache()`. Non-issue in practice (separate processes). |
| 7 | **Info** | Key rotation requires daemon restart. No hot-reload path. |
| 14 | **Low** | `Memory` interface has legacy v1 fields never populated by current ingest. |

### ✅ Verified Correct

| # | Finding |
|---|---|
| 2 | All 22 fields map correctly from HTTP → envelope → DB |
| 3 | Graceful degradation when no keypair exists |
| 8 | Payload reconstruction in verification matches signing exactly |
| 10 | DID encoding/decoding round-trip is correct |
| 11 | Sign/verify use symmetric encoding and crypto primitives |
| 12 | Migration 012 is safe on existing databases |

---

## 10. Recommended Fixes

### Fix 1: Use `buildSignablePayload()` in CLI verification (Finding 9)

```typescript
// cli.ts — verify-signatures command
// BEFORE:
const payload = `${row.content_hash}|${row.created_at}|${row.signer_did}`;

// AFTER:
import { buildSignablePayload } from "@signet/daemon/memory-signing";
// or re-export from @signet/core
const payload = buildSignablePayload(row.content_hash, row.created_at, row.signer_did);
```

Better yet, move `buildSignablePayload` to `@signet/core` so both daemon and CLI can import it without cross-package dependency issues.

### Fix 2: Fix `Memory.tags` type (Finding 13)

```typescript
// types.ts
export interface Memory {
  // ...
  tags: string | null;  // Was: string[] — but DB stores comma-separated text
  // ...
}
```

Or add a serialization layer that converts between `string` and `string[]` at the DB boundary.

### Fix 3 (Optional): Cache `isAutoSignEnabled()` (Finding 4)

```typescript
// memory-signing.ts — add TTL cache similar to isSigningAvailable()
let _autoSignEnabled: boolean | null = null;
let _autoSignCheckedAt = 0;

function isAutoSignEnabledCached(): boolean {
  const now = Date.now();
  if (_autoSignEnabled !== null && now - _autoSignCheckedAt < SIGNING_CACHE_TTL_MS) {
    return _autoSignEnabled;
  }
  _autoSignEnabled = isAutoSignEnabled();
  _autoSignCheckedAt = now;
  return _autoSignEnabled;
}
```
