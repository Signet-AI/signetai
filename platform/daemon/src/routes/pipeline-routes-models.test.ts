import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { registerPipelineRoutes } from "./pipeline-routes";

function makeApp(): Hono {
	const app = new Hono();
	registerPipelineRoutes(app);
	return app;
}

describe("pipeline model routes", () => {
	it("serves checked ACPX model presets from the static catalog", async () => {
		const app = makeApp();
		const res = await app.request("/api/pipeline/models?provider=acpx");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			models: Array<{ id: string; provider: string; deprecated?: boolean }>;
			registry: { initialized: boolean; modelCounts: Record<string, number> };
		};
		expect(body.registry.initialized).toBe(true);
		expect(body.registry.modelCounts.acpx).toBe(body.models.length);
		expect(body.models.every((model) => model.provider === "acpx")).toBe(true);
		const ids = body.models.map((model) => model.id);
		expect(ids).toContain("gpt-5.4-mini");
		expect(ids).toContain("haiku");
		expect(ids).toContain("google/gemini-2.5-flash");
		expect(ids).not.toContain("gpt-5-codex");
		expect(ids).not.toContain("gpt-5-codex-mini");
	});

	it("groups ACPX and Codex models through /api/pipeline/models/by-provider", async () => {
		const app = makeApp();
		const res = await app.request("/api/pipeline/models/by-provider");
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, Array<{ id: string }>>;
		expect(body.codex.map((model) => model.id)).toEqual([
			"gpt-5.4-mini",
			"gpt-5.4",
			"gpt-5.5",
			"gpt-5.3-codex",
			"gpt-5.3-codex-spark",
			"gpt-5.2",
		]);
		expect(body.acpx.map((model) => model.id)).toContain("gpt-5.4-mini");
	});

	it("returns an empty list for inherited provider names", async () => {
		const app = makeApp();
		const res = await app.request("/api/pipeline/models?provider=constructor");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { models: Array<{ id: string }> };
		expect(body.models).toEqual([]);
	});
});
