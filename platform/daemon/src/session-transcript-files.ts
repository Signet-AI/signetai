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
import { withTranscriptFileLock, chainTranscriptRecord, TRANSCRIPT_PREFIX_SEED } from "./transcript-jsonl";
import { normalizeSessionKey } from "./session-end-state";

export interface TranscriptFileCheckpoint {
	readonly inode: number;
	readonly device: number;
	readonly outputInode: number;
	readonly offset: number;
	readonly bytes: number;
	readonly records: number;
	readonly ready: boolean;
	readonly line: string | null;
	readonly prefixCount: number;
	readonly prefixHash: string;
}

export interface TranscriptFileBatch {
	readonly done: boolean;
	readonly checkpoint: TranscriptFileCheckpoint | null;
}

const BATCH_BYTES = 4 * 1024 * 1024;
const MAX_TOKEN = 8192;
const NAMES = ["agent_id", "session_key", "session_id", "source_sha256", "role"];
const HASH = /^[0-9a-f]{64}$/;
const ABSENT = 0;
const NULLISH = 1;
const TEXT = 2;
const OTHER = 3;

interface Scan {
	root: number;
	depth: number;
	inString: boolean;
	escaped: boolean;
	mode: number;
	expectKey: boolean;
	field: number;
	pending: boolean;
	token: string;
	overflow: boolean;
	kinds: number[];
	texts: string[];
}

interface LineState {
	readonly outStart: number;
	readonly scan: Scan;
}

function missing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function freshScan(): Scan {
	return {
		root: 0,
		depth: 0,
		inString: false,
		escaped: false,
		mode: 0,
		expectKey: false,
		field: -1,
		pending: false,
		token: "",
		overflow: false,
		kinds: NAMES.map(() => ABSENT),
		texts: NAMES.map(() => ""),
	};
}

function settle(scan: Scan): void {
	const parsed: unknown = scan.overflow
		? null
		: attempt(() => JSON.parse(Buffer.from(scan.token, "latin1").toString("utf8")));
	if (scan.mode === 1) scan.field = typeof parsed === "string" ? NAMES.indexOf(parsed) : -1;
	if (scan.mode === 2 && scan.field >= 0) {
		scan.kinds[scan.field] = typeof parsed === "string" ? TEXT : OTHER;
		scan.texts[scan.field] = typeof parsed === "string" ? parsed : "";
	}
	scan.mode = 0;
	scan.token = "";
	scan.overflow = false;
}

function capture(scan: Scan, byte: number): void {
	if (scan.token.length >= MAX_TOKEN) scan.overflow = true;
	else scan.token += String.fromCharCode(byte);
}

function feed(scan: Scan, bytes: Uint8Array, start: number, end: number): void {
	for (let i = start; i < end; i++) {
		const byte = bytes[i];
		if (byte === undefined || scan.root === 2) return;
		if (scan.inString) {
			if (scan.mode !== 0) capture(scan, byte);
			if (scan.escaped) scan.escaped = false;
			else if (byte === 0x5c) scan.escaped = true;
			else if (byte === 0x22) {
				scan.inString = false;
				if (scan.mode !== 0) settle(scan);
			}
			continue;
		}
		if (byte === 0x20 || byte === 0x09 || byte === 0x0d) continue;
		if (scan.root === 0) {
			scan.root = byte === 0x7b ? 1 : 2;
			if (scan.root === 1) {
				scan.depth = 1;
				scan.expectKey = true;
			}
			continue;
		}
		if (byte === 0x22) {
			scan.inString = true;
			if (scan.depth === 1 && scan.expectKey) scan.mode = 1;
			else if (scan.depth === 1 && scan.pending) {
				scan.mode = 2;
				scan.pending = false;
			}
			if (scan.mode !== 0) scan.token = '"';
			continue;
		}
		if (byte === 0x7b || byte === 0x5b) {
			if (scan.depth === 1 && scan.pending) {
				scan.kinds[scan.field] = OTHER;
				scan.pending = false;
			}
			scan.depth++;
			continue;
		}
		if (byte === 0x7d || byte === 0x5d) {
			scan.depth--;
			continue;
		}
		if (scan.depth !== 1) continue;
		if (byte === 0x3a) {
			scan.expectKey = false;
			scan.pending = scan.field >= 0;
			continue;
		}
		if (byte === 0x2c) {
			scan.expectKey = true;
			scan.field = -1;
			scan.pending = false;
			continue;
		}
		if (scan.pending) {
			scan.kinds[scan.field] = byte === 0x6e ? NULLISH : OTHER;
			scan.pending = false;
		}
	}
}

