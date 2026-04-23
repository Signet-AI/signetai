import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { LlmProvider } from "@signet/core";
import { Tiktoken } from "js-tiktoken/lite";
import cl100k_base from "js-tiktoken/ranks/cl100k_base";
import { getAgentScope } from "./agent-id";
import { getDbAccessor } from "./db-accessor";
import { logger } from "./logger";
import { MEMORY_HEAD_MAX_TOKENS } from "./memory-head";
import { buildAgentScopeClause } from "./memory-search";
import { NATIVE_MEMORY_BRIDGE_SOURCE_NODE_ID } from "./native-memory-constants";
import { isNoiseSession, isTempProject } from "./session-noise";

function getAgentsDir(): string {
	return process.env.SIGNET_PATH || join(homedir(), ".agents");
}

function getMemoryDir(): string {
	return join(getAgentsDir(), "memory");
}
const HASH_SCOPE = "body-normalized-v1";
const SANITIZER_VERSION = "sanitize_transcript_v1";
const SENTENCE_VERSION = "memory_sentence_v1";
export const IMMUTABLE_ARTIFACT_ERROR_PREFIX = "Refusing to mutate immutable artifact";
const LEDGER_HEADING = "Session Ledger (Last 30 Days)";
const LOW_SIGNAL_SENTENCES = new Set(["Investigated issue.", "Worked on task.", "Reviewed code."]);
const PROJECTION_HEADROOM_TOKENS = 256;
export const MEMORY_PROJECTION_MAX_TOKENS = Math.max(512, MEMORY_HEAD_MAX_TOKENS - PROJECTION_HEADROOM_TOKENS);
export const NOISE_PURGE_REASON = "automatic projection cleanup for temp/test sessions";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
let projTok: Tiktoken | null = null;
const purgeSeen = new Set<string>();

// Incremental index cache: outer key = agentId or "*" for global, inner key = absolute path, value = mtimeMs
const artifactIndexCache = new Map<string, Map<string, number>>();

// Changed manifest paths from last reindexMemoryArtifacts call — read by renderMemoryProjection, keyed by agentId
const lastChangedManifestsByAgent = new Map<string, Set<string>>();

// Tracks which manifest rel paths were referenced in the previous ledger render per agent
const prevLedgerRefsByAgent = new Map<string, Set<string>>();

function getProjectionTokenizer(): Tiktoken {
	if (projTok) return projTok;
	projTok = new Tiktoken(cl100k_base);
	return projTok;
}

export type ArtifactKind = "summary" | "transcript" | "compaction" | "manifest";
type SentenceQuality = "ok" | "fallback";

interface MemorySentence {
	readonly text: string;
	readonly quality: SentenceQuality;
	readonly generatedAt: string;
}

interface ArtifactSeed {
	readonly kind: ArtifactKind;
	readonly agentId: string;
	readonly sessionId: string;
	readonly sessionKey: string | null;
	readonly project: string | null;
	readonly harness: string | null;
	readonly capturedAt: string;
	readonly startedAt: string | null;
	readonly endedAt: string | null;
	readonly sessionToken: string;
	readonly manifestPath: string;
	readonly sourceNodeId: string | null;
	readonly memorySentence: MemorySentence;
	readonly body: string;
}

interface ManifestState {
	readonly path: string;
	readonly revision: number;
	readonly frontmatter: Record<string, unknown>;
	readonly body: string;
}

interface ArtifactRow {
	readonly agent_id: string;
	readonly source_path: string;
	readonly source_sha256: string;
	readonly source_kind: string;
	readonly session_id: string;
	readonly session_key: string | null;
	readonly session_token: string;
	readonly project: string | null;
	readonly harness: string | null;
	readonly captured_at: string;
	readonly started_at: string | null;
	readonly ended_at: string | null;
	readonly manifest_path: string | null;
	readonly source_node_id: string | null;
	readonly memory_sentence: string | null;
	readonly memory_sentence_quality: string | null;
	readonly content: string;
}

interface LedgerSession {
	readonly sessionToken: string;
	readonly sessionId: string;
	readonly sessionKey: string | null;
	readonly project: string | null;
	readonly membershipTs: string;
	readonly sentence: string;
	readonly summaryPath: string | null;
	readonly transcriptPath: string | null;
	readonly compactionPath: string | null;
	readonly manifestPath: string | null;
}

interface ProjectionSection {
	readonly heading: string;
	readonly lines: ReadonlyArray<string>;
}

function readString(frontmatter: Record<string, unknown>, key: string): string | null {
	const value = frontmatter[key];
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizeLf(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

export function normalizeMarkdownBody(body: string): string {
	const lines = normalizeLf(body)
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/g, ""));
	while (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines.join("\n");
}

export function hashNormalizedBody(body: string): string {
	return createHash("sha256").update(normalizeMarkdownBody(body), "utf8").digest("hex");
}

function toScalar(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (typeof value === "string") return JSON.stringify(value);
	return JSON.stringify(String(value));
}

function serializeFrontmatter(frontmatter: Record<string, unknown>): string {
	const lines = ["---"];
	for (const [key, value] of Object.entries(frontmatter)) {
		if (Array.isArray(value)) {
			lines.push(`${key}:`);
			for (const item of value) {
				lines.push(`  - ${toScalar(item)}`);
			}
			continue;
		}
		lines.push(`${key}: ${toScalar(value)}`);
	}
	lines.push("---");
	return lines.join("\n");
}

function parseScalar(raw: string): unknown {
	const trimmed = raw.trim();
	if (trimmed === "null") return null;
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
	if (/^-?\d+\.\d+$/.test(trimmed)) return Number.parseFloat(trimmed);
	if (trimmed.startsWith('"')) {
		try {
			return JSON.parse(trimmed);
		} catch {
			return trimmed.slice(1, -1);
		}
	}
	return trimmed;
}

function parseFrontmatterDocument(content: string): { frontmatter: Record<string, unknown>; body: string } {
	const text = normalizeLf(content);
	if (!text.startsWith("---\n")) {
		return { frontmatter: {}, body: text };
	}

	const end = text.indexOf("\n---\n", 4);
	if (end === -1) {
		return { frontmatter: {}, body: text };
	}

	const raw = text.slice(4, end).split("\n");
	const frontmatter: Record<string, unknown> = {};
	let key = "";
	for (const line of raw) {
		if (line.startsWith("  - ") && key.length > 0) {
			const list = frontmatter[key];
			if (Array.isArray(list)) {
				list.push(parseScalar(line.slice(4)));
			}
			continue;
		}

		const idx = line.indexOf(":");
		if (idx === -1) continue;
		key = line.slice(0, idx).trim();
		const value = line.slice(idx + 1).trim();
		if (value.length === 0) {
			frontmatter[key] = [];
			continue;
		}
		frontmatter[key] = parseScalar(value);
	}

	return {
		frontmatter,
		body: text.slice(end + 5),
	};
}

function base32Sha256(input: string): string {
	const bytes = createHash("sha256").update(input, "utf8").digest();
	let bits = 0;
	let value = 0;
	let out = "";
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += BASE32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) {
		out += BASE32[(value << (5 - bits)) & 31];
	}
	return out;
}

