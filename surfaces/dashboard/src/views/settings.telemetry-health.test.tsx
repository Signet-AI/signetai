/** Regression coverage for #1392: persisted telemetry drops must be visible as local data loss. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TelemetryHealthResponse } from "@/lib/api";
import { Window } from "happy-dom";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { TelemetryHealthPanel, formatTelemetryCount } from "./settings";

function health(overrides: Partial<Extract<TelemetryHealthResponse, { enabled: true }>> = {}): TelemetryHealthResponse {
	return {
		enabled: true,
		status: "healthy",
		deliveryConfigured: true,
		bufferedEventCount: 0,
		queuedUnsentEventCount: 0,
		oldestUnsentEventAgeSec: null,
		lastDaemonEventAgeSec: 10,
		lastAttemptAgeSec: 10,
		lastSuccessfulDeliveryAgeSec: 10,
		recentDeliverySuccessCount: 1,
		recentDeliveryFailureCount: 0,
		consecutiveFailures: 0,
		backoffActive: false,
		droppedEventCount: 0,
		flushIntervalMs: 60_000,
		...overrides,
	};
}

const originalFetch = globalThis.fetch;
let response: TelemetryHealthResponse | "failed" = health();

beforeAll(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const window = new Window();
	for (const key of Object.getOwnPropertyNames(window)) {
		if (!(key in globalThis)) {
			(globalThis as Record<string, unknown>)[key] = (window as unknown as Record<string, unknown>)[key];
		}
	}
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		if (!String(input).endsWith("/api/telemetry/health")) return new Response("not found", { status: 404 });
		if (response === "failed") return new Response("service unavailable", { status: 503 });
		return new Response(JSON.stringify(response), { status: 200, headers: { "Content-Type": "application/json" } });
	}) as typeof fetch;
});

afterAll(() => {
	globalThis.fetch = originalFetch;
});

async function mountPanel(): Promise<{ readonly container: HTMLDivElement; readonly unmount: () => Promise<void> }> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root: Root = createRoot(container);
	await act(async () => {
		root.render(<TelemetryHealthPanel />);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	return {
		container,
		unmount: async () => {
			await act(async () => {
				root.unmount();
			});
			container.remove();
		},
	};
}

describe("telemetry health panel", () => {
	test("keeps a healthy zero-drop collector quiet", async () => {
		response = health();
		const panel = await mountPanel();
		expect(panel.container.textContent).toContain("healthy");
		expect(panel.container.textContent).toContain("Queue age");
		expect(panel.container.textContent).toContain("never");
		expect(panel.container.querySelector(".grid")?.className).toContain("grid-cols-2");
		expect(panel.container.querySelector(".grid")?.className).toContain("sm:grid-cols-5");
		expect(panel.container.querySelector('[role="alert"]')).toBeNull();
		expect(panel.container.textContent).not.toContain("local collector event");
		await panel.unmount();
	});

	test("warns about cumulative local telemetry data loss without naming a cause", async () => {
		response = health({
			status: "degraded",
			queuedUnsentEventCount: 19_974,
			oldestUnsentEventAgeSec: 64_598,
			droppedEventCount: 2_654,
		});
		const panel = await mountPanel();
		const warning = panel.container.querySelector('[role="alert"]');
		expect(warning?.textContent).toContain("2,654 local telemetry events were dropped and cannot be delivered later.");
		expect(warning?.textContent).not.toContain("persisted queue reached capacity");
		expect(panel.container.textContent).toContain("19,974");
		expect(panel.container.textContent).toContain("18h ago");
		expect(panel.container.textContent).toContain("Delivery is degraded. The oldest queued event is 18h ago.");
		await panel.unmount();
	});

	test("formats telemetry counts for readable warnings and metrics", () => {
		expect(formatTelemetryCount(2_654)).toBe("2,654");
		expect(formatTelemetryCount(20_000)).toBe("20,000");
	});

	test("names a disabled collector without treating it as a request failure", async () => {
		response = { enabled: false };
		const panel = await mountPanel();
		expect(panel.container.textContent).toContain("Telemetry collection is disabled on this daemon.");
		await panel.unmount();
	});

	test("reports an unavailable health request without inventing a recovery action", async () => {
		response = "failed";
		const panel = await mountPanel();
		expect(panel.container.textContent).toContain("Collector health is unavailable from this daemon.");
		await panel.unmount();
	});
});
