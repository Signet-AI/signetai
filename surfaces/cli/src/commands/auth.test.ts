import { afterEach, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LoginStore } from "../../../../libs/sdk/src/node.js";
import { registerAuthCommands } from "./auth.js";

const homes: string[] = [];
afterEach(async () => {
	for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

test("device login stores credentials and logout revokes before clearing", async () => {
	const home = await mkdtemp(join(tmpdir(), "signet-auth-"));
	homes.push(home);
	const calls: string[] = [];
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			calls.push(path);
			if (path.endsWith("/start"))
				return Response.json({
					deviceCode: "private-device-code",
					userCode: "ABCD-EFGH",
					verificationUriComplete: "https://example.invalid/approve",
					interval: 0,
					expiresIn: 10,
				});
			if (path.endsWith("/token"))
				return Response.json({
					accessToken: "private-access",
					refreshToken: "private-refresh",
					accessExpiresAt: new Date(Date.now() + 60000).toISOString(),
					refreshExpiresAt: new Date(Date.now() + 120000).toISOString(),
				});
			if (path.endsWith("/logout")) {
				expect(request.headers.get("authorization")).toBe("Bearer private-access");
				return Response.json({ ok: true });
			}
			return Response.json({ error: "unexpected" }, { status: 404 });
		},
	});
	const env = { HOME: home };
	const keyring = {
		get: async () => ({ state: "unsupported" as const }),
		set: async () => ({ state: "unsupported" as const }),
	};
	const output: string[] = [];
	let opened = "";
	const program = new Command();
	registerAuthCommands(program, {
		env,
		keyring,
		configUrl: server.url.origin,
		print: (value) => output.push(value),
		openBrowser: async (url) => {
			opened = url;
		},
	});
	try {
		await program.parseAsync(["login"], { from: "user" });
		const store = new LoginStore(server.url.origin, { env, keyring });
		expect((await store.load())?.credential.refreshToken).toBe("private-refresh");
		expect(opened).toBe("https://example.invalid/approve");
		expect(output.join("\n")).toContain("ABCD-EFGH");
		expect(output.join("\n")).not.toContain("private-");
		await program.parseAsync(["logout"], { from: "user" });
		expect(await store.load()).toBeNull();
		expect(calls).toContain("/api/auth/logout");
	} finally {
		server.stop(true);
	}
});
