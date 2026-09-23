/**
 * Regression coverage for the home view's setup link gate (PR #1858 review):
 * the link must hide only when a Signet connection was actually established —
 * the `configuredHarnesses` record in agent.yaml — never merely because a
 * harness home directory exists on disk (pre-existing `~/.codex`, Hermes home,
 * etc. used to hide the only setup/repair link on a fresh workspace).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";

const dom = new Window({ url: "http://localhost/#" });
const originalFetch = globalThis.fetch;

let harnessPayload: unknown;

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeAll(() => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	for (const key of Object.getOwnPropertyNames(dom)) {
		if (!(key in globalThis)) Reflect.set(globalThis, key, Reflect.get(dom, key));
	}
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const path = String(input);
		if (path.endsWith("/api/harnesses")) {
			return Response.json(harnessPayload);
		}
		if (path.endsWith("/api/status")) {
			return Response.json({ agentId: null });
		}
		if (path.endsWith("/api/knowledge/stats")) {
			return Response.json({ entityCount: 0 });
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
});

async function renderHome(): Promise<readonly [HTMLElement, Root]> {
	const { HomeView } = await import("./home");
	const { ViewProvider } = await import("@/lib/view-context");
	const { SettingsProvider } = await import("@/lib/settings-context");
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<SettingsProvider>
				<ViewProvider>{<HomeView />}</ViewProvider>
			</SettingsProvider>,
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
		expect(container.textContent).toContain("Set up or repair your memory connection");
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
