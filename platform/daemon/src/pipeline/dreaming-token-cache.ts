import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { resolveEmbeddedWorkerPath } from "../native-runtime-assets";
import { tokenizerWasmPath } from "./tokenizer";

export interface DreamingBacklogTokenEntry {
	readonly key: string;
	/** Must change whenever the canonical rendered evidence changes. */
	readonly revision: string;
	readonly text: string;
}

interface CachedTokenEntry {
	readonly revision: string;
	readonly count: number;
}

interface CachedTotal {
	readonly count: number;
	readonly measuredAtMs: number;
}

interface CountResponse {
	readonly type: "counted";
	readonly requestId: number;
	readonly counts: readonly { readonly key: string; readonly count: number }[];
}

function resolveWorkerPath(): string {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const bundled = join(moduleDir, "dreaming-token-worker.js");
	return existsSync(bundled)
		? bundled
		: (resolveEmbeddedWorkerPath("dreaming-token-worker") ?? join(moduleDir, "dreaming-token-worker.ts"));
}

export interface DreamingBacklogTokenBatchResult {
	readonly tokens: number;
	readonly entriesCounted: number;
}

export interface DreamingBacklogTokenMeasurement {
	readonly generation: number;
	readonly lifecycleGeneration: number;
}

function ensureTokenCount(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError(`${label} must be a finite non-negative safe integer`);
	}
	return value;
}

function addTokenCounts(total: number, count: number): number {
	return ensureTokenCount(total + count, "Dreaming token count");
}

function requestKey(
	kind: "exact" | "batch",
	agentId: string,
	entries: readonly DreamingBacklogTokenEntry[],
	stopAt?: number,
): string {
	return JSON.stringify([kind, agentId, entries.map((entry) => [entry.key, entry.revision]), stopAt]);
}

/**
 * Status is intentionally non-blocking, so a completed exact measurement is
 * usable for a short window but must not become an unbounded stale claim.
 */
const DREAMING_BACKLOG_CACHE_MAX_AGE_MS = 60_000;

/**
 * Memoized exact backlog counts. The cache key includes the source and its
 * delivered offset, while the source revision catches in-place updates without
 * retaining the complete evidence text. Entries are nested by agent ID, so an
 * agent ID containing ":" cannot collide with a source key or aggregate.
 * Partial batches only add per-entry memoization; exact refreshes alone own
 * the aggregate value and remove entries absent from their complete snapshot.
 */
export class DreamingBacklogTokenCache {
	private readonly values = new Map<string, CachedTotal>();
	private readonly entries = new Map<string, Map<string, CachedTokenEntry>>();
	private readonly generations = new Map<string, number>();
	private lifecycleGeneration = 0;
	private readonly exactInflight = new Map<string, Promise<number>>();
	private readonly batchInflight = new Map<string, Promise<DreamingBacklogTokenBatchResult>>();
	private readonly tails = new Map<string, Promise<void>>();
	private readonly workers = new Set<Worker>();

	async replaceExactSnapshot(agentId: string, entries: readonly DreamingBacklogTokenEntry[]): Promise<number> {
		const key = requestKey("exact", agentId, entries);
		const measurement = this.beginMeasurement(agentId);
		return await this.enqueue(
			agentId,
			key,
			this.exactInflight,
			async () => await this.replaceExactSnapshotNow(agentId, entries, measurement),
		);
	}

	async countEntries(
		agentId: string,
		entries: readonly DreamingBacklogTokenEntry[],
		stopAtTokens?: number,
	): Promise<DreamingBacklogTokenBatchResult> {
		const stopAt = stopAtTokens === undefined ? undefined : ensureTokenCount(stopAtTokens, "Dreaming token stop limit");
		const key = requestKey("batch", agentId, entries, stopAt);
		const lifecycleGeneration = this.lifecycleGeneration;
		return await this.enqueue(
			agentId,
			key,
			this.batchInflight,
			async () => await this.countEntriesNow(agentId, entries, stopAt, lifecycleGeneration),
		);
	}

	beginMeasurement(agentId: string): DreamingBacklogTokenMeasurement {
		return {
			generation: this.generationFor(agentId),
			lifecycleGeneration: this.lifecycleGeneration,
		};
	}

