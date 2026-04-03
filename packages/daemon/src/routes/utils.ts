import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSimpleYaml } from "@signet/core";
import type { Context } from "hono";
import { normalizeAndHashContent } from "../content-normalization";
import { getAgentPresenceForSession } from "../cross-agent";
import { getDbAccessor } from "../db-accessor";
import {
	fetchEmbedding,
	resolveEmbeddingApiKey,
	resolveEmbeddingBaseUrl,
	resolveOllamaUrl,
	setNativeFallbackToOllama,
} from "../embedding-fetch";
import { logger } from "../logger";
import type { EmbeddingConfig } from "../memory-config";
import {
	resolveScopedAgent,
	resolveScopedProject as resolveScopedProjectForClaims,
	shouldEnforceScope,
} from "../request-scope";
import { authConfig } from "./state";

export interface EmbeddingStatus {
	provider: "native" | "ollama" | "openai" | "none";
	model: string;
	available: boolean;
	modelCached?: boolean;
	dimensions?: number;
	base_url: string;
	error?: string;
	checkedAt: string;
}

export function blobToVector(blob: Buffer, dimensions: number | null): number[] {
	const raw = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
	const vector = new Float32Array(raw);
	const size =
		typeof dimensions === "number" && dimensions > 0 && dimensions <= vector.length ? dimensions : vector.length;
	return Array.from(vector.slice(0, size));
}

export function chunkBySentence(text: string, targetChars: number): readonly string[] {
	const sentences = text.split(/(?<=[.!?])\s+|(?=^[-*] |\n## )/m).filter(Boolean);
	const raw: string[] = [];
	let current = "";

	for (const sentence of sentences) {
		if (sentence.length > targetChars * 2) {
			if (current.length > 0) {
				raw.push(current.trim());
				current = "";
			}
			for (let i = 0; i < sentence.length; i += targetChars) {
				raw.push(sentence.slice(i, i + targetChars).trim());
			}
			continue;
		}

		const combined = current.length > 0 ? `${current} ${sentence}` : sentence;
		if (combined.length > targetChars && current.length > 0) {
			raw.push(current.trim());
			current = sentence;
		} else {
			current = combined;
		}
	}

	if (current.trim().length > 0) {
		raw.push(current.trim());
	}

	const filtered = raw.filter((c) => c.length > 0);
	if (filtered.length <= 1) return filtered;

	const chunks: string[] = [];
	for (let i = 0; i < filtered.length; i++) {
		if (i < filtered.length - 1) {
			const overlap = filtered[i + 1].slice(0, Math.floor(targetChars * 0.25));
			chunks.push(`${filtered[i]} ${overlap}`.trim());
		} else {
			chunks.push(filtered[i]);
		}
	}

	return chunks;
}

export function parseTagsField(raw: string | null): string[] {
	if (!raw) return [];

	try {
		const parsed: unknown = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			return parsed.filter((value): value is string => typeof value === "string");
		}
	} catch {
		// Fallback to comma-separated tags.
	}

	return raw
		.split(",")
		.map((tag) => tag.trim())
		.filter((tag) => tag.length > 0);
}

export function parseBoundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, parsed));
}

export function parseOptionalBoundedInt(raw: string | undefined, min: number, max: number): number | undefined {
	if (!raw) return undefined;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) return undefined;
	return Math.min(max, Math.max(min, parsed));
}

export function parseOptionalBoundedFloat(raw: string | undefined, min: number, max: number): number | undefined {
	if (!raw) return undefined;
	const parsed = Number.parseFloat(raw);
	if (!Number.isFinite(parsed)) return undefined;
	return Math.min(max, Math.max(min, parsed));
}

export function parseCsvQuery(raw: string | undefined): string[] {
	if (!raw) return [];
	return [
		...new Set(
			raw
				.split(",")
				.map((entry) => entry.trim())
				.filter((entry) => entry.length > 0),
		),
	];
}

