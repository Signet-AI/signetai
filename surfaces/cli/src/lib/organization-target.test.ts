import { afterEach, expect, test } from "bun:test";
import { Command } from "commander";
import { createDaemonClient } from "./daemon.js";
import { resolveCliTarget, localOnlyMessage, registerOrganizationTarget } from "./organization-target.js";

afterEach(() => registerOrganizationTarget(new Command()));

test("explicit HTTP CLI targets produce one clear-text warning without credentials in output", async () => {
	const script = `
const { resolveCliTarget } = await import(${JSON.stringify(new URL("./organization-target.ts", import.meta.url).href)});
const key = "cli-fixture-key-" + crypto.randomUUID();
const results = [];
for (const url of ["http://192.168.20.10:3850", "http://100.64.20.10:3850"]) {
 const target = await resolveCliTarget({ url }, { flagKey: key, env: { HOME: process.env.HOME, APPDATA: process.env.APPDATA } });
 results.push(target.remote && await target.credential.get() === key);
}
console.log(JSON.stringify(results));
`;
	const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(code, stderr).toBe(0);
	expect(JSON.parse(stdout)).toEqual([true, true]);
	expect(stderr.match(/HTTP sends credentials in clear text/g)).toHaveLength(1);
	expect(stderr).not.toContain("cli-fixture-key-");
	expect(stdout).not.toContain("cli-fixture-key-");
});

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

test("unknown and local workspace commands refuse remote targets by default", async () => {
	for (const path of [
		"skill list",
		"secret exec",
		"secret exec-status",
		"sources add obsidian",
		"telemetry",
		"bypass",
		"session bypass",
		"dream trigger",
		"update",
		"accelerate",
		"desktop",
		"future-command",
		"agent future-command",
		"connector future-command",
		"hook future-command",
	]) {
		const program = new Command();
		registerOrganizationTarget(program, {
			env: { SIGNET_DAEMON_URL: "https://org.example", SIGNET_API_KEY: "fixture" },
		});
		let command = program;
		for (const name of path.split(" ")) command = command.command(name);
		let ran = false;
		command.action(() => {
			ran = true;
		});
		await expect(program.parseAsync(path.split(" "), { from: "user" })).rejects.toThrow(
			localOnlyMessage("org.example"),
		);
		expect(ran).toBe(false);
	}
});

test("every registered command is explicitly remote-capable or refuses before its action", async () => {
	const { z } = await import("zod");
	const child = Bun.spawn(
		[
			process.execPath,
			"--preload",
			new URL("./test-support/command-tree.ts", import.meta.url).pathname,
			new URL("../cli.ts", import.meta.url).pathname,
		],
		{
			env: { ...process.env, SIGNET_DAEMON_URL: "http://127.0.0.1:49998" },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const output = await new Response(child.stdout).text();
	const errors = await new Response(child.stderr).text();
	expect(await child.exited, errors).toBe(0);
	const paths = z.array(z.array(z.string())).parse(JSON.parse(output));
	expect(paths.length).toBeGreaterThan(200);
	const targetOwning = new Set([
		"connect",
		"disconnect",
		"connector mcp",
		"connector install",
		"connector rotate",
		"connector list",
		"connector doctor",
		"hook session-start",
		"hook user-prompt-submit",
		"hook notifications",
		"hook wake",
		"hook session-end",
		"hook stop",
		"hook pre-compaction",
		"hook compaction-complete",
		"hook synthesis",
	]);
	const supported = new Set([
		"login",
		"logout",
		"whoami",
		"dashboard",
		"status",
		"restart",
		"pause",
		"resume",
		"logs",
		"remember",
		"recall",
		"search",
		"memory list",
		"memory show",
		"session search",
		"session list",
		"sources list",
		"sources imports upload",
		"dream status",
		"import",
		"export",
		"export transcripts",
		"export bundle",
		"doctor",
		"daemon restart",
		"daemon pause",
		"daemon resume",
		"daemon status",
		"daemon logs",
		"embed audit",
		"embed backfill",
		"repair queue requeue",
		"repair queue cancel",
		"repair queue prune",
		"agent use",
		"agent transfer",
		"agent list",
		"agent add",
		"agent remove",
		"agent purge",
		"agent info",
		"agent show",
		"agent set",
		"secret put",
		"secret list",
		"secret delete",
		"secret get",
		"secret has",
		"api-key create",
		"api-key list",
		"api-key revoke",
		"auth sso set",
		"auth devices",
		"auth devices revoke",
		"auth devices rename",
		"auth sessions",
		"auth sessions revoke",
		"org users list",
		"org users invite",
		"org users role",
		"org users reactivate",
		"org users deactivate",
		"org teams list",
		"org teams create",
		"org teams show",
		"org teams delete",
		"org teams rename",
		"org teams add",
		"org teams remove",
		"org access",
		"org jobs",
		"org agents list",
		"audit",
		"classification list",
		"classification create",
		"classification audience",
		"classify",
	]);
	for (const path of paths) {
		const program = new Command();
		registerOrganizationTarget(program, {
			env: { SIGNET_DAEMON_URL: "https://org.example", SIGNET_API_KEY: "fixture" },
		});
		let command = program;
		for (const name of path) command = command.command(name);
		let ran = false;
		command.action(() => {
			ran = true;
		});
		const allowed = supported.has(path.join(" ")) || targetOwning.has(path.join(" "));
		const result = program.parseAsync(["--agent", "fixture", ...path], { from: "user" });
		if (allowed) await result;
		else await expect(result, path.join(" ")).rejects.toThrow(localOnlyMessage("org.example"));
		expect(ran, path.join(" ")).toBe(allowed);
	}
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

test("remote portable bundle paths never open a local database", async () => {
	for (const kind of ["import"]) {
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

test.each([
	{ args: ["--local", "--agent", "agent-a", "sources", "imports", "upload", "job", "file", "path"] },
	{ args: ["sources", "--local", "--agent", "agent-a", "imports", "upload", "job", "file", "path"] },
	{ args: ["sources", "imports", "upload", "job", "file", "path", "--local", "--agent", "agent-a"] },
])("target flags retain the required nested command agent: %j", async ({ args }: { args: string[] }) => {
	const program = new Command().exitOverride();
	registerOrganizationTarget(program, { env: {} });
	let agent: string | undefined;
	program
		.command("sources")
		.command("imports")
		.command("upload <job> <file> <path>")
		.requiredOption("--agent <id>")
		.action((_job: string, _file: string, _path: string, options: { agent: string }) => {
			agent = options.agent;
		});
	await program.parseAsync(args, { from: "user" });
	expect(agent).toBe("agent-a");
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
