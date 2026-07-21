import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applyFilePatch, __resolveFilePathForTest } from "./file-patch";

describe("file-patch apply", () => {
	let agentsDir: string;

	beforeEach(() => {
		agentsDir = mkdtempSync(join(tmpdir(), "ingest-patch-"));
	});
	afterEach(() => {
		// tmpdir is reaped by the OS; nothing to do.
	});

	test("appends a marked block to an identity file", async () => {
		writeFileSync(join(agentsDir, "AGENTS.md"), "# Agents\nExisting body.\n");
		const res = await applyFilePatch(
			{ id: "fp1", file: "AGENTS.md", append: "## Notes\nA new durable note." },
			{ agentId: "default", actor: "daemon", agentsDir },
		);
		expect(res.outcome).toBe("applied");
		const content = await Bun.file(join(agentsDir, "AGENTS.md")).text();
		expect(content).toContain("Existing body."); // prior content preserved
		expect(content).toContain("A new durable note.");
		expect(content).toContain("<!-- ingest-patch:fp1 ");
		expect(content).toContain("<!-- /ingest-patch:fp1 -->");
	});

	test("re-applying the same patch id is a no-op (idempotent)", async () => {
		writeFileSync(join(agentsDir, "SOUL.md"), "# Soul\n");
		const first = await applyFilePatch(
			{ id: "fp1", file: "SOUL.md", append: "first addition" },
			{ agentId: "default", actor: "daemon", agentsDir },
		);
		const second = await applyFilePatch(
			{ id: "fp1", file: "SOUL.md", append: "first addition" },
			{ agentId: "default", actor: "daemon", agentsDir },
		);
		expect(first.outcome).toBe("applied");
		expect(second.outcome).toBe("skipped");
		expect(second.reason).toMatch(/already applied/);
		// Content unchanged after the second (no double-append).
		const content = await Bun.file(join(agentsDir, "SOUL.md")).text();
		expect(content.match(/first addition/g)).toHaveLength(1);
	});

	test("captures a before-state backup for one-call revert", async () => {
		writeFileSync(join(agentsDir, "USER.md"), "original\n");
		await applyFilePatch(
			{ id: "fp1", file: "USER.md", append: "appended" },
			{ agentId: "default", actor: "daemon", agentsDir },
		);
		const versions = readdirSync(join(agentsDir, ".ingest", "versions"));
		expect(versions.length).toBe(1);
		expect(versions[0]).toContain("fp1");
		const backup = await Bun.file(join(agentsDir, ".ingest", "versions", versions[0])).text();
		expect(backup).toBe("original\n"); // exact before-state
	});

	test("two different patch ids to the same file both land (no collision)", async () => {
		writeFileSync(join(agentsDir, "MEMORY.md"), "# Memory\n");
		await applyFilePatch(
			{ id: "fp1", file: "MEMORY.md", append: "first" },
			{ agentId: "default", actor: "daemon", agentsDir },
		);
		await applyFilePatch(
			{ id: "fp2", file: "MEMORY.md", append: "second" },
			{ agentId: "default", actor: "cron", agentsDir },
		);
		const content = await Bun.file(join(agentsDir, "MEMORY.md")).text();
		expect(content).toContain("first");
		expect(content).toContain("second");
	});

	test("rejects a file path that escapes the agents workspace", () => {
		expect(() => __resolveFilePathForTest(agentsDir, "../../etc/passwd")).toThrow(/escapes/);
		expect(() => __resolveFilePathForTest(agentsDir, "/etc/passwd")).toThrow(/escapes/);
	});
});