// Derive a deterministic, agent-scoped token used in artifact file names.
// Uses sessionId as the identity source so each session-end run (which has
// a unique derived sessionId) produces a distinct token and artifact path,
// even when multiple runs share the same sessionKey. For checkpoint-extract
// where sessionId === sessionKey, the result is unchanged from the old
// behavior.
export function deriveSessionToken(agentId: string, sessionId: string): string {
	const seed = `${agentId}:${sessionId.trim()}`;
	return base32Sha256(seed).slice(0, 16);
}

function fsTimestamp(iso: string): string {
	return iso.replace(/:/g, "-");
}

function artifactFileName(capturedAt: string, sessionToken: string, kind: ArtifactKind): string {
	return `${fsTimestamp(capturedAt)}--${sessionToken}--${kind}.md`;
}

function artifactPath(capturedAt: string, sessionToken: string, kind: ArtifactKind): string {
	return join(getMemoryDir(), artifactFileName(capturedAt, sessionToken, kind));
}

function relativeArtifactPath(capturedAt: string, sessionToken: string, kind: ArtifactKind): string {
	return `memory/${artifactFileName(capturedAt, sessionToken, kind)}`;
}

function wikilink(path: string, label?: string): string {
	return label ? `[[${path}|${label}]]` : `[[${path}]]`;
}

export function sanitizeTranscriptV1(raw: string): string {
	return normalizeMarkdownBody(raw);
}

