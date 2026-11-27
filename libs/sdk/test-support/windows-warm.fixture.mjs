import { test } from "bun:test";
test("windows warm subprocess contract", async () => {
	const { resolveTarget, NodeTransport } = await import("../src/node.ts");
	const { chmod, readFile } = await import("node:fs/promises");
	Object.defineProperty(process, "platform", { value: "win32" });
	const server = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true }) });
	try {
		const url = "http://127.0.0.1:" + server.port;
		const target = await resolveTarget({
			flagUrl: url,
			env: { APPDATA: process.env.HOME, SIGNET_DAEMON_URL: url, SIGNET_API_KEY_FILE: process.env.KEY_FILE },
		});
		if (target.credential.source !== "key-file") throw new Error("key-file credential was not selected");
		const client = new NodeTransport(target, { env: { APPDATA: process.env.HOME } });
		for (let i = 0; i < 20; i++) await client.get("/health");
		await client.flush();
		await client.post("/api/hooks/session-end", { reason: "session_shutdown" });
		const count = async () =>
			(await readFile(process.env.ACL_LEDGER, "utf8"))
				.trim()
				.split("\n")
				.map(JSON.parse)
				.filter((v) => v.action === "spawn").length;
		const cold = await count();
		for (let i = 0; i < 2; i++) await client.post("/api/hooks/session-end", { reason: "session_shutdown" });
		if ((await count()) !== cold) throw new Error("warm deliveries spawned more ACL processes");
		await chmod(process.env.KEY_FILE, 0o644);
		let refused = false;
		let refusal = "no error";
		try {
			await client.get("/health");
		} catch (e) {
			refused = e.code === "credential_provider_error";
			refusal = `${e.name}:${e.code}`;
		}
		if (!refused) throw new Error(`unsafe ACL accepted (${refusal})`);
	} finally {
		server.stop(true);
	}
});
