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
		expect(content).toContain("recently saved memory artifacts");
		expect(content).toContain("flexible bulk ingestion");
		expect(content).toContain("Memory artifacts are evidence\nfor attributes");
		expect(content).toContain("source-backed memory artifacts");
		expect(content).toContain("not the API\n  `remember` endpoint");
		expect(content).toContain("signet ontology stream apply ops.jsonl --json");
		expect(content).toContain("signet ontology stream apply proposals.jsonl --propose --json");
		expect(content).toContain("Use dry-run only when the operator asks");
		expect(content).toContain("Do not edit SQLite directly.");
		expect(content).toContain("Do not bypass `ontology_proposals`");
		expect(content).toContain("Do not call `/api/memory/remember`");
		expect(content).not.toContain("Default mode is proposal-first");
		expect(content).not.toContain("Start with `--dry-run`");
		expect(content).not.toContain("not to create JSON");
		expect(content).not.toContain("sqlite3 ");
		expect(content).not.toContain("UPDATE entity_attributes");
	});
});
