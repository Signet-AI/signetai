# 🔒 Security Audit: On-Chain & Federation Modules

**Scope:** `packages/core/src/chain/`, `packages/core/src/federation/`, `packages/contracts/`  
**Branch:** `web3-identity`  
**Auditor:** Automated deep review  
**Date:** 2025-07-14  

**Severity Levels:**  
- 🔴 **CRITICAL** — Exploitable vulnerability, data loss, or fund theft  
- 🟠 **HIGH** — Significant security risk or logic bug  
- 🟡 **MEDIUM** — Correctness issue, defense-in-depth gap  
- 🔵 **LOW** — Code quality, best practice violation, minor edge case  
- ⚪ **INFO** — Observation, suggestion, or note  

---

## Summary

| Severity | Count |
|----------|-------|
| 🔴 CRITICAL | 5 |
| 🟠 HIGH | 9 |
| 🟡 MEDIUM | 12 |
| 🔵 LOW | 10 |
| ⚪ INFO | 6 |
| **Total** | **42** |

---

## 🔴 CRITICAL Findings

### C-1: Solidity — DID Registration Allows Squatting of Token ID 0

**File:** `packages/contracts/src/SignetIdentity.sol`, line 64  
**Description:** The check `require(didToTokenId[keccak256(bytes(did))] == 0, "DID already registered")` uses `0` as the sentinel "not registered" value. However, `_nextTokenId` starts at `0` and is pre-incremented to `1` for the first mint (line 63: `uint256 tokenId = ++_nextTokenId`). This means token ID `0` is never minted, so the sentinel works **for now**.

But the `didToTokenId` mapping returns `0` for *any* key that was never set (Solidity default). If someone calls `getIdentityByDID()` with a never-registered DID, the `require(tokenId != 0, "DID not found")` correctly reverts. **However**, this also means the very first DID registered will get token ID `1`, and there is no way to register a DID that maps to token 0 — which is fine. The real issue is: **a second registration of the same publicKeyHash is blocked, but the `publicKeyRegistered` mapping is never cleared if the NFT is burned or transferred**. If the token is burned (ERC721 has no burn by default, but could be added), the DID slot is permanently consumed.

**Actual Critical Issue:** The `register()` function has **no authorization check**. Anyone can call `register()` with *any* DID string and *any* publicKeyHash. This means:
- An attacker can **front-run** a legitimate agent's registration by watching the mempool and registering the same DID first with their own address
- An attacker can register `did:signet:base:0xVICTIM_ADDRESS` before the victim does
- The attacker then "owns" that identity NFT

**Severity:** 🔴 CRITICAL  
**Fix:** Add a requirement that the DID must encode the caller's address (e.g., `did:signet:base:<msg.sender>`), or require a signature proving the caller owns the private key corresponding to the `publicKeyHash`.

---

### C-2: Payment Header Replay — No Nonce Tracking

**File:** `packages/core/src/chain/payments.ts`, lines 119-159  
**Description:** `verifyPaymentHeader()` validates the signature, amount, and timestamp (5-min window), but **never records or checks if a nonce has been used before**. Within the 5-minute validity window, the same payment header can be presented multiple times. There is no server-side nonce set, no database lookup, no replay protection beyond the timestamp.

An attacker who intercepts a valid `X-PAYMENT` header can replay it multiple times within 5 minutes.

**Severity:** 🔴 CRITICAL  
**Fix:** Maintain a database table (or in-memory set with TTL) of used nonces. On verification, check `nonce` hasn't been seen before, then store it. Purge nonces older than 5 minutes.

---

### C-3: Sync — Received Memories Marked "Verified" Without Actual Signature Verification

**File:** `packages/core/src/federation/sync.ts`, lines 106-113  
**Description:** When processing received memories in `processSyncResponse()`:
```typescript
memory.signature && memory.signerDid ? 1 : 0,
```
The `verified` field is set to `1` (true) merely because the `signature` and `signerDid` fields *exist* on the incoming data — **not because the signature was actually verified against the content**. A malicious peer can send fabricated memories with any `signature` and `signerDid` strings, and they'll be marked as "verified."

