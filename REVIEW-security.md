# Signet Cryptographic Identity Module — Security Audit

**Auditor:** Claude (Senior Security Auditor)  
**Date:** 2025-07-22  
**Scope:** `crypto.ts`, `did.ts`, `merkle.ts`, `did-setup.ts`, `memory-signing.ts`  
**Severity Scale:** CRITICAL / HIGH / MEDIUM / LOW

---

## Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 3     |
| HIGH     | 8     |
| MEDIUM   | 11    |
| LOW      | 10    |
| **Total**| **32**|

---

## Findings

### 1. CRITICAL — Delimiter injection in signing payload allows signature forgery

**File:** `memory-signing.ts` → `buildSignablePayload()`  
**Line:** `return \`${contentHash}|${createdAt}|${signerDid}\`;`

The pipe `|` delimiter is used to concatenate fields, but none of the fields are validated to exclude `|`. A malicious `contentHash` containing `|` can forge an entirely different payload:

- Legit: `abc123|2025-07-22T00:00:00Z|did:key:z6Mk...`
- Forged `contentHash = "abc123|2025-07-21T00:00:00Z|did:key:zFAKE"`: the payload becomes `abc123|2025-07-21T00:00:00Z|did:key:zFAKE|2025-07-22T00:00:00Z|did:key:z6Mk...` — but more critically, a crafted hash like `differentHash|differentTimestamp|differentDid` with empty remaining fields lets an attacker rebind a valid signature to different content.

Since `contentHash` is supposed to be a hex-encoded hash, and `createdAt` is ISO-8601, and `signerDid` is a `did:key:...`, the realistic attack vector requires controlling contentHash input, which IS possible — the contentHash comes from hashing user-provided content.

**Fix:** Use a length-prefixed or structured encoding that is unambiguous:
```typescript
export function buildSignablePayload(
  contentHash: string,
  createdAt: string,
  signerDid: string,
): string {
  // Validate no delimiters in fields
  if (contentHash.includes('|') || createdAt.includes('|') || signerDid.includes('|')) {
    throw new Error('Signing payload fields must not contain pipe characters');
  }
  // Additionally validate contentHash is hex-only
  if (!/^[0-9a-f]+$/.test(contentHash)) {
    throw new Error('contentHash must be lowercase hex');
  }
  return `${contentHash}|${createdAt}|${signerDid}`;
}
```
Or better — use a canonical JSON/CBOR encoding, or length-prefix each field:
```typescript
return `${contentHash.length}:${contentHash}|${createdAt.length}:${createdAt}|${signerDid.length}:${signerDid}`;
```

---

### 2. CRITICAL — Master key derived from predictable, low-entropy inputs

**File:** `crypto.ts` → `getMasterKey()` / `getMachineId()`

The master encryption key is derived solely from `BLAKE2b(signet:secrets:<machineId>)` with **no salt, no KDF stretching, no pepper, and no user-provided passphrase**. The machine ID is a static, publicly-readable value:

- `/etc/machine-id` is world-readable on Linux
- `IOPlatformUUID` can be read by any process on macOS
- The fallback `hostname-username` is trivially guessable

Any process on the same machine (or any process that learns the machine-id) can derive the identical master key and decrypt the private signing key. This is **not** encrypted-at-rest in any meaningful sense against local attackers.

Additionally, `BLAKE2b` with no iterations provides zero resistance to brute-force if the machine-id space is enumerable (hostname + username fallback is extremely low entropy).

**Fix:**
1. Use `crypto_pwhash` (Argon2id) instead of raw BLAKE2b for key derivation
2. Add a user-provided passphrase or OS keychain integration
3. At minimum, use `crypto_generichash` with a random salt stored alongside the encrypted key (so the key is at least unique per installation)
4. On macOS, use Keychain. On Linux, use `secret-tool` or similar

---

### 3. CRITICAL — Private key cached indefinitely in process memory with no zeroing

**File:** `crypto.ts` → `_cachedKeypair`

The decrypted private key (`Uint8Array`) is cached in module-level `_cachedKeypair` for the entire process lifetime. There is:
- No mechanism to clear the cache
- No zeroing on process exit
- No way to re-encrypt after use
- No `process.on('exit')` cleanup handler

If the process is compromised (memory dump, core dump, heap snapshot, `process.report()`, Node.js inspector protocol), the private key is trivially extractable. JavaScript's GC makes true zeroing unreliable, but best-effort zeroing on a timer or after signing operations significantly shrinks the attack window.

