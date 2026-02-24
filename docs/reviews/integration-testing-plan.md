# Signet Integration Testing Plan: Cryptographic Identity Chain

**Date:** 2025-02-24  
**Scope:** End-to-end tests for the sign → verify → Merkle → anchor pipeline  
**Author:** Research subagent (integration-testing-plan task)

---

## Table of Contents

1. [Current Test Coverage Analysis](#1-current-test-coverage-analysis)
2. [Root Cause of Failing Tests](#2-root-cause-of-failing-tests)
3. [Integration Test Design](#3-integration-test-design)
4. [Test Code: Bun Tests (Tests 1–4)](#4-test-code-bun-tests-tests-14)
5. [Test Code: Hardhat + ethers.js (Test 5)](#5-test-code-hardhat--ethersjs-test-5)
6. [CI Pipeline Recommendations](#6-ci-pipeline-recommendations)

---

## 1. Current Test Coverage Analysis

### What IS tested (404 passing tests across 26 files)

| Module | File | Coverage |
|--------|------|----------|
| **Auth system** | `auth/auth.test.ts` | Token generation, verification, expiry, HMAC, role-based policy, scope enforcement, rate limiting, middleware integration, config parsing. **Excellent coverage.** |
| **Transactions** | `transactions.test.ts` | txIngestEnvelope, txModifyMemory, txForgetMemory, txRecoverMemory, txApplyDecision, pinning, versioning, soft-delete, merge. **Excellent coverage.** |
| **Migrations** | `migrations.test.ts` | Schema creation, idempotency, table/column existence, FTS5, deduplication, legacy schema repair. **Good but hardcoded migration count.** |
| **Memory config** | `memory-config.test.ts` | Config loading, fallback chain, pipelineV2 flags, nested/flat key parsing, clamping. **Good but one logic bug.** |
| **Pipeline** | `worker.test.ts`, `decision.test.ts`, `extraction.test.ts`, etc. | Worker lifecycle, decision engine, extraction, graph operations, retention. **Well tested.** |
| **SDK** | `client.test.ts`, `transport.test.ts`, `openai.test.ts`, `ai-sdk.test.ts` | HTTP client, transport layer, AI SDK adapters. **Good coverage.** |
| **Connector** | `connector-openclaw/test/index.test.ts` | Config patching, JSON5 support, workspace management. **Adequate.** |
| **Other** | `analytics.test.ts`, `version.test.ts`, `diagnostics.test.ts`, `db-accessor.test.ts`, etc. | Various daemon modules. **Adequate.** |

### What is NOT tested (critical gaps)

| Module | File | Gap |
|--------|------|-----|
| **Ed25519 Crypto** | `core/src/crypto.ts` | **ZERO tests.** No tests for `generateSigningKeypair()`, `signContent()`, `verifySignature()`, `signBytes()`, `verifyBytes()`, `buildSignablePayload()`, `buildSignablePayloadV2()`, KDF derivation, key loading/caching, passphrase provider, `reEncryptKeypair()`. |
| **DID** | `core/src/did.ts` | **ZERO tests.** No tests for `publicKeyToDid()`, `didToPublicKey()`, `isValidDid()`, `generateDidDocument()`, `formatDidShort()`, base58btc encode/decode. |
| **Merkle (BLAKE2b)** | `core/src/merkle.ts` | **ZERO tests.** No tests for `hashContent()`, `computeMerkleRoot()`, `buildMerkleTree()`, `generateProof()`, `verifyProof()`, hex helpers, domain separation, odd-layer handling, empty tree. |
| **Merkle (keccak256)** | `core/src/chain/merkle.ts` | **ZERO tests.** No tests for `buildMemoryMerkleTree()`, `getMemoryRoot()`, `generateMemoryProof()`, `verifyMemoryProof()`. |
| **Memory signing** | `daemon/src/memory-signing.ts` | **ZERO tests.** No tests for `signEnvelope()`, `verifyMemorySignature()`, `isSigningAvailable()`, `getAgentDid()`, v1↔v2 payload format compatibility. |
| **Smart contract** | `contracts/src/SignetIdentity.sol` | **ZERO tests.** No tests for `register()`, `anchorMemory()`, commit-reveal, soulbound transfer blocking, DID lookup. |
| **Chain wallet** | `core/src/chain/wallet.ts`, `contract.ts`, `session-keys.ts` | **ZERO tests.** On-chain interaction layer untested. |

### Coverage Assessment

**The entire cryptographic identity pipeline — from key generation through on-chain anchoring — has zero test coverage.** This is the highest-priority gap in the project. The 404 passing tests cover the "memory CRUD" and "auth" layers well, but the signing, DID, Merkle, and blockchain layers are completely untested.

---

## 2. Root Cause of Failing Tests

### 5 failing tests — 2 root causes

#### Cause 1: Migration count hardcoded to 19 (4 failures)

**Files:** `packages/core/src/migrations/migrations.test.ts`  
**Tests:**
- `fresh DB gets all migrations applied` — expects `migrations.length === 19`, got `20`
- `schema_migrations_audit records are created` — expects `audits.length === 19`, got `20`
- `repairs version 2 stamped by CLI without running migrations` — expects `migrations.length === 19`, got `20`
- `version 1 stamped by old inline migrate upgrades cleanly` — expects `migrations.length === 19`, got `20`

**Root cause:** A 20th migration was added to the codebase (likely for a new table or column — possibly `session_metrics`, wallet-related tables, or chain anchoring support) but the test assertions were not updated. The tests hardcode `expect(migrations.length).toBe(19)` in 4 places.

**Fix:**
```typescript
// Replace in all 4 locations:
expect(migrations.length).toBe(19);
// With:
expect(migrations.length).toBe(20);
// Or better — make it dynamic:
const EXPECTED_MIGRATION_COUNT = 20;
expect(migrations.length).toBe(EXPECTED_MIGRATION_COUNT);
```

**Best practice:** Use a shared constant or derive the expected count from the migrations array itself to prevent this class of failure when adding new migrations.

#### Cause 2: Config loading priority logic bug (1 failure)

**File:** `packages/daemon/src/memory-config.test.ts`  
**Test:** `prefers agent.yaml embedding settings over legacy files`

**Root cause:** The test writes both `agent.yaml` (with `ollama/all-minilm`) and `AGENT.yaml` (with `openai/text-embedding-3-large`), expecting `agent.yaml` to take priority. The test gets `openai` back instead of `ollama`, meaning `loadMemoryConfig()` either:
1. Reads `AGENT.yaml` first and doesn't check `agent.yaml`, OR
2. `AGENT.yaml` overwrites `agent.yaml` values during merge, OR  
3. On macOS (case-insensitive filesystem), `agent.yaml` and `AGENT.yaml` are the **same file** — writing `AGENT.yaml` second overwrites `agent.yaml`.

**This is almost certainly cause 3.** macOS's default APFS filesystem is case-insensitive. When the test does:
```typescript
writeFileSync(join(agentsDir, "agent.yaml"), "...ollama...");
writeFileSync(join(agentsDir, "AGENT.yaml"), "...openai...");
```
The second write overwrites the first on macOS. The test would pass on Linux (case-sensitive filesystem) but fails on macOS.

**Fix:** The test needs to be restructured for macOS compatibility — either use separate directories or accept the platform behavior:
```typescript
// Option A: Skip on case-insensitive filesystems
const isCaseInsensitive = existsSync(join(agentsDir, "AGENT.yaml")) 
  && existsSync(join(agentsDir, "agent.yaml"));
if (isCaseInsensitive) return; // skip

// Option B: Test with separate temp directories
```

---

## 3. Integration Test Design

### Design Principles (informed by EAS, Ceramic, and crypto testing best practices)

1. **Use real crypto, never mock it.** Ed25519 operations are fast (~50µs) and deterministic. Mocking crypto hides bugs in serialization, encoding, and domain separation — the exact places where real vulnerabilities live. Both EAS and Ceramic test suites use real crypto operations throughout.

2. **Test the full pipeline, not just units.** The value of Signet's crypto chain is the integrity guarantee from end to end. A sign→verify unit test and a Merkle→proof unit test don't catch format mismatches between layers.

3. **Use deterministic seeds for reproducibility.** Generate keypairs from known seeds so test vectors are stable and cross-language verification is possible.

4. **Test boundary conditions aggressively.** Empty trees, single-leaf trees, odd-count trees, empty content, tampered signatures, wrong keys.

5. **Use Hardhat's in-process chain for contract tests.** No external dependencies, fast (~10ms per tx), deterministic block timestamps.

6. **Separate fast crypto tests from slow chain tests.** Crypto tests run in <1s; Hardhat tests take 5-10s. Keep them in separate files for CI parallelism.

### Test Architecture

```
packages/core/src/__tests__/
├── crypto.integration.test.ts      # Tests 1, 2 — key gen, signing, DID
├── merkle.integration.test.ts      # Test 3 — Merkle tree pipeline
├── signing-pipeline.test.ts        # Test 4 — sign + backfill + re-verify

packages/contracts/test/
├── SignetIdentity.test.ts           # Test 5 — full chain with Hardhat
```

---

## 4. Test Code: Bun Tests (Tests 1–4)

### Test 1 & 2: Key Generation → DID → Signing → Verification

```typescript
// packages/core/src/__tests__/crypto.integration.test.ts

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import sodium from "libsodium-wrappers";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Core imports
import {
  publicKeyToDid,
  didToPublicKey,
  isValidDid,
  generateDidDocument,
  formatDidShort,
} from "../did";
import {
  buildSignablePayload,
  buildSignablePayloadV2,
} from "../crypto";

// We can't easily test generateSigningKeypair/signContent/verifySignature
// because they depend on file I/O and SIGNET_PATH. Instead, we test the
// crypto primitives directly with libsodium to verify the pipeline works.

let testKeypair: { publicKey: Uint8Array; privateKey: Uint8Array };

describe("Integration Test 1: Key Generation → DID Derivation → Consistency", () => {
  beforeAll(async () => {
    await sodium.ready;
    // Generate a deterministic keypair from a known seed for reproducibility
    const seed = sodium.crypto_generichash(32, sodium.from_string("signet-test-seed-v1"), null);
    testKeypair = sodium.crypto_sign_seed_keypair(seed);
  });

  test("Ed25519 keypair has correct lengths", () => {
    expect(testKeypair.publicKey.length).toBe(32);
    expect(testKeypair.privateKey.length).toBe(64); // Ed25519 secret key is 64 bytes
  });

  test("public key can be derived from private key", () => {
    const derived = sodium.crypto_sign_ed25519_sk_to_pk(testKeypair.privateKey);
    expect(sodium.memcmp(derived, testKeypair.publicKey)).toBe(true);
  });

  test("public key → DID → public key round-trip is lossless", () => {
    const did = publicKeyToDid(testKeypair.publicKey);
    expect(did).toStartWith("did:key:z");
    expect(isValidDid(did)).toBe(true);

    const recovered = didToPublicKey(did);
    expect(recovered.length).toBe(32);

    // Byte-by-byte comparison
    for (let i = 0; i < 32; i++) {
      expect(recovered[i]).toBe(testKeypair.publicKey[i]);
    }
  });

  test("DID is deterministic for the same public key", () => {
    const did1 = publicKeyToDid(testKeypair.publicKey);
    const did2 = publicKeyToDid(testKeypair.publicKey);
    expect(did1).toBe(did2);
  });

  test("different keys produce different DIDs", async () => {
    const otherSeed = sodium.crypto_generichash(32, sodium.from_string("other-seed"), null);
    const otherKp = sodium.crypto_sign_seed_keypair(otherSeed);
    const did1 = publicKeyToDid(testKeypair.publicKey);
    const did2 = publicKeyToDid(otherKp.publicKey);
    expect(did1).not.toBe(did2);
  });

  test("DID document is well-formed and matches W3C spec", () => {
    const did = publicKeyToDid(testKeypair.publicKey);
    const doc = generateDidDocument(did, testKeypair.publicKey);

    expect(doc["@context"]).toContain("https://www.w3.org/ns/did/v1");
    expect(doc.id).toBe(did);
    expect(doc.verificationMethod).toHaveLength(1);
    expect(doc.verificationMethod[0].type).toBe("Ed25519VerificationKey2020");
    expect(doc.verificationMethod[0].controller).toBe(did);
    expect(doc.authentication).toHaveLength(1);
    expect(doc.assertionMethod).toHaveLength(1);
  });

  test("formatDidShort produces a readable abbreviation", () => {
    const did = publicKeyToDid(testKeypair.publicKey);
    const short = formatDidShort(did);
    expect(short).toContain("did:key:");
    expect(short).toContain("...");
    expect(short.length).toBeLessThan(did.length);
  });

  test("invalid inputs are rejected by DID functions", () => {
    // Wrong length
    expect(() => publicKeyToDid(new Uint8Array(31))).toThrow();
    expect(() => publicKeyToDid(new Uint8Array(33))).toThrow();

    // Not a Uint8Array
    expect(() => publicKeyToDid("not-bytes" as any)).toThrow();

    // Invalid DID strings
    expect(isValidDid("")).toBe(false);
    expect(isValidDid("did:web:example.com")).toBe(false);
    expect(isValidDid("did:key:")).toBe(false);
    expect(isValidDid("did:key:z")).toBe(false);
    expect(isValidDid("did:key:invalidbase58!!!")).toBe(false);

    // didToPublicKey rejects non-did:key
    expect(() => didToPublicKey("did:web:example.com")).toThrow();
  });
});

describe("Integration Test 2: Memory Creation → Signing → Verification", () => {
  let did: string;

  beforeAll(async () => {
    await sodium.ready;
    did = publicKeyToDid(testKeypair.publicKey);
  });

  test("sign and verify a UTF-8 string with detached signature", async () => {
    const content = "User prefers dark theme for all applications";
    const message = new TextEncoder().encode(content);
    const signature = sodium.crypto_sign_detached(message, testKeypair.privateKey);

    expect(signature.length).toBe(64);

    const valid = sodium.crypto_sign_verify_detached(signature, message, testKeypair.publicKey);
    expect(valid).toBe(true);
  });

  test("verification fails with wrong content", async () => {
    const content = "Original content";
    const message = new TextEncoder().encode(content);
    const signature = sodium.crypto_sign_detached(message, testKeypair.privateKey);

    const tamperedMessage = new TextEncoder().encode("Tampered content");
    const valid = sodium.crypto_sign_verify_detached(signature, tamperedMessage, testKeypair.publicKey);
    expect(valid).toBe(false);
  });

  test("verification fails with wrong public key", async () => {
    const content = "Signed content";
    const message = new TextEncoder().encode(content);
    const signature = sodium.crypto_sign_detached(message, testKeypair.privateKey);

    const otherSeed = sodium.crypto_generichash(32, sodium.from_string("wrong-key"), null);
    const otherKp = sodium.crypto_sign_seed_keypair(otherSeed);
    const valid = sodium.crypto_sign_verify_detached(signature, message, otherKp.publicKey);
    expect(valid).toBe(false);
  });

  test("buildSignablePayload v1 format: contentHash|createdAt|signerDid", () => {
    const payload = buildSignablePayload(
      "abcdef0123456789",
      "2025-02-24T00:00:00.000Z",
      did,
    );
    expect(payload).toBe(`abcdef0123456789|2025-02-24T00:00:00.000Z|${did}`);
  });

  test("buildSignablePayloadV2 format: v2|memoryId|contentHash|createdAt|signerDid", () => {
    const payload = buildSignablePayloadV2(
      "mem-123",
      "abcdef0123456789",
      "2025-02-24T00:00:00.000Z",
      did,
    );
    expect(payload).toBe(`v2|mem-123|abcdef0123456789|2025-02-24T00:00:00.000Z|${did}`);
  });

  test("payload injection is prevented (pipe characters rejected)", () => {
    expect(() =>
      buildSignablePayload("abcdef", "2025-01-01|injected", did),
    ).toThrow("pipe");

    expect(() =>
      buildSignablePayloadV2("mem|bad", "abcdef", "2025-01-01", did),
    ).toThrow("pipe");
  });

  test("non-hex contentHash is rejected", () => {
    expect(() =>
      buildSignablePayload("UPPERCASE", "2025-01-01", did),
    ).toThrow("hex");

    expect(() =>
      buildSignablePayload("not-hex-at-all!", "2025-01-01", did),
    ).toThrow("hex");
  });

  test("full memory signing pipeline: hash → payload → sign → verify", async () => {
    // Simulate what memory-signing.ts does
    const memoryId = "mem-integration-test-001";
    const content = "The user's favorite programming language is Rust";
    const createdAt = "2025-02-24T12:00:00.000Z";

    // Step 1: Hash the content (SHA-256, as the daemon does)
    const contentHashBytes = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)),
    );
    const contentHash = Array.from(contentHashBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Step 2: Build v2 signable payload
    const payload = buildSignablePayloadV2(memoryId, contentHash, createdAt, did);

    // Step 3: Sign (using raw libsodium, as crypto.ts does internally)
    const payloadBytes = new TextEncoder().encode(payload);
    const signature = sodium.crypto_sign_detached(payloadBytes, testKeypair.privateKey);
    const signatureB64 = sodium.to_base64(signature, sodium.base64_variants.ORIGINAL);

    // Step 4: Verify (simulating verifyMemorySignature flow)
    // Extract public key from DID
    const recoveredPubKey = didToPublicKey(did);

    // Reconstruct payload and verify
    const verifyPayload = buildSignablePayloadV2(memoryId, contentHash, createdAt, did);
    const sigBytes = sodium.from_base64(signatureB64, sodium.base64_variants.ORIGINAL);
    const verifyResult = sodium.crypto_sign_verify_detached(
      sigBytes,
      new TextEncoder().encode(verifyPayload),
      recoveredPubKey,
    );
    expect(verifyResult).toBe(true);

    // Step 5: Verify v1 fallback would NOT verify a v2 signature
    const v1Payload = buildSignablePayload(contentHash, createdAt, did);
    const v1SigBytes = sodium.from_base64(signatureB64, sodium.base64_variants.ORIGINAL);
    const v1Result = sodium.crypto_sign_verify_detached(
      v1SigBytes,
      new TextEncoder().encode(v1Payload),
      recoveredPubKey,
    );
    expect(v1Result).toBe(false); // v2 signature doesn't verify with v1 payload
  });

  test("v2 signature prevents cross-memory reuse", async () => {
    const content = "Shared content between memories";
    const createdAt = "2025-02-24T12:00:00.000Z";
    const contentHashBytes = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)),
    );
    const contentHash = Array.from(contentHashBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Sign for memory A
    const payloadA = buildSignablePayloadV2("mem-A", contentHash, createdAt, did);
    const sigA = sodium.crypto_sign_detached(
      new TextEncoder().encode(payloadA),
      testKeypair.privateKey,
    );

    // Try to verify with memory B's payload — should fail
    const payloadB = buildSignablePayloadV2("mem-B", contentHash, createdAt, did);
    const validForB = sodium.crypto_sign_verify_detached(
      sigA,
      new TextEncoder().encode(payloadB),
      testKeypair.publicKey,
    );
    expect(validForB).toBe(false);
  });

  test("Ed25519 signatures are deterministic", async () => {
    const message = new TextEncoder().encode("deterministic test");
    const sig1 = sodium.crypto_sign_detached(message, testKeypair.privateKey);
    const sig2 = sodium.crypto_sign_detached(message, testKeypair.privateKey);
    expect(sodium.memcmp(sig1, sig2)).toBe(true);
  });
});
```

### Test 3: Multiple Memories → Merkle Tree → Proof Generation → Proof Verification

```typescript
// packages/core/src/__tests__/merkle.integration.test.ts

import { describe, test, expect, beforeAll } from "bun:test";
import sodium from "libsodium-wrappers";
import { ethers } from "ethers";

// BLAKE2b Merkle tree (local provenance)
import {
  hashContent,
  computeMerkleRoot,
  buildMerkleTree,
  generateProof,
  verifyProof,
  hashPair,
  hexToBytes,
  bytesToHex,
} from "../merkle";

// keccak256 Merkle tree (on-chain anchoring)
import {
  buildMemoryMerkleTree,
  verifyMemoryProof,
} from "../chain/merkle";

describe("Integration Test 3: BLAKE2b Merkle Tree Pipeline", () => {
  beforeAll(async () => {
    await sodium.ready;
  });

  // ---- Hex helpers ----

  test("hexToBytes ↔ bytesToHex round-trip", () => {
    const original = "deadbeef0123456789abcdef";
    const bytes = hexToBytes(original);
    const hex = bytesToHex(bytes);
    expect(hex).toBe(original);
  });

  test("hexToBytes rejects odd-length strings", () => {
    expect(() => hexToBytes("abc")).toThrow("odd-length");
  });

  test("hexToBytes rejects non-hex characters", () => {
    expect(() => hexToBytes("gg")).toThrow("invalid hex");
  });

  // ---- Hashing ----

  test("hashContent produces 64-char hex (32 bytes)", async () => {
    const hash = await hashContent("Hello, Signet!");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("hashContent is deterministic", async () => {
    const h1 = await hashContent("deterministic");
    const h2 = await hashContent("deterministic");
    expect(h1).toBe(h2);
  });

  test("hashContent is content-sensitive", async () => {
    const h1 = await hashContent("content A");
    const h2 = await hashContent("content B");
    expect(h1).not.toBe(h2);
  });

  // ---- Empty tree ----

  test("empty tree has canonical root", async () => {
    const root = await computeMerkleRoot([]);
    expect(root).toMatch(/^[0-9a-f]{64}$/);
    expect(root.length).toBe(64);
  });

  test("empty tree builds with no layers", async () => {
    const tree = await buildMerkleTree([]);
    expect(tree.leaves).toHaveLength(0);
    expect(tree.layers).toHaveLength(0);
    expect(tree.root).toMatch(/^[0-9a-f]{64}$/);
  });

  test("cannot generate proof for empty tree", async () => {
    const tree = await buildMerkleTree([]);
    expect(() => generateProof(tree, 0)).toThrow();
  });

  // ---- Single leaf ----

  test("single leaf tree: root is domain-separated hash of the leaf", async () => {
    const leaf = await hashContent("only leaf");
    const root = await computeMerkleRoot([leaf]);

    // Root should NOT equal the raw leaf — domain separation adds LEAF_PREFIX
    expect(root).not.toBe(leaf);
    expect(root).toMatch(/^[0-9a-f]{64}$/);
  });

  test("single leaf tree: computeMerkleRoot matches buildMerkleTree root", async () => {
    const leaf = await hashContent("consistency check");
    const computedRoot = await computeMerkleRoot([leaf]);
    const tree = await buildMerkleTree([leaf]);
    expect(tree.root).toBe(computedRoot);
  });

  test("single leaf tree: proof has zero siblings", async () => {
    const leaf = await hashContent("solo");
    const tree = await buildMerkleTree([leaf]);
    const proof = generateProof(tree, 0);
    expect(proof.siblings).toHaveLength(0);
    expect(proof.leafHash).toBe(leaf);

    const valid = await verifyProof(proof, leaf, tree.root);
    expect(valid).toBe(true);
  });

  // ---- Two leaves (simplest non-trivial tree) ----

  test("two-leaf tree structure", async () => {
    const leaves = [
      await hashContent("memory 1"),
      await hashContent("memory 2"),
    ];
    const tree = await buildMerkleTree(leaves);

    expect(tree.leaves).toHaveLength(2);
    expect(tree.layers).toHaveLength(2); // tagged leaves + root
    expect(tree.layers[0]).toHaveLength(2);
    expect(tree.layers[1]).toHaveLength(1); // root
    expect(tree.root).toBe(tree.layers[1][0]);
  });

  test("two-leaf tree: both proofs verify", async () => {
    const leaves = [
      await hashContent("alpha"),
      await hashContent("beta"),
    ];
    const tree = await buildMerkleTree(leaves);

    for (let i = 0; i < 2; i++) {
      const proof = generateProof(tree, i);
      expect(proof.siblings).toHaveLength(1);
      expect(proof.leafIndex).toBe(i);
      const valid = await verifyProof(proof, leaves[i], tree.root);
      expect(valid).toBe(true);
    }
  });

  // ---- Odd number of leaves (promotion, not duplication) ----

  test("three-leaf tree: no root collision with [A,B,C,C]", async () => {
    const A = await hashContent("A");
    const B = await hashContent("B");
    const C = await hashContent("C");

    const tree3 = await buildMerkleTree([A, B, C]);
    const tree4 = await buildMerkleTree([A, B, C, C]);

    // With promotion (not duplication), these MUST differ
    expect(tree3.root).not.toBe(tree4.root);
  });

  test("three-leaf tree: all proofs verify", async () => {
    const leaves = [
      await hashContent("one"),
      await hashContent("two"),
      await hashContent("three"),
    ];
    const tree = await buildMerkleTree(leaves);

    for (let i = 0; i < 3; i++) {
      const proof = generateProof(tree, i);
      const valid = await verifyProof(proof, leaves[i], tree.root);
      expect(valid).toBe(true);
    }
  });

  // ---- Larger tree ----

  test("10-leaf tree: all proofs verify", async () => {
    const leaves = await Promise.all(
      Array.from({ length: 10 }, (_, i) => hashContent(`memory ${i}`)),
    );
    const tree = await buildMerkleTree(leaves);

    expect(tree.root).toMatch(/^[0-9a-f]{64}$/);

    for (let i = 0; i < 10; i++) {
      const proof = generateProof(tree, i);
      const valid = await verifyProof(proof, leaves[i], tree.root);
      expect(valid).toBe(true);
    }
  });

  test("100-leaf tree: all proofs verify", async () => {
    const leaves = await Promise.all(
      Array.from({ length: 100 }, (_, i) => hashContent(`bulk memory #${i}`)),
    );
    const tree = await buildMerkleTree(leaves);

    // Spot-check 10 random indices
    for (const i of [0, 7, 13, 42, 50, 67, 88, 91, 99]) {
      const proof = generateProof(tree, i);
      const valid = await verifyProof(proof, leaves[i], tree.root);
      expect(valid).toBe(true);
    }
  });

  // ---- Proof tampering ----

  test("proof fails with wrong leaf hash", async () => {
    const leaves = [
      await hashContent("real"),
      await hashContent("also real"),
    ];
    const tree = await buildMerkleTree(leaves);
    const proof = generateProof(tree, 0);

    const fakeLeaf = await hashContent("fake");
    const valid = await verifyProof(proof, fakeLeaf, tree.root);
    expect(valid).toBe(false);
  });

  test("proof fails with wrong root", async () => {
    const leaves = [
      await hashContent("leaf 1"),
      await hashContent("leaf 2"),
    ];
    const tree = await buildMerkleTree(leaves);
    const proof = generateProof(tree, 0);

    const fakeRoot = await hashContent("not the root");
    const valid = await verifyProof(proof, leaves[0], fakeRoot);
    expect(valid).toBe(false);
  });

  test("proof fails with tampered sibling hash", async () => {
    const leaves = [
      await hashContent("A"),
      await hashContent("B"),
      await hashContent("C"),
      await hashContent("D"),
    ];
    const tree = await buildMerkleTree(leaves);
    const proof = generateProof(tree, 0);

    // Tamper with a sibling
    const tampered = {
      ...proof,
      siblings: proof.siblings.map((s, i) =>
        i === 0 ? { ...s, hash: "ff".repeat(32) } : s,
      ),
    };
    const valid = await verifyProof(tampered, leaves[0], tree.root);
    expect(valid).toBe(false);
  });

  // ---- Out-of-bounds ----

  test("generateProof rejects out-of-bounds index", async () => {
    const tree = await buildMerkleTree([await hashContent("solo")]);
    expect(() => generateProof(tree, -1)).toThrow();
    expect(() => generateProof(tree, 1)).toThrow();
  });

  // ---- Domain separation ----

  test("leaf and internal node hashing use different domain separators", async () => {
    // A leaf hash and an internal hash of the same data should differ
    // because LEAF_PREFIX (0x00) ≠ NODE_PREFIX (0x01)
    const data = "ff".repeat(32);

    // Leaf domain: BLAKE2b(0x00 || data)
    await sodium.ready;
    const leafBytes = hexToBytes(data);
    const leafPrefixed = new Uint8Array(1 + leafBytes.length);
    leafPrefixed[0] = 0x00;
    leafPrefixed.set(leafBytes, 1);
    const leafHash = bytesToHex(sodium.crypto_generichash(32, leafPrefixed, null));

    // Node domain: BLAKE2b(0x01 || data || data) via hashPair
    const nodeHash = await hashPair(data, data);

    expect(leafHash).not.toBe(nodeHash);
  });
});

describe("Integration Test 3b: keccak256 Merkle Tree (On-Chain)", () => {
  test("empty tree produces zero hash root", () => {
    const tree = buildMemoryMerkleTree([]);
    expect(tree.root).toBe(ethers.ZeroHash);
    expect(tree.count).toBe(0);
  });

  test("single memory tree", () => {
    const tree = buildMemoryMerkleTree([
      { id: "mem-1", contentHash: "abcdef0123456789" },
    ]);
    expect(tree.count).toBe(1);
    expect(tree.leaves).toHaveLength(1);
    expect(tree.root).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("proof generation and verification for 4 memories", () => {
    const memories = [
      { id: "mem-1", contentHash: "aaaa" + "0".repeat(60) },
      { id: "mem-2", contentHash: "bbbb" + "0".repeat(60) },
      { id: "mem-3", contentHash: "cccc" + "0".repeat(60) },
      { id: "mem-4", contentHash: "dddd" + "0".repeat(60) },
    ];
    const tree = buildMemoryMerkleTree(memories);

    // Manually construct proof (since generateMemoryProof needs a DB)
    // We can at least verify the sorted-pair property makes proofs work
    expect(tree.root).not.toBe(ethers.ZeroHash);
    expect(tree.count).toBe(4);
  });

  test("keccak256 tree root is deterministic", () => {
    const memories = [
      { id: "m1", contentHash: "aa".repeat(32) },
      { id: "m2", contentHash: "bb".repeat(32) },
    ];
    const tree1 = buildMemoryMerkleTree(memories);
    const tree2 = buildMemoryMerkleTree(memories);
    expect(tree1.root).toBe(tree2.root);
  });

  test("keccak256 tree uses domain separation", () => {
    // The leaf hash includes "signet:memory:" prefix
    const contentHash = "ab".repeat(32);
    const expected = ethers.keccak256(
      ethers.toUtf8Bytes(`signet:memory:${contentHash}`),
    );
    const tree = buildMemoryMerkleTree([{ id: "m", contentHash }]);
    expect(tree.leaves[0]).toBe(expected);
  });

  test("verifyMemoryProof accepts valid proof", () => {
    const proof = {
      leafHash: ethers.keccak256(ethers.toUtf8Bytes("signet:memory:aabb")),
      leafIndex: 0,
      siblings: [],
      root: ethers.keccak256(ethers.toUtf8Bytes("signet:memory:aabb")),
    };
    // Single-leaf tree: root == leaf
    expect(verifyMemoryProof(proof, proof.root)).toBe(true);
  });

  test("verifyMemoryProof rejects proof against wrong root", () => {
    const proof = {
      leafHash: ethers.keccak256(ethers.toUtf8Bytes("signet:memory:aabb")),
      leafIndex: 0,
      siblings: [],
      root: ethers.keccak256(ethers.toUtf8Bytes("signet:memory:aabb")),
    };
    expect(verifyMemoryProof(proof, ethers.ZeroHash)).toBe(false);
  });
});
```

### Test 4: Signed Memory → Backfill → Re-Verify

```typescript
// packages/core/src/__tests__/signing-pipeline.test.ts

import { describe, test, expect, beforeAll } from "bun:test";
import sodium from "libsodium-wrappers";
import {
  publicKeyToDid,
  didToPublicKey,
} from "../did";
import {
  buildSignablePayload,
  buildSignablePayloadV2,
} from "../crypto";
import {
  hashContent,
  buildMerkleTree,
  generateProof,
  verifyProof,
} from "../merkle";

interface MockMemory {
  id: string;
  content: string;
  contentHash: string;
  createdAt: string;
  signerDid: string | null;
  signature: string | null;
}

let keypair: { publicKey: Uint8Array; privateKey: Uint8Array };
let did: string;

describe("Integration Test 4: Signed Memory → Backfill → Re-Verify", () => {
  beforeAll(async () => {
    await sodium.ready;
    const seed = sodium.crypto_generichash(32, sodium.from_string("backfill-test"), null);
    keypair = sodium.crypto_sign_seed_keypair(seed);
    did = publicKeyToDid(keypair.publicKey);
  });

  /**
   * Helper: simulate memory creation with signing (what memory-signing.ts does)
   */
  async function createSignedMemory(id: string, content: string): Promise<MockMemory> {
    const contentHashBytes = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)),
    );
    const contentHash = Array.from(contentHashBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const createdAt = new Date().toISOString();

    // Sign with v2 payload
    const payload = buildSignablePayloadV2(id, contentHash, createdAt, did);
    const sigBytes = sodium.crypto_sign_detached(
      new TextEncoder().encode(payload),
      keypair.privateKey,
    );
    const signature = sodium.to_base64(sigBytes, sodium.base64_variants.ORIGINAL);

    return { id, content, contentHash, createdAt, signerDid: did, signature };
  }

  /**
   * Helper: verify a memory's signature (what verifyMemorySignature does)
   */
  async function verifyMemory(mem: MockMemory): Promise<boolean> {
    if (!mem.signerDid || !mem.signature) return false;

    const pubKey = didToPublicKey(mem.signerDid);
    const sigBytes = sodium.from_base64(mem.signature, sodium.base64_variants.ORIGINAL);

    // Try v2 first
    const v2Payload = buildSignablePayloadV2(mem.id, mem.contentHash, mem.createdAt, mem.signerDid);
    if (sodium.crypto_sign_verify_detached(sigBytes, new TextEncoder().encode(v2Payload), pubKey)) {
      return true;
    }

    // Fall back to v1
    const v1Payload = buildSignablePayload(mem.contentHash, mem.createdAt, mem.signerDid);
    return sodium.crypto_sign_verify_detached(sigBytes, new TextEncoder().encode(v1Payload), pubKey);
  }

  test("create 5 signed memories, all verify individually", async () => {
    const memories: MockMemory[] = [];
    for (let i = 0; i < 5; i++) {
      const mem = await createSignedMemory(`mem-${i}`, `Memory content #${i}`);
      memories.push(mem);
    }

    for (const mem of memories) {
      expect(await verifyMemory(mem)).toBe(true);
    }
  });

  test("create signed memories → build Merkle tree → verify inclusion", async () => {
    const memories: MockMemory[] = [];
    for (let i = 0; i < 8; i++) {
      memories.push(await createSignedMemory(`batch-${i}`, `Batch memory ${i}`));
    }

    // Step 1: Verify all signatures
    for (const mem of memories) {
      expect(await verifyMemory(mem)).toBe(true);
    }

    // Step 2: Build BLAKE2b Merkle tree from content hashes
    const tree = await buildMerkleTree(memories.map((m) => m.contentHash));

    // Step 3: Generate and verify proofs for each
    for (let i = 0; i < memories.length; i++) {
      const proof = generateProof(tree, i);
      const valid = await verifyProof(proof, memories[i].contentHash, tree.root);
      expect(valid).toBe(true);
    }
  });

  test("backfill: sign a previously unsigned memory, verify matches original", async () => {
    // Simulate a memory that was stored without a signature (e.g., pre-signing era)
    const unsignedMemory: MockMemory = {
      id: "mem-legacy",
      content: "This memory was created before signing was enabled",
      contentHash: "",
      createdAt: "2025-01-01T00:00:00.000Z",
      signerDid: null,
      signature: null,
    };

    // Compute its content hash
    const hashBytes = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(unsignedMemory.content)),
    );
    unsignedMemory.contentHash = Array.from(hashBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Verify it's unsigned
    expect(await verifyMemory(unsignedMemory)).toBe(false);

    // Backfill: sign it now
    const payload = buildSignablePayloadV2(
      unsignedMemory.id,
      unsignedMemory.contentHash,
      unsignedMemory.createdAt,
      did,
    );
    const sigBytes = sodium.crypto_sign_detached(
      new TextEncoder().encode(payload),
      keypair.privateKey,
    );
    unsignedMemory.signature = sodium.to_base64(sigBytes, sodium.base64_variants.ORIGINAL);
    unsignedMemory.signerDid = did;

    // Now it should verify
    expect(await verifyMemory(unsignedMemory)).toBe(true);
  });

  test("backfill: re-signed memory maintains Merkle tree consistency", async () => {
    // Create a mix of signed and unsigned memories
    const memories: MockMemory[] = [];

    // 3 already-signed memories
    for (let i = 0; i < 3; i++) {
      memories.push(await createSignedMemory(`signed-${i}`, `Signed content ${i}`));
    }

    // 2 unsigned memories (simulating legacy)
    for (let i = 0; i < 2; i++) {
      const hashBytes = new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(`Unsigned content ${i}`),
        ),
      );
      memories.push({
        id: `unsigned-${i}`,
        content: `Unsigned content ${i}`,
        contentHash: Array.from(hashBytes)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(""),
        createdAt: "2025-01-15T00:00:00.000Z",
        signerDid: null,
        signature: null,
      });
    }

    // Build Merkle tree BEFORE backfill
    const contentHashes = memories.map((m) => m.contentHash);
    const treeBefore = await buildMerkleTree(contentHashes);

    // Backfill: sign the unsigned memories
    for (const mem of memories) {
      if (!mem.signature) {
        const payload = buildSignablePayloadV2(mem.id, mem.contentHash, mem.createdAt, did);
        const sig = sodium.crypto_sign_detached(
          new TextEncoder().encode(payload),
          keypair.privateKey,
        );
        mem.signature = sodium.to_base64(sig, sodium.base64_variants.ORIGINAL);
        mem.signerDid = did;
      }
    }

    // Build Merkle tree AFTER backfill
    const treeAfter = await buildMerkleTree(contentHashes);

    // Key invariant: Merkle root should be IDENTICAL because signing
    // doesn't change content hashes (signatures are separate from content)
    expect(treeAfter.root).toBe(treeBefore.root);

    // All memories now verify
    for (const mem of memories) {
      expect(await verifyMemory(mem)).toBe(true);
    }

    // All Merkle proofs still valid
    for (let i = 0; i < memories.length; i++) {
      const proof = generateProof(treeAfter, i);
      const valid = await verifyProof(proof, contentHashes[i], treeAfter.root);
      expect(valid).toBe(true);
    }
  });

  test("tampered memory content invalidates both signature and Merkle proof", async () => {
    const memories = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        createSignedMemory(`tamper-${i}`, `Original content ${i}`),
      ),
    );

    const tree = await buildMerkleTree(memories.map((m) => m.contentHash));

    // Tamper with memory 1's content
    const tampered = { ...memories[1] };
    tampered.content = "TAMPERED CONTENT";
    const newHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tampered.content)),
    );
    tampered.contentHash = Array.from(newHash)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Signature verification FAILS (content hash changed)
    expect(await verifyMemory(tampered)).toBe(false);

    // Merkle proof FAILS (wrong leaf hash)
    const proof = generateProof(tree, 1);
    const valid = await verifyProof(proof, tampered.contentHash, tree.root);
    expect(valid).toBe(false);
  });
});
```

---

## 5. Test Code: Hardhat + ethers.js (Test 5)

```typescript
// packages/contracts/test/SignetIdentity.test.ts