function pickAnchor(body: string, project: string | null, harness: string | null): string {
	const path = project ? basename(project.trim()) : "";
	if (path.length > 0) return path;

	const issue = body.match(/\b(?:PR|pr|issue|Issue|task|TASK)[-#:\s]*([A-Za-z0-9._-]+)\b/);
	if (issue?.[0]) return issue[0].replace(/\s+/g, "");

	const token = body.match(
		/\b(?:packages\/[A-Za-z0-9._/-]+|web\/[A-Za-z0-9._/-]+|[A-Za-z0-9._-]+\.(?:ts|tsx|js|jsx|rs|md))\b/,
	);
	if (token?.[0]) return token[0];

	if (harness && harness.trim().length > 0) return harness.trim();
	return "session";
}

function tokenCount(text: string): number {
	return getProjectionTokenizer().encode(text).length;
}

function joinParts(parts: ReadonlyArray<string>): string {
	return parts
		.filter((part) => part.trim().length > 0)
		.join("\n\n")
		.trimEnd();
}

function renderSection(section: ProjectionSection): string {
	return [section.heading, "", ...section.lines].join("\n").trimEnd();
}

function fitsBudget(parts: ReadonlyArray<string>): boolean {
	return tokenCount(joinParts(parts)) <= MEMORY_PROJECTION_MAX_TOKENS;
}

function fallbackSentence(body: string, project: string | null, harness: string | null, sourceKind: string): string {
	const anchor = pickAnchor(body, project, harness);
	const clean = normalizeMarkdownBody(body).replace(/\n+/g, " ").trim();
	const preview = clean.length > 120 ? `${clean.slice(0, 117).trim()}...` : clean;
	const sentence =
		sourceKind === "compaction"
			? `Compaction for ${anchor} preserved durable context, linked the active session state, and captured this summary for later MEMORY.md projection and drill-down.`
			: `Session ${anchor} captured durable ${sourceKind} context, preserved lineage metadata, and recorded this artifact for MEMORY.md projection and later drill-down.`;
	if (preview.length < 24) return sentence;
	return sentence;
}

function sentenceWordCount(text: string): number {
	return text
		.trim()
		.split(/\s+/)
		.filter((word) => word.length > 0).length;
}

function hasTerminalPunctuation(text: string): boolean {
	return /[.!?]$/.test(text.trim());
}

function hasConcreteAnchor(text: string, body: string, project: string | null): boolean {
	const anchor = pickAnchor(body, project, null);
	return (
		text.includes(anchor) ||
		!!text.match(/\b(?:packages\/|web\/|PR#?|issue#?|task#?|[A-Za-z0-9._-]+\.(?:ts|tsx|js|jsx|rs|md))\b/)
	);
}

function validateSentence(text: string, body: string, project: string | null): boolean {
	if (LOW_SIGNAL_SENTENCES.has(text.trim())) return false;
	const words = sentenceWordCount(text);
	if (words < 12 || words > 48) return false;
	if (!hasTerminalPunctuation(text)) return false;
	return hasConcreteAnchor(text, body, project);
}

function coerceSentence(
	text: string | null,
	body: string,
	project: string | null,
	harness: string | null,
	sourceKind: string,
): string {
	if (text && validateSentence(text, body, project)) return text;
	return fallbackSentence(body, project, harness, sourceKind);
}

function sentencePrompt(body: string, project: string | null, sourceKind: string): string {
	return `Write exactly one sentence summarizing this ${sourceKind} artifact for MEMORY.md.

Rules:
- 12 to 48 words
- must end with punctuation
- include at least one concrete anchor like a project name, path token, issue id, PR id, or component name
- no lists, no markdown, no quotes
- exactly one sentence

Project: ${project ?? "none"}

Artifact:
${body.slice(0, 4000)}`;
}

export async function resolveMemorySentence(
	body: string,
	project: string | null,
	harness: string | null,
	sourceKind: string,
	provider?: LlmProvider | null,
): Promise<MemorySentence> {
	const generatedAt = new Date().toISOString();
	if (provider) {
		try {
			const raw = await provider.generate(sentencePrompt(body, project, sourceKind), {
				maxTokens: 120,
				timeoutMs: 10_000,
			});
			const cleaned = normalizeMarkdownBody(raw).replace(/\n+/g, " ").trim();
			const line = cleaned.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? cleaned;
			if (validateSentence(line, body, project)) {
				return {
					text: line,
					quality: "ok",
					generatedAt,
				};
			}
		} catch {
			// fall through to deterministic fallback
		}
	}

	return {
		text: fallbackSentence(body, project, harness, sourceKind),
		quality: "fallback",
		generatedAt,
	};
}

function writeAtomic(path: string, content: string): void {
	mkdirSync(getMemoryDir(), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, path);
}

function loadManifest(path: string): ManifestState | null {
	if (!existsSync(path)) return null;
	const parsed = parseFrontmatterDocument(readFileSync(path, "utf8"));
	const rawRevision = parsed.frontmatter.revision;
	return {
		path,
		revision: typeof rawRevision === "number" ? rawRevision : 0,
		frontmatter: parsed.frontmatter,
		body: parsed.body,
	};
}

function writeImmutableArtifact(seed: ArtifactSeed): string {
	const path = artifactPath(seed.capturedAt, seed.sessionToken, seed.kind);
	const body = normalizeMarkdownBody(seed.body);
	const frontmatter: Record<string, unknown> = {
		kind: seed.kind,
		agent_id: seed.agentId,
		session_id: seed.sessionId,
		session_key: seed.sessionKey,
		project: seed.project,
		harness: seed.harness,
		captured_at: seed.capturedAt,
		started_at: seed.startedAt,
		ended_at: seed.endedAt,
		manifest_path: seed.manifestPath,
		source_node_id: seed.sourceNodeId,
		content_sha256: hashNormalizedBody(body),
		hash_scope: HASH_SCOPE,
		memory_sentence: seed.memorySentence.text,
		memory_sentence_version: SENTENCE_VERSION,
		memory_sentence_quality: seed.memorySentence.quality,
		memory_sentence_generated_at: seed.memorySentence.generatedAt,
	};
	if (seed.kind === "transcript") {
		frontmatter.sanitizer_version = SANITIZER_VERSION;
	}
	const content = `${serializeFrontmatter(frontmatter)}\n${body}\n`;

	if (existsSync(path)) {
		const existing = parseFrontmatterDocument(readFileSync(path, "utf8"));
		const fm = existing.frontmatter;
		const fieldsMatch =
			fm.kind === frontmatter.kind &&
			fm.agent_id === frontmatter.agent_id &&
			fm.session_id === frontmatter.session_id &&
			fm.hash_scope === frontmatter.hash_scope;
		if (!fieldsMatch) {
			throw new Error(`${IMMUTABLE_ARTIFACT_ERROR_PREFIX} ${path} (identity mismatch)`);
		}
		return path;
	}

	writeAtomic(path, content);
	return path;
}

function upsertArtifactRow(
	path: string,
	frontmatter: Record<string, unknown>,
	body: string,
	sourceMtimeMs = statSync(path).mtimeMs,
	options: { readonly trustSourcePath?: boolean; readonly trustNativeMarker?: boolean } = {},
): void {
	const agentId = typeof frontmatter.agent_id === "string" ? frontmatter.agent_id : "default";
	const sourcePath =
		options.trustSourcePath && typeof frontmatter.source_path === "string"
			? frontmatter.source_path.replace(/\\/g, "/")
			: path.replace(`${getAgentsDir()}/`, "").replace(/\\/g, "/");
	const sourceKind = typeof frontmatter.kind === "string" ? frontmatter.kind : "manifest";
	const sessionId = typeof frontmatter.session_id === "string" ? frontmatter.session_id : sourcePath;
	const sessionKey = typeof frontmatter.session_key === "string" ? frontmatter.session_key : null;
	const sessionToken = sourcePath.match(/--([a-z2-7]{16})--/)?.[1] ?? deriveSessionToken(agentId, sessionId);
	const project = typeof frontmatter.project === "string" ? frontmatter.project : null;
	const harness = typeof frontmatter.harness === "string" ? frontmatter.harness : null;
	const capturedAt = typeof frontmatter.captured_at === "string" ? frontmatter.captured_at : new Date().toISOString();
	const startedAt = typeof frontmatter.started_at === "string" ? frontmatter.started_at : null;
	const endedAt = typeof frontmatter.ended_at === "string" ? frontmatter.ended_at : null;
	const manifestPath = typeof frontmatter.manifest_path === "string" ? frontmatter.manifest_path : null;
	const rawSourceNodeId = typeof frontmatter.source_node_id === "string" ? frontmatter.source_node_id : null;
	const sourceNodeId =
		rawSourceNodeId === NATIVE_MEMORY_BRIDGE_SOURCE_NODE_ID && !options.trustNativeMarker ? null : rawSourceNodeId;
	const memorySentence = typeof frontmatter.memory_sentence === "string" ? frontmatter.memory_sentence : null;
	const quality = typeof frontmatter.memory_sentence_quality === "string" ? frontmatter.memory_sentence_quality : null;
	const sourceSha =
		typeof frontmatter.content_sha256 === "string" ? frontmatter.content_sha256 : hashNormalizedBody(body);
	const updatedAt = typeof frontmatter.updated_at === "string" ? frontmatter.updated_at : new Date().toISOString();
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO memory_artifacts (
				agent_id, source_path, source_sha256, source_kind, session_id,
				session_key, session_token, project, harness, captured_at,
				started_at, ended_at, manifest_path, source_node_id,
				memory_sentence, memory_sentence_quality, content, updated_at,
				source_mtime_ms
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(agent_id, source_path) DO UPDATE SET
				source_sha256 = excluded.source_sha256,
				source_kind = excluded.source_kind,
				session_id = excluded.session_id,
				session_key = excluded.session_key,
				session_token = excluded.session_token,
				project = excluded.project,
				harness = excluded.harness,
				captured_at = excluded.captured_at,
				started_at = excluded.started_at,
				ended_at = excluded.ended_at,
				manifest_path = excluded.manifest_path,
				source_node_id = excluded.source_node_id,
				memory_sentence = excluded.memory_sentence,
				memory_sentence_quality = excluded.memory_sentence_quality,
				content = excluded.content,
				updated_at = excluded.updated_at,
				source_mtime_ms = excluded.source_mtime_ms`,
		).run(
			agentId,
			sourcePath,
			sourceSha,
			sourceKind,
			sessionId,
			sessionKey,
			sessionToken,
			project,
			harness,
			capturedAt,
			startedAt,
			endedAt,
			manifestPath,
			sourceNodeId,
			memorySentence,
			quality,
			body,
			updatedAt,
			sourceMtimeMs,
		);
	});
}

export function indexExternalMemoryArtifact(input: {
	readonly agentId?: string;
	readonly sourcePath: string;
	readonly sourceKind: string;
	readonly harness: string;
	readonly content: string;
	readonly sourceMtimeMs: number;
	readonly capturedAt?: string;
	readonly project?: string | null;
}): void {
	const capturedAt =
		input.capturedAt ??
		(Number.isFinite(input.sourceMtimeMs) ? new Date(input.sourceMtimeMs).toISOString() : new Date().toISOString());
	upsertArtifactRow(
		input.sourcePath,
		{
			agent_id: input.agentId?.trim() || "default",
			source_path: input.sourcePath.replace(/\\/g, "/"),
			kind: input.sourceKind,
			session_id: `native:${input.harness}:${input.sourcePath}`,
			session_key: `native:${input.harness}`,
			project: input.project ?? null,
			harness: input.harness,
			captured_at: capturedAt,
			started_at: capturedAt,
			ended_at: capturedAt,
			updated_at: new Date().toISOString(),
			source_node_id: NATIVE_MEMORY_BRIDGE_SOURCE_NODE_ID,
			content_sha256: hashNormalizedBody(input.content),
			memory_sentence: `Indexed ${input.harness} native memory from ${basename(input.sourcePath)}.`,
			memory_sentence_quality: "fallback",
		},
		input.content,
		input.sourceMtimeMs,
		{ trustNativeMarker: true, trustSourcePath: true },
	);
}

function canSeedColdCacheFromDbRow(currentMtimeMs: number, row: { readonly source_mtime_ms?: unknown }): boolean {
	if (!Number.isFinite(currentMtimeMs)) return false;

	if (typeof row.source_mtime_ms === "number" && Number.isFinite(row.source_mtime_ms)) {
		return currentMtimeMs === row.source_mtime_ms;
	}

	return false;
}

function listCanonicalFiles(): string[] {
	const dir = getMemoryDir();
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => /^\d{4}-\d{2}-\d{2}T.*--[a-z2-7]{16}--(summary|transcript|compaction|manifest)\.md$/.test(name))
		.map((name) => join(dir, name))
		.sort();
}

export function deleteArtifactRowsForPath(path: string, agentId: string | null): void {
	const sourcePath = relativePath(path);
	const absolutePath = path.replace(/\\/g, "/");
	getDbAccessor().withWriteTx((db) => {
		if (agentId) {
			db.prepare("DELETE FROM memory_artifacts WHERE source_path = ? AND agent_id = ?").run(sourcePath, agentId);
			db.prepare("DELETE FROM memory_artifacts WHERE source_path = ? AND agent_id = ?").run(absolutePath, agentId);
			return;
		}
		db.prepare("DELETE FROM memory_artifacts WHERE source_path = ?").run(sourcePath);
		db.prepare("DELETE FROM memory_artifacts WHERE source_path = ?").run(absolutePath);
	});
}

export function reindexMemoryArtifacts(agentId?: string): void {
	const scope = agentId?.trim() || null;
	const files = listCanonicalFiles();
	const stopTimer = logger.time("resources", "reindexMemoryArtifacts");
	const cacheKey = scope ?? "*";
	const cache = artifactIndexCache.get(cacheKey) ?? new Map<string, number>();
	const changedPaths = new Set<string>();
	lastChangedManifestsByAgent.delete(cacheKey);

	try {
		const ready = getDbAccessor().withReadDb((db) => {
			const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_artifacts'`).get();
			return row !== undefined;
		});
		if (!ready) {
			stopTimer({ fileCount: files.length });
			return;
		}
	} catch {
		stopTimer({ fileCount: files.length });
		return;
	}

	if (cache.size === 0) {
		// Seed from DB state too so files deleted while daemon was down get
		// detected, while unchanged files can skip a full reread on restart.
		const dbPaths = getDbAccessor().withReadDb((db) => {
			const rows = scope
				? (db
						.prepare("SELECT source_path, source_mtime_ms FROM memory_artifacts WHERE agent_id = ?")
						.all(scope) as Array<{
						source_path: string;
						source_mtime_ms?: number | null;
					}>)
				: (db.prepare("SELECT source_path, source_mtime_ms FROM memory_artifacts").all() as Array<{
						source_path: string;
						source_mtime_ms?: number | null;
					}>);
			return rows;
		});
		if (dbPaths.length > 0) {
			const root = getAgentsDir();
			for (const row of dbPaths) {
				const absPath = join(root, row.source_path);
				if (!existsSync(absPath)) {
					cache.set(absPath, 0);
					continue;
				}
				const currentMtimeMs = statSync(absPath).mtimeMs;
				cache.set(absPath, canSeedColdCacheFromDbRow(currentMtimeMs, row) ? currentMtimeMs : 0);
			}
			for (const path of files) {
				if (!cache.has(path)) cache.set(path, 0);
			}
		}
	}

	const tombstones = getDbAccessor().withReadDb((db) => {
		const table = db
			.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_artifact_tombstones'`)
			.get();
		if (!table) return new Set<string>();
		const rows = scope
			? (db.prepare("SELECT session_token FROM memory_artifact_tombstones WHERE agent_id = ?").all(scope) as Array<{
					session_token: string;
				}>)
			: (db.prepare("SELECT session_token FROM memory_artifact_tombstones").all() as Array<{ session_token: string }>);
		return new Set(rows.map((row) => row.session_token));
	});

	const fileSet = new Set(files);
	for (const path of files) {
		const mtime = statSync(path).mtimeMs;
		if (cache.get(path) === mtime) continue;

		const parsed = parseFrontmatterDocument(readFileSync(path, "utf8"));
		const nextAgent = typeof parsed.frontmatter.agent_id === "string" ? parsed.frontmatter.agent_id : "default";
		if (scope && nextAgent !== scope) {
			deleteArtifactRowsForPath(path, scope);
			cache.set(path, mtime);
			continue;
		}
		const match = path.match(/--([a-z2-7]{16})--/);
		const sessionToken = match?.[1];
		if (sessionToken && tombstones.has(sessionToken)) {
			deleteArtifactRowsForPath(path, scope);
			cache.set(path, mtime);
			changedPaths.add(path);
			continue;
		}
		const body = normalizeMarkdownBody(parsed.body);
		if (!isValidArtifact(path, parsed.frontmatter, body)) {
			deleteArtifactRowsForPath(path, scope);
			cache.set(path, mtime);
			changedPaths.add(path);
			continue;
		}
		upsertArtifactRow(path, parsed.frontmatter, body, mtime);
		cache.set(path, mtime);
		changedPaths.add(path);
	}

	for (const path of cache.keys()) {
		if (fileSet.has(path)) continue;
		deleteArtifactRowsForPath(path, scope);
		cache.delete(path);
		changedPaths.add(path);
	}

	lastChangedManifestsByAgent.set(
		cacheKey,
		new Set([...changedPaths].filter((path) => path.endsWith("--manifest.md"))),
	);
	artifactIndexCache.set(cacheKey, cache);

	stopTimer({ fileCount: files.length });
}

function isValidArtifact(path: string, frontmatter: Record<string, unknown>, body: string): boolean {
	const kind = readString(frontmatter, "kind");
	if (!kind) return false;
	if (!["summary", "transcript", "compaction", "manifest"].includes(kind)) return false;

	const agentId = readString(frontmatter, "agent_id");
	const sessionId = readString(frontmatter, "session_id");
	const capturedAt = readString(frontmatter, "captured_at");
	const hashScope = readString(frontmatter, "hash_scope");
	const contentSha = readString(frontmatter, "content_sha256");
	if (!agentId || !sessionId || !capturedAt || !hashScope || !contentSha) return false;
	if (hashScope !== HASH_SCOPE) return false;
	if (contentSha !== hashNormalizedBody(body)) return false;

	if (kind === "transcript") {
		const sanitizerVersion = readString(frontmatter, "sanitizer_version");
		if (sanitizerVersion !== SANITIZER_VERSION) return false;
	}

	if (kind !== "manifest") {
		const manifestPath = readString(frontmatter, "manifest_path");
		if (!manifestPath?.startsWith("memory/")) return false;
	}

	const rel = relativePath(path);
	return rel.startsWith("memory/") && rel.endsWith(`--${kind}.md`);
}

function ensureManifestRecord(seed: {
	readonly agentId: string;
	readonly sessionId: string;
	readonly sessionKey: string | null;
	readonly project: string | null;
	readonly harness: string | null;
	readonly capturedAt: string;
	readonly startedAt: string | null;
	readonly endedAt: string | null;
	readonly sessionToken: string;
}): ManifestState {
	const path = artifactPath(seed.capturedAt, seed.sessionToken, "manifest");
	const summaryPath = relativeArtifactPath(seed.capturedAt, seed.sessionToken, "summary");
	const transcriptPath = relativeArtifactPath(seed.capturedAt, seed.sessionToken, "transcript");
	const existing = loadManifest(path);
	if (existing) return existing;

	const frontmatter: Record<string, unknown> = {
		kind: "manifest",
		agent_id: seed.agentId,
		session_id: seed.sessionId,
		session_key: seed.sessionKey,
		project: seed.project,
		harness: seed.harness,
		captured_at: seed.capturedAt,
		started_at: seed.startedAt,
		ended_at: seed.endedAt,
		summary_path: summaryPath,
		transcript_path: transcriptPath,
		compaction_path: null,
		memory_md_refs: [],
		updated_at: seed.capturedAt,
		revision: 1,
		content_sha256: hashNormalizedBody(""),
		hash_scope: HASH_SCOPE,
	};
	writeAtomic(path, `${serializeFrontmatter(frontmatter)}\n`);
	const manifest = loadManifest(path);
	if (!manifest) {
		throw new Error(`Failed to create manifest ${path}`);
	}
	upsertArtifactRow(path, manifest.frontmatter, manifest.body);
	return manifest;
}

function saveManifest(path: string, frontmatter: Record<string, unknown>, body: string): ManifestState {
	const content = `${serializeFrontmatter(frontmatter)}\n${normalizeMarkdownBody(body)}\n`;
	writeAtomic(path, content);
	const manifest = loadManifest(path);
	if (!manifest) {
		throw new Error(`Failed to reload manifest ${path}`);
	}
	upsertArtifactRow(path, manifest.frontmatter, manifest.body);
	return manifest;
}

function findExistingManifest(agentId: string, sessionId: string): ManifestState | null {
	try {
		// Pre-fix rows stored session_id verbatim from the caller (equal to
		// session_key). New rows use a derived session_id (e.g. "session-end:
		// path:…"). Both cases are covered by this single session_id lookup —
		// a separate session_key fallback is unnecessary because pre-fix rows
		// match on session_id directly (it was persisted as the session_key
		// value) and new rows have a unique derived session_id.
		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT source_path
					 FROM memory_artifacts
					 WHERE agent_id = ? AND source_kind = 'manifest' AND session_id = ?
					 ORDER BY captured_at ASC
					 LIMIT 1`,
					)
					.get(agentId, sessionId) as { source_path: string } | undefined,
		);
		if (!row) return null;
		return loadManifest(join(getAgentsDir(), row.source_path));
	} catch {
		return null;
	}
}

function manifestValue(frontmatter: Record<string, unknown>, key: string): string | null {
	const value = frontmatter[key];
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function ensureCanonicalManifest(seed: {
	readonly agentId: string;
	readonly sessionId: string;
	readonly sessionKey: string | null;
	readonly project: string | null;
	readonly harness: string | null;
	readonly capturedAt: string;
	readonly startedAt: string | null;
	readonly endedAt: string | null;
}): ManifestState {
	const existing = findExistingManifest(seed.agentId, seed.sessionId);
	if (existing) return existing;
	return ensureManifestRecord({
		...seed,
		sessionToken: deriveSessionToken(seed.agentId, seed.sessionId),
	});
}

export function updateManifest(
	path: string,
	mutate: (frontmatter: Record<string, unknown>) => Record<string, unknown>,
): ManifestState {
	const current = loadManifest(path);
	if (!current) {
		throw new Error(`Manifest not found: ${path}`);
	}
	const next = mutate({ ...current.frontmatter });
	const revision = typeof next.revision === "number" ? next.revision : current.revision;
	next.revision = revision + 1;
	next.updated_at = new Date().toISOString();
	if (!("content_sha256" in next)) {
		next.content_sha256 = hashNormalizedBody(current.body);
	}
	if (!("hash_scope" in next)) {
		next.hash_scope = HASH_SCOPE;
	}
	return saveManifest(path, next, current.body);
}

function relativePath(path: string): string {
	return path.replace(`${getAgentsDir()}/`, "").replace(/\\/g, "/");
}

export function writeTranscriptArtifact(params: {
	readonly agentId: string;
	readonly sessionId: string;
	readonly sessionKey: string | null;
	readonly project: string | null;
	readonly harness: string | null;
	readonly capturedAt: string;
	readonly startedAt: string | null;
	readonly endedAt: string | null;
	readonly transcript: string;
}): { readonly manifestPath: string; readonly transcriptPath: string } {
	const manifest = ensureCanonicalManifest(params);
	const sessionToken = deriveSessionToken(params.agentId, params.sessionId);
	const body = sanitizeTranscriptV1(params.transcript);
	const sentence = {
		text: fallbackSentence(body, params.project, params.harness, "transcript"),
		quality: "fallback" as const,
		generatedAt: new Date().toISOString(),
	};
	const fullPath = writeImmutableArtifact({
		kind: "transcript",
		agentId: params.agentId,
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		project: params.project,
		harness: params.harness,
		capturedAt: manifestValue(manifest.frontmatter, "captured_at") ?? params.capturedAt,
		startedAt: params.startedAt,
		endedAt: params.endedAt,
		sessionToken,
		manifestPath: relativePath(manifest.path),
		sourceNodeId: null,
		memorySentence: sentence,
		body,
	});
	const parsed = parseFrontmatterDocument(readFileSync(fullPath, "utf8"));
	upsertArtifactRow(fullPath, parsed.frontmatter, normalizeMarkdownBody(parsed.body));
	return {
		manifestPath: relativePath(manifest.path),
		transcriptPath: relativePath(fullPath),
	};
}

export async function writeSummaryArtifact(params: {
	readonly agentId: string;
	readonly sessionId: string;
	readonly sessionKey: string | null;
	readonly project: string | null;
	readonly harness: string | null;
	readonly capturedAt: string;
	readonly startedAt: string | null;
	readonly endedAt: string | null;
	readonly summary: string;
	readonly provider?: LlmProvider | null;
}): Promise<{ readonly manifestPath: string; readonly summaryPath: string }> {
	const manifest = ensureCanonicalManifest(params);
	const capturedAt = manifestValue(manifest.frontmatter, "captured_at") ?? params.capturedAt;
	const sessionToken = deriveSessionToken(params.agentId, params.sessionId);
	const body = normalizeMarkdownBody(params.summary);
	const sentence = await resolveMemorySentence(body, params.project, params.harness, "summary", params.provider);
	const fullPath = writeImmutableArtifact({
		kind: "summary",
		agentId: params.agentId,
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		project: params.project,
		harness: params.harness,
		capturedAt,
		startedAt: params.startedAt,
		endedAt: params.endedAt,
		sessionToken,
		manifestPath: relativePath(manifest.path),
		sourceNodeId: null,
		memorySentence: sentence,
		body,
	});
	const parsed = parseFrontmatterDocument(readFileSync(fullPath, "utf8"));
	upsertArtifactRow(fullPath, parsed.frontmatter, normalizeMarkdownBody(parsed.body));
	return {
		manifestPath: relativePath(manifest.path),
		summaryPath: relativePath(fullPath),
	};
}

export async function writeCompactionArtifact(params: {
	readonly agentId: string;
	readonly sessionId: string;
	readonly sessionKey: string | null;
	readonly project: string | null;
	readonly harness: string | null;
	readonly capturedAt: string;
	readonly startedAt: string | null;
	readonly endedAt: string | null;
	readonly summary: string;
	readonly provider?: LlmProvider | null;
}): Promise<{ readonly manifestPath: string; readonly compactionPath: string }> {
	const manifest = ensureCanonicalManifest(params);
	const capturedAt = manifestValue(manifest.frontmatter, "captured_at") ?? params.capturedAt;
	const sessionToken = deriveSessionToken(params.agentId, params.sessionId);
	const body = normalizeMarkdownBody(params.summary);
	const sentence = await resolveMemorySentence(body, params.project, params.harness, "compaction", params.provider);
	const fullPath = writeImmutableArtifact({
		kind: "compaction",
		agentId: params.agentId,
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		project: params.project,
		harness: params.harness,
		capturedAt,
		startedAt: params.startedAt,
		endedAt: params.endedAt,
		sessionToken,
		manifestPath: relativePath(manifest.path),
		sourceNodeId: null,
		memorySentence: sentence,
		body,
	});
	const parsed = parseFrontmatterDocument(readFileSync(fullPath, "utf8"));
	upsertArtifactRow(fullPath, parsed.frontmatter, normalizeMarkdownBody(parsed.body));
	updateManifest(manifest.path, (frontmatter) => ({
		...frontmatter,
		compaction_path: relativePath(fullPath),
		ended_at: params.endedAt,
	}));
	return {
		manifestPath: relativePath(manifest.path),
		compactionPath: relativePath(fullPath),
	};
}

function buildTemporalIndex(
	nodes: ReadonlyArray<{
		readonly id: string;
		readonly kind: string;
		readonly source_type: string;
		readonly depth: number;
		readonly latest_at: string;
		readonly project: string | null;
		readonly session_key: string | null;
		readonly source_ref: string | null;
		readonly content: string;
	}>,
): string {
	const lines = nodes.map((node) => {
		const preview = normalizeMarkdownBody(node.content).replace(/\n+/g, " ").trim().slice(0, 120);
		return `- id=${node.id} kind=${node.kind} source=${node.source_type} depth=${node.depth} session=${node.session_key ?? "none"} project=${node.project ?? "none"} ref=${node.source_ref ?? "none"} latest=${node.latest_at}\n  summary: ${preview}`;
	});
	if (lines.length === 0) return "";
	return renderSection({
		heading: "## Temporal Index",
		lines,
	});
}

function readThreadHeads(agentId: string): ReadonlyArray<{
	readonly label: string;
	readonly source_type: string;
	readonly latest_at: string;
	readonly sample: string;
	readonly node_id: string;
	readonly project: string | null;
	readonly session_key: string | null;
	readonly harness: string | null;
}> {
	try {
		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT label, source_type, latest_at, sample, node_id, project, session_key, harness
					 FROM memory_thread_heads
					 WHERE agent_id = ?
					 ORDER BY latest_at DESC
					 LIMIT 12`,
					)
					.all(agentId) as Array<{
					label: string;
					source_type: string;
					latest_at: string;
					sample: string;
					node_id: string;
					project: string | null;
					session_key: string | null;
					harness: string | null;
				}>,
		);
		return rows.filter(
			(row) =>
				!isNoiseSession({
					project: row.project,
					sessionKey: row.session_key,
					sessionId: row.node_id,
					harness: row.harness,
				}),
		);
	} catch {
		return [];
	}
}

