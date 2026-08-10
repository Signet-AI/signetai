/** Regression coverage for the unified Sources entry point and modal state paths. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ConnectSourceDialog } from "@/components/sources/connect-source-dialog";
import { api } from "@/lib/api";
import { ViewProvider } from "@/lib/view-context";
import { Window } from "happy-dom";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { SourcesView } from "./sources";

const originalImportSources = api.importSources;
const originalPickFiles = api.pickFiles;

let importCall: { files: readonly File[]; duplicateMode: string; paths: readonly string[] } | null = null;

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

async function mount(element: React.ReactNode): Promise<{ container: HTMLElement; root: Root }> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(element);
		await flush();
	});
	return { container, root };
}

async function click(element: Element): Promise<void> {
	await act(async () => {
		(element as HTMLElement).click();
		await flush();
	});
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
	const match = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(label));
	if (!(match instanceof HTMLButtonElement)) throw new Error(`button not found: ${label}`);
	return match;
}

beforeAll(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const window = new Window();
	for (const key of Object.getOwnPropertyNames(window)) {
		if (!(key in globalThis)) {
			(globalThis as Record<string, unknown>)[key] = (window as unknown as Record<string, unknown>)[key];
		}
	}
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		if (String(input).endsWith("/api/sources")) {
			return new Response(JSON.stringify({ version: 1, sources: [] }), { status: 200 });
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
});

beforeEach(() => {
	importCall = null;
	api.importSources = async (files, duplicateMode, paths) => {
		importCall = { files, duplicateMode, paths };
		return {
			ok: true,
			data: {
				imported: 1,
				failed: 0,
				files: [
					{ fileName: "notes.md", status: "imported", sourceId: "source-1", format: "markdown", duplicate: false },
				],
			},
		};
	};
	api.pickFiles = async () => ({ ok: true, paths: ["/tmp/notes.md"] });
});

afterAll(() => {
	api.importSources = originalImportSources;
	api.pickFiles = originalPickFiles;
	globalThis.fetch = undefined as unknown as typeof fetch;
});

describe("unified sources dialog", () => {
	test("Sources has one Connect a source entry point that opens the centered dialog with file import reachable", async () => {
		const mounted = await mount(
			<ViewProvider>
				<SourcesView />
			</ViewProvider>,
		);
		const entries = [...mounted.container.querySelectorAll("button")].filter((candidate) =>
			candidate.textContent?.includes("Connect a source"),
		);
		expect(entries).toHaveLength(1);
		expect(mounted.container.querySelector("button")?.textContent).toContain("Connect a source");

		await click(entries[0]);
		expect(mounted.container.querySelector("dialog.cs-panel")).not.toBeNull();
		expect(button(mounted.container, "Choose one or more files")).not.toBeNull();
		expect(mounted.container.querySelector('[aria-pressed="true"]')?.textContent).toContain("Files");

		await act(async () => mounted.root.unmount());
		mounted.container.remove();
	});

	test("selecting a connector keeps its existing field and submit contract", async () => {
		const mounted = await mount(<ConnectSourceDialog open onClose={() => undefined} onConnected={() => undefined} />);
		await click(button(mounted.container, "GitHub"));
		expect(mounted.container.querySelector('[aria-pressed="true"]')?.textContent).toContain("GitHub");
		expect(mounted.container.querySelector('[aria-label="Repository"]')).not.toBeNull();
		expect(button(mounted.container, "Connect & index").disabled).toBe(false);

		await click(button(mounted.container, "Connect & index"));
		expect(mounted.container.textContent).toContain("Expected owner/repo or owner/*");

		await act(async () => mounted.root.unmount());
		mounted.container.remove();
	});

	test("desktop file picking preserves filesystem paths and duplicate mode through import", async () => {
		const mounted = await mount(<ConnectSourceDialog open onClose={() => undefined} onConnected={() => undefined} />);
		await click(button(mounted.container, "Choose from desktop"));
		expect(mounted.container.textContent).toContain("notes.md · desktop path");
		await click(button(mounted.container, "Import & index"));
		expect(importCall).toEqual({ files: [], duplicateMode: "skip", paths: ["/tmp/notes.md"] });

		await act(async () => mounted.root.unmount());
		mounted.container.remove();
	});

	test("cancel and backdrop close use the shared modal boundary", async () => {
		let closed = 0;
		const mounted = await mount(
			<ConnectSourceDialog open onClose={() => (closed += 1)} onConnected={() => undefined} />,
		);
		await click(button(mounted.container, "Close"));
		expect(closed).toBe(1);
		const backdrop = mounted.container.querySelector(".cs-backdrop");
		if (!(backdrop instanceof HTMLElement)) throw new Error("backdrop not found");
		await act(async () => {
			backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await flush();
		});
		expect(closed).toBe(2);
		await act(async () => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
			await flush();
		});
		expect(closed).toBe(3);

		await act(async () => mounted.root.unmount());
		mounted.container.remove();
	});
});
