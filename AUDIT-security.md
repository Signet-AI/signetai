# Security & Cryptography Audit

**Auditor:** Subagent (Security & Cryptography Zone)
**Date:** 2025-07-17
**Branch:** web3-identity
**Scope:** `packages/core/src/crypto.ts`, `packages/core/src/did-setup.ts`, `packages/core/src/chain/wallet.ts`, `packages/core/src/chain/session-keys.ts`, `packages/core/src/chain/payments.ts`

## Summary

**19 issues found: 3 critical, 6 high, 7 medium, 3 low**

---

## Issues

### [CRITICAL-1] Wallet encryption uses getMasterKey() without salt for v2/v3 — will always fail or use wrong key

**File:** `packages/core/src/chain/wallet.ts:36-40` (encryptPrivateKey) and `:55-58` (decryptPrivateKey)

**Description:**
Both `encryptPrivateKey()` and `decryptPrivateKey()` in wallet.ts call `getMasterKey(kdfVersion)` **without passing the salt**. For KDF v2 and v3, Argon2id requires a 16-byte salt. The `getMasterKey()` function in crypto.ts validates `salt.length` and will **throw an error** if salt is missing or wrong length for v2/v3:

```typescript
// wallet.ts line ~38 — NO SALT PASSED
const masterKey = await getMasterKey(kdfVersion);
```

This means:
- On KDF v1 (legacy BLAKE2b): works accidentally, since v1 ignores salt.
- On KDF v2/v3 (Argon2id): **throws** `"Argon2id requires a 16-byte salt, got 0 bytes"` — wallet encryption/decryption is completely broken for any user who has upgraded to v2 or v3 key derivation.

Additionally, `getKeypairKdfVersion()` returns the *signing keypair's* KDF version, but the wallet doesn't read or store its *own* salt. Even if salt were passed, the wallet would need to store which salt was used for its own encryption, separately from the signing keypair.

