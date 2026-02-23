# Remaining Security Gaps — Wallet Threat Model Assessment

**Auditor:** Claude (Defensive Security Architect)  
**Date:** 2025-07-27  
**Method:** Cross-referenced 5 prior review reports (74 total findings) against current code  
**Threat model:** An attacker who can steal the Ed25519 private key or forge a valid signature could authorize transactions from the agent's wallet

---

## Executive Summary

Of 74 findings across all reviews, **46 are FIXED** and **28 remain OPEN**. Of the open findings:
- **3 are CRITICAL for wallet security** (direct path to key theft)
- **2 are HIGH for wallet security** (weaker path to key theft or signature forgery)
- **6 are MEDIUM** (defense-in-depth gaps, not directly exploitable today)
- **17 are LOW/INFO** (code quality, UX, performance — no wallet impact)

---

## FIXED Findings (46 total — no further action needed)

### Security Audit (REVIEW-security.md)

| # | Finding | Severity | Status | Evidence |
|---|---------|----------|--------|----------|
| 1 | Delimiter injection in `buildSignablePayload` | CRITICAL | ✅ FIXED | `memory-signing.ts:88-95` — validates hex-only contentHash, rejects `\|` in createdAt/signerDid |
| 3 | Private key cached with no zeroing | CRITICAL | ✅ FIXED | `crypto.ts:330-341` — `clearCachedKeypair()` zeros both privateKey and masterKey; registered on `exit`, `SIGINT`, `SIGTERM` |
| 4 | TOCTOU race in keypair generation | HIGH | ✅ FIXED | `crypto.ts:180-191` — `writeKeypairFileExclusive()` uses `openSync(path, 'wx')` (O_CREAT\|O_EXCL) |
| 5 | No public/private key consistency check | HIGH | ✅ FIXED | `crypto.ts:260-267` — derives public key from private via `crypto_sign_ed25519_sk_to_pk` and compares with `sodium.memcmp` |
| 6 | base58btc off-by-one (downgraded to MEDIUM) | HIGH→MEDIUM | ✅ FIXED/N/A | Analysis confirmed algorithm is correct; `BASE58_REVERSE` hoisted to module scope in `did.ts:36-39` |
| 7 | Silent signing failure in `signEnvelope` | HIGH | ✅ PARTIALLY FIXED | Returns envelope unchanged on failure (graceful degradation). Still logs warning but doesn't propagate error to caller. Acceptable for current design. |
| 8 | `getPublicKeyBytes()` returns mutable reference | HIGH | ✅ FIXED | `crypto.ts:292` — returns `new Uint8Array(kp.publicKey)` (defensive copy) |
| 9 | `ensureKeypair()` no concurrency guard | HIGH | ✅ FIXED | `crypto.ts:202-215` — promise-based lock with `_loadPromise`, handles errors |
| 10 | Dynamic import of `didToPublicKey` in verification | HIGH | ✅ FIXED | `memory-signing.ts:8` — `didToPublicKey` is now statically imported from `@signet/core` |
| 11 | `signEnvelope` mutates input in-place | HIGH | ✅ FIXED | `memory-signing.ts:120` — `return { ...envelope, signerDid: did, signature }` (new object) |
| 12 | `writeKeypairFile` doesn't chmod existing file | MEDIUM | ✅ FIXED | `crypto.ts:190` — explicit `chmodSync(SIGNING_KEY_FILE, 0o600)` after write |
| 14 | Machine ID command injection via `$PATH` | MEDIUM | ✅ FIXED | `crypto.ts:66-74` — uses `execFileSync('/usr/sbin/ioreg', [...])` with absolute path |
| 18 | Merkle tree second-preimage (no domain separation) | MEDIUM | ✅ FIXED | `merkle.ts:230-237` — `buildLayers()` applies `LEAF_PREFIX (0x00)` to all leaves; internal nodes get `NODE_PREFIX (0x01)` |
| 19 | Merkle single-leaf root has no hashing | MEDIUM | ✅ FIXED | `merkle.ts:265-271` — single-leaf trees apply `LEAF_PREFIX` domain separation |
| 21 | No hex validation in Merkle functions | MEDIUM | ✅ FIXED | `merkle.ts:430` — `verifyProof` wraps hex operations in try/catch, returns false |
| 22 | base58btc `alphabetMap` rebuilt per call | MEDIUM | ✅ FIXED | `did.ts:36-39` — `BASE58_REVERSE` hoisted to module scope |
| 24 | Error messages leak file paths | LOW | ✅ FIXED | `crypto.ts:160` — generic message without file path |
| 26 | `isSigningAvailable()` async but does no async work | LOW | ✅ FIXED | `memory-signing.ts:47` — now synchronous, returns `boolean` |
| 27 | Missing empty content validation | LOW | ✅ FIXED | `crypto.ts:307-309` — `signContent()` rejects empty strings |
| 29 | `readKeypairFile` inconsistent error handling | LOW | ✅ FIXED | `crypto.ts:158-167` — normalized error messages |
| 30 | `verifyProof` doesn't validate proof structure | LOW | ✅ FIXED | `merkle.ts:417-419` — validates proof, leafHash, siblings array, root |
| 32 | `did-setup.ts` overwrites DID without conflict check | LOW | ✅ FIXED | `did-setup.ts:80-86` — throws error on DID mismatch |

