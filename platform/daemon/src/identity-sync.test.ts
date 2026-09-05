import { closeDbAccessor, initDbAccessor } from "./db-accessor";
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forEachInBatches, syncAgentWorkspaces } from "./identity-sync";

describe("forEachInBatches", () => {
	it("yields to the event loop between batches", async () => {
		const phases: string[] = [];
		let timerFired = false;
		setTimeout(() => {
			timerFired = true;
			phases.push("timer");
		}, 0);

		await forEachInBatches([1, 2, 3, 4], 2, async (item) => {
			phases.push(`item-${item}`);
			if (item <= 2) expect(timerFired).toBe(false);
			if (item >= 3) expect(timerFired).toBe(true);
		});

		expect(phases).toEqual(["item-1", "item-2", "timer", "item-3", "item-4"]);
	});
});

describe("syncAgentWorkspaces", () => {
	it("writes composed workspace AGENTS.md using agent overrides and shared identity", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-identity-sync-"));
		try {
			initDbAccessor(join(dir, "memory", "memories.db"), { agentsDir: dir });
			mkdirSync(join(dir, "agents", "writer", "workspace"), { recursive: true });
			writeFileSync(join(dir, "AGENTS.md"), "# Root Agent\n", "utf-8");
			writeFileSync(join(dir, "SOUL.md"), "root soul", "utf-8");
			writeFileSync(join(dir, "IDENTITY.md"), "root identity", "utf-8");
			writeFileSync(join(dir, "USER.md"), "root user", "utf-8");
			writeFileSync(join(dir, "MEMORY.md"), "root memory", "utf-8");
			writeFileSync(join(dir, "agents", "writer", "SOUL.md"), "agent soul", "utf-8");

			await syncAgentWorkspaces({ agentsDir: dir, batchSize: 1 });

			const output = readFileSync(join(dir, "agents", "writer", "workspace", "AGENTS.md"), "utf-8");
			expect(output).toContain("# Root Agent");
			expect(output).toContain("## SOUL");
			expect(output).toContain("agent soul");
			expect(output).toContain("## IDENTITY");
			expect(output).toContain("root identity");
			expect(output).toContain("## USER");
			expect(output).toContain("root user");
			expect(output).toContain("## MEMORY");
			expect(output).toContain("root memory");
			// A later sync must remove old generated text already copied into AGENTS.md.
			const generated = "<!-- generated 2026-09-04 12:00 -->\n\nStale generated Tuesday.";
			writeFileSync(join(dir, "MEMORY.md"), generated);
			await syncAgentWorkspaces({ agentsDir: dir });
			const after = readFileSync(join(dir, "agents", "writer", "workspace", "AGENTS.md"), "utf8");
			expect(after).not.toContain("## MEMORY");
			expect(after).not.toContain("Tuesday");
			expect(after).toContain("root user");
			expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe("# Root Agent\n");
			expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).toBe(generated);
		} finally {
			await closeDbAccessor();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
