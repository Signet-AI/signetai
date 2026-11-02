import { randomUUID } from "node:crypto";
import type { AgentRosterReadPolicy } from "@signet/core";
import { getAgentScope } from "./agent-id";
import {
	type AgentMessage,
	type CrossAgentMessageRow,
	isMessageVisibleToAgent,
	rowToAgentMessage,
} from "./cross-agent";
import { dbOwnerBatch, dbOwnerQuery, ownerStatement } from "./db-owner-runtime";
import type { DbOwnerParameter, DbOwnerStatement } from "./db-owner-protocol";
import { logger } from "./logger";
import { indexExternalMemoryArtifact } from "./memory-lineage";
import type { BoardActivityNotice } from "./notifications/cross-agent-notifications";

export type BoardThreadStatus = "open" | "resolved" | "archived";

export const BOARD_THREAD_STATUSES: readonly BoardThreadStatus[] = ["open", "resolved", "archived"];
export const BOARD_LIMITS = {
	topicSlug: 48,
	topicTitle: 120,
	topicDescription: 1_000,
	threadTitle: 200,
	postBody: 32_768,
	tags: 8,
	tagLength: 32,
	postsPerThread: 5_000,
	threadPage: 100,
	postPage: 200,
	topicPage: 200,
	notices: 5,
	projectionBatch: 20,
} as const;

const TOPIC_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const BOARD_HARNESS = "signet-board";
const BOARD_POST_KIND = "board_post";

export type BoardViewer =
	| { readonly kind: "operator" }
	| {
			readonly kind: "agent";
			readonly agentId: string;
			readonly readPolicy: AgentRosterReadPolicy;
			readonly policyGroup: string | null;
	  };

export interface BoardAuthor {
	readonly agentId: string;
	readonly sessionKey?: string;
	readonly harness?: string;
}

export interface BoardTopic {
	readonly slug: string;
	readonly title: string | null;
	readonly description: string | null;
	readonly createdByAgentId: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly threadCount: number;
	readonly lastActivityAt: string | null;
}

export interface BoardThread {
	readonly id: string;
	readonly topic: string;
	readonly title: string;
	readonly authorAgentId: string;
	readonly authorSessionKey: string | null;
	readonly authorHarness: string | null;
	readonly status: BoardThreadStatus;
	readonly pinned: boolean;
	readonly tags: readonly string[];
	readonly sourceMessageId: string | null;
	readonly postCount: number;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly lastPostAt: string;
	readonly lastReadAt: string | null;
	readonly unread: boolean;
}

export interface BoardPost {
	readonly id: string;
	readonly threadId: string;
	readonly authorAgentId: string;
	readonly authorSessionKey: string | null;
	readonly authorHarness: string | null;
	readonly body: string;
	readonly replyToPostId: string | null;
	readonly createdAt: string;
	readonly projected: boolean;
}

export interface BoardThreadPage {
	readonly items: readonly BoardThread[];
	readonly total: number;
	readonly limit: number;
	readonly offset: number;
	readonly hasMore: boolean;
}

export interface BoardThreadDetail {
	readonly thread: BoardThread;
	readonly posts: readonly BoardPost[];
	readonly postTotal: number;
	readonly postLimit: number;
	readonly postOffset: number;
	readonly hasMorePosts: boolean;
}

export interface BoardWriteResult {
	readonly thread: BoardThread;
	readonly post: BoardPost;
	readonly projection: "projected" | "pending";
}

export type BoardEvent = {
	readonly type: "board";
	readonly action: "thread_created" | "post_created" | "thread_updated" | "thread_deleted";
	readonly threadId: string;
	readonly topic: string;
	readonly threadAuthorAgentId: string;
	readonly postId?: string;
	readonly timestamp: string;
};

export class BoardValidationError extends Error {
	readonly status = 400;
	constructor(message: string) {
		super(message);
		this.name = "BoardValidationError";
	}
}

export class BoardNotFoundError extends Error {
	readonly status = 404;
	constructor(message: string) {
		super(message);
		this.name = "BoardNotFoundError";
	}
}

export class BoardForbiddenError extends Error {
	readonly status = 403;
	constructor(message: string) {
		super(message);
		this.name = "BoardForbiddenError";
	}
}

export class BoardConflictError extends Error {
	readonly status = 409;
	constructor(message: string) {
		super(message);
		this.name = "BoardConflictError";
	}
}

export type BoardError = BoardValidationError | BoardNotFoundError | BoardForbiddenError | BoardConflictError;

export function isBoardError(error: unknown): error is BoardError {
	return (
		error instanceof BoardValidationError ||
		error instanceof BoardNotFoundError ||
		error instanceof BoardForbiddenError ||
		error instanceof BoardConflictError
	);
}

