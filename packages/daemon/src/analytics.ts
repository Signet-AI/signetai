/**
 * In-memory analytics accumulator for the Signet daemon.
 *
 * All counters are ephemeral per daemon lifetime. The existing
 * structured logs and memory_history table provide durable backing
 * for anything that needs to survive restarts.
 */

// ---------------------------------------------------------------------------
// Error codes — stage-keyed taxonomy
// ---------------------------------------------------------------------------

export const ERROR_CODES = {
	EXTRACTION_TIMEOUT: "extraction",
	EXTRACTION_PARSE_FAIL: "extraction",
	DECISION_TIMEOUT: "decision",
	DECISION_INVALID: "decision",
	EMBEDDING_PROVIDER_DOWN: "embedding",
	EMBEDDING_TIMEOUT: "embedding",
	MUTATION_CONFLICT: "mutation",
	MUTATION_SCOPE_DENIED: "mutation",
	CONNECTOR_SYNC_FAIL: "connector",
	CONNECTOR_AUTH_FAIL: "connector",
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;
export type ErrorStage = (typeof ERROR_CODES)[ErrorCode];

// ---------------------------------------------------------------------------
// Usage counter types
// ---------------------------------------------------------------------------

export interface EndpointStats {
	readonly count: number;
	readonly errors: number;
	readonly totalLatencyMs: number;
}

export interface ActorStats {
	readonly requests: number;
	readonly remembers: number;
	readonly recalls: number;
	readonly mutations: number;
}

export interface ProviderStats {
	readonly calls: number;
	readonly failures: number;
	readonly totalLatencyMs: number;
}

export interface ConnectorStats {
	readonly syncs: number;
	readonly errors: number;
	readonly documentsProcessed: number;
}

export interface UsageCounters {
	readonly endpoints: Readonly<Record<string, EndpointStats>>;
	readonly actors: Readonly<Record<string, ActorStats>>;
	readonly providers: Readonly<Record<string, ProviderStats>>;
	readonly connectors: Readonly<Record<string, ConnectorStats>>;
}

// ---------------------------------------------------------------------------
// Error ring buffer types
// ---------------------------------------------------------------------------

export interface ErrorEntry {
	readonly timestamp: string;
	readonly stage: ErrorStage;
	readonly code: string;
	readonly message: string;
	readonly requestId?: string;
	readonly memoryId?: string;
	readonly actor?: string;
}

// ---------------------------------------------------------------------------
// Latency histogram
// ---------------------------------------------------------------------------

export type LatencyOperation = "remember" | "recall" | "mutate" | "jobs";

export interface LatencySnapshot {
	readonly p50: number;
	readonly p95: number;
	readonly p99: number;
	readonly count: number;
	readonly mean: number;
}

interface LatencyHistogram {
	record(ms: number): void;
	snapshot(): LatencySnapshot;
	readonly count: number;
}

function createLatencyHistogram(capacity = 1000): LatencyHistogram {
	const samples: number[] = [];
	let sorted = true;

	function ensureSorted(): void {
		if (!sorted) {
			samples.sort((a, b) => a - b);
			sorted = true;
		}
	}

	function percentile(p: number): number {
		ensureSorted();
		if (samples.length === 0) return 0;
		const idx = Math.ceil((p / 100) * samples.length) - 1;
		return samples[Math.max(0, idx)];
	}

	return {
		record(ms: number): void {
			if (samples.length >= capacity) {
				samples.shift();
			}
			samples.push(ms);
			sorted = false;
		},

		snapshot(): LatencySnapshot {
			if (samples.length === 0) {
				return { p50: 0, p95: 0, p99: 0, count: 0, mean: 0 };
			}
			let sum = 0;
			for (const s of samples) sum += s;
			return {
				p50: percentile(50),
				p95: percentile(95),
				p99: percentile(99),
				count: samples.length,
				mean: Math.round(sum / samples.length),
			};
		},

		get count(): number {
			return samples.length;
		},
	};
}

// ---------------------------------------------------------------------------
// Analytics collector
// ---------------------------------------------------------------------------

export interface AnalyticsCollector {
	recordRequest(
		method: string,
		path: string,
		status: number,
		durationMs: number,
		actor?: string,
	): void;

	recordProvider(
		provider: string,
		durationMs: number,
		success: boolean,
	): void;

	recordConnector(
		connectorId: string,
		event: "sync" | "error" | "document",
		count?: number,
	): void;

	recordError(entry: ErrorEntry): void;

	recordLatency(operation: LatencyOperation, ms: number): void;

	getUsage(): UsageCounters;

	getErrors(opts?: {
		stage?: ErrorStage;
		since?: string;
		limit?: number;
	}): readonly ErrorEntry[];

	getErrorSummary(): Readonly<Record<string, number>>;

	getLatency(): Readonly<Record<LatencyOperation, LatencySnapshot>>;

	reset(): void;
}

export function createAnalyticsCollector(
	errorCapacity = 500,
): AnalyticsCollector {
	const endpoints = new Map<string, Mutable<EndpointStats>>();
	const actors = new Map<string, Mutable<ActorStats>>();
	const providers = new Map<string, Mutable<ProviderStats>>();
	const connectors = new Map<string, Mutable<ConnectorStats>>();

	const errorBuffer: ErrorEntry[] = [];

	const histograms: Record<LatencyOperation, LatencyHistogram> = {
		remember: createLatencyHistogram(),
		recall: createLatencyHistogram(),
		mutate: createLatencyHistogram(),
		jobs: createLatencyHistogram(),
	};

	// Detect operation type from request path
	function classifyActor(
		path: string,
	): "remembers" | "recalls" | "mutations" | "requests" {
		if (path.includes("/remember") || path.includes("/save")) {
			return "remembers";
		}
		if (
			path.includes("/recall") ||
			path.includes("/search") ||
			path.includes("/similar")
		) {
			return "recalls";
		}
		if (
			path.includes("/modify") ||
			path.includes("/forget") ||
			path.includes("/recover")
		) {
			return "mutations";
		}
		return "requests";
	}

	return {
		recordRequest(method, path, status, durationMs, actor) {
			const key = `${method} ${path}`;
			let ep = endpoints.get(key);
			if (!ep) {
				ep = { count: 0, errors: 0, totalLatencyMs: 0 };
				endpoints.set(key, ep);
			}
			ep.count++;
			ep.totalLatencyMs += durationMs;
			if (status >= 400) ep.errors++;

			if (actor) {
				let a = actors.get(actor);
				if (!a) {
					a = { requests: 0, remembers: 0, recalls: 0, mutations: 0 };
					actors.set(actor, a);
				}
				const field = classifyActor(path);
				if (field === "requests") a.requests++;
				else a[field]++;
			}
		},

		recordProvider(provider, durationMs, success) {
			let p = providers.get(provider);
			if (!p) {
				p = { calls: 0, failures: 0, totalLatencyMs: 0 };
				providers.set(provider, p);
			}
			p.calls++;
			p.totalLatencyMs += durationMs;
			if (!success) p.failures++;
		},

		recordConnector(connectorId, event, count = 1) {
			let cs = connectors.get(connectorId);
			if (!cs) {
				cs = { syncs: 0, errors: 0, documentsProcessed: 0 };
				connectors.set(connectorId, cs);
			}
			if (event === "sync") cs.syncs += count;
			else if (event === "error") cs.errors += count;
			else cs.documentsProcessed += count;
		},

		recordError(entry) {
			if (errorBuffer.length >= errorCapacity) {
				errorBuffer.shift();
			}
			errorBuffer.push(entry);
		},

		recordLatency(operation, ms) {
			histograms[operation].record(ms);
		},

		getUsage(): UsageCounters {
			return {
				endpoints: Object.fromEntries(endpoints),
				actors: Object.fromEntries(actors),
				providers: Object.fromEntries(providers),
				connectors: Object.fromEntries(connectors),
			};
		},

		getErrors(opts) {
			const limit = opts?.limit ?? 50;
			const stage = opts?.stage;
			const since = opts?.since;

			let filtered = errorBuffer;
			if (stage) {
				filtered = filtered.filter((e) => e.stage === stage);
			}
			if (since) {
				filtered = filtered.filter((e) => e.timestamp >= since);
			}
			return filtered.slice(-limit);
		},

		getErrorSummary(): Readonly<Record<string, number>> {
			const counts: Record<string, number> = {};
			for (const e of errorBuffer) {
				counts[e.code] = (counts[e.code] ?? 0) + 1;
			}
			return counts;
		},

		getLatency() {
			return {
				remember: histograms.remember.snapshot(),
				recall: histograms.recall.snapshot(),
				mutate: histograms.mutate.snapshot(),
				jobs: histograms.jobs.snapshot(),
			};
		},

		reset() {
			endpoints.clear();
			actors.clear();
			providers.clear();
			connectors.clear();
			errorBuffer.length = 0;
			// Re-create histograms by clearing their internal state
			for (const key of Object.keys(histograms) as LatencyOperation[]) {
				histograms[key] = createLatencyHistogram();
			}
		},
	};
}

// Utility type — mutable version of a readonly interface for internal maps
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
