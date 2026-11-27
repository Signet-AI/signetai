import "../../../../tests/support/connector-safety.js";
import { describe, expect, test } from "bun:test";
import { Command, CommanderError } from "commander";
import { registerAppCommands, registerDefaultAction } from "./app.js";

describe("registerAppCommands", () => {
	test("wraps sync action so Commander args do not leak into the dependency", async () => {
		const calls: unknown[][] = [];
		const program = new Command();

		registerAppCommands(program, {
			collectListOption: (value, previous) => [...previous, value],
			configureAgent: async () => {},
			launchDashboard: async () => {},
			migrateSchema: async () => {},
			setupWizard: async () => {},
			showDoctor: async () => {},
			showStatus: async () => {},
			syncTemplates: async (...args: unknown[]) => {
				calls.push(args);
			},
		});

		await program.parseAsync(["node", "test", "sync"]);

		expect(calls).toEqual([[]]);
	});

	test("routes doctor target into doctor options", async () => {
		const calls: unknown[] = [];
		const program = new Command();

		registerAppCommands(program, {
			collectListOption: (value, previous) => [...previous, value],
			configureAgent: async () => {},
			launchDashboard: async () => {},
			migrateSchema: async () => {},
			setupWizard: async () => {},
			showDoctor: async (options) => {
				calls.push(options);
			},
			showStatus: async () => {},
			syncTemplates: async () => {},
		});

		await program.parseAsync(["node", "test", "doctor", "hermes", "--json"]);

		expect(calls).toEqual([{ json: true, target: "hermes" }]);
	});

	test("rejects excess positional arguments for status and doctor", async () => {
		const cases = [
			["status", "unexpected"],
			["doctor", "hermes", "unexpected"],
		] as const;

		for (const args of cases) {
			const program = new Command();
			program.exitOverride();
			registerAppCommands(program, {
				collectListOption: (value, previous) => [...previous, value],
				configureAgent: async () => {},
				launchDashboard: async () => {},
				migrateSchema: async () => {},
				setupWizard: async () => {},
				showDoctor: async () => {},
				showStatus: async () => {},
				syncTemplates: async () => {},
			});

			let error: unknown;
			try {
				await program.parseAsync(["node", "test", ...args]);
			} catch (caught) {
				error = caught;
			}

			expect(error).toBeInstanceOf(CommanderError);
			expect((error as CommanderError).exitCode).toBe(1);
		}
	});
});

describe("registerDefaultAction", () => {
	test("rejects an unknown command with a non-zero exit instead of rendering the banner", async () => {
		const program = new Command();
		program.exitOverride();
		program.name("signet");
		program
			.command("status")
			.description("Show status")
			.action(() => {});
		registerDefaultAction(program, {
			agentsDir: "/tmp/agents",
			defaultPort: 3850,
			getStatusReport: async () => ({
				installed: true,
				basePath: "/tmp/agents",
				daemon: { running: false },
			}),
			signetBanner: () => "banner",
			statusDeps: {},
		});

		try {
			await program.parseAsync(["node", "test", "nonexistent-command"]);
			expect.unreachable("expected CommanderError");
		} catch (error) {
			expect(error).toBeInstanceOf(CommanderError);
			const commanderError = error as CommanderError;
			expect(commanderError.exitCode).toBe(1);
			expect(commanderError.message).toContain("unknown command 'nonexistent-command'");
		}
	});

	test("bare invocation still renders the status report", async () => {
		const calls: string[] = [];
		const program = new Command();
		program.exitOverride();
		program.name("signet");
		program
			.command("status")
			.description("Show status")
			.action(() => {});
		registerDefaultAction(program, {
			agentsDir: "/tmp/agents",
			defaultPort: 3850,
			getStatusReport: async (basePath) => {
				calls.push(basePath);
				return {
					installed: true,
					basePath,
					daemon: { running: false },
				};
			},
			signetBanner: () => "banner",
			statusDeps: {},
		});

		await program.parseAsync(["node", "test"]);

		expect(calls).toEqual(["/tmp/agents"]);
	});
});

