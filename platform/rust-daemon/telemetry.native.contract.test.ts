import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";

const root = import.meta.dir;
const binary = `${root}/target/debug/signet-daemon`;
const workspace = `/mnt/work/hermes-scratch/telemetry-contract-${process.pid}-${randomBytes(4).toString("hex")}`;
const agent = `telemetry-agent-${randomBytes(4).toString("hex")}`;
const workspaceId = `telemetry-workspace-${randomBytes(4).toString("hex")}`;
let port = 0;
let child: ReturnType<typeof Bun.spawn>;
let stderr = "";
let secret = Buffer.alloc(0);
const base = () => `http://127.0.0.1:${port}`;
const b64 = (value: string | Uint8Array) => Buffer.from(value).toString("base64url");
function token(role: string, scope: Record<string, string>, permissions: string[] = []) {
	const now = Math.floor(Date.now() / 1000);
	const encoded = b64(JSON.stringify({ sub: `contract-${role}`, role, scope, permissions, iat: now, exp: now + 3600 }));
	return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("base64url")}`;
}
const auth = (value: string) => ({
	Authorization: `Bearer ${value}`,
	"x-signet-agent-id": agent,
	"x-signet-workspace-id": workspaceId,
});
async function waitFor(url: string) {
	for (let i = 0; i < 160; i++) {
		try {
			const response = await fetch(url);
			if (response.status > 0) return response;
		} catch {}
		await Bun.sleep(25);
	}
	throw new Error("daemon did not start");
}
async function start() {
	const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {}, close() {} } });
	port = probe.port;
	probe.stop();
	child = Bun.spawn([binary], {
		cwd: root,
		env: { PATH: process.env.PATH ?? "", SIGNET_PATH: workspace, SIGNET_BIND: "127.0.0.1", SIGNET_PORT: String(port) },
		stdout: "pipe",
		stderr: "pipe",
	});
	child.stderr?.text().then((value) => {
		stderr += value;
	});
	await waitFor(`${base()}/health/live`);
}
async function stop() {
	if (!child) return;
	child.kill("SIGTERM");
	await child.exited;
	await Bun.sleep(25);
	expect(stderr).not.toMatch(/panicked at|thread '.*' panicked/);
}
async function body(response: Response) {
	return (await response.json()) as Record<string, unknown>;
}

describe("fresh Rust telemetry boundary", () => {
	beforeAll(async () => {
		await rm(workspace, { recursive: true, force: true });
		await start();
		secret = await readFile(`${workspace}/.daemon/auth-secret`);
	});
	afterAll(async () => {
		await stop();
		await rm(workspace, { recursive: true, force: true });
	});
	test("enforces authentication, capability, and scope without leakage", async () => {
		expect((await fetch(`${base()}/api/telemetry/events`)).status).toBe(401);
		expect(
			(
				await fetch(`${base()}/api/telemetry/events?agent=${agent}`, {
					headers: auth(token("operator", { agent, workspace: workspaceId })),
				})
			).status,
		).toBe(403);
		const wrong = await fetch(`${base()}/api/telemetry/events?agent=other&workspace=${workspaceId}`, {
			headers: auth(token("operator", { agent, workspace: workspaceId }, ["analytics"])),
		});
		expect(wrong.status).toBe(403);
		expect(await wrong.text()).not.toContain("other");
	});
	test("produces durable native events and supports deterministic filters and malformed 4xx", async () => {
		const authority = token("operator", { agent, workspace: workspaceId }, ["analytics"]);
		const produced = await fetch(`${base()}/api/memory/remember`, {
			method: "POST",
			headers: { ...auth(authority), "content-type": "application/json" },
			body: JSON.stringify({ agentId: agent, content: "telemetry contract memory" }),
		});
		expect(produced.status).toBe(201);
		const listed = await fetch(
			`${base()}/api/telemetry/events?agent=${agent}&workspace=${workspaceId}&event=memory.remembered&limit=1`,
			{ headers: auth(authority) },
		);
		expect(listed.status).toBe(200);
		const page = await body(listed);
		expect(page.events).toHaveLength(1);
		expect(page.events[0].event).toBe("memory.remembered");
		expect(page.events[0].payload.source).toBe("native-memory-route");
		expect(
			(
				await fetch(`${base()}/api/telemetry/events?agent=${agent}&workspace=${workspaceId}&limit=0`, {
					headers: auth(authority),
				})
			).status,
		).toBe(400);
		expect(
			(
				await fetch(`${base()}/api/telemetry/events?agent=${agent}&workspace=${workspaceId}&cursor=not-an-int`, {
					headers: auth(authority),
				})
			).status,
		).toBe(400);
		expect(
			(
				await fetch(`${base()}/api/telemetry/events?agent=${agent}&workspace=other-workspace`, {
					headers: auth(authority),
				})
			).status,
		).toBe(400);
		const conflictingHeaders = await fetch(`${base()}/api/telemetry/events?agent=${agent}&workspace=${workspaceId}`, {
			headers: {
				...auth(authority),
				"x-workspace-id": "other-workspace",
			},
		});
		expect(conflictingHeaders.status).toBe(400);
		const compatibilityEvents = await fetch(`${base()}/api/telemetry/events?agent=${agent}&workspace=${workspaceId}`, {
			headers: {
				Authorization: auth(authority).Authorization,
				"x-signet-agent-id": agent,
				"x-workspace-id": workspaceId,
			},
		});
		expect(compatibilityEvents.status).toBe(200);
		const filtered = await body(
			await fetch(`${base()}/api/telemetry/events?agent=${agent}&workspace=${workspaceId}&event=memory.not-emitted`, {
				headers: auth(authority),
			}),
		);
		expect(filtered.events).toHaveLength(0);
	});
	test("reports authenticated health and explicit provider/export boundaries", async () => {
		const authority = token("operator", { agent, workspace: workspaceId }, ["analytics"]);
		const health = await fetch(`${base()}/api/telemetry/health`, { headers: auth(authority) });
		expect(health.status).toBe(200);
		const value = await body(health);
		expect(value.enabled).toBe(true);
		expect(value.workspace).toBe(workspaceId);
		expect((value.events as Record<string, unknown>).aggregation).toBe("unsupported");
		expect(
			(
				await fetch(`${base()}/api/telemetry/health`, {
					headers: { ...auth(authority), "x-workspace-id": "other-workspace" },
				})
			).status,
		).toBe(400);
		expect(
			(
				await fetch(`${base()}/api/telemetry/health?workspace=other-workspace`, {
					headers: auth(authority),
				})
			).status,
		).toBe(400);
		const compatibilityOnly = await fetch(`${base()}/api/telemetry/health?workspace=${workspaceId}`, {
			headers: {
				Authorization: auth(authority).Authorization,
				"x-signet-agent-id": agent,
				"x-workspace-id": workspaceId,
			},
		});
		expect(compatibilityOnly.status).toBe(200);
		expect((await fetch(`${base()}/api/telemetry/export`, { headers: auth(authority) })).status).toBe(501);
	});
	test("preserves events across restart and cleans up the listener", async () => {
		const authority = token("operator", { agent, workspace: workspaceId }, ["analytics"]);
		await stop();
		await start();
		const page = await body(
			await fetch(`${base()}/api/telemetry/events?agent=${agent}&workspace=${workspaceId}`, {
				headers: auth(authority),
			}),
		);
		expect(page.events.length).toBeGreaterThanOrEqual(1);
		await stop();
		expect(await fetch(`${base()}/health/live`).catch(() => null)).toBeNull();
	});
});
