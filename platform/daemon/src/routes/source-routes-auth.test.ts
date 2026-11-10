import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSourcesConfig } from "@signet/core";
import type { Hono } from "hono";
import type { TokenRole } from "../auth";

const previousSignetPath = process.env.SIGNET_PATH;
const previousAgentId = process.env.SIGNET_AGENT_ID;
const loopback = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
let agentsDir: string;
let secretPath: string;
let appFactory: typeof import("hono").Hono;
let createAuthMiddleware: typeof import("../auth").createAuthMiddleware;
let createToken: typeof import("../auth").createToken;
let registerImportRoutes: typeof import("./import-routes").registerImportRoutes;
let registerSourcesRoutes: typeof import("./sources-routes").registerSourcesRoutes;
let initDbAccessor: typeof import("../db-accessor").initDbAccessor;
let closeDbAccessor: typeof import("../db-accessor").closeDbAccessor;
let state: typeof import("./state.js");
let admitted: string[] = [];

function writeAuthConfig(mode: "local" | "team"): void {
	writeFileSync(
		join(agentsDir, "agent.yaml"),
		`auth:\n  mode: ${mode}\n  rateLimits:\n    forget:\n      windowMs: 60000\n      max: 30\n    modify:\n      windowMs: 60000\n      max: 60\n    batchForget:\n      windowMs: 60000\n      max: 5\n    admin:\n      windowMs: 60000\n      max: 10\n    recallLlm:\n      windowMs: 60000\n      max: 60\n`,
	);
}

function teamApp(): Hono {
	if (!state.authSecret) throw new Error("expected auth secret in team mode");
	const app = new appFactory();
	app.use("*", createAuthMiddleware(state.authConfig, state.authSecret));
	registerSourcesRoutes(app, { agentsDir });
	registerImportRoutes(app, {
		durableImportAdmission: {
			admit: async ({ fileName, bytes }) => {
				admitted.push(fileName);
				return { key: `k:${fileName}`, originalPath: join(agentsDir, fileName), sha256: "x", size: bytes.byteLength };
			},
			begin: async () => {},
			complete: async () => {},
		},
	});
	return app;
}

function bearer(role: TokenRole): Record<string, string> {
	if (!state.authSecret) throw new Error("expected auth secret");
	const token = createToken(state.authSecret, { sub: `source-auth-${role}`, role, scope: { agent: "agent-a" } }, 60);
	return { authorization: `Bearer ${token}` };
}

function pathForm(path: string): FormData {
	const form = new FormData();
	form.append("paths", path);
	return form;
}

beforeAll(async () => {
	agentsDir = mkdtempSync(join(tmpdir(), "signet-source-route-auth-"));
	mkdirSync(join(agentsDir, "memory"), { recursive: true });
	mkdirSync(join(agentsDir, ".daemon"), { recursive: true });
	secretPath = join(agentsDir, ".daemon", "auth-secret");
	writeFileSync(secretPath, "test-secret-key-32-bytes-min!!!!");
	process.env.SIGNET_PATH = agentsDir;
	process.env.SIGNET_AGENT_ID = "agent-a";
	appFactory = (await import("hono")).Hono;
	({ createAuthMiddleware, createToken } = await import("../auth"));
	({ registerImportRoutes } = await import("./import-routes"));
	({ registerSourcesRoutes } = await import("./sources-routes"));
	({ initDbAccessor, closeDbAccessor } = await import("../db-accessor"));
	state = await import("./state.js");
	initDbAccessor(join(agentsDir, "memory", "memories.db"));
	writeAuthConfig("team");
	state.reloadAuthState(agentsDir);
});

beforeEach(() => {
	admitted = [];
});

afterAll(async () => {
	writeAuthConfig("local");
	state.reloadAuthState(agentsDir);
	await closeDbAccessor();
	if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
	else process.env.SIGNET_PATH = previousSignetPath;
	if (previousAgentId === undefined) Reflect.deleteProperty(process.env, "SIGNET_AGENT_ID");
	else process.env.SIGNET_AGENT_ID = previousAgentId;
	rmSync(agentsDir, { recursive: true, force: true });
});

