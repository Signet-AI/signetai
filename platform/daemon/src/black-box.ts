import type { DbAccessor, ReadDb } from "./db-accessor";

export type BlackBoxEventKind =
	| "recall.requested"
	| "recall.result"
	| "context.recalled"
	| "artifact.written"
	| "assertion.created";

export interface BlackBoxRef {
	readonly kind: "memory" | "source" | "source_artifact" | "assertion" | "session";
	readonly id: string;
	readonly label?: string;
	readonly score?: number;
	readonly status?: string;
	readonly sourcePath?: string;
}

export interface BlackBoxEvent {
	readonly id: string;
	readonly kind: BlackBoxEventKind;
	readonly at: string;
	readonly title: string;
	readonly detail: string;
	readonly refs: readonly BlackBoxRef[];
	readonly payload?: Readonly<Record<string, unknown>>;
}

export interface BlackBoxInfluence {
	readonly eventId: string;
	readonly at: string;
	readonly reason: string;
	readonly refs: readonly BlackBoxRef[];
}

export interface BlackBoxFrame {
	readonly at: string;
	readonly activeRefCount: number;
	readonly activeRefs: readonly BlackBoxRef[];
	readonly likelyInfluences: readonly BlackBoxInfluence[];
	readonly warnings: readonly string[];
}

export interface BlackBoxSession {
	readonly sessionKey: string;
	readonly agentId: string;
	readonly generatedAt: string;
	readonly eventCount: number;
	readonly events: readonly BlackBoxEvent[];
	readonly frame: BlackBoxFrame;
}

export interface BlackBoxSessionSummary {
	readonly sessionKey: string;
	readonly agentId: string;
	readonly project: string | null;
	readonly lastAt: string;
	readonly recallEvents: number;
	readonly artifactEvents: number;
}

interface TelemetryRow {
	readonly id: string;
	readonly created_at: string;
	readonly route: string;
	readonly query: string;
	readonly result_count: number;
	readonly top_score: number | null;
	readonly duration_ms: number;
	readonly results_json: string;
}

interface TelemetryResultSnapshot {
	readonly id: string;
	readonly content?: string;
	readonly score?: number;
	readonly source_id?: string;
	readonly source_path?: string;
	readonly type?: string;
	readonly rank?: number;
}

interface RecallEventRow {
	readonly session_key: string;
	readonly item_kind: string;
	readonly item_id: string;
	readonly surface: string;
	readonly mode: string;
	readonly score: number | null;
	readonly source: string | null;
	readonly created_at: string;
}

interface ArtifactRow {
	readonly source_path: string;
	readonly source_kind: string;
	readonly session_id: string;
	readonly session_key: string | null;
	readonly session_token: string;
	readonly project: string | null;
	readonly harness: string | null;
	readonly captured_at: string;
	readonly memory_sentence: string | null;
	readonly source_id: string | null;
	readonly source_external_id: string | null;
}

interface AssertionRow {
	readonly id: string;
	readonly subject_entity_id: string;
	readonly predicate: string;
	readonly content: string;
	readonly source_kind: string | null;
	readonly source_id: string | null;
	readonly source_path: string | null;
	readonly status: string;
	readonly asserted_at: string;
	readonly confidence: number;
}

const MAX_EVENTS = 500;
const MAX_ACTIVE_REFS = 80;

function parseResults(raw: string): readonly TelemetryResultSnapshot[] {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((value): value is TelemetryResultSnapshot => {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
			return typeof (value as Record<string, unknown>).id === "string";
		});
	} catch {
		return [];
	}
}

function truncateLabel(value: string, max = 96): string {
	const compact = value.replace(/\s+/g, " ").trim();
	if (compact.length <= max) return compact;
	return `${compact.slice(0, max - 1)}…`;
}

function compareEvent(a: BlackBoxEvent, b: BlackBoxEvent): number {
	const byTime = a.at.localeCompare(b.at);
	if (byTime !== 0) return byTime;
	return a.id.localeCompare(b.id);
}

function memoryRefFromResult(result: TelemetryResultSnapshot): BlackBoxRef {
	return {
		kind: "memory",
		id: result.id,
		label: result.content ? truncateLabel(result.content) : result.id,
		score: typeof result.score === "number" ? result.score : undefined,
		sourcePath: result.source_path,
	};
}

