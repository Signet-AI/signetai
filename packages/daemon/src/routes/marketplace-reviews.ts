import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";

type ReviewTargetType = "skill" | "mcp";

interface MarketplaceReview {
	readonly id: string;
	readonly targetType: ReviewTargetType;
	readonly targetId: string;
	readonly displayName: string;
	readonly rating: number;
	readonly title: string;
	readonly body: string;
	readonly source: "local" | "synced";
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly syncedAt: string | null;
}

interface ReviewsSyncConfig {
	readonly enabled: boolean;
	readonly endpointUrl: string;
	readonly lastSyncAt: string | null;
	readonly lastSyncError: string | null;
}

const DEFAULT_CONFIG: ReviewsSyncConfig = {
	enabled: false,
	endpointUrl: "",
	lastSyncAt: null,
	lastSyncError: null,
};

function getAgentsDir(): string {
	return process.env.SIGNET_PATH || join(homedir(), ".agents");
}

function getMarketplaceDir(): string {
	return join(getAgentsDir(), "marketplace");
}

function getReviewsPath(): string {
	return join(getMarketplaceDir(), "reviews.json");
}

function getReviewsConfigPath(): string {
	return join(getMarketplaceDir(), "reviews-config.json");
}

function ensureMarketplaceDir(): void {
	const dir = getMarketplaceDir();
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTargetType(value: unknown): ReviewTargetType | null {
	if (value === "skill" || value === "mcp") {
		return value;
	}
	return null;
}

function parseText(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	return trimmed;
}

function parseRating(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	const rounded = Math.round(value);
	if (rounded < 1 || rounded > 5) return null;
	return rounded;
}

function normalizeReview(value: unknown): MarketplaceReview | null {
	if (!isRecord(value)) return null;
	const targetType = parseTargetType(value.targetType);
	const targetId = parseText(value.targetId);
	const displayName = parseText(value.displayName);
	const rating = parseRating(value.rating);
	const title = parseText(value.title);
	const body = parseText(value.body);
	const id = parseText(value.id);
	const createdAt = parseText(value.createdAt);
	const updatedAt = parseText(value.updatedAt);
	const source = value.source === "synced" ? "synced" : "local";
	const syncedAt = typeof value.syncedAt === "string" ? value.syncedAt : null;

	if (!targetType || !targetId || !displayName || !rating || !title || !body || !id || !createdAt || !updatedAt) {
		return null;
	}

	return {
		id,
		targetType,
		targetId,
		displayName,
		rating,
		title,
		body,
		source,
		createdAt,
		updatedAt,
		syncedAt,
	};
}

function readReviews(): MarketplaceReview[] {
	const path = getReviewsPath();
	if (!existsSync(path)) return [];
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!Array.isArray(raw)) return [];
		return raw.map(normalizeReview).filter((item): item is MarketplaceReview => item !== null);
	} catch {
		return [];
	}
}

function writeReviews(reviews: readonly MarketplaceReview[]): void {
	ensureMarketplaceDir();
	writeFileSync(getReviewsPath(), JSON.stringify(reviews, null, 2), "utf-8");
}

function readConfig(): ReviewsSyncConfig {
	const path = getReviewsConfigPath();
	if (!existsSync(path)) return DEFAULT_CONFIG;
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!isRecord(raw)) return DEFAULT_CONFIG;
		return {
			enabled: raw.enabled === true,
			endpointUrl: typeof raw.endpointUrl === "string" ? raw.endpointUrl : "",
			lastSyncAt: typeof raw.lastSyncAt === "string" ? raw.lastSyncAt : null,
			lastSyncError: typeof raw.lastSyncError === "string" ? raw.lastSyncError : null,
		};
	} catch {
		return DEFAULT_CONFIG;
	}
}

function writeConfig(config: ReviewsSyncConfig): void {
	ensureMarketplaceDir();
	writeFileSync(getReviewsConfigPath(), JSON.stringify(config, null, 2), "utf-8");
}

function parseLimit(raw: string | undefined): number {
	if (!raw) return 20;
	const value = Number(raw);
	if (!Number.isFinite(value)) return 20;
	return Math.max(1, Math.min(100, Math.round(value)));
}

function parseOffset(raw: string | undefined): number {
	if (!raw) return 0;
	const value = Number(raw);
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.round(value));
}

function summarize(reviews: readonly MarketplaceReview[]): { count: number; avgRating: number } {
	if (reviews.length === 0) return { count: 0, avgRating: 0 };
	const total = reviews.reduce((sum, item) => sum + item.rating, 0);
	return {
		count: reviews.length,
		avgRating: Number((total / reviews.length).toFixed(2)),
	};
}