export function parseIsoDateQuery(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const value = raw.trim();
	if (!value) return undefined;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return undefined;
	return date.toISOString();
}

export function parseOptionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function parseOptionalNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number.parseFloat(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

export function parseOptionalInt(value: unknown): number | undefined {
	const parsed = parseOptionalNumber(value);
	if (parsed === undefined) return undefined;
	if (!Number.isInteger(parsed)) return undefined;
	if (parsed <= 0) return undefined;
	return parsed;
}

export function parseOptionalBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (value === 1) return true;
		if (value === 0) return false;
		return undefined;
	}
	if (typeof value === "string") {
		const lower = value.trim().toLowerCase();
		if (lower === "1" || lower === "true") return true;
		if (lower === "0" || lower === "false") return false;
	}
	return undefined;
}

export function toRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	return value;
}

export async function readOptionalJsonObject(c: Context): Promise<Record<string, unknown> | null> {
	const raw = await c.req.text();
	if (!raw.trim()) return {};
	try {
		return toRecord(JSON.parse(raw));
	} catch {
		return null;
	}
}

export interface LegacyEmbeddingsResponse {
	embeddings: Array<Record<string, unknown>>;
	count: number;
	total: number;
	limit: number;
	offset: number;
	hasMore: boolean;
	error?: string;
}

export function defaultLegacyEmbeddingsResponse(
	limit: number,
	offset: number,
	error?: string,
): LegacyEmbeddingsResponse {
	return {
		embeddings: [],
		count: 0,
		total: 0,
		limit,
		offset,
		hasMore: false,
		error,
	};
}

export function parseLegacyTagsField(raw: unknown): string[] {
	if (Array.isArray(raw)) {
		return raw.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
	}

	if (typeof raw === "string") {
		return parseTagsField(raw);
	}

	return [];
}

export function parseLegacyVector(raw: unknown): number[] | undefined {
	if (Array.isArray(raw)) {
		const values = raw.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
		return values.length > 0 ? values : undefined;
	}

	if (typeof raw === "string") {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (Array.isArray(parsed)) {
				const values = parsed.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
				return values.length > 0 ? values : undefined;
			}
		} catch {
			// Ignore malformed JSON vectors from legacy scripts.
		}
	}

	return undefined;
}

export function normalizeLegacyEmbeddingRow(raw: unknown, withVectors: boolean): Record<string, unknown> | null {
	if (typeof raw !== "object" || raw === null) {
		return null;
	}

	const row = raw as Record<string, unknown>;
	const rawId = row.id ?? row.source_id;
	if (typeof rawId !== "string" && typeof rawId !== "number") {
		return null;
	}

	const id = String(rawId);
	const rawContent = row.content ?? row.text ?? "";
	const content = typeof rawContent === "string" ? rawContent : String(rawContent);
	const who = typeof row.who === "string" && row.who.length > 0 ? row.who : "unknown";

	const sourceType =
		typeof row.sourceType === "string"
			? row.sourceType
			: typeof row.source_type === "string"
				? row.source_type
				: "memory";

	const sourceIdRaw = row.sourceId ?? row.source_id ?? id;
	const sourceId = typeof sourceIdRaw === "string" || typeof sourceIdRaw === "number" ? String(sourceIdRaw) : id;

	const createdAtRaw = row.createdAt ?? row.created_at;
	const createdAt = typeof createdAtRaw === "string" ? createdAtRaw : undefined;

	const typeValue = typeof row.type === "string" ? row.type : null;
	const importance = typeof row.importance === "number" && Number.isFinite(row.importance) ? row.importance : 0.5;

	const normalized: Record<string, unknown> = {
		id,
		content,
		text: content,
		who,
		importance,
		type: typeValue,
		tags: parseLegacyTagsField(row.tags),
		sourceType,
		sourceId,
		createdAt,
	};

	if (withVectors) {
		const vector = parseLegacyVector(row.vector);
		if (vector) {
			normalized.vector = vector;
		}
	}

	return normalized;
}

