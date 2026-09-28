import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useEffect } from "react";
import { type Root, createRoot } from "react-dom/client";
import { parse } from "yaml";
import { installDashboardDomGlobals } from "@/test/dom-globals";

const dom = new Window({ url: "http://localhost/" });
const originalFetch = globalThis.fetch;
let restoreDomGlobals = () => {};
let settingsContext: typeof import("../lib/settings-context") | null = null;
let settingsView: typeof import("./settings") | null = null;
let agentConfig = "";
let savedConfig: string | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findRerankerSwitch(): HTMLElement | null {
	const title = [...document.body.querySelectorAll("div")].find(
		(element) => element.textContent?.trim() === "Reranker",
	);
	const control = title?.parentElement?.parentElement?.querySelector('[role="switch"]');
	return control instanceof dom.HTMLElement ? control : null;
}

function OpenAdvancedSettings() {
	if (!settingsContext) throw new Error("settings context was not loaded");
	const { setOpen, setSection } = settingsContext.useSettings();
	useEffect(() => {
		setSection("advanced");
		setOpen(true);
	}, [setOpen, setSection]);
	return null;
}

async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mountAdvancedSettings(): Promise<{
	readonly toggle: HTMLElement;
	readonly unmount: () => Promise<void>;
}> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root: Root = createRoot(container);
	const context = settingsContext;
	const view = settingsView;
	if (!context || !view) throw new Error("settings modules were not loaded");
	const { SettingsProvider } = context;
	const { SettingsModal } = view;
	await act(async () => {
		root.render(
			<SettingsProvider>
				<SettingsModal />
				<OpenAdvancedSettings />
			</SettingsProvider>,
		);
		for (let attempt = 0; attempt < 10 && findRerankerSwitch() === null; attempt++) await flush();
	});
	const toggle = findRerankerSwitch();
	if (!toggle) throw new Error("Reranker switch was not rendered");
	return {
		toggle,
		unmount: async () => {
			await act(async () => root.unmount());
			await flush();
			container.remove();
		},
	};
}

async function clickAndReadSavedConfig(toggle: HTMLElement): Promise<Record<string, unknown>> {
	await act(async () => {
		toggle.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }));
		for (let attempt = 0; attempt < 10 && savedConfig === null; attempt++) await flush();
	});
	if (savedConfig === null) throw new Error("settings change was not saved");
	const parsed: unknown = parse(savedConfig);
	if (!isRecord(parsed)) throw new Error("saved config was not an object");
	return parsed;
}

beforeAll(async () => {
	restoreDomGlobals = installDashboardDomGlobals(dom);
	settingsContext = await import("../lib/settings-context");
	settingsView = await import("./settings");
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		if (String(input).endsWith("/api/config") && (init?.method ?? "GET") === "GET") {
			return Response.json({ files: [{ name: "agent.yaml", content: agentConfig }] });
		}
		if (String(input).endsWith("/api/config") && init?.method === "POST") {
			savedConfig = String(JSON.parse(String(init.body)).content);
			return Response.json({ success: true });
		}
		return Response.json({}, { status: 404 });
	}) as typeof fetch;
});

afterAll(async () => {
	await flush();
	globalThis.fetch = originalFetch;
	restoreDomGlobals();
	dom.close();
});

beforeEach(() => {
	savedConfig = null;
});

describe("pipelineV2 settings controls", () => {
	test("renders the nested reranker value over a conflicting flat alias", async () => {
		agentConfig = `memory:\n  pipelineV2:\n    reranker:\n      enabled: false\n    rerankerEnabled: true\n`;
		const settings = await mountAdvancedSettings();
		try {
			expect(settings.toggle.getAttribute("aria-checked")).toBe("false");
		} finally {
			await settings.unmount();
		}
	});

	test("persists a reranker edit to the nested path used by runtime resolution", async () => {
		agentConfig = `memory:\n  pipelineV2:\n    reranker:\n      enabled: false\n    rerankerEnabled: false\n`;
		const settings = await mountAdvancedSettings();
		try {
			expect(settings.toggle.getAttribute("aria-checked")).toBe("false");
			const saved = await clickAndReadSavedConfig(settings.toggle);
			const memory = saved.memory;
			if (!isRecord(memory) || !isRecord(memory.pipelineV2)) throw new Error("saved config omitted pipelineV2");
			const pipeline = memory.pipelineV2;
			if (!isRecord(pipeline.reranker)) throw new Error("saved config omitted nested reranker settings");
			expect(pipeline.reranker.enabled).toBe(true);
			expect(pipeline.rerankerEnabled).toBe(false);
		} finally {
			await settings.unmount();
		}
	});
});
