/**
 * /api/ingest/* routes (#913) — the agentic Dreaming two-phase HTTP protocol.
 *
 * The agentic runner (the dreaming skill on cron, or any harness) drives
 * unified ingest over HTTP against the daemon, which stays the single writer:
 *
 *   1. POST /api/ingest/lease      — the daemon leases a batch item into
 *      `planning`, builds the shared context bundle (source + DREAMING.md +
 *      graph slice + budget), and returns it with an opaque lease token. The
 *      harness reasons over the bundle in its own turn.
 *   2. POST /api/ingest/apply-plan — the harness posts its IngestPlan back with
 *      the lease token. The daemon re-verifies the token, runs the shared
 *      deterministic apply (guards outside the model + writes + CAS complete),
 *      and returns the per-op result.
 *
 * Single-writer safety: all DB writes happen daemon-side; the CLI/skill are
 * thin HTTP clients. Overlap with the daemon runner is safe — the fenced lease
 * + per-op idempotency keep the two from double-processing.
 */

import type { Context, Hono } from "hono";
import { applyIngestPlan, type IngestApplyConfig, type IngestEmbedder } from "../pipeline/ingest/apply";
import { buildIngestContext } from "../pipeline/ingest/context";
import { parseIngestPlan, type IngestPlan } from "../pipeline/ingest/ingest-plan";
import {
	DEFAULT_PLANNING_CEILINGS,
	type PlanningCeilings,
	leaseForPlanning,
} from "../pipeline/ingest/lease";
import type { DbAccessor } from "../db-accessor";

export interface IngestRouteContext {
	readonly accessor: DbAccessor;
	readonly agentsDir: string;
	readonly getEmbedder: () => IngestEmbedder;
	/** Base apply config; sourceId is stamped per-job from the leased plan. */
	readonly applyConfigBase: Omit<IngestApplyConfig, "sourceId">;
	readonly planningLeaseTimeoutMs: number;
	readonly contextWindow?: number;
	readonly planningCeilings?: PlanningCeilings;
	/** Runtime abort (pause/cancel). */
	readonly signal?: AbortSignal;
}

function readString(record: Readonly<Record<string, unknown>>, key: string): string | null {
	const v = record[key];
	return typeof v === "string" && v.length > 0 ? v : null;
}

function readNumber(record: Readonly<Record<string, unknown>>, key: string): number | null {
	const v = record[key];
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
	return (value !== null && typeof value === "object" ? value : {}) as Record<string, unknown>;
}

function resolveAgentId(c: Context, body?: Readonly<Record<string, unknown>>): string {
	const fromBody = body ? readString(body, "agent_id") ?? readString(body, "agentId") : null;
	const fromHeader = c.req.header("x-signet-agent-id");
	return fromBody ?? fromHeader ?? "default";
}

export function registerIngestRoutes(app: Hono, buildCtx: () => IngestRouteContext): void {
	app.post("/api/ingest/lease", async (c) => {
		const ctx = buildCtx();
		const raw: unknown = await c.req.json().catch(() => null);
		if (raw === null) return c.json({ error: "Malformed JSON body" }, 400);
		const body = asRecord(raw);
		const agentId = resolveAgentId(c, body);
		// The agentic path may declare its effective window (it knows its real
		// budget; the daemon may not). Treat the declared budget as the window
		// for this lease so the bundle never silently overflows the harness.
		const declaredBudget = readNumber(body, "context_budget");
		const effectiveWindow = declaredBudget ?? ctx.contextWindow;

		const lease = ctx.accessor.withWriteTx((db) =>
			leaseForPlanning(db, {
				agentId,
				owner: c.req.header("x-signet-actor") ?? `agentic:${c.req.header("user-agent") ?? "unknown"}`,
				planningLeaseTimeoutMs: ctx.planningLeaseTimeoutMs,
				ceilings: ctx.planningCeilings ?? DEFAULT_PLANNING_CEILINGS,
			}),
		);
		if (!lease.ok) {
			return c.json({ eligible: false, jobId: null }, 200);
		}

		// Build the shared context bundle the harness reasons over.
		const contextBundle = ctx.accessor.withReadDb((db) =>
			buildIngestContext(db, {
				job: lease.job,
				agentId,
				agentsDir: ctx.agentsDir,
				contextWindow: effectiveWindow,
			}),
		);

		return c.json({
			eligible: true,
			jobId: lease.job.id,
			leaseToken: lease.leaseToken,
			leaseExpiresAt: lease.leaseExpiresAt,
			context: {
				source: contextBundle.source,
				dreamingMd: contextBundle.dreamingMd,
				graphSlice: contextBundle.graphSlice,
				focalEntityIds: contextBundle.focalEntityIds,
				budget: contextBundle.budget,
				tokens: contextBundle.tokens,
				oversize: contextBundle.oversize,
			},
		});
	});

	app.post("/api/ingest/apply-plan", async (c) => {
		const ctx = buildCtx();
		const raw: unknown = await c.req.json().catch(() => null);
		if (raw === null) return c.json({ error: "Malformed JSON body" }, 400);
		const body = asRecord(raw);
		const leaseToken = readString(body, "lease_token") ?? readString(body, "leaseToken");
		if (!leaseToken) return c.json({ error: "lease_token is required" }, 400);
		const planRaw = body.plan ?? body.plan_json;
		if (planRaw === undefined) return c.json({ error: "plan is required" }, 400);

		const parsed = parseIngestPlan(planRaw);
		if (!parsed.ok) {
			return c.json({ error: "Invalid IngestPlan", details: parsed.errors }, 400);
		}
		const plan: IngestPlan = parsed.plan;

		try {
			const result = await applyIngestPlan(
				ctx.accessor,
				plan,
				leaseToken,
				{ ...ctx.applyConfigBase, sourceId: plan.jobId },
				ctx.getEmbedder(),
			);
			return c.json(result);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return c.json({ error: message }, 500);
		}
	});

	app.get("/api/ingest/status", (c) => {
		const ctx = buildCtx();
		const agentId = resolveAgentId(c);
		const depth = ctx.accessor.withReadDb((db) => {
			const row = db
				.prepare(
					`SELECT
					 SUM(status = 'pending') AS pending,
					 SUM(status IN ('leased','planning','applying')) AS active,
					 SUM(status = 'dead') AS dead
					 FROM memory_jobs WHERE job_type = 'ingest' AND agent_id = ?`,
				)
				.get(agentId) as { pending: number; active: number; dead: number };
			return row;
		});
		return c.json({ agentId, queue: depth });
	});
}
