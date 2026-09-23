import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspaceLayout } from "@signet/core";

test("production CLI registers the workspace migration lifecycle", () => {
	const cli = join(import.meta.dir, "..", "cli.ts");
	const result = spawnSync(process.execPath, [cli, "migration", "--help"], {
		cwd: join(import.meta.dir, "..", "..", "..", ".."),
		encoding: "utf8",
		env: { ...process.env, SIGNET_DAEMON_ENTRYPOINT: "0" },
	});
	expect(result.status).toBe(0);
	expect(result.stdout).toContain("Manage the v1 to v2 workspace migration");
	for (const command of ["preflight", "run", "resume", "status", "rollback", "cleanup"])
		expect(result.stdout).toContain(command);
});

test("production CLI migrates and verifies a real v1 SQLite workspace", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-cli-"));
	const source = join(root, "v1");
	const destination = join(root, "v2");
	const home = join(root, "home");
	const config = join(root, "config");
	const state = join(root, "state");
	mkdirSync(join(source, "memory"), { recursive: true });
	mkdirSync(home, { recursive: true });
	try {
		const sourceDb = new Database(join(source, "memory", "memories.db"), { create: true });
		sourceDb.exec('CREATE TABLE proof (value TEXT NOT NULL); INSERT INTO proof VALUES ("workspace-v2-ok")');
		sourceDb.close();
		const cli = join(import.meta.dir, "..", "cli.ts");
		const result = spawnSync(
			process.execPath,
			[cli, "migration", "run", "--source", source, "--destination", destination],
			{
				cwd: join(import.meta.dir, "..", "..", "..", ".."),
				encoding: "utf8",
				env: {
					...process.env,
					HOME: home,
					XDG_CONFIG_HOME: config,
					XDG_STATE_HOME: state,
					SIGNET_PATH: source,
					SIGNET_DAEMON_ENTRYPOINT: "0",
				},
			},
		);
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ status: "completed", destination });
		const layout = resolveWorkspaceLayout(destination);
		expect(layout.version).toBe(2);
		const migrated = new Database(layout.database, { readonly: true });
		expect(migrated.query("SELECT value FROM proof").get()).toEqual({ value: "workspace-v2-ok" });
		migrated.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);

test("production CLI resumes when a matching SQLite snapshot exists before its journal update", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-snapshot-resume-"));
	const source = join(root, "v1");
	const destination = join(root, "v2");
	const home = join(root, "home");
	const config = join(root, "config");
	const state = join(root, "state");
	mkdirSync(join(source, "memory"), { recursive: true });
	mkdirSync(join(destination, "data"), { recursive: true });
	mkdirSync(home, { recursive: true });
	try {
		const sourceDb = new Database(join(source, "memory", "memories.db"), { create: true });
		sourceDb.exec('CREATE TABLE proof (value TEXT NOT NULL); INSERT INTO proof VALUES ("resume-ok")');
		const snapshot = join(destination, "data", "signet.db").replaceAll("'", "''");
		sourceDb.exec(`VACUUM INTO '${snapshot}'`);
		sourceDb.close();
		const cli = join(import.meta.dir, "..", "cli.ts");
		const result = spawnSync(
			process.execPath,
			[cli, "migration", "run", "--source", source, "--destination", destination],
			{
				cwd: join(import.meta.dir, "..", "..", "..", ".."),
				encoding: "utf8",
				env: {
					...process.env,
					HOME: home,
					XDG_CONFIG_HOME: config,
					XDG_STATE_HOME: state,
					SIGNET_PATH: source,
					SIGNET_DAEMON_ENTRYPOINT: "0",
				},
			},
		);
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ status: "completed", destination });
		const migrated = new Database(join(destination, "data", "signet.db"), { readonly: true });
		expect(migrated.query("SELECT value FROM proof").get()).toEqual({ value: "resume-ok" });
		migrated.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);
