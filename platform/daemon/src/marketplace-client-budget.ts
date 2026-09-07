/**
 * Process and client budget for marketplace MCP operations.
 *
 * Marketplace MCP calls may create stdio child processes. Keep discovery,
 * probes, and user calls behind one daemon-wide budget so one cache refresh or
 * burst of callers cannot exhaust local process and file-descriptor limits.
 */

const DEFAULT_MAX_CONCURRENT_CLIENTS = 4;
const MAX_CONCURRENT_CLIENTS = 16;
const MAX_CLIENTS_ENV = "SIGNET_MARKETPLACE_MAX_CONCURRENT_CLIENTS";

export interface MarketplaceMcpRuntimeStatus {
	readonly activeClients: number;
	readonly activeProcesses: number;
	readonly pending: number;
	readonly limit: number;
}

export interface MarketplaceMcpClientPermit {
	readonly markProcessStarted: () => void;
	readonly release: () => void;
}

interface QueueEntry {
	readonly start: () => void;
}

export class MarketplaceMcpClientBudget {
	private readonly max: number;
	private active = 0;
	private processes = 0;
	private readonly queue: QueueEntry[] = [];

	constructor(max: number) {
		this.max = normalizeLimit(max);
	}

	async acquire(timeoutMs: number, signal?: AbortSignal): Promise<MarketplaceMcpClientPermit> {
		await this.acquireSlot(timeoutMs, signal);

		let processStarted = false;
		let released = false;
		return {
			markProcessStarted: (): void => {
				if (released || processStarted) return;
				processStarted = true;
				this.processes++;
			},
			release: (): void => {
				if (released) return;
				released = true;
				if (processStarted) this.processes--;
				this.active--;
				this.drain();
			},
		};
	}

	status(): MarketplaceMcpRuntimeStatus {
		return {
			activeClients: this.active,
			activeProcesses: this.processes,
			pending: this.queue.length,
			limit: this.max,
		};
	}

	private async acquireSlot(timeoutMs: number, signal?: AbortSignal): Promise<void> {
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
			throw new Error("marketplace MCP timeout must be positive");
		}
		if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");

		if (this.active < this.max) {
			this.active++;
			return;
		}

		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				const index = this.queue.indexOf(entry);
				if (index >= 0) this.queue.splice(index, 1);
				cleanup();
				reject(new Error(`marketplace MCP client budget timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			const cleanup = (): void => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			};
			const rejectAborted = (): void => {
				if (settled) return;
				settled = true;
				const index = this.queue.indexOf(entry);
				if (index >= 0) this.queue.splice(index, 1);
				cleanup();
				reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
			};
			const onAbort = (): void => rejectAborted();
			const entry: QueueEntry = {
				start: (): void => {
					if (settled) return;
					settled = true;
					cleanup();
					this.active++;
					resolve();
				},
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			this.queue.push(entry);
			if (signal?.aborted) rejectAborted();
		});
	}

	private drain(): void {
		while (this.active < this.max) {
			const next = this.queue.shift();
			if (!next) return;
			next.start();
		}
	}
}

function normalizeLimit(value: number): number {
	return Number.isSafeInteger(value)
		? Math.min(MAX_CONCURRENT_CLIENTS, Math.max(1, value))
		: DEFAULT_MAX_CONCURRENT_CLIENTS;
}

function configuredLimit(): number {
	const raw = process.env[MAX_CLIENTS_ENV];
	if (raw === undefined) return DEFAULT_MAX_CONCURRENT_CLIENTS;
	const parsed = Number(raw);
	return Number.isSafeInteger(parsed) && parsed >= 1 ? normalizeLimit(parsed) : DEFAULT_MAX_CONCURRENT_CLIENTS;
}

export const marketplaceMcpClientBudget = new MarketplaceMcpClientBudget(configuredLimit());

export function getMarketplaceMcpRuntimeStatus(): MarketplaceMcpRuntimeStatus {
	return marketplaceMcpClientBudget.status();
}

/**
 * Run an operation under the shared client budget and return its remaining
 * deadline after queue acquisition.
 */
export async function withMarketplaceMcpPermit<T>(
	timeoutMs: number,
	fn: (permit: MarketplaceMcpClientPermit, remainingTimeoutMs: number) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	const startedAt = Date.now();
	const permit = await marketplaceMcpClientBudget.acquire(timeoutMs, signal);
	try {
		const remainingTimeoutMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
		return await fn(permit, remainingTimeoutMs);
	} finally {
		permit.release();
	}
}

/**
 * Race an MCP operation against its deadline and close the underlying client
 * as soon as the deadline fires. Closing before releasing the permit prevents
 * timed-out stdio children from occupying an invisible slot indefinitely.
 */
export async function withMarketplaceMcpTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	label: string,
	onTimeout: () => Promise<void>,
	signal?: AbortSignal,
): Promise<T> {
	let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
	let onAbort: (() => void) | null = null;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timeoutHandle = setTimeout(() => {
					void onTimeout().catch(() => undefined);
					reject(new Error(`${label} timed out after ${timeoutMs}ms`));
				}, timeoutMs);
			}),
			...(signal
				? [
						new Promise<T>((_resolve, reject) => {
							onAbort = (): void => {
								void onTimeout().catch(() => undefined);
								reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
							};
							if (signal.aborted) {
								onAbort();
								return;
							}
							signal.addEventListener("abort", onAbort, { once: true });
						}),
					]
				: []),
		]);
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
		if (signal && onAbort) signal.removeEventListener("abort", onAbort);
	}
}
