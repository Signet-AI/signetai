import { afterEach, describe, expect, it, mock } from "bun:test";
import {
	expandRepoGlob,
	fetchDiscussionComments,
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

	it("paginates label-filtered pull request search up to maxItems", async () => {
		const requested: string[] = [];
		globalThis.fetch = mock((url: string | URL | Request) => {
			const text = String(url);
			requested.push(text);
			const page = new URL(text).searchParams.get("page");
			const makePull = (number: number) => ({
				number,
				title: `PR ${number}`,
				body: "",
				state: "open",
				html_url: `https://github.com/o/r/pull/${number}`,
				user: null,
				labels: [],
				created_at: "2026-01-01T00:00:00.000Z",
				updated_at: "2026-01-01T00:00:00.000Z",
				closed_at: null,
				comments: 0,
			});
			return Promise.resolve(
				Response.json({
					items: page === "1" ? Array.from({ length: 100 }, (_, index) => makePull(index + 1)) : [makePull(101)],
				}),
			);
		}) as typeof fetch;

		const result = await fetchPullRequestsBySearch({ owner: "o", repo: "r" }, ["bug"], undefined, "open", 101);

		expect(result.resources).toHaveLength(101);
		expect(new URL(requested[0] ?? "").searchParams.get("page")).toBe("1");
		expect(new URL(requested[1] ?? "").searchParams.get("page")).toBe("2");
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

	it("paginates discussions until maxItems or the final GraphQL page", async () => {
		const afterValues: Array<string | null> = [];
		globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
			const variables = JSON.parse(String(init?.body)).variables as { after?: string | null };
			afterValues.push(variables.after ?? null);
			return Promise.resolve(
				Response.json({
					data: {
						repository: {
							discussions: {
								nodes: [
									{
										number: variables.after ? 2 : 1,
										title: variables.after ? "Second discussion" : "First discussion",
										body: "body",
										url: `https://github.com/o/r/discussions/${variables.after ? 2 : 1}`,
										closed: false,
										createdAt: "2026-01-01T00:00:00.000Z",
										updatedAt: "2026-01-02T00:00:00.000Z",
										author: { login: "alice" },
										labels: { nodes: [] },
										comments: { totalCount: 0 },
									},
								],
								pageInfo: variables.after
									? { hasNextPage: false, endCursor: null }
									: { hasNextPage: true, endCursor: "cursor-1" },
							},
						},
					},
				}),
			);
		}) as typeof fetch;

		const result = await fetchDiscussions({ owner: "o", repo: "r", token: "token" }, undefined, "all", 2);

		expect(result.resources.map((resource) => resource.number)).toEqual([1, 2]);
		expect(afterValues).toEqual([null, "cursor-1"]);
	});

	it("preserves opaque GraphQL discussion comment ids", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				Response.json({
					data: {
						repository: {
							discussion: {
								comments: {
									nodes: [
										{
											id: "DC_kwDOOpaqueOne",
											body: "first",
											createdAt: "2026-01-01T00:00:00.000Z",
											updatedAt: "2026-01-01T00:00:00.000Z",
											author: { login: "alice" },
										},
										{
											id: "DC_kwDOOpaqueTwo",
											body: "second",
											createdAt: "2026-01-02T00:00:00.000Z",
											updatedAt: "2026-01-02T00:00:00.000Z",
											author: { login: "bob" },
										},
									],
								},
							},
						},
					},
				}),
			),
		) as typeof fetch;

		const comments = await fetchDiscussionComments({ owner: "o", repo: "r", token: "token" }, 7);

		expect(comments.map((comment) => comment.id)).toEqual(["DC_kwDOOpaqueOne", "DC_kwDOOpaqueTwo"]);
	});

	it("throws on discussion comment GraphQL errors", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				Response.json({
					errors: [{ message: "discussion comments unavailable" }],
					data: { repository: { discussion: null } },
				}),
			),
		) as typeof fetch;

		await expect(fetchDiscussionComments({ owner: "o", repo: "r", token: "token" }, 7)).rejects.toThrow(
			"Discussion comments GraphQL error: discussion comments unavailable",
		);
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