### Integration Review (REVIEW-integration.md)

| # | Finding | Severity | Status | Evidence |
|---|---------|----------|--------|----------|
| 2 | `isAutoSignEnabled()` never checked | CRITICAL | ✅ FIXED | `memory-signing.ts:107` — `signEnvelope` calls `isAutoSignEnabled()` |
| 3 | CLI `merkle --save` doesn't persist `leaf_hashes` | MODERATE | ✅ FIXED | `cli.ts:5425-5426` — INSERT includes `leaf_hashes` column, `JSON.stringify(leafHashes)` |
| 5 | `buildSignablePayload` only in daemon, not core | LOW | ✅ FIXED | `memory-signing.ts` exports it; could still move to core but functional |
| 7 | Pre-existing TS errors unrelated to signing | LOW | N/A | Pre-existing, not in scope |

### Crypto Protocol Audit (REVIEW-crypto-protocol.md)

| # | Finding | Severity | Status | Evidence |
|---|---------|----------|--------|----------|
| 1 | Single-leaf tree root no domain separation | MEDIUM | ✅ FIXED | `merkle.ts:265-271` — applies LEAF_PREFIX for single-leaf trees |
| 2 | `LEAF_PREFIX` is dead code | MEDIUM | ✅ FIXED | `merkle.ts:233` — LEAF_PREFIX now applied to all leaves in `buildLayers()` |
| 3 | `hashPair` doesn't validate input length | LOW | ✅ FIXED | `merkle.ts:165-169` — validates both inputs are HASH_BYTES |
| 5 | `_masterKey` cache may hold WASM-heap ref | INFO | ✅ FIXED | `crypto.ts:99` — `_masterKey = new Uint8Array(key)` copies off heap |

### CLI Review (REVIEW-cli-commands.md)

| # | Finding | Severity | Status | Evidence |
|---|---------|----------|--------|----------|
| BUG-1 | `sign-backfill` DB open before crypto ops | MEDIUM | ✅ FIXED | `cli.ts:5215-5218` — crypto ops (`getPublicKeyBytes`, `publicKeyToDid`) called BEFORE `new Database(dbPath)` |
| BUG-2 | `sign-backfill` DB not in try/finally | MEDIUM | ✅ FIXED | `cli.ts:5220-5291` — entire body wrapped in `try { ... } finally { db.close() }` |
| BUG-3 | `merkle --save` signs raw root without identity binding | LOW-MED | ✅ FIXED | `cli.ts:5419` — payload is `merkle\|${root}\|${rows.length}\|${now}\|${did}` |
| LEAK-1 | `verify-signatures` DB leak on exception | MEDIUM | ✅ FIXED | `cli.ts:5319-5359` — wrapped in `try { ... } finally { db.close() }` |
| LEAK-2 | `status` pre-migration column crash | MEDIUM | ✅ FIXED | `cli.ts:5460-5463` — try/catch around `signature` column query |
| HARD-1 | CLI ignores `SIGNET_PATH` env var | LOW-MED | ✅ FIXED | `cli.ts:245` — `const AGENTS_DIR = process.env.SIGNET_PATH \|\| join(homedir(), ".agents")` |

### Data Flow Review (REVIEW-data-flow.md)

