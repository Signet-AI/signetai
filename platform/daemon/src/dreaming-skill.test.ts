import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("built-in dreaming skill", () => {
	test("exists and keeps ontology maintenance graph-first", () => {
		const content = readFileSync(resolve(import.meta.dir, "../../../skills/dreaming/SKILL.md"), "utf8");

		expect(content).toContain("name: dreaming");
		expect(content).toContain("Maintain Signet's living ontology and memory substrate");
		expect(content).toContain("transcripts, memory artifacts, source artifacts, notes, summaries, and imported");
		expect(content).toContain("entities, aspects, groups, claims, attributes, and links");
		expect(content).toContain("Apply first with provenance is the blanket rule");
		expect(content).toContain("recently saved memory artifacts");
		expect(content).toContain("flexible bulk ingestion");
		expect(content).toContain("Memory artifacts are evidence\nfor attributes");
		expect(content).toContain("source-attributed epistemic assertions");
		expect(content).toContain("source-backed memory artifacts");
		expect(content).toContain("not the API\n  `remember` endpoint");
		expect(content).toContain("signet ontology assertion create");
		expect(content).toContain("signet ontology assertion import --file assertions.json");
		expect(content).toContain('signet ontology entity merge "Canonical Entity"');
		expect(content).toContain("signet ontology entity merge-plan");
		expect(content).toContain("signet ontology stream apply ops.jsonl --json");
		expect(content).toContain("signet ontology stream apply proposals.jsonl --propose --json");
		expect(content).toContain("Use dry-run only when the operator asks");
		expect(content).toContain("pending proposals only for massive graph refactors");
		expect(content).toContain("Do not edit SQLite directly.");
		expect(content).toContain("Do not create pending proposals for normal dreaming or graph maintenance");
		expect(content).toContain("Do not call `/api/memory/remember`");
		expect(content).not.toContain("Default mode is proposal-first");
		expect(content).not.toContain("proposal-first by default");
		expect(content).not.toContain("Start with `--dry-run`");
		expect(content).not.toContain("not to create JSON");
		expect(content).not.toContain("sqlite3 ");
		expect(content).not.toContain("UPDATE entity_attributes");
	});
});
