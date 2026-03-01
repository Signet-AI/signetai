/**
 * HTTP client for the Signet daemon.
 *
 * Thin wrapper around fetch for calling hook endpoints and
 * consuming the SSE log stream.
 */

import type {
	DaemonStatus,
	LogEntry,
	PreCompactionRequest,
	PreCompactionResponse,
	RecallRequest,
	RecallResponse,
	RememberRequest,
	RememberResponse,
	SessionEndRequest,
	SessionEndResponse,
	SessionStartRequest,
	SessionStartResponse,
	TelemetryEvent,
	UserPromptSubmitRequest,
	UserPromptSubmitResponse,
} from "./types.js";

export interface DaemonClientOptions {
	readonly host?: string;
	readonly port?: number;
}

export class DaemonClient {
	private readonly baseUrl: string;

	constructor(options: DaemonClientOptions = {}) {
		const host = options.host ?? process.env.SIGNET_HOST ?? "localhost";
		const port = options.port ?? (Number(process.env.SIGNET_PORT) || 3850);
		this.baseUrl = `http://${host}:${port}`;
	}

	// =========================================================================
	// Health
	// =========================================================================

	async health(): Promise<boolean> {
		try {
			const res = await fetch(`${this.baseUrl}/health`, {
				signal: AbortSignal.timeout(3000),
			});
			return res.ok;
		} catch {
			return false;
		}
	}

	async status(): Promise<DaemonStatus> {
		const res = await this.post<Record<string, never>, DaemonStatus>(
			"/api/status",
			{},
			"GET",
		);
		return res;
	}

	// =========================================================================
	// Hooks
	// =========================================================================

	async sessionStart(
		body: SessionStartRequest,
	): Promise<SessionStartResponse> {
		return this.post("/api/hooks/session-start", body);
	}

	async userPromptSubmit(
		body: UserPromptSubmitRequest,
	): Promise<UserPromptSubmitResponse> {
		return this.post("/api/hooks/user-prompt-submit", body);
	}

	async sessionEnd(body: SessionEndRequest): Promise<SessionEndResponse> {
		return this.post("/api/hooks/session-end", body);
	}

	async preCompaction(
		body: PreCompactionRequest,
	): Promise<PreCompactionResponse> {
		return this.post("/api/hooks/pre-compaction", body);
	}

	async remember(body: RememberRequest): Promise<RememberResponse> {
		return this.post("/api/hooks/remember", body);
	}

	async recall(body: RecallRequest): Promise<RecallResponse> {
		return this.post("/api/hooks/recall", body);
	}

	// =========================================================================
	// Telemetry
	// =========================================================================

	async telemetryEvents(
		event?: string,
		limit?: number,
	): Promise<ReadonlyArray<TelemetryEvent>> {
		const params = new URLSearchParams();
		if (event) params.set("event", event);
		if (limit !== undefined) params.set("limit", String(limit));
		const qs = params.toString();
		const url = `${this.baseUrl}/api/telemetry/events${qs ? `?${qs}` : ""}`;
		const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
		if (!res.ok) return [];
		return (await res.json()) as TelemetryEvent[];
	}

	// =========================================================================
	// Log Stream (SSE)
	// =========================================================================

	/**
	 * Connect to the daemon's SSE log stream.
	 * Returns a cleanup function that closes the connection.
	 */
	streamLogs(
		onEvent: (entry: LogEntry) => void,
		onError?: (error: Error) => void,
	): () => void {
		const controller = new AbortController();

		const connect = async (): Promise<void> => {
			try {
				const res = await fetch(`${this.baseUrl}/api/logs/stream`, {
					signal: controller.signal,
					headers: { Accept: "text/event-stream" },
				});

				if (!res.ok || !res.body) {
					onError?.(new Error(`SSE connection failed: ${res.status}`));
					return;
				}

				const reader = res.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";

				while (!controller.signal.aborted) {
					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";

					for (const line of lines) {
						if (!line.startsWith("data: ")) continue;
						const json = line.slice(6).trim();
						if (!json) continue;
						try {
							const entry = JSON.parse(json) as LogEntry;
							onEvent(entry);
						} catch {
							// skip malformed entries
						}
					}
				}
			} catch (err) {
				if (!controller.signal.aborted) {
					onError?.(
						err instanceof Error ? err : new Error(String(err)),
					);
				}
			}
		};

		connect();

		return () => {
			controller.abort();
		};
	}

	// =========================================================================
	// Internal
	// =========================================================================

	private async post<TBody, TResponse>(
		path: string,
		body: TBody,
		method: "GET" | "POST" = "POST",
	): Promise<TResponse> {
		const url = `${this.baseUrl}${path}`;
		const options: RequestInit = {
			method,
			signal: AbortSignal.timeout(10000),
			headers: {
				"Content-Type": "application/json",
				"x-signet-runtime-path": "plugin",
			},
		};

		if (method === "POST") {
			options.body = JSON.stringify(body);
		}

		const res = await fetch(url, options);
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(
				`Daemon request failed: ${method} ${path} → ${res.status} ${text}`,
			);
		}

		return (await res.json()) as TResponse;
	}
}
