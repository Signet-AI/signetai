import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
// biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only binary override
const binary = process.env.SIGNET_RUST_DAEMON_BIN ?? join(root, "platform/rust-daemon/target/debug/signet-daemon");
const children: Bun.Subprocess[] = [];
const dirs: string[] = [];
const logs: string[] = [];

async function start(agent: string, workspace: string) {
	const dir = mkdtempSync(join(tmpdir(), "signet-navigation-"));
	dirs.push(dir);
	const port = 38000 + Math.floor(Math.random() * 2000);
	const stdout = Bun.file(join(dir, "stdout.log"));
	const stderr = Bun.file(join(dir, "stderr.log"));
	const child = Bun.spawn([binary], {
		cwd: root,
		env: {
			...process.env,
			SIGNET_PATH: dir,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
			SIGNET_AGENT_ID: agent,
			SIGNET_API_KEY: "",
			SIGNET_TOKEN: "",
		},
		stdout,
		stderr,
	});
	children.push(child);
	const origin = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 240; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return { child, origin, dir, workspace };
		} catch {}
		await Bun.sleep(25);
	}
	throw new Error(`daemon readiness timeout\nstdout=${await stdout.text()}\nstderr=${await stderr.text()}`);
}
const headers = (agent: string, workspace?: string) => ({
	"content-type": "application/json",
	"x-signet-agent": agent,
	...(workspace ? { "x-workspace-id": workspace } : {}),
});
async function json(response: Response) {
	// biome-ignore lint/suspicious/noExplicitAny: dynamic HTTP contract payload
	return (await response.json()) as Record<string, any>;
}
async function stop(child: Bun.Subprocess) {
	child.kill("SIGTERM");
	await Promise.race([child.exited, Bun.sleep(1000)]);
	if (!child.killed) child.kill("SIGKILL");
}
afterEach(async () => {
	for (const child of children.splice(0)) await stop(child);
	for (const dir of dirs.splice(0)) {
		try {
			logs.push(
				`${dir}\nstdout:\n${readFileSync(join(dir, "stdout.log"), "utf8")}\nstderr:\n${readFileSync(join(dir, "stderr.log"), "utf8")}`,
			);
		} catch {}
		rmSync(dir, { recursive: true, force: true });
	}
});

test("fresh daemon navigation tree enforces bounds, aliases, and isolation", async () => {
	const daemon = await start("navigation-owner", "workspace-a");
	const owner = headers("navigation-owner", "workspace-a");
	const create = async (path: string, body: unknown) =>
		fetch(`${daemon.origin}${path}?workspace_id=workspace-a`, {
			method: "POST",
			headers: owner,
			body: JSON.stringify(body),
		});
	const entityResponse = await create("/api/knowledge/entities", {
		name: "Navigation subject",
		type: "person",
		metadata: {},
	});
	expect(entityResponse.status).toBe(201);
	const entity = await json(entityResponse);
	const aspectResponse = await create("/api/knowledge/aspects", { entity_id: entity.id, name: "facts", weight: 0.8 });
	expect(aspectResponse.status).toBe(201);
	const aspect = await json(aspectResponse);
	for (const item of [
		{ group_key: "identity", claim_key: "name", content: "subject" },
		{ group_key: "identity", claim_key: "role", content: "owner" },
		{ group_key: "history", claim_key: "origin", content: "contract" },
	]) {
		const response = await create("/api/knowledge/attributes", {
			aspect_id: aspect.id,
			kind: "fact",
			confidence: 0.9,
			importance: 0.7,
			...item,
		});
		expect(response.status).toBe(201);
	}
	const tree = async (query: string, extra: Record<string, string> = {}) =>
		json(
			await fetch(
				`${daemon.origin}/api/knowledge/navigation/tree?entity=${entity.id}&workspace_id=workspace-a&${query}`,
				{ headers: { ...owner, ...extra } },
			),
		);
	expect((await tree("max_groups=1&max_claims=1")).groups).toHaveLength(1);
	expect((await tree("max_groups=99&max_claims=99")).groups).toHaveLength(2);
	expect((await tree("max_groups=0&max_claims=-4")).groups.length).toBeGreaterThan(0);
	expect((await tree("max_groups=nope&max_claims=wat")).groups.length).toBe(2);
	expect((await tree("max_groups=1&max_claims=1", { "x-signet-workspace-id": "workspace-a" })).groups).toHaveLength(1);
	expect(
		(
			await fetch(`${daemon.origin}/api/knowledge/navigation/tree?entity=${entity.id}&workspace_id=workspace-a`, {
				headers: { ...owner, "x-signet-workspace-id": "workspace-b" },
			})
		).status,
	).toBe(400);
	expect(
		(
			await fetch(`${daemon.origin}/api/knowledge/navigation/tree?entity=${entity.id}&workspace_id=workspace-a`, {
				headers: headers("wrong-agent", "workspace-a"),
			})
		).status,
	).toBe(200);
	const isolated = await json(
		await fetch(`${daemon.origin}/api/knowledge/navigation/tree?entity=${entity.id}&workspace_id=workspace-a`, {
			headers: headers("wrong-agent", "workspace-a"),
		}),
	);
	expect(isolated.groups ?? []).toHaveLength(0);
	expect(
		(
			await fetch(`${daemon.origin}/api/knowledge/navigation/tree?entity=${entity.id}&workspace_id=workspace-a`, {
				headers: headers("navigation-owner", "workspace-b"),
			})
		).status,
	).toBe(200);
});