	private generationFor(agentId: string): number {
		return this.generations.get(agentId) ?? 0;
	}

	private isCurrent(agentId: string, measurement: DreamingBacklogTokenMeasurement): boolean {
		return (
			measurement.lifecycleGeneration === this.lifecycleGeneration &&
			measurement.generation === this.generationFor(agentId)
		);
	}

	get(agentId: string): number {
		return this.getFresh(agentId) ?? 0;
	}

	getFresh(agentId: string): number | null {
		const cached = this.values.get(agentId);
		if (cached === undefined) return null;
		if (Date.now() - cached.measuredAtMs > DREAMING_BACKLOG_CACHE_MAX_AGE_MS) {
			this.values.delete(agentId);
			return null;
		}
		return cached.count;
	}

	recordExactTotal(agentId: string, count: number, measurement = this.beginMeasurement(agentId)): void {
		if (!this.isCurrent(agentId, measurement)) return;
		this.values.set(agentId, {
			count: ensureTokenCount(count, "Dreaming exact token total"),
			measuredAtMs: Date.now(),
		});
	}

	invalidate(agentId: string): void {
		this.values.delete(agentId);
		this.generations.set(agentId, this.generationFor(agentId) + 1);
	}

	stop(): void {
		this.lifecycleGeneration += 1;
		for (const worker of this.workers) void worker.terminate();
		this.workers.clear();
		this.exactInflight.clear();
		this.batchInflight.clear();
		this.tails.clear();
		this.values.clear();
		this.entries.clear();
		this.generations.clear();
	}

	private async replaceExactSnapshotNow(
		agentId: string,
		entries: readonly DreamingBacklogTokenEntry[],
		measurement: DreamingBacklogTokenMeasurement,
	): Promise<number> {
		const result = await this.countEntriesNow(agentId, entries, undefined, measurement.lifecycleGeneration);
		if (!this.isCurrent(agentId, measurement)) return result.tokens;
		const nextKeys = new Set(entries.map((entry) => entry.key));
		const agentEntries = this.entries.get(agentId);
		if (agentEntries === undefined) {
			throw new Error(`Missing Dreaming token cache state for ${agentId}`);
		}
		for (const key of agentEntries.keys()) {
			if (!nextKeys.has(key)) agentEntries.delete(key);
		}
		this.recordExactTotal(agentId, result.tokens, measurement);
		return result.tokens;
	}

	private async countEntriesNow(
		agentId: string,
		entries: readonly DreamingBacklogTokenEntry[],
		stopAtTokens: number | undefined,
		lifecycleGeneration: number,
	): Promise<DreamingBacklogTokenBatchResult> {
		const agentEntries = this.entries.get(agentId) ?? new Map<string, CachedTokenEntry>();
		this.entries.set(agentId, agentEntries);
		if (entries.length === 0 || stopAtTokens === 0) return { tokens: 0, entriesCounted: 0 };

		let tokens = 0;
		let entriesCounted = 0;
		let index = 0;
		while (index < entries.length) {
			const entry = entries[index];
			if (entry === undefined) break;
			const cached = agentEntries.get(entry.key);
			if (cached !== undefined && cached.revision === entry.revision) {
				tokens = addTokenCounts(tokens, ensureTokenCount(cached.count, `Dreaming token count for ${entry.key}`));
				entriesCounted += 1;
				index += 1;
				if (stopAtTokens !== undefined && tokens >= stopAtTokens) return { tokens, entriesCounted };
				continue;
			}

			let end = index;
			while (end < entries.length) {
				const candidate = entries[end];
				if (candidate === undefined) break;
				const candidateCached = agentEntries.get(candidate.key);
				if (candidateCached !== undefined && candidateCached.revision === candidate.revision) break;
				end += 1;
			}
			const segment = entries.slice(index, end);
			const counts = await this.count(segment, stopAtTokens === undefined ? undefined : stopAtTokens - tokens);
			if (lifecycleGeneration !== this.lifecycleGeneration) {
				throw new Error("Dreaming token cache stopped during measurement");
			}
			if (counts.length === 0) throw new Error(`Dreaming token worker omitted ${entry.key}`);
			for (let resultIndex = 0; resultIndex < counts.length; resultIndex += 1) {
				const candidate = segment[resultIndex];
				const result = counts[resultIndex];
				if (candidate === undefined || result === undefined || result.key !== candidate.key) {
					throw new Error(`Dreaming token worker returned an unexpected entry near ${entry.key}`);
				}
				const count = ensureTokenCount(result.count, `Dreaming token count for ${candidate.key}`);
				agentEntries.set(candidate.key, { revision: candidate.revision, count });
				tokens = addTokenCounts(tokens, count);
				entriesCounted += 1;
			}
			if (counts.length < segment.length) return { tokens, entriesCounted };
			index = end;
		}
		return { tokens, entriesCounted };
	}

