import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { DescriptorRoot } from "@signet/core";
import {
	copyFileSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

test("SQLite backup reads the fenced live database rather than a separately staged WAL pair", async () => {
	const source = mkdtempSync(join(tmpdir(), "migration-live-backup-source-"));
	const state = `${source}-state`;
	const destination = `${source}-new`;
	const sourceDatabase = join(source, "memories.db");
	writeFileSync(sourceDatabase, "database fixture");
	let fenceHeld = false;
	let backupSource = "";
	const engine = new MigrationEngine({
		resolver: {
			resolve: () => ({ version: 1, root: source, destination }),
			verifyDestination: async () => expect(fenceHeld).toBe(false),
		},
		writers: { drain: async () => ({ owners: [] }) },
		database: {
			acquireFence: async () => {
				fenceHeld = true;
				return {
					release: async () => {
						fenceHeld = false;
					},
				};
			},
			prepare: async () => ({
				sourceRoot: source,
				sourcePath: "memories.db",
				destinationPath: "data/signet.db",
				bytes: 16,
			}),
			backupTo: async (sourcePath, destinationPath) => {
				expect(fenceHeld).toBe(true);
				backupSource = sourcePath;
				copyFileSync(sourcePath, destinationPath);
			},
			verifySnapshot: async () => undefined,
		},
		mapDestinationPath: (path) => (path === "memories.db" ? undefined : path),
		journalStateDir: state,
	});
	try {
		await engine.run();
		expect(backupSource).toBe(sourceDatabase);
		expect(fenceHeld).toBe(false);
	} finally {
		rmSync(source, { recursive: true, force: true });
		rmSync(destination, { recursive: true, force: true });
		rmSync(state, { recursive: true, force: true });
	}
});

test("migration rejects an external database replacement between fencing and inventory", async () => {
	const source = mkdtempSync(join(tmpdir(), "migration-fence-identity-source-"));
	const state = `${source}-state`;
	const destination = `${source}-new`;
	const external = `${source}-external.db`;
	writeFileSync(join(source, "AGENTS.md"), "identity");
	writeFileSync(external, "external authority");
	let admittedDestination = false;
	let releasedFence = false;
	const engine = new MigrationEngine({
		resolver: { resolve: () => ({ version: 1, root: source, destination }) },
		writers: { drain: async () => ({ owners: [] }) },
		database: {
			acquireFence: async () => ({
				externalDatabase: { path: external, device: "1", inode: "1" },
				release: async () => {
					releasedFence = true;
				},
			}),
			externalReference: async () => ({ path: external, device: "1", inode: "2" }),
			prepare: async () => undefined,
		},
		hooks: {
			afterDestinationAdmitted: async () => {
				admittedDestination = true;
			},
		},
		journalStateDir: state,
	});
	try {
		await expect(engine.run()).rejects.toThrow("external database identity changed during migration");
		expect(admittedDestination).toBe(false);
		expect(releasedFence).toBe(true);
	} finally {
		rmSync(source, { recursive: true, force: true });
		rmSync(state, { recursive: true, force: true });
		rmSync(destination, { recursive: true, force: true });
		rmSync(external, { force: true });
	}
});

test("migration rejects a replaced external database during restored-daemon verification", async () => {
	const source = mkdtempSync(join(tmpdir(), "migration-post-fence-source-"));
	const state = `${source}-state`;
	const destination = `${source}-new`;
	const external = `${source}-external.db`;
	const replacement = `${source}-replacement.db`;
	writeFileSync(join(source, "AGENTS.md"), "identity");
	writeFileSync(external, "original database");
	writeFileSync(replacement, "replacement database");
	const identity = () => {
		const stat = lstatSync(external, { bigint: true });
		return { path: external, device: String(stat.dev), inode: String(stat.ino) };
	};
	const original = identity();
	let fenced = false;
	const engine = new MigrationEngine({
		resolver: {
			resolve: () => ({ version: 1, root: source, destination }),
			verifyDestination: async () => {
				expect(fenced).toBe(false);
				renameSync(external, `${external}.held`);
				renameSync(replacement, external);
			},
		},
		writers: { drain: async () => ({ owners: [] }) },
		database: {
			acquireFence: async () => {
				fenced = true;
				return {
					externalDatabase: original,
					release: async () => {
						fenced = false;
					},
				};
			},
			externalReference: async () => identity(),
			prepare: async () => undefined,
		},
		journalStateDir: state,
	});
	try {
		await expect(engine.run()).rejects.toThrow("external database identity changed during migration");
		expect((await engine.status()).phase).toBe("cutover-pending");
		expect(readFileSync(`${external}.held`, "utf8")).toBe("original database");
		expect(fenced).toBe(false);
	} finally {
		rmSync(source, { recursive: true, force: true });
		rmSync(state, { recursive: true, force: true });
		rmSync(destination, { recursive: true, force: true });
		rmSync(external, { force: true });
		rmSync(`${external}.held`, { force: true });
		rmSync(replacement, { force: true });
	}
});

test("migration checks external database identity before starting restored-daemon verification", async () => {
	const source = mkdtempSync(join(tmpdir(), "migration-release-identity-source-"));
	const state = `${source}-state`;
	const destination = `${source}-new`;
	const external = `${source}-external.db`;
	const replacement = `${source}-replacement.db`;
	writeFileSync(join(source, "AGENTS.md"), "identity");
	writeFileSync(external, "original database");
	writeFileSync(replacement, "replacement database");
	const identity = () => {
		const stat = lstatSync(external, { bigint: true });
		return { path: external, device: String(stat.dev), inode: String(stat.ino) };
	};
	const original = identity();
	let verifications = 0;
	const engine = new MigrationEngine({
		resolver: {
			resolve: () => ({ version: 1, root: source, destination }),
			verifyDestination: async () => {
				verifications++;
			},
		},
		writers: { drain: async () => ({ owners: [] }) },
		database: {
			acquireFence: async () => ({
				externalDatabase: original,
				release: async () => {
					renameSync(external, `${external}.held`);
					renameSync(replacement, external);
				},
			}),
			externalReference: async () => identity(),
			prepare: async () => undefined,
		},
		journalStateDir: state,
	});
	try {
		await expect(engine.run()).rejects.toThrow("external database identity changed during migration");
		expect(verifications).toBe(0);
		expect((await engine.status()).phase).toBe("cutover-pending");
	} finally {
		rmSync(source, { recursive: true, force: true });
		rmSync(state, { recursive: true, force: true });
		rmSync(destination, { recursive: true, force: true });
		rmSync(external, { force: true });
		rmSync(`${external}.held`, { force: true });
		rmSync(replacement, { force: true });
	}
});

test("migration refuses to cut over a database without semantic verification", async () => {
	const source = mkdtempSync(join(tmpdir(), "migration-unverified-db-"));
	const state = mkdtempSync(join(tmpdir(), "migration-unverified-db-state-"));
	const destination = `${source}-new`;
	writeFileSync(join(source, "memories.db"), "database fixture");
	const engine = new MigrationEngine({
		resolver: { resolve: () => ({ version: 1, root: source, destination }) },
		writers: { drain: async () => ({ owners: [] }) },
		database: {
			prepare: async () => ({
				sourceRoot: source,
				sourcePath: "memories.db",
				destinationPath: "data/signet.db",
				bytes: 16,
			}),
		},
		journalStateDir: state,
	});
	await expect(engine.run()).rejects.toThrow("semantic database verifier is not configured");
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

test("resume tolerates source directory mtime changes when inventory is unchanged", async () => {
	const root = mkdtempSync(join(tmpdir(), "migration-directory-mtime-"));
	const source = join(root, "source");
	const nested = join(source, "nested");
	const destination = join(root, "destination");
	const state = join(root, "state");
	mkdirSync(nested, { recursive: true });
	writeFileSync(join(nested, "entry.txt"), "preserved");
	let interrupted = false;
	const engine = new MigrationEngine({
		resolver: { resolve: () => ({ version: 1, root: source, destination }) },
		writers: { drain: async () => ({ owners: [] }) },
		database: { prepare: async () => undefined },
		journalStateDir: state,
		hooks: {
			afterEntryCopy: async () => {
				if (!interrupted) {
					interrupted = true;
					utimesSync(nested, new Date(0), new Date(0));
					throw new Error("interrupt after copy");
				}
			},
		},
	});
	try {
		await expect(engine.run()).rejects.toThrow("interrupt after copy");
		await expect(engine.resume()).resolves.toMatchObject({ status: "completed" });
		expect(readFileSync(join(source, "nested", "entry.txt"), "utf8")).toBe("preserved");
		expect(readFileSync(join(destination, "nested", "entry.txt"), "utf8")).toBe("preserved");
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(destination, { recursive: true, force: true });
		rmSync(state, { recursive: true, force: true });
	}
});

test("run releases its lease when source setup fails before a journal is opened", async () => {
	const root = mkdtempSync(join(tmpdir(), "migration-run-setup-lease-"));
	const source = join(root, "missing-v1");
	const destination = join(root, "v2");
	let released = 0;
	const engine = new MigrationEngine({
		resolver: { resolve: () => ({ version: 1, root: source, destination }) },
		writers: { drain: async () => ({ owners: [] }) },
		database: { prepare: async () => undefined },
		journalStateDir: join(root, "state"),
		lease: {
			acquire: async () => ({
				release: async () => {
					released++;
				},
			}),
		},
	});
	await expect(engine.run()).rejects.toThrow();
	expect(released).toBe(1);
});

test("rollback cannot delete a destination while another migration holds the lease", async () => {
	const source = mkdtempSync(join(tmpdir(), "migration-rollback-lease-source-"));
	const state = mkdtempSync(join(tmpdir(), "migration-rollback-lease-state-"));
	const destination = `${source}-new`;
	writeFileSync(join(source, "one.txt"), "preserved");
	let held = false;
	let acquired = 0;
	let released = 0;
	const engine = new MigrationEngine({
		resolver: { resolve: () => ({ version: 1, root: source, destination }) },
		writers: { drain: async () => ({ owners: [] }) },
		database: { prepare: async () => undefined },
		journalStateDir: state,
		lease: {
			acquire: async () => {
				acquired++;
				if (held) throw new Error("migration lease held");
				return {
					release: async () => {
						released++;
					},
				};
			},
		},
		hooks: {
			afterEntryCopy: async () => {
				throw new Error("interrupt after copy");
			},
		},
	});
	await expect(engine.run()).rejects.toThrow("interrupt after copy");
	expect(readFileSync(join(destination, "one.txt"), "utf8")).toBe("preserved");
	held = true;
	await expect(engine.rollback()).rejects.toThrow("migration lease held");
	expect(readFileSync(join(destination, "one.txt"), "utf8")).toBe("preserved");
	expect(acquired).toBe(2);
	expect(released).toBe(1);
});

test("cleanup cannot retire the migration journal while another migration holds the lease", async () => {
	const source = mkdtempSync(join(tmpdir(), "migration-cleanup-lease-source-"));
	const state = mkdtempSync(join(tmpdir(), "migration-cleanup-lease-state-"));
	const destination = `${source}-new`;
	writeFileSync(join(source, "one.txt"), "preserved");
	let held = false;
	const engine = new MigrationEngine({
		resolver: { resolve: () => ({ version: 1, root: source, destination }) },
		writers: { drain: async () => ({ owners: [] }) },
		database: { prepare: async () => undefined },
		journalStateDir: state,
		lease: {
			acquire: async () => {
				if (held) throw new Error("migration lease held");
				return { release: async () => undefined };
			},
		},
	});
	await engine.run();
	held = true;
	await expect(engine.cleanup(true)).rejects.toThrow("migration lease held");
	expect(existsSync(join(destination, ".signet-migration-receipt.json"))).toBe(false);
	expect((await engine.status()).phase).toBe("completed");
});

test("journal records destination staging writes before a copied entry receives a receipt", async () => {
	const source = mkdtempSync(join(tmpdir(), "migration-staging-write-source-"));
	const state = mkdtempSync(join(tmpdir(), "migration-staging-write-state-"));
	const destination = `${source}-new`;
	writeFileSync(join(source, "one.txt"), "preserved");
	const engine = new MigrationEngine({
		resolver: { resolve: () => ({ version: 1, root: source, destination }) },
		writers: { drain: async () => ({ owners: [] }) },
		database: { prepare: async () => undefined },
		journalStateDir: state,
		hooks: {
			afterEntryCopy: async () => {
				throw new Error("interrupted before receipt");
			},
		},
	});
	await expect(engine.run()).rejects.toThrow("interrupted before receipt");
	expect(readFileSync(join(destination, "one.txt"), "utf8")).toBe("preserved");
	expect(await engine.status()).toMatchObject({ destinationWrites: true, copied: 0 });
});

test("journal records database-only destination writes before semantic verification", async () => {
	const source = mkdtempSync(join(tmpdir(), "migration-db-only-write-source-"));
	const state = mkdtempSync(join(tmpdir(), "migration-db-only-write-state-"));
	const destination = `${source}-new`;
	writeFileSync(join(source, "memories.db"), "consistent snapshot");
	const engine = new MigrationEngine({
		resolver: { resolve: () => ({ version: 1, root: source, destination }) },
		writers: { drain: async () => ({ owners: [] }) },
		database: {
			prepare: async () => ({
				sourceRoot: source,
				sourcePath: "memories.db",
				destinationPath: "data/signet.db",
				bytes: 19,
			}),
			verifySnapshot: async () => {
				throw new Error("interrupted before database receipt");
			},
		},
		mapDestinationPath: (path) => (path === "memories.db" ? undefined : path),
		journalStateDir: state,
	});
	await expect(engine.run()).rejects.toThrow("interrupted before database receipt");
	expect(readFileSync(join(destination, "data", "signet.db"), "utf8")).toBe("consistent snapshot");
	expect(await engine.status()).toMatchObject({ destinationWrites: true, copied: 0 });
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

test("cutover verification failure keeps the published pointer and resume completes", async () => {
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
			verifyDestination: async () => {
				if (failVerification) throw new Error("destination startup failed");
			},
		},
		writers: { drain: async () => ({ owners: [] }) },
		database: { prepare: async () => undefined },
		journalStateDir: join(root, "state"),
	});
	await expect(engine.run()).rejects.toThrow("destination startup failed");
	expect(pointer).toBe(destination);
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
	let preparations = 0;
	let copies = 0;
	let verifications = 0;
	const engine = new MigrationEngine({
		resolver: {
			resolve: () => ({ version: 1, root: source, destination }),
			capture: async () => pointer,
			current: async () => pointer,
			cutover: async () => {
				pointer = destination;
			},
			verifyDestination: async () => {
				verifications++;
			},
		},
		writers: { drain: async () => ({ owners: [] }) },
		database: {
			prepare: async () => {
				preparations++;
				return undefined;
			},
		},
		journalStateDir: join(root, "state"),
		hooks: {
			afterEntryCopy: async () => {
				copies++;
			},
			afterPointerPublished: async () => {
				if (crash) throw new Error("crash after pointer");
			},
		},
	});
	await expect(engine.run()).rejects.toThrow("crash after pointer");
	expect(pointer).toBe(destination);
	expect(preparations).toBe(1);
	expect(copies).toBe(1);
	expect(verifications).toBe(0);
	crash = false;
	await expect(engine.resume()).resolves.toMatchObject({ status: "completed" });
	expect(pointer).toBe(destination);
	expect(preparations).toBe(1);
	expect(copies).toBe(1);
	expect(verifications).toBe(1);
});

test("migration never claims a pre-existing destination containing unrelated data", async () => {
	const root = mkdtempSync(join(tmpdir(), "migration-preexisting-source-"));
	const destination = `${root}-new`;
	mkdirSync(destination);
	writeFileSync(join(root, "source.txt"), "source");
	writeFileSync(join(destination, "user.txt"), "user-owned");
	const engine = new MigrationEngine({
		resolver: { resolve: () => ({ version: 1, root, destination }) },
		writers: { drain: async () => ({ owners: [] }) },
		database: { prepare: async () => undefined },
		journalStateDir: join(root, "state"),
		hooks: {
			afterDestinationAdmitted: async () => {
				throw new Error("interrupt after admission");
			},
		},
	});
	await expect(engine.run()).rejects.toThrow();
	await engine.rollback().catch(() => {});
	expect(readFileSync(join(destination, "user.txt"), "utf8")).toBe("user-owned");
});

test("rollback removes a verified unreceipted copy after interruption", async () => {
	const root = mkdtempSync(join(tmpdir(), "migration-rollback-unreceipted-"));
	const destination = `${root}-new`;
	writeFileSync(join(root, "source.txt"), "source");
	const engine = new MigrationEngine({
		resolver: { resolve: () => ({ version: 1, root, destination }) },
		writers: { drain: async () => ({ owners: [] }) },
		database: { prepare: async () => undefined },
		journalStateDir: join(root, "state"),
		hooks: {
			afterEntryCopy: async () => {
				throw new Error("interrupt before receipt");
			},
		},
	});
	try {
		await expect(engine.run()).rejects.toThrow("interrupt before receipt");
		await expect(engine.rollback()).resolves.toBeUndefined();
		expect(existsSync(destination)).toBe(false);
		expect(readFileSync(join(root, "source.txt"), "utf8")).toBe("source");
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(destination, { recursive: true, force: true });
	}
});

test("rollback preserves a modified pending copy after interruption", async () => {
	const root = mkdtempSync(join(tmpdir(), "migration-rollback-modified-pending-"));
	const destination = `${root}-new`;
	writeFileSync(join(root, "source.txt"), "source");
	const engine = new MigrationEngine({
		resolver: { resolve: () => ({ version: 1, root, destination }) },
		writers: { drain: async () => ({ owners: [] }) },
		database: { prepare: async () => undefined },
		journalStateDir: join(root, "state"),
		hooks: {
			afterEntryCopy: async () => {
				throw new Error("interrupt before receipt");
			},
		},
	});
	try {
		await expect(engine.run()).rejects.toThrow("interrupt before receipt");
		writeFileSync(join(destination, "source.txt"), "user-owned");
		await expect(engine.rollback()).rejects.toThrow("destination conflict during resume: source.txt");
		expect(readFileSync(join(destination, "source.txt"), "utf8")).toBe("user-owned");
		expect(readFileSync(join(root, "source.txt"), "utf8")).toBe("source");
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(destination, { recursive: true, force: true });
	}
});

test("rollback refuses an owned destination with unrelated post-admission data", async () => {
	const root = mkdtempSync(join(tmpdir(), "migration-foreign-after-copy-"));
	const destination = `${root}-new`;
	writeFileSync(join(root, "source.txt"), "source");
	const engine = new MigrationEngine({
		resolver: { resolve: () => ({ version: 1, root, destination }) },
		writers: { drain: async () => ({ owners: [] }) },
		database: { prepare: async () => undefined },
		journalStateDir: join(root, "state"),
		hooks: {
			afterCopy: async () => {
				throw new Error("interrupt after copy");
			},
		},
	});
	await expect(engine.run()).rejects.toThrow("interrupt after copy");
	writeFileSync(join(destination, "user.txt"), "user-owned");
	await expect(engine.rollback()).rejects.toThrow("unexpected migration destination entry");
	expect(readFileSync(join(destination, "user.txt"), "utf8")).toBe("user-owned");
	expect(readFileSync(join(destination, "source.txt"), "utf8")).toBe("source");
});

test("rollback preserves every copied entry when unrelated data appears before removal", async () => {
	const root = mkdtempSync(join(tmpdir(), "migration-rollback-race-source-"));
	const destination = `${root}-new`;
	const state = join(root, "state");
	writeFileSync(join(root, "source.txt"), "source");
	const engine = new MigrationEngine({
		resolver: { resolve: () => ({ version: 1, root, destination }) },
		writers: { drain: async () => ({ owners: [] }) },
		database: { prepare: async () => undefined },
		journalStateDir: state,
		hooks: {
			afterCopy: async () => {
				throw new Error("interrupt after copy");
			},
		},
	});
	const originalRemove = DescriptorRoot.prototype.remove;
	let injected = false;
	DescriptorRoot.prototype.remove = async function (path, options) {
		if (path === "source.txt" && !injected) {
			injected = true;
			writeFileSync(join(destination, "user.txt"), "user-owned");
		}
		return originalRemove.call(this, path, options);
	};
	try {
		await expect(engine.run()).rejects.toThrow("interrupt after copy");
		await expect(engine.rollback()).rejects.toThrow("unexpected migration destination entry");
		expect(injected).toBe(true);
		expect(readFileSync(join(destination, "source.txt"), "utf8")).toBe("source");
		expect(readFileSync(join(destination, "user.txt"), "utf8")).toBe("user-owned");
		expect(readFileSync(join(root, "source.txt"), "utf8")).toBe("source");
	} finally {
		DescriptorRoot.prototype.remove = originalRemove;
		rmSync(root, { recursive: true, force: true });
		rmSync(destination, { recursive: true, force: true });
	}
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

test("distinct workspace roots retain separate migration journals in shared state", async () => {
	const root = mkdtempSync(join(tmpdir(), "migration-workspace-identity-"));
	const firstRoot = join(root, "first");
	const secondRoot = join(root, "second");
	const journalStateDir = join(root, "shared-state");
	mkdirSync(firstRoot);
	mkdirSync(secondRoot);
	writeFileSync(join(firstRoot, "same.txt"), "same");
	writeFileSync(join(secondRoot, "same.txt"), "same");
	const firstDestination = join(root, "first-destination");
	const secondDestination = join(root, "second-destination");
	const first = new MigrationEngine({
		resolver: { resolve: () => ({ version: 1, root: firstRoot, destination: firstDestination }) },
		writers: { drain: async () => ({ owners: [] }) },
		database: { prepare: async () => undefined },
		journalStateDir,
		hooks: {
			afterCopy: async () => {
				throw new Error("interrupt migration");
			},
		},
	});
	await expect(first.run()).rejects.toThrow("interrupt migration");
	let drains = 0;
	const second = new MigrationEngine({
		resolver: { resolve: () => ({ version: 1, root: secondRoot, destination: secondDestination }) },
		writers: {
			drain: async () => {
				drains++;
				return { owners: [] };
			},
		},
		database: { prepare: async () => undefined },
		journalStateDir,
	});
	const secondResult = await second.run();
	expect(secondResult.status).toBe("completed");
	expect(drains).toBe(1);
	expect(readFileSync(join(secondDestination, "same.txt"), "utf8")).toBe("same");
	const firstStatus = await first.status();
	const secondStatus = await second.status();
	expect(firstStatus.journal).not.toBe(secondStatus.journal);
	expect(firstStatus.phase).toBe("failed");
	expect(secondStatus.phase).toBe("completed");
});

test("resume fails closed when a new source entry appears after the journaled inventory", async () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-source-inventory-"));
	const journalStateDir = mkdtempSync(join(tmpdir(), "signet-migration-source-state-"));
	writeFileSync(join(root, "one.txt"), "one");
	const destination = join(`${root}-new`);
	const engine = new MigrationEngine({
		resolver: { resolve: () => ({ version: 1, root, destination }) },
		writers: { drain: async () => ({ owners: [] }) },
		database: { prepare: async () => undefined },
		journalStateDir,
		hooks: {
			afterCopy: async () => {
				throw new Error("interrupt before verification");
			},
		},
	});
	await expect(engine.run()).rejects.toThrow("interrupt before verification");
	writeFileSync(join(root, "late.txt"), "late");
	await expect(engine.resume()).rejects.toThrow("source inventory changed");
	expect(existsSync(join(destination, "late.txt"))).toBe(false);
});

test("cutover-pending rejects a different external database inode after pointer publication", async () => {
	const root = mkdtempSync(join(tmpdir(), "migration-cutover-db-identity-"));
	const source = join(root, "source");
	const destination = join(root, "destination");
	const external = join(root, "outside.db");
	const replacement = join(root, "replacement.db");
	const state = join(root, "state");
	mkdirSync(source);
	writeFileSync(join(source, "AGENTS.md"), "preserve");
	for (const [path, value] of [
		[external, "original"],
		[replacement, "replacement"],
	] as const) {
		const database = new Database(path);
		database.exec(`CREATE TABLE proof (value TEXT NOT NULL); INSERT INTO proof VALUES ('${value}')`);
		database.close();
	}
	let pointer = source;
	let fenceHeld = false;
	const originalInode = lstatSync(external, { bigint: true }).ino;
	const engine = new MigrationEngine({
		resolver: {
			resolve: () => ({ version: 1, root: source, destination }),
			current: async () => pointer,
			cutover: async () => {
				pointer = destination;
			},
			verifyDestination: async () => undefined,
		},
		writers: { drain: async () => ({ owners: [] }) },
		database: {
			acquireFence: async () => {
				fenceHeld = true;
				return {
					release: async () => {
						fenceHeld = false;
					},
				};
			},
			prepare: async () => undefined,
			externalReference: async () => {
				if (!fenceHeld) throw new Error("external identity checked without database fence");
				const stat = lstatSync(external, { bigint: true });
				return { path: external, device: String(stat.dev), inode: String(stat.ino) };
			},
		},
		journalStateDir: state,
		hooks: {
			afterPointerPublished: async () => {
				renameSync(replacement, external);
				throw new Error("crash after pointer publication");
			},
		},
	});
	await expect(engine.run()).rejects.toThrow("crash after pointer publication");
	expect(pointer).toBe(destination);
	expect(lstatSync(external, { bigint: true }).ino).not.toBe(originalInode);
	const journalPath = join(state, `${createHash("sha256").update(resolve(source)).digest("hex").slice(0, 32)}.json`);
	const journal = JSON.parse(readFileSync(journalPath, "utf8"));
	expect(journal.externalDatabase).toMatchObject({ path: external, inode: String(originalInode) });
	await expect(engine.resume()).rejects.toThrow("external database identity changed");
	journal.pointerPublished = false;
	writeFileSync(journalPath, JSON.stringify(journal));
	await expect(engine.resume()).rejects.toThrow("external database identity changed");
	delete journal.externalDatabase;
	writeFileSync(journalPath, JSON.stringify(journal));
	await expect(engine.resume()).rejects.toThrow("external database identity is missing from migration journal");
	expect((await engine.status()).phase).toBe("cutover-pending");
	rmSync(root, { recursive: true, force: true });
});

test("cutover-pending accepts ordinary writes to the same external database inode", async () => {
	const root = mkdtempSync(join(tmpdir(), "migration-cutover-db-writes-"));
	const source = join(root, "source");
	const destination = join(root, "destination");
	const external = join(root, "outside.db");
	mkdirSync(source);
	writeFileSync(join(source, "AGENTS.md"), "preserve");
	const original = new Database(external);
	original.exec("CREATE TABLE proof (value TEXT NOT NULL); INSERT INTO proof VALUES ('original')");
	original.close();
	const before = lstatSync(external, { bigint: true });
	let pointer = source;
	let fenceHeld = false;
	let witnessedFencedReference = false;
	const engine = new MigrationEngine({
		resolver: {
			resolve: () => ({ version: 1, root: source, destination }),
			current: async () => pointer,
			cutover: async () => {
				pointer = destination;
			},
			verifyDestination: async () => undefined,
		},
		writers: { drain: async () => ({ owners: [] }) },
		database: {
			acquireFence: async () => {
				fenceHeld = true;
				return {
					release: async () => {
						fenceHeld = false;
					},
				};
			},
			prepare: async () => undefined,
			externalReference: async () => {
				if (fenceHeld) witnessedFencedReference = true;
				const stat = lstatSync(external, { bigint: true });
				return { path: external, device: String(stat.dev), inode: String(stat.ino) };
			},
		},
		journalStateDir: join(root, "state"),
		hooks: {
			afterPointerPublished: async () => {
				const db = new Database(external);
				try {
					db.exec("INSERT INTO proof VALUES ('post-cutover')");
				} finally {
					db.close();
				}
				throw new Error("crash after pointer publication");
			},
		},
	});
	await expect(engine.run()).rejects.toThrow("crash after pointer publication");
	expect(lstatSync(external, { bigint: true }).ino).toBe(before.ino);
	await expect(engine.resume()).resolves.toMatchObject({ status: "completed" });
	expect(witnessedFencedReference).toBe(true);
	const verified = new Database(external, { readonly: true });
	try {
		expect(verified.prepare("SELECT value FROM proof ORDER BY rowid").all()).toEqual([
			{ value: "original" },
			{ value: "post-cutover" },
		]);
	} finally {
		verified.close();
	}
	rmSync(root, { recursive: true, force: true });
});

test("resume fails closed when the external authoritative database disappears", async () => {
	const root = mkdtempSync(join(tmpdir(), "migration-external-db-resume-"));
	const source = join(root, "source");
	const destination = join(root, "destination");
	const state = join(root, "state");
	mkdirSync(source);
	writeFileSync(join(source, "proof.txt"), "stable");
	const external = join(root, "outside.db");
	writeFileSync(external, "external identity");
	let interrupt = true;
	const engine = new MigrationEngine({
		resolver: { resolve: () => ({ version: 1, root: source, destination }) },
		writers: { drain: async () => ({ owners: [] }) },
		database: {
			prepare: async () => {
				if (!existsSync(external)) throw new Error("external source database is missing");
				return undefined;
			},
		},
		journalStateDir: state,
		hooks: {
			afterCopy: async () => {
				if (interrupt) {
					interrupt = false;
					throw new Error("interrupt migration");
				}
			},
		},
	});
	await expect(engine.run()).rejects.toThrow("interrupt migration");
	rmSync(external);
	await expect(engine.resume()).rejects.toThrow("external source database is missing");
	expect(existsSync(join(destination, "proof.txt"))).toBe(true);
});

test("resume blocks when an external database reference changes", async () => {
	const root = mkdtempSync(join(tmpdir(), "migration-external-db-changed-"));
	const source = join(root, "source");
	const destination = join(root, "destination");
	const original = join(root, "outside.db");
	mkdirSync(source);
	writeFileSync(join(source, "proof.txt"), "stable");
	writeFileSync(original, "original external database");
	let interrupt = true;
	const engine = new MigrationEngine({
		resolver: { resolve: () => ({ version: 1, root: source, destination }) },
		writers: { drain: async () => ({ owners: [] }) },
		database: {
			prepare: async () => ({ sourceRoot: root, sourcePath: "outside.db", destinationPath: "outside.db", bytes: 1 }),
			verifySnapshot: async () => undefined,
		},
		journalStateDir: join(root, "state"),
		gitignoreBytes: () => {
			if (interrupt) {
				interrupt = false;
				throw new Error("interrupted after database snapshot");
			}
			return new Uint8Array();
		},
	});
	await expect(engine.run()).rejects.toThrow("interrupted after database snapshot");
	writeFileSync(original, "changed external database");
	await expect(engine.resume()).rejects.toThrow("database snapshot source changed or disappeared");
});

test("migration journal validates source database identity before resume", async () => {
	const root = mkdtempSync(join(tmpdir(), "migration-db-source-identity-"));
	const source = join(root, "source");
	const destination = join(root, "destination");
	mkdirSync(source);
	writeFileSync(join(source, "memory.db"), "original db");
	let interrupted = true;
	const engine = new MigrationEngine({
		resolver: { resolve: () => ({ version: 1, root: source, destination }) },
		writers: { drain: async () => ({ owners: [] }) },
		database: {
			prepare: async () => ({
				sourceRoot: source,
				sourcePath: "memory.db",
				destinationPath: "data/signet.db",
				bytes: 11,
			}),
			verifySnapshot: async () => undefined,
		},
		mapDestinationPath: (path) => (path === "memory.db" ? undefined : path),
		journalStateDir: join(root, "state"),
		gitignoreBytes: () => {
			if (interrupted) {
				interrupted = false;
				throw new Error("interrupted after snapshot");
			}
			return new Uint8Array();
		},
	});
	await expect(engine.run()).rejects.toThrow("interrupted after snapshot");
	writeFileSync(join(source, "memory.db"), "different db");
	await expect(engine.resume()).rejects.toThrow("database snapshot source changed or disappeared");
});

test("resume fails closed when a database snapshot journal lacks WAL evidence", async () => {
	const root = mkdtempSync(join(tmpdir(), "migration-db-old-journal-"));
	const source = join(root, "source");
	const destination = join(root, "destination");
	mkdirSync(source);
	writeFileSync(join(source, "memories.db"), "stable database");
	const state = join(root, "state");
	let interrupt = true;
	const engine = new MigrationEngine({
		resolver: { resolve: () => ({ version: 1, root: source, destination }) },
		writers: { drain: async () => ({ owners: [] }) },
		database: {
			prepare: async () => ({
				sourceRoot: source,
				sourcePath: "memories.db",
				destinationPath: "data/signet.db",
				bytes: 15,
			}),
			backupTo: async () => undefined,
			verifySnapshot: async () => undefined,
		},
		mapDestinationPath: (path) => (path === "memories.db" ? undefined : path),
		journalStateDir: state,
		hooks: {
			afterCopy: async () => {
				if (interrupt) {
					interrupt = false;
					throw new Error("interrupt before snapshot");
				}
			},
		},
	});
	await expect(engine.run()).rejects.toThrow("interrupt before snapshot");
	const journalPath = join(state, `${createHash("sha256").update(resolve(source)).digest("hex").slice(0, 32)}.json`);
	const journal = JSON.parse(readFileSync(journalPath, "utf8"));
	journal.databaseSnapshot = {
		sourceRoot: source,
		sourcePath: "memories.db",
		destinationPath: "data/signet.db",
		bytes: 15,
		hash: createHash("sha256").update("stable database").digest("hex"),
	};
	writeFileSync(journalPath, JSON.stringify(journal));
	await expect(engine.resume()).rejects.toThrow("database snapshot journal lacks WAL evidence");
});

test("resume rejects a database snapshot whose source disappeared before cutover", async () => {
	const root = mkdtempSync(join(tmpdir(), "migration-db-resume-"));
	const source = join(root, "source");
	const destination = join(root, "destination");
	mkdirSync(source);
	writeFileSync(join(source, "memories.db"), "stable database");
	let preparation = 0;
	let interrupted = false;
	const engine = new MigrationEngine({
		resolver: { resolve: () => ({ version: 1, root: source, destination }) },
		writers: { drain: async () => ({ owners: [] }) },
		database: {
			prepare: async () => {
				preparation++;
				if (!existsSync(join(source, "memories.db"))) return undefined;
				return {
					sourceRoot: source,
					sourcePath: "memories.db",
					destinationPath: "data/signet.db",
					bytes: 15,
				};
			},
			verifySnapshot: async () => undefined,
		},
		mapDestinationPath: (path) => (path === "memories.db" ? undefined : path),
		journalStateDir: join(root, "state"),
		gitignoreBytes: (existing) => {
			if (!interrupted) {
				interrupted = true;
				throw new Error("interrupt after snapshot");
			}
			return new TextEncoder().encode(existing);
		},
	});
	await expect(engine.run()).rejects.toThrow("interrupt after snapshot");
	expect(existsSync(join(destination, "data", "signet.db"))).toBe(true);
	rmSync(join(source, "memories.db"));
	await expect(engine.resume()).rejects.toThrow("database snapshot source changed or disappeared");
	expect(preparation).toBe(2);
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
