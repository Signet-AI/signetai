import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as nodeCrypto from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiKey, listApiKeys, revokeApiKey, verifyApiKey } from "./api-keys";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db/owner/accessor";
import * as ownerRuntime from "../db/owner/runtime";
import { dbOwnerBatch, dbOwnerQuery, ownerStatement } from "../db/owner/runtime";
import { checkPermission } from "./policy";

let tempDir = "";

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "signet-api-keys-"));
	initDbAccessor(join(tempDir, "memory.db"), { agentsDir: tempDir });
});

afterEach(async () => {
	await closeDbAccessor();
	rmSync(tempDir, { recursive: true, force: true });
});

async function setKeyColumn(id: string, column: "expires_at" | "last_used_at", value: string): Promise<void> {
	await dbOwnerBatch([ownerStatement(`UPDATE api_keys SET ${column} = ? WHERE id = ?`, [value, id])], {
		operation: "test.api-keys-update",
		lane: "write",
	});
}

async function lastUsedAt(id: string): Promise<string | null> {
	const row = await dbOwnerQuery<{ last_used_at: string | null } | null>(
		ownerStatement("SELECT last_used_at FROM api_keys WHERE id = ?", [id], "get"),
		{ operation: "test.api-keys-last-used", lane: "read" },
	);
	return row?.last_used_at ?? null;
}

async function setRole(id: string, role: string): Promise<void> {
	await dbOwnerBatch([ownerStatement("UPDATE api_keys SET role = ? WHERE id = ?", [role, id])], {
		operation: "test.api-keys-role",
		lane: "write",
	});
}

function duringScrypt(change: () => Promise<void> | void): { readonly mockRestore: () => void } {
	const original = nodeCrypto.scrypt;
	return spyOn(nodeCrypto, "scrypt").mockImplementationOnce(((...args: Parameters<typeof original>) => {
		void Promise.resolve(change()).then(() => Reflect.apply(original, nodeCrypto, args));
	}) as typeof original);
}

