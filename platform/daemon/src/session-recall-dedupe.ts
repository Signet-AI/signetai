import { compartmentFor, compartmentForWrite, type ReadScope, readScopeSql, requireReadScope } from "@signet/core";
import { resolveAgentId } from "./agent-id";
import { type WriteDb, getDbAccessor } from "./db-accessor";
import { logger } from "./logger";

export interface RecallArtifactKey {
	readonly agentId: string;
	readonly sourcePath: string;
}

export interface RecallReadProvenance {
	readonly compartmentIds?: readonly number[];
	readonly attributeIds?: readonly string[];
	readonly resultIds?: readonly string[];
	readonly artifactKeys?: readonly RecallArtifactKey[];
}

export interface RecallDedupeItem {
	readonly readProvenance?: RecallReadProvenance;
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
	readonly select?: (fresh: readonly T[]) => readonly T[];
	readonly signal?: AbortSignal;
	readonly deadlineAt?: number;
	readonly readScope: ReadScope;
}

export interface ClaimRecallItemsOptions<T extends RecallDedupeItem> {
	readonly sessionKey?: string | null;
	readonly agentId?: string | null;
	readonly surface: string;
	readonly mode: string;
	readonly items: readonly T[];
	readonly select?: (fresh: readonly T[]) => readonly T[];
	readonly signal?: AbortSignal;
	readonly deadlineAt?: number;
	readonly readScope: ReadScope;
}

export type TelemetryCitationKind = "memory" | "transcript" | "artifact" | "attribute";

export interface TelemetryCitation {
	readonly kind: TelemetryCitationKind;
	readonly id: string;
}

export interface TelemetryEvidence {
	readonly base: readonly string[];
	readonly labels: ReadonlyMap<string, readonly string[]>;
	readonly citations: ReadonlyMap<string, readonly TelemetryCitation[]>;
}

function stripped(ids: readonly string[], prefix: string): string[] {
	return ids.flatMap((id) => (id.startsWith(prefix) && id.length > prefix.length ? [id.slice(prefix.length)] : []));
}

function citationKind(value: unknown): TelemetryCitationKind | null {
	return value === "memory" || value === "transcript" || value === "artifact" || value === "attribute" ? value : null;
}

