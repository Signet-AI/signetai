import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const artifact = process.env.SIGNET_NATIVE_ACCEPTANCE_BINARY?.trim();
const provenancePath = process.env.SIGNET_NATIVE_PROVENANCE?.trim();
if (!artifact || !provenancePath) throw new Error("packaged artifact and provenance are required");
if (!existsSync(artifact) || !existsSync(provenancePath)) throw new Error("packaged artifact/provenance missing");
const provenance = JSON.parse(readFileSync(provenancePath, "utf8")) as {
	artifact: string;
	target: string;
	sha256: string;
	sourceRevision: string;
};
const checksum = createHash("sha256").update(readFileSync(artifact)).digest("hex");
if (provenance.sha256 !== checksum) throw new Error(`artifact checksum mismatch: ${checksum} != ${provenance.sha256}`);
if (!provenance.sourceRevision || !provenance.target) throw new Error("incomplete artifact provenance");
const staged = mkdtempSync(join(tmpdir(), "signet-packaged-outside-checkout-"));
const binary = join(staged, basename(artifact));
await Bun.write(binary, Bun.file(artifact));
chmodSync(binary, 0o755);
const root = mkdtempSync(join(tmpdir(), "signet-packaged-workspace-"));
const port = 28761 + Math.floor(Math.random() * 1000);
const origin = `http://127.0.0.1:${port}`;
const cleanPath = "/usr/bin:/bin";
const childEnv = {
	HOME: root,
	PATH: cleanPath,
	SIGNET_MODE: "local",
	SIGNET_PATH: root,
	SIGNET_BIND: "127.0.0.1",
	SIGNET_PORT: String(port),
	SIGNET_TELEMETRY_OPTOUT: "1",
};
const child = Bun.spawn([binary], { cwd: staged, env: childEnv, stdout: "pipe", stderr: "pipe" });
let output = "";
(async () => {
	output += await new Response(child.stdout).text();
})();
(async () => {
	output += await new Response(child.stderr).text();
})();
async function ready() {
	for (let i = 0; i < 150; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return;
		} catch {}
		await Bun.sleep(100);
	}
	throw new Error(`packaged daemon did not become ready\n${output}`);
}
async function stop() {
	child.kill("SIGTERM");
	await Promise.race([child.exited, Bun.sleep(3000)]);
}
async function remember(agent: string, content: string) {
	const response = await fetch(`${origin}/api/memory/remember`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-signet-agent": agent, "x-workspace-id": agent },
		body: JSON.stringify({ content }),
	});
	expect(response.status).toBe(201);
	return (await response.json()) as { id: string };
}

beforeAll(ready, 20_000);
afterAll(async () => {
	if (child.exitCode === null) await stop();
	rmSync(root, { recursive: true, force: true });
	rmSync(staged, { recursive: true, force: true });
});

describe("shipped packaged Rust executable", () => {
	test("records exact target, revision, checksum, and runs outside checkout without Bun/Node", () => {
		expect(provenance.artifact).toBe(resolve(artifact));
		expect(provenance.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(child.exitCode).toBeNull();
		if (process.platform === "linux") {
			const childEnvironment = readFileSync(`/proc/${child.pid}/environ`, "utf8");
			expect(childEnvironment).toContain(`PATH=${cleanPath}\u0000`);
			expect(childEnvironment).not.toContain("BUN_INSTALL=");
			expect(childEnvironment).not.toContain("NODE_PATH=");
		}
		expect(dirname(binary)).not.toContain("/signetai/");
	});
	test("performs scoped write/read and isolates another workspace", async () => {
		const created = await remember("acceptance-a", "packaged durable memory");
		const own = await fetch(`${origin}/api/memory/${created.id}`, {
			headers: { "x-signet-agent": "acceptance-a", "x-workspace-id": "acceptance-a" },
		});
		expect(own.status).toBe(200);
		expect((await own.json()).content).toBe("packaged durable memory");
		const other = await fetch(`${origin}/api/memory/${created.id}`, {
			headers: { "x-signet-agent": "acceptance-b", "x-workspace-id": "acceptance-b" },
		});
		expect(other.status).toBe(404);
	});
	test("persists through stop/restart and upgrades an existing workspace", async () => {
		const created = await remember("restart-a", "survives packaged restart");
		await stop();
		const restarted = Bun.spawn([binary], {
			cwd: staged,
			env: { ...childEnv, SIGNET_PORT: String(port + 1) },
			stdout: "ignore",
			stderr: "pipe",
		});
		const restartedOrigin = `http://127.0.0.1:${port + 1}`;
		for (let i = 0; i < 100; i++) {
			try {
				if ((await fetch(`${restartedOrigin}/health/ready`)).ok) break;
			} catch {}
			await Bun.sleep(100);
		}
		const read = await fetch(`${restartedOrigin}/api/memory/${created.id}`, {
			headers: { "x-signet-agent": "restart-a", "x-workspace-id": "restart-a" },
		});
		expect(read.status).toBe(200);
		expect((await read.json()).content).toBe("survives packaged restart");
		restarted.kill("SIGTERM");
		await restarted.exited;
		expect(readdirSync(root)).toContain("memory");
	});
	test("exercises the shipped database-owner child protocol and recovery evidence", async () => {
		const owner = Bun.spawn([binary, "--db-owner"], {
			cwd: staged,
			env: childEnv,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const reader = owner.stdout.getReader();
		const first = new TextDecoder().decode((await reader.read()).value);
		expect(first).toMatch(/"ready":true/);
		expect(owner.pid).toBeGreaterThan(0);
		owner.kill("SIGTERM");
		await owner.exited;
		expect(existsSync(`/proc/${owner.pid}/fd`)).toBe(false);
	});
});
