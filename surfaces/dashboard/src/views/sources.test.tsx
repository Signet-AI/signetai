/** Regression coverage for the unified Sources entry point and modal state paths. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ConnectSourceDialog } from "@/components/sources/connect-source-dialog";
import { type SignetSource, api } from "@/lib/api";
import { ViewProvider } from "@/lib/view-context";
import { Window } from "happy-dom";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { SourcesView } from "./sources";

const originalImportSources = api.importSources;
const originalPickFiles = api.pickFiles;
const originalGetSourceSnapshot = api.getSourceSnapshot;
const originalRemoveSource = api.removeSource;

let importCall: { files: readonly File[]; duplicateMode: string; paths: readonly string[] } | null = null;
let sourcesResponse: { version: number; sources: SignetSource[] } = { version: 1, sources: [] };

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
			return new Response(JSON.stringify(sourcesResponse), { status: 200 });
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
});

beforeEach(() => {
	importCall = null;
	sourcesResponse = { version: 1, sources: [] };
	api.importSources = async (files, duplicateMode, paths) => {
		importCall = { files, duplicateMode, paths };
		return {
			ok: true,
			data: {
				imported: 1,
				failed: 0,
				files: [
					{
						fileName: "notes.md",
						status: "imported",
						sourceId: "source-1",
						format: "markdown",
						duplicate: false,
						extraction: { documentEntityId: "entity-1", aspectsCreated: 2, attributesCreated: 3 },
					},
				],
			},
		};
	};
	api.pickFiles = async () => ({ ok: true, paths: ["/tmp/notes.md"] });
	api.getSourceSnapshot = async () => ({});
	api.removeSource = async () => ({ ok: true });
});

afterAll(() => {
	api.importSources = originalImportSources;
	api.pickFiles = originalPickFiles;
	api.getSourceSnapshot = originalGetSourceSnapshot;
	api.removeSource = originalRemoveSource;
	globalThis.fetch = undefined as unknown as typeof fetch;
});

function sourceFixture(
	id: string,
	kind: string,
	name: string,
	health: SignetSource["health"]["status"] = "healthy",
	indexJob?: SignetSource["indexJob"],
): SignetSource {
	return {
		id,
		kind,
		name,
		root: kind === "import" ? name : `/vault/${name}`,
		enabled: true,
		mode: "read-only",
		createdAt: "2026-08-10T00:00:00.000Z",
		updatedAt: "2026-08-10T00:00:00.000Z",
		stats: { artifacts: 3, chunks: 4, indexed: 5 },
		health: {
			status: health,
			failures: health === "degraded" ? { total: 1, recoverable: 1 } : { total: 0, recoverable: 0 },
			...(kind === "import"
				? {
						semantic: {
							entities: 1,
							aspects: 2,
							attributes: 3,
							dependencies: 0,
							communities: 0,
							total: 6,
							documentEntityId: "entity-1",
						},
					}
				: {}),
		},
		indexJob,
		...(kind === "import"
			? {
					providerSettings: {
						fileName: name,
						format: name.endsWith(".pdf") ? "pdf" : "markdown",
						contentHash: id,
						agentId: "sources-test-agent",
					},
				}
			: {}),
	};
}

describe("sources grouping", () => {
	test("does not render blank extraction counts from an older daemon payload", async () => {
		const source = sourceFixture("import:legacy", "import", "legacy.md");
		source.health = {
			status: "healthy",
			semantic: {
				entities: 1,
				attributes: 42,
				dependencies: 0,
				communities: 0,
				total: 43,
				documentEntityId: null,
			} as SignetSource["health"]["semantic"],
		};
		sourcesResponse = { version: 1, sources: [source] };
		const mounted = await mount(
			<ViewProvider>
				<SourcesView />
			</ViewProvider>,
		);

		expect(mounted.container.textContent).toContain("extraction result unavailable");
		expect(mounted.container.textContent).not.toContain("undefined aspects");

		await act(async () => mounted.root.unmount());
		mounted.container.remove();
	});

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
		expect(mounted.container.textContent).toContain("2 aspects · 3 attributes · entity linked");

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

	test("groups one or many imported documents without merging connected collections", async () => {
		sourcesResponse = {
			version: 1,
			sources: [
				sourceFixture("import:hash-a", "import", "notes.pdf"),
				sourceFixture("import:hash-b", "import", "table.csv", "degraded", {
					id: "job-b",
					sourceId: "import:hash-b",
					status: "running",
					queuedAt: "2026-08-10T00:00:00.000Z",
					scanned: 2,
					total: 5,
					currentPath: "table.csv",
				}),
				sourceFixture("obsidian:vault", "obsidian", "Vault"),
			],
		};
		const mounted = await mount(
			<ViewProvider>
				<SourcesView />
			</ViewProvider>,
		);
		const documents = mounted.container.querySelector('[data-testid="imported-documents-card"]');
		if (!(documents instanceof HTMLElement)) throw new Error("Documents card not found");

		expect(mounted.container.querySelectorAll('[data-testid="imported-documents-card"]')).toHaveLength(1);
		expect(documents.textContent).toContain("2 documents");
		expect(documents.textContent).toContain("notes.pdf");
		expect(documents.textContent).toContain("2 aspects · 3 attributes · entity linked");
		expect(documents.textContent).toContain("table.csv");
		expect(documents.textContent).toContain("40% · table.csv");
		expect(documents.querySelectorAll('[aria-label="Re-index"]')).toHaveLength(0);
		expect(documents.querySelectorAll('[aria-label="Snapshot"]')).toHaveLength(2);
		expect(documents.querySelectorAll('[aria-label="Remove"]')).toHaveLength(2);
		const list = documents.querySelector('[data-testid="imported-document-list"]');
		if (!(list instanceof HTMLUListElement)) throw new Error("Imported document list not found");
		expect(list.getAttribute("aria-label")).toBe("Imported documents");
		expect(list.className).toContain("min-h-0");
		expect(list.className).toContain("overflow-x-hidden");
		expect(list.className).toContain("overflow-y-auto");
		expect(list.className).toContain("pr-1");
		expect(list.querySelectorAll('[data-testid="imported-document-row"]')).toHaveLength(2);
		expect(documents.className).toContain("h-[clamp(360px,45vh,480px)]");
		expect(documents.textContent).toContain("3 artifacts · 4 chunks · 5 indexed");
		expect(mounted.container.querySelectorAll(".sig-src-card")).toHaveLength(2);
		expect(mounted.container.textContent).toContain("Vault");

		await act(async () => mounted.root.unmount());
		mounted.container.remove();
	});

	test("keeps the aggregate stable across refresh when document names change", async () => {
		sourcesResponse = {
			version: 1,
			sources: [sourceFixture("import:stable", "import", "before.pdf")],
		};
		const mounted = await mount(
			<ViewProvider>
				<SourcesView />
			</ViewProvider>,
		);
		expect(mounted.container.querySelector('[data-testid="imported-documents-card"]')?.textContent).toContain(
			"before.pdf",
		);

		sourcesResponse = {
			version: 1,
			sources: [sourceFixture("import:stable", "import", "after.pdf")],
		};
		const remove = mounted.container.querySelector('[aria-label="Remove"]');
		if (!(remove instanceof HTMLElement)) throw new Error("Remove action not found");
		await click(remove);
		const confirm = mounted.container.querySelector('[aria-label="Confirm remove"]');
		if (!(confirm instanceof HTMLElement)) throw new Error("Confirm remove action not found");
		await click(confirm);

		expect(mounted.container.querySelectorAll('[data-testid="imported-documents-card"]')).toHaveLength(1);
		expect(mounted.container.querySelector('[data-testid="imported-documents-card"]')?.textContent).toContain(
			"after.pdf",
		);

		await act(async () => mounted.root.unmount());
		mounted.container.remove();
	});
});
