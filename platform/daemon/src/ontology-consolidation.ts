import type { LlmProvider, OntologyProposal, OntologyProposalStatus } from "@signetai/core";
import type { DbAccessor } from "./db-accessor";
import { createOntologyProposals, listOntologyProposalConflicts, listOntologyProposals } from "./ontology-proposals";
import { extractBalancedJsonObject, stripFences, tryParseJson } from "./pipeline/extraction";

type ProposalDraft = {
	readonly operation: string;
	readonly payload: Readonly<Record<string, unknown>>;
	readonly confidence?: number;
	readonly rationale?: string;
	readonly evidence?: readonly unknown[];
	readonly risk?: string | null;
};

export interface ConsolidateOntologyParams {
	readonly agentId: string;
	readonly status?: OntologyProposalStatus;
	readonly limit?: number;
	readonly writeProposals?: boolean;
	readonly createdBy?: string;
	readonly useProvider?: boolean;
	readonly provider?: LlmProvider | null;
	readonly providerTimeoutMs?: number;
	readonly providerMaxTokens?: number;
}

export interface OntologyConsolidationResult {
	readonly sourceProposalCount: number;
	readonly proposals: readonly ProposalDraft[];
	readonly items: readonly OntologyProposal[];
	readonly count: number;
	readonly writtenCount: number;
	readonly dryRun: boolean;
	readonly consolidationMode: "provider" | "noop";
	readonly providerName: string | null;
	readonly summary: string | null;
	readonly rejections: readonly unknown[];
	readonly conflicts: readonly unknown[];
	readonly maintenance: readonly unknown[];
	readonly warnings: readonly string[];
}

