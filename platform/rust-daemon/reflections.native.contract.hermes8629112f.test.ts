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
	const stdout = join(dir, "daemon.stdout.log"),
		stderr = join(dir, "daemon.stderr.log");
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
afterEach(async () => {
	for (const child of children.splice(0)) await stop(child);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("serves authenticated reflection list and today envelopes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "signet-reflections-contract-"));
	dirs.push(dir);
	const running = await start(dir, reserve());
	const agent = "reflection-contract";
	const issue = await fetch(`${running.origin}/api/auth/token`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-signet-api-key": "reflection-key" },
		body: JSON.stringify({ role: "agent", scope: { agent }, permissions: ["recall"] }),
	});
	expect(issue.status).toBe(200);
	const { token } = (await issue.json()) as { token: string };
	const headers = { authorization: "Bearer " + token, "x-signet-agent-id": agent };
	const unauthenticated = await fetch(`${running.origin}/api/reflections?limit=1`, {
		headers: { "x-signet-agent-id": agent },
	});
	expect(unauthenticated.status).toBe(401);
	const noRecallIssue = await fetch(`${running.origin}/api/auth/token`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-signet-api-key": "reflection-key" },
		body: JSON.stringify({ role: "agent", scope: { agent }, permissions: [] }),
	});
	expect(noRecallIssue.status).toBe(200);
	const { token: noRecallToken } = (await noRecallIssue.json()) as { token: string };
	const noRecallHeaders = { authorization: "Bearer " + noRecallToken, "x-signet-agent-id": agent };
	const deniedList = await fetch(`${running.origin}/api/reflections?limit=1`, { headers: noRecallHeaders });
	expect(deniedList.status).toBe(403);
	const deniedToday = await fetch(`${running.origin}/api/reflections/today?limit=1`, { headers: noRecallHeaders });
	expect(deniedToday.status).toBe(403);
	const list = await fetch(`${running.origin}/api/reflections?limit=1`, { headers });
	expect(list.status).toBe(200);
	expect(await list.json()).toEqual({ reflections: [] });
	const today = await fetch(`${running.origin}/api/reflections/today?limit=1`, { headers });
	expect(today.status).toBe(200);
	expect(await today.json()).toMatchObject({ reflection: null, reflections: [] });
});
