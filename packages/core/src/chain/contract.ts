/**
 * @module chain/contract
 * @description Interact with the SignetIdentity smart contract on-chain.
 *
 * Provides functions to register agent identities, anchor memory roots,
 * and query on-chain identity data. Uses ethers.js v6 for all contract
 * interactions.
 */

import { ethers } from "ethers";
import type { ChainDb, ChainConfig, OnchainIdentity, OnchainAgentIdentity } from "./types";
import { CHAIN_CONFIGS, DEFAULT_CHAIN } from "./types";

// ---------------------------------------------------------------------------
// Contract ABI (hardcoded — generated from SignetIdentity.sol)
// ---------------------------------------------------------------------------

/**
 * Minimal ABI for the SignetIdentity contract.
 * Only includes the functions/events we actually call.
 * This will be replaced with a compiled ABI once Hardhat compilation is set up.
 */
export const SIGNET_IDENTITY_ABI = [
	// commitRegistration(bytes32 commitment)
	"function commitRegistration(bytes32 commitment) external",
	// register(string did, string metadataURI, bytes32 publicKeyHash, bytes32 salt) → uint256
	"function register(string calldata did, string calldata metadataURI, bytes32 publicKeyHash, bytes32 salt) external returns (uint256)",
	// anchorMemory(uint256 tokenId, bytes32 memoryRoot, uint64 memoryCount)
	"function anchorMemory(uint256 tokenId, bytes32 memoryRoot, uint64 memoryCount) external",
	// updateMetadata(uint256 tokenId, string metadataURI)
	"function updateMetadata(uint256 tokenId, string calldata metadataURI) external",
	// getIdentityByDID(string did) → AgentIdentity
	"function getIdentityByDID(string calldata did) external view returns (tuple(string did, string metadataURI, bytes32 publicKeyHash, uint256 registeredAt, uint256 lastAnchored, bytes32 memoryRoot, uint64 memoryCount))",
	// identities(uint256 tokenId) → AgentIdentity
	"function identities(uint256 tokenId) external view returns (string did, string metadataURI, bytes32 publicKeyHash, uint256 registeredAt, uint256 lastAnchored, bytes32 memoryRoot, uint64 memoryCount)",
	// didToTokenId(bytes32 didHash) → uint256
	"function didToTokenId(bytes32 didHash) external view returns (uint256)",
	// ownerOf(uint256 tokenId) → address
	"function ownerOf(uint256 tokenId) external view returns (address)",
	// tokenURI(uint256 tokenId) → string
	"function tokenURI(uint256 tokenId) external view returns (string)",
	// Events
	"event IdentityRegistered(uint256 indexed tokenId, string did, bytes32 publicKeyHash)",
	"event MemoryAnchored(uint256 indexed tokenId, bytes32 memoryRoot, uint64 memoryCount)",
	"event MetadataUpdated(uint256 indexed tokenId, string metadataURI)",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(): string {
	const { randomBytes } = require("node:crypto");
	return `onchain_${randomBytes(16).toString("hex")}`;
}

function getChainConfig(chain: string): ChainConfig {
	const config = CHAIN_CONFIGS[chain];
	if (!config) {
		throw new Error(
			`Unknown chain '${chain}'. Supported chains: ${Object.keys(CHAIN_CONFIGS).join(", ")}`,
		);
	}
	return config;
}

/**
 * Get a contract instance connected to a wallet.
 *
 * @param wallet - ethers.js Wallet (must be connected to a provider)
 * @param contractAddress - Deployed SignetIdentity contract address
 * @returns ethers.Contract instance
 */
export function getContract(
	wallet: ethers.Wallet,
	contractAddress: string,
): ethers.Contract {
	return new ethers.Contract(contractAddress, SIGNET_IDENTITY_ABI, wallet);
}

/**
 * Get a read-only contract instance connected to a provider.
 *
 * @param rpcUrl - JSON-RPC endpoint URL
 * @param contractAddress - Deployed SignetIdentity contract address
 * @returns ethers.Contract instance (read-only)
 */
export function getReadOnlyContract(
	rpcUrl: string,
	contractAddress: string,
): ethers.Contract {
	const provider = new ethers.JsonRpcProvider(rpcUrl);
	return new ethers.Contract(contractAddress, SIGNET_IDENTITY_ABI, provider);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register an agent identity on-chain.
 *
 * Calls the SignetIdentity.register() function, minting an ERC-721 NFT
 * with the agent's DID, metadata URI, and public key hash.
 *
 * @param db - Database for storing the registration record
 * @param wallet - Connected ethers.js Wallet with sufficient ETH
 * @param contractAddress - Deployed contract address
 * @param did - Agent's DID string
 * @param metadataURI - IPFS or HTTP URI for the agent manifest
 * @param publicKeyHash - keccak256 hash of the Ed25519 public key (bytes32)
 * @param chain - Chain identifier
 * @returns The on-chain identity record
 */
export async function registerIdentity(
	db: ChainDb,
	wallet: ethers.Wallet,
	contractAddress: string,
	did: string,
	metadataURI: string,
	publicKeyHash: string,
	chain: string = DEFAULT_CHAIN,
): Promise<OnchainIdentity> {
	const contract = getContract(wallet, contractAddress);

	// C-1 audit fix: commit-reveal to prevent front-running
	const salt = ethers.hexlify(ethers.randomBytes(32));
	const commitment = ethers.keccak256(
		ethers.solidityPacked(
			["string", "string", "bytes32", "address", "bytes32"],
			[did, metadataURI, publicKeyHash, wallet.address, salt],
		),
	);
	const commitTx = await contract.commitRegistration(commitment);
	await commitTx.wait();

	// Wait for the commit delay requirement (1 block ≈ 2-3s on Base)
	await new Promise<void>((resolve) => setTimeout(resolve, 3000));

	// Submit registration with salt
	const tx = await contract.register(did, metadataURI, publicKeyHash, salt);
	const receipt = await tx.wait();

	if (!receipt || receipt.status !== 1) {
		throw new Error(`Registration transaction failed: ${tx.hash}`);
	}

	// Parse the IdentityRegistered event to get the token ID
	let tokenId: string | null = null;
	for (const log of receipt.logs) {
		try {
			const parsed = contract.interface.parseLog({
				topics: log.topics as string[],
				data: log.data,
			});
			if (parsed && parsed.name === "IdentityRegistered") {
				tokenId = parsed.args[0].toString(); // tokenId is first arg
				break;
			}
		} catch {
			// Not our event, skip
		}
	}

	// Store in local DB
	const id = generateId();
	const now = new Date().toISOString();

	const record: OnchainIdentity = {
		id,
		chain,
		tokenId,
		contractAddress,
		walletAddress: wallet.address,
		did,
		txHash: tx.hash,
		registeredAt: now,
		createdAt: now,
	};

	db.prepare(
		`INSERT INTO onchain_identity
		 (id, chain, token_id, contract_address, wallet_address, did, tx_hash, registered_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(id, chain, tokenId, contractAddress, wallet.address, did, tx.hash, now, now);

	return record;
}

// ---------------------------------------------------------------------------
// Memory Anchoring
// ---------------------------------------------------------------------------

/**
 * Anchor a memory Merkle root on-chain.
 *
 * Calls the SignetIdentity.anchorMemory() function, storing the current
 * Merkle root and memory count in the agent's on-chain identity.
 *
 * @param db - Database for storing the anchor record
 * @param wallet - Connected ethers.js Wallet
 * @param contractAddress - Deployed contract address
 * @param tokenId - On-chain NFT token ID
 * @param memoryRoot - Merkle root hex string (will be padded to bytes32)
 * @param memoryCount - Total memory count
 * @param onchainId - Foreign key to onchain_identity table
 * @returns The memory anchor record
 */
export async function anchorMemoryOnChain(
	db: ChainDb,
	wallet: ethers.Wallet,
	contractAddress: string,
	tokenId: string,
	memoryRoot: string,
	memoryCount: number,
	onchainId: string,
): Promise<{ id: string; txHash: string }> {
	const contract = getContract(wallet, contractAddress);

	// C-5 audit fix: validate root length, never silently pad
	const rootBytes32 = memoryRoot.startsWith("0x") ? memoryRoot : `0x${memoryRoot}`;
	if (rootBytes32.length !== 66) {
		throw new Error(`Invalid memory root length: expected 66 chars (0x + 64 hex), got ${rootBytes32.length}`);
	}

	const tx = await contract.anchorMemory(
		BigInt(tokenId),
		rootBytes32,
		memoryCount,
	);
	const receipt = await tx.wait();

	if (!receipt || receipt.status !== 1) {
		throw new Error(`Anchor transaction failed: ${tx.hash}`);
	}

	// Store in local DB
	const { randomBytes: rb } = require("node:crypto");
	const id = `anchor_${rb(16).toString("hex")}`;
	const now = new Date().toISOString();

	db.prepare(
		`INSERT INTO memory_anchors
		 (id, onchain_id, memory_root, memory_count, tx_hash, anchored_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).run(id, onchainId, memoryRoot, memoryCount, tx.hash, now, now);

	return { id, txHash: tx.hash };
}

// ---------------------------------------------------------------------------
// Queries (read-only)
// ---------------------------------------------------------------------------

/**
 * Look up an agent identity on-chain by DID.
 *
 * @param rpcUrl - JSON-RPC endpoint URL
 * @param contractAddress - Deployed contract address
 * @param did - Agent's DID string
 * @returns The on-chain agent identity, or null if not found
 */
export async function getIdentityByDID(
	rpcUrl: string,
	contractAddress: string,
	did: string,
): Promise<OnchainAgentIdentity | null> {
	const contract = getReadOnlyContract(rpcUrl, contractAddress);

	try {
		const result = await contract.getIdentityByDID(did);
		return {
			did: result[0] ?? result.did,
			metadataURI: result[1] ?? result.metadataURI,
			publicKeyHash: result[2] ?? result.publicKeyHash,
			registeredAt: BigInt(result[3] ?? result.registeredAt),
			lastAnchored: BigInt(result[4] ?? result.lastAnchored),
			memoryRoot: result[5] ?? result.memoryRoot,
			memoryCount: BigInt(result[6] ?? result.memoryCount),
		};
	} catch (err) {
		// Contract reverts with "DID not found" if not registered
		const message = err instanceof Error ? err.message : String(err);
		if (message.includes("DID not found")) {
			return null;
		}
		throw err;
	}
}

/**
 * Get the local on-chain identity record from the database.
 *
 * @param db - Database instance
 * @param chain - Chain identifier
 * @returns The local on-chain identity record, or null
 */
export function getLocalIdentity(
	db: ChainDb,
	chain: string = DEFAULT_CHAIN,
): OnchainIdentity | null {
	const row = db
		.prepare(
			"SELECT * FROM onchain_identity WHERE chain = ? ORDER BY created_at DESC LIMIT 1",
		)
		.get(chain) as Record<string, unknown> | undefined;

	if (!row) return null;

	return {
		id: row.id as string,
		chain: row.chain as string,
		tokenId: (row.token_id as string) ?? null,
		contractAddress: (row.contract_address as string) ?? null,
		walletAddress: row.wallet_address as string,
		did: row.did as string,
		txHash: (row.tx_hash as string) ?? null,
		registeredAt: (row.registered_at as string) ?? null,
		createdAt: row.created_at as string,
	};
}

/**
 * Get the latest memory anchor record from the database.
 *
 * @param db - Database instance
 * @param onchainId - Foreign key to onchain_identity
 * @returns The latest anchor record, or null
 */
export function getLatestAnchor(
	db: ChainDb,
	onchainId: string,
): { memoryRoot: string; memoryCount: number; txHash: string | null; anchoredAt: string | null } | null {
	const row = db
		.prepare(
			"SELECT * FROM memory_anchors WHERE onchain_id = ? ORDER BY created_at DESC LIMIT 1",
		)
		.get(onchainId) as Record<string, unknown> | undefined;

	if (!row) return null;

	return {
		memoryRoot: row.memory_root as string,
		memoryCount: row.memory_count as number,
		txHash: (row.tx_hash as string) ?? null,
		anchoredAt: (row.anchored_at as string) ?? null,
	};
}