export class OntologyConsolidationError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 404,
	) {
		super(message);
		this.name = "OntologyConsolidationError";
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

function normalizeProposal(value: unknown): ProposalDraft | null {
	if (!isRecord(value)) return null;
	const payload = isRecord(value.payload) ? value.payload : isRecord(value.target) ? value.target : {};
	return proposalInput(readString(value, "operation"), payload, value, "Consolidated ontology proposal.");
}

function normalizePromotions(root: Readonly<Record<string, unknown>>): ProposalDraft[] {
	return readArray(root, "promotions")
		.map((raw) => {
			if (!isRecord(raw)) return null;
			const payload = isRecord(raw.payload) ? raw.payload : isRecord(raw.target) ? raw.target : {};
			return proposalInput(
				readString(raw, "operation"),
				payload,
				raw,
				readString(raw, "rationale") ?? "Consolidated noisy candidates into a stable ontology proposal.",
			);
		})
		.filter((proposal): proposal is ProposalDraft => proposal !== null);
}

function parseJson(raw: string): unknown | null {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function parseProviderOutput(raw: string): {
	readonly proposals: readonly ProposalDraft[];
	readonly summary: string | null;
	readonly rejections: readonly unknown[];
	readonly conflicts: readonly unknown[];
	readonly maintenance: readonly unknown[];
} {
	const candidates: unknown[] = [];
	const whole = parseJson(raw);
	if (whole !== null) candidates.push(whole);
	const stripped = stripFences(raw);
	const strippedParsed = tryParseJson(stripped);
	if (strippedParsed !== null) candidates.push(strippedParsed);
	const object = extractBalancedJsonObject(raw);
	if (object) {
		const parsed = tryParseJson(object);
		if (parsed !== null) candidates.push(parsed);
	}

	for (const candidate of candidates) {
		if (!isRecord(candidate)) continue;
		const explicit = readArray(candidate, "proposals")
			.map(normalizeProposal)
			.filter((proposal): proposal is ProposalDraft => proposal !== null);
		const promotions = normalizePromotions(candidate);
		return {
			proposals: [...explicit, ...promotions],
			summary: readString(candidate, "summary"),
			rejections: readArray(candidate, "rejections"),
			conflicts: readArray(candidate, "conflicts"),
			maintenance: readArray(candidate, "maintenance"),
		};
	}

	return { proposals: [], summary: null, rejections: [], conflicts: [], maintenance: [] };
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

const DEFAULT_PROVIDER_TIMEOUT_MS = 120_000;
const MAX_PROVIDER_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_PROVIDER_MAX_TOKENS = 4096;
const MAX_PROVIDER_MAX_TOKENS = 16_000;

function boundedInt(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.floor(value), min), max);
}

function buildPrompt(
	proposals: readonly OntologyProposal[],
	conflicts: ReturnType<typeof listOntologyProposalConflicts>,
): string {
	const compact = proposals.map((proposal) => ({
		id: proposal.id,
		operation: proposal.operation,
		payload: proposal.payload,
		confidence: proposal.confidence,
		rationale: proposal.rationale,
		evidence: proposal.evidence,
		risk: proposal.risk,
		sourceKind: proposal.sourceKind,
		sourceId: proposal.sourceId,
		sourcePath: proposal.sourcePath,
		createdAt: proposal.createdAt,
	}));
	return `You are performing Signet ontology consolidation.

Goal:
Turn noisy pending ontology proposals into a compact set of stable ontology proposals.
Do not mutate the ontology. Output proposals only.

Rules:
1. Contact is not meaning. Do not preserve every mention.
2. Prefer existing proposal operations: create_entity, add_claim_value, supersede_claim_value, create_link, merge_entities.
3. Prefer claim slots with multiple values over destructive overwrites.
4. Preserve provenance for every promoted value.
5. Mark weak, temporary, duplicate, or ambiguous candidates as rejections instead of promoting them.
6. Return ONLY JSON.

Return JSON:
{
  "summary": "what changed and why",
  "proposals": [
    {
      "operation": "create_entity|add_claim_value|supersede_claim_value|create_link|merge_entities",
      "payload": {},
      "confidence": 0.0,
      "rationale": "string",
      "evidence": [{ "source_kind": "ontology_proposal", "source_id": "proposal-id", "quote": "why this proposal was used" }],
      "risk": "low|medium|high"
    }
  ],
  "rejections": [
    { "candidate_id": "string", "reason": "duplicate|weak_evidence|temporary_task|not_durable|ambiguous|contradicted" }
  ],
  "conflicts": [
    { "claim_slot": "string", "values": ["..."], "recommended_reducer": "string", "needs_review": true }
  ],
  "maintenance": [
    { "operation": "request_review|mark_stale|merge_duplicate", "target": "string", "reason": "string" }
  ]
}

Pending proposals:
${JSON.stringify(compact, null, 2)}

Current conflicts:
${JSON.stringify(conflicts.items, null, 2)}`;
}

async function providerConsolidate(
	proposals: readonly OntologyProposal[],
	conflicts: ReturnType<typeof listOntologyProposalConflicts>,
	params: Pick<ConsolidateOntologyParams, "provider" | "providerTimeoutMs" | "providerMaxTokens">,
): Promise<{
	readonly proposals: readonly ProposalDraft[];
	readonly summary: string | null;
	readonly rejections: readonly unknown[];
	readonly conflicts: readonly unknown[];
	readonly maintenance: readonly unknown[];
	readonly warnings: readonly string[];
}> {
	const provider = params.provider;
	if (!provider) {
		return {
			proposals: [],
			summary: null,
			rejections: [],
			conflicts: [],
			maintenance: [],
			warnings: ["Provider consolidation requested but no inference provider is configured."],
		};
	}
	try {
		const raw = await provider.generate(buildPrompt(proposals, conflicts), {
			timeoutMs: boundedInt(params.providerTimeoutMs, DEFAULT_PROVIDER_TIMEOUT_MS, 1_000, MAX_PROVIDER_TIMEOUT_MS),
			maxTokens: boundedInt(params.providerMaxTokens, DEFAULT_PROVIDER_MAX_TOKENS, 1, MAX_PROVIDER_MAX_TOKENS),
			temperature: 0,
		});
		const parsed = parseProviderOutput(raw);
		return {
			...parsed,
			warnings:
				parsed.proposals.length > 0 || parsed.rejections.length > 0 || parsed.conflicts.length > 0
					? []
					: [`Provider ${provider.name} returned no valid consolidation output.`],
		};
	} catch (err) {
		return {
			proposals: [],
			summary: null,
			rejections: [],
			conflicts: [],
			maintenance: [],
			warnings: [`Provider ${provider.name} consolidation failed: ${err instanceof Error ? err.message : String(err)}`],
		};
	}
}

export async function consolidateOntologyProposals(
	accessor: DbAccessor,
	params: ConsolidateOntologyParams,
): Promise<OntologyConsolidationResult> {
	const agentId = params.agentId.trim();
	if (!agentId) throw new OntologyConsolidationError("agentId is required", 400);
	const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
	const source = listOntologyProposals(accessor, {
		agentId,
		status: params.status ?? "pending",
		limit,
	});
	const conflicts = listOntologyProposalConflicts(accessor, { agentId, limit: Math.max(limit, 50) });
	const warnings: string[] = [];
	let summary: string | null = null;
	let rejections: readonly unknown[] = [];
	let resultConflicts: readonly unknown[] = [];
	let maintenance: readonly unknown[] = [];
	let drafts: readonly ProposalDraft[] = [];

	if (params.useProvider) {
		const result = await providerConsolidate(source.items, conflicts, params);
		drafts = result.proposals;
		summary = result.summary;
		rejections = result.rejections;
		resultConflicts = result.conflicts;
		maintenance = result.maintenance;
		warnings.push(...result.warnings);
	} else {
		warnings.push("Consolidation is provider-backed; pass use_provider to run the configured inference workload.");
	}

	const proposals = dedupeProposals(drafts, limit);
	const dryRun = params.writeProposals !== true || proposals.length === 0;
	if (dryRun) {
		return {
			sourceProposalCount: source.items.length,
			proposals,
			items: [],
			count: proposals.length,
			writtenCount: 0,
			dryRun,
			consolidationMode: params.useProvider && proposals.length > 0 ? "provider" : "noop",
			providerName: params.useProvider ? (params.provider?.name ?? null) : null,
			summary,
			rejections,
			conflicts: resultConflicts,
			maintenance,
			warnings,
		};
	}

	const written = createOntologyProposals(
		accessor,
		proposals.map((proposal) => ({
			agentId,
			operation: proposal.operation,
			payload: proposal.payload,
			confidence: proposal.confidence,
			rationale: proposal.rationale,
			evidence: proposal.evidence,
			risk: proposal.risk,
			sourceKind: "ontology_consolidation",
			sourceId: `proposals:${source.items.length}`,
			createdBy: params.createdBy?.trim() || "ontology-consolidate",
		})),
	);
	return {
		sourceProposalCount: source.items.length,
		proposals,
		items: written.items,
		count: proposals.length,
		writtenCount: written.count,
		dryRun: false,
		consolidationMode: "provider",
		providerName: params.useProvider ? (params.provider?.name ?? null) : null,
		summary,
		rejections,
		conflicts: resultConflicts,
		maintenance,
		warnings,
	};
}
