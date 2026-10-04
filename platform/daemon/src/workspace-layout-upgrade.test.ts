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
			expect(runWorkspaceLayoutStartup(env, ["bun", "daemon.ts"])).toEqual({
				status: "skipped",
				reason: "another daemon holds the workspace lock",
			});
			expect(resolveWorkspaceLayout(root).version).toBe(1);
			if (lock) releaseSingleInstanceLock(lock);
			expect(runWorkspaceLayoutStartup(env, ["bun", "daemon.ts"])).toMatchObject({ status: "upgraded" });
			expect(resolveWorkspaceLayout(root).version).toBe(2);
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
