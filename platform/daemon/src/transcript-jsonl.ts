import { createHash, randomUUID, type Hash } from "node:crypto";
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
import { resolveDefaultBasePath, resolveWorkspaceLayout } from "@signet/core";

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
	readonly completedDigests: Map<string, string>;
}

export interface TranscriptTurn {
	readonly role: TranscriptRole;
	readonly content: string;
}

function updateTranscriptDigest(hash: Hash, turn: TranscriptTurn): void {
	const role = Buffer.from(turn.role, "utf8");
	const content = Buffer.from(turn.content, "utf8");
	hash.update(`${role.length}:`).update(role).update(`${content.length}:`).update(content);
}

export function digestTranscriptTurns(turns: ReadonlyArray<TranscriptTurn>): string {
	const hash = createHash("sha256");
	for (const turn of turns) updateTranscriptDigest(hash, turn);
	return hash.digest("hex");
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
	readonly preserveExistingSession?: boolean;
}

const LOCK_DEAD_OWNER_STALE_MS = 30_000;
const LOCK_POLL_MS = 10;
const TAIL_SCAN_BYTES = 256 * 1024;

type SessionIdentityFields = Pick<CanonicalTranscriptRecord, "agent_id" | "harness" | "session_key" | "session_id">;

interface SessionSeqEntry extends SessionIdentityFields {
	readonly lastSeq: number;
}

interface SessionSeqIndex {
	readonly ino: number;
	readonly size: number;
	readonly mtimeMs: number;
	readonly entries: Map<string, SessionSeqEntry>;
}

const sessionSeqIndexes = new Map<string, SessionSeqIndex>();

function resolveBasePath(basePath?: string): string {
	return basePath ?? process.env.SIGNET_PATH ?? resolveDefaultBasePath();
}

export function sanitizeHarnessPath(harness: string): string {
	const trimmed = harness.trim().toLowerCase();
	const safe = trimmed.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return safe.length > 0 ? safe : "unknown";
}

export function canonicalTranscriptRelativePath(harness: string): string {
	const root = resolveBasePath();
	const layout = resolveWorkspaceLayout(root);
	const path = canonicalTranscriptPath(root, harness);
	return path.slice(layout.root.length + 1);
}

export function canonicalTranscriptPath(basePath: string | undefined, harness: string): string {
	const root = resolveBasePath(basePath);
	const layout = resolveWorkspaceLayout(root);
	return join(
		layout.transcripts,
		sanitizeHarnessPath(harness),
		...(layout.version === 1 ? ["transcripts"] : []),
		"transcript.jsonl",
	);
}

