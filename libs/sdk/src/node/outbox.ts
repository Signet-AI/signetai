import { SignetOutboxAdmissionError, SignetNetworkError, SignetTimeoutError } from "../errors.js";
import { resolveSignetDaemonUrl } from "@signet/core/daemon-url";
import { randomUUID } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { abortable, requestSignal, type RequestControl } from "../transport.js";
import {
	atomicPrivateWrite,
	configDirectory,
	originHash,
	readPrivate,
	type StorageOptions,
	withFileLock,
} from "./storage.js";

export const DELIVERY_SCOPE_HEADERS = [
	"x-signet-agent-id",
	"x-signet-session-key",
	"x-signet-session-id",
	"x-signet-runtime-path",
	"x-signet-harness",
] as const;
export function captureDeliveryHeaders(value: Readonly<Record<string, string>> = {}): Readonly<Record<string, string>> {
	const headers = new Headers(value);
	return Object.fromEntries(
		DELIVERY_SCOPE_HEADERS.flatMap((key) => {
			const value = headers.get(key);
			return value === null ? [] : [[key, value]];
		}),
	);
}
function parseDeliveryHeaders(value: unknown): Readonly<Record<string, string>> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Invalid outbox scope headers");
	const result: Record<string, string> = {};
	for (const [key, field] of Object.entries(value)) {
		if (!DELIVERY_SCOPE_HEADERS.some((name) => name === key) || typeof field !== "string")
			throw new Error("Invalid outbox scope header");
		result[key] = field;
	}
	return captureDeliveryHeaders(result);
}
const MAX_ENTRIES = 200;
const MAX_BYTES = 64 * 1024 * 1024;
const ENTRY_UPDATE_RESERVE = 512;
export interface OutboxRequest {
	readonly method: string;
	readonly path: string;
	readonly body: unknown;
	readonly idempotencyKey?: string;
	readonly headers?: Readonly<Record<string, string>>;
}
function snapshotRequest(request: OutboxRequest): OutboxRequest {
	const encoded = JSON.stringify(request.body);
	if (encoded === undefined) throw new TypeError("Outbox body must be JSON data");
	if (Buffer.byteLength(encoded) > MAX_BYTES) throw new RangeError("Outbox entry exceeds 64 MiB");
	const body: unknown = JSON.parse(encoded);
	return {
		method: request.method,
		path: request.path,
		body,
		idempotencyKey: request.idempotencyKey,
		headers: captureDeliveryHeaders(request.headers),
	};
}

