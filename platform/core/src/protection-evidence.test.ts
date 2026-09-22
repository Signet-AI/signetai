import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildProtectionEvidence } from "./protection-evidence";

describe("protection evidence", () => {
	it("computes component state from the resolved workspace without exposing paths", () => {
		const root = mkdtempSync(join(tmpdir(), "protection-evidence-"));
		try {
			for (const dir of ["files", "skills", "transcripts", "runtime", "cache", ".secrets", "data/imports"])
				mkdirSync(join(root, dir), { recursive: true });
			writeFileSync(join(root, "data", "signet.db"), "db");
			const result = buildProtectionEvidence(root, { now: new Date("2026-09-22T00:00:00.000Z") });
			expect(
				result.components.every((c) => c.state !== "unknown" || c.id === "external-sources" || c.id === "secrets"),
			).toBe(true);
			expect(result.components.find((c) => c.id === "filesystem-cache")?.intentionallyExcluded).toBe(true);
			expect(JSON.stringify(result)).not.toContain(root);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