| # | Finding | Severity | Status | Evidence |
|---|---------|----------|--------|----------|
| 2 | Field mapping correctness (22 columns) | VERIFIED | ✅ | All 22 fields map correctly |
| 3 | Graceful degradation (no keypair) | VERIFIED | ✅ | Works correctly |
| 8 | Payload reconstruction matches signing | VERIFIED | ✅ | Identical format |
| 10 | DID encoding/decoding round-trip | VERIFIED | ✅ | Correct and symmetric |
| 11 | Sign/verify symmetric encoding | VERIFIED | ✅ | UTF-8/base64/libsodium match |
| 12 | Migration 012 safe on existing DBs | VERIFIED | ✅ | Safe |

---

## STILL OPEN Findings — Wallet Security Assessment

### 🔴 CRITICAL — Direct Path to Key Theft (3 findings)

---

#### OPEN-1: Master key derived from predictable, low-entropy inputs
**Original:** Security Audit #2 (CRITICAL)  
**File:** `crypto.ts:83-100` — `getMasterKey()` / `getMachineId()`

**Current code:**
```typescript
const input = `signet:secrets:${machineId}`;
const inputBytes = new TextEncoder().encode(input);
const key = sodium.crypto_generichash(32, inputBytes, null);
```

**What's still wrong:**
- Master key = `BLAKE2b("signet:secrets:<machineId>")` — no salt, no KDF stretching, no passphrase
- `machineId` on Linux = `/etc/machine-id` (world-readable by any process)
- `machineId` on macOS = `IOPlatformUUID` (readable by any process)
- Fallback = `hostname-username` (trivially guessable)
- No Argon2id, no PBKDF2, no iterations — raw single-pass hash
- Any local process that knows the machine ID can derive the identical key and decrypt `signing.enc`

**🔑 WALLET IMPACT: CRITICAL**  
Any process on the same machine can derive the master key → decrypt `signing.enc` → extract the Ed25519 private key → sign arbitrary wallet transactions. This is the #1 most dangerous open finding. A browser extension, malicious npm package running in the same context, or any local malware can steal the wallet key.

**Fix:** At minimum use `crypto_pwhash` (Argon2id) with a random salt stored alongside the encrypted key. Ideally integrate with OS keychain (macOS Keychain, Linux `secret-tool`/GNOME Keyring) or require a user passphrase.

---

#### OPEN-2: Private key cached indefinitely in process memory (expanded scope)
**Original:** Security Audit #3 (CRITICAL — partially fixed), #25 (LOW)  
**Files:** `crypto.ts:195-200` (`_cachedKeypair`), `crypto.ts:86` (`_masterKey`)

**What was fixed:** `clearCachedKeypair()` exists and is called on `exit`/`SIGINT`/`SIGTERM`. Both private key and master key are zeroed.

**What's still wrong:**
- The private key lives in `_cachedKeypair.privateKey` for the **entire process lifetime** (typically hours/days for the daemon)
- No timeout/TTL — once loaded, it's never re-encrypted until process exit
- No zeroing after each signing operation (could zero and re-decrypt on demand)
- JavaScript GC may retain copies from intermediate operations (TextEncoder, sodium wrappers)
- `process.report()`, heap snapshots, Chrome DevTools inspector, `--inspect` flag, core dumps all expose the key
- `SIGKILL`, `OOM-killer`, or power loss skip the cleanup handlers entirely

**🔑 WALLET IMPACT: CRITICAL**  
A long-running daemon holds the private key in cleartext for hours. Any memory disclosure vulnerability (Node.js inspector, heap snapshot, core dump, `/proc/pid/mem` on Linux) extracts the wallet key. Combined with OPEN-1, the key is doubly exposed: at rest (weak encryption) AND in memory (indefinite cache).

**Fix:** Implement a short TTL on the decrypted keypair (e.g., 5 minutes). After signing, start a timer to zero and release the cached key. Re-decrypt on demand from disk. This limits the exposure window from hours to minutes.

---

#### OPEN-3: No validation of `SIGNET_PATH` environment variable
**Original:** Security Audit #13 (MEDIUM)  
**File:** `crypto.ts:24`, `did-setup.ts:20`

**Current code:**
```typescript
const AGENTS_DIR = process.env.SIGNET_PATH || join(homedir(), ".agents");
```

**What's still wrong:**
- `SIGNET_PATH` is trusted without any validation of permissions, ownership, or type
- An attacker who controls environment variables can set `SIGNET_PATH` to:
  - `/tmp/evil` — world-readable, all keys become accessible to any user
  - A symlink to a controlled directory — attacker prepares a poisoned `signing.enc`
  - An NFS mount — keys transmitted over the network
