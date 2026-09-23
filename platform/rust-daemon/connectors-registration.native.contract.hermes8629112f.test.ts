import { afterEach, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const configuredBinary = Reflect.get(process.env, "SIGNET_RUST_DAEMON_BIN");
const binary =
	(typeof configuredBinary === "string" && configuredBinary.length > 0 ? configuredBinary : undefined) ??
	join(root, "platform/rust-daemon/target/debug/signet-daemon");
const children: ReturnType<typeof Bun.spawn>[] = [];
const workspaces: string[] = [];
async function freePort() {
	const server = createServer();
	await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("failed to reserve free port");
	const p = address.port;
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	return p;
}
async function start() {
	expect(existsSync(binary)).toBe(true);
	const workspace = mkdtempSync(join(tmpdir(), "signet-connectors-"));
	workspaces.push(workspace);
	const p = await freePort();
	const child = Bun.spawn([binary], {
		cwd: root,
		env: {
			...process.env,
			SIGNET_PATH: workspace,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(p),
			SIGNET_API_KEY: "connector-test-key",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	children.push(child);
	const origin = `http://127.0.0.1:${p}`;
	for (let i = 0; i < 120; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) {
				const tokenResponse = await fetch(`${origin}/api/auth/token`, {
					method: "POST",
					headers: { authorization: "Bearer connector-test-key", "content-type": "application/json" },
					body: JSON.stringify({
						role: "admin",
						permissions: [],
						scope: { agent: "agent-a", workspace: "workspace-a" },
					}),
				});
				expect(tokenResponse.status).toBe(200);
				const token = (await tokenResponse.json()) as { token?: string };
				expect(token.token).toEqual(expect.any(String));
				return { origin, token: token.token as string };
			}
		} catch {}
		await Bun.sleep(50);
	}
	throw new Error("native daemon did not become ready");
}
afterEach(async () => {
	for (const c of children.splice(0)) {
		c.kill();
		await c.exited;
	}
	for (const w of workspaces.splice(0)) rmSync(w, { recursive: true, force: true });
});
const headers = (agent: string, token = "connector-test-key") => ({
	authorization: `Bearer ${token}`,
	"x-signet-agent-id": agent,
	"x-signet-workspace-id": "workspace-a",
	"content-type": "application/json",
});
it("registers scoped connectors with TS validation and readback semantics", async () => {
	const { origin, token } = await start();
	expect(
		(
			await fetch(`${origin}/api/connectors`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			})
		).status,
	).toBe(401);
	expect(
		(await fetch(`${origin}/api/connectors`, { method: "POST", headers: headers("agent-a"), body: "{" })).status,
	).toBe(400);
	const tokenAttempt = await fetch(`${origin}/api/connectors`, {
		method: "POST",
		headers: headers("agent-a", token),
		body: JSON.stringify({ provider: "filesystem", displayName: "Token denied", settings: {} }),
	});
	expect(tokenAttempt.status).toBe(403);
	const body = { provider: "filesystem", displayName: "Docs", settings: { rootPath: "/tmp/docs" } };
	const first = await fetch(`${origin}/api/connectors`, {
		method: "POST",
		headers: headers("agent-a"),
		body: JSON.stringify(body),
	});
	expect(first.status).toBe(201);
	const created = (await first.json()) as { id: string };
	const duplicate = await fetch(`${origin}/api/connectors`, {
		method: "POST",
		headers: headers("agent-a"),
		body: JSON.stringify(body),
	});
	expect(duplicate.status).toBe(201);
	expect((await duplicate.json()).id).not.toBe(created.id);
	expect((await (await fetch(`${origin}/api/connectors`, { headers: headers("agent-a") })).json()).count).toBe(2);
	expect((await (await fetch(`${origin}/api/connectors`, { headers: headers("agent-b") })).json()).count).toBe(0);
	const conflict = await fetch(`${origin}/api/connectors`, {
		method: "POST",
		headers: { ...headers("agent-a"), "x-workspace-id": "workspace-b" },
		body: JSON.stringify(body),
	});
	expect(conflict.status).toBe(400);
	const read = await fetch(`${origin}/api/connectors`, { headers: headers("agent-a") });
	const listed = (await read.json()).connectors as Array<Record<string, unknown>>;
	expect(listed.find((entry) => entry.id === created.id)).toMatchObject({
		id: created.id,
		provider: "filesystem",
		displayName: "Docs",
		status: "idle",
		configured: true,
		probed: false,
	});
});

it("matches TypeScript display-name and settings compatibility", async () => {
	const { origin } = await start();
	const base = { provider: "gdrive", settings: ["scope"] };
	const fallback = await fetch(`${origin}/api/connectors`, {
		method: "POST",
		headers: headers("agent-a"),
		body: JSON.stringify({ ...base, display_name: "Wrong" }),
	});
	expect(fallback.status).toBe(201);
	const explicit = await fetch(`${origin}/api/connectors`, {
		method: "POST",
		headers: headers("agent-a"),
		body: JSON.stringify({ ...base, displayName: "Right" }),
	});
	expect(explicit.status).toBe(201);
	const listed = (await (await fetch(`${origin}/api/connectors`, { headers: headers("agent-a") })).json())
		.connectors as Array<Record<string, unknown>>;
	expect(listed.map((entry) => entry.displayName)).toEqual(["Right", "gdrive"]);
	expect(listed[0].settings).toEqual(["scope"]);
});