function readTopMemories(agentId: string): ReadonlyArray<{
	readonly content: string;
	readonly type: string;
	readonly importance: number;
	readonly project: string | null;
}> {
	try {
		const scope = getAgentScope(agentId);
		const clause = buildAgentScopeClause(agentId, scope.readPolicy, scope.policyGroup);
		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT m.content, m.type, m.importance, m.project
					 FROM memories m
					 WHERE m.is_deleted = 0${clause.sql}
					 ORDER BY m.pinned DESC, m.importance DESC, m.created_at DESC
					 LIMIT 8`,
					)
					.all(...clause.args) as Array<{
					content: string;
					type: string;
					importance: number;
					project: string | null;
				}>,
		);
		return rows.filter((row) => !isNoiseSession({ project: row.project }));
	} catch {
		return [];
	}
}

function readTemporalNodes(agentId: string): ReadonlyArray<{
	readonly id: string;
	readonly kind: string;
	readonly source_type: string;
	readonly depth: number;
	readonly latest_at: string;
	readonly project: string | null;
	readonly session_key: string | null;
	readonly source_ref: string | null;
	readonly content: string;
}> {
	try {
		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT id, kind, COALESCE(source_type, kind) AS source_type, depth, latest_at,
					        project, session_key, source_ref, content
					 FROM session_summaries
					 WHERE agent_id = ?
					 ORDER BY latest_at DESC
					 LIMIT 20`,
					)
					.all(agentId) as Array<{
					id: string;
					kind: string;
					source_type: string;
					depth: number;
					latest_at: string;
					project: string | null;
					session_key: string | null;
					source_ref: string | null;
					content: string;
				}>,
		);
		return rows.filter(
			(row) =>
				!isNoiseSession({
					project: row.project,
					sessionKey: row.session_key,
					sessionId: row.id,
				}),
		);
	} catch {
		return [];
	}
}

