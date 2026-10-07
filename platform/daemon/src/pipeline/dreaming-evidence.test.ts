import { describe, expect, it } from "bun:test";
import type { EpisodicSourceRecord } from "../episodic-sources";
import {
	createDreamingAgentEvidence,
	nextDreamingEvidenceFragment,
	renderDreamingEvidence,
	sanitizeTranscriptForDreaming,
} from "./dreaming-evidence";

const SOURCE: EpisodicSourceRecord = {
	kind: "memory",
	id: "memory-1",
	content: "Signet consolidates immutable evidence.",
	sourceKind: "manual",
	sourceId: "memory-1",
	sourcePath: null,
	sourceEntryId: null,
	project: "signet",
	harness: "pi",
	capturedAt: "2026-08-03T00:00:00.000Z",
	evidenceMeta: JSON.stringify({ aspects: [{ entityName: "Signet", aspect: "architecture" }] }),
	completed: true,
};

describe("dreaming evidence", () => {
	it("uses the same rendered structured evidence for prompts and agent citations", () => {
		const rendered = renderDreamingEvidence(SOURCE);
		const evidence = createDreamingAgentEvidence([SOURCE]);
		expect(rendered).toContain("structured_evidence:");
		expect(evidence).toEqual([
			expect.objectContaining({
				content: rendered,
				sourceRef: "memory:memory-1",
				sourceKind: "manual",
				sourceId: "memory-1",
			}),
		]);
	});

	it("sanitizes transcript evidence without mutating the retained source", () => {
		const content = [
			"User: inspect the release branch",
			"Tool call: terminal",
			"Tool output: SECRET_COMMAND_OUTPUT",
			"Assistant: the branch is clean.",
		].join("\n");
		const source: EpisodicSourceRecord = {
			...SOURCE,
			kind: "transcript",
			sourceKind: "transcript",
			id: "session-1",
			content,
		};

		const rendered = renderDreamingEvidence(source);
		expect(rendered).toContain("[tool call: terminal]");
		expect(rendered).not.toContain("SECRET_COMMAND_OUTPUT");
		expect(source.content).toBe(content);
	});

	it("projects JSONL tool calls to markers and drops tool results", () => {
		const raw = [
			JSON.stringify({ role: "user", content: "What changed?" }),
			JSON.stringify({ type: "function_call", name: "git", arguments: "status" }),
			JSON.stringify({ type: "function_call_output", output: "SECRET_COMMAND_OUTPUT" }),
			JSON.stringify({ role: "assistant", content: "The branch is clean." }),
		].join("\n");
		const projected = sanitizeTranscriptForDreaming(raw);
		expect(projected).toContain("User: What changed?");
		expect(projected).toContain("[tool call: git]");
		expect(projected).toContain("Assistant: The branch is clean.");
		expect(projected).not.toContain("SECRET_COMMAND_OUTPUT");
	});

	it("drops direct reasoning records and provider reasoning fields", () => {
		const raw = [
			JSON.stringify({ role: "user", content: "What changed?" }),
			JSON.stringify({ role: "reasoning", content: "SECRET_DIRECT_REASONING" }),
			JSON.stringify({
				role: "assistant",
				reasoning_content: "SECRET_OPENAI_REASONING",
				content: "The branch is clean.",
			}),
			JSON.stringify({ role: "assistant", reasoning_content: "SECRET_NULL_CONTENT_REASONING", content: null }),
		].join("\n");
		const projected = sanitizeTranscriptForDreaming(raw);
		expect(projected).toContain("User: What changed?");
		expect(projected).toContain("Assistant: The branch is clean.");
		expect(projected).not.toContain("SECRET_DIRECT_REASONING");
		expect(projected).not.toContain("SECRET_OPENAI_REASONING");
		expect(projected).not.toContain("SECRET_NULL_CONTENT_REASONING");
	});

	it("drops Anthropic and provider-specific thinking blocks while keeping answer text", () => {
		const raw = [
			JSON.stringify({
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "SECRET_ANTHROPIC_THINKING" },
						{ type: "redacted_thinking", data: "SECRET_REDACTED_THINKING" },
						{ type: "text", text: "The answer is here." },
					],
				},
			}),
			JSON.stringify({
				role: "assistant",
				content: [
					{ type: "reasoning", text: "SECRET_REASONING_BLOCK" },
					{ type: "text", text: "A second answer." },
				],
			}),
			JSON.stringify({ role: "model", content: [{ thought: true, text: "SECRET_GEMINI_THOUGHT" }] }),
		].join("\n");
		const projected = sanitizeTranscriptForDreaming(raw);
		expect(projected).toContain("Assistant: The answer is here.");
		expect(projected).toContain("Assistant: A second answer.");
		expect(projected).not.toContain("SECRET_ANTHROPIC_THINKING");
		expect(projected).not.toContain("SECRET_REDACTED_THINKING");
		expect(projected).not.toContain("SECRET_REASONING_BLOCK");
		expect(projected).not.toContain("SECRET_GEMINI_THOUGHT");
	});

	it("drops XML and role-prefixed reasoning from plain mixed transcripts", () => {
		const projected = sanitizeTranscriptForDreaming(
			[
				"User: inspect the release",
				"<think>SECRET_XML_REASONING</think>",
				"Assistant reasoning: SECRET_PREFIXED_REASONING",
				"still secret reasoning",
				"Assistant: the release is clean",
			].join("\n"),
		);
		expect(projected).toContain("User: inspect the release");
		expect(projected).toContain("Assistant: the release is clean");
		expect(projected).not.toContain("SECRET_");
	});

	it("drops normalized tool records and antml reasoning/invocation markup", () => {
		const projected = sanitizeTranscriptForDreaming(
			[
				"User: inspect the release",
				"Tool: SECRET_NORMALIZED_TOOL_OUTPUT",
				'Assistant: <antml:thinking>SECRET_ANTML_REASONING</antml:thinking><antml:invoke name="Bash"><antml:parameter name="command">SECRET_ANTML_COMMAND</antml:parameter></antml:invoke>',
				"Assistant: the release is clean",
			].join("\n"),
		);
		expect(projected).toContain("[tool call: Bash]");
		expect(projected).toContain("Assistant: the release is clean");
		expect(projected).not.toContain("SECRET_");
	});

	it("keeps tool-call markers from top-level tool_calls and drops their results", () => {
		const raw = [
			JSON.stringify({ role: "assistant", content: "Checking status.", tool_calls: [{ function: { name: "git" } }] }),
			JSON.stringify({ role: "tool", tool_call_id: "call-1", content: "SECRET_TOOL_RESULT" }),
			JSON.stringify({ role: "assistant", content: "The branch is clean." }),
		].join("\n");
		const projected = sanitizeTranscriptForDreaming(raw);
		expect(projected).toContain("[tool call: git]");
		expect(projected).toContain("Assistant: The branch is clean.");
		expect(projected).not.toContain("SECRET_TOOL_RESULT");
	});

	it("preserves prose when unrecognized JSON is mixed into a transcript", () => {
		const projected = sanitizeTranscriptForDreaming(
			["User: here is the configuration", JSON.stringify({ a: 1 }), "Assistant: the setting is valid"].join("\n"),
		);
		expect(projected).toContain("User: here is the configuration");
		expect(projected).toContain("Assistant: the setting is valid");
	});

	it("splits at a safe boundary without changing the immutable evidence", () => {
		const source = { ...SOURCE, content: "First sentence.\n\nSecond sentence.\n\nThird sentence.", evidenceMeta: null };
		const fragments = [];
		let start = 0;
		for (;;) {
			const fragment = nextDreamingEvidenceFragment(source, start, 20);
			if (!fragment) break;
			fragments.push(fragment);
			start = fragment.end;
		}
		expect(fragments.length).toBeGreaterThan(1);
		expect(fragments.map((fragment) => fragment.content).join("")).toBe(source.content);
		expect(
			createDreamingAgentEvidence(fragments)
				.map((evidence) => evidence.content)
				.join(""),
		).toBe(source.content);
	});

	it("pages the same reduced projection used for citations", () => {
		const content = [
			JSON.stringify({ role: "assistant", content: [{ type: "thinking", thinking: "SECRET_PAGED_REASONING" }] }),
			JSON.stringify({ role: "assistant", content: "The projected answer remains quotable." }),
		].join("\n");
		const source = { ...SOURCE, kind: "transcript" as const, sourceKind: "transcript", id: "paged-session", content };
		const rendered = renderDreamingEvidence(source);
		const fragments = [];
		let start = 0;
		for (;;) {
			const fragment = nextDreamingEvidenceFragment(source, start, 18);
			if (!fragment) break;
			fragments.push(fragment);
			start = fragment.end;
		}
		expect(fragments.map((fragment) => fragment.content).join("")).toBe(rendered);
		expect(
			createDreamingAgentEvidence(fragments)
				.map((evidence) => evidence.content)
				.join(""),
		).toBe(rendered);
		expect(rendered).not.toContain("SECRET_PAGED_REASONING");
		expect(source.content).toBe(content);
	});
});
