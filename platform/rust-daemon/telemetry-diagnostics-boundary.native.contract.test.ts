import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";

const root = import.meta.dir;
const binary = `${root}/target/debug/signet-daemon`;
const dir = `/tmp/signet-boundary-${process.pid}-${randomBytes(4).toString("hex")}`;
let port = 0;
let secret = Buffer.alloc(0);
let child: Bun.Subprocess;
const b64 = (v: string) => Buffer.from(v).toString("base64url");
function token(role = "admin", permissions = ["diagnostics", "analytics"]) {
	const payload = b64(
		JSON.stringify({
			sub: "boundary",
			role,
			permissions,
			scope: { agent: "default", workspace: "default" },
			iat: Math.floor(Date.now() / 1000),
			exp: Math.floor(Date.now() / 1000) + 3600,
		}),
	);
	return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}
async function waitFor(url: string) {
	for (let i = 0; i < 200; i++) {
		try {
			const response = await fetch(url);
			if (response.status > 0) return;
		} catch {}
		await Bun.sleep(25);
	}
	throw new Error("daemon did not start");
}

describe("fresh Rust telemetry and diagnostics boundary", () => {
	beforeAll(async () => {
		await rm(dir, { recursive: true, force: true });
		const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {}, close() {} } });
		port = probe.port;
		probe.stop();
		child = Bun.spawn([binary], {
			cwd: root,
			env: { PATH: process.env.PATH ?? "", SIGNET_PATH: dir, SIGNET_BIND: "127.0.0.1", SIGNET_PORT: String(port) },
			stdout: "ignore",
			stderr: "pipe",
		});
		await waitFor(`http://127.0.0.1:${port}/health/live`);
		secret = await readFile(`${dir}/.daemon/auth-secret`);
	});
	afterAll(async () => {
		child.kill("SIGTERM");
		await child.exited;
		await rm(dir, { recursive: true, force: true });
	});
	test("preserves diagnostic sample bounds and explicit unsupported telemetry", async () => {
		const headers = { authorization: `Bearer ${token()}` };
		const tooLarge = await fetch(
			`http://127.0.0.1:${port}/api/diagnostics/database/tables/schema_migrations/sample?limit=101`,
			{ headers },
		);
		expect(tooLarge.status).toBe(400);
		const unsupported = await fetch(`http://127.0.0.1:${port}/api/telemetry/export`, { headers });
		expect(unsupported.status).toBe(501);
		const body = (await unsupported.json()) as { code?: string; message?: string };
		expect(body.code).toBe("unsupported");
		expect(JSON.stringify(body)).toContain("unsupported_marker");
	});
});
