import { DEFAULT_EMBEDDING_DIMENSIONS } from "@signet/core";
import type { ReadDb, WriteDb } from "./db-accessor";
import {
	embeddingProfileFingerprint,
	embeddingProfileFingerprintsEqual,
	recommendedEmbeddingProfileId,
} from "./embedding-profile";
import type { EmbeddingConfig } from "./memory-config";

export type EmbeddingIndexBuildState = "ready" | "building" | "failed";
export type EmbeddingProjectionSlot = "active" | "staging";

export const MAX_CONSECUTIVE_PROVIDER_FAILURES = 6;
export const MAX_PROVIDER_BACKOFF_MS = 60_000;
export const MAX_CONSECUTIVE_NO_PROGRESS_TICKS = 6;

export type EmbeddingMigrationPhase = "staging" | "projection" | "promoting";

export interface EmbeddingIndexMigrationProgress {
	readonly state: EmbeddingIndexBuildState;
	readonly staged: number;
	readonly total: number;
	readonly phase: EmbeddingMigrationPhase | null;
	readonly providerEndpoint: string | null;
	readonly lastError: string | null;
	readonly projectionCursor: {
		readonly lastId: string | null;
		readonly slot: EmbeddingProjectionSlot | null;
	} | null;
}

export interface PersistedEmbeddingProfile {
	readonly fingerprint: string;
	readonly provider: EmbeddingConfig["provider"];
	readonly model: string;
	readonly dimensions: number;
	readonly baseUrl: string;
	readonly profile?: string;
	readonly projectionSlot?: EmbeddingProjectionSlot;
	readonly projectionRebuild?: boolean;
}

export interface EmbeddingIndexState {
	readonly active: PersistedEmbeddingProfile;
	readonly staging: PersistedEmbeddingProfile | null;
	readonly state: EmbeddingIndexBuildState;
	readonly lastError: string | null;
}

export interface EmbeddingIndexStateRow {
	readonly active_profile_json: string;
	readonly staging_profile_json: string | null;
	readonly state: EmbeddingIndexBuildState;
	readonly last_error: string | null;
}

type PersistedFailure = {
	readonly message: string;
	readonly cause?: "provider-unavailable";
	readonly nextAttemptAt?: string;
};

function parseFailure(value: string | null): PersistedFailure | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as Partial<PersistedFailure>;
		return typeof parsed.message === "string"
			? {
					message: parsed.message,
					...(parsed.cause === "provider-unavailable" ? { cause: parsed.cause } : {}),
					...(typeof parsed.nextAttemptAt === "string" ? { nextAttemptAt: parsed.nextAttemptAt } : {}),
				}
			: null;
	} catch {
		return null;
	}
}

export function persistEmbeddingIndexFailure(
	error: string,
	options?: { cause?: "provider-unavailable"; nextAttemptAt?: string },
): string {
	return JSON.stringify({ message: error, ...options });
}

function profileForStorage(cfg: EmbeddingConfig): PersistedEmbeddingProfile {
	const provider = isEmbeddingProvider(cfg.provider) ? cfg.provider : "native";
	const dimensions =
		Number.isInteger(cfg.dimensions) && cfg.dimensions > 0 ? cfg.dimensions : DEFAULT_EMBEDDING_DIMENSIONS;
	const normalized: EmbeddingConfig = { ...cfg, provider, dimensions };
	return {
		fingerprint: embeddingProfileFingerprint(normalized),
		provider,
		model: normalized.model,
		dimensions,
		baseUrl: normalized.base_url,
		...(normalized.profile ? { profile: normalized.profile } : {}),
	};
}

export function resolveActiveEmbeddingConfigFromState(
	configured: EmbeddingConfig,
	state: EmbeddingIndexState | null,
): EmbeddingConfig {
	if (configured.profile) return configured;
	const active = state?.active;
	if (!active) return configured;
	return {
		...configured,
		provider: active.provider,
		model: active.model,
		dimensions: active.dimensions,
		base_url: configured.base_url,
		...(active.profile ? { profile: active.profile } : { profile: undefined }),
	};
}