function normalizeLf(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

function cleanTurnContent(text: string): string {
	return normalizeLf(text);
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
	for (const [index, line] of normalizeLf(transcript).split("\n").entries()) {
		if (index === normalizeLf(transcript).split("\n").length - 1 && line.length === 0) continue;
		const match = line.match(/^(User|Human|Assistant)\s*:(.*)$/i);
		if (match) {
			const role = match[1]?.toLowerCase() === "assistant" ? "assistant" : "user";
			const content = match[2] ?? "";
			turns.push({ role, content: content.startsWith(" ") ? content.slice(1) : content });
			continue;
		}
		const previous = turns.at(-1);
		if (previous) {
			turns[turns.length - 1] = { ...previous, content: `${previous.content}\n${line}` };
		} else if (line.length > 0) {
			turns.push({ role: "unknown", content: line });
		}
	}
	return turns;
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
		} catch {}
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

function fsyncDirectory(path: string): void {
	const fd = openSync(dirname(path), "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
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

function lockOwnerToken(path: string): string | null {
	try {
		const parsed = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as { readonly token?: unknown };
		return typeof parsed.token === "string" ? parsed.token : null;
	} catch {
		return null;
	}
}

function processIsRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

function lockCanBeReaped(path: string, now: number): boolean {
	try {
		const pid = lockOwnerPid(path);
		if (pid !== null) return !processIsRunning(pid);
		return now - statSync(path).mtimeMs > LOCK_DEAD_OWNER_STALE_MS;
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
			if (lockOwnerToken(lockPath) !== token) continue;
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

export async function withTranscriptFileLock<T>(path: string, write: () => T | Promise<T>): Promise<T> {
	mkdirSync(dirname(path), { recursive: true });
	const lock = await acquireTranscriptFileLock(path);

	try {
		return await write();
	} finally {
		releaseTranscriptFileLock(lock.lockPath, lock.token);
	}
}

function sameSession(record: SessionIdentityFields, input: TranscriptIdentity): boolean {
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

function recordSeqCacheKey(record: SessionIdentityFields): string {
	return [
		record.agent_id.trim() || "default",
		sanitizeHarnessPath(record.harness),
		record.session_id?.trim() || record.session_key?.trim() || "",
		record.session_key?.trim() || "",
	].join("\0");
}

function fileSignature(path: string): { readonly ino: number; readonly size: number; readonly mtimeMs: number } | null {
	if (!existsSync(path)) return null;
	const stat = statSync(path);
	return { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

function recordSessionSeq(entries: Map<string, SessionSeqEntry>, record: CanonicalTranscriptRecord): void {
	const key = recordSeqCacheKey(record);
	const previous = entries.get(key)?.lastSeq ?? 0;
	entries.set(key, {
		agent_id: record.agent_id,
		harness: record.harness,
		session_key: record.session_key,
		session_id: record.session_id,
		lastSeq: Math.max(previous, record.seq),
	});
}

async function loadSessionSeqIndex(path: string): Promise<Map<string, SessionSeqEntry>> {
	const signature = fileSignature(path);
	if (signature === null) return new Map();
	const cached = sessionSeqIndexes.get(path);
	if (
		cached &&
		cached.ino === signature.ino &&
		cached.size === signature.size &&
		cached.mtimeMs === signature.mtimeMs
	) {
		return cached.entries;
	}
	const entries = new Map<string, SessionSeqEntry>();
	const stream = createReadStream(path, { encoding: "utf8" });
	const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
	try {
		for await (const line of lines) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			try {
				const parsed = JSON.parse(trimmed) as Partial<CanonicalTranscriptRecord>;
				if (
					parsed.schema === "signet.transcript.v1" &&
					typeof parsed.agent_id === "string" &&
					typeof parsed.harness === "string" &&
					Number.isSafeInteger(parsed.seq)
				) {
					recordSessionSeq(entries, parsed as CanonicalTranscriptRecord);
				}
			} catch {}
		}
	} finally {
		lines.close();
		stream.destroy();
	}
	sessionSeqIndexes.set(path, { ...signature, entries });
	return entries;
}

function appendIndexedRecords(
	path: string,
	entries: Map<string, SessionSeqEntry>,
	records: readonly CanonicalTranscriptRecord[],
): void {
	appendRecords(path, records);
	for (const record of records) recordSessionSeq(entries, record);
	const signature = fileSignature(path);
	if (signature) sessionSeqIndexes.set(path, { ...signature, entries });
}

function lastSessionSeq(entries: ReadonlyMap<string, SessionSeqEntry>, input: TranscriptIdentity): number {
	let last = entries.get(sessionSeqCacheKey(input))?.lastSeq ?? 0;
	for (const entry of entries.values()) {
		if (sameSession(entry, input)) last = Math.max(last, entry.lastSeq);
	}
	return last;
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
	const completedHashes = new Map<string, Hash>();
	const lastSeqByKey = new Map<string, number>();
	if (!existsSync(path)) return { canonicalKeys, liveOnlyKeys, completedDigests: new Map() };
	const agentId = input.agentId?.trim() || null;
	const stream = createReadStream(path, { encoding: "utf8" });
	const lines = createInterface({
		input: stream,
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	try {
		for await (const line of lines) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			let parsed: Partial<CanonicalTranscriptRecord>;
			try {
				parsed = JSON.parse(trimmed) as Partial<CanonicalTranscriptRecord>;
			} catch {
				throw new Error("Invalid canonical transcript JSONL record");
			}
			if (
				parsed?.schema !== "signet.transcript.v1" ||
				typeof parsed.content !== "string" ||
				(parsed.role !== "user" && parsed.role !== "assistant" && parsed.role !== "unknown") ||
				typeof parsed.agent_id !== "string" ||
				typeof parsed.harness !== "string"
			) {
				throw new Error("Invalid canonical transcript JSONL record");
			}
			const record = parsed as CanonicalTranscriptRecord;
			const key = recordSeqCacheKey(record);
			if (!Number.isSafeInteger(record.seq) || record.seq <= (lastSeqByKey.get(key) ?? 0)) {
				throw new Error("Invalid canonical transcript JSONL sequence");
			}
			lastSeqByKey.set(key, record.seq);
			if (agentId !== null && record.agent_id !== agentId) continue;
			if (record.source_format !== "live") {
				canonicalKeys.add(key);
				liveOnlyKeys.delete(key);
				const hash = completedHashes.get(key) ?? createHash("sha256");
				updateTranscriptDigest(hash, record);
				completedHashes.set(key, hash);
				continue;
			}
			if (!canonicalKeys.has(key)) liveOnlyKeys.add(key);
		}
	} finally {
		lines.close();
		stream.destroy();
	}
	return {
		canonicalKeys,
		liveOnlyKeys,
		completedDigests: new Map([...completedHashes].map(([key, hash]) => [key, hash.digest("hex")])),
	};
}

export function writeCanonicalTranscriptSnapshot(
	input: TranscriptIdentity & { readonly transcript: string },
): Promise<boolean> {
	const turns = transcriptTextToTurns(input.transcript);
	if (turns.length === 0) return Promise.resolve(false);
	const path = canonicalTranscriptPath(input.basePath, input.harness);
	return withTranscriptFileLock(path, async () => {
		const next = turns
			.map((turn, index) => makeRecord(input, turn, index + 1))
			.filter((record): record is CanonicalTranscriptRecord => record !== null);
		if (next.length === 0) return false;

		if (!existsSync(path)) {
			mkdirSync(dirname(path), { recursive: true });
			const body = next.map((r) => JSON.stringify(r)).join("\n");
			const fd = openSync(path, "w");
			try {
				writeSync(fd, `${body}\n`, undefined, "utf8");
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			fsyncDirectory(path);
			sessionSeqIndexes.delete(path);
			return true;
		}

		const tmpPath = `${path}.snapshot-tmp`;
		let fd: number | null = null;
		try {
			fd = openSync(tmpPath, "w");
			const existingSessionTurns: Array<Pick<CanonicalTranscriptRecord, "role" | "content">> = [];
			let existingSessionLiveOnly = true;
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
						if (parsed.schema !== "signet.transcript.v1" || typeof parsed.content !== "string") {
							writeSync(fd, `${line}\n`);
							continue;
						}
						if (sameSession(parsed as CanonicalTranscriptRecord, input)) {
							if (parsed.source_format !== "live") existingSessionLiveOnly = false;
							existingSessionTurns.push({
								role: parsed.role as CanonicalTranscriptRecord["role"],
								content: cleanTurnContent(parsed.content),
							});
							continue;
						}
						writeSync(fd, `${line}\n`);
					} catch {
						writeSync(fd, `${line}\n`);
					}
				}
			} finally {
				lines.close();
			}
			const incomingMatchesExisting =
				existingSessionTurns.length === next.length &&
				existingSessionTurns.every(
					(record, index) => record.role === next[index]?.role && record.content === next[index]?.content,
				);
			if (incomingMatchesExisting) {
				closeSync(fd);
				fd = null;
				rmSync(tmpPath, { force: true });
				return true;
			}
			const incomingExtendsExisting =
				existingSessionTurns.length < next.length &&
				existingSessionTurns.every(
					(record, index) => record.role === next[index]?.role && record.content === next[index]?.content,
				);
			if (
				(input.preserveExistingSession || (input.sourcePath && !existingSessionLiveOnly)) &&
				!incomingExtendsExisting
			) {
				closeSync(fd);
				fd = null;
				rmSync(tmpPath, { force: true });
				return false;
			}
			for (const r of next) {
				writeSync(fd, `${JSON.stringify(r)}\n`);
			}
			fsyncSync(fd);
			closeSync(fd);
			fd = null;
			renameSync(tmpPath, path);
			fsyncDirectory(path);
			sessionSeqIndexes.delete(path);
			return true;
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
	return withTranscriptFileLock(path, async () => {
		if (hasTrailingTurns(readTailRecords(path), input, turns)) return path;
		const entries = await loadSessionSeqIndex(path);
		let seq = lastSessionSeq(entries, input);
		const next = turns
			.map((turn) => makeRecord(input, turn, ++seq))
			.filter((record): record is CanonicalTranscriptRecord => record !== null);
		if (next.length === 0) return null;
		appendIndexedRecords(path, entries, next);
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
		const entries = await loadSessionSeqIndex(path);
		if (entries.has(key)) return path;
		const next = turns
			.map((turn, index) => makeRecord(input, turn, index + 1))
			.filter((record): record is CanonicalTranscriptRecord => record !== null);
		if (next.length === 0) return null;
		appendIndexedRecords(path, entries, next);
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
		const effectiveReplacements =
			healedKeys.size > 0 ? new Map([...replacements].filter(([k]) => !healedKeys.has(k))) : replacements;
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
			sessionSeqIndexes.delete(jsonlPath);
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
		} catch {}
	}
	return parsed >= Math.ceil(lines.length * 0.6) ? "jsonl" : "markdown";
}