export function normalizeLegacyEmbeddingsPayload(
	payload: unknown,
	withVectors: boolean,
	limit: number,
	offset: number,
): LegacyEmbeddingsResponse {
	if (typeof payload !== "object" || payload === null) {
		return defaultLegacyEmbeddingsResponse(limit, offset, "Legacy export returned invalid payload");
	}

	const data: Record<string, unknown> = Object.create(null);
	Object.assign(data, payload);
	const rawEmbeddings = Array.isArray(data.embeddings) ? data.embeddings : [];
	const embeddings = rawEmbeddings
		.map((entry) => normalizeLegacyEmbeddingRow(entry, withVectors))
		.filter((entry): entry is Record<string, unknown> => entry !== null);

	const total =
		typeof data.total === "number" && Number.isFinite(data.total)
			? data.total
			: typeof data.count === "number" && Number.isFinite(data.count)
				? data.count
				: embeddings.length;

	const resolvedLimit = typeof data.limit === "number" && Number.isFinite(data.limit) ? data.limit : limit;

	const resolvedOffset = typeof data.offset === "number" && Number.isFinite(data.offset) ? data.offset : offset;

	const hasMore = typeof data.hasMore === "boolean" ? data.hasMore : resolvedOffset + resolvedLimit < total;

	const error = typeof data.error === "string" ? data.error : undefined;

	return {
		embeddings,
		count: embeddings.length,
		total,
		limit: resolvedLimit,
		offset: resolvedOffset,
		hasMore,
		error,
	};
}

export function isMissingEmbeddingsTableError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("no such table: embeddings");
}

export async function runLegacyEmbeddingsExport(
	withVectors: boolean,
	limit: number,
	offset: number,
	agentsDir: string,
): Promise<LegacyEmbeddingsResponse | null> {
	const scriptPath = join(agentsDir, "memory", "scripts", "export_embeddings.py");
	if (!existsSync(scriptPath)) {
		return null;
	}

	const args = [scriptPath, "--limit", String(limit), "--offset", String(offset)];
	if (withVectors) {
		args.push("--with-vectors");
	}

	return await new Promise<LegacyEmbeddingsResponse>((resolve) => {
		const timeout = withVectors ? 120000 : 30000;
		const proc = spawn("python3", args, {
			cwd: agentsDir,
			stdio: "pipe",
			windowsHide: true,
		});

		const timer = setTimeout(() => {
			proc.kill();
			resolve(defaultLegacyEmbeddingsResponse(limit, offset, `Legacy embeddings export timed out after ${timeout}ms`));
		}, timeout);

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});

		proc.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		proc.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				resolve(
					defaultLegacyEmbeddingsResponse(
						limit,
						offset,
						stderr.trim() || `Legacy embeddings export failed (exit ${code})`,
					),
				);
				return;
			}

			if (!stdout.trim()) {
				resolve(defaultLegacyEmbeddingsResponse(limit, offset, "Legacy embeddings export returned empty output"));
				return;
			}

			try {
				const parsed: unknown = JSON.parse(stdout);
				resolve(normalizeLegacyEmbeddingsPayload(parsed, withVectors, limit, offset));
			} catch (error) {
				resolve(
					defaultLegacyEmbeddingsResponse(
						limit,
						offset,
						`Legacy embeddings export returned invalid JSON: ${(error as Error).message}`,
					),
				);
			}
		});

		proc.on("error", (error) => {
			clearTimeout(timer);
			resolve(defaultLegacyEmbeddingsResponse(limit, offset, error.message));
		});
	});
}

const TYPE_HINTS: Array<[string, string]> = [
	["prefer", "preference"],
	["likes", "preference"],
	["want", "preference"],
	["decided", "decision"],
	["agreed", "decision"],
	["will use", "decision"],
	["learned", "learning"],
	["discovered", "learning"],
	["til ", "learning"],
	["bug", "issue"],
	["issue", "issue"],
	["broken", "issue"],
	["never", "rule"],
	["always", "rule"],
	["must", "rule"],
];