export function resolveActiveEmbeddingConfig(db: ReadDb, configured: EmbeddingConfig): EmbeddingConfig {
	return resolveActiveEmbeddingConfigFromState(configured, readEmbeddingIndexState(db));
}
export function isActiveEmbeddingConfig(db: ReadDb, cfg: EmbeddingConfig): boolean {
	const state = readEmbeddingIndexState(db);
	if (!state) return true;
	if (state.state === "building" && state.staging?.projectionRebuild === true) return false;
	return embeddingProfileFingerprintsEqual(embeddingProfileFingerprint(cfg), state.active.fingerprint);
}

function stateHasColumn(db: ReadDb, column: string): boolean {
	return (db.prepare("PRAGMA table_info(embedding_index_state)").all() as Array<{ name?: string }>).some(
		(row) => row.name === column,
	);
}

function updateProgressColumns(
	db: WriteDb,
	values: Partial<{
		migration_phase: EmbeddingMigrationPhase | null;
		progress_staged: number;
		progress_total: number;
		projection_cursor_last_id: string | null;
		projection_cursor_slot: EmbeddingProjectionSlot | null;
		no_progress_ticks: number;
		provider_endpoint: string | null;
	}>,
): void {
	const available = new Set(
		(db.prepare("PRAGMA table_info(embedding_index_state)").all() as Array<{ name?: string }>)
			.map((row) => row.name)
			.filter((name): name is string => typeof name === "string"),
	);
	const entries = Object.entries(values).filter(([column]) => available.has(column));
	if (entries.length === 0) return;
	const assignments = entries.map(([column]) => `${column} = ?`).join(", ");
	db.prepare(`UPDATE embedding_index_state SET ${assignments} WHERE id = 1`).run(...entries.map(([, value]) => value));
}
export function readEmbeddingIndexMigrationProgress(
	db: ReadDb,
	configured?: EmbeddingConfig,
): EmbeddingIndexMigrationProgress | null {
	const state = readEmbeddingIndexState(db);
	if (!state) return null;
	let staged = 0;
	let total = 0;
	try {
		total = (db.prepare("SELECT COUNT(*) AS n FROM embeddings").get() as { n?: number } | undefined)?.n ?? 0;
		staged = (db.prepare("SELECT COUNT(*) AS n FROM embeddings_staging").get() as { n?: number } | undefined)?.n ?? 0;
	} catch {}
	if (state.state !== "building") staged = total;
	let phase: EmbeddingMigrationPhase | null = state.state === "building" ? "staging" : null;
	let lastId: string | null = null;
	let slot: EmbeddingProjectionSlot | null = null;
	if (state.staging?.projectionRebuild) phase = "projection";
	if (stateHasColumn(db, "migration_phase")) {
		const row = db
			.prepare(
				"SELECT migration_phase, progress_staged, progress_total, projection_cursor_last_id, projection_cursor_slot, provider_endpoint FROM embedding_index_state WHERE id = 1",
			)
			.get() as
			| {
					migration_phase?: string | null;
					progress_staged?: number;
					progress_total?: number;
					projection_cursor_last_id?: string | null;
					projection_cursor_slot?: string | null;
					provider_endpoint?: string | null;
			  }
			| undefined;
		if (
			row?.migration_phase === "staging" ||
			row?.migration_phase === "projection" ||
			row?.migration_phase === "promoting"
		)
			phase = row.migration_phase;
		if (typeof row?.progress_staged === "number") staged = row.progress_staged;
		if (typeof row?.progress_total === "number") total = row.progress_total;
		lastId = typeof row?.projection_cursor_last_id === "string" ? row.projection_cursor_last_id : null;
		slot =
			row?.projection_cursor_slot === "active" || row?.projection_cursor_slot === "staging"
				? row.projection_cursor_slot
				: null;
		const providerEndpoint =
			configured?.base_url ?? row?.provider_endpoint ?? state.staging?.baseUrl ?? state.active.baseUrl;
		return {
			state: state.state,
			staged,
			total,
			phase,
			providerEndpoint,
			lastError: state.lastError,
			projectionCursor: lastId !== null || slot !== null ? { lastId, slot } : null,
		};
	}
	return {
		state: state.state,
		staged,
		total,
		phase,
		providerEndpoint: configured?.base_url ?? state.staging?.baseUrl ?? state.active.baseUrl,
		lastError: state.lastError,
		projectionCursor: null,
	};
}

