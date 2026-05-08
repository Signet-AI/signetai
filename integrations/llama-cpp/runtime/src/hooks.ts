/**
 * Signet session lifecycle hooks for llama.cpp runtime.
 *
 * Calls the daemon's hook endpoints to inject memories at session
 * start, recall on each prompt, and extract on session end.
 */

export interface SessionContext {
	sessionKey: string;
	daemonUrl: string;
	transcript: Array<{ role: string; content: string }>;
}

interface HookResponse {
	memory?: string;
	context?: string;
	error?: string;
}

export async function onSessionStart(ctx: SessionContext): Promise<string | null> {
	try {
		const res = await fetch(`${ctx.daemonUrl}/api/hooks/session-start`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-signet-runtime-path": "plugin",
				"x-signet-harness": "llama-cpp",
			},
			body: JSON.stringify({
				sessionKey: ctx.sessionKey,
				harness: "llama-cpp",
			}),
			signal: AbortSignal.timeout(10_000),
		});

		if (!res.ok) return null;

		const data = (await res.json()) as HookResponse;
		if (data.memory || data.context) {
			return [data.memory, data.context].filter(Boolean).join("\n\n");
		}
		return null;
	} catch {
		return null;
	}
}

export async function onUserPromptSubmit(ctx: SessionContext, userMessage: string): Promise<string | null> {
	try {
		const res = await fetch(`${ctx.daemonUrl}/api/hooks/user-prompt-submit`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-signet-runtime-path": "plugin",
				"x-signet-harness": "llama-cpp",
			},
			body: JSON.stringify({
				sessionKey: ctx.sessionKey,
				harness: "llama-cpp",
				prompt: userMessage,
				transcript: ctx.transcript,
			}),
			signal: AbortSignal.timeout(5_000),
		});

		if (!res.ok) return null;

		const data = (await res.json()) as HookResponse;
		if (data.memory || data.context) {
			return [data.memory, data.context].filter(Boolean).join("\n\n");
		}
		return null;
	} catch {
		return null;
	}
}

export async function onSessionEnd(ctx: SessionContext): Promise<void> {
	try {
		await fetch(`${ctx.daemonUrl}/api/hooks/session-end`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-signet-runtime-path": "plugin",
				"x-signet-harness": "llama-cpp",
			},
			body: JSON.stringify({
				sessionKey: ctx.sessionKey,
				harness: "llama-cpp",
				transcript: ctx.transcript,
			}),
			signal: AbortSignal.timeout(30_000),
		});
	} catch {
		// Best effort — extraction is async and can be retried
	}
}
