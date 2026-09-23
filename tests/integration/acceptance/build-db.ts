import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
// tests/ is not a bun workspace, so `@signet/core` does not resolve from
// here under a clean CI install (it only resolves locally via machine-global
// node_modules). Import the real migration runner by relative path instead —
// same code production runs, no package-name resolution involved.
import { runMigrations } from "../../../platform/core/src/migrations/index";

/**
 * Deterministic production-shaped database builder for the Phase D stability
 * acceptance harness (#1543).
 *
 * Shapes match the real deployment profile the wedge incidents (#1670/#1671)
 * were observed against: ~106k memories, ~11k transcript capture jobs with
 * full-size inline transcripts, telemetry events, and a multi-thousand-file
 * source artifact index. Sizes derive from the shipped schema: transcripts
 * live inline in transcript_capture_jobs.transcript; memory content is stored
 * at realistic sentence lengths.
 *
 * The schema itself is created by the real migration runner (runMigrations)
 * so the harness always boots against exactly what production would create.
 */

/** Fast, deterministic 32-bit PRNG (mulberry32) — same sequence every run. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const WORDS = [
	"agent",
	"memory",
	"daemon",
	"source",
	"sync",
	"embed",
	"index",
	"search",
	"transcript",
	"session",
	"pipeline",
	"extraction",
	"ontology",
	"entity",
	"aspect",
	"claim",
	"dashboard",
	"recall",
	"queue",
	"worker",
	"owner",
	"sqlite",
	"event",
	"loop",
	"latency",
	"budget",
	"pressure",
	"admission",
	"artifact",
	"tombstone",
	"lineage",
	"provenance",
	"visibility",
	"scope",
];

function sentence(rng: () => number, minLength: number): string {
	const target = minLength + Math.floor(rng() * 80);
	const parts: string[] = [];
	let length = 0;
	while (length < target) {
		const word = WORDS[Math.floor(rng() * WORDS.length)];
		if (word === undefined) break;
		parts.push(word);
		length += word.length + 1;
	}
	if (parts.length === 0) return "memory";
	const text = parts.join(" ");
	return `${text.charAt(0).toUpperCase() + text.slice(1)}.`;
}

function sentences(rng: () => number, count: number, minLength: number): string {
	const out: string[] = [];
	for (let i = 0; i < count; i++) out.push(sentence(rng, minLength));
	return out.join(" ");
}

function isoMinute(seedMs: number): string {
	// Whole-minute timestamps keep the built database byte-deterministic.
	return new Date(seedMs - (seedMs % 60_000)).toISOString();
}

export interface ProductionDbOptions {
	/** Total memories to create (default 106_000 — the real deployment scale). */
	readonly memoryCount?: number;
	/** Transcript capture jobs with full inline payloads (default 11_000). */
	readonly transcriptJobs?: number;
	/** Telemetry event rows (default 25_000). */
	readonly telemetryEvents?: number;
	/** Source file index rows in memory_artifacts (default 5_000). */
	readonly sourceFiles?: number;
	/** Deterministic seed (default 1543). */
	readonly seed?: number;
	/** Rows per insert transaction (default 2_000). */
	readonly batchSize?: number;
}

export interface ProductionDbResult {
	readonly dbPath: string;
	readonly counts: {
		readonly memories: number;
		readonly transcriptJobs: number;
		readonly telemetryEvents: number;
		readonly sourceFiles: number;
	};
	readonly buildMs: number;
}

