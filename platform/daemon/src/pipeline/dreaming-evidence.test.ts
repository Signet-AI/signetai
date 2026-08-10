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
});
