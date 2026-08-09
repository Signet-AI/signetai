import { randomUUID } from "node:crypto";
import { type DbAccessor, type ReadDb, type WriteDb, getDbAccessor, hasDbAccessor } from "./db-accessor";
export { relayMessageViaAcp, type AcpRelayRequest, type AcpRelayResult } from "./cross-agent-acp";

export type AgentMessageType = "assist_request" | "decision_update" | "info" | "question";

export type AgentMessageDeliveryPath = "local" | "acp";
export type AgentMessageDeliveryStatus = "queued" | "delivered" | "failed";
export type AgentMessageDeliveryState = "pending" | "in_flight" | "indeterminate" | "delivered" | "failed";

export interface AgentPresence {
	readonly key: string;
	readonly sessionKey?: string;
	readonly agentId: string;
	readonly harness: string;
	readonly project?: string;
	readonly runtimePath?: "plugin" | "legacy";
	readonly provider?: string;
	readonly startedAt: string;
	readonly lastSeenAt: string;
}

export interface UpsertAgentPresenceInput {
	readonly sessionKey?: string;
	readonly agentId?: string;
	readonly harness: string;
	readonly project?: string;
	readonly runtimePath?: "plugin" | "legacy";
	readonly provider?: string;
}

export interface ListAgentPresenceOptions {
	readonly agentId?: string;
	readonly includeSelf?: boolean;
	readonly sessionKey?: string;
	readonly project?: string;
	readonly limit?: number;
}

interface MutableAgentPresence {
	key: string;
	sessionKey?: string;
	agentId: string;
	harness: string;
	project?: string;
	runtimePath?: "plugin" | "legacy";
	provider?: string;
	startedAt: string;
	lastSeenAt: string;
}

export interface AgentMessage {
	readonly id: string;
	readonly createdAt: string;
	readonly expiresAt: string;
	readonly fromAgentId: string;
	readonly fromSessionKey?: string;
	readonly toAgentId?: string;
	readonly toSessionKey?: string;
	readonly toSessionAgentId?: string;
	readonly content: string;
	readonly type: AgentMessageType;
	readonly broadcast: boolean;
	readonly deliveryPath: AgentMessageDeliveryPath;
	readonly deliveryStatus: AgentMessageDeliveryStatus;
	readonly deliveryState: AgentMessageDeliveryState;
	readonly deliveryAttemptId?: string;
	readonly deliveryAttempts: number;
	readonly deliveryAttemptStartedAt?: string;
	readonly deliveryUpdatedAt?: string;
	readonly deliveryError?: string;
	readonly deliveryReceipt?: Record<string, unknown>;
	readonly acknowledgedAt?: string;
}

interface CrossAgentMessageRow {
	readonly id: string;
	readonly created_at: string;
	readonly expires_at: string;
	readonly from_agent_id: string;
	readonly from_session_key: string | null;
	readonly to_agent_id: string | null;
	readonly to_session_key: string | null;
	readonly to_session_agent_id: string | null;
	readonly content: string;
	readonly message_type: AgentMessageType;
	readonly broadcast: number;
	readonly delivery_path: AgentMessageDeliveryPath;
	readonly delivery_status: AgentMessageDeliveryStatus;
	readonly delivery_error: string | null;
	readonly delivery_receipt_json: string | null;
	readonly acknowledged_at: string | null;
	readonly delivery_state: AgentMessageDeliveryState;
	readonly delivery_attempt_id: string | null;
	readonly delivery_attempts: number;
	readonly delivery_lease_token: string | null;
	readonly delivery_lease_expires_at: string | null;
	readonly delivery_attempt_started_at: string | null;
	readonly delivery_updated_at: string | null;
	readonly acp_base_url: string | null;
	readonly acp_target_agent_name: string | null;
	readonly acp_timeout_ms: number | null;
	readonly acp_metadata_json: string | null;
}

export interface CreateAgentMessageInput {
	readonly fromAgentId?: string;
	readonly fromSessionKey?: string;
	readonly toAgentId?: string;
	readonly toSessionKey?: string;
	readonly content: string;
	readonly type?: AgentMessageType;
	readonly broadcast?: boolean;
	readonly deliveryPath?: AgentMessageDeliveryPath;
	readonly deliveryStatus?: AgentMessageDeliveryStatus;
	readonly deliveryError?: string;
	readonly deliveryReceipt?: Record<string, unknown>;
	readonly acpBaseUrl?: string;
	readonly acpTargetAgentName?: string;
	readonly acpTimeoutMs?: number;
	readonly acpMetadata?: Record<string, unknown>;
}

