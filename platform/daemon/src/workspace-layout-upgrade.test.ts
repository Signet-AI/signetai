import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { persistWorkspaceLayout, resolveWorkspaceLayout } from "@signet/core";
import { acquireSingleInstanceLock, releaseSingleInstanceLock } from "./single-instance-lock";
import { runWorkspaceLayoutStartup } from "./workspace-layout-startup";
import {
	WORKSPACE_LAYOUT_UPGRADE_FILE,
	readWorkspaceLayoutStatus,
	readWorkspaceLayoutUpgradeRecord,
	upgradeWorkspaceLayout,
} from "./workspace-layout-upgrade";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
	const root = mkdtempSync(join(tmpdir(), "signet-layout-upgrade-"));
	roots.push(root);
	return root;
}

function write(root: string, path: string, content = path): void {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), content);
}

function tree(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			const stat = lstatSync(path);
			const rel = relative(root, path);
			if (rel === ".git" || rel === WORKSPACE_LAYOUT_UPGRADE_FILE) continue;
			out.push(`${rel}:${stat.isDirectory() ? "d" : stat.isSymbolicLink() ? "l" : "f"}:${stat.ino}`);
			if (stat.isDirectory()) walk(path);
		}
	};
	walk(root);
	return out;
}

const ARTIFACT = "2026-01-01T00-00-00Z--abc123--transcript.md";

function v1Workspace(): { root: string; databaseInode: number } {
	const root = workspace();
	for (const file of ["agent.yaml", "AGENTS.md", "SOUL.md", "skills/demo/SKILL.md", "files/inbox.txt", ".secrets/key"])
		write(root, file);
	write(root, "notes/unrelated.md");
	mkdirSync(join(root, "memory"), { recursive: true });
	const db = new Database(join(root, "memory", "memories.db"));
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT)");
	db.exec("INSERT INTO memories (content) VALUES ('kept')");
	db.close();
	write(root, "memory/claude-code/transcripts/transcript.jsonl", '{"role":"user"}\n');
	write(root, "memory/claude-code/notes.txt");
	write(root, `memory/${ARTIFACT}`);
	write(root, "memory/cache/embedding.bin");
	write(root, "memory/imports/original.pdf");
	write(root, "memory/MEMORY-backup.md");
	write(root, "memory/scripts/memory.py");
	write(root, ".daemon/logs/signet.log");
	write(root, ".daemon/pid", "123");
	return { root, databaseInode: statSync(join(root, "memory", "memories.db")).ino };
}

function git(root: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr);
	return result.stdout.trim();
}

