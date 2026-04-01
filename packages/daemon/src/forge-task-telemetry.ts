import { getDbAccessor } from "./db-accessor";

export interface ForgeTaskTelemetryEnvelope {
	readonly sessionKey: string;
	readonly harness: string;
	readonly event: unknown;
	readonly receivedAt: string;
	readonly cursor?: number;
	readonly sequence?: number;
}

type ForgeTaskTelemetryListener = (event: ForgeTaskTelemetryEnvelope) => void;

const listenersBySession = new Map<string, Set<ForgeTaskTelemetryListener>>();
const eventsBySession = new Map<string, ForgeTaskTelemetryEnvelope[]>();
let tableEnsured = false;
const sessionSequenceByKey = new Map<string, number>();

const MAX_EVENTS_PER_SESSION = 1_000;
const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_MAX_ROWS_GLOBAL = 200_000;
const DEFAULT_MAX_ROWS_PER_SESSION = 10_000;

function parseEnvInt(name: string, fallback: number, min: number, max: number): number {
	const raw = process.env[name];
	const num = raw ? Number.parseInt(raw, 10) : NaN;
	if (!Number.isFinite(num)) return fallback;
	return Math.min(max, Math.max(min, num));
}

function pruneForgeTaskTelemetry(sessionKey: string, sequence: number): void {
	// Keep prune work cheap by running periodically.
	if (sequence % 100 !== 0) return;

	const retentionDays = parseEnvInt(
		"SIGNET_FORGE_TASK_TELEMETRY_RETENTION_DAYS",
		DEFAULT_RETENTION_DAYS,
		1,
		90,
	);
	const maxRowsGlobal = parseEnvInt(
		"SIGNET_FORGE_TASK_TELEMETRY_MAX_ROWS",
		DEFAULT_MAX_ROWS_GLOBAL,
		10_000,
		5_000_000,
	);
	const maxRowsPerSession = parseEnvInt(
		"SIGNET_FORGE_TASK_TELEMETRY_MAX_ROWS_PER_SESSION",
		DEFAULT_MAX_ROWS_PER_SESSION,
		1_000,
		500_000,
	);
	const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

	getDbAccessor().withWriteTx((db) => {
		// Time-based retention
		db.prepare("DELETE FROM forge_task_telemetry WHERE received_at < ?").run(cutoff);

		// Per-session cap
		db.prepare(
			`DELETE FROM forge_task_telemetry
			 WHERE session_key = ?
			   AND id NOT IN (
			       SELECT id FROM forge_task_telemetry
			       WHERE session_key = ?
			       ORDER BY id DESC
			       LIMIT ?
			   )`,
		).run(sessionKey, sessionKey, maxRowsPerSession);

		// Global cap
		db.prepare(
			`DELETE FROM forge_task_telemetry
			 WHERE id NOT IN (
			     SELECT id FROM forge_task_telemetry
			     ORDER BY id DESC
			     LIMIT ?
			 )`,
		).run(maxRowsGlobal);
	});
}

function ensureTable(): void {
	if (tableEnsured) return;
	getDbAccessor().withWriteTx((db) => {
		db.exec(`
			CREATE TABLE IF NOT EXISTS forge_task_telemetry (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_key TEXT NOT NULL,
				harness TEXT NOT NULL,
				received_at TEXT NOT NULL,
				sequence INTEGER NOT NULL DEFAULT 0,
				task_id TEXT,
				kind TEXT,
				phase TEXT,
				name TEXT,
				policy_denied INTEGER NOT NULL DEFAULT 0,
				policy_reason TEXT,
				event_json TEXT NOT NULL
			)
		`);
		db.exec(`
			CREATE INDEX IF NOT EXISTS idx_forge_task_telemetry_session_received
			ON forge_task_telemetry(session_key, received_at DESC)
		`);
		db.exec(`
			CREATE INDEX IF NOT EXISTS idx_forge_task_telemetry_session_id
			ON forge_task_telemetry(session_key, id DESC)
		`);
		try {
			db.exec("ALTER TABLE forge_task_telemetry ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0");
		} catch {
			// ignore when column already exists
		}
	});
	tableEnsured = true;
}

function toTaskFields(event: unknown): {
	taskId: string | null;
	kind: string | null;
	phase: string | null;
	name: string | null;
	policyDenied: number;
	policyReason: string | null;
} {
	if (!event || typeof event !== "object") {
		return {
			taskId: null,
			kind: null,
			phase: null,
			name: null,
			policyDenied: 0,
			policyReason: null,
		};
	}
	const obj = event as Record<string, unknown>;
	const meta = obj.meta && typeof obj.meta === "object" ? (obj.meta as Record<string, unknown>) : null;
	const policyDenied = meta?.policy_denied === true ? 1 : 0;
	const policyReason =
		typeof meta?.policy_reason === "string" ? (meta.policy_reason as string) : null;
	return {
		taskId: typeof obj.task_id === "string" ? obj.task_id : null,
		kind: typeof obj.kind === "string" ? obj.kind : null,
		phase: typeof obj.phase === "string" ? obj.phase : null,
		name: typeof obj.name === "string" ? obj.name : null,
		policyDenied,
		policyReason,
	};
}