**Fix:**
The wallet needs to either (a) read the salt from the signing keypair file (coupling it to the signing key's salt), or (b) store its own salt alongside the encrypted key. Option (a) is simpler:

```typescript
import { readFileSync } from "fs";
import { join } from "path";
import { resolveAgentsDir } from "../crypto";

function getSigningKeypairSalt(): Uint8Array | undefined {
    const keysDir = join(resolveAgentsDir(), ".keys");
    const signingFile = join(keysDir, "signing.enc");
    try {
        const stored = JSON.parse(readFileSync(signingFile, "utf-8"));
        if (stored.salt) {
            return sodium.from_base64(stored.salt, sodium.base64_variants.ORIGINAL);
        }
    } catch { /* no keypair yet */ }
    return undefined;
}

async function encryptPrivateKey(privateKey: string): Promise<string> {
    await sodium.ready;
    const kdfVersion = getKeypairKdfVersion() ?? 1;
    const salt = getSigningKeypairSalt();
    const masterKey = await getMasterKey(kdfVersion, salt);
    // ... rest unchanged
}
```

Better long-term fix: export a `getMasterKeyForCurrentKeypair()` convenience from `crypto.ts` that encapsulates reading the version + salt internally.

---

### [CRITICAL-2] Session key encryption has the same missing-salt bug as wallet.ts

**File:** `packages/core/src/chain/session-keys.ts:71-74` (encryptPrivateKey) and `:89-92` (decryptPrivateKey)

**Description:**
Identical to CRITICAL-1. Session key encrypt/decrypt calls `getMasterKey(kdfVersion)` without the salt parameter. Broken for v2/v3 KDF:

```typescript
const masterKey = await getMasterKey(kdfVersion); // no salt!
```

This means session keys cannot be created or loaded on any installation using passphrase-based (v3) or Argon2id (v2) key derivation — which is the *recommended* path.

**Fix:** Same as CRITICAL-1 — pass the salt from the signing keypair file, or export a convenience function from crypto.ts.

---

### [CRITICAL-3] Payment header has no replay protection — nonce is not tracked

**File:** `packages/core/src/chain/payments.ts:135-173` (verifyPaymentHeader)

**Description:**
The `verifyPaymentHeader()` function generates and validates a nonce, but **never checks if the nonce was previously seen**. There is no nonce storage or lookup. The only freshness check is a 5-minute timestamp window.

This means a valid payment header can be **replayed** any number of times within the 5-minute window. An attacker who intercepts a single x402 header can replay it to drain the payer's session key up to the daily spend limit:

```typescript
// Line ~165: Timestamp check exists, but nonces are never stored/checked
const maxAgeMs = 5 * 60 * 1000;
if (Math.abs(now - headerTime) > maxAgeMs) { ... }
// NO: "if nonce was already used, reject"
```

**Fix:**
Add a `payment_nonces` table (or in-memory set with TTL) and check/store nonces during verification:

```typescript
// Add to DB schema:
// CREATE TABLE IF NOT EXISTS payment_nonces (
//   nonce TEXT PRIMARY KEY,
//   expires_at TEXT NOT NULL
// );

export function verifyPaymentHeader(
    headerValue: string,
    expectedAmount?: string,
    db?: ChainDb,  // Add DB parameter for nonce tracking
): { valid: boolean; header?: PaymentHeader; reason?: string } {
    // ... existing validation ...

    // After timestamp check, before signature verification:
    if (db) {
        // Clean expired nonces
        db.prepare("DELETE FROM payment_nonces WHERE expires_at < ?")
            .run(new Date().toISOString());

        // Check for replay
        const existing = db.prepare("SELECT nonce FROM payment_nonces WHERE nonce = ?")
            .get(header.nonce);
        if (existing) {
            return { valid: false, reason: "Nonce already used — possible replay attack" };
        }

        // Store nonce with expiry
        const expiresAt = new Date(Date.now() + maxAgeMs).toISOString();
        db.prepare("INSERT INTO payment_nonces (nonce, expires_at) VALUES (?, ?)")
            .run(header.nonce, expiresAt);
    }

    // ... signature verification ...
}
```

---

### [HIGH-1] Master key cache is keyed without passphrase — different passphrases return cached key from first call

**File:** `packages/core/src/crypto.ts:196` (getMasterKeyV3)

**Description:**
The v3 master key cache uses `v3:${base64(salt)}` as the cache key, but does **not** include any derivative of the passphrase. This means:

1. First call with passphrase "correct-horse" → derives key, caches as `v3:<salt>`.
2. Second call with passphrase "wrong-password" → cache hit on `v3:<salt>`, returns the key derived from "correct-horse".

During `reEncryptKeypair()` for v3→v3 migration, the old passphrase is used to decrypt, then the new passphrase is used to encrypt. Both calls use the same salt (the old salt for decrypt, a new salt for encrypt), so the new salt avoids this bug in the migration path. However, in any other scenario where `getMasterKeyV3` is called twice with the same salt but different passphrases (e.g., a retry after mistyping), the wrong cached key would be returned silently.

**Fix:**
Include a hash of the passphrase in the cache key (don't put the raw passphrase in the key — hash it):

```typescript
async function getMasterKeyV3(salt: Uint8Array, passphrase: string): Promise<Uint8Array> {
    // Hash the passphrase for cache keying (not for security — just uniqueness)
    const ppHash = sodium.crypto_generichash(16, new TextEncoder().encode(passphrase));
    const cacheKey = `v3:${sodium.to_base64(salt, sodium.base64_variants.ORIGINAL)}:${sodium.to_base64(ppHash, sodium.base64_variants.ORIGINAL)}`;
    const cached = _masterKeyCache.get(cacheKey);
    if (cached) return new Uint8Array(cached);
    // ... rest unchanged
}
```

---

### [HIGH-2] Wallet private key is not zeroed after use in loadWallet()

**File:** `packages/core/src/chain/wallet.ts:110-120` (loadWallet)

**Description:**
After decrypting the wallet private key, it's passed to `new ethers.Wallet(privateKey)` and then the string variable `privateKey` is left in memory. JavaScript strings are immutable and cannot be zeroed. The decrypted hex private key string will persist in the V8 heap until garbage collected.

The `decryptPrivateKey` function returns a string (via `TextDecoder`), and this string contains the raw hex private key. There's no way to securely wipe a JS string.

**Fix:**
This is a fundamental limitation of JavaScript/ethers.js. Mitigations:
1. Minimize the window — don't store the wallet; load, use, and discard in the tightest scope possible.
2. Document the limitation clearly.
3. Consider storing the raw bytes instead of hex string in the encrypted blob, and using a lower-level API if ethers supports it.

```typescript
// At minimum, null out the reference ASAP:
export async function loadWallet(db: ChainDb, chain: string = DEFAULT_CHAIN, rpcUrl?: string): Promise<ethers.Wallet> {
    // ... existing code ...
    let privateKey: string | null = await decryptPrivateKey(row.encrypted_key);
    let wallet = new ethers.Wallet(privateKey);
    privateKey = null; // Allow GC to collect sooner (not a guarantee)
    // ...
}
```

---

### [HIGH-3] ID generation uses Math.random() — predictable identifiers

**File:** `packages/core/src/chain/wallet.ts:15`, `packages/core/src/chain/session-keys.ts:56`, `packages/core/src/chain/payments.ts:66`

**Description:**
All three files use the same pattern for generating IDs:

```typescript
function generateId(): string {
    return `wallet_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
```

`Math.random()` is not cryptographically secure. The V8 engine uses xorshift128+, which is predictable if an attacker observes a few outputs. While these are database IDs and not cryptographic keys, predictable IDs in a payment system create risks:
- An attacker could predict future session key IDs and pre-craft requests.
- The `Date.now()` component reduces entropy further (millisecond precision, often guessable).

**Fix:**
Use `crypto.randomBytes` or `ethers.randomBytes` (already imported in payments.ts):

```typescript
import { randomBytes } from "crypto";

function generateId(prefix: string): string {
    return `${prefix}_${randomBytes(16).toString("hex")}`;
}
```

---

### [HIGH-4] Daily spend tracking uses string ISO timestamps with lexicographic comparison — timezone and precision issues

**File:** `packages/core/src/chain/payments.ts:288-300` (getDailySpend) and `:310-322` (getDailyTransactionCount)

**Description:**
The daily spend calculation constructs a "today start" timestamp:

```typescript
const todayStart = new Date();
todayStart.setUTCHours(0, 0, 0, 0);
// Then: AND created_at >= ?
```

The `created_at` field stores ISO-8601 strings. SQLite compares these lexicographically, which works for ISO-8601… **except** that `new Date().toISOString()` and `todayStart.toISOString()` both produce UTC strings, but a subtle issue exists: the comparison `created_at >= '2025-07-17T00:00:00.000Z'` is correct for UTC, but if any payment was recorded with a non-UTC ISO string (e.g., with timezone offset), the comparison silently breaks.

More importantly, if `processPayment()` is called near midnight UTC, a race condition exists: the daily limit check reads the count, the payment is processed, and the count is updated — but there's no transaction wrapping the check + insert. Two concurrent payments could both pass the daily limit check.

**Fix:**
Wrap the limit check + payment insert in a SQLite transaction:

```typescript
export async function processPayment(db: ChainDb, ...): Promise<PaymentRecord> {
    // ... validation ...

    // Atomic daily limit check + insert
    // Note: This requires the ChainDb interface to support transactions
    // At minimum, use a serialized check:
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayISO = todayStart.toISOString();

    // Read + insert in a single prepare to minimize race window:
    db.exec("BEGIN IMMEDIATE");
    try {
        const dailySpend = getDailySpend(db, sessionKeyId);
        const newTotal = parseFloat(dailySpend) + parseFloat(amount);
        if (newTotal > parseFloat(sessionKey.permissions.maxDailySpend)) {
            db.exec("ROLLBACK");
            throw new Error(`Daily spend limit exceeded`);
        }
        // ... insert pending payment ...
        db.exec("COMMIT");
    } catch (err) {
        try { db.exec("ROLLBACK"); } catch {}
        throw err;
    }
}
```

---

### [HIGH-5] Daily spend only counts 'completed' payments — pending payments bypass the limit

**File:** `packages/core/src/chain/payments.ts:290-296` (getDailySpend)

**Description:**
The daily spend query filters `AND status = 'completed'`. But in `processPayment()`, the payment is inserted as `'pending'` *before* the transaction is submitted. This means:

1. Payment A (0.5 ETH) starts, inserted as 'pending'. Daily spend query returns 0.
2. Payment B (0.5 ETH) starts concurrently, inserted as 'pending'. Daily spend query still returns 0 (A is pending, not completed).
3. Both payments complete. Actual daily spend = 1.0 ETH, but the limit was 0.5 ETH.

Pending payments are invisible to the limit check, allowing concurrent payments to bypass spending limits.

**Fix:**
Count both 'pending' and 'completed' payments toward the daily limit:

```typescript
const row = db
    .prepare(
        `SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) as total
         FROM payment_log
         WHERE session_key_id = ?
           AND status IN ('completed', 'pending')
           AND created_at >= ?`,
    )
    .get(sessionKeyId, todayStart.toISOString()) as { total: number } | undefined;
```

---

### [HIGH-6] Floating-point arithmetic for ETH amounts — precision loss in financial calculations

**File:** `packages/core/src/chain/payments.ts:224,230` and `packages/core/src/chain/session-keys.ts:265,280`

**Description:**
ETH amounts are compared using `parseFloat()`:

```typescript
const txValue = parseFloat(txData.value);
const maxValue = parseFloat(key.permissions.maxTransactionValue);
if (txValue > maxValue) { ... }
```

And in payments.ts:
```typescript
const newTotal = parseFloat(dailySpend) + parseFloat(amount);
if (newTotal > parseFloat(sessionKey.permissions.maxDailySpend)) { ... }
```

IEEE 754 floating-point cannot precisely represent all decimal values. `parseFloat("0.1") + parseFloat("0.2") === 0.30000000000000004`. This can cause:
- Payments that should be rejected being allowed (under-counting spend).
- Payments that should be allowed being rejected (over-counting spend).

For financial calculations, this is unacceptable.

**Fix:**
Use `ethers.parseEther()` and `BigInt` comparison for precise arithmetic:

```typescript
import { ethers } from "ethers";

const txValueWei = ethers.parseEther(txData.value);
const maxValueWei = ethers.parseEther(key.permissions.maxTransactionValue);
if (txValueWei > maxValueWei) {
    return { valid: false, reason: `Transaction value exceeds limit` };
}
```

For daily spend accumulation:
```typescript
const dailySpendWei = ethers.parseEther(dailySpend);
const amountWei = ethers.parseEther(amount);
const limitWei = ethers.parseEther(sessionKey.permissions.maxDailySpend);
if (dailySpendWei + amountWei > limitWei) {
    throw new Error("Daily spend limit exceeded");
}
```

---

### [MEDIUM-1] Master key cache never expires — keys remain in memory indefinitely

**File:** `packages/core/src/crypto.ts:155-198` (_masterKeyCache)

**Description:**
The signing keypair has a 5-minute TTL cache with automatic zeroing. However, the `_masterKeyCache` (Map of derived master keys) has **no TTL**. Once a master key is derived, it stays in the Map forever until `clearCachedKeypair()` is explicitly called or the process exits.

This increases the exposure window for memory-scraping attacks. A heap dump or debugger attach at any point after first key derivation will reveal the raw 32-byte master encryption key.

**Fix:**
Add TTL-based eviction to the master key cache, similar to the keypair cache:

```typescript
interface CachedMasterKey {
    key: Uint8Array;
    expiresAt: number;
}
const _masterKeyCache = new Map<string, CachedMasterKey>();
const MASTER_KEY_TTL_MS = 5 * 60 * 1000;

function getCachedMasterKey(cacheKey: string): Uint8Array | undefined {
    const cached = _masterKeyCache.get(cacheKey);
    if (!cached) return undefined;
    if (Date.now() > cached.expiresAt) {
        cached.key.fill(0);
        _masterKeyCache.delete(cacheKey);
        return undefined;
    }
    return new Uint8Array(cached.key);
}
```

---

### [MEDIUM-2] SIGNET_PASSPHRASE environment variable visible to other processes

**File:** `packages/core/src/crypto.ts:151-155` (resolvePassphrase)

**Description:**
The passphrase can be provided via `SIGNET_PASSPHRASE` environment variable. On Linux/macOS, any process running as the same user can read another process's environment variables via `/proc/<pid>/environ` (Linux) or `ps eww` (macOS). This significantly weakens the passphrase protection.

The code has a comment "documented as less secure" but doesn't actively warn at runtime or suggest alternatives.

**Fix:**
1. Emit a runtime warning when the env var is used (not just in docs):
```typescript
const envPassphrase = process.env.SIGNET_PASSPHRASE;
if (envPassphrase && envPassphrase.length > 0) {
    if (!process.env.SIGNET_SUPPRESS_PASSPHRASE_WARNING) {
        console.warn(
            "⚠️  Using SIGNET_PASSPHRASE from environment — visible to other processes. " +
            "Consider using setPassphraseProvider() or a secrets manager instead.",
        );
    }
    // Clear from environment after reading to minimize exposure window
    delete process.env.SIGNET_PASSPHRASE;
    return envPassphrase;
}
```

2. Clear the env var after reading to minimize the exposure window.

---

### [MEDIUM-3] Session key function selector check is bypassed when txData.data is undefined/empty

**File:** `packages/core/src/chain/session-keys.ts:283-291` (validateSessionKeyPermission)

**Description:**
The function selector check only runs `if (key.permissions.allowedFunctions.length > 0 && txData.data)`. If `txData.data` is `undefined` (a plain ETH transfer, no calldata), the check is skipped entirely.

This means a session key configured with `allowedFunctions: ["0xa9059cbb"]` (ERC-20 transfer) will also allow **plain ETH transfers** (no function selector). If the intent was to restrict the session key to only ERC-20 transfers, it fails.

**Fix:**
If `allowedFunctions` is non-empty but `txData.data` is missing, the transaction should be rejected:

```typescript
// Check allowed functions
if (key.permissions.allowedFunctions.length > 0) {
    if (!txData.data || txData.data.length < 10) {
        return {
            valid: false,
            reason: "Transaction has no function selector but session key restricts to specific functions",
        };
    }
    const selector = txData.data.slice(0, 10);
    const normalizedSelector = selector.toLowerCase();
    const allowed = key.permissions.allowedFunctions.map((f) => f.toLowerCase());
    if (!allowed.includes(normalizedSelector)) {
        return {
            valid: false,
            reason: `Function selector ${selector} is not in the allowed list`,
        };
    }
}
```

---

### [MEDIUM-4] reEncryptKeypair() writes new keypair with writeFileSync — not atomic

**File:** `packages/core/src/crypto.ts:405`

**Description:**
During key re-encryption, the new keypair data is written directly with `writeFileSync()`:

```typescript
writeFileSync(SIGNING_KEY_FILE, JSON.stringify(upgraded, null, 2), { mode: 0o600 });
```

If the process crashes (SIGKILL, power failure) during the write, the file could be left in a truncated/corrupted state. This would make the private key **irrecoverable** — the old encryption is gone, and the new file is corrupt.

The initial `writeKeypairFileExclusive()` uses `O_EXCL` for atomicity of *creation*, but the migration uses a simple overwrite.

**Fix:**
Use atomic write pattern (write to temp file, then rename):

```typescript
import { renameSync } from "fs";

const tmpFile = SIGNING_KEY_FILE + ".tmp";
writeFileSync(tmpFile, JSON.stringify(upgraded, null, 2), { mode: 0o600 });
chmodSync(tmpFile, 0o600);
renameSync(tmpFile, SIGNING_KEY_FILE); // atomic on POSIX
```

---

### [MEDIUM-5] Payment amount validation allows NaN and Infinity

**File:** `packages/core/src/chain/payments.ts:113,117` and `packages/core/src/chain/session-keys.ts:145,151`

**Description:**
Amount validation uses `parseFloat(amount) <= 0`:

```typescript
if (parseFloat(amount) <= 0) {
    throw new Error("Payment amount must be positive");
}
```

`parseFloat("NaN")` returns `NaN`, and `NaN <= 0` is `false`, so `"NaN"` passes validation. Similarly, `parseFloat("Infinity")` returns `Infinity`, which is `> 0`. These would create nonsensical payment records and potentially crash downstream processing.

**Fix:**
```typescript
const parsed = parseFloat(amount);
if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("Payment amount must be a finite positive number");
}
```

Apply to all three files where amounts are validated (session-keys.ts permissions validation too).

---

### [MEDIUM-6] verifyPaymentHeader leaks signature recovery details in error messages

**File:** `packages/core/src/chain/payments.ts:166-171`

**Description:**
When signature verification fails, the error response includes the recovered address:

```typescript
return {
    valid: false,
    reason: `Signature verification failed: recovered ${recoveredAddress}, expected ${header.payer}`,
};
```

And on crypto errors:
```typescript
reason: `Signature verification error: ${err instanceof Error ? err.message : String(err)}`,
```

Leaking the recovered address and detailed crypto error messages helps attackers debug forged signatures. The verifier should only indicate that verification failed, not *how* it failed internally.

**Fix:**
```typescript
if (recoveredAddress.toLowerCase() !== header.payer.toLowerCase()) {
    return { valid: false, reason: "Payment signature verification failed" };
}
```

Log the details server-side if needed, but don't include them in the returned object that may be sent to clients.

---

### [MEDIUM-7] did-setup.ts appends to agent.yaml without sanitizing DID value — YAML injection

**File:** `packages/core/src/did-setup.ts:75-80`

**Description:**
When updating `agent.yaml`, the DID is interpolated directly into a YAML string:

```typescript
let appendBlock = `\n# DID identity (auto-generated by signet did init)\ndid: "${did}"\n`;
```

While DIDs derived from Ed25519 keys via `publicKeyToDid()` only contain safe characters (base58), if the `did` value were ever manipulated (e.g., through a compromised `publicKeyToDid` or a different DID method), characters like `"`, `\n`, or YAML special chars could inject arbitrary YAML content.

**Fix:**
Use the `stringify` import from the yaml package (already imported but unused for this path):

```typescript
import { parse, stringify } from "yaml";

// Instead of string interpolation:
if (!config.did) {
    config.did = did;
    if (!config.signing) {
        config.signing = { autoSign: true };
    }
    // Use yaml stringify to safely serialize
    writeFileSync(yamlPath, stringify(config));
    yamlUpdated = true;
}
```

Note: This would lose user comments. The trade-off is security vs. preserving comments. At minimum, escape the DID value.

---

### [LOW-1] loadSigningKeypair() emits warnings to stderr on every load for v1/v2 keys

**File:** `packages/core/src/crypto.ts:298-303`

**Description:**
Every call to `loadSigningKeypair()` that finds a v1/v2 keypair emits a `console.warn()`. While the keypair is cached, if the cache expires (5-minute TTL), the next signing operation will reload and warn again. In a long-running daemon, this produces repeated warnings in logs.

**Fix:**
Track whether the warning has been emitted:

```typescript
let _kdfWarningEmitted = false;

// In loadSigningKeypair:
if (kdfVersion <= 2 && !_kdfWarningEmitted) {
    _kdfWarningEmitted = true;
    console.warn(/* ... */);
}
```

---

### [LOW-2] signContent() rejects empty strings but signBytes() accepts empty Uint8Array

**File:** `packages/core/src/crypto.ts:332-334` (signContent) vs `:365` (signBytes)

**Description:**
`signContent()` explicitly checks for empty input:
```typescript
if (!content || content.length === 0) {
    throw new Error("Cannot sign empty content");
}
```

But `signBytes()` has no such check:
```typescript
export async function signBytes(data: Uint8Array): Promise<Uint8Array> {
    await sodium.ready;
    const kp = await ensureKeypair();
    return sodium.crypto_sign_detached(data, kp.privateKey);
}
```

Signing an empty byte array is technically valid in Ed25519 but is almost certainly a bug in the caller. The inconsistency is confusing.

**Fix:**
Add validation to `signBytes()`:

```typescript
export async function signBytes(data: Uint8Array): Promise<Uint8Array> {
    if (!data || data.length === 0) {
        throw new Error("Cannot sign empty data");
    }
    await sodium.ready;
    const kp = await ensureKeypair();
    return sodium.crypto_sign_detached(data, kp.privateKey);
}
```

---

### [LOW-3] Payment header timestamp validation accepts future timestamps

**File:** `packages/core/src/chain/payments.ts:160-163`

**Description:**
The timestamp check uses `Math.abs(now - headerTime) > maxAgeMs`, which allows timestamps up to 5 minutes **in the future**. While some clock skew tolerance is reasonable, 5 minutes of future tolerance means an attacker can pre-generate payment headers with future timestamps that remain valid for up to 10 minutes total (5 min future + 5 min past).

**Fix:**
Use asymmetric window — small future tolerance (30 seconds for clock skew), larger past tolerance:

```typescript
const maxPastMs = 5 * 60 * 1000;    // 5 minutes
const maxFutureMs = 30 * 1000;       // 30 seconds (clock skew)
const delta = now - headerTime;
if (delta > maxPastMs || delta < -maxFutureMs) {
    return { valid: false, reason: "Payment header timestamp is too old or too far in the future" };
}
```

---

## Architecture Notes (Not Bugs)

### [NOTE-1] JavaScript cannot guarantee key zeroing
All the `.fill(0)` calls on Uint8Arrays are best-effort. The V8 GC may have already copied the buffer during compaction, and `Buffer.from()` / `TextDecoder` / `TextEncoder` create intermediate copies. This is a fundamental JS limitation, not a bug per se — but it should be documented prominently for users who need to assess their threat model.

### [NOTE-2] The `yaml` `parse()` call in did-setup.ts uses default settings
The `yaml` package's `parse()` with default settings may evaluate some YAML features. Consider using `{ strict: true }` to prevent unexpected behavior from crafted agent.yaml files.

### [NOTE-3] SQLite CAST(amount AS REAL) in getDailySpend
Using `CAST(amount AS REAL)` in SQLite has the same floating-point precision issue as JavaScript's `parseFloat()`. Consider storing amounts as integer "wei" values in the database for precise arithmetic.

---

## Summary Table

| ID | Severity | File | Title |
|----|----------|------|-------|
| CRITICAL-1 | 🔴 CRITICAL | wallet.ts | getMasterKey called without salt — wallet encryption broken for v2/v3 |
| CRITICAL-2 | 🔴 CRITICAL | session-keys.ts | Same missing-salt bug — session key encryption broken for v2/v3 |
| CRITICAL-3 | 🔴 CRITICAL | payments.ts | No nonce tracking — payment headers can be replayed within 5-min window |
| HIGH-1 | 🟠 HIGH | crypto.ts | Master key cache ignores passphrase — wrong key returned on mismatch |
| HIGH-2 | 🟠 HIGH | wallet.ts | Decrypted private key string not zeroed (JS limitation) |
| HIGH-3 | 🟠 HIGH | wallet.ts, session-keys.ts, payments.ts | Math.random() used for security-adjacent IDs |
| HIGH-4 | 🟠 HIGH | payments.ts | Daily spend check + insert not atomic — race condition |
| HIGH-5 | 🟠 HIGH | payments.ts | Pending payments not counted toward daily limit |
| HIGH-6 | 🟠 HIGH | payments.ts, session-keys.ts | Floating-point arithmetic for ETH financial calculations |
| MEDIUM-1 | 🟡 MEDIUM | crypto.ts | Master key cache has no TTL — keys stay in memory forever |
| MEDIUM-2 | 🟡 MEDIUM | crypto.ts | SIGNET_PASSPHRASE env var visible to same-user processes |
| MEDIUM-3 | 🟡 MEDIUM | session-keys.ts | allowedFunctions check bypassed for plain ETH transfers |
| MEDIUM-4 | 🟡 MEDIUM | crypto.ts | reEncryptKeypair uses non-atomic write — crash = key loss |
| MEDIUM-5 | 🟡 MEDIUM | payments.ts, session-keys.ts | NaN/Infinity pass amount validation |
| MEDIUM-6 | 🟡 MEDIUM | payments.ts | Signature error details leaked in verification response |
| MEDIUM-7 | 🟡 MEDIUM | did-setup.ts | DID string interpolated into YAML without escaping |
| LOW-1 | 🟢 LOW | crypto.ts | KDF version warning repeated on every cache-miss reload |
| LOW-2 | 🟢 LOW | crypto.ts | signBytes() accepts empty input unlike signContent() |
| LOW-3 | 🟢 LOW | payments.ts | Future timestamp tolerance too generous (5 min) |
