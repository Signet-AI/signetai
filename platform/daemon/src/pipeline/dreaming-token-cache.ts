import { existsSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { resolveEmbeddedWorkerPath } from "../native-runtime-assets";
import { tokenizerWasmPath } from "./tokenizer";

export interface DreamingBacklogTokenEntry {
	readonly key: string;
	readonly text: string;
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

function ensureTokenCount(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError(`${label} must be a finite non-negative safe integer`);
	}
	return value;
}

function addTokenCounts(total: number, count: number): number {
	return ensureTokenCount(total + count, "Dreaming token count");
}

/**
 * Memoized exact backlog counts. The cache key includes the source and its
 * delivered offset, while the text comparison catches in-place revisions.
 * Entries and counts are nested by agent ID rather than concatenated, so an
 * agent ID containing ":" cannot collide with a source key or aggregate.
 * Partial batches only add per-entry memoization; exact refreshes alone own
 * the aggregate value and remove entries absent from their complete snapshot.
 */
export class DreamingBacklogTokenCache {
	private readonly values = new Map<string, number>();
	private readonly entries = new Map<string, Map<string, DreamingBacklogTokenEntry>>();
	private readonly entryValues = new Map<string, Map<string, number>>();
	private readonly exactInflight = new Map<string, Promise<number>>();
	private readonly batchInflight = new Map<string, Promise<DreamingBacklogTokenBatchResult>>();
	private readonly tails = new Map<string, Promise<void>>();
	private readonly workers = new Set<Worker>();

	async replaceExactSnapshot(agentId: string, entries: readonly DreamingBacklogTokenEntry[]): Promise<number> {
		const key = JSON.stringify(["exact", agentId, entries]);
		return await this.enqueue(
			agentId,
			key,
			this.exactInflight,
			async () => await this.replaceExactSnapshotNow(agentId, entries),
		);
	}

	async countEntries(
		agentId: string,
		entries: readonly DreamingBacklogTokenEntry[],
		stopAtTokens?: number,
	): Promise<DreamingBacklogTokenBatchResult> {
		const stopAt = stopAtTokens === undefined ? undefined : ensureTokenCount(stopAtTokens, "Dreaming token stop limit");
		const key = JSON.stringify(["batch", agentId, entries, stopAt]);
		return await this.enqueue(
			agentId,
			key,
			this.batchInflight,
			async () => await this.countEntriesNow(agentId, entries, stopAt),
		);
	}

	get(agentId: string): number {
		return this.values.get(agentId) ?? 0;
	}

	recordExactTotal(agentId: string, count: number): void {
		this.values.set(agentId, ensureTokenCount(count, "Dreaming exact token total"));
	}

	hasValue(agentId: string): boolean {
		return this.values.has(agentId);
	}

	stop(): void {
		for (const worker of this.workers) void worker.terminate();
		this.workers.clear();
		this.exactInflight.clear();
		this.batchInflight.clear();
		this.tails.clear();
	}

	private async replaceExactSnapshotNow(
		agentId: string,
		entries: readonly DreamingBacklogTokenEntry[],
	): Promise<number> {
		const result = await this.countEntriesNow(agentId, entries);
		const nextKeys = new Set(entries.map((entry) => entry.key));
		const agentEntries = this.entries.get(agentId);
		const agentValues = this.entryValues.get(agentId);
		if (agentEntries === undefined || agentValues === undefined) {
			throw new Error(`Missing Dreaming token cache state for ${agentId}`);
		}
		for (const key of agentEntries.keys()) {
			if (!nextKeys.has(key)) agentEntries.delete(key);
		}
		for (const key of agentValues.keys()) {
			if (!nextKeys.has(key)) agentValues.delete(key);
		}
		this.values.set(agentId, result.tokens);
		return result.tokens;
	}

	private async countEntriesNow(
		agentId: string,
		entries: readonly DreamingBacklogTokenEntry[],
		stopAtTokens?: number,
	): Promise<DreamingBacklogTokenBatchResult> {
		const agentEntries = this.entries.get(agentId) ?? new Map<string, DreamingBacklogTokenEntry>();
		const agentValues = this.entryValues.get(agentId) ?? new Map<string, number>();
		this.entries.set(agentId, agentEntries);
		this.entryValues.set(agentId, agentValues);
		if (entries.length === 0 || stopAtTokens === 0) return { tokens: 0, entriesCounted: 0 };

		let tokens = 0;
		let entriesCounted = 0;
		let index = 0;
		while (index < entries.length) {
			const entry = entries[index];
			if (entry === undefined) break;
			const cached = agentEntries.get(entry.key);
			const cachedCount = agentValues.get(entry.key);
			if (cached !== undefined && cached.text === entry.text && cachedCount !== undefined) {
				tokens = addTokenCounts(tokens, ensureTokenCount(cachedCount, `Dreaming token count for ${entry.key}`));
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
				const candidateCount = agentValues.get(candidate.key);
				if (candidateCached !== undefined && candidateCached.text === candidate.text && candidateCount !== undefined)
					break;
				end += 1;
			}
			const segment = entries.slice(index, end);
			const counts = await this.count(segment, stopAtTokens === undefined ? undefined : stopAtTokens - tokens);
			if (counts.length === 0) throw new Error(`Dreaming token worker omitted ${entry.key}`);
			for (let resultIndex = 0; resultIndex < counts.length; resultIndex += 1) {
				const candidate = segment[resultIndex];
				const result = counts[resultIndex];
				if (candidate === undefined || result === undefined || result.key !== candidate.key) {
					throw new Error(`Dreaming token worker returned an unexpected entry near ${entry.key}`);
				}
				const count = ensureTokenCount(result.count, `Dreaming token count for ${candidate.key}`);
				agentEntries.set(candidate.key, candidate);
				agentValues.set(candidate.key, count);
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
			this.workers.delete(worker);
			void worker.terminate().catch(() => {
				// The worker already exited; the request result carries the causal error.
			});
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
		const promise = prior.then(operation, operation);
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

/** Record only a complete, measured backlog total in the aggregate cache. */
export function recordDreamingEpisodicTokenBacklog(agentId: string, count: number): void {
	dreamingBacklogTokenCache.recordExactTotal(agentId, count);
}
