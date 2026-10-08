import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { threadId } from "node:worker_threads";
import { type SecretKeyringAdapter, type SignetSourceEntry, addNotionSource, addWebSource } from "@signet/core";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { type LogEntry, logger } from "./logger";
import { getSecret, putSecret, setSecretKeyringAdapterForTests } from "./secrets";
import type { SourceProviderProgressEvent, SourceProviderSyncContext } from "./source-providers";
import { closeSourceSyncWorkers, runSourceSyncInWorker } from "./source-sync-worker-handle";

const TOKEN = "notion-worker-token-value";
const WORKER_MODULE = join(import.meta.dir, "source-sync-worker.ts");

function memoryKeyring(): SecretKeyringAdapter {
	let stored: string | undefined;
	const read = async () =>
		stored === undefined ? { state: "missing" as const } : { state: "found" as const, value: stored };
	return {
		platform: "test",
		service: "ai.signet.secrets",
		account: "source-sync-worker-test",
		get: read,
		getStatus: read,
		async set(value: string) {
			stored = value;
			return { state: "found" as const, value };
		},
	};
}

function notionFetchStub(options: { readonly busyMs?: number } = {}): string {
	return `
const TOKEN = ${JSON.stringify(TOKEN)};
const BUSY_MS = ${options.busyMs ?? 0};
globalThis.fetch = async (input, init) => {
	const url = new URL(String(input));
	if (new Headers(init?.headers).get("authorization") !== "Bearer " + TOKEN) {
		return Response.json({ object: "error", code: "unauthorized", message: "bad token" }, { status: 401 });
	}
	if (url.pathname.endsWith("/search")) {
		return Response.json({
			object: "list",
			has_more: false,
			next_cursor: null,
			results: [{
				object: "page",
				id: "worker-page",
				url: "https://www.notion.so/worker-page",
				created_time: "2026-01-01T00:00:00.000Z",
				last_edited_time: "2026-02-01T00:00:00.000Z",
				in_trash: false,
				parent: { type: "workspace", workspace: true },
				properties: { Name: { type: "title", title: [{ plain_text: "Worker page" }] } },
			}],
		});
	}
	const startedAt = Date.now();
	while (Date.now() - startedAt < BUSY_MS) {}
	return Response.json({ object: "page_markdown", markdown: "Indexed off the request loop.", truncated: false, unknown_block_ids: [] });
};
`;
}

