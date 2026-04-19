import { FTS_STOP } from "./stop-words";

export interface EvidenceChannels {
	readonly lexical: number;
	readonly semantic: number;
	readonly hint: number;
	readonly traversal: number;
	readonly structured: number;
}

export interface EvidenceCandidateInput {
	readonly id: string;
	readonly source?: string;
	readonly lexical?: number;
	readonly semantic?: number;
	readonly hint?: number;
	readonly traversal?: number;
	readonly structured?: number;
}

export interface EvidenceCandidate {
	readonly id: string;
	readonly score: number;
	readonly source: string;
	readonly evidence: EvidenceChannels;
}

export interface StructuredEvidenceOptions {
	readonly minScore: number;
	readonly traversalAnchorThreshold: number;
	readonly traversalUnanchoredCap: number;
	readonly weights: EvidenceChannels;
}

export const DEFAULT_STRUCTURED_EVIDENCE_OPTIONS: StructuredEvidenceOptions = {
	minScore: 0,
	traversalAnchorThreshold: 0.35,
	traversalUnanchoredCap: 0.35,
	weights: {
		lexical: 0.25,
		semantic: 0.3,
		hint: 0.3,
		traversal: 0.15,
		structured: 0.15,
	},
};

const PUNCT = /[^a-z0-9\s]/g;

function clamp01(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(1, value));
}

function tokenize(text: string): Set<string> {
	const tokens = new Set<string>();
	for (const raw of text.toLowerCase().replace(PUNCT, " ").split(/\s+/)) {
		if (raw.length < 2 || FTS_STOP.has(raw)) continue;
		tokens.add(raw);
	}
	return tokens;
}

function weightedScore(channels: EvidenceChannels, weights: EvidenceChannels): number {
	return (
		channels.lexical * weights.lexical +
		channels.semantic * weights.semantic +
		channels.hint * weights.hint +
		channels.traversal * weights.traversal +
		channels.structured * weights.structured
	);
}

function hasTraversalAnchor(channels: EvidenceChannels, threshold: number): boolean {
	return (
		channels.lexical > 0 || channels.hint > 0 || channels.semantic >= threshold || channels.structured >= threshold
	);
}

function sourceFor(input: EvidenceCandidateInput, channels: EvidenceChannels): string {
	if (
		channels.traversal > 0 &&
		(channels.lexical > 0 || channels.semantic > 0 || channels.hint > 0 || channels.structured > 0)
	)
		return "sec";
	if (channels.structured > 0 && (channels.lexical > 0 || channels.semantic > 0 || channels.hint > 0)) return "sec";
	if (channels.structured > 0 && channels.traversal === 0) return "structured";
	if (channels.hint > 0 && channels.lexical === 0 && channels.semantic === 0) return "hint";
	return input.source ?? "sec";
}

export function shapeStructuredEvidence(
	inputs: readonly EvidenceCandidateInput[],
	options: Partial<StructuredEvidenceOptions> = {},
): EvidenceCandidate[] {
	const cfg: StructuredEvidenceOptions = {
		...DEFAULT_STRUCTURED_EVIDENCE_OPTIONS,
		...options,
		weights: {
			...DEFAULT_STRUCTURED_EVIDENCE_OPTIONS.weights,
			...(options.weights ?? {}),
		},
	};

	const shaped = inputs.flatMap((input): EvidenceCandidate[] => {
		const evidence: EvidenceChannels = {
			lexical: clamp01(input.lexical),
			semantic: clamp01(input.semantic),
			hint: clamp01(input.hint),
			traversal: clamp01(input.traversal),
			structured: clamp01(input.structured),
		};

		let score = weightedScore(evidence, cfg.weights);
		if (evidence.structured >= 0.25) {
			score += (evidence.structured - 0.25) * 0.8;
		}
		if (evidence.structured >= 0.2) {
			// Structured path scores are already query-normalized evidence over
			// entity/aspect/group/claim/content tokens. Let that channel introduce
			// and rank candidates on its own instead of reducing it to a small
			// additive boost behind generic vector similarity.
			score = Math.max(score, evidence.structured);
		}
		if (evidence.traversal > 0 && !hasTraversalAnchor(evidence, cfg.traversalAnchorThreshold)) {
			score = Math.min(score, cfg.traversalUnanchoredCap);
		}
		score = Math.max(0, Math.min(1, score));
		if (score < cfg.minScore) return [];

		return [
			{
				id: input.id,
				score,
				source: sourceFor(input, evidence),
				evidence,
			},
		];
	});

	shaped.sort((a, b) => b.score - a.score);
	return shaped;
}

export function shapeByFacetCoverage(
	query: string,
	candidates: readonly EvidenceCandidate[],
	contentById: ReadonlyMap<string, string>,
	limit: number,
): EvidenceCandidate[] {
	if (limit <= 0 || candidates.length <= 1) return [...candidates];

	const queryFacets = tokenize(query);
	if (queryFacets.size <= 1) return [...candidates];

	const remaining = [...candidates];
	const selected: EvidenceCandidate[] = [];
	const covered = new Set<string>();

	while (remaining.length > 0 && selected.length < limit) {
		let bestIndex = 0;
		let bestScore = Number.NEGATIVE_INFINITY;

		for (let i = 0; i < remaining.length; i++) {
			const candidate = remaining[i];
			const content = tokenize(contentById.get(candidate.id) ?? "");
			let newFacets = 0;
			let repeatedFacets = 0;
			for (const facet of queryFacets) {
				if (!content.has(facet)) continue;
				if (covered.has(facet)) repeatedFacets += 1;
				else newFacets += 1;
			}
			const coverageScore = candidate.score + newFacets * 0.08 - repeatedFacets * 0.02;
			if (coverageScore > bestScore) {
				bestScore = coverageScore;
				bestIndex = i;
			}
		}

		const [picked] = remaining.splice(bestIndex, 1);
		selected.push(picked);
		const content = tokenize(contentById.get(picked.id) ?? "");
		for (const facet of queryFacets) {
			if (content.has(facet)) covered.add(facet);
		}
	}

	return [...selected, ...remaining];
}
