import { afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createConcurrencyAdmission } from "../../runtime/concurrency/admission";
import { type TelemetryCollector, type TelemetryEvent, setActiveTelemetry } from "../../telemetry/usage/telemetry";
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
	it("rejects saturated captures with 503 and releases completed captures", async () => {
		const app = new Hono();
		const admission = createConcurrencyAdmission(1);
		const middleware = createMemoryCaptureAdmissionMiddleware(admission, 1);
		app.use("/capture", middleware);
		app.post("/capture", (c) => c.json({ ok: true }));

		expect(admission.acquire()).toBe(true);
		const rejected = await app.request("/capture", { method: "POST" });
		expect(rejected.status).toBe(503);
		expect(await rejected.json()).toEqual({
			error: "Too many concurrent memory captures (max 1); retry shortly",
		});
		expect(admission.inFlight()).toBe(1);

		admission.release();
		const completed = await app.request("/capture", { method: "POST" });
		expect(completed.status).toBe(200);
		expect(await completed.json()).toEqual({ ok: true });
		expect(admission.inFlight()).toBe(0);
	});

	it("records direct admission rejections as failed memory captures", async () => {
		const telemetry = captureTelemetry();
		setActiveTelemetry(telemetry.collector);
		const app = new Hono();
		registerMemoryRoutes(app, { memoryCaptureAdmission: createConcurrencyAdmission(0) });

		const response = await app.request("/api/memory/remember", { method: "POST", body: "{}" });

		expect(response.status).toBe(503);
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
