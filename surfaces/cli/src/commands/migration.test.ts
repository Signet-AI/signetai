import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestMigrationDrain, verifyDestinationDaemon } from "./migration";
import { resolveWorkspaceLayout } from "@signet/core";

function runGit(root: string, ...args: string[]): string {
	const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr);
	return result.stdout;
}

function treeDigest(root: string): string {
	const hash = createHash("sha256");
	const visit = (path: string, relativePath: string): void => {
		for (const name of readdirSync(path).sort()) {
			const absolute = join(path, name);
			const relative = join(relativePath, name);
			const stat = statSync(absolute);
			hash.update(relative);
			hash.update(`${stat.mode & 0o7777}:${stat.size}`);
			if (stat.isDirectory()) visit(absolute, relative);
			else hash.update(readFileSync(absolute));
		}
	};
	visit(root, "");
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
	const blockers = await requestMigrationDrain(
		"http://127.0.0.1:3850",
		async (input: string | URL | Request, init?: RequestInit) => {
			expect(String(input)).toBe("http://127.0.0.1:3850/api/workspace/migration-control/drain");
			expect(init?.method).toBe("POST");
			return new Response(
				JSON.stringify({
					closed: false,
					blockers: [{ owner: "transcript-capture", active: 1, queued: 0 }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		},
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
	const source = join(tmpdir(), "workspace-being-migrated");
	const pid = 1234;
	const blockers = await requestMigrationDrain(
		"http://127.0.0.1:3850",
		async (input) => {
			requests.push(String(input));
			return String(input).endsWith("/api/status")
				? Response.json({ pid, agentsDir: source })
				: Response.json({ closed: true, blockers: [] });
		},
		source,
		pid,
	);
	expect(blockers).toEqual([]);
	expect(requests).toEqual([
		"http://127.0.0.1:3850/api/status",
		"http://127.0.0.1:3850/api/workspace/migration-control/drain",
	]);
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
	writeDaemonConfig(source);
	try {
		const sourceDb = new Database(join(source, "memory", "memories.db"), { create: true });
		sourceDb.exec(
			'PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE proof (value TEXT NOT NULL); INSERT INTO proof VALUES ("workspace-v2-ok")',
		);
		expect(existsSync(`${join(source, "memory", "memories.db")}-wal`)).toBe(true);
		const databaseBefore = readFileSync(join(source, "memory", "memories.db"));
		const walBefore = readFileSync(join(source, "memory", "memories.db-wal"));
		const cli = join(import.meta.dir, "..", "cli.ts");
		const preflight = spawnSync(
			process.execPath,
			[cli, "migration", "preflight", "--source", source, "--destination", destination],
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
		expect(existsSync(destination)).toBe(false);
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
		sourceDb.close();
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
}, 60_000);

test("production CLI maps default v1 components into canonical v2 ownership", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-components-"));
	const source = join(root, "v1");
	const destination = join(root, "v2");
	const home = join(root, "home");
	const config = join(root, "config");
	const state = join(root, "state");
	mkdirSync(join(source, "memory", "cache"), { recursive: true });
	mkdirSync(join(source, "memory", "imports"), { recursive: true });
	mkdirSync(join(source, "memory", "hermes", "transcripts"), { recursive: true });
	mkdirSync(join(source, ".daemon"), { recursive: true });
	mkdirSync(join(source, "files"), { recursive: true });
	mkdirSync(home, { recursive: true });
	writeFileSync(join(source, "memory", "cache", "vectors.bin"), "cache");
	writeFileSync(join(source, "memory", "imports", "original.md"), "import");
	writeFileSync(join(source, "memory", "hermes", "transcripts", "transcript.jsonl"), '{"role":"user"}\n');
	writeFileSync(join(source, "memory", "hermes", "transcripts", "capture.state"), "checkpoint");
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
		if (result.status !== 0) throw new Error(result.stderr);
		expect(existsSync(join(destination, "memory"))).toBe(false);
		expect(readFileSync(join(destination, "cache", "vectors.bin"), "utf8")).toBe("cache");
		expect(readFileSync(join(destination, "data", "imports", "original.md"), "utf8")).toBe("import");
		expect(readFileSync(join(destination, "transcripts", "hermes", "transcript.jsonl"), "utf8")).toBe(
			'{"role":"user"}\n',
		);
		expect(readFileSync(join(destination, "transcripts", "hermes", "capture.state"), "utf8")).toBe("checkpoint");
		expect(readFileSync(join(destination, "data", "legacy-memory", "legacy-note.md"), "utf8")).toBe("legacy");
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

test("production CLI preserves explicit local component overrides during v2 migration", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-overrides-"));
	const source = join(root, "v1");
	const destination = join(root, "v2");
	const home = join(root, "home");
	const config = join(root, "config");
	const state = join(root, "state");
	mkdirSync(join(source, "custom", "cache"), { recursive: true });
	mkdirSync(join(source, "custom", "transcripts"), { recursive: true });
	mkdirSync(home, { recursive: true });
	writeFileSync(join(source, "custom", "cache", "index.bin"), "custom-cache");
	writeFileSync(join(source, "custom", "transcripts", "events.jsonl"), '{"custom":true}\n');
	writeDaemonConfig(source);
	writeFileSync(
		join(source, "workspace-layout.json"),
		JSON.stringify({
			version: 1,
			overrides: {
				database: "custom/custom.db",
				cache: "custom/cache",
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
		if (result.status !== 0) throw new Error(result.stderr);
		const layout = resolveWorkspaceLayout(destination);
		expect(layout).toMatchObject({
			version: 2,
			database: join(destination, "custom", "custom.db"),
			cache: join(destination, "custom", "cache"),
			transcripts: join(destination, "custom", "transcripts"),
		});
		expect(readFileSync(join(layout.cache, "index.bin"), "utf8")).toBe("custom-cache");
		expect(readFileSync(join(layout.transcripts, "events.jsonl"), "utf8")).toBe('{"custom":true}\n');
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
	const destination = join(root, "new");
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
			[process.execPath, join(import.meta.dir, "..", "cli.ts"), "migration", "run", "--destination", destination],
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
		const destinationNested = join(destination, "skills", "demo");
		expect(runGit(destinationNested, "rev-parse", "HEAD").trim()).toBe(nestedHead);
		expect(runGit(destinationNested, "status", "--porcelain=v1")).toBe(nestedStatus);
		expect(treeDigest(join(source, ".git"))).toBe(sourceGitDigest);
		expect(treeDigest(join(nested, ".git"))).toBe(nestedGitDigest);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("production CLI blocks cutover when the configured source database is missing", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-missing-db-"));
	const source = join(root, "v1");
	const destination = join(root, "v2");
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
			[cli, "migration", "preflight", "--source", source, "--destination", destination],
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
		expect(existsSync(destination)).toBe(false);
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
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("source database is missing");
		expect(existsSync(join(destination, "workspace-layout.json"))).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);

test("production CLI resumes when a matching descriptor snapshot exists before its journal update", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-migration-snapshot-resume-"));
	const source = join(root, "v1");
	const destination = join(root, "v2");
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
		copyFileSync(join(source, "memory", "memories.db"), join(destination, "data", "signet.db"));
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
		if (result.status !== 0) throw new Error(result.stderr);
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ status: "completed", destination });
		const migrated = new Database(join(destination, "data", "signet.db"), { readonly: true });
		expect(migrated.query("SELECT value FROM proof").get()).toEqual({ value: "resume-ok" });
		migrated.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);
