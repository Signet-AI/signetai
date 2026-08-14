import { existsSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { resolveEmbeddedWorkerPath } from "../native-runtime-assets";

export interface DreamingBacklogTokenEntry {
	readonly key: string;
	readonly text: string;
}

interface CountResponse {
	readonly type: "counted";
	readonly requestId: number;
	readonly counts: readonly { readonly key: string; readonly count: number }[];
}

interface PendingRequest {
	readonly resolve: (counts: readonly { readonly key: string; readonly count: number }[]) => void;
	readonly reject: (error: Error) => void;
}

interface DreamingTokenWorkerLike {
	on(event: "message", listener: (message: CountResponse) => void): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
	on(event: "exit", listener: (code: number) => void): unknown;
	postMessage(message: unknown): void;
	terminate(): Promise<number> | number;
	unref?(): void;
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
 * Consumption therefore removes or changes entries on the next refresh
 * without maintaining a second counter that could drift from the evidence DB.
 */
export class DreamingBacklogTokenCache {
	private readonly values = new Map<string, number>();
	private readonly entries = new Map<string, DreamingBacklogTokenEntry>();
	private readonly pending = new Map<number, PendingRequest>();
	private readonly inflight = new Map<string, Promise<number>>();
	private worker: DreamingTokenWorkerLike | null = null;
	private nextRequestId = 1;

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

	hasValue(agentId: string): boolean {
		return this.values.has(agentId);
	}

	stop(): void {
		const worker = this.worker;
		this.worker = null;
		if (worker !== null) void worker.terminate();
		for (const pending of this.pending.values()) pending.reject(new Error("Dreaming token worker stopped"));
		this.pending.clear();
		this.inflight.clear();
	}

	private async refreshNow(agentId: string, entries: readonly DreamingBacklogTokenEntry[]): Promise<number> {
		const nextKeys = new Set(entries.map((entry) => `${agentId}:${entry.key}`));
		for (const key of this.entries.keys()) {
			if (key.startsWith(`${agentId}:`) && !nextKeys.has(key)) this.entries.delete(key);
		}

		const uncached = entries.filter((entry) => {
			const cached = this.entries.get(`${agentId}:${entry.key}`);
			return cached === undefined || cached.text !== entry.text;
		});
		if (uncached.length > 0) {
			const counts = await this.count(uncached);
			for (const entry of uncached) {
				const result = counts.find((item) => item.key === entry.key);
				if (result === undefined) throw new Error(`Dreaming token worker omitted ${entry.key}`);
				this.entries.set(`${agentId}:${entry.key}`, entry);
				this.values.set(`${agentId}:${entry.key}`, result.count);
			}
		}

		let total = 0;
		for (const entry of entries) {
			const count = this.values.get(`${agentId}:${entry.key}`);
			if (count === undefined) throw new Error(`Missing cached Dreaming token count for ${entry.key}`);
			total += count;
		}
		for (const key of this.values.keys()) {
			if (key.startsWith(`${agentId}:`) && !nextKeys.has(key)) this.values.delete(key);
		}
		this.values.set(agentId, total);
		return total;
	}

	private count(
		entries: readonly DreamingBacklogTokenEntry[],
	): Promise<readonly { readonly key: string; readonly count: number }[]> {
		const worker = this.ensureWorker();
		const requestId = this.nextRequestId++;
		return new Promise((resolve, reject) => {
			this.pending.set(requestId, { resolve, reject });
			worker.postMessage({ type: "count", requestId, entries });
		});
	}

	private ensureWorker(): DreamingTokenWorkerLike {
		if (this.worker !== null) return this.worker;
		const worker = new Worker(resolveWorkerPath()) as unknown as DreamingTokenWorkerLike;
		worker.unref?.();
		worker.on("message", (message) => {
			const pending = this.pending.get(message.requestId);
			if (pending === undefined) return;
			this.pending.delete(message.requestId);
			pending.resolve(message.counts);
		});
		const fail = (error: Error): void => {
			for (const pending of this.pending.values()) pending.reject(error);
			this.pending.clear();
			this.worker = null;
		};
		worker.on("error", fail);
		worker.on("exit", (code) => {
			if (code !== 0) fail(new Error(`Dreaming token worker exited with code ${code}`));
			if (this.worker === worker) this.worker = null;
		});
		this.worker = worker;
		return worker;
	}
}
