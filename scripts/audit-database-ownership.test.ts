import { describe, expect, test } from "bun:test";
import { auditDatabaseOwnership, isDatabaseOwnershipSource, type DatabaseSource } from "./audit-database-ownership";

function source(path: string, content: string): DatabaseSource {
	return { content, path };
}

describe("database ownership source scope", () => {
	test("includes runtime packages and excludes tests, generated output, and repository tooling", () => {
		expect(isDatabaseOwnershipSource("platform/daemon/src/new-route.ts")).toBe(true);
		expect(isDatabaseOwnershipSource("integrations/hermes-agent/connector/src/index.ts")).toBe(true);
		expect(isDatabaseOwnershipSource("memorybench/src/server/db/index.ts")).toBe(true);
		expect(isDatabaseOwnershipSource("platform/daemon/src/new-route.test.ts")).toBe(false);
		expect(isDatabaseOwnershipSource("tests/integration/run.ts")).toBe(false);
		expect(isDatabaseOwnershipSource("scripts/backfill.ts")).toBe(false);
		expect(isDatabaseOwnershipSource("dist/signetai/index.js")).toBe(false);
	});
});

describe("database owner audit", () => {
	test("rejects runtime imports and requires of SQLite implementations outside exact owners", () => {
		const violations = auditDatabaseOwnership([
			source("integrations/example/src/export-all.ts", 'export * from "bun:sqlite";'),
			source("integrations/example/src/export-named.ts", 'export { Database } from "node:sqlite";'),
			source("integrations/example/src/side-effect.ts", 'import "bun:sqlite";'),
			source("libs/example/src/computed.ts", 'let moduleName = "bun:sqlite"; require(moduleName);'),
			source("libs/example/src/import-equals.ts", 'import Database = require("better-sqlite3");'),
			source(
				"libs/example/src/nested.ts",
				'function open() { const moduleName = "bun:sqlite"; return require(moduleName); }',
			),
			source("platform/daemon/src/new-route.ts", 'import { Database } from "bun:sqlite";'),
			source("platform/core/src/new-store.ts", 'const sqlite = require("better-sqlite3");'),
			source("surfaces/cli/src/new-store.ts", 'const sqlite = await import("node:sqlite");'),
		]);
		expect(violations.map(({ module, path }) => [path, module])).toEqual([
			["integrations/example/src/export-all.ts", "bun:sqlite"],
			["integrations/example/src/export-named.ts", "node:sqlite"],
			["integrations/example/src/side-effect.ts", "bun:sqlite"],
			["libs/example/src/computed.ts", "bun:sqlite"],
			["libs/example/src/import-equals.ts", "better-sqlite3"],
			["libs/example/src/nested.ts", "bun:sqlite"],
			["platform/core/src/new-store.ts", "better-sqlite3"],
			["platform/daemon/src/new-route.ts", "bun:sqlite"],
			["surfaces/cli/src/new-store.ts", "node:sqlite"],
		]);
	});

	test("accepts type-only imports because they cannot open a database", () => {
		const violations = auditDatabaseOwnership([
			source("platform/daemon/src/memory.ts", 'import type { Database } from "bun:sqlite";'),
			source("platform/daemon/src/query.ts", 'import { type SQLQueryBindings } from "bun:sqlite";'),
			source("platform/daemon/src/types.ts", 'export type { Database } from "bun:sqlite";'),
		]);
		expect(violations).toEqual([]);
	});

	test("accepts existing exact runtime owners without exempting sibling files", () => {
		const violations = auditDatabaseOwnership([
			source("platform/daemon/src/db-owner-worker.ts", 'const sqlite = require("bun:sqlite");'),
			source("platform/core/src/database.ts", 'const sqlite = await import("better-sqlite3");'),
			source("memorybench/src/server/db/index.ts", 'import { Database } from "bun:sqlite";'),
			source("platform/daemon/src/db-owner-helper.ts", 'const sqlite = require("bun:sqlite");'),
		]);
		expect(violations).toEqual([expect.objectContaining({ path: "platform/daemon/src/db-owner-helper.ts" })]);
	});

	test("ignores forbidden module names in strings and comments", () => {
		const violations = auditDatabaseOwnership([
			source(
				"platform/daemon/src/status.ts",
				['const message = "bun:sqlite is owned externally";', '// require("better-sqlite3")'].join("\n"),
			),
		]);
		expect(violations).toEqual([]);
	});

	test("sorts findings deterministically and reports source lines", () => {
		const violations = auditDatabaseOwnership([
			source("z.ts", '\nconst sqlite = require("node:sqlite");'),
			source("a.ts", 'import Database from "better-sqlite3";'),
		]);
		expect(violations.map(({ path, line }) => `${path}:${line}`)).toEqual(["a.ts:1", "z.ts:2"]);
	});
});
