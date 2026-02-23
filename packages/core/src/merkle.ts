/**
 * @module merkle
 * @description Merkle tree implementation for Signet Web3 using BLAKE2b-256.
 *
 * Provides construction, proof generation, and verification of Merkle trees
 * over content hashes. All hashing uses BLAKE2b-256 via libsodium.
 *
 * @example
 * ```typescript
 * import { hashContent, computeMerkleRoot, buildMerkleTree, generateProof, verifyProof } from './merkle';
 *
 * const hashes = await Promise.all(items.map(i => hashContent(i)));
 * const root = await computeMerkleRoot(hashes);
 * const tree = await buildMerkleTree(hashes);
 * const proof = generateProof(tree, 0);
 * const valid = await verifyProof(proof, hashes[0], root);
 * ```
 */

import sodium from 'libsodium-wrappers';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** BLAKE2b-256 output length in bytes. */
const HASH_BYTES = 32;

/**
 * Canonical "empty root" — the BLAKE2b-256 hash of an empty input.
 * Used when `computeMerkleRoot` or `buildMerkleTree` receives an empty array.
 * Pre-computed once on first access via {@link getEmptyRoot}.
 */
let _emptyRoot: string | null = null;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Represents a complete Merkle tree with all intermediate layers. */
export interface MerkleTree {
  /** Leaf hashes in their original order (hex-encoded). */
  leaves: string[];
  /** All layers from leaves (index 0) to root (last index). Each layer is an array of hex hashes. */
  layers: string[][];
  /** The Merkle root hash (hex-encoded). */
  root: string;
}

/** A single step in a Merkle inclusion proof. */
export interface MerkleProofStep {
  /** The sibling node's hash (hex-encoded). */
  hash: string;
  /** Whether this sibling sits to the `"left"` or `"right"` of the path node. */
  position: 'left' | 'right';
}

/** A Merkle inclusion proof for a specific leaf. */
export interface MerkleProof {
  /** The leaf hash being proved (hex-encoded). */
  leafHash: string;
  /** The leaf's index in the original leaf array. */
  leafIndex: number;
  /** Ordered sibling hashes from leaf level up to the root. */
  siblings: MerkleProofStep[];
  /** The expected Merkle root (hex-encoded). */
  root: string;
}

// ---------------------------------------------------------------------------
// Hex helpers
// ---------------------------------------------------------------------------

/**
 * Convert a hex-encoded string to a `Uint8Array`.
 *
 * @param hex - Hex string (lowercase, no prefix). Must have even length.
 * @returns Raw bytes.
 * @throws {Error} If the string length is odd or contains non-hex characters.
 */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`hexToBytes: odd-length hex string (${hex.length} chars)`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const hi = hexVal(hex.charCodeAt(i * 2));
    const lo = hexVal(hex.charCodeAt(i * 2 + 1));
    if (hi === -1 || lo === -1) {
      throw new Error(`hexToBytes: invalid hex character at position ${i * 2}`);
    }
    bytes[i] = (hi << 4) | lo;
  }
  return bytes;
}

/**
 * Convert a `Uint8Array` to a lowercase hex-encoded string.
 *
 * @param bytes - Raw bytes.
 * @returns Hex string.
 */
export function bytesToHex(bytes: Uint8Array): string {
  const hexChars = new Array<string>(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    hexChars[i] = byteToHex[bytes[i]];
  }
  return hexChars.join('');
}

/** Lookup table: byte value → two-char lowercase hex string. */
const byteToHex: string[] = new Array(256);
for (let i = 0; i < 256; i++) {
  byteToHex[i] = i.toString(16).padStart(2, '0');
}

/** Return 0-15 for valid hex char codes, -1 otherwise. */
function hexVal(code: number): number {
  // 0-9
  if (code >= 48 && code <= 57) return code - 48;
  // a-f
  if (code >= 97 && code <= 102) return code - 87;
  // A-F
  if (code >= 65 && code <= 70) return code - 55;
  return -1;
}

// ---------------------------------------------------------------------------
// Sodium initialization guard
// ---------------------------------------------------------------------------

