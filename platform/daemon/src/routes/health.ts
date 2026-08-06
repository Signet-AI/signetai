import type { SQLQueryBindings } from "bun:sqlite";
import { type MigrationDb, hasPendingMigrations } from "@signet/core";
import type { Hono } from "hono";
import { type ReadDb, getDbAccessor } from "../db-accessor";
import {
	QUEUE_MAX_DEAD_RATE,
	QUEUE_MAX_DEPTH,
	QUEUE_MAX_OLDEST_AGE_SEC,
	type QueueHealth,
	getQueueHealth,
} from "../diagnostics";
import { getAllFeatureFlags } from "../feature-flags";
import { loadMemoryConfig } from "../memory-config";
import { getResourceSnapshot } from "../resource-monitor";
import { getUpdateState } from "../update-system";
import {
	AGENTS_DIR,
	CURRENT_VERSION,
	PORT,
	authConfig,
	getCurrentAgentsDir,
	getExtractionWorkloadState,
	providerRuntimeResolution,
	shuttingDown,
} from "./state.js";
import { checkEmbeddingProvider } from "./utils";

// Native/ollama embedding probes do network or model work; a probe must never
// block the event loop on the /health path (see
// .github/workflows/embedding-health-isolation.yml).
const EMBEDDING_CHECK_TIMEOUT_MS = 2000;

function toRecordOrUndefined(row: unknown): Record<string, unknown> | undefined {
	return typeof row === "object" && row !== null ? (row as Record<string, unknown>) : undefined;
}

/**
 * Adapt the accessor's readonly db to the MigrationDb surface.
 * This is read-only: hasPendingMigrations only reads schema_migrations.
 * The exec/run methods exist to satisfy the MigrationDb interface but will
 * throw on the readonly accessor if ever used for writes. Do not add write
 * calls through this adapter.
 */
function readDbAsMigrationDb(db: ReadDb): MigrationDb {
	return {
		exec(sql: string): void {
			db.prepare(sql).run();
		},
		prepare(sql: string) {
			const stmt = db.prepare(sql);
			return {
				run(...args: SQLQueryBindings[]): void {
					stmt.run(...args);
				},
				get(...args: SQLQueryBindings[]): Record<string, unknown> | undefined {
					return toRecordOrUndefined(stmt.get(...args));
				},
				all(...args: SQLQueryBindings[]): Record<string, unknown>[] {
					return stmt
						.all(...args)
						.map((row) => toRecordOrUndefined(row))
						.filter((row): row is Record<string, unknown> => row !== undefined);
				},
			};
		},
	};
}

async function withTimeout<T>(promise: Promise<T>, ms: number, timeoutError: Error): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(timeoutError), ms);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

interface EmbeddingCheck {
	readonly provider: string;
	readonly available: boolean;
	readonly note?: string;
	readonly error?: string;
	readonly checkedAt?: string;
}

/** Embedding gates readiness when a provider is configured; "none" means intentionally disabled. */
async function checkEmbedding(): Promise<{ ok: boolean; detail: EmbeddingCheck; reason: string | null }> {
	let cfg: ReturnType<typeof loadMemoryConfig>["embedding"];
	try {
		cfg = loadMemoryConfig(getCurrentAgentsDir()).embedding;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			detail: { provider: "unknown", available: false, error: msg },
			reason: `embedding config unavailable: ${msg}`,
		};
	}

	if (cfg.provider === "none") {
		return { ok: true, detail: { provider: "none", available: true, note: "disabled" }, reason: null };
	}

	try {
		const status = await withTimeout(
			checkEmbeddingProvider(cfg),
			EMBEDDING_CHECK_TIMEOUT_MS,
			new Error("embedding check timed out"),
		);
		if (status.available) {
			return {
				ok: true,
				detail: { provider: status.provider, available: true, checkedAt: status.checkedAt },
				reason: null,
			};
		}
		const err = status.error ?? "provider unreachable";
		return {
			ok: false,
			detail: { provider: status.provider, available: false, error: err, checkedAt: status.checkedAt },
			reason: `embedding provider ${status.provider} unavailable: ${err}`,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			detail: { provider: cfg.provider, available: false, error: msg },
			reason: msg === "embedding check timed out" ? msg : `embedding provider ${cfg.provider} unavailable: ${msg}`,
		};
	}
}

interface InferenceCheck {
	readonly status: string;
	readonly configured: string | null;
	readonly effective: string;
	readonly reason: string | null;
}