export interface ForgeTaskTelemetryQuery {
	readonly sessionKey: string;
	readonly limit?: number;
	readonly kind?: string;
	readonly phase?: string;
	readonly name?: string;
	readonly policyDeniedOnly?: boolean;
	readonly since?: string;
	readonly afterCursor?: number;
}

export function ingestForgeTaskTelemetry(event: ForgeTaskTelemetryEnvelope): void {
	ensureTable();
	const extracted = toTaskFields(event.event);
	let sequence = sessionSequenceByKey.get(event.sessionKey);
	if (!sequence) {
		sequence = getDbAccessor().withReadDb((db) => {
			const row = db
				.prepare(
					`SELECT COALESCE(MAX(sequence), 0) AS seq
					 FROM forge_task_telemetry
					 WHERE session_key = ?`,
				)
				.get(event.sessionKey) as { seq?: number } | undefined;
			return Number.isFinite(row?.seq) ? Number(row?.seq) : 0;
		});
	}
	sequence += 1;
	sessionSequenceByKey.set(event.sessionKey, sequence);
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO forge_task_telemetry
			(session_key, harness, received_at, sequence, task_id, kind, phase, name, policy_denied, policy_reason, event_json)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			event.sessionKey,
			event.harness,
			event.receivedAt,
			sequence,
			extracted.taskId,
			extracted.kind,
			extracted.phase,
			extracted.name,
			extracted.policyDenied,
			extracted.policyReason,
			JSON.stringify(event),
		);
		const row = db
			.prepare("SELECT last_insert_rowid() AS id")
			.get() as { id?: number } | undefined;
		const cursor = Number.isFinite(row?.id) ? Number(row?.id) : undefined;
		emitForgeTaskTelemetry({
			...event,
			sequence,
			cursor,
		});
	});
	pruneForgeTaskTelemetry(event.sessionKey, sequence);
}

export function emitForgeTaskTelemetry(event: ForgeTaskTelemetryEnvelope): void {
	const existing = eventsBySession.get(event.sessionKey);
	if (existing) {
		existing.push(event);
		if (existing.length > MAX_EVENTS_PER_SESSION) {
			existing.splice(0, existing.length - MAX_EVENTS_PER_SESSION);
		}
	} else {
		eventsBySession.set(event.sessionKey, [event]);
	}

	const listeners = listenersBySession.get(event.sessionKey);
	if (!listeners || listeners.size === 0) return;
	for (const listener of listeners) {
		listener(event);
	}
}

export function listForgeTaskTelemetry(query: ForgeTaskTelemetryQuery): ReadonlyArray<ForgeTaskTelemetryEnvelope> {
	ensureTable();
	const limit = Math.max(1, Math.min(query.limit ?? 200, 2_000));
	const clauses = ["session_key = ?"];
	const params: unknown[] = [query.sessionKey];

	if (query.kind && query.kind.length > 0) {
		clauses.push("kind = ?");
		params.push(query.kind);
	}
	if (query.phase && query.phase.length > 0) {
		clauses.push("phase = ?");
		params.push(query.phase);
	}
	if (query.name && query.name.length > 0) {
		clauses.push("name = ?");
		params.push(query.name);
	}
	if (query.policyDeniedOnly) {
		clauses.push("policy_denied = 1");
	}
	if (query.since && query.since.length > 0) {
		clauses.push("received_at >= ?");
		params.push(query.since);
	}
	if (Number.isFinite(query.afterCursor)) {
		clauses.push("id > ?");
		params.push(Number(query.afterCursor));
	}

	const rows = getDbAccessor().withReadDb((db) =>
		db
			.prepare(
				`SELECT id, sequence, event_json
				 FROM forge_task_telemetry
				 WHERE ${clauses.join(" AND ")}
				 ORDER BY id DESC
				 LIMIT ?`,
			)
			.all(...params, limit) as Array<{ id: number; sequence: number; event_json: string }>,
	);

	const parsed = rows
		.map((row) => {
			try {
				const parsed = JSON.parse(row.event_json) as ForgeTaskTelemetryEnvelope;
				return {
					...parsed,
					cursor: row.id,
					sequence: row.sequence,
				} satisfies ForgeTaskTelemetryEnvelope;
			} catch {
				return null;
			}
		})
		.filter((evt): evt is ForgeTaskTelemetryEnvelope => evt !== null);

	parsed.reverse();
	return parsed;
}

export function subscribeForgeTaskTelemetry(
	sessionKey: string,
	listener: ForgeTaskTelemetryListener,
): () => void {
	const existing = listenersBySession.get(sessionKey);
	if (existing) {
		existing.add(listener);
	} else {
		listenersBySession.set(sessionKey, new Set([listener]));
	}

	return () => {
		const listeners = listenersBySession.get(sessionKey);
		if (!listeners) return;
		listeners.delete(listener);
		if (listeners.size === 0) {
			listenersBySession.delete(sessionKey);
		}
	};
}

export function getForgeTaskTelemetrySnapshot(
	sessionKey: string,
	limit = 200,
): ReadonlyArray<ForgeTaskTelemetryEnvelope> {
	return listForgeTaskTelemetry({ sessionKey, limit });
}

export function resetForgeTaskTelemetryForTests(): void {
	listenersBySession.clear();
	eventsBySession.clear();
	sessionSequenceByKey.clear();
	tableEnsured = false;
}