describe("api keys", () => {
	test("creates a connector key, stores only metadata, and verifies the raw secret", async () => {
		const created = createApiKey(getDbAccessor(), { name: "work laptop pi", connector: "pi", agentId: "agent-pi" });
		expect(created.key.startsWith("sig_sk_")).toBe(true);
		expect(created.prefix).toMatch(/^[0-9a-f]+$/);
		expect(created.permissions).toContain("recall");
		expect(created.permissions).toContain("documents");

		const listed = listApiKeys(getDbAccessor());
		expect(listed).toHaveLength(1);
		expect(listed[0]?.name).toBe("work laptop pi");
		expect("key" in (listed[0] as object)).toBe(false);

		const verified = await verifyApiKey(created.key);
		expect(verified.authenticated).toBe(true);
		expect(verified.claims?.role).toBe("agent");
		expect(verified.claims?.scope).toEqual({});
		expect(checkPermission(verified.claims, "recall", "team").allowed).toBe(true);
		expect(checkPermission(verified.claims, "admin", "team").allowed).toBe(false);
	});

	test("non-connector admin keys are not restricted by an empty permissions list", async () => {
		const created = createApiKey(getDbAccessor(), { name: "admin laptop", role: "admin" });
		expect(created.permissions).toEqual([]);

		const verified = await verifyApiKey(created.key);
		expect(verified.authenticated).toBe(true);
		expect(verified.claims?.permissions).toBeUndefined();
		expect(checkPermission(verified.claims, "admin", "team").allowed).toBe(true);
		expect(checkPermission(verified.claims, "connectors", "team").allowed).toBe(true);
	});

	test("revoked keys stop authenticating", async () => {
		const created = createApiKey(getDbAccessor(), { name: "remote codex", connector: "codex" });
		expect((await verifyApiKey(created.key)).authenticated).toBe(true);

		const revoked = revokeApiKey(getDbAccessor(), created.prefix);
		expect(typeof revoked?.revokedAt).toBe("string");
		expect(await verifyApiKey(created.key)).toMatchObject({ authenticated: false, error: "api key revoked" });
	});

	test("hashes a token once and reuses the result for later requests", async () => {
		const created = createApiKey(getDbAccessor(), { name: "container claude", connector: "claude-code" });
		const scrypt = spyOn(nodeCrypto, "scrypt");
		const scryptSync = spyOn(nodeCrypto, "scryptSync");
		try {
			for (let i = 0; i < 3; i++) {
				expect((await verifyApiKey(created.key)).authenticated).toBe(true);
			}
			expect(scrypt).toHaveBeenCalledTimes(1);
			expect(scryptSync).not.toHaveBeenCalled();
		} finally {
			scrypt.mockRestore();
			scryptSync.mockRestore();
		}
	});

	test("a wrong secret with a known prefix stays invalid after the real key was verified", async () => {
		const created = createApiKey(getDbAccessor(), { name: "container claude", connector: "claude-code" });
		expect((await verifyApiKey(created.key)).authenticated).toBe(true);

		const forged = `sig_sk_${created.prefix}_${"A".repeat(43)}`;
		expect(await verifyApiKey(forged)).toMatchObject({ authenticated: false, error: "invalid api key" });
		expect(await verifyApiKey(forged)).toMatchObject({ authenticated: false, error: "invalid api key" });
	});

	test("an expired key stops authenticating after it was verified", async () => {
		const created = createApiKey(getDbAccessor(), { name: "container claude", connector: "claude-code" });
		expect((await verifyApiKey(created.key)).authenticated).toBe(true);

		await setKeyColumn(created.id, "expires_at", "2000-01-01T00:00:00.000Z");
		expect(await verifyApiKey(created.key)).toMatchObject({ authenticated: false, error: "api key expired" });
	});

	test("records last use at most once a minute per key", async () => {
		const created = createApiKey(getDbAccessor(), { name: "container claude", connector: "claude-code" });

		expect((await verifyApiKey(created.key)).authenticated).toBe(true);
		const first = await lastUsedAt(created.id);
		expect(first).toEqual(expect.any(String));

		await Bun.sleep(5);
		expect((await verifyApiKey(created.key)).authenticated).toBe(true);
		expect(await lastUsedAt(created.id)).toBe(first);

		const stale = new Date(Date.now() - 61_000).toISOString();
		await setKeyColumn(created.id, "last_used_at", stale);
		expect((await verifyApiKey(created.key)).authenticated).toBe(true);
		const refreshed = await lastUsedAt(created.id);
		expect(refreshed).not.toBe(stale);
		expect(Date.parse(refreshed ?? "")).toBeGreaterThan(Date.parse(stale));
	});

	test("does not overwrite a last use recorded by a concurrent request", async () => {
		const created = createApiKey(getDbAccessor(), { name: "container claude", connector: "claude-code" });
		const recent = new Date(Date.now() - 1_000).toISOString();
		await setKeyColumn(created.id, "last_used_at", recent);

		const query = dbOwnerQuery;
		const staleRead = spyOn(ownerRuntime, "dbOwnerQuery").mockImplementationOnce((async (statement, options) => {
			const row = await query<Record<string, unknown> | null>(statement, options);
			return row && { ...row, last_used_at: null };
		}) as typeof dbOwnerQuery);
		try {
			expect((await verifyApiKey(created.key)).authenticated).toBe(true);
		} finally {
			staleRead.mockRestore();
		}
		expect(await lastUsedAt(created.id)).toBe(recent);
	});

	test("a key revoked while its secret is being hashed does not authenticate", async () => {
		const created = createApiKey(getDbAccessor(), { name: "container claude", connector: "claude-code" });
		const scrypt = duringScrypt(() => {
			revokeApiKey(getDbAccessor(), created.prefix);
		});
		try {
			expect(await verifyApiKey(created.key)).toMatchObject({ authenticated: false, error: "api key revoked" });
		} finally {
			scrypt.mockRestore();
		}
	});

	test("a key revoked while its last use is recorded does not authenticate", async () => {
		const created = createApiKey(getDbAccessor(), { name: "container claude", connector: "claude-code" });
		const batch = dbOwnerBatch;
		const write = spyOn(ownerRuntime, "dbOwnerBatch").mockImplementationOnce((async (statements, options) => {
			revokeApiKey(getDbAccessor(), created.prefix);
			return batch(statements, options);
		}) as typeof dbOwnerBatch);
		try {
			expect(await verifyApiKey(created.key)).toMatchObject({ authenticated: false, error: "api key revoked" });
			expect(write).toHaveBeenCalledTimes(1);
		} finally {
			write.mockRestore();
		}
	});

	test("a key that expires while its last use is recorded does not authenticate", async () => {
		const created = createApiKey(getDbAccessor(), { name: "container claude", connector: "claude-code" });
		const batch = dbOwnerBatch;
		const write = spyOn(ownerRuntime, "dbOwnerBatch").mockImplementationOnce((async (statements, options) => {
			await setKeyColumn(created.id, "expires_at", new Date(Date.now() + 20).toISOString());
			await Bun.sleep(40);
			return batch(statements, options);
		}) as typeof dbOwnerBatch);
		try {
			expect(await verifyApiKey(created.key)).toMatchObject({ authenticated: false, error: "api key expired" });
		} finally {
			write.mockRestore();
		}
		await setKeyColumn(created.id, "expires_at", new Date(Date.now() + 60_000).toISOString());
		expect((await verifyApiKey(created.key)).authenticated).toBe(true);
	});

	test("claims come from the key as it stands after verification", async () => {
		const created = createApiKey(getDbAccessor(), { name: "admin laptop", role: "admin" });
		const scrypt = duringScrypt(() => setRole(created.id, "readonly"));
		try {
			const verified = await verifyApiKey(created.key);
			expect(verified.authenticated).toBe(true);
			expect(verified.claims?.role).toBe("readonly");
		} finally {
			scrypt.mockRestore();
		}
	});
});
