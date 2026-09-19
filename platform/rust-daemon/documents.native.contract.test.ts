// biome-ignore-all lint/suspicious/noExplicitAny: Native compatibility payloads are intentionally dynamic.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const bin = join(root, "platform/rust-daemon/target/debug/signet-daemon");
const children: Array<{
	kill: (signal?: string) => void;
	exited: Promise<number>;
	stderr: ReadableStream<Uint8Array>;
}> = [];
const workspaces: string[] = [];
const testValues = new Set<string>();
let nextPort = 39800 + Math.floor(Math.random() * 500);

async function start(workspace: string, agent: string, workspaceId: string) {
	const port = nextPort++;
	const child = Bun.spawn([bin], {
		cwd: root,
		env: Object.fromEntries(
			Object.entries({
				...process.env,
				SIGNET_PATH: workspace,
				SIGNET_BIND: "127.0.0.1",
				SIGNET_PORT: String(port),
				SIGNET_AGENT_ID: agent,
				SIGNET_WORKSPACE_ID: workspaceId,
			}).filter(([key]) => key !== "SIGNET_API_KEY" && key !== "SIGNET_TOKEN"),
		),
		stdout: "ignore",
		stderr: "pipe",
	}) as unknown as (typeof children)[number];
	children.push(child);
	const origin = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 240; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return { origin, child };
		} catch {}
		await Bun.sleep(25);
	}
	throw new Error("native Rust daemon readiness timeout");
}

async function body(response: Response) {
	const text = await response.text();
	try {
		return JSON.parse(text) as Record<string, any>;
	} catch {
		return { raw: text };
	}
}

function headers(agent: string, workspace: string) {
	return { "content-type": "application/json", "x-signet-agent": agent, "x-workspace-id": workspace };
}

async function stop(child: (typeof children)[number]) {
	child.kill("SIGTERM");
	await Promise.race([child.exited, Bun.sleep(1500)]);
}

