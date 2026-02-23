/**
 * @module chain/payments
 * @description x402 payment protocol implementation for Signet agents.
 *
 * Implements the x402 HTTP payment header protocol, allowing agents to:
 * - Create payment authorization headers for 402 Payment Required responses
 * - Verify incoming payment headers from other agents
 * - Process and log payments through session keys
 * - Track spending against daily limits
 *
 * The x402 header format:
 *   X-PAYMENT: <base64(JSON({ amount, recipient, timestamp, nonce, signature }))>
 *
 * All payments are logged in the payment_log table for audit and limit tracking.
 */

import { ethers } from "ethers";
import type { ChainDb } from "./types";
import { loadSessionKey, getSessionKeyById, validateSessionKeyPermission } from "./session-keys";
import type { SessionKey, TransactionData } from "./session-keys";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PaymentHeader {
	/** Payment amount in ETH */
	amount: string;
	/** Recipient Ethereum address */
	recipient: string;
	/** ISO-8601 timestamp */
	timestamp: string;
	/** Random nonce for replay protection */
	nonce: string;
	/** ECDSA signature over the payment payload */
	signature: string;
	/** Payer's Ethereum address (derived from signature) */
	payer: string;
}

export interface PaymentRecord {
	/** Payment log entry ID */
	id: string;
	/** Session key used for this payment */
	sessionKeyId: string;
	/** Sender address */
	fromAddress: string;
	/** Recipient address */
	toAddress: string;
	/** Amount in ETH */
	amount: string;
	/** On-chain transaction hash (if submitted) */
	txHash: string | null;
	/** Purpose/description of the payment */
	purpose: string | null;
	/** Payment status: pending, completed, failed */
	status: string;
	/** ISO-8601 creation timestamp */
	createdAt: string;
}

