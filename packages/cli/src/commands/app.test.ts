import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerAppCommands } from "./app.js";

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
});