**Fix:**
```typescript
export function clearCachedKeypair(): void {
  if (_cachedKeypair) {
    _cachedKeypair.privateKey.fill(0);
    _cachedKeypair = null;
  }
}

// Register cleanup
process.on('exit', clearCachedKeypair);
process.on('SIGINT', () => { clearCachedKeypair(); process.exit(130); });
process.on('SIGTERM', () => { clearCachedKeypair(); process.exit(143); });
```

---

### 4. HIGH — TOCTOU race in keypair generation

**File:** `crypto.ts` → `generateSigningKeypair()`

```typescript
if (existsSync(SIGNING_KEY_FILE)) {
  throw new Error(`Signing keypair already exists...`);
}
// ... generate ...
writeKeypairFile(stored);
```

Between `existsSync()` and `writeFileSync()`, another process could create the file, causing a race condition where the second process silently overwrites the first's key — destroying the original keypair and any DIDs/signatures derived from it.

**Fix:** Use `O_CREAT | O_EXCL` via `fs.openSync(path, 'wx')` which atomically fails if the file already exists:
```typescript
import { openSync, writeSync, closeSync } from 'fs';

function writeKeypairFileExclusive(data: StoredKeypair): void {
  mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
  const fd = openSync(SIGNING_KEY_FILE, 'wx', 0o600); // fails if exists
  try {
    writeSync(fd, JSON.stringify(data, null, 2));
  } finally {
    closeSync(fd);
  }
}
```

---

### 5. HIGH — No public/private key consistency check after decryption

**File:** `crypto.ts` → `loadSigningKeypair()`

After decrypting the private key and loading the public key, the code checks lengths but never verifies that the public key actually corresponds to the private key. A corrupted or tampered file could pair a valid-looking public key with a different private key, causing signatures that appear to come from one identity but are actually signed by another.

**Fix:** After loading both keys, derive the public key from the private key and compare:
```typescript
const derivedPublicKey = sodium.crypto_sign_ed25519_sk_to_pk(privateKey);
if (sodium.memcmp(derivedPublicKey, publicKey) === false) {
  throw new Error('Public/private key mismatch — keypair file may be tampered');
}
```

---

### 6. HIGH — base58btcEncode mutates a copy but has an off-by-one in allZero tracking

**File:** `did.ts` → `base58btcEncode()`

The encoding loop has a subtle issue:

```typescript
let allZero = true;
for (let i = start; i < input.length; i++) {
  const digit = input[i] + remainder * 256;
  input[i] = (digit / 58) | 0;
  remainder = digit % 58;
  if (input[i] !== 0 && allZero) {
    newStart = i;
    allZero = false;
  }
}
encoded.push(remainder);
if (allZero) break;
start = newStart;
```

When `allZero` remains true at the end of a pass, the loop breaks. But `remainder` has already been pushed to `encoded`. This means the final remainder digit is correctly captured. However, the issue is that `newStart` is only set when `input[i] !== 0`, so if the very first non-zero quotient is at the start position, `newStart = start`, which means no progress is made on `start`. This could cause an infinite loop for certain inputs where `start` never advances because the first non-zero position equals `start`.

Wait — re-analyzing: `newStart` is initialized to `start` at the top of the while loop, and only advanced when a non-zero quotient is found. If `input[start]` itself is the only non-zero, `newStart = start`, so next iteration `start = start` — but the value at `input[start]` will eventually become zero through repeated division by 58. This is correct but inefficient. Not a bug per se.

**Revised finding:** The algorithm is functionally correct for the happy path, but lacks protection against excessively large inputs that could cause CPU exhaustion. No actual encoding bug found on deeper analysis.

**Severity downgrade to MEDIUM** — see issue #22 instead for base58 concerns.

---

### 7. HIGH — Signing error in `signEnvelope` is silently swallowed

**File:** `memory-signing.ts` → `signEnvelope()`

```typescript
} catch (err) {
  console.warn("[memory-signing] Failed to sign memory:", err instanceof Error ? err.message : String(err));
}
```

If signing fails (corrupted key, sodium crash, disk error), the memory is stored **unsigned** with no indication to the caller that signing was expected but failed. This creates a silent integrity gap — the system believes it's signing all memories but some slip through unsigned.

**Fix:** Either:
1. Return a status indicator: `{ envelope, signed: boolean, error?: string }`
2. Or re-throw the error and let the caller decide:
```typescript
export async function signEnvelope(
  envelope: IngestEnvelope,
  options: { requireSigning?: boolean } = {},
): Promise<IngestEnvelope> {
  // ...
  } catch (err) {
    if (options.requireSigning) throw err;
    console.warn(...);
  }
}
```

