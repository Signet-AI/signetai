import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, initDbAccessor } from "./db-accessor";
import { searchTranscriptFallback, upsertSessionTranscript } from "./session-transcripts";

let dir = "";

describe("session transcript lookup", () => {
	afterEach(() => {
		closeDbAccessor();
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	function init(): void {
		dir = mkdtempSync(join(tmpdir(), "signet-session-transcripts-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
	}

	it("exact query with colon alias returns hyphen stored session key", () => {
		init();
		upsertSessionTranscript(
			"019f3a7a-218f-7000-b6a3-0dcc8801a625",
			"User: asked about mesh PR 9147 and 9146. Assistant: gave answer.",
			"oh-my-pi",
			"/repo-a",
			"noam",
		);

		const hits = searchTranscriptFallback({
			query: "019f3a7a-218f:7000:b6a3-0dcc8801a625",
			agentId: "noam",
			limit: 5,
		});

		expect(hits).toHaveLength(1);
		expect(hits[0]?.sessionKey).toBe("019f3a7a-218f-7000-b6a3-0dcc8801a625");
	});

	it("exact query returns row when params sessionKey equals query", () => {
		init();
		upsertSessionTranscript(
			"same-session",
			"User: exact same session lookup should return stored content. Assistant: yes.",
			"oh-my-pi",
			"/repo-a",
			"noam",
		);

		const hits = searchTranscriptFallback({
			query: "same-session",
			agentId: "noam",
			sessionKey: "same-session",
			limit: 5,
		});

		expect(hits).toHaveLength(1);
		expect(hits[0]?.sessionKey).toBe("same-session");
	});
});