function chooseSentence(rows: ReadonlyArray<ArtifactRow>): ArtifactRow | null {
	const ranked = [...rows].sort((a, b) => {
		const rank = (row: ArtifactRow): number => {
			if (row.source_kind === "summary") return 3;
			if (row.source_kind === "compaction") return 2;
			if (row.source_kind === "transcript") return 1;
			return 0;
		};
		return rank(b) - rank(a) || (b.ended_at ?? b.captured_at).localeCompare(a.ended_at ?? a.captured_at);
	});
	return ranked[0] ?? null;
}

function sessionProject(rows: ReadonlyArray<ArtifactRow>): string | null {
	for (const row of rows) {
		if (row.project) return row.project;
	}
	return null;
}

function sessionId(rows: ReadonlyArray<ArtifactRow>): string {
	return rows[0]?.session_id ?? "unknown";
}

function pathForKind(rows: ReadonlyArray<ArtifactRow>, kind: string): string | null {
	for (const row of rows) {
		if (row.source_kind === kind) return row.source_path;
	}
	return null;
}

function membershipTs(rows: ReadonlyArray<ArtifactRow>): string {
	const picked = chooseSentence(rows);
	if (!picked) return rows[0]?.captured_at ?? new Date().toISOString();
	return picked.ended_at ?? picked.captured_at;
}

