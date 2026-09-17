import { resolveAgentId } from "./agent-id";
import { type WriteDb, getDbAccessor } from "./db-accessor";
import { logger } from "./logger";

export interface RecallDedupeItem {
	readonly id: string;
	readonly score?: number;
	readonly source?: string;
}

export interface RecallDedupeMeta {
	readonly enabled: boolean;
	readonly contextEpoch?: number;
	readonly suppressed: number;
	readonly repeatedReturned: number;
	readonly failedOpen?: boolean;
}

export interface ApplyRecallDedupeOptions<T extends RecallDedupeItem> {
	readonly sessionKey?: string | null;
	readonly agentId?: string | null;
	readonly includeRecalled?: boolean;
	readonly surface: string;
	readonly mode: string;
	readonly claim: boolean;
	readonly items: readonly T[];
	readonly markRepeated?: (item: T) => T;
}

export interface ClaimRecallItemsOptions<T extends RecallDedupeItem> {
	readonly sessionKey?: string | null;
	readonly agentId?: string | null;
	readonly surface: string;
	readonly mode: string;
	readonly items: readonly T[];
}

function normalizeSessionKey(sessionKey: string | null | undefined): string | null {
	const trimmed = sessionKey?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : null;
}

function normalizeAgentId(agentId: string | null | undefined, sessionKey: string): string {
	const trimmed = agentId?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : resolveAgentId({ sessionKey });
}

function hasRecallDedupeTables(db: WriteDb): boolean {
	const row = db
		.prepare(
			`SELECT COUNT(*) AS count
			 FROM sqlite_master
			 WHERE type = 'table'
			   AND name IN ('session_context_epochs', 'session_recall_events')`,
		)
		.get() as { count?: number } | undefined;
	return row?.count === 2;
}

function itemKind(id: string): string {
	const prefix = id.split(":", 1)[0];
	if (prefix === "source-chunk") return "source_chunk";
	if (prefix === "native-artifact") return "native_artifact";
	if (prefix === "transcript") return "transcript";
	if (prefix === "summary") return "summary";
	if (prefix === "constructed") return "constructed";
	return "memory";
}

function itemKey(item: RecallDedupeItem): string {
	return `${itemKind(item.id)}\0${item.id}`;
}

function disabledMeta(failedOpen = false): RecallDedupeMeta {
	return {
		enabled: false,
		suppressed: 0,
		repeatedReturned: 0,
		...(failedOpen ? { failedOpen: true } : {}),
	};
}

function currentEpoch(db: WriteDb, sessionKey: string, agentId: string): number {
	const row = db
		.prepare(
			`SELECT MAX(context_epoch) AS epoch
			 FROM session_context_epochs
			 WHERE session_key = ? AND agent_id = ?`,
		)
		.get(sessionKey, agentId) as { epoch?: number | null } | undefined;
	return typeof row?.epoch === "number" && Number.isFinite(row.epoch) ? row.epoch : 0;
}

