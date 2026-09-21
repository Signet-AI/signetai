import { afterEach, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
// biome-ignore lint/suspicious/noUndeclaredEnvVars: native contract binary override
const binary = process.env.SIGNET_RUST_DAEMON_BIN ?? join(root, "platform/rust-daemon/target/debug/signet-daemon");
const children: Bun.Subprocess[] = [];
const dirs: string[] = [];
const reserve = () => {
	const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {}, close() {} } });
	const p = s.port;
	s.stop();
	return p;
};
async function start(dir: string, port: number) {
	const out = join(dir, "stdout.log"),
		err = join(dir, "stderr.log");
	const child = Bun.spawn([binary], {
		cwd: root,
		env: {
			...process.env,
			SIGNET_PATH: dir,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
			SIGNET_API_KEY: "reflection-key",
		},
		stdout: Bun.file(out),
		stderr: Bun.file(err),
	});
	children.push(child);
	const origin = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 240; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return { child, origin };
		} catch {}
		await Bun.sleep(25);
	}
	throw new Error(`readiness timeout\nstdout=${readFileSync(out, "utf8")}\nstderr=${readFileSync(err, "utf8")}`);
}
async function stop(child: Bun.Subprocess) {
	child.kill("SIGTERM");
	await Promise.race([child.exited, Bun.sleep(1000)]);
	if (!child.killed) child.kill("SIGKILL");
}
function fixture(dir: string, id: string, agent: string) {
	const db = new Database(join(dir, "memory", "memories.db"));
	db.query(
		"INSERT INTO daily_reflections (id,agent_id,date,summary,patterns,question,memory_ids,summary_ids,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
	).run(
		id,
		agent,
		new Date().toISOString().slice(0, 10),
		"Native contract reflection",
		'["contract"]',
		"What shipped?",
		"[]",
		"[]",
		new Date().toISOString(),
	);
	db.close();
}
afterEach(async () => {
	for (const c of children.splice(0)) await stop(c);
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

it("exercises native reflection answer auth, persistence, scope, and generation boundaries", async () => {
	const dir = mkdtempSync(join(tmpdir(), "signet-reflection-answer-"));
	dirs.push(dir);
	const port = reserve();
	const first = await start(dir, port);
	const admin = { "content-type": "application/json", "x-signet-api-key": "reflection-key" };
	const issue = async (role: string, scope: object, permissions: string[] = []) => {
		const res = await fetch(`${first.origin}/api/auth/token`, {
			method: "POST",
			headers: admin,
			body: JSON.stringify({ role, scope, permissions }),
		});
		expect(res.status).toBe(200);
		return (await res.json()).token as string;
	};
	const agent = "reflection-contract";
	const modify = await issue("agent", { agent }, ["modify", "recall"]);
	const readonly = await issue("readonly", { agent }, ["recall"]);
	const headers = (token: string, extra: Record<string, string> = {}) => ({
		...extra,
		"content-type": "application/json",
		authorization: `Bearer ${token}`,
		"x-signet-agent-id": agent,
	});
	const noAuth = await fetch(`${first.origin}/api/reflections/missing/answer`, { method: "POST", body: "{}" });
	expect(noAuth.status).toBe(401);
	for (const body of ["{", JSON.stringify({ answer: "   " })])
		expect(
			(
				await fetch(`${first.origin}/api/reflections/missing/answer`, {
					method: "POST",
					headers: headers(modify),
					body,
				})
			).status,
		).toBe(400);
	expect(
		(
			await fetch(`${first.origin}/api/reflections/missing/answer`, {
				method: "POST",
				headers: headers(modify),
				body: JSON.stringify({ answer: "x".repeat(10001) }),
			})
		).status,
	).toBe(413);
	expect(
		(
			await fetch(`${first.origin}/api/reflections/missing/answer`, {
				method: "POST",
				headers: headers(modify),
				body: JSON.stringify({ answer: "x" }),
			})
		).status,
	).toBe(404);
	expect(
		(
			await fetch(`${first.origin}/api/reflections/missing/answer`, {
				method: "POST",
				headers: headers(readonly),
				body: JSON.stringify({ answer: "x" }),
			})
		).status,
	).toBe(403);
	expect(
		(
			await fetch(`${first.origin}/api/reflections/missing/answer`, {
				method: "POST",
				headers: { ...headers(modify), "x-signet-agent": "other" },
				body: JSON.stringify({ answer: "x" }),
			})
		).status,
	).toBe(400);
	expect(
		(
			await fetch(`${first.origin}/api/sources`, {
				headers: { ...headers(modify), "x-workspace-id": "other", "x-signet-workspace-id": "workspace" },
			})
		).status,
	).toBe(400);
	await stop(first.child);
	const reflectionId = crypto.randomUUID();
	fixture(dir, reflectionId, agent);
	const running = await start(dir, port);
	const answer = await fetch(`${running.origin}/api/reflections/${reflectionId}/answer`, {
		method: "POST",
		headers: headers(modify),
		body: JSON.stringify({ answer: "  Trimmed native answer.  " }),
	});
	expect(answer.status).toBe(200);
	const answerBody = await answer.json();
	expect(answerBody).toMatchObject({ success: true });
	expect(typeof answerBody.memoryId).toBe("string");
	const list = await fetch(`${running.origin}/api/reflections?agentId=${agent}`, { headers: headers(modify) });
	expect(list.status).toBe(200);
	const listed = await list.json();
	expect(listed.reflections).toHaveLength(1);
	expect(listed.reflections[0]).toMatchObject({
		answer: "Trimmed native answer.",
		answerMemoryId: answerBody.memoryId,
	});
	const memories = await fetch(`${running.origin}/api/memories?agentId=${agent}&limit=100`, {
		headers: headers(modify),
	});
	expect(memories.status).toBe(200);
	const memory = (await memories.json()).memories.find(
		(item: Record<string, unknown>) => item.id === answerBody.memoryId,
	);
	expect(memory).toMatchObject({
		content: "Trimmed native answer.",
		agent_id: agent,
		sourceType: "reflection-answer",
		sourceId: reflectionId,
	});
	const second = await fetch(`${running.origin}/api/reflections/${reflectionId}/answer`, {
		method: "POST",
		headers: headers(modify),
		body: JSON.stringify({ answer: "Second" }),
	});
	expect(second.status).toBe(409);
	const adminToken = await issue("admin", { agent });
	const disabled = await fetch(`${running.origin}/api/reflections/generate?agentId=${agent}`, {
		method: "POST",
		headers: headers(adminToken),
	});
	expect(disabled.status).toBe(400);
	await stop(running.child);
	await Bun.write(join(dir, "agent.yaml"), "memory:\n  pipelineV2:\n    reflections:\n      enabled: true\n");
	const enabled = await start(dir, port);
	const generated = await fetch(`${enabled.origin}/api/reflections/generate?agentId=${agent}`, {
		method: "POST",
		headers: headers(adminToken),
	});
	expect(generated.status).toBe(400);
});
