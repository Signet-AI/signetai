import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, stat, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { resolveWorkspaceLayout } from "@signet/core";
import { withMigrationAdmission, type MigrationAdmission } from "./workspace-writer-barrier";

export type ImportStatus =
	| "pending"
	| "processing"
	| "imported"
	| "duplicate"
	| "failed"
	| "quarantined"
	| "original_unavailable";
export class ImportAdmissionConflictError extends Error {
	constructor(key: string) {
		super(`import admission key conflict: ${key}`);
		this.name = "ImportAdmissionConflictError";
	}
}
export interface ImportRow {
	key: string;
	fileName: string;
	status: ImportStatus;
	originalPath: string;
	sha256: string;
	size: number;
	sourceId?: string;
	error?: string;
}
export interface ImportLedger {
	upsert(row: ImportRow): Promise<ImportRow> | ImportRow;
	find(key: string): Promise<ImportRow | undefined> | ImportRow | undefined;
	appendEvent?(key: string, event: string): Promise<void> | void;
	transition?(
		key: string,
		from: ImportStatus | ImportStatus[],
		to: ImportStatus,
		error?: string,
		options?: { readonly sourceId?: string },
	): Promise<ImportRow>;
	list?(status?: ImportStatus): Promise<ImportRow[]>;
}
export interface InboxOptions {
	root: string;
	layout?: ReturnType<typeof resolveWorkspaceLayout>;
	ledger: ImportLedger;
	maxFiles?: number;
	maxFileBytes?: number;
	migration?: MigrationAdmission;
}
export interface Admission {
	root: string;
	layout?: ReturnType<typeof resolveWorkspaceLayout>;
	fileName: string;
	bytes: Uint8Array;
	ledger: ImportLedger;
	idempotencyKey?: string;
	maxFileBytes?: number;
	migration?: MigrationAdmission;
}
export interface DurableImportAdmission {
	admit(input: {
		readonly fileName: string;
		readonly bytes: Uint8Array;
		readonly contentType?: string;
		readonly idempotencyKey?: string;
	}): Promise<{
		readonly key: string;
		readonly originalPath: string;
		readonly sha256: string;
		readonly size: number;
		readonly status?: ImportStatus;
		readonly sourceId?: string;
		readonly error?: string;
	}>;
	begin(key: string): Promise<void>;
	complete(input: {
		readonly key: string;
		readonly status: "imported" | "duplicate" | "failed" | "quarantined";
		readonly sourceId?: string;
		readonly error?: string;
	}): Promise<void>;
}

const DEFAULT_MAX = 25 * 1024 * 1024;
const keyFor = (bytes: Uint8Array, name: string, supplied?: string) =>
	supplied ?? createHash("sha256").update(bytes).update("\0").update(name).digest("hex");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function readManagedOriginal(path: string): Promise<Uint8Array> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new Error("managed original is not a regular file");
		return new Uint8Array(await handle.readFile());
	} finally {
		await handle.close();
	}
}

function paths(root: string, key: string, layout = resolveWorkspaceLayout(root)) {
	const managed = join(resolve(layout.imports), key);
	return { managed, original: join(managed, "original") };
}
export async function admitImport(input: Admission): Promise<ImportRow> {
	return withMigrationAdmission(input.migration, "import-admission", () => admitImportInGeneration(input));
}

async function admitImportInGeneration(input: Admission): Promise<ImportRow> {
	if (!input.fileName.trim() || input.fileName !== basename(input.fileName))
		throw new Error("file name must be a leaf name");
	const max = input.maxFileBytes ?? DEFAULT_MAX;
	if (input.bytes.byteLength === 0) throw new Error("file is empty");
	if (input.bytes.byteLength > max) throw new Error(`file exceeds ${max} bytes`);
	const key = keyFor(input.bytes, input.fileName, input.idempotencyKey);
	const inputDigest = digest(input.bytes);
	const prior = await input.ledger.find(key);
	if (prior) {
		if (prior.fileName !== input.fileName || prior.sha256 !== inputDigest || prior.size !== input.bytes.byteLength)
			throw new ImportAdmissionConflictError(key);
		return prior;
	}
	const target = paths(input.root, key, input.layout);
	await mkdir(target.managed, { recursive: true });
	const tmp = `${target.original}.tmp-${process.pid}-${Date.now()}`;
	await Bun.write(tmp, input.bytes);
	const written = new Uint8Array(await Bun.file(tmp).arrayBuffer());
	if (digest(written) !== inputDigest) {
		await unlink(tmp).catch(() => {});
		throw new Error("original verification failed");
	}
	const row: ImportRow = {
		key,
		fileName: input.fileName,
		status: "pending",
		originalPath: target.original,
		sha256: inputDigest,
		size: input.bytes.byteLength,
	};
	try {
		await copyFile(tmp, target.original, constants.COPYFILE_EXCL);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const existing = await readManagedOriginal(target.original);
		if (digest(existing) !== row.sha256) throw new ImportAdmissionConflictError(key);
	} finally {
		await unlink(tmp).catch(() => {});
	}
	const committed = await input.ledger.upsert(row);
	return committed;
}
export async function scanInbox(input: InboxOptions): Promise<ImportRow[]> {
	return withMigrationAdmission(input.migration, "import-inbox", () => scanInboxInGeneration(input));
}

async function scanInboxInGeneration(input: InboxOptions): Promise<ImportRow[]> {
	const layout = input.layout ?? resolveWorkspaceLayout(input.root);
	const inbox = resolve(layout.files);
	await mkdir(inbox, { recursive: true });
	const entries = await readdir(inbox, { withFileTypes: true });
	const out: ImportRow[] = [];
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
				await input.ledger.upsert({
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
				await input.ledger.upsert({
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
				await input.ledger.upsert({
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
		const row = await admitImport({ root: input.root, layout, fileName: entry.name, bytes, ledger: input.ledger });
		await unlink(source).catch(() => {});
		out.push(row);
	}
	return out;
}

export function managedImportRoot(root: string): string {
	return resolve(resolveWorkspaceLayout(root).imports);
}
