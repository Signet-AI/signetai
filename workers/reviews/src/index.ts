/**
 * Signet Reviews Worker
 *
 * Central aggregation endpoint for marketplace reviews.
 * Receives synced reviews from user daemons and serves them publicly.
 *
 * Routes:
 *   GET  /              - health check
 *   GET  /api/reviews   - list/query reviews (public, cached)
 *   POST /api/reviews/sync - batch upsert from signetai daemon
 */

export interface Env {
	DB: D1Database;
	RATE_LIMITER: { limit(opts: { key: string }): Promise<{ success: boolean }> };
	CORS_ORIGIN: string;
}

interface ReviewRow {
	id: string;
	target_type: "skill" | "mcp";
	target_id: string;
	display_name: string;
	rating: number;
	title: string;
	body: string;
	created_at: string;
	updated_at: string;
	received_at: string;
}

interface IncomingReview {
	id: string;
	targetType: "skill" | "mcp";
	targetId: string;
	displayName: string;
	rating: number;
	title: string;
	body: string;
	createdAt: string;
	updatedAt: string;
}

// Validation limits
const LIMITS = {
	BATCH_SIZE: 100,
	TARGET_ID: 200,
	DISPLAY_NAME: 50,
	TITLE: 100,
	BODY: 2_000,
	BODY_MIN: 10,
	TITLE_MIN: 3,
	REQUEST_BODY_BYTES: 512_000,
} as const;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function parseStr(value: unknown, min: number, max: number): string | null {
	if (typeof value !== "string") return null;
	const t = value.trim();
	if (t.length < min || t.length > max) return null;
	return t;
}

function parseTargetType(v: unknown): "skill" | "mcp" | null {
	if (v === "skill" || v === "mcp") return v;
	return null;
}

function parseRating(v: unknown): number | null {
	if (typeof v !== "number" || !Number.isFinite(v)) return null;
	const r = Math.round(v);
	if (r < 1 || r > 5) return null;
	return r;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseUUID(v: unknown): string | null {
	if (typeof v !== "string" || !UUID_RE.test(v)) return null;
	return v.toLowerCase();
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function parseTimestamp(v: unknown): string | null {
	if (typeof v !== "string" || !ISO_RE.test(v)) return null;
	const ts = new Date(v).getTime();
	if (isNaN(ts)) return null;
	if (ts > Date.now() + 30 * 24 * 60 * 60 * 1_000) return null;
	return v;
}

function validateReview(raw: unknown): IncomingReview | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;

	const id = parseUUID(r["id"]);
	const targetType = parseTargetType(r["targetType"]);
	const targetId = parseStr(r["targetId"], 1, LIMITS.TARGET_ID);
	const displayName = parseStr(r["displayName"], 1, LIMITS.DISPLAY_NAME);
	const rating = parseRating(r["rating"]);
	const title = parseStr(r["title"], LIMITS.TITLE_MIN, LIMITS.TITLE);
	const body = parseStr(r["body"], LIMITS.BODY_MIN, LIMITS.BODY);
	const createdAt = parseTimestamp(r["createdAt"]);
	const updatedAt = parseTimestamp(r["updatedAt"]);

	if (
		!id ||
		!targetType ||
		!targetId ||
		!displayName ||
		rating === null ||
		!title ||
		!body ||
		!createdAt ||
		!updatedAt
	) {
		return null;
	}

	return { id, targetType, targetId, displayName, rating, title, body, createdAt, updatedAt };
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

function corsHeaders(origin: string): Record<string, string> {
	return {
		"Access-Control-Allow-Origin": origin,
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type, X-Signet-Sync",
		"Access-Control-Max-Age": "86400",
	};
}

function isOriginAllowed(origin: string | null, allowed: string): boolean {
	if (allowed === "*") return true;
	// No Origin header = server-to-server (daemon sync). Allow.
	if (!origin) return true;
	if (origin === allowed) return true;
	try {
		const u = new URL(origin);
		if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return true;
	} catch {
		// ignore
	}
	return false;
}

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json;charset=UTF-8", ...extra },
	});
}

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------

