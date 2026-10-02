import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MigrationEngine } from "../lib/migration-engine";
import {
	createDefaultMigrationEngine,
	defaultMigrationDestination,
	initializeMigrationLeaseFile,
	migrationLeasePath,
	registerMigrationCommands,
	requestMigrationDrain,
	verifyDestinationDaemon,
} from "./migration";
import {
	Database as CoreDatabase,
	addObsidianSource,
	findSqliteVecExtension,
	loadSourcesConfig,
	resolveWorkspaceLayout,
} from "@signet/core";

function tryCreateSymlink(target: string, path: string, type?: "file" | "dir"): boolean {
	try {
		symlinkSync(target, path, type);
		return true;
	} catch (error) {
		if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return false;
		throw error;
	}
}

test("default migration keeps the configured workspace path", () => {
	const source = "C:\\Users\\alice\\.agents";
	expect(defaultMigrationDestination(source, win32)).toBe(source);
});

test("default migration refuses a different destination path", () => {
	const source = mkdtempSync(join(tmpdir(), "signet-migration-destination-"));
	try {
		expect(() => createDefaultMigrationEngine({ source, destination: `${source}-elsewhere` })).toThrow(
			"workspace layout migration upgrades in place",
		);
	} finally {
		rmSync(source, { recursive: true, force: true });
	}
});

test("default migration accepts a Windows path alias to the same directory", () => {
	if (process.platform !== "win32") return;
	const source = mkdtempSync(join(tmpdir(), "signet-migration-path-alias-"));
	const index = source.search(/[a-z]/i);
	if (index < 0) throw new Error("temporary directory path has no letter to case-fold");
	const letter = source[index] ?? "";
	const alias = `${source.slice(0, index)}${letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()}${source.slice(index + 1)}`;
	try {
		expect(statSync(source, { bigint: true }).ino).toBe(statSync(alias, { bigint: true }).ino);
		expect(() => createDefaultMigrationEngine({ source, destination: alias })).not.toThrow();
	} finally {
		rmSync(source, { recursive: true, force: true });
	}
});

test("run previews the in-place plan and cancellation leaves the workspace unchanged", async () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-confirm-"));
	const state = `${root}-state`;
	const logs: string[] = [];
	let confirmations = 0;
	const engine = new MigrationEngine({
		resolver: {
			resolve: () => ({ version: 1, root, destination: root }),
			current: async () => root,
		},
		writers: { drain: async () => ({ owners: [] }) },
		database: { prepare: async () => undefined },
		selectSourceEntries: async () => ({ entries: [], untouched: ["agent-training-data"] }),
		layoutBytes: () => Buffer.from('{"version":2}\\n'),
		journalStateDir: state,
	});
	const program = new Command();
	registerMigrationCommands(program, {
		createEngine: () => engine,
		confirm: async (message) => {
			confirmations++;
			expect(message).toBe("Apply this in-place workspace upgrade?");
			return false;
		},
		stdout: { log: (message) => logs.push(String(message)), error: () => undefined },
	});
	try {
		await program.parseAsync(["migration", "run", "--source", root], { from: "user" });
		expect(confirmations).toBe(1);
		expect(logs.join("\\n")).toContain(`Workspace: ${root}`);
		expect(logs.join("\\n")).toContain("Entries left untouched: 1");
		expect(logs.join("\\n")).toContain("contents are not inspected or hashed");
		expect(logs.join("\\n")).toContain("Migration cancelled; no changes made.");
		expect(existsSync(join(root, "workspace-layout.json"))).toBe(false);
		expect(existsSync(state)).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(state, { recursive: true, force: true });
	}
});

test("run rejects a changed workspace after confirmation instead of migrating beyond the reviewed plan", async () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-stale-plan-"));
	const state = `${root}-state`;
	const managed = join(root, "memory", "imports", "proof.md");
	mkdirSync(dirname(managed), { recursive: true });
	writeFileSync(managed, "reviewed bytes");
	const engine = new MigrationEngine({
		resolver: { resolve: () => ({ version: 1, root, destination: root }) },
		writers: { drain: async () => ({ owners: [] }) },
		database: { prepare: async () => undefined },
		selectSourceEntries: async (source) => ({
			entries: [await source.inspectEntry("memory/imports/proof.md")],
			untouched: [],
		}),
		mapDestinationPath: () => "data/imports/proof.md",
		journalStateDir: state,
	});
	const program = new Command();
	registerMigrationCommands(program, {
		createEngine: () => engine,
		confirm: async () => {
			writeFileSync(managed, "changed after review");
			return true;
		},
	});
	try {
		await expect(program.parseAsync(["migration", "run", "--source", root], { from: "user" })).rejects.toThrow(
			"workspace changed since the migration plan; rerun preflight",
		);
		expect(existsSync(join(root, "data", "imports", "proof.md"))).toBe(false);
		expect(existsSync(join(root, "workspace-layout.json"))).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(state, { recursive: true, force: true });
	}
});

test("migration preflight stays at the workspace root and ignores unregistered trees", async () => {
	const source = mkdtempSync(join(tmpdir(), "signet-migration-scope-"));
	mkdirSync(join(source, "memory"), { recursive: true });
	const database = new Database(join(source, "memory", "memories.db"));
	database.close();
	const unrelated = join(source, "agent-training-data");
	mkdirSync(unrelated);
	writeFileSync(join(unrelated, "conversations.raw.jsonl"), "must remain outside migration scope");
	chmodSync(unrelated, 0);
	try {
		const plan = await createDefaultMigrationEngine({ source }).preflight();
		expect(plan.source).toBe(source);
		expect(plan.destination).toBe(source);
		expect(plan.untouched).toContain("agent-training-data");
		expect(plan.components.some((path) => path.startsWith("agent-training-data/"))).toBe(false);
	} finally {
		chmodSync(unrelated, 0o700);
		rmSync(source, { recursive: true, force: true });
	}
});

test("Windows migration lease stays a safe file beneath state and reuses an existing legacy lease", () => {
	const state = "C:\\Users\\alice\\AppData\\Local\\Signet\\migrations";
	const source = "C:\\Users\\alice\\.agents";
	const legacy = win32.join(state, `${win32.resolve(source).replace(/[\\/:]/g, "_")}.lease`);
	const lease = migrationLeasePath(state, source, { platform: "win32", pathApi: win32, exists: () => false });
	expect(win32.dirname(lease)).toBe(state);
	expect(win32.basename(lease)).toMatch(/^[a-f0-9]{32}\.lease$/);
	expect(
		migrationLeasePath(state, source, { platform: "win32", pathApi: win32, exists: (path) => path === legacy }),
	).toBe(legacy);
});

function runGit(root: string, ...args: string[]): string {
	const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr);
	return result.stdout;
}

function treeDigest(root: string, ignoreIndex = false): string {
	const hash = createHash("sha256");
	const visit = (relativePath: string) => {
		if (ignoreIndex && relativePath === "index") return;
		const path = join(root, relativePath);
		const stat = lstatSync(path);
		hash.update(
			JSON.stringify([
				relativePath,
				stat.mode & 0o7777,
				stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file",
			]),
		);
		if (stat.isDirectory()) {
			for (const child of readdirSync(path).sort()) visit(join(relativePath, child));
		} else if (stat.isSymbolicLink()) hash.update(readlinkSync(path));
		else hash.update(readFileSync(path));
	};
	visit("");
	return hash.digest("hex");
}

function writeDaemonConfig(root: string): void {
	writeFileSync(
		join(root, "agent.yaml"),
		[
			"version: 1",
			"configVersion: 9",
			"embedding:",
			"  provider: none",
			"auth:",
			"  mode: local",
			"capabilities:",
			"  identity:",
			"    mode: off",
			"memory:",
			"  pipelineV2:",
			"    enabled: false",
			"",
		].join("\n"),
	);
}

