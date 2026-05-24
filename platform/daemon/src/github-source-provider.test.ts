import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SignetSourceEntry, addGitHubSource } from "@signet/core";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { githubSourceProvider } from "./github-source-provider";
import { indexExternalMemoryArtifact } from "./memory-lineage";

const originalFetch = globalThis.fetch;

describe("github-source-provider", () => {
	let dir = "";
	let previousSignetPath: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-github-source-"));
		previousSignetPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = dir;
		mkdirSync(join(dir, "memory"), { recursive: true });
		closeDbAccessor();
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		closeDbAccessor();
		if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = previousSignetPath;
		rmSync(dir, { recursive: true, force: true });
	});

	it("indexes GitHub issue and comment artifacts with source provenance", async () => {
		globalThis.fetch = mock((url: string | URL | Request) => {
			const text = String(url);
			if (text.endsWith("/repos/Signet-AI/signetai")) {
				return Promise.resolve(
					Response.json({
						name: "signetai",
						full_name: "Signet-AI/signetai",
						default_branch: "main",
						html_url: "https://github.com/Signet-AI/signetai",
						owner: { login: "Signet-AI" },
					}),
				);
			}
			if (text.includes("/issues?")) {
				return Promise.resolve(
					Response.json([
						{
							number: 12,
							title: "Index GitHub",
							body: "issue body",
							state: "open",
							html_url: "https://github.com/Signet-AI/signetai/issues/12",
							user: { login: "alice" },
							labels: [{ name: "sources" }],
							created_at: "2026-01-01T00:00:00.000Z",
							updated_at: "2026-01-02T00:00:00.000Z",
							closed_at: null,
							comments: 1,
						},
					]),
				);
			}
			if (text.includes("/issues/12/comments")) {
				return Promise.resolve(
					Response.json([
						{
							id: 99,
							body: "comment body",
							user: { login: "bob" },
							created_at: "2026-01-03T00:00:00.000Z",
							updated_at: "2026-01-03T00:00:00.000Z",
						},
					]),
				);
			}
			return Promise.resolve(Response.json([]));
		}) as typeof fetch;
		const added = addGitHubSource(
			{
				repos: ["Signet-AI/signetai"],
				resourceTypes: ["issues"],
				maxItemsPerRepo: 5,
				now: "2026-01-01T00:00:00.000Z",
			},
			dir,
		);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);

		const result = await githubSourceProvider.sync?.({
			source: added.source,
			agentsDir: dir,
			agentId: "default",
			shouldContinue: () => true,
		});

		expect(result?.failures).toEqual([]);
		const rows = sourceRows(added.source.id);
		expect(rows.map((row) => row.source_kind)).toContain("source_github_issue");
		expect(rows.map((row) => row.source_kind)).toContain("source_github_comment");
		expect(rows.find((row) => row.source_kind === "source_github_issue")?.source_external_id).toBe(
			"Signet-AI/signetai:issue:12",
		);
		expect(rows.find((row) => row.source_kind === "source_github_comment")?.content).toContain("comment body");
	});

	it("records requested discussion failures when no token is available", async () => {
		const source: SignetSourceEntry = {
			id: "github:test",
			kind: "github",
			name: "GitHub",
			root: "github://repos/Signet-AI/signetai",
			enabled: true,
			mode: "read-only",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			providerSettings: {
				repos: ["Signet-AI/signetai"],
				resourceTypes: ["discussions"],
				state: "all",
				includeComments: true,
				docPaths: ["README.md"],
				maxItemsPerRepo: 5,
			},
		};
		globalThis.fetch = mock((url: string | URL | Request) => {
			if (String(url).endsWith("/repos/Signet-AI/signetai")) {
				return Promise.resolve(
					Response.json({ name: "signetai", full_name: "Signet-AI/signetai", default_branch: "main" }),
				);
			}
			return Promise.resolve(Response.json([]));
		}) as typeof fetch;

		const result = await githubSourceProvider.sync?.({
			source,
			agentsDir: dir,
			agentId: "default",
			shouldContinue: () => true,
		});

		expect(result?.failures[0]?.message).toContain("discussions require tokenRef");
		expect(sourceRows(source.id).map((row) => row.source_kind)).toContain("source_github_failure");
	});

	it("records a failure when a wildcard repo pattern matches nothing", async () => {
		const source: SignetSourceEntry = {
			id: "github:wildcard",
			kind: "github",
			name: "GitHub",
			root: "github://repos/Signet-AI/no-match-*",
			enabled: true,
			mode: "read-only",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			providerSettings: {
				repos: ["Signet-AI/no-match-*"],
				resourceTypes: ["issues"],
				state: "all",
				includeComments: true,
				docPaths: ["README.md"],
				maxItemsPerRepo: 5,
			},
		};
		globalThis.fetch = mock(() => Promise.resolve(Response.json([]))) as typeof fetch;

		const result = await githubSourceProvider.sync?.({
			source,
			agentsDir: dir,
			agentId: "default",
			shouldContinue: () => true,
		});

		expect(result?.failures[0]?.message).toContain("matched no repositories");
		expect(sourceRows(source.id).map((row) => row.source_kind)).toContain("source_github_failure");
	});

	it("purges stale artifacts for successful repos after another repo fails", async () => {
		const source: SignetSourceEntry = {
			id: "github:partial",
			kind: "github",
			name: "GitHub",
			root: "github://repos/Signet-AI/no-match-*,Signet-AI/signetai",
			enabled: true,
			mode: "read-only",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			providerSettings: {
				repos: ["Signet-AI/no-match-*", "Signet-AI/signetai"],
				resourceTypes: ["issues"],
				state: "all",
				includeComments: true,
				docPaths: ["README.md"],
				maxItemsPerRepo: 5,
			},
		};
		indexExternalMemoryArtifact({
			agentId: "default",
			harness: "github",
			sourceId: source.id,
			sourceRoot: source.root,
			sourceExternalId: "Signet-AI/signetai:issue:999",
			sourceParentPath: "github://Signet-AI/signetai",
			sourcePath: "github://Signet-AI/signetai/issues/999",
			sourceKind: "source_github_issue",
			sourceMtimeMs: Date.parse("2025-01-01T00:00:00.000Z"),
			capturedAt: "2025-01-01T00:00:00.000Z",
			content: "stale issue",
		});
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE memory_artifacts SET updated_at = ? WHERE source_id = ? AND source_path = ?").run(
				"2025-01-01T00:00:00.000Z",
				source.id,
				"github://Signet-AI/signetai/issues/999",
			);
		});
		globalThis.fetch = mock((url: string | URL | Request) => {
			const text = String(url);
			if (text.includes("/orgs/Signet-AI/repos") || text.includes("/users/Signet-AI/repos")) {
				return Promise.resolve(Response.json([]));
			}
			if (text.endsWith("/repos/Signet-AI/signetai")) {
				return Promise.resolve(
					Response.json({ name: "signetai", full_name: "Signet-AI/signetai", default_branch: "main" }),
				);
			}
			if (text.includes("/issues?")) {
				return Promise.resolve(
					Response.json([
						{
							number: 12,
							title: "Current issue",
							body: "body",
							state: "open",
							html_url: "https://github.com/Signet-AI/signetai/issues/12",
							user: { login: "alice" },
							labels: [],
							created_at: "2026-01-01T00:00:00.000Z",
							updated_at: "2026-01-02T00:00:00.000Z",
							closed_at: null,
							comments: 0,
						},
					]),
				);
			}
			return Promise.resolve(Response.json([]));
		}) as typeof fetch;

		const result = await githubSourceProvider.sync?.({
			source,
			agentsDir: dir,
			agentId: "default",
			shouldContinue: () => true,
		});

		const rows = sourceRows(source.id);
		expect(result?.failures[0]?.message).toContain("matched no repositories");
		expect(rows.map((row) => row.source_external_id)).toContain("Signet-AI/signetai:issue:12");
		expect(rows.map((row) => row.source_external_id)).not.toContain("Signet-AI/signetai:issue:999");
		expect(rows.map((row) => row.source_kind)).toContain("source_github_failure");
	});

	it("purges stale failure artifacts after a later successful sync", async () => {
		const source: SignetSourceEntry = {
			id: "github:recovered",
			kind: "github",
			name: "GitHub",
			root: "github://repos/Signet-AI/signetai",
			enabled: true,
			mode: "read-only",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			providerSettings: {
				repos: ["Signet-AI/signetai"],
				resourceTypes: ["issues"],
				state: "all",
				includeComments: false,
				docPaths: ["README.md"],
				maxItemsPerRepo: 5,
			},
		};
		indexExternalMemoryArtifact({
			agentId: "default",
			harness: "github",
			sourceId: source.id,
			sourceRoot: source.root,
			sourceExternalId: "failure:2025-01-01T00:00:00.000Z:old failure",
			sourcePath: `github://source/${source.id}/failures/2025-01-01T00%3A00%3A00.000Z`,
			sourceKind: "source_github_failure",
			sourceMtimeMs: Date.parse("2025-01-01T00:00:00.000Z"),
			capturedAt: "2025-01-01T00:00:00.000Z",
			content: "old failure",
		});
		globalThis.fetch = mock((url: string | URL | Request) => {
			const text = String(url);
			if (text.endsWith("/repos/Signet-AI/signetai")) {
				return Promise.resolve(
					Response.json({ name: "signetai", full_name: "Signet-AI/signetai", default_branch: "main" }),
				);
			}
			if (text.includes("/issues?")) {
				return Promise.resolve(
					Response.json([
						{
							number: 12,
							title: "Current issue",
							body: "body",
							state: "open",
							html_url: "https://github.com/Signet-AI/signetai/issues/12",
							user: { login: "alice" },
							labels: [],
							created_at: "2026-01-01T00:00:00.000Z",
							updated_at: "2026-01-02T00:00:00.000Z",
							closed_at: null,
							comments: 0,
						},
					]),
				);
			}
			return Promise.resolve(Response.json([]));
		}) as typeof fetch;

		const result = await githubSourceProvider.sync?.({
			source,
			agentsDir: dir,
			agentId: "default",
			shouldContinue: () => true,
		});

		const rows = sourceRows(source.id);
		expect(result?.failures).toEqual([]);
		expect(rows.map((row) => row.source_external_id)).toContain("Signet-AI/signetai:issue:12");
		expect(rows.map((row) => row.source_kind)).not.toContain("source_github_failure");
	});

	it("propagates comment fetch failures to the provider result", async () => {
		globalThis.fetch = mock((url: string | URL | Request) => {
			const text = String(url);
			if (text.endsWith("/repos/Signet-AI/signetai")) {
				return Promise.resolve(
					Response.json({
						name: "signetai",
						full_name: "Signet-AI/signetai",
						default_branch: "main",
						html_url: "https://github.com/Signet-AI/signetai",
						owner: { login: "Signet-AI" },
					}),
				);
			}
			if (text.includes("/issues?")) {
				return Promise.resolve(
					Response.json([
						{
							number: 12,
							title: "Index GitHub",
							body: "issue body",
							state: "open",
							html_url: "https://github.com/Signet-AI/signetai/issues/12",
							user: { login: "alice" },
							labels: [],
							created_at: "2026-01-01T00:00:00.000Z",
							updated_at: "2026-01-02T00:00:00.000Z",
							closed_at: null,
							comments: 1,
						},
					]),
				);
			}
			if (text.includes("/issues/12/comments")) {
				return Promise.resolve(Response.json({ message: "missing" }, { status: 404 }));
			}
			return Promise.resolve(Response.json([]));
		}) as typeof fetch;
		const added = addGitHubSource(
			{
				repos: ["Signet-AI/signetai"],
				resourceTypes: ["issues"],
				maxItemsPerRepo: 5,
				now: "2026-01-01T00:00:00.000Z",
			},
			dir,
		);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);

		const result = await githubSourceProvider.sync?.({
			source: added.source,
			agentsDir: dir,
			agentId: "default",
			shouldContinue: () => true,
		});

		expect(result?.failures[0]?.message).toContain("comment fetch failed");
		expect(sourceRows(added.source.id).map((row) => row.source_kind)).toContain("source_github_failure");
	});

	it("purges source-owned GitHub artifacts through the provider", () => {
		indexExternalMemoryArtifact({
			agentId: "default",
			harness: "github",
			sourceId: "github:test",
			sourceRoot: "github://repos/Signet-AI/signetai",
			sourceExternalId: "Signet-AI/signetai:issue:1",
			sourcePath: "github://Signet-AI/signetai/issues/1",
			sourceKind: "source_github_issue",
			sourceMtimeMs: Date.now(),
			content: "old issue",
		});

		const purged = githubSourceProvider.purge({ id: "github:test" } as SignetSourceEntry, "default");

		expect(purged).toBeGreaterThanOrEqual(1);
		expect(sourceRows("github:test")).toEqual([]);
	});
});

function sourceRows(sourceId: string): Array<{
	source_kind: string;
	source_path: string;
	source_external_id: string | null;
	source_meta_json: string | null;
	content: string;
}> {
	return getDbAccessor().withReadDb(
		(db) =>
			db
				.prepare(
					`SELECT source_kind, source_path, source_external_id, source_meta_json, content
					 FROM memory_artifacts
					 WHERE source_id = ?
					   AND COALESCE(is_deleted, 0) = 0
					 ORDER BY source_path`,
				)
				.all(sourceId) as Array<{
				source_kind: string;
				source_path: string;
				source_external_id: string | null;
				source_meta_json: string | null;
				content: string;
			}>,
	);
}
