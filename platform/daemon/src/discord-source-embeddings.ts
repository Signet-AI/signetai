import { createHash } from "node:crypto";
import { yieldEvery } from "./async-yield";
import { getDbAccessor } from "./db-accessor";
import { syncVecDeleteByEmbeddingIds, syncVecInsert, vectorToBlob } from "./db-helpers";
import type { DiscordMessage } from "./discord-source-fetch";
import { displayName } from "./discord-source-fetch";
import type { EmbeddingConfig } from "./memory-config";
import type { SourceEmbeddingFetch } from "./obsidian-source-embeddings";

export const DISCORD_CHUNK_SOURCE_TYPE = "source_discord_chunk";
const DISCORD_SOURCE_CHUNK_DELAY_MS = 100;

export interface DiscordSourceChunk {
	readonly id: string;
	readonly text: string;
	readonly chunkText: string;
	readonly heading: string;
	readonly startLine: number;
	readonly endLine: number;
}

export interface IndexDiscordSourceEmbeddingsInput {
	readonly agentId: string;
	readonly sourceId: string;
	readonly guildId: string;
	readonly channelId: string;
	readonly channelName: string;
	readonly threadId?: string;
	readonly messages: readonly DiscordMessage[];
	readonly embeddingConfig: EmbeddingConfig;
	readonly fetchEmbedding: SourceEmbeddingFetch;
}

