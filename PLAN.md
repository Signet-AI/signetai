# Signet Web3 Fork — Implementation Plan

## Codebase Map

```
packages/
├── core/           # Shared types, migrations, identity files, manifest
│   └── src/
│       ├── types.ts        # Memory, Entity, Relation, etc.
│       ├── database.ts     # SQLite wrapper (bun:sqlite / better-sqlite3)
│       ├── identity.ts     # Identity file loading (AGENTS.md, etc.)
│       ├── manifest.ts     # agent.yaml parsing
│       ├── constants.ts    # Paths, versions
│       ├── search.ts       # Search logic
│       └── migrations/     # DB migrations (001-011)
├── daemon/         # Background daemon (HTTP API, pipeline, memory ops)
│   └── src/
│       ├── daemon.ts       # HTTP server setup
│       ├── db-accessor.ts  # Singleton DB connection manager
│       ├── transactions.ts # Atomic memory write operations
│       ├── secrets.ts      # libsodium encrypted secrets (XSalsa20-Poly1305)
│       ├── pipeline/       # Memory extraction, decisions, graph, workers
│       └── hooks.ts        # Session lifecycle hooks
├── cli/            # CLI commands (commander.js, ~5300 lines)
│   └── src/cli.ts
├── sdk/            # TypeScript SDK for external consumers
├── signetai/       # Published npm package (bundles cli + daemon)
└── connector-*/    # Harness connectors (Claude Code, OpenCode, OpenClaw)
```

## Key Findings
- libsodium already bundled (secrets.ts uses XSalsa20-Poly1305)
- Ed25519 available via libsodium but NOT used for identity yet (only for secrets encryption via BLAKE2b KDF)
- No keypair generation exists — secrets use machine-derived symmetric key
- Migration system is clean (versioned, transactional, IF NOT EXISTS)
- Memory table has: id, content, contentHash, type, importance, tags, who, why, project
- Memory table does NOT have: signature, signerDid, merkleIndex
- agent.yaml has optional `trust` and `owner` fields (skeleton, not implemented)
- The `trust.verification` field already accepts "did" as a value

## What We're Building (Phase 0)

### 1. Ed25519 Keypair Generation
**File:** `packages/core/src/crypto.ts` (NEW)

- Generate Ed25519 signing keypair via libsodium
- Store encrypted in `~/.agents/.keys/signing.enc` (use existing secrets encryption)
- Derive DID from public key: `did:key:z6Mk...` (multicodec ed25519-pub + multibase base58btc)
- Export functions: `generateKeypair()`, `loadKeypair()`, `getPublicKey()`, `sign()`, `verify()`

### 2. DID Generation
**File:** `packages/core/src/did.ts` (NEW)

- Convert Ed25519 public key → did:key format
- Generate DID Document (JSON-LD)
- Store DID in agent.yaml under new `did` field
- CLI: `signet did show`, `signet did document`

### 3. Memory Signing
**File:** Modify `packages/daemon/src/transactions.ts`
**Migration:** `packages/core/src/migrations/012-memory-signing.ts` (NEW)

- Add columns to memories table: `signature TEXT`, `signer_did TEXT`
- On every memory write (ingestMemoryTx), sign `contentHash + createdAt + signerDid` with Ed25519
- Backfill command: `signet memory sign --backfill`
- Verify command: `signet memory verify [--id <id>]`

### 4. Merkle Tree
**File:** `packages/core/src/merkle.ts` (NEW)

- Build Merkle tree from all memory contentHashes
- Compute root hash
- Generate inclusion proofs for individual memories
- Store roots in `merkle_roots` table (migration 012)
- CLI: `signet memory merkle` shows current root

### 5. CLI Commands
**File:** Modify `packages/cli/src/cli.ts`

- `signet did show` — display agent DID
- `signet did document` — export DID Document
- `signet memory sign --backfill` — sign unsigned memories
- `signet memory verify [--id <id>]` — verify memory signatures
- `signet memory merkle` — compute and display Merkle root
- `signet knowledge status` — knowledge health dashboard

### 6. Config Updates
**File:** Modify `packages/core/src/types.ts`

- Add `did` field to AgentManifest
- Add `signing` to agent.yaml schema
- Update `trust` field to include DID-based verification

## Migration 012 Schema

```sql
-- Add signing columns to memories
ALTER TABLE memories ADD COLUMN signature TEXT;
ALTER TABLE memories ADD COLUMN signer_did TEXT;

-- Merkle root tracking
CREATE TABLE IF NOT EXISTS merkle_roots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root_hash TEXT NOT NULL,
  memory_count INTEGER NOT NULL,
  computed_at TEXT NOT NULL,
  anchor_chain TEXT,
  anchor_tx TEXT,
  anchor_block INTEGER
);

-- Index for efficient signature verification
CREATE INDEX IF NOT EXISTS idx_memories_signature ON memories(signature);
CREATE INDEX IF NOT EXISTS idx_memories_signer_did ON memories(signer_did);
```

## Build Order

1. `packages/core/src/crypto.ts` — Keypair generation + signing
2. `packages/core/src/did.ts` — DID generation from Ed25519
3. `packages/core/src/merkle.ts` — Merkle tree operations
4. `packages/core/src/migrations/012-memory-signing.ts` — Schema migration
5. Update `packages/core/src/types.ts` — Add DID/signing types
6. Update `packages/core/src/constants.ts` — Add key paths
7. Update `packages/daemon/src/transactions.ts` — Sign on write
8. Update `packages/daemon/src/daemon.ts` — DID API routes
9. Update `packages/cli/src/cli.ts` — New commands
10. Update `packages/core/src/manifest.ts` — DID in agent.yaml
11. Tests for crypto, DID, merkle, signing

## Safety Checklist
- [ ] Never modify existing migration files (append-only)
- [ ] All new columns use ALTER TABLE ADD COLUMN (not recreate)
- [ ] Signing is opt-in for existing memories (backfill command)
- [ ] New memories auto-sign only if keypair exists
- [ ] No breaking changes to existing CLI commands
- [ ] No breaking changes to daemon API
- [ ] No breaking changes to agent.yaml format (new fields are optional)
- [ ] libsodium already a dependency — no new deps needed for crypto
- [ ] Existing tests must still pass
