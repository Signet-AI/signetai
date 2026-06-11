import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { DbAccessor } from "../db-accessor";
import { checkPermission } from "./policy";
import { createApiKey, listApiKeys, revokeApiKey, verifyApiKey } from "./api-keys";

function makeAccessor(): { accessor: DbAccessor; close: () => void } {
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE api_keys (
			id TEXT PRIMARY KEY,
			prefix TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			key_hash TEXT NOT NULL,
			role TEXT NOT NULL DEFAULT 'agent',
			scope_json TEXT NOT NULL DEFAULT '{}',
			permissions_json TEXT NOT NULL DEFAULT '[]',
			connector TEXT,
			harness TEXT,
			agent_id TEXT,
			allowed_projects_json TEXT,
			created_at TEXT NOT NULL,
			last_used_at TEXT,
			revoked_at TEXT,
			expires_at TEXT
		)
	`);
	return {
		accessor: {
			withWriteTx(fn) {
				db.exec("BEGIN IMMEDIATE");
				try {
					const result = fn(db as never);
					db.exec("COMMIT");
					return result;
				} catch (error) {
					db.exec("ROLLBACK");
					throw error;
				}
			},
			withReadDb(fn) {
				return fn(db as never);
			},
			close() {
				db.close();
			},
		},
		close: () => db.close(),
	};
}

let cleanup: (() => void) | null = null;

afterEach(() => {
	cleanup?.();
	cleanup = null;
});

describe("api keys", () => {
	test("creates a connector key, stores only metadata, and verifies the raw secret", () => {
		const { accessor, close } = makeAccessor();
		cleanup = close;

		const created = createApiKey(accessor, { name: "work laptop pi", connector: "pi", agentId: "agent-pi" });
		expect(created.key.startsWith("sig_sk_")).toBe(true);
		expect(created.prefix).toMatch(/^[0-9a-f]+$/);
		expect(created.permissions).toContain("recall");
		expect(created.permissions).toContain("documents");

		const listed = listApiKeys(accessor);
		expect(listed).toHaveLength(1);
		expect(listed[0]?.name).toBe("work laptop pi");
		expect("key" in (listed[0] as object)).toBe(false);

		const verified = verifyApiKey(accessor, created.key);
		expect(verified.authenticated).toBe(true);
		expect(verified.claims?.role).toBe("agent");
		expect(verified.claims?.scope).toEqual({});
		expect(checkPermission(verified.claims, "recall", "team").allowed).toBe(true);
		expect(checkPermission(verified.claims, "admin", "team").allowed).toBe(false);
	});

	test("non-connector admin keys are not restricted by an empty permissions list", () => {
		const { accessor, close } = makeAccessor();
		cleanup = close;

		const created = createApiKey(accessor, { name: "admin laptop", role: "admin" });
		expect(created.permissions).toEqual([]);

		const verified = verifyApiKey(accessor, created.key);
		expect(verified.authenticated).toBe(true);
		expect(verified.claims?.permissions).toBeUndefined();
		expect(checkPermission(verified.claims, "admin", "team").allowed).toBe(true);
		expect(checkPermission(verified.claims, "connectors", "team").allowed).toBe(true);
	});

	test("revoked keys stop authenticating", () => {
		const { accessor, close } = makeAccessor();
		cleanup = close;

		const created = createApiKey(accessor, { name: "remote codex", connector: "codex" });
		expect(verifyApiKey(accessor, created.key).authenticated).toBe(true);

		const revoked = revokeApiKey(accessor, created.prefix);
		expect(typeof revoked?.revokedAt).toBe("string");
		expect(verifyApiKey(accessor, created.key)).toMatchObject({ authenticated: false, error: "api key revoked" });
	});
});
