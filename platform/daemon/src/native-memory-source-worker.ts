import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, opendir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, threadId } from "node:worker_threads";
import { resolveEmbeddedWorkerPath } from "./native-runtime-assets";
import { buildObsidianSourceChunks, type ObsidianSourceChunk } from "./obsidian-source-embeddings";

export interface NativeSourceWorkerPattern {
	readonly glob: string;
	readonly kind: string;
	readonly excludeGlobs?: readonly string[];
	readonly excludeBasenames?: readonly string[];
}

export interface NativeSourceWorkerSource {
	readonly root: string;
	readonly sourceRoot?: string;
	readonly files: readonly NativeSourceWorkerPattern[];
	readonly harness?: string;
	readonly sourceId?: string;
}

export interface NativeSourceWorkerFile {
	readonly path: string;
	readonly content: string;
	readonly mtimeMs: number;
	readonly kind: string;
	readonly contentHash: string;
	/** Source identity is derived in the isolated worker, never in the parent. */
	readonly sourceId?: string;
	readonly lineCount: number;
	readonly rolloutId?: string;
	readonly chunks?: readonly ObsidianSourceChunk[];
}

export interface NativeSourceWorkerPage {
	readonly files: readonly NativeSourceWorkerFile[];
	readonly nextCursor: string | null;
	readonly scanned: number;
	readonly total: number;
	readonly complete: boolean;
	readonly frontier: readonly string[];
	readonly permissionDeniedPaths: readonly string[];
}

interface ScanCommand {
	readonly type: "scan";
	readonly id: string;
	readonly source: NativeSourceWorkerSource;
	readonly cursor: string | null;
	readonly frontier?: readonly string[];
	readonly pageSize: number;
}

type WorkerCommand = ScanCommand;

type WorkerEvent =
	| { readonly type: "ready"; readonly threadId: number }
	| { readonly type: "scan_started"; readonly id: string }
	| {
			readonly type: "result";
			readonly id: string;
			readonly result: NativeSourceWorkerPage;
	  }
	| { readonly type: "error"; readonly id: string; readonly message: string };

