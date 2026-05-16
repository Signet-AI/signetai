import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("built-in dreaming skill", () => {
	test("exists and keeps ontology maintenance proposal-first", () => {
		const content = readFileSync(resolve(import.meta.dir, "../../../skills/dreaming/SKILL.md"), "utf8");

		expect(content).toContain("name: dreaming");
		expect(content).toContain("transcripts, memory artifacts, source artifacts, notes, summaries, and imported");
		expect(content).toContain("entities, aspects, groups, claims, attributes, and links");
		expect(content).toContain("recently saved memory artifacts");
		expect(content).toContain("flexible bulk ingestion");
		expect(content).toContain("signet ontology stream apply proposals.jsonl --dry-run --json");
		expect(content).toContain("signet ontology stream apply proposals.jsonl --propose --json");
		expect(content).toContain("Do not edit SQLite directly.");
		expect(content).toContain("Do not bypass `ontology_proposals`");
		expect(content).not.toContain("sqlite3 ");
		expect(content).not.toContain("UPDATE entity_attributes");
	});
});
