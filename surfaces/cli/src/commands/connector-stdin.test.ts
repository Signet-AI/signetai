import "../../../../tests/support/connector-safety.js";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectorRegistry, readKeyFile } from "../../../../libs/sdk/src/node.js";

test.each(["connector", "personal", "wrong-harness", "session", "unbound", "invalid"])(
	"connect stdin validates the server credential binding: %s",
	async (kind) => {
		const home = await mkdtemp(join(tmpdir(), "connector-stdin-"));
		const secret = `sig_sk_${crypto.randomUUID()}`;
		let issued = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				if (request.method === "POST") {
					issued++;
					return Response.json({}, { status: 500 });
				}
				if (new URL(request.url).pathname !== "/api/auth/whoami") return Response.json({});
				expect(request.headers.get("authorization")).toBe(`Bearer ${secret}`);
				if (kind === "invalid") return Response.json({ reason: "revoked" }, { status: 401 });
				return Response.json({
					mode: "team",
					credential: {
						kind: kind === "session" ? "session" : "api_key",
						keyKind: kind === "personal" ? "personal" : "connector",
						id: "manual-key",
						deviceId: "device",
						harness: kind === "unbound" ? null : kind === "wrong-harness" ? "pi" : "codex",
					},
				});
			},
		});
		try {
			const args = ["connect", "codex", "--url", server.url.origin, "--api-key-stdin", "--json"];
			const script = `import { Command } from 'commander'; import { registerConnectorCommands } from ${JSON.stringify(new URL("./connector.ts", import.meta.url).pathname)}; const p = new Command(); registerConnectorCommands(p, { agentsDir: process.env.HOME }); await p.parseAsync(${JSON.stringify(args)}, { from: 'user' });`;
			const child = Bun.spawn([process.execPath, "-e", script], {
				cwd: new URL("../../", import.meta.url).pathname,
				env: { ...process.env, HOME: home, CODEX_HOME: join(home, ".codex") },
				stdin: new Blob([secret + "\n"]),
				stdout: "pipe",
				stderr: "pipe",
			});
			const [code, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			const entry = (await new ConnectorRegistry({ env: { HOME: home } }).read()).codex;
			if (kind === "connector") {
				expect(code).toBe(0);
				expect(entry?.keyId).toBe("manual-key");
				expect(await readKeyFile(entry?.keyFile ?? "missing")).toBe(secret);
			} else {
				expect(code).toBe(kind === "invalid" ? 3 : 1);
				expect(stderr).toContain(kind === "invalid" ? "connector key" : "connector key bound to codex");
				expect(stderr).not.toContain("session expired");
				expect(entry).toBeUndefined();
			}
			expect(issued).toBe(0);
			expect(stdout + stderr).not.toContain(secret);
		} finally {
			server.stop(true);
			await rm(home, { recursive: true, force: true });
		}
	},
);
