import { parseUploadState, type UploadState } from "./capture.js";
import { SignetOutboxAdmissionError } from "../errors.js";
import { resolveSignetDaemonUrl } from "@signet/core/daemon-url";
import { randomUUID } from "node:crypto";
import { readdir, stat, lstat, chmod } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { attempt, attemptAsync } from "@signet/core/attempt";
import { ownerAlive, parseOwner, processOwner, type ProcessOwner } from "./process-owner.js";
import { abortable, requestSignal, type RequestControl } from "../transport.js";
import {
	atomicPrivateWrite,
	privateRemove as rm,
	privateRename as rename,
	isMissing,
	privateDirectory,
	PrivateFileError,
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

export interface OutboxOptions extends StorageOptions {
	readonly harness?: string;
}
export type UploadCheckpoint = (state: UploadState) => Promise<void>;
export interface OutboxEntry {
	readonly upload?: UploadState;
	readonly version: 1;
	readonly harness: string;
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
	readonly countersLost: boolean;
	readonly claimed: number;
	readonly quarantined: number;
	readonly quarantine: readonly { file: string; reason: string }[];
	readonly lastFlush: OutboxFlushResult | null;
	readonly pending: number;
	readonly bytes: number;
	readonly evicted: number;
	readonly dropped: number;
	readonly lastDrop: { id: string; status: number; at: string } | null;
}
interface Metadata {
	countersLost?: boolean;
	lastFlush?: OutboxFlushResult;
	admitting: boolean;
	evicted: number;
	dropped: number;
	lastDrop: OutboxStatus["lastDrop"];
	removing: string[];
}
export interface OutboxFlushResult {
	readonly state: "complete" | "deferred" | "failed";
	readonly pending: number | null;
	readonly sent: number;
	readonly quarantined?: number;
	readonly dropped?: number;
	readonly failure: { readonly code: string; readonly status: number | null; readonly reason: string | null } | null;
}
export interface FlushOptions extends RequestControl {
	readonly origin?: string;
	readonly harness?: string;
	readonly force?: boolean;
}
export function deliveryPath(path: string): void {
	if (!path.startsWith("/") || path.startsWith("//") || /[\\\r\n?#]/.test(path))
		throw new TypeError("Outbox path must be daemon-relative, without query or fragment");
}
class CorruptOutboxError extends Error {}
function parseEntry(value: unknown): OutboxEntry {
	if (
		typeof value !== "object" ||
		value === null ||
		!("version" in value) ||
		value.version !== 1 ||
		!("harness" in value) ||
		typeof value.harness !== "string" ||
		!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value.harness) ||
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
		throw new CorruptOutboxError("Corrupt Signet outbox entry");
	deliveryPath(value.path);
	return {
		version: 1,
		harness: value.harness,
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
		...("upload" in value ? { upload: parseUploadState(value.upload) } : {}),
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
	readonly harness: string;
	constructor(origin: string, options: OutboxOptions = {}) {
		this.origin = resolveSignetDaemonUrl({ env: {}, configUrl: origin });
		this.harness = options.harness ?? "cli";
		if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(this.harness)) throw new TypeError("Invalid connector identifier");
		this.directory = join(configDirectory(options), "outbox", originHash(this.origin), this.harness);
	}
	private file(id: string): string {
		if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid outbox id");
		return join(this.directory, `${id}.json`);
	}
	private get legacyDirectory(): string {
		return join(dirname(this.directory), ".legacy-quarantine");
	}
	private async legacyNames(): Promise<string[]> {
		const root = dirname(this.directory);
		const result: string[] = [];
		for (const name of await this.names(root)) {
			if (!name.endsWith(".json") || (name.startsWith(".") && name !== ".status.json")) continue;
			try {
				if (!(await lstat(join(root, name))).isDirectory()) result.push(name);
			} catch (error) {
				if (!isMissing(error)) throw error;
			}
		}
		return result;
	}
	private async migrateLegacy(signal?: AbortSignal): Promise<void> {
		if (!(await this.legacyNames()).length) return;
		const root = dirname(this.directory);
		await withFileLock(
			join(root, ".lock"),
			async () => {
				await privateDirectory(this.legacyDirectory);
				for (const name of await this.legacyNames()) {
					signal?.throwIfAborted();
					const reason = name === ".status.json" ? "legacy_metadata" : "legacy_unattributed";
					await rename(join(root, name), join(this.legacyDirectory, `${name}.${reason}.${randomUUID()}.json`));
				}
			},
			signal,
		);
	}
	async recoverLegacy(file: string, harness: string): Promise<OutboxEntry> {
		if (harness !== this.harness) throw new TypeError("Legacy recovery requires the selected harness");
		if (!/^[a-f0-9-]{36}\.json(?:\.legacy_unattributed\.[a-f0-9-]{36}\.json)?$/.test(file))
			throw new TypeError("Invalid legacy quarantine file");
		return withFileLock(join(this.directory, ".lock"), async () =>
			withFileLock(join(dirname(this.directory), ".lock"), async () => {
				const path = join(this.legacyDirectory, file);
				const text = await readPrivate(path, MAX_BYTES);
				if (text === null) throw new Error("Legacy evidence not found");
				const value: unknown = JSON.parse(text);
				if (typeof value !== "object" || value === null || Array.isArray(value))
					throw new CorruptOutboxError("Invalid legacy evidence");
				if (("harness" in value && value.harness !== harness) || ("version" in value && value.version !== 1))
					throw new Error("Legacy harness or version conflict");
				const entry = parseEntry({ ...value, headers: "headers" in value ? value.headers : {}, version: 1, harness });
				if (entry.origin !== this.origin || (file !== `${entry.id}.json` && !file.startsWith(`${entry.id}.json.`)))
					throw new Error("Legacy origin or id conflict");
				const items = await this.list();
				const reserved = await this.reserved();
				if (
					items.some((item) => item.entry.id === entry.id) ||
					(await this.names(join(this.directory, ".claims"))).some((name) => name.startsWith(`${entry.id}.`)) ||
					(await this.names(join(this.directory, ".quarantine"))).some((name) => name.startsWith(`${entry.id}.`))
				)
					throw new Error("Legacy entry id already exists");
				const encoded = JSON.stringify(entry);
				const bytes =
					reserved.bytes +
					items.reduce((n, item) => n + item.bytes + ENTRY_UPDATE_RESERVE, 0) -
					Buffer.byteLength(text) +
					Buffer.byteLength(encoded);
				if (items.length + reserved.count > MAX_ENTRIES || bytes > MAX_BYTES)
					throw new RangeError("Outbox capacity reserved by evidence");
				await atomicPrivateWrite(path, encoded);
				await rename(path, this.file(entry.id));
				return entry;
			}),
		);
	}
	private async metadata(): Promise<Metadata> {
		try {
			return await this.parseMetadata();
		} catch (error) {
			if (!(error instanceof PrivateFileError || error instanceof SyntaxError || error instanceof CorruptOutboxError))
				throw error;
			await this.quarantineFile(join(this.directory, ".status.json"), "bad_status");
			const meta: Metadata = {
				admitting: false,
				evicted: 0,
				dropped: 0,
				lastDrop: null,
				removing: [],
				countersLost: true,
			};
			await this.saveMetadata(meta);
			return meta;
		}
	}
	private async parseMetadata(): Promise<Metadata> {
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
			throw new CorruptOutboxError("Corrupt Signet outbox status");
		if ("admitting" in value && typeof value.admitting !== "boolean")
			throw new CorruptOutboxError("Corrupt outbox admission marker");
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
				throw new CorruptOutboxError("Corrupt Signet outbox drop");
			lastDrop = { id: drop.id, status: drop.status, at: drop.at };
		}
		return {
			lastFlush: "lastFlush" in value ? parseFlush(value.lastFlush) : undefined,
			countersLost: "countersLost" in value && value.countersLost === true,
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
		await this.reap();
		await this.recoverClaims();
		if (meta.removing.length) {
			for (const id of meta.removing) {
				await rm(this.file(id), { force: true });
				for (const name of await this.names(join(this.directory, ".claims"))) {
					if (name.startsWith(`${id}.`)) await rm(join(this.directory, ".claims", name), { force: true });
				}
			}
			meta.removing = [];
			await this.saveMetadata(meta);
		}
		if (!meta.admitting) return;
		const items = await this.list();
		const reserved = await this.reserved();
		let total = reserved.bytes + items.reduce((n, item) => n + item.bytes + ENTRY_UPDATE_RESERVE, 0);
		const evictions: string[] = [];
		while (items.length + reserved.count > MAX_ENTRIES || total > MAX_BYTES) {
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
	private async names(directory = this.directory): Promise<string[]> {
		try {
			return await readdir(directory);
		} catch (error) {
			if (isMissing(error)) return [];
			throw error;
		}
	}
	private async quarantineFile(path: string, reason: string): Promise<void> {
		const directory = join(this.directory, ".quarantine");
		await privateDirectory(directory);
		const target = join(directory, `${basename(path)}.${reason}.${randomUUID()}.json`);
		try {
			await rename(path, target);
		} catch (error) {
			if (isMissing(error)) return;
			throw error;
		}
		const info = await lstat(target);
		if (info.isFile() && process.platform !== "win32" && (!process.getuid || info.uid === process.getuid()))
			await chmod(target, 0o600);
	}
	private async reap(): Promise<void> {
		for (const dir of [
			this.directory,
			join(this.directory, ".claims"),
			join(this.directory, ".quarantine"),
			join(this.directory, ".lock.tickets"),
		])
			for (const name of await this.names(dir))
				if (name.endsWith(".tmp")) {
					const path = join(dir, name);
					try {
						if (Date.now() - (await lstat(path)).mtimeMs > 300_000) await rm(path, { force: true, recursive: true });
					} catch (error) {
						if (!isMissing(error)) throw error;
					}
				}
	}
	private async recoverClaims(): Promise<void> {
		const directory = join(this.directory, ".claims");
		for (const name of (await this.names(directory)).filter((name) => name.endsWith(".json"))) {
			const parts = /^([a-f0-9-]{36})\.([a-f0-9-]{36})\.json$/.exec(name);
			const id = parts?.[1],
				generation = parts?.[2];
			const path = join(directory, name);
			if (!id || !generation) {
				await this.quarantineFile(path, "bad_claim");
				continue;
			}
			let owner: ProcessOwner | null = null;
			try {
				const text = await readPrivate(`${path}.owner`, 4096);
				owner = text === null ? null : parseOwner(attempt(() => JSON.parse(text)));
			} catch (error) {
				if (!(error instanceof PrivateFileError)) throw error;
			}
			if (owner?.token !== generation || !(await ownerAlive(owner))) {
				await rename(path, this.file(id));
				await rm(`${path}.owner`, { force: true }, false);
			}
		}
	}
	private async list(
		signal?: AbortSignal,
		files?: readonly string[],
	): Promise<{ entry: OutboxEntry; bytes: number }[]> {
		const items: { entry: OutboxEntry; bytes: number }[] = [];
		for (const name of (files ?? (await this.names())).filter(
			(name) => !name.startsWith(".") && name.endsWith(".json"),
		)) {
			signal?.throwIfAborted();
			const path = join(this.directory, name);
			try {
				const text = await readPrivate(path, MAX_BYTES);
				if (text === null) continue;
				const entry = attempt(() => parseEntry(JSON.parse(text)));
				if (!entry) throw new CorruptOutboxError("Corrupt Signet outbox entry");
				if (`${entry.id}.json` !== name) throw new CorruptOutboxError("Outbox id mismatch");
				items.push({ entry, bytes: (await stat(path)).size });
			} catch (error) {
				if (
					error instanceof PrivateFileError ||
					error instanceof SyntaxError ||
					error instanceof CorruptOutboxError ||
					error instanceof TypeError
				)
					await this.quarantineFile(path, "bad_file");
				else throw error;
			}
		}
		return items.sort(
			(a, b) => a.entry.createdAt.localeCompare(b.entry.createdAt) || a.entry.id.localeCompare(b.entry.id),
		);
	}
	private async reserved(): Promise<{
		count: number;
		bytes: number;
		claimed: number;
		quarantine: { file: string; reason: string }[];
	}> {
		let count = 0,
			bytes = 0,
			claimed = 0;
		const quarantine: { file: string; reason: string }[] = [];
		for (const directory of [
			join(this.directory, ".claims"),
			join(this.directory, ".quarantine"),
			this.legacyDirectory,
		])
			for (const name of await this.names(directory)) {
				if (!name.endsWith(".json")) continue;
				try {
					bytes +=
						(await lstat(join(directory, name))).size +
						(directory === this.legacyDirectory && name.startsWith(".status.json") ? 0 : ENTRY_UPDATE_RESERVE);
				} catch (error) {
					if (isMissing(error)) continue;
					throw error;
				}
				if (!(directory === this.legacyDirectory && name.startsWith(".status.json"))) count++;
				if (directory === join(this.directory, ".claims")) claimed++;
				else
					quarantine.push({
						file: name,
						reason:
							directory === this.legacyDirectory
								? name.startsWith(".status.json")
									? "legacy_metadata"
									: "legacy_unattributed"
								: (name.split(".").at(-3) ?? "bad_file"),
					});
			}
		return { count, bytes, claimed, quarantine };
	}
	private async claimLocked(
		entry: OutboxEntry,
		force: boolean,
	): Promise<{ entry: OutboxEntry; owner: ProcessOwner } | null> {
		if (entry.origin !== this.origin || entry.harness !== this.harness) return null;
		if (entry.attempts >= 20 || Date.now() - Date.parse(entry.createdAt) >= 7 * 86400_000) {
			await this.quarantineFile(this.file(entry.id), entry.attempts >= 20 ? "poison_attempts" : "poison_age");
			return null;
		}
		const info = await stat(this.file(entry.id));
		if (
			!force &&
			entry.attempts &&
			Date.now() - info.mtimeMs < Math.min(60_000, 1000 * 2 ** Math.min(entry.attempts, 6))
		)
			return null;
		const claimed = { ...entry, attempts: entry.attempts + 1 };
		const owner = await processOwner();
		const path = join(this.directory, ".claims", `${entry.id}.${owner.token}.json`);
		await privateDirectory(join(this.directory, ".claims"));
		await atomicPrivateWrite(this.file(entry.id), JSON.stringify(claimed));
		await atomicPrivateWrite(`${path}.owner`, JSON.stringify(owner), false);
		await rename(this.file(entry.id), path);
		return { entry: claimed, owner };
	}
	private async checkpoint(
		claim: { entry: OutboxEntry; owner: ProcessOwner },
		state: UploadState,
		signal: AbortSignal,
	): Promise<void> {
		const upload = parseUploadState(state);
		await withFileLock(
			join(this.directory, ".lock"),
			async () => {
				signal.throwIfAborted();
				const path = join(this.directory, ".claims", `${claim.entry.id}.${claim.owner.token}.json`);
				const text = await readPrivate(`${path}.owner`, 4096);
				if (text === null || parseOwner(attempt(() => JSON.parse(text)))?.token !== claim.owner.token)
					throw new Error("Upload claim ownership changed");
				const next = { ...claim.entry, upload };
				await atomicPrivateWrite(path, JSON.stringify(next));
				claim.entry = next;
			},
			signal,
		);
	}
	private async settle(
		claim: { entry: OutboxEntry; owner: ProcessOwner },
		error: unknown | null,
		signal: AbortSignal,
	): Promise<void> {
		await withFileLock(
			join(this.directory, ".lock"),
			async () => {
				signal.throwIfAborted();
				const { entry, owner } = claim;
				const path = join(this.directory, ".claims", `${entry.id}.${owner.token}.json`);
				const text = await readPrivate(`${path}.owner`, 4096);
				if (text === null || parseOwner(attempt(() => JSON.parse(text)))?.token !== owner.token) return;
				if (error === null) {
					await rm(path, { force: true });
					await rm(`${path}.owner`, { force: true }, false);
					return;
				}
				const meta = await this.metadata();
				const status = statusCode(error);
				const reason = errorReason(error);
				if (
					status === 403 &&
					[
						"agent_not_permitted",
						"agent_binding_conflict",
						"actor_conflict",
						"project_not_permitted",
						"permission",
					].includes(reason ?? "")
				) {
					await this.quarantineFile(path, `scope_${reason}`);
					await rm(`${path}.owner`, { force: true }, false);
					return;
				}
				if (entry.attempts >= 20) {
					await this.quarantineFile(path, "poison_attempts");
					await rm(`${path}.owner`, { force: true }, false);
					return;
				}
				if (status !== null && status >= 400 && status < 500 && ![401, 408, 429].includes(status)) {
					await this.remove(meta, entry, status);
					return;
				}
				await rename(path, this.file(entry.id));
				await rm(`${path}.owner`, { force: true }, false);
				await atomicPrivateWrite(
					this.file(entry.id),
					JSON.stringify({
						...entry,
						lastError:
							status === null
								? (errorReason(error) ?? (error instanceof Error ? error.name : "delivery_failed"))
								: `http_${status}`,
					}),
				);
			},
			signal,
		);
	}
	private async remove(meta: Metadata, entry: OutboxEntry, disposition: number): Promise<void> {
		meta.dropped++;
		meta.lastDrop = { id: entry.id, status: disposition, at: new Date().toISOString() };
		meta.removing = [entry.id];
		await this.saveMetadata(meta);
		await this.recover(meta);
	}
	private async admit(request: OutboxRequest, meta: Metadata, signal: AbortSignal): Promise<OutboxEntry> {
		await this.migrateLegacy(signal);
		deliveryPath(request.path);
		if (request.method !== "POST") throw new TypeError("Only designated POST delivery calls belong in the outbox");
		if (request.idempotencyKey !== undefined && !/^[\x21-\x7e]{1,512}$/.test(request.idempotencyKey))
			throw new TypeError("Invalid idempotency key");
		await this.recover(meta);
		const items = await this.list();
		const last = items.at(-1)?.entry;
		const entry: OutboxEntry = {
			version: 1,
			harness: this.harness,
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
		const reserved = await this.reserved();
		if (reserved.count >= MAX_ENTRIES || reserved.bytes + bytes > MAX_BYTES)
			throw new RangeError("Outbox capacity reserved by claims or quarantined evidence");
		const total = reserved.bytes + items.reduce((n, item) => n + item.bytes + ENTRY_UPDATE_RESERVE, 0);
		if (items.length + reserved.count >= MAX_ENTRIES || total + bytes > MAX_BYTES) {
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
				async () => this.admit(request, await this.metadata(), scope.signal),
				scope.signal,
			);
		} finally {
			scope.cleanup();
		}
	}
	async deliver<T>(
		request: OutboxRequest,
		send: (entry: OutboxEntry, checkpoint: UploadCheckpoint) => Promise<T>,
		control: RequestControl = {},
	): Promise<{ value: T; cleanupError: Error | null }> {
		const scope = requestSignal(control);
		let claim: { entry: OutboxEntry; owner: ProcessOwner };
		try {
			request = snapshotRequest(request);
			const result = await withFileLock(
				join(this.directory, ".lock"),
				async () => {
					const entry = await this.admit(request, await this.metadata(), scope.signal);
					return this.claimLocked(entry, true);
				},
				scope.signal,
			);
			if (!result) throw new Error("Delivery was not claimed");
			claim = result;
		} catch (error) {
			scope.cleanup();
			throw new SignetOutboxAdmissionError(error);
		}
		try {
			let value: T;
			try {
				scope.signal.throwIfAborted();
				value = await abortable(
					send(claim.entry, (state) => this.checkpoint(claim, state, scope.signal)),
					scope.signal,
				);
			} catch (error) {
				if (!scope.signal.aborted) await attemptAsync(() => this.settle(claim, error, scope.signal));
				throw error;
			}
			try {
				await this.settle(claim, null, scope.signal);
				return { value, cleanupError: null };
			} catch (error) {
				return { value, cleanupError: error instanceof Error ? error : new Error("Acknowledgement failed") };
			}
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
			await this.migrateLegacy();
			const meta = await this.metadata();
			await this.recover(meta);
			const items = await this.list();
			const reserved = await this.reserved();
			return {
				countersLost: meta.countersLost ?? false,
				claimed: reserved.claimed,
				quarantined: reserved.quarantine.length,
				quarantine: reserved.quarantine,
				lastFlush: meta.lastFlush ?? null,
				pending: items.length + reserved.claimed,
				bytes: reserved.bytes - reserved.count * ENTRY_UPDATE_RESERVE + items.reduce((n, i) => n + i.bytes, 0),
				evicted: meta.evicted,
				dropped: meta.dropped,
				lastDrop: meta.lastDrop,
			};
		});
	}
	async flush(
		send: (entry: OutboxEntry, control: RequestControl, checkpoint: UploadCheckpoint) => Promise<unknown>,
		options: FlushOptions = {},
	): Promise<OutboxFlushResult> {
		const scope = requestSignal(options, 5000);
		try {
			scope.signal.throwIfAborted();
			return await this.flushOwned(send, { ...options, signal: scope.signal, deadline: Date.now() + scope.timeoutMs });
		} catch (error) {
			return { state: "failed", pending: null, sent: 0, failure: flushFailure(error) };
		} finally {
			scope.cleanup();
		}
	}
	private async flushOwned(
		send: (entry: OutboxEntry, control: RequestControl, checkpoint: UploadCheckpoint) => Promise<unknown>,
		options: FlushOptions = {},
	): Promise<OutboxFlushResult> {
		if (
			(options.origin !== undefined && options.origin !== this.origin) ||
			(options.harness !== undefined && options.harness !== this.harness)
		)
			return {
				state: "deferred",
				pending: null,
				sent: 0,
				failure: { code: "partition_mismatch", status: null, reason: null },
			};
		await this.migrateLegacy(options.signal);
		if (
			!(await this.names()).some((name) => !name.startsWith(".") && name.endsWith(".json")) &&
			!(await this.names(join(this.directory, ".claims"))).some((name) => name.endsWith(".json"))
		) {
			const quarantined = [
				...(await this.names(join(this.directory, ".quarantine"))),
				...(await this.names(this.legacyDirectory)),
			].filter((name) => name.endsWith(".json")).length;
			return { state: quarantined ? "deferred" : "complete", pending: 0, sent: 0, failure: null, quarantined };
		}
		const scope = requestSignal(options, 5000);
		const deadline = Date.now() + scope.timeoutMs;
		let sent = 0;
		let failure: OutboxFlushResult["failure"] = null;
		try {
			const ids = await withFileLock(
				join(this.directory, ".lock"),
				async () => {
					const meta = await this.metadata();
					await this.recover(meta);
					return (await this.list(scope.signal)).map((entry) => entry.entry.id);
				},
				scope.signal,
			);
			for (const id of ids) {
				scope.signal.throwIfAborted();
				const claim = await withFileLock(
					join(this.directory, ".lock"),
					async () => {
						const item = (await this.list(scope.signal, [`${id}.json`])).find((item) => item.entry.id === id);
						return item ? this.claimLocked(item.entry, options.force ?? false) : null;
					},
					scope.signal,
				);
				if (!claim) continue;
				try {
					scope.signal.throwIfAborted();
					const sendScope = requestSignal(
						{ signal: scope.signal, deadline: Math.min(deadline, Date.now() + 60_000) },
						60_000,
					);
					try {
						await abortable(
							send(claim.entry, { signal: sendScope.signal, deadline: Date.now() + sendScope.timeoutMs }, (state) =>
								this.checkpoint(claim, state, sendScope.signal),
							),
							sendScope.signal,
						);
					} finally {
						sendScope.cleanup();
					}
					await this.settle(claim, null, scope.signal);
					sent++;
				} catch (error) {
					const settled = scope.signal.aborted
						? undefined
						: await attemptAsync(async () => {
								await this.settle(claim, error, scope.signal);
								return true;
							});
					if (!settled) {
						failure = flushFailure(error);
						break;
					}
					const status = statusCode(error);
					if (status !== null && status >= 400 && status < 500 && ![401, 408, 429].includes(status)) {
						failure = flushFailure(error);
						continue;
					}
					failure = flushFailure(error);
					break;
				}
			}
		} catch (error) {
			failure = flushFailure(error);
		}
		try {
			scope.signal.throwIfAborted();
			return await withFileLock(
				join(this.directory, ".lock"),
				async () => {
					const meta = await this.metadata();
					await this.recover(meta);
					const pending = (await this.list()).length;
					const reserved = await this.reserved();
					const result: OutboxFlushResult = {
						state: failure
							? "failed"
							: pending || reserved.claimed || reserved.quarantine.length
								? "deferred"
								: "complete",
						pending: pending + reserved.claimed,
						sent,
						quarantined: reserved.quarantine.length,
						dropped: meta.dropped,
						failure,
					};
					meta.lastFlush = result;
					await this.saveMetadata(meta);
					return result;
				},
				scope.signal,
			);
		} catch (error) {
			return { state: "failed", pending: null, sent, failure: failure ?? flushFailure(error) };
		} finally {
			scope.cleanup();
		}
	}
	async purge(options: { readonly includeLegacy?: boolean } = {}): Promise<void> {
		await withFileLock(join(this.directory, ".lock"), async () => {
			await this.migrateLegacy();
			if (options.includeLegacy)
				await withFileLock(join(dirname(this.directory), ".lock"), async () => {
					await rm(this.legacyDirectory, { recursive: true, force: true });
				});
			for (const name of await this.names()) {
				if (name === ".lock.tickets") continue;
				await rm(join(this.directory, name), { recursive: true, force: true });
			}
			if ((await this.names()).some((name) => name !== ".lock.tickets"))
				throw new Error("Outbox purge could not be verified");
		});
	}
}
function errorReason(error: unknown): string | null {
	return typeof error === "object" && error !== null && "reason" in error && typeof error.reason === "string"
		? error.reason
		: null;
}
function flushFailure(error: unknown): NonNullable<OutboxFlushResult["failure"]> {
	return {
		code: error instanceof Error ? error.name : "replay_failed",
		status: statusCode(error),
		reason: errorReason(error),
	};
}
function parseFlush(value: unknown): OutboxFlushResult | undefined {
	if (
		typeof value !== "object" ||
		value === null ||
		!("state" in value) ||
		!["complete", "deferred", "failed"].includes(String(value.state)) ||
		!("pending" in value) ||
		typeof value.pending !== "number" ||
		!("sent" in value) ||
		typeof value.sent !== "number" ||
		!("failure" in value)
	)
		return undefined;
	const state = value.state;
	if (state !== "complete" && state !== "deferred" && state !== "failed") return undefined;
	const error = value.failure;
	const failure =
		typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
			? { code: error.code, status: statusCode(error), reason: errorReason(error) }
			: null;
	return { state, pending: value.pending, sent: value.sent, failure };
}