test("migration drain reports named daemon writer blockers", async () => {
	const source = join(tmpdir(), "workspace-being-migrated");
	const pid = 1234;
	const blockers = await requestMigrationDrain(
		"http://127.0.0.1:3850",
		async (input: string | URL | Request, init?: RequestInit) => {
			if (String(input).endsWith("/api/status")) return Response.json({ pid, agentsDir: source });
			expect(String(input)).toBe("http://127.0.0.1:3850/api/workspace/migration-control/drain");
			expect(init?.method).toBe("POST");
			expect(JSON.parse(String(init?.body))).toEqual({ expectedPid: pid, expectedWorkspace: source });
			return new Response(
				JSON.stringify({
					closed: false,
					blockers: [{ owner: "transcript-capture", active: 1, queued: 0 }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		},
		source,
		pid,
	);
	expect(blockers).toEqual(["transcript-capture"]);
});

test("migration does not drain a daemon serving another workspace", async () => {
	const requests: string[] = [];
	const source = join(tmpdir(), "workspace-being-migrated");
	const result = await requestMigrationDrain(
		"http://127.0.0.1:3850",
		async (input) => {
			requests.push(String(input));
			return Response.json({ pid: process.pid, agentsDir: join(tmpdir(), "unrelated-workspace") });
		},
		source,
	);
	expect(result).toBeNull();
	expect(requests).toEqual(["http://127.0.0.1:3850/api/status"]);
});

test("migration drains only a daemon with a matching workspace and managed PID", async () => {
	const requests: string[] = [];
	let drainBody: unknown;
	const source = join(tmpdir(), "workspace-being-migrated");
	const pid = 1234;
	const blockers = await requestMigrationDrain(
		"http://127.0.0.1:3850",
		async (input, init) => {
			requests.push(String(input));
			if (String(input).endsWith("/api/status")) return Response.json({ pid, agentsDir: source });
			drainBody = JSON.parse(String(init?.body));
			return Response.json({ closed: true, blockers: [] });
		},
		source,
		pid,
	);
	expect(blockers).toEqual([]);
	expect(drainBody).toEqual({ expectedPid: pid, expectedWorkspace: source });
	expect(requests).toEqual([
		"http://127.0.0.1:3850/api/status",
		"http://127.0.0.1:3850/api/workspace/migration-control/drain",
	]);
});

test("migration refuses to drain a replacement daemon with a different PID", async () => {
	const requests: string[] = [];
	const source = join(tmpdir(), "workspace-being-migrated");
	const blockers = await requestMigrationDrain(
		"http://127.0.0.1:3850",
		async (input) => {
			requests.push(String(input));
			return Response.json({ pid: 5678, agentsDir: source });
		},
		source,
		1234,
	);
	expect(blockers).toEqual(["daemon:pid-unverified"]);
	expect(requests).toEqual(["http://127.0.0.1:3850/api/status"]);
});

test("migration withholds drain when a daemon PID is not independently managed", async () => {
	const requests: string[] = [];
	const source = join(tmpdir(), "workspace-being-migrated");
	const blockers = await requestMigrationDrain(
		"http://127.0.0.1:3850",
		async (input) => {
			requests.push(String(input));
			return Response.json({ pid: 1234, agentsDir: source });
		},
		source,
		null,
	);
	expect(blockers).toEqual(["daemon:pid-unverified"]);
	expect(requests).toEqual(["http://127.0.0.1:3850/api/status"]);
});

test("destination verification requires readiness rather than liveness", async () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-readiness-"));
	const child = `
+const server = Bun.serve({
+  hostname: process.env.SIGNET_HOST,
+  port: Number(process.env.SIGNET_PORT),
+  fetch(request) {
+    const path = new URL(request.url).pathname;
+    if (path === "/health/live") return Response.json({ status: "alive" });
+    if (path === "/api/status") return Response.json({ status: "ok" });
+    if (path === "/health/ready") return Response.json({ status: "not_ready", reasons: ["blocked"] }, { status: 503 });
+    return new Response("missing", { status: 404 });
+  },
+});
+process.on("SIGTERM", () => { server.stop(true); process.exit(0); });
+process.on("message", message => {
+  if (message && message.type === "migration-verification-shutdown") { server.stop(true); process.exit(0); }
+});
+`.replace(/^\+/gm, "");
	try {
		await expect(
			verifyDestinationDaemon(root, {
				launchCommand: [process.execPath, "-e", child],
				readinessTimeoutMs: 500,
			}),
		).rejects.toThrow("blocked");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("production CLI registers layout migration under workspace and preserves the legacy alias", () => {
	const cli = join(import.meta.dir, "..", "cli.ts");
	const cwd = join(import.meta.dir, "..", "..", "..", "..");
	const env = { ...process.env, SIGNET_DAEMON_ENTRYPOINT: "0" };
	const commands = [
		{
			args: ["workspace", "layout", "migrate", "--help"],
			description: "Manage the v1 to v2 workspace migration",
		},
		{
			args: ["migration", "--help"],
			description: "Compatibility alias for workspace layout migration",
		},
	] as const;
	for (const command of commands) {
		const result = spawnSync(process.execPath, [cli, ...command.args], { cwd, encoding: "utf8", env });
		expect(result.status).toBe(0);
		expect(result.stdout).toContain(command.description);
		for (const subcommand of ["preflight", "run", "resume", "status", "rollback", "cleanup"])
			expect(result.stdout).toContain(subcommand);
	}
});

test("migration refuses an ambiguous legacy lease instead of racing an older writer", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-legacy-lease-"));
	const commandsDir = dirname(fileURLToPath(import.meta.url));
	const source = join(root, "v1");
	const destination = source;
	const state = join(root, "state");
	const leaseDir = join(state, "signet", "migrations");
	mkdirSync(join(source, "memory"), { recursive: true });
	new Database(join(source, "memory", "memories.db")).close();
	mkdirSync(leaseDir, { recursive: true });
	writeDaemonConfig(source);
	writeFileSync(join(leaseDir, `${source.replace(/[\\/:]/g, "_")}.lease`), "");
	try {
		const result = spawnSync(
			process.execPath,
			[
				join(commandsDir, "..", "cli.ts"),
				"migration",
				"run",
				"--source",
				source,
				"--destination",
				destination,
				"--yes",
			],
			{
				cwd: join(commandsDir, "..", "..", "..", ".."),
				encoding: "utf8",
				timeout: 5_000,
				env: {
					...process.env,
					HOME: join(root, "home"),
					XDG_CONFIG_HOME: join(root, "config"),
					XDG_STATE_HOME: state,
					SIGNET_PATH: source,
					SIGNET_WORKSPACE: "",
					SIGNET_DAEMON_ENTRYPOINT: "0",
					SIGNET_DAEMON_URL: "http://127.0.0.1:1",
				},
			},
		);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("legacy migration lease");
		expect(existsSync(join(source, "data", "signet.db"))).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("migration publishes only initialized SQLite lease files and leaves interrupted staging private", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-lease-publish-"));
	const lease = join(root, "migration.lease");
	const interruptedStage = join(root, "migration.lease.init-interrupted");
	writeFileSync(interruptedStage, "");
	try {
		initializeMigrationLeaseFile(lease);
		const db = new Database(lease, { readonly: true });
		try {
			expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(1);
		} finally {
			db.close(true);
		}
		if (process.platform !== "win32") expect(statSync(lease).mode & 0o777).toBe(0o600);
		expect(readdirSync(root).sort()).toEqual(["migration.lease", "migration.lease.init-interrupted"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("migration leaves an active lease owner in control", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-active-lease-"));
	const commandsDir = dirname(fileURLToPath(import.meta.url));
	const source = join(root, "v1");
	const destination = source;
	const state = join(root, "state");
	const leaseDir = join(state, "signet", "migrations");
	mkdirSync(join(source, "memory"), { recursive: true });
	new Database(join(source, "memory", "memories.db")).close();
	mkdirSync(leaseDir, { recursive: true });
	writeDaemonConfig(source);
	const owner = new Database(join(leaseDir, `${source.replace(/[\\/:]/g, "_")}.lease`));
	owner.exec("PRAGMA user_version = 1");
	owner.exec("BEGIN IMMEDIATE");
	try {
		const result = spawnSync(
			process.execPath,
			[
				join(commandsDir, "..", "cli.ts"),
				"migration",
				"run",
				"--source",
				source,
				"--destination",
				destination,
				"--yes",
			],
			{
				cwd: join(commandsDir, "..", "..", "..", ".."),
				encoding: "utf8",
				timeout: 5_000,
				env: {
					...process.env,
					HOME: join(root, "home"),
					XDG_CONFIG_HOME: join(root, "config"),
					XDG_STATE_HOME: state,
					SIGNET_PATH: source,
					SIGNET_WORKSPACE: "",
					SIGNET_DAEMON_ENTRYPOINT: "0",
					SIGNET_DAEMON_URL: "http://127.0.0.1:1",
				},
			},
		);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("another migration is already running");
		expect(existsSync(join(source, "data", "signet.db"))).toBe(false);
	} finally {
		owner.exec("ROLLBACK");
		owner.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("packaged desktop migration runner upgrades in place and leaves arbitrary files untouched", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-cli-"));
	const source = join(root, "v1");
	const destination = source;
	const home = join(root, "home");
	const config = join(root, "config");
	const state = join(root, "state");
	mkdirSync(join(source, "memory"), { recursive: true });
	mkdirSync(home, { recursive: true });
	writeDaemonConfig(source);
	const arbitraryFiles = Array.from({ length: 24 }, (_, index) => {
		const bucket = index % 4;
		const sourcePath =
			bucket === 0
				? `loose note ${index}.txt`
				: bucket === 1
					? `.personal-notes/nested/field ${index}.md`
					: bucket === 2
						? `memory/misc/${index}/opaque file.bin`
						: `files/old attachments/${index}.dat`;
		const destinationPath = bucket === 2 ? `data/legacy-memory/misc/${index}/opaque file.bin` : sourcePath;
		const contents = Buffer.from(`user-authored payload ${index}\0with arbitrary bytes`);
		mkdirSync(dirname(join(source, sourcePath)), { recursive: true });
		writeFileSync(join(source, sourcePath), contents);
		return { sourcePath, destinationPath, contents };
	});
	tryCreateSymlink("loose note 0.txt", join(source, "CLAUDE.md"));
	try {
		const sourceDb = new Database(join(source, "memory", "memories.db"), { create: true });
		sourceDb.exec(
			'PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE proof (value TEXT NOT NULL); INSERT INTO proof VALUES ("workspace-v2-ok")',
		);
		expect(existsSync(`${join(source, "memory", "memories.db")}-wal`)).toBe(true);
		const databaseBefore = readFileSync(join(source, "memory", "memories.db"));
		const walBefore = readFileSync(join(source, "memory", "memories.db-wal"));
		const cli = join(import.meta.dir, "..", "cli.ts");
		const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
		const runnerSource = join(repoRoot, "surfaces", "desktop", "scripts", "workspace-migration-runner.ts");
		const runner = join(root, "workspace-migration-runner.js");
		const buildRunner = spawnSync(
			process.execPath,
			["build", runnerSource, "--target=bun", "--outfile", runner, "--external", "better-sqlite3"],
			{ cwd: repoRoot, encoding: "utf8" },
		);
		expect(buildRunner.status, buildRunner.stderr).toBe(0);
		const preflight = spawnSync(
			process.execPath,
			[cli, "workspace", "layout", "migrate", "preflight", "--source", source, "--destination", destination],
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
		expect(preflight.status).toBe(0);
		expect(readFileSync(join(source, "memory", "memories.db"))).toEqual(databaseBefore);
		expect(readFileSync(join(source, "memory", "memories.db-wal"))).toEqual(walBefore);
		expect(existsSync(join(source, "data", "signet.db"))).toBe(false);
		const sqliteVecPath = findSqliteVecExtension();
		if (!sqliteVecPath) throw new Error("sqlite-vec extension is required by the desktop migration runner test");
		const workerOptions = {
			cwd: repoRoot,
			encoding: "utf8" as const,
			env: {
				...process.env,
				HOME: home,
				XDG_CONFIG_HOME: config,
				XDG_STATE_HOME: state,
				SIGNET_PATH: source,
				SIGNET_VEC_PATH: sqliteVecPath,
				SIGNET_WORKSPACE: "",
				SIGNET_DAEMON_URL: "http://127.0.0.1:1",
				SIGNET_DAEMON_RUNTIME: "bun-js",
				SIGNET_DAEMON_JS_PATH: join(repoRoot, "platform", "daemon", "dist", "daemon.js"),
				SIGNET_DAEMON_ENTRYPOINT: "0",
			},
		};
		const workerStatus = spawnSync(
			process.execPath,
			[runner, "status", "--source", source, "--destination", destination],
			workerOptions,
		);
		expect(workerStatus.status, workerStatus.stderr).toBe(0);
		expect(JSON.parse(workerStatus.stdout)).toMatchObject({ phase: "not-started", destinationWrites: false });
		expect(readFileSync(join(source, "memory", "memories.db"))).toEqual(databaseBefore);
		expect(readFileSync(join(source, "memory", "memories.db-wal"))).toEqual(walBefore);
		expect(existsSync(join(source, "data", "signet.db"))).toBe(false);
		const result = spawnSync(process.execPath, [runner, "run", "--source", source, "--destination", destination], {
			...workerOptions,
		});
		const sourceDatabaseAfter = readFileSync(join(source, "memory", "memories.db"));
		const sourceWalAfter = readFileSync(join(source, "memory", "memories.db-wal"));
		sourceDb.close(true);
		expect(sourceDatabaseAfter).toEqual(databaseBefore);
		expect(sourceWalAfter).toEqual(walBefore);
		expect(result.status, result.stderr.toString()).toBe(0);
		expect(result.stderr.toString()).toBe("");
		expect(JSON.parse(result.stdout)).toMatchObject({ status: "completed", destination });
		const layout = resolveWorkspaceLayout(destination);
		expect(layout.version).toBe(2);
		for (const file of arbitraryFiles) {
			if (file.sourcePath.startsWith("memory/misc/"))
				expect(existsSync(join(destination, file.destinationPath))).toBe(false);
			else expect(readFileSync(join(destination, file.destinationPath))).toEqual(file.contents);
			expect(readFileSync(join(source, file.sourcePath))).toEqual(file.contents);
		}
		const migrated = new Database(layout.database, { readonly: true });
		expect(migrated.query("SELECT value FROM proof").get()).toEqual({ value: "workspace-v2-ok" });
		migrated.close(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 60_000);

test("production CLI refuses an unregistered SQLite writer before destination writes", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-writer-fence-"));
	const source = join(root, "v1");
	const destination = source;
	const databasePath = join(source, "memory", "memories.db");
	mkdirSync(dirname(databasePath), { recursive: true });
	mkdirSync(join(root, "home"), { recursive: true });
	writeDaemonConfig(source);
	const writer = new Database(databasePath, { create: true });
	let transactionOpen = false;
	try {
		writer.exec(
			'PRAGMA journal_mode=WAL; CREATE TABLE proof (value TEXT NOT NULL); INSERT INTO proof VALUES ("committed")',
		);
		writer.exec("BEGIN IMMEDIATE");
		transactionOpen = true;
		const cli = join(import.meta.dir, "..", "cli.ts");
		const options = {
			cwd: join(import.meta.dir, "..", "..", "..", ".."),
			encoding: "utf8" as const,
			timeout: 30_000,
			env: {
				...process.env,
				HOME: join(root, "home"),
				XDG_CONFIG_HOME: join(root, "config"),
				XDG_STATE_HOME: join(root, "state"),
				SIGNET_PATH: source,
				SIGNET_DAEMON_ENTRYPOINT: "0",
			},
		};
		const blocked = spawnSync(
			process.execPath,
			[cli, "migration", "run", "--source", source, "--destination", destination, "--yes"],
			options,
		);
		expect(blocked.status).not.toBe(0);
		expect(blocked.stderr).toContain("source database has an active writer");
		expect(existsSync(join(source, "data", "signet.db"))).toBe(false);
		writer.exec("ROLLBACK");
		transactionOpen = false;
		const resumed = spawnSync(
			process.execPath,
			[cli, "migration", "resume", "--source", source, "--destination", destination],
			options,
		);
		expect(resumed.status, resumed.stderr).toBe(0);
		const migrated = new Database(join(destination, "data", "signet.db"), { readonly: true });
		try {
			expect(migrated.query("SELECT value FROM proof").get()).toEqual({ value: "committed" });
		} finally {
			migrated.close(true);
		}
	} finally {
		if (transactionOpen) writer.exec("ROLLBACK");
		writer.close(true);
		rmSync(root, { recursive: true, force: true });
	}
}, 60_000);

test("migration resumes copied-but-unreceipted bytes after a hard subprocess exit", async () => {
	const commandsDir = dirname(fileURLToPath(import.meta.url));
	const root = mkdtempSync(join(tmpdir(), "signet-migration-source-resume-"));
	const source = join(root, "v1");
	const destination = source;
	const vault = join(root, "vault");
	const home = join(root, "home");
	let interruptedTemporaryPath: string | undefined;
	mkdirSync(join(source, "memory"), { recursive: true });
	mkdirSync(vault);
	mkdirSync(home);
	writeDaemonConfig(source);
	mkdirSync(join(source, "memory", "imports"), { recursive: true });
	writeFileSync(join(source, "memory", "imports", "resume-proof.md"), "registered import bytes");
	const note = join(vault, "evidence.md");
	writeFileSync(note, "# Durable evidence\nThe source remains attributable.\n");
	writeFileSync(join(source, "user-note.md"), "Source-owned bytes stay unchanged.\n");
	try {
		const added = addObsidianSource(
			{ root: vault, name: "Migration acceptance", now: "2026-01-01T00:00:00.000Z" },
			source,
		);
		if (!added.ok) throw new Error(added.error);
		const original = loadSourcesConfig(source).sources.find((entry) => entry.id === added.source.id);
		expect(original).toBeDefined();
		expect(original?.generation).toMatch(/^[0-9a-f-]{36}$/i);
		const configBytes = readFileSync(join(source, "sources.json"));
		const dbPath = join(source, "memory", "memories.db");
		const db = new CoreDatabase(dbPath);
		await db.init();
		const memoryId = db.addMemory({
			type: "fact",
			content: "The source remains attributable.",
			confidence: 1,
			sourceId: original?.id,
			sourceType: "obsidian",
			sourcePath: note,
			tags: ["migration-acceptance"],
			updatedBy: "migration-fixture",
			vectorClock: {},
			manualOverride: false,
		});
		db.close();
		const cwd = join(commandsDir, "..", "..", "..", "..");
		const cli = join(cwd, "surfaces", "cli", "dist", "cli.js");
		const env = {
			...process.env,
			HOME: home,
			XDG_CONFIG_HOME: join(root, "config"),
			XDG_STATE_HOME: join(root, "state"),
			SIGNET_PATH: source,
			SIGNET_WORKSPACE: "",
			SIGNET_DAEMON_URL: "http://127.0.0.1:1",
			SIGNET_DAEMON_ENTRYPOINT: "0",
			SIGNET_DAEMON_RUNTIME: "bun-js",
			SIGNET_DAEMON_JS_PATH: join(cwd, "platform", "daemon", "dist", "daemon.js"),
		};
		const injectedRunner = [
			`import { Command } from ${JSON.stringify(pathToFileURL(join(commandsDir, "..", "..", "node_modules", "commander", "esm.mjs")).href)};`,
			`import { registerMigrationCommands } from ${JSON.stringify(pathToFileURL(join(commandsDir, "migration.ts")).href)};`,
			"const program = new Command();",
			"registerMigrationCommands(program, { hooks: { afterEntryPublish: async () => { process.exit(73); } } });",
			'await program.parseAsync(process.argv.slice(1), { from: "user" });',
		].join("\n");
		const interrupted = spawnSync(
			process.execPath,
			["-e", injectedRunner, "migration", "run", "--source", source, "--destination", destination, "--yes"],
			{ cwd, env, encoding: "utf8" },
		);
		expect(interrupted.status, interrupted.stderr).toBe(73);
		expect(existsSync(destination)).toBe(true);
		const status = spawnSync(
			process.execPath,
			[cli, "migration", "status", "--source", source, "--destination", destination],
			{
				cwd,
				env,
				encoding: "utf8",
			},
		);
		expect(status.status, status.stderr).toBe(0);
		const interruptedStatus = JSON.parse(status.stdout) as { journal?: string };
		expect(interruptedStatus).toMatchObject({ destinationWrites: true, rollbackEligible: true, copied: 0 });
		const journalPath = interruptedStatus.journal;
		if (journalPath === undefined) throw new Error("migration status omitted its journal path");
		const interruptedJournal = JSON.parse(readFileSync(journalPath, "utf8")) as {
			pendingCopy?: string;
			pendingCopyTemporaryPath?: string;
			fingerprints: { path: string; destinationPath?: string }[];
		};
		const temporaryPath = interruptedJournal.pendingCopyTemporaryPath;
		if (temporaryPath === undefined) throw new Error("migration journal omitted its pending temporary path");
		interruptedTemporaryPath = temporaryPath;
		expect(interruptedJournal.pendingCopy).toBeDefined();
		expect(existsSync(join(destination, temporaryPath))).toBe(true);
		const pendingCopy = interruptedJournal.pendingCopy;
		if (pendingCopy === undefined) throw new Error("migration journal omitted its pending copy");
		const pendingFingerprint = interruptedJournal.fingerprints.find((fingerprint) => fingerprint.path === pendingCopy);
		if (!pendingFingerprint) throw new Error(`missing pending fingerprint: ${pendingCopy}`);
		const pendingDestinationPath = pendingFingerprint.destinationPath ?? pendingFingerprint.path;
		expect(existsSync(join(destination, pendingDestinationPath))).toBe(true);
		expect(readFileSync(join(source, "sources.json"))).toEqual(configBytes);
		const resumed = spawnSync(
			process.execPath,
			[cli, "migration", "resume", "--source", source, "--destination", destination],
			{
				cwd,
				env,
				encoding: "utf8",
				timeout: 60_000,
			},
		);
		if (resumed.status !== 0) throw new Error(`migration resume failed: ${resumed.stderr.slice(-2000)}`);
		expect(JSON.parse(resumed.stdout)).toMatchObject({ status: "completed", destination });
		if (interruptedTemporaryPath === undefined) throw new Error("migration temporary path was not captured");
		expect(existsSync(join(destination, interruptedTemporaryPath))).toBe(false);
		const destinationSource = loadSourcesConfig(destination).sources.find((entry) => entry.id === original?.id);
		expect(destinationSource).toMatchObject(original ?? {});
		expect(readFileSync(join(source, "sources.json"))).toEqual(configBytes);
		expect(readFileSync(join(destination, "data", "imports", "resume-proof.md"), "utf8")).toBe(
			"registered import bytes",
		);
		expect(readFileSync(join(destination, "user-note.md"))).toEqual(readFileSync(join(source, "user-note.md")));
		const migrated = new Database(resolveWorkspaceLayout(destination).database, { readonly: true });
		expect(migrated.query("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
		expect(migrated.query("SELECT id, source_id, content FROM memories WHERE id = ?").get(memoryId)).toEqual({
			id: memoryId,
			source_id: original?.id,
			content: "The source remains attributable.",
		});
		migrated.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 90_000);

test("production migration rollback refuses an unreceipted in-place write and preserves recovery data", async () => {
	const commandsDir = dirname(fileURLToPath(import.meta.url));
	const root = mkdtempSync(join(tmpdir(), "signet-migration-source-rollback-"));
	const source = join(root, "v1");
	const destination = source;
	const vault = join(root, "vault");
	mkdirSync(join(source, "memory"), { recursive: true });
	mkdirSync(vault);
	mkdirSync(join(root, "home"));
	writeDaemonConfig(source);
	const note = join(vault, "evidence.md");
	writeFileSync(note, "User-owned source evidence\n");
	mkdirSync(join(source, "memory", "imports"), { recursive: true });
	writeFileSync(join(source, "memory", "imports", "rollback-proof.md"), "registered import bytes");
	try {
		const added = addObsidianSource({ root: vault, name: "Rollback acceptance" }, source);
		if (!added.ok) throw new Error(added.error);
		const original = loadSourcesConfig(source).sources.find((entry) => entry.id === added.source.id);
		expect(original).toBeDefined();
		const configBytes = readFileSync(join(source, "sources.json"));
		const noteBytes = readFileSync(note);
		const dbPath = join(source, "memory", "memories.db");
		const db = new CoreDatabase(dbPath);
		await db.init();
		db.addMemory({
			type: "fact",
			content: "User-owned source evidence",
			confidence: 1,
			sourceId: original?.id,
			sourceType: "obsidian",
			sourcePath: note,
			tags: [],
			updatedBy: "rollback-fixture",
			vectorClock: {},
			manualOverride: false,
		});
		db.close();
		const dbBytes = readFileSync(dbPath);
		const cwd = join(commandsDir, "..", "..", "..", "..");
		const cli = join(cwd, "surfaces", "cli", "dist", "cli.js");
		const env = {
			...process.env,
			HOME: join(root, "home"),
			XDG_CONFIG_HOME: join(root, "config"),
			XDG_STATE_HOME: join(root, "state"),
			SIGNET_PATH: source,
			SIGNET_WORKSPACE: "",
			SIGNET_DAEMON_URL: "http://127.0.0.1:1",
			SIGNET_DAEMON_ENTRYPOINT: "0",
		};
		const injectedRunner = [
			`import { Command } from ${JSON.stringify(pathToFileURL(join(commandsDir, "..", "..", "node_modules", "commander", "esm.mjs")).href)};`,
			`import { registerMigrationCommands } from ${JSON.stringify(pathToFileURL(join(commandsDir, "migration.ts")).href)};`,
			"const program = new Command();",
			"registerMigrationCommands(program, { hooks: { afterEntryPublish: async () => { process.exit(73); } } });",
			'await program.parseAsync(process.argv.slice(1), { from: "user" });',
		].join("\n");
		const interrupted = spawnSync(
			process.execPath,
			["-e", injectedRunner, "migration", "run", "--source", source, "--destination", destination, "--yes"],
			{ cwd, env, encoding: "utf8" },
		);
		expect(interrupted.status, interrupted.stderr).toBe(73);
		expect(existsSync(destination)).toBe(true);
		const interruptedStatus = spawnSync(
			process.execPath,
			[cli, "migration", "status", "--source", source, "--destination", destination],
			{ cwd, env, encoding: "utf8" },
		);
		expect(interruptedStatus.status, interruptedStatus.stderr).toBe(0);
		const statusBody = JSON.parse(interruptedStatus.stdout) as { journal?: string };
		const journalPath = statusBody.journal;
		if (journalPath === undefined) throw new Error("migration status omitted its journal path");
		const interruptedJournal = JSON.parse(readFileSync(journalPath, "utf8")) as {
			pendingCopy?: string;
			pendingCopyTemporaryPath?: string;
			fingerprints: { path: string; destinationPath?: string }[];
		};
		const temporaryPath = interruptedJournal.pendingCopyTemporaryPath;
		if (temporaryPath === undefined) throw new Error("migration journal omitted its pending temporary path");
		expect(interruptedJournal.pendingCopy).toBeDefined();
		expect(existsSync(join(destination, temporaryPath))).toBe(true);
		const pendingCopy = interruptedJournal.pendingCopy;
		if (pendingCopy === undefined) throw new Error("migration journal omitted its pending copy");
		const pendingFingerprint = interruptedJournal.fingerprints.find((fingerprint) => fingerprint.path === pendingCopy);
		if (!pendingFingerprint) throw new Error(`missing pending fingerprint: ${pendingCopy}`);
		const pendingDestinationPath = pendingFingerprint.destinationPath ?? pendingFingerprint.path;
		expect(existsSync(join(destination, pendingDestinationPath))).toBe(true);
		const rollback = spawnSync(
			process.execPath,
			[cli, "migration", "rollback", "--source", source, "--destination", destination],
			{ cwd, env, encoding: "utf8" },
		);
		expect(rollback.status).not.toBe(0);
		expect(rollback.stderr).toContain("in-place migration has an unreceipted write; resume it before rollback");
		expect(existsSync(join(source, "data", "signet.db"))).toBe(false);
		expect(readFileSync(join(source, "sources.json"))).toEqual(configBytes);
		expect(readFileSync(join(source, "memory", "imports", "rollback-proof.md"), "utf8")).toBe(
			"registered import bytes",
		);
		expect(loadSourcesConfig(source).sources.find((entry) => entry.id === original?.id)).toMatchObject(original ?? {});
		expect(readFileSync(note)).toEqual(noteBytes);
		expect(readFileSync(dbPath)).toEqual(dbBytes);
		const status = spawnSync(
			process.execPath,
			[cli, "migration", "status", "--source", source, "--destination", destination],
			{
				cwd,
				env,
				encoding: "utf8",
			},
		);
		expect(JSON.parse(status.stdout)).toMatchObject({ destinationWrites: true, rollbackEligible: true, copied: 0 });
		expect(existsSync(join(source, temporaryPath))).toBe(true);
		expect(readFileSync(dbPath)).toEqual(dbBytes);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 60_000);

test("production CLI maps default v1 components into canonical v2 ownership", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-components-"));
	const source = join(root, "v1");
	const destination = source;
	const home = join(root, "home");
	const config = join(root, "config");
	const state = join(root, "state");
	mkdirSync(join(source, "memory", "cache"), { recursive: true });
	mkdirSync(join(source, "memory", "imports"), { recursive: true });
	mkdirSync(join(source, "memory", "hermes-agent", "transcripts"), { recursive: true });
	mkdirSync(join(source, ".daemon"), { recursive: true });
	mkdirSync(join(source, "files"), { recursive: true });
	mkdirSync(home, { recursive: true });
	writeFileSync(join(source, "memory", "cache", "vectors.bin"), "cache");
	writeFileSync(join(source, "memory", "imports", "original.md"), "import");
	writeFileSync(join(source, "memory", "hermes-agent", "transcripts", "transcript.jsonl"), '{"role":"user"}\n');
	writeFileSync(join(source, "memory", "hermes-agent", "transcripts", "capture.state"), "checkpoint");
	writeFileSync(join(source, "memory", "legacy-note.md"), "legacy");
	writeFileSync(join(source, "memory", "session--transcript.md"), "---\nkind: transcript\n---\nUser: hello\n");
	writeFileSync(join(source, "memory", "session--manifest.md"), "---\nkind: manifest\n---\nlinks\n");
	writeFileSync(join(source, ".daemon", "lifecycle.json"), '{"state":"clean"}\n');
	writeFileSync(join(source, "files", "manual.md"), "manual");
	writeFileSync(join(source, "AGENTS.md"), "authored");
	writeDaemonConfig(source);
	new Database(join(source, "memory", "memories.db"), { create: true }).close();
	try {
		const cli = join(import.meta.dir, "..", "cli.ts");
		const result = spawnSync(
			process.execPath,
			[cli, "migration", "run", "--source", source, "--destination", destination, "--yes"],
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
		if (result.status !== 0) throw new Error(result.stderr);
		expect(existsSync(join(destination, "memory"))).toBe(true);
		expect(readFileSync(join(source, "memory", "cache", "vectors.bin"), "utf8")).toBe("cache");
		expect(existsSync(join(destination, "cache", "vectors.bin"))).toBe(false);
		expect(readFileSync(join(destination, "data", "imports", "original.md"), "utf8")).toBe("import");
		expect(readFileSync(join(destination, "transcripts", "hermes-agent", "transcript.jsonl"), "utf8")).toBe(
			'{"role":"user"}\n',
		);
		expect(readFileSync(join(destination, "transcripts", "hermes-agent", "capture.state"), "utf8")).toBe("checkpoint");
		expect(readFileSync(join(source, "memory", "legacy-note.md"), "utf8")).toBe("legacy");
		expect(existsSync(join(destination, "data", "legacy-memory", "legacy-note.md"))).toBe(false);
		expect(readFileSync(join(destination, "transcripts", "session--transcript.md"), "utf8")).toBe(
			"---\nkind: transcript\n---\nUser: hello\n",
		);
		expect(readFileSync(join(destination, "transcripts", "session--manifest.md"), "utf8")).toBe(
			"---\nkind: manifest\n---\nlinks\n",
		);
		expect(JSON.parse(readFileSync(join(destination, "runtime", "lifecycle.json"), "utf8"))).toMatchObject({
			state: "clean",
			exitCode: 0,
		});
		expect(readFileSync(join(destination, "files", "manual.md"), "utf8")).toBe("manual");
		expect(readFileSync(join(destination, "AGENTS.md"), "utf8")).toBe("authored");
		expect(resolveWorkspaceLayout(destination)).toMatchObject({
			version: 2,
			database: join(destination, "data", "signet.db"),
			transcripts: join(destination, "transcripts"),
			runtime: join(destination, "runtime"),
			cache: join(destination, "cache"),
			files: join(destination, "files"),
			imports: join(destination, "data", "imports"),
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);

test("preflight verifies an external absolute database without changing its bytes", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-external-preflight-"));
	const source = join(root, "v1");
	const destination = source;
	const external = join(root, "outside", "custom.db");
	mkdirSync(join(source, "memory"), { recursive: true });
	mkdirSync(dirname(external), { recursive: true });
	mkdirSync(join(root, "home"), { recursive: true });
	writeDaemonConfig(source);
	writeFileSync(
		join(source, "workspace-layout.json"),
		JSON.stringify({ version: 1, overrides: { database: external } }),
	);
	const db = new Database(external, { create: true });
	db.exec('CREATE TABLE proof (value TEXT NOT NULL); INSERT INTO proof VALUES ("authoritative")');
	db.close();
	const before = createHash("sha256").update(readFileSync(external)).digest("hex");
	try {
		const cli = join(import.meta.dir, "..", "cli.ts");
		const repositoryRoot = dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))));
		const result = spawnSync(
			process.execPath,
			[cli, "workspace", "layout", "migrate", "preflight", "--source", source, "--destination", destination],
			{
				cwd: repositoryRoot,
				encoding: "utf8",
				env: {
					...process.env,
					HOME: join(root, "home"),
					XDG_CONFIG_HOME: join(root, "config"),
					XDG_STATE_HOME: join(root, "state"),
					SIGNET_PATH: source,
				},
			},
		);
		expect(result.status, result.stderr).toBe(0);
		expect(createHash("sha256").update(readFileSync(external)).digest("hex")).toBe(before);
		expect(existsSync(join(source, "data", "signet.db"))).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);

test("external database writer cannot cross the migration cutover fence", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-external-writer-"));
	const source = join(root, "v1");
	const destination = source;
	const external = join(root, "external", "custom.db");
	mkdirSync(source, { recursive: true });
	mkdirSync(dirname(external), { recursive: true });
	mkdirSync(join(root, "home"), { recursive: true });
	writeDaemonConfig(source);
	writeFileSync(
		join(source, "workspace-layout.json"),
		JSON.stringify({ version: 1, overrides: { database: external } }),
	);
	const writer = new Database(external, { create: true });
	let transactionOpen = false;
	try {
		writer.exec(
			'PRAGMA journal_mode=WAL; CREATE TABLE proof (value TEXT NOT NULL); INSERT INTO proof VALUES ("external")',
		);
		const cli = join(import.meta.dir, "..", "cli.ts");
		const options = {
			cwd: join(import.meta.dir, "..", "..", "..", ".."),
			encoding: "utf8" as const,
			timeout: 15_000,
			env: {
				...process.env,
				HOME: join(root, "home"),
				XDG_CONFIG_HOME: join(root, "config"),
				XDG_STATE_HOME: join(root, "state"),
				SIGNET_PATH: source,
				SIGNET_DAEMON_ENTRYPOINT: "0",
			},
		};
		const preflight = spawnSync(
			process.execPath,
			[cli, "workspace", "layout", "migrate", "preflight", "--source", source, "--destination", destination],
			options,
		);
		expect(preflight.status, preflight.stderr).toBe(0);
		writer.exec("BEGIN IMMEDIATE");
		transactionOpen = true;
		const blocked = spawnSync(
			process.execPath,
			[cli, "migration", "run", "--source", source, "--destination", destination, "--yes"],
			options,
		);
		expect(blocked.status).not.toBe(0);
		expect(blocked.stderr).toContain("source database has an active writer");
		expect(existsSync(join(source, "data", "signet.db"))).toBe(false);
		writer.exec("ROLLBACK");
		transactionOpen = false;
		const resumed = spawnSync(
			process.execPath,
			[cli, "migration", "resume", "--source", source, "--destination", destination],
			options,
		);
		expect(resumed.status, resumed.stderr).toBe(0);
		expect(resolveWorkspaceLayout(destination).database).toBe(external);
		expect(writer.query("SELECT value FROM proof").get()).toEqual({ value: "external" });
	} finally {
		if (transactionOpen) writer.exec("ROLLBACK");
		writer.close();
		rmSync(root, { recursive: true, force: true });
	}
}, 60_000);

test("production migration rejects an external database replaced after writer fencing", async () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-fenced-replacement-"));
	const source = join(root, "v1");
	const destination = source;
	const external = join(root, "external", "custom.db");
	const replacement = join(root, "external", "replacement.db");
	mkdirSync(source, { recursive: true });
	mkdirSync(dirname(external), { recursive: true });
	mkdirSync(join(root, "home"), { recursive: true });
	writeDaemonConfig(source);
	writeFileSync(
		join(source, "workspace-layout.json"),
		JSON.stringify({ version: 1, overrides: { database: external } }),
	);
	for (const [path, value] of [
		[external, "original"],
		[replacement, "replacement"],
	] as const) {
		const database = new Database(path, { create: true });
		database.exec(`CREATE TABLE proof (value TEXT NOT NULL); INSERT INTO proof VALUES ('${value}')`);
		database.close();
	}
	const originalInode = lstatSync(external, { bigint: true }).ino;
	const envKeys = [
		"HOME",
		"XDG_CONFIG_HOME",
		"XDG_STATE_HOME",
		"SIGNET_PATH",
		"SIGNET_DAEMON_ENTRYPOINT",
		"SIGNET_DAEMON_RUNTIME",
		"SIGNET_DAEMON_JS_PATH",
	] as const;
	const previous = envKeys.map((key) => [key, process.env[key]] as const);
	const previousEntrypoint = process.argv[1];
	process.argv[1] = join(import.meta.dir, "..", "..", "..", "..", "platform", "daemon", "src", "daemon.ts");
	Object.assign(process.env, {
		HOME: join(root, "home"),
		XDG_CONFIG_HOME: join(root, "config"),
		XDG_STATE_HOME: join(root, "state"),
		SIGNET_PATH: source,
		SIGNET_DAEMON_ENTRYPOINT: "0",
		SIGNET_DAEMON_RUNTIME: "bun-js",
		SIGNET_DAEMON_JS_PATH: join(import.meta.dir, "..", "..", "..", "..", "platform", "daemon", "dist", "daemon.js"),
	});
	try {
		const program = new Command();
		registerMigrationCommands(program, {
			stdout: { log: () => undefined, error: () => undefined },
			hooks: {
				afterDatabaseFence: async () => {
					renameSync(external, `${external}.held`);
					renameSync(replacement, external);
				},
			},
		});
		const migration = program.parseAsync(
			["migration", "run", "--source", source, "--destination", destination, "--yes"],
			{ from: "user" },
		);
		if (process.platform === "win32") {
			let error: unknown;
			try {
				await migration;
			} catch (caught) {
				error = caught;
			}
			expect((error as NodeJS.ErrnoException | undefined)?.code).toMatch(/^(?:EBUSY|EPERM)$/);
			expect(lstatSync(external, { bigint: true }).ino).toBe(originalInode);
			expect(existsSync(`${external}.held`)).toBe(false);
		} else {
			await expect(migration).rejects.toThrow("external database identity changed during migration");
			expect(lstatSync(`${external}.held`, { bigint: true }).ino).toBe(originalInode);
		}
		expect(existsSync(join(source, "data", "signet.db"))).toBe(false);
	} finally {
		if (previousEntrypoint === undefined) process.argv.splice(1, 1);
		else process.argv[1] = previousEntrypoint;
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);

test("post-cutover verification fails closed when the external database reference disappears", async () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-external-disappears-"));
	const source = join(root, "v1");
	const destination = source;
	const external = join(root, "external", "custom.db");
	mkdirSync(source, { recursive: true });
	mkdirSync(dirname(external), { recursive: true });
	mkdirSync(join(root, "home"), { recursive: true });
	writeDaemonConfig(source);
	writeFileSync(
		join(source, "workspace-layout.json"),
		JSON.stringify({ version: 1, overrides: { database: external } }),
	);
	const db = new Database(external, { create: true });
	db.exec('CREATE TABLE proof (value TEXT NOT NULL); INSERT INTO proof VALUES ("external")');
	db.close();
	const envKeys = ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "SIGNET_PATH", "SIGNET_DAEMON_ENTRYPOINT"] as const;
	const previous = envKeys.map((key) => [key, process.env[key]] as const);
	const previousEntrypoint = process.argv[1];
	process.argv[1] = join(import.meta.dir, "..", "..", "..", "..", "platform", "daemon", "src", "daemon.ts");
	Object.assign(process.env, {
		HOME: join(root, "home"),
		XDG_CONFIG_HOME: join(root, "config"),
		XDG_STATE_HOME: join(root, "state"),
		SIGNET_PATH: source,
		SIGNET_DAEMON_ENTRYPOINT: "0",
	});
	try {
		const program = new Command();
		registerMigrationCommands(program, {
			stdout: { log: () => undefined, error: () => undefined },
			hooks: { afterPointerPublished: async () => renameSync(external, `${external}.held`) },
		});
		const migration = program.parseAsync(
			["migration", "run", "--source", source, "--destination", destination, "--yes"],
			{ from: "user" },
		);
		if (process.platform === "win32") {
			let error: unknown;
			try {
				await migration;
			} catch (caught) {
				error = caught;
			}
			expect((error as NodeJS.ErrnoException | undefined)?.code).toMatch(/^(?:EBUSY|EPERM)$/);
			expect(existsSync(external)).toBe(true);
			expect(existsSync(`${external}.held`)).toBe(false);
		} else {
			await expect(migration).rejects.toThrow("external database identity unavailable during migration");
			expect(existsSync(`${external}.held`)).toBe(true);
			expect(existsSync(external)).toBe(false);
		}
	} finally {
		if (previousEntrypoint === undefined) process.argv.splice(1, 1);
		else process.argv[1] = previousEntrypoint;
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);

test("production resume rejects a replaced but valid external database after pointer publication", async () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-external-replaced-"));
	const source = join(root, "v1");
	const destination = source;
	const external = join(root, "external", "custom.db");
	const replacement = join(root, "external", "replacement.db");
	mkdirSync(source, { recursive: true });
	mkdirSync(dirname(external), { recursive: true });
	mkdirSync(join(root, "home"), { recursive: true });
	writeDaemonConfig(source);
	writeFileSync(
		join(source, "workspace-layout.json"),
		JSON.stringify({ version: 1, overrides: { database: external } }),
	);
	for (const [path, value] of [
		[external, "original"],
		[replacement, "replacement"],
	] as const) {
		const database = new Database(path, { create: true });
		database.exec(`CREATE TABLE proof (value TEXT NOT NULL); INSERT INTO proof VALUES ('${value}')`);
		database.close();
	}
	const originalInode = lstatSync(external, { bigint: true }).ino;
	const envKeys = [
		"HOME",
		"XDG_CONFIG_HOME",
		"XDG_STATE_HOME",
		"SIGNET_PATH",
		"SIGNET_DAEMON_ENTRYPOINT",
		"SIGNET_DAEMON_RUNTIME",
		"SIGNET_DAEMON_JS_PATH",
	] as const;
	const previous = envKeys.map((key) => [key, process.env[key]] as const);
	Object.assign(process.env, {
		HOME: join(root, "home"),
		XDG_CONFIG_HOME: join(root, "config"),
		XDG_STATE_HOME: join(root, "state"),
		SIGNET_PATH: source,
		SIGNET_DAEMON_ENTRYPOINT: "0",
		SIGNET_DAEMON_RUNTIME: "bun-js",
		SIGNET_DAEMON_JS_PATH: join(import.meta.dir, "..", "..", "..", "..", "platform", "daemon", "dist", "daemon.js"),
	});
	try {
		const run = new Command();
		registerMigrationCommands(run, {
			stdout: { log: () => undefined, error: () => undefined },
			hooks: {
				afterPointerPublished: async () => {
					renameSync(replacement, external);
					throw new Error("interrupted after publication");
				},
			},
		});
		const attempt = run.parseAsync(["migration", "run", "--source", source, "--destination", destination, "--yes"], {
			from: "user",
		});
		const resume = new Command();
		registerMigrationCommands(resume, { stdout: { log: () => undefined, error: () => undefined } });
		if (process.platform === "win32") {
			let error: unknown;
			try {
				await attempt;
			} catch (caught) {
				error = caught;
			}
			expect((error as NodeJS.ErrnoException | undefined)?.code).toMatch(/^(?:EBUSY|EPERM)$/);
			expect(lstatSync(external, { bigint: true }).ino).toBe(originalInode);
			await resume.parseAsync(["migration", "resume", "--source", source, "--destination", destination], {
				from: "user",
			});
		} else {
			await expect(attempt).rejects.toThrow("interrupted after publication");
			expect(lstatSync(external, { bigint: true }).ino).not.toBe(originalInode);
			await expect(
				resume.parseAsync(["migration", "resume", "--source", source, "--destination", destination], { from: "user" }),
			).rejects.toThrow("external database identity changed");
		}
		const database = new Database(external, { readonly: true });
		try {
			expect(database.query("SELECT value FROM proof").get()).toEqual({
				value: process.platform === "win32" ? "original" : "replacement",
			});
		} finally {
			database.close(true);
		}
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);

test("production CLI preserves an external absolute database override as authoritative", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-external-db-"));
	const source = join(root, "v1");
	const destination = source;
	const external = join(root, "external", "custom.db");
	mkdirSync(join(source, "memory"), { recursive: true });
	mkdirSync(dirname(external), { recursive: true });
	mkdirSync(join(root, "home"), { recursive: true });
	writeDaemonConfig(source);
	writeFileSync(
		join(source, "workspace-layout.json"),
		JSON.stringify({ version: 1, overrides: { database: external } }),
	);
	const db = new Database(external, { create: true });
	db.exec('CREATE TABLE proof (value TEXT NOT NULL); INSERT INTO proof VALUES ("external-authority")');
	db.close();
	try {
		const cli = join(import.meta.dir, "..", "cli.ts");
		const child = spawnSync(
			process.execPath,
			[cli, "migration", "run", "--source", source, "--destination", destination, "--yes"],
			{
				cwd: join(import.meta.dir, "..", "..", "..", ".."),
				encoding: "utf8",
				env: {
					...process.env,
					HOME: join(root, "home"),
					XDG_CONFIG_HOME: join(root, "config"),
					XDG_STATE_HOME: join(root, "state"),
					SIGNET_PATH: source,
					SIGNET_DAEMON_ENTRYPOINT: "0",
				},
			},
		);
		expect(child.status, child.stderr).toBe(0);
		expect(resolveWorkspaceLayout(destination).database).toBe(external);
		expect(JSON.parse(readFileSync(join(destination, "workspace-layout.json"), "utf8"))).toMatchObject({
			overrides: { database: external },
		});
		const check = new Database(external, { readonly: true });
		expect(check.query("SELECT value FROM proof").get()).toEqual({ value: "external-authority" });
		check.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);

test("production CLI preserves explicit local component overrides during v2 migration", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-overrides-"));
	const source = join(root, "v1");
	const destination = source;
	const home = join(root, "home");
	const config = join(root, "config");
	const state = join(root, "state");
	mkdirSync(join(source, "custom", "cache"), { recursive: true });
	mkdirSync(join(source, "custom", "imports"), { recursive: true });
	mkdirSync(join(source, "custom", "runtime"), { recursive: true });
	mkdirSync(join(source, "custom", "transcripts"), { recursive: true });
	mkdirSync(join(source, ".daemon"), { recursive: true });
	mkdirSync(join(source, "memory", "imports"), { recursive: true });
	mkdirSync(join(source, "memory", "hermes-agent", "transcripts"), { recursive: true });
	mkdirSync(home, { recursive: true });
	writeFileSync(join(source, "custom", "cache", "index.bin"), "custom-cache");
	writeFileSync(join(source, "custom", "imports", "retained.md"), "custom-import");
	writeFileSync(join(source, "custom", "runtime", "sentinel.txt"), "custom-runtime");
	writeFileSync(join(source, "custom", "transcripts", "events.jsonl"), '{"custom":true}\n');
	writeFileSync(join(source, ".daemon", "lifecycle.json"), '{"state":"legacy"}');
	writeFileSync(join(source, "memory", "imports", "legacy.md"), "legacy-import");
	writeFileSync(join(source, "memory", "hermes-agent", "transcripts", "legacy.jsonl"), '{"legacy":true}\n');
	writeDaemonConfig(source);
	writeFileSync(
		join(source, "workspace-layout.json"),
		JSON.stringify({
			version: 1,
			overrides: {
				database: "custom/custom.db",
				cache: "custom/cache",
				imports: "custom/imports",
				runtime: "custom/runtime",
				transcripts: "custom/transcripts",
			},
		}),
	);
	const sourceDb = new Database(join(source, "custom", "custom.db"), { create: true });
	sourceDb.exec('CREATE TABLE proof (value TEXT NOT NULL); INSERT INTO proof VALUES ("custom-db")');
	sourceDb.close();
	try {
		const cli = join(import.meta.dir, "..", "cli.ts");
		const result = spawnSync(
			process.execPath,
			[cli, "migration", "run", "--source", source, "--destination", destination, "--yes"],
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
		if (result.status !== 0) throw new Error(result.stderr);
		const layout = resolveWorkspaceLayout(destination);
		expect(layout).toMatchObject({
			version: 2,
			database: join(destination, "custom", "custom.db"),
			cache: join(destination, "custom", "cache"),
			transcripts: join(destination, "custom", "transcripts"),
		});
		expect(readFileSync(join(layout.cache, "index.bin"), "utf8")).toBe("custom-cache");
		expect(readFileSync(join(layout.imports, "retained.md"), "utf8")).toBe("custom-import");
		expect(readFileSync(join(layout.runtime, "sentinel.txt"), "utf8")).toBe("custom-runtime");
		expect(readFileSync(join(layout.transcripts, "events.jsonl"), "utf8")).toBe('{"custom":true}\n');
		expect(readFileSync(join(source, ".daemon", "lifecycle.json"), "utf8")).toBe('{"state":"legacy"}');
		expect(readFileSync(join(source, "memory", "imports", "legacy.md"), "utf8")).toBe("legacy-import");
		expect(readFileSync(join(source, "memory", "hermes-agent", "transcripts", "legacy.jsonl"), "utf8")).toBe(
			'{"legacy":true}\n',
		);
		expect(existsSync(join(source, "runtime", "lifecycle.json"))).toBe(false);
		expect(existsSync(join(source, "data", "imports", "legacy.md"))).toBe(false);
		expect(existsSync(join(source, "transcripts", "hermes-agent", "legacy.jsonl"))).toBe(false);
		const migrated = new Database(layout.database, { readonly: true });
		expect(migrated.query("SELECT value FROM proof").get()).toEqual({ value: "custom-db" });
		migrated.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);

test("production CLI preserves root and nested Git state without mutating the source repository", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-git-"));
	const source = join(root, "old");
	const destination = source;
	const config = join(root, "config");
	const state = join(root, "state");
	mkdirSync(source, { recursive: true });
	mkdirSync(join(source, "memory"), { recursive: true });
	new Database(join(source, "memory", "memories.db"), { create: true }).close();
	writeDaemonConfig(source);
	runGit(source, "init", "-b", "main");
	runGit(source, "config", "user.name", "Migration Test");
	runGit(source, "config", "user.email", "migration@example.test");
	runGit(source, "remote", "add", "origin", "https://example.test/workspace.git");
	writeFileSync(join(source, "tracked.txt"), "base\n");
	writeFileSync(join(source, "staged.txt"), "base\n");
	runGit(source, "add", "tracked.txt", "staged.txt");
	runGit(source, "commit", "-m", "base");
	writeFileSync(join(source, "tracked.txt"), "unstaged\n");
	writeFileSync(join(source, "staged.txt"), "staged\n");
	runGit(source, "add", "staged.txt");
	writeFileSync(join(source, "untracked.txt"), "untracked\n");
	mkdirSync(join(source, ".git", "hooks"), { recursive: true });
	writeFileSync(join(source, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	const nested = join(source, "skills", "demo");
	mkdirSync(nested, { recursive: true });
	runGit(nested, "init", "-b", "main");
	runGit(nested, "config", "user.name", "Migration Test");
	runGit(nested, "config", "user.email", "migration@example.test");
	writeFileSync(join(nested, "skill.md"), "nested\n");
	runGit(nested, "add", "skill.md");
	runGit(nested, "commit", "-m", "nested");
	const sourceStatus = runGit(source, "status", "--porcelain=v1");
	const nestedStatus = runGit(nested, "status", "--porcelain=v1");
	const sourceHead = runGit(source, "rev-parse", "HEAD").trim();
	const nestedHead = runGit(nested, "rev-parse", "HEAD").trim();
	const sourceGitDigest = treeDigest(join(source, ".git"));
	const nestedGitDigest = treeDigest(join(nested, ".git"));
	try {
		const result = Bun.spawnSync(
			[
				process.execPath,
				join(import.meta.dir, "..", "cli.ts"),
				"migration",
				"run",
				"--source",
				source,
				"--destination",
				destination,
				"--yes",
			],
			{
				env: {
					...process.env,
					SIGNET_PATH: source,
					SIGNET_DAEMON_ENTRYPOINT: "0",
					XDG_CONFIG_HOME: config,
					XDG_STATE_HOME: state,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
		const destinationNested = join(destination, "skills", "demo");
		expect(treeDigest(join(source, ".git"))).toBe(sourceGitDigest);
		expect(treeDigest(join(nested, ".git"))).toBe(nestedGitDigest);
		expect(treeDigest(join(destination, ".git"), true)).toBe(treeDigest(join(source, ".git"), true));
		expect(treeDigest(join(destinationNested, ".git"))).toBe(nestedGitDigest);
		expect(runGit(destination, "rev-parse", "HEAD").trim()).toBe(sourceHead);
		expect(runGit(destinationNested, "rev-parse", "HEAD").trim()).toBe(nestedHead);
		expect(runGit(destination, "ls-files", "--stage")).toBe(runGit(source, "ls-files", "--stage"));
		expect(existsSync(join(destination, ".git", "objects", "info"))).toBe(true);
		expect(existsSync(join(destination, ".git", "objects", "pack"))).toBe(true);
		expect(existsSync(join(destination, ".git", "refs", "tags"))).toBe(true);
		expect(statSync(join(destination, ".git")).mode & 0o7777).toBe(statSync(join(source, ".git")).mode & 0o7777);
		expect(statSync(join(destinationNested, ".git")).mode & 0o7777).toBe(statSync(join(nested, ".git")).mode & 0o7777);
		expect(statSync(join(destination, ".git", "objects", "info")).mtimeMs).toBeCloseTo(
			statSync(join(source, ".git", "objects", "info")).mtimeMs,
			0,
		);
		expect(runGit(destination, "rev-parse", "HEAD").trim()).toBe(sourceHead);
		const destinationStatus = runGit(destination, "status", "--porcelain=v1");
		for (const line of sourceStatus
			.trim()
			.split("\n")
			.filter((entry) => entry !== "?? memory/" && entry !== "?? untracked.txt"))
			expect(destinationStatus.split("\n")).toContain(line);
		expect(readFileSync(join(destination, "untracked.txt"), "utf8")).toBe("untracked\n");
		expect(runGit(destination, "config", "--get", "remote.origin.url").trim()).toBe(
			"https://example.test/workspace.git",
		);
		expect(readFileSync(join(destination, ".git", "hooks", "pre-commit"), "utf8")).toBe("#!/bin/sh\nexit 0\n");
		expect(runGit(destinationNested, "rev-parse", "HEAD").trim()).toBe(nestedHead);
		expect(runGit(destinationNested, "status", "--porcelain=v1")).toBe(nestedStatus);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);

test("production CLI blocks cutover when the configured source database is missing", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-missing-db-"));
	const source = join(root, "v1");
	const destination = source;
	const home = join(root, "home");
	const config = join(root, "config");
	const state = join(root, "state");
	mkdirSync(source, { recursive: true });
	mkdirSync(home, { recursive: true });
	writeDaemonConfig(source);
	try {
		const cli = join(import.meta.dir, "..", "cli.ts");
		const preflight = spawnSync(
			process.execPath,
			[cli, "workspace", "layout", "migrate", "preflight", "--source", source, "--destination", destination],
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
		expect(preflight.status).not.toBe(0);
		expect(preflight.stderr).toContain("source database is missing");
		expect(existsSync(join(source, "data", "signet.db"))).toBe(false);
		const result = spawnSync(
			process.execPath,
			[cli, "migration", "run", "--source", source, "--destination", destination, "--yes"],
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
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("source database is missing");
		expect(existsSync(join(destination, "workspace-layout.json"))).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);

test("production CLI refuses an unowned pre-existing destination even when its database matches", async () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-snapshot-resume-"));
	const source = join(root, "v1");
	const destination = source;
	const home = join(root, "home");
	const config = join(root, "config");
	const state = join(root, "state");
	mkdirSync(join(source, "memory"), { recursive: true });
	mkdirSync(join(destination, "data"), { recursive: true });
	mkdirSync(home, { recursive: true });
	writeDaemonConfig(source);
	try {
		const sourceDb = new Database(join(source, "memory", "memories.db"), { create: true });
		sourceDb.exec('CREATE TABLE proof (value TEXT NOT NULL); INSERT INTO proof VALUES ("resume-ok")');
		sourceDb.close();
		const stagedSource = new DatabaseSync(join(source, "memory", "memories.db"), { readOnly: true });
		try {
			await backup(stagedSource, join(destination, "data", "signet.db"));
		} finally {
			stagedSource.close();
		}
		const cli = join(import.meta.dir, "..", "cli.ts");
		const result = spawnSync(
			process.execPath,
			[cli, "migration", "run", "--source", source, "--destination", destination, "--yes"],
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
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("unowned in-place database snapshot");
		const migrated = new Database(join(destination, "data", "signet.db"), { readonly: true });
		expect(migrated.query("SELECT value FROM proof").get()).toEqual({ value: "resume-ok" });
		migrated.close();
		expect(existsSync(join(destination, "workspace-layout.json"))).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);
