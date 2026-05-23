import { describe, expect, test } from "bun:test";
import { buildGitHubSourceChunks } from "./github-source-embeddings";
import type { GitHubResource } from "./github-source-fetch";

function makeIssue(overrides: Partial<GitHubResource> = {}): GitHubResource {
	return {
		type: "issue",
		number: 42,
		title: "Fix native bundle installer 404",
		body: "The install.sh script fetches from `bundle-latest` tag which does not exist yet.",
		state: "open",
		labels: ["bug", "priority:high"],
		author: "nicholai",
		createdAt: "2026-05-10T00:00:00Z",
		updatedAt: "2026-05-17T00:00:00Z",
		closedAt: null,
		mergedAt: null,
		commentsCount: 2,
		extra: { html_url: "https://github.com/Signet-AI/signetai/issues/42" },
		...overrides,
	};
}

describe("buildGitHubSourceChunks", () => {
	test("produces chunks from an issue", () => {
		const resource = makeIssue();
		const chunks = buildGitHubSourceChunks({
			sourceId: "github:abc123",
			repo: "Signet-AI/signetai",
			resource,
		});
		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks[0]?.id).toContain("github:abc123");
		expect(chunks[0]?.id).toContain("Signet-AI/signetai");
		expect(chunks[0]?.id).toContain("issue:42");
		expect(chunks[0]?.chunkText).toContain("source_id: github:abc123");
		expect(chunks[0]?.chunkText).toContain("repo: Signet-AI/signetai");
	});

	test("produces chunks from a PR with comments", () => {
		const resource = makeIssue({ type: "pull", number: 123, title: "Add GitHub source connector" });
		const comments = [
			{ author: "alexmondello", body: "Looks good, just one nit.", createdAt: "2026-05-12T00:00:00Z" },
			{ author: "nicholai", body: "Fixed, pushing now.", createdAt: "2026-05-12T01:00:00Z" },
		];
		const chunks = buildGitHubSourceChunks({
			sourceId: "github:abc123",
			repo: "Signet-AI/signetai",
			resource,
			comments,
		});
		expect(chunks.length).toBeGreaterThan(0);
		const allText = chunks.map((c) => c.chunkText).join(" ");
		expect(allText).toContain("alexmondello");
		expect(allText).toContain("nicholai");
	});

	test("produces chunks from a doc", () => {
		const resource: GitHubResource = {
			type: "doc",
			path: "README.md",
			title: "README",
			body: "# Signet AI\n\nThis is the signet project. It does stuff.\n\n## Installation\n\nRun `bun add -g signetai`.",
			state: "open",
			labels: [],
			author: null,
			createdAt: "",
			updatedAt: "",
			closedAt: null,
			mergedAt: null,
			commentsCount: 0,
			extra: { path: "README.md" },
		};
		const chunks = buildGitHubSourceChunks({
			sourceId: "github:abc123",
			repo: "Signet-AI/signetai",
			resource,
		});
		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks[0]?.id).toContain("docs:README.md");
	});

	test("returns minimal chunk for empty body", () => {
		const resource = makeIssue({ body: "" });
		const chunks = buildGitHubSourceChunks({
			sourceId: "github:abc123",
			repo: "Signet-AI/signetai",
			resource,
		});
		expect(chunks.length).toBe(1);
		expect(chunks[0]?.chunkText).toContain("source_id: github:abc123");
	});

	test("splits long content into multiple chunks", () => {
		const longBody = "x".repeat(5000);
		const resource = makeIssue({ body: longBody });
		const chunks = buildGitHubSourceChunks({
			sourceId: "github:abc123",
			repo: "Signet-AI/signetai",
			resource,
		});
		expect(chunks.length).toBeGreaterThan(1);
	});
});