export function buildProductionDb(dbPath: string, options: ProductionDbOptions = {}): ProductionDbResult {
	const memoryCount = options.memoryCount ?? 106_000;
	const transcriptJobs = options.transcriptJobs ?? 11_000;
	const telemetryEvents = options.telemetryEvents ?? 25_000;
	const sourceFiles = options.sourceFiles ?? 5_000;
	const seed = options.seed ?? 1543;
	const batchSize = options.batchSize ?? 2_000;

	const startedAt = Date.now();
	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");

	try {
		// Real schema, exactly as production would create it.
		runMigrations(db);

		const rng = mulberry32(seed);
		// Anchor timestamps so identical seeds produce identical data.
		const now = 1_780_000_000_000;
		const memoryTypes = ["fact", "preference", "procedure", "insight", "relationship"] as const;
		const agents = ["default", "codex", "claude-code", "hermes-agent"] as const;
		const projects = [null, "signet", "biohazard", "vault", "research"] as const;
		const jobStatuses = ["completed", "completed", "completed", "pending", "failed", "processing"] as const;

		// -- memories (+ FTS via the shipped triggers) --
		const insertMemory = db.prepare(`
			INSERT INTO memories (
				id, agent_id, type, category, content, normalized_content, content_hash,
				confidence, importance, tags, who, why, project, scope, visibility,
				created_at, updated_at, updated_by, last_accessed, access_count,
				is_deleted, extraction_status, embedding_model, memory_kind
			) VALUES (
				?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
			)
		`);
		const insertEmbedding = db.prepare(`
			INSERT OR IGNORE INTO embeddings (
				id, agent_id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		// Deterministic pseudo-random unit vector (float32 blob, 768 dims —
		// the nomic-embed-text-v1.5 profile). Values only need to be stable
		// and dense; the daemon never similarity-matches them in this
		// harness (the provider is down by design).
		const vectorBlob = (seed: number): Buffer => {
			const out = Buffer.allocUnsafe(768 * 4);
			for (let d = 0; d < 768; d++) {
				const v = Math.sin(seed * 12.9898 + d * 78.233) * 43758.5453;
				out.writeFloatLE(v - Math.floor(v), d * 4);
			}
			return out;
		};
		for (let base = 0; base < memoryCount; base += batchSize) {
			const end = Math.min(base + batchSize, memoryCount);
			db.exec("BEGIN");
			for (let i = base; i < end; i++) {
				const content = sentences(rng, 2 + Math.floor(rng() * 6), 60);
				const agent = agents[i % agents.length];
				if (agent === undefined) continue;
				const project = projects[i % projects.length];
				const createdAt = isoMinute(now - (memoryCount - i) * 45_000);
				const deleted = rng() < 0.04;
				const withEmbedding = !deleted && rng() < 0.92;
				insertMemory.run(
					`mem-${String(i).padStart(7, "0")}`,
					agent,
					memoryTypes[i % memoryTypes.length],
					i % 17 === 0 ? "work" : null,
					content,
					content.toLowerCase(),
					`sha-${agent}-${i}`,
					0.5 + rng() * 0.5,
					rng(),
					i % 11 === 0 ? '["seeded"]' : null,
					i % 13 === 0 ? "nicholai" : null,
					i % 19 === 0 ? "observed during harness shaping" : null,
					project,
					null,
					"global",
					createdAt,
					createdAt,
					"system",
					createdAt,
					Math.floor(rng() * 40),
					deleted ? 1 : 0,
					withEmbedding ? "completed" : "none",
					withEmbedding ? "nomic-embed-text-v1.5" : null,
					i % 23 === 0 ? "chunk" : "atomic",
				);
				if (withEmbedding) {
					insertEmbedding.run(
						`emb-${String(i).padStart(7, "0")}`,
						agent,
						`sha-${agent}-${i}`,
						vectorBlob(i),
						768,
						"memory",
						`mem-${String(i).padStart(7, "0")}`,
						content.slice(0, 512),
						createdAt,
					);
				}
			}
			db.exec("COMMIT");
		}

		// -- transcript_capture_jobs: transcripts inline, full-size payloads --
		const insertJob = db.prepare(`
			INSERT INTO transcript_capture_jobs (
				id, agent_id, harness, session_key, session_id, project,
				transcript, raw_transcript, transcript_path, captured_at, ended_at,
				summary_status, status, attempts, max_attempts,
				created_at, updated_at, completed_at, error
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		const harnesses = ["codex", "claude-code", "hermes-agent", "opencode"] as const;
		for (let base = 0; base < transcriptJobs; base += batchSize) {
			const end = Math.min(base + batchSize, transcriptJobs);
			db.exec("BEGIN");
			for (let i = base; i < end; i++) {
				const harness = harnesses[i % harnesses.length];
				if (harness === undefined) continue;
				const status = jobStatuses[i % jobStatuses.length];
				// Full-size payload: role-turn JSON, transcript inline, matching
				// the shipped schema where transcripts live in the jobs table.
				const turns = 24 + Math.floor(rng() * 60);
				const transcript = JSON.stringify({
					session: `sess-${String(i).padStart(6, "0")}`,
					turns: Array.from({ length: turns }, (_, t) => ({
						role: t % 2 === 0 ? "user" : "assistant",
						content: sentences(rng, 4 + Math.floor(rng() * 10), 80),
					})),
				});
				const capturedAt = isoMinute(now - (transcriptJobs - i) * 300_000);
				const terminal = status === "completed";
				insertJob.run(
					`tcj-${String(i).padStart(6, "0")}`,
					"default",
					harness,
					`sk-${harness}-${Math.floor(i / 3)}`,
					`sess-${String(i).padStart(6, "0")}`,
					i % 5 === 0 ? "signet" : null,
					transcript,
					i % 3 === 0 ? transcript : null,
					null,
					capturedAt,
					terminal ? isoMinute(new Date(capturedAt).getTime() + 240_000).slice(0, undefined) : null,
					terminal ? "done" : "not_requested",
					status,
					status === "failed" ? 3 : status === "completed" ? 1 : 0,
					5,
					capturedAt,
					capturedAt,
					terminal ? capturedAt : null,
					status === "failed" ? "simulated capture failure for harness shaping" : null,
				);
			}
			db.exec("COMMIT");
		}

		// -- telemetry_events --
		const insertTelemetry = db.prepare(`
			INSERT INTO telemetry_events (id, event, timestamp, properties, sent_to_posthog, created_at)
			VALUES (?, ?, ?, ?, ?, ?)
		`);
		const eventNames = [
			"memory_remember",
			"memory_recall",
			"session_start",
			"session_end",
			"daemon_status",
			"source_sync",
			"embedding_request",
			"error",
		] as const;
		for (let base = 0; base < telemetryEvents; base += batchSize) {
			const end = Math.min(base + batchSize, telemetryEvents);
			db.exec("BEGIN");
			for (let i = base; i < end; i++) {
				const event = eventNames[i % eventNames.length];
				if (event === undefined) continue;
				const ts = isoMinute(now - (telemetryEvents - i) * 20_000);
				insertTelemetry.run(
					`tel-${String(i).padStart(7, "0")}`,
					event,
					ts,
					JSON.stringify({ seeded: true, seq: i, harness: harnesses[i % harnesses.length] }),
					i % 4 === 0 ? 1 : 0,
					ts,
				);
			}
			db.exec("COMMIT");
		}

		// -- source file index: memory_artifacts (multi-thousand-file scale) --
		const insertArtifact = db.prepare(`
			INSERT INTO memory_artifacts (
				agent_id, source_path, source_sha256, source_kind, session_id,
				session_key, session_token, project, harness, captured_at,
				started_at, ended_at, memory_sentence, content, updated_at,
				source_mtime_ms, is_deleted
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		for (let base = 0; base < sourceFiles; base += batchSize) {
			const end = Math.min(base + batchSize, sourceFiles);
			db.exec("BEGIN");
			for (let i = base; i < end; i++) {
				const harness = harnesses[i % harnesses.length];
				if (harness === undefined) continue;
				const capturedAt = isoMinute(now - (sourceFiles - i) * 120_000);
				const content = sentences(rng, 6, 100);
				insertArtifact.run(
					"default",
					`/home/agent/.${harness}/sessions/${Math.floor(i / 250)}/${String(i).padStart(6, "0")}.jsonl`,
					`art-sha-${String(i).padStart(6, "0")}`,
					"jsonl",
					`sess-${String(i % 4000).padStart(6, "0")}`,
					`sk-${harness}-${i % 900}`,
					`tok-${String(i).padStart(6, "0")}`,
					i % 6 === 0 ? "signet" : null,
					harness,
					capturedAt,
					capturedAt,
					isoMinute(new Date(capturedAt).getTime() + 300_000).slice(0, undefined),
					sentence(rng, 40),
					content,
					capturedAt,
					new Date(capturedAt).getTime(),
					0,
				);
			}
			db.exec("COMMIT");
		}

		// Materialize FTS for the seeded memories in one deterministic pass.
		// memories_fts is an external-content table: the index is the derived
		// surface, memories is canonical.
		db.exec("INSERT INTO memories_fts(rowid, content) SELECT rowid, content FROM memories WHERE is_deleted = 0");
		db.exec(
			"UPDATE memories_fts_state SET memory_count = (SELECT COUNT(*) FROM memories), indexed_count = (SELECT COUNT(*) FROM memories WHERE is_deleted = 0), updated_at = datetime('now') WHERE id = 1",
		);

		db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		// Loud-failure check: INSERT OR IGNORE can silently drop rows (a
		// constraint mismatch once left the DB with 0 embeddings while the
		// builder reported success). Never trust the counter — count rows.
		const actual = {
			memories: db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number },
			embeddings: db.prepare("SELECT COUNT(*) AS c FROM embeddings").get() as { c: number },
			jobs: db.prepare("SELECT COUNT(*) AS c FROM transcript_capture_jobs").get() as { c: number },
			telemetry: db.prepare("SELECT COUNT(*) AS c FROM telemetry_events").get() as { c: number },
			artifacts: db.prepare("SELECT COUNT(*) AS c FROM memory_artifacts").get() as { c: number },
		};
		const mismatch: string[] = [];
		if (actual.memories.c !== memoryCount) mismatch.push(`memories ${actual.memories.c}/${memoryCount}`);
		if (actual.embeddings.c === 0 && memoryCount > 0) mismatch.push("embeddings 0 (vector NOT NULL violated?)");
		if (actual.jobs.c !== transcriptJobs) mismatch.push(`transcript jobs ${actual.jobs.c}/${transcriptJobs}`);
		if (actual.telemetry.c !== telemetryEvents) mismatch.push(`telemetry ${actual.telemetry.c}/${telemetryEvents}`);
		if (actual.artifacts.c !== sourceFiles) mismatch.push(`artifacts ${actual.artifacts.c}/${sourceFiles}`);
		if (mismatch.length > 0) {
			throw new Error(`production-shape mismatch: ${mismatch.join("; ")} — schema drifted from the builder`);
		}
		const counts = {
			memories: memoryCount,
			transcriptJobs,
			telemetryEvents,
			sourceFiles,
			embeddings: actual.embeddings.c,
		} as const;
		return { dbPath, counts, buildMs: Date.now() - startedAt };
	} finally {
		db.close();
	}
}