	private async count(
		entries: readonly DreamingBacklogTokenEntry[],
		stopAtTokens?: number,
	): Promise<readonly { readonly key: string; readonly count: number }[]> {
		const worker = new Worker(resolveWorkerPath(), { workerData: { tokenizerWasmPath } });
		this.workers.add(worker);
		try {
			return await new Promise((resolve, reject) => {
				worker.once("message", (message: CountResponse) => resolve(message.counts));
				worker.once("error", reject);
				worker.once("exit", (code) => reject(new Error(`Dreaming token worker exited with code ${code}`)));
				worker.postMessage({
					type: "count",
					requestId: 1,
					entries,
					...(stopAtTokens === undefined ? {} : { stopAt: stopAtTokens }),
				});
			});
		} finally {
			// Complete teardown before the next queued request can start another
			// worker; overlapping compiled worker shutdown can hang Windows.
			try {
				await worker.terminate();
			} catch {
				// The worker already exited; the request result carries the causal error.
			}
			this.workers.delete(worker);
		}
	}

	private enqueue<Result>(
		agentId: string,
		key: string,
		inflight: Map<string, Promise<Result>>,
		operation: () => Promise<Result>,
	): Promise<Result> {
		const active = inflight.get(key);
		if (active !== undefined) return active;
		const prior = this.tails.get(agentId) ?? Promise.resolve();
		const lifecycleGeneration = this.lifecycleGeneration;
		const run = (): Promise<Result> => {
			if (lifecycleGeneration !== this.lifecycleGeneration) {
				return Promise.reject(new Error("Dreaming token cache stopped during operation"));
			}
			return operation();
		};
		const promise = prior.then(run, run);
		inflight.set(key, promise);
		const tail = promise.then(
			() => undefined,
			() => undefined,
		);
		this.tails.set(agentId, tail);
		const clear = (): void => {
			if (inflight.get(key) === promise) inflight.delete(key);
			if (this.tails.get(agentId) === tail) this.tails.delete(agentId);
		};
		void promise.then(clear, clear);
		return promise;
	}
}

const dreamingBacklogTokenCache = new DreamingBacklogTokenCache();

export function refreshDreamingBacklogTokenCache(
	agentId: string,
	entries: readonly DreamingBacklogTokenEntry[],
): Promise<number> {
	return dreamingBacklogTokenCache.replaceExactSnapshot(agentId, entries);
}

export function countDreamingBacklogTokenEntries(
	agentId: string,
	entries: readonly DreamingBacklogTokenEntry[],
	stopAtTokens?: number,
): Promise<DreamingBacklogTokenBatchResult> {
	return dreamingBacklogTokenCache.countEntries(agentId, entries, stopAtTokens);
}

export function getDreamingEpisodicTokenBacklogCached(agentId: string): number {
	return dreamingBacklogTokenCache.get(agentId);
}

export function getDreamingEpisodicTokenBacklogCachedOrNull(agentId: string): number | null {
	return dreamingBacklogTokenCache.getFresh(agentId);
}

export function beginDreamingEpisodicTokenBacklogMeasurement(agentId: string): DreamingBacklogTokenMeasurement {
	return dreamingBacklogTokenCache.beginMeasurement(agentId);
}

export function invalidateDreamingEpisodicTokenBacklog(agentId: string): void {
	dreamingBacklogTokenCache.invalidate(agentId);
}
/** Record only a complete, measured backlog total in the aggregate cache. */
export function recordDreamingEpisodicTokenBacklog(
	agentId: string,
	count: number,
	measurement?: DreamingBacklogTokenMeasurement,
): void {
	dreamingBacklogTokenCache.recordExactTotal(agentId, count, measurement);
}