function sourceRefFromResult(result: TelemetryResultSnapshot): BlackBoxRef | null {
	if (!result.source_id) return null;
	return {
		kind: "source",
		id: result.source_id,
		label: result.source_path ?? result.source_id,
		score: typeof result.score === "number" ? result.score : undefined,
		sourcePath: result.source_path,
	};
}

function dedupeRefs(refs: readonly BlackBoxRef[]): readonly BlackBoxRef[] {
	const byKey = new Map<string, BlackBoxRef>();
	for (const ref of refs) {
		const key = `${ref.kind}:${ref.id}`;
		const existing = byKey.get(key);
		if (!existing || (ref.score ?? Number.NEGATIVE_INFINITY) > (existing.score ?? Number.NEGATIVE_INFINITY)) {
			byKey.set(key, ref);
		}
	}
	return [...byKey.values()];
}

function listTelemetryEvents(
	db: ReadDb,
	agentId: string,
	sessionKey: string,
	project: string | undefined,
	limit: number,
): BlackBoxEvent[] {
	const rows = db
		.prepare(
			`SELECT id, created_at, route, query, result_count, top_score, duration_ms, results_json
			 FROM memory_search_telemetry
			 WHERE agent_id = ? AND session_key = ? AND (? IS NULL OR project = ?)
			 ORDER BY created_at ASC
			 LIMIT ?`,
		)
		.all(agentId, sessionKey, project ?? null, project ?? null, limit) as readonly TelemetryRow[];

	const events: BlackBoxEvent[] = [];
	for (const row of rows) {
		const results = parseResults(row.results_json);
		const refs = dedupeRefs([
			...results.map(memoryRefFromResult),
			...results.map(sourceRefFromResult).filter((ref): ref is BlackBoxRef => ref !== null),
		]);
		events.push({
			id: `telemetry:${row.id}:query`,
			kind: "recall.requested",
			at: row.created_at,
			title: "Recall requested",
			detail: row.query,
			refs: [],
			payload: {
				route: row.route,
				resultCount: row.result_count,
				durationMs: row.duration_ms,
				topScore: row.top_score,
			},
		});
		if (refs.length > 0) {
			events.push({
				id: `telemetry:${row.id}:results`,
				kind: "recall.result",
				at: row.created_at,
				title: `${refs.length} context reference${refs.length === 1 ? "" : "s"} returned`,
				detail: row.query,
				refs,
				payload: { route: row.route, resultCount: row.result_count },
			});
		}
	}
	return events;
}

function listSessionRecallEvents(
	db: ReadDb,
	agentId: string,
	sessionKey: string,
	project: string | undefined,
	limit: number,
): BlackBoxEvent[] {
	// session_recall_events intentionally has no project column. In scoped
	// requests, rely on project-filtered telemetry/artifact provenance instead.
	if (project) return [];
	const rows = db
		.prepare(
			`SELECT session_key, item_kind, item_id, surface, mode, score, source, created_at
			 FROM session_recall_events
			 WHERE agent_id = ? AND session_key = ?
			 ORDER BY created_at ASC
			 LIMIT ?`,
		)
		.all(agentId, sessionKey, limit) as readonly RecallEventRow[];
	return rows.map((row) => ({
		id: `context:${row.created_at}:${row.item_kind}:${row.item_id}`,
		kind: "context.recalled",
		at: row.created_at,
		title: "Context entered session",
		detail: `${row.item_kind} via ${row.surface}/${row.mode}`,
		refs: [
			{
				kind: row.item_kind === "source" || row.item_kind === "source_chunk" ? "source" : "memory",
				id: row.item_id,
				label: row.source ?? row.item_id,
				score: row.score ?? undefined,
			},
		],
		payload: { surface: row.surface, mode: row.mode, source: row.source },
	}));
}

