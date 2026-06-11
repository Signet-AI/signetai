import { createHash } from "node:crypto";
import { relative } from "node:path";
import { LEGACY_OBSIDIAN_CHUNK_SOURCE_TYPE, SOURCE_CHUNK_SOURCE_TYPE } from "@signetai/core";
import { yieldEvery } from "./async-yield";
import { getDbAccessor } from "./db-accessor";
import { syncVecDeleteByEmbeddingIds, syncVecInsert, vectorToBlob } from "./db-helpers";
import type { EmbeddingConfig } from "./memory-config";

export const OBSIDIAN_CHUNK_SOURCE_TYPE = SOURCE_CHUNK_SOURCE_TYPE;
const OBSIDIAN_SOURCE_CHUNK_DELAY_MS = 100;
const OBSIDIAN_CHUNK_SOURCE_TYPES = [SOURCE_CHUNK_SOURCE_TYPE, LEGACY_OBSIDIAN_CHUNK_SOURCE_TYPE] as const;

export type SourceEmbeddingFetch = (text: string, cfg: EmbeddingConfig) => Promise<number[] | null>;

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
	readonly embeddingConfig: EmbeddingConfig;
	readonly fetchEmbedding: SourceEmbeddingFetch;
}

export interface IndexObsidianSourceEmbeddingsResult {
	readonly chunks: number;
	readonly embedded: number;
	readonly skipped: number;
}

export interface PurgeObsidianSourceEmbeddingsInput {
	readonly sourceId: string;
	readonly agentId?: string;
}

export interface PurgeObsidianSourceFileEmbeddingsInput {
	readonly sourceId: string;
	readonly agentId?: string;
	readonly root: string;
	readonly filePath: string;
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

export async function indexObsidianSourceEmbeddings(
	input: IndexObsidianSourceEmbeddingsInput,
): Promise<IndexObsidianSourceEmbeddingsResult> {
	if (input.embeddingConfig.provider === "none") return { chunks: 0, embedded: 0, skipped: 0 };
	const chunks = buildObsidianSourceChunks(input);
	const currentHashes = new Set<string>();
	const yielder = yieldEvery(1);
	let embedded = 0;
	let skipped = 0;
	const now = new Date().toISOString();

	for (const chunk of chunks) {
		const contentHash = hash(`${input.agentId}\n${chunk.id}\n${chunk.chunkText}`);
		currentHashes.add(contentHash);
		if (existingChunkEmbeddingContentHash(input.agentId, chunk.id) === contentHash) {
			skipped++;
			await yielder();
			await sleep(OBSIDIAN_SOURCE_CHUNK_DELAY_MS);
			continue;
		}
		const vector = await input.fetchEmbedding(chunk.chunkText, input.embeddingConfig);
		if (!vector || vector.length === 0) {
			skipped++;
			await yielder();
			await sleep(OBSIDIAN_SOURCE_CHUNK_DELAY_MS);
			continue;
		}
		getDbAccessor().withWriteTx((db) => {
			const embId = hash(`${OBSIDIAN_CHUNK_SOURCE_TYPE}:${input.agentId}:${chunk.id}`).slice(0, 32);
			const existingForId = db.prepare("SELECT content_hash FROM embeddings WHERE id = ?").get(embId) as
				| { content_hash: string }
				| undefined;
			if (existingForId && existingForId.content_hash !== contentHash) {
				syncVecDeleteByEmbeddingIds(db, [embId]);
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
			const stored = db.prepare("SELECT id FROM embeddings WHERE content_hash = ?").get(contentHash) as
				| { id: string }
				| undefined;
			syncVecInsert(db, stored?.id ?? embId, vector);
		});
		embedded++;
		await yielder();
		await sleep(OBSIDIAN_SOURCE_CHUNK_DELAY_MS);
	}

	getDbAccessor().withWriteTx((db) => {
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
			syncVecDeleteByEmbeddingIds(db, staleIds);
			const stmt = db.prepare("DELETE FROM embeddings WHERE id = ?");
			for (const id of staleIds) stmt.run(id);
		}
	});

	return { chunks: chunks.length, embedded, skipped };
}

function sleep(ms: number): Promise<void> {
	return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function existingChunkEmbeddingContentHash(agentId: string, chunkId: string): string | null {
	const row = getDbAccessor().withReadDb((db) =>
		db
			.prepare("SELECT content_hash FROM embeddings WHERE source_type = ? AND source_id = ? AND agent_id = ? LIMIT 1")
			.get(SOURCE_CHUNK_SOURCE_TYPE, chunkId, agentId),
	) as { content_hash: string } | undefined;
	return row?.content_hash ?? null;
}

export function purgeObsidianSourceFileEmbeddings(input: PurgeObsidianSourceFileEmbeddingsInput): number {
	const prefix = `${input.sourceId}:${relPath(normalizePath(input.root).replace(/\/$/, ""), normalizePath(input.filePath))}#`;
	return purgeEmbeddingsBySourceIdPrefix(prefix, input.agentId);
}

export function purgeObsidianSourceEmbeddings(input: PurgeObsidianSourceEmbeddingsInput): number {
	return purgeEmbeddingsBySourceIdPrefix(`${input.sourceId}:`, input.agentId);
}

function purgeEmbeddingsBySourceIdPrefix(prefix: string, agentId?: string): number {
	return getDbAccessor().withWriteTx((db) => {
		const agentWhere = agentId ? " AND agent_id = ?" : "";
		const upper = prefixUpperBound(prefix);
		const ids: string[] = [];
		let changes = 0;
		for (const sourceType of OBSIDIAN_CHUNK_SOURCE_TYPES) {
			const args = agentId ? [sourceType, prefix, upper, agentId] : [sourceType, prefix, upper];
			const rows = db
				.prepare(`SELECT id FROM embeddings WHERE source_type = ? AND source_id >= ? AND source_id < ?${agentWhere}`)
				.all(...args) as Array<{ id: string }>;
			ids.push(...rows.map((row) => row.id));
			const result = db
				.prepare(`DELETE FROM embeddings WHERE source_type = ? AND source_id >= ? AND source_id < ?${agentWhere}`)
				.run(...args);
			changes += result.changes;
		}
		syncVecDeleteByEmbeddingIds(db, ids);
		return changes;
	});
}

function prefixUpperBound(prefix: string): string {
	return `${prefix}\uffff`;
}
