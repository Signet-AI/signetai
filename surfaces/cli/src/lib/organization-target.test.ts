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

test("--local routes existing clients to loopback without organization credentials", async () => {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			return Response.json({ authorization: request.headers.get("authorization") });
		},
	});
	try {
		const client = createDaemonClient(1);
		const program = new Command();
		registerOrganizationTarget(program, {
			env: {
				SIGNET_DAEMON_URL: "https://org.example",
				SIGNET_PORT: String(server.port),
				SIGNET_API_KEY: "must-not-leak",
			},
		});
		let result: unknown;
		program.command("recall").action(async () => {
			result = await client.fetchFromDaemon("/api/memory/recall");
		});
		await program.parseAsync(["--local", "recall"], { from: "user" });
		expect(result).toEqual({ authorization: null });
		expect(client.url).toBe(server.url.origin);
	} finally {
		server.stop(true);
	}
});

test("raw organization streams use the resolved credential without local fallback", async () => {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			return new Response(request.headers.get("authorization") ?? "missing");
		},
	});
	try {
		const client = createDaemonClient(1);
		const program = new Command();
		registerOrganizationTarget(program, {
			env: { SIGNET_DAEMON_URL: server.url.origin, SIGNET_API_KEY: "stream-fixture" },
		});
		let text = "";
		program.command("export").action(async () => {
			const response = await client.fetchDaemonStream("/api/memory/export");
			if (response.ok) text = await response.response.text();
		});
		await program.parseAsync(["export"], { from: "user" });
		expect(text).toBe("Bearer stream-fixture");
	} finally {
		server.stop(true);
	}
});

test("unimplemented remote operator paths never execute local process or file actions", async () => {
	for (const name of ["restart", "repair", "embed"]) {
		const program = new Command();
		registerOrganizationTarget(program, {
			env: { SIGNET_DAEMON_URL: "https://org.example", SIGNET_API_KEY: "fixture" },
		});
		let ran = false;
		program.command(name).action(() => {
			ran = true;
		});
		await expect(program.parseAsync([name], { from: "user" })).rejects.toThrow("No local action was attempted");
		expect(ran).toBe(false);
	}
});

test("remote portable bundle paths never open a local database", async () => {
	for (const kind of ["import", "export"]) {
		const program = new Command();
		registerOrganizationTarget(program, {
			env: { SIGNET_DAEMON_URL: "https://org.example", SIGNET_API_KEY: "fixture" },
		});
		let ran = false;
		if (kind === "import")
			program.command("import <path>").action(() => {
				ran = true;
			});
		else
			program
				.command("export")
				.command("bundle")
				.action(() => {
					ran = true;
				});
		await expect(
			program.parseAsync(kind === "import" ? ["import", "missing.json"] : ["export", "bundle"], { from: "user" }),
		).rejects.toThrow(kind === "import" ? "--agent" : "No local database was opened");
		expect(ran).toBe(false);
	}
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
