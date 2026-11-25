import { afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createConcurrencyAdmission } from "../concurrency-admission";
import { type TelemetryCollector, type TelemetryEvent, setActiveTelemetry } from "../telemetry";
import { createMemoryCaptureAdmissionMiddleware, registerMemoryRoutes } from "./memory-routes";

function captureTelemetry(): { readonly collector: TelemetryCollector; readonly events: TelemetryEvent[] } {
	const events: TelemetryEvent[] = [];
	const collector: TelemetryCollector = {
		enabled: true,
		record(event, properties): void {
			events.push({ id: "test", event, timestamp: "2026-01-01T00:00:00.000Z", properties });
		},
		reopenSession(): void {},
		recordFirstUse(): void {},
		async flush(): Promise<void> {},
		start(): void {},
		async stop(): Promise<void> {},
		query(): readonly TelemetryEvent[] {
			return events;
		},
		anonymizeAgentId(): string {
			return "";
		},
	};
	return { collector, events };
}

afterEach(() => setActiveTelemetry(undefined));

describe("memory capture admission (#1342)", () => {
	it("waits for saturated captures and releases completed captures", async () => {
		const app = new Hono();
		const admission = createConcurrencyAdmission(1);
		const middleware = createMemoryCaptureAdmissionMiddleware(admission);
		app.use("/capture", middleware);
		app.post("/capture", (c) => c.json({ ok: true }));

		const release = await admission.acquire("local");
		if (typeof release !== "function") throw new Error("expected grant");
		let settled = false;
		const request = Promise.resolve(app.request("/capture", { method: "POST" })).then((response) => {
			settled = true;
			return response;
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(settled).toBe(false);
		release();
		const completed = await request;
		expect(completed.status).toBe(200);
		expect(await completed.json()).toEqual({ ok: true });
		expect(admission.inFlight()).toBe(0);
	});

	it("releases a granted slot and skips captures aborted before their continuation", async () => {
		for (const queued of [false, true]) {
			const app = new Hono();
			const admission = createConcurrencyAdmission(1);
			app.use("/capture", createMemoryCaptureAdmissionMiddleware(admission));
			let captures = 0;
			app.post("/capture", (c) => {
				captures++;
				return c.json({ ok: true });
			});
			const held = queued ? await admission.acquire("local") : undefined;
			const controller = new AbortController();
			const request = app.request("/capture", { method: "POST", signal: controller.signal });
			if (queued) await new Promise((resolve) => setTimeout(resolve, 10));
			if (typeof held === "function") held();
			controller.abort();
			const response = await request;
			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({ reason: "admission" });
			expect(captures).toBe(0);
			expect(admission.inFlight()).toBe(0);
		}
	});

	it("reports the actual configured capture capacity", async () => {
		const app = new Hono();
		registerMemoryRoutes(app, { memoryCaptureAdmission: createConcurrencyAdmission(0) });
		const response = await app.request("/api/memory/remember", { method: "POST", body: "{}" });
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: "Too many concurrent memory captures (max 0); retry shortly",
		});
	});

	it("records direct admission rejections as failed memory captures", async () => {
		const telemetry = captureTelemetry();
		setActiveTelemetry(telemetry.collector);
		const app = new Hono();
		registerMemoryRoutes(app, { memoryCaptureAdmission: createConcurrencyAdmission(0) });

		const response = await app.request("/api/memory/remember", { method: "POST", body: "{}" });

		expect(response.status).toBe(503);
		expect(response.headers.get("Retry-After")).toBe("1");
		expect(await response.json()).toMatchObject({ reason: "admission" });
		expect(telemetry.events).toContainEqual(
			expect.objectContaining({
				event: "pipeline.operation",
				properties: expect.objectContaining({
					operationClass: "memory_capture",
					outcome: "failed",
					failed: 1,
				}),
			}),
		);
	});
});
