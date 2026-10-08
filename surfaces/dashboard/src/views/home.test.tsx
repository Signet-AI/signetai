import { dashboardQueryCache } from "@/lib/query-cache";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { installDashboardDomGlobals } from "@/test/dom-globals";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";

const dom = new Window({ url: "http://localhost/#" });
const originalFetch = globalThis.fetch;
let restoreDomGlobals = () => {};

let harnessPayload: unknown;
let statusPayload: unknown = { agentId: null };

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeAll(() => {
	restoreDomGlobals = installDashboardDomGlobals(dom);
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const path = String(input);
		if (path.endsWith("/api/harnesses")) {
			return Response.json(harnessPayload);
		}
		if (path.endsWith("/api/status")) {
			return Response.json(statusPayload);
		}
		if (path.endsWith("/api/knowledge/stats")) {
			return Response.json({ entityCount: 0 });
		}
		if (path.endsWith("/api/sources/import-inbox")) {
			return Response.json({ enabled: false, imports: [] });
		}
		if (path.endsWith("/api/sources/imports")) {
			return Response.json({ imports: [] });
		}
		if (path.endsWith("/api/protection")) {
			return Response.json({
				overall: "partial",
				components: [],
				missing: [],
				degraded: [],
				restoreReceipt: null,
			});
		}
		if (path.endsWith("/api/sources")) {
			return Response.json({ version: 1, sources: [] });
		}
		if (path.includes("/api/memory/timeline")) {
			return Response.json({ totalMemories: 0, dailyBuckets: [] });
		}
		if (path.includes("/api/ontology/proposals")) {
			return Response.json({ items: [] });
		}
		if (path.includes("/api/secrets")) {
			return Response.json({ secrets: [] });
		}
		if (path.includes("/api/identity")) {
			return Response.json({ name: "fixture" });
		}
		if (path.includes("/api/agents")) {
			return Response.json({ agents: [] });
		}
		if (path.includes("/api/reflections/today")) {
			return Response.json({ items: [] });
		}
		if (path.includes("/api/memories")) {
			return Response.json({ memories: [] });
		}
		return Response.json({}, { status: 200 });
	}) as typeof fetch;
});

afterAll(() => {
	globalThis.fetch = originalFetch;
	restoreDomGlobals();
});

async function renderHome(): Promise<readonly [HTMLElement, Root]> {
	dashboardQueryCache.clear(false);
	const { HomeView } = await import("./home");
	const { ViewProvider } = await import("@/lib/view-context");
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<ViewProvider>
				<HomeView />
			</ViewProvider>,
		);
		await flush();
	});
	return [container, root];
}

async function unmountHome(root: Root): Promise<void> {
	await act(async () => {
		root.unmount();
	});
}

test("shows the setup link on a fresh workspace even when harness directories exist", async () => {
	harnessPayload = {
		harnesses: [
			{ id: "codex", name: "Codex", path: "/home/.codex", exists: true, lastSeen: null },
			{ id: "hermes-agent", name: "Hermes", path: "/home/.hermes", exists: true, lastSeen: null },
		],
		configuredHarnesses: [],
	};
	const [container, root] = await renderHome();
	try {
		expect(container.querySelector('a[href="#setup"]')).not.toBeNull();
		expect(container.textContent).toContain("Set up your memory connection");
	} finally {
		await unmountHome(root);
		container.remove();
	}
});

test("hides the setup link once a harness connection is configured", async () => {
	harnessPayload = {
		harnesses: [{ id: "codex", name: "Codex", path: "/home/.codex", exists: false, lastSeen: null }],
		configuredHarnesses: ["codex"],
	};
	const [container, root] = await renderHome();
	try {
		expect(container.querySelector('a[href="#setup"]')).toBeNull();
	} finally {
		await unmountHome(root);
		container.remove();
	}
});

test("asks for a provider while Dreaming waits for inference", async () => {
	harnessPayload = { harnesses: [], configuredHarnesses: ["codex"] };
	statusPayload = { agentId: null, dreaming: { enabled: true, workerRunning: true, blockedBy: "no_provider" } };
	const [container, root] = await renderHome();
	try {
		for (let attempt = 0; attempt < 50 && !container.textContent?.includes("connect a provider"); attempt += 1) {
			await act(async () => {
				await flush();
			});
		}
		expect(container.textContent).toContain("Memory is paused until you connect a provider");
		const connect = [...container.querySelectorAll("button")].find((button) => button.textContent === "Connect");
		expect(connect).toBeDefined();
		await act(async () => {
			connect?.click();
			await flush();
		});
		expect(window.location.hash).toContain("inference");
	} finally {
		statusPayload = { agentId: null };
		await unmountHome(root);
		container.remove();
	}
});

test("does not ask for a provider when Dreaming is blocked by the pipeline or turned off", async () => {
	harnessPayload = { harnesses: [], configuredHarnesses: ["codex"] };
	for (const dreaming of [
		{ enabled: true, workerRunning: true, blockedBy: "paused" },
		{ enabled: false, workerRunning: true, blockedBy: "no_provider" },
	]) {
		statusPayload = { agentId: null, dreaming };
		const [container, root] = await renderHome();
		try {
			for (let attempt = 0; attempt < 20; attempt += 1) {
				await act(async () => {
					await flush();
				});
			}
			expect(container.textContent).not.toContain("connect a provider");
		} finally {
			await unmountHome(root);
			container.remove();
		}
	}
	statusPayload = { agentId: null };
});

test("a failed connector refresh does not invite repair of an existing connection", async () => {
	harnessPayload = { harnesses: [], connectors: [], configuredHarnesses: ["codex"] };
	const [container, root] = await renderHome();
	try {
		harnessPayload = { error: "Request timed out" };
		await act(async () => {
			dashboardQueryCache.invalidate();
			await flush();
		});
		expect(container.querySelector('a[href="#setup"]')).toBeNull();
		expect(container.textContent).toContain("Checks unavailable");
	} finally {
		await unmountHome(root);
		container.remove();
	}
});

test("keeps the setup link when an older daemon omits the connection record", async () => {
	harnessPayload = { harnesses: [{ id: "codex", name: "Codex", path: "/x", exists: true, lastSeen: null }] };
	const [container, root] = await renderHome();
	try {
		expect(container.querySelector('a[href="#setup"]')).not.toBeNull();
	} finally {
		await unmountHome(root);
		container.remove();
	}
});

test("keeps the setup link while the harness check is pending", async () => {
	harnessPayload = { harnesses: [], configuredHarnesses: [] };
	let resolveFetch: ((value: Response) => void) | undefined;
	const original = globalThis.fetch;
	globalThis.fetch = (async () => {
		await new Promise<Response>((resolve) => {
			resolveFetch = resolve;
		});
		return original("/api/harnesses");
	}) as typeof fetch;
	const [container, root] = await renderHome();
	try {
		expect(container.querySelector('a[href="#setup"]')).not.toBeNull();
	} finally {
		resolveFetch?.(Response.json(harnessPayload));
		await unmountHome(root);
		container.remove();
		globalThis.fetch = original;
	}
});

test("keeps protection and durable import controls out of the reachable Home surface", async () => {
	harnessPayload = { harnesses: [], configuredHarnesses: [] };
	const [container, root] = await renderHome();
	try {
		expect(container.querySelector('[aria-label="Protection recovery"]')).toBeNull();
		expect(container.querySelector('[aria-label="Durable import status"]')).toBeNull();
		expect(container.querySelector('[data-testid="import-inbox-card"]')).toBeNull();
	} finally {
		await unmountHome(root);
		container.remove();
	}
});
