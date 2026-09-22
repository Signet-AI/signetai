import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { mountProtectionRoutes } from "./protection";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("protection API", () => {
	it("projects the shared protection status without exposing paths or secrets", async () => {
		const app = new Hono();
		mountProtectionRoutes(app, {
			components: [{ id: "secrets", status: "protected", detail: "keyring available", label: "/home/user/.secrets" }],
		});
		const response = await app.request("/api/protection");
		const body = await response.json();
		expect(response.status).toBe(200);
		expect(body.components[0]).toEqual({ id: "secrets", status: "protected", detail: "keyring available" });
		expect(JSON.stringify(body)).not.toContain("/home/user");
	});

	it("computes evidence from the workspace at request time without leaking its path", async () => {
		const root = mkdtempSync(join(tmpdir(), "protection-api-"));
		try {
			mkdirSync(join(root, "files"), { recursive: true });
			writeFileSync(join(root, "workspace-layout.json"), JSON.stringify({ version: 2 }));
			const app = new Hono();
			mountProtectionRoutes(app, { workspacePath: root });
			const body = await (await app.request("/api/protection")).json();
			expect(body.components).toHaveLength(9);
			expect(JSON.stringify(body)).not.toContain(root);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
