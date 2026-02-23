/**
 * @module chain/types
 * @description Type definitions for on-chain identity and wallet management.
 */

// ---------------------------------------------------------------------------
// Chain Configuration
// ---------------------------------------------------------------------------

export interface ChainConfig {
	/** Chain identifier: 'base' | 'base-sepolia' | 'hardhat' */
	readonly chain: string;
	/** Numeric chain ID (Base Sepolia = 84532, Base = 8453, Hardhat = 31337) */
	readonly chainId: number;
	/** JSON-RPC endpoint URL */
	readonly rpcUrl: string;
	/** Block explorer URL (optional) */
	readonly explorerUrl?: string;
	/** Deployed SignetIdentity contract address */
	readonly contractAddress?: string;
}

/** Pre-configured chain definitions */
export const CHAIN_CONFIGS: Record<string, ChainConfig> = {
	"base-sepolia": {
		chain: "base-sepolia",
		chainId: 84532,
		rpcUrl: "https://sepolia.base.org",
		explorerUrl: "https://sepolia.basescan.org",
	},
	base: {
		chain: "base",
		chainId: 8453,
		rpcUrl: "https://mainnet.base.org",
		explorerUrl: "https://basescan.org",
	},
	hardhat: {
		chain: "hardhat",
		chainId: 31337,
		rpcUrl: "http://127.0.0.1:8545",
	},
};

/** Default chain for new operations */
export const DEFAULT_CHAIN = "base-sepolia";

// ---------------------------------------------------------------------------
// On-Chain Identity
// ---------------------------------------------------------------------------

export interface OnchainIdentity {
	/** Local DB ID */
	id: string;
	/** Chain name */
	chain: string;
	/** On-chain NFT token ID (stringified bigint) */
	tokenId: string | null;
	/** SignetIdentity contract address */
	contractAddress: string | null;
	/** Wallet address that owns the identity */
	walletAddress: string;
	/** Agent DID string */
	did: string;
	/** Registration transaction hash */
	txHash: string | null;
	/** On-chain registration timestamp */
	registeredAt: string | null;
	/** Local creation timestamp */
	createdAt: string;
}

// ---------------------------------------------------------------------------
// Memory Anchor
// ---------------------------------------------------------------------------

export interface MemoryAnchor {
	/** Local DB ID */
	id: string;
	/** Foreign key to onchain_identity */
	onchainId: string;
	/** Merkle root hex string */
	memoryRoot: string;
	/** Total memories in the tree */
	memoryCount: number;
	/** Anchor transaction hash */
	txHash: string | null;
	/** On-chain anchor timestamp */
	anchoredAt: string | null;
	/** Local creation timestamp */
	createdAt: string;
}

// ---------------------------------------------------------------------------
// Wallet Configuration
// ---------------------------------------------------------------------------

export interface WalletConfig {
	/** Local DB ID */
	id: string;
	/** Chain name */
	chain: string;
	/** Ethereum address (0x...) */
	address: string;
	/** Encrypted private key (base64, XSalsa20-Poly1305) */
	encryptedKey: string | null;
	/** Key type (always 'secp256k1' for Ethereum) */
	keyType: string;
	/** Whether this is the default wallet for the chain */
	isDefault: boolean;
	/** Local creation timestamp */
	createdAt: string;
}

// ---------------------------------------------------------------------------
// Contract Return Types
// ---------------------------------------------------------------------------

export interface OnchainAgentIdentity {
	did: string;
	metadataURI: string;
	publicKeyHash: string;
	registeredAt: bigint;
	lastAnchored: bigint;
	memoryRoot: string;
	memoryCount: bigint;
}

// ---------------------------------------------------------------------------
// DB Interface (compatible with better-sqlite3)
// ---------------------------------------------------------------------------

export interface ChainDb {
	prepare(sql: string): {
		run(...args: unknown[]): { changes: number; lastInsertRowid: number | bigint };
		get(...args: unknown[]): Record<string, unknown> | undefined;
		all(...args: unknown[]): Record<string, unknown>[];
	};
	exec(sql: string): void;
}
