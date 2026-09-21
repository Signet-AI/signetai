import { afterEach, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const configuredBinary = Reflect.get(process.env, "SIGNET_RUST_DAEMON_BIN");
const binary =
	(typeof configuredBinary === "string" && configuredBinary.length > 0 ? configuredBinary : undefined) ??
	join(root, "platform/rust-daemon/target/debug/signet-daemon");
const children: ReturnType<typeof Bun.spawn>[] = [];
const workspaces: string[] = [];
let port = 39_450;
async function start() {
	expect(existsSync(binary)).toBe(true);
	const workspace = mkdtempSync(join(tmpdir(), "signet-connectors-"));
	workspaces.push(workspace);
	const p = port++;
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
			if ((await fetch(`${origin}/health/ready`)).ok) return { origin };
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
const headers = (agent: string) => ({
	authorization: "Bearer connector-test-key",
	"x-signet-agent-id": agent,
	"x-signet-workspace-id": "workspace-a",
	"content-type": "application/json",
});
it("registers scoped connectors with TS validation and readback semantics", async () => {
	const { origin } = await start();
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