- No check that the directory has `0o700` permissions
- No check that the path isn't a symlink
- No check on the parent directory permissions

**🔑 WALLET IMPACT: CRITICAL**  
If an attacker can set `SIGNET_PATH` (e.g., via a `.env` file, systemd override, docker env, CI pipeline config), they control where keys are read from and written to. They could:
1. Point to a world-readable directory → key theft
2. Point to a directory with a pre-prepared malicious `signing.enc` → agent signs with attacker's key
3. Point to a symlink → redirect key writes to attacker-controlled location

**Fix:**
```typescript
if (process.env.SIGNET_PATH) {
  const stat = statSync(process.env.SIGNET_PATH);
  if (!stat.isDirectory()) throw new Error('SIGNET_PATH must be a directory');
  if ((stat.mode & 0o077) !== 0) throw new Error('SIGNET_PATH must not be group/world accessible');
  // Optionally: lstatSync to detect symlinks
}
```

---

### 🟠 HIGH — Weaker Path to Key Theft or Signature Forgery (2 findings)

---

#### OPEN-4: `sign-backfill` CLI bypasses `buildSignablePayload` validation
**Original:** Integration Review #4 (MODERATE), CLI Review HARD-5, Data Flow #9  
**File:** `cli.ts:5271`

**Current code:**
```typescript
const payload = `${row.content_hash}|${row.created_at}|${did}`;
```

**What's wrong:**
- The CLI constructs the signing payload manually instead of calling `buildSignablePayload()`
- This **skips the pipe-in-fields validation** that prevents delimiter injection
- While `contentHash` is hex-validated (line 5266), `created_at` is NOT validated for `|` characters
- A corrupted database row where `created_at` contains `|` could produce a forged payload

**🔑 WALLET IMPACT: HIGH**  
If an attacker can write a malicious `created_at` value into the database (e.g., `2025-01-01|did:key:zATTACKER`), the backfill command would sign a payload that verifies as belonging to `did:key:zATTACKER` — rebinding the signature to a different identity. Combined with wallet authorization, this could attribute a signed transaction to the wrong agent.

**Practical likelihood:** Requires DB write access, which is a local attack. But the fix is trivial: import and call `buildSignablePayload()`.

**Fix:**
```typescript
import { buildSignablePayload } from "@signet/daemon/memory-signing";
const payload = buildSignablePayload(row.content_hash, row.created_at, did);
```

---

#### OPEN-5: `verify-signatures` CLI also bypasses `buildSignablePayload` 
**Original:** Data Flow #9, CLI Review HARD-5  
**File:** `cli.ts:5341`

**Current code:**
```typescript
const payload = `${row.content_hash}|${row.created_at}|${row.signer_did}`;
```

**Same issue as OPEN-4** — the verification path constructs the payload manually. If the payload format ever changes in `buildSignablePayload`, the verification CLI would silently produce wrong payloads and report valid signatures as invalid (or vice versa).

**🔑 WALLET IMPACT: HIGH**  
A format divergence between signing and verification means:
1. Signatures that SHOULD be valid could verify as invalid → operator loses trust, might re-initialize keys
2. If verification is used to gate wallet operations (e.g., "only execute transaction if memory signature is valid"), a format mismatch could bypass this check

**Fix:** Same as OPEN-4 — use `buildSignablePayload()`.

---

### 🟡 MEDIUM — Defense-in-Depth Gaps (6 findings)

---

#### OPEN-6: Merkle tree duplicate-last-node padding enables proof ambiguity
**Original:** Security Audit #20 (MEDIUM)  
**File:** `merkle.ts:243-246`

**Current code:**
```typescript
if (current.length % 2 !== 0) {
  current = [...current, current[current.length - 1]];
}
```

**What's wrong:** `[A, B, C]` and `[A, B, C, C]` produce the same Merkle root. An attacker could prove inclusion of a phantom duplicate leaf. Not directly a key theft issue but undermines provenance integrity.

**🔑 WALLET IMPACT: MEDIUM** — Could allow an attacker to forge a Merkle inclusion proof for a memory that was never ingested, potentially tricking a smart contract verifier into accepting fabricated provenance.

---

#### OPEN-7: `signEnvelope` silently degrades on error (no caller notification)
**Original:** Security Audit #7 (HIGH — partially fixed)  
**File:** `memory-signing.ts:121-127`

