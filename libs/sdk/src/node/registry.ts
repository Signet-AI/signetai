import { join } from "node:path";
import { resolveSignetDaemonUrl } from "@signet/core/daemon-url";
import {
	atomicPrivateWrite,
	configDirectory,
	identifier,
	originHash,
	readPrivate,
	type StorageOptions,
	withFileLock,
} from "./storage.js";

export interface ConnectorEntry {
	readonly url: string;
	readonly keyFile?: string;
	readonly agentId?: string;
	readonly deviceId?: string;
	readonly keyId?: string;
}
function entry(value: unknown): ConnectorEntry {
	if (typeof value !== "object" || value === null || !("url" in value) || typeof value.url !== "string")
		throw new TypeError("Invalid connector registry entry");
	for (const [key, field] of Object.entries(value))
		if (["keyFile", "agentId", "deviceId", "keyId"].includes(key) && typeof field !== "string")
			throw new TypeError(`Invalid connector ${key}`);
	return {
		url: resolveSignetDaemonUrl({ env: {}, configUrl: value.url }),
		...("keyFile" in value && typeof value.keyFile === "string" ? { keyFile: value.keyFile } : {}),
		...("agentId" in value && typeof value.agentId === "string" ? { agentId: value.agentId } : {}),
		...("deviceId" in value && typeof value.deviceId === "string" ? { deviceId: value.deviceId } : {}),
		...("keyId" in value && typeof value.keyId === "string" ? { keyId: value.keyId } : {}),
	};
}
export class ConnectorRegistry {
	readonly path: string;
	constructor(options: StorageOptions = {}) {
		this.path = join(configDirectory(options), "connectors.json");
	}
	async read(): Promise<Record<string, ConnectorEntry>> {
		const text = await readPrivate(this.path);
		if (text === null) return {};
		const value: unknown = JSON.parse(text);
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new TypeError("Invalid connector registry");
		const entries: [string, ConnectorEntry][] = [];
		for (const [key, v] of Object.entries(value)) entries.push([identifier(key), entry(v)]);
		return Object.fromEntries(entries);
	}
	async set(harness: string, value: ConnectorEntry): Promise<void> {
		identifier(harness);
		const normalized = entry(value);
		await withFileLock(`${this.path}.lock`, async () => {
			const values = await this.read();
			Object.defineProperty(values, harness, { value: normalized, enumerable: true, configurable: true });
			await atomicPrivateWrite(this.path, JSON.stringify(values));
		});
	}
	async remove(harness: string): Promise<void> {
		identifier(harness);
		await withFileLock(`${this.path}.lock`, async () => {
			const values = await this.read();
			delete values[harness];
			await atomicPrivateWrite(this.path, JSON.stringify(values));
		});
	}
}
export async function writeKeyFile(
	origin: string,
	harness: string,
	credential: string,
	options: StorageOptions = {},
): Promise<string> {
	if (!credential.trim() || /[\r\n]/.test(credential)) throw new TypeError("Invalid connector credential");
	const path = join(configDirectory(options), "keys", originHash(origin), `${identifier(harness)}.key`);
	await atomicPrivateWrite(path, credential);
	return path;
}
export async function readKeyFile(path: string): Promise<string> {
	const value = await readPrivate(path, 64 * 1024, true);
	if (value === null) throw new Error(`Credential key file is missing: ${path}`);
	const trimmed = value.trim();
	if (!trimmed || /[\r\n]/.test(trimmed)) throw new Error("Invalid credential key file");
	return trimmed;
}
