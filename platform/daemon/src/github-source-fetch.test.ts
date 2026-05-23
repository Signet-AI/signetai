import { afterEach, describe, expect, mock, test } from "bun:test";
import { expandRepoGlob, fetchDiscussions, fetchIssues, fetchRepoDocs } from "./github-source-fetch";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("fetchRepoDocs", () => {
	test("caps wildcard doc fetches to maxItemsPerRepo", async () => {
		globalThis.fetch = mock(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.includes("/git/trees/")) {
				return new Response(
					JSON.stringify({
						tree: [
							{ path: "a.md", type: "blob" },
							{ path: "b.md", type: "blob" },
							{ path: "c.md", type: "blob" },
						],
					}),
					{ status: 200 },
				);
			}
			const name = url.match(/\/contents\/docs\/([^?]+)/)?.[1];
			return new Response(
				JSON.stringify({
					name,
					sha: `sha-${name}`,
					content: Buffer.from(`# ${name}`).toString("base64"),
				}),
				{ status: 200 },
			);
		}) as typeof fetch;

		const result = await fetchRepoDocs(
			{ owner: "Signet-AI", repo: "signetai" },
			["docs/**/*.md"],
			"main",
			1,
		);

		expect(result.resources).toHaveLength(1);
		expect(result.resources[0]?.path).toBe("docs/a.md");
	});
});

describe("expandRepoGlob", () => {
	test("caps wildcard repo expansion to the configured limit", async () => {
		let requests = 0;
		globalThis.fetch = mock(async (input: string | URL | Request) => {
			requests++;
			const url = new URL(String(input));
			expect(url.searchParams.get("per_page")).toBe("1");
			expect(url.searchParams.get("page")).toBe("1");
			return new Response(JSON.stringify([{ full_name: "Signet-AI/signetai", name: "signetai" }]), {
				status: 200,
			});
		}) as typeof fetch;

		const result = await expandRepoGlob("Signet-AI", "*", undefined, 1);

		expect(result.repos).toEqual(["Signet-AI/signetai"]);
		expect(result.truncated).toBe(true);
		expect(requests).toBe(1);
	});
});

describe("fetchIssues", () => {
	test("keeps fetching until it indexes the requested number of issues even when pages include PR rows", async () => {
		let requests = 0;
		globalThis.fetch = (async (input) => {
			requests++;
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const page = Number(new URL(url).searchParams.get("page") ?? "1");
			const perPage = Number(new URL(url).searchParams.get("per_page") ?? "100");
			const rows =
				page === 1
					? [
							makeIssueRow(1, false),
							...Array.from({ length: 99 }, (_, index) => makeIssueRow(index + 2, true)),
						]
					: [makeIssueRow(5, false)];
			return new Response(
				JSON.stringify(rows.slice(0, perPage)),
				{
					status: 200,
					headers: {
						"content-type": "application/json",
						"x-ratelimit-remaining": "4999",
						"x-ratelimit-reset": "0",
					},
				},
			);
		}) as typeof fetch;

		const result = await fetchIssues({ owner: "Signet-AI", repo: "signetai" }, undefined, "all", 2);

		expect(requests).toBe(2);
		expect(result.resources.map((resource) => resource.number)).toEqual([1, 5]);
	});

	test("reports a bounded partial result when PR rows exhaust the scan budget", async () => {
		let requests = 0;
		globalThis.fetch = (async () => {
			requests++;
			return new Response(JSON.stringify(Array.from({ length: 100 }, (_, index) => makeIssueRow(index + 1, true))), {
				status: 200,
				headers: {
					"content-type": "application/json",
					"x-ratelimit-remaining": "4999",
					"x-ratelimit-reset": "0",
				},
			});
		}) as typeof fetch;

		const result = await fetchIssues({ owner: "Signet-AI", repo: "signetai" }, undefined, "all", 2);

		expect(requests).toBe(5);
		expect(result.resources).toHaveLength(0);
		expect(result.errors[0]?.message).toContain("scan budget exhausted");
	});
});

describe("fetchDiscussions", () => {
	test("filters discussions by requested state across pages", async () => {
		let requests = 0;
		globalThis.fetch = (async (_input, init) => {
			requests++;
			const body = JSON.parse(String(init?.body ?? "{}")) as { variables?: { after?: string | null } };
			const after = body.variables?.after ?? null;
			return new Response(JSON.stringify(makeDiscussionPage(after)), {
				status: 200,
				headers: {
					"content-type": "application/json",
					"x-ratelimit-remaining": "4999",
					"x-ratelimit-reset": "0",
				},
			});
		}) as typeof fetch;

		const result = await fetchDiscussions({ owner: "Signet-AI", repo: "signetai" }, undefined, "closed", 2);

		expect(requests).toBe(2);
		expect(result.resources).toHaveLength(2);
		expect(result.resources.map((resource) => resource.number)).toEqual([2, 3]);
		expect(result.resources.map((resource) => resource.state)).toEqual(["closed", "closed"]);
	});
});

function makeIssueRow(number: number, isPullRequest: boolean): Record<string, unknown> {
	return {
		number,
		title: `Issue ${number}`,
		body: "",
		state: "open",
		html_url: `https://github.com/Signet-AI/signetai/issues/${number}`,
		user: { login: "alexmondello" },
		labels: [],
		assignees: [],
		milestone: null,
		created_at: "2026-05-23T00:00:00Z",
		updated_at: "2026-05-23T00:00:00Z",
		closed_at: null,
		comments: 0,
		...(isPullRequest ? { pull_request: { url: `https://api.github.com/repos/Signet-AI/signetai/pulls/${number}` } } : {}),
	};
}

function makeDiscussionPage(after: string | null): Record<string, unknown> {
	if (after === "cursor-1") {
		return {
			data: {
				repository: {
					discussions: {
						pageInfo: { hasNextPage: false, endCursor: null },
						nodes: [
							makeDiscussionNode(2, "CLOSED", "2026-05-23T01:00:00Z"),
							makeDiscussionNode(3, "CLOSED", "2026-05-23T00:30:00Z"),
						],
					},
				},
			},
		};
	}
	return {
		data: {
			repository: {
				discussions: {
					pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
					nodes: [makeDiscussionNode(1, "OPEN", "2026-05-23T02:00:00Z")],
				},
			},
		},
	};
}

function makeDiscussionNode(number: number, state: string, updatedAt: string): Record<string, unknown> {
	return {
		number,
		title: `Discussion ${number}`,
		body: "",
		state,
		url: `https://github.com/Signet-AI/signetai/discussions/${number}`,
		author: { login: "alexmondello" },
		labels: { nodes: [] },
		createdAt: updatedAt,
		updatedAt,
		answerId: null,
		comments: { totalCount: 0 },
	};
}
