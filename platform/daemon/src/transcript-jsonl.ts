import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	createReadStream,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { resolveDefaultBasePath } from "@signet/core";

export type TranscriptRole = "user" | "assistant" | "unknown";
export type TranscriptSourceFormat = "jsonl" | "markdown" | "db" | "live" | "normalized";

export interface CanonicalTranscriptRecord {
	readonly schema: "signet.transcript.v1";
	readonly id: string;
	readonly captured_at: string;
	readonly agent_id: string;
	readonly harness: string;
	readonly session_key: string | null;
	readonly session_id: string | null;
	readonly project: string | null;
	readonly seq: number;
	readonly role: TranscriptRole;
	readonly content: string;
	readonly source_format: TranscriptSourceFormat;
	readonly source_path?: string;
	readonly source_sha256: string;
}

export interface TranscriptSessionKeyClassification {
	readonly canonicalKeys: Set<string>;
	readonly liveOnlyKeys: Set<string>;
}

export interface TranscriptTurn {
	readonly role: TranscriptRole;
	readonly content: string;
}

export interface TranscriptIdentity {
	readonly basePath?: string;
	readonly agentId: string;
	readonly harness: string;
	readonly sessionKey: string | null;
	readonly sessionId?: string | null;
	readonly project?: string | null;
	readonly capturedAt?: string;
	readonly sourceFormat: TranscriptSourceFormat;
	readonly sourcePath?: string;
}

const LOCK_DEAD_OWNER_STALE_MS = 30_000;
const LOCK_POLL_MS = 10;
const TAIL_SCAN_BYTES = 256 * 1024;
const sessionSeqCache = new Map<string, number>();

function resolveBasePath(basePath?: string): string {
	return basePath ?? process.env.SIGNET_PATH ?? resolveDefaultBasePath();
}

export function sanitizeHarnessPath(harness: string): string {
	const trimmed = harness.trim().toLowerCase();
	const safe = trimmed.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return safe.length > 0 ? safe : "unknown";
}

export function canonicalTranscriptRelativePath(harness: string): string {
	return `memory/${sanitizeHarnessPath(harness)}/transcripts/transcript.jsonl`;
}

export function canonicalTranscriptPath(basePath: string | undefined, harness: string): string {
	return join(resolveBasePath(basePath), canonicalTranscriptRelativePath(harness));
}

function normalizeLf(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

function cleanTurnContent(text: string): string {
	return normalizeLf(text).replace(/\s+/g, " ").trim();
}

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function recordId(record: Omit<CanonicalTranscriptRecord, "id">): string {
	return sha256(
		[
			record.schema,
			record.agent_id,
			record.harness,
			record.session_key ?? "",
			record.session_id ?? "",
			String(record.seq),
			record.role,
			record.content,
			record.source_sha256,
		].join("\0"),
	).slice(0, 32);
}

function makeRecord(input: TranscriptIdentity, turn: TranscriptTurn, seq: number): CanonicalTranscriptRecord | null {
	const content = cleanTurnContent(turn.content);
	if (content.length === 0) return null;
	const withoutId = {
		schema: "signet.transcript.v1" as const,
		captured_at: input.capturedAt ?? new Date().toISOString(),
		agent_id: input.agentId.trim() || "default",
		harness: sanitizeHarnessPath(input.harness),
		session_key: input.sessionKey?.trim() || null,
		session_id: input.sessionId?.trim() || input.sessionKey?.trim() || null,
		project: input.project?.trim() || null,
		seq,
		role: turn.role,
		content,
		source_format: input.sourceFormat,
		...(input.sourcePath ? { source_path: input.sourcePath } : {}),
		source_sha256: sha256(content),
	};
	return { ...withoutId, id: recordId(withoutId) };
}

export function transcriptTextToTurns(transcript: string): TranscriptTurn[] {
	const turns: TranscriptTurn[] = [];
	for (const line of normalizeLf(transcript).split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		const match = trimmed.match(/^(User|Human|Assistant)\s*:\s*(.*)$/i);
		if (match) {
			const role = match[1]?.toLowerCase() === "assistant" ? "assistant" : "user";
			turns.push({ role, content: match[2] ?? "" });
			continue;
		}
		turns.push({ role: "unknown", content: trimmed });
	}
	return turns;
}

function readRecords(path: string): CanonicalTranscriptRecord[] {
	if (!existsSync(path)) return [];
	const records: CanonicalTranscriptRecord[] = [];
	for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			const parsed = JSON.parse(trimmed) as Partial<CanonicalTranscriptRecord>;
			if (parsed.schema === "signet.transcript.v1" && typeof parsed.content === "string") {
				records.push(parsed as CanonicalTranscriptRecord);
			}
		} catch {
			// Ignore malformed historical lines rather than blocking capture.
		}
	}
	return records;
}