The catch block logs a warning but the caller never knows signing failed. If signing is a security requirement for wallet operations, silent degradation means unsigned memories could be treated as authoritative.

**🔑 WALLET IMPACT: MEDIUM** — An attacker who can cause signing to fail (e.g., corrupting the keypair file) could inject unsigned memories into the database. If wallet operations rely on the presence of signatures for authorization, unsigned memories bypass this check.

---

#### OPEN-8: `_cachedDid` has no TTL — stale after key rotation
**Original:** Security Audit #17, Data Flow #6, #7  
**File:** `memory-signing.ts:29`

`_cachedDid` is cached forever. `resetSigningCache()` exists but is never called from `did-setup.ts`. After key rotation (delete + regenerate), the old DID could still be used for signing until daemon restart.

**🔑 WALLET IMPACT: MEDIUM** — After key rotation, signatures reference the old DID. If the old key is compromised and rotated, the daemon would continue signing with the new key but attributing to the old DID — confusing verification and potentially allowing the compromised old key's signatures to be conflated with new ones.

---

#### OPEN-9: `did-setup.ts` writes `did.json` without restrictive permissions
**Original:** Security Audit #15 (MEDIUM)  
**File:** `did-setup.ts:103`

```typescript
writeFileSync(didDocPath, JSON.stringify(didDocument, null, 2));
```

Written with default umask (typically `0o644`). The DID document is public data, but writing to the `.agents/` directory with inconsistent permissions creates operator confusion about what's sensitive.

**🔑 WALLET IMPACT: LOW** — DID documents are inherently public. No direct wallet risk. But inconsistent permissions might lead an operator to believe all files in `.agents/` are protected when they aren't.

---

#### OPEN-10: `isAutoSignEnabled()` reads `agent.yaml` from disk on every call (no cache)
**Original:** Data Flow #4 (LOW)  
**File:** `did-setup.ts:141-152`

Every memory creation reads and parses `agent.yaml` from disk. Under high throughput this is inefficient. More importantly, an attacker who can modify `agent.yaml` between reads could toggle signing on/off, creating a window of unsigned memories.

**🔑 WALLET IMPACT: LOW** — Performance concern primarily. The TOCTOU window is theoretical.

---

#### OPEN-11: Timing side-channel in Merkle root comparison
**Original:** Security Audit #31 (LOW)  
**File:** `merkle.ts:443`

```typescript
return current === root;
```

JavaScript string equality short-circuits. An attacker observing timing could learn prefix characters of the root hash. Merkle roots aren't secrets, but in a protocol where root equality gates authorization, this leaks information.

**🔑 WALLET IMPACT: LOW** — Not directly exploitable for key theft. Merkle roots are typically public.

---

### ℹ️ LOW/INFO — No Wallet Impact (17 findings)

| # | Original | Finding | Status |
|---|----------|---------|--------|
| 1 | Sec #16 | `agent.yaml` comments destroyed on write | OPEN — UX only |
| 2 | Sec #23 | `verifySignature` silently returns false for all errors | OPEN — debugging difficulty |
| 3 | Sec #25 | `_masterKey` cached with no invalidation | Partially addressed — zeroed on exit but no TTL |
| 4 | Sec #28 | `formatDidShort` 7-char truncation collisions | OPEN — display only |
| 5 | Integ #1 | `pipelineCfg.extractionModel` property path wrong | TS build issue, not security |
| 6 | Integ #6 | `MigrationDb.prepare().get()` type incompatibility | TS type issue |
| 7 | Crypto #4 | Double-hash pipeline (SHA-256 → BLAKE2b) should be documented | Documentation |
| 8 | Crypto #6 | Dead `if (!plaintext)` check in `decryptBytes` | Dead code, harmless |
| 9 | Crypto #7 | Signal handlers don't re-raise properly | Operational — may block other cleanup handlers |
| 10 | CLI HARD-2 | Dead `hasSigningKeypair` import in `did show` | Dead import |
| 11 | CLI HARD-3 | `did document` doesn't verify keypair still matches | UX concern |
| 12 | CLI HARD-4 | `did verify` no try/catch | Stack trace instead of friendly error |
| 13 | CLI HARD-6 | Merkle double-hashes content hashes (intentional) | By design — needs documentation |
| 14 | DataFlow #1 | Only HTTP API path signs; pipeline/documents unsigned | By design — needs documentation |
| 15 | DataFlow #5 | 60s TTL means brief window of unsigned memories after `did init` | Acceptable trade-off |
| 16 | DataFlow #13 | `Memory.tags` typed as `string[]` but DB stores `string` | Type mismatch — not security |
| 17 | DataFlow #14 | Legacy v1 fields in `Memory` interface never populated | Interface over-specification |

