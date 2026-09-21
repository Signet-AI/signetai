import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
// biome-ignore lint/suspicious/noUndeclaredEnvVars: native contract binary override
const binary = process.env.SIGNET_RUST_DAEMON_BIN ?? join(root, "platform/rust-daemon/target/debug/signet-daemon");
const children: Bun.Subprocess[] = [];
const dirs: string[] = [];
const reserve = () => {
	const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {}, close() {} } });
	const port = server.port;
	server.stop();
	return port;
};
async function start(dir: string, port: number) {
	const stdout = join(dir, "daemon.stdout.log");
	const stderr = join(dir, "daemon.stderr.log");
	const child = Bun.spawn([binary], {
		cwd: root,
		env: {
			...process.env,
			SIGNET_PATH: dir,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
			SIGNET_API_KEY: "reflection-key",
		},
		stdout: Bun.file(stdout),
		stderr: Bun.file(stderr),
	});
	children.push(child);
	const origin = `http://127.0.0.1:${port}`;
	for (let attempt = 0; attempt < 240; attempt++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return { child, origin };
		} catch {
			/* daemon is still starting */
		}
		await Bun.sleep(25);
	}
	throw new Error(`readiness timeout\nstdout=${readFileSync(stdout, "utf8")}\nstderr=${readFileSync(stderr, "utf8")}`);
}
async function stop(child: Bun.Subprocess) {
	if (!child.killed) child.kill("SIGTERM");
	await Promise.race([child.exited, Bun.sleep(1000)]);
	if (!child.killed) child.kill("SIGKILL");
	await child.exited;
}
function auth(token: string, extra: Record<string, string> = {}) {
	return {
		...extra,
		"content-type": "application/json",
		authorization: `Bearer ${token}`,
		"x-signet-agent-id": "reflection-contract",
	};
}

afterEach(async () => {
	for (const child of children.splice(0)) await stop(child);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("proves native reflection generation contract end to end", async () => {
	const dir = mkdtempSync(join(tmpdir(), "signet-reflection-generation-"));
	dirs.push(dir);
	await Bun.write(
		join(dir, "agent.yaml"),
		"memory:\n  pipelineV2:\n    reflections:\n      enabled: false\n      model: contract-model\n      count: 3\n      timeout: 2000\n      maxTokens: 321\n",
	);
	const providerRequests: Record<string, unknown>[] = [];
	let providerFails = false;
	const provider = Bun.serve({
		port: 0,
		fetch: async (request) => {
			if (providerFails) return new Response("provider unavailable", { status: 503 });
			const body = (await request.json()) as Record<string, unknown>;
			providerRequests.push(body);
			return Response.json({
				choices: [
					{
						message: {
							content: JSON.stringify({
								entries: [
									{
										summary: "A generated reflection",
										question: "What changed?",
										memoryIds: ["memory-1"],
										contentKey: "contract-key",
										provenance: { source: "native-contract", provider: "stub" },
									},
								],
							}),
						},
					},
				],
			});
		},
	});
	const port = reserve();
	// biome-ignore lint/suspicious/noUndeclaredEnvVars: native contract provider override
	const previousBaseUrl = process.env.SIGNET_OPENAI_BASE_URL;
	// biome-ignore lint/suspicious/noUndeclaredEnvVars: native contract provider override
	const previousModel = process.env.SIGNET_OPENAI_MODEL;
	// biome-ignore lint/suspicious/noUndeclaredEnvVars: native contract provider override
	process.env.SIGNET_OPENAI_BASE_URL = `http://127.0.0.1:${provider.port}`;
	// biome-ignore lint/suspicious/noUndeclaredEnvVars: native contract provider override
	process.env.SIGNET_OPENAI_MODEL = "contract-model";
	try {
		const running = await start(dir, port);
		const issue = async (role: string, permissions: string[] = []) => {
			const response = await fetch(`${running.origin}/api/auth/token`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-signet-api-key": "reflection-key" },
				body: JSON.stringify({ role, scope: { agent: "reflection-contract" }, permissions }),
			});
			expect(response.status).toBe(200);
			return ((await response.json()) as { token: string }).token;
		};
		const admin = await issue("admin");
		const readonly = await issue("readonly", ["recall"]);
		const unauthenticated = await fetch(`${running.origin}/api/reflections/generate?agentId=reflection-contract`, {
			method: "POST",
		});
		expect(unauthenticated.status).toBe(401);
		const denied = await fetch(`${running.origin}/api/reflections/generate?agentId=reflection-contract`, {
			method: "POST",
			headers: auth(readonly),
		});
		expect(denied.status).toBe(403);
		const disabled = await fetch(`${running.origin}/api/reflections/generate?agentId=reflection-contract`, {
			method: "POST",
			headers: auth(admin),
		});
		expect(disabled.status).toBe(400);

		await stop(running.child);
		await Bun.write(
			join(dir, "agent.yaml"),
			"memory:\n  pipelineV2:\n    reflections:\n      enabled: true\n      model: contract-model\n      count: 3\n      timeout: 2000\n      maxTokens: 321\n",
		);
		const enabled = await start(dir, port);
		const generated = await fetch(`${enabled.origin}/api/reflections/generate?agentId=reflection-contract&count=99`, {
			method: "POST",
			headers: auth(admin),
		});
		expect(generated.status).toBe(200);
		expect(await generated.json()).toMatchObject({
			generated: 1,
			reflection: expect.any(Object),
			reflections: expect.any(Array),
		});
		expect(providerRequests).toHaveLength(1);
		expect(providerRequests[0]).toMatchObject({
			model: "contract-model",
			max_tokens: 321,
			messages: expect.any(Array),
		});

		const listed = await fetch(`${enabled.origin}/api/reflections?agentId=reflection-contract`, {
			headers: auth(admin),
		});
		expect(listed.status).toBe(200);
		const rows = ((await listed.json()) as { reflections: Record<string, unknown>[] }).reflections;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			model: "contract-model",
			date: expect.any(String),
			contentKey: "contract-key",
			memoryIds: ["memory-1"],
			provenance: { source: "native-contract", provider: "stub" },
		});

		const defaultCount = await fetch(`${enabled.origin}/api/reflections/generate?agentId=reflection-contract&count=0`, {
			method: "POST",
			headers: auth(admin),
		});
		expect(defaultCount.status).toBe(200);
		expect(providerRequests).toHaveLength(2);
		providerFails = true;
		const beforeFailure = rows.length;
		const failed = await fetch(`${enabled.origin}/api/reflections/generate?agentId=reflection-contract&count=2`, {
			method: "POST",
			headers: auth(admin),
		});
		expect(failed.status).toBe(500);
		const afterFailure = (await (
			await fetch(`${enabled.origin}/api/reflections?agentId=reflection-contract`, { headers: auth(admin) })
		).json()) as { reflections: unknown[] };
		expect(afterFailure.reflections).toHaveLength(beforeFailure);
	} finally {
		provider.stop();
		// biome-ignore lint/suspicious/noUndeclaredEnvVars: native contract provider override
		if (previousBaseUrl === undefined) delete process.env.SIGNET_OPENAI_BASE_URL;
		else process.env.SIGNET_OPENAI_BASE_URL = previousBaseUrl;
		// biome-ignore lint/suspicious/noUndeclaredEnvVars: native contract provider override
		if (previousModel === undefined) delete process.env.SIGNET_OPENAI_MODEL;
		else process.env.SIGNET_OPENAI_MODEL = previousModel;
	}
});
