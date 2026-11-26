import { afterEach, expect, test } from "bun:test";
import { Command } from "commander";
import { createDaemonClient } from "./daemon.js";
import { resolveCliTarget, localOnlyMessage, registerOrganizationTarget } from "./organization-target.js";

afterEach(() => registerOrganizationTarget(new Command()));

test("local-only commands refuse remotely before running their action and --local preserves it", async () => {
	let actions = 0;
	for (const local of [false, true]) {
		const program = new Command();
		registerOrganizationTarget(program, {
			env: { SIGNET_DAEMON_URL: "https://acme.example", SIGNET_API_KEY: "fixture" },
		});
		program.command("start").action(() => {
			actions++;
		});
		const request = program.parseAsync([...(local ? ["--local"] : ["--org"]), "start"], { from: "user" });
		if (local) await request;
		else await expect(request).rejects.toThrow(localOnlyMessage("acme.example"));
	}
	expect(actions).toBe(1);
});

test("existing daemon clients use the resolved organization credential and agent", async () => {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			return Response.json({
				authorization: request.headers.get("authorization"),
				agent: request.headers.get("x-signet-agent-id"),
			});
		},
	});
	try {
		const client = createDaemonClient(1);
		const program = new Command();
		registerOrganizationTarget(program, { env: { SIGNET_DAEMON_URL: server.url.origin, SIGNET_API_KEY: "fixture" } });
		let result: unknown;
		program.command("recall").action(async () => {
			result = await client.fetchFromDaemon("/api/memory/recall");
		});
		await program.parseAsync(["--org", "--agent", "agent_team", "recall"], { from: "user" });
		expect(result).toEqual({ authorization: "Bearer fixture", agent: "agent_team" });
	} finally {
		server.stop(true);
	}
});

const keyring = {
	get: async () => ({ state: "unsupported" as const }),
	set: async () => ({ state: "unsupported" as const }),
};
test("explicit local target ignores organization environment and stored URL", async () => {
	const target = await resolveCliTarget(
		{ local: true },
		{
			keyring,
			env: { HOME: process.env.HOME, SIGNET_DAEMON_URL: "https://environment.example", SIGNET_API_KEY: "fixture" },
			configUrl: "https://stored.example",
		},
	);
	expect(target.url).toBe("http://127.0.0.1:3850");
	expect(target.remote).toBe(false);
	expect(await target.credential.get()).toBeNull();
});
test("target precedence is explicit URL then environment then stored login URL", async () => {
	const deps = {
		keyring,
		env: { HOME: process.env.HOME, SIGNET_DAEMON_URL: "https://environment.example", SIGNET_API_KEY: "fixture" },
		configUrl: "https://stored.example",
	};
	expect((await resolveCliTarget({ url: "https://flag.example" }, deps)).url).toBe("https://flag.example");
	expect((await resolveCliTarget({}, deps)).url).toBe("https://environment.example");
	expect((await resolveCliTarget({}, { ...deps, env: { HOME: process.env.HOME } })).url).toBe("https://stored.example");
});
test("target overrides conflict and local-only refusal names both sides", async () => {
	await expect(resolveCliTarget({ local: true, org: true }, { keyring })).rejects.toThrow("cannot be combined");
	expect(localOnlyMessage("acme")).toBe(
		"This manages a local daemon. Your current target is `acme` (remote). Pass `--local`, or run it on the instance host.",
	);
});