const subscribers = new Set<(event: BoardEvent) => void>();

export function subscribeBoardEvents(subscriber: (event: BoardEvent) => void): () => void {
	subscribers.add(subscriber);
	return () => {
		subscribers.delete(subscriber);
	};
}

function emit(event: BoardEvent): void {
	for (const subscriber of subscribers) {
		try {
			subscriber(event);
		} catch {}
	}
}

export async function resolveBoardViewer(agentId: string): Promise<BoardViewer> {
	const scope = await getAgentScope(agentId);
	return { kind: "agent", agentId, readPolicy: scope.readPolicy, policyGroup: scope.policyGroup };
}

export function boardViewerAgentId(viewer: BoardViewer): string | null {
	return viewer.kind === "agent" ? viewer.agentId : null;
}

function agentVisibility(viewer: BoardViewer, column: string): { sql: string; args: DbOwnerParameter[] } {
	if (viewer.kind === "operator" || viewer.readPolicy === "shared") return { sql: "1 = 1", args: [] };
	if (viewer.readPolicy === "group" && viewer.policyGroup) {
		return {
			sql: `(${column} = ? OR ${column} IN (SELECT id FROM agents WHERE policy_group = ?))`,
			args: [viewer.agentId, viewer.policyGroup],
		};
	}
	return { sql: `${column} = ?`, args: [viewer.agentId] };
}

export async function createBoardEventVisibility(viewer: BoardViewer): Promise<(authorAgentId: string) => boolean> {
	if (viewer.kind === "operator" || viewer.readPolicy === "shared") return () => true;
	if (viewer.readPolicy === "group" && viewer.policyGroup) {
		const rows = await dbOwnerQuery<readonly { readonly id: string }[]>(
			ownerStatement("SELECT id FROM agents WHERE policy_group = ?", [viewer.policyGroup], "all"),
			{ operation: "board.group-members", lane: "read", deadlineMs: 5_000, estimatedWorkUnits: 1 },
		);
		const members = new Set(rows.map((row) => row.id));
		members.add(viewer.agentId);
		return (authorAgentId) => members.has(authorAgentId);
	}
	return (authorAgentId) => authorAgentId === viewer.agentId;
}

function normalizeText(value: string | undefined | null): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeTopicSlug(value: string | undefined): string {
	const slug = normalizeText(value)?.toLowerCase();
	if (!slug || !TOPIC_SLUG_RE.test(slug)) {
		throw new BoardValidationError(
			"topic must be 1-48 characters of lowercase letters, digits, and hyphens, starting with a letter or digit",
		);
	}
	return slug;
}

export function normalizeBoardTags(value: readonly unknown[] | undefined): readonly string[] {
	if (value === undefined) return [];
	const tags = new Set<string>();
	for (const raw of value) {
		if (typeof raw !== "string") throw new BoardValidationError("tags must be strings");
		const tag = raw.trim().toLowerCase().replace(/^#/, "");
		if (!TAG_RE.test(tag)) {
			throw new BoardValidationError(
				`invalid tag '${raw}': use 1-32 lowercase letters, digits, and hyphens, starting with a letter or digit`,
			);
		}
		tags.add(tag);
	}
	if (tags.size > BOARD_LIMITS.tags) throw new BoardValidationError(`at most ${BOARD_LIMITS.tags} tags are allowed`);
	return [...tags].sort();
}

function requireBounded(value: string | undefined, field: string, max: number): string {
	const text = normalizeText(value);
	if (!text) throw new BoardValidationError(`${field} is required`);
	if (text.length > max) throw new BoardValidationError(`${field} must be ${max} characters or fewer`);
	return text;
}

function optionalBounded(value: string | undefined, field: string, max: number): string | null {
	const text = normalizeText(value);
	if (!text) return null;
	if (text.length > max) throw new BoardValidationError(`${field} must be ${max} characters or fewer`);
	return text;
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.round(value)));
}

function threadPath(threadId: string): string {
	return `signet-board://thread/${threadId}`;
}

function postPath(threadId: string, postId: string): string {
	return `${threadPath(threadId)}/post/${postId}`;
}

interface ThreadRow {
	readonly id: string;
	readonly topic_slug: string;
	readonly title: string;
	readonly author_agent_id: string;
	readonly author_session_key: string | null;
	readonly author_harness: string | null;
	readonly status: BoardThreadStatus;
	readonly pinned: number;
	readonly source_message_id: string | null;
	readonly post_count: number;
	readonly created_at: string;
	readonly updated_at: string;
	readonly last_post_at: string;
	readonly tags_csv: string | null;
	readonly last_read_at: string | null;
}

