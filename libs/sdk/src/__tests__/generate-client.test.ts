import { describe, expect, test } from "bun:test";
import { generateClient, loadRoutes } from "../../scripts/generate-client.ts";

describe("SDK route generator", () => {
	test("uses the checked-in native route contract without importing or executing a daemon", () => {
		const routes = loadRoutes();
		expect(routes).toContainEqual({ method: "get", path: "/api/memory/{id}/history" });
		const generated = generateClient([{ method: "get", path: "/api/items/{id}" }]);
		expect(generated).toContain("getApiItemsById");
		expect(generated).toContain("/api/items/${" + "id}");
		expect(generated).not.toContain("platform/daemon");
	});
});
