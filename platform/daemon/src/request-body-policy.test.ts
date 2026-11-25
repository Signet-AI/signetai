import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspaceLayout } from "@signet/core";
import { Hono } from "hono";
import ts from "typescript";
import { closeDbAccessor, initDbAccessor } from "./db-accessor";
import { closeDbOwner } from "./db-owner-runtime";
import { registerGlobalMiddleware } from "./middleware";
import { streamedRequestBody } from "./request-body";
import { reloadAuthState } from "./routes/state";
import { registerTranscriptImportRoutes } from "./routes/transcript-import-routes";

function routeSources(): Map<string, string> {
	const out = new Map<string, string>();
	function walk(dir: string): void {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== "__tests__") walk(path);
				continue;
			}
			if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
			const source = readFileSync(path, "utf8"),
				sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
			const functions = new Map<string, ts.Node>();
			function find(node: ts.Node): void {
				if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
				if (
					ts.isVariableDeclaration(node) &&
					ts.isIdentifier(node.name) &&
					node.initializer &&
					(ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
				)
					functions.set(node.name.text, node.initializer);
				ts.forEachChild(node, find);
			}
			find(sf);
			function body(node: ts.Node, seen = new Set<string>()): string {
				let text = node.getText(sf);
				if (ts.isIdentifier(node) && functions.has(node.text)) {
					const target = functions.get(node.text);
					if (target && !seen.has(node.text)) {
						seen.add(node.text);
						text += body(target, seen);
					}
				}
				function expand(child: ts.Node): void {
					if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && !seen.has(child.expression.text)) {
						const target = functions.get(child.expression.text);
						if (target) {
							seen.add(child.expression.text);
							text += body(target, seen);
						}
					}
					ts.forEachChild(child, expand);
				}
				expand(node);
				return text;
			}
			function visit(node: ts.Node): void {
				if (
					ts.isCallExpression(node) &&
					ts.isPropertyAccessExpression(node.expression) &&
					["post", "put", "patch", "delete", "all"].includes(node.expression.name.text)
				) {
					const path = node.arguments[0],
						handler = node.arguments[node.arguments.length - 1];
					if (path && ts.isStringLiteral(path) && handler)
						out.set(`${node.expression.name.text.toUpperCase()} ${path.text}`, body(handler));
				}
				ts.forEachChild(node, visit);
			}
			visit(sf);
		}
	}
	walk(import.meta.dir);
	return out;
}
let dir = "";
const previous = process.env.SIGNET_PATH;
beforeEach(async () => {
	await closeDbOwner();
	await closeDbAccessor();
	dir = mkdtempSync(join(tmpdir(), "org-body-policy-"));
	process.env.SIGNET_PATH = dir;
	writeFileSync(join(dir, "agent.yaml"), "auth:\n  mode: local\n");
	initDbAccessor(resolveWorkspaceLayout(dir).database);
	reloadAuthState(dir);
});
afterEach(async () => {
	await closeDbOwner();
	await closeDbAccessor();
	if (previous === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
	else process.env.SIGNET_PATH = previous;
	reloadAuthState(join(dir, "restore"));
	rmSync(dir, { recursive: true, force: true });
});
test.each([undefined, "application/octet-stream"])(
	"raw chunk PATCH survives global middleware (%s)",
	async (contentType: string | undefined) => {
		const app = new Hono();
		registerGlobalMiddleware(app);
		registerTranscriptImportRoutes(app);
		const created = await app.request("/api/sources/imports", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ files: [{ name: "fixture.jsonl" }] }),
		});
		expect(created.status).toBe(201);
		const job = await created.json();
		const bytes = new TextEncoder().encode("raw chunk fixture");
		const response = await app.request(`/api/sources/imports/${job.jobId}/files/${job.files[0].id}`, {
			method: "PATCH",
			headers: {
				...(contentType ? { "content-type": contentType } : {}),
				"upload-generation": "0",
				"upload-length": String(bytes.length),
				"upload-offset": "0",
				"upload-checksum": createHash("sha256").update(bytes).digest("hex"),
			},
			body: bytes,
		});
		expect(response.status).toBe(200);
		expect((await response.json()).offset).toBe(bytes.length);
	},
);
test("registered raw-body and JSON routes are covered by the shared body policy", async () => {
	const { app } = await import("./daemon");
	const raw = [];
	const json = [];
	const sources = routeSources();
	for (const route of app.routes) {
		if (!["POST", "PUT", "PATCH", "DELETE", "ALL"].includes(route.method)) continue;
		const source = sources.get(`${route.method} ${route.path}`) ?? route.handler.toString();
		if (/\.req\.(?:arrayBuffer|blob)\(|\.req\.raw(?!\.(?:signal|headers|url|method)\b)/.test(source)) {
			raw.push(`${route.method} ${route.path}`);
			const probe = new Hono();
			probe.on(route.method, route.path, (c) => c.text(String(streamedRequestBody(c))));
			const path = route.path.replace(/:[A-Za-z_][A-Za-z_0-9]*(?:\{[^}]*\})?/g, "fixture");
			const response = await probe.request(path, {
				method: route.method === "ALL" ? "POST" : route.method,
				headers: route.path === "/api/sources/import" ? { "content-type": "multipart/form-data" } : {},
			});
			expect(await response.text(), `${route.method} ${route.path}`).toBe("true");
		} else if (/jsonBody|readJsonObject|readOptionalJsonObject|\.req\.json\(/.test(source)) {
			json.push(`${route.method} ${route.path}`);
			const probe = new Hono();
			registerGlobalMiddleware(probe);
			probe.on(route.method, route.path, (c) => c.json(c.get("parsedJsonBody")));
			const path = route.path.replace(/:[A-Za-z_][A-Za-z_0-9]*(?:\{[^}]*\})?/g, "fixture");
			const invalid = await probe.request(path, {
				method: route.method,
				headers: { "content-type": "text/plain" },
				body: JSON.stringify({ agentId: "default" }),
			});
			expect(invalid.status, `${route.method} ${route.path}`).toBe(415);
			const valid = await probe.request(path, {
				method: route.method,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ agentId: "default" }),
			});
			const text = await valid.text();
			expect(text, `${route.method} ${route.path} parsed JSON body`).not.toBe("");
			let parsed: unknown;
			try {
				parsed = JSON.parse(text);
			} catch {
				throw new Error(`${route.method} ${route.path}: ${valid.status} ${text.slice(0, 120)}`);
			}
			expect(parsed).toEqual({ agentId: "default" });
		}
	}
	expect(raw).toContain("PATCH /api/sources/imports/:jobId/files/:fileId");
	expect(raw).toContain("ALL /mcp");
	expect(json).toContain("POST /v1/chat/completions");
});

