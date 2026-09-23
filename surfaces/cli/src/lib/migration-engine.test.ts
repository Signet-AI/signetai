import { expect, test } from "bun:test";
import {
	existsSync,
	linkSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	renameSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MigrationEngine } from "./migration-engine.js";

test("preflight is read-only and inventory reports required bytes", async () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-"));
	writeFileSync(join(root, "AGENTS.md"), "identity");
	const destination = join(`${root}-new`);
	let drains = 0;
	let leases = 0;
	const engine = new MigrationEngine({
		resolver: { resolve: () => ({ version: 1, root, destination }) },
		writers: {
			drain: async () => {
				drains++;
				return { owners: [] };
			},
		},
		database: { prepare: async () => undefined },
		lease: {
			acquire: async () => {
				leases++;
				return { release: async () => undefined };
			},
		},
		journalStateDir: join(root, "state"),
	});
	const plan = await engine.preflight();
	expect(plan.readOnly).toBe(true);
	expect(plan.bytes).toBe(8);
	expect(plan.components).toContain("AGENTS.md");
	expect(drains).toBe(0);
	expect(leases).toBe(0);
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
		database: { prepare: async () => undefined },
		journalStateDir: state,
	});
	await engine.run();
	expect(readFileSync(join(destination, "memory", "memories.db"), "utf8")).toBe("db");
});

test("destination writes remain rooted in the admitted parent after pathname replacement", async () => {
	const source = mkdtempSync(join(tmpdir(), "migration-admitted-source-"));
	const destinationParent = mkdtempSync(join(tmpdir(), "migration-admitted-parent-"));
	const admittedParent = `${destinationParent}-admitted`;
	const attacker = mkdtempSync(join(tmpdir(), "migration-admitted-attacker-"));
	const state = mkdtempSync(join(tmpdir(), "migration-admitted-state-"));
	writeFileSync(join(source, "one.txt"), "one");
	const destination = join(destinationParent, "workspace");
	const engine = new MigrationEngine({
		resolver: { resolve: () => ({ version: 1, root: source, destination }) },
		writers: { drain: async () => ({ owners: [] }) },
		database: { prepare: async () => undefined },
		journalStateDir: state,
		hooks: {
			afterDestinationAdmitted: async () => {
				renameSync(destinationParent, admittedParent);
				symlinkSync(attacker, destinationParent);
			},
		},
	});
	await expect(engine.run()).rejects.toThrow("destination identity changed");
	expect(readFileSync(join(admittedParent, "workspace", "one.txt"), "utf8")).toBe("one");
	expect(existsSync(join(attacker, "workspace", "one.txt"))).toBe(false);
});

test("migration preserves root and nested Git metadata while reporting hardlinks", async () => {
	const source = mkdtempSync(join(tmpdir(), "migration-git-source-"));
	const state = mkdtempSync(join(tmpdir(), "migration-git-state-"));
	const destination = `${source}-new`;
	mkdirSync(join(source, ".git", "hooks"), { recursive: true });
	mkdirSync(join(source, "skills", "nested", ".git"), { recursive: true });
	writeFileSync(join(source, ".git", "config"), "root-config");
	writeFileSync(join(source, ".git", "hooks", "pre-commit"), "hook");
	writeFileSync(join(source, "skills", "nested", ".git", "config"), "nested-config");
	writeFileSync(join(source, "payload"), "same");
	linkSync(join(source, "payload"), join(source, "payload-link"));
	const engine = new MigrationEngine({
		resolver: { resolve: () => ({ version: 1, root: source, destination }) },
		writers: { drain: async () => ({ owners: [] }) },
		database: { prepare: async () => undefined },
		journalStateDir: state,
	});
	const plan = await engine.preflight();
	expect(plan.hardlinks).toEqual([["payload", "payload-link"]]);
	await engine.run();
	expect(readFileSync(join(destination, ".git", "config"), "utf8")).toBe("root-config");
	expect(readFileSync(join(destination, ".git", "hooks", "pre-commit"), "utf8")).toBe("hook");
	expect(readFileSync(join(destination, "skills", "nested", ".git", "config"), "utf8")).toBe("nested-config");
	expect(readFileSync(join(destination, "payload-link"), "utf8")).toBe("same");
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
		database: { prepare: async () => undefined },
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
		database: { prepare: async () => undefined },
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
		database: { prepare: async () => undefined },
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
		database: { prepare: async () => undefined },
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

test("cutover verification failure restores the pointer preimage and resume completes", async () => {
	const root = mkdtempSync(join(tmpdir(), "migration-cutover-verify-"));
	const source = join(root, "old");
	const destination = join(root, "new");
	mkdirSync(source);
	writeFileSync(join(source, "one.txt"), "one");
	let pointer = source;
	let failVerification = true;
	const engine = new MigrationEngine({
		resolver: {
			resolve: () => ({ version: 1, root: source, destination }),
			capture: async () => pointer,
			current: async () => pointer,
			cutover: async () => {
				pointer = destination;
			},
			restore: async (preimage) => {
				pointer = preimage ?? source;
			},
			verifyDestination: async () => {
				if (failVerification) throw new Error("destination startup failed");
			},
		},
		writers: { drain: async () => ({ owners: [] }) },
		database: { prepare: async () => undefined },
		journalStateDir: join(root, "state"),
	});
	await expect(engine.run()).rejects.toThrow("destination startup failed");
	expect(pointer).toBe(source);
	failVerification = false;
	await expect(engine.resume()).resolves.toMatchObject({ status: "completed" });
	expect(pointer).toBe(destination);
});

test("resume completes a cutover interrupted after pointer publication", async () => {
	const root = mkdtempSync(join(tmpdir(), "migration-cutover-crash-"));
	const source = join(root, "old");
	const destination = join(root, "new");
	mkdirSync(source);
	writeFileSync(join(source, "one.txt"), "one");
	let pointer = source;
	let crash = true;
	const engine = new MigrationEngine({
		resolver: {
			resolve: () => ({ version: 1, root: source, destination }),
			capture: async () => pointer,
			current: async () => pointer,
			cutover: async () => {
				pointer = destination;
			},
			verifyDestination: async () => {},
		},
		writers: { drain: async () => ({ owners: [] }) },
		database: { prepare: async () => undefined },
		journalStateDir: join(root, "state"),
		hooks: {
			afterPointerPublished: async () => {
				if (crash) throw new Error("crash after pointer");
			},
		},
	});
	await expect(engine.run()).rejects.toThrow("crash after pointer");
	expect(pointer).toBe(destination);
	crash = false;
	await expect(engine.resume()).resolves.toMatchObject({ status: "completed" });
	expect(pointer).toBe(destination);
});

test("rollback removes only the owned partial destination and can be rerun", async () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-"));
	writeFileSync(join(root, "one.txt"), "one");
	const destination = join(`${root}-new`);
	const engine = new MigrationEngine({
		resolver: { resolve: () => ({ version: 1, root, destination }) },
		writers: { drain: async () => ({ owners: [] }) },
		database: { prepare: async () => undefined },
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
		database: { prepare: async () => undefined },
		journalStateDir: state,
	});
	await engine.run();
	await engine.cleanup(true);
	const receipt = JSON.parse(readFileSync(join(destination, ".signet-migration-receipt.json"), "utf8"));
	expect(existsSync(join(destination, ".signet-migration-receipt.json"))).toBe(true);
	expect(receipt.components).toEqual([{ component: "one.txt", verified: true }]);
	expect(receipt.rollbackBoundary).toBe("cutover-published");
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
		database: { prepare: async () => undefined },
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
