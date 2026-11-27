import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import {
	getPluginRegistryDir,
	SIGNET_PLUGIN_REGISTRY_FILE,
	SIGNET_PLUGIN_REGISTRY_VERSION,
	SIGNET_GRAPHIQ_PLUGIN_ID,
	updateGraphiqActiveProject,
} from "@signet/core";
import { localPrincipal } from "../auth/principal";
import { organizationReadRequest } from "../auth/agent-access";
import { resetDefaultPluginHostForTests } from "../plugins";
import { mountMcpRoute } from "./route";
const previousPath = process.env.SIGNET_PATH;
const previousBinPath = process.env.PATH;
let dir = "";
let marker = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "signet-mcp-plugin-permissions-"));
	process.env.SIGNET_PATH = dir;
	const dbPath = join(dir, "project/.graphiq/graphiq.db");
	mkdirSync(dirname(dbPath), { recursive: true });
	writeFileSync(dbPath, "");
	updateGraphiqActiveProject(dir, { projectPath: join(dir, "project"), indexedAt: new Date("2026-11-25") });
	const registry = getPluginRegistryDir(dir);
	mkdirSync(registry, { recursive: true });
	writeFileSync(
		join(registry, SIGNET_PLUGIN_REGISTRY_FILE),
		JSON.stringify({
			version: SIGNET_PLUGIN_REGISTRY_VERSION,
			plugins: { [SIGNET_GRAPHIQ_PLUGIN_ID]: { enabled: true } },
		}),
	);
	resetDefaultPluginHostForTests();
	const bin = join(dir, "bin");
	mkdirSync(bin);
	marker = join(dir, "executed");
	const cli = join(bin, "graphiq");
	writeFileSync(cli, `#!/bin/sh\nprintf 'executed' > '${marker}'\nprintf 'success'\n`);
	chmodSync(cli, 0o755);
	process.env.PATH = `${bin}:${previousBinPath ?? ""}`;
});
afterEach(() => {
	if (previousPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
	else process.env.SIGNET_PATH = previousPath;
	if (previousBinPath === undefined) Reflect.deleteProperty(process.env, "PATH");
	else process.env.PATH = previousBinPath;
	resetDefaultPluginHostForTests();
	rmSync(dir, { recursive: true, force: true });
});
async function invoke(name: string, permissions: readonly ("admin" | "recall")[], args: Record<string, unknown> = {}) {
	return invokeBody({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, permissions);
}
async function invokeBody(body: unknown, permissions: readonly ("admin" | "recall")[]) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("principal", { ...localPrincipal(), permissions: new Set(permissions) });
		await next();
	});
	mountMcpRoute(app);
	return app.request("/mcp", {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
		body: JSON.stringify(body),
	});
}
test("MCP request classification is not globally read-only", () => {
	expect(organizationReadRequest("POST", "/mcp")).toBe(false);
});
test("mounted MCP cannot run GraphIQ clear without admin permission", async () => {
	const denied = await invoke("signet_code_clear", ["recall"], { confirm: true });
	expect(denied.status).toBe(403);
	expect(await denied.json()).toMatchObject({ reason: "permission", required: "admin" });
	expect(existsSync(marker)).toBe(false);
	const allowed = await invoke("signet_code_clear", ["admin"], { confirm: true });
	expect(allowed.status).toBe(200);
	expect(existsSync(marker)).toBe(true);
});
test("mounted MCP denies a clear batch before any plugin handler runs", async () => {
	const response = await invokeBody(
		[
			{
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "signet_code_clear", arguments: { confirm: true } },
			},
		],
		["recall"],
	);
	expect(response.status).toBe(403);
	expect(await response.json()).toMatchObject({ required: "admin" });
	expect(existsSync(marker)).toBe(false);
});
test("mounted MCP denies a mixed list and call batch atomically", async () => {
	const response = await invokeBody(
		[
			{ jsonrpc: "2.0", id: 1, method: "tools/list" },
			{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "code_search", arguments: { query: "hello" } } },
			{
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "signet_code_clear", arguments: { confirm: true } },
			},
		],
		["recall"],
	);
	expect(response.status).toBe(403);
	expect(await response.json()).toMatchObject({ required: "admin" });
	expect(existsSync(marker)).toBe(false);
});
test("mounted MCP plugin reads require recall permission", async () => {
	const denied = await invoke("code_search", [], { query: "hello" });
	expect(denied.status).toBe(403);
	expect(await denied.json()).toMatchObject({ required: "recall" });
	expect(existsSync(marker)).toBe(false);
	const allowed = await invoke("code_search", ["recall"], { query: "hello" });
	expect(allowed.status).toBe(200);
	expect(existsSync(marker)).toBe(true);
});
