import { describe, expect, test } from "bun:test";
import { parseTranscriptSkills } from "./skill-transcript.js";

const TS_R1 = "2025-03-15T09:00:00.000Z";
const TS_R2 = "2025-03-15T09:00:02.000Z";
const TS_R3 = "2025-03-15T09:00:04.000Z";
const TS_R4 = "2025-03-15T09:00:06.000Z";
const TS_R5 = "2025-03-15T09:00:08.000Z";

const realStructureFixture = [
	JSON.stringify({
		type: "assistant",
		timestamp: TS_R1,
		sessionId: "sess-fixture-1",
		cwd: "/home/dev/project",
		parentUuid: "uuid-parent-fixture-0",
		isSidechain: false,
		requestId: "req-fixture-001",
		uuid: "uuid-fixture-001",
		userType: "human",
		entrypoint: "cli",
		version: "1.0.0",
		gitBranch: "main",
		message: {
			role: "assistant",
			id: "msg-fixture-001",
			type: "message",
			model: "claude-fixture-model",
			stop_reason: "tool_use",
			stop_sequence: null,
			stop_details: null,
			usage: {
				input_tokens: 100,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
				output_tokens: 20,
			},
			content: [
				{
					type: "tool_use",
					id: "toolu_fixture001",
					name: "Skill",
					input: {
						skill: "web-search",
						args: "latest news",
						caller: { type: "assistant" },
					},
				},
			],
		},
	}),
	JSON.stringify({
		type: "user",
		timestamp: TS_R2,
		sessionId: "sess-fixture-1",
		cwd: "/home/dev/project",
		parentUuid: "uuid-fixture-001",
		isSidechain: false,
		requestId: "req-fixture-002",
		uuid: "uuid-fixture-002",
		userType: "human",
		entrypoint: "cli",
		version: "1.0.0",
		gitBranch: "main",
		message: {
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "toolu_fixture001",
					is_error: null,
					content: "Search completed successfully with 5 results.",
				},
			],
		},
	}),
	JSON.stringify({
		type: "assistant",
		timestamp: TS_R3,
		sessionId: "sess-fixture-1",
		cwd: "/home/dev/project",
		parentUuid: "uuid-fixture-002",
		isSidechain: false,
		requestId: "req-fixture-003",
		uuid: "uuid-fixture-003",
		userType: "human",
		entrypoint: "cli",
		version: "1.0.0",
		gitBranch: "main",
		message: {
			role: "assistant",
			id: "msg-fixture-003",
			type: "message",
			model: "claude-fixture-model",
			stop_reason: "tool_use",
			stop_sequence: null,
			stop_details: null,
			usage: { input_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 15 },
			content: [
				{
					type: "tool_use",
					id: "toolu_fixture002",
					name: "Skill",
					input: { skill: "tavily-search", args: "query arg", caller: { type: "assistant" } },
				},
			],
		},
	}),
	JSON.stringify({
		type: "user",
		timestamp: TS_R4,
		sessionId: "sess-fixture-1",
		cwd: "/home/dev/project",
		parentUuid: "uuid-fixture-003",
		isSidechain: false,
		requestId: "req-fixture-004",
		uuid: "uuid-fixture-004",
		userType: "human",
		entrypoint: "cli",
		version: "1.0.0",
		gitBranch: "main",
		message: {
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "toolu_fixture002",
					is_error: true,
					content: "Skill execution failed: timeout",
				},
			],
		},
	}),
	JSON.stringify({
		type: "assistant",
		timestamp: TS_R5,
		sessionId: "sess-fixture-1",
		cwd: "/home/dev/project",
		parentUuid: "uuid-fixture-004",
		isSidechain: false,
		requestId: "req-fixture-005",
		uuid: "uuid-fixture-005",
		userType: "human",
		entrypoint: "cli",
		version: "1.0.0",
		gitBranch: "main",
		message: {
			role: "assistant",
			id: "msg-fixture-005",
			type: "message",
			model: "claude-fixture-model",
			stop_reason: "end_turn",
			stop_sequence: null,
			stop_details: null,
			usage: { input_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 30 },
			content: [{ type: "text", text: "Here are the search results you requested." }],
		},
	}),
].join("\n");

const T1 = "2024-01-01T10:00:00.000Z";
const T2 = "2024-01-01T10:00:01.500Z";
const T3 = "2024-01-01T10:00:03.000Z";
const T4 = "2024-01-01T10:00:04.000Z";
const fixture = [
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

	test("uses zero latency when the tool_use timestamp is invalid", () => {
		const content = [
			JSON.stringify({
				timestamp: "not-a-date",
				sessionId: "sess-invalid-time",
				message: {
					content: [{ type: "tool_use", id: "toolu_invalid_time", name: "Skill", input: { skill: "web-search" } }],
				},
			}),
			JSON.stringify({
				timestamp: "2024-01-01T00:00:01.000Z",
				sessionId: "sess-invalid-time",
				message: { content: [{ type: "tool_result", tool_use_id: "toolu_invalid_time", is_error: false }] },
			}),
		].join("\n");
		const { records } = parseTranscriptSkills(content);
		expect(records[0]?.latencyMs).toBe(0);
	});
});

describe("parseTranscriptSkills — real Claude Code transcript structure", () => {
	test("returns exactly two records (noise text turn produces no record)", () => {
		const { records, skipped } = parseTranscriptSkills(realStructureFixture);
		expect(records.length).toBe(2);
		expect(skipped).toBe(0);
	});

	test("extracts skillName, sessionId, cwd, toolUseId from full production envelope", () => {
		const { records } = parseTranscriptSkills(realStructureFixture);
		const r1 = records.find((r) => r.toolUseId === "toolu_fixture001");
		expect(r1).toBeDefined();
		if (!r1) return;
		expect(r1.skillName).toBe("web-search");
		expect(r1.sessionId).toBe("sess-fixture-1");
		expect(r1.cwd).toBe("/home/dev/project");
	});

	test("is_error:null treated as success (production quirk — NOT false)", () => {
		const { records } = parseTranscriptSkills(realStructureFixture);
		const r = records.find((r) => r.toolUseId === "toolu_fixture001");
		expect(r).toBeDefined();
		if (!r) return;
		expect(r.success).toBe(true);
		expect(r.latencyMs).toBe(2000);
		expect(r.createdAtMs).toBe(Date.parse(TS_R1));
	});

	test("is_error:true correctly maps to success=false (plain-string content tolerated)", () => {
		const { records } = parseTranscriptSkills(realStructureFixture);
		const r = records.find((r) => r.toolUseId === "toolu_fixture002");
		expect(r).toBeDefined();
		if (!r) return;
		expect(r.skillName).toBe("tavily-search");
		expect(r.success).toBe(false);
	});

	test("extra caller field in tool_use input does not corrupt skillName", () => {
		const { records } = parseTranscriptSkills(realStructureFixture);
		for (const r of records) {
			expect(r.skillName.length).toBeGreaterThan(0);
			expect(r.skillName).not.toContain("{");
		}
	});
});
