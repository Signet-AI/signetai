import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const configuredBinary = Reflect.get(process.env, "SIGNET_RUST_DAEMON_BIN");
const bin =
	(typeof configuredBinary === "string" ? configuredBinary : undefined) ??
	join(root, "platform/rust-daemon/target/debug/signet-daemon");
const children: Array<{ kill: (signal?: string) => void; exited: Promise<number> }> = [];
const workspaces: string[] = [];
let port = 39700;

async function start(workspace: string, agent: string) {
	const child = Bun.spawn([bin], {
		cwd: root,
		env: {
			...process.env,
			SIGNET_PATH: workspace,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port++),
			SIGNET_AGENT_ID: agent,
		},
		stdout: "ignore",
		stderr: "pipe",
	}) as unknown as (typeof children)[number];
	children.push(child);
	const origin = `http://127.0.0.1:${port - 1}`;
	for (let i = 0; i < 200; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return { origin, child };
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("native Rust daemon readiness timeout");
}
async function json(response: Response) {
	return (await response.json()) as Record<string, unknown>;
}

afterEach(async () => {
	for (const child of children.splice(0)) {
		child.kill("SIGTERM");
		await Promise.race([child.exited, new Promise((r) => setTimeout(r, 1000))]);
	}
	for (const path of workspaces.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("native Rust source lifecycle is durable, scoped, fenced, and provider-local", async () => {
	expect(existsSync(bin)).toBe(true);
	const workspace = mkdtempSync(join(tmpdir(), "signet-source-contract-"));
	workspaces.push(workspace);
	let daemon = await start(workspace, "agent-a");
	const h = { "x-signet-agent": "agent-a", "x-signet-workspace-id": "workspace-a", "content-type": "application/json" };
	const created = await json(
		await fetch(`${daemon.origin}/api/sources`, {
			method: "POST",
			headers: h,
			body: JSON.stringify({ kind: "folder", name: "docs", config: {} }),
		}),
	);
	expect(typeof created.id).toBe("string");
	const sourceId = created.id;
	expect((await json(await fetch(`${daemon.origin}/api/sources`, { headers: h }))).sources).toHaveLength(1);
	expect(
		(await fetch(`${daemon.origin}/api/sources`, { headers: { ...h, "x-workspace-id": "workspace-b" } })).status,
	).toBe(400);
	expect(
		(
			await json(
				await fetch(`${daemon.origin}/api/sources`, {
					headers: { "x-signet-agent": "agent-a", "x-signet-workspace-id": "workspace-b" },
				}),
			)
		).sources,
	).toHaveLength(0);
	expect(
		(
			await json(
				await fetch(`${daemon.origin}/api/sources`, {
					headers: { "x-signet-agent": "agent-b", "x-signet-workspace-id": "workspace-a" },
				}),
			)
		).sources,
	).toHaveLength(0);
	const ingest = async (content: string, duplicateMode = "skip") =>
		json(
			await fetch(`${daemon.origin}/api/import/documents`, {
				method: "POST",
				headers: h,
				body: JSON.stringify({ source_id: sourceId, path: "a.md", content, duplicateMode }),
			}),
		);
	const first = await ingest("one");
	expect(first.status).toBe("stored");
	expect(first.contentHash).toBe("7692c3ad3540bb803c020b3aee66cd8887123234ea0c6e7143c0add73ff431ed");
	const crossAgent = await fetch(`${daemon.origin}/api/import/documents`, {
		method: "POST",
		headers: {
			"x-signet-agent": "agent-b",
			"x-signet-workspace-id": "workspace-a",
			"content-type": "application/json",
		},
		body: JSON.stringify({ source_id: sourceId, path: "b.md", content: "hidden" }),
	});
	expect(crossAgent.status).toBe(404);
	const skipped = await ingest("two");
	expect(skipped.status).toBe("skipped");
	expect(skipped.contentHash).toBe(first.contentHash);
	const replaced = await ingest("two", "replace");
	expect(replaced.status).toBe("replaced");
	expect(replaced.contentHash).not.toBe(first.contentHash);
	const reimported = await ingest("three", "reimport");
	expect(reimported.status).toBe("reimported");
	const invalid = await fetch(`${daemon.origin}/api/import/documents`, {
		method: "POST",
		headers: h,
		body: JSON.stringify({ source_id: sourceId, path: "", content: "x" }),
	});
	expect(invalid.status).toBe(400);
	const invalidMode = await fetch(`${daemon.origin}/api/import/documents`, {
		method: "POST",
		headers: h,
		body: JSON.stringify({ source_id: sourceId, path: "bad.md", content: "x", duplicateMode: "unknown" }),
	});
	expect(invalidMode.status).toBe(400);
	const healthResponse = await fetch(`${daemon.origin}/api/sources/${sourceId}/health`, { headers: h });
	expect(healthResponse.status).toBe(200);
	expect(await json(healthResponse)).toMatchObject({
		status: "ready",
		database: "ready",
		source: "present",
		externalProvider: "not_checked",
	});
	expect(
		(
			await fetch(`${daemon.origin}/api/sources/${sourceId}/health`, {
				headers: { "x-signet-agent": "agent-b", "x-signet-workspace-id": "workspace-a" },
			})
		).status,
	).toBe(404);
	daemon.child.kill("SIGTERM");
	await daemon.child.exited;
	children.splice(children.indexOf(daemon.child), 1);
	daemon = await start(workspace, "agent-a");
	expect((await ingest("two")).status).toBe("skipped");
	expect(
		(
			await fetch(`${daemon.origin}/api/sources/${sourceId}`, {
				method: "DELETE",
				headers: h,
				body: JSON.stringify({ generation: 999 }),
			})
		).status,
	).toBe(404);
	expect(
		(
			await fetch(`${daemon.origin}/api/sources/${sourceId}`, {
				method: "DELETE",
				headers: h,
				body: JSON.stringify({}),
			})
		).status,
	).toBe(200);
	const late = await fetch(`${daemon.origin}/api/import/documents`, {
		method: "POST",
		headers: h,
		body: JSON.stringify({ source_id: sourceId, path: "late.md", content: "late" }),
	});
	expect(late.status).toBe(404);
	expect(await json(late)).toMatchObject({ code: "not_found" });
	const health = await json(await fetch(`${daemon.origin}/health`));
	expect(health).toMatchObject({ runtime: "rust", implementation: "fresh" });
});
