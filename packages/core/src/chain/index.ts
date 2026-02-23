/**
 * @module chain
 * @description On-chain identity and memory anchoring for Signet agents.
 *
 * Provides:
 * - Ethereum wallet management (encrypted at rest)
 * - SignetIdentity contract interaction (ERC-8004 compatible)
 * - Memory Merkle tree construction and proof generation (keccak256-based)
 * - Chain configuration for Base Sepolia and Base mainnet
 */

// Types
export type {
	ChainConfig,
	OnchainIdentity,
	MemoryAnchor,
	WalletConfig,
	OnchainAgentIdentity,
	ChainDb,
} from "./types";
export { CHAIN_CONFIGS, DEFAULT_CHAIN } from "./types";

// Wallet management
export {
	createWallet,
	loadWallet,
	getWalletAddress,
	exportWalletKey,
	getWalletBalance,
	checkWalletFunds,
	keccak256Hash,
} from "./wallet";

// Contract interaction
export {
	SIGNET_IDENTITY_ABI,
	getContract,
	getReadOnlyContract,
	registerIdentity,
	anchorMemoryOnChain,
	getIdentityByDID,
	getLocalIdentity,
	getLatestAnchor,
} from "./contract";

// Memory Merkle tree (keccak256-based for Ethereum)
export {
	buildMemoryMerkleTree,
	getMemoryRoot,
	generateMemoryProof,
	verifyMemoryProof,
} from "./merkle";
export type {
	MemoryLeaf,
	ChainMerkleTree,
	ChainMerkleProof,
} from "./merkle";
