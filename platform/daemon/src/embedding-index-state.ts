import { DEFAULT_EMBEDDING_DIMENSIONS } from "@signet/core";
import type { ReadDb, WriteDb } from "./db-accessor";
import { embeddingProfileFingerprint, recommendedEmbeddingProfileId } from "./embedding-profile";
import type { EmbeddingConfig } from "./memory-config";

export type EmbeddingIndexBuildState = "ready" | "building" | "failed";

export interface PersistedEmbeddingProfile {
	readonly fingerprint: string;
	readonly provider: EmbeddingConfig["provider"];
	readonly model: string;
	readonly dimensions: number;
	readonly baseUrl: string;
	readonly profile?: string;
}

export interface EmbeddingIndexState {
	readonly active: PersistedEmbeddingProfile;
	readonly staging: PersistedEmbeddingProfile | null;
	readonly state: EmbeddingIndexBuildState;
	readonly lastError: string | null;
}

interface StateRow {
	readonly active_profile_json: string;
	readonly staging_profile_json: string | null;
	readonly state: EmbeddingIndexBuildState;
	readonly last_error: string | null;
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

export function resolveActiveEmbeddingConfig(db: ReadDb, configured: EmbeddingConfig): EmbeddingConfig {
	if (configured.profile) return configured;
	const active = readEmbeddingIndexState(db)?.active;
	if (!active) return configured;
	return {
		...configured,
		provider: active.provider,
		model: active.model,
		dimensions: active.dimensions,
		base_url: active.baseUrl,
		...(active.profile ? { profile: active.profile } : { profile: undefined }),
	};
}

/** True only while `cfg` still describes the generation that owns active recall. */
export function isActiveEmbeddingConfig(db: ReadDb, cfg: EmbeddingConfig): boolean {
	const state = readEmbeddingIndexState(db);
	// Lightweight/test databases that have run schema migrations but not daemon
	// initialization cannot be mid-promotion. Preserve their legacy behavior;
	// a running daemon always seeds this singleton before any worker starts.
	if (!state) return true;
	return embeddingProfileFingerprint(cfg) === state.active.fingerprint;
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
			// `Number.isInteger` does not narrow `number | undefined` for TypeScript.
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
			...(typeof parsed.profile === "string" ? { profile: parsed.profile } : {}),
		};
	} catch {
		return null;
	}
}

function isEmbeddingProvider(value: unknown): value is EmbeddingConfig["provider"] {
	return value === "native" || value === "llama-cpp" || value === "ollama" || value === "openai" || value === "none";
}

function parseState(row: StateRow): EmbeddingIndexState | null {
	const active = parseProfile(row.active_profile_json);
	const staging = row.staging_profile_json === null ? null : parseProfile(row.staging_profile_json);
	if (!active || (row.staging_profile_json !== null && !staging)) return null;
	if (row.state !== "ready" && row.state !== "building" && row.state !== "failed") return null;
	return { active, staging, state: row.state, lastError: row.last_error };
}

export function readEmbeddingIndexState(db: ReadDb): EmbeddingIndexState | null {
	const row = db
		.prepare(
			"SELECT active_profile_json, staging_profile_json, state, last_error FROM embedding_index_state WHERE id = 1",
		)
		.get() as StateRow | undefined;
	return row ? parseState(row) : null;
}

/**
 * Initialise the singleton with the legacy raw-text profile. This deliberately
 * does not infer a new formatter from the model name: existing vectors were
 * created from raw input and must keep their matching query transform until a
 * staged generation has rebuilt them.
 */
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

/** Start (or resume) the inactive generation without changing active recall. */
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
	const staging = profileForStorage(stagingConfig);
	if (current.state === "building" && current.staging?.fingerprint === staging.fingerprint) return current;
	if (current.active.fingerprint === staging.fingerprint) {
		// The configured profile IS the active generation: nothing to build.
		// If a build of a different generation is in flight (the live config
		// flipped back to the active profile mid-build, #1160), abandon it
		// instead of promoting a generation the config no longer wants.
		if (current.state === "building") {
			db.exec("DELETE FROM embeddings_staging");
			db.prepare(
				`UPDATE embedding_index_state
				 SET staging_profile_json = NULL, state = 'ready', last_error = NULL, updated_at = ?
				 WHERE id = 1`,
			).run(now);
			return { active: current.active, staging: null, state: "ready", lastError: null };
		}
		return current;
	}

	db.exec("DELETE FROM embeddings_staging");
	db.prepare(
		`UPDATE embedding_index_state
		 SET staging_profile_json = ?, state = 'building', last_error = NULL, updated_at = ?
		 WHERE id = 1`,
	).run(JSON.stringify(staging), now);
	return { active: current.active, staging, state: "building", lastError: null };
}

export function failEmbeddingIndexBuild(db: WriteDb, error: string, now = new Date().toISOString()): void {
	db.prepare("UPDATE embedding_index_state SET state = 'failed', last_error = ?, updated_at = ? WHERE id = 1").run(
		error,
		now,
	);
}
