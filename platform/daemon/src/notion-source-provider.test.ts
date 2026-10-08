import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SignetSourceEntry, addNotionSource } from "@signet/core";
import type { SecretKeyringAdapter } from "@signet/core";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import {
	NOTION_API_VERSION,
	NOTION_MAX_RESPONSE_BYTES,
	parseNotionPage,
	setNotionSleepForTest,
} from "./notion-source-fetch";
import {
	NOTION_MAX_PAGE_CHARS,
	propertiesHash,
	setNotionSyncDeadlineForTest,
	syncNotionSource,
} from "./notion-source-provider";
import { getSecret, putSecret, setSecretKeyringAdapterForTests } from "./secrets";

const originalFetch = globalThis.fetch;
const TOKEN = "notion-test-token-value";

interface RecordedRequest {
	readonly method: string;
	readonly path: string;
	readonly headers: Headers;
	readonly body: Record<string, unknown> | null;
}

type Route = (request: RecordedRequest) => Response | Promise<Response>;

function memoryKeyring(): SecretKeyringAdapter {
	let stored: string | undefined;
	const read = async () =>
		stored === undefined ? { state: "missing" as const } : { state: "found" as const, value: stored };
	return {
		platform: "test",
		service: "ai.signet.secrets",
		account: "notion-source-test",
		get: read,
		getStatus: read,
		async set(value: string) {
			stored = value;
			return { state: "found" as const, value };
		},
	};
}

function stubNotion(route: Route): RecordedRequest[] {
	const requests: RecordedRequest[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const request: RecordedRequest = {
			method: init?.method ?? "GET",
			path: url.pathname.replace(/^\/v1/, ""),
			headers: new Headers(init?.headers),
			body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
		};
		requests.push(request);
		return await route(request);
	}) as typeof fetch;
	return requests;
}

function page(
	id: string,
	title: string,
	lastEditedTime: string,
	extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
	return {
		object: "page",
		id,
		url: `https://www.notion.so/${id}`,
		created_time: "2026-01-01T00:00:00.000Z",
		last_edited_time: lastEditedTime,
		in_trash: false,
		parent: { type: "workspace", workspace: true },
		properties: { Name: { type: "title", title: [{ plain_text: title }] } },
		...extra,
	};
}

function searchResponse(results: readonly unknown[], extra: Readonly<Record<string, unknown>> = {}): Response {
	return Response.json({ object: "list", results, next_cursor: null, has_more: false, ...extra });
}

function markdownResponse(markdown: string, truncated = false): Response {
	return Response.json({ object: "page_markdown", markdown, truncated, unknown_block_ids: [] });
}

function markdownRoute(pages: Readonly<Record<string, string>>): Route {
	return (request) => {
		const id = request.path.match(/^\/pages\/([^/]+)\/markdown$/)?.[1];
		if (id && pages[id] !== undefined) return markdownResponse(pages[id]);
		return Response.json({ object: "error", code: "object_not_found", message: "missing" }, { status: 404 });
	};
}