describe("registerDefaultAction", () => {
	test("rejects an unknown command with a non-zero exit instead of rendering the banner", async () => {
		const program = new Command();
		program.exitOverride();
		program.name("signet");
		program
			.command("status")
			.description("Show status")
			.action(() => {});
		registerDefaultAction(program, {
			agentsDir: "/tmp/agents",
			defaultPort: 3850,
			getStatusReport: async () => ({
				installed: true,
				basePath: "/tmp/agents",
				daemon: { running: false },
			}),
			signetBanner: () => "banner",
			statusDeps: {},
		});

		try {
			await program.parseAsync(["node", "test", "nonexistent-command"]);
			expect.unreachable("expected CommanderError");
		} catch (error) {
			expect(error).toBeInstanceOf(CommanderError);
			const commanderError = error as CommanderError;
			expect(commanderError.exitCode).toBe(1);
			expect(commanderError.message).toContain("unknown command 'nonexistent-command'");
		}
	});

	test("bare invocation still renders the status report", async () => {
		const calls: string[] = [];
		const program = new Command();
		program.exitOverride();
		program.name("signet");
		program
			.command("status")
			.description("Show status")
			.action(() => {});
		registerDefaultAction(program, {
			agentsDir: "/tmp/agents",
			defaultPort: 3850,
			getStatusReport: async (basePath) => {
				calls.push(basePath);
				return {
					installed: true,
					basePath,
					daemon: { running: false },
				};
			},
			signetBanner: () => "banner",
			statusDeps: {},
		});

		await program.parseAsync(["node", "test"]);

		expect(calls).toEqual(["/tmp/agents"]);
	});
});

test("interactive setup entry dispatches personal, host and join without changing explicit setup paths", async () => {
	const prompts = await import("@clack/prompts"),
		{ spyOn } = await import("bun:test");
	const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	const select = spyOn(prompts, "select"),
		input = spyOn(prompts, "text"),
		cancelCheck = spyOn(prompts, "isCancel");
	const create = () => {
		const calls: unknown[] = [],
			program = new Command();
		registerAppCommands(program, {
			collectListOption: (value, prior) => [...prior, value],
			configureAgent: async () => {},
			installNative: async () => {},
			launchDashboard: async () => {},
			migrateSchema: async () => {},
			setupWizard: async (options) => {
				calls.push(options);
			},
			showDoctor: async () => {},
			showStatus: async () => {},
			syncTemplates: async () => {},
		});
		program
			.command("login")
			.option("--url <url>")
			.action((options) => {
				calls.push({ login: options.url });
			});
		return { calls, program };
	};
	try {
		for (const choice of ["personal", "host", "join"]) {
			select.mockClear();
			select.mockResolvedValue(choice);
			input.mockResolvedValue("https://org.example");
			const { calls, program } = create();
			await program.parseAsync(["setup"], { from: "user" });
			expect(select.mock.calls[0]?.[0]).toMatchObject({
				options: [
					{ value: "personal", label: "Personal workspace" },
					{ value: "host", label: "Host an organization" },
					{ value: "join", label: "Join an organization" },
				],
			});
			if (choice === "host")
				expect(calls).toEqual([expect.objectContaining({ host: true, publicUrl: "https://org.example" })]);
			else if (choice === "join") expect(calls).toEqual([{ login: "https://org.example" }]);
			else expect(calls).toEqual([{ harness: [], obsidianSource: [], agent: [] }]);
		}
		for (const [args, key, value] of [
			[["--non-interactive"], "nonInteractive", true],
			[["--file", "plan.json"], "file", "plan.json"],
			[["--json", "{}"], "json", "{}"],
			[["--dry-run"], "dryRun", true],
			[["--skip-git"], "skipGit", true],
			[["--schema"], "schema", true],
			[["--path", "personal"], "path", "personal"],
		] as const) {
			select.mockClear();
			const { calls, program } = create();
			await program.parseAsync(["setup", ...args], { from: "user" });
			expect(select).not.toHaveBeenCalled();
			expect(calls).toEqual([expect.objectContaining({ [key]: value })]);
		}
		select.mockClear();
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		const headless = create();
		await headless.program.parseAsync(["setup"], { from: "user" });
		expect(select).not.toHaveBeenCalled();
		expect(headless.calls).toHaveLength(1);
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		cancelCheck.mockReturnValue(true);
		select.mockResolvedValue(Symbol("cancel"));
		const cancelled = create();
		await expect(cancelled.program.parseAsync(["setup"], { from: "user" })).rejects.toMatchObject({
			code: "cancelled",
		});
		expect(cancelled.calls).toEqual([]);
	} finally {
		select.mockRestore();
		input.mockRestore();
		cancelCheck.mockRestore();
		if (tty) Object.defineProperty(process.stdin, "isTTY", tty);
		else Reflect.deleteProperty(process.stdin, "isTTY");
	}
});