**Severity:** 🔴 CRITICAL  
**Fix:** Actually verify the memory signature using `verifySignature(memory.content, memory.signature, publicKeyFromDid(memory.signerDid))`. Only set `verified = 1` if that check passes. Import the necessary crypto functions and DID resolution.

---

### C-4: Server Handshake — Peer Authenticated Before Counter-Challenge Verified

**File:** `packages/core/src/federation/server.ts`, lines 226-228  
**Description:** In `handleHandshake()`, the server sets `peer.authenticated = true` immediately after `respondToHandshake()` succeeds — but the counter-challenge response from the initiator has not been verified yet. The 3-step handshake is:
1. Initiator → HANDSHAKE (with challenge)
2. Responder → HANDSHAKE_ACK (signs challenge, sends counter-challenge)  
3. Initiator → signs counter-challenge (proves identity to responder)

The server skips step 3 verification. After step 2, the server marks the peer as authenticated. The client does send the counter-challenge response (as a PING payload), but the server's PING handler never checks it.

This means: **The server proves the initiator's DID via the message signature on the HANDSHAKE, but the mutual authentication is incomplete.** An attacker who can forge or replay a HANDSHAKE message (within the 5-minute window) could connect without proving private key possession via the counter-challenge.

**Severity:** 🔴 CRITICAL  
**Fix:** Do NOT set `peer.authenticated = true` until the counter-challenge response is received and verified. Add a `HANDSHAKE_COMPLETE` message type (or check the counter-challenge response in the PING handler). Only after `verifyCounterChallengeResponse()` passes should the peer be authenticated.

---

### C-5: Memory Root Padding Corrupts Hash

**File:** `packages/core/src/chain/contract.ts`, lines 143-145  
**Description:** 
```typescript
const rootBytes32 = memoryRoot.startsWith("0x")
    ? memoryRoot.padEnd(66, "0")
    : `0x${memoryRoot}`.padEnd(66, "0");
```
This pads the hex string with trailing zeros to reach 66 characters (0x + 64 hex chars). This is **wrong** if `memoryRoot` is a full keccak256 hash (which it is — 32 bytes = 64 hex chars + "0x" prefix = 66 chars). If the hash is already 66 characters, `padEnd` is a no-op and it's fine. But if a hash is truncated or not 0x-prefixed, **right-padding with zeros changes the hash value**. This means the on-chain root won't match the locally-computed root, silently breaking all Merkle proof verification.

**Severity:** 🔴 CRITICAL  
**Fix:** Validate that the root is exactly 66 characters (with 0x prefix) or 64 characters (without). Throw an error if it's the wrong length instead of silently padding:
```typescript
const rootBytes32 = memoryRoot.startsWith("0x") ? memoryRoot : `0x${memoryRoot}`;
if (rootBytes32.length !== 66) {
    throw new Error(`Invalid memory root length: expected 66 chars (0x + 64 hex), got ${rootBytes32.length}`);
}
```

---

## 🟠 HIGH Findings

### H-1: Solidity — No Transfer Restriction on Identity NFTs

**File:** `packages/contracts/src/SignetIdentity.sol`  
**Description:** Identity NFTs can be freely transferred via ERC-721's `transferFrom` / `safeTransferFrom`. After transfer, the new owner can:
- Call `anchorMemory()` with arbitrary roots (they pass the `ownerOf` check)
- Call `updateMetadata()` with arbitrary URIs
- Effectively hijack the agent's on-chain identity

An identity NFT represents a DID bound to a specific public key. Allowing transfer breaks this binding — the new owner doesn't have the original private key.

**Severity:** 🟠 HIGH  
**Fix:** Override `_update()` (or `_beforeTokenTransfer` in older OZ) to make the token soulbound (non-transferable), or at minimum require re-binding the `publicKeyHash` on transfer.

---

### H-2: Solidity — `register()` Allows Registering with bytes32(0) publicKeyHash

**File:** `packages/contracts/src/SignetIdentity.sol`, line 60  
**Description:** There's no check that `publicKeyHash != bytes32(0)`. The `publicKeyRegistered[bytes32(0)]` starts as `false`, so the first caller can register with a zero hash. After that, no one else can use `bytes32(0)`, but having a zero public key hash is meaningless and breaks the key-identity binding.