function rowToPublic(row: ReviewRow) {
	return {
		id: row.id,
		targetType: row.target_type,
		targetId: row.target_id,
		displayName: row.display_name,
		rating: row.rating,
		title: row.title,
		body: row.body,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

async function upsertReviews(
	db: D1Database,
	reviews: IncomingReview[],
	receivedAt: string,
): Promise<{ accepted: number; rejected: number }> {
	const stmts = reviews.map((r) =>
		db
			.prepare(
				`INSERT INTO reviews
				   (id, target_type, target_id, display_name, rating, title, body,
				    created_at, updated_at, received_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
				   display_name = excluded.display_name,
				   rating       = excluded.rating,
				   title        = excluded.title,
				   body         = excluded.body,
				   updated_at   = excluded.updated_at,
				   received_at  = excluded.received_at
				 WHERE excluded.updated_at >= reviews.updated_at`,
			)
			.bind(
				r.id,
				r.targetType,
				r.targetId,
				r.displayName,
				r.rating,
				r.title,
				r.body,
				r.createdAt,
				r.updatedAt,
				receivedAt,
			),
	);

	const results = await db.batch(stmts);
	let accepted = 0;
	let rejected = 0;
	for (const res of results) {
		if (res.success) accepted++;
		else rejected++;
	}
	return { accepted, rejected };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseIntParam(v: string | null, min: number, max: number, def: number): number {
	if (!v) return def;
	const n = parseInt(v, 10);
	if (!Number.isFinite(n)) return def;
	return Math.max(min, Math.min(max, n));
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleGetReviews(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
	const url = new URL(request.url);
	const type = url.searchParams.get("type");
	const id = url.searchParams.get("id");
	const limit = parseIntParam(url.searchParams.get("limit"), 1, 50, 20);
	const offset = parseIntParam(url.searchParams.get("offset"), 0, 100_000, 0);

	const conditions: string[] = [];
	const bindings: (string | number)[] = [];

	if (type === "skill" || type === "mcp") {
		conditions.push("target_type = ?");
		bindings.push(type);
	}
	if (id) {
		conditions.push("target_id = ?");
		bindings.push(id.slice(0, LIMITS.TARGET_ID));
	}

	const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

	const batch = await env.DB.batch([
		env.DB.prepare(
			`SELECT id, target_type, target_id, display_name, rating, title, body,
			        created_at, updated_at
			 FROM reviews ${where}
			 ORDER BY updated_at DESC
			 LIMIT ? OFFSET ?`,
		).bind(...bindings, limit, offset),
		env.DB.prepare(
			`SELECT COUNT(*) as total, AVG(rating) as avg_rating
			 FROM reviews ${where}`,
		).bind(...bindings),
	]);

	const rows = (batch[0]?.results ?? []) as ReviewRow[];
	const summary = (batch[1]?.results?.[0] ?? { total: 0, avg_rating: 0 }) as {
		total: number;
		avg_rating: number | null;
	};

	return json(
		{
			reviews: rows.map(rowToPublic),
			total: summary.total,
			limit,
			offset,
			summary: {
				count: summary.total,
				avgRating: summary.avg_rating != null ? Math.round(summary.avg_rating * 10) / 10 : 0,
			},
		},
		200,
		{ ...cors, "Cache-Control": "public, max-age=30, stale-while-revalidate=60" },
	);
}

async function handleSync(
	request: Request,
	env: Env,
	cors: Record<string, string>,
	clientIp: string,
): Promise<Response> {
	const { success: allowed } = await env.RATE_LIMITER.limit({ key: clientIp });
	if (!allowed) {
		return json({ error: "rate limit exceeded" }, 429, { ...cors, "Retry-After": "60" });
	}

	if (request.headers.get("X-Signet-Sync") !== "1") {
		return json({ error: "missing required header" }, 400, cors);
	}

	const ct = request.headers.get("Content-Type") ?? "";
	if (!ct.includes("application/json")) {
		return json({ error: "Content-Type must be application/json" }, 415, cors);
	}

	const buf = await request.arrayBuffer();
	if (buf.byteLength > LIMITS.REQUEST_BODY_BYTES) {
		return json({ error: "request body too large" }, 413, cors);
	}

	let payload: unknown;
	try {
		payload = JSON.parse(new TextDecoder().decode(buf));
	} catch {
		return json({ error: "invalid JSON" }, 400, cors);
	}

	if (
		typeof payload !== "object" ||
		payload === null ||
		(payload as Record<string, unknown>)["source"] !== "signet-marketplace" ||
		(payload as Record<string, unknown>)["type"] !== "reviews-sync"
	) {
		return json({ error: "invalid sync payload" }, 400, cors);
	}

	const raw = (payload as Record<string, unknown>)["reviews"];
	if (!Array.isArray(raw)) {
		return json({ error: "'reviews' must be an array" }, 400, cors);
	}
	if (raw.length > LIMITS.BATCH_SIZE) {
		return json({ error: `batch too large, max ${LIMITS.BATCH_SIZE}` }, 400, cors);
	}

	const valid: IncomingReview[] = [];
	let skipped = 0;
	for (const item of raw) {
		const r = validateReview(item);
		if (r) valid.push(r);
		else skipped++;
	}

	if (valid.length === 0) {
		return json({ error: "no valid reviews in batch", skipped }, 400, cors);
	}

	const receivedAt = new Date().toISOString();
	try {
		const { accepted, rejected } = await upsertReviews(env.DB, valid, receivedAt);
		return json({ success: true, accepted, rejected, skipped, receivedAt }, 200, cors);
	} catch {
		return json({ error: "storage error" }, 500, cors);
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const method = request.method.toUpperCase();

		const origin = request.headers.get("Origin");
		const allowed = isOriginAllowed(origin, env.CORS_ORIGIN);
		const cors = allowed ? corsHeaders(origin ?? env.CORS_ORIGIN) : {};

		if (method === "OPTIONS") {
			return new Response(null, {
				status: 204,
				headers: allowed ? corsHeaders(origin ?? env.CORS_ORIGIN) : { "Content-Length": "0" },
			});
		}

		if (!allowed && method !== "GET") {
			return json({ error: "forbidden" }, 403, {});
		}

		const path = url.pathname.replace(/\/+$/, "") || "/";

		if (path === "/" && method === "GET") {
			return json({ ok: true, service: "signet-reviews" }, 200, cors);
		}

		if (path === "/api/reviews" && method === "GET") {
			return handleGetReviews(request, env, cors);
		}

		if (path === "/api/reviews/sync" && method === "POST") {
			const ip =
				request.headers.get("CF-Connecting-IP") ??
				request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
				"unknown";
			return handleSync(request, env, cors, ip);
		}

		return json({ error: "not found" }, 404, cors);
	},
} satisfies ExportedHandler<Env>;