/** Inference gates readiness only when the extraction route is fully blocked; degraded still serves. */
function checkInference(): { ok: boolean; detail: InferenceCheck; reason: string | null } {
	let cfg: ReturnType<typeof loadMemoryConfig>;
	try {
		cfg = loadMemoryConfig(getCurrentAgentsDir());
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			detail: { status: "unknown", configured: null, effective: "none", reason: msg },
			reason: `inference config unavailable: ${msg}`,
		};
	}
	const extraction = getExtractionWorkloadState({
		enabled: false,
		paused: cfg.pipelineV2.paused,
	});
	const detail: InferenceCheck = {
		status: extraction.status,
		configured: extraction.configured,
		effective: extraction.effective,
		reason: extraction.reason,
	};
	if (extraction.status === "blocked") {
		return {
			ok: false,
			detail,
			reason: `inference route blocked: ${extraction.reason ?? "no available extraction provider"}`,
		};
	}
	return { ok: true, detail, reason: null };
}

export function mountHealthRoutes(app: Hono): void {
	app.get("/health", (c) => {
		const us = getUpdateState();
		let dbOk = false;
		try {
			getDbAccessor().withReadDb((db) => {
				db.prepare("SELECT 1").get();
				dbOk = true;
			});
		} catch {}

		return c.json({
			status: shuttingDown ? "shutting_down" : "healthy",
			uptime: process.uptime(),
			pid: process.pid,
			version: CURRENT_VERSION,
			port: PORT,
			agentsDir: AGENTS_DIR,
			db: dbOk,
			shuttingDown,
			updateAvailable: us.lastCheck?.updateAvailable ?? false,
			pendingRestart: us.pendingRestartVersion !== null,
			resources: getResourceSnapshot(),
		});
	});

	// Cheap liveness: process is up. Never touches db or subsystems, always 200.
	app.get("/health/live", (c) => {
		return c.json({
			status: shuttingDown ? "shutting_down" : "healthy",
			uptime: process.uptime(),
			pid: process.pid,
			version: CURRENT_VERSION,
			port: PORT,
			shuttingDown,
		});
	});

	// Readiness: composed per-check results. 200 only when every gate passes.
	app.get("/health/ready", async (c) => {
		const reasons: string[] = [];

		// db, migrations, and queue share one readonly connection.
		let dbResult: { readonly migrationsOk: boolean; readonly queueHealth: QueueHealth } | null = null;
		try {
			dbResult = getDbAccessor().withReadDb((db) => {
				db.prepare("SELECT 1").get();
				return {
					migrationsOk: !hasPendingMigrations(readDbAsMigrationDb(db)),
					queueHealth: getQueueHealth(db),
				};
			});
		} catch (err) {
			reasons.push(`database unavailable: ${err instanceof Error ? err.message : String(err)}`);
		}
		const dbOk = dbResult !== null;
		const migrationsOk = dbResult?.migrationsOk ?? false;
		if (dbOk && !migrationsOk) {
			reasons.push("pending migrations");
		}
		const queueHealth = dbResult?.queueHealth ?? null;
		if (queueHealth !== null) {
			if (queueHealth.depth > QUEUE_MAX_DEPTH) {
				reasons.push(`queue backlog depth ${queueHealth.depth} exceeds ${QUEUE_MAX_DEPTH}`);
			}
			if (queueHealth.deadRate > QUEUE_MAX_DEAD_RATE) {
				reasons.push(`queue dead-letter rate ${queueHealth.deadRate.toFixed(4)} exceeds ${QUEUE_MAX_DEAD_RATE}`);
			}
			if (queueHealth.oldestAgeSec > QUEUE_MAX_OLDEST_AGE_SEC) {
				reasons.push(
					`queue oldest pending job age ${Math.round(queueHealth.oldestAgeSec)}s exceeds ${QUEUE_MAX_OLDEST_AGE_SEC}s`,
				);
			}
		}
		const queue: QueueHealth | { readonly error: string } = queueHealth ?? { error: "database unavailable" };

		const embedding = await checkEmbedding();
		if (embedding.reason !== null) reasons.push(embedding.reason);

		const inference = checkInference();
		if (inference.reason !== null) reasons.push(inference.reason);

		if (shuttingDown) reasons.push("shutting_down");

		const ready = reasons.length === 0;
		return c.json(
			{
				status: ready ? "ready" : "not_ready",
				version: CURRENT_VERSION,
				shuttingDown,
				checks: {
					db: dbOk,
					migrations: migrationsOk,
					embedding: embedding.detail,
					inference: inference.detail,
					queue,
				},
				reasons,
			},
			ready ? 200 : 503,
		);
	});

	app.get("/api/features", (c) => {
		return c.json(getAllFeatureFlags());
	});

	// Environment probe (issue #1001): deliberately lightweight and
	// unauthenticated so the dashboard can distinguish "talking to a real
	// daemon" (any hostname: localhost, Tailscale, .local, tunnel, LAN IP)
	// from the marketing site or cloud app. `mode` reflects the daemon's
	// auth mode; `requiresAuth` reflects whether data endpoints require a
	// token in that mode.
	app.get("/api/mode", (c) => {
		return c.json({ mode: authConfig.mode, requiresAuth: authConfig.mode !== "local" });
	});
}