**Severity:** 🟠 HIGH  
**Fix:** Add `require(publicKeyHash != bytes32(0), "Invalid public key hash");`

---

### H-3: Solidity — Empty DID String Can Be Registered

**File:** `packages/contracts/src/SignetIdentity.sol`, line 64  
**Description:** `register("")` would compute `keccak256(bytes(""))` which is a valid hash, and since `didToTokenId[hash]` is 0, the check passes. An empty string DID is nonsensical and consumes the slot.

**Severity:** 🟠 HIGH  
**Fix:** Add `require(bytes(did).length > 0, "DID cannot be empty");`

---

### H-4: Tag Filter SQL Injection in Publisher

**File:** `packages/core/src/federation/publisher.ts`, lines 183-186  
**Description:**
```typescript
params.push(...rule.tags.map((t) => `%${t}%`));
```
While parameterized queries prevent classic SQL injection, the `LIKE` pattern with user-controlled content allows **LIKE injection**. If a tag contains `%` or `_` characters, the filter becomes overly broad. For example, a tag of `%` would match every memory (`LIKE '%%'`).

More importantly, tags from publish rules are user-configurable. A rule with `tags: ["%"]` would inadvertently share ALL memories with the peer, bypassing the selective publishing intent.

**Severity:** 🟠 HIGH  
**Fix:** Escape `%` and `_` in tag values before LIKE matching, or switch to exact JSON array matching (e.g., check if the tags column contains the exact tag string using JSON functions).

---

### H-5: Federation Client — Counter-Challenge Response Sent as PING, Never Verified by Server

**File:** `packages/core/src/federation/client.ts`, lines 120-125  
**Description:** The client sends the counter-challenge response embedded in a PING message:
```typescript
const pingMsg = await createMessage("PING", {
    counterChallengeResponse: counterResponse,
}, config.did);
```
But the server's PING handler (server.ts, lines 172-175) simply responds with PONG — it never extracts or verifies `counterChallengeResponse`. This makes the mutual authentication one-directional: the server verifies the client (via HANDSHAKE message signature), but the server's counter-challenge is never checked.

**Severity:** 🟠 HIGH (directly related to C-4)  
**Fix:** The server PING handler should check if `peer.counterChallenge` is set, extract `counterChallengeResponse` from the payload, and call `verifyCounterChallengeResponse()`. Only then clear `peer.counterChallenge`.

---

### H-6: WebSocket Server — No Maximum Connection Limit

**File:** `packages/core/src/federation/server.ts`  
**Description:** The server accepts unlimited WebSocket connections with no maximum. An attacker could open thousands of connections, exhausting server memory and file descriptors (DoS).

**Severity:** 🟠 HIGH  
**Fix:** Track connection count. Reject new connections with `ws.close(1013, "Try again later")` when at capacity. Also consider per-IP connection limits.

---

### H-7: WebSocket Server — No Maximum Message Size Limit

**File:** `packages/core/src/federation/server.ts`  
**Description:** The WebSocket server does not configure `maxPayload` on the `WebSocketServer`. A malicious peer could send extremely large messages (e.g., hundreds of MB) to exhaust memory.

**Severity:** 🟠 HIGH  
**Fix:** Configure `new WebSocketServer({ port, maxPayload: 1_048_576 })` (1MB or appropriate limit).

---

### H-8: Session Key Permissions — No Function Selector Check When No Data

**File:** `packages/core/src/chain/session-keys.ts`, lines 243-250  
**Description:** The function selector check only runs `if (key.permissions.allowedFunctions.length > 0 && txData.data)`. If `allowedFunctions` is non-empty but `txData.data` is undefined (plain ETH transfer), the check is skipped entirely. This means a session key restricted to specific function calls can still send arbitrary ETH transfers.

