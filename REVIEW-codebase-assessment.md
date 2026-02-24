# Signet Web3 — Honest Codebase Assessment

**Date:** 2026-02-23  
**Reviewer:** Buba (unbiased mode)  
**Scope:** Full codebase (74K LOC TypeScript, 129 LOC Solidity, 14 packages)

---

## The Good — What's Actually Strong

### 1. Core Architecture Is Sound
The local-first daemon + CLI + SDK split is exactly right for this kind of project. The daemon owns the database, serves the API, runs the pipeline. The CLI is a thin client. The SDK is a zero-dependency HTTP client. Clean separation of concerns.

### 2. Memory Pipeline Is Surprisingly Deep
This isn't a toy. The pipeline has:
- LLM-based fact extraction from raw text
- BM25 + vector hybrid search with configurable alpha blending
- Graph-augmented retrieval (knowledge graph on top of memories)
- Temporal decay (Ebbinghaus strength model)
- Reranking (embedding-based and LLM-based)
- Document ingestion with chunking strategies
- Contradiction detection and decision tracking
- Automated maintenance workers (retention, summary, repair)

Most agent memory systems are just "save text, vector search it." This is leagues ahead.

### 3. Crypto Layer Is Now Solid
After 13 rounds of hardening:
- Argon2id key derivation with random salt (not guessable)
- Ed25519 signing with DID:key identity
- BLAKE2b Merkle trees with domain separation
- Memory-bound signature payloads (v2 format)
- Constant-time comparison where it matters
- File-based local auth token
- 5-minute key cache TTL

This is production-grade crypto for an agent project. Most competitors don't even attempt signing.

### 4. Connector Pattern Is Smart
The `connector-base` → `connector-claude-code` / `connector-openclaw` / `connector-opencode` pattern means signet works across harnesses. Agent identity is portable. This is the core value prop and it's well-designed.

### 5. Test Coverage Where It Matters
404 passing tests across 26 files. Heavy coverage on:
- Pipeline workers (1345 lines of tests)
- Hooks (1084 lines)
- Auth (643 lines)
- Transactions (665 lines)
- Mutations, repair actions, analytics, migrations

### 6. Smart Contract Is Clean
129-line SignetIdentity.sol is focused:
- Soulbound ERC-721 (non-transferable)
- Commit-reveal registration (anti-front-running)
- Memory root anchoring
- No unnecessary complexity

---

## The Bad — What Needs Work

### 1. daemon.ts Is a God File (7,142 Lines)
This is the single biggest code quality problem. One file handles:
- HTTP server setup (~200 routes)
- Memory CRUD operations
- Search/recall endpoints
- Document management
- Analytics
- Git sync
- Pipeline orchestration
- Session tracking
- Update system
- File watching
- Config management

**Impact:** Impossible to navigate. Changes in one area risk breaking others. New contributors will bounce off this wall.

**Fix:** Split into route modules: `routes/memory.ts`, `routes/documents.ts`, `routes/analytics.ts`, `routes/config.ts`, `routes/search.ts`, etc. The Hono framework supports `app.route()` for this.

### 2. CLI Is Also a God File (8,377 Lines)
Same problem. One massive `cli.ts` with every command. Should be split into command modules.

### 3. No Integration Tests for the Crypto ↔ Daemon ↔ CLI Chain
We have unit tests for individual modules but NO end-to-end test that:
1. Generates a keypair via CLI
2. Starts the daemon
3. Stores a memory via API
4. Verifies the signature is present and valid
5. Builds a Merkle tree and verifies a proof
6. Anchors to the contract

This is the ENTIRE value proposition of the web3 branch and it has zero integration testing.

### 4. Smart Contract Has No Tests
`packages/contracts/` has `src/SignetIdentity.sol` but NO test files. A contract that manages identity NFTs and memory anchoring MUST have tests for:
- Commit-reveal flow
- Soulbound transfer blocking
- Memory anchoring with monotonic count enforcement
- Edge cases (expired commits, duplicate DIDs, etc.)

### 5. The Bridge Between Daemon and Contract Doesn't Exist
There's no code that actually:
- Calls the smart contract from the daemon
- Anchors Merkle roots on-chain
- Reads on-chain state
- Manages gas/nonces

The `anchorMemory` Solidity function exists but nothing calls it. This is the "web3" in "signet-web3" and it's completely unwired.

### 6. No Key Rotation Ceremony
`reEncryptKeypair()` exists for upgrading v1→v2 encryption, but there's no proper key rotation flow:
- Generate new keypair
- Re-sign existing memories with new key
- Update DID in agent.yaml
- Publish rotation to any on-chain registry
- Revoke old DID

