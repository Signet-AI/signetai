import type { LlmProvider } from "@signet/core";
import type { DbAccessor, ReadDb } from "./db-accessor";
import { type ApplyOntologyOperationBatchResult, applyOntologyOperationBatch } from "./ontology-proposals";
import { extractBalancedJsonObject, stripFences, tryParseJson } from "./pipeline/extraction";

type SourceKind = "memory" | "artifact" | "transcript";

type SourceRecord = {
	readonly kind: SourceKind;
	readonly id: string;
	readonly content: string;
	readonly sourceKind: string;
	readonly sourceId: string;
	readonly sourcePath: string | null;
	readonly project: string | null;
	readonly harness: string | null;
	readonly capturedAt: string;
	readonly confidence: number | null;
};

export interface DreamPromotionSourceInfo {
	readonly kind: SourceKind;
	readonly id: string;
	readonly sourceKind: string;
	readonly sourceId: string;
	readonly sourcePath: string | null;
	readonly project: string | null;
	readonly harness: string | null;
	readonly capturedAt: string;
}

export interface DreamPromotionOperation {
	readonly operation: "set_claim_value";
	readonly payload: Readonly<Record<string, unknown>>;
	readonly reason?: string;
	readonly evidence?: readonly unknown[];
	readonly confidence?: number;
	readonly risk?: string | null;
	readonly sourceKind?: string | null;
	readonly sourceId?: string | null;
	readonly sourcePath?: string | null;
	readonly sourceRoot?: string | null;
	readonly trustedForApply?: boolean;
}

export interface DreamPromotionParams {
	readonly agentId: string;
	readonly from: string;
	readonly apply?: boolean;
	readonly actor?: string;
	readonly limit?: number;
	readonly useProvider?: boolean;
	readonly provider?: LlmProvider | null;
	readonly providerTimeoutMs?: number;
	readonly providerMaxTokens?: number;
}

export interface DreamPromotionResult {
	readonly sources: readonly DreamPromotionSourceInfo[];
	readonly operations: readonly DreamPromotionOperation[];
	readonly applied: ApplyOntologyOperationBatchResult | null;
	readonly count: number;
	readonly appliedCount: number;
	readonly skipped: readonly string[];
	readonly questions: readonly string[];
	readonly warnings: readonly string[];
	readonly dryRun: boolean;
	readonly providerName: string | null;
}

export class DreamPromotionError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 404,
	) {
		super(message);
		this.name = "DreamPromotionError";
	}
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const MAX_PROVIDER_INPUT_CHARS = 20_000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 90_000;
const MAX_PROVIDER_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_PROVIDER_MAX_TOKENS = 4096;
const MAX_PROVIDER_MAX_TOKENS = 16_000;
const MIN_EXPLICIT_CONFIDENCE = 0.75;

