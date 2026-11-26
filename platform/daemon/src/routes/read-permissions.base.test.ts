import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { PERMISSIONS, type Permission } from "../auth/types";
import { localPrincipal } from "../auth/principal";
import { readOrganization } from "../auth/organization-store";
import { closeDbAccessor, initDbAccessor } from "../db-accessor";
import { registerKnowledgeRoutes } from "./knowledge-routes";
import { registerOntologyRoutes } from "./ontology-routes";
import { registerPipelineRoutes } from "./pipeline-routes";
import { registerReflectionRoutes } from "./reflection-routes";
import { registerTelemetryRoutes } from "./telemetry-routes";
import { registerMiscRoutes } from "./misc-routes";

const previousPath = process.env.SIGNET_PATH;
let dir = "";
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "signet-route-permissions-"));
	process.env.SIGNET_PATH = dir;
	initDbAccessor(join(dir, "test.db"));
});
afterAll(async () => {
	await closeDbAccessor();
	if (previousPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
	else process.env.SIGNET_PATH = previousPath;
	rmSync(dir, { recursive: true, force: true });
});
const variants: readonly { label: string; permissions: readonly Permission[] }[] = [
	{ label: "none", permissions: [] },
	...PERMISSIONS.map((permission) => ({ label: permission, permissions: [permission] })),
	{ label: "all", permissions: PERMISSIONS },
];
const snapshotSchema = z.object({
	sourceCommit: z.literal("6730d3dc7"),
	variants: z.array(z.string()),
	entries: z.record(
		z.string(),
		z.object({
			local: z.array(z.string().nullable()),
			organization: z.array(z.string().nullable()),
			leafGuards: z.array(z.string()),
		}),
	),
});
function registrations() {
	const app = new Hono();
	registerPipelineRoutes(app);
	registerKnowledgeRoutes(app);
	registerOntologyRoutes(app);
	registerReflectionRoutes(app);
	registerTelemetryRoutes(app);
	registerMiscRoutes(app);
	return app.routes;
}
test("every read-lane route retains its frozen base permission table", async () => {
	const registered = registrations();
	const leaves = new Map<string, number>();
	registered.forEach((route, index) => {
		if (route.method !== "ALL") leaves.set(`${route.method} ${route.path}`, index);
	});
	const keys = [...leaves.keys()].sort();
	const entries: z.infer<typeof snapshotSchema>["entries"] = {};
	for (const key of keys) {
		const index = leaves.get(key);
		const leaf = index === undefined ? undefined : registered[index];
		if (!leaf) throw new Error("route_leaf_missing");
		entries[key] = {
			local: [],
			organization: [],
			leafGuards: [...leaf.handler.toString().matchAll(/\b(?:requirePermission|checkPermission)\w*\s*\([^)]*/g)].map(
				(match) => match[0].replace(/\s+/g, " "),
			),
		};
	}
	const organization = await readOrganization();
	for (const mode of ["local", "organization"] as const) {
		for (const variant of variants) {
			const app = new Hono();
			app.use("*", async (c, next) => {
				c.set("principal", { ...localPrincipal(), permissions: new Set(variant.permissions) });
				if (mode === "organization") c.set("organization", organization);
				await next();
			});
			registered.forEach((route, index) => {
				if (
					leaves.get(`${route.method} ${route.path}`) === index &&
					!/\brequirePermission\w*\s*\(/.test(route.handler.toString())
				) {
					app.on(route.method, route.path, (c) => c.json({ permissionBoundary: true }));
				} else {
					app.on(route.method, route.path, route.handler);
				}
			});
			for (const key of keys) {
				const entry = entries[key];
				const split = key.indexOf(" ");
				const method = key.slice(0, split);
				const path = key
					.slice(split + 1)
					.replace(/:[A-Za-z_]+(?:\{[^}]*\})?/g, "x")
					.replace(/\*/g, "x");
				const response = await app.request(path, {
					method,
					headers: { "content-type": "application/json" },
					body: method === "GET" ? undefined : "{}",
				});
				const result = z
					.object({ reason: z.string().optional(), required: z.string().optional() })
					.passthrough()
					.parse(await response.json());
				if (!entry) throw new Error("route_entry_missing");
				entry[mode].push(
					response.status === 403 && result.reason === "permission" ? (result.required ?? "permission") : null,
				);
			}
		}
	}
	const observed = { sourceCommit: "6730d3dc7", variants: variants.map((variant) => variant.label), entries };
	const capture = process.env.SIGNET_CAPTURE_PERMISSION_TABLE;
	if (capture) {
		expect(execFileSync("git", ["rev-parse", "--short=9", "HEAD"], { encoding: "utf8" }).trim()).toBe("6730d3dc7");
		writeFileSync(capture, JSON.stringify(observed, null, 2) + "\n");
	} else {
		const expected = snapshotSchema.parse(
			JSON.parse(readFileSync(join(import.meta.dir, "fixtures/read-permissions.6730d3dc7.json"), "utf8")),
		);
		expect(keys).toEqual(Object.keys(expected.entries).sort());
		expect(observed).toEqual(expected);
	}
}, 30000);
