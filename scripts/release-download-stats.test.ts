import { describe, expect, it } from "bun:test";
import { type GitHubRelease, fetchReleases, summarizeReleases } from "./release-download-stats";

const SAMPLE_RELEASES: readonly GitHubRelease[] = [
	{
		tag_name: "v0.163.15",
		published_at: "2026-08-05T00:00:00Z",
		assets: [
			{ name: "signetai-linux-x64-0.163.15.tgz", download_count: 1200, size: 1000 },
			{ name: "signetai-darwin-arm64-0.163.15.tgz", download_count: 800, size: 1000 },
		],
	},
	{
		tag_name: "v0.163.14",
		published_at: "2026-08-01T00:00:00Z",
		assets: [{ name: "signetai-linux-x64-0.163.14.tgz", download_count: 900, size: 1000 }],
	},
];

describe("release-download-stats (issue #1026 Phase 3)", () => {
	it("fetches releases from the GitHub API with the right request", async () => {
		const calls: string[] = [];
		const fakeFetch = async (url: string, init?: { headers?: Record<string, string> }): Promise<Response> => {
			calls.push(url);
			expect(init?.headers?.["Accept"]).toBe("application/vnd.github+json");
			return new Response(JSON.stringify(SAMPLE_RELEASES), { status: 200 });
		};

		const releases = await fetchReleases("Signet-AI/signetai", 10, fakeFetch as unknown as typeof fetch);
		expect(releases).toHaveLength(2);
		expect(calls[0]).toContain("releases?per_page=10");
	});

	it("throws on a non-OK GitHub response", async () => {
		const fakeFetch = async (): Promise<Response> => new Response("rate limited", { status: 403 });
		await expect(fetchReleases("Signet-AI/signetai", 10, fakeFetch as unknown as typeof fetch)).rejects.toThrow(
			"GitHub API 403",
		);
	});

	it("aggregates per-release and per-asset download counts", () => {
		const result = summarizeReleases(SAMPLE_RELEASES);
		expect(result.repo).toBe("Signet-AI/signetai");
		expect(result.totalDownloads).toBe(2900);
		expect(result.releases[0].totalDownloads).toBe(2000);
		expect(result.releases[0].assets[0]).toEqual({ name: "signetai-linux-x64-0.163.15.tgz", downloads: 1200 });
		// Assets sorted by downloads descending
		expect(result.releases[0].assets[0].downloads).toBeGreaterThanOrEqual(result.releases[0].assets[1].downloads);
	});

	it("handles releases without assets", () => {
		const result = summarizeReleases([{ tag_name: "v0.1.0", published_at: null, assets: [] }]);
		expect(result.releases[0].totalDownloads).toBe(0);
		expect(result.releases[0].publishedAt).toBeNull();
		expect(result.totalDownloads).toBe(0);
	});
});
