import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWebSource } from "@signet/core";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import {
	WEB_MAX_RESPONSE_BYTES,
	fetchPublicWebPage,
	setWebDnsLookupForTest,
	setWebFetchTimeoutForTest,
	setWebRequestForTest,
	webSourceProvider,
} from "./web-source-provider";

describe("web-source-provider", () => {
	let dir = "";
	let previousSignetPath: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-web-source-"));
		previousSignetPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = dir;
		mkdirSync(join(dir, "memory"), { recursive: true });
		closeDbAccessor();
		initDbAccessor(join(dir, "memory", "memories.db"));
		setWebDnsLookupForTest((async () => [
			{ address: "93.184.216.34", family: 4 },
		]) as typeof import("node:dns/promises").lookup);
	});

	afterEach(() => {
		setWebDnsLookupForTest(null);
		setWebFetchTimeoutForTest(null);
		setWebRequestForTest(null);
		closeDbAccessor();
		if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = previousSignetPath;
		rmSync(dir, { recursive: true, force: true });
	});

	it("extracts Markdown and metadata with source provenance", async () => {
		setWebRequestForTest(
			async () =>
				new Response(
					"<html lang='en'><head><title>Example article</title><meta name='author' content='Alice'><link rel='canonical' href='https://example.com/canonical/article'></head><body><article><h1>Example article</h1><p>This is readable source-backed content.</p></article></body></html>",
					{ headers: { "content-type": "text/html; charset=utf-8" } },
				),
		);
		const added = addWebSource({ url: "https://example.com/article", name: "Example" }, dir);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);
		const result = await webSourceProvider.sync?.({
			source: added.source,
			agentsDir: dir,
			agentId: "web-test-agent",
			shouldContinue: () => true,
		});
		expect(result?.failures).toEqual([]);
		expect(result?.indexed).toBe(1);
		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						"SELECT source_kind, source_path, source_external_id, source_meta_json, content FROM memory_artifacts WHERE source_id = ?",
					)
					.all(added.source.id) as Array<Record<string, string>>,
		);
		const page = rows.find((row) => row.source_kind === "source_web_page");
		expect(page?.source_path).toBe(`web://source/${encodeURIComponent(added.source.id)}/example.com/article`);
		expect(page?.source_external_id).toBe("https://example.com/canonical/article");
		expect(page?.content).toContain("This is readable source-backed content.");
		expect(page?.source_meta_json).toContain("originalUrl");
		expect(page?.source_meta_json).toContain("canonical/article");
		const graphDocs = getDbAccessor().withReadDb(
			(db) =>
				(
					db
						.prepare("SELECT COUNT(*) AS count FROM entities WHERE source_id = ? AND entity_type = 'source_document'")
						.get(added.source.id) as { count: number }
				).count,
		);
		expect(graphDocs).toBeGreaterThan(0);
	});

	it("keeps old page evidence and writes a failure artifact when fetch fails", async () => {
		setWebRequestForTest(async () => new Response("denied", { status: 403 }));
		const added = addWebSource({ url: "https://example.com/private" }, dir);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);
		const result = await webSourceProvider.sync?.({
			source: added.source,
			agentsDir: dir,
			agentId: "web-test-agent",
			shouldContinue: () => true,
		});
		expect(result?.failures).toHaveLength(1);
		expect(result?.indexed).toBe(1);
		const failure = getDbAccessor().withReadDb((db) =>
			(
				db
					.prepare("SELECT source_kind, content FROM memory_artifacts WHERE source_id = ?")
					.all(added.source.id) as Array<Record<string, string>>
			).find((row) => row.source_kind === "source_web_failure"),
		);
		expect(failure?.content).toContain("HTTP 403");
	});

	it("rejects oversized responses before extraction", async () => {
		setWebRequestForTest(
			async () =>
				new Response("tiny", {
					headers: { "content-type": "text/html", "content-length": String(WEB_MAX_RESPONSE_BYTES + 1) },
				}),
		);
		const added = addWebSource({ url: "https://example.com/large" }, dir);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);
		const result = await webSourceProvider.sync?.({
			source: added.source,
			agentsDir: dir,
			agentId: "web-test-agent",
			shouldContinue: () => true,
		});
		expect(result?.failures[0]?.metadata).toMatchObject({ code: "response_size" });
	});

	it("pins the validated address and does not resolve the hostname again", async () => {
		let lookupCount = 0;
		let pinnedAddress = "";
		setWebDnsLookupForTest((async (hostname) => {
			lookupCount += 1;
			expect(hostname).toBe("example.com");
			return lookupCount === 1 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "192.168.1.1", family: 4 }];
		}) as typeof import("node:dns/promises").lookup);
		setWebRequestForTest(async (_url, options) => {
			pinnedAddress = options.address;
			return new Response("<html><body>body</body></html>", { headers: { "content-type": "text/html" } });
		});

		const fetched = await fetchPublicWebPage("https://example.com/article");
		expect(fetched.responseBytes).toBeGreaterThan(0);
		expect(lookupCount).toBe(1);
		expect(pinnedAddress).toBe("93.184.216.34");
	});

	it("normalizes bracketed IPv6 host literals before DNS lookup", async () => {
		let resolvedHostname = "";
		setWebDnsLookupForTest((async (hostname) => {
			resolvedHostname = hostname;
			return [{ address: "2001:4860:4860::8888", family: 6 }];
		}) as typeof import("node:dns/promises").lookup);
		setWebRequestForTest(async (_url, options) => {
			expect(options.address).toBe("2001:4860:4860::8888");
			expect(options.family).toBe(6);
			return new Response("<html><body>IPv6 body</body></html>", {
				headers: { "content-type": "text/html" },
			});
		});

		await fetchPublicWebPage("https://[2001:4860:4860::8888]/article");
		expect(resolvedHostname).toBe("2001:4860:4860::8888");
	});

	it("keeps the deadline active through a stalled response body", async () => {
		setWebFetchTimeoutForTest(25);
		let bodyAborted = false;
		setWebRequestForTest(async (_url, options) => {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					options.signal.addEventListener(
						"abort",
						() => {
							bodyAborted = true;
							controller.error(new Error("body aborted"));
						},
						{ once: true },
					);
				},
				cancel() {
					bodyAborted = true;
				},
			});
			return new Response(body, { headers: { "content-type": "text/html" } });
		});

		const error = await fetchPublicWebPage("https://example.com/stalled").catch((caught) => caught);
		expect(error).toMatchObject({ code: "timeout" });
		expect(bodyAborted).toBe(true);
	});

	it("treats a malformed canonical link as absent", async () => {
		setWebRequestForTest(
			async () =>
				new Response(
					"<html><head><link rel='canonical' href='http://[broken'></head><body><article><h1>Malformed canonical</h1><p>Readable body.</p></article></body></html>",
					{ headers: { "content-type": "text/html" } },
				),
		);
		const added = addWebSource({ url: "https://example.com/malformed" }, dir);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);

		await webSourceProvider.sync?.({
			source: added.source,
			agentsDir: dir,
			agentId: "web-test-agent",
			shouldContinue: () => true,
		});
		const page = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						"SELECT source_external_id, source_meta_json FROM memory_artifacts WHERE source_id = ? AND source_kind = 'source_web_page'",
					)
					.get(added.source.id) as Record<string, string> | undefined,
		);
		expect(page?.source_external_id).toBe("https://example.com/malformed");
		expect(page?.source_meta_json).toContain('"canonicalUrl":null');
	});

	it("keeps redirected aliases isolated by source ownership", async () => {
		const pageHtml = "<html><body><article><h1>Shared article</h1><p>Shared body.</p></article></body></html>";
		setWebRequestForTest(async (url) => {
			if (url.endsWith("/alias-a") || url.endsWith("/alias-b")) {
				return new Response(null, {
					status: 302,
					headers: { location: "https://example.com/article" },
				});
			}
			return new Response(pageHtml, { headers: { "content-type": "text/html" } });
		});
		const first = addWebSource({ url: "https://example.com/alias-a" }, dir);
		const second = addWebSource({ url: "https://example.com/alias-b" }, dir);
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (first.ok === false || second.ok === false) throw new Error("Expected both aliases to be added");

		for (const source of [first.source, second.source]) {
			const result = await webSourceProvider.sync?.({
				source,
				agentsDir: dir,
				agentId: "web-test-agent",
				shouldContinue: () => true,
			});
			expect(result?.failures).toEqual([]);
		}
		const pages = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						"SELECT source_id, source_path FROM memory_artifacts WHERE agent_id = ? AND source_kind = 'source_web_page' AND COALESCE(is_deleted, 0) = 0 ORDER BY source_id",
					)
					.all("web-test-agent") as Array<{ source_id: string; source_path: string }>,
		);
		expect(pages).toHaveLength(2);
		expect(new Set(pages.map((page) => page.source_id))).toEqual(new Set([first.source.id, second.source.id]));
		expect(new Set(pages.map((page) => page.source_path)).size).toBe(2);
	});

	it("rejects responses without an HTML content type", async () => {
		setWebRequestForTest(async () => new Response('{"ok":true}', { headers: { "content-type": "application/json" } }));
		const added = addWebSource({ url: "https://example.com/data" }, dir);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);
		const result = await webSourceProvider.sync?.({
			source: added.source,
			agentsDir: dir,
			agentId: "web-test-agent",
			shouldContinue: () => true,
		});
		expect(result?.failures[0]?.metadata).toMatchObject({ code: "content_type" });
	});
});
