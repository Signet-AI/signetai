import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { dashboardQueryCache } from "@/lib/query-cache";
import { Window } from "happy-dom";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { AdvancedSection } from "./advanced";

const originalFetch = globalThis.fetch;
let config = "";
const calls: string[] = [];

function pausedIn(content: string): boolean {
	return /paused: true/.test(content);
}

function switchFor(label: string): HTMLButtonElement {
	const element = document.querySelector(`[role="switch"][aria-label="${label}"]`);
	if (!(element instanceof HTMLButtonElement)) throw new Error(`Missing ${label} switch`);
	return element;
}

async function settle(): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

async function mount(): Promise<{ readonly close: () => Promise<void> }> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root: Root = createRoot(container);
	await act(async () => {
		root.render(<AdvancedSection />);
	});
	await settle();
	return {
		close: async () => {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

beforeAll(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const window = new Window();
	for (const key of Object.getOwnPropertyNames(window)) {
		if (!(key in globalThis)) {
			(globalThis as Record<string, unknown>)[key] = (window as unknown as Record<string, unknown>)[key];
		}
	}
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		calls.push(`${method} ${url}`);
		if (url.endsWith("/api/config") && method === "GET")
			return Response.json({ files: [{ name: "agent.yaml", content: config }] });
		if (url.endsWith("/api/config") && method === "POST") {
			const content = JSON.parse(String(init?.body)).content as string;
			if (pausedIn(content) !== pausedIn(config))
				return Response.json(
					{ error: "memory.pipelineV2.paused changes only through /api/pipeline/pause or /api/pipeline/resume." },
					{ status: 409 },
				);
			config = content;
			return Response.json({ success: true });
		}
		if (url.endsWith("/api/pipeline/pause") || url.endsWith("/api/pipeline/resume")) {
			const paused = url.endsWith("/pause");
			config = config.replace(/paused: (true|false)/, `paused: ${paused}`);
			return Response.json({ success: true, changed: true, paused, mode: "controlled-write" });
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
});

beforeEach(() => {
	dashboardQueryCache.clear(false, false);
	calls.length = 0;
});

afterAll(() => {
	globalThis.fetch = originalFetch;
});

test("a paused pipeline can be resumed from Settings and Dreaming then turns on", async () => {
	config = "memory:\n  pipelineV2:\n    enabled: true\n    paused: true\n";
	const view = await mount();
	try {
		expect(switchFor("Pause memory pipeline").getAttribute("aria-checked")).toBe("true");
		expect(switchFor("Dreaming").disabled).toBe(true);
		expect(document.body.textContent).toContain("The memory pipeline is paused");

		await act(async () => switchFor("Pause memory pipeline").click());
		await settle();
		expect(calls).toContain("POST /api/pipeline/resume");
		expect(switchFor("Pause memory pipeline").getAttribute("aria-checked")).toBe("false");
		expect(switchFor("Dreaming").disabled).toBe(false);

		await act(async () => switchFor("Dreaming").click());
		await settle();
		expect(document.querySelector('[role="alert"]')).toBeNull();
		expect(config).toContain("paused: false");
		expect(config).toMatch(/dreaming:\s*\n\s+enabled: true/);
		expect(switchFor("Dreaming").getAttribute("aria-checked")).toBe("true");
	} finally {
		await view.close();
	}
});

test("a refused settings save is shown instead of dropped", async () => {
	config = "memory:\n  pipelineV2:\n    paused: false\n";
	const view = await mount();
	try {
		config = "memory:\n  pipelineV2:\n    paused: true\n";
		await act(async () => switchFor("Dreaming").click());
		await settle();
		expect(document.querySelector('[role="alert"]')?.textContent).toContain("memory.pipelineV2.paused");
	} finally {
		await view.close();
	}
});
