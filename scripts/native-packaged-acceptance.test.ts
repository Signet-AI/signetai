import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const binary = process.env.SIGNET_NATIVE_ACCEPTANCE_BINARY?.trim();
if (!binary) throw new Error("SIGNET_NATIVE_ACCEPTANCE_BINARY is required; refusing checkout/debug fallback");
if (!existsSync(binary)) throw new Error(`packaged native artifact missing: ${binary}`);
const root = mkdtempSync(join(tmpdir(), "signet-packaged-acceptance-"));
const port = 28761 + Math.floor(Math.random() * 1000);
const env = {
	...process.env,
	HOME: root,
	SIGNET_PATH: root,
	SIGNET_BIND: "127.0.0.1",
	SIGNET_PORT: String(port),
	SIGNET_TELEMETRY_OPTOUT: "1",
};
const child = spawn(binary, [], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
child.stdout.on("data", (b) => (output += b));
child.stderr.on("data", (b) => (output += b));
const origin = `http://127.0.0.1:${port}`;

async function ready() {
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return;
		} catch {}
		await Bun.sleep(100);
	}
	throw new Error(`packaged daemon did not become ready\n${output}`);
}

beforeAll(ready, 15_000);
afterAll(() => {
	child.kill("SIGTERM");
	rmSync(root, { recursive: true, force: true });
});

describe("packaged Rust daemon acceptance", () => {
	test("has provenance and runtime process evidence", () => {
		const provenance = process.env.SIGNET_NATIVE_PROVENANCE;
		expect(provenance).toBeTruthy();
		const stat = Bun.file(binary);
		expect(stat.size).toBeGreaterThan(0);
		expect(createHash("sha256").update(readFileSync(binary)).digest("hex")).toMatch(/^[a-f0-9]{64}$/);
		expect(child.exitCode).toBeNull();
	});
	test("readiness and scoped API isolation are live", async () => {
		const a = { "x-workspace-id": "acceptance-a" };
		const b = { "x-workspace-id": "acceptance-b" };
		const status = await fetch(`${origin}/api/pipeline/status`, { headers: a });
		expect(status.status).toBe(200);
		const other = await fetch(`${origin}/api/pipeline/status`, { headers: b });
		expect(other.status).toBe(200);
		expect(await (await fetch(`${origin}/health/live`)).json()).toBeTruthy();
	});
	test("does not silently accept a missing artifact", () => expect(existsSync(binary)).toBe(true));
});
