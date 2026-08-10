import {
	MEMORY_CONTENT_SAFETY_POLICY_VERSION,
	MEMORY_CONTENT_WITHHELD_NOTICE,
	type MemoryContentSafetyAssessment,
	scanMemoryContent,
} from "@signet/core";
import type { ReadDb, WriteDb } from "./db-accessor";
import { tableExists } from "./db-helpers";

export type MemoryContentSafetySourceKind = "memory" | "artifact" | "transcript" | "summary" | "source_chunk";

export interface MemoryContentSafetyRow {
	readonly agent_id: string;
	readonly source_kind: MemoryContentSafetySourceKind;
	readonly source_id: string;
	readonly status: "clean" | "tainted" | "blocked";
	readonly context_eligible: number;
	readonly reasons_json: string;
	readonly policy_version: string;
	readonly scanned_at: string;
}

export function memoryContentSafetyTableExists(db: ReadDb | WriteDb): boolean {
	return tableExists(db, "memory_content_safety");
}

/** Record a derived assessment without changing the retained source content. */
export function upsertMemoryContentSafetyInTx(
	db: WriteDb,
	input: {
		readonly agentId?: string | null;
		readonly sourceKind: MemoryContentSafetySourceKind;
		readonly sourceId: string;
		readonly content: string;
		readonly assessment?: MemoryContentSafetyAssessment;
	},
): void {
	const sourceId = input.sourceId.trim();
	if (!sourceId || !memoryContentSafetyTableExists(db)) return;
	const assessment = input.assessment ?? scanMemoryContent(input.content);
	const agentId = input.agentId?.trim() || "default";
	db.prepare(
		`INSERT INTO memory_content_safety
		 (agent_id, source_kind, source_id, status, context_eligible, reasons_json, policy_version, scanned_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(agent_id, source_kind, source_id) DO UPDATE SET
		   status = excluded.status,
		   context_eligible = excluded.context_eligible,
		   reasons_json = excluded.reasons_json,
		   policy_version = excluded.policy_version,
		   scanned_at = excluded.scanned_at`,
	).run(
		agentId,
		input.sourceKind,
		sourceId,
		assessment.status,
		assessment.contextEligible ? 1 : 0,
		JSON.stringify(assessment.reasons),
		MEMORY_CONTENT_SAFETY_POLICY_VERSION,
		new Date().toISOString(),
	);
}

export function readMemoryContentSafety(
	db: ReadDb,
	params: { readonly agentId: string; readonly sourceKind: MemoryContentSafetySourceKind; readonly sourceId: string },
): MemoryContentSafetyRow | null {
	if (!memoryContentSafetyTableExists(db)) return null;
	const agentId = params.agentId.trim() || "default";
	return (
		(db
			.prepare(
				`SELECT agent_id, source_kind, source_id, status, context_eligible,
				        reasons_json, policy_version, scanned_at
				 FROM memory_content_safety
				 WHERE agent_id = ? AND source_kind = ? AND source_id = ?`,
			)
			.get(agentId, params.sourceKind, params.sourceId) as MemoryContentSafetyRow | undefined) ?? null
	);
}

/**
 * Apply the persisted decision when present, while also scanning the exact
 * projection being returned. This catches direct edits and derived content
 * that differs from the source row, and keeps legacy fixtures safe when no
 * ledger row exists.
 */
export function isMemoryContentContextEligible(
	db: ReadDb,
	params: {
		readonly agentId: string;
		readonly sourceKind: MemoryContentSafetySourceKind;
		readonly sourceId: string;
		readonly content: string;
	},
): boolean {
	const current = scanMemoryContent(params.content);
	if (!current.contextEligible) return false;
	const persisted = readMemoryContentSafety(db, params);
	return persisted ? persisted.status === "clean" && persisted.context_eligible === 1 : true;
}

const MEMORY_PROJECTION_CONTENT_KEYS = [
	"content",
	"excerpt",
	"summary",
	"rationale",
	"evidence",
	"quote",
	"description",
	"preview",
	"archiveReason",
] as const;

/** Replace hostile text in structured prompt-facing projections without touching source rows. */
export function redactUnsafeMemoryProjection<T>(value: T): T {
	function redact(input: unknown): unknown {
		if (Array.isArray(input)) return input.map(redact);
		if (typeof input === "string")
			return scanMemoryContent(input).contextEligible ? input : MEMORY_CONTENT_WITHHELD_NOTICE;
		if (input === null || typeof input !== "object") return input;
		const record = input as Record<string, unknown>;
		const copy = Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, redact(entry)])) as Record<
			string,
			unknown
		>;
		const safety = record.contentSafety;
		const unsafeText = MEMORY_PROJECTION_CONTENT_KEYS.some(
			(key) => typeof record[key] === "string" && !scanMemoryContent(record[key] as string).contextEligible,
		);
		const markedUnsafe =
			safety !== null && typeof safety === "object" && (safety as Record<string, unknown>).contextEligible === false;
		if (unsafeText || markedUnsafe) {
			for (const key of MEMORY_PROJECTION_CONTENT_KEYS) {
				if (typeof record[key] === "string") copy[key] = MEMORY_CONTENT_WITHHELD_NOTICE;
			}
		}
		return copy;
	}

	return redact(value) as T;
}

export function parseMemorySafetyReasons(value: string): string[] {
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.filter((reason): reason is string => typeof reason === "string") : [];
	} catch {
		return [];
	}
}

export function listMemoryContentSafety(
	db: ReadDb,
	params: {
		readonly agentId: string;
		readonly status?: string;
		readonly sourceKind?: string;
		readonly limit: number;
		readonly offset: number;
	},
): {
	readonly policyVersion: string;
	readonly counts: readonly { status: string; sourceKind: string; count: number }[];
	readonly items: readonly MemoryContentSafetyRow[];
} {
	if (!memoryContentSafetyTableExists(db)) {
		return { policyVersion: MEMORY_CONTENT_SAFETY_POLICY_VERSION, counts: [], items: [] };
	}
	const agentId = params.agentId.trim() || "default";
	const counts = db
		.prepare(
			`SELECT status, source_kind, COUNT(*) AS count
			 FROM memory_content_safety
			 WHERE agent_id = ?
			 GROUP BY status, source_kind
			 ORDER BY status, source_kind`,
		)
		.all(agentId) as Array<{ status: string; source_kind: string; count: number }>;
	const predicates = ["agent_id = ?"];
	const args: unknown[] = [agentId];
	if (params.status) {
		predicates.push("status = ?");
		args.push(params.status);
	}
	if (params.sourceKind) {
		predicates.push("source_kind = ?");
		args.push(params.sourceKind);
	}
	args.push(params.limit, params.offset);
	const items = db
		.prepare(
			`SELECT agent_id, source_kind, source_id, status, context_eligible,
			        reasons_json, policy_version, scanned_at
			 FROM memory_content_safety
			 WHERE ${predicates.join(" AND ")}
			 ORDER BY scanned_at DESC, source_kind, source_id
			 LIMIT ? OFFSET ?`,
		)
		.all(...args) as MemoryContentSafetyRow[];
	return {
		policyVersion: MEMORY_CONTENT_SAFETY_POLICY_VERSION,
		counts: counts.map((row) => ({ status: row.status, sourceKind: row.source_kind, count: row.count })),
		items,
	};
}
