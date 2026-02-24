/**
 * Embedding health check — aggregates scattered embedding signals
 * into a single actionable report.
 *
 * Read-only module following the diagnostics.ts pattern.
 * All functions accept a ReadDb and return plain data structs.
 */

import type { ReadDb } from "./db-accessor";
import type { EmbeddingConfig } from "./memory-config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EmbeddingStatus {
	readonly provider: "ollama" | "openai";
	readonly model: string;
	readonly available: boolean;
	readonly dimensions?: number;
	readonly base_url: string;
	readonly error?: string;
	readonly checkedAt: string;
}

export interface EmbeddingCheckResult {
	readonly name: string;
	readonly status: "ok" | "warn" | "fail";
	readonly message: string;
	readonly detail?: Record<string, unknown>;
	readonly fix?: string;
}

export interface EmbeddingHealthReport {
	readonly status: "healthy" | "degraded" | "unhealthy";
	readonly score: number;
	readonly checkedAt: string;
	readonly config: {
		readonly provider: string;
		readonly model: string;
		readonly dimensions: number;
	};
	readonly checks: readonly EmbeddingCheckResult[];
}

// ---------------------------------------------------------------------------
// Score helpers (duplicated from diagnostics.ts — those are private)
// ---------------------------------------------------------------------------

function scoreStatus(score: number): "healthy" | "degraded" | "unhealthy" {
	if (score >= 0.8) return "healthy";
	if (score >= 0.5) return "degraded";
	return "unhealthy";
}