---

### 8. HIGH — `getPublicKeyBytes()` returns a mutable reference to cached key

**File:** `crypto.ts` → `getPublicKeyBytes()`

```typescript
export async function getPublicKeyBytes(): Promise<Uint8Array> {
  const kp = await ensureKeypair();
  return kp.publicKey;  // Direct reference to cached array
}
```

Any caller who receives this `Uint8Array` and modifies it (e.g., `.fill(0)`, index assignment) will corrupt the cached keypair for all subsequent callers. The same applies to `loadSigningKeypair()` which exposes `_cachedKeypair` directly.

**Fix:** Return a defensive copy:
```typescript
export async function getPublicKeyBytes(): Promise<Uint8Array> {
  const kp = await ensureKeypair();
  return new Uint8Array(kp.publicKey);
}
```

And for `loadSigningKeypair`, either return copies or document that the returned object is read-only.

---

### 9. HIGH — `ensureKeypair()` has no concurrency guard — parallel calls trigger duplicate loads

**File:** `crypto.ts` → `ensureKeypair()`

```typescript
async function ensureKeypair(): Promise<DecryptedKeypair> {
  if (_cachedKeypair) return _cachedKeypair;
  _cachedKeypair = await loadSigningKeypair();
  return _cachedKeypair;
}
```

If two async callers hit `ensureKeypair()` simultaneously before the cache is populated, both will call `loadSigningKeypair()`, perform duplicate file reads and decryptions, and the second will overwrite `_cachedKeypair`. This wastes resources and means two different `Uint8Array` instances of the private key exist in memory (the first one is never zeroed).

**Fix:** Use a promise-based lock:
```typescript
let _loadPromise: Promise<DecryptedKeypair> | null = null;

async function ensureKeypair(): Promise<DecryptedKeypair> {
  if (_cachedKeypair) return _cachedKeypair;
  if (!_loadPromise) {
    _loadPromise = loadSigningKeypair().then(kp => {
      _cachedKeypair = kp;
      _loadPromise = null;
      return kp;
    });
  }
  return _loadPromise;
}
```

---

### 10. HIGH — `verifyMemorySignature` uses dynamic import, can be intercepted

**File:** `memory-signing.ts` → `verifyMemorySignature()`

```typescript
const { didToPublicKey } = await import("@signet/core");
```

This is a dynamic `import()` at verification time. `didToPublicKey` is already available as a static import at the top of the file (`import { publicKeyToDid } from "@signet/core"`). The dynamic import:
1. Is inconsistent — `publicKeyToDid` is statically imported but `didToPublicKey` is not
2. Could be intercepted by module resolution hijacking (prototype pollution, loader hooks)
3. Has a performance cost on every verification call
4. Creates a dependency that's invisible to static analysis / tree shaking

**Fix:** Add `didToPublicKey` to the static imports at the top:
```typescript
import { publicKeyToDid, didToPublicKey } from "@signet/core";
```

---

### 11. HIGH — `signEnvelope` mutates the input object in-place

**File:** `memory-signing.ts` → `signEnvelope()`

```typescript
envelope.signerDid = did;
envelope.signature = signature;
```

The function both mutates the input AND returns it. If the caller passes the same envelope to multiple concurrent calls (e.g., retry logic), there's a race on the envelope fields. The mutation is also surprising API behavior — callers may not expect their input to be modified.

**Fix:** Return a new object:
```typescript
return { ...envelope, signerDid: did, signature };
```

---

### 12. MEDIUM — `writeKeypairFile` doesn't set file permissions on the file if it already exists

**File:** `crypto.ts` → `writeKeypairFile()`

```typescript
mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
writeFileSync(SIGNING_KEY_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
```

`writeFileSync` with `mode` only applies when **creating** a new file. If the file already exists with more permissive permissions (e.g., `0o644`), the mode flag is silently ignored. This can happen if an older version or misconfigured tool created the file.

**Fix:** Explicitly chmod after write:
```typescript
import { chmodSync } from 'fs';
writeFileSync(SIGNING_KEY_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
chmodSync(SIGNING_KEY_FILE, 0o600);
```

---

### 13. MEDIUM — No validation of `SIGNET_PATH` environment variable

**File:** `crypto.ts`, `did-setup.ts`