export function inferType(content: string): string {
	const lower = content.toLowerCase();
	for (const [hint, type] of TYPE_HINTS) {
		if (lower.includes(hint)) return type;
	}
	return "fact";
}

export interface ParsedMemory {
	content: string;
	tags: string | null;
	pinned: boolean;
	importance: number;
}

export function parsePrefixes(raw: string): ParsedMemory {
	let content = raw.trim();
	let pinned = false;
	let importance = 0.8;
	let tags: string | null = null;

	if (content.toLowerCase().startsWith("critical:")) {
		content = content.slice(9).trim();
		pinned = true;
		importance = 1.0;
	}

	const tagMatch = content.match(/^\[([^\]]+)\]:\s*(.+)$/s);
	if (tagMatch) {
		tags = tagMatch[1]
			.split(",")
			.map((t) => t.trim().toLowerCase())
			.filter(Boolean)
			.join(",");
		content = tagMatch[2].trim();
	}

	return { content, tags, pinned, importance };
}

export function shouldEnforceAuthScope(c: Context): boolean {
	return shouldEnforceScope(authConfig.mode, c.get("auth")?.claims ?? null);
}

export function resolveScopedAgentId(
	c: Context,
	requestedAgentId: string | undefined,
	fallbackAgentId = "default",
): { agentId: string; error?: string } {
	return resolveScopedAgent(c.get("auth")?.claims ?? null, authConfig.mode, requestedAgentId, fallbackAgentId);
}

export function resolveScopedProject(
	c: Context,
	requestedProject: string | undefined,
): { project: string | undefined; error?: string } {
	return resolveScopedProjectForClaims(c.get("auth")?.claims ?? null, authConfig.mode, requestedProject);
}

export function validateSessionAgentBinding(
	c: Context,
	sessionKey: string | undefined,
	agentId: string,
	options: { requireExisting: boolean; context: string },
): string | undefined {
	const normalizedSessionKey = parseOptionalString(sessionKey);
	if (!normalizedSessionKey || !shouldEnforceAuthScope(c)) {
		return undefined;
	}

	const existing = getAgentPresenceForSession(normalizedSessionKey);
	if (!existing) {
		return options.requireExisting ? `${options.context} is not an active session` : undefined;
	}

	if (existing.agentId !== agentId) {
		return `${options.context} belongs to a different agent`;
	}

	return undefined;
}

export function parseTagsMutation(value: unknown): string | null | undefined {
	if (value === null) return null;
	if (typeof value === "string") {
		const trimmed = value
			.split(",")
			.map((tag) => tag.trim())
			.filter((tag) => tag.length > 0)
			.join(",");
		return trimmed.length > 0 ? trimmed : null;
	}
	if (Array.isArray(value)) {
		if (value.some((entry) => typeof entry !== "string")) {
			return undefined;
		}
		const tags = value
			.map((tag) => tag.trim())
			.filter((tag) => tag.length > 0)
			.join(",");
		return tags.length > 0 ? tags : null;
	}
	return undefined;
}

export interface MutationActor {
	changedBy: string;
	actorType: string;
	sessionId: string | undefined;
	requestId: string | undefined;
}

const ACTOR_TYPES = new Set(["operator", "pipeline", "harness", "sdk", "daemon"]);