describe("notion-source-provider", () => {
	let dir = "";
	let previousSignetPath: string | undefined;
	let sleeps: number[] = [];

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "signet-notion-source-"));
		previousSignetPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = dir;
		mkdirSync(join(dir, "memory"), { recursive: true });
		closeDbAccessor();
		initDbAccessor(join(dir, "memory", "memories.db"));
		setSecretKeyringAdapterForTests(memoryKeyring());
		await putSecret("NOTION_TOKEN", TOKEN);
		sleeps = [];
		setNotionSleepForTest(async (ms) => {
			sleeps.push(ms);
		});
	});

	afterEach(async () => {
		globalThis.fetch = originalFetch;
		setNotionSleepForTest(null);
		setNotionSyncDeadlineForTest(null);
		setSecretKeyringAdapterForTests(null);
		await closeDbAccessor();
		if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = previousSignetPath;
		rmSync(dir, { recursive: true, force: true });
	});

	function addSource(maxPages?: number): SignetSourceEntry {
		const added = addNotionSource({ tokenRef: "NOTION_TOKEN", maxPages }, dir);
		if (added.ok === false) throw new Error(added.error);
		return added.source;
	}

	async function sync(source: SignetSourceEntry) {
		const result = await syncNotionSource({
			source,
			agentsDir: dir,
			agentId: "default",
			shouldContinue: () => true,
			getSecret,
		});
		if (!result) throw new Error("Notion provider has no sync");
		return result;
	}

	it("indexes shared pages as attributable source artifacts", async () => {
		const source = addSource();
		const row = page("row-1", "Ship Notion", "2026-02-02T00:00:00.000Z", {
			parent: { type: "data_source_id", data_source_id: "ds-1" },
			properties: {
				Task: { type: "title", title: [{ plain_text: "Ship Notion" }] },
				Status: { type: "status", status: { name: "In progress" } },
				Tags: { type: "multi_select", multi_select: [{ name: "sources" }, { name: "connectors" }] },
				Due: { type: "date", date: { start: "2026-03-01", end: null } },
				Owner: { type: "people", people: [{ name: "Avery" }] },
				Empty: { type: "rich_text", rich_text: [] },
			},
		});
		const child = page("child-1", "Child page", "2026-02-01T00:00:00.000Z", {
			parent: { type: "page_id", page_id: "row-1" },
		});
		const trashed = page("trash-1", "Trashed", "2026-02-03T00:00:00.000Z", { in_trash: true });
		const requests = stubNotion((request) =>
			request.path === "/search"
				? searchResponse([row, child, trashed, { object: "page", id: "partial-1" }])
				: markdownRoute({ "row-1": "Ship the **connector**.", "child-1": "Nested notes." })(request),
		);

		const result = await sync(source);

		expect(result.failures).toEqual([]);
		expect(result).toMatchObject({ indexed: 2, scanned: 2, total: 2 });
		expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
		expect(requests[0]?.headers.get("notion-version")).toBe(NOTION_API_VERSION);
		expect(requests[0]?.body).toMatchObject({
			filter: { property: "object", value: "page" },
			sort: { timestamp: "last_edited_time", direction: "descending" },
		});
		expect(requests.some((request) => request.path.includes("trash-1"))).toBe(false);

		const rows = sourceRows(source.id);
		expect(rows.map((entry) => entry.source_path)).toEqual([
			`notion://sources/${source.id}/pages/child-1`,
			`notion://sources/${source.id}/pages/row-1`,
		]);
		const rowArtifact = rows.find((entry) => entry.source_external_id === "row-1");
		expect(rowArtifact?.source_kind).toBe("source_notion_page");
		expect(rowArtifact?.source_parent_path).toBe(`notion://sources/${source.id}/parents/data-sources/ds-1`);
		expect(rowArtifact?.content).toContain("# Ship Notion");
		expect(rowArtifact?.content).toContain("- Status: In progress");
		expect(rowArtifact?.content).toContain("- Tags: sources, connectors");
		expect(rowArtifact?.content).toContain("- Owner: Avery");
		expect(rowArtifact?.content).not.toContain("Empty");
		expect(rowArtifact?.content).toContain("Ship the **connector**.");
		expect(JSON.parse(rowArtifact?.source_meta_json ?? "{}")).toMatchObject({
			provider: "notion",
			pageId: "row-1",
			url: "https://www.notion.so/row-1",
			incomplete: false,
			unsupportedBlocks: 0,
		});
		expect(rows.find((entry) => entry.source_external_id === "child-1")?.source_parent_path).toBe(
			`notion://sources/${source.id}/parents/pages/row-1`,
		);
		expect(rows.every((entry) => !entry.content.includes(TOKEN))).toBe(true);
		const graphDocs = getDbAccessor().withReadDb(
			(db) =>
				(
					db
						.prepare("SELECT COUNT(*) AS count FROM entities WHERE source_id = ? AND entity_type = 'source_document'")
						.get(source.id) as { count: number }
				).count,
		);
		expect(graphDocs).toBeGreaterThanOrEqual(2);
	});

	it("refetches only edited pages and purges pages no longer shared", async () => {
		const source = addSource();
		let results = [page("a", "A", "2026-02-01T00:00:00.000Z"), page("b", "B", "2026-02-01T00:00:00.000Z")];
		let markdown: Record<string, string> = { a: "A v1", b: "B v1" };
		const requests = stubNotion((request) =>
			request.path === "/search" ? searchResponse(results) : markdownRoute(markdown)(request),
		);
		await sync(source);

		results = [page("a", "A", "2026-02-05T00:00:00.000Z")];
		markdown = { a: "A v2" };
		requests.length = 0;
		const second = await sync(source);

		expect(second.failures).toEqual([]);
		expect(second).toMatchObject({ indexed: 1, scanned: 1, total: 1 });
		expect(requests.map((request) => request.path)).toEqual(["/search", "/pages/a/markdown", "/pages/b"]);
		const rows = sourceRows(source.id);
		expect(rows.find((entry) => entry.source_external_id === "a")).toMatchObject({ is_deleted: 0 });
		expect(rows.find((entry) => entry.source_external_id === "a")?.content).toContain("A v2");
		expect(rows.find((entry) => entry.source_external_id === "b")).toMatchObject({ is_deleted: 1 });

		requests.length = 0;
		const third = await sync(source);
		expect(third).toMatchObject({ indexed: 1, scanned: 1, total: 1, failures: [] });
		expect(requests.map((request) => request.path)).toEqual(["/search"]);
	});

	it("keeps the last good page when a refetch fails and clears the failure after recovery", async () => {
		const source = addSource();
		let edited = "2026-02-01T00:00:00.000Z";
		let fail = false;
		stubNotion((request) => {
			if (request.path === "/search") return searchResponse([page("a", "A", edited)]);
			if (fail) return Response.json({ code: "restricted_resource", message: "no access" }, { status: 403 });
			return markdownResponse(`A at ${edited}`);
		});
		await sync(source);

		edited = "2026-02-02T00:00:00.000Z";
		fail = true;
		const failed = await sync(source);

		expect(failed.failures).toHaveLength(1);
		expect(failed.failures[0]?.message).toContain('Notion page fetch failed for "A"');
		expect(failed.failures[0]?.message).toContain("403 restricted_resource");
		expect(failed.failures[0]?.message).not.toContain(TOKEN);
		expect(failed.indexed - failed.failures.length).toBe(0);
		let rows = sourceRows(source.id);
		expect(rows.find((entry) => entry.source_kind === "source_notion_page")).toMatchObject({ is_deleted: 0 });
		expect(rows.find((entry) => entry.source_kind === "source_notion_page")?.content).toContain(
			"A at 2026-02-01T00:00:00.000Z",
		);
		expect(
			rows.filter((entry) => entry.source_kind === "source_notion_failure" && entry.is_deleted === 0),
		).toHaveLength(1);

		fail = false;
		const recovered = await sync(source);

		expect(recovered.failures).toEqual([]);
		rows = sourceRows(source.id);
		expect(rows.find((entry) => entry.source_kind === "source_notion_page")?.content).toContain(
			"A at 2026-02-02T00:00:00.000Z",
		);
		expect(
			rows.filter((entry) => entry.source_kind === "source_notion_failure" && entry.is_deleted === 0),
		).toHaveLength(0);
	});

	it("retries rate limits with Retry-After and fails closed on authorization errors", async () => {
		const source = addSource();
		let searches = 0;
		stubNotion((request) => {
			if (request.path !== "/search") return markdownResponse("body");
			searches++;
			if (searches === 1) {
				return Response.json(
					{ code: "rate_limited", message: "slow down" },
					{ status: 429, headers: { "Retry-After": "7" } },
				);
			}
			return searchResponse([page("a", "A", "2026-02-01T00:00:00.000Z")]);
		});

		const retried = await sync(source);

		expect(retried.failures).toEqual([]);
		expect(searches).toBe(2);
		expect(sleeps).toEqual([7_000]);

		sleeps = [];
		searches = 0;
		stubNotion(() => {
			searches++;
			return Response.json({ code: "unauthorized", message: "API token is invalid." }, { status: 401 });
		});
		const unauthorized = await sync(source);

		expect(searches).toBe(1);
		expect(sleeps).toEqual([]);
		expect(unauthorized.failures.map((failure) => failure.message)).toEqual([
			"Notion search failed: Notion API 401 unauthorized: API token is invalid.",
		]);
		expect(sourceRows(source.id).find((entry) => entry.source_kind === "source_notion_page")).toMatchObject({
			is_deleted: 0,
		});
	});

	it("bounds retries on persistent server errors", async () => {
		const source = addSource();
		let searches = 0;
		stubNotion(() => {
			searches++;
			return Response.json({ code: "service_unavailable", message: "down" }, { status: 503 });
		});

		const result = await sync(source);

		expect(searches).toBe(4);
		expect(sleeps).toEqual([1_000, 2_000, 4_000]);
		expect(result.failures[0]?.message).toContain("503 service_unavailable");
	});

	it("stops enumeration at maxPages", async () => {
		const source = addSource(3);
		const requests = stubNotion((request) =>
			request.path === "/search"
				? searchResponse(
						[1, 2, 3, 4].map((n) => page(`p${n}`, `P${n}`, "2026-02-01T00:00:00.000Z")),
						{ has_more: true, next_cursor: "next" },
					)
				: markdownResponse("body"),
		);

		const result = await sync(source);

		expect(result).toMatchObject({ indexed: 3, scanned: 3, total: 3, failures: [] });
		expect(requests[0]?.body?.page_size).toBe(3);
		expect(requests.filter((request) => request.path === "/search")).toHaveLength(1);
	});

	it("does not purge when Notion reports an incomplete search", async () => {
		const source = addSource();
		let results = [page("a", "A", "2026-02-01T00:00:00.000Z"), page("b", "B", "2026-02-01T00:00:00.000Z")];
		let status: Record<string, unknown> = { type: "complete" };
		stubNotion((request) =>
			request.path === "/search" ? searchResponse(results, { request_status: status }) : markdownResponse("body"),
		);
		await sync(source);

		results = [page("a", "A", "2026-02-01T00:00:00.000Z")];
		status = { type: "incomplete", incomplete_reason: "query_result_limit_reached" };
		const result = await sync(source);

		expect(result.failures.map((failure) => failure.message)).toEqual([
			"Notion search returned an incomplete result set; stale pages were not purged",
		]);
		expect(sourceRows(source.id).find((entry) => entry.source_external_id === "b")).toMatchObject({ is_deleted: 0 });
	});

	it("rejects oversized responses without buffering them", async () => {
		const source = addSource();
		const chunk = new Uint8Array(1024 * 1024);
		let sent = 0;
		stubNotion(
			() =>
				new Response(
					new ReadableStream<Uint8Array>({
						pull(controller) {
							sent += chunk.byteLength;
							controller.enqueue(chunk);
						},
					}),
					{ status: 200 },
				),
		);

		const result = await sync(source);

		expect(result.failures[0]?.message).toContain(`exceeded ${NOTION_MAX_RESPONSE_BYTES} bytes`);
		expect(sent).toBeLessThanOrEqual(NOTION_MAX_RESPONSE_BYTES + 2 * chunk.byteLength);
	});

	it("fails the sync when the token reference cannot be resolved", async () => {
		const added = addNotionSource({ tokenRef: "MISSING_NOTION_TOKEN" }, dir);
		if (added.ok === false) throw new Error(added.error);
		const requests = stubNotion(() => searchResponse([]));

		await expect(sync(added.source)).rejects.toThrow("Failed to resolve Notion token ref 'MISSING_NOTION_TOKEN'");
		expect(requests).toHaveLength(0);
	});

	it("syncs the maximum page count without exceeding the owner result cap", async () => {
		const source = addSource(10_000);
		const edited = "2026-02-01T00:00:00.000Z";
		const ids = Array.from(
			{ length: 10_000 },
			(_, index) => `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`,
		);
		seedPageRows(source.id, ids, Date.parse(edited), Date.now());
		const requests = stubNotion((request) => {
			if (request.path !== "/search") return markdownResponse("unexpected");
			const offset = Number(request.body?.start_cursor ?? 0);
			const size = Number(request.body?.page_size ?? 100);
			const slice = ids.slice(offset, offset + size).map((id) => page(id, id, edited));
			const next = offset + size < ids.length ? String(offset + size) : null;
			return searchResponse(slice, { has_more: next !== null, next_cursor: next });
		});

		const result = await sync(source);

		expect(result.failures).toEqual([]);
		expect(result).toMatchObject({ indexed: 10_000, scanned: 10_000, total: 10_000 });
		expect(requests.every((request) => request.path === "/search")).toBe(true);
	});

	it("purges more than one owner transaction worth of unshared pages", async () => {
		const source = addSource();
		let ids = Array.from({ length: 140 }, (_, index) => `p${index}`);
		stubNotion((request) => {
			if (request.path === "/search") return searchResponse(ids.map((id) => page(id, id, "2026-02-01T00:00:00.000Z")));
			if (request.path.endsWith("/markdown")) return markdownResponse("body");
			return Response.json({ code: "object_not_found", message: "Could not find page" }, { status: 404 });
		});
		await sync(source);

		ids = ids.slice(0, 5);
		const result = await sync(source);

		expect(result.failures).toEqual([]);
		const rows = sourceRows(source.id).filter((entry) => entry.source_kind === "source_notion_page");
		expect(rows.filter((entry) => entry.is_deleted === 0)).toHaveLength(5);
		expect(rows.filter((entry) => entry.is_deleted === 1)).toHaveLength(135);
		expect(sourceDocumentCount(source.id)).toBe(5);
	});

	it("keeps pages that search missed but Notion still serves", async () => {
		const source = addSource();
		let results = [page("a", "A", "2026-02-01T00:00:00.000Z"), page("b", "B", "2026-02-01T00:00:00.000Z")];
		stubNotion((request) => {
			if (request.path === "/search") return searchResponse(results);
			if (request.path === "/pages/b") return Response.json(page("b", "B", "2026-03-01T00:00:00.000Z"));
			return markdownResponse("body");
		});
		await sync(source);

		results = [page("a", "A", "2026-02-01T00:00:00.000Z"), { object: "page", id: "b" }];
		const partial = await sync(source);
		results = [page("a", "A", "2026-02-01T00:00:00.000Z")];
		const missed = await sync(source);

		expect(partial.failures).toEqual([]);
		expect(missed.failures).toEqual([]);
		expect(sourceRows(source.id).find((entry) => entry.source_external_id === "b")).toMatchObject({ is_deleted: 0 });
	});

	it("drops pages outside a shrunken maxPages window without confirming each one", async () => {
		const source = addSource(5);
		const all = [5, 4, 3, 2, 1].map((day) => page(`d${day}`, `D${day}`, `2026-02-0${day}T00:00:00.000Z`));
		let maxPages = 5;
		const requests = stubNotion((request) => {
			if (request.path === "/search") {
				return searchResponse(all.slice(0, maxPages), { has_more: maxPages < all.length, next_cursor: "more" });
			}
			return markdownResponse("body");
		});
		await sync(source);

		maxPages = 2;
		const shrunk = addNotionSource({ tokenRef: "NOTION_TOKEN", maxPages: 2 }, dir);
		if (shrunk.ok === false) throw new Error(shrunk.error);
		requests.length = 0;
		const result = await sync(shrunk.source);

		expect(result.failures).toEqual([]);
		expect(requests.map((request) => request.path)).toEqual(["/search"]);
		const live = sourceRows(source.id)
			.filter((entry) => entry.source_kind === "source_notion_page" && entry.is_deleted === 0)
			.map((entry) => entry.source_external_id);
		expect(live.sort()).toEqual(["d4", "d5"]);
	});

	it("refetches a page edited in the same minute as the previous sync", async () => {
		const source = addSource();
		const minute = new Date(Math.floor((Date.now() + 10_000) / 60_000) * 60_000).toISOString();
		let body = "first";
		const requests = stubNotion((request) =>
			request.path === "/search" ? searchResponse([page("a", "A", minute)]) : markdownResponse(body),
		);
		await sync(source);

		body = "second";
		requests.length = 0;
		await sync(source);

		expect(requests.map((request) => request.path)).toEqual(["/search", "/pages/a/markdown"]);
		expect(sourceRows(source.id).find((entry) => entry.source_external_id === "a")?.content).toContain("second");
	});

	it("does not trust an artifact whose sync marker was never committed", async () => {
		const source = addSource();
		const requests = stubNotion((request) =>
			request.path === "/search"
				? searchResponse([page("a", "A", "2026-02-01T00:00:00.000Z")])
				: markdownResponse("body"),
		);
		await sync(source);
		getDbAccessor().withWriteTx((db) =>
			db
				.prepare(
					"UPDATE memory_artifacts SET source_meta_json = json_remove(source_meta_json, '$.syncedAtMs') WHERE source_id = ?",
				)
				.run(source.id),
		);

		requests.length = 0;
		await sync(source);

		expect(requests.map((request) => request.path)).toEqual(["/search", "/pages/a/markdown"]);
	});

	it("keeps a child's parent link when only the parent is reindexed", async () => {
		const source = addSource();
		let parentEdited = "2026-02-01T00:00:00.000Z";
		stubNotion((request) =>
			request.path === "/search"
				? searchResponse([
						page("parent", "Parent", parentEdited),
						page("child", "Child", "2026-02-01T00:00:00.000Z", { parent: { type: "page_id", page_id: "parent" } }),
					])
				: markdownResponse("body"),
		);
		await sync(source);

		parentEdited = "2026-02-02T00:00:00.000Z";
		await sync(source);

		const childPath = `notion://sources/${source.id}/pages/child`;
		const dangling = getDbAccessor().withReadDb(
			(db) =>
				(
					db
						.prepare(
							`SELECT COUNT(*) AS count FROM entity_dependencies d
							 LEFT JOIN entities e ON e.id = d.source_entity_id
							 WHERE d.source_id = ? AND d.source_path = ? AND e.id IS NULL`,
						)
						.get(source.id, childPath) as { count: number }
				).count,
		);
		const links = getDbAccessor().withReadDb(
			(db) =>
				(
					db
						.prepare("SELECT COUNT(*) AS count FROM entity_dependencies WHERE source_id = ? AND source_path = ?")
						.get(source.id, childPath) as { count: number }
				).count,
		);
		expect(links).toBeGreaterThan(0);
		expect(dangling).toBe(0);
	});

	it("renders unsupported blocks as placeholders without failing the sync", async () => {
		const source = addSource();
		const requests = stubNotion((request) => {
			if (request.path === "/search") return searchResponse([page("p", "Buttons", "2026-02-01T00:00:00.000Z")]);
			if (request.path === "/pages/p/markdown") {
				return Response.json({
					markdown: 'Intro\n<unknown url="https://www.notion.so/p#aaaa1111" alt="button"/>\nOutro',
					truncated: true,
					unknown_block_ids: ["aaaa-1111"],
				});
			}
			return Response.json({
				markdown: '<unknown url="https://www.notion.so/p#aaaa1111" alt="button"/>',
				truncated: true,
				unknown_block_ids: ["aaaa-1111"],
			});
		});

		const first = await sync(source);
		requests.length = 0;
		const second = await sync(source);

		expect(first.failures).toEqual([]);
		const artifact = sourceRows(source.id).find((entry) => entry.source_kind === "source_notion_page");
		expect(artifact?.content).toContain("Intro\n[Unsupported Notion block: button]\nOutro");
		expect(artifact?.content).not.toContain("<unknown");
		expect(JSON.parse(artifact?.source_meta_json ?? "{}")).toMatchObject({ incomplete: false, unsupportedBlocks: 1 });
		expect(second.failures).toEqual([]);
		expect(requests.map((request) => request.path)).toEqual(["/search"]);
	});

	it("substitutes unknown blocks that Notion can serve on their own", async () => {
		const source = addSource();
		stubNotion((request) => {
			if (request.path === "/search") return searchResponse([page("p", "Long", "2026-02-01T00:00:00.000Z")]);
			if (request.path === "/pages/p/markdown") {
				return Response.json({
					markdown: 'Start\n<unknown url="https://www.notion.so/p#bbbb2222" alt="toggle"/>',
					truncated: true,
					unknown_block_ids: ["bbbb-2222"],
				});
			}
			return Response.json({ markdown: "Recovered remainder", truncated: false, unknown_block_ids: [] });
		});

		const result = await sync(source);

		expect(result.failures).toEqual([]);
		const artifact = sourceRows(source.id).find((entry) => entry.source_kind === "source_notion_page");
		expect(artifact?.content).toContain("Start\nRecovered remainder");
		expect(JSON.parse(artifact?.source_meta_json ?? "{}")).toMatchObject({ incomplete: false, unsupportedBlocks: 0 });
	});

	it("reports unretrievable blocks and widens the block budget on the next sync", async () => {
		const source = addSource();
		const ids = Array.from({ length: 27 }, (_, index) => `block-${index}`);
		const requests = stubNotion((request) => {
			if (request.path === "/search") return searchResponse([page("big", "Big page", "2026-02-01T00:00:00.000Z")]);
			if (request.path === "/pages/big/markdown") {
				return Response.json({ markdown: "partial", truncated: true, unknown_block_ids: ids });
			}
			if (request.path === "/pages/block-0/markdown") {
				return Response.json({ code: "service_unavailable", message: "down" }, { status: 503 });
			}
			return Response.json({ markdown: "more", truncated: false, unknown_block_ids: [] });
		});

		const first = await sync(source);
		requests.length = 0;
		const second = await sync(source);

		expect(first.failures.map((failure) => failure.message)).toEqual([
			'Notion page "Big page" is incomplete: 3 block(s) could not be retrieved',
		]);
		expect(second.failures.map((failure) => failure.message)).toEqual([
			'Notion page "Big page" is incomplete: 1 block(s) could not be retrieved',
		]);
		expect(requests.some((request) => request.path === "/pages/big/markdown")).toBe(true);
		const artifact = sourceRows(source.id).find((entry) => entry.source_kind === "source_notion_page");
		expect(artifact?.content).toContain("1 Notion block(s) on this page could not be retrieved.");
		expect(JSON.parse(artifact?.source_meta_json ?? "{}")).toMatchObject({
			incomplete: true,
			missingBlocks: 1,
			resolutionBudget: 50,
		});
	});

	it("resolves nested unknown blocks and treats unresolved nested content as missing", async () => {
		const source = addSource();
		let deepFails = true;
		const requests = stubNotion((request) => {
			if (request.path === "/search") return searchResponse([page("p", "Nested", "2026-02-01T00:00:00.000Z")]);
			if (request.path === "/pages/p/markdown") {
				return Response.json({
					markdown: 'Top\n<unknown url="https://www.notion.so/p#sub1" alt="toggle"/>',
					truncated: true,
					unknown_block_ids: ["sub-1"],
				});
			}
			if (request.path === "/pages/sub-1/markdown") {
				return Response.json({
					markdown: 'Subtree start\n<unknown url="https://www.notion.so/p#deep1" alt="paragraph"/>',
					truncated: true,
					unknown_block_ids: ["deep-1"],
				});
			}
			if (deepFails) return Response.json({ code: "internal_server_error", message: "boom" }, { status: 500 });
			return Response.json({ markdown: "Deep content", truncated: false, unknown_block_ids: [] });
		});

		const failed = await sync(source);

		expect(failed.failures.map((failure) => failure.message)).toEqual([
			'Notion page "Nested" is incomplete: 1 block(s) could not be retrieved',
		]);
		let artifact = sourceRows(source.id).find((entry) => entry.source_kind === "source_notion_page");
		expect(artifact?.content).toContain("Top\nSubtree start\n[Missing Notion block: paragraph]");
		expect(JSON.parse(artifact?.source_meta_json ?? "{}")).toMatchObject({ incomplete: true });

		deepFails = false;
		requests.length = 0;
		const recovered = await sync(source);

		expect(recovered.failures).toEqual([]);
		artifact = sourceRows(source.id).find((entry) => entry.source_kind === "source_notion_page");
		expect(artifact?.content).toContain("Top\nSubtree start\nDeep content");
		expect(JSON.parse(artifact?.source_meta_json ?? "{}")).toMatchObject({ incomplete: false });
	});

	it("counts unknown tags that Notion did not list as missing", async () => {
		const source = addSource();
		stubNotion((request) =>
			request.path === "/search"
				? searchResponse([page("p", "Unlisted", "2026-02-01T00:00:00.000Z")])
				: Response.json({
						markdown: 'Body\n<unknown url="https://www.notion.so/p#orphan" alt="synced_block"/>',
						truncated: false,
						unknown_block_ids: [],
					}),
		);

		const result = await sync(source);

		expect(result.failures.map((failure) => failure.message)).toEqual([
			'Notion page "Unlisted" is incomplete: 1 block(s) could not be retrieved',
		]);
	});

	it("finishes classifying more unsupported blocks than one sync's budget", async () => {
		const source = addSource();
		const ids = Array.from({ length: 30 }, (_, index) => `embed-${index}`);
		const markdown = ids.map((id) => `<unknown url="https://www.notion.so/p#${id}" alt="embed"/>`).join("\n");
		const requests = stubNotion((request) => {
			if (request.path === "/search") return searchResponse([page("p", "Embeds", "2026-02-01T00:00:00.000Z")]);
			if (request.path === "/pages/p/markdown") {
				return Response.json({ markdown, truncated: true, unknown_block_ids: ids });
			}
			const id = request.path.split("/")[2] ?? "";
			return Response.json({
				markdown: `<unknown url="https://www.notion.so/p#${id}" alt="embed"/>`,
				truncated: true,
				unknown_block_ids: [id],
			});
		});

		const first = await sync(source);
		requests.length = 0;
		const second = await sync(source);
		const secondRequests = requests.length;
		requests.length = 0;
		const third = await sync(source);

		expect(first.failures.map((failure) => failure.message)).toEqual([
			'Notion page "Embeds" is incomplete: 5 block(s) could not be retrieved',
		]);
		expect(second.failures).toEqual([]);
		expect(secondRequests).toBe(1 + 1 + 5);
		expect(third.failures).toEqual([]);
		expect(requests.map((request) => request.path)).toEqual(["/search"]);
		const artifact = sourceRows(source.id).find((entry) => entry.source_kind === "source_notion_page");
		expect(artifact?.content.match(/\[Unsupported Notion block: embed\]/g)).toHaveLength(30);
	});

	it("drops unseen pages tied at the maxPages window floor", async () => {
		const edited = "2026-02-01T00:00:00.000Z";
		const ids = Array.from({ length: 10 }, (_, index) => `t${index}`);
		const wide = addSource(10);
		let maxPages = 10;
		const requests = stubNotion((request) => {
			if (request.path === "/search") {
				return searchResponse(
					ids.slice(0, maxPages).map((id) => page(id, id, edited)),
					{ has_more: maxPages < ids.length, next_cursor: "more" },
				);
			}
			if (request.path.endsWith("/markdown")) return markdownResponse("body");
			const id = request.path.split("/")[2] ?? "";
			return Response.json(page(id, id, edited));
		});
		await sync(wide);

		maxPages = 3;
		const narrow = addNotionSource({ tokenRef: "NOTION_TOKEN", maxPages: 3 }, dir);
		if (narrow.ok === false) throw new Error(narrow.error);
		requests.length = 0;
		const result = await sync(narrow.source);

		expect(result.failures).toEqual([]);
		expect(requests.filter((request) => request.path.startsWith("/pages/"))).toHaveLength(7);
		const live = sourceRows(wide.id).filter(
			(entry) => entry.source_kind === "source_notion_page" && entry.is_deleted === 0,
		);
		expect(live).toHaveLength(3);
	});

	it("rotates removal lookups so a deleted page is eventually confirmed", async () => {
		const source = addSource();
		const live = Array.from({ length: 205 }, (_, index) => `a-${String(index).padStart(3, "0")}`);
		seedPageRows(source.id, [...live, "zz-gone"], Date.parse("2026-02-01T00:00:00.000Z"), Date.now());
		stubNotion((request) => {
			if (request.path === "/search") return searchResponse([]);
			const id = request.path.split("/")[2] ?? "";
			if (id === "zz-gone") return Response.json({ code: "object_not_found", message: "gone" }, { status: 404 });
			return Response.json(page(id, id, "2026-02-01T00:00:00.000Z"));
		});

		const first = await sync(source);
		const gone = () => sourceRows(source.id).find((entry) => entry.source_external_id === "zz-gone");
		expect(first.failures.map((failure) => failure.message)).toEqual([
			"Could not confirm removal of 6 Notion page(s); kept them for the next sync",
		]);
		expect(gone()).toMatchObject({ is_deleted: 0 });

		await sync(source);

		expect(gone()).toMatchObject({ is_deleted: 1 });
	});

	it("leaves literal unknown text and custom elements untouched", async () => {
		const source = addSource();
		const body = '```html\n<unknown-element id="a">hi</unknown-element>\n```\n<unknown>';
		stubNotion((request) =>
			request.path === "/search"
				? searchResponse([page("p", "Literal", "2026-02-01T00:00:00.000Z")])
				: Response.json({ markdown: body, truncated: false, unknown_block_ids: [] }),
		);

		const result = await sync(source);

		expect(result.failures).toEqual([]);
		expect(sourceRows(source.id).find((entry) => entry.source_external_id === "p")?.content).toContain(body);
	});

	it("uses Notion's response time to decide whether a same-minute edit was captured", async () => {
		const source = addSource();
		const requests = stubNotion((request) =>
			request.path === "/search"
				? searchResponse([page("a", "A", "2026-02-01T00:00:00.000Z")])
				: new Response(JSON.stringify({ markdown: "body", truncated: false, unknown_block_ids: [] }), {
						headers: { "content-type": "application/json", date: "Sun, 01 Feb 2026 00:00:30 GMT" },
					}),
		);
		await sync(source);
		requests.length = 0;

		await sync(source);

		expect(requests.map((request) => request.path)).toEqual(["/search", "/pages/a/markdown"]);
	});

	it("stops a sync after repeated transient request failures", async () => {
		const source = addSource();
		const ids = Array.from({ length: 20 }, (_, index) => `p${index}`);
		const requests = stubNotion((request) =>
			request.path === "/search"
				? searchResponse(ids.map((id) => page(id, id, "2026-02-01T00:00:00.000Z")))
				: Response.json({ code: "rate_limited", message: "slow" }, { status: 429, headers: { "Retry-After": "60" } }),
		);

		const result = await sync(source);

		expect(requests.filter((request) => request.path.endsWith("/markdown"))).toHaveLength(5 * 4);
		expect(result.scanned).toBe(5);
		expect(result.failures.at(-1)?.message).toBe(
			"Stopped after 5 consecutive Notion request failures; 15 page(s) were not attempted",
		);
	});

	it("stops a sync immediately when Notion rejects the token", async () => {
		const source = addSource();
		const requests = stubNotion((request) =>
			request.path === "/search"
				? searchResponse(["a", "b", "c"].map((id) => page(id, id, "2026-02-01T00:00:00.000Z")))
				: Response.json({ code: "unauthorized", message: "API token is invalid." }, { status: 401 }),
		);

		const result = await sync(source);

		expect(requests.filter((request) => request.path.endsWith("/markdown"))).toHaveLength(1);
		expect(result.failures.at(-1)?.message).toBe("Notion rejected the integration token; 2 page(s) were not attempted");
	});

	it("stops at the sync deadline and leaves the rest for the next sync", async () => {
		const source = addSource();
		setNotionSyncDeadlineForTest(-1);
		const requests = stubNotion((request) =>
			request.path === "/search"
				? searchResponse(["a", "b"].map((id) => page(id, id, "2026-02-01T00:00:00.000Z")))
				: markdownResponse("body"),
		);

		const result = await sync(source);

		expect(requests.map((request) => request.path)).toEqual(["/search"]);
		expect(result.failures.at(-1)?.message).toContain("deadline; 2 page(s) were not attempted");
	});

	it("halts removal lookups after repeated transient failures", async () => {
		const source = addSource();
		seedPageRows(
			source.id,
			Array.from({ length: 20 }, (_, index) => `gone-${index}`),
			Date.parse("2026-02-01T00:00:00.000Z"),
			Date.now(),
		);
		const requests = stubNotion((request) =>
			request.path === "/search"
				? searchResponse([])
				: Response.json({ code: "service_unavailable", message: "down" }, { status: 503 }),
		);

		const result = await sync(source);

		expect(requests.filter((request) => request.path.startsWith("/pages/"))).toHaveLength(5 * 4);
		expect(result.failures.map((failure) => failure.message)).toEqual([
			"Could not confirm removal of 20 Notion page(s); kept them for the next sync",
		]);
	});

	it("never rewrites unknown-tag text inside code", async () => {
		const source = addSource();
		const body =
			'Docs:\n```html\n<unknown url="https://example.com/x" alt="demo"/>\n```\nInline `<unknown url="u" alt="a"/>` too.';
		stubNotion((request) =>
			request.path === "/search"
				? searchResponse([page("p", "Format", "2026-02-01T00:00:00.000Z")])
				: Response.json({ markdown: body, truncated: false, unknown_block_ids: [] }),
		);

		const result = await sync(source);

		expect(result.failures).toEqual([]);
		expect(sourceRows(source.id).find((entry) => entry.source_external_id === "p")?.content).toContain(body);
	});

	it("widens the budget so pages with many resolvable blocks converge", async () => {
		const source = addSource();
		const ids = Array.from({ length: 30 }, (_, index) => `blk-${index}`);
		const markdown = ids.map((id) => `<unknown url="https://www.notion.so/p#${id}" alt="toggle"/>`).join("\n");
		stubNotion((request) => {
			if (request.path === "/search") return searchResponse([page("p", "Long", "2026-02-01T00:00:00.000Z")]);
			if (request.path === "/pages/p/markdown")
				return Response.json({ markdown, truncated: true, unknown_block_ids: ids });
			return Response.json({
				markdown: `content ${request.path.split("/")[2]}`,
				truncated: false,
				unknown_block_ids: [],
			});
		});

		const first = await sync(source);
		const second = await sync(source);

		expect(first.failures.map((failure) => failure.message)).toEqual([
			'Notion page "Long" is incomplete: 5 block(s) could not be retrieved',
		]);
		expect(second.failures).toEqual([]);
		const artifact = sourceRows(source.id).find((entry) => entry.source_kind === "source_notion_page");
		expect(artifact?.content).toContain("content blk-29");
		expect(artifact?.content).not.toContain("[Missing Notion block");
	});

	it("caps stored page content and marks it clipped", async () => {
		const source = addSource();
		stubNotion((request) =>
			request.path === "/search"
				? searchResponse([page("p", "Huge", "2026-02-01T00:00:00.000Z")])
				: markdownResponse("x".repeat(NOTION_MAX_PAGE_CHARS + 50_000)),
		);

		const result = await sync(source);

		expect(result.failures).toEqual([]);
		const artifact = sourceRows(source.id).find((entry) => entry.source_external_id === "p");
		expect(artifact?.content.length).toBeLessThan(NOTION_MAX_PAGE_CHARS + 1_000);
		expect(artifact?.content).toContain("Signet stored the first 750,000 characters of this page.");
		expect(JSON.parse(artifact?.source_meta_json ?? "{}")).toMatchObject({ clipped: true });
	});

	it("refetches a page whose properties changed without an edit", async () => {
		const source = addSource();
		let score = 1;
		const requests = stubNotion((request) =>
			request.path === "/search"
				? searchResponse([
						page("row", "Row", "2026-02-01T00:00:00.000Z", {
							properties: {
								Name: { type: "title", title: [{ plain_text: "Row" }] },
								Score: { type: "formula", formula: { type: "number", number: score } },
							},
						}),
					])
				: markdownResponse("body"),
		);
		await sync(source);

		requests.length = 0;
		await sync(source);
		expect(requests.map((request) => request.path)).toEqual(["/search"]);

		score = 2;
		requests.length = 0;
		await sync(source);
		expect(requests.map((request) => request.path)).toEqual(["/search", "/pages/row/markdown"]);
		expect(sourceRows(source.id).find((entry) => entry.source_external_id === "row")?.content).toContain("- Score: 2");
	});

	it("confirms floor-adjacent pages before dropping them from a capped window", async () => {
		const source = addSource(2);
		seedPageRows(source.id, ["lagged"], Date.parse("2026-02-04T00:00:30.000Z"), Date.now());
		seedPageRows(source.id, ["old"], Date.parse("2026-01-01T00:00:00.000Z"), Date.now());
		const requests = stubNotion((request) => {
			if (request.path === "/search") {
				return searchResponse(
					[page("a", "A", "2026-02-05T00:00:00.000Z"), page("b", "B", "2026-02-04T00:01:00.000Z")],
					{ has_more: true, next_cursor: "more" },
				);
			}
			if (request.path === "/pages/lagged") return Response.json(page("lagged", "Lagged", "2026-02-06T00:00:00.000Z"));
			return markdownResponse("body");
		});

		const result = await sync(source);

		expect(result.failures).toEqual([]);
		expect(requests.filter((request) => /^\/pages\/[^/]+$/.test(request.path)).map((request) => request.path)).toEqual([
			"/pages/lagged",
		]);
		const rows = sourceRows(source.id);
		expect(rows.find((entry) => entry.source_external_id === "lagged")).toMatchObject({ is_deleted: 0 });
		expect(rows.find((entry) => entry.source_external_id === "old")).toMatchObject({ is_deleted: 1 });
	});

	it("treats a trashed page lookup as removed", async () => {
		const source = addSource();
		let results = [page("a", "A", "2026-02-01T00:00:00.000Z"), page("t", "T", "2026-02-01T00:00:00.000Z")];
		stubNotion((request) => {
			if (request.path === "/search") return searchResponse(results);
			if (request.path === "/pages/t")
				return Response.json(page("t", "T", "2026-02-02T00:00:00.000Z", { in_trash: true }));
			return markdownResponse("body");
		});
		await sync(source);

		results = [page("a", "A", "2026-02-01T00:00:00.000Z")];
		const result = await sync(source);

		expect(result.failures).toEqual([]);
		expect(sourceRows(source.id).find((entry) => entry.source_external_id === "t")).toMatchObject({ is_deleted: 1 });
	});

	it("classifies an inaccessible nested block as unsupported", async () => {
		const source = addSource();
		stubNotion((request) => {
			if (request.path === "/search") return searchResponse([page("p", "Synced", "2026-02-01T00:00:00.000Z")]);
			if (request.path === "/pages/p/markdown") {
				return Response.json({
					markdown: 'Body\n<unknown url="https://www.notion.so/p#locked1" alt="synced_block"/>',
					truncated: true,
					unknown_block_ids: ["locked-1"],
				});
			}
			return Response.json({ code: "restricted_resource", message: "no access" }, { status: 403 });
		});

		const result = await sync(source);

		expect(result.failures).toEqual([]);
		const artifact = sourceRows(source.id).find((entry) => entry.source_kind === "source_notion_page");
		expect(artifact?.content).toContain("[Unsupported Notion block: synced_block]");
		expect(JSON.parse(artifact?.source_meta_json ?? "{}")).toMatchObject({ incomplete: false, unsupportedBlocks: 1 });
	});

	it("keeps agents isolated when they sync the same source", async () => {
		const source = addSource();
		let results = [page("a", "A", "2026-02-01T00:00:00.000Z"), page("b", "B", "2026-02-01T00:00:00.000Z")];
		stubNotion((request) => {
			if (request.path === "/search") return searchResponse(results);
			if (request.path === "/pages/b")
				return Response.json({ code: "object_not_found", message: "gone" }, { status: 404 });
			return markdownResponse("body");
		});
		await sync(source);
		await syncNotionSource({ source, agentsDir: dir, agentId: "other", shouldContinue: () => true, getSecret });

		results = [page("a", "A", "2026-02-01T00:00:00.000Z")];
		await syncNotionSource({ source, agentsDir: dir, agentId: "other", shouldContinue: () => true, getSecret });

		const rows = agentRows(source.id);
		expect(rows.filter((row) => row.agent_id === "default" && row.is_deleted === 0)).toHaveLength(2);
		expect(rows.find((row) => row.agent_id === "other" && row.source_external_id === "b")).toMatchObject({
			is_deleted: 1,
		});
	});

	it("keeps two Notion sources independent when they share a page", async () => {
		await putSecret("NOTION_TOKEN_TWO", "second-token-value");
		const first = addSource();
		const added = addNotionSource({ tokenRef: "NOTION_TOKEN_TWO" }, dir);
		if (added.ok === false) throw new Error(added.error);
		const second = added.source;
		let secondSees = true;
		stubNotion((request) => {
			const isSecond = request.headers.get("authorization") === "Bearer second-token-value";
			if (request.path === "/search")
				return searchResponse(isSecond && !secondSees ? [] : [page("shared", "Shared", "2026-02-01T00:00:00.000Z")]);
			if (request.path === "/pages/shared")
				return Response.json({ code: "object_not_found", message: "gone" }, { status: 404 });
			return markdownResponse("body");
		});
		await sync(first);
		await sync(second);

		secondSees = false;
		await sync(second);

		expect(sourceRows(first.id).find((entry) => entry.source_external_id === "shared")).toMatchObject({
			is_deleted: 0,
		});
		expect(sourceRows(second.id).find((entry) => entry.source_external_id === "shared")).toMatchObject({
			is_deleted: 1,
		});
	});

	it("retries a rate limit whose body is not JSON", async () => {
		const source = addSource();
		let searches = 0;
		stubNotion((request) => {
			if (request.path !== "/search") return markdownResponse("body");
			searches++;
			if (searches === 1) return new Response("Too Many Requests", { status: 429, headers: { "Retry-After": "3" } });
			return searchResponse([]);
		});

		const result = await sync(source);

		expect(result.failures).toEqual([]);
		expect(searches).toBe(2);
		expect(sleeps).toEqual([3_000]);
	});

	it("stops issuing requests and skips purge once the sync is cancelled", async () => {
		const source = addSource();
		let results = [page("a", "A", "2026-02-01T00:00:00.000Z"), page("b", "B", "2026-02-01T00:00:00.000Z")];
		const requests = stubNotion((request) =>
			request.path === "/search" ? searchResponse(results) : markdownResponse("body"),
		);
		await sync(source);

		results = [page("a", "A", "2026-02-05T00:00:00.000Z")];
		requests.length = 0;
		let active = true;
		const result = await syncNotionSource({
			source,
			agentsDir: dir,
			agentId: "default",
			shouldContinue: () => active,
			getSecret,
			onProgress: (event) => {
				if (event.currentPath.endsWith("/pages/a")) active = false;
			},
		});

		expect(result).toBeDefined();
		expect(requests.map((request) => request.path)).toEqual(["/search"]);
		expect(sourceRows(source.id).find((entry) => entry.source_external_id === "b")).toMatchObject({ is_deleted: 0 });
	});
});

