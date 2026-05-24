import { createHash } from "node:crypto";
import { yieldEvery } from "./async-yield";
import { getDbAccessor } from "./db-accessor";
import { syncVecDeleteByEmbeddingIds, syncVecInsert, vectorToBlob } from "./db-helpers";
import type { GitHubResource } from "./github-source-fetch";
import { resourceToMarkdown } from "./github-source-fetch";
import type { EmbeddingConfig } from "./memory-config";
import type { SourceEmbeddingFetch } from "./obsidian-source-embeddings";

export const GITHUB_CHUNK_SOURCE_TYPE = "source_github_chunk";
const GITHUB_SOURCE_CHUNK_DELAY_MS = 100;

export interface GitHubSourceChunk {
	readonly id: string;
	readonly text: string;
	readonly chunkText: string;
	readonly heading: string;
	readonly startLine: number;
	readonly endLine: number;
}

export interface IndexGitHubSourceEmbeddingsInput {
	readonly agentId: string;
	readonly sourceId: string;
	readonly repo: string;
	readonly resource: GitHubResource;
	readonly comments?: readonly { author: string | null; body: string; createdAt: string }[];
	readonly embeddingConfig: EmbeddingConfig;
	readonly fetchEmbedding: SourceEmbeddingFetch;
	readonly sourceActiveCheck?: () => boolean;
}

export interface IndexGitHubSourceEmbeddingsResult {
	readonly chunks: number;
	readonly embedded: number;
	readonly skipped: number;
}

const TARGET_CHARS = 1_600;
const MAX_CHARS = 2_200;
const MIN_CHARS = 40;

