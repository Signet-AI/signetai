import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("built-in dreaming skill", () => {
	test("exists and keeps unified ingest apply-first (agentic lease/apply-plan)", () => {
		const content = readFileSync(resolve(import.meta.dir, "../../../skills/dreaming/SKILL.md"), "utf8");

		// Identity + conceptual framing preserved across the re-point.
		expect(content).toContain("name: dreaming");
		expect(content).toContain("Maintain Signet's living ontology and memory substrate");
		expect(content).toContain("transcripts, memory artifacts, source artifacts, notes, summaries, and imported");
		expect(content).toContain("entities, aspects, groups, claims, attributes, and links");
		expect(content).toContain("Apply first with provenance is the blanket rule");
		expect(content).toContain("flexible bulk ingestion");
		expect(content).toContain("source-backed recall rows");

		// Ingest-first agentic workflow (the re-point from graph-first CLI).
		expect(content).toContain("signet ingest lease --agent");
		expect(content).toContain("signet ingest apply-plan");
		expect(content).toContain("--lease-token");
		expect(content).toContain("IngestPlan");
		expect(content).toContain("nothing to drain");
		expect(content).toContain("filePatches");
		expect(content).toContain("graphOps");

		// The full ontology op vocabulary is expressed as ingest graphOps now.
		expect(content).toContain("merge_entities");
		expect(content).toContain("set_claim_value");
		expect(content).toContain("create_entity");

		// Preserved guarantees asserted under the new ingest verbs.
		expect(content).toContain("pending proposals only for massive graph refactors");
		expect(content).toContain("flows through ingest apply");
		expect(content).toContain("Do not edit SQLite directly.");
		expect(content).toContain("Do not create pending proposals for normal dreaming or graph maintenance");
		expect(content).toContain("Do not call `/api/memory/remember`");

		// The old graph-first apply path must be gone — the runner no longer
		// drives `signet ontology stream apply` itself; the daemon applies the
		// posted IngestPlan.
		expect(content).not.toContain("signet ontology stream apply ops.jsonl --json");
		expect(content).not.toContain("signet ontology stream apply proposals.jsonl --propose --json");
		expect(content).not.toContain("signet ontology assertion create");
		expect(content).not.toContain("signet ontology entity merge-plan");

		// Unsafe wording must not regress.
		expect(content).not.toContain("Default mode is proposal-first");
		expect(content).not.toContain("proposal-first by default");
		expect(content).not.toContain("Start with `--dry-run`");
		expect(content).not.toContain("not to create JSON");
		expect(content).not.toContain("sqlite3 ");
		expect(content).not.toContain("UPDATE entity_attributes");
	});
});
