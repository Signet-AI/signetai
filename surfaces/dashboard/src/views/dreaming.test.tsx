import { beforeEach as beforeDashboardFixture } from "bun:test";
import { dashboardQueryCache } from "@/lib/query-cache";
beforeDashboardFixture(() => dashboardQueryCache.clear(false, false));

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { installDashboardDomGlobals } from "@/test/dom-globals";
let createRoot: typeof import("react-dom/client").createRoot;
let DreamsView: typeof import("./dreaming").DreamsView;
let restoreDomGlobals = () => {};
import type { DreamStatus, DreamToolCall } from "@/lib/api";

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
const originalFetch = globalThis.fetch;
let fixtureStatus: DreamStatus = DREAM_STATUS;
let fixtureTools: DreamToolCall[] = [
	{
		id: "tool-1",
		passId: "pass-1",
		sequence: 1,
		toolCallId: null,
		toolName: "attention_list",
		input: { kind: "review_due" },
		output: null,
		success: 1,
		latencyMs: 12,
		createdAt: null,
	},
];

beforeAll(async () => {
	const window = new Window();
	restoreDomGlobals = installDashboardDomGlobals(window);
	({ createRoot } = await import("react-dom/client"));
	({ DreamsView } = await import("./dreaming"));
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.endsWith("/api/dream/status")) {
			return new Response(JSON.stringify(fixtureStatus), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		if (url.includes("/api/dream/passes/pass-1/tools")) {
			return new Response(JSON.stringify({ agentId: "default", passId: "pass-1", items: fixtureTools }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
});

afterAll(() => {
	globalThis.fetch = originalFetch;
	restoreDomGlobals();
});

describe("dreaming summary layout", () => {
	test("opens the full pass details when a recent pass is clicked", async () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root: Root = createRoot(container);

		await act(async () => {
			root.render(<DreamsView />);
			await new Promise((resolve) => setTimeout(resolve, 0));
		});

		const summary = container.querySelector(".dreams-summary");
		expect(summary).not.toBeNull();
		expect(summary?.textContent).toContain("A long dreaming summary must remain readable.");
		expect(container.textContent).toContain("automatic Dreaming deferred: queue pressure");
		expect(container.querySelector(".dream-section")).toBeNull();
		expect(container.querySelector(".dreams-activity")?.textContent).toContain("attention_list");
		const details = container.querySelector<HTMLButtonElement>(".dreams-pass-row");
		expect(details).toBeDefined();
		await act(async () => {
			details?.click();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(document.querySelector('[role="dialog"]')?.textContent).toContain("attention_list");

		await act(async () => {
			root.unmount();
		});
		container.remove();
	});
	test("shows the last pass failure when no tool calls were recorded", async () => {
		fixtureStatus = {
			...DREAM_STATUS,
			passes: [
				{ ...DREAM_STATUS.passes[0], status: "failed", error: "All routing candidates were blocked.", summary: null },
			],
		};
		fixtureTools = [];
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		try {
			await act(async () => {
				root.render(<DreamsView />);
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			expect(container.querySelector(".dream-section")).toBeNull();
			const details = Array.from(container.querySelectorAll("button")).find((button) =>
				button.textContent?.includes("Details"),
			);
			await act(async () => {
				details?.click();
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			const dialog = document.querySelector('[role="dialog"]');
			expect(dialog?.textContent).toContain("All routing candidates were blocked.");
			expect(dialog?.textContent).toContain("No tool calls recorded.");
		} finally {
			await act(async () => root.unmount());
			container.remove();
			fixtureStatus = DREAM_STATUS;
		}
	});
});
