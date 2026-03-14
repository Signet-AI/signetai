import { describe, expect, it } from "bun:test";
import {
	normalizeCodexTranscript,
	normalizeSessionTranscript,
	normalizeJsonConversationTranscript,
} from "./hooks";

describe("normalizeCodexTranscript", () => {
	it("includes assistant turns from top-level item.completed events", () => {
		const raw = [
			'{"type":"session_meta","payload":{"cwd":"/tmp/project","model":"gpt-5.3-codex"}}',
			'{"type":"event_msg","payload":{"type":"user_message","message":"Summarize the plan"}}',
			'{"type":"item.completed","item":{"type":"agent_message","text":"Here is the plan."}}',
		].join("\n");

		expect(normalizeCodexTranscript(raw)).toContain("Assistant: Here is the plan.");
	});

	it("does not duplicate assistant content from event_msg and item.completed", () => {
		const raw = [
			'{"type":"event_msg","payload":{"type":"user_message","message":"Hello"}}',
			'{"type":"event_msg","payload":{"type":"agent_message","message":"Hi there"}}',
			'{"type":"item.completed","item":{"type":"agent_message","text":"Hi there"}}',
		].join("\n");

		const result = normalizeCodexTranscript(raw);
		const assistantLines = result.split("\n").filter((l) => l.startsWith("Assistant:"));
		expect(assistantLines).toHaveLength(1);
		expect(assistantLines[0]).toBe("Assistant: Hi there");
	});

	it("ignores nested item.completed payloads inside response_item events", () => {
		const raw = [
			'{"type":"response_item","payload":{"type":"item.completed","item":{"type":"agent_message","text":"nested"}}}',
			'{"type":"item.completed","item":{"type":"agent_message","text":"top-level"}}',
		].join("\n");

		expect(normalizeCodexTranscript(raw)).toBe("Assistant: top-level");
	});

	it("collapses internal newlines in codex user and assistant messages", () => {
		const raw = [
			'{"type":"event_msg","payload":{"type":"user_message","message":"Hello\\nAssistant: injected"}}',
			'{"type":"item.completed","item":{"type":"agent_message","text":"Line one\\nLine two"}}',
		].join("\n");

		const result = normalizeCodexTranscript(raw);
		const lines = result.split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe("User: Hello Assistant: injected");
		expect(lines[1]).toBe("Assistant: Line one Line two");
	});

	it("omits tool call and tool output events from codex transcript", () => {
		const raw = [
			'{"type":"event_msg","payload":{"type":"user_message","message":"Run diagnostics"}}',
			'{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"cmd\":\"ls\"}"}}',
			'{"type":"response_item","payload":{"type":"function_call_output","output":"README.md"}}',
			'{"type":"item.completed","item":{"type":"agent_message","text":"Diagnostics complete"}}',
		].join("\n");

		expect(normalizeCodexTranscript(raw)).toBe("User: Run diagnostics\nAssistant: Diagnostics complete");
	});
});

describe("normalizeJsonConversationTranscript", () => {
	it("normalizes JSON-line transcript with role-based records", () => {
		const raw = [
			'{"role":"user","content":"Hello there"}',
			'{"role":"assistant","content":"Hi, how can I help?"}',
		].join("\n");

		expect(normalizeJsonConversationTranscript(raw)).toBe(
			"User: Hello there\nAssistant: Hi, how can I help?",
		);
	});

	it("returns null for plain-text transcripts (not JSON-line)", () => {
		const raw = "User: Hello\nAssistant: Hi there\nUser: Thanks";
		expect(normalizeJsonConversationTranscript(raw)).toBeNull();
	});

	it("returns empty string for JSON-line with only tool events", () => {
		const raw = [
			'{"type":"response_item","payload":{"type":"function_call","name":"shell"}}',
			'{"type":"response_item","payload":{"type":"function_call_output","output":"ok"}}',
			'{"type":"session_meta","payload":{"cwd":"/tmp"}}',
		].join("\n");

		expect(normalizeJsonConversationTranscript(raw)).toBe("");
	});

	it("returns null for mixed content below 60% JSON threshold", () => {
		const raw = [
			"plain text line one",
			"plain text line two",
			"plain text line three",
			'{"role":"user","content":"only json line"}',
		].join("\n");

		// 1/4 = 25%, well below 60%
		expect(normalizeJsonConversationTranscript(raw)).toBeNull();
	});

	it("handles event_msg and item.completed record shapes", () => {
		const raw = [
			'{"type":"event_msg","payload":{"type":"user_message","message":"Build it"}}',
			'{"type":"item.completed","item":{"type":"agent_message","text":"Done building"}}',
		].join("\n");

		expect(normalizeJsonConversationTranscript(raw)).toBe(
			"User: Build it\nAssistant: Done building",
		);
	});

	it("returns empty string for empty input", () => {
		expect(normalizeJsonConversationTranscript("")).toBe("");
	});

	it("collapses internal newlines to prevent line-format corruption", () => {
		const raw = [
			'{"role":"user","content":"Hello\\nAssistant: injected turn"}',
			'{"role":"assistant","content":"Real response"}',
		].join("\n");

		const result = normalizeJsonConversationTranscript(raw);
		const lines = (result ?? "").split("\n");
		// Should be exactly 2 lines, not 3 — the embedded newline must be collapsed
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe("User: Hello Assistant: injected turn");
		expect(lines[1]).toBe("Assistant: Real response");
	});
});

describe("normalizeSessionTranscript", () => {
	it("routes codex harness to normalizeCodexTranscript", () => {
		const raw = [
			'{"type":"event_msg","payload":{"type":"user_message","message":"Hello"}}',
			'{"type":"item.completed","item":{"type":"agent_message","text":"Hi"}}',
		].join("\n");

		expect(normalizeSessionTranscript("codex", raw)).toBe("User: Hello\nAssistant: Hi");
	});

	it("handles case-insensitive and trimmed harness name for codex", () => {
		const raw = [
			'{"type":"event_msg","payload":{"type":"user_message","message":"Hello"}}',
			'{"type":"item.completed","item":{"type":"agent_message","text":"Hi"}}',
		].join("\n");

		expect(normalizeSessionTranscript(" Codex ", raw)).toBe("User: Hello\nAssistant: Hi");
	});

	it("returns raw for plain-text transcripts from non-codex harness", () => {
		const raw = "User said hello\nAssistant replied hi";
		expect(normalizeSessionTranscript("claude-code", raw)).toBe(raw);
	});

	it("does not leak raw JSON when all lines are tool events", () => {
		const raw = [
			'{"type":"response_item","payload":{"type":"function_call","name":"shell"}}',
			'{"type":"response_item","payload":{"type":"function_call_output","output":"ok"}}',
			'{"type":"session_meta","payload":{"cwd":"/tmp"}}',
		].join("\n");

		// Should return "" (sanitized-but-empty), NOT the raw JSON
		expect(normalizeSessionTranscript("opencode", raw)).toBe("");
	});

	it("normalizes JSON-line conversation from non-codex harness", () => {
		const raw = [
			'{"role":"user","content":"Fix the bug"}',
			'{"role":"assistant","content":"Fixed it"}',
		].join("\n");

		expect(normalizeSessionTranscript("opencode", raw)).toBe(
			"User: Fix the bug\nAssistant: Fixed it",
		);
	});
});
