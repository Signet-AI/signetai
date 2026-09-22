import { createHash } from "node:crypto";
import { mkdir, readdir, rename, stat, lstat, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export type ImportStatus = "pending" | "processing" | "imported" | "duplicate" | "failed" | "quarantined";
export interface ImportRow {
	key: string;
	fileName: string;
	status: ImportStatus;
	originalPath: string;
	sha256: string;
	size: number;
	error?: string;
}
export interface ImportLedger {
	upsert(row: ImportRow): ImportRow;
	find(key: string): ImportRow | undefined;
	/** Optional durable event hook owned by the daemon database adapter. */
	appendEvent?(key: string, event: string): void;
}
export interface InboxOptions {
	root: string;
	ledger: ImportLedger;
	maxFiles?: number;
	maxFileBytes?: number;
}
export interface Admission {
	root: string;
	fileName: string;
	bytes: Uint8Array;
	ledger: ImportLedger;
	idempotencyKey?: string;
	maxFileBytes?: number;
}

const DEFAULT_MAX = 25 * 1024 * 1024;
const keyFor = (bytes: Uint8Array, name: string, supplied?: string) =>
	supplied ?? createHash("sha256").update(bytes).update("\0").update(name).digest("hex");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function paths(root: string, key: string) {
	const managed = join(resolve(root), "data", "imports", key);
	return { managed, original: join(managed, "original") };
}

/** The sole admission boundary shared by uploads and inbox drops. */
export async function admitImport(input: Admission): Promise<ImportRow> {
	if (!input.fileName.trim() || input.fileName !== basename(input.fileName))
		throw new Error("file name must be a leaf name");
	const max = input.maxFileBytes ?? DEFAULT_MAX;
	if (input.bytes.byteLength === 0) throw new Error("file is empty");
	if (input.bytes.byteLength > max) throw new Error(`file exceeds ${max} bytes`);
	const key = keyFor(input.bytes, input.fileName, input.idempotencyKey);
	const prior = input.ledger.find(key);
	if (prior) return prior;
	const target = paths(input.root, key);
	await mkdir(target.managed, { recursive: true });
	const tmp = `${target.original}.tmp-${process.pid}-${Date.now()}`;
	await Bun.write(tmp, input.bytes);
	const written = new Uint8Array(await Bun.file(tmp).arrayBuffer());
	if (digest(written) !== digest(input.bytes)) {
		await unlink(tmp).catch(() => {});
		throw new Error("original verification failed");
	}
	// Publish retained bytes before the durable row. A crash here leaves an
	// inspectable orphan for reconciliation; the reverse ordering loses bytes.
	await rename(tmp, target.original);
	const row: ImportRow = {
		key,
		fileName: input.fileName,
		status: "pending",
		originalPath: target.original,
		sha256: digest(input.bytes),
		size: input.bytes.byteLength,
	};
	const committed = input.ledger.upsert(row);
	input.ledger.appendEvent?.(key, "admitted");
	return committed;
}

/** Inventory only the configured inbox; never follows links or scans parents. */
export async function scanInbox(input: InboxOptions): Promise<ImportRow[]> {
	const inbox = join(resolve(input.root), "files");
	await mkdir(inbox, { recursive: true });
	const entries = await readdir(inbox, { withFileTypes: true });
	const out: ImportRow[] = [];
	// Filter first, then bound work; temp files must not starve valid entries.
	const candidates = entries.filter(
		(entry) => !entry.name.startsWith(".") && !entry.name.endsWith(".tmp") && !entry.name.endsWith(".part"),
	);
	for (const entry of candidates.slice(0, input.maxFiles ?? 25)) {
		const source = join(inbox, entry.name);
		let info: Awaited<ReturnType<typeof lstat>>;
		try {
			info = await lstat(source);
		} catch {
			continue;
		}
		if (!info.isFile() || info.isSymbolicLink()) {
			out.push(
				input.ledger.upsert({
					key: `quarantine:${entry.name}`,
					fileName: entry.name,
					status: "quarantined",
					originalPath: source,
					sha256: "",
					size: 0,
					error: "not a regular file",
				}),
			);
			continue;
		}
		if (info.size > (input.maxFileBytes ?? DEFAULT_MAX)) {
			out.push(
				input.ledger.upsert({
					key: `quarantine:${entry.name}`,
					fileName: entry.name,
					status: "quarantined",
					originalPath: source,
					sha256: "",
					size: info.size,
					error: "file exceeds size limit",
				}),
			);
			continue;
		}
		const bytes = new Uint8Array(await Bun.file(source).arrayBuffer());
		const after = await stat(source);
		if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
			out.push(
				input.ledger.upsert({
					key: `quarantine:${entry.name}`,
					fileName: entry.name,
					status: "quarantined",
					originalPath: source,
					sha256: "",
					size: after.size,
					error: "file changed during admission",
				}),
			);
			continue;
		}
		const row = await admitImport({ root: input.root, fileName: entry.name, bytes, ledger: input.ledger });
		await unlink(source).catch(() => {});
		out.push(row);
	}
	return out;
}

export function managedImportRoot(root: string): string {
	return join(resolve(root), "data", "imports");
}
