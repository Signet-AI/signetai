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
	const reservation = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {}, close() {} } });
	const port = reservation.port;
	reservation.stop();
	const stdout = Bun.file(join(dir, "stdout.log"));
	const stderr = Bun.file(join(dir, "stderr.log"));
	const child = Bun.spawn([binary], {
		cwd: root,
		env: {
			...process.env,
			SIGNET_PATH: dir,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_MODE: "local",
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
		{ group_key: "identity", claim_key: "name", content: "subject", kind: "attribute" },
		{ group_key: "identity", claim_key: "role", content: "owner", kind: "attribute" },
		{ group_key: "history", claim_key: "origin", content: "contract", kind: "constraint" },
	]) {
		const { kind, ...fields } = item;
		const response = await create("/api/knowledge/attributes", {
			aspect_id: aspect.id,
			kind,
			confidence: 0.9,
			importance: 0.7,
			...fields,
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
	const firstTree = await tree("max_groups=1&max_claims=1");
	const groups = (payload: Record<string, unknown>): unknown[] => {
		if (!Array.isArray(payload.items) || payload.items.length === 0) return [];
		const first = payload.items[0];
		if (typeof first !== "object" || first === null) return [];
		const values = Reflect.get(first, "groups");
		return Array.isArray(values) ? values : [];
	};
	const claims = (group: unknown): unknown[] => {
		if (typeof group !== "object" || group === null) return [];
		const values = Reflect.get(group, "claims");
		return Array.isArray(values) ? values : [];
	};
	const boundedGroups = groups(firstTree);
	expect(boundedGroups).toHaveLength(1);
	expect(claims(boundedGroups[0])).toHaveLength(1);
	const fullTree = await tree("max_groups=99&max_claims=99");
	const fullGroups = groups(fullTree);
	expect(fullGroups).toHaveLength(2);
	expect(claims(fullGroups[0])).toHaveLength(2);
	const firstItem = Array.isArray(fullTree.items) ? fullTree.items[0] : null;
	expect(firstItem && typeof firstItem === "object" ? Reflect.get(firstItem, "attributeCount") : null).toBe(2);
	expect(firstItem && typeof firstItem === "object" ? Reflect.get(firstItem, "constraintCount") : null).toBe(1);
	expect(groups(await tree("max_groups=0&max_claims=-4")).length).toBeGreaterThan(0);
	expect(groups(await tree("max_groups=nope&max_claims=wat"))).toHaveLength(2);
	expect(groups(await tree("max_groups=1&max_claims=1", { "x-signet-workspace-id": "workspace-a" }))).toHaveLength(1);
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
				headers: headers("other-agent", "workspace-a"),
			})
		).status,
	).toBe(404);
	expect(
		(
			await fetch(`${daemon.origin}/api/knowledge/navigation/tree?entity=${entity.id}&workspace_id=workspace-b`, {
				headers: headers("navigation-owner", "workspace-b"),
			})
		).status,
	).toBe(404);
});

test("fresh daemon navigation paths round-trip group and claim keys", async () => {
	const daemon = await start("navigation-path-owner", "workspace-a");
	const owner = headers("navigation-path-owner", "workspace-a");
	const create = async (path: string, body: unknown) =>
		fetch(`${daemon.origin}${path}?workspace_id=workspace-a`, {
			method: "POST",
			headers: owner,
			body: JSON.stringify(body),
		});
	const entityResponse = await create("/api/knowledge/entities", {
		name: "Group subject",
		type: "person",
		metadata: {},
	});
	expect(entityResponse.status).toBe(201);
	const entity = await json(entityResponse);
	const aspectResponse = await create("/api/knowledge/aspects", { entity_id: entity.id, name: "facts", weight: 0.8 });
	expect(aspectResponse.status).toBe(201);
	const aspect = await json(aspectResponse);
	const attributeResponse = await create("/api/knowledge/attributes", {
		aspect_id: aspect.id,
		kind: "attribute",
		group_key: "dietary constraints",
		claim_key: "favorite meal",
		content: "pizza",
		confidence: 0.9,
		importance: 0.7,
	});
	expect(attributeResponse.status).toBe(201);
	const encoded = encodeURIComponent;
	const groupsResponse = await fetch(
		`${daemon.origin}/api/knowledge/navigation/groups?entity=${encoded("Group subject")}&aspect=facts&workspace_id=workspace-a`,
		{ headers: owner },
	);
	expect(groupsResponse.status).toBe(200);
	const groupsPayload = await json(groupsResponse);
	expect(Array.isArray(groupsPayload.items) ? groupsPayload.items : []).toHaveLength(1);
	const group = Array.isArray(groupsPayload.items) ? groupsPayload.items[0] : null;
	expect(group && typeof group === "object" ? Reflect.get(group, "groupKey") : null).toBe("dietary constraints");
	const claimsResponse = await fetch(
		`${daemon.origin}/api/knowledge/navigation/claims?entity=${encoded("Group subject")}&aspect=facts&group=${encoded("dietary constraints")}&workspace_id=workspace-a`,
		{ headers: owner },
	);
	expect(claimsResponse.status).toBe(200);
	expect(
		await json(claimsResponse).then((payload) => (Array.isArray(payload.items) ? payload.items : [])),
	).toHaveLength(1);
	const attributesResponse = await fetch(
		`${daemon.origin}/api/knowledge/navigation/attributes?entity=${encoded("Group subject")}&aspect=facts&group=${encoded("dietary constraints")}&claim=${encoded("favorite meal")}&workspace_id=workspace-a`,
		{ headers: owner },
	);
	expect(attributesResponse.status).toBe(200);
	expect(
		await json(attributesResponse).then((payload) => (Array.isArray(payload.items) ? payload.items : [])),
	).toHaveLength(1);
});
