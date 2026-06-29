import { describe, expect, test } from "bun:test";
import { parseTranscriptSkills } from "./skill-transcript.js";

const T1 = "2024-01-01T10:00:00.000Z";
const T2 = "2024-01-01T10:00:01.500Z"; // +1500ms
const T3 = "2024-01-01T10:00:03.000Z"; // +3000ms
const T4 = "2024-01-01T10:00:04.000Z";

// Two Skill uses with results + one orphan use (no tool_result → skipped).
const fixture = [
	// assistant: two Skill tool_use blocks
	JSON.stringify({
		type: "assistant",
		timestamp: T1,
		sessionId: "sess-abc",
		cwd: "/home/user/project",
		message: {
			role: "assistant",
			content: [
				{ type: "tool_use", id: "toolu_001", name: "Skill", input: { skill: "my-skill", args: "hello world" } },
				{ type: "tool_use", id: "toolu_002", name: "Skill", input: { name: "other-skill", args: "foo" } },
			],
		},
	}),
	// user: tool_result for toolu_001 (success)
	JSON.stringify({
		type: "user",
		timestamp: T2,
		sessionId: "sess-abc",
		cwd: "/home/user/project",
		message: {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "toolu_001", is_error: false, content: "done" }],
		},
	}),
	// user: tool_result for toolu_002 (error)
	JSON.stringify({
		type: "user",
		timestamp: T3,
		sessionId: "sess-abc",
		cwd: "/home/user/project",
		message: {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "toolu_002", is_error: true, content: "skill failed" }],
		},
	}),
	// assistant: orphan Skill use — no tool_result in this fixture
	JSON.stringify({
		type: "assistant",
		timestamp: T4,
		sessionId: "sess-abc",
		cwd: "/home/user/project",
		message: {
			role: "assistant",
			content: [
				{ type: "tool_use", id: "toolu_003", name: "Skill", input: { skill: "orphan-skill", args: "no result" } },
			],
		},
	}),
].join("\n");

describe("parseTranscriptSkills", () => {
	test("returns two resolved records and one skipped", () => {
		const { records, skipped } = parseTranscriptSkills(fixture);
		expect(records.length).toBe(2);
		expect(skipped).toBe(1);
	});

	test("toolUseId, sessionId, and skillName are populated for resolved calls", () => {
		const { records } = parseTranscriptSkills(fixture);
		const ids = records.map((r) => r.toolUseId).sort();
		expect(ids).toEqual(["toolu_001", "toolu_002"]);
		for (const r of records) {
			expect(r.sessionId).toBe("sess-abc");
			expect(r.skillName.length).toBeGreaterThan(0);
		}
	});

	test("success=true and latency computed for successful call", () => {
		const { records } = parseTranscriptSkills(fixture);
		const r = records.find((rec) => rec.toolUseId === "toolu_001");
		expect(r).toBeDefined();
		if (!r) return;
		expect(r.skillName).toBe("my-skill");
		expect(r.sessionId).toBe("sess-abc");
		expect(r.success).toBe(true);
		expect(r.latencyMs).toBe(1500);
		expect(r.createdAtMs).toBe(Date.parse(T1));
	});

	test("success reflects is_error for failed call", () => {
		const { records } = parseTranscriptSkills(fixture);
		const r = records.find((rec) => rec.toolUseId === "toolu_002");
		expect(r).toBeDefined();
		if (!r) return;
		expect(r.skillName).toBe("other-skill");
		expect(r.success).toBe(false);
	});

	test("skips unparseable lines without throwing", () => {
		const { records, skipped } = parseTranscriptSkills(`${fixture}\nnot-json\n{broken`);
		expect(records.length).toBe(2);
		expect(skipped).toBe(1);
	});
});