export function telemetryEvidenceInTx(
	db: WriteDb,
	input: {
		readonly agentId: string;
		readonly sessionKey: string | null;
		readonly resultIds: readonly string[];
		readonly items?: readonly RecallDedupeItem[];
	},
): TelemetryEvidence {
	const ids = [
		...new Set([...input.resultIds, ...(input.items ?? []).flatMap((item) => item.readProvenance?.resultIds ?? [])]),
	];
	const boundTranscripts = new Set(
		(input.items ?? [])
			.filter(
				(item) =>
					item.id.startsWith("transcript:") &&
					((item.readProvenance?.resultIds?.length ?? 0) > 0 || (item.readProvenance?.artifactKeys?.length ?? 0) > 0),
			)
			.map((item) => item.id),
	);
	const provenanceItems = JSON.stringify(
		(input.items ?? []).map((item) => ({ id: item.id, readProvenance: item.readProvenance ?? {} })),
	);
	const transcripts = stripped(
		ids.filter((id) => !boundTranscripts.has(id)),
		"transcript:",
	);
	const rowids = stripped(ids, "native-artifact:").flatMap((id) => {
		const value = Number(id);
		return /^\d+$/.test(id) && Number.isSafeInteger(value) ? [value] : [];
	});
	const base = compartmentForWrite(db, {
		agentId: input.agentId,
		sessionKey: input.sessionKey?.split("\0", 1)[0] ?? null,
	});
	const evidenceQuery = db.prepare(
		`SELECT h.result_id, h.kind, h.evidence_id, h.agent_id, h.memory_id, cm.classification_id
			 FROM (
				SELECT m.id AS result_id, 'memory' AS kind, m.id AS evidence_id, m.agent_id, m.compartment_id, m.id AS memory_id
				FROM memories m WHERE m.id IN (SELECT value FROM json_each(?))
				UNION ALL SELECT 'ontology-claim:' || a.id, 'attribute', a.id, a.agent_id, a.compartment_id, a.memory_id
				FROM entity_attributes a WHERE a.id IN (SELECT value FROM json_each(?))
				UNION ALL SELECT 'transcript:' || t.session_key, 'transcript', t.session_key, t.agent_id, t.compartment_id, NULL
				FROM session_transcripts t WHERE t.agent_id = ? AND t.session_key IN (SELECT value FROM json_each(?))
				UNION ALL SELECT 'transcript:' || r.session_id, 'artifact', r.source_path, r.agent_id, r.compartment_id, NULL
				FROM memory_artifacts r WHERE r.agent_id = ? AND r.source_kind = 'transcript' AND r.session_id IN (SELECT value FROM json_each(?))
				UNION ALL SELECT 'native-artifact:' || r.rowid, 'artifact', r.source_path, r.agent_id, r.compartment_id, NULL
				FROM memory_artifacts r WHERE r.rowid IN (SELECT value FROM json_each(?))
				UNION ALL SELECT 'source-chunk:' || e.id, NULL, e.source_id, e.agent_id, e.compartment_id, NULL
				FROM embeddings e WHERE e.id IN (SELECT value FROM json_each(?))
				UNION ALL SELECT 'source-chunk:' || e.id, 'artifact', r.source_path, r.agent_id, r.compartment_id, NULL
				FROM embeddings e JOIN memory_artifacts r ON r.agent_id = e.agent_id AND r.source_path = e.source_id
				WHERE e.id IN (SELECT value FROM json_each(?))
				UNION ALL SELECT 'constructed:' || n.name, NULL, NULL, n.agent_id, n.compartment_id, NULL
				FROM entities n WHERE n.agent_id = ? AND n.name IN (SELECT value FROM json_each(?))
 				UNION ALL SELECT json_extract(i.value,'$.id'), NULL, NULL, NULL, c.value, NULL
				FROM json_each(?) i CROSS JOIN json_each(i.value,'$.readProvenance.compartmentIds') c
				UNION ALL SELECT json_extract(i.value,'$.id'), 'attribute', a.id, a.agent_id, a.compartment_id, a.memory_id
				FROM json_each(?) i CROSS JOIN json_each(i.value,'$.readProvenance.attributeIds') refs JOIN entity_attributes a ON a.id=refs.value
				UNION ALL SELECT json_extract(i.value,'$.id'), 'artifact', r.source_path, r.agent_id, r.compartment_id, NULL
				FROM json_each(?) i CROSS JOIN json_each(i.value,'$.readProvenance.artifactKeys') k
				JOIN memory_artifacts r ON r.agent_id = json_extract(k.value,'$.agentId') AND r.source_path = json_extract(k.value,'$.sourcePath')
				UNION ALL SELECT NULL, NULL, NULL, NULL, ?, NULL
			 ) h
			 LEFT JOIN compartment_members cm ON cm.compartment_id = h.compartment_id`,
	);
	const rows = evidenceQuery.all(
		JSON.stringify(ids),
		JSON.stringify(stripped(ids, "ontology-claim:")),
		input.agentId,
		JSON.stringify(transcripts),
		input.agentId,
		JSON.stringify(transcripts),
		JSON.stringify(rowids),
		JSON.stringify(stripped(ids, "source-chunk:")),
		JSON.stringify(stripped(ids, "source-chunk:")),
		input.agentId,
		JSON.stringify(stripped(ids, "constructed:")),
		provenanceItems,
		provenanceItems,
		provenanceItems,
		base,
	);
	const inheritedItems: RecallDedupeItem[] = [];
	const baseLabels = new Set<string>();
	const labels = new Map<string, Set<string>>();
	const citations = new Map<string, Map<string, TelemetryCitation>>();
	for (const row of rows) {
		if (typeof row !== "object" || row === null) continue;
		const resultId = "result_id" in row && typeof row.result_id === "string" ? row.result_id : null;
		const label =
			"classification_id" in row && typeof row.classification_id === "string" ? row.classification_id : null;
		if (resultId === null) {
			if (label !== null) baseLabels.add(label);
			continue;
		}
		const own = labels.get(resultId) ?? new Set<string>();
		if (label !== null) own.add(label);
		const kind = "kind" in row ? citationKind(row.kind) : null;
		const evidenceId = "evidence_id" in row && typeof row.evidence_id === "string" ? row.evidence_id : null;
		if ("agent_id" in row && typeof row.agent_id === "string") {
			const memoryId = "memory_id" in row && typeof row.memory_id === "string" ? row.memory_id : null;
			const inherited = compartmentForWrite(db, {
				agentId: row.agent_id,
				memoryId,
				sessionKey: kind === "transcript" ? evidenceId : null,
				sourceId:
					kind === "artifact" || kind === "transcript" || resultId.startsWith("source-chunk:") ? evidenceId : null,
			});
			if (inherited !== null) inheritedItems.push({ id: resultId, readProvenance: { compartmentIds: [inherited] } });
		}
		labels.set(resultId, own);
		const sameAgent = "agent_id" in row && row.agent_id === input.agentId;
		if (kind === null || evidenceId === null || !sameAgent) continue;
		const cited = citations.get(resultId) ?? new Map<string, TelemetryCitation>();
		cited.set(`${kind}\0${evidenceId}`, { kind, id: evidenceId });
		citations.set(resultId, cited);
	}
	for (const row of evidenceQuery.all(
		"[]",
		"[]",
		input.agentId,
		"[]",
		input.agentId,
		"[]",
		"[]",
		"[]",
		"[]",
		input.agentId,
		"[]",
		JSON.stringify(inheritedItems),
		"[]",
		"[]",
		null,
	)) {
		if (
			typeof row !== "object" ||
			row === null ||
			!("result_id" in row) ||
			typeof row.result_id !== "string" ||
			!("classification_id" in row) ||
			typeof row.classification_id !== "string"
		)
			continue;
		labels.get(row.result_id)?.add(row.classification_id);
	}
	for (const item of input.items ?? []) {
		const copiedLabels = labels.get(item.id) ?? new Set<string>();
		const copiedCitations = citations.get(item.id) ?? new Map<string, TelemetryCitation>();
		for (const sourceId of item.readProvenance?.resultIds ?? []) {
			for (const label of labels.get(sourceId) ?? []) copiedLabels.add(label);
			for (const [key, citation] of citations.get(sourceId) ?? []) copiedCitations.set(key, citation);
		}
		labels.set(item.id, copiedLabels);
		citations.set(item.id, copiedCitations);
	}
	return {
		base: [...baseLabels],
		labels: new Map([...labels].map(([id, values]) => [id, [...values]])),
		citations: new Map([...citations].map(([id, values]) => [id, [...values.values()]])),
	};
}