describe("upgradeWorkspaceLayout", () => {
	it("renames v1 storage into the v2 layout under the same root", () => {
		const { root, databaseInode } = v1Workspace();
		git(root, ["init", "-q"]);
		git(root, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
		const head = git(root, ["rev-parse", "HEAD"]);

		const result = upgradeWorkspaceLayout(root);

		expect(result).toMatchObject({ status: "upgraded", resumed: false });
		const layout = resolveWorkspaceLayout(root);
		expect(layout.root).toBe(root);
		expect(layout.version).toBe(2);
		expect(layout.database).toBe(join(root, "data", "signet.db"));
		expect(statSync(layout.database).ino).toBe(databaseInode);
		const db = new Database(layout.database, { readonly: true });
		expect(db.query("SELECT content FROM memories").all()).toEqual([{ content: "kept" }]);
		db.close();
		expect(readFileSync(join(root, "transcripts/claude-code/transcript.jsonl"), "utf8")).toBe('{"role":"user"}\n');
		for (const path of [
			`transcripts/${ARTIFACT}`,
			"cache/embedding.bin",
			"data/imports/original.pdf",
			"data/legacy-memory/claude-code/notes.txt",
			"data/legacy-memory/MEMORY-backup.md",
			"data/legacy-memory/scripts/memory.py",
			"runtime/logs/signet.log",
			"runtime/pid",
			"agent.yaml",
			"AGENTS.md",
			"SOUL.md",
			"skills/demo/SKILL.md",
			"files/inbox.txt",
			".secrets/key",
			"notes/unrelated.md",
		])
			expect(existsSync(join(root, path))).toBe(true);
		expect(existsSync(join(root, "memory"))).toBe(false);
		expect(existsSync(join(root, ".daemon"))).toBe(false);
		expect(existsSync(join(root, "data/legacy-memory/claude-code/transcripts"))).toBe(false);
		expect(existsSync(join(root, WORKSPACE_LAYOUT_UPGRADE_FILE))).toBe(false);
		expect(git(root, ["rev-parse", "HEAD"])).toBe(head);
		expect(upgradeWorkspaceLayout(root)).toEqual({ status: "current" });
	});

	it("refuses to merge into an existing non-empty v2 directory and changes nothing", () => {
		const { root } = v1Workspace();
		write(root, "data/user-owned.txt");
		const before = tree(root);

		const result = upgradeWorkspaceLayout(root);

		expect(result).toEqual({ status: "blocked", reason: "data already exists and is not empty" });
		expect(tree(root)).toEqual(before);
		expect(resolveWorkspaceLayout(root).version).toBe(1);
		expect(readWorkspaceLayoutStatus(root, 1).upgrade).toMatchObject({
			state: "blocked",
			reason: "data already exists and is not empty",
		});

		rmSync(join(root, "data"), { recursive: true });
		expect(upgradeWorkspaceLayout(root)).toMatchObject({ status: "upgraded" });
		expect(readWorkspaceLayoutStatus(root, 2).upgrade).toBeNull();
	});

	it("reverses completed renames when a rename fails partway", () => {
		const { root } = v1Workspace();
		const before = tree(root);
		let calls = 0;
		const result = upgradeWorkspaceLayout(root, {
			rename: (from, to) => {
				calls += 1;
				if (calls === 4) throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
				renameSync(from, to);
			},
		});

		expect(result.status).toBe("blocked");
		expect(tree(root)).toEqual(before);
		expect(resolveWorkspaceLayout(root).version).toBe(1);
		expect(readWorkspaceLayoutUpgradeRecord(root)).toMatchObject({ state: "blocked" });
	});

	it("finishes an interrupted upgrade on the next start", () => {
		const { root, databaseInode } = v1Workspace();
		let calls = 0;
		const crash = (from: string, to: string): void => {
			calls += 1;
			if (calls > 3) throw new Error("process terminated");
			renameSync(from, to);
		};

		expect(() => upgradeWorkspaceLayout(root, { rename: crash })).toThrow("workspace layout upgrade could not finish");
		expect(readWorkspaceLayoutUpgradeRecord(root)).toMatchObject({ state: "in-progress" });
		expect(resolveWorkspaceLayout(root).version).toBe(1);

		const resumed = upgradeWorkspaceLayout(root);

		expect(resumed).toMatchObject({ status: "upgraded", resumed: true });
		expect(resolveWorkspaceLayout(root).version).toBe(2);
		expect(statSync(join(root, "data/signet.db")).ino).toBe(databaseInode);
		expect(existsSync(join(root, "memory"))).toBe(false);
		expect(existsSync(join(root, WORKSPACE_LAYOUT_UPGRADE_FILE))).toBe(false);
	});

	it("refuses to finish an interrupted upgrade when a moved item is missing from both paths", () => {
		const { root } = v1Workspace();
		let renames = 0;
		expect(() =>
			upgradeWorkspaceLayout(root, {
				rename: (from, to) => {
					renames += 1;
					if (renames > 1) throw new Error("process terminated");
					renameSync(from, to);
				},
			}),
		).toThrow("workspace layout upgrade could not finish");

		const record = readWorkspaceLayoutUpgradeRecord(root);
		expect(record?.state).toBe("in-progress");
		rmSync(join(root, "data/signet.db"));

		expect(() => upgradeWorkspaceLayout(root)).toThrow("workspace layout upgrade could not finish an interrupted run");
		expect(resolveWorkspaceLayout(root).version).toBe(1);
		expect(readWorkspaceLayoutUpgradeRecord(root)?.state).toBe("in-progress");
	});

	it("does not accept a replacement destination as a completed interrupted move", () => {
		const { root } = v1Workspace();
		let renames = 0;
		expect(() =>
			upgradeWorkspaceLayout(root, {
				rename: (from, to) => {
					renames += 1;
					if (renames > 1) throw new Error("process terminated");
					renameSync(from, to);
				},
			}),
		).toThrow("workspace layout upgrade could not finish");

		const destination = join(root, "data/signet.db");
		const replacementPath = join(root, "replacement.db");
		const replacement = new Database(replacementPath);
		replacement.exec("CREATE TABLE memories (content TEXT); INSERT INTO memories VALUES ('replacement')");
		replacement.close();
		rmSync(destination);
		renameSync(replacementPath, destination);

		expect(() => upgradeWorkspaceLayout(root)).toThrow(
			"moved item at data/signet.db does not match its recorded identity",
		);
		expect(resolveWorkspaceLayout(root).version).toBe(1);
		expect(readWorkspaceLayoutUpgradeRecord(root)?.state).toBe("in-progress");
		const db = new Database(destination, { readonly: true });
		expect(db.query("SELECT content FROM memories").get()).toEqual({ content: "replacement" });
		db.close();
	});

	it("rejects a replaced runtime destination when the launcher recreated .daemon", () => {
		const { root } = v1Workspace();
		crashAfterRuntimeRename(root);
		const runtime = join(root, "runtime");
		const original = join(root, "runtime-original");
		renameSync(runtime, original);
		mkdirSync(runtime);
		write(root, "runtime/replacement.txt");
		write(root, ".daemon/logs/launcher.txt");

		expect(() => upgradeWorkspaceLayout(root)).toThrow(/recorded identity/);
		expect(resolveWorkspaceLayout(root).version).toBe(1);
		expect(readWorkspaceLayoutUpgradeRecord(root)?.state).toBe("in-progress");
		expect(readFileSync(join(original, "pid"), "utf8")).toBe("123");
		expect(readFileSync(join(root, "runtime/replacement.txt"), "utf8")).toBe("runtime/replacement.txt");
		expect(readFileSync(join(root, ".daemon/logs/launcher.txt"), "utf8")).toBe(".daemon/logs/launcher.txt");
	});

	it("rejects legacy interrupted records when a moved item has no identity", () => {
		const { root } = v1Workspace();
		let renames = 0;
		expect(() =>
			upgradeWorkspaceLayout(root, {
				rename: (from, to) => {
					renames += 1;
					if (renames > 1) throw new Error("process terminated");
					renameSync(from, to);
				},
			}),
		).toThrow("workspace layout upgrade could not finish");
		const record = readWorkspaceLayoutUpgradeRecord(root);
		if (record?.state !== "in-progress") throw new Error("expected an in-progress upgrade record");
		writeFileSync(
			join(root, WORKSPACE_LAYOUT_UPGRADE_FILE),
			`${JSON.stringify({ ...record, moves: record.moves.map(({ from, to }) => ({ from, to })) }, null, 2)}\n`,
		);

		expect(() => upgradeWorkspaceLayout(root)).toThrow(/identity/);
		expect(resolveWorkspaceLayout(root).version).toBe(1);
		expect(readWorkspaceLayoutUpgradeRecord(root)?.state).toBe("in-progress");
	});

	it("rejects interrupted move identities without a stable birthtime", () => {
		const { root } = v1Workspace();
		let renames = 0;
		expect(() =>
			upgradeWorkspaceLayout(root, {
				rename: (from, to) => {
					renames += 1;
					if (renames > 1) throw new Error("process terminated");
					renameSync(from, to);
				},
			}),
		).toThrow("workspace layout upgrade could not finish");
		const record = readWorkspaceLayoutUpgradeRecord(root);
		if (record?.state !== "in-progress") throw new Error("expected an in-progress upgrade record");
		writeFileSync(
			join(root, WORKSPACE_LAYOUT_UPGRADE_FILE),
			`${JSON.stringify(
				{
					...record,
					moves: record.moves.map((move) => ({
						from: move.from,
						to: move.to,
						identity: move.identity && {
							device: move.identity.device,
							inode: move.identity.inode,
							kind: move.identity.kind,
						},
					})),
				},
				null,
				2,
			)}\n`,
		);

		expect(() => upgradeWorkspaceLayout(root)).toThrow(/durable identity/);
		expect(resolveWorkspaceLayout(root).version).toBe(1);
		expect(readWorkspaceLayoutUpgradeRecord(root)?.state).toBe("in-progress");
	});

	it("keeps custom paths and normalizes transcripts inside a custom transcript root", () => {
		const { root } = v1Workspace();
		const external = workspace();
		write(root, "custom-transcripts/codex/transcripts/transcript.jsonl", "{}\n");
		persistWorkspaceLayout(root, { version: 1, overrides: { transcripts: "custom-transcripts", cache: external } });

		expect(upgradeWorkspaceLayout(root)).toMatchObject({ status: "upgraded" });

		const layout = resolveWorkspaceLayout(root);
		expect(layout.version).toBe(2);
		expect(layout.transcripts).toBe(join(root, "custom-transcripts"));
		expect(layout.cache).toBe(external);
		expect(readFileSync(join(root, "custom-transcripts/codex/transcript.jsonl"), "utf8")).toBe("{}\n");
		expect(existsSync(join(root, "custom-transcripts/codex/transcripts"))).toBe(false);
		expect(existsSync(join(root, "data/legacy-memory/cache/embedding.bin"))).toBe(true);
	});

	it("refuses to move files through a symlinked v1 directory", () => {
		const { root } = v1Workspace();
		const elsewhere = workspace();
		renameSync(join(root, "memory"), join(elsewhere, "memory"));
		symlinkSync(join(elsewhere, "memory"), join(root, "memory"));
		const before = tree(root);

		const result = upgradeWorkspaceLayout(root);

		expect(result.status).toBe("blocked");
		expect(tree(root)).toEqual(before);
		expect(existsSync(join(elsewhere, "memory", "memories.db"))).toBe(true);
	});

	it("keeps WAL and journal files beside a custom database inside memory/", () => {
		const { root } = v1Workspace();
		const writer = new Database(join(root, "memory", "memories.db"));
		writer.exec("PRAGMA wal_autocheckpoint = 0");
		for (let i = 0; i < 20; i += 1) writer.exec(`INSERT INTO memories (content) VALUES ('wal-${i}')`);
		const walCopy = readFileSync(join(root, "memory", "memories.db-wal"));
		const dbCopy = readFileSync(join(root, "memory", "memories.db"));
		writer.close();
		writeFileSync(join(root, "memory", "memories.db"), dbCopy);
		writeFileSync(join(root, "memory", "memories.db-wal"), walCopy);
		persistWorkspaceLayout(root, { version: 1, overrides: { database: "memory/memories.db" } });

		expect(upgradeWorkspaceLayout(root)).toMatchObject({ status: "upgraded" });

		expect(resolveWorkspaceLayout(root).database).toBe(join(root, "memory", "memories.db"));
		expect(existsSync(join(root, "memory", "memories.db-wal"))).toBe(true);
		expect(existsSync(join(root, "data/legacy-memory/memories.db-wal"))).toBe(false);
		const db = new Database(join(root, "memory", "memories.db"), { readonly: true });
		expect(db.query("SELECT COUNT(*) AS count FROM memories").get()).toEqual({ count: 21 });
		db.close();
	});

	function crashAfterRuntimeRename(root: string): void {
		let terminated = false;
		expect(() =>
			upgradeWorkspaceLayout(root, {
				rename: (from, to) => {
					if (terminated) throw new Error("process terminated");
					renameSync(from, to);
					if (to === join(root, "runtime")) {
						terminated = true;
						throw new Error("process terminated");
					}
				},
			}),
		).toThrow("workspace layout upgrade could not finish");
	}

	it("finishes an interrupted run when a launcher recreated .daemon, keeping current files canonical", () => {
		const { root } = v1Workspace();
		crashAfterRuntimeRename(root);
		write(root, ".daemon/logs/startup.log", "this launch");
		write(root, ".daemon/logs/signet.log", "this launch");
		write(root, ".daemon/telemetry/events.jsonl", "{}\n");
		write(root, ".daemon/pid", "999");
		write(root, ".daemon/daemon.lock", "");

		expect(upgradeWorkspaceLayout(root)).toMatchObject({ status: "upgraded", resumed: true });

		expect(resolveWorkspaceLayout(root).version).toBe(2);
		expect(existsSync(join(root, ".daemon"))).toBe(false);
		expect(readFileSync(join(root, "runtime/pid"), "utf8")).toBe("999");
		expect(readFileSync(join(root, "runtime/logs/signet.log"), "utf8")).toBe("this launch");
		expect(readFileSync(join(root, "runtime/logs/startup.log"), "utf8")).toBe("this launch");
		expect(readFileSync(join(root, "runtime/telemetry/events.jsonl"), "utf8")).toBe("{}\n");
		const pidAside = readdirSync(join(root, "runtime")).find((name) => name.startsWith("pid.before-"));
		expect(pidAside && readFileSync(join(root, "runtime", pidAside), "utf8")).toBe("123");
		const logAside = readdirSync(join(root, "runtime/logs")).find((name) => name.startsWith("signet.log.before-"));
		expect(logAside && readFileSync(join(root, "runtime/logs", logAside), "utf8")).toBe(".daemon/logs/signet.log");
	});

	it("resumes through the startup gate after the database already moved", () => {
		const { root, databaseInode } = v1Workspace();
		let renames = 0;
		expect(() =>
			upgradeWorkspaceLayout(root, {
				rename: (from, to) => {
					renames += 1;
					if (renames > 1) throw new Error("process terminated");
					renameSync(from, to);
				},
			}),
		).toThrow("workspace layout upgrade could not finish");
		expect(existsSync(join(root, "memory/memories.db"))).toBe(false);
		const env = { ...process.env, SIGNET_PATH: root, SIGNET_DAEMON_ENTRYPOINT: "1" };
		const previous = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = root;
		try {
			expect(runWorkspaceLayoutStartup(env, ["bun", "daemon.ts"], 0)).toMatchObject({
				status: "upgraded",
				resumed: true,
			});
		} finally {
			if (previous === undefined) delete process.env.SIGNET_PATH;
			else process.env.SIGNET_PATH = previous;
		}
		expect(resolveWorkspaceLayout(root).version).toBe(2);
		expect(statSync(join(root, "data/signet.db")).ino).toBe(databaseInode);
	});

	it("reverses every rename when writing the layout fails", () => {
		const { root } = v1Workspace();
		write(root, "memory/codex/transcripts/transcript.jsonl", "{}\n");
		const before = tree(root);
		const result = upgradeWorkspaceLayout(root, {
			rename: (from, to) => {
				renameSync(from, to);
				if (to === join(root, "runtime")) mkdirSync(join(root, "workspace-layout.json"));
			},
		});
		rmSync(join(root, "workspace-layout.json"), { recursive: true, force: true });

		expect(result.status).toBe("blocked");
		expect(tree(root)).toEqual(before);
	});

	it("refuses a resumed record that lists a directory outside the workspace", () => {
		const { root } = v1Workspace();
		const outside = workspace();
		mkdirSync(join(outside, "empty"));
		writeFileSync(
			join(root, WORKSPACE_LAYOUT_UPGRADE_FILE),
			JSON.stringify({
				version: 1,
				state: "in-progress",
				startedAt: "2026-10-04T00:00:00.000Z",
				moves: [],
				createdDirectories: [],
				emptiedDirectories: [join(outside, "empty")],
			}),
		);

		expect(() => upgradeWorkspaceLayout(root)).toThrow("outside the workspace and its configured roots");
		expect(existsSync(join(outside, "empty"))).toBe(true);
	});

	it("reports a blocked upgrade, not a refusal, when a rename fails beside an empty v2 directory", () => {
		const { root } = v1Workspace();
		mkdirSync(join(root, "runtime"));
		mkdirSync(join(root, "cache"));
		const before = tree(root).filter((line) => !line.startsWith("runtime:") && !line.startsWith("cache:"));
		const result = upgradeWorkspaceLayout(root, {
			rename: () => {
				throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
			},
		});

		expect(result).toEqual({ status: "blocked", reason: "EACCES: permission denied" });
		expect(tree(root).filter((line) => !line.startsWith("runtime:") && !line.startsWith("cache:"))).toEqual(before);
		expect(resolveWorkspaceLayout(root).version).toBe(1);
	});

	it("refuses a resumed record that names a path outside the workspace", () => {
		const { root } = v1Workspace();
		const outside = workspace();
		write(outside, "victim.txt");
		writeFileSync(
			join(root, WORKSPACE_LAYOUT_UPGRADE_FILE),
			JSON.stringify({
				version: 1,
				state: "in-progress",
				startedAt: "2026-10-04T00:00:00.000Z",
				moves: [{ from: join(outside, "victim.txt"), to: join(outside, "moved.txt") }],
				createdDirectories: [],
				emptiedDirectories: [],
			}),
		);

		expect(() => upgradeWorkspaceLayout(root)).toThrow("outside the workspace and its configured roots");
		expect(existsSync(join(outside, "victim.txt"))).toBe(true);
		expect(resolveWorkspaceLayout(root).version).toBe(1);
	});

	it("normalizes transcripts inside an external transcript root", () => {
		const { root } = v1Workspace();
		const external = workspace();
		write(external, "codex/transcripts/transcript.jsonl", "{}\n");
		write(external, "podcast/transcripts/episode-01.txt", "user file");
		persistWorkspaceLayout(root, { version: 1, overrides: { transcripts: external } });

		expect(upgradeWorkspaceLayout(root)).toMatchObject({ status: "upgraded" });

		expect(readFileSync(join(external, "codex/transcript.jsonl"), "utf8")).toBe("{}\n");
		expect(existsSync(join(external, "codex/transcripts"))).toBe(false);
		expect(readFileSync(join(external, "podcast/transcripts/episode-01.txt"), "utf8")).toBe("user file");
	});

	it("accepts an empty pre-existing v2 directory", () => {
		const { root } = v1Workspace();
		mkdirSync(join(root, "runtime"));
		mkdirSync(join(root, "cache"));

		expect(upgradeWorkspaceLayout(root)).toMatchObject({ status: "upgraded" });
		expect(existsSync(join(root, "runtime/pid"))).toBe(true);
		expect(existsSync(join(root, "cache/embedding.bin"))).toBe(true);
	});

	it("upgrades through a symlinked workspace root", () => {
		const { root } = v1Workspace();
		const link = join(workspace(), "agents-link");
		symlinkSync(root, link);

		expect(upgradeWorkspaceLayout(link)).toMatchObject({ status: "upgraded" });
		expect(resolveWorkspaceLayout(root).version).toBe(2);
		expect(existsSync(join(root, "data/signet.db"))).toBe(true);
	});

	it("writes the v2 layout for a workspace with no v1 state", () => {
		const root = workspace();
		expect(upgradeWorkspaceLayout(root)).toEqual({ status: "upgraded", moved: 0, resumed: false });
		expect(resolveWorkspaceLayout(root).version).toBe(2);
	});
});

describe("runWorkspaceLayoutStartup", () => {
	it("does nothing outside the daemon process", () => {
		const { root } = v1Workspace();
		expect(runWorkspaceLayoutStartup({ SIGNET_PATH: root }, ["bun", "test.ts"])).toEqual({ status: "not-daemon" });
		expect(resolveWorkspaceLayout(root).version).toBe(1);
	});

	it("leaves the workspace alone while another daemon holds the instance lock", () => {
		const { root } = v1Workspace();
		const env = { ...process.env, SIGNET_PATH: root, SIGNET_DAEMON_ENTRYPOINT: "1" };
		const previous = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = root;
		const lock = acquireSingleInstanceLock(join(root, ".daemon", "daemon.lock"));
		try {
			expect(lock).not.toBeNull();
			expect(runWorkspaceLayoutStartup(env, ["bun", "daemon.ts"], 0)).toEqual({
				status: "skipped",
				reason: "another daemon holds the workspace lock",
			});
			expect(resolveWorkspaceLayout(root).version).toBe(1);
			if (lock) releaseSingleInstanceLock(lock);
			expect(runWorkspaceLayoutStartup(env, ["bun", "daemon.ts"], 0)).toMatchObject({ status: "upgraded" });
			expect(resolveWorkspaceLayout(root).version).toBe(2);
		} finally {
			if (lock) releaseSingleInstanceLock(lock);
			if (previous === undefined) delete process.env.SIGNET_PATH;
			else process.env.SIGNET_PATH = previous;
		}
	});

	it("does not wait for the instance lock when the workspace is already on layout v2", () => {
		const root = workspace();
		persistWorkspaceLayout(root, { version: 2 });
		const env = { ...process.env, SIGNET_PATH: root, SIGNET_DAEMON_ENTRYPOINT: "1" };
		const previous = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = root;
		write(root, "agent.yaml");
		write(root, "data/signet.db", "");
		const lock = acquireSingleInstanceLock(join(root, "runtime", "daemon.lock"));
		try {
			const started = performance.now();
			expect(runWorkspaceLayoutStartup(env, ["bun", "daemon.ts"], 10_000)).toEqual({ status: "current" });
			expect(performance.now() - started).toBeLessThan(1_000);
		} finally {
			if (lock) releaseSingleInstanceLock(lock);
			if (previous === undefined) delete process.env.SIGNET_PATH;
			else process.env.SIGNET_PATH = previous;
		}
	});

	it("does not remove a blocked upgrade record without the v2 instance lock", () => {
		const root = workspace();
		persistWorkspaceLayout(root, { version: 2 });
		const env = { ...process.env, SIGNET_PATH: root, SIGNET_DAEMON_ENTRYPOINT: "1" };
		const previous = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = root;
		write(root, "agent.yaml");
		write(root, "data/signet.db", "");
		write(
			root,
			WORKSPACE_LAYOUT_UPGRADE_FILE,
			JSON.stringify({
				version: 1,
				state: "blocked",
				reason: "operator recovery required",
				at: new Date().toISOString(),
			}),
		);
		const lock = acquireSingleInstanceLock(join(root, "runtime", "daemon.lock"));
		try {
			expect(lock).not.toBeNull();
			expect(runWorkspaceLayoutStartup(env, ["bun", "daemon.ts"], 0)).toEqual({
				status: "skipped",
				reason: "another daemon holds the workspace lock",
			});
			expect(readWorkspaceLayoutUpgradeRecord(root)?.state).toBe("blocked");
		} finally {
			if (lock) releaseSingleInstanceLock(lock);
			if (previous === undefined) delete process.env.SIGNET_PATH;
			else process.env.SIGNET_PATH = previous;
		}
	});

	it("loads before any daemon module that binds workspace paths", () => {
		const source = readFileSync(join(import.meta.dir, "daemon.ts"), "utf8");
		const firstImport = source.split("\n").find((line) => line.startsWith("import "));
		expect(firstImport).toBe('import { workspaceLayoutStartup } from "./workspace-layout-startup";');
	});
});
