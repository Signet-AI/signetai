import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MigrationEngine } from "./migration-engine.js";

test("preflight is read-only and inventory reports required bytes", async () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-"));
	writeFileSync(join(root, "AGENTS.md"), "identity");
	const destination = join(root, "new");
	const engine = new MigrationEngine({
		resolver: { resolve: () => ({ version: 1, root, destination }) },
		writers: { drain: async () => ({ owners: [] }) },
		database: { snapshot: async () => ({ path: join(root, "db"), bytes: 0 }), verify: async () => true },
		journalStateDir: join(root, "state"),
	});
	const plan = await engine.preflight();
	expect(plan.readOnly).toBe(true);
	expect(plan.bytes).toBe(8);
	expect(plan.components).toContain("AGENTS.md");
});

test("interrupted copy resumes and rollback is fenced after destination writes", async () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-"));
	mkdirSync(join(root, "old"));
	writeFileSync(join(root, "old", "one.txt"), "one");
	const destination = join(root, "new");
	let copied = false;
	const engine = new MigrationEngine({
		resolver: { resolve: () => ({ version: 1, root: join(root, "old"), destination }), cutover: async () => {} },
		writers: { drain: async () => ({ owners: [] }) },
		database: { snapshot: async () => ({ path: join(root, "db"), bytes: 0 }), verify: async () => true },
		journalStateDir: join(root, "state"),
		hooks: {
			afterCopy: async () => {
				if (!copied) {
					copied = true;
					throw new Error("interrupt");
				}
			},
		},
	});
	await expect(engine.run()).rejects.toThrow("interrupt");
	expect(await engine.resume()).toMatchObject({ status: "completed" });
	await expect(engine.rollback()).rejects.toThrow("rollback is no longer safe");
});

test("escaping symlink is rejected without following it", async () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-"));
	writeFileSync(join(root, "secret"), "no");
	writeFileSync(join(root, "inside"), "yes");
	const { symlinkSync } = await import("node:fs");
	const outside = mkdtempSync(join(tmpdir(), "signet-outside-"));
	writeFileSync(join(outside, "secret"), "no");
	symlinkSync(join(outside, "secret"), join(root, "link"));
	const engine = new MigrationEngine({
		resolver: { resolve: () => ({ version: 1, root, destination: join(root, "new") }) },
		writers: { drain: async () => ({ owners: [] }) },
		database: { snapshot: async () => ({ path: join(root, "db"), bytes: 0 }), verify: async () => true },
		journalStateDir: join(root, "state"),
	});
	await expect(engine.run()).rejects.toThrow("escaping symlink");
});
