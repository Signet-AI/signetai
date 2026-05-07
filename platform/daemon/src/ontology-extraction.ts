import type { LlmProvider, OntologyProposal } from "@signet/core";
import type { DbAccessor, ReadDb } from "./db-accessor";
import { createOntologyProposals } from "./ontology-proposals";
import { extractBalancedJsonObject, stripFences, tryParseJson } from "./pipeline/extraction";

type ProposalDraft = {
	readonly operation: string;
	readonly payload: Readonly<Record<string, unknown>>;
	readonly confidence?: number;
	readonly rationale?: string;
	readonly evidence?: readonly unknown[];
	readonly risk?: string | null;
};

type ParsedProposalJson = {
	readonly proposals: readonly ProposalDraft[];
	readonly questions: readonly string[];
};

type SourceRecord = {
	readonly kind: "transcript" | "artifact";
	readonly id: string;
	readonly content: string;
	readonly sourceKind: string;
	readonly sourceId: string;
	readonly sourcePath: string | null;
	readonly project: string | null;
	readonly harness: string | null;
};

export interface OntologyExtractionSourceInfo {
	readonly kind: "transcript" | "artifact";
	readonly id: string;
	readonly sourceKind: string;
	readonly sourceId: string;
	readonly sourcePath: string | null;
	readonly project: string | null;
	readonly harness: string | null;
}

export interface ExtractOntologyParams {
	readonly agentId: string;
	readonly from: string;
	readonly writeProposals?: boolean;
	readonly createdBy?: string;
	readonly limit?: number;
	readonly useProvider?: boolean;
	readonly provider?: LlmProvider | null;
	readonly providerTimeoutMs?: number;
	readonly providerMaxTokens?: number;
}

export interface OntologyExtractionResult {
	readonly source: OntologyExtractionSourceInfo;
	readonly proposals: readonly ProposalDraft[];
	readonly items: readonly OntologyProposal[];
	readonly count: number;
	readonly writtenCount: number;
	readonly dryRun: boolean;
	readonly extractionMode: "mechanical" | "provider" | "mixed";
	readonly providerName: string | null;
	readonly questions: readonly string[];
	readonly warnings: readonly string[];
}

export class OntologyExtractionError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 404,
	) {
		super(message);
		this.name = "OntologyExtractionError";
	}
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

function readArray(record: Readonly<Record<string, unknown>>, key: string): readonly unknown[] {
	const value = record[key];
	return Array.isArray(value) ? value : [];
}

function readStringArray(record: Readonly<Record<string, unknown>>, key: string): readonly string[] {
	return readArray(record, key)
		.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		.map((item) => item.trim());
}

function payloadRecord(entries: readonly (readonly [string, unknown])[]): Record<string, unknown> {
	return Object.fromEntries(entries.filter((entry) => entry[1] !== undefined && entry[1] !== null));
}

function proposalInput(
	operation: string | null,
	payload: Record<string, unknown>,
	src: Readonly<Record<string, unknown>>,
	fallbackRationale: string,
): ProposalDraft | null {
	if (!operation || Object.keys(payload).length === 0) return null;
	return {
		operation,
		payload,
		confidence: readNumber(src, "confidence"),
		rationale: readString(src, "rationale") ?? readString(src, "reason") ?? fallbackRationale,
		evidence: readArray(src, "evidence"),
		risk: readString(src, "risk"),
	};
}

function normalizeExplicitProposal(value: unknown): ProposalDraft | null {
	if (!isRecord(value)) return null;
	return proposalInput(
		readString(value, "operation"),
		isRecord(value.payload) ? value.payload : {},
		value,
		"Imported ontology proposal.",
	);
}

function normalizeExtractionEntities(root: Readonly<Record<string, unknown>>): ProposalDraft[] {
	return readArray(root, "entities")
		.map((raw) => {
			if (!isRecord(raw)) return null;
			const name = readString(raw, "name");
			if (!name) return null;
			return proposalInput(
				"create_entity",
				payloadRecord([
					["name", name],
					["entity_type", readString(raw, "type") ?? readString(raw, "entity_type")],
				]),
				raw,
				"Extracted entity candidate from source evidence.",
			);
		})
		.filter((proposal): proposal is ProposalDraft => proposal !== null);
}