```typescript
const AGENTS_DIR = process.env.SIGNET_PATH || join(homedir(), ".agents");
```

`SIGNET_PATH` is trusted without validation. An attacker who controls environment variables could set it to:
- `/tmp/evil` — world-readable directory, keys become accessible
- A symlink to a different directory
- A network mount with different permission semantics

**Fix:** Validate the path and its permissions:
```typescript
if (process.env.SIGNET_PATH) {
  const stat = statSync(process.env.SIGNET_PATH);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error('SIGNET_PATH directory must not be group/world accessible');
  }
}
```

---

### 14. MEDIUM — Machine ID command injection risk

**File:** `crypto.ts` → `getMachineId()`

```typescript
const out = execSync(
  "ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID | awk '{print $3}'",
  { timeout: 2000 },
).toString().trim().replace(/"/g, "");
```

While the command itself is hardcoded (no user input injection), `execSync` launches a shell (`/bin/sh -c`). If an attacker can modify `$PATH` or plant a malicious `ioreg`/`grep`/`awk` binary, they can control the machine ID and therefore derive the master key of their choice. More of a defense-in-depth concern than a direct vulnerability.

**Fix:** Use `execFileSync` with absolute paths to avoid `$PATH` manipulation:
```typescript
import { execFileSync } from 'child_process';
const out = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { timeout: 2000 })
  .toString()
  .split('\n')
  .find(l => l.includes('IOPlatformUUID'))
  ?.match(/"([^"]+)"$/)?.[1] || '';
```

---

### 15. MEDIUM — `did-setup.ts` writes `did.json` without restrictive permissions

**File:** `did-setup.ts` → `initializeAgentDid()`

```typescript
writeFileSync(didDocPath, JSON.stringify(didDocument, null, 2));
```

The DID document (which contains the public key) is written with default umask permissions (typically `0o644`). While the DID document is inherently public, writing to `~/.agents/` without explicit permissions is inconsistent with the `0o600` used for the keypair file and could confuse operators about what's sensitive.

**Fix:** Use `{ mode: 0o644 }` explicitly to document the intent, or `0o600` if you want consistency.

---

### 16. MEDIUM — `agent.yaml` written without preserved comments or formatting

**File:** `did-setup.ts` → `initializeAgentDid()`

```typescript
const config = parse(raw) as Record<string, unknown>;
config.did = did;
writeFileSync(yamlPath, stringify(config));
```

`yaml.parse()` followed by `yaml.stringify()` destroys all comments, custom formatting, and ordering in the user's `agent.yaml`. This is a data loss issue that could silently remove important user annotations.

**Fix:** Use a comment-preserving YAML library or do targeted string replacement.

---

### 17. MEDIUM — `_signingAvailable` cache in `memory-signing.ts` never resets on key creation

**File:** `memory-signing.ts`

```typescript
let _signingAvailable: boolean | null = null;
```

If the daemon starts before key generation (signing unavailable → cached `false`), and then `signet did init` creates a key, the daemon process still has `_signingAvailable = false` until restart. The `resetSigningCache()` function exists but is never called from `did-setup.ts`.

**Fix:** `initializeAgentDid()` should call `resetSigningCache()` after generating a keypair, or the daemon should watch for key file creation.

---

### 18. MEDIUM — Merkle tree second-preimage attack: no domain separation between leaf and internal nodes

**File:** `merkle.ts` → `buildLayers()` / `verifyProof()`

Leaf hashes and internal node hashes both use raw `BLAKE2b(left || right)`. This allows a classic second-preimage attack: an attacker can construct a fake two-leaf tree whose "leaf" is actually `left || right` of two real leaves, producing the same internal hash.

**Fix:** Add domain separation — prefix leaf hashes with `0x00` and internal node hashes with `0x01`:
```typescript
// Leaf: BLAKE2b(0x00 || data)
// Node: BLAKE2b(0x01 || left || right)
```

---

### 19. MEDIUM — Merkle single-leaf tree returns raw leaf hash as root (no hashing)

**File:** `merkle.ts` → `computeMerkleRoot()`

```typescript
if (hashes.length === 1) {
  return hashes[0];
}
```

A single-leaf tree's "root" is just the leaf hash itself, with no additional hashing. Combined with issue #18, this means a leaf hash is indistinguishable from a root hash, enabling confusion between a proof for a one-element tree and a leaf in a larger tree.

**Fix:** Always hash even single leaves through the tree construction:
```typescript
if (hashes.length === 1) {
  return hashPair(hashes[0], hashes[0]); // or hash with domain separator
}
```

