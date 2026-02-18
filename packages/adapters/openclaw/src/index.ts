/**
 * Signet Adapter for OpenClaw
 *
 * Integrates Signet's memory system with OpenClaw's lifecycle hooks.
 *
 * Usage in OpenClaw config:
 * ```json
 * {
 *   "plugins": ["@signet/adapter-openclaw"],
 *   "signet": {
 *     "enabled": true,
 *     "daemonUrl": "http://localhost:3850"
 *   }
 * }
 * ```
 */

const DEFAULT_DAEMON_URL = "http://localhost:3850";

export interface SignetConfig {
	enabled?: boolean;
	daemonUrl?: string;
}

export interface SessionStartResult {
	identity: {
		name: string;
		description?: string;
	};
	memories: Array<{
		id: number;
		content: string;
		type: string;
		importance: number;
		created_at: string;
	}>;
	recentContext?: string;
	inject: string;
}

export interface PreCompactionResult {
	summaryPrompt: string;
	guidelines: string;
}

/**
 * Check if the Signet daemon is running
 */
export async function isDaemonRunning(
	daemonUrl = DEFAULT_DAEMON_URL,
): Promise<boolean> {
	try {
		const res = await fetch(`${daemonUrl}/health`, {
			signal: AbortSignal.timeout(1000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

/**
 * Called when a new session starts.
 * Returns context/memories to inject into the system prompt.
 */
export async function onSessionStart(
	harness: string,
	options: {
		daemonUrl?: string;
		agentId?: string;
		context?: string;
		sessionKey?: string;
	} = {},
): Promise<SessionStartResult | null> {
	const daemonUrl = options.daemonUrl || DEFAULT_DAEMON_URL;

	try {
		const res = await fetch(`${daemonUrl}/api/hooks/session-start`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				harness,
				agentId: options.agentId,
				context: options.context,
				sessionKey: options.sessionKey,
			}),
			signal: AbortSignal.timeout(5000),
		});

		if (!res.ok) {
			console.warn("[signet] Session start hook failed:", res.status);
			return null;
		}

		return await res.json();
	} catch (e) {
		console.warn("[signet] Session start hook error:", e);
		return null;
	}
}

/**
 * Called before session compaction/summarization.
 * Returns the prompt/guidelines for generating a session summary.
 */
export async function onPreCompaction(
	harness: string,
	options: {
		daemonUrl?: string;
		sessionContext?: string;
		messageCount?: number;
		sessionKey?: string;
	} = {},
): Promise<PreCompactionResult | null> {
	const daemonUrl = options.daemonUrl || DEFAULT_DAEMON_URL;

	try {
		const res = await fetch(`${daemonUrl}/api/hooks/pre-compaction`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				harness,
				sessionContext: options.sessionContext,
				messageCount: options.messageCount,
				sessionKey: options.sessionKey,
			}),
			signal: AbortSignal.timeout(5000),
		});

		if (!res.ok) {
			console.warn("[signet] Pre-compaction hook failed:", res.status);
			return null;
		}

		return await res.json();
	} catch (e) {
		console.warn("[signet] Pre-compaction hook error:", e);
		return null;
	}
}

/**
 * Called after compaction with the generated summary.
 * Saves the summary to Signet's memory system.
 */
export async function onCompactionComplete(
	harness: string,
	summary: string,
	options: {
		daemonUrl?: string;
		sessionKey?: string;
	} = {},
): Promise<boolean> {
	const daemonUrl = options.daemonUrl || DEFAULT_DAEMON_URL;

	try {
		const res = await fetch(`${daemonUrl}/api/hooks/compaction-complete`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				harness,
				summary,
				sessionKey: options.sessionKey,
			}),
			signal: AbortSignal.timeout(5000),
		});

		if (!res.ok) {
			console.warn("[signet] Compaction complete hook failed:", res.status);
			return false;
		}

		return true;
	} catch (e) {
		console.warn("[signet] Compaction complete hook error:", e);
		return false;
	}
}

/**
 * Manually save a memory via Signet
 */
export async function remember(
	content: string,
	options: {
		daemonUrl?: string;
		type?: string;
		importance?: number;
		tags?: string[];
		who?: string;
	} = {},
): Promise<number | null> {
	const daemonUrl = options.daemonUrl || DEFAULT_DAEMON_URL;

	try {
		const res = await fetch(`${daemonUrl}/api/memory/remember`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content,
				type: options.type,
				importance: options.importance,
				tags: options.tags,
				who: options.who || "openclaw",
			}),
			signal: AbortSignal.timeout(10000),
		});

		if (!res.ok) {
			console.warn("[signet] Remember failed:", res.status);
			return null;
		}

		const data = await res.json();
		return data.id || data.memoryId;
	} catch (e) {
		console.warn("[signet] Remember error:", e);
		return null;
	}
}

/**
 * Query memories via Signet
 */
export async function recall(
	query: string,
	options: {
		daemonUrl?: string;
		limit?: number;
		type?: string;
		minScore?: number;
	} = {},
): Promise<
	Array<{
		id: number;
		content: string;
		type: string;
		importance: number;
		score: number;
		created_at: string;
	}>
> {
	const daemonUrl = options.daemonUrl || DEFAULT_DAEMON_URL;

	try {
		const res = await fetch(`${daemonUrl}/api/memory/recall`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query,
				limit: options.limit || 10,
				type: options.type,
				min_score: options.minScore,
			}),
			signal: AbortSignal.timeout(10000),
		});

		if (!res.ok) {
			console.warn("[signet] Recall failed:", res.status);
			return [];
		}

		const data = await res.json();
		return data.results || [];
	} catch (e) {
		console.warn("[signet] Recall error:", e);
		return [];
	}
}

/**
 * Create an OpenClaw plugin that auto-integrates Signet
 */
export function createPlugin(config: SignetConfig = {}) {
	const enabled = config.enabled !== false;
	const daemonUrl = config.daemonUrl || DEFAULT_DAEMON_URL;

	return {
		name: "@signet/adapter-openclaw",

		async onSessionStart(ctx: { harness: string; sessionKey?: string }) {
			if (!enabled) return null;
			return onSessionStart(ctx.harness, {
				daemonUrl,
				sessionKey: ctx.sessionKey,
			});
		},

		async onPreCompaction(ctx: {
			harness: string;
			sessionKey?: string;
			messageCount?: number;
		}) {
			if (!enabled) return null;
			return onPreCompaction(ctx.harness, { daemonUrl, ...ctx });
		},

		async onCompactionComplete(ctx: {
			harness: string;
			summary: string;
			sessionKey?: string;
		}) {
			if (!enabled) return false;
			return onCompactionComplete(ctx.harness, ctx.summary, {
				daemonUrl,
				sessionKey: ctx.sessionKey,
			});
		},

		remember: (content: string, opts = {}) =>
			remember(content, { daemonUrl, ...opts }),
		recall: (query: string, opts = {}) => recall(query, { daemonUrl, ...opts }),
	};
}

export default createPlugin;