interface PostRow {
	readonly id: string;
	readonly thread_id: string;
	readonly author_agent_id: string;
	readonly author_session_key: string | null;
	readonly author_harness: string | null;
	readonly body: string;
	readonly reply_to_post_id: string | null;
	readonly created_at: string;
	readonly projected_at: string | null;
}

interface TopicRow {
	readonly slug: string;
	readonly title: string | null;
	readonly description: string | null;
	readonly created_by_agent_id: string;
	readonly created_at: string;
	readonly updated_at: string;
	readonly thread_count: number | null;
	readonly last_activity_at: string | null;
}

function threadFromRow(row: ThreadRow, viewer: BoardViewer): BoardThread {
	const tags = (row.tags_csv ?? "")
		.split(",")
		.map((tag) => tag.trim())
		.filter((tag) => tag.length > 0)
		.sort();
	const unread = viewer.kind === "agent" ? row.last_read_at === null || row.last_post_at > row.last_read_at : false;
	return {
		id: row.id,
		topic: row.topic_slug,
		title: row.title,
		authorAgentId: row.author_agent_id,
		authorSessionKey: row.author_session_key,
		authorHarness: row.author_harness,
		status: row.status,
		pinned: row.pinned === 1,
		tags,
		sourceMessageId: row.source_message_id,
		postCount: row.post_count,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		lastPostAt: row.last_post_at,
		lastReadAt: row.last_read_at,
		unread,
	};
}

function postFromRow(row: PostRow): BoardPost {
	return {
		id: row.id,
		threadId: row.thread_id,
		authorAgentId: row.author_agent_id,
		authorSessionKey: row.author_session_key,
		authorHarness: row.author_harness,
		body: row.body,
		replyToPostId: row.reply_to_post_id,
		createdAt: row.created_at,
		projected: row.projected_at !== null,
	};
}

async function readAll<Row>(
	sql: string,
	params: readonly DbOwnerParameter[],
	operation: string,
): Promise<readonly Row[]> {
	return await dbOwnerQuery<readonly Row[]>(ownerStatement(sql, params, "all"), {
		operation,
		lane: "read",
		deadlineMs: 5_000,
		estimatedWorkUnits: 2,
	});
}

async function write(statements: readonly DbOwnerStatement[], operation: string): Promise<readonly unknown[]> {
	return await dbOwnerBatch(statements, {
		operation,
		lane: "write",
		deadlineMs: 10_000,
		estimatedWorkUnits: Math.max(1, statements.length),
	});
}

const THREAD_SELECT = `SELECT t.*,
	(SELECT group_concat(g.tag, ',') FROM board_thread_tags g WHERE g.thread_id = t.id) AS tags_csv,
	r.last_read_at AS last_read_at
	FROM board_threads t
	LEFT JOIN board_reads r ON r.thread_id = t.id AND r.agent_id = ?`;

async function readVisibleThread(threadId: string, viewer: BoardViewer): Promise<BoardThread> {
	const visibility = agentVisibility(viewer, "t.author_agent_id");
	const rows = await readAll<ThreadRow>(
		`${THREAD_SELECT} WHERE t.id = ? AND ${visibility.sql}`,
		[boardViewerAgentId(viewer) ?? "", threadId, ...visibility.args],
		"board.thread.read",
	);
	const row = rows[0];
	if (!row) throw new BoardNotFoundError(`board thread not found: ${threadId}`);
	return threadFromRow(row, viewer);
}

async function readPost(postId: string): Promise<BoardPost | null> {
	const rows = await readAll<PostRow>("SELECT * FROM board_posts WHERE id = ?", [postId], "board.post.read");
	return rows[0] ? postFromRow(rows[0]) : null;
}

export async function listBoardTopics(viewer: BoardViewer): Promise<readonly BoardTopic[]> {
	const threadVisibility = agentVisibility(viewer, "t.author_agent_id");
	const creatorVisibility = agentVisibility(viewer, "tp.created_by_agent_id");
	const rows = await readAll<TopicRow>(
		`SELECT tp.*,
			(SELECT COUNT(*) FROM board_threads t
			 WHERE t.topic_slug = tp.slug AND t.status <> 'archived' AND ${threadVisibility.sql}) AS thread_count,
			(SELECT MAX(t.last_post_at) FROM board_threads t
			 WHERE t.topic_slug = tp.slug AND ${threadVisibility.sql}) AS last_activity_at
		 FROM board_topics tp
		 WHERE ${creatorVisibility.sql}
		    OR EXISTS (SELECT 1 FROM board_threads t WHERE t.topic_slug = tp.slug AND ${threadVisibility.sql})
		 ORDER BY last_activity_at IS NULL, last_activity_at DESC, tp.slug ASC
		 LIMIT ?`,
		[
			...threadVisibility.args,
			...threadVisibility.args,
			...creatorVisibility.args,
			...threadVisibility.args,
			BOARD_LIMITS.topicPage,
		],
		"board.topics.list",
	);
	return rows.map((row) => ({
		slug: row.slug,
		title: row.title,
		description: row.description,
		createdByAgentId: row.created_by_agent_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		threadCount: row.thread_count ?? 0,
		lastActivityAt: row.last_activity_at,
	}));
}

