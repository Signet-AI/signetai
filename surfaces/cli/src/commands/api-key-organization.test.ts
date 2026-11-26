import { expect, spyOn, test } from "bun:test";
import { Command } from "commander";
import { registerOrganizationTarget } from "../lib/organization-target.js";
import { registerApiKeyCommands } from "./api-key.js";

test("organization key create uses personal permissions, warns in JSON and lists only own keys by default", async () => {
	const calls: { path: string; body: unknown }[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const path = new URL(request.url).pathname + new URL(request.url).search;
			calls.push({ path, body: request.method === "GET" ? null : await request.json() });
			if (path.endsWith("whoami")) return Response.json({ permissions: ["recall", "remember"] });
			return Response.json(
				request.method === "POST" ? { secret: "fixture-once", key: { id: "key_fixture" } } : { apiKeys: [] },
			);
		},
	});
	const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
	const stdout = spyOn(console, "log").mockImplementation(() => {});
	try {
		for (const args of [
			["api-key", "create", "--name", "CI", "--json"],
			["api-key", "list", "--all", "--json"],
		]) {
			const program = new Command();
			registerOrganizationTarget(program, { env: { SIGNET_DAEMON_URL: server.url.origin, SIGNET_API_KEY: "fixture" } });
			registerApiKeyCommands(program, {
				ensureDaemonRunning: async () => {
					throw new Error("local daemon checked");
				},
				apiCall: async () => {
					throw new Error("local request used");
				},
			});
			await program.parseAsync(args, { from: "user" });
		}
		expect(calls[1]?.body).toMatchObject({ name: "CI", permissions: ["recall", "remember"], kind: "personal" });
		expect(calls[2]?.path).toBe("/api/auth/api-keys?all=1");
		expect(stderr.mock.calls.flat().join("")).toContain("only once");
		expect(stdout.mock.calls.flat().join("").split("fixture-once")).toHaveLength(2);
	} finally {
		stderr.mockRestore();
		stdout.mockRestore();
		registerOrganizationTarget(new Command());
		server.stop(true);
	}
});