interface PendingScan {
	readonly resolve: (page: NativeSourceWorkerPage) => void;
	readonly reject: (error: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
}

const NATIVE_SOURCE_WORKER_SCAN_DEADLINE_MS = 30_000;
/** Maximum UTF-8 JSON size for either side of the worker IPC channel. */
export const NATIVE_SOURCE_WORKER_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

function nativeSourceId(source: NativeSourceWorkerSource): string | undefined {
	if (source.sourceId !== undefined) return source.sourceId;
	if (source.harness === "codex")
		return `codex_native_memory:${createHash("sha256").update(source.root.replace(/\\/g, "/")).digest("hex").slice(0, 16)}`;
	if (source.harness === "hermes-agent")
		return `hermes_native_memory:${createHash("sha256")
			.update((source.sourceRoot ?? source.root).replace(/\\/g, "/"))
			.digest("hex")
			.slice(0, 16)}`;
	return undefined;
}

function matchSegment(glob: string, value: string): boolean {
	if (glob === "*") return value.length > 0;
	if (!glob.includes("*")) return glob === value;
	const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`).test(value);
}

function matchParts(glob: readonly string[], value: readonly string[]): boolean {
	if (glob.length === 0) return value.length === 0;
	const head = glob[0] ?? "";
	if (head === "**") return matchParts(glob.slice(1), value) || (value.length > 0 && matchParts(glob, value.slice(1)));
	return value.length > 0 && matchSegment(head, value[0] ?? "") && matchParts(glob.slice(1), value.slice(1));
}

function matchesGlob(glob: string, value: string): boolean {
	return matchParts(glob.replace(/\\/g, "/").split("/"), value.replace(/\\/g, "/").split("/"));
}

function matchesPattern(source: NativeSourceWorkerSource, filePath: string): string | null {
	const normalized = filePath.replace(/\\/g, "/");
	const root = source.root.replace(/\\/g, "/").replace(/\/$/, "");
	const rel = normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
	for (const pattern of source.files) {
		if (pattern.excludeBasenames?.includes(rel.split("/").slice(-1)[0] ?? "")) continue;
		if (pattern.excludeGlobs?.some((glob) => matchesGlob(glob.includes("/") ? glob : `**/${glob}`, rel))) continue;
		if (matchesGlob(pattern.glob, rel)) return pattern.kind;
	}
	return null;
}

function normalizeMarkdownBody(body: string): string {
	const lines = body
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.trimEnd());
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.join("\n");
}

function contentMetadata(content: string): Pick<NativeSourceWorkerFile, "contentHash" | "lineCount" | "rolloutId"> {
	const normalized = content.replace(/\r\n?/g, "\n").replace(/\n$/, "");
	const rolloutId = content.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i)?.[0];
	return {
		contentHash: createHash("sha256").update(normalizeMarkdownBody(content), "utf8").digest("hex"),
		lineCount: normalized.length === 0 ? 0 : normalized.split("\n").length,
		...(rolloutId === undefined ? {} : { rolloutId }),
	};
}

async function scan(command: ScanCommand): Promise<NativeSourceWorkerPage> {
	const pageSize = Math.max(1, Math.min(100, Math.trunc(command.pageSize)));
	const frontier = [...(command.frontier ?? [command.source.root])];
	const files: NativeSourceWorkerFile[] = [];
	const permissionDeniedPaths: string[] = [];
	while (frontier.length > 0 && files.length < pageSize) {
		const path = frontier.pop();
		if (path === undefined) break;
		try {
			const info = await lstat(path);
			if (info.isDirectory()) {
				const directory = await opendir(path);
				const entries: string[] = [];
				for await (const entry of directory) {
					if (entry.name !== ".git") entries.push(join(path, entry.name));
				}
				entries.sort((left, right) => right.localeCompare(left));
				frontier.push(...entries);
				continue;
			}
			if (!info.isFile()) continue;
			const kind = matchesPattern(command.source, path);
			if (kind === null) continue;
			const content = await readFile(path, "utf8");
			if (!content.trim()) continue;
			const chunks =
				command.source.harness === "obsidian" &&
				command.source.sourceId !== undefined &&
				kind === "source_obsidian_markdown"
					? buildObsidianSourceChunks({
							sourceId: command.source.sourceId,
							root: command.source.root,
							filePath: path,
							content,
						})
					: undefined;
			const descriptor: NativeSourceWorkerFile = {
				path,
				content,
				mtimeMs: info.mtimeMs,
				kind,
				...contentMetadata(content),
				...(nativeSourceId(command.source) === undefined ? {} : { sourceId: nativeSourceId(command.source) }),
				...(chunks === undefined ? {} : { chunks }),
			};
			const candidate = {
				files: [...files, descriptor],
				nextCursor: descriptor.path,
				scanned: files.length + 1,
				total: files.length + 1,
				complete: frontier.length === 0,
				frontier,
				permissionDeniedPaths,
			};
			const candidateBytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
			if (files.length > 0 && candidateBytes > NATIVE_SOURCE_WORKER_MAX_MESSAGE_BYTES) {
				frontier.push(path);
				break;
			}
			if (candidateBytes > NATIVE_SOURCE_WORKER_MAX_MESSAGE_BYTES)
				throw new Error(
					`native source worker descriptor exceeds the ${NATIVE_SOURCE_WORKER_MAX_MESSAGE_BYTES}-byte IPC limit`,
				);
			files.push(descriptor);
		} catch (error) {
			if (error instanceof Error && error.message.includes("IPC limit")) throw error;
			if (
				typeof error === "object" &&
				error !== null &&
				((error as NodeJS.ErrnoException).code === "EACCES" || (error as NodeJS.ErrnoException).code === "EPERM")
			) {
				permissionDeniedPaths.push(path);
			}
			// Files and directories can disappear while a source is being edited.
		}
	}
	return {
		files,
		nextCursor: files[files.length - 1]?.path ?? command.cursor,
		scanned: files.length,
		total: files.length,
		complete: frontier.length === 0,
		frontier,
		permissionDeniedPaths,
	};
}

export function runNativeSourceWorker(): void {
	const port = parentPort;
	if (port === null) throw new Error("native source worker requires a parent port");
	const send = (event: WorkerEvent): void => {
		const serialized = JSON.stringify(event);
		if (Buffer.byteLength(serialized, "utf8") > NATIVE_SOURCE_WORKER_MAX_MESSAGE_BYTES)
			throw new Error(
				`native source worker message exceeds the ${NATIVE_SOURCE_WORKER_MAX_MESSAGE_BYTES}-byte IPC limit`,
			);
		port.postMessage(event);
	};
	send({ type: "ready", threadId });
	port.on("message", (command: WorkerCommand) => {
		send({ type: "scan_started", id: command.id });
		void scan(command).then(
			(result) => send({ type: "result", id: command.id, result }),
			(error: unknown) =>
				send({
					type: "error",
					id: command.id,
					message: error instanceof Error ? error.message : String(error),
				}),
		);
	});
}

function workerPath(): string {
	const embedded = resolveEmbeddedWorkerPath("native-memory-source-worker");
	if (embedded !== null) return embedded;
	const directory = dirname(fileURLToPath(import.meta.url));
	const bundled = join(directory, "native-memory-source-worker.js");
	return existsSync(bundled) ? bundled : join(directory, "native-memory-source-worker.ts");
}

export interface NativeSourceWorkerHandle {
	readonly scan: (input: {
		readonly source: NativeSourceWorkerSource;
		readonly cursor: string | null;
		readonly frontier?: readonly string[] | null;
		readonly pageSize: number;
	}) => Promise<NativeSourceWorkerPage>;
	readonly cancel: () => void;
	readonly close: () => Promise<void>;
}

export function createNativeSourceWorker(
	options: {
		readonly onScanStarted?: () => void;
		/** Test-only hook fired when the worker has delivered a scan result. */
		readonly onScanResult?: () => void;
	} = {},
): NativeSourceWorkerHandle {
	let worker: Worker | null = null;
	let startPromise: Promise<void> | null = null;
	let rejectStart: ((error: Error) => void) | null = null;
	let sequence = 0;
	const pending = new Map<string, PendingScan>();
	const rejectPending = (error: Error): void => {
		for (const job of pending.values()) {
			if (job.timer) clearTimeout(job.timer);
			job.reject(error);
		}
		pending.clear();
	};
	const terminateWorker = async (target: Worker, error: Error): Promise<void> => {
		if (worker === target) {
			worker = null;
			rejectStart?.(error);
			rejectStart = null;
		}
		rejectPending(error);
		await target.terminate().catch(() => {});
	};
	const start = async (): Promise<void> => {
		if (worker !== null) return;
		if (startPromise !== null) return await startPromise;
		startPromise = new Promise<void>((resolve, reject) => {
			rejectStart = reject;
			const current = new Worker(workerPath());
			worker = current;
			let ready = false;
			const fail = (error: Error): void => {
				if (worker !== current) return;
				worker = null;
				rejectPending(error);
				if (!ready) {
					rejectStart = null;
					reject(error);
				}
			};
			current.on("message", (event: WorkerEvent) => {
				if (event.type === "ready") {
					ready = true;
					resolve();
					return;
				}
				if (event.type === "scan_started") {
					options.onScanStarted?.();
					return;
				}
				const job = pending.get(event.id);
				if (!job) return;
				pending.delete(event.id);
				if (job.timer) clearTimeout(job.timer);
				if (event.type === "result") {
					options.onScanResult?.();
					job.resolve(event.result);
				} else job.reject(new Error(event.message));
			});
			current.once("error", (error: Error) => fail(error));
			current.once("exit", (code: number) => {
				if (worker !== current) return;
				fail(new Error(`native source worker exited with code ${code}`));
			});
		});
		try {
			await startPromise;
		} finally {
			startPromise = null;
		}
	};
	const scan = async (inputValue: {
		readonly source: NativeSourceWorkerSource;
		readonly cursor: string | null;
		readonly frontier?: readonly string[] | null;
		readonly pageSize: number;
	}): Promise<NativeSourceWorkerPage> => {
		await start();
		const current = worker;
		if (current === null) throw new Error("native source worker is unavailable");
		const id = `source-scan-${process.pid}-${++sequence}`;
		let rejectResult!: (error: Error) => void;
		let timer!: ReturnType<typeof setTimeout>;
		const result = new Promise<NativeSourceWorkerPage>((resolve, reject) => {
			rejectResult = reject;
			timer = setTimeout(() => {
				if (!pending.delete(id)) return;
				const error = new Error(`native source worker scan exceeded ${NATIVE_SOURCE_WORKER_SCAN_DEADLINE_MS}ms`);
				reject(error);
				void terminateWorker(current, error);
			}, NATIVE_SOURCE_WORKER_SCAN_DEADLINE_MS);
			pending.set(id, { resolve, reject, timer });
		});
		const command: ScanCommand = {
			type: "scan",
			id,
			source: inputValue.source,
			cursor: inputValue.cursor,
			...(inputValue.frontier === undefined || inputValue.frontier === null ? {} : { frontier: inputValue.frontier }),
			pageSize: inputValue.pageSize,
		};
		const commandBytes = Buffer.byteLength(JSON.stringify(command), "utf8");
		if (commandBytes > NATIVE_SOURCE_WORKER_MAX_MESSAGE_BYTES) {
			pending.delete(id);
			clearTimeout(timer);
			rejectResult(
				new Error(`native source worker command exceeds the ${NATIVE_SOURCE_WORKER_MAX_MESSAGE_BYTES}-byte IPC limit`),
			);
			return await result;
		}
		try {
			current.postMessage(command);
		} catch (error: unknown) {
			if (pending.delete(id)) {
				clearTimeout(timer);
				rejectResult(error instanceof Error ? error : new Error(String(error)));
			}
		}
		return await result;
	};
	return {
		scan,
		cancel: () => {
			const current = worker;
			if (current === null) return;
			void terminateWorker(current, new Error("native source worker cancelled"));
		},
		async close(): Promise<void> {
			const current = worker;
			if (current === null) return;
			await terminateWorker(current, new Error("native source worker closed"));
		},
	};
}

if (!isMainThread && parentPort !== null) {
	runNativeSourceWorker();
}
