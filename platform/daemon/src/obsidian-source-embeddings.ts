import { createHash } from "node:crypto";
import { relative } from "node:path";
import {
	scanMemoryContent,
	MEMORY_CONTENT_SAFETY_POLICY_VERSION,
	LEGACY_OBSIDIAN_CHUNK_SOURCE_TYPE,
	SOURCE_CHUNK_SOURCE_TYPE,
} from "@signet/core";
import { yieldEvery } from "./async-yield";
import { getDbAccessor } from "./db-accessor";
import { syncVecDeleteByEmbeddingIds, syncVecInsert, vectorToBlob } from "./db-helpers";
import { computeRetryBackoffMs } from "./embedding-repair-state";
import type { EmbeddingFetchOptions } from "./embedding-fetch";
import type { PipelineCauseFamily } from "./pipeline-operation";
import { isActiveEmbeddingConfig, resolveActiveEmbeddingConfig } from "./embedding-index-state";
import { embeddingProfileFingerprint } from "./embedding-profile";
import { dbOwnerBatch, dbOwnerQuery, ownerStatement } from "./db-owner-runtime";
import type { EmbeddingRole } from "./embedding-profile";
import type { EmbeddingConfig } from "./memory-config";
import { upsertMemoryContentSafetyInTx } from "./memory-content-safety";
import {
	awaitEmbeddingProviderAvailable,
	recordEmbeddingProviderFailure,
	shouldEmitEmbeddingProviderNotice,
} from "./embedding-circuit-breaker";
import { logger } from "./logger";

export const OBSIDIAN_CHUNK_SOURCE_TYPE = SOURCE_CHUNK_SOURCE_TYPE;
const OBSIDIAN_SOURCE_CHUNK_DELAY_MS = 100;
const EMBEDDING_PROVIDER_PROBE_TEXT = "Signet embedding provider health check.";
const OBSIDIAN_CHUNK_SOURCE_TYPES = [SOURCE_CHUNK_SOURCE_TYPE, LEGACY_OBSIDIAN_CHUNK_SOURCE_TYPE] as const;

export type SourceEmbeddingFetch = (
	text: string,
	cfg: EmbeddingConfig,
	role?: EmbeddingRole,
	opts?: EmbeddingFetchOptions,
) => Promise<number[] | null>;

export interface ObsidianSourceChunk {
	readonly id: string;
	readonly text: string;
	readonly chunkText: string;
	readonly heading: string;
	readonly headingPath: string;
	readonly startLine: number;
	readonly endLine: number;
}

export interface IndexObsidianSourceEmbeddingsInput {
	readonly agentId: string;
	readonly sourceId: string;
	readonly root: string;
	readonly filePath: string;
	readonly content: string;
	/** Chunks prepared by the killable native-source worker. */
	readonly chunks?: readonly ObsidianSourceChunk[];
	readonly embeddingConfig: EmbeddingConfig;
	readonly fetchEmbedding: SourceEmbeddingFetch;
	readonly checkpoint?: {
		readonly sourceKey: string;
		readonly scanned: number;
		readonly cursor: string | null;
		readonly frontier: readonly string[] | null;
		readonly complete: boolean;
	};
	readonly signal?: AbortSignal;
}

export interface IndexObsidianSourceEmbeddingsResult {
	readonly chunks: number;
	readonly embedded: number;
	readonly skipped: number;
	readonly status?: typeof EMBEDDINGS_PENDING_PROVIDER_DOWN;
	readonly providerUnavailable: boolean;
	readonly retryAfterMs?: number;
}

export const EMBEDDINGS_PENDING_PROVIDER_DOWN = "embeddings pending - provider down";

interface SourceEmbeddingFailureState {
	readonly attempts: number;
	readonly retryAt: number;
}

const SOURCE_EMBEDDING_POLL_MS = 10_000;
const sourceEmbeddingFailures = new Map<string, SourceEmbeddingFailureState>();

export function resetObsidianSourceEmbeddingBackoff(): void {
	sourceEmbeddingFailures.clear();
}

function sourceEmbeddingFailureKey(input: IndexObsidianSourceEmbeddingsInput, model: string): string {
	return `${input.agentId}:${input.sourceId}:${normalizePath(input.filePath)}:${model}`;
}

function providerUnavailableCause(cause: PipelineCauseFamily): boolean {
	return cause === "provider_unavailable" || cause === "timeout";
}

export interface PurgeObsidianSourceEmbeddingsInput {
	readonly sourceId: string;
	readonly agentId?: string;
	readonly signal?: AbortSignal;
}

