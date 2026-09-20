import { describe, expect, it } from "bun:test";
describe("fresh native secrets alias and response contract", () => {
	it("rejects conflicting aliases and preserves active SDK envelopes", async () => {
		const bin = process.env.SIGNET_RUST_DAEMON_BIN ?? `${process.cwd()}/platform/rust-daemon/target/debug/signet-daemon`;
		const root = await import("node:fs").then(({ mkdtempSync }) => mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/signet-secret-contract-`));
		const port = 40000 + Math.floor(Math.random() * 20000); const key = crypto.randomUUID();
		const child = Bun.spawn([bin], { env: { ...process.env, SIGNET_PATH: root, SIGNET_BIND: "127.0.0.1", SIGNET_PORT: String(port), SIGNET_API_KEY: key }, stdout: "ignore", stderr: "ignore" });
		const origin = `http://127.0.0.1:${port}`; try {
			for (let i = 0; i < 160 && !(await fetch(`${origin}/health/ready`).then((r) => r.ok).catch(() => false)); i++) await Bun.sleep(25);
			const h = { authorization: `Bearer ${key}`, "content-type": "application/json", "x-signet-agent": "agent-contract", "x-signet-workspace-id": "workspace-contract" };
			const auth = await fetch(`${origin}/api/auth/api-keys`, { method: "POST", headers: h, body: JSON.stringify({ name: "secrets-contract", role: "admin", scope: { agent: "agent-contract", workspace: "workspace-contract" }, permissions: ["secrets:list", "secrets:write", "secrets:delete"] }) }); expect(auth.status).toBe(201); const credential = (await auth.json()).apiKey.key;
			const conflict = await fetch(`${origin}/api/secrets`, { headers: { authorization: `Bearer ${credential}`, "x-signet-agent-id": "agent-contract", "x-signet-agent": "other-agent", "x-signet-workspace-id": "workspace-contract" } }); expect(conflict.status).toBe(400);
			const s = { authorization: `Bearer ${credential}`, "content-type": "application/json", "x-signet-agent-id": "agent-contract", "x-signet-workspace-id": "workspace-contract" };
			const list = await fetch(`${origin}/api/secrets`, { headers: s }); expect(list.status).toBe(200); expect(await list.json()).toMatchObject({ secrets: [], provider: "local" });
			const put = await fetch(`${origin}/api/secrets/contract-name`, { method: "POST", headers: s, body: JSON.stringify({ value: "harmless-value" }) }); expect(put.status).toBe(201); expect(await put.json()).toEqual({ success: true, name: "contract-name" });
			const del = await fetch(`${origin}/api/secrets/contract-name`, { method: "DELETE", headers: s }); expect(del.status).toBe(200); expect(await del.json()).toEqual({ success: true, name: "contract-name" });
		} finally { child.kill("SIGTERM"); await child.exited; (await import("node:fs")).rmSync(root, { recursive: true, force: true }); }
	});
});
