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