function listArtifactEvents(
	db: ReadDb,
	agentId: string,
	sessionKey: string,
	project: string | undefined,
	limit: number,
): BlackBoxEvent[] {
	const rows = db
		.prepare(
			`SELECT source_path, source_kind, session_id, session_key, session_token, project, harness,
			        captured_at, memory_sentence, source_id, source_external_id
			 FROM memory_artifacts
			 WHERE agent_id = ?
			   AND COALESCE(is_deleted, 0) = 0
			   AND (? IS NULL OR project = ?)
			   AND (session_id = ? OR session_key = ? OR session_token = ?)
			 ORDER BY captured_at ASC
			 LIMIT ?`,
		)
		.all(
			agentId,
			project ?? null,
			project ?? null,
			sessionKey,
			sessionKey,
			sessionKey,
			limit,
		) as readonly ArtifactRow[];
	return rows.map((row) => ({
		id: `artifact:${row.source_path}`,
		kind: "artifact.written",
		at: row.captured_at,
		title: `${row.source_kind} artifact written`,
		detail: row.memory_sentence ?? row.source_path,
		refs: [
			{
				kind: "source_artifact",
				id: row.source_id ?? row.source_external_id ?? row.source_path,
				label: row.source_path,
				sourcePath: row.source_path,
			},
		],
		payload: { project: row.project, harness: row.harness, sessionId: row.session_id },
	}));
}

function listAssertionEvents(
	db: ReadDb,
	agentId: string,
	sessionKey: string,
	project: string | undefined,
	limit: number,
): BlackBoxEvent[] {
	const rows = project
		? (db
				.prepare(
					`SELECT ea.id, ea.subject_entity_id, ea.predicate, ea.content, ea.source_kind, ea.source_id, ea.source_path,
					        ea.status, ea.asserted_at, ea.confidence
					 FROM epistemic_assertions ea
					 WHERE ea.agent_id = ?
					   AND EXISTS (
					     SELECT 1
					     FROM memory_artifacts ma
					     WHERE ma.agent_id = ea.agent_id
					       AND ma.project = ?
					       AND COALESCE(ma.is_deleted, 0) = 0
					       AND (ma.session_id = ? OR ma.session_key = ? OR ma.session_token = ?)
					       AND (
					         ea.source_path = ma.source_path
					         OR ea.source_id = ma.source_id
					         OR ea.source_id = ma.source_external_id
					         OR ea.source_id = ma.source_node_id
					       )
					   )
					 ORDER BY ea.asserted_at ASC
					 LIMIT ?`,
				)
				.all(agentId, project, sessionKey, sessionKey, sessionKey, limit) as readonly AssertionRow[])
		: (db
				.prepare(
					`SELECT id, subject_entity_id, predicate, content, source_kind, source_id, source_path,
					        status, asserted_at, confidence
					 FROM epistemic_assertions
					 WHERE agent_id = ?
					   AND (source_id = ? OR source_path = ?)
					 ORDER BY asserted_at ASC
					 LIMIT ?`,
				)
				.all(agentId, sessionKey, sessionKey, limit) as readonly AssertionRow[]);
	return rows.map((row) => ({
		id: `assertion:${row.id}`,
		kind: "assertion.created",
		at: row.asserted_at,
		title: `Assertion ${row.predicate}`,
		detail: row.content,
		refs: [
			{
				kind: "assertion",
				id: row.id,
				label: truncateLabel(row.content),
				status: row.status,
				sourcePath: row.source_path ?? undefined,
			},
		],
		payload: {
			predicate: row.predicate,
			subjectEntityId: row.subject_entity_id,
			confidence: row.confidence,
			sourceKind: row.source_kind,
			sourceId: row.source_id,
		},
	}));
}

function buildFrame(events: readonly BlackBoxEvent[], requestedAt?: string): BlackBoxFrame {
	const at = requestedAt ?? events.at(-1)?.at ?? new Date().toISOString();
	const visible = events.filter((event) => event.at <= at);
	const active = new Map<string, BlackBoxRef>();
	for (const event of visible) {
		for (const ref of event.refs) {
			active.set(`${ref.kind}:${ref.id}`, ref);
		}
	}
	const likelyInfluences = visible
		.filter((event) => event.kind === "recall.result" || event.kind === "context.recalled")
		.slice(-5)
		.reverse()
		.map((event) => ({
			eventId: event.id,
			at: event.at,
			reason:
				event.kind === "recall.result"
					? "Returned by explicit recall before this moment"
					: "Already injected in this context epoch",
			refs: event.refs.slice(0, 8),
		}));
	const warnings = visible.some(
		(event) => event.kind === "assertion.created" && event.refs.some((ref) => ref.status === "superseded"),
	)
		? ["One or more assertions in this frame are superseded."]
		: [];
	return {
		at,
		activeRefCount: active.size,
		activeRefs: [...active.values()].slice(0, MAX_ACTIVE_REFS),
		likelyInfluences,
		warnings,
	};
}