/** Ensure libsodium is initialized exactly once. */
let _sodiumReady: Promise<void> | null = null;

function ensureSodium(): Promise<void> {
  if (!_sodiumReady) {
    _sodiumReady = sodium.ready;
  }
  return _sodiumReady;
}

// ---------------------------------------------------------------------------
// Low-level hashing
// ---------------------------------------------------------------------------

/**
 * Compute the BLAKE2b-256 hash of arbitrary content (UTF-8 string).
 *
 * @param content - UTF-8 string to hash.
 * @returns Hex-encoded BLAKE2b-256 digest.
 */
export async function hashContent(content: string): Promise<string> {
  await ensureSodium();
  const hash = sodium.crypto_generichash(HASH_BYTES, sodium.from_string(content), null);
  return bytesToHex(hash);
}

/**
 * Hash two hex-encoded nodes together for Merkle tree construction.
 *
 * Computes `BLAKE2b-256(leftBytes || rightBytes)` where `||` is byte concatenation.
 *
 * @param left  - Left child hash (hex-encoded, 32 bytes).
 * @param right - Right child hash (hex-encoded, 32 bytes).
 * @returns Hex-encoded parent hash.
 */
export async function hashPair(left: string, right: string): Promise<string> {
  await ensureSodium();
  const leftBytes = hexToBytes(left);
  const rightBytes = hexToBytes(right);
  const combined = new Uint8Array(leftBytes.length + rightBytes.length);
  combined.set(leftBytes, 0);
  combined.set(rightBytes, leftBytes.length);
  const hash = sodium.crypto_generichash(HASH_BYTES, combined, null);
  return bytesToHex(hash);
}

// ---------------------------------------------------------------------------
// Empty root
// ---------------------------------------------------------------------------

/**
 * Return the canonical empty-tree root: `BLAKE2b-256("")`.
 * Cached after first computation.
 */
async function getEmptyRoot(): Promise<string> {
  if (_emptyRoot === null) {
    await ensureSodium();
    const hash = sodium.crypto_generichash(HASH_BYTES, new Uint8Array(0), null);
    _emptyRoot = bytesToHex(hash);
  }
  return _emptyRoot;
}

// ---------------------------------------------------------------------------
// Tree construction (internal)
// ---------------------------------------------------------------------------

/**
 * Build all layers of the Merkle tree bottom-up.
 *
 * If a layer has an odd number of nodes the last node is duplicated before
 * pairing, ensuring a full binary tree.
 *
 * @param leaves - Array of leaf hashes (hex-encoded).
 * @returns All layers from leaves (index 0) to root (last index).
 */
async function buildLayers(leaves: string[]): Promise<string[][]> {
  await ensureSodium();

  const layers: string[][] = [leaves.slice()]; // layer 0 = leaves (copy)
  let current = layers[0];

  while (current.length > 1) {
    // Duplicate last element if odd count
    if (current.length % 2 !== 0) {
      current = [...current, current[current.length - 1]];
      // Update the layer in place so proof generation sees the padded version
      layers[layers.length - 1] = current;
    }

    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const leftBytes = hexToBytes(current[i]);
      const rightBytes = hexToBytes(current[i + 1]);
      const combined = new Uint8Array(HASH_BYTES * 2);
      combined.set(leftBytes, 0);
      combined.set(rightBytes, HASH_BYTES);
      const hash = sodium.crypto_generichash(HASH_BYTES, combined, null);
      next.push(bytesToHex(hash));
    }

    layers.push(next);
    current = next;
  }

  return layers;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the Merkle root from an array of leaf hashes.
 *
 * - **0 leaves:** returns a canonical empty root (`BLAKE2b-256("")`).
 * - **1 leaf:** returns that leaf's hash unchanged.
 * - **2+ leaves:** builds the tree bottom-up and returns the root.
 *
 * @param hashes - Array of hex-encoded leaf hashes.
 * @returns Hex-encoded Merkle root.
 */
export async function computeMerkleRoot(hashes: string[]): Promise<string> {
  if (hashes.length === 0) {
    return getEmptyRoot();
  }
  if (hashes.length === 1) {
    return hashes[0];
  }

  const layers = await buildLayers(hashes);
  return layers[layers.length - 1][0];
}

