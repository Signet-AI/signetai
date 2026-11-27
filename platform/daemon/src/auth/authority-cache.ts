import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { DbOwnerStatement } from "../db-owner-protocol";
import { cacheableAuthorityStatement } from "./authority-epoch";

interface Entry {
	readonly version: string;
	readonly value: unknown;
}
interface CredentialReads {
	readonly credential: string;
	readonly pending: Map<string, Entry>;
	verified: boolean;
}
const reads = new AsyncLocalStorage<CredentialReads | undefined>();
const entries = new Map<string, Entry>();
let currentVersion: string | null = null;
const MAX_ENTRIES = 2048;
const MAX_VALUE_BYTES = 32768;

function remember(key: string, entry: Entry): void {
	if (entry.version !== currentVersion) return;
	entries.delete(key);
	while (entries.size >= MAX_ENTRIES) {
		const oldest = entries.keys().next().value;
		if (oldest === undefined) break;
		entries.delete(oldest);
	}
	entries.set(key, entry);
}

export function withCredentialAuthority<T>(credential: string | undefined, work: () => T): T {
	if (!credential) return work();
	return reads.run(
		{ credential: createHash("sha256").update(credential).digest("hex"), pending: new Map(), verified: false },
		work,
	);
}
export function withoutCredentialAuthority<T>(work: () => T): T {
	return reads.run(undefined, work);
}
export function acceptCredentialAuthority(): void {
	const context = reads.getStore();
	if (!context) return;
	context.verified = true;
	for (const [key, entry] of context.pending) remember(key, entry);
	context.pending.clear();
}

export async function cachedAuthorityQuery(
	statement: DbOwnerStatement,
	version: () => string | null,
	load: () => Promise<unknown>,
): Promise<unknown> {
	const context = reads.getStore();
	const stamp = context && cacheableAuthorityStatement(statement) ? version() : null;
	if (!context || stamp === null) return await load();
	if (currentVersion !== stamp) {
		entries.clear();
		currentVersion = stamp;
	}
	const sqlKey = JSON.stringify([statement.sql, statement.params, statement.result]);
	if (sqlKey.length > 8192) return await load();
	const key = createHash("sha256")
		.update(JSON.stringify([context.credential, stamp, sqlKey]))
		.digest("hex");
	const hit = entries.get(key) ?? context.pending.get(key);
	if (hit && hit.version === stamp) {
		if (entries.has(key)) remember(key, hit);
		return structuredClone(hit.value);
	}
	const value = await load();
	const json = JSON.stringify(value);
	if (version() !== stamp || Buffer.byteLength(json ?? "") > MAX_VALUE_BYTES) return value;
	const entry = { version: stamp, value: structuredClone(value) };
	if (context.verified) remember(key, entry);
	else if (context.pending.size < 32) context.pending.set(key, entry);
	return value;
}