function parseRecords(text: string): CanonicalTranscriptRecord[] {
	const records: CanonicalTranscriptRecord[] = [];
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			const parsed = JSON.parse(trimmed) as Partial<CanonicalTranscriptRecord>;
			if (parsed.schema === "signet.transcript.v1" && typeof parsed.content === "string") {
				records.push(parsed as CanonicalTranscriptRecord);
			}
		} catch {
			// Ignore malformed historical lines rather than blocking capture.
		}
	}
	return records;
}

function readTailRecords(path: string): CanonicalTranscriptRecord[] {
	if (!existsSync(path)) return [];
	const size = statSync(path).size;
	const start = Math.max(0, size - TAIL_SCAN_BYTES);
	const length = size - start;
	if (length <= 0) return [];
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, start);
		const text = buffer.toString("utf8");
		return parseRecords(start === 0 ? text : text.slice(Math.max(0, text.indexOf("\n") + 1)));
	} finally {
		closeSync(fd);
	}
}

function writeRecords(path: string, records: readonly CanonicalTranscriptRecord[]): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	const body = records.map((record) => JSON.stringify(record)).join("\n");
	writeFileSync(tmp, body.length > 0 ? `${body}\n` : "", "utf8");
	renameSync(tmp, path);
}

function appendRecords(path: string, records: readonly CanonicalTranscriptRecord[]): void {
	if (records.length === 0) return;
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(
		path,
		records
			.map((record) => JSON.stringify(record))
			.join("\n")
			.concat("\n"),
		"utf8",
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockOwnerPid(path: string): number | null {
	try {
		const parsed = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as { readonly pid?: unknown };
		return typeof parsed.pid === "number" && Number.isInteger(parsed.pid) ? parsed.pid : null;
	} catch {
		return null;
	}
}

function processIsRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function lockCanBeReaped(path: string, now: number): boolean {
	try {
		if (now - statSync(path).mtimeMs <= LOCK_DEAD_OWNER_STALE_MS) return false;
		const pid = lockOwnerPid(path);
		return pid === null || !processIsRunning(pid);
	} catch {
		return false;
	}
}

async function acquireTranscriptFileLock(path: string): Promise<{ readonly lockPath: string; readonly token: string }> {
	const lockPath = `${path}.lock`;
	while (true) {
		const token = randomUUID();
		try {
			mkdirSync(lockPath);
			writeFileSync(
				join(lockPath, "owner.json"),
				JSON.stringify({ pid: process.pid, token, created_at: new Date().toISOString() }),
				"utf8",
			);
			return { lockPath, token };
		} catch (error) {
			const code = error instanceof Error && "code" in error ? error.code : null;
			if (code !== "EEXIST") throw error;

			const now = Date.now();
			if (lockCanBeReaped(lockPath, now)) {
				rmSync(lockPath, { recursive: true, force: true });
				continue;
			}
			await sleep(LOCK_POLL_MS);
		}
	}
}

function releaseTranscriptFileLock(lockPath: string, token: string): void {
	try {
		const parsed = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as { readonly token?: unknown };
		if (parsed.token !== token) return;
	} catch {
		return;
	}
	rmSync(lockPath, { recursive: true, force: true });
}

async function withTranscriptFileLock<T>(path: string, write: () => T | Promise<T>): Promise<T> {
	mkdirSync(dirname(path), { recursive: true });
	const lock = await acquireTranscriptFileLock(path);

	try {
		return await write();
	} finally {
		releaseTranscriptFileLock(lock.lockPath, lock.token);
	}
}

function sameSession(record: CanonicalTranscriptRecord, input: TranscriptIdentity): boolean {
	const sessionKey = input.sessionKey?.trim() || null;
	const sessionId = input.sessionId?.trim() || null;
	if (sessionId !== null) {
		return (
			record.agent_id === (input.agentId.trim() || "default") &&
			record.harness === sanitizeHarnessPath(input.harness) &&
			(record.session_id === sessionId ||
				(sessionKey !== null && record.session_key === sessionKey && record.session_id === sessionKey))
		);
	}
	return (
		record.agent_id === (input.agentId.trim() || "default") &&
		record.harness === sanitizeHarnessPath(input.harness) &&
		sessionKey !== null &&
		record.session_key === sessionKey
	);
}

export function sessionSeqCacheKey(input: TranscriptIdentity): string {
	return [
		input.agentId.trim() || "default",
		sanitizeHarnessPath(input.harness),
		input.sessionId?.trim() || input.sessionKey?.trim() || "",
		input.sessionKey?.trim() || "",
	].join("\0");
}

function recordSeqCacheKey(record: CanonicalTranscriptRecord): string {
	return [
		record.agent_id.trim() || "default",
		sanitizeHarnessPath(record.harness),
		record.session_id?.trim() || record.session_key?.trim() || "",
		record.session_key?.trim() || "",
	].join("\0");
}

function hasTrailingTurns(
	records: readonly CanonicalTranscriptRecord[],
	input: TranscriptIdentity,
	turns: readonly TranscriptTurn[],
): boolean {
	const relevant = records.filter((record) => sameSession(record, input));
	if (relevant.length < turns.length) return false;
	const tail = relevant.slice(-turns.length);
	return turns.every(
		(turn, index) => tail[index]?.role === turn.role && tail[index]?.content === cleanTurnContent(turn.content),
	);
}

export async function readCanonicalTranscriptSessionKeys(input: {
	readonly basePath?: string;
	readonly harness: string;
	readonly agentId?: string;
}): Promise<TranscriptSessionKeyClassification> {
	const path = canonicalTranscriptPath(input.basePath, input.harness);
	const canonicalKeys = new Set<string>();
	const liveOnlyKeys = new Set<string>();
	if (!existsSync(path)) return { canonicalKeys, liveOnlyKeys };
	const agentId = input.agentId?.trim() || null;
	const lines = createInterface({
		input: createReadStream(path, { encoding: "utf8" }),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	try {
		for await (const line of lines) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			try {
				const parsed = JSON.parse(trimmed) as Partial<CanonicalTranscriptRecord>;
				if (parsed.schema !== "signet.transcript.v1" || typeof parsed.content !== "string") continue;
				const record = parsed as CanonicalTranscriptRecord;
				if (agentId !== null && record.agent_id !== agentId) continue;
				const key = recordSeqCacheKey(record);
				if (record.source_format !== "live") {
					canonicalKeys.add(key);
					liveOnlyKeys.delete(key);
					continue;
				}
				if (!canonicalKeys.has(key)) liveOnlyKeys.add(key);
			} catch {
				// Ignore malformed historical lines rather than blocking capture.
			}
		}
	} finally {
		lines.close();
	}
	return { canonicalKeys, liveOnlyKeys };
}

async function hasSessionRecord(path: string, input: TranscriptIdentity): Promise<boolean> {
	if (!existsSync(path)) return false;
	const lines = createInterface({
		input: createReadStream(path, { encoding: "utf8" }),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	try {
		for await (const line of lines) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			try {
				const parsed = JSON.parse(trimmed) as Partial<CanonicalTranscriptRecord>;
				if (
					parsed.schema === "signet.transcript.v1" &&
					typeof parsed.content === "string" &&
					sameSession(parsed as CanonicalTranscriptRecord, input)
				) {
					return true;
				}
			} catch {
				// Ignore malformed historical lines rather than blocking capture.
			}
		}
	} finally {
		lines.close();
	}
	return false;
}

export function writeCanonicalTranscriptSnapshot(
	input: TranscriptIdentity & { readonly transcript: string },
): Promise<string | null> {
	const turns = transcriptTextToTurns(input.transcript);
	if (turns.length === 0) return Promise.resolve(null);
	const path = canonicalTranscriptPath(input.basePath, input.harness);
	return withTranscriptFileLock(path, async () => {
		const next = turns
			.map((turn, index) => makeRecord(input, turn, index + 1))
			.filter((record): record is CanonicalTranscriptRecord => record !== null);
		if (next.length === 0) return null;

		if (!existsSync(path)) {
			mkdirSync(dirname(path), { recursive: true });
			const body = next.map((r) => JSON.stringify(r)).join("\n");
			writeFileSync(path, `${body}\n`, "utf8");
			sessionSeqCache.set(
				sessionSeqCacheKey(input),
				next.reduce((max, record) => Math.max(max, record.seq), 0),
			);
			return path;
		}

		const tmpPath = `${path}.snapshot-tmp`;
		let fd: number | null = null;
		try {
			fd = openSync(tmpPath, "w");
			const lines = createInterface({
				input: createReadStream(path, { encoding: "utf8" }),
				crlfDelay: Number.POSITIVE_INFINITY,
			});
			try {
				for await (const line of lines) {
					const trimmedLine = line.trim();
					if (trimmedLine.length === 0) continue;
					try {
						const parsed = JSON.parse(trimmedLine) as Partial<CanonicalTranscriptRecord>;
						if (
							parsed.schema !== "signet.transcript.v1" ||
							typeof parsed.content !== "string"
						) {
							writeSync(fd, `${line}\n`);
							continue;
						}
						if (sameSession(parsed as CanonicalTranscriptRecord, input)) {
							continue; // Skip — will be replaced by `next` records at end
						}
						writeSync(fd, `${line}\n`);
					} catch {
						// Malformed line — preserve verbatim
						writeSync(fd, `${line}\n`);
					}
				}
			} finally {
				lines.close();
			}
			// Append new canonical records for this session
			for (const r of next) {
				writeSync(fd, `${JSON.stringify(r)}\n`);
			}
			fsyncSync(fd);
			closeSync(fd);
			fd = null;
			renameSync(tmpPath, path);
			sessionSeqCache.set(
				sessionSeqCacheKey(input),
				next.reduce((max, record) => Math.max(max, record.seq), 0),
			);
			return path;
		} catch (error) {
			if (fd !== null) closeSync(fd);
			rmSync(tmpPath, { force: true });
			throw error;
		}
	});
}

export function appendCanonicalTranscriptTurns(
	input: TranscriptIdentity & { readonly turns: readonly TranscriptTurn[] },
): Promise<string | null> {
	const turns = input.turns.filter((turn) => cleanTurnContent(turn.content).length > 0);
	if (turns.length === 0) return Promise.resolve(null);
	const path = canonicalTranscriptPath(input.basePath, input.harness);
	return withTranscriptFileLock(path, () => {
		const recent = readTailRecords(path);
		if (hasTrailingTurns(recent, input, turns)) return path;
		const key = sessionSeqCacheKey(input);
		const relevant = recent.filter((record) => sameSession(record, input));
		let seq = Math.max(
			sessionSeqCache.get(key) ?? 0,
			relevant.reduce((max, record) => Math.max(max, record.seq), 0),
		);
		const next = turns
			.map((turn) => makeRecord(input, turn, ++seq))
			.filter((record): record is CanonicalTranscriptRecord => record !== null);
		if (next.length === 0) return null;
		appendRecords(path, next);
		sessionSeqCache.set(key, seq);
		return path;
	});
}

export function appendCanonicalTranscriptSnapshotIfMissing(
	input: TranscriptIdentity & { readonly transcript: string },
	knownSessionKeys?: Set<string>,
): Promise<string | null> {
	const turns = transcriptTextToTurns(input.transcript);
	if (turns.length === 0) return Promise.resolve(null);
	const path = canonicalTranscriptPath(input.basePath, input.harness);
	const key = sessionSeqCacheKey(input);
	if (knownSessionKeys?.has(key)) return Promise.resolve(path);
	return withTranscriptFileLock(path, async () => {
		if (knownSessionKeys === undefined && (await hasSessionRecord(path, input))) return path;
		const next = turns
			.map((turn, index) => makeRecord(input, turn, index + 1))
			.filter((record): record is CanonicalTranscriptRecord => record !== null);
		if (next.length === 0) return null;
		appendRecords(path, next);
		sessionSeqCache.set(
			sessionSeqCacheKey(input),
			next.reduce((max, record) => Math.max(max, record.seq), 0),
		);
		knownSessionKeys?.add(key);
		return path;
	});
}

export function rewriteReplacingLiveOnlySessions(
	jsonlPath: string,
	replacements: ReadonlyMap<string, { readonly identity: TranscriptIdentity; readonly transcript: string }>,
): Promise<number> {
	if (replacements.size === 0 || !existsSync(jsonlPath)) return Promise.resolve(0);
	return withTranscriptFileLock(jsonlPath, async () => {
		// Re-classify inside the lock: between external classification and lock
		// acquisition, session-end hooks may have written non-live records. Only
		// replace sessions that are STILL live-only at the moment we hold the lock.
		const healedKeys = new Set<string>();
		const prescan = createInterface({
			input: createReadStream(jsonlPath, { encoding: "utf8" }),
			crlfDelay: Number.POSITIVE_INFINITY,
		});
		try {
			for await (const line of prescan) {
				const trimmed = line.trim();
				if (trimmed.length === 0) continue;
				try {
					const parsed = JSON.parse(trimmed) as Partial<CanonicalTranscriptRecord>;
					if (parsed.schema !== "signet.transcript.v1" || typeof parsed.content !== "string") continue;
					const record = parsed as CanonicalTranscriptRecord;
					const key = recordSeqCacheKey(record);
					if (replacements.has(key) && record.source_format !== "live") {
						healedKeys.add(key);
					}
				} catch {}
			}
		} finally {
			prescan.close();
		}
		const effectiveReplacements = healedKeys.size > 0
			? new Map([...replacements].filter(([k]) => !healedKeys.has(k)))
			: replacements;
		if (effectiveReplacements.size === 0) return healedKeys.size;

		const tmpPath = `${jsonlPath}.rewrite-tmp`;
		const rewritten = new Set<string>();
		let fd: number | null = null;
		try {
			fd = openSync(tmpPath, "w");
			const lines = createInterface({
				input: createReadStream(jsonlPath, { encoding: "utf8" }),
				crlfDelay: Number.POSITIVE_INFINITY,
			});
			try {
				for await (const line of lines) {
					const trimmedLine = line.trim();
					if (trimmedLine.length === 0) continue;
					try {
						const parsed = JSON.parse(trimmedLine) as Partial<CanonicalTranscriptRecord>;
						if (parsed.schema !== "signet.transcript.v1" || typeof parsed.content !== "string") {
							writeSync(fd, `${line}\n`);
							continue;
						}
					const record = parsed as CanonicalTranscriptRecord;
					const key = recordSeqCacheKey(record);
					if (!effectiveReplacements.has(key)) {
						writeSync(fd, `${line}\n`);
						continue;
					}
					if (rewritten.has(key)) {
						if (record.source_format === "live") continue;
						writeSync(fd, `${line}\n`);
						continue;
					}
					const entry = effectiveReplacements.get(key);
					if (!entry) {
						writeSync(fd, `${line}\n`);
						continue;
					}
					const next = transcriptTextToTurns(entry.transcript)
						.map((turn, index) => makeRecord(entry.identity, turn, index + 1))
						.filter((r): r is CanonicalTranscriptRecord => r !== null);
					if (next.length === 0) {
						writeSync(fd, `${line}\n`);
						continue;
					}
					for (const r of next) {
						writeSync(fd, `${JSON.stringify(r)}\n`);
					}
					rewritten.add(key);
					} catch {
						writeSync(fd, `${line}\n`);
					}
				}
			} finally {
				lines.close();
			}
			fsyncSync(fd);
			closeSync(fd);
			fd = null;
			renameSync(tmpPath, jsonlPath);
			for (const key of rewritten) {
				const entry = effectiveReplacements.get(key);
				if (!entry) continue;
				const seq = transcriptTextToTurns(entry.transcript).reduce((count, turn) => {
					if (makeRecord(entry.identity, turn, count + 1) === null) return count;
					return count + 1;
				}, 0);
				sessionSeqCache.set(sessionSeqCacheKey(entry.identity), seq);
			}
			return rewritten.size + healedKeys.size;
		} catch (error) {
			if (fd !== null) closeSync(fd);
			rmSync(tmpPath, { force: true });
			throw error;
		}
	});
}

export function inferTranscriptSourceFormat(raw: string): TranscriptSourceFormat {
	const lines = raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length === 0) return "normalized";
	let parsed = 0;
	for (const line of lines) {
		try {
			JSON.parse(line);
			parsed++;
		} catch {
			// not JSON
		}
	}
	return parsed >= Math.ceil(lines.length * 0.6) ? "jsonl" : "markdown";
}
