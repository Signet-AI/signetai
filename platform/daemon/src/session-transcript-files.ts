import { attempt } from "@signet/core";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { parse } from "yaml";
import {
	openContainedTranscriptFile,
	removeContainedTranscriptPath,
	replaceContainedTranscriptFile,
} from "./transcript-import-safe-fs";
import { withTranscriptFileLock } from "./transcript-jsonl";
import { normalizeSessionKey } from "./session-end-state";

export interface TranscriptFileCheckpoint {
	readonly inode: number;
	readonly device: number;
	readonly outputInode: number;
	readonly offset: number;
	readonly bytes: number;
	readonly records: number;
	readonly ready: boolean;
}

export interface TranscriptFileBatch {
	readonly done: boolean;
	readonly checkpoint: TranscriptFileCheckpoint | null;
}

function missing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isTarget(bytes: Uint8Array, agentId: string, sessionKey: string): boolean {
	const record: unknown = attempt(() => JSON.parse(Buffer.from(bytes).toString("utf8")));
	if (typeof record !== "object" || record === null || !("agent_id" in record) || record.agent_id !== agentId)
		return false;
	const key =
		"session_key" in record && record.session_key !== null
			? record.session_key
			: "session_id" in record
				? record.session_id
				: null;
	return typeof key === "string" && normalizeSessionKey(key) === sessionKey;
}

export async function redactTranscriptFileBatch(input: {
	readonly basePath: string;
	readonly path: string;
	readonly agentId: string;
	readonly sessionKey: string;
	readonly generation: number;
	readonly checkpoint: TranscriptFileCheckpoint | null;
}): Promise<TranscriptFileBatch> {
	const path = resolve(input.basePath, input.path.split("#")[0] ?? input.path);
	const rel = relative(resolve(input.basePath), path);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Transcript cleanup target escapes workspace");
	const token = createHash("sha256")
		.update(JSON.stringify([input.agentId, input.sessionKey, input.generation]))
		.digest("hex")
		.slice(0, 32);
	const tmp = `${path}.delete-${token}`;
	await mkdir(dirname(path), { recursive: true });
	return withTranscriptFileLock(
		path,
		async () => {
			const source = await openContainedTranscriptFile(
				input.basePath,
				path,
				constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
			).catch((error: unknown) => {
				if (missing(error)) return null;
				throw error;
			});
			if (!source) return { done: true, checkpoint: input.checkpoint };
			try {
				const stat = await source.stat();
				if (!stat.isFile()) throw new Error("Transcript cleanup target is not a regular file");
				if (path.endsWith(".md")) {
					const head = Buffer.alloc(8192);
					const read = await source.read(head, 0, head.length, 0);
					const text = head.subarray(0, read.bytesRead).toString("utf8").replaceAll("\r\n", "\n");
					const end = text.indexOf("\n---\n", 4);
					if (!text.startsWith("---\n") || end < 0) throw new Error("Transcript artifact has no bounded frontmatter");
					const metadata: unknown = parse(text.slice(4, end));
					if (
						typeof metadata !== "object" ||
						metadata === null ||
						!("agent_id" in metadata) ||
						metadata.agent_id !== input.agentId ||
						!("session_key" in metadata) ||
						typeof metadata.session_key !== "string" ||
						normalizeSessionKey(metadata.session_key) !== input.sessionKey
					)
						throw new Error("Transcript artifact ownership changed");
					await removeContainedTranscriptPath(input.basePath, path, { force: true });
					const directory = await openContainedTranscriptFile(
						input.basePath,
						dirname(path),
						constants.O_RDONLY | constants.O_DIRECTORY,
					);
					try {
						await directory.sync();
					} finally {
						await directory.close();
					}
					return {
						done: true,
						checkpoint: {
							inode: stat.ino,
							device: stat.dev,
							outputInode: 0,
							offset: stat.size,
							bytes: 0,
							records: 1,
							ready: true,
						},
					};
				}
				const previous = input.checkpoint;
				if (previous?.ready && previous.outputInode === stat.ino && previous.device === stat.dev)
					return { done: true, checkpoint: previous };
				if (
					previous?.ready &&
					previous.inode === stat.ino &&
					previous.device === stat.dev &&
					previous.offset === stat.size
				) {
					await replaceContainedTranscriptFile(input.basePath, tmp, path);
					return { done: true, checkpoint: previous };
				}
				const checkpoint =
					previous && previous.inode === stat.ino && previous.device === stat.dev && previous.offset <= stat.size
						? previous
						: { inode: stat.ino, device: stat.dev, outputInode: 0, offset: 0, bytes: 0, records: 0, ready: false };
				const target = await openContainedTranscriptFile(
					input.basePath,
					tmp,
					constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | constants.O_NOFOLLOW,
					0o600,
				);
				try {
					if (!(await target.stat()).isFile()) throw new Error("Transcript cleanup output is not a regular file");
					await target.truncate(checkpoint.bytes);
					const buffer = Buffer.alloc(Math.min(4 * 1024 * 1024, stat.size - checkpoint.offset));
					const { bytesRead } = await source.read(buffer, 0, buffer.length, checkpoint.offset);
					const eof = checkpoint.offset + bytesRead === stat.size;
					const end = eof ? bytesRead : buffer.lastIndexOf(0x0a, bytesRead - 1) + 1;
					if (end === 0 && !eof) throw new Error("Transcript record exceeds cleanup batch limit");
					let start = 0;
					let records = checkpoint.records;
					const kept: Uint8Array[] = [];
					for (let i = 0; i < end; i++) {
						if (buffer[i] !== 0x0a && i !== end - 1) continue;
						const line = buffer.subarray(start, i + 1);
						const matched = isTarget(line, input.agentId, input.sessionKey);
						if (matched) records++;
						if (!matched) kept.push(line);
						start = i + 1;
					}
					const bytes = Buffer.concat(kept);
					let written = 0;
					while (written < bytes.length) {
						const result = await target.write(bytes, written, bytes.length - written, checkpoint.bytes + written);
						if (result.bytesWritten === 0) throw new Error("Transcript cleanup write made no progress");
						written += result.bytesWritten;
					}
					await target.sync();
					return {
						done: false,
						checkpoint: {
							inode: stat.ino,
							device: stat.dev,
							outputInode: (await target.stat()).ino,
							offset: checkpoint.offset + end,
							bytes: checkpoint.bytes + bytes.length,
							records,
							ready: eof,
						},
					};
				} finally {
					await target.close();
				}
			} finally {
				await source.close();
			}
		},
		{ timeoutMs: 250 },
	);
}
