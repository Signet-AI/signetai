import { describe, expect, test } from "bun:test";
import { extractRoutes, generateClient } from "../../scripts/generate-client.ts";

describe("SDK route generator", () => {
	test("parses route declarations without importing or executing a daemon", () => {
		const routes = extractRoutes('.route("/api/items/{id}", get(show).delete(remove))');
		expect(routes).toEqual([
			{ method: "get", path: "/api/items/{id}" },
			{ method: "delete", path: "/api/items/{id}" },
		]);
		const generated = generateClient(routes);
		expect(generated).toContain("getApiItemsById");
		expect(generated).toContain("/api/items/${" + "id}");
		expect(generated).not.toContain("daemon.ts");
	});
});
