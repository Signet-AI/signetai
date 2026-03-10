/**
 * GHLConnector
 *
 * The main orchestrator. Wires together OAuth, discovery, gap analysis,
 * and Signet memory ingestion into a single bootstrap + sync lifecycle.
 *
 * Usage:
 *   const connector = new GHLConnector(config);
 *   const authUrl = connector.getAuthorizationUrl();
 *   // ... user visits authUrl, gets redirected to /api/ghl/callback ...
 *   const account = await connector.handleCallback(code);
 *   // agent is now bootstrapped with full account context in memory
 */

import type {
	GHLConnectedAccount,
	GHLConnectorConfig,
	GHLDiscoveryResult,
	GHLGapAnalysisResult,
	GHLOAuthTokens,
} from "./types.js";
import {
	REQUIRED_SCOPES,
	buildAuthorizationUrl,
	ensureValidTokens,
	exchangeCodeForTokens,
} from "./oauth.js";
import { computeHealthScore, discoverLocation } from "./discovery.js";
import { analyzeGaps, executeAutoFixes } from "./gap-analysis.js";
import { ingestDiscovery, ingestGapAnalysis } from "./ingest.js";

// ============================================================================
// Storage Abstraction
// ============================================================================

export interface GHLStorage {
	saveAccount(account: GHLConnectedAccount): Promise<void>;
	getAccount(locationId: string): Promise<GHLConnectedAccount | null>;
	getAllAccounts(): Promise<GHLConnectedAccount[]>;
	deleteAccount(locationId: string): Promise<void>;
}

/** In-memory storage (for development / testing) */
export class MemoryStorage implements GHLStorage {
	private accounts = new Map<string, GHLConnectedAccount>();

	async saveAccount(account: GHLConnectedAccount): Promise<void> {
		this.accounts.set(account.id, account);
	}
	async getAccount(locationId: string): Promise<GHLConnectedAccount | null> {
		return this.accounts.get(locationId) ?? null;
	}
	async getAllAccounts(): Promise<GHLConnectedAccount[]> {
		return [...this.accounts.values()];
	}
	async deleteAccount(locationId: string): Promise<void> {
		this.accounts.delete(locationId);
	}
}

// ============================================================================
// GHLConnector
// ============================================================================

export class GHLConnector {
	private readonly config: GHLConnectorConfig;
	private readonly storage: GHLStorage;

	constructor(config: GHLConnectorConfig, storage?: GHLStorage) {
		// Default scopes if not provided
		if (!config.oauth.scopes || config.oauth.scopes.length === 0) {
			config.oauth.scopes = [...REQUIRED_SCOPES];
		}
		this.config = config;
		this.storage = storage ?? new MemoryStorage();
	}

	// ── OAuth ──────────────────────────────────────────────────────────────────

	/**
	 * Build the URL to redirect the user to for GHL OAuth consent.
	 * Include `state` to tie the callback back to a session.
	 */
	getAuthorizationUrl(state?: string): string {
		return buildAuthorizationUrl({ config: this.config.oauth, state });
	}

	/**
	 * Handle the OAuth callback after user approves.
	 * Exchanges the code for tokens, runs discovery, ingests memories.
	 * Returns the fully bootstrapped connected account.
	 */
	async handleCallback(
		code: string,
		opts: {
			onProgress?: (msg: string) => void;
			runGapAnalysis?: boolean;
			autoFix?: boolean;
		} = {}
	): Promise<GHLConnectedAccount> {
		const log = opts.onProgress ?? (() => {});
		const runGapAnalysis = opts.runGapAnalysis ?? true;

		log("Exchanging authorization code for tokens...");
		const tokens = await exchangeCodeForTokens(code, this.config.oauth);

		log(`Connected as location ${tokens.locationId}`);

		// Bootstrap
		const account = await this.bootstrapAccount(tokens, {
			onProgress: log,
			runGapAnalysis,
			autoFix: opts.autoFix,
		});

		return account;
	}

	// ── Bootstrap ──────────────────────────────────────────────────────────────

