import { readToken } from "./session";
interface Entry {
	value: unknown;
	updatedAt: number;
	touchedAt: number;
	bytes: number;
}
export interface QueryResult<T> {
	data: T | null;
	error: string | null;
	updatedAt: number;
}
export class QueryCache {
	private entries = new Map<string, Entry>();
	private pending = new Map<string, Promise<QueryResult<unknown>>>();
	private listeners = new Map<string, Set<(invalidated: boolean) => void>>();
	private generation = 0;
	private invalidated = new Set<Promise<QueryResult<unknown>>>();
	private failures = new Set<string>();
	private statusListeners = new Set<() => void>();
	subscribeStatus = (listener: () => void): (() => void) => {
		this.statusListeners.add(listener);
		return () => {
			this.statusListeners.delete(listener);
		};
	};
	unavailableReads = (): number => [...this.failures].filter((key) => this.listeners.has(key)).length;
	private notifyStatus(): void {
		for (const listener of this.statusListeners) listener();
	}

	constructor(
		private limits = { entries: 48, bytes: 12 * 1024 * 1024, entryBytes: 4 * 1024 * 1024, retentionMs: 5 * 60_000 },
		private now = Date.now,
	) {}
	read<T>(key: string): QueryResult<T> {
		this.prune();
		const entry = this.entries.get(key);
		if (entry) entry.touchedAt = this.now();
		return { data: (entry?.value as T) ?? null, error: null, updatedAt: entry?.updatedAt ?? 0 };
	}
	subscribe(key: string, listener: (invalidated: boolean) => void): () => void {
		const listeners = this.listeners.get(key) ?? new Set();
		listeners.add(listener);
		this.listeners.set(key, listeners);
		this.notifyStatus();
		return () => {
			listeners.delete(listener);
			if (!listeners.size) {
				this.listeners.delete(key);
				this.failures.delete(key);
			}
			this.notifyStatus();
		};
	}
	clear(revalidate = true, notify = true): void {
		this.generation++;
		this.entries.clear();
		this.failures.clear();
		if (!notify) return;
		this.notifyStatus();
		for (const listeners of this.listeners.values()) for (const listener of listeners) listener(revalidate);
	}
	invalidate(matches: (key: string) => boolean = () => true): void {
		for (const [key, request] of this.pending) if (matches(key)) this.invalidated.add(request);
		for (const [key, entry] of this.entries) if (matches(key)) entry.updatedAt = 0;
		for (const [key, listeners] of this.listeners) if (matches(key)) for (const listener of listeners) listener(true);
	}
	async fetch<T>(
		key: string,
		fetcher: () => Promise<T | null>,
		staleMs: number,
		force = false,
	): Promise<QueryResult<T>> {
		const cached = this.read<T>(key);
		if (!force && cached.data !== null && this.now() - cached.updatedAt < staleMs) return cached;
		const pending = this.pending.get(key);
		if (pending) return pending as Promise<QueryResult<T>>;
		if (this.pending.size >= 32) return { ...cached, error: "Waiting for other dashboard requests to finish." };
		const generation = this.generation;
		const request = Promise.resolve()
			.then(fetcher)
			.then((value): QueryResult<T> => {
				if (generation !== this.generation)
					return { data: null, error: "Dashboard data changed. Refresh required.", updatedAt: 0 };
				if (this.invalidated.has(request as Promise<QueryResult<unknown>>))
					return { ...this.read<T>(key), error: "Dashboard data changed. Refresh required." };
				const failure = readFailure(value);
				if (failure) {
					if (this.listeners.has(key)) this.failures.add(key);
					this.notifyStatus();
					const last = this.read<T>(key);
					const data = last.data ?? value;
					return {
						...last,
						data: data && typeof data === "object" && "error" in data ? { ...data, error: failure } : data,
						error: failure,
					};
				}
				this.failures.delete(key);
				this.notifyStatus();
				const updatedAt = this.now();
				const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
				if (bytes <= this.limits.entryBytes) {
					this.entries.set(key, { value, updatedAt, touchedAt: updatedAt, bytes });
					this.prune();
					for (const listener of this.listeners.get(key) ?? []) listener(false);
				}
				return { data: value, error: null, updatedAt };
			})
			.catch(
				(error): QueryResult<T> => ({
					...this.read<T>(key),
					error: error instanceof Error ? error.message : "Dashboard request failed.",
				}),
			)
			.finally(() => {
				this.invalidated.delete(request as Promise<QueryResult<unknown>>);
				if (this.pending.get(key) === request) this.pending.delete(key);
			});
		this.pending.set(key, request as Promise<QueryResult<unknown>>);
		return request;
	}
	private prune(): void {
		const now = this.now();
		for (const [key, entry] of this.entries)
			if (now - entry.touchedAt > this.limits.retentionMs) this.entries.delete(key);
		let bytes = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
		for (const [key, entry] of [...this.entries].sort((a, b) => a[1].touchedAt - b[1].touchedAt)) {
			if (this.entries.size <= this.limits.entries && bytes <= this.limits.bytes) break;
			this.entries.delete(key);
			bytes -= entry.bytes;
		}
	}
}
function readFailure(value: unknown): string | null {
	if (value === null || value === undefined) return "Daemon data is unavailable.";
	if (typeof value === "object" && "error" in value && value.error) return String(value.error);
	if (typeof value === "object" && "memories" in value && value.memories === null) return "Memories are unavailable.";
	return null;
}
export const dashboardQueryCache = new QueryCache();
let scope: string | undefined;
export function scopedQueryKey(key: string): string {
	const current = `${typeof location === "undefined" ? "" : location.origin}:${readToken() ?? ""}`;
	if (scope !== current) {
		scope = current;
		dashboardQueryCache.clear(false, false);
	}
	return `${current}:${key}`;
}