function seedPageRows(sourceId: string, ids: readonly string[], editedMs: number, syncedAtMs: number): void {
	getDbAccessor().withWriteTx((db) => {
		const insert = db.prepare(
			`INSERT INTO memory_artifacts
			 (agent_id, source_path, source_sha256, source_kind, session_id, session_token, harness, captured_at,
			  content, updated_at, source_mtime_ms, source_id, source_external_id, source_meta_json)
			 VALUES ('default', ?, ?, 'source_notion_page', ?, ?, 'notion', ?, 'seeded', ?, ?, ?, ?, ?)`,
		);
		const iso = new Date(editedMs).toISOString();
		for (const id of ids) {
			const path = `notion://sources/${sourceId}/pages/${id}`;
			insert.run(
				path,
				`sha-${id}`,
				`native:notion:${path}`,
				`token-${id}`,
				iso,
				iso,
				editedMs,
				sourceId,
				id,
				JSON.stringify({
					provider: "notion",
					pageId: id,
					incomplete: false,
					syncedAtMs,
					propertiesHash: seededHash(id, iso),
				}),
			);
		}
	});
}

function seededHash(id: string, lastEditedTime: string): string {
	const parsed = parseNotionPage(page(id, id, lastEditedTime));
	if (!parsed) throw new Error("seed page did not parse");
	return propertiesHash(parsed);
}

