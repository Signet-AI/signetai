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

/**
 * Memoized exact backlog counts. The cache key includes the source and its
 * delivered offset, while the text comparison catches in-place revisions.
 * Entries and counts are nested by agent ID rather than concatenated, so an
 * agent ID containing ":" cannot collide with a source key or aggregate.
 * Consumption therefore removes or changes entries on the next refresh
 * without maintaining a second counter that could drift from the evidence DB.
 */
export class DreamingBacklogTokenCache {
	private readonly values = new Map<string, number>();
	private readonly entries = new Map<string, Map<string, DreamingBacklogTokenEntry>>();
	private readonly entryValues = new Map<string, Map<string, number>>();
	private readonly inflight = new Map<string, Promise<number>>();
	private readonly workers = new Set<Worker>();

	async refresh(agentId: string, entries: readonly DreamingBacklogTokenEntry[]): Promise<number> {
		const active = this.inflight.get(agentId);
		if (active !== undefined) return active;
		const promise = this.refreshNow(agentId, entries);
		this.inflight.set(agentId, promise);
		try {
			return await promise;
		} finally {
			this.inflight.delete(agentId);
		}
	}

	get(agentId: string): number {
		return this.values.get(agentId) ?? 0;
	}

	record(agentId: string, count: number): void {
		this.values.set(agentId, count);
	}

	hasValue(agentId: string): boolean {
		return this.values.has(agentId);
	}

	stop(): void {
		for (const worker of this.workers) void worker.terminate();
		this.workers.clear();
		this.inflight.clear();
	}

	private async refreshNow(agentId: string, entries: readonly DreamingBacklogTokenEntry[]): Promise<number> {
		const nextKeys = new Set(entries.map((entry) => entry.key));
		const agentEntries = this.entries.get(agentId) ?? new Map<string, DreamingBacklogTokenEntry>();
		const agentValues = this.entryValues.get(agentId) ?? new Map<string, number>();
		this.entries.set(agentId, agentEntries);
		this.entryValues.set(agentId, agentValues);
		for (const key of agentEntries.keys()) {
			if (!nextKeys.has(key)) agentEntries.delete(key);
		}

		const uncached = entries.filter((entry) => {
			const cached = agentEntries.get(entry.key);
			return cached === undefined || cached.text !== entry.text;
		});
		if (uncached.length > 0) {
			const counts = await this.count(uncached);
			for (const entry of uncached) {
				const result = counts.find((item) => item.key === entry.key);
				if (result === undefined) throw new Error(`Dreaming token worker omitted ${entry.key}`);
				agentEntries.set(entry.key, entry);
				agentValues.set(entry.key, result.count);
			}
		}

		let total = 0;
		for (const entry of entries) {
			const count = agentValues.get(entry.key);
			if (count === undefined) throw new Error(`Missing cached Dreaming token count for ${entry.key}`);
			total += count;
		}
		for (const key of agentValues.keys()) {
			if (!nextKeys.has(key)) agentValues.delete(key);
		}
		this.values.set(agentId, total);
		return total;
	}

	private async count(
		entries: readonly DreamingBacklogTokenEntry[],
	): Promise<readonly { readonly key: string; readonly count: number }[]> {
		const worker = new Worker(resolveWorkerPath(), { workerData: { tokenizerWasmPath } });
		this.workers.add(worker);
		try {
			return await new Promise((resolve, reject) => {
				worker.once("message", (message: CountResponse) => resolve(message.counts));
				worker.once("error", reject);
				worker.once("exit", (code) => reject(new Error(`Dreaming token worker exited with code ${code}`)));
				worker.postMessage({ type: "count", requestId: 1, entries });
			});
		} finally {
			this.workers.delete(worker);
			void worker.terminate().catch(() => {
				// The worker already exited; the request result carries the causal error.
			});
		}
	}
}

const dreamingBacklogTokenCache = new DreamingBacklogTokenCache();

export function refreshDreamingBacklogTokenCache(
	agentId: string,
	entries: readonly DreamingBacklogTokenEntry[],
): Promise<number> {
	return dreamingBacklogTokenCache.refresh(agentId, entries);
}

export function getDreamingEpisodicTokenBacklogCached(agentId: string): number {
	return dreamingBacklogTokenCache.get(agentId);
}

export function recordDreamingEpisodicTokenBacklog(agentId: string, count: number): void {
	dreamingBacklogTokenCache.record(agentId, count);
}