function buildLedger(agentId: string): ReadonlyArray<LedgerSession> {
	const now = Date.now();
	const floor = now - 30 * 24 * 60 * 60 * 1000;
	let rows: ArtifactRow[] = [];
	try {
		rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT agent_id, source_path, source_sha256, source_kind, session_id, session_key,
					        session_token, project, harness, captured_at, started_at, ended_at,
					        manifest_path, source_node_id, memory_sentence, memory_sentence_quality, content
					 FROM memory_artifacts
					 WHERE agent_id = ?
					   AND source_kind IN ('summary', 'transcript', 'compaction')
					 ORDER BY COALESCE(ended_at, captured_at) DESC, captured_at DESC`,
					)
					.all(agentId) as ArtifactRow[],
		);
	} catch {
		rows = [];
	}

	const bySession = new Map<string, ArtifactRow[]>();
	for (const row of rows) {
		const bucket = bySession.get(row.session_token);
		if (bucket) {
			bucket.push(row);
			continue;
		}
		bySession.set(row.session_token, [row]);
	}

	const sessions: LedgerSession[] = [];
	for (const [token, group] of bySession) {
		const stamp = Date.parse(membershipTs(group));
		if (!Number.isFinite(stamp) || stamp < floor || stamp > now) continue;
		const picked = chooseSentence(group);
		if (!picked || !picked.memory_sentence) continue;
		if (
			isNoiseSession({
				project: sessionProject(group),
				sessionKey: picked.session_key,
				sessionId: sessionId(group),
				harness: picked.harness,
			})
		) {
			continue;
		}
		sessions.push({
			sessionToken: token,
			sessionId: sessionId(group),
			sessionKey: picked.session_key,
			project: sessionProject(group),
			membershipTs: membershipTs(group),
			sentence: coerceSentence(
				picked.memory_sentence,
				picked.content,
				picked.project,
				picked.harness,
				picked.source_kind,
			),
			summaryPath: pathForKind(group, "summary"),
			transcriptPath: pathForKind(group, "transcript"),
			compactionPath: pathForKind(group, "compaction"),
			manifestPath: picked.manifest_path,
		});
	}

	sessions.sort((a, b) => b.membershipTs.localeCompare(a.membershipTs));
	return sessions;
}

function renderLedgerRows(sessions: ReadonlyArray<LedgerSession>): string[] {
	if (sessions.length === 0) {
		return ["- no in-window sessions yet."];
	}

	const lines: string[] = [];
	let day = "";
	for (const session of sessions) {
		const utcDay = session.membershipTs.slice(0, 10);
		if (utcDay !== day) {
			day = utcDay;
			if (lines.length > 0) {
				lines.push("");
			}
			lines.push(`### ${utcDay}`, "");
		}
		const links = [
			session.summaryPath ? wikilink(session.summaryPath, "summary") : "",
			session.transcriptPath ? wikilink(session.transcriptPath, "transcript") : "",
			session.compactionPath ? wikilink(session.compactionPath, "compaction") : "",
			session.manifestPath ? wikilink(session.manifestPath, "manifest") : "",
		].filter((value) => value.length > 0);
		lines.push(
			`- ${session.membershipTs} | session=${session.sessionKey ?? session.sessionId} | project=${session.project ?? "none"} | ${session.sentence} ${links.join(" ")}`.trim(),
		);
	}
	return lines;
}

