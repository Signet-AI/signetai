/* biome-ignore-all lint/suspicious/noUndeclaredEnvVars: native contract harness */
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binary = process.env.SIGNET_RUST_DAEMON_BIN;
if (!binary) throw new Error("SIGNET_RUST_DAEMON_BIN is required; native contract must not be skipped");
const apiKey = "native-secret-contract-key";
type Json = Record<string, unknown>;
const iso = (v: unknown) => expect(typeof v === "string" && !Number.isNaN(Date.parse(v))).toBe(true);
async function json(response: Response): Promise<Json> {
	const text = await response.text();
	try {
		return JSON.parse(text) as Json;
	} catch {
		throw new Error(`non-JSON response (${response.status}): ${text}`);
	}
}
async function stop(child: Bun.Subprocess) {
	child.kill("SIGTERM");
	await Promise.race([child.exited, Bun.sleep(1000)]);
	if (!child.killed) child.kill("SIGKILL");
	await child.exited;
}

test("fresh exact daemon implements the supplementary secrets exec HTTP contract", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "signet-native-secrets-"));
	const reservation = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {}, close() {} } });
	const port = reservation.port;
	reservation.stop();
	const stdout = Bun.file(join(workspace, "daemon.stdout.log"));
	const stderr = Bun.file(join(workspace, "daemon.stderr.log"));
	const child = Bun.spawn([binary], {
		cwd: process.cwd(),
		env: {
			...process.env,
			SIGNET_PATH: workspace,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_MODE: "test",
			SIGNET_PORT: String(port),
			SIGNET_API_KEY: apiKey,
		},
		stdout,
		stderr,
	});
	const origin = `http://127.0.0.1:${port}`;
	const headers = (agent = "native-contract", scope = "native-contract") => ({
		authorization: `Bearer ${apiKey}`,
		"content-type": "application/json",
		"x-signet-agent-id": agent,
		"x-signet-workspace-id": scope,
	});
	const request = (path: string, init?: RequestInit) => fetch(`${origin}${path}`, init);
	const post = (body: unknown, h = headers()) =>
		request("/api/secrets/exec", { method: "POST", headers: h, body: JSON.stringify(body) });
	try {
		for (let i = 0; i < 240; i++) {
			try {
				if ((await request("/health/ready")).ok) break;
			} catch {}
			if (i === 239) throw new Error("daemon readiness timeout");
			await Bun.sleep(25);
		}
		const owner = headers();
		const created = await request("/api/secrets", {
			method: "POST",
			headers: owner,
			body: JSON.stringify({ name: "contract_secret", value: "native-secret-value" }),
		});
		expect(created.status).toBe(201);
		expect((await request("/api/secrets/exec", { method: "POST", body: "{}" })).status).toBe(401);
		for (const body of [
			{ command: "", secrets: { VALUE: "contract_secret" } },
			{ command: "   ", secrets: { VALUE: "contract_secret" } },
			{ command: "printf ok", secrets: {} },
			{ command: "printf ok", secrets: [] },
			{ command: "printf ok", secrets: "contract_secret" },
			{ command: "echo hi; id", secrets: { VALUE: "contract_secret" } },
			{ command: "echo $VALUE", secrets: { VALUE: "contract_secret" } },
		])
			expect((await post(body)).status).toBe(400);
		async function poll(id: string, h = owner) {
			for (let i = 0; i < 120; i++) {
				const r = await request(`/api/secrets/exec/${id}`, { headers: h });
				const b = await json(r);
				if (b.status === "completed" || b.status === "failed") return b;
				await Bun.sleep(25);
			}
			throw new Error(`job ${id} remained pending`);
		}
		const queued = await post({ command: "printenv VALUE", secrets: { VALUE: "contract_secret" }, timeoutMs: 1000 });
		expect(queued.status).toBe(202);
		const q = await json(queued);
		expect(q).toMatchObject({ status: "queued", timeoutMs: 1000 });
		expect(typeof q.id).toBe("string");
		iso(q.createdAt);
		expect(JSON.stringify(q)).not.toContain("native-secret-value");
		const done = await poll(q.id);
		expect(["completed", "failed"]).toContain(done.status);
		iso(done.createdAt);
		iso(done.startedAt);
		iso(done.completedAt);
		expect(done.result.code).toBe(0);
		expect(done.result.stdout).toBe("[REDACTED]\n");
		expect(typeof done.result.stderr).toBe("string");
		expect(JSON.stringify(done)).not.toContain("native-secret-value");
		const boundary = await post({
			command: `python3 -c 'import os; print("X"+os.environ["VALUE"], end="")'`,
			secrets: { VALUE: "contract_secret" },
			timeoutMs: 1000,
			maxOutputBytes: 8,
		});
		expect(boundary.status).toBe(202);
		const boundaryJob = await json(boundary);
		expect(typeof boundaryJob.id).toBe("string");
		const boundaryDone = await poll(boundaryJob.id as string);
		expect(boundaryDone.status).toBe("completed");
		const boundaryResult = boundaryDone.result as { stdout?: unknown; truncated?: unknown };
		expect(boundaryResult.truncated).toBe(true);
		expect(String(boundaryResult.stdout)).not.toContain("native-");
		expect(String(boundaryResult.stdout)).not.toContain("secret-value");
		expect(JSON.stringify(boundaryDone)).not.toContain("native-secret-value");
		expect((await request("/api/secrets/exec/does-not-exist", { headers: owner })).status).toBe(404);
		const missing = await post({
			command: "printenv VALUE",
			secrets: { VALUE: "missing_secret_name" },
			timeoutMs: 1000,
		});
		const missingDone = await poll((await json(missing)).id);
		expect(missingDone.status).toBe("failed");
		expect(missingDone.error).toBe("secret resolution failed");
		expect(JSON.stringify(missingDone)).not.toContain("missing_secret_name");
		const wrong = headers("other-agent", "other-workspace");
		const ownedJob = await post({
			command: "printenv VALUE",
			secrets: { VALUE: "contract_secret" },
			timeoutMs: 1000,
		});
		expect(ownedJob.status).toBe(202);
		const ownedJobBody = await json(ownedJob);
		expect(typeof ownedJobBody.id).toBe("string");
		const crossScope = await request(`/api/secrets/exec/${ownedJobBody.id as string}`, { headers: wrong });
		expect(crossScope.status).toBe(403);
		const ownedJobDone = await poll(ownedJobBody.id as string, owner);
		expect(ownedJobDone.status).toBe("completed");
		const denied = await post(
			{ command: "printenv VALUE", secrets: { VALUE: "contract_secret" }, timeoutMs: 1000 },
			wrong,
		);
		expect(denied.status).toBe(202);
		const deniedDone = await poll((await json(denied)).id, wrong);
		expect(deniedDone.status).toBe("failed");
		expect(JSON.stringify(deniedDone)).not.toContain("native-secret-value");
		const timeout = await post({ command: "sleep 2", secrets: { VALUE: "contract_secret" }, timeoutMs: 1000 });
		const timed = await poll((await json(timeout)).id);
		expect(timed.status).toBe("failed");
		expect(timed.result.timedOut).toBe(true);
		expect(timed.result.stderr).toContain("timed out");
		const large = await post({
			command: "head -c 1100000 /dev/zero",
			secrets: { VALUE: "contract_secret" },
			timeoutMs: 1000,
		});
		const capped = await poll((await json(large)).id);
		expect(capped.result.truncated).toBe(true);
		expect(capped.result.stdout.length).toBeLessThanOrEqual(1_048_576 + 64);
		expect(capped.result.stdout).toContain("[signet secret exec: stdout truncated]");
	} catch (error) {
		const logs = `\n--- stdout ---\n${await readFile(stdout, "utf8").catch(() => "")}\n--- stderr ---\n${await readFile(stderr, "utf8").catch(() => "")}`;
		throw new Error(`${error instanceof Error ? error.message : String(error)}${logs}`);
	} finally {
		await stop(child).catch(() => undefined);
		await rm(workspace, { recursive: true, force: true });
	}
});
