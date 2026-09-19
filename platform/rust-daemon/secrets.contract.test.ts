/* biome-ignore-all lint/suspicious/noExplicitAny: dynamic JSON contract payloads */
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const bin =
	process.env.SIGNET_RUST_DAEMON_BIN ?? join(process.cwd(), "platform/rust-daemon/target/debug/signet-daemon");
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
type D = { origin: string; child: ReturnType<typeof Bun.spawn>; root: string; stderr: string[]; credential: string };
let assertions = 0;
function check<T>(actual: T, expected: T) {
	assertions++;
	expect(actual).toEqual(expected);
}
async function start(root = mkdtempSync(join(tmpdir(), "signet-secrets-"))): Promise<D> {
	if (!existsSync(bin)) throw new Error("native daemon binary is missing");
	const port = 40000 + Math.floor(Math.random() * 20000),
		credential = random(),
		stderr: string[] = [];
	const child = Bun.spawn([bin], {
		env: {
			...process.env,
			SIGNET_PATH: root,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
			SIGNET_API_KEY: credential,
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	const reader = child.stderr.getReader();
	void (async () => {
		const decoder = new TextDecoder();
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			stderr.push(decoder.decode(next.value));
		}
	})();
	const origin = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 160; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return { origin, child, root, stderr, credential };
		} catch {}
		await Bun.sleep(25);
	}
	child.kill("SIGTERM");
	await child.exited;
	throw new Error("native daemon readiness failed");
}
async function request(
	d: D,
	path: string,
	init: RequestInit = {},
	credential?: string,
	agent = "agent-a",
	workspace = "workspace-a",
) {
	const response = await fetch(d.origin + path, {
		...init,
		headers: {
			...(credential ? { authorization: `Bearer ${credential}` } : {}),
			"x-signet-agent-id": agent,
			"x-signet-workspace-id": workspace,
			"content-type": "application/json",
			...init.headers,
		},
	});
	const text = await response.text();
	let body: any = {};
	try {
		body = JSON.parse(text);
	} catch {}
	return { response, text, body };
}
async function stop(d: D) {
	d.child.kill("SIGTERM");
	check(await d.child.exited, 0);
	try {
		await fetch(`${d.origin}/health/ready`);
		throw new Error("listener remained after SIGTERM");
	} catch {}
}

describe("fresh native local-secrets contract", () => {
	it("enforces authority, scope, persistence, validation, and unsupported boundaries", async () => {
		let d = await start();
		const agent = "agent-" + random(),
			workspace = "workspace-" + random(),
			name = "name-" + random(),
			value = "value-" + random();
		try {
			check((await request(d, "/api/secrets")).response.status, 401);
			const headers = { authorization: `Bearer ${d.credential}` };
			const list = () => request(d, "/api/secrets", { headers }, d.credential, agent, workspace);
			const created = await request(
				d,
				"/api/secrets",
				{ method: "POST", body: JSON.stringify({ name, value }) },
				d.credential,
				agent,
				workspace,
			);
			check(created.response.status, 201);
			expect(created.text).not.toContain(value);
			expect(created.body).not.toHaveProperty("value");
			assertions += 2;
			check((await list()).response.status, 200);
			expect(JSON.stringify((await list()).body)).not.toContain(value);
			assertions++;
			const updatedValue = "value-" + random();
			const updated = await request(
				d,
				`/api/secrets/${encodeURIComponent(name)}`,
				{ method: "POST", body: JSON.stringify({ value: updatedValue }) },
				d.credential,
				agent,
				workspace,
			);
			check(updated.response.status, 201);
			expect(updated.text).not.toContain(updatedValue);
			assertions++;
			check((await request(d, "/api/secrets", {}, d.credential, `${agent}-other`, workspace)).body.items, []);
			check((await request(d, "/api/secrets", {}, d.credential, agent, `${workspace}-other`)).body.items, []);
			check(
				(
					await request(
						d,
						"/api/secrets",
						{ headers: { authorization: `Bearer ${d.credential}` } },
						d.credential,
						agent,
						workspace,
					)
				).response.status,
				200,
			);
			check((await request(d, "/api/secrets?limit=0", {}, d.credential, agent, workspace)).response.status, 400);
			check((await request(d, "/api/secrets?limit=101", {}, d.credential, agent, workspace)).response.status, 400);
			for (const [index, body] of [
				{ name: "", value: "x" },
				{ name, value: "" },
				{ name: " ", value: "x" },
				{ name, value: "x".repeat(65537) },
			].entries()) {
				const status = (
					await request(
						d,
						"/api/secrets",
						{ method: "POST", body: JSON.stringify(body) },
						d.credential,
						agent,
						workspace,
					)
				).response.status;
				if (status < 400) throw new Error(`invalid input index ${index} was accepted`);
				assertions++;
			}
			check(
				(await request(d, "/api/secrets", { method: "POST", body: "{" }, d.credential, agent, workspace)).response
					.status >= 400,
				true,
			);
			check(
				(await request(d, "/api/secrets/exec", { method: "POST" }, d.credential, agent, workspace)).response.status,
				501,
			);
			check(
				(await request(d, `/api/secrets/${name}/exec`, { method: "POST" }, d.credential, agent, workspace)).response
					.status,
				501,
			);
			for (const provider of ["1password", "bitwarden"])
				check(
					(await request(d, `/api/secrets/${provider}/items`, {}, d.credential, agent, workspace)).response.status,
					501,
				);
			await stop(d);
			d = await start(d.root);
			check((await request(d, "/api/secrets", {}, d.credential, agent, workspace)).response.status, 200);
			check((await request(d, "/api/secrets", {}, d.credential, agent, workspace)).body.items[0].name, name);
			const deleted = await request(d, `/api/secrets/${name}`, { method: "DELETE" }, d.credential, agent, workspace);
			check(deleted.response.status, 200);
			check(
				(await request(d, `/api/secrets/${name}`, { method: "DELETE" }, d.credential, agent, workspace)).response
					.status,
				200,
			);
			expect(d.stderr.join("")).not.toContain(value);
			expect(d.stderr.join("")).not.toContain(updatedValue);
			assertions += 2;
		} finally {
			await stop(d);
			rmSync(d.root, { recursive: true, force: true });
		}
		console.log(`assertions=${assertions}`);
	});
});