**Severity:** 🟠 HIGH  
**Fix:** If `allowedFunctions.length > 0` and `txData.data` is falsy, the transaction should be rejected (it's trying to do a plain transfer when only specific function calls are allowed).

---

### H-9: Wallet ID Generation Uses Math.random() — Predictable

**File:** `packages/core/src/chain/wallet.ts`, line 20  
**Description:** `Math.random().toString(36).slice(2, 10)` is used for ID generation. `Math.random()` is not cryptographically secure and can be predicted. While these are database IDs (not secrets), predictable IDs in a multi-tenant or adversarial context could enable ID collision attacks.

The same pattern appears in:
- `contract.ts` line 46
- `session-keys.ts` line 61
- `payments.ts` line 63

**Severity:** 🟠 HIGH  
**Fix:** Use `randomBytes(8).toString('hex')` from `node:crypto` instead of `Math.random()` for all ID generation. Some files already import `randomBytes` (session-keys, payments) but still use `Math.random()`.

---

## 🟡 MEDIUM Findings

### M-1: Merkle Tree — Odd-Node Promotion Weakens Proof Security

**File:** `packages/core/src/chain/merkle.ts`, lines 88-92  
**Description:** When the current layer has an odd number of nodes, the last node is promoted directly to the next layer without hashing:
```typescript
nextLayer.push(currentLayer[i]);
```
This is a common approach but it means an attacker who can control the last leaf in an odd-sized tree gets their hash promoted unchanged. Standard practice is to duplicate the last node and hash it with itself (`hashPair(node, node)`), which makes proofs more uniform. The inconsistency also complicates proof generation (lines 148-152), which must handle the "no sibling" case.

**Severity:** 🟡 MEDIUM  
**Fix:** Duplicate the odd node: `nextLayer.push(hashPair(currentLayer[i], currentLayer[i]))`. Update proof generation accordingly.

---

### M-2: Merkle Proof — `verifyMemoryProof` Ignores Position Data

**File:** `packages/core/src/chain/merkle.ts`, lines 172-181  
**Description:** The `verifyMemoryProof` function calls `hashPair(current, sibling.hash)` which internally sorts the two inputs. This means the `position` field in the proof (`"left"` or `"right"`) is completely ignored. While the sorted-pair approach works for verification (and is simpler for on-chain verification), storing position data that is never used is misleading. More critically, this means **different trees could produce the same root** if leaves happen to collide after sorting — a second-preimage concern.

**Severity:** 🟡 MEDIUM  
**Fix:** Either remove the `position` field from proofs (since it's unused), or use position-aware hashing (don't sort, use the recorded position). If keeping sorted pairs for on-chain compatibility, document this clearly.

---

### M-3: Protocol Timestamp — No Monotonic Check

**File:** `packages/core/src/federation/protocol.ts`, lines 71-77  
**Description:** The 5-minute replay window allows message reuse within that window. There's no per-peer sequence number or nonce to detect replayed messages. If an attacker captures a valid `SYNC_REQUEST` message, they can replay it within 5 minutes.

**Severity:** 🟡 MEDIUM  
**Fix:** Add per-peer message nonces or sequence numbers. Track the highest timestamp seen from each peer and reject older timestamps (monotonic check).

---

### M-4: Wallet — Private Key Exists in Memory as String

**File:** `packages/core/src/chain/wallet.ts`, lines 118-119  
**Description:** `decryptPrivateKey()` returns the raw hex private key as a JavaScript string. Strings in JS are immutable and cannot be zeroed from memory. The key persists in heap memory until garbage collected. While `masterKey.fill(0)` is called, the actual private key string lives on indefinitely.

The same issue exists in `session-keys.ts` lines 105-106.

**Severity:** 🟡 MEDIUM  
**Fix:** Use `Uint8Array` for private key material instead of strings. Zero the array after use. Consider using ethers.js's `SigningKey` directly with byte arrays.

---

### M-5: Payment — Float Comparison for Financial Values

**File:** `packages/core/src/chain/payments.ts`, lines 68 and throughout  
**Description:** `parseFloat(amount)` is used extensively for comparing ETH values. Floating point arithmetic is imprecise for decimal values. Example: `parseFloat("0.1") + parseFloat("0.2") !== 0.3`. This could cause incorrect limit enforcement.

Also in `session-keys.ts` line 237: `parseFloat(txData.value) > parseFloat(key.permissions.maxTransactionValue)`.

**Severity:** 🟡 MEDIUM  
**Fix:** Use `ethers.parseEther()` to convert to `bigint` (wei) for all comparisons. Compare wei values instead of floating-point ETH strings.

---

### M-6: Server — Blocked Peer Can Reconnect with Different WebSocket

**File:** `packages/core/src/federation/server.ts`, lines 195-203  
**Description:** Blocked peer detection only happens during the HANDSHAKE handler. A blocked peer is rejected with `ws.close()`. But the block check uses DID lookup — if the attacker connects with a new DID, they bypass the block. There's no IP-based blocking.

**Severity:** 🟡 MEDIUM  
**Fix:** Add IP-based rate limiting and blocking in addition to DID-based blocking.

---

### M-7: Publisher — LIKE Query Filter Is Case-Sensitive and Fragile

**File:** `packages/core/src/federation/publisher.ts`, lines 188-189  
**Description:** `content LIKE ?` with `%query%` is case-sensitive in SQLite by default (for ASCII). This means the query filter `"hello"` won't match content containing `"Hello"`. Users may not realize their publish rules aren't matching due to case differences.

**Severity:** 🟡 MEDIUM  
**Fix:** Use `content LIKE ? COLLATE NOCASE` or `LOWER(content) LIKE LOWER(?)`.

---

### M-8: Sync — Deduplication by Content Only, Not by ID

**File:** `packages/core/src/federation/sync.ts`, lines 102-105  
**Description:**
```typescript
const existing = db.prepare(
    `SELECT id FROM federation_received
     WHERE peer_id = ? AND original_content = ?`,
).get(peerId, memory.content);
```
Deduplication is by `(peer_id, original_content)` rather than by the memory's original ID. Two different memories with identical content from the same peer would be treated as duplicates. Additionally, comparing potentially large content strings is expensive.

**Severity:** 🟡 MEDIUM  
**Fix:** Deduplicate by `(peer_id, memory_id)` using the memory's original ID, or by `(peer_id, content_hash)` which is more efficient.

---

### M-9: Solidity — No memoryCount Monotonicity Check

**File:** `packages/contracts/src/SignetIdentity.sol`, line 89  
**Description:** `anchorMemory()` accepts any `memoryCount` value, including values lower than the current count. An owner (or compromised key) could anchor a lower count, making it appear memories were deleted. There's no enforcement that `memoryCount >= identities[tokenId].memoryCount`.

**Severity:** 🟡 MEDIUM  
**Fix:** Add `require(memoryCount >= identities[tokenId].memoryCount, "Memory count cannot decrease");`

---

### M-10: Server Rate Limit — Per-Connection, Not Per-DID

**File:** `packages/core/src/federation/server.ts`, lines 81-90  
**Description:** Rate limiting tracks `messageCount` per `ConnectedPeer` object (i.e., per WebSocket connection). An attacker can simply open multiple connections to multiply their message allowance. Combined with H-6 (no connection limit), this makes rate limiting ineffective.

**Severity:** 🟡 MEDIUM  
**Fix:** Track rate limits per DID (after authentication) or per IP address. Use a shared rate limit map.

---

### M-11: Contract ABI — Missing `publicKeyRegistered` Accessor

**File:** `packages/core/src/chain/contract.ts`, lines 28-49 vs `SignetIdentity.sol` lines 28-29  
**Description:** The Solidity contract has a public mapping `publicKeyRegistered` which auto-generates a getter, but it's not in the hardcoded ABI. While not currently used in TypeScript, it's an asymmetry that could confuse developers.

More importantly, the ABI declares `identities(uint256)` as returning a flat tuple, but the Solidity auto-generated getter for a struct mapping actually returns each field individually. This may cause decoding issues depending on ethers.js version.

**Severity:** 🟡 MEDIUM  
**Fix:** Add `publicKeyRegistered` to the ABI if needed. Test that the `identities()` getter decoding works correctly with ethers v6. Consider using a compiled ABI instead of hardcoded strings.

---

### M-12: Client — No Signature Verification on MEMORY_ACK

**File:** `packages/core/src/federation/client.ts`, lines 135-143  
**Description:** When the client receives a `MEMORY_ACK`, it resolves the pending promise without verifying the message signature. A MITM could forge ACK messages.

**Severity:** 🟡 MEDIUM  
**Fix:** Call `verifyMessage(message, peerPublicKey)` before resolving MEMORY_ACK promises.

---

## 🔵 LOW Findings

### L-1: Wallet — `checkWalletFunds` Uses parseFloat for ETH Comparison

**File:** `packages/core/src/chain/wallet.ts`, lines 166-168  
**Description:** `parseFloat(balance) >= parseFloat(minEth)` — same float issue as M-5 but lower impact since this is just an informational check.

**Severity:** 🔵 LOW  
**Fix:** Use `ethers.parseEther()` for bigint comparison.

---

### L-2: Contract — `getIdentityByDID` Returns Uninitialized Struct for Token 0

**File:** `packages/contracts/src/SignetIdentity.sol`, line 105  
**Description:** If `didToTokenId` returns 0 (DID not found), the require catches it. But if someone somehow gets token 0 mapped (impossible with current logic), `identities[0]` would return an empty struct. This is a theoretical concern only.

**Severity:** 🔵 LOW  
**Fix:** No action needed with current logic. Add a comment noting the token-0 sentinel assumption.

---

### L-3: Deploy Script — No Contract Address Output to File

**File:** `packages/contracts/scripts/deploy.ts`  
**Description:** The deploy script only logs the contract address to console. There's no automated way to capture the address into a config file or `.env` for the TypeScript code to use. This is an operational gap.

**Severity:** 🔵 LOW  
**Fix:** Write the deployed address to a JSON file (e.g., `deployments/base-sepolia.json`).

---

### L-4: Hardhat Config — No Gas Price or Gas Limit Configuration

**File:** `packages/contracts/hardhat.config.ts`  
**Description:** The `baseSepolia` and `base` network configs don't specify gas settings. For mainnet deployment, this could lead to unexpected gas costs or failed transactions during congestion.

**Severity:** 🔵 LOW  
**Fix:** Add `gasPrice` or `maxFeePerGas` settings, or at least document the expected gas behavior.

---

### L-5: Client — `pendingResponses` Map Never Cleaned on Timeout

**File:** `packages/core/src/federation/client.ts`  
**Description:** When a sync or push times out, the entry is deleted from `pendingResponses`. But if the response arrives *after* the timeout, the message handler won't find it in the map and silently drops it. This is correct behavior but could mask debugging issues. The `on("close")` handler does clean up.

**Severity:** 🔵 LOW  
**Fix:** Log a warning in debug mode when a response arrives for an unknown/timed-out request.

---

### L-6: Server — Error Messages Leak Internal State

**File:** `packages/core/src/federation/server.ts`, lines 140-144  
**Description:**
```typescript
message: err instanceof Error ? err.message : String(err),
```
Error messages from unhandled exceptions are sent to the peer. This could leak internal file paths, database errors, or other sensitive information to an attacker.

**Severity:** 🔵 LOW  
**Fix:** Send a generic "Internal error" message. Log the detailed error server-side only.

---

### L-7: Federation Types — `FederationDb` Interface Identical to `ChainDb`

**File:** `packages/core/src/federation/types.ts`, lines 162-170 vs `chain/types.ts`  
**Description:** Both modules define identical `Db` interfaces independently. This is code duplication and could diverge over time.

**Severity:** 🔵 LOW  
**Fix:** Extract a shared `SqliteDb` interface into a common module.

---

### L-8: Peer Manager — `removePeer` Doesn't Check Publish Rules

**File:** `packages/core/src/federation/peer-manager.ts`, lines 101-107  
**Description:** When a peer is removed, shared/received records are cleaned up, but `federation_publish_rules` entries that reference this peer in their `peer_ids` JSON array are not updated. Stale peer IDs in rules won't cause errors (the peer just won't match), but it's messy.