export function telemetryCompartment(
	db: WriteDb,
	evidence: TelemetryEvidence,
	resultIds: readonly string[],
): number | null {
	return compartmentFor(db, [...evidence.base, ...resultIds.flatMap((id) => evidence.labels.get(id) ?? [])]);
}

export function citeTelemetryInTx(
	db: WriteDb,
	input: { readonly derivedId: string; readonly agentId: string; readonly citations: readonly TelemetryCitation[] },
): void {
	const insert = db.prepare(
		"INSERT OR IGNORE INTO evidence_citations(derived_kind, derived_id, agent_id, evidence_kind, evidence_id) VALUES ('telemetry', ?, ?, ?, ?)",
	);
	for (const citation of input.citations) insert.run(input.derivedId, input.agentId, citation.kind, citation.id);
}

export function pruneTelemetryCitationsInTx(db: WriteDb, cutoff: string): void {
	db.prepare(
		`DELETE FROM evidence_citations
		 WHERE derived_kind = 'telemetry'
		   AND derived_id IN (SELECT id FROM memory_search_telemetry WHERE created_at < ?)`,
	).run(cutoff);
}

function normalizeSessionKey(sessionKey: string | null | undefined): string | null {
	const trimmed = sessionKey?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : null;
}

function normalizeAgentId(agentId: string | null | undefined, sessionKey: string): string {
	const trimmed = agentId?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : resolveAgentId({ sessionKey });
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
	return recallItemKey(item.id);
}

export function recallItemKey(id: string): string {
	return `${itemKind(id)}\0${id}`;
}

function disabledMeta(failedOpen = false): RecallDedupeMeta {
	return {
		enabled: false,
		suppressed: 0,
		repeatedReturned: 0,
		...(failedOpen ? { failedOpen: true } : {}),
	};
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
		readonly compartment: number | null;
		readonly citations: readonly TelemetryCitation[];
	},
): void {
	const row = db
		.prepare(
			`INSERT INTO session_recall_events (
				session_key, agent_id, context_epoch, item_kind, item_id,
				surface, mode, score, source, created_at, compartment_id
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(session_key, agent_id, context_epoch, item_kind, item_id) DO UPDATE SET
				surface = excluded.surface, mode = excluded.mode, score = excluded.score, source = excluded.source,
				created_at = excluded.created_at, compartment_id = excluded.compartment_id
			RETURNING json_array(session_key, context_epoch, item_kind, item_id) AS citation_key`,
		)
		.get(
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
			opts.compartment,
		);
	if (typeof row?.citation_key !== "string") throw new Error("Recall event citation key missing");
	citeTelemetryInTx(db, { derivedId: row.citation_key, agentId: opts.agentId, citations: opts.citations });
}

