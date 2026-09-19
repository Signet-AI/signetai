import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface NativeProcess {
	readonly kill: (signal?: number | NodeJS.Signals) => void;
	readonly exited: Promise<number>;
}

const children: NativeProcess[] = [];
const workspaces: string[] = [];
let nextPort = 38_600;
const root = process.cwd();
function environmentValue(name: string): string | undefined {
	const value = Reflect.get(process.env, name);
	return typeof value === "string" ? value : undefined;
}

const binary =
	environmentValue("SIGNET_RUST_DAEMON_BIN") ??
	join(root, "platform", "rust-daemon", "target", "debug", "signet-daemon");

function requireBinary(): string {
	if (!existsSync(binary)) {
		throw new Error(`fresh Rust daemon binary is missing: ${binary}; build it before running this test`);
	}
	return binary;
}

async function waitForReady(origin: string, child: NativeProcess): Promise<void> {
	const deadline = Date.now() + 5_000;
	let lastError = "";
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${origin}/health/ready`);
			if (response.ok) return;
			lastError = await response.text();
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		const exit = await Promise.race([
			child.exited.then((code) => code),
			new Promise<null>((resolve) => setTimeout(() => resolve(null), 25)),
		]);
		if (exit !== null) throw new Error(`native daemon exited during readiness (${exit}): ${lastError}`);
	}
	throw new Error(`native daemon did not become ready: ${lastError}`);
}

async function startDaemon(
	agentId: string | null = environmentValue("SIGNET_AGENT_ID"),
	withDashboard = false,
): Promise<{ readonly origin: string; readonly workspace: string; readonly child: NativeProcess }> {
	const workspace = mkdtempSync(join(tmpdir(), "signet-rust-workspace-"));
	if (withDashboard) {
		const dashboard = join(workspace, "dashboard");
		mkdirSync(dashboard, { recursive: true });
		writeFileSync(join(dashboard, "index.html"), "<main>fresh rust dashboard</main>");
	}
	workspaces.push(workspace);
	const port = nextPort++;
	const child = Bun.spawn([requireBinary()], {
		cwd: root,
		env: {
			...process.env,
			SIGNET_PATH: workspace,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
			...(withDashboard ? { SIGNET_DASHBOARD_DIR: join(workspace, "dashboard") } : {}),
			...(agentId === null ? { SIGNET_AGENT_ID: "" } : agentId === undefined ? {} : { SIGNET_AGENT_ID: agentId }),
		},
		stderr: "pipe",
		stdout: "ignore",
	}) as unknown as NativeProcess;
	children.push(child);
	const origin = `http://127.0.0.1:${port}`;
	await waitForReady(origin, child);
	return { origin, workspace, child };
}

