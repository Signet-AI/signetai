/**
 * Tests for the DB accessor (singleton read/write transaction wrapper).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	closeDbAccessor,
	getDbAccessor,
	initDbAccessor,
	resolveCustomSqlitePath,
	resolveSqliteAgentsDir,
	resolveSqliteRuntimeConfig,
} from "./db-accessor";

function tmpDbPath(): string {
	const dir = join(tmpdir(), `signet-accessor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return join(dir, "test.db");
}

describe("DbAccessor", () => {
	const cleanupDirs: string[] = [];

	afterEach(() => {
		closeDbAccessor();
		for (const dir of cleanupDirs) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
		cleanupDirs.length = 0;
	});

	test("initializes without error", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));

		initDbAccessor(dbPath);
		const acc = getDbAccessor();
		expect(acc).toBeTruthy();
	});

	test("withWriteTx provides working write access", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		initDbAccessor(dbPath);
		const acc = getDbAccessor();

		acc.withWriteTx((db) => {
			db.exec("CREATE TABLE test_table (id INTEGER PRIMARY KEY, val TEXT)");
			db.prepare("INSERT INTO test_table (id, val) VALUES (?, ?)").run(1, "hello");
		});

		const result = acc.withReadDb((db) => {
			return db.prepare("SELECT val FROM test_table WHERE id = ?").get(1) as Record<string, unknown> | undefined;
		});
		expect(result).toBeTruthy();
		expect(result?.val).toBe("hello");
	});

	test("withReadDb provides working read access", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		initDbAccessor(dbPath);
		const acc = getDbAccessor();

		acc.withWriteTx((db) => {
			db.exec("CREATE TABLE read_test (id INTEGER PRIMARY KEY, name TEXT)");
			db.prepare("INSERT INTO read_test (id, name) VALUES (?, ?)").run(1, "alice");
			db.prepare("INSERT INTO read_test (id, name) VALUES (?, ?)").run(2, "bob");
		});

		const rows = acc.withReadDb((db) => {
			return db.prepare("SELECT name FROM read_test ORDER BY id").all() as Array<Record<string, unknown>>;
		});
		expect(rows).toHaveLength(2);
		expect(rows[0].name).toBe("alice");
		expect(rows[1].name).toBe("bob");
	});

	test("write transaction rolls back on error", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		initDbAccessor(dbPath);
		const acc = getDbAccessor();

		acc.withWriteTx((db) => {
			db.exec("CREATE TABLE rollback_test (id INTEGER PRIMARY KEY, val TEXT)");
			db.prepare("INSERT INTO rollback_test (id, val) VALUES (?, ?)").run(1, "original");
		});

		try {
			acc.withWriteTx((db) => {
				db.prepare("INSERT INTO rollback_test (id, val) VALUES (?, ?)").run(2, "should-rollback");
				throw new Error("intentional failure");
			});
		} catch {
			// expected
		}

		const rows = acc.withReadDb((db) => {
			return db.prepare("SELECT id FROM rollback_test ORDER BY id").all() as Array<Record<string, unknown>>;
		});
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe(1);
	});

	test("close works without error", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		initDbAccessor(dbPath);

		// Should not throw
		closeDbAccessor();
	});
});

describe("resolveCustomSqlitePath", () => {
	test("defaults workspace discovery to the home-scoped agents dir when SIGNET_PATH is unset", () => {
		const dir = resolveSqliteAgentsDir({
			env: {},
			home: () => "/tmp/home",
		});

		expect(dir).toBe("/tmp/home/.agents");
	});

	test("uses persisted workspace config when SIGNET_PATH is unset", () => {
		const root = join(tmpdir(), `signet-workspace-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cfgDir = join(root, "xdg", "signet");
		mkdirSync(cfgDir, { recursive: true });
		writeFileSync(
			join(cfgDir, "workspace.json"),
			JSON.stringify({
				version: 1,
				workspace: "/tmp/custom-workspace",
				updatedAt: new Date().toISOString(),
			}),
		);

		try {
			const dir = resolveSqliteAgentsDir({
				env: { XDG_CONFIG_HOME: join(root, "xdg") },
				home: () => "/tmp/home",
			});

			expect(dir).toBe("/tmp/custom-workspace");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("prefers explicit SIGNET_SQLITE_PATH on macOS", () => {
		const found = new Set([
			"/tmp/custom/libsqlite3.dylib",
			"/tmp/agents/libsqlite3.dylib",
			"/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
		]);
		const result = resolveCustomSqlitePath({
			platform: "darwin",
			agentsDir: "/tmp/agents",
			env: { SIGNET_SQLITE_PATH: "/tmp/custom/libsqlite3.dylib" },
			exists: (path) => found.has(path),
		});

		expect(result).toEqual({
			path: "/tmp/custom/libsqlite3.dylib",
			source: "env",
		});
	});

	test("does not fall back when explicit SIGNET_SQLITE_PATH is missing", () => {
		const found = new Set(["/tmp/agents/libsqlite3.dylib", "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib"]);
		const result = resolveCustomSqlitePath({
			platform: "darwin",
			agentsDir: "/tmp/agents",
			env: { SIGNET_SQLITE_PATH: "/tmp/missing/libsqlite3.dylib" },
			exists: (path) => found.has(path),
		});

		expect(result).toBeNull();
	});

	test("falls back to workspace sqlite dylib before Homebrew", () => {
		const found = new Set(["/tmp/agents/libsqlite3.dylib", "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib"]);
		const result = resolveCustomSqlitePath({
			platform: "darwin",
			agentsDir: "/tmp/agents",
			env: {},
			exists: (path) => found.has(path),
		});

		expect(result).toEqual({
			path: "/tmp/agents/libsqlite3.dylib",
			source: "workspace",
		});
	});

	test("falls back to Homebrew sqlite on macOS", () => {
		const found = new Set(["/usr/local/opt/sqlite/lib/libsqlite3.dylib"]);
		const result = resolveCustomSqlitePath({
			platform: "darwin",
			agentsDir: "/tmp/agents",
			env: {},
			exists: (path) => found.has(path),
		});

		expect(result).toEqual({
			path: "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
			source: "homebrew",
		});
	});

	test("returns null outside macOS", () => {
		const result = resolveCustomSqlitePath({
			platform: "linux",
			agentsDir: "/tmp/agents",
			env: { SIGNET_SQLITE_PATH: "/tmp/custom/libsqlite3.dylib" },
			exists: () => true,
		});

		expect(result).toBeNull();
	});

	test("falls back to Homebrew when workspace sqlite exists but fails activation", () => {
		const found = new Set(["/tmp/agents/libsqlite3.dylib", "/usr/local/opt/sqlite/lib/libsqlite3.dylib"]);
		const calls: string[] = [];
		const cfg = resolveSqliteRuntimeConfig({
			platform: "darwin",
			agentsDir: "/tmp/agents",
			env: {},
			exists: (path) => found.has(path),
			set: (path) => {
				calls.push(path);
				if (path === "/tmp/agents/libsqlite3.dylib") {
					throw new Error("wrong architecture");
				}
			},
		});

		expect(calls).toEqual(["/tmp/agents/libsqlite3.dylib", "/usr/local/opt/sqlite/lib/libsqlite3.dylib"]);
		expect(cfg).toEqual({
			choice: {
				path: "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
				source: "homebrew",
			},
			attempt: "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
			warning: null,
		});
	});

	test("uses the explicit agentsDir passed to init-time sqlite resolution", () => {
		const found = new Set(["/tmp/explicit/libsqlite3.dylib"]);
		const cfg = resolveSqliteRuntimeConfig({
			platform: "darwin",
			agentsDir: "/tmp/explicit",
			env: { SIGNET_PATH: "/tmp/env-workspace" },
			exists: (path) => found.has(path),
			set: () => {},
		});

		expect(cfg).toEqual({
			choice: {
				path: "/tmp/explicit/libsqlite3.dylib",
				source: "workspace",
			},
			attempt: "/tmp/explicit/libsqlite3.dylib",
			warning: null,
		});
	});
});

describe("sqlite runtime ordering", () => {
	test("keeps bun sqlite construction centralized in db-accessor", async () => {
		const hits: string[] = [];

		for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: import.meta.dir })) {
			if (file.endsWith(".test.ts") || file.endsWith(".bench.ts")) continue;

			const text = readFileSync(join(import.meta.dir, file), "utf8");
			if (text.includes("new Database(")) {
				hits.push(file);
			}
		}

		expect(hits).toEqual(["db-accessor.ts"]);
	});
});