function normalizeExtractionClaims(root: Readonly<Record<string, unknown>>): ProposalDraft[] {
	return readArray(root, "claim_values")
		.map((raw) => {
			if (!isRecord(raw)) return null;
			const entity = readString(raw, "entity");
			const aspect = readString(raw, "aspect");
			const claimKey = readString(raw, "claim_key");
			const value = readString(raw, "value");
			if (!entity || !aspect || !claimKey || !value) return null;
			return proposalInput(
				"add_claim_value",
				payloadRecord([
					["entity", entity],
					["entity_type", readString(raw, "entity_type")],
					["aspect", aspect],
					["group_key", readString(raw, "group_key")],
					["claim_key", claimKey],
					["value", value],
					["visibility", readString(raw, "visibility")],
					["reducer_hint", readString(raw, "reducer_hint")],
					["confidence", readNumber(raw, "confidence")],
				]),
				raw,
				"Extracted claim value candidate from source evidence.",
			);
		})
		.filter((proposal): proposal is ProposalDraft => proposal !== null);
}

function normalizeExtractionLinks(root: Readonly<Record<string, unknown>>): ProposalDraft[] {
	return readArray(root, "links")
		.map((raw) => {
			if (!isRecord(raw)) return null;
			const source = readString(raw, "source_entity");
			const target = readString(raw, "target_entity");
			const linkType = readString(raw, "link_type");
			if (!source || !target || !linkType) return null;
			return proposalInput(
				"create_link",
				payloadRecord([
					["source_entity", source],
					["source_type", readString(raw, "source_type")],
					["link_type", linkType],
					["target_entity", target],
					["target_type", readString(raw, "target_type")],
					["properties", isRecord(raw.properties) ? raw.properties : undefined],
					["reason", readString(raw, "reason")],
					["confidence", readNumber(raw, "confidence")],
				]),
				raw,
				"Extracted typed link candidate from source evidence.",
			);
		})
		.filter((proposal): proposal is ProposalDraft => proposal !== null);
}

function normalizeExtractionPolicies(root: Readonly<Record<string, unknown>>): ProposalDraft[] {
	return readArray(root, "actions_or_policies")
		.map((raw) => {
			if (!isRecord(raw)) return null;
			const target = readString(raw, "target_entity");
			const kind = readString(raw, "kind");
			const content = readString(raw, "content");
			if (!target || !kind || !content) return null;
			return proposalInput(
				"create_policy",
				payloadRecord([
					["target_entity", target],
					["kind", kind],
					["content", content],
				]),
				raw,
				"Extracted action or policy candidate from source evidence.",
			);
		})
		.filter((proposal): proposal is ProposalDraft => proposal !== null);
}

function normalizeProposalJson(raw: unknown): ParsedProposalJson {
	if (Array.isArray(raw))
		return {
			proposals: raw.map(normalizeExplicitProposal).filter((proposal): proposal is ProposalDraft => proposal !== null),
			questions: [],
		};
	if (!isRecord(raw)) return { proposals: [], questions: [] };
	const explicit = readArray(raw, "proposals");
	if (explicit.length > 0) {
		return {
			proposals: explicit
				.map(normalizeExplicitProposal)
				.filter((proposal): proposal is ProposalDraft => proposal !== null),
			questions: readStringArray(raw, "questions"),
		};
	}
	return {
		proposals: [
			...normalizeExtractionEntities(raw),
			...normalizeExtractionClaims(raw),
			...normalizeExtractionLinks(raw),
			...normalizeExtractionPolicies(raw),
		],
		questions: readStringArray(raw, "questions"),
	};
}

function mergeParsedProposalJson(items: readonly ParsedProposalJson[]): ParsedProposalJson {
	return {
		proposals: items.flatMap((item) => item.proposals),
		questions: [...new Set(items.flatMap((item) => item.questions))],
	};
}

