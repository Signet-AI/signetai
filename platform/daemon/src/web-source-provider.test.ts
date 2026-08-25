import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWebSource } from "@signet/core";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { WEB_MAX_RESPONSE_BYTES, setWebDnsLookupForTest, webSourceProvider } from "./web-source-provider";

const originalFetch = globalThis.fetch;

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
		globalThis.fetch = originalFetch;
		setWebDnsLookupForTest(null);
		closeDbAccessor();
		if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = previousSignetPath;
		rmSync(dir, { recursive: true, force: true });
	});

	it("extracts Markdown and metadata with source provenance", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(
					"<html lang='en'><head><title>Example article</title><meta name='author' content='Alice'><link rel='canonical' href='https://example.com/article'></head><body><article><h1>Example article</h1><p>This is readable source-backed content.</p></article></body></html>",
					{ headers: { "content-type": "text/html; charset=utf-8" } },
				),
			),
		) as typeof fetch;
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
		expect(page?.source_path).toBe("web://example.com/article");
		expect(page?.source_external_id).toBe("https://example.com/article");
		expect(page?.content).toContain("This is readable source-backed content.");
		expect(page?.source_meta_json).toContain("originalUrl");
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
		globalThis.fetch = mock(() => Promise.resolve(new Response("denied", { status: 403 }))) as typeof fetch;
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
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response("tiny", {
					headers: { "content-type": "text/html", "content-length": String(WEB_MAX_RESPONSE_BYTES + 1) },
				}),
			),
		) as typeof fetch;
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

	it("rejects responses without an HTML content type", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response('{"ok":true}', { headers: { "content-type": "application/json" } })),
		) as typeof fetch;
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