function renderLedgerSection(
	sessions: ReadonlyArray<LedgerSession>,
	base: ReadonlyArray<string>,
): { readonly block: string; readonly refs: ReadonlyArray<string>; readonly count: number } {
	function renderCount(count: number): string {
		const kept = sessions.slice(0, count);
		const clipped = sessions.length - kept.length;
		const lines =
			clipped > 0
				? [
						`- older ledger rows clipped: kept ${kept.length} of ${sessions.length} in-window sessions within projection budget.`,
						"",
						...renderLedgerRows(kept),
					]
				: renderLedgerRows(kept);
		return renderSection({
			heading: `## ${LEDGER_HEADING}`,
			lines,
		});
	}

	// renderCount is not monotone at the full-length boundary because dropping
	// one row adds the clipping notice. Check the unclipped case up front before
	// binary-searching clipped prefixes.
	if (fitsBudget([...base, renderCount(sessions.length)])) {
		const refs = sessions
			.map((session) => session.manifestPath)
			.filter((path): path is string => typeof path === "string");
		return {
			block: renderCount(sessions.length),
			refs,
			count: sessions.length,
		};
	}

	let low = 1;
	let high = sessions.length;
	let best = 0;
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const block = renderCount(mid);
		if (fitsBudget([...base, block])) {
			best = mid;
			low = mid + 1;
			continue;
		}
		high = mid - 1;
	}

	if (best > 0) {
		const kept = sessions.slice(0, best);
		const block = renderCount(best);
		const refs = kept.map((session) => session.manifestPath).filter((path): path is string => typeof path === "string");
		return {
			block,
			refs,
			count: kept.length,
		};
	}

	if (sessions.length === 0) {
		const block = renderCount(0);
		return {
			block,
			refs: [],
			count: 0,
		};
	}

	return {
		block: renderSection({
			heading: `## ${LEDGER_HEADING}`,
			lines: [`- older ledger rows clipped: kept 0 of ${sessions.length} in-window sessions within projection budget.`],
		}),
		refs: [],
		count: 0,
	};
}

function renderIndexSection(indexBlock: string, base: ReadonlyArray<string>): string {
	if (indexBlock.trim().length === 0) return "";
	if (fitsBudget([...base, indexBlock])) return indexBlock;

	const lines = indexBlock.split("\n");
	while (lines.length > 2) {
		lines.pop();
		const next = lines.join("\n").trimEnd();
		if (fitsBudget([...base, next])) {
			return next;
		}
	}

	return "";
}

