import { describe, expect, it } from "bun:test";
import type { EpisodicSourceRecord } from "../episodic-sources";
import { createDreamingAgentEvidence, nextDreamingEvidenceFragment, renderDreamingEvidence } from "./dreaming-evidence";

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