export async function createBoardTopic(input: {
	readonly slug: string | undefined;
	readonly title?: string;
	readonly description?: string;
	readonly author: BoardAuthor;
	readonly nowMs?: number;
}): Promise<{ readonly slug: string; readonly created: boolean }> {
	const slug = normalizeTopicSlug(input.slug);
	const title = optionalBounded(input.title, "title", BOARD_LIMITS.topicTitle);
	const description = optionalBounded(input.description, "description", BOARD_LIMITS.topicDescription);
	const now = new Date(input.nowMs ?? Date.now()).toISOString();
	const results = await write(
		[
			ownerStatement(
				`INSERT OR IGNORE INTO board_topics (slug, title, description, created_by_agent_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				[slug, title, description, input.author.agentId, now, now],
			),
		],
		"board.topic.create",
	);
	const created = (results[0] as { readonly changes?: number } | undefined)?.changes === 1;
	return { slug, created };
}

export async function listBoardThreads(
	viewer: BoardViewer,
	options: {
		readonly topic?: string;
		readonly tag?: string;
		readonly status?: BoardThreadStatus | "all";
		readonly limit?: number;
		readonly offset?: number;
	} = {},
): Promise<BoardThreadPage> {
	const limit = clamp(options.limit, 25, 1, BOARD_LIMITS.threadPage);
	const offset = clamp(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
	const visibility = agentVisibility(viewer, "t.author_agent_id");
	const filters = [visibility.sql];
	const args: DbOwnerParameter[] = [...visibility.args];
	if (options.topic) {
		filters.push("t.topic_slug = ?");
		args.push(normalizeTopicSlug(options.topic));
	}
	if (options.tag) {
		filters.push("EXISTS (SELECT 1 FROM board_thread_tags g2 WHERE g2.thread_id = t.id AND g2.tag = ?)");
		args.push(normalizeBoardTags([options.tag])[0] ?? "");
	}
	if (options.status && options.status !== "all") {
		filters.push("t.status = ?");
		args.push(options.status);
	} else if (!options.status) {
		filters.push("t.status <> 'archived'");
	}
	const where = filters.join(" AND ");
	const counts = await readAll<{ readonly total: number }>(
		`SELECT COUNT(*) AS total FROM board_threads t WHERE ${where}`,
		args,
		"board.threads.count",
	);
	const rows = await readAll<ThreadRow>(
		`${THREAD_SELECT} WHERE ${where}
		 ORDER BY t.pinned DESC, t.last_post_at DESC, t.id ASC
		 LIMIT ? OFFSET ?`,
		[boardViewerAgentId(viewer) ?? "", ...args, limit, offset],
		"board.threads.list",
	);
	const total = counts[0]?.total ?? 0;
	return {
		items: rows.map((row) => threadFromRow(row, viewer)),
		total,
		limit,
		offset,
		hasMore: offset + rows.length < total,
	};
}

export async function readBoardThread(
	threadId: string,
	viewer: BoardViewer,
	options: { readonly postLimit?: number; readonly postOffset?: number } = {},
): Promise<BoardThreadDetail> {
	const thread = await readVisibleThread(threadId, viewer);
	const postLimit = clamp(options.postLimit, 100, 1, BOARD_LIMITS.postPage);
	const postOffset = clamp(options.postOffset, 0, 0, Number.MAX_SAFE_INTEGER);
	const rows = await readAll<PostRow>(
		"SELECT * FROM board_posts WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ? OFFSET ?",
		[threadId, postLimit, postOffset],
		"board.posts.list",
	);
	return {
		thread,
		posts: rows.map(postFromRow),
		postTotal: thread.postCount,
		postLimit,
		postOffset,
		hasMorePosts: postOffset + rows.length < thread.postCount,
	};
}

export async function markBoardThreadRead(
	threadId: string,
	viewer: BoardViewer,
	nowMs = Date.now(),
): Promise<{ readonly threadId: string; readonly lastReadAt: string }> {
	if (viewer.kind !== "agent") throw new BoardValidationError("read cursors require an agent");
	await readVisibleThread(threadId, viewer);
	const now = new Date(nowMs).toISOString();
	await write(
		[
			ownerStatement(
				`INSERT INTO board_reads (agent_id, thread_id, last_read_at) VALUES (?, ?, ?)
				 ON CONFLICT(agent_id, thread_id) DO UPDATE SET last_read_at = excluded.last_read_at`,
				[viewer.agentId, threadId, now],
			),
		],
		"board.thread.mark-read",
	);
	return { threadId, lastReadAt: now };
}

function defaultTitleFrom(content: string): string {
	const firstLine =
		content
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? "Promoted message";
	return firstLine.length > 120 ? `${firstLine.slice(0, 119)}…` : firstLine;
}

async function readPromotableMessage(messageId: string, author: BoardAuthor): Promise<AgentMessage> {
	const rows = await readAll<CrossAgentMessageRow>(
		"SELECT m.*, NULL AS acknowledged_at FROM cross_agent_messages m WHERE m.id = ?",
		[messageId],
		"board.promote.message",
	);
	const row = rows[0];
	if (!row) throw new BoardNotFoundError(`cross-agent message not found or not visible: ${messageId}`);
	const message = rowToAgentMessage(row);
	const visible =
		message.fromAgentId === author.agentId ||
		isMessageVisibleToAgent(message, {
			agentId: author.agentId,
			sessionKey: author.sessionKey,
			includeBroadcast: true,
		});
	if (!visible) throw new BoardNotFoundError(`cross-agent message not found or not visible: ${messageId}`);
	return message;
}

export async function createBoardThread(input: {
	readonly viewer: BoardViewer;
	readonly author: BoardAuthor;
	readonly topic: string | undefined;
	readonly title?: string;
	readonly body?: string;
	readonly tags?: readonly unknown[];
	readonly fromMessageId?: string;
	readonly nowMs?: number;
}): Promise<BoardWriteResult> {
	const topic = normalizeTopicSlug(input.topic);
	const tags = normalizeBoardTags(input.tags);
	const promoted = input.fromMessageId ? await readPromotableMessage(input.fromMessageId, input.author) : null;
	const body = requireBounded(input.body ?? promoted?.content, "body", BOARD_LIMITS.postBody);
	const title = requireBounded(
		input.title ?? (promoted ? defaultTitleFrom(promoted.content) : undefined),
		"title",
		BOARD_LIMITS.threadTitle,
	);
	const postAuthor: BoardAuthor = promoted
		? { agentId: promoted.fromAgentId, sessionKey: promoted.fromSessionKey, harness: undefined }
		: input.author;
	const now = new Date(input.nowMs ?? Date.now()).toISOString();
	const threadId = randomUUID();
	const postId = randomUUID();
	await write(
		[
			ownerStatement(
				`INSERT OR IGNORE INTO board_topics (slug, title, description, created_by_agent_id, created_at, updated_at)
				 VALUES (?, NULL, NULL, ?, ?, ?)`,
				[topic, input.author.agentId, now, now],
			),
			ownerStatement(
				`INSERT INTO board_threads (
					id, topic_slug, title, author_agent_id, author_session_key, author_harness,
					status, pinned, source_message_id, post_count, created_at, updated_at, last_post_at
				) VALUES (?, ?, ?, ?, ?, ?, 'open', 0, ?, 1, ?, ?, ?)`,
				[
					threadId,
					topic,
					title,
					input.author.agentId,
					input.author.sessionKey ?? null,
					input.author.harness ?? null,
					promoted?.id ?? null,
					now,
					now,
					now,
				],
			),
			...tags.map((tag) =>
				ownerStatement("INSERT INTO board_thread_tags (thread_id, tag) VALUES (?, ?)", [threadId, tag]),
			),
			ownerStatement(
				`INSERT INTO board_posts (
					id, thread_id, author_agent_id, author_session_key, author_harness, body, reply_to_post_id, created_at
				) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
				[postId, threadId, postAuthor.agentId, postAuthor.sessionKey ?? null, postAuthor.harness ?? null, body, now],
			),
		],
		"board.thread.create",
	);
	emit({
		type: "board",
		action: "thread_created",
		threadId,
		topic,
		threadAuthorAgentId: input.author.agentId,
		postId,
		timestamp: now,
	});
	const projection = await projectAfterWrite(postId);
	const thread = await readVisibleThread(threadId, input.viewer);
	const post = await readPost(postId);
	if (!post) throw new Error(`board post disappeared after commit: ${postId}`);
	return { thread, post, projection };
}