afterEach(async () => {
	for (const child of children.splice(0)) {
		child.kill("SIGTERM");
		await Promise.race([child.exited, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
	}
	for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

describe("fresh Rust daemon", () => {
	it("serves health from a native process and preserves scoped durable memory", async () => {
		const { origin } = await startDaemon();
		const live = await fetch(`${origin}/health/live`);
		expect(live.status).toBe(200);
		expect((await live.json()).runtime).toBe("rust");

		const remember = await fetch(`${origin}/api/memory/remember`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-signet-agent": "agent-a" },
			body: JSON.stringify({ content: "durable UTF-8 memory: café" }),
		});
		expect(remember.status).toBe(201);
		const created = (await remember.json()) as { id: string };

		const own = await fetch(`${origin}/api/memory/${created.id}`, { headers: { "x-signet-agent": "agent-a" } });
		expect(own.status).toBe(200);
		expect((await own.json()).content).toBe("durable UTF-8 memory: café");

		const other = await fetch(`${origin}/api/memory/${created.id}`, { headers: { "x-signet-agent": "agent-b" } });
		expect(other.status).toBe(404);
	});

	it("persists a committed transition across restart without exposing the database to the client", async () => {
		const first = await startDaemon();
		const remember = await fetch(`${first.origin}/api/memory/remember`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-signet-agent": "restart-agent" },
			body: JSON.stringify({ content: "survives restart" }),
		});
		expect(remember.status).toBe(201);
		const firstId = ((await remember.json()) as { id: string }).id;
		first.child.kill("SIGTERM");
		await first.child.exited;
		children.splice(children.indexOf(first.child), 1);

		const port = nextPort++;
		const child = Bun.spawn([requireBinary()], {
			cwd: root,
			env: { ...process.env, SIGNET_PATH: first.workspace, SIGNET_BIND: "127.0.0.1", SIGNET_PORT: String(port) },
			stderr: "pipe",
			stdout: "ignore",
		}) as unknown as NativeProcess;
		children.push(child);
		const origin = `http://127.0.0.1:${port}`;
		await waitForReady(origin, child);
		const read = await fetch(`${origin}/api/memory/${firstId}`, { headers: { "x-signet-agent": "restart-agent" } });
		expect(read.status).toBe(200);
		expect((await read.json()).content).toBe("survives restart");

		const db = join(first.workspace, "memory", "memories.db");
		expect(existsSync(db)).toBe(true);
		expect(readFileSync(db).length).toBeGreaterThan(0);
	});

	it("records scoped mutation history and recovers a soft-deleted memory", async () => {
		const { origin } = await startDaemon();
		const headers = { "content-type": "application/json", "x-signet-agent": "history-agent" };
		const remember = await fetch(`${origin}/api/memory/remember`, {
			method: "POST",
			headers,
			body: JSON.stringify({ content: "history target", metadata: { source: "test" } }),
		});
		expect(remember.status).toBe(201);
		const id = ((await remember.json()) as { id: string }).id;

		const patch = await fetch(`${origin}/api/memory/${id}`, {
			method: "PATCH",
			headers,
			body: JSON.stringify({ metadata: { source: "patched" } }),
		});
		expect(patch.status).toBe(200);
		const deleted = await fetch(`${origin}/api/memory/${id}`, { method: "DELETE", headers });
		expect(deleted.status).toBe(200);
		expect((await fetch(`${origin}/api/memory/${id}`, { headers })).status).toBe(404);

		const history = await fetch(`${origin}/api/memory/${id}/history`, { headers });
		expect(history.status).toBe(200);
		expect((await history.json()).history).toHaveLength(3);

		const recovered = await fetch(`${origin}/api/memory/${id}/recover`, { method: "POST", headers });
		expect(recovered.status).toBe(200);
		const restored = await fetch(`${origin}/api/memory/${id}`, { headers });
		expect((await restored.json()).metadata.source).toBe("patched");
		expect((await fetch(`${origin}/api/memory/${id}/history`, { headers })).status).toBe(200);
	});

	it("rejects unscoped writes instead of guessing an agent", async () => {
		const { origin } = await startDaemon(null);
		const response = await fetch(`${origin}/api/memory/remember`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ content: "must be rejected" }),
		});
		expect(response.status).toBe(401);
	});

	it("enforces configured API authentication while leaving readiness and static routes public", async () => {
		process.env.SIGNET_API_KEY = "contract-api-key";
		try {
			const { origin } = await startDaemon(null, true);
			expect((await fetch(`${origin}/health/live`)).status).toBe(200);
			expect((await fetch(`${origin}/`)).status).toBe(200);

			const missing = await fetch(`${origin}/api/status`);
			expect(missing.status).toBe(401);
			expect(missing.headers.get("content-type")).toContain("application/json");
			expect(await missing.json()).toEqual({
				error: "valid Bearer token or x-signet-api-key is required",
				code: "unauthorized",
			});
			expect((await fetch(`${origin}/api/status`, { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
			expect(
				(await fetch(`${origin}/api/status`, { headers: { Authorization: "Bearer contract-api-key" } })).status,
			).toBe(200);
			expect(
				(await fetch(`${origin}/api/status`, { headers: { "x-signet-api-key": "contract-api-key" } })).status,
			).toBe(200);
		} finally {
			Reflect.deleteProperty(process.env, "SIGNET_API_KEY");
		}
	});

	it("falls back to SIGNET_TOKEN when SIGNET_API_KEY is absent", async () => {
		process.env.SIGNET_TOKEN = "legacy-token";
		try {
			const { origin } = await startDaemon(null);
			expect((await fetch(`${origin}/api/status`, { headers: { Authorization: "Bearer legacy-token" } })).status).toBe(
				200,
			);
		} finally {
			Reflect.deleteProperty(process.env, "SIGNET_TOKEN");
		}
	});

	it("persists bounded jobs and isolates ontology records by agent", async () => {
		const { origin } = await startDaemon();
		const agentA = { "content-type": "application/json", "x-signet-agent": "agent-a" };
		const job = await fetch(`${origin}/api/jobs`, {
			method: "POST",
			headers: agentA,
			body: JSON.stringify({ kind: "dreaming", payload: { batch: 1 } }),
		});
		expect(job.status).toBe(200);
		const jobId = ((await job.json()) as { id: string }).id;
		const listed = await fetch(`${origin}/api/jobs`, { headers: { "x-signet-agent": "agent-a" } });
		expect(listed.status).toBe(200);
		expect((await listed.json()).length).toBe(1);
		const cancelled = await fetch(`${origin}/api/jobs/${jobId}`, {
			method: "DELETE",
			headers: { "x-signet-agent": "agent-a" },
		});
		expect(cancelled.status).toBe(200);
		expect((await cancelled.json()).state).toBe("cancelled");

		const claim = await fetch(`${origin}/api/claims?workspace_id=workspace-a`, {
			method: "POST",
			headers: agentA,
			body: JSON.stringify({ id: "claim-1", value: { text: "agent A claim" } }),
		});
		expect(claim.status).toBe(200);
		const ownClaims = await fetch(`${origin}/api/claims?workspace_id=workspace-a`, {
			headers: { "x-signet-agent": "agent-a" },
		});
		expect((await ownClaims.json()).items).toHaveLength(1);
		const otherClaims = await fetch(`${origin}/api/claims?workspace_id=workspace-a`, {
			headers: { "x-signet-agent": "agent-b" },
		});
		expect((await otherClaims.json()).items).toHaveLength(0);
	});

	it("persists source documents and rejects cross-agent ingestion", async () => {
		const { origin } = await startDaemon();
		const agentA = { "content-type": "application/json", "x-signet-agent": "agent-a" };
		const create = await fetch(`${origin}/api/sources`, {
			method: "POST",
			headers: agentA,
			body: JSON.stringify({ kind: "file", name: "notes", config: { path: "notes.md" } }),
		});
		expect(create.status).toBe(201);
		const sourceId = ((await create.json()) as { id: string }).id;
		const imported = await fetch(`${origin}/api/import/documents`, {
			method: "POST",
			headers: agentA,
			body: JSON.stringify({ source_id: sourceId, path: "notes.md", content: "source evidence" }),
		});
		expect(imported.status).toBe(201);
		const crossAgent = await fetch(`${origin}/api/import/documents`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-signet-agent": "agent-b" },
			body: JSON.stringify({ source_id: sourceId, path: "notes.md", content: "must be rejected" }),
		});
		expect(crossAgent.status).toBe(404);
		const ownSources = await fetch(`${origin}/api/sources`, { headers: { "x-signet-agent": "agent-a" } });
		expect((await ownSources.json()).sources).toHaveLength(1);
		const otherSources = await fetch(`${origin}/api/sources`, { headers: { "x-signet-agent": "agent-b" } });
		expect((await otherSources.json()).sources).toHaveLength(0);
	});

	it("atomically updates an allowlisted configuration file", async () => {
		const { origin } = await startDaemon();
		const write = await fetch(`${origin}/api/config`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ file: "USER.md", content: "# user\n" }),
		});
		expect(write.status).toBe(200);
		const read = await fetch(`${origin}/api/config`);
		const payload = (await read.json()) as { files?: Array<{ name?: string; content?: string }> };
		expect(read.status).toBe(200);
		expect(payload.files).toContainEqual({ name: "USER.md", content: "# user\n", size: 7 });
		const rejected = await fetch(`${origin}/api/config`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ file: "../escape", content: "nope" }),
		});
		expect(rejected.status).toBe(400);
	});

	it("serves scoped knowledge entities and relations with bounded 4xx validation", async () => {
		const { origin } = await startDaemon();
		const headers = { "content-type": "application/json", "x-signet-agent": "graph-a" };
		const alice = await fetch(`${origin}/api/knowledge/entities`, {
			method: "POST",
			headers,
			body: JSON.stringify({ name: "Alice", type: "person", metadata: { source: "contract" } }),
		});
		const bob = await fetch(`${origin}/api/knowledge/entities`, {
			method: "POST",
			headers,
			body: JSON.stringify({ name: "Bob", type: "person" }),
		});
		expect(alice.status).toBe(201);
		expect(bob.status).toBe(201);
		const aliceId = ((await alice.json()) as { id: string }).id;
		const bobId = ((await bob.json()) as { id: string }).id;
		const relation = await fetch(`${origin}/api/knowledge/relations`, {
			method: "POST",
			headers,
			body: JSON.stringify({ from_id: aliceId, to_id: bobId, relation: "knows" }),
		});
		expect(relation.status).toBe(201);
		expect(
			(await (await fetch(`${origin}/api/knowledge/entities/${aliceId}/relations`, { headers })).json()).items,
		).toHaveLength(1);
		expect(
			(await (await fetch(`${origin}/api/knowledge/entities`, { headers: { "x-signet-agent": "graph-b" } })).json())
				.items,
		).toHaveLength(0);
		const invalid = await fetch(`${origin}/api/knowledge/entities`, {
			method: "POST",
			headers,
			body: JSON.stringify({ name: "", type: "person" }),
		});
		expect(invalid.status).toBe(400);
	});
});
