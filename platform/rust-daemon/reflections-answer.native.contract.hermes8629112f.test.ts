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
afterEach(async () => {
	for (const c of children.splice(0)) await stop(c);
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

it("requires a real native binary and preserves reflection answer boundaries", async () => {
	const dir = mkdtempSync(join(tmpdir(), "signet-reflection-answer-"));
	dirs.push(dir);
	const { origin } = await start(dir, reserve());
	const noAuth = await fetch(`${origin}/api/reflections/missing/answer`, { method: "POST", body: "{}" });
	expect(noAuth.status).toBe(401);
	const headers = {
		"content-type": "application/json",
		"x-signet-api-key": "reflection-key",
		"x-signet-agent-id": "reflection-contract",
	};
	for (const body of ["{", JSON.stringify({ answer: "   " })])
		expect((await fetch(`${origin}/api/reflections/missing/answer`, { method: "POST", headers, body })).status).toBe(
			400,
		);
	expect(
		(
			await fetch(`${origin}/api/reflections/missing/answer`, {
				method: "POST",
				headers,
				body: JSON.stringify({ answer: "x".repeat(10001) }),
			})
		).status,
	).toBe(413);
	expect(
		(
			await fetch(`${origin}/api/reflections/missing/answer`, {
				method: "POST",
				headers,
				body: JSON.stringify({ answer: "x" }),
			})
		).status,
	).toBe(404);
});
