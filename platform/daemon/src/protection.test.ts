import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { mountProtectionRoutes } from "./protection";

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
});