export function buildBlackBoxSession(
	accessor: DbAccessor,
	input: {
		readonly agentId: string;
		readonly sessionKey: string;
		readonly project?: string;
		readonly at?: string;
		readonly limit?: number;
	},
): BlackBoxSession {
	const limit = Math.max(1, Math.min(input.limit ?? MAX_EVENTS, MAX_EVENTS));
	const events = accessor.withReadDb((db) =>
		[
			...listTelemetryEvents(db, input.agentId, input.sessionKey, input.project, limit),
			...listSessionRecallEvents(db, input.agentId, input.sessionKey, input.project, limit),
			...listArtifactEvents(db, input.agentId, input.sessionKey, input.project, limit),
			...listAssertionEvents(db, input.agentId, input.sessionKey, input.project, limit),
		]
			.sort(compareEvent)
			.slice(0, limit),
	);
	return {
		sessionKey: input.sessionKey,
		agentId: input.agentId,
		generatedAt: new Date().toISOString(),
		eventCount: events.length,
		events,
		frame: buildFrame(events, input.at),
	};
}

interface SessionAggregateRow {
	readonly session_key: string | null;
	readonly project: string | null;
	readonly last_at: string | null;
	readonly count: number;
}

export function listBlackBoxSessions(
	accessor: DbAccessor,
	input: { readonly agentId: string; readonly project?: string; readonly limit?: number },
): readonly BlackBoxSessionSummary[] {
	const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
	return accessor.withReadDb((db) => {
		const bySession = new Map<string, BlackBoxSessionSummary>();
		const telemetryRows = db
			.prepare(
				`SELECT session_key, project, MAX(created_at) AS last_at, COUNT(*) AS count
				 FROM memory_search_telemetry
				 WHERE agent_id = ? AND session_key IS NOT NULL AND session_key != '' AND (? IS NULL OR project = ?)
				 GROUP BY session_key
				 ORDER BY last_at DESC
				 LIMIT ?`,
			)
			.all(input.agentId, input.project ?? null, input.project ?? null, limit) as readonly SessionAggregateRow[];
		for (const row of telemetryRows) {
			if (!row.session_key || !row.last_at) continue;
			bySession.set(row.session_key, {
				sessionKey: row.session_key,
				agentId: input.agentId,
				project: row.project,
				lastAt: row.last_at,
				recallEvents: row.count,
				artifactEvents: 0,
			});
		}

		const artifactRows = db
			.prepare(
				`SELECT COALESCE(NULLIF(session_key, ''), session_id, session_token) AS session_key,
				        project, MAX(captured_at) AS last_at, COUNT(*) AS count
				 FROM memory_artifacts
				 WHERE agent_id = ? AND COALESCE(is_deleted, 0) = 0 AND (? IS NULL OR project = ?)
				 GROUP BY COALESCE(NULLIF(session_key, ''), session_id, session_token)
				 ORDER BY last_at DESC
				 LIMIT ?`,
			)
			.all(input.agentId, input.project ?? null, input.project ?? null, limit) as readonly SessionAggregateRow[];
		for (const row of artifactRows) {
			if (!row.session_key || !row.last_at) continue;
			const existing = bySession.get(row.session_key);
			bySession.set(row.session_key, {
				sessionKey: row.session_key,
				agentId: input.agentId,
				project: existing?.project ?? row.project,
				lastAt: existing && existing.lastAt > row.last_at ? existing.lastAt : row.last_at,
				recallEvents: existing?.recallEvents ?? 0,
				artifactEvents: row.count,
			});
		}

		return [...bySession.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, limit);
	});
}