function boundedInt(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.floor(value), min), max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Readonly<Record<string, unknown>>, key: string): string | null {
	const value = record[key];
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function readNumber(record: Readonly<Record<string, unknown>>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function explicitConfidence(
	raw: Readonly<Record<string, unknown>>,
	payload: Readonly<Record<string, unknown>>,
): number | null {
	const confidence = readNumber(raw, "confidence") ?? readNumber(payload, "confidence");
	if (confidence === undefined || confidence < MIN_EXPLICIT_CONFIDENCE || confidence > 1) return null;
	return confidence;
}

function isBlockedRisk(value: string | null): boolean {
	return value?.toLowerCase() === "high";
}

function meetsPromotionConfidence(value: number | null): value is number {
	return value !== null && value >= MIN_EXPLICIT_CONFIDENCE && value <= 1;
}

function readArray(record: Readonly<Record<string, unknown>>, key: string): readonly unknown[] {
	const value = record[key];
	return Array.isArray(value) ? value : [];
}

function canonicalKey(value: string): string {
	const key = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.replace(/_+/g, "_")
		.slice(0, 120);
	return key.length > 0 ? key : "preference";
}

function sourceInfo(source: SourceRecord): DreamPromotionSourceInfo {
	return {
		kind: source.kind,
		id: source.id,
		sourceKind: source.sourceKind,
		sourceId: source.sourceId,
		sourcePath: source.sourcePath,
		project: source.project,
		harness: source.harness,
		capturedAt: source.capturedAt,
	};
}

function sourceIdCandidates(value: string): string[] {
	const trimmed = value.trim();
	const stripped = trimmed.replace(/^(memory|artifact|source|transcript|session):/, "");
	return [
		...new Set(
			[
				trimmed,
				stripped,
				`memory:${stripped}`,
				`artifact:${stripped}`,
				`transcript:${stripped}`,
				`session:${stripped}`,
			].filter(Boolean),
		),
	];
}

function readMemorySource(db: ReadDb, agentId: string, id: string): SourceRecord | null {
	const ids = sourceIdCandidates(id);
	const placeholders = ids.map(() => "?").join(", ");
	const row = db
		.prepare(
			`SELECT id, content, project, confidence, created_at, updated_at
			 FROM memories
			 WHERE agent_id = ?
			   AND COALESCE(is_deleted, 0) = 0
			   AND id IN (${placeholders})
			 ORDER BY updated_at DESC
			 LIMIT 1`,
		)
		.get(agentId, ...ids) as
		| {
				readonly id: string;
				readonly content: string;
				readonly project: string | null;
				readonly created_at: string;
				readonly updated_at: string;
				readonly confidence: number | null;
		  }
		| undefined;
	if (!row) return null;
	return {
		kind: "memory",
		id: row.id,
		content: row.content,
		sourceKind: "memory",
		sourceId: row.id,
		sourcePath: null,
		project: row.project,
		harness: null,
		capturedAt: row.updated_at ?? row.created_at,
		confidence: row.confidence,
	};
}

function readRecentMemorySources(db: ReadDb, agentId: string, limit: number): SourceRecord[] {
	return db
		.prepare(
			`SELECT id, content, project, confidence, created_at, updated_at
			 FROM memories
			 WHERE agent_id = ?
			   AND COALESCE(is_deleted, 0) = 0
			 ORDER BY updated_at DESC, created_at DESC
			 LIMIT ?`,
		)
		.all(agentId, limit)
		.map((row) => {
			const memory = row as {
				readonly id: string;
				readonly content: string;
				readonly project: string | null;
				readonly created_at: string;
				readonly updated_at: string;
				readonly confidence: number | null;
			};
			return {
				kind: "memory",
				id: memory.id,
				content: memory.content,
				sourceKind: "memory",
				sourceId: memory.id,
				sourcePath: null,
				project: memory.project,
				harness: null,
				capturedAt: memory.updated_at ?? memory.created_at,
				confidence: memory.confidence,
			} satisfies SourceRecord;
		});
}

function readTranscriptSource(db: ReadDb, agentId: string, id: string): SourceRecord | null {
	const ids = sourceIdCandidates(id);
	const placeholders = ids.map(() => "?").join(", ");
	const row = db
		.prepare(
			`SELECT session_key, content, harness, project, created_at, updated_at
			 FROM session_transcripts
			 WHERE agent_id = ? AND session_key IN (${placeholders})
			 ORDER BY updated_at DESC, created_at DESC
			 LIMIT 1`,
		)
		.get(agentId, ...ids) as
		| {
				readonly session_key: string;
				readonly content: string;
				readonly harness: string | null;
				readonly project: string | null;
				readonly created_at: string;
				readonly updated_at: string | null;
		  }
		| undefined;
	if (!row) return null;
	return {
		kind: "transcript",
		id: row.session_key,
		content: row.content,
		sourceKind: "transcript",
		sourceId: row.session_key,
		sourcePath: null,
		project: row.project,
		harness: row.harness,
		capturedAt: row.updated_at ?? row.created_at,
		confidence: null,
	};
}

function readRecentTranscriptSources(db: ReadDb, agentId: string, limit: number): SourceRecord[] {
	return db
		.prepare(
			`SELECT session_key, content, harness, project, created_at, updated_at
			 FROM session_transcripts
			 WHERE agent_id = ?
			 ORDER BY updated_at DESC, created_at DESC
			 LIMIT ?`,
		)
		.all(agentId, limit)
		.map((row) => {
			const transcript = row as {
				readonly session_key: string;
				readonly content: string;
				readonly harness: string | null;
				readonly project: string | null;
				readonly created_at: string;
				readonly updated_at: string | null;
			};
			return {
				kind: "transcript",
				id: transcript.session_key,
				content: transcript.content,
				sourceKind: "transcript",
				sourceId: transcript.session_key,
				sourcePath: null,
				project: transcript.project,
				harness: transcript.harness,
				capturedAt: transcript.updated_at ?? transcript.created_at,
				confidence: null,
			} satisfies SourceRecord;
		});
}

function readArtifactSource(db: ReadDb, agentId: string, id: string): SourceRecord | null {
	const ids = sourceIdCandidates(id);
	const placeholders = ids.map(() => "?").join(", ");
	const row = db
		.prepare(
			`SELECT source_path, source_kind, source_node_id, session_id, session_key, session_token,
			        project, harness, content, captured_at, updated_at
			 FROM memory_artifacts
			 WHERE agent_id = ?
			   AND COALESCE(is_deleted, 0) = 0
			   AND (
			     source_path = ?
			     OR source_node_id IN (${placeholders})
			     OR session_id IN (${placeholders})
			     OR session_key IN (${placeholders})
			     OR session_token IN (${placeholders})
			   )
			 ORDER BY captured_at DESC
			 LIMIT 1`,
		)
		.get(agentId, id, ...ids, ...ids, ...ids, ...ids) as
		| {
				readonly source_path: string;
				readonly source_kind: string;
				readonly source_node_id: string | null;
				readonly session_id: string;
				readonly session_key: string | null;
				readonly session_token: string;
				readonly project: string | null;
				readonly harness: string | null;
				readonly content: string;
				readonly captured_at: string;
				readonly updated_at: string;
		  }
		| undefined;
	if (!row) return null;
	return {
		kind: "artifact",
		id: row.source_path,
		content: row.content,
		sourceKind: row.source_kind,
		sourceId: row.source_node_id ?? row.session_key ?? row.session_id ?? row.session_token,
		sourcePath: row.source_path,
		project: row.project,
		harness: row.harness,
		capturedAt: row.captured_at ?? row.updated_at,
		confidence: null,
	};
}

function readRecentArtifactSources(db: ReadDb, agentId: string, limit: number): SourceRecord[] {
	return db
		.prepare(
			`SELECT source_path, source_kind, source_node_id, session_id, session_key, session_token,
			        project, harness, content, captured_at, updated_at
			 FROM memory_artifacts
			 WHERE agent_id = ?
			   AND COALESCE(is_deleted, 0) = 0
			 ORDER BY captured_at DESC, updated_at DESC
			 LIMIT ?`,
		)
		.all(agentId, limit)
		.map((row) => {
			const artifact = row as {
				readonly source_path: string;
				readonly source_kind: string;
				readonly source_node_id: string | null;
				readonly session_id: string;
				readonly session_key: string | null;
				readonly session_token: string;
				readonly project: string | null;
				readonly harness: string | null;
				readonly content: string;
				readonly captured_at: string;
				readonly updated_at: string;
			};
			return {
				kind: "artifact",
				id: artifact.source_path,
				content: artifact.content,
				sourceKind: artifact.source_kind,
				sourceId: artifact.source_node_id ?? artifact.session_key ?? artifact.session_id ?? artifact.session_token,
				sourcePath: artifact.source_path,
				project: artifact.project,
				harness: artifact.harness,
				capturedAt: artifact.captured_at ?? artifact.updated_at,
				confidence: null,
			} satisfies SourceRecord;
		});
}

function readSources(
	accessor: DbAccessor,
	params: Pick<DreamPromotionParams, "agentId" | "from" | "limit">,
): SourceRecord[] {
	const from = params.from.trim();
	if (from.length === 0) throw new DreamPromotionError("from is required", 400);
	const limit = boundedInt(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
	return accessor.withReadDb((db) => {
		if (from === "all") {
			return [
				...readRecentMemorySources(db, params.agentId, limit),
				...readRecentArtifactSources(db, params.agentId, limit),
				...readRecentTranscriptSources(db, params.agentId, limit),
			].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
		}
		if (from === "memories:recent") return readRecentMemorySources(db, params.agentId, limit);
		if (from === "artifacts:recent") return readRecentArtifactSources(db, params.agentId, limit);
		if (from === "transcripts:recent") return readRecentTranscriptSources(db, params.agentId, limit);
		if (from.startsWith("memory:")) {
			const memory = readMemorySource(db, params.agentId, from);
			if (memory) return [memory];
		}
		if (from.startsWith("transcript:") || from.startsWith("session:")) {
			const transcript = readTranscriptSource(db, params.agentId, from);
			if (transcript) return [transcript];
		}
		const artifactId = from.replace(/^(artifact|source):/, "");
		const artifact = readArtifactSource(db, params.agentId, artifactId);
		if (artifact) return [artifact];
		const memory = readMemorySource(db, params.agentId, from);
		if (memory) return [memory];
		const transcript = readTranscriptSource(db, params.agentId, from);
		if (transcript) return [transcript];
		throw new DreamPromotionError("Dream promotion source not found", 404);
	});
}

function evidence(source: SourceRecord, quote: string): readonly unknown[] {
	return [
		{
			source_kind: source.sourceKind,
			source_id: source.sourceId,
			source_path: source.sourcePath,
			quote,
		},
	];
}

function normalizeSentence(value: string): string {
	const sentence = value.replace(/\s+/g, " ").trim();
	if (sentence.length === 0) return sentence;
	return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

function statementParts(
	sentence: string,
): { readonly entity: string; readonly verb: string; readonly object: string; readonly context: string | null } | null {
	const match = sentence
		.replace(/\s+/g, " ")
		.trim()
		.match(/^(Nicholai|User|The user)\s+(prefers|likes|wants|expects)\s+(.+?)(?:\s+when\s+(.+))?$/i);
	if (!match) return null;
	const actor = match[1] ?? "";
	const verb = (match[2] ?? "").toLowerCase();
	const object = (match[3] ?? "").trim();
	const context = (match[4] ?? "").trim();
	if (object.length < 3) return null;
	const entity = actor.toLowerCase() === "nicholai" ? "Nicholai" : "Nicholai";
	return {
		entity,
		verb,
		object,
		context: context.length > 0 ? context : null,
	};
}

function claimTarget(object: string): string {
	const target = object
		.replace(/\s+to\s+be\s+.*$/i, "")
		.replace(/\s+as\s+.*$/i, "")
		.trim();
	return target.length > 0 ? target : object;
}

function mechanicalPreferenceOperations(source: SourceRecord): DreamPromotionOperation[] {
	if (!meetsPromotionConfidence(source.confidence)) return [];
	const seen = new Set<string>();
	const operations: DreamPromotionOperation[] = [];
	for (const sentence of source.content.split(/(?<=[.!?])\s+|\n+/).map(normalizeSentence)) {
		const parts = statementParts(sentence.replace(/[.!?]$/, ""));
		if (!parts) continue;
		const claim = parts.context
			? `${parts.verb} ${parts.object} when ${parts.context}`
			: `${parts.verb} ${parts.object}`;
		const claimKey = parts.context
			? canonicalKey(`${parts.verb} ${claimTarget(parts.object)} when ${parts.context}`)
			: canonicalKey(`${parts.verb} ${claimTarget(parts.object)}`);
		const key = `${parts.entity}:${claimKey}`;
		if (seen.has(key)) continue;
		seen.add(key);
		operations.push({
			operation: "set_claim_value",
			payload: {
				entity: parts.entity,
				entity_type: "person",
				aspect: "preferences",
				group_key: parts.context ? "workflow" : "general",
				claim_key: claimKey,
				value: normalizeSentence(`${parts.entity} ${claim}`),
				kind: "attribute",
				confidence: source.confidence,
			},
			confidence: source.confidence,
			reason: "Dreaming promoted an explicit user preference into an update-in-place attribute slot.",
			evidence: evidence(source, sentence),
			risk: "low",
			sourceKind: source.sourceKind,
			sourceId: source.sourceId,
			sourcePath: source.sourcePath,
			sourceRoot: source.kind,
			trustedForApply: true,
		});
	}
	return operations;
}

function normalizeExplicitOperation(
	raw: unknown,
	source: SourceRecord,
	trustedForApply: boolean,
): DreamPromotionOperation | null {
	if (!isRecord(raw)) return null;
	const operation = readString(raw, "operation");
	if (operation !== "set_claim_value") return null;
	const payload = isRecord(raw.payload) ? raw.payload : {};
	const kind = readString(payload, "kind") ?? "attribute";
	if (kind !== "attribute") return null;
	const confidence = explicitConfidence(raw, payload);
	if (confidence === null || isBlockedRisk(readString(raw, "risk"))) return null;
	const entity = readString(payload, "entity");
	const aspect = readString(payload, "aspect");
	const claimKey = readString(payload, "claim_key") ?? readString(payload, "claim");
	const value = readString(payload, "value");
	if (!entity || !aspect || !claimKey || !value) return null;
	return {
		operation,
		payload: {
			...payload,
			claim_key: claimKey,
			kind,
			confidence,
		},
		confidence,
		reason:
			readString(raw, "reason") ??
			readString(raw, "rationale") ??
			"Dreaming promoted explicit ontology operation evidence.",
		evidence: readArray(raw, "evidence").length > 0 ? readArray(raw, "evidence") : evidence(source, value),
		risk: readString(raw, "risk"),
		sourceKind: source.sourceKind,
		sourceId: source.sourceId,
		sourcePath: source.sourcePath,
		sourceRoot: source.kind,
		trustedForApply,
	};
}

function normalizeClaimValue(
	raw: unknown,
	source: SourceRecord,
	trustedForApply: boolean,
): DreamPromotionOperation | null {
	if (!isRecord(raw)) return null;
	const kind = readString(raw, "kind") ?? "attribute";
	if (kind !== "attribute") return null;
	const confidence = explicitConfidence(raw, raw);
	if (confidence === null || isBlockedRisk(readString(raw, "risk"))) return null;
	const entity = readString(raw, "entity");
	const aspect = readString(raw, "aspect");
	const claimKey = readString(raw, "claim_key") ?? readString(raw, "claim");
	const value = readString(raw, "value");
	if (!entity || !aspect || !claimKey || !value) return null;
	return {
		operation: "set_claim_value",
		payload: {
			entity,
			entity_type: readString(raw, "entity_type") ?? undefined,
			aspect,
			group_key: readString(raw, "group_key") ?? readString(raw, "group") ?? undefined,
			claim_key: claimKey,
			value,
			kind,
			confidence,
			importance: readNumber(raw, "importance"),
		},
		confidence,
		reason:
			readString(raw, "reason") ??
			readString(raw, "rationale") ??
			"Dreaming promoted extracted claim evidence into a current attribute value.",
		evidence: readArray(raw, "evidence").length > 0 ? readArray(raw, "evidence") : evidence(source, value),
		risk: readString(raw, "risk"),
		sourceKind: source.sourceKind,
		sourceId: source.sourceId,
		sourcePath: source.sourcePath,
		sourceRoot: source.kind,
		trustedForApply,
	};
}

function parseJsonContent(content: string): unknown | null {
	try {
		return JSON.parse(content);
	} catch {
		return null;
	}
}

function extractJsonBlocks(content: string): unknown[] {
	const parsed = parseJsonContent(content);
	if (parsed !== null) return [parsed];
	return [...content.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
		.map((match) => parseJsonContent(match[1]?.trim() ?? ""))
		.filter((value): value is unknown => value !== null);
}

function normalizeJsonOperations(
	raw: unknown,
	source: SourceRecord,
	trustedForApply: boolean,
): {
	readonly operations: readonly DreamPromotionOperation[];
	readonly questions: readonly string[];
} {
	if (Array.isArray(raw))
		return {
			operations: raw
				.map((item) => normalizeExplicitOperation(item, source, trustedForApply))
				.filter((item): item is DreamPromotionOperation => item !== null),
			questions: [],
		};
	if (!isRecord(raw)) return { operations: [], questions: [] };
	const explicit = readArray(raw, "operations")
		.map((item) => normalizeExplicitOperation(item, source, trustedForApply))
		.filter((item): item is DreamPromotionOperation => item !== null);
	const claims = readArray(raw, "claim_values")
		.map((item) => normalizeClaimValue(item, source, trustedForApply))
		.filter((item): item is DreamPromotionOperation => item !== null);
	return {
		operations: [...explicit, ...claims],
		questions: readArray(raw, "questions").filter(
			(item): item is string => typeof item === "string" && item.trim().length > 0,
		),
	};
}

function parseProviderOutput(
	raw: string,
	source: SourceRecord,
): {
	readonly operations: readonly DreamPromotionOperation[];
	readonly questions: readonly string[];
} {
	const candidates: unknown[] = [];
	const whole = parseJsonContent(raw);
	if (whole !== null) candidates.push(whole);
	const stripped = stripFences(raw);
	const strippedParsed = tryParseJson(stripped);
	if (strippedParsed !== null) candidates.push(strippedParsed);
	const object = extractBalancedJsonObject(raw);
	if (object) {
		const parsed = tryParseJson(object);
		if (parsed !== null) candidates.push(parsed);
	}
	const parsed = candidates.map((candidate) => normalizeJsonOperations(candidate, source, true));
	return {
		operations: parsed.flatMap((item) => item.operations),
		questions: [...new Set(parsed.flatMap((item) => item.questions).map((item) => item.trim()))],
	};
}

function extractExplicitOperations(source: SourceRecord): {
	readonly operations: readonly DreamPromotionOperation[];
	readonly questions: readonly string[];
} {
	const parsed = extractJsonBlocks(source.content).map((candidate) =>
		normalizeJsonOperations(candidate, source, false),
	);
	return {
		operations: parsed.flatMap((item) => item.operations),
		questions: [...new Set(parsed.flatMap((item) => item.questions).map((item) => item.trim()))],
	};
}

function dedupeOperations(operations: readonly DreamPromotionOperation[], limit: number): DreamPromotionOperation[] {
	const seen = new Set<string>();
	return operations
		.filter((operation) => {
			const key = JSON.stringify([operation.operation, operation.payload]);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.slice(0, limit);
}

function buildProviderPrompt(source: SourceRecord): string {
	const content =
		source.content.length > MAX_PROVIDER_INPUT_CHARS
			? `${source.content.slice(0, MAX_PROVIDER_INPUT_CHARS)}\n[truncated]`
			: source.content;
	return `You are running Signet's dreaming skill over source evidence.

Source of truth:
- kind: ${source.kind}
- source_kind: ${source.sourceKind}
- source_id: ${source.sourceId}
- source_path: ${source.sourcePath ?? ""}
- project: ${source.project ?? ""}
- harness: ${source.harness ?? ""}

Task:
Promote explicit durable user preferences, stable project facts, or maintained policy statements into current ontology attributes.
Return direct operations only. Do not create pending proposals. Do not write memories.
Use operation "set_claim_value" so repeated evidence updates the same claim slot in place.
Skip ambiguous or low-confidence candidates and put the uncertainty in questions.
Preserve provenance for every operation using a short exact quote.

Return ONLY JSON with this shape:
{
  "operations": [
    {
      "operation": "set_claim_value",
      "payload": {
        "entity": "Nicholai",
        "entity_type": "person|project|system|tool|source|artifact|concept|task|unknown",
        "aspect": "preferences",
        "group_key": "workflow",
        "claim_key": "stable_snake_case_slot",
        "value": "Nicholai prefers ...",
        "kind": "attribute",
        "confidence": 0.0
      },
      "confidence": 0.0,
      "reason": "string",
      "evidence": [{ "source_kind": "${source.sourceKind}", "source_id": "${source.sourceId}", "source_path": ${JSON.stringify(source.sourcePath)}, "quote": "short exact quote" }],
      "risk": "low|medium|high"
    }
  ],
  "questions": ["uncertainties that need review"]
}

Source content:
${content}`;
}

async function providerOperations(
	source: SourceRecord,
	provider: LlmProvider,
	params: Pick<DreamPromotionParams, "providerTimeoutMs" | "providerMaxTokens">,
): Promise<{
	readonly operations: readonly DreamPromotionOperation[];
	readonly questions: readonly string[];
	readonly warnings: readonly string[];
}> {
	try {
		const raw = await provider.generate(buildProviderPrompt(source), {
			timeoutMs: boundedInt(params.providerTimeoutMs, DEFAULT_PROVIDER_TIMEOUT_MS, 1_000, MAX_PROVIDER_TIMEOUT_MS),
			maxTokens: boundedInt(params.providerMaxTokens, DEFAULT_PROVIDER_MAX_TOKENS, 1, MAX_PROVIDER_MAX_TOKENS),
			temperature: 0,
		});
		const parsed = parseProviderOutput(raw, source);
		return {
			operations: parsed.operations,
			questions: parsed.questions,
			warnings:
				parsed.operations.length > 0
					? []
					: [`Provider ${provider.name} returned no valid dreaming promotion operations.`],
		};
	} catch (err) {
		return {
			operations: [],
			questions: [],
			warnings: [`Provider ${provider.name} promotion failed: ${err instanceof Error ? err.message : String(err)}`],
		};
	}
}

export async function promoteDreamingEvidence(
	accessor: DbAccessor,
	params: DreamPromotionParams,
): Promise<DreamPromotionResult> {
	const limit = boundedInt(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
	const sources = readSources(accessor, params);
	const warnings: string[] = [];
	const questions: string[] = [];
	const skipped: string[] = [];
	const operations: DreamPromotionOperation[] = [];
	for (const source of sources) {
		const explicit = extractExplicitOperations(source);
		operations.push(...explicit.operations);
		questions.push(...explicit.questions);
		operations.push(...mechanicalPreferenceOperations(source));
		if (params.useProvider) {
			if (params.provider) {
				const generated = await providerOperations(source, params.provider, params);
				operations.push(...generated.operations);
				questions.push(...generated.questions);
				warnings.push(...generated.warnings);
			} else {
				warnings.push("Provider promotion requested but no inference provider is configured.");
			}
		}
	}
	const deduped = dedupeOperations(operations, limit);
	if (deduped.length === 0 && sources.length > 0) {
		skipped.push("No explicit high-confidence attribute promotions found.");
	}
	const applyable = params.apply === true ? deduped.filter((operation) => operation.trustedForApply === true) : deduped;
	const previewOnly = deduped.length - applyable.length;
	if (params.apply === true && previewOnly > 0) {
		warnings.push(
			`${previewOnly} embedded operation${previewOnly === 1 ? "" : "s"} left in preview because source JSON cannot self-attest confidence for direct apply.`,
		);
	}
	const applied =
		applyable.length > 0
			? applyOntologyOperationBatch(accessor, {
					agentId: params.agentId,
					actor: params.actor ?? "dreaming-promote",
					operations: applyable,
					dryRun: params.apply !== true,
					propose: false,
				})
			: null;
	return {
		sources: sources.map(sourceInfo),
		operations: deduped,
		applied,
		count: deduped.length,
		appliedCount: params.apply === true ? (applied?.count ?? 0) : 0,
		skipped,
		questions: [...new Set(questions)],
		warnings,
		dryRun: params.apply !== true,
		providerName: params.useProvider ? (params.provider?.name ?? null) : null,
	};
}
