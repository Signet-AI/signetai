import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildProtectionEvidence } from "./protection-evidence";

describe("protection evidence", () => {
	it("fails closed when directories exist without their protection authorities", () => {
		const root = mkdtempSync(join(tmpdir(), "protection-evidence-unprotected-"));
		try {
			for (const dir of ["files", "skills", "transcripts", "runtime", "cache", ".secrets", "data/imports"])
				mkdirSync(join(root, dir), { recursive: true });
			writeFileSync(join(root, "workspace-layout.json"), JSON.stringify({ version: 2 }));
			writeFileSync(join(root, "data", "signet.db"), "db");

			const components = buildProtectionEvidence(root).components;
			expect(components.find((item) => item.id === "root-authored")?.status).toBe("missing");
			expect(components.find((item) => item.id === "skills")?.status).toBe("missing");
			expect(components.find((item) => item.id === "external-sources")?.status).toBe("protected");
			expect(components.find((item) => item.id === "secrets")?.status).toBe("unverified");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("accepts verified Git authorities without treating inbox files as source ownership", () => {
		const root = mkdtempSync(join(tmpdir(), "protection-evidence-git-"));
		try {
			for (const dir of ["files", "skills", "transcripts", "runtime", "cache", "data/imports"])
				mkdirSync(join(root, dir), { recursive: true });
			for (const file of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "agent.yaml", ".sigignore"])
				writeFileSync(join(root, file), `${file}\n`);
			writeFileSync(join(root, "workspace-layout.json"), JSON.stringify({ version: 2 }));
			writeFileSync(join(root, "files", "sources.json"), "manual inbox payload");
			writeFileSync(join(root, "skills", "example.md"), "skill\n");
			const components = buildProtectionEvidence(root, {
				rootGitProtected: true,
				skillsGitProtected: true,
			}).components;
			expect(components.find((item) => item.id === "root-authored")?.status).toBe("protected");
			expect(components.find((item) => item.id === "skills")?.status).toBe("protected");
			expect(components.find((item) => item.id === "external-sources")?.status).toBe("protected");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("computes component state from the resolved workspace without exposing paths", () => {
		const root = mkdtempSync(join(tmpdir(), "protection-evidence-"));
		try {
			for (const dir of ["files", "skills", "transcripts", "runtime", "cache", ".secrets", "data/imports"])
				mkdirSync(join(root, dir), { recursive: true });
			writeFileSync(join(root, "data", "signet.db"), "db");
			const result = buildProtectionEvidence(root, { now: new Date("2026-09-22T00:00:00.000Z") });
			expect(result.components.every((c) => c.status !== "unknown")).toBe(true);
			expect(result.components.find((c) => c.id === "filesystem-cache")?.status).toBe("excluded-rebuildable");
			expect(JSON.stringify(result)).not.toContain(root);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