afterEach(async () => {
	for (const child of children.splice(0)) await stop(child);
	for (const path of workspaces.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("native document compatibility routes are real, scoped, durable, and explicit", async () => {
	expect(existsSync(bin)).toBe(true);
	const workspace = mkdtempSync(join(tmpdir(), "signet-documents-contract-"));
	workspaces.push(workspace);
	const agent = `doc-agent-${crypto.randomUUID()}`;
	const workspaceId = `doc-workspace-${crypto.randomUUID()}`;
	const sourceName = `source-${crypto.randomUUID()}`;
	const path = `document-${crypto.randomUUID()}.md`;
	const content = `native-document-content-${crypto.randomUUID()}`;
	for (const value of [agent, workspaceId, sourceName, path, content]) testValues.add(value);
	let daemon = await start(workspace, agent, workspaceId);
	const h = headers(agent, workspaceId);

	const sourceResponse = await fetch(`${daemon.origin}/api/sources`, {
		method: "POST",
		headers: h,
		body: JSON.stringify({ kind: "folder", name: sourceName, config: {} }),
	});
	expect([200, 201].includes(sourceResponse.status)).toBe(true);
	const source = await body(sourceResponse);
	expect(typeof source.id).toBe("string");
	const create = await fetch(`${daemon.origin}/api/documents`, {
		method: "POST",
		headers: h,
		body: JSON.stringify({
			source_id: source.id,
			path,
			agent_id: agent,
			workspace_id: workspaceId,
			source_type: "text",
			content,
			title: path,
			content_type: "text/markdown",
			metadata: { source: sourceName },
		}),
	});
	expect([200, 201, 202].includes(create.status)).toBe(true);
	const created = await body(create);
	expect(typeof created.id).toBe("string");
	expect(typeof created.status).toBe("string");
	const documentId = created.id as string;
	const importedResponse = await fetch(`${daemon.origin}/api/import/documents`, {
		method: "POST",
		headers: h,
		body: JSON.stringify({ source_id: source.id, path, content: `${content}-alias`, duplicateMode: "skip" }),
	});
	expect([200, 201, 409].includes(importedResponse.status)).toBe(true);

	const duplicate = await fetch(`${daemon.origin}/api/documents`, {
		method: "POST",
		headers: h,
		body: JSON.stringify({
			source_id: source.id,
			path,
			agent_id: agent,
			workspace_id: workspaceId,
			source_type: "text",
			content,
			title: path,
			content_type: "text/markdown",
			metadata: { source: sourceName },
		}),
	});
	expect([200, 201, 202, 409].includes(duplicate.status)).toBe(true);
	const duplicateBody = await body(duplicate);
	expect(typeof duplicateBody.status === "string" || duplicate.status === 409).toBe(true);

	const listResponse = await fetch(`${daemon.origin}/api/documents?limit=100&offset=0`, { headers: h });
	const list = await body(listResponse);
	expect(listResponse.status).toBe(200);
	expect(Array.isArray(list.items)).toBe(true);
	expect(list.complete).toBe(true);
	expect(list.unsupported).toMatchObject({ persistentChunks: true });
	expect(list.limit).toBe(100);
	expect(list.items.map((item: any) => item.id)).toEqual(
		[...list.items].sort((a: any, b: any) => String(a.id).localeCompare(String(b.id))).map((item: any) => item.id),
	);
	expect(list.items.some((item: any) => item.id === documentId)).toBe(true);

	const record = await body(await fetch(`${daemon.origin}/api/documents/${documentId}`, { headers: h }));
	expect(record).toMatchObject({ id: documentId, path, sourceId: source.id, status: "completed" });
	expect(record.completeness).toMatchObject({ content: "complete", sourceIdentity: "complete", chunks: "derived" });
	expect(typeof record.status).toBe("string");
	expect(typeof record.content).toBe("string");
	expect(record.content).toBe(content);
	expect(typeof record.createdAt).toBe("string");
	expect(typeof record.updatedAt).toBe("string");

	const chunks = await body(await fetch(`${daemon.origin}/api/documents/${documentId}/chunks`, { headers: h }));
	expect(chunks).toMatchObject({ complete: true, limit: 100, unsupported: { persistentChunks: true } });
	expect(Array.isArray(chunks.items)).toBe(true);
	expect(chunks.items.map((chunk: any) => chunk.index)).toEqual(
		[...chunks.items].sort((a: any, b: any) => a.index - b.index).map((chunk: any) => chunk.index),
	);
	for (const chunk of chunks.items)
		expect(chunk).toMatchObject({ content: expect.any(String), index: expect.any(Number) });

	const malformed = await fetch(`${daemon.origin}/api/documents`, { method: "POST", headers: h, body: "{" });
	expect(malformed.status).toBeGreaterThanOrEqual(400);
	expect(malformed.status).toBeLessThan(500);
	const empty = await fetch(`${daemon.origin}/api/documents`, { method: "POST", headers: h, body: "" });
	expect(empty.status).toBeGreaterThanOrEqual(400);
	expect(empty.status).toBeLessThan(500);
	const oversized = await fetch(`${daemon.origin}/api/documents`, {
		method: "POST",
		headers: h,
		body: JSON.stringify({ source_type: "text", content: "x".repeat(2_000_000) }),
	});
	expect(oversized.status).toBeGreaterThanOrEqual(400);
	expect(oversized.status).toBeLessThan(500);

	const wrongAgent = { ...headers(`wrong-${agent}`, workspaceId) };
	const wrongWorkspace = headers(agent, `wrong-${workspaceId}`);
	for (const requestHeaders of [wrongAgent, wrongWorkspace]) {
		expect((await fetch(`${daemon.origin}/api/documents`, { headers: requestHeaders })).status).toBe(200);
		expect((await fetch(`${daemon.origin}/api/documents/${documentId}`, { headers: requestHeaders })).status).toBe(404);
		expect(
			(await fetch(`${daemon.origin}/api/documents/${documentId}/chunks`, { headers: requestHeaders })).status,
		).toBe(404);
	}
	const privateList = await body(await fetch(`${daemon.origin}/api/documents`, { headers: wrongAgent }));
	expect(JSON.stringify(privateList)).not.toContain(content);

	await stop(daemon.child);
	children.splice(children.indexOf(daemon.child), 1);
	daemon = await start(workspace, agent, workspaceId);
	const persisted = await fetch(`${daemon.origin}/api/documents/${documentId}`, { headers: h });
	expect(persisted.status).toBe(200);
	expect((await body(persisted)).id).toBe(documentId);
	const deleted = await fetch(`${daemon.origin}/api/documents/${documentId}`, {
		method: "DELETE",
		headers: h,
		body: JSON.stringify({ reason: "contract cleanup" }),
	});
	expect(deleted.status).toBe(200);
	expect(await body(deleted)).toMatchObject({ id: documentId, status: "deleted" });
	const deletedAgain = await fetch(`${daemon.origin}/api/documents/${documentId}`, {
		method: "DELETE",
		headers: h,
		body: JSON.stringify({ reason: "contract cleanup" }),
	});
	expect([200, 404].includes(deletedAgain.status)).toBe(true);
	if (deletedAgain.status === 200) expect((await body(deletedAgain)).status).toBe("deleted");
	expect((await fetch(`${daemon.origin}/api/documents/${documentId}`, { headers: h })).status).toBe(404);

	await stop(daemon.child);
	const stderr = new TextDecoder().decode(await new Response(daemon.child.stderr).arrayBuffer());
	for (const value of testValues) expect(stderr).not.toContain(value);
});