function syncManifestRefs(
	refs: ReadonlyArray<string>,
	changedManifests: ReadonlySet<string> | undefined,
	agentId: string,
): void {
	const set = new Set(refs);
	let files: string[];
	if (changedManifests !== undefined) {
		const absFiles = new Set(changedManifests);
		const prev = prevLedgerRefsByAgent.get(agentId);
		if (prev) {
			const root = getAgentsDir();
			for (const rel of prev) {
				if (!set.has(rel)) {
					absFiles.add(join(root, rel));
				}
			}
		}
		prevLedgerRefsByAgent.set(agentId, set);
		if (absFiles.size === 0) return;
		files = [...absFiles];
	} else {
		prevLedgerRefsByAgent.set(agentId, set);
		files = listCanonicalFiles().filter((path) => path.endsWith("--manifest.md"));
	}
	for (const path of files) {
		const state = loadManifest(path);
		if (!state) continue;
		const rel = relativePath(path);
		const nextRefs = set.has(rel) ? [LEDGER_HEADING] : [];
		const currentRefs = Array.isArray(state.frontmatter.memory_md_refs)
			? state.frontmatter.memory_md_refs.filter((value): value is string => typeof value === "string")
			: [];
		if (currentRefs.length === nextRefs.length && currentRefs.every((value, idx) => value === nextRefs[idx])) {
			continue;
		}
		saveManifest(
			path,
			{
				...state.frontmatter,
				memory_md_refs: nextRefs,
				revision: state.revision + 1,
				updated_at: new Date().toISOString(),
			},
			state.body,
		);
	}
}

export function renderMemoryProjection(agentId = "default"): {
	content: string;
	fileCount: number;
	indexBlock: string;
} {
	reindexMemoryArtifacts(agentId);
	const changedManifests = lastChangedManifestsByAgent.get(agentId);
	lastChangedManifestsByAgent.delete(agentId);
	const memories = readTopMemories(agentId);
	const threadHeads = readThreadHeads(agentId);
	const nodes = readTemporalNodes(agentId);
	const ledger = buildLedger(agentId);
	const indexBlock = buildTemporalIndex(nodes);

	const globalLines =
		memories.length > 0
			? memories.map((row) => `- [${row.type}] ${row.content}`)
			: ["- no durable global head items yet."];
	const threadLines =
		threadHeads.length > 0
			? threadHeads.flatMap((row) => [
					`### ${row.label}`,
					`- ${row.sample}`,
					`- latest=${row.latest_at} source=${row.source_type} node=${row.node_id}`,
					"",
				])
			: ["- no thread heads yet."];
	const openLines =
		threadHeads.length > 0 ? threadHeads.slice(0, 8).map((row) => `- ${row.label}`) : ["- no open thread heads yet."];
	const durableLines =
		memories.length > 0 ? memories.slice(0, 8).map((row) => `- ${row.content}`) : ["- no durable notes yet."];

	const parts = [
		"# Working Memory Summary",
		renderSection({
			heading: "## Global Head (Tier 1)",
			lines: globalLines,
		}),
		renderSection({
			heading: "## Thread Heads (Tier 2)",
			lines: threadLines,
		}),
		renderSection({
			heading: "## Open Threads",
			lines: openLines,
		}),
		renderSection({
			heading: "## Durable Notes & Constraints",
			lines: durableLines,
		}),
	];
	const ledgerBlock = renderLedgerSection(ledger, parts);
	syncManifestRefs(ledgerBlock.refs, changedManifests, agentId);
	parts.push(ledgerBlock.block);
	const trimmedIndex = renderIndexSection(indexBlock, parts);
	if (trimmedIndex.length > 0) {
		parts.push(trimmedIndex);
	}

	return {
		content: joinParts(parts),
		fileCount: memories.length + threadHeads.length + ledgerBlock.count + nodes.length,
		indexBlock: trimmedIndex,
	};
}

export function appendSynthesisIndexBlock(content: string, indexBlock: string): string {
	const trimmed = content.trimEnd();
	if (trimmed.includes("## Temporal Index")) return trimmed;
	if (indexBlock.trim().length === 0) return trimmed;
	return `${trimmed}\n\n${indexBlock.trim()}`;
}

export function removeCanonicalSession(agentId: string, sessionToken: string, reason: string): void {
	const rows = getDbAccessor().withReadDb(
		(db) =>
			db
				.prepare(
					`SELECT source_path
				 FROM memory_artifacts
				 WHERE agent_id = ? AND session_token = ?`,
				)
				.all(agentId, sessionToken) as Array<{ source_path: string }>,
	);
	const paths = rows.map((row) => row.source_path);
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO memory_artifact_tombstones (
				agent_id, session_token, removed_at, reason, removed_paths
			) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(agent_id, session_token) DO UPDATE SET
				removed_at = excluded.removed_at,
				reason = excluded.reason,
				removed_paths = excluded.removed_paths`,
		).run(agentId, sessionToken, new Date().toISOString(), reason, JSON.stringify(paths));
		db.prepare("DELETE FROM memory_artifacts WHERE agent_id = ? AND session_token = ?").run(agentId, sessionToken);
	});
	for (const path of paths) {
		rmSync(join(getAgentsDir(), path), { force: true });
	}
}

function isNoiseArtifactGroup(
	rows: ReadonlyArray<{
		session_id: string;
		session_key: string | null;
		project: string | null;
		harness: string | null;
	}>,
): boolean {
	let hasProject = false;
	for (const row of rows) {
		if (isTempProject(row.project)) return true;
		if (typeof row.project === "string" && row.project.trim().length > 0) {
			hasProject = true;
		}
	}
	if (hasProject) return false;
	return rows.some((row) =>
		isNoiseSession({
			project: null,
			sessionKey: row.session_key,
			sessionId: row.session_id,
			harness: row.harness,
		}),
	);
}

export function purgeCanonicalNoiseSessions(agentId: string, reason: string): number {
	const rows = getDbAccessor().withReadDb(
		(db) =>
			db
				.prepare(
					`SELECT session_token, session_id, session_key, project, harness
				 FROM memory_artifacts
				 WHERE agent_id = ?
				   AND source_kind IN ('summary', 'transcript', 'compaction')
				 ORDER BY session_token`,
				)
				.all(agentId) as Array<{
				session_token: string;
				session_id: string;
				session_key: string | null;
				project: string | null;
				harness: string | null;
			}>,
	);
	const groups = new Map<
		string,
		Array<{
			session_id: string;
			session_key: string | null;
			project: string | null;
			harness: string | null;
		}>
	>();
	for (const row of rows) {
		const group = groups.get(row.session_token);
		if (group) {
			group.push(row);
			continue;
		}
		groups.set(row.session_token, [row]);
	}
	let count = 0;
	for (const [sessionToken, group] of groups) {
		if (!isNoiseArtifactGroup(group)) continue;
		removeCanonicalSession(agentId, sessionToken, reason);
		count++;
	}
	return count;
}

function purgeScope(agentId: string): string {
	return `${getAgentsDir()}\u0000${agentId}`;
}

export function purgeCanonicalNoiseSessionsOnce(agentId: string, reason: string): number {
	const key = purgeScope(agentId);
	if (purgeSeen.has(key)) return 0;
	const count = purgeCanonicalNoiseSessions(agentId, reason);
	purgeSeen.add(key);
	return count;
}

export function resetProjectionPurgeState(): void {
	purgeSeen.clear();
	artifactIndexCache.clear();
	lastChangedManifestsByAgent.clear();
	prevLedgerRefsByAgent.clear();
}
