import { join } from "node:path";
import { resolveSignetDaemonUrl } from "@signet/core/daemon-url";
import {
	atomicPrivateWrite,
	configDirectory,
	identifier,
	readPrivate,
	withFileLock,
	type StorageOptions,
} from "../../../../libs/sdk/src/node/storage.js";

export interface PendingRevoke {
	readonly harness: string;
	readonly url: string;
	readonly keyId: string;
}
function decode(value: unknown): PendingRevoke {
	if (
		typeof value !== "object" ||
		value === null ||
		!("harness" in value) ||
		typeof value.harness !== "string" ||
		!("url" in value) ||
		typeof value.url !== "string" ||
		!("keyId" in value) ||
		typeof value.keyId !== "string"
	)
		throw new Error("Invalid pending connector revocation");
	return {
		harness: identifier(value.harness),
		url: resolveSignetDaemonUrl({ env: {}, configUrl: value.url }),
		keyId: identifier(value.keyId),
	};
}
function same(a: PendingRevoke, b: PendingRevoke): boolean {
	return a.harness === b.harness && a.url === b.url && a.keyId === b.keyId;
}
export class PendingRevokes {
	readonly path: string;
	constructor(options: StorageOptions) {
		this.path = join(configDirectory(options), "pending-revokes.json");
	}
	async read(): Promise<PendingRevoke[]> {
		const text = await readPrivate(this.path);
		if (text === null) return [];
		const values: unknown = JSON.parse(text);
		if (!Array.isArray(values) || values.length > 1000) throw new Error("Invalid pending connector revocations");
		return values.map(decode);
	}
	async add(record: PendingRevoke): Promise<void> {
		const normalized = decode(record);
		await withFileLock(`${this.path}.lock`, async () => {
			const values = await this.read();
			if (values.some((value) => same(value, normalized))) return;
			if (values.length >= 1000) throw new Error("Pending connector revocation limit reached; run connector doctor");
			await atomicPrivateWrite(this.path, JSON.stringify([...values, normalized]));
		});
	}
	async remove(record: PendingRevoke): Promise<void> {
		await withFileLock(`${this.path}.lock`, async () => {
			await atomicPrivateWrite(this.path, JSON.stringify((await this.read()).filter((value) => !same(value, record))));
		});
	}
}
