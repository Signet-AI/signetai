import { afterEach, describe, expect, it, mock } from "bun:test";
import {
	expandRepoGlob,
	fetchDiscussions,
	fetchIssues,
	fetchPullRequestsBySearch,
	fetchRepoDocs,
} from "./github-source-fetch";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("github-source-fetch", () => {
	it("escapes wildcard repo glob literals and caps expansion", async () => {
		globalThis.fetch = mock((url: string | URL | Request) => {
			expect(String(url)).toContain("per_page=2");
			return Promise.resolve(
				Response.json([
					{ full_name: "owner/private.*", name: "private.*" },
					{ full_name: "owner/privateXarchive", name: "privateXarchive" },
				]),
			);
		}) as typeof fetch;

		const result = await expandRepoGlob("owner", "private.*", undefined, 2);

		expect(result.repos).toEqual(["owner/private.*"]);
		expect(result.truncated).toBe(true);
	});

	it("bounds issue scanning separately from indexed issue count on PR-heavy repos", async () => {
		let calls = 0;
		globalThis.fetch = mock(() => {
			calls++;
			return Promise.resolve(
				Response.json([
					{
						number: calls,
						pull_request: { url: "x" },
						title: "PR",
						body: "",
						state: "open",
						html_url: "",
						user: null,
						labels: [],
						created_at: "2026-01-01T00:00:00.000Z",
						updated_at: "2026-01-01T00:00:00.000Z",
						closed_at: null,
						comments: 0,
					},
				]),
			);
		}) as typeof fetch;

		const result = await fetchIssues({ owner: "o", repo: "r" }, undefined, "all", 1);

		expect(result.resources).toEqual([]);
		expect(calls).toBeLessThanOrEqual(5);
	});

	it("escapes PR label search values", async () => {
		let requested = "";
		globalThis.fetch = mock((url: string | URL | Request) => {
			requested = String(url);
			return Promise.resolve(Response.json({ items: [] }));
		}) as typeof fetch;

		await fetchPullRequestsBySearch({ owner: "o", repo: "r" }, ['quoted"label'], undefined, "open", 10);

		expect(decodeURIComponent(requested)).toContain('label:"quoted\\"label"');
	});

	it("maps GraphQL discussion closed state without requiring a state string field", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				Response.json({
					data: {
						repository: {
							discussions: {
								nodes: [
									{
										number: 7,
										title: "Closed discussion",
										body: "body",
										url: "https://github.com/o/r/discussions/7",
										closed: true,
										createdAt: "2026-01-01T00:00:00.000Z",
										updatedAt: "2026-01-02T00:00:00.000Z",
										author: { login: "alice" },
										labels: { nodes: [{ name: "roadmap" }] },
										comments: { totalCount: 0 },
									},
								],
							},
						},
					},
				}),
			),
		) as typeof fetch;

		const result = await fetchDiscussions({ owner: "o", repo: "r", token: "token" }, undefined, "closed", 10);

		expect(result.resources[0]?.state).toBe("closed");
		expect(result.resources[0]?.labels).toEqual(["roadmap"]);
	});

	it("applies maxItems to wildcard docs", async () => {
		globalThis.fetch = mock((url: string | URL | Request) => {
			const text = String(url);
			if (text.includes("/git/trees/")) {
				return Promise.resolve(
					Response.json({
						tree: [
							{ type: "blob", path: "docs/a.md" },
							{ type: "blob", path: "docs/b.md" },
						],
					}),
				);
			}
			return Promise.resolve(
				Response.json({
					content: Buffer.from("# doc").toString("base64"),
					encoding: "base64",
					sha: "abc",
				}),
			);
		}) as typeof fetch;

		const result = await fetchRepoDocs({ owner: "o", repo: "r" }, ["docs/*.md"], "main", 1);

		expect(result.resources).toHaveLength(1);
		expect(result.resources[0]?.path).toBe("docs/a.md");
	});
});
