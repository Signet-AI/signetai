import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SignetSourceEntry, loadSourcesConfig, saveSourcesConfig } from "../../core/src/sources-config";
import { closeDbAccessor, initDbAccessor } from "./db-accessor";
import { startGitHubSourceBridge } from "./github-source-bridge";
import { clearSourceIndexProgressForTests, getSourceIndexJob } from "./source-index-progress";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	clearSourceIndexProgressForTests();
	closeDbAccessor();
});

describe("startGitHubSourceBridge", () => {
	test("marks GitHub sources indexed and completes the source job after a successful sync", async () => {
		const agentsDir = mkdtempSync(join(tmpdir(), "signet-github-bridge-"));
		mkdirSync(agentsDir, { recursive: true });
		initDbAccessor(join(agentsDir, "memories.db"));
		const source: SignetSourceEntry = {
			id: "github:test",
			kind: "github",
			name: "Test Repo",
			root: "",
			enabled: true,
			mode: "read-only",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			agentId: "default",
			settings: {
				repos: ["Signet-AI/signetai"],
				resourceTypes: ["issues"],
				maxItemsPerRepo: 1,
			},
		};
		saveSourcesConfig({ version: 1, sources: [source] }, agentsDir);

		globalThis.fetch = mock(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/repos/Signet-AI/signetai")) {
				return new Response(
					JSON.stringify({
						owner: { login: "Signet-AI" },
						name: "signetai",
						full_name: "Signet-AI/signetai",
						default_branch: "main",
						html_url: "https://github.com/Signet-AI/signetai",
					}),
					{ status: 200 },
				);
			}
			if (url.includes("/repos/Signet-AI/signetai/issues?")) {
				return new Response(JSON.stringify([]), { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;

		const bridge = startGitHubSourceBridge([source], { agentsDir, pollIntervalMs: 0 });
		try {
			const indexed = await bridge.sync();
			expect(indexed).toBe(0);
		} finally {
			await bridge.close();
		}

		const saved = loadSourcesConfig(agentsDir).sources[0];
		expect(saved?.lastIndexedAt).toBeString();
		expect(getSourceIndexJob(source.id)).toMatchObject({ status: "complete", indexed: 0 });
	});

	test("marks the source job failed when sync completes with partial errors", async () => {
		const agentsDir = mkdtempSync(join(tmpdir(), "signet-github-bridge-errors-"));
		mkdirSync(agentsDir, { recursive: true });
		initDbAccessor(join(agentsDir, "memories.db"));
		const source: SignetSourceEntry = {
			id: "github:test-errors",
			kind: "github",
			name: "Test Repo",
			root: "",
			enabled: true,
			mode: "read-only",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			agentId: "default",
			settings: {
				repos: ["Signet-AI/signetai"],
				resourceTypes: ["issues"],
				maxItemsPerRepo: 1,
			},
		};
		saveSourcesConfig({ version: 1, sources: [source] }, agentsDir);

		globalThis.fetch = mock(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/repos/Signet-AI/signetai")) {
				return new Response(
					JSON.stringify({
						owner: { login: "Signet-AI" },
						name: "signetai",
						full_name: "Signet-AI/signetai",
						default_branch: "main",
						html_url: "https://github.com/Signet-AI/signetai",
					}),
					{ status: 200 },
				);
			}
			if (url.includes("/repos/Signet-AI/signetai/issues?")) {
				return new Response(JSON.stringify({ message: "unprocessable" }), { status: 422 });
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;

		const bridge = startGitHubSourceBridge([source], { agentsDir, pollIntervalMs: 0 });
		try {
			const indexed = await bridge.sync();
			expect(indexed).toBe(0);
		} finally {
			await bridge.close();
		}

		const saved = loadSourcesConfig(agentsDir).sources[0];
		expect(saved?.lastIndexedAt).toBeUndefined();
		expect(getSourceIndexJob(source.id)).toMatchObject({ status: "error" });
	});
});