function insertRecallEvent(
	db: WriteDb,
	opts: {
		readonly sessionKey: string;
		readonly agentId: string;
		readonly epoch: number;
		readonly item: RecallDedupeItem;
		readonly surface: string;
		readonly mode: string;
	},
): boolean {
	db.prepare(
		`INSERT OR IGNORE INTO session_recall_events (
			session_key, agent_id, context_epoch, item_kind, item_id,
			surface, mode, score, source, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		opts.sessionKey,
		opts.agentId,
		opts.epoch,
		itemKind(opts.item.id),
		opts.item.id,
		opts.surface,
		opts.mode,
		typeof opts.item.score === "number" && Number.isFinite(opts.item.score) ? opts.item.score : null,
		opts.item.source ?? null,
		new Date().toISOString(),
	);
	const changed = db.prepare("SELECT changes() AS count").get() as { count?: number } | undefined;
	return (changed?.count ?? 0) > 0;
}

function loadRecalledIds(
	db: WriteDb,
	sessionKey: string,
	agentId: string,
	epoch: number,
	items: readonly RecallDedupeItem[],
): Set<string> {
	if (items.length === 0) return new Set();
	const keys = new Set(items.map((item) => itemKey(item)));
	const placeholders = items.map(() => "(?, ?)").join(", ");
	const args = items.flatMap((item) => [itemKind(item.id), item.id]);
	const rows = db
		.prepare(
			`SELECT item_kind, item_id
			 FROM session_recall_events
			 WHERE session_key = ?
			   AND agent_id = ?
			   AND context_epoch = ?
			   AND (item_kind, item_id) IN (${placeholders})`,
		)
		.all(sessionKey, agentId, epoch, ...args) as Array<{ item_kind: string; item_id: string }>;
	return new Set(rows.map((row) => `${row.item_kind}\0${row.item_id}`).filter((key) => keys.has(key)));
}

function applyRecallDedupeInTx<T extends RecallDedupeItem>(
	db: WriteDb,
	opts: ApplyRecallDedupeOptions<T>,
	sessionKey: string,
	agentId: string,
): { readonly items: T[]; readonly meta: RecallDedupeMeta } {
	if (!hasRecallDedupeTables(db)) {
		return { items: [...opts.items], meta: disabledMeta(true) };
	}

	const epoch = currentEpoch(db, sessionKey, agentId);
	if (opts.includeRecalled === true) {
		const recalled = loadRecalledIds(db, sessionKey, agentId, epoch, opts.items);
		const seen = new Set<string>();
		const items: T[] = [];
		let repeatedReturned = 0;
		for (const item of opts.items) {
			const key = itemKey(item);
			if (seen.has(key)) continue;
			seen.add(key);
			if (recalled.has(key)) {
				repeatedReturned++;
				items.push(opts.markRepeated ? opts.markRepeated(item) : item);
				continue;
			}
			insertRecallEvent(db, { sessionKey, agentId, epoch, item, surface: opts.surface, mode: opts.mode });
			items.push(item);
		}
		return {
			items,
			meta: { enabled: true, contextEpoch: epoch, suppressed: 0, repeatedReturned },
		};
	}

	let suppressed = 0;
	const items: T[] = [];
	if (opts.claim) {
		for (const item of opts.items) {
			const claimed = insertRecallEvent(db, {
				sessionKey,
				agentId,
				epoch,
				item,
				surface: opts.surface,
				mode: opts.mode,
			});
			if (claimed) items.push(item);
			else suppressed++;
		}
	} else {
		const recalled = loadRecalledIds(db, sessionKey, agentId, epoch, opts.items);
		const seen = new Set<string>();
		for (const item of opts.items) {
			const key = itemKey(item);
			if (seen.has(key)) {
				suppressed++;
				continue;
			}
			seen.add(key);
			if (recalled.has(key)) suppressed++;
			else items.push(item);
		}
	}

	return {
		items,
		meta: { enabled: true, contextEpoch: epoch, suppressed, repeatedReturned: 0 },
	};
}

export function applyRecallDedupe<T extends RecallDedupeItem>(
	opts: ApplyRecallDedupeOptions<T>,
): { readonly items: T[]; readonly meta: RecallDedupeMeta } {
	const sessionKey = normalizeSessionKey(opts.sessionKey);
	if (!sessionKey) {
		return { items: [...opts.items], meta: disabledMeta() };
	}

	const agentId = normalizeAgentId(opts.agentId, sessionKey);
	try {
		// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
		return getDbAccessor().withWriteTx(
			(db: import("./db-accessor").WriteDb) => applyRecallDedupeInTx(db, opts, sessionKey, agentId),
			"session-recall-dedupe.ts:232",
		);
	} catch (error) {
		logger.warn("memory", "Recall dedupe failed open", {
			error: error instanceof Error ? error.message : String(error),
			sessionKey,
			agentId,
		});
		return { items: [...opts.items], meta: disabledMeta(true) };
	}
}

export async function applyRecallDedupeAsync<T extends RecallDedupeItem>(
	opts: ApplyRecallDedupeOptions<T>,
): Promise<{ readonly items: T[]; readonly meta: RecallDedupeMeta }> {
	const sessionKey = normalizeSessionKey(opts.sessionKey);
	if (!sessionKey) {
		return { items: [...opts.items], meta: disabledMeta() };
	}

	const agentId = normalizeAgentId(opts.agentId, sessionKey);
	try {
		return await getDbAccessor().withWriteTxAsync((db) => applyRecallDedupeInTx(db, opts, sessionKey, agentId), {
			siteToken: "session-recall-dedupe.ts:255",
		});
	} catch (error) {
		logger.warn("memory", "Recall dedupe failed open", {
			error: error instanceof Error ? error.message : String(error),
			sessionKey,
			agentId,
		});
		return { items: [...opts.items], meta: disabledMeta(true) };
	}
}

export async function claimRecallItemsAsync<T extends RecallDedupeItem>(
	opts: ClaimRecallItemsOptions<T>,
): Promise<{ readonly items: T[]; readonly meta: RecallDedupeMeta }> {
	return applyRecallDedupeAsync({
		...opts,
		includeRecalled: false,
		claim: true,
	});
}

export async function advanceRecallContextEpochAsync(input: {
	readonly sessionKey?: string | null;
	readonly agentId?: string | null;
	readonly reason: string;
	readonly sourceRef?: string | null;
}): Promise<{ readonly advanced: boolean; readonly contextEpoch?: number; readonly failedOpen?: boolean }> {
	const sessionKey = normalizeSessionKey(input.sessionKey);
	if (!sessionKey) return { advanced: false };
	const agentId = normalizeAgentId(input.agentId, sessionKey);
	try {
		return await getDbAccessor().withWriteTxAsync(
			(db) => {
				if (!hasRecallDedupeTables(db)) return { advanced: false, failedOpen: true };
				const next = currentEpoch(db, sessionKey, agentId) + 1;
				db.prepare(
					`INSERT OR IGNORE INTO session_context_epochs (
					session_key, agent_id, context_epoch, reason, source_ref, created_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				).run(sessionKey, agentId, next, input.reason, input.sourceRef ?? null, new Date().toISOString());
				const changed = db.prepare("SELECT changes() AS count").get() as { count?: number } | undefined;
				return { advanced: (changed?.count ?? 0) > 0, contextEpoch: next };
			},
			{ siteToken: "session-recall-dedupe.ts:324" },
		);
	} catch (error) {
		logger.warn("memory", "Failed to advance recall context epoch", {
			error: error instanceof Error ? error.message : String(error),
			sessionKey,
			agentId,
		});
		return { advanced: false, failedOpen: true };
	}
}

