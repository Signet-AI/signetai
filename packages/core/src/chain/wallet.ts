/**
 * @module chain/wallet
 * @description Ethereum wallet management for Signet on-chain identity.
 *
 * Wallet private keys are encrypted at rest using the same XSalsa20-Poly1305
 * (libsodium secretbox) encryption as the Ed25519 signing keypair, under the
 * master key derived from the user's passphrase + machine ID.
 */

import { ethers } from "ethers";
import sodium from "libsodium-wrappers";
import { getMasterKey, getKeypairKdfVersion } from "../crypto";
import type { ChainDb, WalletConfig, ChainConfig, CHAIN_CONFIGS } from "./types";
import { DEFAULT_CHAIN } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(): string {
	return `wallet_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Encrypt a private key using the master key from crypto.ts.
 * Returns base64(nonce || ciphertext).
 */
async function encryptPrivateKey(privateKey: string): Promise<string> {
	await sodium.ready;

	const kdfVersion = getKeypairKdfVersion() ?? 1;
	// For v2/v3, we need the salt from the signing keypair file.
	// For simplicity, we derive the master key the same way crypto.ts does.
	const masterKey = await getMasterKey(kdfVersion);

	const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
	const plaintext = new TextEncoder().encode(privateKey);
	const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, masterKey);

	const combined = new Uint8Array(nonce.length + ciphertext.length);
	combined.set(nonce);
	combined.set(ciphertext, nonce.length);

	masterKey.fill(0);
	return sodium.to_base64(combined, sodium.base64_variants.ORIGINAL);
}

/**
 * Decrypt a private key using the master key from crypto.ts.
 */
async function decryptPrivateKey(encrypted: string): Promise<string> {
	await sodium.ready;

	const kdfVersion = getKeypairKdfVersion() ?? 1;
	const masterKey = await getMasterKey(kdfVersion);

	const combined = sodium.from_base64(encrypted, sodium.base64_variants.ORIGINAL);
	if (combined.length < sodium.crypto_secretbox_NONCEBYTES + sodium.crypto_secretbox_MACBYTES) {
		throw new Error("Encrypted key data is too short — may be corrupted");
	}

	const nonce = combined.slice(0, sodium.crypto_secretbox_NONCEBYTES);
	const ciphertext = combined.slice(sodium.crypto_secretbox_NONCEBYTES);

	const plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, masterKey);
	masterKey.fill(0);

	if (!plaintext) {
		throw new Error(
			"Failed to decrypt wallet key — master key mismatch or corrupted data. " +
			"This can happen if the keypair was generated on a different machine.",
		);
	}

	return new TextDecoder().decode(plaintext);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new Ethereum wallet, encrypt its private key, and store in DB.
 *
 * @param db - Database instance with wallet_config table
 * @param chain - Chain identifier (default: 'base-sepolia')
 * @returns The created WalletConfig
 */
export async function createWallet(
	db: ChainDb,
	chain: string = DEFAULT_CHAIN,
): Promise<WalletConfig> {
	// Check if a wallet already exists for this chain
	const existing = db
		.prepare("SELECT id FROM wallet_config WHERE chain = ? AND is_default = 1")
		.get(chain) as { id: string } | undefined;

	if (existing) {
		throw new Error(
			`A default wallet already exists for chain '${chain}'. ` +
			"Use getWalletAddress() to view it or delete it first.",
		);
	}

	// Generate a new random Ethereum wallet
	const wallet = ethers.Wallet.createRandom();
	const encryptedKey = await encryptPrivateKey(wallet.privateKey);

	const id = generateId();
	const config: WalletConfig = {
		id,
		chain,
		address: wallet.address,
		encryptedKey,
		keyType: "secp256k1",
		isDefault: true,
		createdAt: new Date().toISOString(),
	};

	db.prepare(
		`INSERT INTO wallet_config (id, chain, address, encrypted_key, key_type, is_default, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).run(id, chain, wallet.address, encryptedKey, "secp256k1", 1, config.createdAt);

	return config;
}

/**
 * Load and decrypt the default wallet for a chain, returning an ethers.js Wallet.
 *
 * @param db - Database instance
 * @param chain - Chain identifier
 * @param rpcUrl - Optional RPC URL to connect the wallet to a provider
 * @returns Connected ethers.Wallet
 */
export async function loadWallet(
	db: ChainDb,
	chain: string = DEFAULT_CHAIN,
	rpcUrl?: string,
): Promise<ethers.Wallet> {
	const row = db
		.prepare(
			"SELECT encrypted_key, address FROM wallet_config WHERE chain = ? AND is_default = 1",
		)
		.get(chain) as { encrypted_key: string; address: string } | undefined;

	if (!row) {
		throw new Error(
			`No wallet found for chain '${chain}'. Create one with: signet chain wallet create`,
		);
	}

	if (!row.encrypted_key) {
		throw new Error("Wallet has no encrypted key — it may be a watch-only wallet");
	}

	const privateKey = await decryptPrivateKey(row.encrypted_key);
	let wallet = new ethers.Wallet(privateKey);

	// Connect to provider if RPC URL provided
	if (rpcUrl) {
		const provider = new ethers.JsonRpcProvider(rpcUrl);
		wallet = wallet.connect(provider);
	}

	return wallet;
}

/**
 * Get the wallet address for a chain without decrypting the private key.
 *
 * @param db - Database instance
 * @param chain - Chain identifier
 * @returns Ethereum address or null if no wallet exists
 */
export function getWalletAddress(
	db: ChainDb,
	chain: string = DEFAULT_CHAIN,
): string | null {
	const row = db
		.prepare("SELECT address FROM wallet_config WHERE chain = ? AND is_default = 1")
		.get(chain) as { address: string } | undefined;

	return row?.address ?? null;
}

/**
 * Export the private key for a wallet (after decryption).
 * WARNING: This exposes the raw private key. Use with extreme caution.
 *
 * @param db - Database instance
 * @param chain - Chain identifier
 * @returns The raw hex private key
 */
export async function exportWalletKey(
	db: ChainDb,
	chain: string = DEFAULT_CHAIN,
): Promise<string> {
	const row = db
		.prepare(
			"SELECT encrypted_key FROM wallet_config WHERE chain = ? AND is_default = 1",
		)
		.get(chain) as { encrypted_key: string } | undefined;

	if (!row?.encrypted_key) {
		throw new Error(`No wallet with encrypted key found for chain '${chain}'`);
	}

	return decryptPrivateKey(row.encrypted_key);
}

/**
 * Get the ETH balance for the wallet on a given chain.
 *
 * @param address - Ethereum address
 * @param rpcUrl - RPC endpoint URL
 * @returns Balance in ETH as a string
 */
export async function getWalletBalance(
	address: string,
	rpcUrl: string,
): Promise<string> {
	const provider = new ethers.JsonRpcProvider(rpcUrl);
	const balance = await provider.getBalance(address);
	return ethers.formatEther(balance);
}

/**
 * Compute the keccak256 hash of arbitrary bytes.
 * Convenience wrapper around ethers.keccak256 for CLI use.
 */
export function keccak256Hash(data: Uint8Array): string {
	return ethers.keccak256(data);
}

/**
 * Check if a wallet has sufficient ETH to perform a transaction.
 * Returns an object with the balance and whether it's sufficient.
 */
export async function checkWalletFunds(
	address: string,
	rpcUrl: string,
	minEth: string = "0.001",
): Promise<{ balance: string; sufficient: boolean }> {
	const balance = await getWalletBalance(address, rpcUrl);
	const sufficient = parseFloat(balance) >= parseFloat(minEth);
	return { balance, sufficient };
}
