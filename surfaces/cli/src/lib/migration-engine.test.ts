import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MigrationEngine } from "./migration-engine.js";

test("preflight is read-only and inventory reports required bytes", async () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-"));
	writeFileSync(join(root, "AGENTS.md"), "identity");
	const destination = join(`${root}-new`);
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

test("migration creates verified destination directories for nested files", async () => {
	const root = mkdtempSync(join(tmpdir(), "migration-nested-"));
	const state = mkdtempSync(join(tmpdir(), "migration-nested-state-"));
	mkdirSync(join(root, "memory"), { recursive: true });
	writeFileSync(join(root, "memory", "memories.db"), "db");
	const destination = `${root}-new`;
	const engine = new MigrationEngine({
		resolver: { resolve: () => ({ version: 1, root, destination }) },
		writers: { drain: async () => ({ owners: [] }) },
		database: { snapshot: async () => ({ path: join(root, "db"), bytes: 0 }), verify: async () => true },
		journalStateDir: state,
	});
	await engine.run();
	expect(readFileSync(join(destination, "memory", "memories.db"), "utf8")).toBe("db");
});

test("interrupted copy resumes and rollback is fenced after destination writes", async () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-"));
	mkdirSync(join(root, "old"));
	writeFileSync(join(root, "old", "one.txt"), "one");
	const destination = join(`${root}-new`);
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
		resolver: { resolve: () => ({ version: 1, root, destination: join(`${root}-new`) }) },
		writers: { drain: async () => ({ owners: [] }) },
		database: { snapshot: async () => ({ path: join(root, "db"), bytes: 0 }), verify: async () => true },
		journalStateDir: join(root, "state"),
	});
	await expect(engine.run()).rejects.toThrow("escaping symlink");
});

test("run drains before inventory and rejects source mutation during preflight", async () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-"));
	writeFileSync(join(root, "one.txt"), "one");
	const destination = join(`${root}-new`);
	let drained = false;
	const engine = new MigrationEngine({
		resolver: { resolve: () => ({ version: 1, root, destination }) },
		writers: {
			drain: async () => {
				drained = true;
				writeFileSync(join(root, "one.txt"), "changed");
				return { owners: [] };
			},
		},
		database: { snapshot: async () => ({ path: join(root, "db"), bytes: 0 }), verify: async () => true },
		journalStateDir: join(root, "state"),
	});
	await expect(engine.run()).resolves.toMatchObject({ status: "completed" });
	expect(drained).toBe(true);
});

test("cutover-pending resume reacquires lease and drains writers", async () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-"));
	writeFileSync(join(root, "one.txt"), "one");
	const destination = join(`${root}-new`);
	let acquired = 0;
	let drained = 0;
	const deps = {
		resolver: {
			resolve: () => ({ version: 1, root, destination }),
			cutover: async () => {
				throw new Error("cutover interrupted");
			},
		},
		writers: {
			drain: async () => {
				drained++;
				return { owners: [] };
			},
		},
		database: { snapshot: async () => ({ path: join(root, "db"), bytes: 0 }), verify: async () => true },
		journalStateDir: join(root, "state"),
		lease: {
			acquire: async () => {
				acquired++;
				return { release: async () => {} };
			},
		},
	};
	const first = new MigrationEngine(deps);
	await expect(first.run()).rejects.toThrow("cutover interrupted");
	const second = new MigrationEngine({
		...deps,
		resolver: { resolve: () => ({ version: 1, root, destination }), cutover: async () => {} },
	});
	await second.resume();
	expect(acquired).toBe(2);
	expect(drained).toBe(2);
});

test("rollback removes only the owned partial destination and can be rerun", async () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-"));
	writeFileSync(join(root, "one.txt"), "one");
	const destination = join(`${root}-new`);
	const engine = new MigrationEngine({
		resolver: { resolve: () => ({ version: 1, root, destination }) },
		writers: { drain: async () => ({ owners: [] }) },
		database: { snapshot: async () => ({ path: join(root, "db"), bytes: 0 }), verify: async () => true },
		journalStateDir: join(root, "state"),
		hooks: {
			afterCopy: async () => {
				throw new Error("interrupt");
			},
		},
	});
	await expect(engine.run()).rejects.toThrow("interrupt");
	await engine.rollback();
	await expect(engine.status()).resolves.toMatchObject({ phase: "not-started" });
	await expect(engine.run()).rejects.toThrow("interrupt");
});

test("cleanup writes a durable redacted receipt with verified components", async () => {
const root = mkdtempSync(join(tmpdir(), "signet-migration-receipt-"));
writeFileSync(join(root, "one.txt"), "one");
const destination = join(`${root}-new`);
const state = join(root, "state");
const engine = new MigrationEngine({
	resolver: { resolve: () => ({ version: 1, root, destination }) },
	writers: { drain: async () => ({ owners: [] }) },
	database: { snapshot: async () => ({ path: join(root, "db"), bytes: 0 }), verify: async () => true },
	journalStateDir: state,
});
await engine.run();
await engine.cleanup(true);
const receipt = JSON.parse(readFileSync(join(destination, ".signet-migration-receipt.json"), "utf8"));
expect(existsSync(join(destination, ".signet-migration-receipt.json"))).toBe(true);
expect(receipt.components).toEqual([{ component: "one.txt", verified: true }]);
expect(receipt.rollbackBoundary).toBe("destination-writes-fenced");
expect(receipt.sourceVersion).toBe(1);
expect(receipt.destinationVersion).toBe(2);
expect(JSON.stringify(receipt)).not.toContain(root);
});

test("resume reconciles a copied file left behind before its journal update", async () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-"));
	const journalStateDir = mkdtempSync(join(tmpdir(), "signet-migration-state-"));
	writeFileSync(join(root, "one.txt"), "one");
	const destination = join(`${root}-new`);
	let interrupted = false;
	const engine = new MigrationEngine({
		resolver: { resolve: () => ({ version: 1, root, destination }), cutover: async () => {} },
		writers: { drain: async () => ({ owners: [] }) },
		database: { snapshot: async () => ({ path: join(root, "db"), bytes: 0 }), verify: async () => true },
		journalStateDir,
		hooks: {
			afterEntryCopy: async () => {
				if (!interrupted) {
					interrupted = true;
					throw new Error("crash after copy before journal");
				}
			},
		},
	});
	await expect(engine.run()).rejects.toThrow("crash after copy before journal");
	expect(await engine.resume()).toMatchObject({ status: "completed" });
});