export async function replyToBoardThread(input: {
	readonly viewer: BoardViewer;
	readonly author: BoardAuthor;
	readonly threadId: string;
	readonly body: string | undefined;
	readonly replyToPostId?: string;
	readonly nowMs?: number;
}): Promise<BoardWriteResult> {
	const thread = await readVisibleThread(input.threadId, input.viewer);
	if (thread.status === "archived") throw new BoardConflictError("archived threads do not accept replies");
	if (thread.postCount >= BOARD_LIMITS.postsPerThread) {
		throw new BoardConflictError(`thread reached the ${BOARD_LIMITS.postsPerThread} post limit`);
	}
	const body = requireBounded(input.body, "body", BOARD_LIMITS.postBody);
	const replyToPostId = normalizeText(input.replyToPostId) ?? null;
	if (replyToPostId) {
		const target = await readPost(replyToPostId);
		if (!target || target.threadId !== thread.id) {
			throw new BoardValidationError("replyToPostId must reference a post in the same thread");
		}
	}
	const now = new Date(input.nowMs ?? Date.now()).toISOString();
	const postId = randomUUID();
	try {
		await write(
			[
				{
					...ownerStatement(
						`UPDATE board_threads
						 SET post_count = post_count + 1, last_post_at = ?, updated_at = ?
						 WHERE id = ? AND status <> 'archived' AND post_count < ?`,
						[now, now, thread.id, BOARD_LIMITS.postsPerThread],
					),
					requireChanges: true,
				},
				ownerStatement(
					`INSERT INTO board_posts (
						id, thread_id, author_agent_id, author_session_key, author_harness, body, reply_to_post_id, created_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						postId,
						thread.id,
						input.author.agentId,
						input.author.sessionKey ?? null,
						input.author.harness ?? null,
						body,
						replyToPostId,
						now,
					],
				),
			],
			"board.post.create",
		);
	} catch (error) {
		if (error instanceof Error && /changed zero rows/.test(error.message)) {
			throw new BoardConflictError("thread no longer accepts replies");
		}
		throw error;
	}
	emit({
		type: "board",
		action: "post_created",
		threadId: thread.id,
		topic: thread.topic,
		threadAuthorAgentId: thread.authorAgentId,
		postId,
		timestamp: now,
	});
	const projection = await projectAfterWrite(postId);
	const updated = await readVisibleThread(thread.id, input.viewer);
	const post = await readPost(postId);
	if (!post) throw new Error(`board post disappeared after commit: ${postId}`);
	return { thread: updated, post, projection };
}

export async function updateBoardThread(input: {
	readonly viewer: BoardViewer;
	readonly threadId: string;
	readonly status?: BoardThreadStatus;
	readonly pinned?: boolean;
	readonly title?: string;
	readonly tags?: readonly unknown[];
	readonly nowMs?: number;
}): Promise<BoardThread> {
	const thread = await readVisibleThread(input.threadId, input.viewer);
	if (input.viewer.kind === "agent" && input.viewer.agentId !== thread.authorAgentId) {
		throw new BoardForbiddenError("only the thread author agent or the operator can change this thread");
	}
	if (input.status !== undefined && !BOARD_THREAD_STATUSES.includes(input.status)) {
		throw new BoardValidationError(`status must be one of ${BOARD_THREAD_STATUSES.join(", ")}`);
	}
	const title = input.title === undefined ? undefined : requireBounded(input.title, "title", BOARD_LIMITS.threadTitle);
	const tags = input.tags === undefined ? undefined : normalizeBoardTags(input.tags);
	if (input.status === undefined && input.pinned === undefined && title === undefined && tags === undefined) {
		throw new BoardValidationError("provide status, pinned, title, or tags");
	}
	const now = new Date(input.nowMs ?? Date.now()).toISOString();
	const statements: DbOwnerStatement[] = [
		{
			...ownerStatement(
				`UPDATE board_threads
				 SET status = COALESCE(?, status), pinned = COALESCE(?, pinned), title = COALESCE(?, title), updated_at = ?
				 WHERE id = ?`,
				[input.status ?? null, input.pinned === undefined ? null : input.pinned ? 1 : 0, title ?? null, now, thread.id],
			),
			requireChanges: true,
		},
	];
	if (tags !== undefined) {
		statements.push(ownerStatement("DELETE FROM board_thread_tags WHERE thread_id = ?", [thread.id]));
		for (const tag of tags) {
			statements.push(ownerStatement("INSERT INTO board_thread_tags (thread_id, tag) VALUES (?, ?)", [thread.id, tag]));
		}
	}
	try {
		await write(statements, "board.thread.update");
	} catch (error) {
		if (error instanceof Error && /changed zero rows/.test(error.message)) {
			throw new BoardNotFoundError(`board thread not found: ${thread.id}`);
		}
		throw error;
	}
	emit({
		type: "board",
		action: "thread_updated",
		threadId: thread.id,
		topic: thread.topic,
		threadAuthorAgentId: thread.authorAgentId,
		timestamp: now,
	});
	return await readVisibleThread(thread.id, input.viewer);
}

export async function deleteBoardThread(
	threadId: string,
	viewer: BoardViewer,
): Promise<{ readonly threadId: string; readonly deletedPosts: number }> {
	if (viewer.kind !== "operator") throw new BoardForbiddenError("only the operator can delete board threads");
	const thread = await readVisibleThread(threadId, viewer);
	const parent = threadPath(thread.id);
	const results = await write(
		[
			ownerStatement("DELETE FROM memory_artifacts WHERE source_parent_path = ? AND source_kind = ?", [
				parent,
				BOARD_POST_KIND,
			]),
			ownerStatement("DELETE FROM board_posts WHERE thread_id = ?", [thread.id]),
			ownerStatement("DELETE FROM board_thread_tags WHERE thread_id = ?", [thread.id]),
			ownerStatement("DELETE FROM board_reads WHERE thread_id = ?", [thread.id]),
			ownerStatement("DELETE FROM board_notices WHERE thread_id = ?", [thread.id]),
			ownerStatement("DELETE FROM board_threads WHERE id = ?", [thread.id]),
		],
		"board.thread.delete",
	);
	emit({
		type: "board",
		action: "thread_deleted",
		threadId: thread.id,
		topic: thread.topic,
		threadAuthorAgentId: thread.authorAgentId,
		timestamp: new Date().toISOString(),
	});
	return { threadId: thread.id, deletedPosts: (results[1] as { readonly changes?: number } | undefined)?.changes ?? 0 };
}

export async function claimBoardActivityNotices(input: {
	readonly agentId: string;
	readonly sessionKey?: string;
	readonly limit?: number;
	readonly nowMs?: number;
}): Promise<readonly BoardActivityNotice[]> {
	const viewer = await resolveBoardViewer(input.agentId);
	const visibility = agentVisibility(viewer, "t.author_agent_id");
	const limit = clamp(input.limit, BOARD_LIMITS.notices, 1, BOARD_LIMITS.notices);
	const scanStartedAt = new Date().toISOString();
	const session = input.sessionKey ?? "";
	const authorSession = input.sessionKey ?? null;
	const rows = await readAll<{
		readonly id: string;
		readonly topic_slug: string;
		readonly title: string;
		readonly last_post_at: string;
		readonly new_posts: number;
	}>(
		`WITH mine AS (
			SELECT thread_id FROM board_posts WHERE author_agent_id = ? AND author_session_key IS ?
			UNION
			SELECT id AS thread_id FROM board_threads WHERE author_agent_id = ? AND author_session_key IS ?
		),
		candidates AS (
			SELECT t.id, t.topic_slug, t.title, t.last_post_at,
				MAX(
					COALESCE(r.last_read_at, ''),
					COALESCE(n.notified_at, ''),
					COALESCE((
						SELECT MAX(own.created_at) FROM board_posts own
						WHERE own.thread_id = t.id AND own.author_agent_id = ? AND own.author_session_key IS ?
					), '')
				) AS seen_at
			FROM mine
			JOIN board_threads t ON t.id = mine.thread_id
			LEFT JOIN board_reads r ON r.thread_id = t.id AND r.agent_id = ?
			LEFT JOIN board_notices n ON n.thread_id = t.id AND n.agent_id = ? AND n.session_key = ?
			WHERE t.status <> 'archived'
			  AND ${visibility.sql}
		)
		SELECT c.id, c.topic_slug, c.title, c.last_post_at,
			(SELECT COUNT(*) FROM board_posts p2
			 WHERE p2.thread_id = c.id
			   AND p2.created_at > c.seen_at
			   AND NOT (p2.author_agent_id = ? AND p2.author_session_key IS ?)) AS new_posts
		FROM candidates c
		WHERE c.last_post_at > c.seen_at
		ORDER BY c.last_post_at DESC
		LIMIT ?`,
		[
			input.agentId,
			authorSession,
			input.agentId,
			authorSession,
			input.agentId,
			authorSession,
			input.agentId,
			input.agentId,
			session,
			...visibility.args,
			input.agentId,
			authorSession,
			BOARD_LIMITS.notices * 4,
		],
		"board.notices.scan",
	);
	const notices = rows
		.filter((row) => row.new_posts > 0)
		.slice(0, limit)
		.map((row) => ({
			threadId: row.id,
			topic: row.topic_slug,
			title: row.title,
			newPosts: row.new_posts,
			lastPostAt: row.last_post_at,
		}));
	if (notices.length === 0) return [];
	const now = new Date(input.nowMs ?? Date.now()).toISOString();
	const results = await write(
		notices.map((notice) =>
			ownerStatement(
				`INSERT INTO board_notices (agent_id, session_key, thread_id, notified_at) VALUES (?, ?, ?, ?)
				 ON CONFLICT(agent_id, session_key, thread_id) DO UPDATE SET notified_at = excluded.notified_at
				 WHERE board_notices.notified_at < ?`,
				[input.agentId, session, notice.threadId, now, scanStartedAt],
			),
		),
		"board.notices.claim",
	);
	return notices.filter((_, index) => (results[index] as { readonly changes?: number } | undefined)?.changes === 1);
}

function renderPostArtifact(thread: BoardThread, post: BoardPost): string {
	const author = post.authorSessionKey
		? `${post.authorAgentId} (session ${post.authorSessionKey})`
		: post.authorAgentId;
	const lines = [
		`# Message board post in ${thread.topic}: ${thread.title}`,
		"",
		`- Thread: ${thread.id}`,
		`- Post: ${post.id}`,
		`- Author: ${author}${post.authorHarness ? ` via ${post.authorHarness}` : ""}`,
		`- Posted: ${post.createdAt}`,
	];
	if (thread.tags.length > 0) lines.push(`- Tags: ${thread.tags.join(", ")}`);
	if (post.replyToPostId) lines.push(`- In reply to post: ${post.replyToPostId}`);
	if (thread.sourceMessageId) lines.push(`- Promoted from direct message: ${thread.sourceMessageId}`);
	lines.push("", post.body);
	return lines.join("\n");
}

export async function projectBoardPost(postId: string): Promise<boolean> {
	const post = await readPost(postId);
	if (!post) return false;
	const thread = await readVisibleThread(post.threadId, { kind: "operator" });
	const participants = await readAll<{ readonly author_agent_id: string }>(
		`SELECT DISTINCT author_agent_id FROM board_posts
		 WHERE thread_id = ? AND (created_at < ? OR (created_at = ? AND id = ?))`,
		[thread.id, post.createdAt, post.createdAt, post.id],
		"board.projection.participants",
	);
	const agents = new Set<string>([thread.authorAgentId, ...participants.map((row) => row.author_agent_id)]);
	const content = renderPostArtifact(thread, post);
	const path = postPath(thread.id, post.id);
	for (const agentId of agents) {
		await indexExternalMemoryArtifact({
			agentId,
			harness: BOARD_HARNESS,
			sourcePath: path,
			sourceParentPath: threadPath(thread.id),
			sourceExternalId: post.id,
			sourceKind: BOARD_POST_KIND,
			sourceMtimeMs: Date.parse(post.createdAt),
			capturedAt: post.createdAt,
			content,
			sourceMeta: {
				threadId: thread.id,
				postId: post.id,
				topic: thread.topic,
				authorAgentId: post.authorAgentId,
				authorSessionKey: post.authorSessionKey,
				authorHarness: post.authorHarness,
				replyToPostId: post.replyToPostId,
				sourceMessageId: thread.sourceMessageId,
			},
		});
	}
	await write(
		[
			ownerStatement("UPDATE board_posts SET projected_at = ? WHERE id = ? AND projected_at IS NULL", [
				new Date().toISOString(),
				post.id,
			]),
			ownerStatement(
				`DELETE FROM memory_artifacts
				 WHERE source_path = ? AND source_kind = ?
				   AND NOT EXISTS (SELECT 1 FROM board_posts WHERE id = ?)`,
				[path, BOARD_POST_KIND, post.id],
			),
		],
		"board.projection.mark",
	);
	return true;
}

let drainFlight: Promise<number> | null = null;

export async function drainBoardProjections(limit: number = BOARD_LIMITS.projectionBatch): Promise<number> {
	if (drainFlight) return await drainFlight;
	drainFlight = (async () => {
		const rows = await readAll<{ readonly id: string }>(
			"SELECT id FROM board_posts WHERE projected_at IS NULL ORDER BY created_at ASC, id ASC LIMIT ?",
			[clamp(limit, BOARD_LIMITS.projectionBatch, 1, 100)],
			"board.projection.pending",
		);
		let projected = 0;
		for (const row of rows) {
			try {
				if (await projectBoardPost(row.id)) projected += 1;
			} catch (error) {
				logger.warn("board", "Board post projection failed", {
					postId: row.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return projected;
	})();
	try {
		return await drainFlight;
	} finally {
		drainFlight = null;
	}
}

async function projectAfterWrite(postId: string): Promise<"projected" | "pending"> {
	try {
		await drainBoardProjections();
	} catch (error) {
		logger.warn("board", "Board projection drain failed", {
			postId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
	const post = await readPost(postId);
	return post?.projected ? "projected" : "pending";
}

export function resetBoardStateForTest(): void {
	subscribers.clear();
	drainFlight = null;
}
