# Key Rotation, Federation, and DID Resolution for Signet

**Author:** Research subagent  
**Date:** 2026-02-24  
**Status:** Review / Design Proposal  
**Scope:** Cryptographic identity lifecycle, key rotation ceremonies, federation protocol design, DID resolution strategy

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current State of the Codebase](#2-current-state-of-the-codebase)
3. [The did:key Rotation Problem](#3-the-didkey-rotation-problem)
4. [Comparison of Key Rotation Approaches](#4-comparison-of-key-rotation-approaches)
5. [Recommended Key Rotation Ceremony for Signet](#5-recommended-key-rotation-ceremony-for-signet)
6. [DID Resolution Strategy](#6-did-resolution-strategy)
7. [Federation Protocol Design](#7-federation-protocol-design)
8. [What's Built vs What's Missing](#8-whats-built-vs-whats-missing)
9. [Security Considerations](#9-security-considerations)
10. [Recommendation](#10-recommendation)

---

## 1. Executive Summary

Signet currently uses `did:key` (Ed25519) as its sole DID method. This is elegant — the DID *is* the public key, making verification zero-dependency. But `did:key` is inherently **non-rotatable**: changing the key changes the DID, which breaks all peer relationships, signed memories, and trust graphs.

The existing federation code (Phase 5) is **remarkably complete** for a first implementation — it covers WebSocket transport, DID-verified handshakes with challenge-response, selective memory publishing with privacy rules, peer trust management, and auto-reconnection. What's missing is the identity lifecycle layer above it: key rotation, multi-method DID resolution, and cross-instance discovery.

This document compares three rotation approaches (KERI, did:plc, and a simple signed-log approach), evaluates DID resolution strategies, and proposes a concrete design that fits Signet's architecture — prioritizing simplicity, self-sovereignty, and alignment with the "Option 3: Federated Signet" direction agreed upon with Nicholai.

**Bottom line:** Use a **hybrid did:key + signed rotation log** approach with optional `did:web` for human-readable resolution. This gives Signet key rotation without requiring external infrastructure, stays self-certifying at the core, and can scale to KERI-level security later if needed.

---

## 2. Current State of the Codebase

### 2.1 Cryptographic Layer (`crypto.ts`)

The crypto module is **production-grade**:

- **Ed25519 keypair** via libsodium, stored encrypted at `~/.agents/.keys/signing.enc`
- **Three KDF versions:** v1 (BLAKE2b, legacy), v2 (Argon2id + machineId), v3 (Argon2id + user passphrase) — with migration path via `reEncryptKeypair()`
- **Encrypted-at-rest** with XSalsa20-Poly1305 (secretbox), TTL-cached in memory (5min eviction)
- **Signable payload versioning:** v1 (`contentHash|createdAt|signerDid`) and v2 (adds `memoryId` to prevent cross-memory signature reuse)
- **Path security:** SIGNET_PATH validated against symlinks, traversal, ownership, permissions

**Key observation:** `reEncryptKeypair()` already supports rotating the *encryption wrapper* (KDF upgrade) without changing the keypair. The Ed25519 keypair itself never changes — this is by design but also the limitation we need to solve.

### 2.2 DID Layer (`did.ts`, `did-setup.ts`)

- **did:key method only** — multicodec-prefixed Ed25519 public key, base58btc encoded
- `publicKeyToDid()` / `didToPublicKey()` — bidirectional conversion
- `generateDidDocument()` — produces a W3C-compliant DID Document with Ed25519VerificationKey2020
- `initializeAgentDid()` — bootstrap: generates keypair → derives DID → updates `agent.yaml` → writes `did.json`
- **No rotation support** — `generateSigningKeypair()` throws if a keypair already exists: *"Delete it manually or use a key rotation workflow to replace it."*

### 2.3 Federation Layer (`federation/`)

| Module | What it does | Completeness |
|--------|-------------|-------------|
| `types.ts` | Full type system: peers, messages, sync, publish rules, config | ✅ Complete |
| `protocol.ts` | Signed message creation/verification, 5-min replay window | ✅ Complete |
| `handshake.ts` | 3-step challenge-response with DID verification | ✅ Complete |
| `server.ts` | WebSocket server with rate limiting, heartbeat, message routing | ✅ Complete |
| `client.ts` | WebSocket client with auto-reconnect, exponential backoff | ✅ Complete |
| `peer-manager.ts` | CRUD for peers, trust levels (pending/trusted/blocked) | ✅ Complete |
| `sync.ts` | Bidirectional memory sync with signature verification | ✅ Complete |
| `publisher.ts` | Selective publishing rules (tags, types, importance, peer targeting) | ✅ Complete |

**What the federation code assumes:**
- A peer's DID never changes — DID ↔ public key is a permanent binding
- Peers are discovered manually (endpoint URL must be known)
- Trust is binary: pending → trusted (by operator) → can sync
- No mechanism for DID update notifications between peers

---

## 3. The did:key Rotation Problem

### Why did:key Can't Rotate

The W3C `did:key` spec explicitly states:

> "The `did:key` method does not support key rotation because the identifier is derived directly from the public key material itself. Any change to the cryptographic key would result in an entirely different DID, effectively creating a new identity rather than updating an existing one."

This is a feature, not a bug — `did:key` is *self-certifying*, meaning verification requires zero external lookups. But it means:

1. **Compromised key = compromised identity** — no recovery mechanism
2. **Key weakness** (quantum advances, algorithm deprecation) forces identity abandonment
3. **All signed memories become orphaned** — new DID can't prove continuity with old one
4. **Peer trust graphs break** — every peer must re-establish trust manually

### When Rotation is Needed

| Scenario | Urgency | Impact |
|----------|---------|--------|
| Key compromise (leak, theft) | Critical | All memories/identities suspect |
| Machine migration | Medium | Same agent, new hardware |
| Algorithm upgrade (post-quantum) | Low (years) | Industry-wide migration |
| Routine hygiene | Low | Best practice, debatable necessity |
| Multi-device support | Medium | Same agent on laptop + server |

---

## 4. Comparison of Key Rotation Approaches

### 4.1 KERI (Key Event Receipt Infrastructure)

**How it works:**
- **Key Event Log (KEL):** An append-only log of signed key events (inception, rotation, interaction)
- **Pre-rotation:** At inception, you commit to the *hash* of your next public key. To rotate, you reveal the pre-committed key and commit to the *next* next key. An attacker who steals your current key can't rotate because they don't know the pre-committed next key.
- **Witnesses:** Independent nodes that receipt (countersign) key events, providing a secondary root of trust
- **Self-certifying:** The identifier is derived from the inception event, not from any single key

**Strengths:**
- Post-compromise recovery via pre-rotation (attacker can't use stolen key to rotate)
- No blockchain or central authority required
- Ambient verifiability — any infrastructure can host the KEL
- IETF draft status, serious academic backing

**Weaknesses:**
- **Extremely complex** — the full KERI spec is 100+ pages with witnesses, delegated events, fractionally weighted thresholds
- Pre-rotation requires planning (must generate next keypair at rotation time)
- Witness infrastructure adds operational burden
- Limited library ecosystem outside Python (keripy)
- Overkill for a system with dozens of peers, not millions

**Fit for Signet:** Poor-to-moderate. The pre-rotation concept is brilliant but the full KERI stack is vastly overengineered for agent-to-agent federation. Cherry-picking the pre-rotation idea (without witnesses or CESR encoding) would be valuable.

### 4.2 did:plc (Bluesky/AT Protocol)

**How it works:**
- **Signed operation log:** Each identity has a chain of signed operations (creation → update → update → ...). Each operation references the previous one by hash (DAG-CBOR CID).
- **Rotation keys:** A priority-ordered list of public keys that can sign operations. Higher-priority keys can override lower-priority ones within a 72-hour recovery window.
- **Central directory:** `plc.directory` collects, validates, and serves the operation log. The log is self-certifying but the server provides ordering.
- **DID derivation:** `did:plc:<base32(sha256(genesisOp))[0:24]>` — derived from genesis operation, not from any key

**Strengths:**
- Clean, practical design — battle-tested at Bluesky scale (millions of DIDs)
- Recovery mechanism via higher-priority rotation keys (72h window)
- Operation log is self-certifying — can be verified independently
- Separation of rotation keys (control) and verification keys (signing)

**Weaknesses:**
- **Requires a central directory server** — defeats full decentralization
- Uses ECDSA (secp256k1/P-256) for rotation keys, not Ed25519
- DAG-CBOR serialization adds complexity
- The 72h recovery window is arbitrary and could be exploited by patient attackers

**Fit for Signet:** Moderate. The signed operation log concept is excellent and directly applicable. The central directory requirement doesn't fit Signet's peer-to-peer model, but the concept of a self-certifying operation log that peers can independently verify is very relevant.

### 4.3 Simple Signed Rotation Log (Proposed for Signet)

**How it works:**
- **Rotation log:** An append-only JSON array stored locally and replicated to peers
- **Each entry is dual-signed:** The *old* key signs a statement: "I am transferring control to [newDID] at [timestamp]", and the *new* key countersigns: "I accept control from [oldDID]"
- **Chain of trust:** Entry N references entry N-1 by hash, forming a hash chain back to genesis
- **Peer notification:** On rotation, broadcast a `KEY_ROTATED` message to all connected peers
- **Optional pre-commitment:** At each rotation, optionally include the hash of the *next* public key (KERI-lite)

**Strengths:**
- **Simple** — can be implemented in ~200 lines of TypeScript
- Self-certifying — no external infrastructure needed
- Dual-signature prevents unilateral key seizure
- Hash chain provides tamper-evident history
- Optional pre-commitment adds KERI-level security without KERI complexity
- Fits perfectly with Signet's existing WebSocket federation

**Weaknesses:**
- No independent witnesses (peers must trust the rotation log they receive)
- No recovery if both old and new keys are compromised simultaneously
- No time-windowed recovery (unlike did:plc's 72h window)
- Not a standard — custom protocol

**Fit for Signet:** **Excellent.** This is the sweet spot between simplicity and security for an agent identity system with a manageable peer count.

### 4.4 Comparison Matrix

| Feature | KERI | did:plc | Signed Log |
|---------|------|---------|------------|
| Complexity | Very High | High | Low |
| External infra needed | Witnesses (optional) | Central directory | None |
| Pre-compromise security | ✅ Pre-rotation | ❌ | ⚠️ Optional |
| Post-compromise recovery | ✅ Pre-rotation | ✅ 72h recovery | ❌ |
| Self-certifying | ✅ | ✅ | ✅ |
| DID stability | ✅ (AID) | ✅ (plc hash) | ⚠️ (DID changes, log proves continuity) |
| Ed25519 support | ✅ | ❌ (secp256k1/P-256 only for rotation) | ✅ |
| Library ecosystem | Python (keripy) | TypeScript (AT Protocol) | Custom |
| Peer count scaling | Millions | Millions | Hundreds |
| Implementation effort | Months | Weeks | Days |

---

## 5. Recommended Key Rotation Ceremony for Signet

### 5.1 Data Structures

```typescript
interface RotationEntry {
  /** Monotonically increasing sequence number */
  seq: number;
  /** SHA-256 hash of previous entry (null for genesis) */
  prev: string | null;
  /** The old DID being rotated from */
  fromDid: string;
  /** The new DID being rotated to */
  toDid: string;
  /** ISO-8601 timestamp */
  timestamp: string;
  /** Optional: hash of the *next* public key (KERI-lite pre-commitment) */
  nextKeyHash?: string;
  /** Signature by the OLD key over the rotation payload */
  fromSignature: string;
  /** Signature by the NEW key over the rotation payload */
  toSignature: string;
}

interface RotationLog {
  /** Current active DID */
  currentDid: string;
  /** Genesis DID (never changes — this is the stable identity anchor) */
  genesisDid: string;
  /** Ordered list of rotation entries */
  entries: RotationEntry[];
}
```

### 5.2 Step-by-Step Rotation Ceremony

```
ROTATION CEREMONY
═══════════════════════════════════════════════════════

Step 1: GENERATE NEW KEYPAIR
├── Generate new Ed25519 keypair (newPub, newPriv)
├── Derive new DID: did:key:z6Mk<newPub>
├── Store new keypair temporarily (not yet the active key)
└── If pre-commitment exists from previous rotation:
    └── Verify: hash(newPub) === previousEntry.nextKeyHash
        └── ABORT if mismatch (potential compromise)

Step 2: BUILD ROTATION PAYLOAD
├── rotationPayload = JSON.stringify({
│     seq: currentLog.entries.length,
│     prev: sha256(lastEntry) or null,
│     fromDid: currentDid,
│     toDid: newDid,
│     timestamp: new Date().toISOString(),
│     nextKeyHash: sha256(futurePublicKey) // optional
│   })
└── This is the canonical string both keys will sign

Step 3: DUAL-SIGN
├── fromSignature = sign(rotationPayload, oldPrivateKey)
├── toSignature = sign(rotationPayload, newPrivateKey)
└── Construct complete RotationEntry with both signatures

Step 4: VALIDATE LOCALLY
├── Verify fromSignature with oldPublicKey ✓
├── Verify toSignature with newPublicKey ✓
├── Verify prev hash chain ✓
├── Verify seq is monotonic ✓
└── Verify timestamp is reasonable ✓

Step 5: PERSIST
├── Append entry to rotation log (rotations.json)
├── Swap active keypair: encrypt newPriv → signing.enc
├── Update agent.yaml with new DID
├── Regenerate did.json with new DID document
├── Archive old keypair (encrypted, for audit)
└── ATOMIC: use temp file + rename to prevent corruption

Step 6: NOTIFY PEERS
├── For each connected peer:
│     Send KEY_ROTATION message containing:
│     ├── Full rotation log (or just the new entry if peer has prior log)
│     ├── New DID
│     └── New public key
├── Peer validates rotation chain back to genesis
├── Peer updates stored peer record with new DID/key
└── Peer re-verifies handshake with new key

Step 7: ON-CHAIN UPDATE (if applicable)
├── If agent has on-chain identity (chainAddress):
│     Submit transaction: updateDid(oldDid, newDid, rotationProof)
│     └── rotationProof = the dual-signed rotation entry
└── This provides an additional anchor but is NOT required
```

### 5.3 Verification by Peers

When a peer receives a rotation log, they verify:

1. **Genesis entry** has `prev: null` and `seq: 0`
2. **Each entry's hash chain:** `entry[n].prev === sha256(entry[n-1])`
3. **Each entry's dual signatures:** both fromDid and toDid signatures are valid
4. **Continuity:** `entry[n].fromDid === entry[n-1].toDid` (or genesisDid for entry 0)
5. **Pre-commitment (if used):** `hash(entry[n].toDid.publicKey) === entry[n-1].nextKeyHash`
6. **No forks:** Only one chain from genesis (reject if peer has seen a different chain)

### 5.4 New Federation Message Types

```typescript
// Add to MESSAGE_TYPES:
"KEY_ROTATION"     // Notify peers of key rotation
"KEY_ROTATION_ACK" // Peer acknowledges rotation
"ROTATION_LOG_REQUEST"  // Request full rotation log
"ROTATION_LOG_RESPONSE" // Full rotation log response
```

---

## 6. DID Resolution Strategy

### 6.1 The Spectrum

| Method | Self-Certifying | Human-Readable | Key Rotation | External Deps |
|--------|----------------|----------------|-------------|---------------|
| `did:key` | ✅ | ❌ | ❌ | None |
| `did:web` | ❌ | ✅ | ✅ | DNS + HTTPS |
| `did:plc` | ✅ | ❌ | ✅ | PLC directory |
| `did:peer` | ✅ | ❌ | ❌ | None |
| `did:key` + rotation log | ✅ | ❌ | ✅ | None |

### 6.2 Recommended Approach: did:key Primary + did:web Optional

**Primary identity:** `did:key` — remains the canonical identifier within Signet. Self-certifying, zero-dependency, used for all signing and verification.

**Optional human-readable layer:** `did:web` — for agents that want a human-readable DID pointing to their Signet instance. This is a convenience layer, not a security layer.

#### did:web Setup for Signet Agents

An agent at `signet.example.com` could publish:

```
https://signet.example.com/.well-known/did.json
```

```json
{
  "@context": ["https://www.w3.org/ns/did/v1"],
  "id": "did:web:signet.example.com",
  "alsoKnownAs": ["did:key:z6MkhaXg..."],
  "verificationMethod": [{
    "id": "did:web:signet.example.com#key-1",
    "type": "Ed25519VerificationKey2020",
    "controller": "did:web:signet.example.com",
    "publicKeyMultibase": "z6MkhaXg..."
  }],
  "authentication": ["did:web:signet.example.com#key-1"],
  "service": [{
    "id": "did:web:signet.example.com#federation",
    "type": "SignetFederation",
    "serviceEndpoint": "wss://signet.example.com/federation"
  }]
}
```

**This enables:**
- Human-readable discovery: "connect to `did:web:signet.example.com`"
- Service endpoint discovery: peers find the WebSocket URL automatically
- Rotation transparency: update the `did.json` when keys rotate
- Bidirectional linking: `did:web` document references the `did:key`, and the rotation log anchors the `did:key`

**Trust model:** `did:web` trusts DNS + TLS. It's weaker than `did:key` (which trusts only cryptography), so Signet should always verify the underlying `did:key` even when discovering via `did:web`.

### 6.3 Resolution Flow

```
PEER DISCOVERY & RESOLUTION
═══════════════════════════════════════════════════════

Input: "did:web:signet.example.com" OR "did:key:z6Mk..." OR "wss://..."

Path A: did:web input
├── Fetch https://signet.example.com/.well-known/did.json
├── Extract did:key from alsoKnownAs
├── Extract WebSocket endpoint from services
├── Connect and perform did:key handshake
└── Verify did:key in handshake matches did:web document

Path B: did:key input
├── Need endpoint URL (manual or from peer directory)
├── Connect and perform did:key handshake
└── Direct verification — no intermediaries

Path C: WebSocket URL input
├── Connect and perform handshake
├── Learn peer's did:key from handshake
└── Optionally verify against did:web if peer claims one
```

---

## 7. Federation Protocol Design

### 7.1 Context: "Option 3 — Federated Signet"

From the Feb 18 discussion with Nicholai, the agreed direction is **peer-to-peer pub/sub between Signet instances** where:
- Each bot keeps full local control
- Private memories stay private
- Shared memories propagate via selective publishing
- Lightweight `/publish` endpoint broadcasts tagged memories to subscribed peers

The existing code implements most of this. Below are the gaps and proposed extensions.

### 7.2 Discovery

**Current:** Manual — operator must know the peer's WebSocket URL.

**Proposed: Three discovery mechanisms**

#### a) Direct Connection (existing)
```
signet federation add wss://peer.example.com:8080
```

#### b) did:web Discovery (new)
```
signet federation add did:web:peer.example.com
```
Resolves to `did.json`, extracts WebSocket endpoint, auto-connects.

#### c) Peer Exchange (new — gossip-based)
When two trusted peers are connected, they can optionally share their peer lists:

```typescript
interface PeerExchangePayload {
  peers: Array<{
    did: string;
    displayName?: string;
    endpointUrl?: string;
    didWeb?: string;           // Human-readable DID if available
    rotationLogHash?: string;  // Hash of their rotation log for verification
  }>;
}
```

Peer exchange only shares **public metadata** — no trust levels, no private info. The receiving agent decides independently whether to connect.

### 7.3 Handshake (Existing — Enhancement Needed)

The current 3-step handshake is well-designed:

```
Initiator → Responder: HANDSHAKE(did, pubkey, challenge)
Responder → Initiator: HANDSHAKE_ACK(did, pubkey, challengeResponse, counterChallenge)
Initiator → Responder: PING(counterChallengeResponse)
```

**Enhancement: Include rotation log in handshake**

```typescript
interface HandshakePayload {
  did: string;
  publicKey: string;
  challenge: string;
  displayName?: string;
  chainAddress?: string;
  // NEW:
  genesisDid?: string;          // Stable identity anchor
  rotationLogHash?: string;     // Hash of full rotation log
  previousDids?: string[];      // List of prior DIDs (for peers who knew us by old DID)
}
```

This allows a peer who knew us as `did:key:z6MkOLD...` to recognize us as `did:key:z6MkNEW...` by checking the rotation chain.

### 7.4 Memory Exchange

**Current:** Complete — sync request/response with publish rules. Works well.

**Proposed additions:**

1. **Selective field encryption:** For sensitive memories shared with specific peers, encrypt the content field with the peer's public key (X25519 key agreement derived from Ed25519)
2. **Provenance chains:** When a memory is forwarded through multiple peers (A→B→C), maintain a chain of signatures proving the path
3. **Conflict resolution:** When the same memory arrives from multiple peers, prefer the version with the strongest provenance chain

### 7.5 Trust Model

**Current:** Three levels — pending, trusted, blocked. Operator-managed.

**Proposed enhancement: Trust scoring**

```typescript
interface TrustScore {
  /** Base level set by operator */
  operatorTrust: 'pending' | 'trusted' | 'blocked';
  /** Time-based trust: increases with connection duration */
  ageFactor: number;         // 0.0 - 1.0
  /** Reliability: ratio of valid messages to total */
  reliabilityFactor: number; // 0.0 - 1.0
  /** Vouching: trusted peers who also trust this peer */
  vouchCount: number;
  /** On-chain: has verified on-chain identity */
  chainVerified: boolean;
  /** Rotation: has a valid rotation log (key management hygiene) */
  rotationLogValid: boolean;
  /** Computed score */
  score: number;             // 0.0 - 1.0
}
```

This doesn't replace operator trust — it supplements it with observable signals.

### 7.6 Federation Message Protocol Summary

| Message | Direction | Purpose |
|---------|-----------|---------|
| `HANDSHAKE` | → | Initiate connection with DID proof |
| `HANDSHAKE_ACK` | ← | Respond with counter-challenge |
| `SYNC_REQUEST` | → | Request memories since timestamp |
| `SYNC_RESPONSE` | ← | Return matching memories |
| `MEMORY_PUSH` | → | Push single memory (auto-publish) |
| `MEMORY_ACK` | ← | Accept/reject pushed memory |
| `PING` / `PONG` | ↔ | Keepalive |
| `ERROR` | ↔ | Protocol errors |
| **`KEY_ROTATION`** | → | **Notify peers of key rotation** |
| **`KEY_ROTATION_ACK`** | ← | **Acknowledge rotation** |
| **`PEER_EXCHANGE`** | ↔ | **Share peer list (gossip)** |
| **`DID_RESOLVE`** | → | **Request DID document** |
| **`DID_RESOLVE_RESPONSE`** | ← | **Return DID document + rotation log** |

---

## 8. What's Built vs What's Missing

### ✅ Built and Working

| Component | Status | Notes |
|-----------|--------|-------|
| Ed25519 keypair generation & storage | Production | v3 KDF with Argon2id |
| KDF migration (v1→v2→v3) | Production | `reEncryptKeypair()` |
| did:key encoding/decoding | Production | Full W3C compliance |
| DID Document generation | Production | Ed25519VerificationKey2020 |
| WebSocket federation server | Production | Rate limiting, heartbeat |
| WebSocket federation client | Production | Auto-reconnect with backoff |
| Challenge-response handshake | Production | Mutual DID verification |
| Peer trust management | Production | pending/trusted/blocked |
| Memory sync (bidirectional) | Production | With signature verification |
| Selective publish rules | Production | Tags, types, importance, peer targeting |
| Signed message protocol | Production | 5-min replay window |
| Memory signature verification | Production | C-3 audit fix: actual verification |
| Signable payload v2 | Production | Prevents cross-memory signature reuse |

### ❌ Missing — Key Rotation

| Component | Priority | Effort |
|-----------|----------|--------|
| Rotation log data structure | High | 1 day |
| Rotation ceremony implementation | High | 2 days |
| `KEY_ROTATION` federation message | High | 1 day |
| Peer DID update on rotation notification | High | 1 day |
| Rotation log verification | High | 1 day |
| Pre-commitment (KERI-lite) | Medium | 0.5 day |
| CLI commands: `signet rotate`, `signet rotation-log` | Medium | 1 day |
| Old signature re-verification after rotation | Medium | 1 day |

### ❌ Missing — Discovery & Resolution

| Component | Priority | Effort |
|-----------|----------|--------|
| did:web document generation | Medium | 0.5 day |
| did:web resolution (fetch + parse) | Medium | 1 day |
| Service endpoint extraction from DID docs | Medium | 0.5 day |
| `signet federation add did:web:...` | Medium | 0.5 day |
| Peer exchange (gossip) protocol | Low | 2 days |
| DID resolver abstraction (pluggable methods) | Low | 1 day |

### ❌ Missing — Federation Enhancements

| Component | Priority | Effort |
|-----------|----------|--------|
| Rotation-aware handshake (genesisDid, previousDids) | High | 1 day |
| Memory provenance chains | Low | 2 days |
| Trust scoring | Low | 1 day |
| Selective field encryption (X25519) | Low | 2 days |
| Federation dashboard / monitoring | Low | 3 days |

**Total estimated effort for high-priority items: ~7-8 days**

---

## 9. Security Considerations

### 9.1 Key Rotation Risks

| Risk | Mitigation |
|------|-----------|
| **Attacker steals old key and rotates first** | Pre-commitment: include hash of next key at each rotation. Attacker can't forge a rotation that matches the pre-committed hash. |
| **Forked rotation log** | Peers reject any DID with two different rotation chains from the same genesis. First-seen wins; alert the operator for manual resolution. |
| **Replay of old rotation message** | Timestamp validation (already implemented as 5-min window). Sequence numbers must be strictly monotonic. |
| **Both old and new keys compromised** | No mitigation at the protocol level. Operational security (HSM, separate machines for key generation) is required. |
| **Peer doesn't receive rotation notification** | On reconnect, peers exchange rotation log hashes. If they differ, full log is synced and verified. |

### 9.2 Federation Risks

| Risk | Mitigation |
|------|-----------|
| **Man-in-the-middle on WebSocket** | TLS (wss://) for transport security. DID handshake provides end-to-end authentication regardless of transport. |
| **Malicious peer floods with fake memories** | Rate limiting (existing: 120 msg/min). Trust levels gate sync access. Importance-based filtering. |
| **Peer exchange enables network mapping** | Peer exchange is optional and only shares public metadata. Peers can opt out. |
| **did:web DNS hijacking** | did:web is a convenience layer only. All security decisions use the underlying did:key verification. DNSSEC recommended. |
| **Sybil attack via multiple DIDs** | On-chain identity verification (chainAddress) provides sybil resistance. Trust scoring based on age and reliability. |

### 9.3 did:key vs did:web Security Comparison

| Property | did:key | did:web |
|----------|---------|--------|
| Trust root | Cryptography only | DNS + TLS CA |
| Offline verification | ✅ | ❌ |
| Resistance to state-level attacker | ✅ | ❌ (CA compromise, DNS seizure) |
| Human readable | ❌ | ✅ |
| Update without changing ID | ❌ | ✅ (update did.json) |
| Appropriate for | Primary identity | Discovery + convenience |

---

## 10. Recommendation

### Phase 1: Key Rotation (Priority: High)

1. **Implement the signed rotation log** as described in Section 5
2. Add `KEY_ROTATION` and `KEY_ROTATION_ACK` message types to federation protocol
3. Update `peer-manager.ts` to handle DID changes (lookup by genesisDid)
4. Add CLI command: `signet did rotate` — interactive rotation ceremony
5. Store rotation log at `~/.agents/rotations.json`

**Do NOT implement:** Full KERI (too complex), did:plc (requires central server), or custom DID method (standardization burden).

**DO implement:** Optional pre-commitment (hash of next key) — it's ~20 lines of code and provides meaningful protection against key theft.

### Phase 2: Discovery (Priority: Medium)

1. Add `did:web` document generation (extend `did-setup.ts`)
2. Add `did:web` resolution to federation client
3. Add `signet federation add did:web:...` command
4. Include service endpoints in DID documents

### Phase 3: Advanced Federation (Priority: Low)

1. Peer exchange protocol (gossip)
2. Trust scoring
3. Memory provenance chains
4. Federation monitoring/dashboard

### What NOT to Build

- **Don't build a custom DID method** (`did:signet`). The maintenance burden of a custom method spec is enormous and brings no value over `did:key` + rotation log.
- **Don't depend on external infrastructure** for core identity operations. The whole point of `did:key` is self-sovereignty.
- **Don't implement KERI wholesale.** Cherry-pick pre-rotation; leave the rest.
- **Don't make did:web mandatory.** It's a convenience layer for discovery; agents without a domain should work perfectly.

### Architecture Decision Record

```
DECISION: Signet Identity Lifecycle Architecture
─────────────────────────────────────────────────
Primary DID method:     did:key (Ed25519)
Key rotation:           Signed rotation log (dual-signed, hash-chained)
Pre-commitment:         Optional KERI-lite (hash of next pubkey)
Identity anchor:        Genesis DID (first-ever did:key)
Human-readable layer:   Optional did:web
Discovery:              did:web resolution + manual + peer exchange
Federation transport:   WebSocket (existing)
Trust model:            Operator-managed + trust scoring signals
On-chain anchor:        Optional (existing chainAddress support)
```

---

## Appendix A: Related Standards and Protocols

| Standard | Relevance to Signet |
|----------|-------------------|
| [W3C DID Core 1.0](https://www.w3.org/TR/did-core/) | Foundation — Signet's DID documents already comply |
| [did:key v0.9](https://w3c-ccg.github.io/did-key-spec/) | Primary DID method — already implemented |
| [did:web](https://w3c-ccg.github.io/did-method-web/) | Proposed for discovery layer |
| [KERI (IETF Draft)](https://weboftrust.github.io/ietf-keri/draft-ssmith-keri.html) | Pre-rotation concept cherry-picked |
| [did:plc v0.1](https://web.plc.directory/spec/v0.1/did-plc) | Signed operation log concept borrowed |
| [DIDComm v2](https://identity.foundation/didcomm-messaging/spec/) | Potential future upgrade for encrypted messaging |
| [ANP (Agent Network Protocol)](https://www.agent-network-protocol.com/) | DID-based agent discovery — aligned architecture |
| [Nostr NIP-05](https://github.com/nostr-protocol/nips/blob/master/05.md) | Similar pattern to did:web (DNS-based identity verification) |

## Appendix B: Comparison to AT Protocol's Approach

Bluesky's AT Protocol uses `did:plc` with a central PLC directory. Key differences from the proposed Signet approach:

| Aspect | AT Protocol (did:plc) | Signet (proposed) |
|--------|----------------------|-------------------|
| Directory | Central (plc.directory) | None (peer-to-peer) |
| Recovery | 72h window, priority-ordered rotation keys | Pre-commitment hash |
| Signing algorithm | ECDSA (secp256k1/P-256) | Ed25519 |
| Serialization | DAG-CBOR | JSON |
| DID stability | ✅ DID never changes | ⚠️ DID changes, genesis anchors identity |
| Scale target | Millions | Hundreds to thousands |
| Operation complexity | High (CID hashing, CBOR, low-S normalization) | Low (JSON + Ed25519) |

The most valuable insight from did:plc is the **separation of rotation keys and signing keys**. Signet could adopt this: the Ed25519 key used for memory signing could be different from a higher-authority key used for rotation. This allows the signing key to be "hot" (cached for performance) while the rotation key stays cold (offline, hardware token).

## Appendix C: Implementation Sketch — Rotation Entry

```typescript
// rotation.ts — minimal implementation sketch

import { signContent, verifySignature, getPublicKeyBytes } from './crypto';
import { publicKeyToDid, didToPublicKey } from './did';
import { createHash } from 'crypto';

function hashEntry(entry: Omit<RotationEntry, 'fromSignature' | 'toSignature'>): string {
  return createHash('sha256')
    .update(JSON.stringify(entry))
    .digest('hex');
}

async function createRotationEntry(
  oldDid: string,
  newPublicKey: Uint8Array,
  signWithOldKey: (content: string) => Promise<string>,
  signWithNewKey: (content: string) => Promise<string>,
  prevEntry: RotationEntry | null,
  nextKeyHash?: string,
): Promise<RotationEntry> {
  const newDid = publicKeyToDid(newPublicKey);
  const seq = prevEntry ? prevEntry.seq + 1 : 0;
  const prev = prevEntry
    ? hashEntry(prevEntry)
    : null;

  const payload = JSON.stringify({
    seq, prev, fromDid: oldDid, toDid: newDid,
    timestamp: new Date().toISOString(),
    nextKeyHash,
  });

  const fromSignature = await signWithOldKey(payload);
  const toSignature = await signWithNewKey(payload);

  return {
    seq, prev, fromDid: oldDid, toDid: newDid,
    timestamp: new Date().toISOString(),
    nextKeyHash,
    fromSignature, toSignature,
  };
}

function verifyRotationChain(log: RotationLog): boolean {
  for (let i = 0; i < log.entries.length; i++) {
    const entry = log.entries[i];
    
    // Verify hash chain
    if (i === 0) {
      if (entry.prev !== null || entry.seq !== 0) return false;
    } else {
      const expectedPrev = hashEntry(log.entries[i - 1]);
      if (entry.prev !== expectedPrev) return false;
      if (entry.seq !== i) return false;
    }

    // Verify continuity
    if (i > 0 && entry.fromDid !== log.entries[i - 1].toDid) return false;

    // Verify dual signatures
    const payload = JSON.stringify({
      seq: entry.seq, prev: entry.prev,
      fromDid: entry.fromDid, toDid: entry.toDid,
      timestamp: entry.timestamp, nextKeyHash: entry.nextKeyHash,
    });

    const fromPubKey = didToPublicKey(entry.fromDid);
    const toPubKey = didToPublicKey(entry.toDid);

    // Note: verifySignature is async in Signet — this is pseudocode
    // if (!verifySignature(payload, entry.fromSignature, fromPubKey)) return false;
    // if (!verifySignature(payload, entry.toSignature, toPubKey)) return false;

    // Verify pre-commitment from previous entry
    if (i > 0 && log.entries[i - 1].nextKeyHash) {
      const expectedHash = createHash('sha256')
        .update(toPubKey)
        .digest('hex');
      if (log.entries[i - 1].nextKeyHash !== expectedHash) return false;
    }
  }

  return true;
}
```