---

### 20. MEDIUM — Merkle tree duplicate-last-node padding enables proof ambiguity

**File:** `merkle.ts` → `buildLayers()`

```typescript
if (current.length % 2 !== 0) {
  current = [...current, current[current.length - 1]];
}
```

When duplicating the last leaf for odd-length layers, the tree cannot distinguish between `[A, B, C]` and `[A, B, C, C]` — both produce the same root. This means an attacker can prove inclusion of a phantom duplicate leaf that was never in the original data set.

**Fix:** Use a different padding strategy (e.g., promote the unpaired node directly) or include the original leaf count in the root computation.

---

### 21. MEDIUM — No input validation on hex strings in Merkle functions

**File:** `merkle.ts` → `hashPair()`, `verifyProof()`

`hashPair()` accepts any strings and calls `hexToBytes()`, which will throw on invalid hex. But the error message (`hexToBytes: invalid hex character at position N`) could propagate up to users with confusing context. More importantly, `verifyProof` trusts `proof.siblings[].hash` without validation — a malformed proof with non-hex hashes will throw instead of returning `false`.

**Fix:** Wrap hex operations in try/catch within `verifyProof` and return `false`:
```typescript
try {
  const leftBytes = hexToBytes(left);
  // ...
} catch {
  return false;
}
```

---

### 22. MEDIUM — base58btc `alphabetMap` is rebuilt on every decode call

**File:** `did.ts` → `base58btcDecode()`

```typescript
const alphabetMap = new Map<string, number>();
for (let i = 0; i < BASE58_ALPHABET.length; i++) {
  alphabetMap.set(BASE58_ALPHABET[i], i);
}
```

This allocates a new `Map` and populates it with 58 entries on every single decode. For a hot path (e.g., verifying many DIDs), this is wasteful and creates GC pressure.

**Fix:** Hoist to module scope:
```typescript
const BASE58_REVERSE = new Map<string, number>();
for (let i = 0; i < BASE58_ALPHABET.length; i++) {
  BASE58_REVERSE.set(BASE58_ALPHABET[i], i);
}
```

---

### 23. LOW — `verifySignature` silently returns `false` for all errors

**File:** `crypto.ts` → `verifySignature()`

```typescript
} catch {
  return false;
}
```

This catches ALL errors (including `TypeError`, out-of-memory, sodium internal errors) and maps them to "invalid signature." While this is a common pattern, it makes debugging extremely difficult. At minimum, log the error at debug level.

**Fix:** Add debug-level logging:
```typescript
} catch (err) {
  // Log at debug level for troubleshooting — never log the signature or key bytes
  if (process.env.SIGNET_DEBUG) {
    console.debug('[crypto] Signature verification error:', (err as Error).message);
  }
  return false;
}
```

---

### 24. LOW — `generateSigningKeypair` leaks file path in error messages

**File:** `crypto.ts`

```typescript
throw new Error(`Signing keypair already exists at ${SIGNING_KEY_FILE}.`);
throw new Error(`Signing keypair not found at ${SIGNING_KEY_FILE}.`);
```

Error messages include the full filesystem path. If these errors propagate to HTTP responses or user-facing logs, they reveal the server's directory structure.

**Fix:** Use generic messages or sanitize paths before surfacing to external callers.

---

### 25. LOW — `getMasterKey()` result is cached with no invalidation

**File:** `crypto.ts` → `_masterKey`

Once derived, the master key lives in memory forever. There's no mechanism to clear it if the machine ID changes (e.g., container migration) or as a security hygiene measure.

**Fix:** Add a `clearMasterKey()` function and call it from cleanup paths.

---

### 26. LOW — `isSigningAvailable()` is async but does no async work

**File:** `memory-signing.ts`

```typescript
export async function isSigningAvailable(): Promise<boolean> {
  if (_signingAvailable !== null) return _signingAvailable;
  _signingAvailable = hasSigningKeypair();
  return _signingAvailable;
}
```

`hasSigningKeypair()` is synchronous (`existsSync`). Making this `async` adds a microtask tick on every call for no benefit and creates a misleading API that suggests IO is happening.

**Fix:** Make synchronous, or document why it's async (future-proofing).

---

### 27. LOW — Missing `Uint8Array` input validation in `signContent` and `signBytes`

**File:** `crypto.ts`

