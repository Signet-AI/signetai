#!/usr/bin/env bun

/**
 * GitHub release download stats (issue #1026 Phase 3).
 *
 * Surfaces the cleaner install signal the issue calls out: GitHub release
 * asset download counts. Each download is a real binary/connector fetch —
 * unlike npm download totals, which include CI pipelines, npx one-offs, and
 * version-update churn.
 *
 * Queries the public GitHub REST API (no auth needed for public repos; the
 * unauthenticated rate limit of 60 req/hr is fine for this) and aggregates
 * `download_count` per release and per asset. Output is a markdown table
 * (default) or NDJSON (`--json`) suitable for dashboards.
 *
 * Usage:
 *   bun scripts/release-download-stats.ts [--json] [--releases N]
 */

const REPO = "Signet-AI/signetai";
const DEFAULT_RELEASES = 10;

interface GitHubAsset {
	readonly name: string;
	readonly download_count: number;
	readonly size: number;
}

export interface GitHubRelease {
	readonly tag_name: string;
	readonly published_at: string | null;
	readonly assets: readonly GitHubAsset[];
}

export interface ReleaseDownloadStat {
	readonly tag: string;
	readonly publishedAt: string | null;
	readonly totalDownloads: number;
	readonly assets: ReadonlyArray<{ readonly name: string; readonly downloads: number }>;
}

export interface ReleaseStatsResult {
	readonly repo: string;
	readonly releases: readonly ReleaseDownloadStat[];
	readonly totalDownloads: number;
}

/** Fetch releases from the GitHub API. Injectable for tests. */
export async function fetchReleases(
	repo: string,
	releases = DEFAULT_RELEASES,
	fetchImpl: typeof fetch = fetch,
): Promise<readonly GitHubRelease[]> {
	const url = `https://api.github.com/repos/${repo}/releases?per_page=${releases}`;
	const res = await fetchImpl(url, {
		headers: { Accept: "application/vnd.github+json", "User-Agent": "signet-release-stats" },
	});
	if (!res.ok) {
		throw new Error(`GitHub API ${res.status} fetching ${url}`);
	}
	const body = (await res.json()) as readonly GitHubRelease[];
	return body;
}

/** Aggregate per-release download counts. */
export function summarizeReleases(releases: readonly GitHubRelease[]): ReleaseStatsResult {
	const stats: ReleaseDownloadStat[] = releases.map((release) => ({
		tag: release.tag_name,
		publishedAt: release.published_at,
		totalDownloads: release.assets.reduce((sum, asset) => sum + asset.download_count, 0),
		assets: release.assets
			.map((asset) => ({ name: asset.name, downloads: asset.download_count }))
			.sort((a, b) => b.downloads - a.downloads),
	}));
	return {
		repo: REPO,
		releases: stats,
		totalDownloads: stats.reduce((sum, release) => sum + release.totalDownloads, 0),
	};
}

function formatTable(result: ReleaseStatsResult): string {
	const rows = result.releases.map(
		(release) =>
			`| ${release.tag} | ${release.publishedAt?.slice(0, 10) ?? "—"} | ${release.totalDownloads.toLocaleString()} | ${release.assets
				.slice(0, 3)
				.map((asset) => `${asset.name}: ${asset.downloads.toLocaleString()}`)
				.join("<br>")} |`,
	);
	return [
		`# Release download stats — ${result.repo}`,
		"",
		`Total asset downloads across ${result.releases.length} releases: **${result.totalDownloads.toLocaleString()}**`,
		"",
		"| Release | Published | Downloads | Top assets |",
		"|---|---|---|---|",
		...rows,
		"",
	].join("\n");
}

async function main(): Promise<void> {
	const json = process.argv.includes("--json");
	const releasesFlag = process.argv.indexOf("--releases");
	const releases = releasesFlag >= 0 ? Number.parseInt(process.argv[releasesFlag + 1] ?? "", 10) : DEFAULT_RELEASES;

	const releasesData = await fetchReleases(
		REPO,
		Number.isFinite(releases) && releases > 0 ? releases : DEFAULT_RELEASES,
	);
	const result = summarizeReleases(releasesData);

	if (json) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		console.log(formatTable(result));
	}
}

if (import.meta.main) {
	main().catch((err) => {
		console.error(`release-download-stats failed: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	});
}