export interface PurgeObsidianSourceFileEmbeddingsInput {
	readonly sourceId: string;
	readonly agentId?: string;
	readonly root: string;
	readonly filePath: string;
	readonly signal?: AbortSignal;
}

interface MarkdownSection {
	readonly heading: string;
	readonly headingPath: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly body: string;
}

const TARGET_CHARS = 1_600;
const MAX_CHARS = 2_200;
const MIN_CHARS = 40;

function normalizePath(path: string): string {
	return path.replace(/\\/g, "/");
}

function relPath(root: string, filePath: string): string {
	return normalizePath(relative(root, filePath));
}

function stripFrontmatterLines(lines: string[]): { lines: string[]; lineOffset: number } {
	if (lines[0] !== "---") return { lines, lineOffset: 0 };
	const end = lines.findIndex((line, index) => index > 0 && line === "---");
	if (end === -1) return { lines, lineOffset: 0 };
	return { lines: lines.slice(end + 1), lineOffset: end + 1 };
}

function slug(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
}

function hash(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

function parseMarkdownSections(content: string): MarkdownSection[] {
	const rawLines = content.replace(/\r\n?/g, "\n").split("\n");
	const stripped = stripFrontmatterLines(rawLines);
	const lines = stripped.lines;
	const sections: Array<{ heading: string; headingPath: string; startLine: number; lines: string[] }> = [];
	const headingStack: Array<{ level: number; title: string }> = [];
	let current: { heading: string; headingPath: string; startLine: number; lines: string[] } = {
		heading: "Overview",
		headingPath: "Overview",
		startLine: stripped.lineOffset + 1,
		lines: [],
	};

	function pushCurrent(endLine: number): void {
		const body = current.lines.join("\n").trim();
		if (!body && current.heading === "Overview") return;
		sections.push({ ...current, lines: current.lines.slice(0, Math.max(0, endLine - current.startLine + 1)) });
	}

	for (let idx = 0; idx < lines.length; idx++) {
		const line = lines[idx] ?? "";
		const absoluteLine = stripped.lineOffset + idx + 1;
		const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
		if (match) {
			pushCurrent(absoluteLine - 1);
			const level = match[1]?.length ?? 1;
			const title = match[2]?.trim() || "Untitled";
			while (headingStack.length > 0 && (headingStack[headingStack.length - 1]?.level ?? 0) >= level)
				headingStack.pop();
			headingStack.push({ level, title });
			const headingPath = headingStack.map((item) => item.title).join(" / ");
			current = { heading: title, headingPath, startLine: absoluteLine, lines: [] };
			continue;
		}
		current.lines.push(line);
	}
	pushCurrent(stripped.lineOffset + lines.length);

	return sections
		.map((section) => ({
			heading: section.heading,
			headingPath: section.headingPath,
			startLine: section.startLine,
			endLine: section.startLine + section.lines.length,
			body: section.lines.join("\n").trim(),
		}))
		.filter((section) => section.body.length >= MIN_CHARS);
}

function splitParagraphs(body: string): string[] {
	return body
		.split(/\n{2,}|\n(?=-\s+)|\n(?=\d+\.\s+)/)
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

function splitLongText(text: string): string[] {
	if (text.length <= MAX_CHARS) return [text];
	const chunks: string[] = [];
	for (let start = 0; start < text.length; start += TARGET_CHARS) {
		chunks.push(text.slice(start, start + MAX_CHARS).trim());
	}
	return chunks.filter((chunk) => chunk.length >= MIN_CHARS);
}

export function buildObsidianSourceChunks(input: {
	readonly sourceId: string;
	readonly root: string;
	readonly filePath: string;
	readonly content: string;
}): ObsidianSourceChunk[] {
	const root = normalizePath(input.root).replace(/\/$/, "");
	const filePath = normalizePath(input.filePath);
	const relativePath = relPath(root, filePath);
	const chunks: ObsidianSourceChunk[] = [];
	for (const section of parseMarkdownSections(input.content)) {
		const paragraphs = splitParagraphs(section.body);
		let bucket = "";
		let chunkIndex = 0;
		const flush = (): void => {
			const trimmed = bucket.trim();
			if (trimmed.length < MIN_CHARS) {
				bucket = "";
				return;
			}
			for (const piece of splitLongText(trimmed)) {
				const headingKey = slug(section.headingPath) || "overview";
				const lineKey = `${section.startLine}-${section.endLine}`;
				const chunkId = `${input.sourceId}:${relativePath}#${headingKey}:${lineKey}:${chunkIndex}`;
				const chunkText = [
					`source_id: ${input.sourceId}`,
					"source_provider: obsidian",
					`source_root: ${root}`,
					`source_path: ${filePath}`,
					`vault_relative_path: ${relativePath}`,
					`heading: ${section.headingPath}`,
					`lines: ${section.startLine}-${section.endLine}`,
					"",
					piece,
				].join("\n");
				chunks.push({
					id: chunkId,
					text: piece,
					chunkText,
					heading: section.heading,
					headingPath: section.headingPath,
					startLine: section.startLine,
					endLine: section.endLine,
				});
				chunkIndex++;
			}
			bucket = "";
		};
		for (const paragraph of paragraphs) {
			if (paragraph.length > MAX_CHARS) {
				flush();
				for (const piece of splitLongText(paragraph)) {
					bucket = piece;
					flush();
				}
				continue;
			}
			const candidate = bucket ? `${bucket}\n\n${paragraph}` : paragraph;
			if (candidate.length > TARGET_CHARS) {
				flush();
				bucket = paragraph;
			} else {
				bucket = candidate;
			}
		}
		flush();
	}
	return chunks;
}

export async function indexObsidianSourceEmbeddingsViaOwner(
	input: IndexObsidianSourceEmbeddingsInput,
): Promise<IndexObsidianSourceEmbeddingsResult> {
	const chunks = input.chunks === undefined ? buildObsidianSourceChunks(input) : [...input.chunks];
	const configured = await ownerEmbeddingConfig(input.embeddingConfig, input.signal);
	if (configured.provider === "none") return { chunks: 0, embedded: 0, skipped: 0, providerUnavailable: false };
	const failureKey = sourceEmbeddingFailureKey(input, configured.model);
	const providerKey = `${configured.provider}:${configured.model}:${configured.base_url ?? ""}`;
	let probeCause: PipelineCauseFamily | null = null;
	const gate = await awaitEmbeddingProviderAvailable(
		providerKey,
		async () => {
			const probe = await input.fetchEmbedding(EMBEDDING_PROVIDER_PROBE_TEXT, configured, "document", {
				usage: { source: "artifact-index", agentId: input.agentId },
				onFailure: (cause) => {
					probeCause = cause;
				},
			});
			return Boolean(probe?.length) && (probeCause === null || !providerUnavailableCause(probeCause));
		},
		SOURCE_EMBEDDING_POLL_MS,
		() => logger.warn("embedding", `Embedding provider unavailable; retrying source indexing (${providerKey})`),
	);
	if (!gate.available)
		return {
			chunks: chunks.length,
			embedded: 0,
			skipped: chunks.length,
			status: EMBEDDINGS_PENDING_PROVIDER_DOWN,
			providerUnavailable: true,
			retryAfterMs: gate.retryAfterMs,
		};
	const failureState = sourceEmbeddingFailures.get(failureKey);
	if (failureState && failureState.retryAt > Date.now())
		return {
			chunks: chunks.length,
			embedded: 0,
			skipped: chunks.length,
			status: EMBEDDINGS_PENDING_PROVIDER_DOWN,
			providerUnavailable: true,
			retryAfterMs: failureState.retryAt - Date.now(),
		};
	const vecAvailable = await ownerVecTableExists(input.signal);
	const vecDimensions = vecAvailable ? await ownerVecDimensions(input.signal) : null;
	const safetyAvailable = await ownerSafetyTableExists(input.signal);
	const currentHashes = new Set<string>();
	let embedded = 0;
	let skipped = 0;
	let providerUnavailable = false;
	let retryAfterMs: number | undefined;
	for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
		input.signal?.throwIfAborted();
		const chunk = chunks[chunkIndex];
		if (!chunk) continue;
		const contentHash = hash(`${input.agentId}\n${chunk.id}\n${chunk.chunkText}`);
		const embeddingId = hash(`${OBSIDIAN_CHUNK_SOURCE_TYPE}:${input.agentId}:${chunk.id}`).slice(0, 32);
		currentHashes.add(contentHash);
		const existing = await dbOwnerQuery<{ readonly id: string; readonly content_hash: string } | null>(
			ownerStatement(
				"SELECT id, content_hash FROM embeddings WHERE source_type IN (?, ?) AND source_id = ? AND agent_id = ? LIMIT 1",
				[SOURCE_CHUNK_SOURCE_TYPE, LEGACY_OBSIDIAN_CHUNK_SOURCE_TYPE, chunk.id, input.agentId],
				"get",
			),
			{ operation: "sources.embeddings.owner.existing", lane: "read", signal: input.signal },
		);
		if (existing?.content_hash === contentHash) {
			if (safetyAvailable)
				await dbOwnerBatch([ownerSafetyStatement(input.agentId, embeddingId, chunk.chunkText)], {
					operation: "sources.embeddings.owner.safety",
					lane: "write",
					workloadClass: "maintenance",
					signal: input.signal,
				});
			skipped++;
			continue;
		}
		let failureCause: PipelineCauseFamily = "provider_unavailable";
		const vector = await input.fetchEmbedding(chunk.chunkText, configured, "document", {
			usage: { source: "artifact-index", agentId: input.agentId },
			onFailure: (cause) => {
				failureCause = cause;
			},
		});
		if (!vector || vector.length === 0) {
			if (providerUnavailableCause(failureCause)) {
				recordEmbeddingProviderFailure(providerKey, SOURCE_EMBEDDING_POLL_MS);
				if (shouldEmitEmbeddingProviderNotice(providerKey))
					logger.warn("embedding", `Embedding provider unavailable; retrying source indexing (${providerKey})`);
				const attempts = (failureState?.attempts ?? 0) + 1;
				retryAfterMs = computeRetryBackoffMs(attempts, SOURCE_EMBEDDING_POLL_MS);
				sourceEmbeddingFailures.set(failureKey, { attempts, retryAt: Date.now() + retryAfterMs });
				providerUnavailable = true;
				skipped += chunks.length - chunkIndex;
				break;
			}
			skipped++;
			continue;
		}
		const active = await ownerEmbeddingConfig(configured);
		if (embeddingProfileFingerprint(active) !== embeddingProfileFingerprint(configured)) {
			skipped++;
			continue;
		}
		const statements = [] as Array<ReturnType<typeof ownerStatement>>;
		if (existing && vecAvailable && existing.content_hash !== contentHash)
			statements.push(ownerStatement("DELETE FROM vec_embeddings WHERE id = ?", [existing.id]));
		if (existing && existing.content_hash !== contentHash)
			statements.push(ownerStatement("DELETE FROM embeddings WHERE id = ?", [existing.id]));
		statements.push(
			ownerStatement(
				`INSERT INTO embeddings
				 (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(content_hash) DO UPDATE SET vector = excluded.vector, dimensions = excluded.dimensions,
				 source_type = excluded.source_type, source_id = excluded.source_id, chunk_text = excluded.chunk_text,
				 created_at = excluded.created_at, agent_id = excluded.agent_id`,
				[
					embeddingId,
					contentHash,
					{ type: "bytes", base64: vectorToBlob(vector).toString("base64") },
					vector.length,
					OBSIDIAN_CHUNK_SOURCE_TYPE,
					chunk.id,
					chunk.chunkText,
					new Date().toISOString(),
					input.agentId,
				],
			),
		);
		if (safetyAvailable) statements.push(ownerSafetyStatement(input.agentId, embeddingId, chunk.chunkText));
		if (vecAvailable && vecDimensions === vector.length)
			statements.push(
				ownerStatement("INSERT OR REPLACE INTO vec_embeddings (id, embedding) VALUES (?, ?)", [
					embeddingId,
					{ type: "bytes", base64: vectorToBlob(vector).toString("base64") },
				]),
			);
		await dbOwnerBatch(statements, {
			operation: "sources.embeddings.owner.write",
			lane: "write",
			workloadClass: "maintenance",
			estimatedWorkUnits: statements.length,
			signal: input.signal,
		});
		embedded++;
	}
	if (!providerUnavailable) {
		const prefix = `${input.sourceId}:${relPath(normalizePath(input.root).replace(/\/$/, ""), normalizePath(input.filePath))}#`;
		const stale = await dbOwnerQuery<
			readonly { readonly id: string; readonly source_type: string; readonly content_hash: string }[]
		>(
			ownerStatement(
				"SELECT id, source_type, content_hash FROM embeddings WHERE source_type IN (?, ?) AND source_id >= ? AND source_id < ? AND agent_id = ?",
				[SOURCE_CHUNK_SOURCE_TYPE, LEGACY_OBSIDIAN_CHUNK_SOURCE_TYPE, prefix, prefixUpperBound(prefix), input.agentId],
				"all",
			),
			{ operation: "sources.embeddings.owner.stale", lane: "read", signal: input.signal },
		);
		const staleIds = stale
			.filter((row) => row.source_type === LEGACY_OBSIDIAN_CHUNK_SOURCE_TYPE || !currentHashes.has(row.content_hash))
			.map((row) => row.id);
		const checkpointStatement =
			input.checkpoint === undefined
				? null
				: ownerStatement(
						`INSERT INTO source_sync_checkpoints
						 (agent_id, source_key, phase, cursor, frontier, scanned, complete, updated_at)
						 VALUES (?, ?, 'content', ?, ?, ?, ?, datetime('now'))
						 ON CONFLICT(agent_id, source_key, phase) DO UPDATE SET
						 cursor = excluded.cursor,
						 frontier = excluded.frontier,
						 scanned = excluded.scanned,
						 complete = excluded.complete,
						 updated_at = excluded.updated_at`,
						[
							input.agentId,
							input.checkpoint.sourceKey,
							input.checkpoint.cursor,
							input.checkpoint.frontier === null ? null : JSON.stringify(input.checkpoint.frontier),
							input.checkpoint.scanned,
							input.checkpoint.complete ? 1 : 0,
						],
					);
		if (staleIds.length > 0 || checkpointStatement !== null) {
			const statements = [
				...(vecAvailable
					? [ownerStatement(`DELETE FROM vec_embeddings WHERE id IN (${staleIds.map(() => "?").join(", ")})`, staleIds)]
					: []),
				...(staleIds.length > 0
					? [ownerStatement(`DELETE FROM embeddings WHERE id IN (${staleIds.map(() => "?").join(", ")})`, staleIds)]
					: []),
				...(checkpointStatement === null ? [] : [checkpointStatement]),
			];
			await dbOwnerBatch(statements, {
				operation: "sources.embeddings.owner.stale.delete",
				lane: "write",
				workloadClass: "maintenance",
				signal: input.signal,
			});
		}
	}
	return providerUnavailable
		? {
				chunks: chunks.length,
				embedded,
				skipped,
				status: EMBEDDINGS_PENDING_PROVIDER_DOWN,
				providerUnavailable: true,
				retryAfterMs,
			}
		: { chunks: chunks.length, embedded, skipped, providerUnavailable: false };
}

export async function purgeObsidianSourceFileEmbeddingsViaOwner(
	input: PurgeObsidianSourceFileEmbeddingsInput,
): Promise<number> {
	const prefix = `${input.sourceId}:${relPath(normalizePath(input.root).replace(/\/$/, ""), normalizePath(input.filePath))}#`;
	return await purgeObsidianSourceEmbeddingsByPrefixViaOwner(prefix, input.agentId, input.signal);
}

export async function purgeObsidianSourceEmbeddingsViaOwner(
	input: PurgeObsidianSourceEmbeddingsInput,
): Promise<number> {
	return await purgeObsidianSourceEmbeddingsByPrefixViaOwner(`${input.sourceId}:`, input.agentId, input.signal);
}

async function purgeObsidianSourceEmbeddingsByPrefixViaOwner(
	prefix: string,
	agentId?: string,
	signal?: AbortSignal,
): Promise<number> {
	const agentWhere = agentId ? " AND agent_id = ?" : "";
	const args = agentId ? [prefix, prefixUpperBound(prefix), agentId] : [prefix, prefixUpperBound(prefix)];
	const rows = await dbOwnerQuery<readonly { readonly id: string }[]>(
		ownerStatement(
			`SELECT id FROM embeddings WHERE source_type IN (?, ?) AND source_id >= ? AND source_id < ?${agentWhere}`,
			[SOURCE_CHUNK_SOURCE_TYPE, LEGACY_OBSIDIAN_CHUNK_SOURCE_TYPE, ...args],
			"all",
		),
		{ operation: "sources.embeddings.owner.purge.read", lane: "read", signal },
	);
	if (rows.length === 0) return 0;
	const ids = rows.map((row) => row.id);
	const vec = await ownerVecTableExists(signal);
	await dbOwnerBatch(
		[
			...(vec
				? [ownerStatement(`DELETE FROM vec_embeddings WHERE id IN (${ids.map(() => "?").join(", ")})`, ids)]
				: []),
			ownerStatement(`DELETE FROM embeddings WHERE id IN (${ids.map(() => "?").join(", ")})`, ids),
		],
		{ operation: "sources.embeddings.owner.purge.write", lane: "write", workloadClass: "maintenance", signal },
	);
	return ids.length;
}

interface OwnerEmbeddingStateRow {
	readonly active_profile_json: string;
	readonly state: string;
}

async function ownerEmbeddingConfig(configured: EmbeddingConfig, signal?: AbortSignal): Promise<EmbeddingConfig> {
	if (configured.profile) return configured;
	const row = await dbOwnerQuery<OwnerEmbeddingStateRow | null>(
		ownerStatement("SELECT active_profile_json, state FROM embedding_index_state WHERE id = 1", [], "get"),
		{ operation: "sources.embeddings.owner.config", lane: "read", signal },
	);
	if (row === null) return configured;
	try {
		const active = JSON.parse(row.active_profile_json) as Record<string, unknown>;
		if (
			typeof active.provider !== "string" ||
			typeof active.model !== "string" ||
			typeof active.dimensions !== "number"
		)
			return configured;
		return {
			...configured,
			provider: active.provider as EmbeddingConfig["provider"],
			model: active.model,
			dimensions: active.dimensions,
			base_url: typeof active.baseUrl === "string" ? active.baseUrl : configured.base_url,
			profile: typeof active.profile === "string" ? active.profile : undefined,
		};
	} catch {
		return configured;
	}
}

async function ownerVecTableExists(signal?: AbortSignal): Promise<boolean> {
	const row = await dbOwnerQuery<{ readonly name: string } | null>(
		ownerStatement("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vec_embeddings'", [], "get"),
		{ operation: "sources.embeddings.owner.vec", lane: "read", signal },
	);
	return row !== null;
}

async function ownerVecDimensions(signal?: AbortSignal): Promise<number | null> {
	const row = await dbOwnerQuery<{ readonly sql: string } | null>(
		ownerStatement("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vec_embeddings'", [], "get"),
		{ operation: "sources.embeddings.owner.vec-dimensions", lane: "read", signal },
	);
	const match = row?.sql.match(/float\s*\[\s*(\d+)\s*\]/i);
	return match?.[1] === undefined ? null : Number(match[1]);
}

async function ownerSafetyTableExists(signal?: AbortSignal): Promise<boolean> {
	const row = await dbOwnerQuery<{ readonly name: string } | null>(
		ownerStatement("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_content_safety'", [], "get"),
		{ operation: "sources.embeddings.owner.safety-table", lane: "read", signal },
	);
	return row !== null;
}

function ownerSafetyStatement(agentId: string, sourceId: string, content: string): ReturnType<typeof ownerStatement> {
	const assessment = scanMemoryContent(content);
	return ownerStatement(
		`INSERT INTO memory_content_safety
		 (agent_id, source_kind, source_id, status, context_eligible, reasons_json, policy_version, scanned_at)
		 VALUES (?, 'source_chunk', ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(agent_id, source_kind, source_id) DO UPDATE SET status = excluded.status,
		 context_eligible = excluded.context_eligible, reasons_json = excluded.reasons_json,
		 policy_version = excluded.policy_version, scanned_at = excluded.scanned_at`,
		[
			agentId,
			sourceId,
			assessment.status,
			assessment.contextEligible ? 1 : 0,
			JSON.stringify(assessment.reasons),
			MEMORY_CONTENT_SAFETY_POLICY_VERSION,
			new Date().toISOString(),
		],
	);
}

export async function indexObsidianSourceEmbeddings(
	input: IndexObsidianSourceEmbeddingsInput,
): Promise<IndexObsidianSourceEmbeddingsResult> {
	// Source watchers outlive a config edit. Keep their writes compatible with
	// active recall while the requested profile is built in the inactive slot.
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
	const embeddingConfig = getDbAccessor().withReadDb(
		(db: import("./db-accessor").ReadDb) => resolveActiveEmbeddingConfig(db, input.embeddingConfig),
		"obsidian-source-embeddings.ts:630",
	);
	if (embeddingConfig.provider === "none") return { chunks: 0, embedded: 0, skipped: 0, providerUnavailable: false };
	const chunks = buildObsidianSourceChunks(input);
	const failureKey = sourceEmbeddingFailureKey(input, embeddingConfig.model);
	const failureState = sourceEmbeddingFailures.get(failureKey);
	if (failureState && failureState.retryAt > Date.now()) {
		return {
			chunks: chunks.length,
			embedded: 0,
			skipped: chunks.length,
			status: EMBEDDINGS_PENDING_PROVIDER_DOWN,
			providerUnavailable: true,
			retryAfterMs: failureState.retryAt - Date.now(),
		};
	}
	if (failureState) sourceEmbeddingFailures.delete(failureKey);
	const currentHashes = new Set<string>();
	const yielder = yieldEvery(1);
	let embedded = 0;
	let skipped = 0;
	let providerUnavailable = false;
	let retryAfterMs: number | undefined;
	const now = new Date().toISOString();

	for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
		const chunk = chunks[chunkIndex];
		if (!chunk) continue;
		const contentHash = hash(`${input.agentId}\n${chunk.id}\n${chunk.chunkText}`);
		const embId = hash(`${OBSIDIAN_CHUNK_SOURCE_TYPE}:${input.agentId}:${chunk.id}`).slice(0, 32);
		currentHashes.add(contentHash);
		const existingChunk = existingChunkEmbedding(input.agentId, chunk.id);
		if (existingChunk?.content_hash === contentHash) {
			// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
			getDbAccessor().withWriteTx(
				(db: import("./db-accessor").WriteDb) =>
					upsertMemoryContentSafetyInTx(db, {
						agentId: input.agentId,
						sourceKind: "source_chunk",
						sourceId: existingChunk.id,
						content: chunk.chunkText,
					}),
				"obsidian-source-embeddings.ts:666",
			);
			skipped++;
			await yielder();
			await sleep(OBSIDIAN_SOURCE_CHUNK_DELAY_MS);
			continue;
		}
		// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
		const writeConfig = getDbAccessor().withReadDb(
			(db: import("./db-accessor").ReadDb) => resolveActiveEmbeddingConfig(db, input.embeddingConfig),
			"obsidian-source-embeddings.ts:682",
		);
		let failureCause: PipelineCauseFamily = "provider_unavailable";
		const vector = await input.fetchEmbedding(chunk.chunkText, writeConfig, "document", {
			usage: { source: "artifact-index", agentId: input.agentId },
			onFailure: (cause) => {
				failureCause = cause;
			},
		});
		if (!vector || vector.length === 0) {
			if (providerUnavailableCause(failureCause)) {
				const activeProviderKey = `${writeConfig.provider}:${writeConfig.model}:${writeConfig.base_url ?? ""}`;
				recordEmbeddingProviderFailure(activeProviderKey, SOURCE_EMBEDDING_POLL_MS);
				if (shouldEmitEmbeddingProviderNotice(activeProviderKey))
					logger.warn("embedding", `Embedding provider unavailable; retrying source indexing (${activeProviderKey})`);
				const attempts = (failureState?.attempts ?? 0) + 1;
				retryAfterMs = computeRetryBackoffMs(attempts, SOURCE_EMBEDDING_POLL_MS);
				sourceEmbeddingFailures.set(failureKey, { attempts, retryAt: Date.now() + retryAfterMs });
				providerUnavailable = true;
				// Do not probe the same dead provider once per chunk. The source
				// artifact and graph work above remain committed, while all
				// embeddings stay pending for the next backoff window.
				skipped += chunks.length - chunkIndex;
				break;
			}
			skipped++;
			await yielder();
			await sleep(OBSIDIAN_SOURCE_CHUNK_DELAY_MS);
			continue;
		}
		sourceEmbeddingFailures.delete(failureKey);
		// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
		const stored = getDbAccessor().withWriteTx((db: import("./db-accessor").WriteDb) => {
			// Recheck after the asynchronous provider call: promotion may have
			// committed a new active space while this chunk was encoding.
			if (!isActiveEmbeddingConfig(db, writeConfig)) return false;
			const existingForId = db.prepare("SELECT content_hash FROM embeddings WHERE id = ?").get(embId) as
				| { content_hash: string }
				| undefined;
			if (existingForId && existingForId.content_hash !== contentHash) {
				if (!syncVecDeleteByEmbeddingIds(db, [embId])) {
					throw new Error("failed to reconcile vec_embeddings before replacing source embedding");
				}
				db.prepare("DELETE FROM embeddings WHERE id = ?").run(embId);
			}
			db.prepare(
				`INSERT INTO embeddings
				 (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(content_hash) DO UPDATE SET
				   vector = excluded.vector,
				   dimensions = excluded.dimensions,
				   source_type = excluded.source_type,
				   source_id = excluded.source_id,
				   chunk_text = excluded.chunk_text,
				   created_at = excluded.created_at,
				   agent_id = excluded.agent_id`,
			).run(
				embId,
				contentHash,
				vectorToBlob(vector),
				vector.length,
				OBSIDIAN_CHUNK_SOURCE_TYPE,
				chunk.id,
				chunk.chunkText,
				now,
				input.agentId,
			);
			upsertMemoryContentSafetyInTx(db, {
				agentId: input.agentId,
				sourceKind: "source_chunk",
				sourceId: embId,
				content: chunk.chunkText,
			});
			const stored = db.prepare("SELECT id FROM embeddings WHERE content_hash = ?").get(contentHash) as
				| { id: string }
				| undefined;
			syncVecInsert(db, stored?.id ?? embId, vector);
			return true;
		}, "obsidian-source-embeddings.ts:716");
		if (!stored) {
			skipped++;
			await yielder();
			await sleep(OBSIDIAN_SOURCE_CHUNK_DELAY_MS);
			continue;
		}
		embedded++;
		await yielder();
		await sleep(OBSIDIAN_SOURCE_CHUNK_DELAY_MS);
	}

	if (!providerUnavailable)
		// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
		getDbAccessor().withWriteTx((db: import("./db-accessor").WriteDb) => {
			const prefix = `${input.sourceId}:${relPath(normalizePath(input.root).replace(/\/$/, ""), normalizePath(input.filePath))}#`;
			const stale = OBSIDIAN_CHUNK_SOURCE_TYPES.flatMap(
				(sourceType) =>
					db
						.prepare(
							"SELECT id, source_type, content_hash FROM embeddings WHERE source_type = ? AND source_id >= ? AND source_id < ? AND agent_id = ?",
						)
						.all(sourceType, prefix, prefixUpperBound(prefix), input.agentId) as Array<{
						id: string;
						source_type: string;
						content_hash: string;
					}>,
			);
			const staleIds = stale
				.filter((row) => row.source_type === LEGACY_OBSIDIAN_CHUNK_SOURCE_TYPE || !currentHashes.has(row.content_hash))
				.map((row) => row.id);
			if (staleIds.length > 0) {
				if (!syncVecDeleteByEmbeddingIds(db, staleIds)) {
					throw new Error("failed to reconcile vec_embeddings before removing stale source embeddings");
				}
				const stmt = db.prepare("DELETE FROM embeddings WHERE id = ?");
				for (const id of staleIds) stmt.run(id);
			}
		}, "obsidian-source-embeddings.ts:777");

	return {
		chunks: chunks.length,
		embedded,
		skipped,
		...(providerUnavailable
			? {
					status: EMBEDDINGS_PENDING_PROVIDER_DOWN as typeof EMBEDDINGS_PENDING_PROVIDER_DOWN,
					providerUnavailable: true,
					retryAfterMs,
				}
			: { providerUnavailable: false }),
	};
}