**Severity:** 🔵 LOW  
**Fix:** Optionally clean up stale peer references in publish rules on peer removal.

---

### L-9: Wallet Import — Unused Type Import

**File:** `packages/core/src/chain/wallet.ts`, line 4  
**Description:** `CHAIN_CONFIGS` is imported as a type but never used in the file.

**Severity:** 🔵 LOW  
**Fix:** Remove the unused import.

---

### L-10: Session Keys — Daily Limit Reset Is UTC-Based, Not Configurable

**File:** `packages/core/src/chain/payments.ts`, lines 221-224  
**Description:** `todayStart.setUTCHours(0, 0, 0, 0)` means daily limits reset at UTC midnight. Users in different time zones may find this confusing. Not a bug, but a UX consideration.

**Severity:** 🔵 LOW  
**Fix:** Document the UTC-based reset. Consider making the daily window configurable (rolling 24h vs calendar day).

---

## ⚪ INFO Observations

### I-1: Solidity — Contract Uses OpenZeppelin v5 Patterns

**File:** `packages/contracts/src/SignetIdentity.sol`  
**Description:** The contract uses `Ownable(msg.sender)` and `_requireOwned()` which are OpenZeppelin v5 patterns. The `Ownable` inheritance is imported but `onlyOwner` modifier is never used — the owner has no special privileges beyond NFT ownership. The `Ownable` import adds unnecessary code size.