function parseOntologyJsonOutput(raw: string): ParsedProposalJson {
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
	return mergeParsedProposalJson(candidates.map(normalizeProposalJson));
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

function normalizeName(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function claimKeyFor(value: string): string {
	const words = value
		.toLowerCase()
		.replace(/[^a-z0-9\s_-]/g, " ")
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 6);
	return words.length > 0 ? words.join("_") : "extracted_claim";
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

function mechanicalEntityProposals(source: SourceRecord): ProposalDraft[] {
	const seen = new Set<string>();
	return [...source.content.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)]
		.map((match) => normalizeName(match[1] ?? ""))
		.filter((name) => name.length >= 2)
		.filter((name) => {
			const key = name.toLowerCase();
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.slice(0, 50)
		.map((name) => ({
			operation: "create_entity",
			payload: { name, entity_type: "concept" },
			confidence: 0.7,
			rationale: "Detected explicit wikilink entity in source text.",
			evidence: evidence(source, `[[${name}]]`),
			risk: "low",
		}));
}

function mechanicalClaimProposals(source: SourceRecord): ProposalDraft[] {
	const blocked = new Set(["User", "Assistant", "The", "This", "That", "It", "I", "We"]);
	const text = source.content.replace(/\s+/g, " ");
	const matches = [
		...text.matchAll(/\b([A-Z][A-Za-z0-9 ._-]{1,80}?)\s+(should|must|needs to|is|are)\s+([^.!?]{12,240})[.!?]/g),
	];
	const seen = new Set<string>();
	return matches
		.map((match) => {
			const entity = normalizeName(match[1] ?? "");
			const verb = normalizeName(match[2] ?? "");
			const rest = normalizeName(match[3] ?? "");
			const first = entity.split(/\s+/)[0] ?? "";
			if (blocked.has(first) || entity.length < 2 || rest.length < 12) return null;
			const value = `${entity} ${verb} ${rest}.`;
			const key = `${entity.toLowerCase()}:${value.toLowerCase()}`;
			if (seen.has(key)) return null;
			seen.add(key);
			return {
				operation: "add_claim_value",
				payload: {
					entity,
					entity_type: "concept",
					aspect: "extracted",
					group_key: "transcript",
					claim_key: claimKeyFor(`${verb} ${rest}`),
					value,
				},
				confidence: 0.55,
				rationale: "Detected explicit sentence-level claim in source text.",
				evidence: evidence(source, value),
				risk: "medium",
			} satisfies ProposalDraft;
		})
		.filter((proposal): proposal is ProposalDraft => proposal !== null)
		.slice(0, 50);
}

function mechanicalLinkProposals(source: SourceRecord): ProposalDraft[] {
	const linkTypes = new Set([
		"supports",
		"requires",
		"blocks",
		"uses",
		"contains",
		"implements",
		"maintains",
		"informs",
	]);
	const text = source.content.replace(/\s+/g, " ");
	const matches = [
		...text.matchAll(
			/\b([A-Z][A-Za-z0-9 _.-]{1,80}?)\s+(supports|requires|blocks|uses|contains|implements|maintains|informs)\s+([A-Z][A-Za-z0-9 _.-]{1,80}?)(?:[.!?]|,|\s+because\b)/g,
		),
	];
	const seen = new Set<string>();
	return matches
		.map((match) => {
			const sourceEntity = normalizeName(match[1] ?? "");
			const linkType = normalizeName(match[2] ?? "");
			const targetEntity = normalizeName(match[3] ?? "");
			if (!linkTypes.has(linkType) || sourceEntity.length < 2 || targetEntity.length < 2) return null;
			const key = `${sourceEntity.toLowerCase()}:${linkType}:${targetEntity.toLowerCase()}`;
			if (seen.has(key)) return null;
			seen.add(key);
			const quote = `${sourceEntity} ${linkType} ${targetEntity}`;
			return {
				operation: "create_link",
				payload: {
					source_entity: sourceEntity,
					source_type: "concept",
					link_type: linkType === "supports" ? "supports_claim" : linkType,
					target_entity: targetEntity,
					target_type: "concept",
					reason: "Detected explicit relationship statement in source text.",
				},
				confidence: 0.58,
				rationale: "Detected explicit relationship statement in source text.",
				evidence: evidence(source, quote),
				risk: "medium",
			} satisfies ProposalDraft;
		})
		.filter((proposal): proposal is ProposalDraft => proposal !== null)
		.slice(0, 50);
}

function extractProposals(source: SourceRecord, limit: number): ProposalDraft[] {
	const jsonProposals = mergeParsedProposalJson(extractJsonBlocks(source.content).map(normalizeProposalJson)).proposals;
	const mechanical = [
		...mechanicalEntityProposals(source),
		...mechanicalClaimProposals(source),
		...mechanicalLinkProposals(source),
	];
	return dedupeProposals([...jsonProposals, ...mechanical], limit);
}

function dedupeProposals(proposals: readonly ProposalDraft[], limit: number): ProposalDraft[] {
	const seen = new Set<string>();
	return proposals
		.filter((proposal) => {
			const key = JSON.stringify([proposal.operation, proposal.payload]);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.slice(0, limit);
}

const MAX_PROVIDER_INPUT_CHARS = 20_000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 90_000;
const MAX_PROVIDER_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_PROVIDER_MAX_TOKENS = 4096;
const MAX_PROVIDER_MAX_TOKENS = 16_000;

function boundedInt(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.floor(value), min), max);
}

function buildProviderPrompt(source: SourceRecord): string {
	const content =
		source.content.length > MAX_PROVIDER_INPUT_CHARS
			? `${source.content.slice(0, MAX_PROVIDER_INPUT_CHARS)}\n[truncated]`
			: source.content;
	return `You are extracting candidate ontology updates from source evidence.

Source of truth:
- kind: ${source.kind}
- source_kind: ${source.sourceKind}
- source_id: ${source.sourceId}
- source_path: ${source.sourcePath ?? ""}
- project: ${source.project ?? ""}
- harness: ${source.harness ?? ""}

Task:
Identify durable semantic structure that may belong in Signet's ontology.
Do not write to memory. Do not invent missing facts.
Mentions, backlinks, keyword overlap, and embeddings are evidence of contact, not proof of a stable relationship.
Extract only candidates supported by explicit source evidence.
Prefer compact atomic claims and typed links.
Preserve provenance for every candidate using short quotes.

Return ONLY JSON with this shape:
{
  "entities": [
    {
      "name": "string",
      "type": "person|project|system|tool|source|artifact|concept|task|unknown",
      "confidence": 0.0,
      "evidence": [{ "source_kind": "${source.sourceKind}", "source_id": "${source.sourceId}", "source_path": ${JSON.stringify(source.sourcePath)}, "quote": "short exact quote" }]
    }
  ],
  "claim_values": [
    {
      "entity": "string",
      "aspect": "string",
      "group_key": "string|null",
      "claim_key": "string",
      "value": "string",
      "confidence": 0.0,
      "visibility": "private|project|public|unknown",
      "reducer_hint": "explicit_user_statement_wins|most_recent|highest_confidence|null",
      "evidence": [{ "source_kind": "${source.sourceKind}", "source_id": "${source.sourceId}", "source_path": ${JSON.stringify(source.sourcePath)}, "quote": "short exact quote" }]
    }
  ],
  "links": [
    {
      "source_entity": "string",
      "link_type": "contains|uses|requires|supports_claim|authored_by|maintains|blocks|informs|may_execute|custom",
      "target_entity": "string",
      "properties": {},
      "confidence": 0.0,
      "reason": "string",
      "evidence": [{ "source_kind": "${source.sourceKind}", "source_id": "${source.sourceId}", "source_path": ${JSON.stringify(source.sourcePath)}, "quote": "short exact quote" }]
    }
  ],
  "actions_or_policies": [
    {
      "target_entity": "string",
      "kind": "permitted_action|forbidden_action|approval_required|disclosure_policy",
      "content": "string",
      "confidence": 0.0,
      "evidence": [{ "source_kind": "${source.sourceKind}", "source_id": "${source.sourceId}", "source_path": ${JSON.stringify(source.sourcePath)}, "quote": "short exact quote" }]
    }
  ],
  "questions": ["uncertainties that need review"]
}

Source content:
${content}`;
}

async function extractProviderProposals(
	source: SourceRecord,
	provider: LlmProvider,
	params: Pick<ExtractOntologyParams, "providerTimeoutMs" | "providerMaxTokens">,
): Promise<{
	readonly proposals: readonly ProposalDraft[];
	readonly questions: readonly string[];
	readonly warnings: readonly string[];
}> {
	try {
		const raw = await provider.generate(buildProviderPrompt(source), {
			timeoutMs: boundedInt(params.providerTimeoutMs, DEFAULT_PROVIDER_TIMEOUT_MS, 1_000, MAX_PROVIDER_TIMEOUT_MS),
			maxTokens: boundedInt(params.providerMaxTokens, DEFAULT_PROVIDER_MAX_TOKENS, 1, MAX_PROVIDER_MAX_TOKENS),
			temperature: 0,
		});
		const parsed = parseOntologyJsonOutput(raw);
		return {
			proposals: parsed.proposals,
			questions: parsed.questions,
			warnings: parsed.proposals.length > 0 ? [] : [`Provider ${provider.name} returned no valid ontology proposals.`],
		};
	} catch (err) {
		return {
			proposals: [],
			questions: [],
			warnings: [`Provider ${provider.name} extraction failed: ${err instanceof Error ? err.message : String(err)}`],
		};
	}
}

function sourceInfo(source: SourceRecord): OntologyExtractionSourceInfo {
	return {
		kind: source.kind,
		id: source.id,
		sourceKind: source.sourceKind,
		sourceId: source.sourceId,
		sourcePath: source.sourcePath,
		project: source.project,
		harness: source.harness,
	};
}

function sourceIdCandidates(value: string): string[] {
	const trimmed = value.trim();
	const stripped = trimmed.replace(/^transcript:/, "").replace(/^session:/, "");
	return [...new Set([trimmed, stripped, `transcript:${stripped}`, `session:${stripped}`].filter(Boolean))];
}

function readTranscriptSource(db: ReadDb, agentId: string, id: string): SourceRecord | null {
	const ids = sourceIdCandidates(id);
	const placeholders = ids.map(() => "?").join(", ");
	const row = db
		.prepare(
			`SELECT session_key, content, harness, project
			 FROM session_transcripts
			 WHERE agent_id = ? AND session_key IN (${placeholders})
			 ORDER BY created_at DESC
			 LIMIT 1`,
		)
		.get(agentId, ...ids) as
		| {
				readonly session_key: string;
				readonly content: string;
				readonly harness: string | null;
				readonly project: string | null;
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
	};
}

function readArtifactSource(db: ReadDb, agentId: string, id: string): SourceRecord | null {
	const ids = sourceIdCandidates(id);
	const placeholders = ids.map(() => "?").join(", ");
	const row = db
		.prepare(
			`SELECT source_path, source_kind, source_node_id, session_id, session_key, session_token,
			        project, harness, content
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
	};
}

function readSource(accessor: DbAccessor, params: Pick<ExtractOntologyParams, "agentId" | "from">): SourceRecord {
	const from = params.from.trim();
	if (from.length === 0) throw new OntologyExtractionError("from is required", 400);
	return accessor.withReadDb((db) => {
		if (from.startsWith("transcript:") || from.startsWith("session:")) {
			const transcript = readTranscriptSource(db, params.agentId, from);
			if (transcript) return transcript;
		}
		const artifactId = from.replace(/^(artifact|source):/, "");
		const artifact = readArtifactSource(db, params.agentId, artifactId);
		if (artifact) return artifact;
		const transcript = readTranscriptSource(db, params.agentId, from);
		if (transcript) return transcript;
		throw new OntologyExtractionError("Extraction source not found", 404);
	});
}

export async function extractOntologyProposals(
	accessor: DbAccessor,
	params: ExtractOntologyParams,
): Promise<OntologyExtractionResult> {
	const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
	const source = readSource(accessor, params);
	const explicitParsed = mergeParsedProposalJson(extractJsonBlocks(source.content).map(normalizeProposalJson));
	const explicit = explicitParsed.proposals;
	const mechanical = extractProposals(source, limit);
	const warnings: string[] = [];
	let providerProposals: readonly ProposalDraft[] = [];
	let providerQuestions: readonly string[] = [];
	if (params.useProvider) {
		if (params.provider) {
			const provider = await extractProviderProposals(source, params.provider, params);
			providerProposals = provider.proposals;
			providerQuestions = provider.questions;
			warnings.push(...provider.warnings);
		} else {
			warnings.push("Provider extraction requested but no inference provider is configured.");
		}
	}
	const raw =
		params.useProvider && providerProposals.length > 0
			? dedupeProposals([...explicit, ...providerProposals], limit)
			: mechanical;
	const proposals = raw.map((proposal) => ({
		...proposal,
		evidence: proposal.evidence && proposal.evidence.length > 0 ? proposal.evidence : evidence(source, source.id),
	}));
	const extractionMode =
		params.useProvider && providerProposals.length > 0 && explicit.length > 0
			? "mixed"
			: params.useProvider && providerProposals.length > 0
				? "provider"
				: "mechanical";
	const questions = [...new Set([...explicitParsed.questions, ...providerQuestions])];
	if (!params.writeProposals || proposals.length === 0) {
		return {
			source: sourceInfo(source),
			proposals,
			items: [],
			count: proposals.length,
			writtenCount: 0,
			dryRun: true,
			extractionMode,
			providerName: params.useProvider ? (params.provider?.name ?? null) : null,
			questions,
			warnings,
		};
	}

	const written = createOntologyProposals(
		accessor,
		proposals.map((proposal) => ({
			agentId: params.agentId,
			operation: proposal.operation,
			payload: proposal.payload,
			confidence: proposal.confidence,
			rationale: proposal.rationale,
			evidence: proposal.evidence,
			risk: proposal.risk,
			sourceKind: source.sourceKind,
			sourceId: source.sourceId,
			sourcePath: source.sourcePath,
			createdBy: params.createdBy ?? "ontology-extract",
		})),
	);

	return {
		source: sourceInfo(source),
		proposals,
		items: written.items,
		count: proposals.length,
		writtenCount: written.count,
		dryRun: false,
		extractionMode,
		providerName: params.useProvider ? (params.provider?.name ?? null) : null,
		questions,
		warnings,
	};
}