export interface OutboxEntry {
	readonly origin: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly id: string;
	readonly idempotencyKey: string;
	readonly method: string;
	readonly path: string;
	readonly body: unknown;
	readonly createdAt: string;
	readonly attempts: number;
	readonly lastError: string | null;
}
export interface OutboxStatus {
	readonly pending: number;
	readonly bytes: number;
	readonly evicted: number;
	readonly dropped: number;
	readonly lastDrop: { id: string; status: number; at: string } | null;
}
interface Metadata {
	admitting: boolean;
	evicted: number;
	dropped: number;
	lastDrop: OutboxStatus["lastDrop"];
	removing: string[];
}
export interface OutboxFlushResult {
	readonly pending: number;
}
export interface FlushOptions extends RequestControl {
	readonly origin?: string;
	readonly force?: boolean;
}
export function deliveryPath(path: string): void {
	if (!path.startsWith("/") || path.startsWith("//") || /[\\\r\n?#]/.test(path))
		throw new TypeError("Outbox path must be daemon-relative, without query or fragment");
}
function parseEntry(value: unknown): OutboxEntry {
	if (
		typeof value !== "object" ||
		value === null ||
		!("origin" in value) ||
		typeof value.origin !== "string" ||
		!("headers" in value) ||
		!("id" in value) ||
		typeof value.id !== "string" ||
		!/^[a-f0-9-]{36}$/.test(value.id) ||
		!("idempotencyKey" in value) ||
		typeof value.idempotencyKey !== "string" ||
		!/^[\x21-\x7e]{1,512}$/.test(value.idempotencyKey) ||
		!("method" in value) ||
		value.method !== "POST" ||
		!("path" in value) ||
		typeof value.path !== "string" ||
		!("body" in value) ||
		!("createdAt" in value) ||
		typeof value.createdAt !== "string" ||
		!Number.isFinite(Date.parse(value.createdAt)) ||
		!("attempts" in value) ||
		typeof value.attempts !== "number" ||
		!Number.isSafeInteger(value.attempts) ||
		value.attempts < 0 ||
		!("lastError" in value) ||
		(value.lastError !== null && typeof value.lastError !== "string")
	)
		throw new Error("Corrupt Signet outbox entry");
	deliveryPath(value.path);
	return {
		origin: resolveSignetDaemonUrl({ env: {}, configUrl: value.origin }),
		headers: parseDeliveryHeaders(value.headers),
		id: value.id,
		idempotencyKey: value.idempotencyKey,
		method: value.method,
		path: value.path,
		body: value.body,
		createdAt: value.createdAt,
		attempts: value.attempts,
		lastError: value.lastError,
	};
}
function statusCode(error: unknown): number | null {
	return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
		? error.status
		: null;
}
export class DurableOutbox {
	readonly directory: string;
	readonly origin: string;
	constructor(origin: string, options: StorageOptions = {}) {
		this.origin = resolveSignetDaemonUrl({ env: {}, configUrl: origin });
		this.directory = join(configDirectory(options), "outbox", originHash(this.origin));
	}
	private file(id: string): string {
		if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid outbox id");
		return join(this.directory, `${id}.json`);
	}
	private async metadata(): Promise<Metadata> {
		const text = await readPrivate(join(this.directory, ".status.json"));
		if (!text) return { evicted: 0, dropped: 0, lastDrop: null, removing: [], admitting: false };
		const value: unknown = JSON.parse(text);
		if (
			typeof value !== "object" ||
			value === null ||
			!("evicted" in value) ||
			typeof value.evicted !== "number" ||
			!Number.isSafeInteger(value.evicted) ||
			value.evicted < 0 ||
			!("dropped" in value) ||
			typeof value.dropped !== "number" ||
			!Number.isSafeInteger(value.dropped) ||
			value.dropped < 0 ||
			!("removing" in value) ||
			!Array.isArray(value.removing) ||
			!value.removing.every((id: unknown) => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id))
		)
			throw new Error("Corrupt Signet outbox status");
		if ("admitting" in value && typeof value.admitting !== "boolean")
			throw new Error("Corrupt outbox admission marker");
		let lastDrop: OutboxStatus["lastDrop"] = null;
		if ("lastDrop" in value && value.lastDrop !== null) {
			const drop = value.lastDrop;
			if (
				typeof drop !== "object" ||
				!("id" in drop) ||
				typeof drop.id !== "string" ||
				!("status" in drop) ||
				typeof drop.status !== "number" ||
				!("at" in drop) ||
				typeof drop.at !== "string"
			)
				throw new Error("Corrupt Signet outbox drop");
			lastDrop = { id: drop.id, status: drop.status, at: drop.at };
		}
		return {
			evicted: value.evicted,
			dropped: value.dropped,
			lastDrop,
			removing: value.removing,
			admitting: "admitting" in value && value.admitting === true,
		};
	}
	private saveMetadata(meta: Metadata): Promise<void> {
		return atomicPrivateWrite(join(this.directory, ".status.json"), JSON.stringify(meta));
	}
	private async recover(meta: Metadata): Promise<void> {
		if (meta.removing.length) {
			for (const id of meta.removing) await rm(this.file(id), { force: true });
			meta.removing = [];
			await this.saveMetadata(meta);
		}
		if (!meta.admitting) return;
		const items = await this.list();
		let total = items.reduce((n, item) => n + item.bytes + ENTRY_UPDATE_RESERVE, 0);
		const evictions: string[] = [];
		while (items.length > MAX_ENTRIES || total > MAX_BYTES) {
			const oldest = items.shift();
			if (!oldest) break;
			evictions.push(oldest.entry.id);
			total -= oldest.bytes + ENTRY_UPDATE_RESERVE;
		}
		meta.admitting = false;
		meta.evicted += evictions.length;
		meta.removing = evictions;
		await this.saveMetadata(meta);
		await this.recover(meta);
	}
	private async list(): Promise<{ entry: OutboxEntry; bytes: number }[]> {
		const files = await readdir(this.directory);
		if (files.length > 1000) throw new Error("Signet outbox directory exceeds scan bound");
		const items: { entry: OutboxEntry; bytes: number }[] = [];
		for (const name of files.filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))) {
			const path = join(this.directory, name);
			const text = await readPrivate(path, MAX_BYTES);
			if (text === null) throw new Error("Outbox entry disappeared while locked");
			const entry = parseEntry(JSON.parse(text));
			if (`${entry.id}.json` !== name) throw new Error("Outbox entry id mismatch");
			items.push({ entry, bytes: (await stat(path)).size });
		}
		return items.sort(
			(a, b) => a.entry.createdAt.localeCompare(b.entry.createdAt) || a.entry.id.localeCompare(b.entry.id),
		);
	}
	private async remove(meta: Metadata, entry: OutboxEntry, disposition: "delivered" | number): Promise<void> {
		if (typeof disposition === "number") {
			meta.dropped++;
			meta.lastDrop = { id: entry.id, status: disposition, at: new Date().toISOString() };
		}
		meta.removing = [entry.id];
		await this.saveMetadata(meta);
		await this.recover(meta);
	}
	private async admit(request: OutboxRequest, meta: Metadata): Promise<OutboxEntry> {
		deliveryPath(request.path);
		if (request.method !== "POST") throw new TypeError("Only designated POST delivery calls belong in the outbox");
		if (request.idempotencyKey !== undefined && !/^[\x21-\x7e]{1,512}$/.test(request.idempotencyKey))
			throw new TypeError("Invalid idempotency key");
		await this.recover(meta);
		const items = await this.list();
		const last = items.at(-1)?.entry;
		const entry: OutboxEntry = {
			origin: this.origin,
			headers: captureDeliveryHeaders(request.headers),
			id: randomUUID(),
			idempotencyKey: request.idempotencyKey ?? randomUUID(),
			method: request.method,
			path: request.path,
			body: request.body,
			createdAt: new Date(Math.max(Date.now(), last ? Date.parse(last.createdAt) + 1 : 0)).toISOString(),
			attempts: 0,
			lastError: null,
		};
		const encoded = JSON.stringify(entry);
		const bytes = Buffer.byteLength(encoded) + ENTRY_UPDATE_RESERVE;
		if (bytes > MAX_BYTES) throw new RangeError("Outbox entry exceeds 64 MiB");
		const total = items.reduce((n, item) => n + item.bytes + ENTRY_UPDATE_RESERVE, 0);
		if (items.length >= MAX_ENTRIES || total + bytes > MAX_BYTES) {
			meta.admitting = true;
			await this.saveMetadata(meta);
		}
		await atomicPrivateWrite(this.file(entry.id), encoded);
		await this.recover(meta);
		return entry;
	}
	async enqueue(request: OutboxRequest, control: RequestControl = {}): Promise<OutboxEntry> {
		const scope = requestSignal(control);
		try {
			request = snapshotRequest(request);
			return await withFileLock(
				join(this.directory, ".lock"),
				async () => this.admit(request, await this.metadata()),
				scope.signal,
			);
		} finally {
			scope.cleanup();
		}
	}
	async deliver<T>(
		request: OutboxRequest,
		send: (entry: OutboxEntry) => Promise<T>,
		control: RequestControl = {},
	): Promise<{ value: T; cleanupError: Error | null }> {
		const scope = requestSignal(control);
		let admitted = false;
		let committed: { value: T } | undefined;
		try {
			request = snapshotRequest(request);
			const value = await withFileLock(
				join(this.directory, ".lock"),
				async () => {
					const meta = await this.metadata();
					const entry = await this.admit(request, meta);
					admitted = true;
					let value: T;
					try {
						value = await send(entry);
					} catch (error) {
						const status = statusCode(error);
						if (status !== null && status >= 400 && status < 500 && ![401, 408, 429].includes(status))
							await this.remove(meta, entry, status);
						else
							await atomicPrivateWrite(
								this.file(entry.id),
								JSON.stringify({ ...entry, lastError: status === null ? "network_or_deadline" : `http_${status}` }),
							);
						throw error;
					}
					committed = { value };
					await this.remove(meta, entry, "delivered");
					return value;
				},
				scope.signal,
			);
			return { value, cleanupError: null };
		} catch (error) {
			if (committed)
				return {
					value: committed.value,
					cleanupError: error instanceof Error ? error : new Error("Outbox acknowledgement failed"),
				};
			if (!admitted) throw new SignetOutboxAdmissionError(error);
			throw error;
		} finally {
			scope.cleanup();
		}
	}
	async entries(): Promise<OutboxEntry[]> {
		return withFileLock(join(this.directory, ".lock"), async () => {
			const meta = await this.metadata();
			await this.recover(meta);
			return (await this.list()).map((item) => item.entry);
		});
	}
	async status(): Promise<OutboxStatus> {
		return withFileLock(join(this.directory, ".lock"), async () => {
			const meta = await this.metadata();
			await this.recover(meta);
			const items = await this.list();
			return {
				pending: items.length,
				bytes: items.reduce((n, i) => n + i.bytes, 0),
				evicted: meta.evicted,
				dropped: meta.dropped,
				lastDrop: meta.lastDrop,
			};
		});
	}
	async flush(
		send: (entry: OutboxEntry, control: RequestControl) => Promise<unknown>,
		options: FlushOptions = {},
	): Promise<OutboxFlushResult> {
		const scope = requestSignal(options, 5000);
		try {
			return await withFileLock(
				join(this.directory, ".lock"),
				async () => {
					const meta = await this.metadata();
					await this.recover(meta);
					const items = await this.list();
					let pending = items.length;
					for (const { entry } of items) {
						if (entry.origin !== this.origin || (options.origin !== undefined && entry.origin !== options.origin))
							continue;
						scope.signal.throwIfAborted();
						const backoff = Math.min(60_000, 1000 * 2 ** Math.min(entry.attempts, 6));
						const info = await stat(this.file(entry.id));
						if (!options.force && entry.attempts && Date.now() - info.mtimeMs < backoff) break;
						try {
							await abortable(
								send(entry, { signal: scope.signal, deadline: Date.now() + Math.max(0, scope.timeoutMs) }),
								scope.signal,
							);
						} catch (error) {
							const status = statusCode(error);
							if (status !== null && status >= 400 && status < 500 && ![401, 408, 429].includes(status)) {
								await this.remove(meta, entry, status);
								pending--;
								continue;
							}
							await atomicPrivateWrite(
								this.file(entry.id),
								JSON.stringify({
									...entry,
									attempts: entry.attempts + 1,
									lastError: status === null ? "network_or_deadline" : `http_${status}`,
								}),
							);
							throw error;
						}
						await this.remove(meta, entry, "delivered");
						pending--;
					}
					return { pending };
				},
				scope.signal,
			);
		} catch (error) {
			if (scope.signal.aborted) {
				const reason: unknown = scope.signal.reason;
				if (reason instanceof Error && reason.name === "TimeoutError") throw new SignetTimeoutError(scope.timeoutMs);
				if (error instanceof SignetNetworkError) throw error;
				throw new SignetNetworkError(
					"Outbox replay cancelled",
					error instanceof Error ? error : new Error(String(error)),
				);
			}
			throw error;
		} finally {
			scope.cleanup();
		}
	}
	async purge(): Promise<void> {
		await withFileLock(join(this.directory, ".lock"), async () => {
			for (const { entry } of await this.list()) await rm(this.file(entry.id));
			await rm(join(this.directory, ".status.json"), { force: true });
		});
	}
}