	/**
	 * Full bootstrap: discover → analyze → ingest → store.
	 * Called on first connect AND on re-sync.
	 */
	async bootstrapAccount(
		tokens: GHLOAuthTokens,
		opts: {
			onProgress?: (msg: string) => void;
			runGapAnalysis?: boolean;
			autoFix?: boolean;
		} = {}
	): Promise<GHLConnectedAccount> {
		const log = opts.onProgress ?? (() => {});
		const locationId = tokens.locationId;

		// Check if account already exists (re-sync case)
		const existing = await this.storage.getAccount(locationId);

		// Save tokens first (so we have them even if discovery fails)
		const partial: GHLConnectedAccount = {
			id: locationId,
			locationName: existing?.locationName ?? locationId,
			companyId: tokens.companyId,
			userId: tokens.userId,
			connectedAt: existing?.connectedAt ?? new Date().toISOString(),
			lastSyncAt: null,
			tokens,
			healthScore: null,
			discoveryResult: null,
			gapAnalysis: null,
		};
		await this.storage.saveAccount(partial);

		// Discover
		log("Running entity discovery...");
		let discovery: GHLDiscoveryResult;
		try {
			discovery = await discoverLocation({
				tokens,
				config: this.config.oauth,
				onRefreshed: async (newTokens) => {
					partial.tokens = newTokens;
					await this.storage.saveAccount(partial);
				},
				onProgress: log,
			});
		} catch (e) {
			log(`Discovery failed: ${e}`);
			throw e;
		}

		const healthScore = computeHealthScore(discovery);
		log(`Health score: ${healthScore}/100`);

		// Gap analysis
		let gapAnalysis: GHLGapAnalysisResult | null = null;
		if (opts.runGapAnalysis ?? true) {
			log("Analyzing gaps...");
			gapAnalysis = analyzeGaps(discovery);
			log(
				`Gaps: ${gapAnalysis.autoFixable} auto-fixable, ${gapAnalysis.humanReview} need review`
			);

			// Auto-fix if requested
			if (opts.autoFix && gapAnalysis.autoFixable > 0) {
				log("Executing auto-fixes...");
				const fixResults = await executeAutoFixes(gapAnalysis, tokens, {
					onProgress: log,
				});
				const fixed = fixResults.filter((r) => r.success).length;
				log(`Auto-fixed ${fixed} of ${gapAnalysis.autoFixable} gaps`);
			}
		}

		// Ingest into Signet memory
		if (this.config.ingestOnBootstrap !== false) {
			log("Ingesting memories into Signet...");
			const ingestResult = await ingestDiscovery(discovery, {
				daemonPort: this.config.daemonPort,
				onProgress: log,
			});
			log(`Memory: ${ingestResult.written} written, ${ingestResult.failed} failed`);

			if (gapAnalysis) {
				await ingestGapAnalysis(gapAnalysis, discovery.locationName, {
					daemonPort: this.config.daemonPort,
				});
			}
		}

		// Save complete account
		const account: GHLConnectedAccount = {
			id: locationId,
			locationName: discovery.locationName,
			companyId: tokens.companyId,
			userId: tokens.userId,
			connectedAt: existing?.connectedAt ?? new Date().toISOString(),
			lastSyncAt: new Date().toISOString(),
			tokens,
			healthScore,
			discoveryResult: discovery,
			gapAnalysis,
		};
		await this.storage.saveAccount(account);

		log(`Bootstrap complete for ${discovery.locationName}`);
		return account;
	}

	// ── Re-Sync ────────────────────────────────────────────────────────────────

	/**
	 * Re-run discovery and re-ingest memories for an existing account.
	 * Call this on a schedule (e.g., daily) to keep the agent's context fresh.
	 */
	async syncAccount(
		locationId: string,
		opts: { onProgress?: (msg: string) => void } = {}
	): Promise<GHLConnectedAccount> {
		const account = await this.storage.getAccount(locationId);
		if (!account) throw new Error(`No account found for location ${locationId}`);

		const tokens = await ensureValidTokens(
			account.tokens,
			this.config.oauth,
			async (newTokens) => {
				account.tokens = newTokens;
				await this.storage.saveAccount(account);
			}
		);

		return this.bootstrapAccount(tokens, {
			onProgress: opts.onProgress,
			runGapAnalysis: true,
		});
	}

	// ── Account Management ────────────────────────────────────────────────────

	async getAccount(locationId: string): Promise<GHLConnectedAccount | null> {
		return this.storage.getAccount(locationId);
	}

	async getAllAccounts(): Promise<GHLConnectedAccount[]> {
		return this.storage.getAllAccounts();
	}

	async disconnectAccount(locationId: string): Promise<void> {
		await this.storage.deleteAccount(locationId);
	}
}