function sleep(ms: number): Promise<void> {
	return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function existingChunkEmbedding(agentId: string, chunkId: string): { id: string; content_hash: string } | null {
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
	const row = getDbAccessor().withReadDb(
		(db: import("./db-accessor").ReadDb) =>
			db
				.prepare(
					"SELECT id, content_hash FROM embeddings WHERE source_type IN (?, ?) AND source_id = ? AND agent_id = ? LIMIT 1",
				)
				.get(SOURCE_CHUNK_SOURCE_TYPE, LEGACY_OBSIDIAN_CHUNK_SOURCE_TYPE, chunkId, agentId),
		"obsidian-source-embeddings.ts:823",
	) as { id: string; content_hash: string } | undefined;
	return row ?? null;
}

export function purgeObsidianSourceFileEmbeddings(input: PurgeObsidianSourceFileEmbeddingsInput): number {
	const prefix = `${input.sourceId}:${relPath(normalizePath(input.root).replace(/\/$/, ""), normalizePath(input.filePath))}#`;
	return purgeEmbeddingsBySourceIdPrefix(prefix, input.agentId);
}

export function purgeObsidianSourceEmbeddings(input: PurgeObsidianSourceEmbeddingsInput): number {
	return purgeEmbeddingsBySourceIdPrefix(`${input.sourceId}:`, input.agentId);
}

function purgeEmbeddingsBySourceIdPrefix(prefix: string, agentId?: string): number {
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
	return getDbAccessor().withWriteTx((db: import("./db-accessor").WriteDb) => {
		const agentWhere = agentId ? " AND agent_id = ?" : "";
		const upper = prefixUpperBound(prefix);
		let changes = 0;
		for (const sourceType of OBSIDIAN_CHUNK_SOURCE_TYPES) {
			const args = agentId ? [sourceType, prefix, upper, agentId] : [sourceType, prefix, upper];
			const rows = db
				.prepare(`SELECT id FROM embeddings WHERE source_type = ? AND source_id >= ? AND source_id < ?${agentWhere}`)
				.all(...args) as Array<{ id: string }>;
			// Derived vectors must be removed before their canonical embedding rows.
			// Throwing rolls back the whole source purge and leaves it retryable.
			if (
				!syncVecDeleteByEmbeddingIds(
					db,
					rows.map((row) => row.id),
				)
			) {
				throw new Error("failed to reconcile vec_embeddings before purging source embeddings");
			}
			const result = db
				.prepare(`DELETE FROM embeddings WHERE source_type = ? AND source_id >= ? AND source_id < ?${agentWhere}`)
				.run(...args);
			changes += result.changes;
		}
		return changes;
	}, "obsidian-source-embeddings.ts:846");
}

function prefixUpperBound(prefix: string): string {
	return `${prefix}\uffff`;
}