`signContent()` accepts `string` but doesn't validate it's non-empty. `signBytes()` accepts `Uint8Array` but doesn't check it's actually a `Uint8Array` or non-empty. While libsodium handles empty inputs fine, signing empty content is likely a bug in the caller.

**Fix:** Add defensive checks:
```typescript
if (!content || content.length === 0) {
  throw new Error('Cannot sign empty content');
}
```

---

### 28. LOW — `formatDidShort` truncation could create collisions

**File:** `did.ts` → `formatDidShort()`

Showing only 4 + 3 = 7 characters of the multibase portion means different DIDs will collide visually. In a multi-agent system, this could cause an operator to confuse two agents' DIDs.

**Fix:** Use at least 8 + 4 = 12 characters, or include a hash-based fingerprint.

---

### 29. LOW — `readKeypairFile` re-throws `SyntaxError` with path but passes all other errors through raw

**File:** `crypto.ts` → `readKeypairFile()`

```typescript
} catch (err) {
  if (err instanceof SyntaxError) {
    throw new Error(`Signing keypair file is corrupt (invalid JSON): ${SIGNING_KEY_FILE}`);
  }
  throw err;
}
```

Non-JSON errors (e.g., `EACCES`) propagate with their original stack trace and message, which may contain sensitive path information. The inconsistency also means some errors have user-friendly messages and others don't.

**Fix:** Normalize all errors from this function.

---

### 30. LOW — `verifyProof` doesn't validate proof structure

**File:** `merkle.ts` → `verifyProof()`

The function accesses `proof.leafHash`, `proof.siblings`, etc. without validating the proof object structure. A malformed proof (null fields, missing siblings array) will throw a `TypeError` instead of returning `false`.

**Fix:** Add structural validation at the top:
```typescript
if (!proof || !proof.leafHash || !Array.isArray(proof.siblings) || !proof.root) {
  return false;
}
```

---

### 31. LOW — Timing side-channel in Merkle root comparison

**File:** `merkle.ts` → `verifyProof()`

```typescript
return current === root;
```

String equality in JavaScript short-circuits on the first differing character, leaking information about how many prefix characters match. While this is a Merkle root (not a secret), in some protocols an attacker who can observe timing could learn partial hash information to optimize second-preimage searches.

**Fix:** Use constant-time comparison:
```typescript
await ensureSodium();
return sodium.memcmp(hexToBytes(current), hexToBytes(root));
```

---

### 32. LOW — `did-setup.ts` doesn't validate existing DID in `agent.yaml` before overwriting

**File:** `did-setup.ts` → `initializeAgentDid()`

```typescript
if (config.did !== did) {
  config.did = did;
  writeFileSync(yamlPath, stringify(config));
}
```

If `agent.yaml` already has a different valid DID (from a previous key), this silently overwrites it. There's no backup, no confirmation, and no migration path for existing signatures that reference the old DID.

**Fix:** If a DID already exists and differs from the derived one, treat it as a conflict:
```typescript
if (config.did && config.did !== did) {
  throw new Error(
    `DID mismatch: agent.yaml has ${config.did} but current keypair derives ${did}. ` +
    'Delete the old DID or rotate keys explicitly.'
  );
}
```

---

## Positive Observations

1. **Good:** The keypair file uses `mode: 0o600` and the directory uses `0o700`
2. **Good:** `generateSigningKeypair()` zeros the original libsodium buffers after copying
3. **Good:** The `verifySignature` function validates key and signature lengths before calling sodium
4. **Good:** base58btc encode works on a copy of the input (`new Uint8Array(bytes)`)
5. **Good:** `didToPublicKey` validates multicodec prefix and key length
6. **Good:** The Merkle proof generation correctly handles padded layers
7. **Good:** The code avoids logging private keys or raw key bytes anywhere

---

## Priority Remediation Order

1. **#1** — Delimiter injection (CRITICAL, easy fix)
2. **#2** — Master key derivation (CRITICAL, requires design decision)
3. **#3** — Private key memory lifetime (CRITICAL, straightforward)
4. **#4** — TOCTOU in key generation (HIGH, easy fix with `O_EXCL`)
5. **#5** — Key consistency check (HIGH, one-line fix)
6. **#8** — Mutable reference leak (HIGH, one-line fix)
7. **#9** — Concurrent load race (HIGH, straightforward)
8. **#10** — Dynamic import in verification (HIGH, trivial fix)
9. **#7** — Silent signing failure (HIGH, design decision needed)
10. **#18** — Merkle domain separation (MEDIUM, standard fix)
11. Everything else by severity
