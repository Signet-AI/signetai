import { Command } from "commander";
import { describe, expect, it } from "bun:test";
import { registerCliPreAction } from "./cli-pre-action.js";

function makeProgram(commandName: string, calls: string[]): Command {
	const program = new Command().name("signet");
	registerCliPreAction(program, {
		agentsDir: process.cwd(),
		version: "test-version",
		recordCommandInvoked: (_agentsDir, name) => calls.push(`record:${name}`),
		flushCliTelemetry: async (_agentsDir, version) => {
			calls.push(`flush:${version}`);
		},
		ensureOpenClawPluginPackage: async (_agentsDir, options) => {
			calls.push(`sync:${options.silent}`);
			return undefined;
		},
	});
	program.command(commandName).action(() => {});
	return program;
}

describe("CLI preAction effects", () => {
	for (const commandName of ["status", "dashboard"]) {
		it(`records telemetry for ${commandName} without syncing the OpenClaw package`, async () => {
			const calls: string[] = [];
			const program = makeProgram(commandName, calls);
			await program.parseAsync(["node", "signet", commandName]);
			expect(calls).toEqual([`record:${commandName}`, "flush:test-version"]);
		});
	}

	it("keeps plugin synchronization enabled for other eligible commands", async () => {
		const calls: string[] = [];
		const program = makeProgram("remember", calls);
		await program.parseAsync(["node", "signet", "remember"]);
		expect(calls).toEqual(["record:remember", "flush:test-version", "sync:true"]);
	});
});
