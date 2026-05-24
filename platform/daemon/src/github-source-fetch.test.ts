import { afterEach, describe, expect, it, mock } from "bun:test";
import {
	expandRepoGlob,
	fetchDiscussionComments,
	fetchDiscussions,
	fetchIssues,
	fetchPullRequests,
	fetchPullRequestsBySearch,
	fetchRepoDocs,
	fetchRepoInfo,
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

	it("clears request timeout handles when fetch attempts fail", async () => {
		const originalSetTimeout = globalThis.setTimeout;
		const originalClearTimeout = globalThis.clearTimeout;
		const requestTimeouts: unknown[] = [];
		const clearedTimeouts: unknown[] = [];
		globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
			if (delay === 30_000) {
				const handle = { id: `request-${requestTimeouts.length + 1}` };
				requestTimeouts.push(handle);
				return handle as ReturnType<typeof setTimeout>;
			}
			return originalSetTimeout(callback, 0, ...args);
		}) as typeof setTimeout;
		globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
			if (requestTimeouts.includes(handle)) {
				clearedTimeouts.push(handle);
				return;
			}
			originalClearTimeout(handle);
		}) as typeof clearTimeout;
		globalThis.fetch = mock(() => Promise.reject(new Error("network down"))) as typeof fetch;

		try {
			await expect(fetchRepoInfo({ owner: "o", repo: "r" })).rejects.toThrow("network down");
			expect(clearedTimeouts).toEqual(requestTimeouts);
		} finally {
			globalThis.setTimeout = originalSetTimeout;
			globalThis.clearTimeout = originalClearTimeout;
		}
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
			const pullMatch = text.match(/\/pulls\/(\d+)$/);
			if (pullMatch) {
				const number = Number.parseInt(pullMatch[1] ?? "0", 10);
				return Promise.resolve(
					Response.json({
						number,
						title: `PR ${number}`,
						body: "",
						state: "open",
						html_url: `https://github.com/o/r/pull/${number}`,
						user: null,
						created_at: "2026-01-01T00:00:00.000Z",
						updated_at: "2026-01-01T00:00:00.000Z",
						closed_at: null,
						merged_at: null,
						draft: false,
						base: { ref: "main" },
						head: { ref: `feature-${number}` },
						comments: 0,
						review_comments: 0,
					}),
				);
			}
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
		const searchRequests = requested.filter((entry) => entry.includes("/search/issues"));
		expect(new URL(searchRequests[0] ?? "").searchParams.get("page")).toBe("1");
		expect(new URL(searchRequests[1] ?? "").searchParams.get("page")).toBe("2");
		expect(requested.filter((entry) => entry.includes("/pulls/"))).toHaveLength(101);
	});

	it("hydrates label-filtered pull request metadata while preserving search labels", async () => {
		globalThis.fetch = mock((url: string | URL | Request) => {
			const text = String(url);
			if (text.includes("/search/issues")) {
				return Promise.resolve(
					Response.json({
						items: [
							{
								number: 17,
								title: "Search PR",
								body: "search body",
								state: "open",
								html_url: "https://github.com/o/r/pull/17",
								user: { login: "alice" },
								labels: [{ name: "sources" }],
								created_at: "2026-01-01T00:00:00.000Z",
								updated_at: "2026-01-01T00:00:00.000Z",
								closed_at: null,
								comments: 4,
							},
						],
					}),
				);
			}
			return Promise.resolve(
				Response.json({
					number: 17,
					title: "Hydrated PR",
					body: "pull body",
					state: "closed",
					html_url: "https://github.com/o/r/pull/17",
					user: { login: "alice" },
					created_at: "2026-01-01T00:00:00.000Z",
					updated_at: "2026-01-03T00:00:00.000Z",
					closed_at: "2026-01-04T00:00:00.000Z",
					merged_at: "2026-01-04T00:00:00.000Z",
					draft: true,
					base: { ref: "main" },
					head: { ref: "feature" },
					comments: 2,
					review_comments: 3,
				}),
			);
		}) as typeof fetch;

		const result = await fetchPullRequestsBySearch({ owner: "o", repo: "r" }, ["sources"], undefined, "all", 1);

		expect(result.errors).toEqual([]);
		expect(result.resources[0]).toMatchObject({
			type: "pull",
			title: "Hydrated PR",
			body: "pull body",
			state: "closed",
			labels: ["sources"],
			mergedAt: "2026-01-04T00:00:00.000Z",
			commentsCount: 5,
			extra: { draft: true, base: "main", head: "feature" },
		});
	});

	it("maps pull request list responses without issue labels", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				Response.json([
					{
						number: 17,
						title: "Pull request",
						body: "body",
						state: "open",
						html_url: "https://github.com/o/r/pull/17",
						user: { login: "alice" },
						created_at: "2026-01-01T00:00:00.000Z",
						updated_at: "2026-01-02T00:00:00.000Z",
						closed_at: null,
						merged_at: null,
						draft: false,
						base: { ref: "main" },
						head: { ref: "feature" },
					},
				]),
			),
		) as typeof fetch;

		const result = await fetchPullRequests({ owner: "o", repo: "r" }, undefined, "open", 1);

		expect(result.resources[0]?.number).toBe(17);
		expect(result.resources[0]?.labels).toEqual([]);
		expect(result.resources[0]?.commentsCount).toBe(0);
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

	it("continues scanning discussions past state-filtered pages", async () => {
		const afterValues: Array<string | null> = [];
		globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
			const variables = JSON.parse(String(init?.body)).variables as { after?: string | null; first?: number };
			afterValues.push(variables.after ?? null);
			expect(variables.first).toBe(100);
			const closedNodes = Array.from({ length: 100 }, (_, index) => ({
				number: index + 1,
				title: "Closed discussion",
				body: "body",
				url: `https://github.com/o/r/discussions/${index + 1}`,
				closed: true,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-02T00:00:00.000Z",
				author: { login: "alice" },
				labels: { nodes: [] },
				comments: { totalCount: 0 },
			}));
			return Promise.resolve(
				Response.json({
					data: {
						repository: {
							discussions: variables.after
								? {
										nodes: [
											{
												number: 101,
												title: "Open discussion",
												body: "body",
												url: "https://github.com/o/r/discussions/101",
												closed: false,
												createdAt: "2026-01-01T00:00:00.000Z",
												updatedAt: "2026-01-02T00:00:00.000Z",
												author: { login: "alice" },
												labels: { nodes: [] },
												comments: { totalCount: 0 },
											},
										],
										pageInfo: { hasNextPage: false, endCursor: null },
									}
								: {
										nodes: closedNodes,
										pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
									},
						},
					},
				}),
			);
		}) as typeof fetch;

		const result = await fetchDiscussions({ owner: "o", repo: "r", token: "token" }, undefined, "open", 1);

		expect(result.resources.map((resource) => resource.number)).toEqual([101]);
		expect(afterValues).toEqual([null, "cursor-1"]);
	});

	it("bounds discussion scanning when state filters reject fetched nodes", async () => {
		const afterValues: Array<string | null> = [];
		globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
			const variables = JSON.parse(String(init?.body)).variables as { after?: string | null; first?: number };
			afterValues.push(variables.after ?? null);
			expect(variables.first).toBe(100);
			const pageIndex = afterValues.length;
			return Promise.resolve(
				Response.json({
					data: {
						repository: {
							discussions: {
								nodes: Array.from({ length: 100 }, (_, index) => ({
									number: (pageIndex - 1) * 100 + index + 1,
									title: "Closed discussion",
									body: "body",
									url: `https://github.com/o/r/discussions/${(pageIndex - 1) * 100 + index + 1}`,
									closed: true,
									createdAt: "2026-01-01T00:00:00.000Z",
									updatedAt: "2026-01-02T00:00:00.000Z",
									author: { login: "alice" },
									labels: { nodes: [] },
									comments: { totalCount: 0 },
								})),
								pageInfo: { hasNextPage: true, endCursor: `cursor-${pageIndex}` },
							},
						},
					},
				}),
			);
		}) as typeof fetch;

		const result = await fetchDiscussions({ owner: "o", repo: "r", token: "token" }, undefined, "open", 1);

		expect(result.resources).toEqual([]);
		expect(afterValues).toEqual([null, "cursor-1", "cursor-2", "cursor-3", "cursor-4"]);
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

	it("paginates discussion comments with GraphQL-safe page sizes", async () => {
		const requests: Array<{ first?: number; after?: string | null }> = [];
		globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body ?? "{}")) as { variables?: { first?: number; after?: string | null } };
			requests.push({ first: body.variables?.first, after: body.variables?.after });
			return Promise.resolve(
				Response.json({
					data: {
						repository: {
							discussion: {
								comments: {
									nodes: [
										{
											id: requests.length === 1 ? "DC_first" : "DC_second",
											body: requests.length === 1 ? "first" : "second",
											createdAt: "2026-01-01T00:00:00.000Z",
											updatedAt: "2026-01-01T00:00:00.000Z",
											author: { login: "alice" },
										},
									],
									pageInfo: {
										hasNextPage: requests.length === 1,
										endCursor: requests.length === 1 ? "cursor-1" : null,
									},
								},
							},
						},
					},
				}),
			);
		}) as typeof fetch;

		const comments = await fetchDiscussionComments({ owner: "o", repo: "r", token: "token" }, 7);

		expect(requests).toEqual([
			{ first: 100, after: null },
			{ first: 100, after: "cursor-1" },
		]);
		expect(comments.map((comment) => comment.id)).toEqual(["DC_first", "DC_second"]);
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

	it("preserves nested path separators when fetching docs", async () => {
		let requested = "";
		globalThis.fetch = mock((url: string | URL | Request) => {
			requested = String(url);
			return Promise.resolve(
				Response.json({
					content: Buffer.from("# api").toString("base64"),
					encoding: "base64",
					sha: "abc",
				}),
			);
		}) as typeof fetch;

		const result = await fetchRepoDocs({ owner: "o", repo: "r" }, ["docs/API.md"], "main", 1);

		expect(result.resources[0]?.path).toBe("docs/API.md");
		expect(requested).toContain("/contents/docs/API.md?");
		expect(requested).not.toContain("docs%2FAPI.md");
	});

	it("keeps single-star doc globs within one path segment", async () => {
		globalThis.fetch = mock((url: string | URL | Request) => {
			const text = String(url);
			if (text.includes("/git/trees/")) {
				return Promise.resolve(
					Response.json({
						tree: [
							{ type: "blob", path: "docs/API.md" },
							{ type: "blob", path: "docs/private/notes.md" },
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

		const direct = await fetchRepoDocs({ owner: "o", repo: "r" }, ["docs/*.md"], "main", 10);
		const recursive = await fetchRepoDocs({ owner: "o", repo: "r" }, ["docs/**/*.md"], "main", 10);

		expect(direct.resources.map((resource) => resource.path)).toEqual(["docs/API.md"]);
		expect(recursive.resources.map((resource) => resource.path)).toEqual(["docs/API.md", "docs/private/notes.md"]);
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