export interface ListAgentMessageOptions {
	readonly agentId?: string;
	readonly sessionKey?: string;
	readonly since?: string;
	readonly includeSent?: boolean;
	readonly includeBroadcast?: boolean;
	readonly unreadOnly?: boolean;
	readonly limit?: number;
	readonly offset?: number;
	readonly order?: "asc" | "desc";
}

export interface AgentMessagePage {
	readonly items: readonly AgentMessage[];
	readonly count: number;
	readonly total: number;
	readonly unreadCount: number;
	readonly limit: number;
	readonly offset: number;
	readonly hasMore: boolean;
}

export interface AcknowledgeAgentMessageInput {
	readonly messageId: string;
	readonly agentId?: string;
	readonly sessionKey?: string;
}

export interface AcknowledgeAgentMessageResult {
	readonly messageId: string;
	readonly agentId: string;
	readonly acknowledgedAt: string;
	readonly alreadyAcknowledged: boolean;
}

export class AgentMessageNotFoundError extends Error {
	constructor(messageId: string) {
		super(`Cross-agent message not found or not visible: ${messageId}`);
		this.name = "AgentMessageNotFoundError";
	}
}

export class AgentMessageCapacityError extends Error {
	constructor() {
		super("Cross-agent message capacity reached; wait for retention cleanup before retrying");
		this.name = "AgentMessageCapacityError";
	}
}

export interface AgentPresenceEvent {
	readonly type: "presence";
	readonly action: "upsert" | "remove";
	readonly presence: AgentPresence;
	readonly activeCount: number;
	readonly timestamp: string;
}

export interface AgentMessageEvent {
	readonly type: "message";
	readonly message: AgentMessage;
	readonly timestamp: string;
}

export type CrossAgentEvent = AgentPresenceEvent | AgentMessageEvent;

const PRESENCE_STALE_MS = 4 * 60 * 60 * 1000;
const AGENT_MESSAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MESSAGE_LIMIT = 100;
const MAX_MESSAGE_LIMIT = 500;
const MAX_MESSAGE_CONTENT_CHARS = 65_536;
const MAX_DURABLE_MESSAGES = 10_000;
const ACP_RELAY_LEASE_MS = 150_000; // 120s max ACP timeout plus a 30s reconciliation grace period
const ACP_PENDING_GRACE_MS = 30_000;
const ACP_MAX_RETRY_ATTEMPTS = 3;

const presenceByKey = new Map<string, MutableAgentPresence>();
const subscribers = new Set<(event: CrossAgentEvent) => void>();

function normalizeText(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneDeliveryReceipt(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!value) return undefined;

	try {
		if (typeof globalThis.structuredClone === "function") {
			const cloned = globalThis.structuredClone(value);
			return isRecord(cloned) ? cloned : undefined;
		}

		const cloned = JSON.parse(JSON.stringify(value));
		return isRecord(cloned) ? cloned : undefined;
	} catch {
		return undefined;
	}
}

function serializeDeliveryReceipt(value: Record<string, unknown> | undefined): string | null {
	const cloned = cloneDeliveryReceipt(value);
	return cloned ? JSON.stringify(cloned) : null;
}