function hash(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

function resourceId(sourceId: string, repo: string, resource: GitHubResource): string {
	if (resource.type === "doc" && resource.path) {
		return `${sourceId}:${repo}:docs:${resource.path}`;
	}
	return `${sourceId}:${repo}:${resource.type}:${resource.number}`;
}

export function buildGitHubSourceChunks(input: {
	readonly sourceId: string;
	readonly repo: string;
	readonly resource: GitHubResource;
	readonly comments?: readonly { author: string | null; body: string; createdAt: string }[];
}): GitHubSourceChunk[] {
	const markdown = resourceToMarkdown(input.resource, input.comments);
	const prefix = resourceId(input.sourceId, input.repo, input.resource);
	const sections = parseMarkdownSections(markdown);
	const chunks: GitHubSourceChunk[] = [];

	for (const section of sections) {
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
				const headingKey = slug(section.heading) || "overview";
				const lineKey = `${section.startLine}-${section.endLine}`;
				const chunkId = `${prefix}#${headingKey}:${lineKey}:${chunkIndex}`;
				const chunkText = [
					`source_id: ${input.sourceId}`,
					`repo: ${input.repo}`,
					`type: ${input.resource.type}`,
					input.resource.number != null ? `number: ${input.resource.number}` : `path: ${input.resource.path}`,
					`heading: ${section.heading}`,
					"",
					piece,
				].join("\n");
				chunks.push({
					id: chunkId,
					text: piece,
					chunkText,
					heading: section.heading,
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

interface MarkdownSection {
	readonly heading: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly body: string;
}

function parseMarkdownSections(content: string): MarkdownSection[] {
	const lines = content.replace(/\r\n?/g, "\n").split("\n");
	const sections: Array<{ heading: string; startLine: number; lines: string[] }> = [];
	let current: { heading: string; startLine: number; lines: string[] } = {
		heading: "Overview",
		startLine: 1,
		lines: [],
	};

	for (let idx = 0; idx < lines.length; idx++) {
		const line = lines[idx] ?? "";
		const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
		if (match) {
			const body = current.lines.join("\n").trim();
			if (body.length >= MIN_CHARS || current.heading !== "Overview") {
				sections.push({
					heading: current.heading,
					startLine: current.startLine,
					endLine: current.startLine + current.lines.length,
					body,
				});
			}
			current = { heading: match[2]?.trim() || "Untitled", startLine: idx + 1, lines: [] };
			continue;
		}
		current.lines.push(line);
	}
	const finalBody = current.lines.join("\n").trim();
	if (finalBody.length >= MIN_CHARS || current.heading !== "Overview") {
		sections.push({
			heading: current.heading,
			startLine: current.startLine,
			endLine: current.startLine + current.lines.length,
			body: finalBody,
		});
	}
	return sections.filter((s) => s.body.length >= MIN_CHARS);
}

function splitParagraphs(body: string): string[] {
	return body
		.split(/\n{2,}/)
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

function slug(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
}

function sleep(ms: number): Promise<void> {
	return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function assertSourceActive(input: IndexGitHubSourceEmbeddingsInput): void {
	if (input.sourceActiveCheck && !input.sourceActiveCheck()) {
		throw new Error(`Source ${input.sourceId} removed during embedding sync`);
	}
}

export async function indexGitHubSourceEmbeddings(
	input: IndexGitHubSourceEmbeddingsInput,
): Promise<IndexGitHubSourceEmbeddingsResult> {
	if (input.embeddingConfig.provider === "none") return { chunks: 0, embedded: 0, skipped: 0 };
	const chunks = buildGitHubSourceChunks(input);
	const currentHashes = new Set<string>();
	const yielder = yieldEvery(1);
	let embedded = 0;
	let skipped = 0;
	const now = new Date().toISOString();

	for (const chunk of chunks) {
		assertSourceActive(input);
		const contentHash = hash(`${input.agentId}\n${chunk.id}\n${chunk.chunkText}`);
		currentHashes.add(contentHash);
		if (existingChunkEmbeddingContentHash(input.agentId, chunk.id) === contentHash) {
			skipped++;
			await yielder();
			await sleep(GITHUB_SOURCE_CHUNK_DELAY_MS);
			continue;
		}
		const vector = await input.fetchEmbedding(chunk.chunkText, input.embeddingConfig);
		assertSourceActive(input);
		if (!vector || vector.length === 0) {
			skipped++;
			await yielder();
			await sleep(GITHUB_SOURCE_CHUNK_DELAY_MS);
			continue;
		}
		assertSourceActive(input);
		getDbAccessor().withWriteTx((db) => {
			const embId = hash(`${GITHUB_CHUNK_SOURCE_TYPE}:${input.agentId}:${chunk.id}`).slice(0, 32);
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
				GITHUB_CHUNK_SOURCE_TYPE,
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
		await sleep(GITHUB_SOURCE_CHUNK_DELAY_MS);
	}

	const prefix = `${resourceId(input.sourceId, input.repo, input.resource)}#`;
	assertSourceActive(input);
	getDbAccessor().withWriteTx((db) => {
		const stale = db
			.prepare(
				"SELECT id, content_hash FROM embeddings WHERE source_type = ? AND source_id >= ? AND source_id < ? AND agent_id = ?",
			)
			.all(GITHUB_CHUNK_SOURCE_TYPE, prefix, `${prefix}\uffff`, input.agentId) as Array<{
			id: string;
			content_hash: string;
		}>;
		const staleIds = stale.filter((row) => !currentHashes.has(row.content_hash)).map((row) => row.id);
		if (staleIds.length > 0) {
			syncVecDeleteByEmbeddingIds(db, staleIds);
			const stmt = db.prepare("DELETE FROM embeddings WHERE id = ?");
			for (const id of staleIds) stmt.run(id);
		}
	});

	return { chunks: chunks.length, embedded, skipped };
}

function existingChunkEmbeddingContentHash(agentId: string, chunkId: string): string | null {
	const row = getDbAccessor().withReadDb((db) =>
		db
			.prepare("SELECT content_hash FROM embeddings WHERE source_type = ? AND source_id = ? AND agent_id = ? LIMIT 1")
			.get(GITHUB_CHUNK_SOURCE_TYPE, chunkId, agentId),
	) as { content_hash: string } | undefined;
	return row?.content_hash ?? null;
}

export function purgeGitHubSourceEmbeddings(input: { readonly sourceId: string; readonly agentId?: string }): number {
	const prefix = `${input.sourceId}:`;
	return getDbAccessor().withWriteTx((db) => {
		const agentWhere = input.agentId ? " AND agent_id = ?" : "";
		const upper = `${prefix}\uffff`;
		const args = input.agentId
			? [GITHUB_CHUNK_SOURCE_TYPE, prefix, upper, input.agentId]
			: [GITHUB_CHUNK_SOURCE_TYPE, prefix, upper];
		const rows = db
			.prepare(`SELECT id FROM embeddings WHERE source_type = ? AND source_id >= ? AND source_id < ?${agentWhere}`)
			.all(...args) as Array<{ id: string }>;
		const ids = rows.map((row) => row.id);
		syncVecDeleteByEmbeddingIds(db, ids);
		return db
			.prepare(`DELETE FROM embeddings WHERE source_type = ? AND source_id >= ? AND source_id < ?${agentWhere}`)
			.run(...args).changes;
	});
}

export function purgeGitHubResourceEmbeddings(input: {
	readonly sourceId: string;
	readonly repo: string;
	readonly agentId: string;
	readonly resource: GitHubResource;
}): number {
	const prefix = `${resourceId(input.sourceId, input.repo, input.resource)}#`;
	return getDbAccessor().withWriteTx((db) => {
		const rows = db
			.prepare("SELECT id FROM embeddings WHERE source_type = ? AND source_id >= ? AND source_id < ? AND agent_id = ?")
			.all(GITHUB_CHUNK_SOURCE_TYPE, prefix, `${prefix}\uffff`, input.agentId) as Array<{ id: string }>;
		const ids = rows.map((row) => row.id);
		syncVecDeleteByEmbeddingIds(db, ids);
		return db
			.prepare("DELETE FROM embeddings WHERE source_type = ? AND source_id >= ? AND source_id < ? AND agent_id = ?")
			.run(GITHUB_CHUNK_SOURCE_TYPE, prefix, `${prefix}\uffff`, input.agentId).changes;
	});
}