export function resolveMutationActor(c: Context, fallback?: string): MutationActor {
	const auth = c.get("auth");
	if (auth?.claims) {
		return {
			changedBy: auth.claims.sub,
			actorType: auth.claims.role,
			sessionId: parseOptionalString(c.req.header("x-signet-session-id")),
			requestId: parseOptionalString(c.req.header("x-signet-request-id")),
		};
	}

	const headerActor = parseOptionalString(c.req.header("x-signet-actor"));
	const changedBy = headerActor ?? (fallback && fallback.trim().length > 0 ? fallback.trim() : "daemon");

	const rawType = parseOptionalString(c.req.header("x-signet-actor-type"));
	const actorType = rawType && ACTOR_TYPES.has(rawType) ? rawType : "operator";

	return {
		changedBy,
		actorType,
		sessionId: parseOptionalString(c.req.header("x-signet-session-id")),
		requestId: parseOptionalString(c.req.header("x-signet-request-id")),
	};
}

export interface ForgetCandidate {
	id: string;
	pinned: number;
	version: number;
	score: number;
}

export interface ForgetCandidatesRequest {
	query: string;
	type: string;
	tags: string;
	who: string;
	sourceType: string;
	since: string;
	until: string;
	scope: string | null;
	limit: number;
}

const MAX_MUTATION_BATCH = 200;

export function buildForgetCandidatesWhere(
	req: ForgetCandidatesRequest,
	alias: string,
): { clause: string; args: unknown[] } {
	const parts: string[] = [];
	const args: unknown[] = [];
	const prefix = alias.length > 0 ? `${alias}.` : "";

	if (req.type) {
		parts.push(`${prefix}type = ?`);
		args.push(req.type);
	}
	if (req.tags) {
		const tags = req.tags
			.split(",")
			.map((tag) => tag.trim())
			.filter((tag) => tag.length > 0);
		for (const tag of tags) {
			parts.push(`${prefix}tags LIKE ?`);
			args.push(`%${tag}%`);
		}
	}
	if (req.who) {
		parts.push(`${prefix}who = ?`);
		args.push(req.who);
	}
	if (req.sourceType) {
		parts.push(`${prefix}source_type = ?`);
		args.push(req.sourceType);
	}
	if (req.scope !== null) {
		parts.push(`${prefix}scope = ?`);
		args.push(req.scope);
	} else {
		parts.push(`${prefix}scope IS NULL`);
	}
	if (req.since) {
		parts.push(`${prefix}created_at >= ?`);
		args.push(req.since);
	}
	if (req.until) {
		parts.push(`${prefix}created_at <= ?`);
		args.push(req.until);
	}

	const clause = parts.length > 0 ? ` AND ${parts.join(" AND ")}` : "";
	return { clause, args };
}

export function loadForgetCandidates(req: ForgetCandidatesRequest): ForgetCandidate[] {
	return getDbAccessor().withReadDb((db) => {
		const limit = Math.max(1, Math.min(req.limit, MAX_MUTATION_BATCH));
		const withQuery = req.query.trim().length > 0;
		const { clause, args } = buildForgetCandidatesWhere(req, withQuery ? "m" : "");

		if (withQuery) {
			try {
				const rows = (
					db.prepare(
						`SELECT m.id, m.pinned, m.version, bm25(memories_fts) AS raw_score
						 FROM memories_fts
						 JOIN memories m ON memories_fts.rowid = m.rowid
						 WHERE memories_fts MATCH ? AND m.is_deleted = 0${clause}
						 ORDER BY raw_score
						 LIMIT ?`,
					) as any
				).all(req.query, ...args, limit) as Array<{
					id: string;
					pinned: number;
					version: number;
					raw_score: number;
				}>;
				return rows.map((row) => ({
					id: row.id,
					pinned: row.pinned,
					version: row.version,
					score: 1 / (1 + Math.abs(row.raw_score ?? 0)),
				}));
			} catch {
				// Fall through to LIKE fallback.
			}

			const fallbackRows = (
				db.prepare(
					`SELECT m.id, m.pinned, m.version
					 FROM memories m
					 WHERE m.is_deleted = 0
					   AND (m.content LIKE ? OR m.tags LIKE ?)${clause}
					 ORDER BY m.updated_at DESC
					 LIMIT ?`,
				) as any
			).all(`%${req.query}%`, `%${req.query}%`, ...args, limit) as Array<{
				id: string;
				pinned: number;
				version: number;
			}>;
			return fallbackRows.map((row) => ({
				id: row.id,
				pinned: row.pinned,
				version: row.version,
				score: 0,
			}));
		}

		const rows = (
			db.prepare(
				`SELECT id, pinned, version
				 FROM memories
				 WHERE is_deleted = 0${clause}
				 ORDER BY pinned DESC, importance DESC, updated_at DESC
				 LIMIT ?`,
			) as any
		).all(...args, limit) as Array<{
			id: string;
			pinned: number;
			version: number;
		}>;
		return rows.map((row) => ({
			id: row.id,
			pinned: row.pinned,
			version: row.version,
			score: 0,
		}));
	});
}