export function mountMarketplaceReviewsRoutes(app: Hono): void {
	app.get("/api/marketplace/reviews", (c) => {
		const targetType = parseTargetType(c.req.query("type"));
		const targetId = parseText(c.req.query("id"));
		const limit = parseLimit(c.req.query("limit"));
		const offset = parseOffset(c.req.query("offset"));

		const allReviews = readReviews().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		const filtered = allReviews.filter((item) => {
			if (targetType && item.targetType !== targetType) return false;
			if (targetId && item.targetId !== targetId) return false;
			return true;
		});

		const page = filtered.slice(offset, offset + limit);
		return c.json({
			reviews: page,
			total: filtered.length,
			limit,
			offset,
			summary: summarize(filtered),
		});
	});

	app.post("/api/marketplace/reviews", async (c) => {
		let body: {
			targetType?: unknown;
			targetId?: unknown;
			displayName?: unknown;
			rating?: unknown;
			title?: unknown;
			body?: unknown;
		} = {};

		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const targetType = parseTargetType(body.targetType);
		const targetId = parseText(body.targetId);
		const displayName = parseText(body.displayName);
		const rating = parseRating(body.rating);
		const title = parseText(body.title);
		const reviewBody = parseText(body.body);

		if (!targetType || !targetId || !displayName || !rating || !title || !reviewBody) {
			return c.json({ error: "targetType, targetId, displayName, rating, title, and body are required" }, 400);
		}

		const now = new Date().toISOString();
		const review: MarketplaceReview = {
			id: randomUUID(),
			targetType,
			targetId,
			displayName,
			rating,
			title,
			body: reviewBody,
			source: "local",
			createdAt: now,
			updatedAt: now,
			syncedAt: null,
		};

		const reviews = readReviews();
		writeReviews([review, ...reviews]);
		return c.json({ success: true, review });
	});

	app.patch("/api/marketplace/reviews/config", async (c) => {
		let body: { enabled?: unknown; endpointUrl?: unknown } = {};
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const current = readConfig();
		const next: ReviewsSyncConfig = {
			enabled: typeof body.enabled === "boolean" ? body.enabled : current.enabled,
			endpointUrl:
				body.endpointUrl === undefined
					? current.endpointUrl
					: typeof body.endpointUrl === "string"
						? body.endpointUrl.trim()
						: current.endpointUrl,
			lastSyncAt: current.lastSyncAt,
			lastSyncError: current.lastSyncError,
		};

		writeConfig(next);
		return c.json({ success: true, config: next });
	});

	app.patch("/api/marketplace/reviews/:id", async (c) => {
		const id = c.req.param("id");
		let body: {
			displayName?: unknown;
			rating?: unknown;
			title?: unknown;
			body?: unknown;
		} = {};

		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const reviews = readReviews();
		const existing = reviews.find((item) => item.id === id);
		if (!existing) {
			return c.json({ error: "Review not found" }, 404);
		}

		const displayName = body.displayName === undefined ? existing.displayName : parseText(body.displayName);
		const rating = body.rating === undefined ? existing.rating : parseRating(body.rating);
		const title = body.title === undefined ? existing.title : parseText(body.title);
		const reviewBody = body.body === undefined ? existing.body : parseText(body.body);

		if (!displayName || !rating || !title || !reviewBody) {
			return c.json({ error: "displayName, rating, title, and body must be valid when provided" }, 400);
		}

		const updated: MarketplaceReview = {
			...existing,
			displayName,
			rating,
			title,
			body: reviewBody,
			updatedAt: new Date().toISOString(),
			syncedAt: null,
		};

		writeReviews(reviews.map((item) => (item.id === id ? updated : item)));
		return c.json({ success: true, review: updated });
	});

	app.delete("/api/marketplace/reviews/:id", (c) => {
		const id = c.req.param("id");
		const reviews = readReviews();
		if (!reviews.some((item) => item.id === id)) {
			return c.json({ error: "Review not found" }, 404);
		}

		writeReviews(reviews.filter((item) => item.id !== id));
		return c.json({ success: true, id });
	});

	app.get("/api/marketplace/reviews/config", (c) => {
		const config = readConfig();
		const pending = readReviews().filter((item) => item.syncedAt === null || item.updatedAt > item.syncedAt).length;
		return c.json({ ...config, pending });
	});

	app.post("/api/marketplace/reviews/sync", async (c) => {
		const config = readConfig();
		if (!config.enabled || config.endpointUrl.length === 0) {
			return c.json({ success: false, error: "Review sync endpoint is not configured" }, 400);
		}

		const reviews = readReviews();
		const pending = reviews.filter((item) => item.syncedAt === null || item.updatedAt > item.syncedAt);
		if (pending.length === 0) {
			return c.json({ success: true, sent: 0, synced: 0, message: "No pending reviews" });
		}

		try {
			const response = await fetch(config.endpointUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					source: "signet-marketplace",
					type: "reviews-sync",
					sentAt: new Date().toISOString(),
					reviews: pending,
				}),
			});

			if (!response.ok) {
				const errorText = `Sync endpoint returned HTTP ${response.status}`;
				writeConfig({ ...config, lastSyncError: errorText });
				return c.json({ success: false, error: errorText }, 502);
			}

			const syncedAt = new Date().toISOString();
			const pendingIds = new Set(pending.map((item) => item.id));
			const nextReviews = reviews.map((item) =>
				pendingIds.has(item.id) ? { ...item, syncedAt, source: "synced" as const } : item,
			);
			writeReviews(nextReviews);

			writeConfig({ ...config, lastSyncAt: syncedAt, lastSyncError: null });
			return c.json({ success: true, sent: pending.length, synced: pending.length, syncedAt });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			writeConfig({ ...config, lastSyncError: message });
			return c.json({ success: false, error: message }, 502);
		}
	});
}
