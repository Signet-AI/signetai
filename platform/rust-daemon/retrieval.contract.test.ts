import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Child = ReturnType<typeof Bun.spawn>;
type SearchResult = { id: string; content: string };
type SearchBody = {
	results: SearchResult[];
	query: string;
	method: string;
	meta: { lexical: { completeness: string }; channels: { vector: { supported: boolean } } };
};
type Created = { id: string };

const configuredBinary = Reflect.get(process.env, "SIGNET_RUST_DAEMON_BIN");
const binary =
	(typeof configuredBinary === "string" ? configuredBinary : undefined) ??
	join(process.cwd(), "platform/rust-daemon/target/debug/signet-daemon");
const jsonHeaders = (agent: string) => ({ "content-type": "application/json", "x-signet-agent": agent });

async function freePort(): Promise<number> {
	const server = Bun.serve({ port: 0, fetch: () => new Response() });
	const port = server.port;
	server.stop();
	return port;
}
async function start(
	workspace = mkdtempSync(join(tmpdir(), "signet-retrieval-")),
): Promise<{ origin: string; child: Child; workspace: string }> {
	if (!existsSync(binary)) throw new Error(`build daemon first: ${binary}`);
	const port = await freePort();
	const child = Bun.spawn([binary], {
		env: {
			...process.env,
			SIGNET_PATH: workspace,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
			SIGNET_AGENT_ID: "",
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	const origin = `http://127.0.0.1:${port}`;
	try {
		for (let i = 0; i < 200; i++) {
			try {
				if ((await fetch(`${origin}/health/ready`)).ok) return { origin, child, workspace };
			} catch {}
			await Bun.sleep(10);
		}
		throw new Error("daemon did not start");
	} catch (error) {
		child.kill("SIGTERM");
		await child.exited;
		throw error;
	}
}
async function stop(child: Child): Promise<void> {
	child.kill("SIGTERM");
	await child.exited;
}
async function remember(origin: string, agent: string, content: string): Promise<string> {
	const response = await fetch(`${origin}/api/memory/remember`, {
		method: "POST",
		headers: jsonHeaders(agent),
		body: JSON.stringify({ content }),
	});
	expect(response.status).toBe(201);
	return ((await response.json()) as Created).id;
}
async function search(origin: string, agent: string, suffix = ""): Promise<SearchBody> {
	const response = await fetch(`${origin}/api/memory/search?q=tokenized&agent_id=${agent}${suffix}`);
	expect(response.status).toBe(200);
	return (await response.json()) as SearchBody;
}

describe("native retrieval contract", () => {
	it("proves scoped lexical retrieval, API shapes, boundaries, lifecycle exclusion, fallback truth, and restart", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "signet-retrieval-"));
		let first: Awaited<ReturnType<typeof start>> | undefined;
		let second: Awaited<ReturnType<typeof start>> | undefined;
		try {
			first = await start(workspace);
			const active = await remember(first.origin, "agent-a", "tokenized comet alpha");
			const privateId = await remember(first.origin, "agent-b", "tokenized comet private");
			const deleted = await remember(first.origin, "agent-a", "tokenized deleted");
			const replacement = await remember(first.origin, "agent-a", "tokenized replacement");
			const del = await fetch(`${first.origin}/api/memory/${deleted}`, {
				method: "DELETE",
				headers: { "x-signet-agent": "agent-a" },
			});
			expect(del.status).toBe(200);
			const supersede = await fetch(`${first.origin}/api/memories/${active}/supersede`, {
				method: "POST",
				headers: jsonHeaders("agent-a"),
				body: JSON.stringify({ supersededBy: replacement }),
			});
			expect(supersede.status).toBe(200);
			const recall = await fetch(`${first.origin}/api/memory/recall`, {
				method: "POST",
				headers: jsonHeaders("agent-a"),
				body: JSON.stringify({ query: "tokenized", limit: 1 }),
			});
			expect(recall.status).toBe(200);
			const recallBody = (await recall.json()) as SearchBody;
			expect(Array.isArray(recallBody.results)).toBe(true);
			expect(recallBody.query).toBe("tokenized");
			expect(recallBody.method).toBe("keyword");
			expect(recallBody.results.length).toBe(1);
			expect(recallBody.meta.channels.vector.supported).toBe(false);
			const api = await search(first.origin, "agent-a", "&limit=1");
			expect(api.results.length).toBe(1);
			const legacy = (await (
				await fetch(`${first.origin}/memory/search?q=tokenized&agent_id=agent-a&limit=1`)
			).json()) as SearchBody;
			expect(legacy.results.length).toBe(1);
			expect((await search(first.origin, "agent-a")).results.some((row) => row.id === privateId)).toBe(false);
			expect((await search(first.origin, "agent-a")).results.some((row) => row.id === deleted)).toBe(false);
			expect((await search(first.origin, "agent-a")).meta.lexical.completeness).toBe("partial");
			for (const bad of ["0", "101", "nope", "-1", "1.5"])
				expect(
					(await fetch(`${first.origin}/api/memory/search?q=tokenized&agent_id=agent-a&limit=${bad}`)).status,
				).toBe(400);
			await stop(first.child);
			first = undefined;
			second = await start(workspace);
			const persisted = await search(second.origin, "agent-a");
			expect(persisted.results.some((row) => row.id === replacement)).toBe(true);
		} finally {
			if (first) await stop(first.child);
			if (second) await stop(second.child);
			rmSync(workspace, { recursive: true, force: true });
		}
	});
});
