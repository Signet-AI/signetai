import { expect, test } from "bun:test";
import { Command } from "commander";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerOrganizationTarget } from "../lib/organization-target.js";
import { registerAgentCommands } from "./agent.js";

test("remote agent add never scaffolds locally and use persists the daemon preference", async () => {
	const home = await mkdtemp(join(tmpdir(), "org-agent-cli-"));
	const calls: { path: string; body: unknown }[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			calls.push({ path, body: request.method === "GET" ? null : await request.json() });
			if (request.method === "GET")
				return Response.json({
					agents: [{ id: "agent_notes", name: "notes", kind: "personal", ownerUserId: "usr_me", canActAs: true }],
				});
			return Response.json({ ok: true });
		},
	});
	try {
		for (const args of [
			["agent", "add", "notes"],
			["agent", "use", "notes"],
		]) {
			const program = new Command();
			registerOrganizationTarget(program, { env: { SIGNET_DAEMON_URL: server.url.origin, SIGNET_API_KEY: "fixture" } });
			registerAgentCommands(program, {
				AGENTS_DIR: home,
				fetchFromDaemon: async () => {
					throw new Error("local path used");
				},
			});
			await program.parseAsync(args, { from: "user" });
		}
		expect(calls).toEqual([
			{ path: "/api/agents", body: { name: "notes", kind: "personal" } },
			{ path: "/api/agents", body: null },
			{ path: "/api/auth/preferences", body: { defaultReadAgentId: "agent_notes" } },
		]);
		expect(await readdir(home)).toEqual([]);
	} finally {
		registerOrganizationTarget(new Command());
		server.stop(true);
		await rm(home, { recursive: true, force: true });
	}
});