/**
 * Build a complete Merkle tree, retaining every layer for proof generation.
 *
 * - **0 leaves:** returns a tree with empty leaves/layers and the canonical empty root.
 * - **1 leaf:** single-layer tree; root equals the sole leaf.
 * - **2+ leaves:** full binary tree with internal layers.
 *
 * @param hashes - Array of hex-encoded leaf hashes.
 * @returns A {@link MerkleTree} containing leaves, layers, and root.
 */
export async function buildMerkleTree(hashes: string[]): Promise<MerkleTree> {
  if (hashes.length === 0) {
    const emptyRoot = await getEmptyRoot();
    return {
      leaves: [],
      layers: [],
      root: emptyRoot,
    };
  }

  if (hashes.length === 1) {
    return {
      leaves: [hashes[0]],
      layers: [[hashes[0]]],
      root: hashes[0],
    };
  }

  const layers = await buildLayers(hashes);

  return {
    leaves: hashes.slice(),
    layers,
    root: layers[layers.length - 1][0],
  };
}

/**
 * Generate an inclusion proof for a leaf at a given index.
 *
 * The proof consists of the sibling hashes at each level of the tree, annotated
 * with their position (`"left"` or `"right"`) relative to the path element.
 *
 * @param tree      - A tree previously built with {@link buildMerkleTree}.
 * @param leafIndex - Zero-based index of the leaf to prove.
 * @returns A {@link MerkleProof} that can be verified with {@link verifyProof}.
 * @throws {RangeError} If `leafIndex` is out of bounds.
 * @throws {Error} If the tree has no leaves.
 */
export function generateProof(tree: MerkleTree, leafIndex: number): MerkleProof {
  if (tree.leaves.length === 0) {
    throw new Error('generateProof: cannot generate proof for an empty tree');
  }
  if (leafIndex < 0 || leafIndex >= tree.leaves.length) {
    throw new RangeError(
      `generateProof: leafIndex ${leafIndex} out of bounds [0, ${tree.leaves.length - 1}]`,
    );
  }

  const siblings: MerkleProofStep[] = [];
  let idx = leafIndex;

  // Walk from the leaf layer up to (but not including) the root layer
  for (let level = 0; level < tree.layers.length - 1; level++) {
    const layer = tree.layers[level];
    const isLeft = idx % 2 === 0;
    const siblingIdx = isLeft ? idx + 1 : idx - 1;

    // siblingIdx should always be valid because odd layers are padded
    if (siblingIdx < layer.length) {
      siblings.push({
        hash: layer[siblingIdx],
        position: isLeft ? 'right' : 'left',
      });
    }

    // Move to parent index
    idx = Math.floor(idx / 2);
  }

  return {
    leafHash: tree.leaves[leafIndex],
    leafIndex,
    siblings,
    root: tree.root,
  };
}

/**
 * Verify a Merkle inclusion proof.
 *
 * Recomputes the path from `leafHash` to the root using the sibling hashes,
 * then compares against the expected `root`.
 *
 * @param proof    - The proof to verify.
 * @param leafHash - The leaf hash to verify inclusion of (hex-encoded).
 * @param root     - The expected Merkle root (hex-encoded).
 * @returns `true` if the proof is valid and matches the given root.
 */
export async function verifyProof(
  proof: MerkleProof,
  leafHash: string,
  root: string,
): Promise<boolean> {
  await ensureSodium();

  // Quick sanity: the proof's own leaf must match the provided leaf
  if (proof.leafHash !== leafHash) {
    return false;
  }

  let current = leafHash;

  for (const step of proof.siblings) {
    const left = step.position === 'left' ? step.hash : current;
    const right = step.position === 'left' ? current : step.hash;

    const leftBytes = hexToBytes(left);
    const rightBytes = hexToBytes(right);
    const combined = new Uint8Array(HASH_BYTES * 2);
    combined.set(leftBytes, 0);
    combined.set(rightBytes, HASH_BYTES);
    current = bytesToHex(sodium.crypto_generichash(HASH_BYTES, combined, null));
  }

  return current === root;
}