describe("source sync worker", () => {
	let dir = "";
	let previousSignetPath: string | undefined;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "signet-source-sync-worker-"));
		previousSignetPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = dir;
		mkdirSync(join(dir, "memory"), { recursive: true });
		await closeDbAccessor();
		initDbAccessor(join(dir, "memory", "memories.db"));
		setSecretKeyringAdapterForTests(memoryKeyring());
		await putSecret("NOTION_TOKEN", TOKEN);
	});

	afterEach(async () => {
		await closeSourceSyncWorkers();
		setSecretKeyringAdapterForTests(null);
		await closeDbAccessor();
		if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = previousSignetPath;
		rmSync(dir, { recursive: true, force: true });
	});

	function workerEntry(name: string, body: string, importWorker = true): string {
		const path = join(dir, `${name}.ts`);
		writeFileSync(path, `${body}\n${importWorker ? `await import(${JSON.stringify(WORKER_MODULE)});` : ""}\n`);
		return path;
	}

	function protocolEntry(name: string, onSync: string, onCancel = ""): string {
		return workerEntry(
			name,
			`import { parentPort } from "node:worker_threads";
const post = (message) => parentPort.postMessage({ version: 1, ...message });
parentPort.on("message", (message) => {
	if (message.type === "sync") { ${onSync} }
	if (message.type === "cancel") { ${onCancel} }
	if (message.type === "owner_error") post({ type: "error", message: message.error.message });
	if (message.type === "secret_error") post({ type: "error", message: message.message });
});
post({ type: "ready", threadId: 99 });`,
			false,
		);
	}

	function notionSource(): SignetSourceEntry {
		const added = addNotionSource({ tokenRef: "NOTION_TOKEN" }, dir);
		if (added.ok === false) throw new Error(added.error);
		return added.source;
	}

	function context(source: SignetSourceEntry, overrides: Partial<SourceProviderSyncContext> = {}) {
		return {
			source,
			agentsDir: dir,
			agentId: "default",
			shouldContinue: () => true,
			getSecret,
			...overrides,
		} satisfies SourceProviderSyncContext;
	}

	it("runs Notion sync in a worker thread and commits through the daemon DB owner", async () => {
		const source = notionSource();
		const progress: SourceProviderProgressEvent[] = [];
		let workerThreadId = threadId;
		const result = await runSourceSyncInWorker(context(source, { onProgress: (event) => progress.push(event) }), {
			workerPath: workerEntry("notion", notionFetchStub()),
			onReady: (id) => {
				workerThreadId = id;
			},
		});

		expect(workerThreadId).not.toBe(threadId);
		expect(result).toMatchObject({ indexed: 1, scanned: 1, total: 1, failures: [] });
		expect(progress.at(-1)).toMatchObject({ scanned: 1, total: 1, indexed: 1 });
		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						"SELECT source_kind, content FROM memory_artifacts WHERE source_id = ? AND COALESCE(is_deleted, 0) = 0",
					)
					.all(source.id) as Array<{ source_kind: string; content: string }>,
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.source_kind).toBe("source_notion_page");
		expect(rows[0]?.content).toContain("Indexed off the request loop.");
	});

	it("runs Web fetch and extraction in the worker thread", async () => {
		const added = addWebSource({ url: "https://example.com/worker" }, dir);
		if (added.ok === false) throw new Error(added.error);
		const result = await runSourceSyncInWorker(context(added.source), {
			workerPath: workerEntry(
				"web",
				`const web = await import(${JSON.stringify(join(import.meta.dir, "web-source-provider.ts"))});
web.setWebDnsLookupForTest(async () => [{ address: "93.184.216.34", family: 4 }]);
web.setWebRequestForTest(() => Promise.resolve(new Response(
	"<html><head><title>Worker Web</title></head><body><article><h1>Worker Web</h1><p>Extracted inside the source sync worker.</p></article></body></html>",
	{ headers: { "content-type": "text/html" } },
)));`,
			),
		});

		expect(result).toMatchObject({ indexed: 1, scanned: 1, total: 1, failures: [] });
		const content = getDbAccessor().withReadDb(
			(db) =>
				(
					db
						.prepare("SELECT content FROM memory_artifacts WHERE source_id = ? AND source_kind = 'source_web_page'")
						.get(added.source.id) as { content: string } | undefined
				)?.content,
		);
		expect(content).toContain("Extracted inside the source sync worker.");
	});

	it("keeps the daemon event loop responsive while the worker is CPU-bound", async () => {
		const source = notionSource();
		let maxGapMs = 0;
		let last = performance.now();
		const ticker = setInterval(() => {
			const now = performance.now();
			maxGapMs = Math.max(maxGapMs, now - last);
			last = now;
		}, 5);
		const startedAt = performance.now();
		try {
			const result = await runSourceSyncInWorker(context(source), {
				workerPath: workerEntry("busy", notionFetchStub({ busyMs: 750 })),
			});
			expect(result.failures).toEqual([]);
		} finally {
			clearInterval(ticker);
		}
		expect(performance.now() - startedAt).toBeGreaterThanOrEqual(750);
		expect(maxGapMs).toBeLessThan(250);
	});

	it("resolves only the source's configured token ref", async () => {
		const source = notionSource();
		const pending = runSourceSyncInWorker(context(source), {
			workerPath: protocolEntry("secret", `post({ type: "secret", id: "s1", name: "OTHER_TOKEN" });`),
		});
		await expect(pending).rejects.toThrow("configured token ref");
	});

	it("rejects owner requests outside the source sync relay", async () => {
		const source = notionSource();
		const pending = runSourceSyncInWorker(context(source), {
			workerPath: protocolEntry(
				"owner",
				`post({ type: "owner_submit", id: "o1", request: { kind: "agent_remove", input: {} }, options: { operation: "x", lane: "write", deadlineMs: 1000 } });`,
			),
		});
		await expect(pending).rejects.toThrow("may not submit owner request: agent_remove");
	});

	it("fails the sync explicitly when the worker exits", async () => {
		const source = notionSource();
		const pending = runSourceSyncInWorker(context(source), {
			workerPath: protocolEntry("crash", "process.exit(17);"),
		});
		await expect(pending).rejects.toThrow("source sync worker exited with code 17");
	});

	it("delivers cancellation to the worker before the grace deadline", async () => {
		const source = notionSource();
		let active = true;
		const pending = runSourceSyncInWorker(context(source, { shouldContinue: () => active }), {
			workerPath: protocolEntry(
				"cooperative",
				"",
				`post({ type: "result", result: { indexed: 0, scanned: 0, total: 1, failures: [] } });`,
			),
			cancelPollMs: 5,
			cancelGraceMs: 10_000,
		});
		await Bun.sleep(20);
		active = false;
		expect(await pending).toEqual({ indexed: 0, scanned: 0, total: 1, failures: [] });
	});

	it("relays worker log entries to the daemon logger", async () => {
		const source = notionSource();
		const entries: LogEntry[] = [];
		const listener = (entry: LogEntry) => entries.push(entry);
		logger.on("log", listener);
		try {
			await runSourceSyncInWorker(context(source), {
				workerPath: protocolEntry(
					"log",
					`post({ type: "log", entry: { timestamp: new Date().toISOString(), level: "warn", category: "notion-source", message: "worker warning" } });
post({ type: "result", result: { indexed: 0, scanned: 0, total: 0, failures: [] } });`,
				),
			});
		} finally {
			logger.off("log", listener);
		}
		expect(entries.some((entry) => entry.category === "notion-source" && entry.message === "worker warning")).toBe(
			true,
		);
	});

	it("terminates a worker that does not stop after cancellation", async () => {
		const source = notionSource();
		let active = true;
		const pending = runSourceSyncInWorker(context(source, { shouldContinue: () => active }), {
			workerPath: protocolEntry("hang", ""),
			cancelPollMs: 5,
			cancelGraceMs: 25,
		});
		await Bun.sleep(20);
		active = false;
		await expect(pending).rejects.toThrow("source sync worker cancelled");
	});

	it("terminates live workers on shutdown", async () => {
		const source = notionSource();
		const outcome = runSourceSyncInWorker(context(source), { workerPath: protocolEntry("shutdown", "") }).then(
			() => null,
			(error: unknown) => error,
		);
		await Bun.sleep(20);
		await closeSourceSyncWorkers();
		expect(String(await outcome)).toContain("source sync worker closed");
	});
});
