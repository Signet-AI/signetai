import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyRestore } from "./restore-verification";

function workspace(): string {
	const root = mkdtempSync(join(tmpdir(), "signet-restore-"));
	for (const file of [
		"MEMORY.md",
		"transcripts/2026-01-01.jsonl",
		"skills/independent/SKILL.md",
		"imports/original.md",
	])
		mkdirSync(join(root, file, ".."), { recursive: true });
	writeFileSync(join(root, "MEMORY.md"), "memory");
	writeFileSync(
		join(root, "transcripts/2026-01-01.jsonl"),
		JSON.stringify({ role: "user", content: "hello", timestamp: "2026-01-01T00:00:00Z", provenance: "source-1" }) +
			"\n",
	);
	writeFileSync(join(root, "skills/independent/SKILL.md"), "skill");
	writeFileSync(join(root, "imports/original.md"), "original");
	return root;
}

const expected = {
	files: ["MEMORY.md", "transcripts/2026-01-01.jsonl", "skills/independent/SKILL.md", "imports/original.md"],
	transcripts: [{ path: "transcripts/2026-01-01.jsonl", roles: ["user"], provenance: ["source-1"] }],
	sources: [{ id: "source-1", generation: 3 }],
	recall: { current: true, scope: "agent-a" },
	dreaming: { frontier: "pass-4", consumed: ["pass-1", "pass-2", "pass-3"] },
	ontology: { history: 2, evidenceLinks: 1 },
	harness: { identity: "agent-a", skills: ["independent"] },
};

describe("verifyRestore", () => {
	it("proves a disposable workspace recovery and emits a privacy-safe receipt", async () => {
		const root = workspace();
		const result = await verifyRestore({
			root,
			expected,
			database: { snapshotConsistent: true },
			daemon: { ready: true },
			protection: { encryptedProvider: "available" },
		});
		expect(result.ok).toBe(true);
		expect(result.receipt.schema).toBe("signet.restore.v1");
		expect(result.receipt).not.toHaveProperty("content");
		expect(result.receipt.components).toContain("transcripts");
	});

	it("fails closed when transcript ordering or provenance changes", async () => {
		const root = workspace();
		writeFileSync(
			join(root, "transcripts/2026-01-01.jsonl"),
			`${JSON.stringify({
				role: "assistant",
				content: "tampered",
				timestamp: "2025-01-01T00:00:00Z",
				provenance: "other",
			})}\n`,
		);
		const result = await verifyRestore({
			root,
			expected,
			database: { snapshotConsistent: true },
			daemon: { ready: true },
		});
		expect(result.ok).toBe(false);
		expect(result.failures.some((failure) => failure.component === "transcripts")).toBe(true);
	});
});