test("global Origin policy honors a trusted proxy loaded from agent.yaml", async () => {
	writeFileSync(join(dir, "agent.yaml"), "auth:\n  mode: local\n  trustedProxies: [127.0.0.1]\n");
	reloadAuthState(dir);
	const app = new Hono();
	registerGlobalMiddleware(app);
	app.post("/api/auth/login", (c) => c.json({ ok: true }));
	function call(peer: string) {
		return app.fetch(
			new Request("http://daemon.invalid/api/auth/login", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "https://public.example",
					"x-forwarded-proto": "https",
					"x-forwarded-host": "public.example",
				},
				body: "{}",
			}),
			{ incoming: { socket: { remoteAddress: peer } } },
		);
	}
	const accepted = await call("127.0.0.1");
	expect(accepted.status).toBe(200);
	expect(accepted.headers.get("access-control-allow-origin")).toBe("https://public.example");
	expect((await call("203.0.113.2")).status).toBe(403);
});
test("global Origin policy preserves the development dashboard allowlist", async () => {
	const app = new Hono();
	registerGlobalMiddleware(app);
	app.post("/api/development-write", (c) => c.json({ ok: true }));
	const response = await app.request("http://localhost:3850/api/development-write", {
		method: "POST",
		headers: { origin: "http://localhost:5173", "sec-fetch-site": "cross-site", "content-type": "application/json" },
		body: "{}",
	});
	expect(response.status).toBe(200);
	expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
});