If a key is compromised, there's no recovery path beyond "delete everything and start over."

### 7. Vector Search Is Fragile
The vec0 SQLite extension loading has known issues (mentioned in the code). The fallback chain is `native → worker → none`, but when it falls to `none`, search degrades silently to BM25-only with no warning to the user.

### 8. 5 Failing Tests
```
(fail) loadMemoryConfig > prefers agent.yaml embedding settings
(fail) migration framework > fresh DB gets all migrations applied (×3 variants)
```
These are likely from recent migration additions that didn't update test fixtures. They should be green.

---

## The Missing — What Doesn't Exist Yet

### 1. On-Chain Anchoring Pipeline
The entire point of the `web3-identity` branch. Need:
- `packages/daemon/src/anchoring.ts` — Periodic job that computes Merkle root of recent memories and submits to Base Sepolia
- Gas estimation, retry logic, nonce management
- CLI command: `signet anchor --dry-run`
- Config in agent.yaml: `anchoring: { enabled, interval, chain, rpc }`

### 2. Wallet Integration
No wallet management at all:
- No private key for transaction signing (separate from DID signing key!)
- No ETH balance checking
- No gas funding flow
- Decision: use the DID signing key for chain transactions too? Or separate wallet?

### 3. Verification Endpoint
No way for a third party to verify an agent's identity on-chain:
- `GET /api/verify/:did` — Check if DID is registered on-chain
- `GET /api/verify/:did/memory/:hash` — Verify a memory's Merkle inclusion
- Smart contract read integration

### 4. DID Resolution
`did:key` is self-certifying (no resolution needed), but if you want interop:
- DID Document hosting (currently written to `did.json` but not served)
- Resolution endpoint: `GET /.well-known/did.json`
- Optional DID:web support for human-readable identities

### 5. Federation Protocol
Nicholai's been discussing this. Agents need to:
- Discover other agents
- Verify their identities
- Exchange signed memories
- Build trust graphs

Zero code for this exists.

### 6. Dashboard Doesn't Show Web3 State
The web dashboard (CLI-hosted) presumably shows memory stats but has no:
- DID identity card
- Signing status
- Merkle tree visualization
- On-chain anchor status
- Key health indicators

### 7. Migration CLI for Existing Users
Existing Signet users on the `main` branch need a smooth upgrade path:
- `signet upgrade` — Run migration 012+ for signing columns
- `signet did init` — Generate keypair and DID
- `signet memory sign-backfill` — Sign existing memories
- `signet reencrypt` — Upgrade v1 → v2 key encryption

The commands exist individually but there's no guided flow.

### 8. Rate Limiting / Abuse Protection for Team Mode
The `auth: team` mode has JWT tokens but no per-token rate limiting. A compromised token could flood the API.

---

## Priority Recommendations

### Before PR (Must-Have)
1. **Fix the 5 failing tests** — Never merge with red tests
2. **Add one integration test** for the full sign → verify → Merkle proof chain
3. **Add basic contract tests** — At least happy-path for register + anchor
4. **Split daemon.ts** into route modules (or at minimum, extract the largest sections)

### Before Alpha Release
5. **Wire up on-chain anchoring** — This is the feature
6. **Build the verification endpoint** — So others can verify
7. **Add key rotation ceremony** — Security requirement
8. **Fix vector search resilience** — Warn users when degraded

### Before Production
9. **Federation protocol** — Agent-to-agent identity verification
10. **Dashboard web3 integration** — Visual identity management
11. **Wallet integration decision** — Same key or separate?
12. **Guided upgrade flow** — For existing Signet users

---

## Overall Verdict

**Signet is a genuinely impressive agent infrastructure project.** The memory pipeline alone is more sophisticated than most commercial offerings. The crypto layer (after hardening) is solid. The architecture is clean.

**But the "web3" part is 90% plumbing, 10% wired.** The Ed25519 identity and Merkle trees are built. The smart contract exists. But nothing connects them. The daemon can't talk to the chain. There's no anchoring pipeline. There's no verification flow. The "soulbound agent identity NFT" is a Solidity file that's never been deployed or tested.

**The code quality split is stark:** daemon.ts and cli.ts are maintenance nightmares at 7K and 8K lines respectively, while the crypto, search, and pipeline modules are clean and well-structured. The contrast suggests rapid feature development without refactoring pauses.

**For a PR:** The security hardening is merge-ready. The crypto primitives are merge-ready. The god files need splitting, the tests need fixing, and the on-chain integration needs at least a basic working path before the `web3-identity` branch delivers on its name.

---

*This assessment is intentionally harsh. The project is strong — it just needs the hard parts finished, not more plumbing.*