function parseProfile(value: string): PersistedEmbeddingProfile | null {
	try {
		const parsed = JSON.parse(value) as Partial<PersistedEmbeddingProfile>;
		const dimensions = parsed.dimensions;
		if (
			typeof parsed.fingerprint !== "string" ||
			typeof parsed.model !== "string" ||
			typeof parsed.baseUrl !== "string" ||
			!Number.isInteger(dimensions) ||
			dimensions === undefined ||
			dimensions <= 0 ||
			!isEmbeddingProvider(parsed.provider)
		)
			return null;
		return {
			fingerprint: parsed.fingerprint,
			provider: parsed.provider,
			model: parsed.model,
			dimensions,
			baseUrl: parsed.baseUrl,
			...(parsed.projectionSlot === "active" || parsed.projectionSlot === "staging"
				? { projectionSlot: parsed.projectionSlot }
				: {}),
			...(typeof parsed.profile === "string" ? { profile: parsed.profile } : {}),
			...(parsed.projectionRebuild === true ? { projectionRebuild: true } : {}),
		};
	} catch {
		return null;
	}
}

function isEmbeddingProvider(value: unknown): value is EmbeddingConfig["provider"] {
	return value === "native" || value === "llama-cpp" || value === "ollama" || value === "openai" || value === "none";
}

function parseState(row: EmbeddingIndexStateRow): EmbeddingIndexState | null {
	const active = parseProfile(row.active_profile_json);
	const parsedStaging = row.staging_profile_json === null ? null : parseProfile(row.staging_profile_json);
	const staging =
		parsedStaging && parsedStaging.projectionSlot === undefined
			? { ...parsedStaging, projectionSlot: "staging" as const }
			: parsedStaging;
	if (!active || (row.staging_profile_json !== null && !staging)) return null;
	if (row.state !== "ready" && row.state !== "building" && row.state !== "failed") return null;
	return { active, staging, state: row.state, lastError: row.last_error };
}

export function parseEmbeddingIndexStateRow(row: EmbeddingIndexStateRow | null): EmbeddingIndexState | null {
	return row === null ? null : parseState(row);
}