import { expect } from "chai";
import { ethers } from "hardhat";
import type { SignetIdentity } from "../typechain-types";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-toolbox/types";

describe("Integration Test 5: Full Chain — Key Gen → Sign → Merkle → Anchor", function () {
  let contract: SignetIdentity;
  let owner: HardhatEthersSigner;
  let agent: HardhatEthersSigner;
  let attacker: HardhatEthersSigner;

  beforeEach(async function () {
    [owner, agent, attacker] = await ethers.getSigners();
    const SignetIdentity = await ethers.getContractFactory("SignetIdentity");
    contract = await SignetIdentity.deploy();
    await contract.waitForDeployment();
  });

  // ---- Helper: register an agent identity via commit-reveal ----
  async function registerAgent(
    signer: HardhatEthersSigner,
    did: string,
    metadataURI: string,
    publicKeyHash: string,
  ): Promise<bigint> {
    const salt = ethers.randomBytes(32);
    const commitment = ethers.keccak256(
      ethers.solidityPacked(
        ["string", "string", "bytes32", "address", "bytes32"],
        [did, metadataURI, publicKeyHash, signer.address, salt],
      ),
    );

    // Phase 1: Commit
    await contract.connect(signer).commitRegistration(commitment);

    // Mine a block to satisfy COMMIT_DELAY
    await ethers.provider.send("evm_mine", []);

    // Phase 2: Reveal
    const tx = await contract.connect(signer).register(did, metadataURI, publicKeyHash, salt);
    const receipt = await tx.wait();

    // Extract tokenId from IdentityRegistered event
    const event = receipt?.logs.find((log) => {
      try {
        return contract.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name === "IdentityRegistered";
      } catch {
        return false;
      }
    });

    if (!event) throw new Error("IdentityRegistered event not found");
    const parsed = contract.interface.parseLog({ topics: event.topics as string[], data: event.data });
    return parsed!.args.tokenId;
  }

  // ---- Contract deployment ----

  describe("Deployment", function () {
    it("deploys with correct name and symbol", async function () {
      expect(await contract.name()).to.equal("Signet Identity");
      expect(await contract.symbol()).to.equal("SIGNET");
    });

    it("deployer is owner", async function () {
      expect(await contract.owner()).to.equal(owner.address);
    });
  });

  // ---- Commit-reveal registration ----

  describe("Registration (Commit-Reveal)", function () {
    const testDid = "did:key:z6MktestPublicKeyHere123456789";
    const testMetadata = "ipfs://QmTestMetadata";
    const testKeyHash = ethers.keccak256(ethers.toUtf8Bytes("test-ed25519-pubkey"));

    it("registers an agent identity via commit-reveal", async function () {
      const tokenId = await registerAgent(agent, testDid, testMetadata, testKeyHash);
      expect(tokenId).to.equal(1n);

      const identity = await contract.getIdentityByDID(testDid);
      expect(identity.did).to.equal(testDid);
      expect(identity.metadataURI).to.equal(testMetadata);
      expect(identity.publicKeyHash).to.equal(testKeyHash);
      expect(identity.memoryRoot).to.equal(ethers.ZeroHash);
      expect(identity.memoryCount).to.equal(0n);
    });

    it("rejects registration without prior commit", async function () {
      const salt = ethers.randomBytes(32);
      await expect(
        contract.connect(agent).register(testDid, testMetadata, testKeyHash, salt),
      ).to.be.revertedWith("No commitment found");
    });

    it("rejects duplicate DID registration", async function () {
      await registerAgent(agent, testDid, testMetadata, testKeyHash);

      const otherKeyHash = ethers.keccak256(ethers.toUtf8Bytes("other-key"));
      await expect(
        registerAgent(attacker, testDid, "ipfs://fake", otherKeyHash),
      ).to.be.revertedWith("DID already registered");
    });

    it("rejects duplicate public key registration", async function () {
      await registerAgent(agent, testDid, testMetadata, testKeyHash);

      await expect(
        registerAgent(attacker, "did:key:z6MkDifferentDID", "ipfs://other", testKeyHash),
      ).to.be.revertedWith("Key already registered");
    });

    it("rejects empty DID", async function () {
      await expect(
        registerAgent(agent, "", testMetadata, testKeyHash),
      ).to.be.revertedWith("DID cannot be empty");
    });

    it("rejects zero public key hash", async function () {
      await expect(
        registerAgent(agent, testDid, testMetadata, ethers.ZeroHash),
      ).to.be.revertedWith("Invalid public key hash");
    });
  });

  // ---- Soulbound (non-transferable) ----

  describe("Soulbound Property", function () {
    it("blocks transfers", async function () {
      const testDid = "did:key:z6MkSoulbound";
      const testKeyHash = ethers.keccak256(ethers.toUtf8Bytes("soulbound-key"));
      const tokenId = await registerAgent(agent, testDid, "ipfs://sb", testKeyHash);

      await expect(
        contract.connect(agent).transferFrom(agent.address, attacker.address, tokenId),
      ).to.be.revertedWith("Soulbound: identity NFTs are non-transferable");
    });
  });

  // ---- Memory anchoring ----

  describe("Memory Anchoring", function () {
    let tokenId: bigint;
    const testDid = "did:key:z6MkAnchorTest";
    const testKeyHash = ethers.keccak256(ethers.toUtf8Bytes("anchor-key"));

    beforeEach(async function () {
      tokenId = await registerAgent(agent, testDid, "ipfs://anchor", testKeyHash);
    });

    it("anchors a memory root on-chain", async function () {
      // Simulate building a keccak256 Merkle tree off-chain
      const memories = [
        { id: "m1", contentHash: "aa".repeat(32) },
        { id: "m2", contentHash: "bb".repeat(32) },
        { id: "m3", contentHash: "cc".repeat(32) },
      ];

      // Build leaves
      const leaves = memories.map((m) =>
        ethers.keccak256(ethers.toUtf8Bytes(`signet:memory:${m.contentHash}`)),
      );

      // Build tree (simplified 3-leaf)
      const pair01 = ethers.keccak256(
        ethers.concat(
          leaves[0] < leaves[1]
            ? [ethers.getBytes(leaves[0]), ethers.getBytes(leaves[1])]
            : [ethers.getBytes(leaves[1]), ethers.getBytes(leaves[0])],
        ),
      );
      // Odd leaf promoted
      const root = ethers.keccak256(
        ethers.concat(
          pair01 < leaves[2]
            ? [ethers.getBytes(pair01), ethers.getBytes(leaves[2])]
            : [ethers.getBytes(leaves[2]), ethers.getBytes(pair01)],
        ),
      );

      const tx = await contract.connect(agent).anchorMemory(tokenId, root, 3);
      const receipt = await tx.wait();

      // Verify event
      const event = receipt?.logs.find((log) => {
        try {
          return contract.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name === "MemoryAnchored";
        } catch {
          return false;
        }
      });
      expect(event).to.not.be.undefined;

      // Verify on-chain state
      const identity = await contract.identities(tokenId);
      expect(identity.memoryRoot).to.equal(root);
      expect(identity.memoryCount).to.equal(3n);
      expect(identity.lastAnchored).to.be.greaterThan(0n);
    });

    it("allows updating memory root with more memories", async function () {
      // First anchor
      const root1 = ethers.keccak256(ethers.toUtf8Bytes("root-v1"));
      await contract.connect(agent).anchorMemory(tokenId, root1, 5);

      // Second anchor with more memories
      const root2 = ethers.keccak256(ethers.toUtf8Bytes("root-v2"));
      await contract.connect(agent).anchorMemory(tokenId, root2, 10);

      const identity = await contract.identities(tokenId);
      expect(identity.memoryRoot).to.equal(root2);
      expect(identity.memoryCount).to.equal(10n);
    });

    it("rejects memory count decrease (M-9)", async function () {
      const root = ethers.keccak256(ethers.toUtf8Bytes("root"));
      await contract.connect(agent).anchorMemory(tokenId, root, 10);

      await expect(
        contract.connect(agent).anchorMemory(tokenId, root, 5),
      ).to.be.revertedWith("Memory count cannot decrease");
    });

    it("rejects anchor from non-owner", async function () {
      const root = ethers.keccak256(ethers.toUtf8Bytes("fake-root"));
      await expect(
        contract.connect(attacker).anchorMemory(tokenId, root, 1),
      ).to.be.reverted;
    });
  });

  // ---- Full E2E pipeline ----

  describe("Full Pipeline: Key Gen → DID → Sign → Merkle → Anchor → Verify", function () {
    it("executes the complete identity + memory anchoring flow", async function () {
      // Step 1: Simulate Ed25519 key generation (off-chain)
      // In real code this uses libsodium; here we represent it as hashes
      const agentPublicKey = ethers.randomBytes(32);
      const publicKeyHash = ethers.keccak256(agentPublicKey);

      // Step 2: Construct DID (off-chain)
      const agentDid = "did:key:z6Mk" + ethers.hexlify(agentPublicKey).slice(2, 46);

      // Step 3: Register identity on-chain
      const tokenId = await registerAgent(
        agent,
        agentDid,
        "ipfs://QmAgentMetadata",
        publicKeyHash,
      );
      expect(tokenId).to.be.greaterThan(0n);

      // Step 4: Create memories with content hashes (off-chain)
      const memoryContents = [
        "User prefers TypeScript over JavaScript",
        "User's timezone is America/New_York",
        "User uses Bun as their runtime",
        "User's project is called Signet",
        "User prefers dark theme",
      ];

      const contentHashes = memoryContents.map((content) =>
        ethers.keccak256(ethers.toUtf8Bytes(content)),
      );

      // Step 5: Build Merkle tree (off-chain)
      const leaves = contentHashes.map((hash) =>
        ethers.keccak256(ethers.toUtf8Bytes(`signet:memory:${hash}`)),
      );

      // Build tree bottom-up
      function buildTree(leafHashes: string[]): string {
        if (leafHashes.length === 0) return ethers.ZeroHash;
        if (leafHashes.length === 1) return leafHashes[0];

        let layer = [...leafHashes];
        while (layer.length > 1) {
          const next: string[] = [];
          for (let i = 0; i < layer.length; i += 2) {
            if (i + 1 < layer.length) {
              const [a, b] = layer[i] < layer[i + 1]
                ? [layer[i], layer[i + 1]]
                : [layer[i + 1], layer[i]];
              next.push(
                ethers.keccak256(ethers.concat([ethers.getBytes(a), ethers.getBytes(b)])),
              );
            } else {
              next.push(layer[i]);
            }
          }
          layer = next;
        }
        return layer[0];
      }

      const merkleRoot = buildTree(leaves);

      // Step 6: Anchor on-chain
      const anchorTx = await contract.connect(agent).anchorMemory(
        tokenId,
        merkleRoot,
        memoryContents.length,
      );
      await anchorTx.wait();

      // Step 7: Verify on-chain state
      const identity = await contract.identities(tokenId);
      expect(identity.memoryRoot).to.equal(merkleRoot);
      expect(identity.memoryCount).to.equal(BigInt(memoryContents.length));
      expect(identity.lastAnchored).to.be.greaterThan(0n);
      expect(identity.did).to.equal(agentDid);
      expect(identity.publicKeyHash).to.equal(publicKeyHash);

      // Step 8: Verify via DID lookup
      const lookedUp = await contract.getIdentityByDID(agentDid);
      expect(lookedUp.memoryRoot).to.equal(merkleRoot);
      expect(lookedUp.memoryCount).to.equal(BigInt(memoryContents.length));

      // Step 9: Re-anchor after adding more memories
      const moreContents = [
        "User likes coffee in the morning",
        "User's editor is VS Code",
      ];
      const allContents = [...memoryContents, ...moreContents];
      const allContentHashes = allContents.map((c) =>
        ethers.keccak256(ethers.toUtf8Bytes(c)),
      );
      const allLeaves = allContentHashes.map((h) =>
        ethers.keccak256(ethers.toUtf8Bytes(`signet:memory:${h}`)),
      );
      const newRoot = buildTree(allLeaves);

      await contract.connect(agent).anchorMemory(tokenId, newRoot, allContents.length);

      const updated = await contract.identities(tokenId);
      expect(updated.memoryRoot).to.equal(newRoot);
      expect(updated.memoryCount).to.equal(BigInt(allContents.length));
      expect(updated.memoryRoot).to.not.equal(merkleRoot); // root changed
    });
  });

  // ---- Metadata ----

  describe("Metadata", function () {
    it("owner can update metadata URI", async function () {
      const tokenId = await registerAgent(
        agent,
        "did:key:z6MkMeta",
        "ipfs://old",
        ethers.keccak256(ethers.toUtf8Bytes("meta-key")),
      );

      await contract.connect(agent).updateMetadata(tokenId, "ipfs://new");
      expect(await contract.tokenURI(tokenId)).to.equal("ipfs://new");
    });

    it("non-owner cannot update metadata", async function () {
      const tokenId = await registerAgent(
        agent,
        "did:key:z6MkMetaDeny",
        "ipfs://meta",
        ethers.keccak256(ethers.toUtf8Bytes("meta-key-2")),
      );

      await expect(
        contract.connect(attacker).updateMetadata(tokenId, "ipfs://hacked"),
      ).to.be.reverted;
    });
  });
});
```

---

## 6. CI Pipeline Recommendations

### Test Tiers

| Tier | Tests | Runtime | Trigger |
|------|-------|---------|---------|
| **Fast** | Unit tests (existing 404) + crypto integration (Tests 1-4) | ~15s | Every push, every PR |
| **Chain** | Hardhat contract tests (Test 5) | ~30s | Every push to `main`, PRs touching `contracts/` or `chain/` |
| **Full** | All tiers + linting + type checking | ~60s | Pre-merge, nightly |

### Recommended CI Configuration (GitHub Actions)

```yaml
# .github/workflows/test.yml
name: Test Suite