**Fix (optional):** Remove `Ownable` inheritance if owner privileges aren't needed. The current contract doesn't use `onlyOwner` anywhere.

---

### I-2: No Event Indexing on DID String

**File:** `packages/contracts/src/SignetIdentity.sol`  
**Description:** The `IdentityRegistered` event indexes `tokenId` but not the DID. Since DIDs are strings (can't be indexed directly), this is fine, but consider adding an indexed `bytes32 didHash` parameter for efficient off-chain filtering.

---

### I-3: Federation Protocol — No Versioning

**File:** `packages/core/src/federation/protocol.ts` / `types.ts`  
**Description:** There's no protocol version field in messages. If the protocol changes, old and new peers will be incompatible with no negotiation mechanism.

**Fix (suggestion):** Add a `version` field to the handshake payload.

---

### I-4: Merkle Tree — Deterministic Ordering Depends on `created_at`

**File:** `packages/core/src/chain/merkle.ts`, lines 108-111  
**Description:** Memory ordering for Merkle root computation is `ORDER BY created_at ASC`. If two memories have the exact same `created_at` timestamp, the order is undefined (depends on SQLite insertion order), which could produce different roots on different machines.

**Fix (suggestion):** Add `ORDER BY created_at ASC, id ASC` for deterministic tiebreaking.

---

### I-5: Session Keys — No On-Chain Enforcement

**File:** `packages/core/src/chain/session-keys.ts`  
**Description:** Session key permissions (allowed contracts, functions, daily limits) are enforced purely client-side. If an attacker obtains the decrypted session key, they can bypass all permission checks and send arbitrary transactions.

This is acceptable for the current design but should be documented as a trust assumption.

---

### I-6: Payment Header — No Recipient-Side Verification of Payment

**File:** `packages/core/src/chain/payments.ts`  
**Description:** `verifyPaymentHeader()` checks the signature and timestamp, but doesn't verify that a corresponding on-chain transaction actually occurred. The x402 header is essentially a signed promise to pay, not proof of payment. A malicious payer could create a valid header, get the service, and never submit the actual transaction.

The `processPayment()` function does submit the transaction, but the verification and execution are decoupled.

---

## Recommendations Summary

### Immediate Fixes Required (CRITICAL)
1. **C-1**: Add DID-to-caller binding in `register()` or require a proof-of-key-ownership
2. **C-2**: Implement nonce tracking in `verifyPaymentHeader()`
3. **C-3**: Actually verify memory signatures in `processSyncResponse()`
4. **C-4/H-5**: Complete the 3-step handshake — verify counter-challenge before authentication
5. **C-5**: Validate memory root length, throw on mismatch instead of padding

### High Priority
6. Make identity NFTs soulbound (H-1)
7. Add input validation for empty DID and zero publicKeyHash (H-2, H-3)
8. Escape LIKE wildcards in publisher queries (H-4)
9. Add WebSocket connection limits and max payload size (H-6, H-7)
10. Fix session key function selector bypass (H-8)
11. Use crypto.randomBytes for all ID generation (H-9)

### Testing Recommendations
- Fuzz the Solidity `register()` function with edge-case inputs
- Test Merkle tree with 0, 1, 2, 3, and large (1000+) leaf counts
- Test payment replay within 5-minute window
- Test federation handshake with malformed/replayed messages
- Load test WebSocket server with concurrent connections
- Test session key permission bypass with missing `data` field