function agentRows(
	sourceId: string,
): Array<{ agent_id: string; source_external_id: string | null; is_deleted: number }> {
	return getDbAccessor().withReadDb(
		(db) =>
			db
				.prepare(
					`SELECT agent_id, source_external_id, COALESCE(is_deleted, 0) AS is_deleted
					 FROM memory_artifacts WHERE source_id = ? AND source_kind = 'source_notion_page'`,
				)
				.all(sourceId) as Array<{ agent_id: string; source_external_id: string | null; is_deleted: number }>,
	);
}

function sourceDocumentCount(sourceId: string): number {
	return getDbAccessor().withReadDb(
		(db) =>
			(
				db
					.prepare("SELECT COUNT(*) AS count FROM entities WHERE source_id = ? AND entity_type = 'source_document'")
					.get(sourceId) as { count: number }
			).count,
	);
}

function sourceRows(sourceId: string): Array<{
	source_kind: string;
	source_path: string;
	source_external_id: string | null;
	source_parent_path: string | null;
	source_meta_json: string | null;
	content: string;
	is_deleted: number;
}> {
	return getDbAccessor().withReadDb(
		(db) =>
			db
				.prepare(
					`SELECT source_kind, source_path, source_external_id, source_parent_path, source_meta_json, content,
					        COALESCE(is_deleted, 0) AS is_deleted
					 FROM memory_artifacts
					 WHERE source_id = ?
					 ORDER BY source_path ASC`,
				)
				.all(sourceId) as Array<{
				source_kind: string;
				source_path: string;
				source_external_id: string | null;
				source_parent_path: string | null;
				source_meta_json: string | null;
				content: string;
				is_deleted: number;
			}>,
	);
}
