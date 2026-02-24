/**
 * @module chain/merkle
 * @description Memory Merkle tree operations for on-chain anchoring.
 *
 * Uses keccak256 (via ethers.js) for Ethereum-compatible Merkle roots,
 * distinct from the BLAKE2b Merkle tree in core/merkle.ts which is used
 * for local provenance verification.
 *
 * Why keccak256? The on-chain contract uses Solidity's bytes32 type and
 * the EVM's native keccak256. Using the same hash function on both sides
 * enables future on-chain proof verification (e.g., a verifyProof() Solidity function).
 */

import { ethers } from "ethers";
import type { ChainDb } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryLeaf {
	/** Memory ID */
	id: string;
	/** Content hash (SHA-256 hex from the memories table) */
	contentHash: string;
}

export interface ChainMerkleTree {
	/** Leaf hashes in order (keccak256 of content hashes) */
	leaves: string[];
	/** The Merkle root (keccak256-based) */
	root: string;
	/** Total leaf count */
	count: number;
}

export interface ChainMerkleProof {
	/** The leaf being proved */
	leafHash: string;
	/** Index of the leaf */
	leafIndex: number;
	/** Sibling hashes with position info */
	siblings: Array<{ hash: string; position: "left" | "right" }>;
	/** The root hash */
	root: string;
}

// ---------------------------------------------------------------------------
// Core Hashing
// ---------------------------------------------------------------------------

/**
 * Hash a memory's content hash into a Merkle leaf using keccak256.
 * Applies a domain separator to prevent cross-protocol collisions.
 */
function hashLeaf(contentHash: string): string {
	// Domain-separated: keccak256("signet:memory:" + contentHash)
	return ethers.keccak256(
		ethers.toUtf8Bytes(`signet:memory:${contentHash}`),
	);
}

/**
 * Hash two nodes together for Merkle tree construction.
 * Sorts the pair to ensure consistent ordering regardless of position.
 * This makes proof verification simpler (no left/right tracking needed on-chain).
 */
function hashPair(a: string, b: string): string {
	// Sort to ensure deterministic ordering
	const [left, right] = a < b ? [a, b] : [b, a];
	return ethers.keccak256(
		ethers.concat([
			ethers.getBytes(left),
			ethers.getBytes(right),
		]),
	);
}

// ---------------------------------------------------------------------------
// Tree Construction
// ---------------------------------------------------------------------------

/**
 * Build a keccak256-based Merkle tree from memory content hashes.
 *
 * @param memories - Array of {id, contentHash} objects
 * @returns ChainMerkleTree with root, leaves, and count
 */
export function buildMemoryMerkleTree(
	memories: MemoryLeaf[],
): ChainMerkleTree {
	if (memories.length === 0) {
		return {
			leaves: [],
			root: ethers.ZeroHash,
			count: 0,
		};
	}

	// Hash each content hash into a leaf
	const leaves = memories.map((m) => hashLeaf(m.contentHash));

	if (leaves.length === 1) {
		return {
			leaves,
			root: leaves[0],
			count: 1,
		};
	}

	// Build tree bottom-up
	let currentLayer = [...leaves];
	while (currentLayer.length > 1) {
		const nextLayer: string[] = [];
		for (let i = 0; i < currentLayer.length; i += 2) {
			if (i + 1 < currentLayer.length) {
				nextLayer.push(hashPair(currentLayer[i], currentLayer[i + 1]));
			} else {
				// Odd node: promote directly
				nextLayer.push(currentLayer[i]);
			}
		}
		currentLayer = nextLayer;
	}

	return {
		leaves,
		root: currentLayer[0],
		count: memories.length,
	};
}

// ---------------------------------------------------------------------------
// Database Operations
// ---------------------------------------------------------------------------

/**
 * Compute the current memory Merkle root from all signed memories in the DB.
 *
 * Only includes memories that have a content_hash and are not deleted.
 * Ordered by created_at for deterministic root computation.
 *
 * @param db - Database instance
 * @returns ChainMerkleTree with root and count
 */
export function getMemoryRoot(db: ChainDb): ChainMerkleTree {
	const rows = db
		.prepare(
			`SELECT id, content_hash FROM memories
			 WHERE content_hash IS NOT NULL AND is_deleted = 0
			 ORDER BY created_at ASC`,
		)
		.all() as Array<{ id: string; content_hash: string }>;

	const memories: MemoryLeaf[] = rows.map((r) => ({
		id: r.id,
		contentHash: r.content_hash,
	}));

	return buildMemoryMerkleTree(memories);
}

/**
 * Generate a Merkle inclusion proof for a specific memory.
 *
 * @param db - Database instance
 * @param memoryId - The memory ID to generate a proof for
 * @returns ChainMerkleProof or null if memory not found
 */
export function generateMemoryProof(
	db: ChainDb,
	memoryId: string,
): ChainMerkleProof | null {
	// Get all memories in deterministic order
	const rows = db
		.prepare(
			`SELECT id, content_hash FROM memories
			 WHERE content_hash IS NOT NULL AND is_deleted = 0
			 ORDER BY created_at ASC`,
		)
		.all() as Array<{ id: string; content_hash: string }>;

	const memories: MemoryLeaf[] = rows.map((r) => ({
		id: r.id,
		contentHash: r.content_hash,
	}));

	// Find the target memory's index
	const leafIndex = memories.findIndex((m) => m.id === memoryId);
	if (leafIndex === -1) return null;

	if (memories.length === 0) return null;

	// Hash all leaves
	const leaves = memories.map((m) => hashLeaf(m.contentHash));
	const targetLeaf = leaves[leafIndex];

	if (memories.length === 1) {
		return {
			leafHash: targetLeaf,
			leafIndex: 0,
			siblings: [],
			root: targetLeaf,
		};
	}

	// Build tree and collect proof path
	const siblings: Array<{ hash: string; position: "left" | "right" }> = [];
	let currentLayer = [...leaves];
	let idx = leafIndex;

	while (currentLayer.length > 1) {
		const nextLayer: string[] = [];
		for (let i = 0; i < currentLayer.length; i += 2) {
			if (i + 1 < currentLayer.length) {
				nextLayer.push(hashPair(currentLayer[i], currentLayer[i + 1]));
			} else {
				nextLayer.push(currentLayer[i]);
			}
		}

		// Record sibling if we have one at this level
		const isLeft = idx % 2 === 0;
		const siblingIdx = isLeft ? idx + 1 : idx - 1;
		if (siblingIdx < currentLayer.length) {
			siblings.push({
				hash: currentLayer[siblingIdx],
				position: isLeft ? "right" : "left",
			});
		}

		idx = Math.floor(idx / 2);
		currentLayer = nextLayer;
	}

	return {
		leafHash: targetLeaf,
		leafIndex,
		siblings,
		root: currentLayer[0],
	};
}

/**
 * Verify a Merkle inclusion proof.
 *
 * @param proof - The proof to verify
 * @param expectedRoot - The expected Merkle root
 * @returns true if the proof is valid
 */
export function verifyMemoryProof(
	proof: ChainMerkleProof,
	expectedRoot: string,
): boolean {
	let current = proof.leafHash;

	for (const sibling of proof.siblings) {
		current = hashPair(current, sibling.hash);
	}

	return current === expectedRoot;
}