export function loadForgetCandidatesByIds(requestedIds: readonly string[], limit: number): ForgetCandidate[] {
	const dedupedIds = [...new Set(requestedIds)]
		.map((id) => id.trim())
		.filter((id) => id.length > 0)
		.slice(0, Math.max(1, Math.min(limit, MAX_MUTATION_BATCH)));
	if (dedupedIds.length === 0) return [];

	return getDbAccessor().withReadDb((db) => {
		const placeholders = dedupedIds.map(() => "?").join(", ");
		const rows = db
			.prepare(
				`SELECT id, pinned, version
				 FROM memories
				 WHERE is_deleted = 0 AND id IN (${placeholders})`,
			)
			.all(...dedupedIds) as Array<{
			id: string;
			pinned: number;
			version: number;
		}>;
		const rowById = new Map(rows.map((row) => [row.id, row]));
		return dedupedIds
			.map((id) => rowById.get(id))
			.filter((row): row is { id: string; pinned: number; version: number } => Boolean(row))
			.map((row) => ({
				id: row.id,
				pinned: row.pinned,
				version: row.version,
				score: 0,
			}));
	});
}

export function buildForgetConfirmToken(memoryIds: readonly string[]): string {
	const canonical = [...new Set(memoryIds)].sort().join("|");
	return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export interface ParsedModifyPatch {
	patch: {
		content?: string;
		normalizedContent?: string;
		contentHash?: string;
		type?: string;
		tags?: string | null;
		importance?: number;
		pinned?: number;
	};
	contentForEmbedding: string | null;
}

export function parseModifyPatch(
	payload: Record<string, unknown>,
): { ok: true; value: ParsedModifyPatch } | { ok: false; error: string } {
	const patch: ParsedModifyPatch["patch"] = {};
	let changed = false;
	let contentForEmbedding: string | null = null;

	const hasField = (field: string): boolean => Object.prototype.hasOwnProperty.call(payload, field);

	if (hasField("content")) {
		if (typeof payload.content !== "string") {
			return { ok: false, error: "content must be a string" };
		}
		const normalized = normalizeAndHashContent(payload.content);
		if (!normalized.storageContent) {
			return { ok: false, error: "content must not be empty" };
		}
		patch.content = normalized.storageContent;
		patch.normalizedContent =
			normalized.normalizedContent.length > 0 ? normalized.normalizedContent : normalized.hashBasis;
		patch.contentHash = normalized.contentHash;
		contentForEmbedding = normalized.storageContent;
		changed = true;
	}

	if (hasField("type")) {
		const type = parseOptionalString(payload.type);
		if (!type) {
			return { ok: false, error: "type must be a non-empty string" };
		}
		patch.type = type;
		changed = true;
	}

	if (hasField("tags")) {
		const tags = parseTagsMutation(payload.tags);
		if (tags === undefined) {
			return {
				ok: false,
				error: "tags must be a string, string array, or null",
			};
		}
		patch.tags = tags;
		changed = true;
	}

	if (hasField("importance")) {
		const importance = parseOptionalNumber(payload.importance);
		if (importance === undefined || importance < 0 || importance > 1 || !Number.isFinite(importance)) {
			return {
				ok: false,
				error: "importance must be a finite number between 0 and 1",
			};
		}
		patch.importance = importance;
		changed = true;
	}

	if (hasField("pinned")) {
		const pinned = parseOptionalBoolean(payload.pinned);
		if (pinned === undefined) {
			return { ok: false, error: "pinned must be a boolean" };
		}
		patch.pinned = pinned ? 1 : 0;
		changed = true;
	}

	if (!changed) {
		return {
			ok: false,
			error: "at least one of content, type, tags, importance, pinned is required",
		};
	}

	return { ok: true, value: { patch, contentForEmbedding } };
}

export let cachedEmbeddingStatus: EmbeddingStatus | null = null;
export let statusCacheTime = 0;
export const STATUS_CACHE_TTL = 30000;

export async function checkEmbeddingProvider(cfg: EmbeddingConfig): Promise<EmbeddingStatus> {
	const now = Date.now();

	if (cachedEmbeddingStatus && now - statusCacheTime < STATUS_CACHE_TTL) {
		return cachedEmbeddingStatus;
	}

	const status: EmbeddingStatus = {
		provider: cfg.provider,
		model: cfg.model,
		base_url: resolveEmbeddingBaseUrl(cfg),
		available: false,
		checkedAt: new Date().toISOString(),
	};

	if (cfg.provider === "none") {
		status.available = false;
		status.error = "Embedding provider set to 'none' — vector search disabled";
		cachedEmbeddingStatus = status;
		statusCacheTime = now;
		return status;
	}

	try {
		if (cfg.provider === "native") {
			const mod = await import("../native-embedding");
			const nativeStatus = await mod.checkNativeProvider();
			status.modelCached = nativeStatus.modelCached;
			if (nativeStatus.available) {
				status.available = true;
				status.dimensions = nativeStatus.dimensions;
			} else {
				logger.warn("embedding", `Native provider unavailable: ${nativeStatus.error ?? "unknown"}`);
				try {
					const ollamaRes = await fetch(`${resolveOllamaUrl().replace(/\/$/, "")}/api/tags`, {
						method: "GET",
						signal: AbortSignal.timeout(3000),
					});
					if (ollamaRes.ok) {
						const ollamaData = (await ollamaRes.json()) as { models?: { name: string }[] };
						const models = ollamaData.models ?? [];
						const hasNomic = models.some((m) => m.name.startsWith("nomic-embed-text"));
						if (hasNomic) {
							status.available = true;
							status.dimensions = 768;
							status.error = "Native unavailable — using ollama fallback";
							setNativeFallbackToOllama(true);
							logger.info("embedding", "Ollama fallback available — will use ollama for embeddings");
						} else {
							status.error = `Native: ${nativeStatus.error ?? "not ready"}. Ollama available but nomic-embed-text not found.`;
						}
					} else {
						status.error = `Native: ${nativeStatus.error ?? "not ready"}. Ollama not available.`;
					}
				} catch {
					status.error = `Native: ${nativeStatus.error ?? "not ready"}. Ollama not reachable.`;
				}
			}
		} else if (cfg.provider === "ollama") {
			const res = await fetch(`${cfg.base_url.replace(/\/$/, "")}/api/tags`, {
				method: "GET",
				signal: AbortSignal.timeout(5000),
			});

			if (!res.ok) {
				status.error = `Ollama returned ${res.status}`;
			} else {
				const data = (await res.json()) as { models?: { name: string }[] };
				const models = data.models ?? [];
				const modelExists = models.some((m) => m.name.startsWith(cfg.model));

				if (!modelExists) {
					status.error = `Model '${cfg.model}' not found. Available: ${models.map((m) => m.name).join(", ") || "none"}`;
				} else {
					status.available = true;
					status.dimensions = cfg.dimensions;
				}
			}
		} else {
			const apiKey = await resolveEmbeddingApiKey(cfg.api_key);
			if (!apiKey) {
				status.error = "Missing OpenAI API key";
				cachedEmbeddingStatus = status;
				statusCacheTime = now;
				return status;
			}
			const testResult = await fetchEmbedding("test", cfg);
			if (testResult) {
				status.available = true;
				status.dimensions = testResult.length;
			} else {
				status.error = "Failed to generate test embedding";
			}
		}
	} catch (err) {
		status.error = err instanceof Error ? err.message : "Unknown error";
	}

	cachedEmbeddingStatus = status;
	statusCacheTime = now;
	return status;
}

export function getConfiguredProviderHints(agentsDir: string): {
	readonly extraction: string | null;
	readonly synthesis: string | null;
} {
	const paths = [join(agentsDir, "agent.yaml"), join(agentsDir, "AGENT.yaml"), join(agentsDir, "config.yaml")];
	let extraction: string | null = null;
	let synthesis: string | null = null;

	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			const yaml = toRecord(parseSimpleYaml(readFileSync(path, "utf-8")));
			const mem = toRecord(yaml?.memory);
			const pipeline = toRecord(mem?.pipelineV2);
			const extractionObj = toRecord(pipeline?.extraction);
			const synthesisObj = toRecord(pipeline?.synthesis);
			const extractionInFile =
				typeof pipeline?.extractionProvider === "string"
					? pipeline.extractionProvider
					: typeof extractionObj?.provider === "string"
						? extractionObj.provider
						: null;
			const synthesisInFile = typeof synthesisObj?.provider === "string" ? synthesisObj.provider : null;
			if (extraction === null && extractionInFile !== null) {
				extraction = extractionInFile;
			}
			if (synthesis === null && synthesisInFile !== null) {
				synthesis = synthesisInFile;
			}
			if (extraction !== null && synthesis !== null) {
				break;
			}
		} catch {}
	}

	return { extraction, synthesis };
}