describe("source route authorization in team mode", () => {
	it("refuses host path imports from non-admin tokens even over loopback", async () => {
		for (const role of ["agent", "operator"] as const) {
			const response = await teamApp().request(
				"http://localhost/api/sources/import",
				{ method: "POST", headers: bearer(role), body: pathForm(secretPath) },
				loopback,
			);
			expect(response.status).toBe(403);
		}
		expect(admitted).toEqual([]);
	});

	it("allows host path imports for admin tokens over loopback only", async () => {
		const path = join(agentsDir, "selected.txt");
		writeFileSync(path, "selected");
		const local = await teamApp().request(
			"http://localhost/api/sources/import",
			{ method: "POST", headers: bearer("admin"), body: pathForm(path) },
			loopback,
		);
		expect(local.status).toBe(201);
		expect(admitted).toEqual(["selected.txt"]);

		const remote = await teamApp().request("https://remote.example/api/sources/import", {
			method: "POST",
			headers: bearer("admin"),
			body: pathForm(path),
		});
		expect(remote.status).toBe(400);
	});

	it("requires documents permission for uploaded imports", async () => {
		const upload = (): FormData => {
			const form = new FormData();
			form.append("files", new File(["hello"], "note.txt", { type: "text/plain" }));
			return form;
		};
		const readonly = await teamApp().request("http://localhost/api/sources/import", {
			method: "POST",
			headers: bearer("readonly"),
			body: upload(),
		});
		expect(readonly.status).toBe(403);
		expect(admitted).toEqual([]);

		const agent = await teamApp().request("http://localhost/api/sources/import", {
			method: "POST",
			headers: bearer("agent"),
			body: upload(),
		});
		expect(agent.status).toBe(201);
		expect(admitted).toEqual(["note.txt"]);
	});

	it("requires admin for routes that read or browse the daemon host", async () => {
		const requests: ReadonlyArray<readonly [string, unknown]> = [
			["/api/sources/obsidian", { path: join(agentsDir, ".daemon") }],
			["/api/sources/pick-directory", {}],
			["/api/sources/pick-files", {}],
			["/api/sources/discord", { guildIds: ["1"], tokenRef: "T", desktopCachePath: agentsDir }],
			["/api/sources/discord", { syncMode: "desktop-cache" }],
		];
		for (const [path, body] of requests) {
			const response = await teamApp().request(
				`http://localhost${path}`,
				{
					method: "POST",
					headers: { ...bearer("operator"), "content-type": "application/json" },
					body: JSON.stringify(body),
				},
				loopback,
			);
			expect({ path, status: response.status }).toEqual({ path, status: 403 });
		}
		const kinds = loadSourcesConfig(agentsDir).sources.map((source) => source.kind);
		expect(kinds.filter((kind) => kind === "obsidian" || kind === "discord")).toEqual([]);
	});

	it("requires connectors permission to change source configuration", async () => {
		const mutations: ReadonlyArray<readonly [string, string]> = [
			["POST", "/api/sources/discord"],
			["POST", "/api/sources/github"],
			["POST", "/api/sources/notion"],
			["POST", "/api/sources/web"],
			["POST", "/api/sources/obsidian:abc/snapshot/import"],
			["DELETE", "/api/sources/obsidian:abc"],
		];
		for (const [method, path] of mutations) {
			const response = await teamApp().request(`http://localhost${path}`, {
				method,
				headers: { ...bearer("agent"), "content-type": "application/json" },
				body: method === "POST" ? "{}" : undefined,
			});
			expect({ method, path, status: response.status }).toEqual({ method, path, status: 403 });
		}

		const github = await teamApp().request("http://localhost/api/sources/github", {
			method: "POST",
			headers: { ...bearer("operator"), "content-type": "application/json" },
			body: "{}",
		});
		expect(github.status).toBe(400);
		const missing = await teamApp().request("http://localhost/api/sources/obsidian:abc", {
			method: "DELETE",
			headers: bearer("operator"),
		});
		expect(missing.status).toBe(404);
	});
});
