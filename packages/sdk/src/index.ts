/**
 * @signet/sdk
 * SDK for integrating Signet into applications
 */

import { Signet as SignetCore } from "@signet/core";

export interface SignetOptions {
	basePath?: string;
}

export class SignetSDK {
	private core: SignetCore;
	private connected = false;

	constructor(options: SignetOptions = {}) {
		this.core = new SignetCore(options);
	}

	/**
	 * Detect if user has a Signet agent
	 */
	static async detect(): Promise<SignetSDK | null> {
		if (SignetCore.detect()) {
			const sdk = new SignetSDK();
			await sdk.connect();
			return sdk;
		}
		return null;
	}

	/**
	 * Connect to the user's Signet agent
	 */
	async connect(): Promise<void> {
		await this.core.load();
		this.connected = true;
	}

	/**
	 * Get agent profile
	 */
	getProfile() {
		const agent = this.core.getAgent();
		if (!agent) throw new Error("Not connected");

		return {
			name: agent.manifest.agent.name,
			created: agent.manifest.agent.created,
		};
	}

	/**
	 * Get user preferences from memory
	 */
	async getPreferences(): Promise<Record<string, any>> {
		const db = this.core.getDatabase();
		if (!db) throw new Error("Not connected");

		const prefs = db.getMemories("preference");
		return Object.fromEntries(
			prefs.map((p) => [p.category || "general", p.content]),
		);
	}

	/**
	 * Search agent's memory
	 */
	async recall(query: string): Promise<string[]> {
		const db = this.core.getDatabase();
		if (!db) throw new Error("Not connected");

		const { search } = await import("@signet/core");
		const results = await search(db, { query, limit: 5 });
		return results.map((r) => r.content);
	}

	/**
	 * Store a new memory
	 */
	async remember(
		content: string,
		type: "fact" | "preference" | "decision" = "fact",
	): Promise<void> {
		const db = this.core.getDatabase();
		if (!db) throw new Error("Not connected");

		db.addMemory({
			type,
			content,
			confidence: 1.0,
			tags: [],
			updatedBy: "sdk",
			vectorClock: {},
			manualOverride: false,
		});
	}

	/**
	 * Get the owner's wallet address (if configured)
	 */
	getOwnerAddress(): string | null {
		const agent = this.core.getAgent();
		return agent?.manifest.owner?.address || null;
	}

	/**
	 * Check if connected
	 */
	isConnected(): boolean {
		return this.connected;
	}
}

// Convenience export
export const Signet = SignetSDK;
