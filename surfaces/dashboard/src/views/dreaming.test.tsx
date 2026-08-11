/** Regression test for dreaming summaries being clipped by the outer content surface. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { DreamsView } from "./dreaming";

const DREAM_STATUS = {
	worker: { running: true, active: false, activeAgentId: null },
	scheduler: { status: "deferred", reason: "queue_pressure", checkedAt: "2026-08-10T14:14:11.000Z" },
	state: {
		consecutiveFailures: 0,
		lastFailureAt: null,
		lastPassAt: "2026-08-10T14:14:11.000Z",
		evidenceCursor: null,
		lastPassId: "pass-1",
		lastPassMode: "content",
	},
	episodicTokensPending: 0,
	config: {
		tokenThreshold: 1000,
		backfillOnFirstRun: false,
		maxInputTokens: 1000,
		maxOutputTokens: 1000,
		timeout: 30,
	},
	passes: [
		{
			id: "pass-1",
			mode: "content",
			status: "completed",
			startedAt: "2026-08-10T14:00:00.000Z",
			completedAt: "2026-08-10T14:14:11.000Z",
			tokensConsumed: 100,
			tokensInput: 50,
			tokensOutput: 50,
			tokensCacheRead: 0,
			tokensCacheWrite: 0,
			tokensCost: 0,
			mutationsApplied: 1,
			mutationsSkipped: 0,
			mutationsFailed: 0,
			summary: "# Summary\n\n- A long dreaming summary must remain readable.",
			error: null,
		},
	],
	attention: [],
	exclusions: [],
};

beforeAll(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const window = new Window();
	for (const key of Object.getOwnPropertyNames(window)) {
		if (!(key in globalThis)) {
			(globalThis as Record<string, unknown>)[key] = (window as unknown as Record<string, unknown>)[key];
		}
	}
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.endsWith("/api/dream/status")) {
			return new Response(JSON.stringify(DREAM_STATUS), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		if (url.includes("/api/dream/passes/pass-1/tools")) {
			return new Response(JSON.stringify({ agentId: "default", passId: "pass-1", items: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
});

afterAll(() => {
	globalThis.fetch = undefined as unknown as typeof fetch;
});

describe("dreaming summary layout", () => {
	test("keeps the summary in a scrollable, scrollbar-free container", async () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root: Root = createRoot(container);

		await act(async () => {
			root.render(<DreamsView />);
			await new Promise((resolve) => setTimeout(resolve, 0));
		});

		const summary = container.querySelector("section.scrollbar-none");
		expect(summary).not.toBeNull();
		expect(summary?.className).toContain("min-h-0");
		expect(summary?.className).toContain("overflow-y-auto");
		expect(container.textContent).toContain("automatic Dreaming deferred: queue pressure");

		await act(async () => {
			root.unmount();
		});
		container.remove();
	});
});
