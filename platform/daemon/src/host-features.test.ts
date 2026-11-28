import assignments from "./host-features.json";
import { expect, test } from "bun:test";
import { hostFeatureAssignment, hostFeatureSchema, NEVER_REMOTE_ROUTES } from "./host-features";
import { loadRouteInventory } from "../../../tests/integration/org-mode/route-inventory";

test("every host-affecting registration has one reviewed remote policy", async () => {
	const inventory = await loadRouteInventory();
	expect([...Object.keys(assignments), ...NEVER_REMOTE_ROUTES].sort()).toEqual(
		inventory
			.filter((route) => route.effect.startsWith("host"))
			.map((route) => `${route.method} ${route.path}`)
			.sort(),
	);
	for (const route of inventory) {
		if (!route.effect.startsWith("host")) continue;
		const assignment = hostFeatureAssignment(route.method, route.path);
		for (const path of route.paths) expect(hostFeatureAssignment(route.method, path)).toBe(assignment);
		expect({ route: `${route.method} ${route.path}`, assigned: assignment !== undefined }).toEqual({
			route: `${route.method} ${route.path}`,
			assigned: true,
		});
	}
});
test("arbitrary command execution and server-path reads cannot be opted in", () => {
	for (const route of [
		"POST /api/secrets/exec",
		"POST /api/secrets/:name/exec",
		"GET /api/secrets/exec/:jobId",
		"POST /api/troubleshoot/exec",
		"POST /api/sources/import",
		"POST /api/graphiq/index",
	] as const) {
		expect(NEVER_REMOTE_ROUTES).toContain(route);
		const separator = route.indexOf(" ");
		expect(hostFeatureAssignment(route.slice(0, separator), route.slice(separator + 1))).toBe("never-remote");
	}
	expect(hostFeatureSchema.safeParse("never-remote").success).toBe(false);
	expect(hostFeatureAssignment("POST", "/api/harnesses/codex/execute")).toBeUndefined();
});