export function readEmbeddingIndexState(db: ReadDb): EmbeddingIndexState | null {
	const row = db
		.prepare(
			"SELECT active_profile_json, staging_profile_json, state, last_error FROM embedding_index_state WHERE id = 1",
		)
		.get() as EmbeddingIndexStateRow | undefined;
	return parseEmbeddingIndexStateRow(row ?? null);
}
export function ensureEmbeddingIndexState(
	db: WriteDb,
	cfg: EmbeddingConfig,
	now = new Date().toISOString(),
): EmbeddingIndexState {
	const existing = readEmbeddingIndexState(db);
	if (existing) {
		const parsed = existing;
		if (parsed) return parsed;
	}
	const rawState = db.prepare("SELECT 1 FROM embedding_index_state WHERE id = 1").get();
	if (rawState) throw new Error("Invalid embedding index state; refusing to guess an active vector space");

	const legacyConfig: EmbeddingConfig = { ...cfg, profile: undefined };
	const active = profileForStorage(legacyConfig);
	db.prepare(
		`INSERT INTO embedding_index_state
		 (id, active_profile_json, staging_profile_json, state, last_error, created_at, updated_at)
		 VALUES (1, ?, NULL, 'ready', NULL, ?, ?)`,
	).run(JSON.stringify(active), now, now);
	return { active, staging: null, state: "ready", lastError: null };
}
export function beginEmbeddingIndexBuild(
	db: WriteDb,
	cfg: EmbeddingConfig,
	now = new Date().toISOString(),
): EmbeddingIndexState {
	const current = ensureEmbeddingIndexState(db, cfg, now);
	const stagingConfig: EmbeddingConfig = {
		...cfg,
		profile: recommendedEmbeddingProfileId(cfg),
	};
	const staging = {
		...profileForStorage(stagingConfig),
		projectionSlot: current.active.projectionSlot === "staging" ? ("active" as const) : ("staging" as const),
	};
	const activeMatchesTarget = embeddingProfileFingerprintsEqual(current.active.fingerprint, staging.fingerprint);
	if (activeMatchesTarget) {
		const normalizedActive = {
			...current.active,
			fingerprint: staging.fingerprint,
			baseUrl: cfg.base_url,
		};
		db.prepare("UPDATE embedding_index_state SET active_profile_json = ? WHERE id = 1").run(
			JSON.stringify(normalizedActive),
		);
		updateProgressColumns(db, { provider_endpoint: cfg.base_url });
		if (current.state === "building") {
			if (current.staging?.projectionRebuild === true) {
				const projectionTable = staging.projectionSlot === "staging" ? "vec_embeddings_staging" : "vec_embeddings";
				db.exec("ALTER TABLE embeddings RENAME TO embeddings_next");
				db.exec("ALTER TABLE embeddings_staging RENAME TO embeddings");
				db.exec("ALTER TABLE embeddings_next RENAME TO embeddings_staging");
				db.exec(`DELETE FROM ${projectionTable}`);
			}
			db.exec("DELETE FROM embeddings_staging");
			db.prepare(
				`UPDATE embedding_index_state
				 SET staging_profile_json = NULL, state = 'ready', last_error = NULL, updated_at = ?
				 WHERE id = 1`,
			).run(now);
			updateProgressColumns(db, {
				migration_phase: null,
				progress_staged: 0,
				progress_total: 0,
				projection_cursor_last_id: null,
				projection_cursor_slot: null,
				no_progress_ticks: 0,
				provider_endpoint: cfg.base_url,
			});
			return { active: normalizedActive, staging: null, state: "ready", lastError: null };
		}
		db.prepare(
			`UPDATE embedding_index_state
			 SET staging_profile_json = NULL, state = 'ready', last_error = NULL, updated_at = ?
			 WHERE id = 1`,
		).run(now);
		updateProgressColumns(db, {
			migration_phase: null,
			progress_staged: 0,
			progress_total: 0,
			projection_cursor_last_id: null,
			projection_cursor_slot: null,
			no_progress_ticks: 0,
			provider_endpoint: cfg.base_url,
		});
		return { active: normalizedActive, staging: null, state: "ready", lastError: null };
	}
	const failure = parseFailure(current.lastError);
	if (
		current.state === "failed" &&
		current.staging !== null &&
		current.staging !== undefined &&
		embeddingProfileFingerprintsEqual(current.staging.fingerprint, staging.fingerprint) &&
		failure?.cause === "provider-unavailable" &&
		failure.nextAttemptAt !== undefined &&
		now < failure.nextAttemptAt
	)
		return current;
	if (
		current.state === "building" &&
		current.staging &&
		embeddingProfileFingerprintsEqual(current.staging.fingerprint, staging.fingerprint)
	) {
		return current;
	}

	db.exec("DELETE FROM embeddings_staging");
	let total = 0;
	try {
		total = (db.prepare("SELECT COUNT(*) AS n FROM embeddings").get() as { n?: number } | undefined)?.n ?? 0;
	} catch {}
	db.prepare(
		`UPDATE embedding_index_state
		 SET staging_profile_json = ?, state = 'building', last_error = NULL, updated_at = ?
		 WHERE id = 1`,
	).run(JSON.stringify(staging), now);
	updateProgressColumns(db, {
		migration_phase: "staging",
		progress_staged: 0,
		progress_total: total,
		projection_cursor_last_id: null,
		projection_cursor_slot: null,
		no_progress_ticks: 0,
		provider_endpoint: cfg.base_url,
	});
	return { active: current.active, staging, state: "building", lastError: null };
}

export function failEmbeddingIndexBuild(
	db: WriteDb,
	error: string,
	now = new Date().toISOString(),
	options?: { cause?: "provider-unavailable"; nextAttemptAt?: string },
): void {
	db.prepare("UPDATE embedding_index_state SET state = 'failed', last_error = ?, updated_at = ? WHERE id = 1").run(
		persistEmbeddingIndexFailure(error, options),
		now,
	);
}