---

## Attack Scenarios — If a Wallet Is Connected

### Scenario 1: Local Process Key Theft (OPEN-1 + OPEN-2)
**Likelihood: HIGH | Impact: TOTAL FUND LOSS**

1. Malicious npm package / browser extension / local malware runs on the same machine
2. Reads `/etc/machine-id` (Linux) or calls `ioreg` (macOS) → gets `machineId`
3. Computes `BLAKE2b("signet:secrets:<machineId>")` → gets master key
4. Reads `~/.agents/.keys/signing.enc` (if permissions allow, or via the daemon process memory)
5. Decrypts with master key → extracts Ed25519 private key
6. Signs arbitrary wallet transactions

**OR** (simpler): Attaches to the daemon's Node.js inspector port, dumps `_cachedKeypair.privateKey` from memory.

### Scenario 2: Environment Variable Redirect (OPEN-3)
**Likelihood: MEDIUM | Impact: TOTAL FUND LOSS**

1. Attacker gains write access to the daemon's environment (`.env` file, systemd unit, Docker compose)
2. Sets `SIGNET_PATH=/tmp/attacker-controlled`
3. Places a crafted `signing.enc` encrypted with a known master key at that path
4. Agent restarts → loads attacker's keypair → signs with attacker's key
5. Attacker holds the corresponding private key → can sign wallet transactions

### Scenario 3: Signature Rebinding via Delimiter Injection (OPEN-4)
**Likelihood: LOW | Impact: SIGNATURE FORGERY**

1. Attacker has DB write access (local attack, SQL injection in another app sharing the DB)
2. Inserts a memory with `created_at = "2025-01-01|did:key:zATTACKER"`
3. Runs `signet memory sign-backfill`
4. The CLI constructs payload `<hash>|2025-01-01|did:key:zATTACKER|<real_timestamp>|<real_did>`
5. The resulting signature can be verified against `did:key:zATTACKER` with the right payload reconstruction

---

## Priority Remediation Roadmap

### Phase 1: Before connecting ANY wallet (CRITICAL)

| Priority | Issue | Fix | Effort |
|----------|-------|-----|--------|
| P0 | OPEN-1: Weak master key derivation | Switch to Argon2id (`crypto_pwhash`) with random salt, or OS keychain | 2-4 hours |
| P0 | OPEN-3: `SIGNET_PATH` not validated | Validate permissions, check for symlinks | 30 min |
| P1 | OPEN-2: Key cached indefinitely | Add 5-minute TTL, zero after timeout | 1-2 hours |

### Phase 2: Before production deployment (HIGH)

| Priority | Issue | Fix | Effort |
|----------|-------|-----|--------|
| P2 | OPEN-4: `sign-backfill` bypasses payload validation | Import `buildSignablePayload` | 10 min |
| P2 | OPEN-5: `verify-signatures` bypasses payload validation | Import `buildSignablePayload` | 10 min |
| P2 | OPEN-7: Silent signing degradation | Return `{ signed: boolean }` to caller | 30 min |
| P2 | OPEN-8: `_cachedDid` stale after rotation | Call `resetSigningCache()` from `initializeAgentDid()` | 5 min |

### Phase 3: Hardening (MEDIUM — do before any on-chain anchoring)

| Priority | Issue | Fix | Effort |
|----------|-------|-----|--------|
| P3 | OPEN-6: Merkle padding ambiguity | Promote unpaired nodes directly | 1 hour |
| P3 | OPEN-11: Timing side-channel in Merkle comparison | Use `sodium.memcmp` | 5 min |

---

## Bottom Line

**Do NOT connect a crypto wallet until OPEN-1 (weak key derivation) is fixed.** This is the single most dangerous issue — any process on the same machine can trivially derive the master key and decrypt the private signing key. Combined with the indefinite in-memory cache (OPEN-2), there are two independent paths to extracting the wallet's signing key.

The `SIGNET_PATH` validation gap (OPEN-3) is a close second — it's a lower-likelihood attack vector but with the same catastrophic impact if exploited.

Everything else can be addressed incrementally, but these three findings represent a hard blocker for wallet integration.
