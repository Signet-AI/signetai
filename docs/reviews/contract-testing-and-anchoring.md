# SignetIdentity Contract Testing & On-Chain Anchoring Architecture

> **Date:** 2025-02-24
> **Scope:** Full test spec for `SignetIdentity.sol`, anchoring pipeline architecture, gas analysis, wallet management strategy
> **Contract:** `packages/contracts/src/SignetIdentity.sol`
> **Chain integration:** `packages/core/src/chain/` (wallet, contract, merkle, session-keys, payments)

---

## Table of Contents

1. [Contract Overview](#1-contract-overview)
2. [Full Test Specification](#2-full-test-specification)
3. [Hardhat Test Code Examples](#3-hardhat-test-code-examples)
4. [Anchoring Pipeline Architecture](#4-anchoring-pipeline-architecture)
5. [Daemon Anchoring Worker Code](#5-daemon-anchoring-worker-code)
6. [Gas Cost Analysis](#6-gas-cost-analysis)
7. [Wallet Management Strategy](#7-wallet-management-strategy)
8. [ERC-8004 Alignment Analysis](#8-erc-8004-alignment-analysis)
9. [Recommendations](#9-recommendations)

---

## 1. Contract Overview

`SignetIdentity` is a soulbound (non-transferable) ERC-721 contract that serves as an on-chain identity registry for Signet AI agents. Key design features:

### Functions

| Function | Visibility | Mutability | Purpose |
|---|---|---|---|
| `constructor()` | public | — | Deploys with name "Signet Identity", symbol "SIGNET", owner = deployer |
| `_update(to, tokenId, auth)` | internal | override | Soulbound enforcement — blocks all transfers except mints |
| `commitRegistration(commitment)` | external | write | Phase 1 of commit-reveal: stores `keccak256(did, metadataURI, publicKeyHash, sender, salt)` with timestamp |
| `register(did, metadataURI, publicKeyHash, salt)` | external | write | Phase 2: reveals commitment, mints soulbound NFT, stores `AgentIdentity` struct |
| `anchorMemory(tokenId, memoryRoot, memoryCount)` | external | write | Anchors a Merkle root + count to an agent's identity; monotonic count enforcement |
| `updateMetadata(tokenId, metadataURI)` | external | write | Owner-only metadata URI update |
| `getIdentityByDID(did)` | external | view | Lookup identity by DID string |
| `tokenURI(tokenId)` | public | view | Returns the agent's metadataURI |

### State Variables

| Variable | Type | Purpose |
|---|---|---|
| `identities` | `mapping(uint256 => AgentIdentity)` | Token ID → full identity struct |
| `didToTokenId` | `mapping(bytes32 => uint256)` | `keccak256(did)` → token ID |
| `publicKeyRegistered` | `mapping(bytes32 => bool)` | Prevents duplicate public key registration |
| `commitTimestamps` | `mapping(bytes32 => uint256)` | Commitment hash → block.timestamp |
| `COMMIT_DELAY` | `uint256 constant = 1` | Minimum seconds between commit and reveal |
| `COMMIT_EXPIRY` | `uint256 constant = 86400` | Maximum seconds before commitment expires (24h) |
| `_nextTokenId` | `uint256 private` | Auto-incrementing token counter |

### Security Audit Tags Found in Code

- **C-1:** Commit-reveal for front-running protection
- **H-1:** Soulbound transfer blocking via `_update` override
- **H-2:** Zero public key hash rejection
- **H-3:** Empty DID rejection
- **M-9:** Monotonic memory count enforcement

---

## 2. Full Test Specification

### 2.1 Deployment Tests

```
describe("Deployment")
  ✓ should deploy with correct name "Signet Identity"
  ✓ should deploy with correct symbol "SIGNET"
  ✓ should set deployer as owner
  ✓ should start with _nextTokenId at 0 (no tokens minted)
  ✓ should have COMMIT_DELAY of 1
  ✓ should have COMMIT_EXPIRY of 86400
```

### 2.2 Commit-Reveal Registration Tests

```
describe("commitRegistration")
  ✓ should store commitment timestamp
  ✓ should emit RegistrationCommitted event with sender and commitment
  ✓ should allow the same address to make multiple commitments
  ✓ should allow different addresses to commit the same hash
  ✓ should overwrite timestamp if same commitment is re-submitted

describe("register — happy path")
  ✓ should mint token after valid commit-reveal
  ✓ should assign token ID = 1 for first registration
  ✓ should increment token IDs sequentially (1, 2, 3...)
  ✓ should store correct AgentIdentity struct fields
  ✓ should map DID hash to token ID via didToTokenId
  ✓ should mark public key hash as registered
  ✓ should emit IdentityRegistered event with (tokenId, did, publicKeyHash)
  ✓ should delete the commitment after successful registration
  ✓ should set registeredAt to block.timestamp
  ✓ should set lastAnchored to 0
  ✓ should set memoryRoot to bytes32(0)
  ✓ should set memoryCount to 0
  ✓ should make msg.sender the NFT owner

describe("register — commit-reveal enforcement (C-1)")
  ✗ should revert if no commitment exists ("No commitment found")
  ✗ should revert if commitment is too recent (within COMMIT_DELAY) ("Commitment too recent")
  ✗ should revert if commitment has expired (> COMMIT_EXPIRY) ("Commitment expired")
  ✗ should revert if wrong salt is used (commitment mismatch)
  ✗ should revert if different sender reveals another's commitment
  ✗ should revert if DID is altered between commit and reveal
  ✗ should revert if metadataURI is altered between commit and reveal
  ✗ should revert if publicKeyHash is altered between commit and reveal
  ✓ should succeed at exactly COMMIT_DELAY + 1 second
  ✓ should succeed at exactly COMMIT_EXPIRY boundary

describe("register — input validation")
  ✗ should revert with empty DID ("DID cannot be empty") (H-3)
  ✗ should revert with zero bytes32 publicKeyHash ("Invalid public key hash") (H-2)
  ✗ should revert if publicKeyHash is already registered ("Key already registered")
  ✗ should revert if DID is already registered ("DID already registered")

describe("register — front-running attack vectors")
  ✗ should prevent attacker from using victim's commitment (different sender address in hash)
  ✗ should prevent commitment replay after deletion (commitment consumed on first use)
  ✓ should allow legitimate re-registration after a failed first attempt with new commitment
```

### 2.3 Soulbound Transfer Tests (H-1)

```
describe("Soulbound enforcement — _update override")
  ✓ should allow minting (from = address(0) → to = owner)
  ✗ should revert on transferFrom ("Soulbound: identity NFTs are non-transferable")
  ✗ should revert on safeTransferFrom(address,address,uint256)
  ✗ should revert on safeTransferFrom(address,address,uint256,bytes)
  ✗ should revert when owner tries to transfer to self
  ✗ should revert when owner tries to transfer to another address
  ✗ should revert on approve + transferFrom flow
  ✗ should revert on setApprovalForAll + transferFrom flow
  ✓ should still allow approve() to succeed (even though transfer will fail)
  ✓ should still allow setApprovalForAll() to succeed
```

### 2.4 Memory Anchoring Tests

```
describe("anchorMemory — happy path")
  ✓ should update memoryRoot on identity
  ✓ should update memoryCount on identity
  ✓ should update lastAnchored to block.timestamp
  ✓ should emit MemoryAnchored event with (tokenId, memoryRoot, memoryCount)
  ✓ should allow overwriting with a new root and higher count
  ✓ should allow same memoryCount (equal, not just greater) (M-9 says >=)

describe("anchorMemory — access control")
  ✗ should revert if caller is not token owner ("Not owner")
  ✗ should revert for non-existent token ID (ERC721 reverts)

describe("anchorMemory — monotonicity enforcement (M-9)")
  ✗ should revert if memoryCount < current count ("Memory count cannot decrease")
  ✓ should allow memoryCount == current count (idempotent re-anchor)
  ✓ should allow memoryCount > current count

describe("anchorMemory — edge cases")
  ✓ should accept bytes32(0) as memoryRoot (reset scenario)
  ✓ should accept memoryCount = 0 on first anchor
  ✓ should accept max uint64 value for memoryCount
  ✓ should handle multiple sequential anchors correctly
```

### 2.5 Metadata Update Tests

```
describe("updateMetadata")
  ✓ should update metadataURI on identity
  ✓ should emit MetadataUpdated event with (tokenId, newMetadataURI)
  ✓ should allow setting empty string as metadata
  ✗ should revert if caller is not token owner ("Not owner")
  ✗ should revert for non-existent token ID
```

### 2.6 Query Tests

```
describe("getIdentityByDID")
  ✓ should return correct AgentIdentity for registered DID
  ✗ should revert for unregistered DID ("DID not found")
  ✓ should return updated data after anchorMemory
  ✓ should return updated data after updateMetadata

describe("tokenURI")
  ✓ should return metadataURI for valid token
  ✓ should return updated URI after updateMetadata
  ✗ should revert for non-existent token (ERC721NonexistentToken)

describe("identities mapping")
  ✓ should return all struct fields via public getter
  ✓ should return empty struct for non-existent token ID

describe("didToTokenId mapping")
  ✓ should return token ID for registered DID hash
  ✓ should return 0 for unregistered DID hash

describe("publicKeyRegistered mapping")
  ✓ should return true for registered key hash
  ✓ should return false for unregistered key hash
```

### 2.7 ERC-721 Compliance Tests

```
describe("ERC-721 standard compliance")
  ✓ should support ERC-721 interface (ERC165)
  ✓ should support ERC-721 Metadata interface
  ✓ should return correct name()
  ✓ should return correct symbol()
  ✓ should return correct balanceOf() after minting
  ✓ should return correct ownerOf() after minting
```

### 2.8 Ownable Tests

```
describe("Ownable")
  ✓ should set deployer as initial owner
  ✓ should allow owner to transfer ownership
  ✓ should allow owner to renounce ownership
  Note: Ownable is inherited but no admin functions currently use onlyOwner
  (This is a design consideration — should anchorMemory or register require admin?)
```

### 2.9 Attack Vector Tests

```
describe("Attack vectors")
  ✗ Front-running: attacker sees mempool commit, submits own — commitment includes sender address so different hash
  ✗ Replay: attacker replays same register() call — commitment already deleted
  ✗ Grief: attacker commits on victim's behalf to block their real commitment — commitment is per (data + sender), can't collide
  ✗ DID squatting: register someone else's DID — possible but requires commitment; DID string has no ownership verification on-chain
  ✗ Token ID overflow: uint256 overflow is effectively impossible
  ✗ Reentrancy: no external calls before state updates; ERC721 _safeMint not used (uses _mint)
  ✗ Storage collision: struct packing verified, no overlapping slots
```

---

## 3. Hardhat Test Code Examples

### 3.1 Test Setup and Helpers

```typescript
// test/SignetIdentity.test.ts
import { expect } from "chai";
import { ethers } from "hardhat";
import { SignetIdentity } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("SignetIdentity", function () {
  let contract: SignetIdentity;
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let attacker: HardhatEthersSigner;

  // Helper: compute commitment hash matching the Solidity packing
  function computeCommitment(
    did: string,
    metadataURI: string,
    publicKeyHash: string,
    sender: string,
    salt: string
  ): string {
    return ethers.keccak256(
      ethers.solidityPacked(
        ["string", "string", "bytes32", "address", "bytes32"],
        [did, metadataURI, publicKeyHash, sender, salt]
      )
    );
  }

  // Helper: full commit-reveal registration flow
  async function commitAndRegister(
    signer: HardhatEthersSigner,
    did: string,
    metadataURI: string,
    publicKeyHash: string,
    delaySeconds: number = 2
  ) {
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const commitment = computeCommitment(
      did,
      metadataURI,
      publicKeyHash,
      signer.address,
      salt
    );

    await contract.connect(signer).commitRegistration(commitment);
    await time.increase(delaySeconds);

    const tx = await contract
      .connect(signer)
      .register(did, metadataURI, publicKeyHash, salt);
    const receipt = await tx.wait();

    // Parse token ID from event
    const event = receipt?.logs
      .map((log) => {
        try {
          return contract.interface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          });
        } catch {
          return null;
        }
      })
      .find((e) => e?.name === "IdentityRegistered");

    return {
      tokenId: event?.args[0] as bigint,
      tx,
      receipt,
      salt,
    };
  }

  // Test fixtures
  const TEST_DID = "did:signet:test-agent-001";
  const TEST_METADATA = "ipfs://QmTest123/manifest.json";
  const TEST_PUBLIC_KEY_HASH = ethers.keccak256(
    ethers.toUtf8Bytes("test-ed25519-pubkey-001")
  );

  beforeEach(async function () {
    [owner, alice, bob, attacker] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("SignetIdentity");
    contract = await Factory.deploy();
    await contract.waitForDeployment();
  });

  // ═══════════════════════════════════════════════════════════════
  // DEPLOYMENT
  // ═══════════════════════════════════════════════════════════════
  describe("Deployment", function () {
    it("should deploy with correct name and symbol", async function () {
      expect(await contract.name()).to.equal("Signet Identity");
      expect(await contract.symbol()).to.equal("SIGNET");
    });

    it("should set deployer as owner", async function () {
      expect(await contract.owner()).to.equal(owner.address);
    });

    it("should have correct constants", async function () {
      expect(await contract.COMMIT_DELAY()).to.equal(1n);
      expect(await contract.COMMIT_EXPIRY()).to.equal(86400n);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // COMMIT-REVEAL REGISTRATION
  // ═══════════════════════════════════════════════════════════════
  describe("Commit-Reveal Registration", function () {
    describe("commitRegistration", function () {
      it("should store commitment and emit event", async function () {
        const salt = ethers.hexlify(ethers.randomBytes(32));
        const commitment = computeCommitment(
          TEST_DID,
          TEST_METADATA,
          TEST_PUBLIC_KEY_HASH,
          alice.address,
          salt
        );

        await expect(
          contract.connect(alice).commitRegistration(commitment)
        )
          .to.emit(contract, "RegistrationCommitted")
          .withArgs(alice.address, commitment);

        expect(await contract.commitTimestamps(commitment)).to.be.gt(0);
      });
    });

    describe("register — happy path", function () {
      it("should mint soulbound NFT with correct identity", async function () {
        const { tokenId } = await commitAndRegister(
          alice,
          TEST_DID,
          TEST_METADATA,
          TEST_PUBLIC_KEY_HASH
        );

        expect(tokenId).to.equal(1n);
        expect(await contract.ownerOf(tokenId)).to.equal(alice.address);

        const identity = await contract.identities(tokenId);
        expect(identity.did).to.equal(TEST_DID);
        expect(identity.metadataURI).to.equal(TEST_METADATA);
        expect(identity.publicKeyHash).to.equal(TEST_PUBLIC_KEY_HASH);
        expect(identity.registeredAt).to.be.gt(0);
        expect(identity.lastAnchored).to.equal(0);
        expect(identity.memoryRoot).to.equal(ethers.ZeroHash);
        expect(identity.memoryCount).to.equal(0);
      });

      it("should emit IdentityRegistered event", async function () {
        const salt = ethers.hexlify(ethers.randomBytes(32));
        const commitment = computeCommitment(
          TEST_DID,
          TEST_METADATA,
          TEST_PUBLIC_KEY_HASH,
          alice.address,
          salt
        );

        await contract.connect(alice).commitRegistration(commitment);
        await time.increase(2);

        await expect(
          contract
            .connect(alice)
            .register(TEST_DID, TEST_METADATA, TEST_PUBLIC_KEY_HASH, salt)
        )
          .to.emit(contract, "IdentityRegistered")
          .withArgs(1n, TEST_DID, TEST_PUBLIC_KEY_HASH);
      });

      it("should increment token IDs sequentially", async function () {
        const pkh2 = ethers.keccak256(ethers.toUtf8Bytes("key2"));

        const { tokenId: id1 } = await commitAndRegister(
          alice,
          "did:signet:agent-1",
          TEST_METADATA,
          TEST_PUBLIC_KEY_HASH
        );
        const { tokenId: id2 } = await commitAndRegister(
          bob,
          "did:signet:agent-2",
          TEST_METADATA,
          pkh2
        );

        expect(id1).to.equal(1n);
        expect(id2).to.equal(2n);
      });
    });

    describe("register — commit-reveal enforcement (C-1)", function () {
      it("should revert without commitment", async function () {
        const salt = ethers.hexlify(ethers.randomBytes(32));
        await expect(
          contract
            .connect(alice)
            .register(TEST_DID, TEST_METADATA, TEST_PUBLIC_KEY_HASH, salt)
        ).to.be.revertedWith("No commitment found");
      });

      it("should revert if commitment is too recent", async function () {
        const salt = ethers.hexlify(ethers.randomBytes(32));
        const commitment = computeCommitment(
          TEST_DID,
          TEST_METADATA,
          TEST_PUBLIC_KEY_HASH,
          alice.address,
          salt
        );

        await contract.connect(alice).commitRegistration(commitment);
        // Don't wait — try to register immediately

        await expect(
          contract
            .connect(alice)
            .register(TEST_DID, TEST_METADATA, TEST_PUBLIC_KEY_HASH, salt)
        ).to.be.revertedWith("Commitment too recent");
      });

      it("should revert if commitment has expired", async function () {
        const salt = ethers.hexlify(ethers.randomBytes(32));
        const commitment = computeCommitment(
          TEST_DID,
          TEST_METADATA,
          TEST_PUBLIC_KEY_HASH,
          alice.address,
          salt
        );

        await contract.connect(alice).commitRegistration(commitment);
        await time.increase(86401); // Past COMMIT_EXPIRY

        await expect(
          contract
            .connect(alice)
            .register(TEST_DID, TEST_METADATA, TEST_PUBLIC_KEY_HASH, salt)
        ).to.be.revertedWith("Commitment expired");
      });

      it("should revert if attacker tries to reveal another's commitment", async function () {
        const salt = ethers.hexlify(ethers.randomBytes(32));
        // Alice's commitment includes alice.address
        const commitment = computeCommitment(
          TEST_DID,
          TEST_METADATA,
          TEST_PUBLIC_KEY_HASH,
          alice.address,
          salt
        );

        await contract.connect(alice).commitRegistration(commitment);
        await time.increase(2);

        // Attacker tries to register — different sender means different commitment hash
        await expect(
          contract
            .connect(attacker)
            .register(TEST_DID, TEST_METADATA, TEST_PUBLIC_KEY_HASH, salt)
        ).to.be.revertedWith("No commitment found");
      });
    });

    describe("register — input validation", function () {
      it("should revert with empty DID (H-3)", async function () {
        const salt = ethers.hexlify(ethers.randomBytes(32));
        const commitment = computeCommitment(
          "",
          TEST_METADATA,
          TEST_PUBLIC_KEY_HASH,
          alice.address,
          salt
        );

        await contract.connect(alice).commitRegistration(commitment);
        await time.increase(2);

        await expect(
          contract
            .connect(alice)
            .register("", TEST_METADATA, TEST_PUBLIC_KEY_HASH, salt)
        ).to.be.revertedWith("DID cannot be empty");
      });

      it("should revert with zero publicKeyHash (H-2)", async function () {
        const salt = ethers.hexlify(ethers.randomBytes(32));
        const commitment = computeCommitment(
          TEST_DID,
          TEST_METADATA,
          ethers.ZeroHash,
          alice.address,
          salt
        );

        await contract.connect(alice).commitRegistration(commitment);
        await time.increase(2);

        await expect(
          contract
            .connect(alice)
            .register(TEST_DID, TEST_METADATA, ethers.ZeroHash, salt)
        ).to.be.revertedWith("Invalid public key hash");
      });

      it("should revert on duplicate publicKeyHash", async function () {
        await commitAndRegister(alice, TEST_DID, TEST_METADATA, TEST_PUBLIC_KEY_HASH);

        // Try registering a different DID with the same key hash
        await expect(
          commitAndRegister(bob, "did:signet:agent-2", TEST_METADATA, TEST_PUBLIC_KEY_HASH)
        ).to.be.revertedWith("Key already registered");
      });

      it("should revert on duplicate DID", async function () {
        await commitAndRegister(alice, TEST_DID, TEST_METADATA, TEST_PUBLIC_KEY_HASH);

        const newPkh = ethers.keccak256(ethers.toUtf8Bytes("different-key"));
        await expect(
          commitAndRegister(bob, TEST_DID, TEST_METADATA, newPkh)
        ).to.be.revertedWith("DID already registered");
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // SOULBOUND TRANSFER BLOCKING (H-1)
  // ═══════════════════════════════════════════════════════════════
  describe("Soulbound Enforcement (H-1)", function () {
    let tokenId: bigint;

    beforeEach(async function () {
      const result = await commitAndRegister(
        alice,
        TEST_DID,
        TEST_METADATA,
        TEST_PUBLIC_KEY_HASH
      );
      tokenId = result.tokenId;
    });

    it("should block transferFrom", async function () {
      await expect(
        contract.connect(alice).transferFrom(alice.address, bob.address, tokenId)
      ).to.be.revertedWith("Soulbound: identity NFTs are non-transferable");
    });

    it("should block safeTransferFrom", async function () {
      await expect(
        contract
          .connect(alice)
          ["safeTransferFrom(address,address,uint256)"](
            alice.address,
            bob.address,
            tokenId
          )
      ).to.be.revertedWith("Soulbound: identity NFTs are non-transferable");
    });

    it("should block safeTransferFrom with data", async function () {
      await expect(
        contract
          .connect(alice)
          ["safeTransferFrom(address,address,uint256,bytes)"](
            alice.address,
            bob.address,
            tokenId,
            "0x"
          )
      ).to.be.revertedWith("Soulbound: identity NFTs are non-transferable");
    });

    it("should block transfer to self", async function () {
      await expect(
        contract
          .connect(alice)
          .transferFrom(alice.address, alice.address, tokenId)
      ).to.be.revertedWith("Soulbound: identity NFTs are non-transferable");
    });

    it("should block approved operator transfer", async function () {
      await contract.connect(alice).approve(bob.address, tokenId);
      await expect(
        contract.connect(bob).transferFrom(alice.address, bob.address, tokenId)
      ).to.be.revertedWith("Soulbound: identity NFTs are non-transferable");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // MEMORY ANCHORING
  // ═══════════════════════════════════════════════════════════════
  describe("Memory Anchoring", function () {
    let tokenId: bigint;
    const testRoot = ethers.keccak256(ethers.toUtf8Bytes("merkle-root-1"));

    beforeEach(async function () {
      const result = await commitAndRegister(
        alice,
        TEST_DID,
        TEST_METADATA,
        TEST_PUBLIC_KEY_HASH
      );
      tokenId = result.tokenId;
    });

    describe("anchorMemory — happy path", function () {
      it("should update memoryRoot and count", async function () {
        await contract.connect(alice).anchorMemory(tokenId, testRoot, 42);

        const identity = await contract.identities(tokenId);
        expect(identity.memoryRoot).to.equal(testRoot);
        expect(identity.memoryCount).to.equal(42);
        expect(identity.lastAnchored).to.be.gt(0);
      });

      it("should emit MemoryAnchored event", async function () {
        await expect(
          contract.connect(alice).anchorMemory(tokenId, testRoot, 42)
        )
          .to.emit(contract, "MemoryAnchored")
          .withArgs(tokenId, testRoot, 42);
      });

      it("should allow updating to a higher count", async function () {
        await contract.connect(alice).anchorMemory(tokenId, testRoot, 10);

        const newRoot = ethers.keccak256(ethers.toUtf8Bytes("merkle-root-2"));
        await contract.connect(alice).anchorMemory(tokenId, newRoot, 20);

        const identity = await contract.identities(tokenId);
        expect(identity.memoryRoot).to.equal(newRoot);
        expect(identity.memoryCount).to.equal(20);
      });

      it("should allow same count (idempotent re-anchor)", async function () {
        await contract.connect(alice).anchorMemory(tokenId, testRoot, 10);

        const newRoot = ethers.keccak256(ethers.toUtf8Bytes("updated-root"));
        await contract.connect(alice).anchorMemory(tokenId, newRoot, 10);

        const identity = await contract.identities(tokenId);
        expect(identity.memoryRoot).to.equal(newRoot);
      });
    });

    describe("anchorMemory — access control", function () {
      it("should revert if not owner", async function () {
        await expect(
          contract.connect(bob).anchorMemory(tokenId, testRoot, 1)
        ).to.be.revertedWith("Not owner");
      });
    });

    describe("anchorMemory — monotonicity (M-9)", function () {
      it("should revert if count decreases", async function () {
        await contract.connect(alice).anchorMemory(tokenId, testRoot, 10);

        await expect(
          contract.connect(alice).anchorMemory(tokenId, testRoot, 9)
        ).to.be.revertedWith("Memory count cannot decrease");
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // METADATA UPDATE
  // ═══════════════════════════════════════════════════════════════
  describe("updateMetadata", function () {
    let tokenId: bigint;

    beforeEach(async function () {
      const result = await commitAndRegister(
        alice,
        TEST_DID,
        TEST_METADATA,
        TEST_PUBLIC_KEY_HASH
      );
      tokenId = result.tokenId;
    });

    it("should update metadataURI and emit event", async function () {
      const newURI = "ipfs://QmNewMetadata456";

      await expect(
        contract.connect(alice).updateMetadata(tokenId, newURI)
      )
        .to.emit(contract, "MetadataUpdated")
        .withArgs(tokenId, newURI);

      expect(await contract.tokenURI(tokenId)).to.equal(newURI);
    });

    it("should revert if not owner", async function () {
      await expect(
        contract.connect(bob).updateMetadata(tokenId, "ipfs://malicious")
      ).to.be.revertedWith("Not owner");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // QUERIES
  // ═══════════════════════════════════════════════════════════════
  describe("Queries", function () {
    let tokenId: bigint;

    beforeEach(async function () {
      const result = await commitAndRegister(
        alice,
        TEST_DID,
        TEST_METADATA,
        TEST_PUBLIC_KEY_HASH
      );
      tokenId = result.tokenId;
    });

    it("should resolve identity by DID", async function () {
      const identity = await contract.getIdentityByDID(TEST_DID);
      expect(identity.did).to.equal(TEST_DID);
      expect(identity.publicKeyHash).to.equal(TEST_PUBLIC_KEY_HASH);
    });

    it("should revert for unregistered DID", async function () {
      await expect(
        contract.getIdentityByDID("did:signet:nonexistent")
      ).to.be.revertedWith("DID not found");
    });

    it("should return correct tokenURI", async function () {
      expect(await contract.tokenURI(tokenId)).to.equal(TEST_METADATA);
    });

    it("should revert tokenURI for non-existent token", async function () {
      await expect(contract.tokenURI(999))
        .to.be.revertedWithCustomError(contract, "ERC721NonexistentToken");
    });
  });
});
```

### 3.2 Gas Reporting Configuration

```typescript
// hardhat.config.ts additions
import "hardhat-gas-reporter";

const config: HardhatUserConfig = {
  // ... existing config ...
  gasReporter: {
    enabled: true,
    currency: "USD",
    gasPrice: 0.006, // Base mainnet ~0.006 Gwei
    L2: "base",
    L1Etherscan: process.env.ETHERSCAN_API_KEY,
    coinmarketcap: process.env.COINMARKETCAP_API_KEY,
  },
};
```

---

## 4. Anchoring Pipeline Architecture

### 4.1 High-Level Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                     SIGNET DAEMON (Node.js)                       │
│                                                                   │
│  ┌─────────────┐    ┌──────────────┐    ┌──────────────────────┐ │
│  │ Memory Store │───▶│ Merkle Tree  │───▶│ Anchoring Scheduler  │ │
│  │  (SQLite)    │    │  Builder     │    │  (cron / event)      │ │
│  └─────────────┘    └──────────────┘    └──────────┬───────────┘ │
│                                                     │             │
│                                          ┌──────────▼───────────┐ │
│                                          │  Transaction Manager │ │
│                                          │  - nonce tracking    │ │
│                                          │  - gas estimation    │ │
│                                          │  - retry logic       │ │
│                                          │  - confirmation wait │ │
│                                          └──────────┬───────────┘ │
│                                                     │             │
│                                          ┌──────────▼───────────┐ │
│                                          │  DB Update           │ │
│                                          │  - anchor record     │ │
│                                          │  - tx hash           │ │
│                                          │  - confirmation      │ │
│                                          └──────────────────────┘ │
└───────────────────────────────┬──────────────────────────────────┘
                                │
                    ┌───────────▼───────────┐
                    │  Base Sepolia / Base   │
                    │  SignetIdentity.sol    │
                    │  anchorMemory(...)     │
                    └───────────────────────┘
```

### 4.2 Pipeline Stages

#### Stage 1: Trigger Detection

The anchoring worker runs on a configurable schedule. Triggers:

| Trigger | Description | Default |
|---|---|---|
| **Time-based** | Periodic anchoring every N minutes | Every 60 min |
| **Count-based** | After N new memories since last anchor | Every 50 memories |
| **Manual** | CLI command `signet chain anchor` | On demand |
| **Startup** | Anchor on daemon startup if stale | If > 24h since last |

Decision logic:

```typescript
function shouldAnchor(lastAnchor: AnchorState, currentCount: number): boolean {
  const now = Date.now();
  const timeSinceLastAnchor = now - lastAnchor.timestamp;
  const newMemories = currentCount - lastAnchor.memoryCount;

  return (
    newMemories > 0 && ( // Only anchor if there are actual changes
      timeSinceLastAnchor >= ANCHOR_INTERVAL_MS ||
      newMemories >= ANCHOR_BATCH_THRESHOLD ||
      lastAnchor.timestamp === 0 // First anchor ever
    )
  );
}
```

#### Stage 2: Merkle Root Computation

Uses the existing `packages/core/src/chain/merkle.ts`:

1. Query all non-deleted memories with content hashes, ordered by `created_at ASC`
2. Hash each `contentHash` through `keccak256("signet:memory:" + contentHash)` (domain separation)
3. Build binary Merkle tree with sorted-pair hashing for deterministic ordering
4. Output: `{ root: bytes32, count: uint64, leaves: string[] }`

**Critical invariant:** The ordering (`ORDER BY created_at ASC`) must be identical every time. The existing `getMemoryRoot(db)` function handles this correctly.

#### Stage 3: Transaction Submission

```
┌─────────────────────────────────────────────┐
│              Transaction Flow                │
│                                              │
│  1. Load wallet (decrypt from DB)            │
│  2. Check wallet balance (min 0.001 ETH)     │
│  3. Estimate gas for anchorMemory()          │
│  4. Set gas parameters:                      │
│     - maxFeePerGas = baseFee * 1.5           │
│     - maxPriorityFeePerGas = 0.001 gwei      │
│  5. Submit transaction                       │
│  6. Wait for receipt (timeout: 120s)         │
│  7. Verify receipt.status === 1              │
│  8. Parse MemoryAnchored event               │
└─────────────────────────────────────────────┘
```

#### Stage 4: Confirmation & DB Update

After a successful transaction:

1. Write `memory_anchors` record with: `{ onchainId, memoryRoot, memoryCount, txHash, anchoredAt }`
2. Update local state tracking: `lastAnchorTimestamp`, `lastAnchorCount`
3. Log the block explorer URL: `https://sepolia.basescan.org/tx/{hash}`

#### Stage 5: Error Handling & Retry

| Error Type | Strategy |
|---|---|
| Insufficient funds | Log warning, skip, alert via notification |
| Nonce too low | Re-fetch nonce, retry once |
| Transaction underpriced | Increase gas by 20%, retry |
| Transaction reverted | Log error with revert reason, investigate |
| RPC timeout | Exponential backoff (2s, 4s, 8s, max 60s), 3 retries |
| Network error | Fallback RPC URL if configured |

### 4.3 Batch Anchoring (Ceramic-Inspired)

For scale, a multi-agent deployment could batch multiple agents' roots:

```
Agent 1 root ──┐
Agent 2 root ──┤── Build super-tree ── Anchor single super-root on-chain
Agent 3 root ──┘                       (1 tx covers N agents)
```

**Current design:** Single-agent anchoring (1 tx per agent per anchor cycle). This is appropriate for the current Signet architecture where each agent manages its own identity. Multi-agent batching is a Phase 3+ optimization.

---

## 5. Daemon Anchoring Worker Code

### 5.1 Anchoring Worker

```typescript
// packages/core/src/chain/anchor-worker.ts

import { ethers } from "ethers";
import { getMemoryRoot } from "./merkle";
import { loadWallet, checkWalletFunds } from "./wallet";
import { getContract, getLocalIdentity, getLatestAnchor } from "./contract";
import type { ChainDb } from "./types";
import { CHAIN_CONFIGS, DEFAULT_CHAIN } from "./types";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AnchorWorkerConfig {
  /** Minimum interval between anchors in milliseconds */
  intervalMs: number;
  /** Minimum new memories before anchoring */
  batchThreshold: number;
  /** Chain to anchor on */
  chain: string;
  /** Minimum ETH balance required to attempt anchoring */
  minBalanceEth: string;
  /** Maximum retries for failed transactions */
  maxRetries: number;
  /** Whether to log verbose output */
  verbose: boolean;
}

const DEFAULT_CONFIG: AnchorWorkerConfig = {
  intervalMs: 60 * 60 * 1000, // 1 hour
  batchThreshold: 50,
  chain: DEFAULT_CHAIN,
  minBalanceEth: "0.001",
  maxRetries: 3,
  verbose: false,
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface AnchorState {
  lastAnchorTime: number;
  lastMemoryCount: number;
  lastRoot: string;
  consecutiveFailures: number;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export class AnchorWorker {
  private config: AnchorWorkerConfig;
  private db: ChainDb;
  private timer: ReturnType<typeof setInterval> | null = null;
  private state: AnchorState = {
    lastAnchorTime: 0,
    lastMemoryCount: 0,
    lastRoot: ethers.ZeroHash,
    consecutiveFailures: 0,
  };

  constructor(db: ChainDb, config: Partial<AnchorWorkerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.db = db;
    this.loadState();
  }

  /**
   * Load last anchor state from DB to resume after restart.
   */
  private loadState(): void {
    const identity = getLocalIdentity(this.db, this.config.chain);
    if (!identity) return;

    const latest = getLatestAnchor(this.db, identity.id);
    if (latest) {
      this.state.lastMemoryCount = latest.memoryCount;
      this.state.lastRoot = latest.memoryRoot;
      this.state.lastAnchorTime = latest.anchoredAt
        ? new Date(latest.anchoredAt).getTime()
        : 0;
    }
  }

  /**
   * Start the periodic anchoring worker.
   */
  start(): void {
    if (this.timer) {
      throw new Error("Anchor worker is already running");
    }

    this.log("Starting anchor worker", {
      interval: `${this.config.intervalMs / 1000}s`,
      chain: this.config.chain,
      threshold: this.config.batchThreshold,
    });

    // Run immediately on start, then periodically
    this.tick().catch((err) => this.log("Initial tick failed:", err));
    this.timer = setInterval(
      () => this.tick().catch((err) => this.log("Tick failed:", err)),
      this.config.intervalMs,
    );

    // Allow Node to exit even if timer is running
    if (this.timer && typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }

  /**
   * Stop the worker.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.log("Anchor worker stopped");
    }
  }

  /**
   * Single anchoring tick — check if anchoring is needed and execute.
   */
  async tick(): Promise<{ anchored: boolean; reason: string }> {
    try {
      // 1. Check if we have an on-chain identity
      const identity = getLocalIdentity(this.db, this.config.chain);
      if (!identity?.tokenId || !identity.contractAddress) {
        return { anchored: false, reason: "No on-chain identity registered" };
      }

      // 2. Compute current Merkle root
      const tree = getMemoryRoot(this.db);

      if (tree.count === 0) {
        return { anchored: false, reason: "No memories to anchor" };
      }

      // 3. Check if anchoring is needed
      const now = Date.now();
      const timeSinceAnchor = now - this.state.lastAnchorTime;
      const newMemories = tree.count - this.state.lastMemoryCount;

      // Skip if root hasn't changed
      if (tree.root === this.state.lastRoot && tree.count === this.state.lastMemoryCount) {
        return { anchored: false, reason: "Root unchanged since last anchor" };
      }

      // Skip if neither time nor count threshold met
      if (
        newMemories < this.config.batchThreshold &&
        timeSinceAnchor < this.config.intervalMs &&
        this.state.lastAnchorTime > 0
      ) {
        return {
          anchored: false,
          reason: `Thresholds not met (${newMemories} new memories, ${Math.round(timeSinceAnchor / 1000)}s elapsed)`,
        };
      }

      // 4. Check wallet balance
      const chainConfig = CHAIN_CONFIGS[this.config.chain];
      if (!chainConfig) {
        return { anchored: false, reason: `Unknown chain: ${this.config.chain}` };
      }

      const wallet = await loadWallet(this.db, this.config.chain, chainConfig.rpcUrl);
      const { balance, sufficient } = await checkWalletFunds(
        wallet.address,
        chainConfig.rpcUrl,
        this.config.minBalanceEth,
      );

      if (!sufficient) {
        this.log(`Insufficient balance: ${balance} ETH (need ${this.config.minBalanceEth})`);
        return {
          anchored: false,
          reason: `Insufficient balance: ${balance} ETH`,
        };
      }

      // 5. Submit transaction
      this.log(`Anchoring ${tree.count} memories (root: ${tree.root.slice(0, 18)}...)`);

      const contract = getContract(wallet, identity.contractAddress);

      // C-5: validate root is proper bytes32
      if (tree.root.length !== 66) {
        throw new Error(`Invalid root length: ${tree.root.length}`);
      }

      const tx = await contract.anchorMemory(
        BigInt(identity.tokenId),
        tree.root,
        tree.count,
      );

      this.log(`Transaction submitted: ${tx.hash}`);

      // 6. Wait for confirmation
      const receipt = await tx.wait(1); // Wait for 1 confirmation

      if (!receipt || receipt.status !== 1) {
        throw new Error(`Transaction reverted: ${tx.hash}`);
      }

      // 7. Update local DB
      const { randomBytes } = require("node:crypto");
      const anchorId = `anchor_${randomBytes(16).toString("hex")}`;
      const anchoredAt = new Date().toISOString();

      this.db.prepare(
        `INSERT INTO memory_anchors
         (id, onchain_id, memory_root, memory_count, tx_hash, anchored_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        anchorId,
        identity.id,
        tree.root,
        tree.count,
        tx.hash,
        anchoredAt,
        anchoredAt,
      );

      // 8. Update in-memory state
      this.state.lastAnchorTime = now;
      this.state.lastMemoryCount = tree.count;
      this.state.lastRoot = tree.root;
      this.state.consecutiveFailures = 0;

      const explorerUrl = chainConfig.explorerUrl
        ? `${chainConfig.explorerUrl}/tx/${tx.hash}`
        : tx.hash;

      this.log(`✓ Anchored successfully: ${explorerUrl}`);

      return { anchored: true, reason: `Anchored ${tree.count} memories` };
    } catch (err) {
      this.state.consecutiveFailures++;
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`✗ Anchor failed (attempt ${this.state.consecutiveFailures}): ${msg}`);

      // Back off on repeated failures
      if (this.state.consecutiveFailures >= this.config.maxRetries) {
        this.log(
          `Max retries reached (${this.config.maxRetries}). Will retry next cycle.`,
        );
      }

      return { anchored: false, reason: `Error: ${msg}` };
    }
  }

  /**
   * Force an immediate anchor, bypassing thresholds.
   */
  async forceAnchor(): Promise<{ anchored: boolean; reason: string }> {
    // Temporarily set thresholds to 0
    const origThreshold = this.config.batchThreshold;
    const origInterval = this.config.intervalMs;
    this.config.batchThreshold = 0;
    this.config.intervalMs = 0;
    this.state.lastAnchorTime = 0;

    try {
      return await this.tick();
    } finally {
      this.config.batchThreshold = origThreshold;
      this.config.intervalMs = origInterval;
    }
  }

  /**
   * Get the current worker status.
   */
  getStatus(): {
    running: boolean;
    lastAnchorTime: number;
    lastMemoryCount: number;
    lastRoot: string;
    consecutiveFailures: number;
  } {
    return {
      running: this.timer !== null,
      ...this.state,
    };
  }

  private log(message: string, data?: unknown): void {
    const prefix = `[anchor-worker]`;
    if (data) {
      console.log(`${prefix} ${message}`, data);
    } else {
      console.log(`${prefix} ${message}`);
    }
  }
}
```

### 5.2 CLI Integration

```typescript
// Integration with signet CLI — anchor subcommands

// signet chain anchor          → force immediate anchor
// signet chain anchor status   → show last anchor info
// signet chain anchor start    → start background worker
// signet chain anchor stop     → stop background worker

export async function handleAnchorCommand(
  db: ChainDb,
  subcommand: string,
): Promise<void> {
  const worker = new AnchorWorker(db);

  switch (subcommand) {
    case "now":
    case undefined: {
      const result = await worker.forceAnchor();
      console.log(result.anchored ? `✓ ${result.reason}` : `⊘ ${result.reason}`);
      break;
    }
    case "status": {
      const status = worker.getStatus();
      const identity = getLocalIdentity(db);
      const latest = identity ? getLatestAnchor(db, identity.id) : null;

      console.log("Anchor Status:");
      console.log(`  Chain:        ${DEFAULT_CHAIN}`);
      console.log(`  Token ID:     ${identity?.tokenId ?? "not registered"}`);
      console.log(`  Last root:    ${latest?.memoryRoot ?? "none"}`);
      console.log(`  Last count:   ${latest?.memoryCount ?? 0}`);
      console.log(`  Last tx:      ${latest?.txHash ?? "none"}`);
      console.log(`  Last anchor:  ${latest?.anchoredAt ?? "never"}`);
      break;
    }
  }
}
```

---

## 6. Gas Cost Analysis

### 6.1 Function-Level Gas Estimates

Gas estimates based on the contract's storage operations:

| Function | Gas (approx) | Storage Ops | Notes |
|---|---|---|---|
| `commitRegistration` | ~46,000 | 1 SSTORE (new slot) | Cold write to `commitTimestamps` |
| `register` | ~180,000–220,000 | 5+ SSTORE + 1 mint | Deletes commitment, mints NFT, writes identity struct, two mappings |
| `anchorMemory` | ~35,000–55,000 | 3 SSTORE (warm) | Updates `memoryRoot`, `memoryCount`, `lastAnchored` on existing struct |
| `updateMetadata` | ~30,000–45,000 | 1 SSTORE (warm) | Updates string in existing struct |
| `getIdentityByDID` | ~5,000 | 0 (view) | Two SLOADs |
| `tokenURI` | ~5,000 | 0 (view) | One SLOAD |

### 6.2 Cost Comparison: Base Sepolia vs Base Mainnet

| Parameter | Base Sepolia | Base Mainnet |
|---|---|---|
| **L2 gas price** | ~0.001 Gwei (free testnet) | ~0.005–0.01 Gwei |
| **L1 data fee** | Free (testnet) | ~$0.001–0.01 per tx (post-EIP-4844 blobs) |
| **ETH cost** | Free (faucet) | Real ETH |
| **`anchorMemory` cost** | ~$0.00 | ~$0.001–0.005 |
| **`register` cost** | ~$0.00 | ~$0.003–0.015 |
| **Monthly anchor cost (hourly)** | ~$0.00 | ~$0.72–3.60 (730 txs) |
| **Monthly anchor cost (daily)** | ~$0.00 | ~$0.03–0.15 (30 txs) |

### 6.3 Cost Breakdown for `anchorMemory`

On Base mainnet (post-EIP-4844):

```
L2 execution gas:  ~45,000 gas × 0.006 Gwei = 0.00000027 ETH
L1 data fee:       ~200 bytes × blob pricing  ≈ 0.0000001 ETH
Total per anchor:  ~0.0000004 ETH ≈ $0.001 at $2500 ETH
```

**Key insight:** Base L2 is extremely cheap. The dominant cost is L1 data availability, which EIP-4844 blob pricing made ~100x cheaper than pre-Dencun calldata.

### 6.4 Anchoring Frequency vs Cost

| Frequency | Monthly Txs | Monthly Cost (Base) | Use Case |
|---|---|---|---|
| Every 10 min | 4,380 | ~$4.38 | High-frequency agent with real-time provenance |
| Every 1 hour | 730 | ~$0.73 | Default — good latency-cost balance |
| Every 6 hours | 120 | ~$0.12 | Low-activity agent |
| Every 24 hours | 30 | ~$0.03 | Minimal anchor — daily digest |
| On-demand only | Variable | Variable | Manual CLI trigger |

**Recommendation:** Default to **hourly anchoring** with a 50-memory batch threshold. Cost is negligible on Base (~$0.73/month), and hourly granularity provides meaningful provenance guarantees.

### 6.5 Optimization Strategies

1. **Skip unchanged roots:** Don't anchor if root hasn't changed (already implemented in worker)
2. **Batch threshold:** Wait for N new memories before anchoring (reduces empty anchors)
3. **Gas price awareness:** Check `baseFee` before submitting, wait if unusually high
4. **EIP-1559 tuning:** Use low `maxPriorityFeePerGas` on Base (validators aren't competitive)
5. **Future: multi-agent batching** — build a super-tree of multiple agents' roots into one tx

---

## 7. Wallet Management Strategy

### 7.1 Options Analysis

#### Option A: DID Key (Ed25519) — NOT VIABLE for Ethereum

| Aspect | Assessment |
|---|---|
| **Curve** | Ed25519 (not natively supported on EVM) |
| **Signing** | Cannot sign Ethereum transactions |
| **Address derivation** | No standard Ed25519 → Ethereum address mapping |
| **Verdict** | ❌ Cannot use directly for on-chain transactions |

The Signet DID key is Ed25519 (used for signing memories, Noise protocol, etc.). Ethereum uses secp256k1. These are fundamentally different curves. You cannot derive a valid Ethereum private key from an Ed25519 key.

#### Option B: Separate Ethereum Wallet (Current Implementation) ✅

| Aspect | Assessment |
|---|---|
| **Key type** | secp256k1 (native Ethereum) |
| **Storage** | Encrypted at rest with XSalsa20-Poly1305 under master key |
| **Master key** | Same derivation as DID key (passphrase + machine ID) |
| **Pros** | Clean separation, standard tooling, key rotation possible |
| **Cons** | Two keys to manage, wallet needs funding |
| **Verdict** | ✅ Current approach — correct and well-implemented |

#### Option C: Deterministic Derivation (DID seed → Ethereum key)

| Aspect | Assessment |
|---|---|
| **Method** | `HKDF(didSeed, "signet:ethereum:secp256k1")` → secp256k1 private key |
| **Pros** | One seed backs up everything, no separate wallet creation |
| **Cons** | Couples DID rotation to wallet rotation, harder to fund selectively |
| **Risk** | If DID seed is compromised, attacker gets wallet too |
| **Verdict** | ⚠️ Viable but adds coupling — not recommended unless backup simplicity is paramount |

### 7.2 Recommendation: Keep Separate Wallet (Option B)

The current implementation in `packages/core/src/chain/wallet.ts` is well-designed:

1. **Separate secp256k1 wallet** generated at `signet chain wallet create`
2. **Encrypted at rest** using the same master key derivation as the DID keypair
3. **Decrypted on demand** for transaction signing, then zeroed (as much as JS allows)
4. **Balance checking** before transactions to prevent failed txs

**Additional recommendations:**

- **Session keys for automated anchoring:** Use the existing `session-keys.ts` with a scoped session key that can only call `anchorMemory()` on the specific contract. This limits blast radius if the session key is compromised:

```typescript
const sessionKey = await createSessionKey(db, walletAddress, {
  maxTransactionValue: "0",          // No ETH transfers
  allowedContracts: [contractAddr],  // Only SignetIdentity
  allowedFunctions: ["0x..."],       // Only anchorMemory selector
  maxDailyTransactions: 24,          // Max 1/hour
  maxDailySpend: "0",               // No spending
}, 720);                             // 30 day expiry
```

- **Hot wallet pattern:** Keep minimal ETH in the anchoring wallet (~0.01 ETH). Refill from a more secure wallet when balance drops below threshold.

---

## 8. ERC-8004 Alignment Analysis

### 8.1 What is ERC-8004?

ERC-8004 ("Trustless Agents") is a **Draft** EIP (authored by MetaMask, Ethereum Foundation, Google, and Coinbase engineers) that defines three on-chain registries for AI agent identity:

1. **Identity Registry** — ERC-721 with URIStorage, agents discoverable by `tokenId` + `agentURI`
2. **Reputation Registry** — Feedback signals (on-chain + off-chain scoring)
3. **Validation Registry** — Hooks for independent verification (zkML, TEE, stakers)

### 8.2 SignetIdentity vs ERC-8004 Identity Registry

| Feature | SignetIdentity | ERC-8004 Identity Registry |
|---|---|---|
| **Base** | ERC-721 | ERC-721 + URIStorage |
| **Transferable** | ❌ Soulbound | ✅ Transferable (ownership transfer) |
| **Registration** | Commit-reveal with DID + publicKeyHash | Simple `register(agentURI)` (no commit-reveal) |
| **DID storage** | On-chain (string in struct) | Off-chain (in registration file JSON) |
| **Public key** | On-chain (bytes32 hash) | Off-chain (registration file) |
| **Metadata** | `metadataURI` (IPFS/HTTP) | `agentURI` → registration file (JSON) |
| **Memory anchoring** | ✅ Built-in `anchorMemory()` | ❌ Not in spec |
| **Agent wallet** | Separate concept (wallet.ts) | Built-in `setAgentWallet()` with EIP-712 verification |
| **Generic metadata** | ❌ Fixed struct | ✅ `getMetadata()/setMetadata()` key-value |
| **Multi-chain** | Base-focused | Deployed on 10+ chains |

### 8.3 Key Differences & Migration Path

**SignetIdentity extends beyond ERC-8004** with:
- Soulbound enforcement (appropriate for agent identity — agents shouldn't be "transferred")
- Commit-reveal anti-front-running (ERC-8004 has none)
- On-chain memory anchoring (unique to Signet)
- On-chain public key hash storage (for off-chain verification)

**ERC-8004 has features Signet lacks:**
- Generic metadata key-value store
- Registration file standard (JSON schema for A2A, MCP, DID endpoints)
- Reputation + Validation registries
- Agent wallet verification via EIP-712

**Recommendation for alignment:**

1. **Short-term:** Keep `SignetIdentity` as-is. It's purpose-built for Signet's memory provenance use case.
2. **Medium-term:** Register with the ERC-8004 Identity Registry as well (dual registration). Use `services.DID` in the registration file to point to the Signet DID, and add a custom `services.Signet` endpoint.
3. **Long-term:** Consider implementing the ERC-8004 Reputation Registry for cross-agent trust signals. Signet's memory proofs could become a powerful reputation signal.

### 8.4 Dual Registration Example

```json
{
  "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  "name": "Signet Agent: claude-alpha",
  "description": "Signet AI agent with on-chain memory provenance",
  "image": "ipfs://QmSignetAgentAvatar",
  "services": [
    {
      "name": "DID",
      "endpoint": "did:signet:base-sepolia:0x1234...abcd",
      "version": "v1"
    },
    {
      "name": "Signet",
      "endpoint": "https://agent.example.com/.well-known/signet-identity.json",
      "version": "0.1.0"
    },
    {
      "name": "A2A",
      "endpoint": "https://agent.example.com/.well-known/agent-card.json",
      "version": "0.3.0"
    }
  ],
  "active": true,
  "registrations": [
    {
      "agentId": 42,
      "agentRegistry": "eip155:84532:0x8004A818BFB912233c491871b3d84c89A494BD9e"
    }
  ],
  "supportedTrust": ["reputation"]
}
```

---

## 9. Recommendations

### 9.1 Immediate Actions (Phase 1)

1. **Write the Hardhat tests** using the spec in Section 2 and code in Section 3. The test file should be at `packages/contracts/test/SignetIdentity.test.ts`.

2. **Add `hardhat-gas-reporter`** to the dev dependencies for gas profiling:
   ```bash
   cd packages/contracts && npm install --save-dev hardhat-gas-reporter
   ```

3. **Implement the `AnchorWorker`** class (Section 5.1) in `packages/core/src/chain/anchor-worker.ts`.

4. **Add `typechain-types`** generation to the Hardhat build for proper TypeScript contract typing:
   ```bash
   npx hardhat compile  # generates typechain-types/
   ```

### 9.2 Near-Term Improvements (Phase 2)

5. **Session key for anchoring:** Create a scoped session key that only has permission to call `anchorMemory()`. This reduces risk from automated key usage.

6. **Event indexing:** Add a listener for `MemoryAnchored` events to detect if someone else (attacker) anchors to your token. The `ownerOf` check prevents this, but monitoring is good practice.

7. **Gas price monitoring:** Before submitting, check if L2 gas price is abnormally high and delay if so.

8. **Commitment deletion attack surface:** Note that `commitTimestamps` mapping allows anyone to `commitRegistration` with any hash. An attacker could front-run by committing the same hash, but since the hash includes `msg.sender`, the attacker's commitment would be a different hash. This is safe as designed.

### 9.3 Future Considerations (Phase 3+)

9. **On-chain Merkle proof verification:** Add a `verifyMemoryProof()` function to the contract. The merkle.ts already uses sorted-pair hashing which is verification-friendly. This enables third parties to verify memory inclusion on-chain.

10. **ERC-8004 dual registration:** Register Signet agents on the official ERC-8004 Identity Registry for cross-ecosystem discoverability.

11. **Anchoring cost subsidization:** For multi-agent deployments, a paymaster or relayer could subsidize anchoring gas costs.

12. **Burn/revoke mechanism:** Currently, soulbound tokens cannot be burned. Consider adding an `onlyOwner` burn function for agent decommissioning.

---

## Appendix A: Contract Storage Layout

```
Slot 0: _name (string)
Slot 1: _symbol (string)
Slot 2: _owners (mapping)
Slot 3: _balances (mapping)
Slot 4: _tokenApprovals (mapping)
Slot 5: _operatorApprovals (mapping)
Slot 6: _owner (Ownable)
Slot 7: identities (mapping)
Slot 8: didToTokenId (mapping)
Slot 9: publicKeyRegistered (mapping)
Slot 10: commitTimestamps (mapping)
Slot 11: _nextTokenId
```

## Appendix B: Reference Projects

| Project | Anchoring Pattern | Key Learning |
|---|---|---|
| **Ceramic (CAS)** | Batch Merkle tree of stream commits → single Ethereum tx | Multi-stream batching into one root reduces cost by N× |
| **EAS** | Merkle root of private attestation data → on-chain schema | Selective disclosure via Merkle proofs from anchored root |
| **Hyperlane** | Merkle tree of cross-chain messages → validator consensus | ISM (Interchain Security Module) pattern for pluggable verification |
| **ERC-8004** | No anchoring — discovery + reputation registries | Registration file standard, agent wallet verification via EIP-712 |

## Appendix C: Test Running Commands

```bash
# Run all tests
cd packages/contracts
npx hardhat test

# Run with gas reporting
REPORT_GAS=true npx hardhat test

# Run specific test file
npx hardhat test test/SignetIdentity.test.ts

# Run on local Hardhat network with verbose logging
npx hardhat test --verbose

# Compile and generate types
npx hardhat compile
```