function owns(scan: Scan, agentId: string, sessionKey: string): boolean {
	if (scan.root !== 1 || scan.kinds[0] !== TEXT || scan.texts[0] !== agentId) return false;
	const index = scan.kinds[1] === ABSENT || scan.kinds[1] === NULLISH ? 2 : 1;
	return scan.kinds[index] === TEXT && normalizeSessionKey(scan.texts[index] ?? "") === sessionKey;
}

function decodeLine(value: string): LineState | null {
	const parsed: unknown = attempt(() => JSON.parse(value));
	if (typeof parsed !== "object" || parsed === null || !("outStart" in parsed) || !("scan" in parsed)) return null;
	const scan = parsed.scan;
	if (
		typeof parsed.outStart !== "number" ||
		typeof scan !== "object" ||
		scan === null ||
		!("root" in scan) ||
		typeof scan.root !== "number" ||
		!("depth" in scan) ||
		typeof scan.depth !== "number" ||
		!("inString" in scan) ||
		typeof scan.inString !== "boolean" ||
		!("escaped" in scan) ||
		typeof scan.escaped !== "boolean" ||
		!("mode" in scan) ||
		typeof scan.mode !== "number" ||
		!("expectKey" in scan) ||
		typeof scan.expectKey !== "boolean" ||
		!("field" in scan) ||
		typeof scan.field !== "number" ||
		!("pending" in scan) ||
		typeof scan.pending !== "boolean" ||
		!("token" in scan) ||
		typeof scan.token !== "string" ||
		!("overflow" in scan) ||
		typeof scan.overflow !== "boolean" ||
		!("kinds" in scan) ||
		!Array.isArray(scan.kinds) ||
		scan.kinds.length !== NAMES.length ||
		!("texts" in scan) ||
		!Array.isArray(scan.texts) ||
		scan.texts.length !== NAMES.length
	)
		return null;
	const kinds = scan.kinds.filter((kind: unknown): kind is number => typeof kind === "number");
	const texts = scan.texts.filter((text: unknown): text is string => typeof text === "string");
	if (kinds.length !== NAMES.length || texts.length !== NAMES.length) return null;
	return {
		outStart: parsed.outStart,
		scan: {
			root: scan.root,
			depth: scan.depth,
			inString: scan.inString,
			escaped: scan.escaped,
			mode: scan.mode,
			expectKey: scan.expectKey,
			field: scan.field,
			pending: scan.pending,
			token: scan.token,
			overflow: scan.overflow,
			kinds,
			texts,
		},
	};
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
					const claimed =
						typeof metadata === "object" &&
						metadata !== null &&
						"session_key" in metadata &&
						metadata.session_key !== null
							? metadata.session_key
							: typeof metadata === "object" && metadata !== null && "session_id" in metadata
								? metadata.session_id
								: null;
					if (
						typeof metadata !== "object" ||
						metadata === null ||
						!("agent_id" in metadata) ||
						metadata.agent_id !== input.agentId ||
						typeof claimed !== "string" ||
						normalizeSessionKey(claimed) !== input.sessionKey
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
							line: null,
							prefixCount: 0,
							prefixHash: TRANSCRIPT_PREFIX_SEED,
						},
					};
				}
				const previous = input.checkpoint;
				if (previous?.ready && previous.outputInode === stat.ino && previous.device === stat.dev)
					return { done: true, checkpoint: previous };
				const resumable =
					previous && previous.inode === stat.ino && previous.device === stat.dev && previous.offset <= stat.size
						? previous
						: null;
				const target = await openContainedTranscriptFile(
					input.basePath,
					tmp,
					constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | constants.O_NOFOLLOW,
					0o600,
				);
				try {
					const output = await target.stat();
					if (!output.isFile()) throw new Error("Transcript cleanup output is not a regular file");
					const carried = resumable?.line ? decodeLine(resumable.line) : null;
					const intact =
						resumable !== null &&
						resumable.outputInode === output.ino &&
						output.size >= resumable.bytes &&
						(resumable.line === null || carried !== null);
					if (intact && resumable.ready && resumable.offset === stat.size) {
						if (output.size > resumable.bytes) await target.truncate(resumable.bytes);
						await target.sync();
						await replaceContainedTranscriptFile(input.basePath, tmp, path);
						return { done: true, checkpoint: resumable };
					}
					const base: TranscriptFileCheckpoint = intact
						? resumable
						: {
								inode: stat.ino,
								device: stat.dev,
								outputInode: output.ino,
								offset: 0,
								bytes: 0,
								records: 0,
								ready: false,
								line: null,
								prefixCount: 0,
								prefixHash: TRANSCRIPT_PREFIX_SEED,
							};
					const open = intact ? carried : null;
					const buffer = Buffer.alloc(Math.min(BATCH_BYTES, stat.size - base.offset));
					let length = 0;
					while (length < buffer.length) {
						const { bytesRead } = await source.read(buffer, length, buffer.length - length, base.offset + length);
						if (bytesRead === 0) break;
						length += bytesRead;
					}
					let prefixCount = base.prefixCount;
					let prefixHash = base.prefixHash;
					const kept = Buffer.alloc(length);
					let keptLength = 0;
					let writeAt = base.bytes;
					let records = base.records;
					let scan = open?.scan ?? freshScan();
					let lineOut = open?.outStart ?? base.bytes;
					let continued = open !== null;
					let segment = 0;
					let cursor = 0;
					const finish = (end: number): void => {
						if (owns(scan, input.agentId, input.sessionKey)) {
							records++;
							const hash = scan.kinds[3] === TEXT ? scan.texts[3] : undefined;
							if (hash !== undefined && HASH.test(hash) && scan.kinds[4] === TEXT) {
								prefixHash = chainTranscriptRecord(prefixHash, scan.texts[4] ?? "unknown", hash);
								prefixCount++;
							}
							if (continued) writeAt = lineOut;
						}
						if (!owns(scan, input.agentId, input.sessionKey)) {
							buffer.copy(kept, keptLength, segment, end);
							keptLength += end - segment;
						}
						scan = freshScan();
						continued = false;
						segment = end;
						lineOut = writeAt + keptLength;
					};
					const consumed = length;
					while (cursor < length) {
						const newline = buffer.indexOf(0x0a, cursor);
						feed(scan, buffer, cursor, newline < 0 ? length : newline);
						if (newline < 0) break;
						finish(newline + 1);
						cursor = newline + 1;
					}
					const eof = base.offset + consumed === stat.size;
					let line: string | null = null;
					if (segment < consumed || continued) {
						if (eof) finish(length);
						if (!eof) {
							buffer.copy(kept, keptLength, segment, consumed);
							keptLength += consumed - segment;
							line = JSON.stringify({ outStart: lineOut, scan });
						}
					}
					if (output.size > writeAt) await target.truncate(writeAt);
					let written = 0;
					while (written < keptLength) {
						const result = await target.write(kept, written, keptLength - written, writeAt + written);
						if (result.bytesWritten === 0) throw new Error("Transcript cleanup write made no progress");
						written += result.bytesWritten;
					}
					await target.sync();
					return {
						done: false,
						checkpoint: {
							inode: stat.ino,
							device: stat.dev,
							outputInode: output.ino,
							offset: base.offset + consumed,
							bytes: writeAt + keptLength,
							records,
							ready: eof,
							line,
							prefixCount,
							prefixHash,
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