export function claimRecallItems<T extends RecallDedupeItem>(
	opts: ClaimRecallItemsOptions<T>,
): {
	readonly items: T[];
	readonly meta: RecallDedupeMeta;
} {
	return applyRecallDedupe({
		...opts,
		includeRecalled: false,
		claim: true,
	});
}

export function advanceRecallContextEpoch(input: {
	readonly sessionKey?: string | null;
	readonly agentId?: string | null;
	readonly reason: string;
	readonly sourceRef?: string | null;
}): { readonly advanced: boolean; readonly contextEpoch?: number; readonly failedOpen?: boolean } {
	const sessionKey = normalizeSessionKey(input.sessionKey);
	if (!sessionKey) return { advanced: false };
	const agentId = normalizeAgentId(input.agentId, sessionKey);
	try {
		// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
		return getDbAccessor().withWriteTx((db: import("./db-accessor").WriteDb) => {
			if (!hasRecallDedupeTables(db)) return { advanced: false, failedOpen: true };
			const next = currentEpoch(db, sessionKey, agentId) + 1;
			db.prepare(
				`INSERT OR IGNORE INTO session_context_epochs (
					session_key, agent_id, context_epoch, reason, source_ref, created_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
			).run(sessionKey, agentId, next, input.reason, input.sourceRef ?? null, new Date().toISOString());
			const changed = db.prepare("SELECT changes() AS count").get() as { count?: number } | undefined;
			return { advanced: (changed?.count ?? 0) > 0, contextEpoch: next };
		}, "session-recall-dedupe.ts:372");
	} catch (error) {
		logger.warn("memory", "Failed to advance recall context epoch", {
			error: error instanceof Error ? error.message : String(error),
			sessionKey,
			agentId,
		});
		return { advanced: false, failedOpen: true };
	}
}