export interface PaymentHistoryOptions {
	/** Filter by session key ID */
	sessionKeyId?: string;
	/** Filter by sender address */
	fromAddress?: string;
	/** Filter by recipient address */
	toAddress?: string;
	/** Filter by status */
	status?: string;
	/** Maximum results */
	limit?: number;
	/** Offset for pagination */
	offset?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(): string {
	return `pay_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function generateNonce(): string {
	const bytes = ethers.randomBytes(16);
	return ethers.hexlify(bytes);
}

/**
 * Build the canonical message for signing/verification.
 * Format: `x402:1:${amount}:${recipient}:${timestamp}:${nonce}`
 */
function buildPaymentMessage(
	amount: string,
	recipient: string,
	timestamp: string,
	nonce: string,
): string {
	return `x402:1:${amount}:${recipient}:${timestamp}:${nonce}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create an x402 payment authorization header.
 *
 * Generates a signed payment header that can be included in HTTP requests
 * to fulfill 402 Payment Required responses.
 *
 * @param sessionKeyWallet - ethers.Wallet loaded from a session key
 * @param amount - Payment amount in ETH
 * @param recipient - Recipient Ethereum address
 * @returns Base64-encoded payment header string
 */
export async function createPaymentHeader(
	sessionKeyWallet: ethers.Wallet,
	amount: string,
	recipient: string,
): Promise<string> {
	if (!ethers.isAddress(recipient)) {
		throw new Error(`Invalid recipient address: ${recipient}`);
	}
	if (parseFloat(amount) <= 0) {
		throw new Error("Payment amount must be positive");
	}

	const timestamp = new Date().toISOString();
	const nonce = generateNonce();

	const message = buildPaymentMessage(amount, recipient, timestamp, nonce);
	const signature = await sessionKeyWallet.signMessage(message);

	const header: PaymentHeader = {
		amount,
		recipient,
		timestamp,
		nonce,
		signature,
		payer: sessionKeyWallet.address,
	};

	// Encode as base64 JSON
	const json = JSON.stringify(header);
	return Buffer.from(json, "utf-8").toString("base64");
}

/**
 * Verify an incoming x402 payment header.
 *
 * Validates:
 * 1. Header is well-formed JSON
 * 2. ECDSA signature is valid
 * 3. Amount matches expected amount (if provided)
 * 4. Timestamp is not too old (5 minute window)
 *
 * @param headerValue - Base64-encoded payment header
 * @param expectedAmount - Optional expected payment amount
 * @returns Object with valid flag and parsed header
 */
export function verifyPaymentHeader(
	headerValue: string,
	expectedAmount?: string,
): { valid: boolean; header?: PaymentHeader; reason?: string } {
	let header: PaymentHeader;

	try {
		const json = Buffer.from(headerValue, "base64").toString("utf-8");
		header = JSON.parse(json) as PaymentHeader;
	} catch {
		return { valid: false, reason: "Invalid header format: not valid base64 JSON" };
	}

	// Validate required fields
	if (!header.amount || !header.recipient || !header.timestamp || !header.nonce || !header.signature) {
		return { valid: false, reason: "Missing required fields in payment header" };
	}

	// Verify amount matches
	if (expectedAmount !== undefined && header.amount !== expectedAmount) {
		return {
			valid: false,
			reason: `Amount mismatch: expected ${expectedAmount}, got ${header.amount}`,
		};
	}

	// Verify timestamp freshness (5 minute window)
	const headerTime = new Date(header.timestamp).getTime();
	const now = Date.now();
	const maxAgeMs = 5 * 60 * 1000; // 5 minutes
	if (Math.abs(now - headerTime) > maxAgeMs) {
		return { valid: false, reason: "Payment header timestamp is too old or in the future" };
	}

	// Verify signature
	const message = buildPaymentMessage(header.amount, header.recipient, header.timestamp, header.nonce);
	try {
		const recoveredAddress = ethers.verifyMessage(message, header.signature);
		if (recoveredAddress.toLowerCase() !== header.payer.toLowerCase()) {
			return {
				valid: false,
				reason: `Signature verification failed: recovered ${recoveredAddress}, expected ${header.payer}`,
			};
		}
	} catch (err) {
		return {
			valid: false,
			reason: `Signature verification error: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	return { valid: true, header };
}

/**
 * Process a payment: validate permissions, execute transaction, and log.
 *
 * This is the main entry point for making a payment through a session key.
 * It validates the session key permissions, sends the transaction, and
 * records the payment in the payment_log table.
 *
 * @param db - Database instance
 * @param sessionKeyId - Session key to use for payment
 * @param to - Recipient address
 * @param amount - Amount in ETH
 * @param purpose - Description/reason for the payment
 * @param rpcUrl - JSON-RPC endpoint for transaction submission
 * @returns Payment record with transaction hash
 */
export async function processPayment(
	db: ChainDb,
	sessionKeyId: string,
	to: string,
	amount: string,
	purpose: string,
	rpcUrl: string,
): Promise<PaymentRecord> {
	if (!ethers.isAddress(to)) {
		throw new Error(`Invalid recipient address: ${to}`);
	}
	if (parseFloat(amount) <= 0) {
		throw new Error("Payment amount must be positive");
	}

	// Load and validate session key
	const sessionKey = getSessionKeyById(db, sessionKeyId);
	if (!sessionKey) {
		throw new Error(`Session key not found: ${sessionKeyId}`);
	}

	// Validate permissions
	const txData: TransactionData = { to, value: amount };
	const permCheck = validateSessionKeyPermission(sessionKey, txData);
	if (!permCheck.valid) {
		throw new Error(`Permission denied: ${permCheck.reason}`);
	}

	// Check daily limits
	const dailySpend = getDailySpend(db, sessionKeyId);
	const newTotal = parseFloat(dailySpend) + parseFloat(amount);
	if (newTotal > parseFloat(sessionKey.permissions.maxDailySpend)) {
		throw new Error(
			`Daily spend limit exceeded: current ${dailySpend} + ${amount} > ${sessionKey.permissions.maxDailySpend} ETH`,
		);
	}

	const dailyTxCount = getDailyTransactionCount(db, sessionKeyId);
	if (dailyTxCount >= sessionKey.permissions.maxDailyTransactions) {
		throw new Error(
			`Daily transaction limit exceeded: ${dailyTxCount} >= ${sessionKey.permissions.maxDailyTransactions}`,
		);
	}

	// Create payment log entry (pending)
	const paymentId = generateId();
	const now = new Date().toISOString();

	db.prepare(
		`INSERT INTO payment_log
		 (id, session_key_id, from_address, to_address, amount, purpose, status, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
	).run(paymentId, sessionKeyId, sessionKey.sessionAddress, to, amount, purpose, now);

	// Execute transaction
	let txHash: string | null = null;
	try {
		const wallet = await loadSessionKey(db, sessionKeyId, rpcUrl);
		const tx = await wallet.sendTransaction({
			to,
			value: ethers.parseEther(amount),
		});
		const receipt = await tx.wait();

		if (!receipt || receipt.status !== 1) {
			throw new Error("Transaction failed on-chain");
		}

		txHash = tx.hash;

		// Update payment log to completed
		db.prepare(
			"UPDATE payment_log SET tx_hash = ?, status = 'completed' WHERE id = ?",
		).run(txHash, paymentId);
	} catch (err) {
		// Update payment log to failed
		db.prepare(
			"UPDATE payment_log SET status = 'failed' WHERE id = ?",
		).run(paymentId);

		throw new Error(
			`Payment failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	return {
		id: paymentId,
		sessionKeyId,
		fromAddress: sessionKey.sessionAddress,
		toAddress: to,
		amount,
		txHash,
		purpose,
		status: "completed",
		createdAt: now,
	};
}

/**
 * Get payment history with optional filters.
 *
 * @param db - Database instance
 * @param options - Filter options
 * @returns Array of payment records
 */
export function getPaymentHistory(
	db: ChainDb,
	options: PaymentHistoryOptions = {},
): PaymentRecord[] {
	const conditions: string[] = [];
	const params: unknown[] = [];

	if (options.sessionKeyId) {
		conditions.push("session_key_id = ?");
		params.push(options.sessionKeyId);
	}
	if (options.fromAddress) {
		conditions.push("from_address = ?");
		params.push(options.fromAddress);
	}
	if (options.toAddress) {
		conditions.push("to_address = ?");
		params.push(options.toAddress);
	}
	if (options.status) {
		conditions.push("status = ?");
		params.push(options.status);
	}

	const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
	const limit = options.limit ?? 50;
	const offset = options.offset ?? 0;

	const rows = db
		.prepare(
			`SELECT * FROM payment_log ${where}
			 ORDER BY created_at DESC
			 LIMIT ? OFFSET ?`,
		)
		.all(...params, limit, offset) as Record<string, unknown>[];

	return rows.map(rowToPaymentRecord);
}

/**
 * Get the total amount spent today through a session key.
 *
 * @param db - Database instance
 * @param sessionKeyId - Session key ID
 * @returns Total daily spend in ETH as a string
 */
export function getDailySpend(db: ChainDb, sessionKeyId: string): string {
	const todayStart = new Date();
	todayStart.setUTCHours(0, 0, 0, 0);

	const row = db
		.prepare(
			`SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) as total
			 FROM payment_log
			 WHERE session_key_id = ?
			   AND status = 'completed'
			   AND created_at >= ?`,
		)
		.get(sessionKeyId, todayStart.toISOString()) as { total: number } | undefined;

	return (row?.total ?? 0).toString();
}

/**
 * Get the number of transactions made today through a session key.
 *
 * @param db - Database instance
 * @param sessionKeyId - Session key ID
 * @returns Number of transactions today
 */
export function getDailyTransactionCount(
	db: ChainDb,
	sessionKeyId: string,
): number {
	const todayStart = new Date();
	todayStart.setUTCHours(0, 0, 0, 0);

	const row = db
		.prepare(
			`SELECT COUNT(*) as count
			 FROM payment_log
			 WHERE session_key_id = ?
			   AND status = 'completed'
			   AND created_at >= ?`,
		)
		.get(sessionKeyId, todayStart.toISOString()) as { count: number } | undefined;

	return row?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function rowToPaymentRecord(row: Record<string, unknown>): PaymentRecord {
	return {
		id: row.id as string,
		sessionKeyId: row.session_key_id as string,
		fromAddress: row.from_address as string,
		toAddress: row.to_address as string,
		amount: row.amount as string,
		txHash: (row.tx_hash as string) ?? null,
		purpose: (row.purpose as string) ?? null,
		status: row.status as string,
		createdAt: row.created_at as string,
	};
}
