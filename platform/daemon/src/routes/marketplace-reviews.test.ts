import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountMarketplaceReviewsRoutes } from "./marketplace-reviews.js";

describe("marketplace reviews routes", () => {
	const tmpAgentsDir = join(tmpdir(), `signet-marketplace-reviews-route-test-${process.pid}`);
	const originalFetch = globalThis.fetch;
	let origSignetPath: string | undefined;
	let app: Hono;

	beforeEach(() => {
		origSignetPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = tmpAgentsDir;
		mkdirSync(tmpAgentsDir, { recursive: true });

		app = new Hono();
		mountMarketplaceReviewsRoutes(app);
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		process.env.SIGNET_PATH = origSignetPath;
		if (existsSync(tmpAgentsDir)) {
			rmSync(tmpAgentsDir, { recursive: true, force: true });
		}
	});

	it("creates and lists reviews for a target", async () => {
		const createRes = await app.request("/api/marketplace/reviews", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				targetType: "skill",
				targetId: "skills.sh/foo",
				displayName: "avery",
				rating: 5,
				title: "Great",
				body: "Does the job",
			}),
		});

		expect(createRes.status).toBe(200);
		const createBody = (await createRes.json()) as { success: boolean };
		expect(createBody.success).toBe(true);

		const listRes = await app.request("/api/marketplace/reviews?type=skill&id=skills.sh%2Ffoo");
		expect(listRes.status).toBe(200);
		const listBody = (await listRes.json()) as {
			reviews: Array<{ targetType: string; targetId: string; rating: number }>;
			total: number;
			summary: { count: number; avgRating: number };
		};

		expect(listBody.total).toBe(1);
		expect(listBody.reviews[0]?.targetType).toBe("skill");
		expect(listBody.reviews[0]?.targetId).toBe("skills.sh/foo");
		expect(listBody.summary.count).toBe(1);
		expect(listBody.summary.avgRating).toBe(5);
	});

	it("updates review sync config", async () => {
		const patchRes = await app.request("/api/marketplace/reviews/config", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ enabled: true, endpointUrl: "https://example.com/reviews" }),
		});

		expect(patchRes.status).toBe(200);
		const patchBody = (await patchRes.json()) as {
			success: boolean;
			config: { enabled: boolean; endpointUrl: string };
		};
		expect(patchBody.success).toBe(true);
		expect(patchBody.config.enabled).toBe(true);
		expect(patchBody.config.endpointUrl).toBe("https://example.com/reviews");
	});

	it("preserves pending reviews when the sync endpoint returns a failure", async () => {
		await app.request("/api/marketplace/reviews", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				targetType: "skill",
				targetId: "skills.sh/failing",
				displayName: "avery",
				rating: 4,
				title: "Needs retry",
				body: "The downstream endpoint is unavailable",
			}),
		});
		await app.request("/api/marketplace/reviews/config", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ enabled: true, endpointUrl: "https://example.com/reviews" }),
		});

		globalThis.fetch = mock(() => Promise.resolve(new Response(null, { status: 503 }))) as unknown as typeof fetch;
		const syncRes = await app.request("/api/marketplace/reviews/sync", { method: "POST" });
		expect(syncRes.status).toBe(502);
		const syncBody = (await syncRes.json()) as { success: boolean; error: string };
		expect(syncBody.success).toBe(false);
		expect(syncBody.error).toContain("pending reviews were preserved for retry");

		const configRes = await app.request("/api/marketplace/reviews/config");
		const configBody = (await configRes.json()) as { pending: number; lastSyncError: string | null };
		expect(configBody.pending).toBe(1);
		expect(configBody.lastSyncError).toBe(syncBody.error);
	});

	it("preserves pending reviews when the sync request times out", async () => {
		await app.request("/api/marketplace/reviews", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				targetType: "mcp",
				targetId: "mcp/failing",
				displayName: "avery",
				rating: 3,
				title: "Slow",
				body: "The downstream endpoint timed out",
			}),
		});
		await app.request("/api/marketplace/reviews/config", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ enabled: true, endpointUrl: "https://example.com/reviews" }),
		});

		let receivedSignal: AbortSignal | undefined;
		globalThis.fetch = mock((_input: string | URL | Request, init?: RequestInit) => {
			receivedSignal = init?.signal ?? undefined;
			return Promise.reject(new DOMException("The operation was aborted", "TimeoutError"));
		}) as unknown as typeof fetch;
		const syncRes = await app.request("/api/marketplace/reviews/sync", { method: "POST" });
		expect(syncRes.status).toBe(502);
		const syncBody = (await syncRes.json()) as { success: boolean; error: string };
		expect(syncBody.success).toBe(false);
		expect(syncBody.error).toContain("timed out after 15 seconds");
		expect(syncBody.error).toContain("pending reviews were preserved for retry");
		expect(receivedSignal).toBeInstanceOf(AbortSignal);

		const listRes = await app.request("/api/marketplace/reviews");
		const listBody = (await listRes.json()) as { reviews: Array<{ syncedAt: string | null }> };
		expect(listBody.reviews[0]?.syncedAt).toBeNull();
	});

	it("preserves pending reviews after a thrown failure and allows retry", async () => {
		await app.request("/api/marketplace/reviews", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				targetType: "skill",
				targetId: "skills.sh/retry",
				displayName: "avery",
				rating: 5,
				title: "Retry",
				body: "A later attempt should be able to send this review",
			}),
		});
		await app.request("/api/marketplace/reviews/config", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ enabled: true, endpointUrl: "https://example.com/reviews" }),
		});

		let calls = 0;
		globalThis.fetch = mock(() => {
			calls += 1;
			return calls === 1 ? Promise.reject(new TypeError("fetch failed")) : Promise.resolve(Response.json({ ok: true }));
		}) as unknown as typeof fetch;

		const failedRes = await app.request("/api/marketplace/reviews/sync", { method: "POST" });
		expect(failedRes.status).toBe(502);
		const failedBody = (await failedRes.json()) as { error: string };
		expect(failedBody.error).toContain("Review sync failed: fetch failed");

		const retryRes = await app.request("/api/marketplace/reviews/sync", { method: "POST" });
		expect(retryRes.status).toBe(200);
		expect(calls).toBe(2);
		const retryBody = (await retryRes.json()) as { sent: number; synced: number };
		expect(retryBody.sent).toBe(1);
		expect(retryBody.synced).toBe(1);
	});

	it("serializes concurrent sync attempts for one workspace", async () => {
		await app.request("/api/marketplace/reviews", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				targetType: "skill",
				targetId: "skills.sh/concurrent",
				displayName: "avery",
				rating: 5,
				title: "Concurrent",
				body: "Only one downstream batch should be sent",
			}),
		});
		await app.request("/api/marketplace/reviews/config", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ enabled: true, endpointUrl: "https://example.com/reviews" }),
		});

		let calls = 0;
		let markStarted: (() => void) | undefined;
		let releaseResponse: ((response: Response) => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const response = new Promise<Response>((resolve) => {
			releaseResponse = resolve;
		});
		globalThis.fetch = mock(() => {
			calls += 1;
			markStarted?.();
			return response;
		}) as unknown as typeof fetch;

		const first = app.request("/api/marketplace/reviews/sync", { method: "POST" });
		await started;
		const second = app.request("/api/marketplace/reviews/sync", { method: "POST" });
		await Bun.sleep(0);
		expect(calls).toBe(1);

		releaseResponse?.(Response.json({ ok: true }));
		const [firstRes, secondRes] = await Promise.all([first, second]);
		expect(firstRes.status).toBe(200);
		expect(secondRes.status).toBe(200);
		expect(calls).toBe(1);
		const firstBody = (await firstRes.json()) as { sent: number; synced: number };
		const secondBody = (await secondRes.json()) as { sent: number; synced: number };
		expect(firstBody.sent + secondBody.sent).toBe(1);
		expect(firstBody.synced + secondBody.synced).toBe(1);
	});
});