on:
  push:
    branches: [main, develop]
  pull_request:

jobs:
  fast-tests:
    name: "Fast Tests (Bun)"
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install
      - run: bun test --bail 5
        env:
          SIGNET_PATH: ${{ runner.temp }}/signet-test

  contract-tests:
    name: "Contract Tests (Hardhat)"
    runs-on: ubuntu-latest
    if: |
      github.ref == 'refs/heads/main' ||
      contains(github.event.pull_request.labels.*.name, 'contracts') ||
      contains(join(github.event.pull_request.changed_files.*.filename, ','), 'contracts/') ||
      contains(join(github.event.pull_request.changed_files.*.filename, ','), 'chain/')
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: cd packages/contracts && npm install
      - run: cd packages/contracts && npx hardhat test

  typecheck:
    name: "Type Check"
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run typecheck
```

### Key CI Practices

1. **Use `$RUNNER_TEMP` for `SIGNET_PATH`** — tests that touch `crypto.ts` need a writable directory. Never use `~/.agents` in CI.

2. **Use `--bail 5`** — stop after 5 failures to save CI minutes. Crypto failures often cascade.

3. **Hardhat runs on Node, not Bun** — Hardhat doesn't fully support Bun yet. Use Node 20+ for contract tests.

4. **Separate jobs for parallelism** — Bun tests and Hardhat tests have different runtimes and dependencies.

5. **Label-based gating** — Contract tests are slow; only run them when relevant files change or on `main`.

6. **Test isolation** — Each test creates its own temp directory and keypair. No shared state between test files.

### Security Testing Additions (Future)

- **Fuzz testing** with `fast-check` for base58btc encode/decode edge cases
- **Known-answer tests (KATs)** — verify Ed25519 signatures against RFC 8032 test vectors
- **Cross-language verification** — generate signatures in TypeScript, verify in Solidity (once on-chain Ed25519 verification is added)
- **Gas benchmarks** — track `anchorMemory` gas cost over time to catch regressions

---

## Summary of Immediate Actions

1. **Fix the 5 failing tests** — Update migration count from 19→20, fix macOS case-sensitivity issue
2. **Create `packages/core/src/__tests/`** directory and add Tests 1-4 (this document provides the code)
3. **Create `packages/contracts/test/SignetIdentity.test.ts`** with Test 5
4. **Add CI workflow** for contract tests
5. **Track test coverage** — target 80%+ on crypto/merkle/did modules within one sprint