export interface IndexDiscordSourceEmbeddingsResult {
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

function threadPrefix(sourceId: string, guildId: string, channelId: string, threadId?: string): string {
	const base = `${sourceId}:guild:${guildId}:channel:${channelId}`;
	return threadId ? `${base}:thread:${threadId}` : `${base}:messages`;
}

const SKIP_MESSAGE_TYPES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

interface ConversationBatch {
	readonly batchId: string;
	readonly messages: DiscordMessage[];
	readonly startTime: string;
	readonly endTime: string;
}

function groupIntoConversations(messages: readonly DiscordMessage[], maxGapMs = 300_000): ConversationBatch[] {
	if (messages.length === 0) return [];
	const sorted = [...messages].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

	const batches: ConversationBatch[] = [];
	let current: DiscordMessage[] = [sorted[0]];

	for (let i = 1; i < sorted.length; i++) {
		const msg = sorted[i];
		const prev = current[current.length - 1];
		if (!prev || !msg) continue;

		const gap = Date.parse(msg.timestamp) - Date.parse(prev.timestamp);
		if (gap > maxGapMs) {
			batches.push(finalizeBatch(current));
			current = [msg];
		} else {
			current.push(msg);
		}
	}
	if (current.length > 0) batches.push(finalizeBatch(current));
	return batches;
}

function finalizeBatch(messages: DiscordMessage[]): ConversationBatch {
	return {
		batchId: `conv-${messages[0].id}`,
		messages,
		startTime: messages[0].timestamp,
		endTime: messages[messages.length - 1].timestamp,
	};
}

export function buildDiscordSourceChunks(input: {
	readonly sourceId: string;
	readonly guildId: string;
	readonly channelId: string;
	readonly channelName: string;
	readonly threadId?: string;
	readonly messages: readonly DiscordMessage[];
}): DiscordSourceChunk[] {
	const filtered = input.messages.filter(
		(msg) =>
			!SKIP_MESSAGE_TYPES.has(msg.type) && (msg.content?.trim() || (msg.attachments && msg.attachments.length > 0)),
	);
	if (filtered.length === 0) return [];

	const conversations = groupIntoConversations(filtered);
	const chunks: DiscordSourceChunk[] = [];
	const prefix = threadPrefix(input.sourceId, input.guildId, input.channelId, input.threadId);

	for (const conv of conversations) {
		const lines: string[] = [];
		for (const msg of conv.messages) {
			const speaker = displayName(msg.author);
			const ts = msg.timestamp.slice(0, 16).replace("T", " ");
			const tag = msg.message_reference ? `${speaker} (replying)` : speaker;
			let line = `[${ts}] ${tag}: ${msg.content}`;
			if (msg.attachments && msg.attachments.length > 0) {
				line += ` [attachments: ${msg.attachments.map((a) => a.filename).join(", ")}]`;
			}
			lines.push(line);
		}

		const text = lines.join("\n");
		const startDate = conv.startTime.slice(0, 16).replace("T", " ");
		const heading = `#${input.channelName} — ${startDate} (${conv.messages.length} messages)`;

		for (const piece of splitLongText(text)) {
			if (piece.length < MIN_CHARS) continue;
			const chunkIndex = chunks.length;
			const chunkId = `${prefix}#${conv.batchId}:${chunkIndex}`;
			const chunkText = [
				`source_id: ${input.sourceId}`,
				`guild: ${input.guildId}`,
				`channel: ${input.channelName}`,
				input.threadId ? `thread: ${input.threadId}` : "",
				`heading: ${heading}`,
				"",
				piece,
			]
				.filter(Boolean)
				.join("\n");
			chunks.push({
				id: chunkId,
				text: piece,
				chunkText,
				heading,
				startLine: 0,
				endLine: conv.messages.length,
			});
		}
	}
	return chunks;
}

function splitLongText(text: string): string[] {
	if (text.length <= MAX_CHARS) return [text];
	const chunks: string[] = [];
	for (let start = 0; start < text.length; start += TARGET_CHARS) {
		const piece = text.slice(start, start + MAX_CHARS).trim();
		if (piece.length >= MIN_CHARS) chunks.push(piece);
	}
	return chunks;
}

function sleep(ms: number): Promise<void> {
	return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export async function indexDiscordSourceEmbeddings(
	input: IndexDiscordSourceEmbeddingsInput,
): Promise<IndexDiscordSourceEmbeddingsResult> {
	if (input.embeddingConfig.provider === "none") return { chunks: 0, embedded: 0, skipped: 0 };
	const chunks = buildDiscordSourceChunks(input);
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
			await sleep(DISCORD_SOURCE_CHUNK_DELAY_MS);
			continue;
		}
		const vector = await input.fetchEmbedding(chunk.chunkText, input.embeddingConfig);
		if (!vector || vector.length === 0) {
			skipped++;
			await yielder();
			await sleep(DISCORD_SOURCE_CHUNK_DELAY_MS);
			continue;
		}
		getDbAccessor().withWriteTx((db) => {
			const embId = hash(`${DISCORD_CHUNK_SOURCE_TYPE}:${input.agentId}:${chunk.id}`).slice(0, 32);
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
				DISCORD_CHUNK_SOURCE_TYPE,
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
		await sleep(DISCORD_SOURCE_CHUNK_DELAY_MS);
	}

	const prefix = `${threadPrefix(input.sourceId, input.guildId, input.channelId, input.threadId)}#`;
	getDbAccessor().withWriteTx((db) => {
		const stale = db
			.prepare(
				"SELECT id, content_hash FROM embeddings WHERE source_type = ? AND source_id >= ? AND source_id < ? AND agent_id = ?",
			)
			.all(DISCORD_CHUNK_SOURCE_TYPE, prefix, `${prefix}\uffff`, input.agentId) as Array<{
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
			.get(DISCORD_CHUNK_SOURCE_TYPE, chunkId, agentId),
	) as { content_hash: string } | undefined;
	return row?.content_hash ?? null;
}

export function purgeDiscordSourceEmbeddings(input: { readonly sourceId: string; readonly agentId?: string }): number {
	const prefix = `${input.sourceId}:`;
	return getDbAccessor().withWriteTx((db) => {
		const agentWhere = input.agentId ? " AND agent_id = ?" : "";
		const upper = `${prefix}\uffff`;
		const args = input.agentId
			? [DISCORD_CHUNK_SOURCE_TYPE, prefix, upper, input.agentId]
			: [DISCORD_CHUNK_SOURCE_TYPE, prefix, upper];
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
