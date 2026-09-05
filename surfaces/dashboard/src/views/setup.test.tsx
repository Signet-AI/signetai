import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { SetupView } from "./settings";

const dom = new Window();
const originalFetch = globalThis.fetch;
let saveFails = false;
let oauthTruncated = false;
let config = "memory:\n  pipelineV2:\n    enabled: false\noperator_setting: preserved\n";
const requests: string[] = [];

beforeAll(() => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	for (const key of Object.getOwnPropertyNames(dom)) {
		if (!(key in globalThis)) Reflect.set(globalThis, key, Reflect.get(dom, key));
	}
	Reflect.set(window, "open", () => ({ closed: false, location: { href: "about:blank" }, close() {} }));
	globalThis.fetch = async (input, init) => {
		const path = String(input);
		requests.push(`${init?.method ?? "GET"} ${path}`);
		if (path === "/api/config") {
			if (init?.method === "POST") {
				if (saveFails) return Response.json({ error: "disk full" }, { status: 500 });
				config = JSON.parse(String(init.body)).content;
				return Response.json({ success: true });
			}
			return Response.json({ files: [{ name: "agent.yaml", content: config }] });
		}
		if (path === "/api/inference/catalog")
			return Response.json({
				providers: ["openai-codex"],
				models: { "openai-codex": [{ id: "fixture-model", name: "Fixture model" }] },
				oauthProviders: [{ id: "openai-codex", name: "ChatGPT", connected: false }],
			});
		if (path.startsWith("/api/inference/status"))
			return Response.json({ workloadBindings: { memoryExtraction: {} }, runtimeSnapshot: { targets: {} } });
		if (path === "/api/inference/explain")
			return Response.json({ targetRef: "background/default", policyId: "default" });
		if (path === "/api/inference/execute")
			return Response.json({ text: "OK", decision: { targetRef: "background/default" }, attempts: [{ ok: true }] });
		if (path === "/api/pipeline/resume") return Response.json({ success: true, mode: "controlled-write" });
		if (path === "/api/inference/oauth/login/openai-codex") {
			const event = oauthTruncated
				? { type: "session", sessionId: "fixture-session" }
				: { type: "connected", providerId: "openai-codex" };
			return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
		}
		throw new Error(`Unexpected request: ${path}`);
	};
});
afterAll(() => {
	globalThis.fetch = originalFetch;
	dom.close();
});

async function mount(): Promise<{
	element: HTMLDivElement;
	click: (text: string) => Promise<void>;
	close: () => Promise<void>;
}> {
	const element = document.createElement("div");
	document.body.append(element);
	const root = createRoot(element);
	await act(async () => {
		root.render(<SetupView />);
	});
	return {
		element,
		async click(text) {
			const button = [...element.querySelectorAll("button")].find((button) => button.textContent === text);
			if (!button) throw new Error(`Button not found: ${text}`);
			await act(async () => {
				button.click();
			});
		},
		async close() {
			await act(async () => root.unmount());
			element.remove();
		},
	};
}

describe("Setup", () => {
	test("does not report connected when the credential account cannot be saved", async () => {
		saveFails = true;
		const view = await mount();
		try {
			await view.click("Sign in");
			await view.click("Sign in with ChatGPT / Codex");
			expect(view.element.textContent).toContain("connection could not be saved");
			expect(view.element.textContent).not.toContain("Connected — you can assign");
		} finally {
			await view.close();
			saveFails = false;
		}
	});
	test("turns a truncated login stream into a retryable error", async () => {
		oauthTruncated = true;
		const view = await mount();
		try {
			await view.click("Sign in");
			await view.click("Sign in with ChatGPT / Codex");
			expect(view.element.textContent).toContain("Sign-in ended before the connection was saved");
		} finally {
			await view.close();
			oauthTruncated = false;
		}
	});
	test("starts memory only after an explicit probe and successful configuration save", async () => {
		requests.length = 0;
		const view = await mount();
		try {
			expect(requests).not.toContain("POST /api/inference/execute");
			await view.click("Test connection");
			expect(view.element.textContent).toContain("The model answered the test prompt");
			saveFails = true;
			await view.click("Start automatic memory");
			expect(requests).not.toContain("POST /api/pipeline/resume");
			expect(view.element.textContent).toContain("Could not save memory settings");
			saveFails = false;
			await view.click("Start automatic memory");
			expect(requests).toContain("POST /api/pipeline/resume");
			expect(config).toContain("operator_setting: preserved");
			expect(config).toContain("enabled: true");
			expect(config).toContain("paused: true");
			expect(view.element.textContent).toContain("Automatic memory is running");
		} finally {
			saveFails = false;
			await view.close();
		}
	});
});