function recordRecallEvents(
	db: WriteDb,
	opts: {
		readonly sessionKey: string;
		readonly agentId: string;
		readonly epoch: number;
		readonly items: readonly RecallDedupeItem[];
		readonly surface: string;
		readonly mode: string;
	},
): void {
	if (opts.items.length === 0) return;
	const evidence = telemetryEvidenceInTx(db, {
		agentId: opts.agentId,
		sessionKey: opts.sessionKey,
		resultIds: opts.items.map((item) => item.id),
		items: opts.items,
	});
	for (const item of opts.items)
		insertRecallEvent(db, {
			...opts,
			item,
			compartment: telemetryCompartment(db, evidence, [item.id]),
			citations: evidence.citations.get(item.id) ?? [],
		});
}

function ledgerScope(scope: ReadScope, agentId: string): { readonly sql: string; readonly args: unknown[] } {
	return readScopeSql(
		"e",
		{ ...scope, reach: { kind: "own", agentId }, projects: scope.projects === null ? null : [] },
		{ visibility: null, memory: "item_id", session: "session_key", source: null },
	);
}

function loadLedger(
	db: WriteDb,
	sessionKey: string,
	agentId: string,
	items: readonly RecallDedupeItem[],
	scope: ReadScope,
): { readonly epoch: number; readonly recalled: Set<string> } {
	const keys = new Set(items.map((item) => itemKey(item)));
	const wanted = items.length > 0 ? `(e.item_kind, e.item_id) IN (${items.map(() => "(?, ?)").join(", ")})` : "0";
	const visible = ledgerScope(scope, agentId);
	const rows = db
		.prepare(
			`WITH current(epoch) AS (
				SELECT COALESCE(MAX(context_epoch), 0) FROM session_context_epochs WHERE session_key = ? AND agent_id = ?
			)
			SELECT current.epoch, e.item_kind, e.item_id
			FROM current
			LEFT JOIN session_recall_events e
			  ON e.session_key = ?
			 AND e.agent_id = ?
			 AND e.context_epoch = current.epoch
			 AND ${wanted}${visible.sql}`,
		)
		.all(
			sessionKey,
			agentId,
			sessionKey,
			agentId,
			...items.flatMap((item) => [itemKind(item.id), item.id]),
			...visible.args,
		);
	let epoch = 0;
	const recalled = new Set<string>();
	for (const row of rows) {
		if (typeof row !== "object" || row === null) continue;
		if ("epoch" in row && typeof row.epoch === "number" && Number.isFinite(row.epoch)) epoch = row.epoch;
		if (!("item_kind" in row) || !("item_id" in row) || row.item_kind === null || row.item_id === null) continue;
		const key = `${String(row.item_kind)}\0${String(row.item_id)}`;
		if (keys.has(key)) recalled.add(key);
	}
	return { epoch, recalled };
}

function uniqueFresh<T extends RecallDedupeItem>(
	items: readonly T[],
	recalled: ReadonlySet<string>,
): { readonly fresh: T[]; readonly suppressed: number } {
	const seen = new Set<string>();
	const fresh: T[] = [];
	let suppressed = 0;
	for (const item of items) {
		const key = itemKey(item);
		if (seen.has(key) || recalled.has(key)) suppressed++;
		else fresh.push(item);
		seen.add(key);
	}
	return { fresh, suppressed };
}