export interface FilterParams {
	type: string;
	tags: string;
	who: string;
	pinned: boolean;
	importance_min: number | null;
	since: string;
}

export function buildWhereRaw(p: FilterParams): { clause: string; args: unknown[] } {
	const parts: string[] = [];
	const args: unknown[] = [];

	if (p.type) {
		parts.push("type = ?");
		args.push(p.type);
	}
	if (p.tags) {
		const tagList = p.tags
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		for (const tag of tagList) {
			parts.push("tags LIKE ?");
			args.push(`%${tag}%`);
		}
	}
	if (p.who) {
		parts.push("who = ?");
		args.push(p.who);
	}
	if (p.pinned) {
		parts.push("pinned = 1");
	}
	if (p.importance_min !== null) {
		parts.push("importance >= ?");
		args.push(p.importance_min);
	}
	if (p.since) {
		parts.push("created_at >= ?");
		args.push(p.since);
	}

	const clause = parts.length ? ` AND ${parts.join(" AND ")}` : "";
	return { clause, args };
}

export function buildWhere(p: FilterParams): { clause: string; args: unknown[] } {
	const parts: string[] = [];
	const args: unknown[] = [];

	if (p.type) {
		parts.push("m.type = ?");
		args.push(p.type);
	}
	if (p.tags) {
		const tagList = p.tags
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		for (const tag of tagList) {
			parts.push("m.tags LIKE ?");
			args.push(`%${tag}%`);
		}
	}
	if (p.who) {
		parts.push("m.who = ?");
		args.push(p.who);
	}
	if (p.pinned) {
		parts.push("m.pinned = 1");
	}
	if (p.importance_min !== null) {
		parts.push("m.importance >= ?");
		args.push(p.importance_min);
	}
	if (p.since) {
		parts.push("m.created_at >= ?");
		args.push(p.since);
	}

	const clause = parts.length ? ` AND ${parts.join(" AND ")}` : "";
	return { clause, args };
}