function parseDeliveryReceipt(value: string | null): Record<string, unknown> | undefined {
	if (!value) return undefined;
	try {
		const parsed: unknown = JSON.parse(value);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function presenceKey(input: UpsertAgentPresenceInput): string {
	const sessionKey = normalizeText(input.sessionKey);
	if (sessionKey) return `session:${sessionKey}`;

	const agentId = normalizeText(input.agentId) ?? "default";
	const harness = normalizeText(input.harness) ?? "unknown";
	const project = normalizeText(input.project) ?? "*";
	return `ephemeral:${encodeURIComponent(agentId)}:${encodeURIComponent(harness)}:${encodeURIComponent(project)}`;
}

function clonePresence(presence: MutableAgentPresence): AgentPresence {
	return {
		key: presence.key,
		sessionKey: presence.sessionKey,
		agentId: presence.agentId,
		harness: presence.harness,
		project: presence.project,
		runtimePath: presence.runtimePath,
		provider: presence.provider,
		startedAt: presence.startedAt,
		lastSeenAt: presence.lastSeenAt,
	};
}

function emit(event: CrossAgentEvent): void {
	for (const subscriber of subscribers) {
		try {
			subscriber(event);
		} catch {
			// Subscribers are external; a faulty subscriber must not block others.
		}
	}
}

function parseIsoTimestamp(value: string | undefined): number | null {
	if (!value) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function prunePresence(nowMs = Date.now()): void {
	const nowIso = new Date(nowMs).toISOString();
	for (const [key, presence] of presenceByKey.entries()) {
		const seenAt = parseIsoTimestamp(presence.lastSeenAt);
		if (seenAt !== null && nowMs - seenAt <= PRESENCE_STALE_MS) continue;

		presenceByKey.delete(key);
		emit({
			type: "presence",
			action: "remove",
			presence: clonePresence(presence),
			activeCount: presenceByKey.size,
			timestamp: nowIso,
		});
	}
}

function pruneExpiredMessages(db: WriteDb, now: string): void {
	db.prepare("DELETE FROM cross_agent_messages WHERE expires_at <= ?").run(now);
}

function agentForSession(sessionKey: string): string | undefined {
	const presence = presenceByKey.get(`session:${sessionKey}`);
	return presence?.agentId;
}

function sessionKeysForAgent(agentId: string): readonly string[] {
	return [...presenceByKey.values()]
		.filter((presence) => presence.agentId === agentId && presence.sessionKey !== undefined)
		.map((presence) => presence.sessionKey as string);
}

export function getAgentPresenceForSession(sessionKey: string): AgentPresence | null {
	const normalized = normalizeText(sessionKey);
	if (!normalized) return null;
	prunePresence();
	const presence = presenceByKey.get(`session:${normalized}`);
	return presence ? clonePresence(presence) : null;
}

export function isMessageVisibleToAgent(
	message: AgentMessage,
	options: {
		readonly agentId?: string;
		readonly sessionKey?: string;
		readonly includeBroadcast?: boolean;
		readonly includeSent?: boolean;
	},
): boolean {
	const agentId = normalizeText(options.agentId);
	const sessionKey = normalizeText(options.sessionKey);
	if (
		sessionKey &&
		message.toSessionKey === sessionKey &&
		(!message.toSessionAgentId || message.toSessionAgentId === agentId)
	) {
		return true;
	}
	if (agentId && message.toAgentId === agentId) return true;
	if (agentId && message.toSessionAgentId === agentId) return true;
	if (
		agentId &&
		message.toSessionKey &&
		!message.toSessionAgentId &&
		agentForSession(message.toSessionKey) === agentId
	) {
		return true;
	}
	if (options.includeBroadcast !== false && message.broadcast) {
		return options.includeSent === true || !agentId || message.fromAgentId !== agentId;
	}
	return options.includeSent === true && !!agentId && message.fromAgentId === agentId;
}

export function upsertAgentPresence(input: UpsertAgentPresenceInput): AgentPresence {
	prunePresence();

	const key = presenceKey(input);
	const now = new Date().toISOString();
	const sessionKey = normalizeText(input.sessionKey);
	const agentId = normalizeText(input.agentId) ?? "default";
	const harness = normalizeText(input.harness) ?? "unknown";
	const project = normalizeText(input.project);
	const provider = normalizeText(input.provider);

	const existing = presenceByKey.get(key);
	if (existing) {
		existing.sessionKey = sessionKey;
		existing.agentId = agentId;
		existing.harness = harness;
		existing.project = project;
		existing.runtimePath = input.runtimePath;
		existing.provider = provider;
		existing.lastSeenAt = now;

		const out = clonePresence(existing);
		emit({
			type: "presence",
			action: "upsert",
			presence: out,
			activeCount: presenceByKey.size,
			timestamp: now,
		});
		return out;
	}

	const created: MutableAgentPresence = {
		key,
		sessionKey,
		agentId,
		harness,
		project,
		runtimePath: input.runtimePath,
		provider,
		startedAt: now,
		lastSeenAt: now,
	};
	presenceByKey.set(key, created);

	const out = clonePresence(created);
	emit({
		type: "presence",
		action: "upsert",
		presence: out,
		activeCount: presenceByKey.size,
		timestamp: now,
	});
	return out;
}

export function touchAgentPresence(sessionKey: string, agentId?: string): AgentPresence | null {
	const normalized = normalizeText(sessionKey);
	if (!normalized) return null;
	prunePresence();
	const presence = presenceByKey.get(`session:${normalized}`);
	if (!presence) return null;
	if (agentId && presence.agentId !== agentId) return null;
	presence.lastSeenAt = new Date().toISOString();
	return clonePresence(presence);
}

export function removeAgentPresence(sessionKey: string): boolean {
	const normalized = normalizeText(sessionKey);
	if (!normalized) return false;
	prunePresence();
	const key = `session:${normalized}`;
	const existing = presenceByKey.get(key);
	if (!existing) return false;

	presenceByKey.delete(key);
	const now = new Date().toISOString();
	emit({
		type: "presence",
		action: "remove",
		presence: clonePresence(existing),
		activeCount: presenceByKey.size,
		timestamp: now,
	});
	return true;
}

export function listAgentPresence(options: ListAgentPresenceOptions = {}): AgentPresence[] {
	prunePresence();

	const agentId = normalizeText(options.agentId);
	const sessionKey = normalizeText(options.sessionKey);
	const project = normalizeText(options.project);
	const includeSelf = options.includeSelf !== false;
	const limit = options.limit && options.limit > 0 ? options.limit : 50;

	return [...presenceByKey.values()]
		.filter((presence) => {
			if (project && presence.project !== project) return false;
			if (!agentId) return true;
			if (includeSelf) return true;
			if (presence.agentId !== agentId) return true;
			if (sessionKey && presence.sessionKey && presence.sessionKey !== sessionKey) return true;
			return false;
		})
		.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
		.slice(0, limit)
		.map(clonePresence);
}

function rowToAgentMessage(row: CrossAgentMessageRow): AgentMessage {
	return {
		id: row.id,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		fromAgentId: row.from_agent_id,
		fromSessionKey: row.from_session_key ?? undefined,
		toAgentId: row.to_agent_id ?? undefined,
		toSessionKey: row.to_session_key ?? undefined,
		toSessionAgentId: row.to_session_agent_id ?? undefined,
		content: row.content,
		type: row.message_type,
		broadcast: row.broadcast === 1,
		deliveryPath: row.delivery_path,
		deliveryStatus: row.delivery_status,
		deliveryState: row.delivery_state,
		deliveryAttemptId: row.delivery_attempt_id ?? undefined,
		deliveryAttempts: row.delivery_attempts,
		deliveryAttemptStartedAt: row.delivery_attempt_started_at ?? undefined,
		deliveryUpdatedAt: row.delivery_updated_at ?? undefined,
		deliveryError: row.delivery_error ?? undefined,
		deliveryReceipt: parseDeliveryReceipt(row.delivery_receipt_json),
		acknowledgedAt: row.acknowledged_at ?? undefined,
	};
}

function clampLimit(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_MESSAGE_LIMIT;
	return Math.max(1, Math.min(MAX_MESSAGE_LIMIT, Math.round(value)));
}

function clampOffset(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.round(value));
}

interface MessageQuery {
	readonly join: string;
	readonly where: string;
	readonly args: readonly unknown[];
	readonly agentId?: string;
}

function buildMessageQuery(options: ListAgentMessageOptions, now: string): MessageQuery | null {
	prunePresence();
	const agentId = normalizeText(options.agentId);
	const sessionKey = normalizeText(options.sessionKey);
	const includeSent = options.includeSent === true;
	const includeBroadcast = options.includeBroadcast !== false;
	const visibility: string[] = [];
	const visibilityArgs: unknown[] = [];

	if (sessionKey) {
		if (agentId) {
			visibility.push("(m.to_session_key = ? AND (m.to_session_agent_id IS NULL OR m.to_session_agent_id = ?))");
			visibilityArgs.push(sessionKey, agentId);
		} else {
			visibility.push("m.to_session_key = ?");
			visibilityArgs.push(sessionKey);
		}
	}
	if (agentId) {
		visibility.push("m.to_agent_id = ?");
		visibilityArgs.push(agentId);
		visibility.push("m.to_session_agent_id = ?");
		visibilityArgs.push(agentId);
		const activeSessions = sessionKeysForAgent(agentId);
		if (activeSessions.length > 0) {
			visibility.push(
				`(m.to_session_agent_id IS NULL AND m.to_session_key IN (${activeSessions.map(() => "?").join(", ")}))`,
			);
			visibilityArgs.push(...activeSessions);
		}
	}
	if (includeBroadcast) {
		if (agentId && !includeSent) {
			visibility.push("(m.broadcast = 1 AND m.from_agent_id <> ?)");
			visibilityArgs.push(agentId);
		} else {
			visibility.push("m.broadcast = 1");
		}
	}
	if (includeSent && agentId) {
		visibility.push("m.from_agent_id = ?");
		visibilityArgs.push(agentId);
	}
	if (visibility.length === 0) return null;

	const filters = ["m.expires_at > ?", `(${visibility.join(" OR ")})`];
	const args: unknown[] = [now, ...visibilityArgs];
	const sinceMs = parseIsoTimestamp(options.since);
	if (sinceMs !== null) {
		filters.push("m.created_at >= ?");
		args.push(new Date(sinceMs).toISOString());
	}
	if (options.unreadOnly === true) {
		filters.push("r.acknowledged_at IS NULL");
	}

	return {
		join: agentId
			? "LEFT JOIN cross_agent_message_receipts r ON r.message_id = m.id AND r.agent_id = ?"
			: "LEFT JOIN cross_agent_message_receipts r ON 1 = 0",
		where: filters.join(" AND "),
		args: agentId ? [agentId, ...args] : args,
		agentId,
	};
}

function countRows(db: ReadDb, query: MessageQuery): number {
	const row = db
		.prepare(`SELECT COUNT(*) AS total FROM cross_agent_messages m ${query.join} WHERE ${query.where}`)
		.get(...query.args) as { total?: number } | null | undefined;
	return typeof row?.total === "number" ? row.total : 0;
}

function unreadCount(db: ReadDb, options: ListAgentMessageOptions, now: string): number {
	const query = buildMessageQuery({ ...options, includeSent: false, unreadOnly: true }, now);
	return query ? countRows(db, query) : 0;
}

export function createAgentMessage(input: CreateAgentMessageInput): AgentMessage {
	prunePresence();
	const content = normalizeText(input.content);
	if (!content) throw new Error("content is required");
	if (content.length > MAX_MESSAGE_CONTENT_CHARS) {
		throw new Error(`content must be ${MAX_MESSAGE_CONTENT_CHARS} characters or fewer`);
	}

	const toAgentId = normalizeText(input.toAgentId);
	const toSessionKey = normalizeText(input.toSessionKey);
	const toSessionAgentId = toSessionKey ? (toAgentId ?? agentForSession(toSessionKey)) : undefined;
	const broadcast = input.broadcast === true;
	const deliveryPath = input.deliveryPath ?? "local";
	if (deliveryPath === "local" && !broadcast && !toAgentId && !toSessionKey) {
		throw new Error("target required for local delivery (toAgentId, toSessionKey, or broadcast=true)");
	}
	if (deliveryPath === "local" && toSessionKey && !toSessionAgentId) {
		throw new Error("target session is not active; use toAgentId for durable delivery");
	}

	const nowMs = Date.now();
	const now = new Date(nowMs).toISOString();
	const expiresAt = new Date(nowMs + AGENT_MESSAGE_RETENTION_MS).toISOString();
	const row: CrossAgentMessageRow = {
		id: randomUUID(),
		created_at: now,
		expires_at: expiresAt,
		from_agent_id: normalizeText(input.fromAgentId) ?? "default",
		from_session_key: normalizeText(input.fromSessionKey) ?? null,
		to_agent_id: toAgentId ?? null,
		to_session_key: toSessionKey ?? null,
		to_session_agent_id: toSessionAgentId ?? null,
		content,
		message_type: input.type ?? "info",
		broadcast: broadcast ? 1 : 0,
		delivery_path: deliveryPath,
		delivery_status: input.deliveryStatus ?? "delivered",
		delivery_state: deliveryPath === "acp" ? "pending" : "delivered",
		delivery_attempt_id: randomUUID(),
		delivery_attempts: 0,
		delivery_lease_token: null,
		delivery_lease_expires_at: null,
		delivery_attempt_started_at: null,
		delivery_updated_at: now,
		delivery_error: normalizeText(input.deliveryError) ?? null,
		delivery_receipt_json: serializeDeliveryReceipt(input.deliveryReceipt),
		acp_base_url: normalizeText(input.acpBaseUrl) ?? null,
		acp_target_agent_name: normalizeText(input.acpTargetAgentName) ?? null,
		acp_timeout_ms:
			typeof input.acpTimeoutMs === "number" && Number.isFinite(input.acpTimeoutMs)
				? Math.round(input.acpTimeoutMs)
				: null,
		acp_metadata_json: serializeDeliveryReceipt(input.acpMetadata),
		acknowledged_at: null,
	};

	getDbAccessor().withWriteTx((db) => {
		pruneExpiredMessages(db, now);
		const countRow = db.prepare("SELECT COUNT(*) AS count FROM cross_agent_messages").get() as
			| { count: number }
			| null
			| undefined;
		if ((countRow?.count ?? 0) >= MAX_DURABLE_MESSAGES) throw new AgentMessageCapacityError();
		db.prepare(
			`INSERT INTO cross_agent_messages (
				id, from_agent_id, from_session_key, to_agent_id, to_session_key,
				to_session_agent_id, broadcast, message_type, content, delivery_path,
				delivery_status, delivery_state, delivery_attempt_id, delivery_attempts,
				delivery_lease_token, delivery_lease_expires_at, delivery_attempt_started_at,
				delivery_updated_at, delivery_error, delivery_receipt_json, acp_base_url,
				acp_target_agent_name, acp_timeout_ms, acp_metadata_json, created_at, expires_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			row.id,
			row.from_agent_id,
			row.from_session_key,
			row.to_agent_id,
			row.to_session_key,
			row.to_session_agent_id,
			row.broadcast,
			row.message_type,
			row.content,
			row.delivery_path,
			row.delivery_status,
			row.delivery_state,
			row.delivery_attempt_id,
			row.delivery_attempts,
			row.delivery_lease_token,
			row.delivery_lease_expires_at,
			row.delivery_attempt_started_at,
			row.delivery_updated_at,
			row.delivery_error,
			row.delivery_receipt_json,
			row.acp_base_url,
			row.acp_target_agent_name,
			row.acp_timeout_ms,
			row.acp_metadata_json,
			row.created_at,
			row.expires_at,
		);
	});

	const out = rowToAgentMessage(row);
	emit({ type: "message", message: out, timestamp: now });
	return out;
}

export class AgentMessageDeliveryLeaseError extends Error {
	constructor(messageId: string) {
		super(`ACP delivery lease was lost for message ${messageId}`);
		this.name = "AgentMessageDeliveryLeaseError";
	}
}

export interface AcpDeliveryAttempt {
	readonly message: AgentMessage;
	readonly leaseToken: string;
	readonly idempotencyKey: string;
	readonly request: {
		readonly baseUrl: string;
		readonly targetAgentName: string;
		readonly content: string;
		readonly fromAgentId: string;
		readonly fromSessionKey?: string;
		readonly metadata?: Readonly<Record<string, unknown>>;
		readonly timeoutMs?: number;
	};
}

function readMessageRow(db: ReadDb | WriteDb, messageId: string): CrossAgentMessageRow | null {
	return (
		(db.prepare("SELECT m.*, NULL AS acknowledged_at FROM cross_agent_messages m WHERE m.id = ?").get(messageId) as
			| CrossAgentMessageRow
			| null
			| undefined) ?? null
	);
}

function buildAcpAttempt(row: CrossAgentMessageRow): AcpDeliveryAttempt {
	const baseUrl = normalizeText(row.acp_base_url ?? undefined);
	const targetAgentName = normalizeText(row.acp_target_agent_name ?? undefined);
	const attemptId = normalizeText(row.delivery_attempt_id ?? undefined);
	const leaseToken = normalizeText(row.delivery_lease_token ?? undefined);
	if (!baseUrl || !targetAgentName || !attemptId || !leaseToken) {
		throw new Error("ACP delivery attempt is missing durable target or lease state");
	}
	return {
		message: rowToAgentMessage(row),
		leaseToken,
		idempotencyKey: `signet-acp-${attemptId}`,
		request: {
			baseUrl,
			targetAgentName,
			content: row.content,
			fromAgentId: row.from_agent_id,
			fromSessionKey: row.from_session_key ?? undefined,
			metadata: parseDeliveryReceipt(row.acp_metadata_json),
			timeoutMs: row.acp_timeout_ms ?? undefined,
		},
	};
}

export function claimAcpMessageDelivery(input: {
	readonly messageId: string;
	readonly agentId?: string;
	readonly retryIndeterminate?: boolean;
	readonly nowMs?: number;
}): AcpDeliveryAttempt {
	const messageId = normalizeText(input.messageId);
	if (!messageId) throw new Error("messageId is required");
	const agentId = normalizeText(input.agentId);
	const nowMs = input.nowMs ?? Date.now();
	const now = new Date(nowMs).toISOString();
	const leaseExpiresAt = new Date(nowMs + ACP_RELAY_LEASE_MS).toISOString();
	const leaseToken = randomUUID();
	const allowedState = input.retryIndeterminate ? "indeterminate" : "pending";
	let attempt: AcpDeliveryAttempt | null = null;

	getDbAccessor().withWriteTx((db) => {
		const result = db
			.prepare(
				`UPDATE cross_agent_messages
				 SET delivery_state = 'in_flight', delivery_status = 'queued',
				     delivery_attempts = delivery_attempts + 1,
				     delivery_lease_token = ?, delivery_lease_expires_at = ?,
				     delivery_attempt_started_at = ?, delivery_updated_at = ?
				 WHERE id = ? AND delivery_path = 'acp'
				   AND delivery_state = ? AND delivery_attempts < ?
				   AND (delivery_lease_expires_at IS NULL OR delivery_lease_expires_at <= ?)`,
			)
			.run(leaseToken, leaseExpiresAt, now, now, messageId, allowedState, ACP_MAX_RETRY_ATTEMPTS, now);
		if (result.changes !== 1) {
			const row = readMessageRow(db, messageId);
			if (row == null) throw new AgentMessageNotFoundError(messageId);
			if (row.delivery_state === "in_flight") throw new Error("ACP delivery is already active");
			if (row.delivery_attempts >= ACP_MAX_RETRY_ATTEMPTS) throw new Error("ACP retry limit reached");
			throw new Error(`ACP delivery is not ${allowedState}`);
		}
		const row = readMessageRow(db, messageId);
		if (row == null) throw new AgentMessageNotFoundError(messageId);
		if (agentId && row.from_agent_id !== agentId) throw new AgentMessageNotFoundError(messageId);
		attempt = buildAcpAttempt(row);
	});
	if (attempt == null) throw new AgentMessageNotFoundError(messageId);
	return attempt;
}

export function completeAcpMessageDelivery(
	messageId: string,
	leaseToken: string,
	input: {
		readonly status: "delivered" | "failed" | "indeterminate";
		readonly error?: string;
		readonly receipt?: Record<string, unknown>;
	},
): AgentMessage {
	const normalizedId = normalizeText(messageId);
	const normalizedToken = normalizeText(leaseToken);
	if (!normalizedId) throw new Error("messageId is required");
	if (!normalizedToken) throw new Error("leaseToken is required");
	const now = new Date().toISOString();
	let updated: AgentMessage | null = null;
	getDbAccessor().withWriteTx((db) => {
		const result = db
			.prepare(
				`UPDATE cross_agent_messages
				 SET delivery_state = ?, delivery_status = ?, delivery_error = ?,
				     delivery_receipt_json = ?, delivery_lease_token = NULL,
				     delivery_lease_expires_at = NULL, delivery_updated_at = ?
				 WHERE id = ? AND delivery_state = 'in_flight' AND delivery_lease_token = ?`,
			)
			.run(
				input.status,
				input.status === "delivered" ? "delivered" : input.status === "failed" ? "failed" : "queued",
				normalizeText(input.error) ?? null,
				serializeDeliveryReceipt(input.receipt),
				now,
				normalizedId,
				normalizedToken,
			);
		if (result.changes !== 1) throw new AgentMessageDeliveryLeaseError(normalizedId);
		const row = readMessageRow(db, normalizedId);
		if (row == null) throw new AgentMessageNotFoundError(normalizedId);
		updated = rowToAgentMessage(row);
	});
	if (updated == null) throw new AgentMessageNotFoundError(normalizedId);
	emit({ type: "message", message: updated, timestamp: now });
	return updated;
}

export function updateAgentMessageDelivery(
	messageId: string,
	input: {
		readonly status: AgentMessageDeliveryStatus;
		readonly error?: string;
		readonly receipt?: Record<string, unknown>;
	},
): AgentMessage {
	const normalizedId = normalizeText(messageId);
	if (!normalizedId) throw new Error("messageId is required");
	let updated: AgentMessage | null = null;
	const state: AgentMessageDeliveryState =
		input.status === "delivered" ? "delivered" : input.status === "failed" ? "failed" : "pending";
	const now = new Date().toISOString();
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`UPDATE cross_agent_messages
			 SET delivery_status = ?, delivery_state = ?, delivery_error = ?,
			     delivery_receipt_json = ?, delivery_lease_token = NULL,
			     delivery_lease_expires_at = NULL, delivery_updated_at = ?
			 WHERE id = ?`,
		).run(
			input.status,
			state,
			normalizeText(input.error) ?? null,
			serializeDeliveryReceipt(input.receipt),
			now,
			normalizedId,
		);
		const row = readMessageRow(db, normalizedId);
		if (row == null) throw new AgentMessageNotFoundError(normalizedId);
		updated = rowToAgentMessage(row);
	});
	if (updated == null) throw new AgentMessageNotFoundError(normalizedId);
	emit({ type: "message", message: updated, timestamp: now });
	return updated;
}

export function reconcileAcpDeliveries(accessor: DbAccessor = getDbAccessor(), nowMs = Date.now()): number {
	const now = new Date(nowMs).toISOString();
	const pendingCutoff = new Date(nowMs - ACP_PENDING_GRACE_MS).toISOString();
	return accessor.withWriteTx((db) => {
		const result = db
			.prepare(
				`UPDATE cross_agent_messages
				 SET delivery_state = 'indeterminate', delivery_status = 'queued',
				     delivery_error = CASE
				       WHEN delivery_state = 'in_flight' THEN 'ACP relay interrupted; remote outcome is unknown'
				       ELSE 'ACP relay was queued but never started'
				     END,
				     delivery_lease_token = NULL, delivery_lease_expires_at = NULL,
				     delivery_updated_at = ?
				 WHERE delivery_path = 'acp'
				   AND ((delivery_state = 'in_flight' AND delivery_lease_expires_at <= ?)
				     OR (delivery_state = 'pending' AND delivery_updated_at <= ?))`,
			)
			.run(now, now, pendingCutoff);
		return result.changes;
	});
}

export function listAgentMessagePage(options: ListAgentMessageOptions = {}): AgentMessagePage {
	const now = new Date().toISOString();
	const limit = clampLimit(options.limit);
	const offset = clampOffset(options.offset);
	const query = buildMessageQuery(options, now);
	if (!query) {
		return { items: [], count: 0, total: 0, unreadCount: 0, limit, offset, hasMore: false };
	}

	return getDbAccessor().withReadDb((db) => {
		const total = countRows(db, query);
		const unread = options.unreadOnly === true ? total : unreadCount(db, options, now);
		const order = options.order === "asc" ? "ASC" : "DESC";
		const rows = db
			.prepare(
				`SELECT m.*, r.acknowledged_at
				 FROM cross_agent_messages m
				 ${query.join}
				 WHERE ${query.where}
				 ORDER BY m.created_at ${order}, m.rowid ${order}
				 LIMIT ? OFFSET ?`,
			)
			.all<CrossAgentMessageRow>(...query.args, limit, offset);
		const items = rows.map(rowToAgentMessage);
		return {
			items,
			count: items.length,
			total,
			unreadCount: unread,
			limit,
			offset,
			hasMore: offset + items.length < total,
		};
	});
}

export function listAgentMessages(options: ListAgentMessageOptions = {}): AgentMessage[] {
	return [...listAgentMessagePage(options).items];
}

export function acknowledgeAgentMessage(input: AcknowledgeAgentMessageInput): AcknowledgeAgentMessageResult {
	const messageId = normalizeText(input.messageId);
	if (!messageId) throw new Error("messageId is required");
	const agentId = normalizeText(input.agentId) ?? "default";
	const sessionKey = normalizeText(input.sessionKey);
	const now = new Date().toISOString();

	return getDbAccessor().withWriteTx((db) => {
		pruneExpiredMessages(db, now);
		const query = buildMessageQuery(
			{
				agentId,
				sessionKey,
				includeBroadcast: true,
				includeSent: false,
			},
			now,
		);
		if (!query) throw new AgentMessageNotFoundError(messageId);
		const row = db
			.prepare(
				`SELECT m.*, r.acknowledged_at
				 FROM cross_agent_messages m
				 ${query.join}
				 WHERE m.id = ? AND ${query.where}`,
			)
			.get(...query.args.slice(0, query.agentId ? 1 : 0), messageId, ...query.args.slice(query.agentId ? 1 : 0)) as
			| CrossAgentMessageRow
			| null
			| undefined;
		if (row == null) throw new AgentMessageNotFoundError(messageId);
		if (row.acknowledged_at) {
			return { messageId, agentId, acknowledgedAt: row.acknowledged_at, alreadyAcknowledged: true };
		}

		db.prepare(
			`INSERT INTO cross_agent_message_receipts (message_id, agent_id, acknowledged_at)
			 VALUES (?, ?, ?)
			 ON CONFLICT(message_id, agent_id) DO NOTHING`,
		).run(messageId, agentId, now);
		const receipt = db
			.prepare(
				`SELECT acknowledged_at FROM cross_agent_message_receipts
				 WHERE message_id = ? AND agent_id = ?`,
			)
			.get(messageId, agentId) as { acknowledged_at?: string } | null | undefined;
		const acknowledgedAt = receipt?.acknowledged_at;
		if (!acknowledgedAt) throw new Error("Failed to persist cross-agent acknowledgement");
		return { messageId, agentId, acknowledgedAt, alreadyAcknowledged: false };
	});
}

export function subscribeCrossAgentEvents(subscriber: (event: CrossAgentEvent) => void): () => void {
	subscribers.add(subscriber);
	return () => {
		subscribers.delete(subscriber);
	};
}

/** Remove all presence entries (for graceful shutdown). Returns count cleared. */
export function clearAllPresence(): number {
	const now = new Date().toISOString();
	let count = 0;
	for (const [, presence] of presenceByKey) {
		emit({
			type: "presence",
			action: "remove",
			presence: clonePresence(presence),
			activeCount: presenceByKey.size - count - 1,
			timestamp: now,
		});
		count++;
	}
	presenceByKey.clear();
	return count;
}

export function resetCrossAgentStateForTest(): void {
	presenceByKey.clear();
	subscribers.clear();
	if (!hasDbAccessor()) return;
	getDbAccessor().withWriteTx((db) => {
		db.prepare("DELETE FROM cross_agent_message_receipts").run();
		db.prepare("DELETE FROM cross_agent_messages").run();
	});
}
