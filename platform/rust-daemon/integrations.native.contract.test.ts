import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const configuredBinary = Reflect.get(process.env, "SIGNET_RUST_DAEMON_BIN");
const binary =
	(typeof configuredBinary === "string" && configuredBinary.length > 0 ? configuredBinary : undefined) ??
	join(root, "platform/rust-daemon/target/debug/signet-daemon");
const children: ReturnType<typeof Bun.spawn>[] = [];
const workspaces: string[] = [];
let port = 39_100;

async function start(existingWorkspace?: string) {
	expect(existsSync(binary)).toBe(true);
	const workspace = existingWorkspace ?? mkdtempSync(join(tmpdir(), "signet-integrations-"));
	if (!existingWorkspace) workspaces.push(workspace);
	const child = Bun.spawn([binary], {
		cwd: root,
		env: { ...process.env, SIGNET_PATH: workspace, SIGNET_BIND: "127.0.0.1", SIGNET_PORT: String(port++) },
		stdout: "ignore",
		stderr: "pipe",
	});
	children.push(child);
	const origin = `http://127.0.0.1:${port - 1}`;
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return { origin, workspace };
		} catch {}
		await Bun.sleep(50);
	}
	throw new Error("native daemon did not become ready");
}

afterEach(async () => {
	for (const child of children.splice(0)) {
		child.kill();
		await child.exited;
	}
	for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

describe("native configuration and integration boundary", () => {
	it("exposes feature, connector, integration, and responsive health shapes without fake provider health", async () => {
		const { origin } = await start();
		const [features, connectors, integrations, health] = await Promise.all([
			fetch(`${origin}/api/features`),
			fetch(`${origin}/api/connectors`),
			fetch(`${origin}/api/integrations`),
			fetch(`${origin}/health/integrations`),
		]);
		expect(features.status).toBe(200);
		expect((await features.json()).runtime).toBe("rust");
		const connectorBody = (await connectors.json()) as { connectors: Array<Record<string, unknown>> };
		expect(connectorBody.connectors[0]).toMatchObject({ implemented: false, probed: false, status: "unsupported" });
		expect((await integrations.json()).integrations[0]).toMatchObject({
			implemented: false,
			probed: false,
			status: "unsupported",
		});
		expect(health.status).toBe(200);
		expect((await health.json()).external).toMatchObject({ probed: false, status: "unknown" });
	});

	it("round-trips allowlisted UTF-8 config and persists it after restart", async () => {
		const first = await start();
		const put = await fetch(`${first.origin}/api/config`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ file: "SOUL.md", content: "café — native" }),
		});
		expect(put.status).toBe(200);
		expect(readFileSync(join(first.workspace, "SOUL.md"), "utf8")).toBe("café — native");
		const child = children.shift();
		expect(child).toBeDefined();
		child?.kill();
		if (child) await child.exited;
		const restarted = await start(first.workspace);
		const persisted = await fetch(`${restarted.origin}/api/config`);
		expect((await persisted.json()).files).toContainEqual({ name: "SOUL.md", content: "café — native", size: 16 });
	});

	it("rejects traversal, symlink targets, and oversize payloads", async () => {
		const { origin, workspace } = await start();
		const traversal = await fetch(`${origin}/api/config`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ file: "../escape", content: "x" }),
		});
		expect(traversal.status).toBe(400);
		symlinkSync("/etc/passwd", join(workspace, "SOUL.md"));
		const symlink = await fetch(`${origin}/api/config`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ file: "SOUL.md", content: "nope" }),
		});
		expect(symlink.status).toBe(400);
		const oversize = await fetch(`${origin}/api/config`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ file: "USER.md", content: "x".repeat(1_048_577) }),
		});
		expect(oversize.status).toBe(400);
	});
});
