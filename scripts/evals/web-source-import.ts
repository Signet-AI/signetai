/**
 * Deterministic evaluation for the Web page source importer.
 *
 * Run with: bun scripts/evals/web-source-import.ts
 * The fixed HTML fixture proves source config, bounded fetch, Defuddle
 * Markdown extraction, metadata/provenance, and source graph indexing without
 * reaching the public network.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWebSource } from "../../platform/core/src/index";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../../platform/daemon/src/db-accessor";
import {
	webSourceProvider,
	setWebDnsLookupForTest,
	setWebRequestForTest,
} from "../../platform/daemon/src/web-source-provider";

const previousSignetPath = process.env.SIGNET_PATH;
const dir = mkdtempSync(join(tmpdir(), "signet-web-source-eval-"));
process.env.SIGNET_PATH = dir;
mkdirSync(join(dir, "memory"), { recursive: true });
closeDbAccessor();
initDbAccessor(join(dir, "memory", "memories.db"));
setWebDnsLookupForTest((async () => [
	{ address: "93.184.216.34", family: 4 },
]) as typeof import("node:dns/promises").lookup);
setWebRequestForTest(
	async () =>
		new Response(
			"<html><head><title>Eval article</title><meta name='author' content='Eval Author'><link rel='canonical' href='https://example.com/eval'></head><body><article><h1>Eval article</h1><p>Fixed source-backed content for the Web page import evaluation.</p></article></body></html>",
			{ headers: { "content-type": "text/html; charset=utf-8" } },
		),
);

let passed = false;
try {
	const added = addWebSource({ url: "https://example.com/eval" }, dir);
	if (!added.ok) throw new Error(added.error);
	const result = await webSourceProvider.sync?.({
		source: added.source,
		agentsDir: dir,
		agentId: "web-eval-agent",
		shouldContinue: () => true,
	});
	const rows = getDbAccessor().withReadDb(
		(db) =>
			db
				.prepare(
					"SELECT source_kind, source_path, source_external_id, content FROM memory_artifacts WHERE source_id = ? AND is_deleted = 0",
				)
				.all(added.source.id) as Array<Record<string, string>>,
	);
	const page = rows.find((row) => row.source_kind === "source_web_page");
	const graphDocs = getDbAccessor().withReadDb(
		(db) =>
			(
				db
					.prepare("SELECT COUNT(*) AS count FROM entities WHERE source_id = ? AND entity_type = 'source_document'")
					.get(added.source.id) as { count: number }
			).count,
	);
	const checks = {
		indexedOnePage: result?.failures.length === 0 && result.indexed === 1,
		markdownAndProvenance:
			page?.content.includes("Fixed source-backed content") === true &&
			page.source_external_id === "https://example.com/eval",
		canonicalPath: page?.source_path === `web://source/${encodeURIComponent(added.source.id)}/example.com/eval`,
		graphIndexed: graphDocs > 0,
	};
	passed = Object.values(checks).every(Boolean);
	console.log(JSON.stringify({ eval: "web-source-import", passed, checks }, null, 2));
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
} finally {
	setWebDnsLookupForTest(null);
	setWebRequestForTest(null);
	closeDbAccessor();
	rmSync(dir, { recursive: true, force: true });
	if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
	else process.env.SIGNET_PATH = previousSignetPath;
}
process.exit(passed ? 0 : 1);
