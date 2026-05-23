import { afterEach, describe, expect, mock, test } from "bun:test";
import { fetchRepoDocs } from "./github-source-fetch";

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