function clamp(n: number): number {
	return Math.max(0, Math.min(1, n));
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function checkProviderAvailable(
	providerStatus: EmbeddingStatus,
): EmbeddingCheckResult {
	if (providerStatus.available) {
		return {
			name: "provider-available",
			status: "ok",
			message: `${providerStatus.provider} (${providerStatus.model}) is reachable`,
		};
	}
	return {
		name: "provider-available",
		status: "fail",
		message: providerStatus.error ?? `${providerStatus.provider} is not reachable`,
		detail: {
			provider: providerStatus.provider,
			base_url: providerStatus.base_url,
			error: providerStatus.error,
		},
		fix: providerStatus.provider === "ollama"
			? "Start ollama with `ollama serve` or check that the model is pulled"
			: "Verify your OpenAI API key and network connectivity",
	};
}

function checkCoverage(db: ReadDb): EmbeddingCheckResult {
	const totalRow = db
		.prepare("SELECT COUNT(*) AS n FROM memories WHERE is_deleted = 0")
		.get() as { n: number } | undefined;
	const total = totalRow?.n ?? 0;

	if (total === 0) {
		return {
			name: "coverage",
			status: "ok",
			message: "No active memories to embed",
			detail: { total: 0, embedded: 0, coverage: 1 },
		};
	}

	const embeddedRow = db
		.prepare(
			`SELECT COUNT(*) AS n FROM memories m
			 INNER JOIN embeddings e
			   ON e.source_type = 'memory' AND e.source_id = m.id
			 WHERE m.is_deleted = 0`,
		)
		.get() as { n: number } | undefined;
	const embedded = embeddedRow?.n ?? 0;
	const coverage = embedded / total;

	const detail = {
		total,
		embedded,
		unembedded: total - embedded,
		coverage: Math.round(coverage * 1000) / 10,
	};

	if (coverage >= 0.95) {
		return {
			name: "coverage",
			status: "ok",
			message: `${detail.coverage}% of memories have embeddings`,
			detail,
		};
	}
	if (coverage >= 0.8) {
		return {
			name: "coverage",
			status: "warn",
			message: `${detail.coverage}% coverage — ${detail.unembedded} memories missing embeddings`,
			detail,
			fix: "Run re-embed repair to backfill missing embeddings",
		};
	}
	return {
		name: "coverage",
		status: "fail",
		message: `${detail.coverage}% coverage — ${detail.unembedded} memories missing embeddings`,
		detail,
		fix: "Run re-embed repair to backfill missing embeddings",
	};
}

function checkDimensionMismatch(
	db: ReadDb,
	expectedDimensions: number,
): EmbeddingCheckResult {
	const rows = db
		.prepare("SELECT DISTINCT dimensions FROM embeddings")
		.all() as Array<{ dimensions: number }>;

	if (rows.length === 0) {
		return {
			name: "dimension-mismatch",
			status: "ok",
			message: "No embeddings to check",
		};
	}

	const dims = rows.map((r) => r.dimensions);
	const mismatched = dims.filter((d) => d !== expectedDimensions);

	if (mismatched.length === 0) {
		return {
			name: "dimension-mismatch",
			status: "ok",
			message: `All embeddings are ${expectedDimensions}-dimensional`,
		};
	}
	return {
		name: "dimension-mismatch",
		status: "fail",
		message: `Found dimensions [${dims.join(", ")}] but config expects ${expectedDimensions}`,
		detail: { expected: expectedDimensions, found: dims },
		fix: "Re-embed affected memories with the correct model/dimensions",
	};
}

function checkModelDrift(db: ReadDb): EmbeddingCheckResult {
	const rows = db
		.prepare(
			"SELECT DISTINCT embedding_model FROM memories WHERE embedding_model IS NOT NULL",
		)
		.all() as Array<{ embedding_model: string }>;

	const models = rows.map((r) => r.embedding_model);

	if (models.length <= 1) {
		return {
			name: "model-drift",
			status: "ok",
			message: models.length === 0
				? "No embedding models recorded"
				: `All memories use ${models[0]}`,
		};
	}
	return {
		name: "model-drift",
		status: "warn",
		message: `Mixed embedding models: ${models.join(", ")}`,
		detail: { models },
		fix: "Re-embed older memories to unify to the current model",
	};
}

function checkNullVectors(db: ReadDb): EmbeddingCheckResult {
	const row = db
		.prepare(
			"SELECT COUNT(*) AS n FROM embeddings WHERE vector IS NULL OR length(vector) = 0",
		)
		.get() as { n: number } | undefined;
	const count = row?.n ?? 0;

	if (count === 0) {
		return {
			name: "null-vectors",
			status: "ok",
			message: "No null or empty vectors found",
		};
	}
	return {
		name: "null-vectors",
		status: "fail",
		message: `${count} embedding(s) have null or empty vectors`,
		detail: { count },
		fix: "Run re-embed repair to regenerate these vectors",
	};
}

function checkVecTableSync(db: ReadDb): EmbeddingCheckResult {
	const embRow = db
		.prepare("SELECT COUNT(*) AS n FROM embeddings")
		.get() as { n: number } | undefined;
	const embCount = embRow?.n ?? 0;

	let vecCount = 0;
	try {
		const vecRow = db
			.prepare("SELECT COUNT(*) AS n FROM vec_embeddings")
			.get() as { n: number } | undefined;
		vecCount = vecRow?.n ?? 0;
	} catch {
		// vec_embeddings may not exist
		return {
			name: "vec-table-sync",
			status: "warn",
			message: "vec_embeddings table not found",
			fix: "Restart daemon to initialize the vector table",
		};
	}

	if (embCount === vecCount) {
		return {
			name: "vec-table-sync",
			status: "ok",
			message: `embeddings (${embCount}) and vec_embeddings (${vecCount}) are in sync`,
		};
	}
	return {
		name: "vec-table-sync",
		status: "warn",
		message: `embeddings has ${embCount} rows but vec_embeddings has ${vecCount}`,
		detail: { embeddings: embCount, vecEmbeddings: vecCount },
		fix: "Run embedding repair to resync the vector index",
	};
}

function checkOrphanedEmbeddings(db: ReadDb): EmbeddingCheckResult {
	const row = db
		.prepare(
			`SELECT COUNT(*) AS n FROM embeddings e
			 LEFT JOIN memories m ON e.source_type = 'memory' AND e.source_id = m.id
			 WHERE e.source_type = 'memory'
			   AND (m.id IS NULL OR m.is_deleted = 1)`,
		)
		.get() as { n: number } | undefined;
	const count = row?.n ?? 0;

	if (count === 0) {
		return {
			name: "orphaned-embeddings",
			status: "ok",
			message: "No orphaned embeddings found",
		};
	}
	return {
		name: "orphaned-embeddings",
		status: "warn",
		message: `${count} embedding(s) point to deleted or missing memories`,
		detail: { count },
		fix: "Clean orphaned embeddings to reclaim space",
	};
}

// ---------------------------------------------------------------------------
// Scoring weights
// ---------------------------------------------------------------------------

const WEIGHTS: Record<string, number> = {
	"provider-available": 0.30,
	coverage: 0.25,
	"dimension-mismatch": 0.15,
	"model-drift": 0.10,
	"null-vectors": 0.08,
	"vec-table-sync": 0.07,
	"orphaned-embeddings": 0.05,
};

function checkScore(check: EmbeddingCheckResult): number {
	if (check.status === "ok") return 1;
	if (check.status === "warn") return 0.5;
	return 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function buildEmbeddingHealth(
	db: ReadDb,
	embeddingCfg: EmbeddingConfig,
	providerStatus: EmbeddingStatus,
): EmbeddingHealthReport {
	const checks: EmbeddingCheckResult[] = [
		checkProviderAvailable(providerStatus),
		checkCoverage(db),
		checkDimensionMismatch(db, embeddingCfg.dimensions),
		checkModelDrift(db),
		checkNullVectors(db),
		checkVecTableSync(db),
		checkOrphanedEmbeddings(db),
	];

	let weightedSum = 0;
	for (const check of checks) {
		const weight = WEIGHTS[check.name] ?? 0;
		weightedSum += checkScore(check) * weight;
	}

	const score = clamp(weightedSum);

	return {
		status: scoreStatus(score),
		score: Math.round(score * 1000) / 1000,
		checkedAt: new Date().toISOString(),
		config: {
			provider: embeddingCfg.provider,
			model: embeddingCfg.model,
			dimensions: embeddingCfg.dimensions,
		},
		checks,
	};
}
