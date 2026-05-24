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

	test("syncs enabled github sources for non-default agent ids instead of silently skipping them", async () => {
		const agentsDir = mkdtempSync(join(tmpdir(), "signet-github-bridge-agent-scope-"));
		mkdirSync(agentsDir, { recursive: true });
		initDbAccessor(join(agentsDir, "memories.db"));
		const sources: SignetSourceEntry[] = [
			{
				id: "github:default",
				kind: "github",
				name: "Default Repo",
				root: "",
				enabled: true,
				mode: "read-only",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
				agentId: "default",
				settings: {
					repos: ["Signet-AI/default-repo"],
					resourceTypes: ["issues"],
					maxItemsPerRepo: 1,
				},
			},
			{
				id: "github:agent-b",
				kind: "github",
				name: "Agent B Repo",
				root: "",
				enabled: true,
				mode: "read-only",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
				agentId: "agent-b",
				settings: {
					repos: ["Signet-AI/agent-b-repo"],
					resourceTypes: ["issues"],
					maxItemsPerRepo: 1,
				},
			},
		];
		saveSourcesConfig({ version: 1, sources }, agentsDir);

		const seenRepos: string[] = [];
		globalThis.fetch = mock(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/repos/Signet-AI/default-repo")) {
				seenRepos.push("default");
				return new Response(
					JSON.stringify({
						owner: { login: "Signet-AI" },
						name: "default-repo",
						full_name: "Signet-AI/default-repo",
						default_branch: "main",
						html_url: "https://github.com/Signet-AI/default-repo",
					}),
					{ status: 200 },
				);
			}
			if (url.endsWith("/repos/Signet-AI/agent-b-repo")) {
				seenRepos.push("agent-b");
				return new Response(
					JSON.stringify({
						owner: { login: "Signet-AI" },
						name: "agent-b-repo",
						full_name: "Signet-AI/agent-b-repo",
						default_branch: "main",
						html_url: "https://github.com/Signet-AI/agent-b-repo",
					}),
					{ status: 200 },
				);
			}
			if (url.includes("/issues?")) {
				return new Response(JSON.stringify([]), { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;

		const bridge = startGitHubSourceBridge(sources, { agentsDir, pollIntervalMs: 0, agentId: "default" });
		try {
			const indexed = await bridge.sync();
			expect(indexed).toBe(0);
		} finally {
			await bridge.close();
		}

		expect(seenRepos).toEqual(["default", "agent-b"]);
		expect(getSourceIndexJob("github:default")).toMatchObject({ status: "complete" });
		expect(getSourceIndexJob("github:agent-b")).toMatchObject({ status: "complete" });
	});
});