function applyRecallDedupeInTx<T extends RecallDedupeItem>(
	db: WriteDb,
	opts: ApplyRecallDedupeOptions<T>,
	sessionKey: string,
	agentId: string,
): { readonly items: T[]; readonly meta: RecallDedupeMeta } {
	const { epoch, recalled } = loadLedger(db, sessionKey, agentId, opts.items, opts.readScope);
	const record = (items: readonly T[]) =>
		recordRecallEvents(db, { sessionKey, agentId, epoch, items, surface: opts.surface, mode: opts.mode });
	if (opts.includeRecalled === true) {
		const seen = new Set<string>();
		const items: T[] = [];
		const fresh: T[] = [];
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
			fresh.push(item);
			items.push(item);
		}
		record(fresh);
		return {
			items,
			meta: { enabled: true, contextEpoch: epoch, suppressed: 0, repeatedReturned },
		};
	}

	const { fresh, suppressed } = uniqueFresh(opts.items, recalled);
	if (!opts.claim) {
		return { items: fresh, meta: { enabled: true, contextEpoch: epoch, suppressed, repeatedReturned: 0 } };
	}
	const items = opts.select ? uniqueFresh(opts.select(fresh), new Set()).fresh : fresh;
	record(items);
	return {
		items,
		meta: { enabled: true, contextEpoch: epoch, suppressed, repeatedReturned: 0 },
	};
}

export function applyRecallDedupe<T extends RecallDedupeItem>(
	opts: ApplyRecallDedupeOptions<T>,
): { readonly items: T[]; readonly meta: RecallDedupeMeta } {
	requireReadScope(opts.readScope);
	const sessionKey = normalizeSessionKey(opts.sessionKey);
	if (!sessionKey) {
		return { items: [...opts.items], meta: disabledMeta() };
	}

	const agentId = normalizeAgentId(opts.agentId, sessionKey);
	try {
		// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
		return getDbAccessor().withWriteTx(
			(db: import("./db-accessor").WriteDb) => applyRecallDedupeInTx(db, opts, sessionKey, agentId),
			"db:recall.ledger.claim.sync",
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
	requireReadScope(opts.readScope);
	const sessionKey = normalizeSessionKey(opts.sessionKey);
	if (!sessionKey) {
		return { items: [...opts.items], meta: disabledMeta() };
	}

	const agentId = normalizeAgentId(opts.agentId, sessionKey);
	const deadlineAt = opts.deadlineAt;
	try {
		if (deadlineAt !== undefined && Date.now() >= deadlineAt) throw new Error("Recall dedupe deadline passed");
		return await getDbAccessor().withWriteTxAsync(
			(db) => {
				const result = applyRecallDedupeInTx(db, opts, sessionKey, agentId);
				if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
					throw new Error("Recall dedupe deadline passed before commit");
				}
				return result;
			},
			{
				siteToken: "db:recall.ledger.claim.async",
				signal: opts.signal,
				deadlineMs: deadlineAt === undefined ? undefined : deadlineAt - Date.now(),
			},
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

export async function claimRecallItemsAsync<T extends RecallDedupeItem>(
	opts: ClaimRecallItemsOptions<T>,
): Promise<{ readonly items: T[]; readonly meta: RecallDedupeMeta }> {
	return applyRecallDedupeAsync({
		...opts,
		includeRecalled: false,
		claim: true,
	});
}

function advanceEpochInTx(
	db: WriteDb,
	sessionKey: string,
	agentId: string,
	input: { readonly reason: string; readonly sourceRef?: string | null },
): { readonly advanced: boolean; readonly contextEpoch?: number; readonly failedOpen?: boolean } {
	const inserted = db
		.prepare(
			`INSERT OR IGNORE INTO session_context_epochs (
				session_key, agent_id, context_epoch, reason, source_ref, created_at
			)
			SELECT ?, ?, COALESCE(MAX(context_epoch), 0) + 1, ?, ?, ?
			FROM session_context_epochs WHERE session_key = ? AND agent_id = ?
			RETURNING context_epoch`,
		)
		.get(sessionKey, agentId, input.reason, input.sourceRef ?? null, new Date().toISOString(), sessionKey, agentId);
	const contextEpoch = inserted?.context_epoch;
	return typeof contextEpoch === "number" ? { advanced: true, contextEpoch } : { advanced: false };
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
				return advanceEpochInTx(db, sessionKey, agentId, input);
			},
			{ siteToken: "db:recall.ledger.apply.async" },
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
			return advanceEpochInTx(db, sessionKey, agentId, input);
		}, "db:recall.ledger.apply.sync");
	} catch (error) {
		logger.warn("memory", "Failed to advance recall context epoch", {
			error: error instanceof Error ? error.message : String(error),
			sessionKey,
			agentId,
		});
		return { advanced: false, failedOpen: true };
	}
}
