/**
 * Issue #1051 — command-level tests for `signet repair queue`.
 *
 * A failed daemon request must surface as a non-zero exit so incident
 * recovery scripts using `&&` do not proceed after a repair failure.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { registerRepairQueueCommands } from "./repair-queue.js";

interface ApiCallResult {
	readonly ok: boolean;
	readonly data: unknown;
}

const DENIED_DATA: ApiCallResult = { ok: false, data: { error: "offline" } };

const ACKED_DRY_RUN_DATA: ApiCallResult = {
	ok: true,
	data: {
		action: "requeueDeadJobs",
		success: true,
		affected: 0,
		message: "dry-run: 3 job(s) match requeue filter",
	},
};

describe("repair queue exit codes", () => {
	let previousExitCode: string | number | undefined;
	let captured: string[];

	beforeEach(() => {
		previousExitCode = process.exitCode;
		process.exitCode = 0;
		captured = [];
	});

	afterEach(() => {
		if (previousExitCode === undefined) process.exitCode = 0;
		else process.exitCode = previousExitCode;
	});

	function makeProgram(apiCall: (method: string, path: string) => Promise<ApiCallResult>): Command {
		const program = new Command();
		registerRepairQueueCommands(program, {
			baseUrl: "http://localhost:3850",
			apiCall,
		});
		return program;
	}

	for (const subcommand of ["requeue", "cancel", "prune"] as const) {
		it(`exits 1 when ${subcommand} hits a non-2xx daemon response`, async () => {
			await makeProgram(async () => DENIED_DATA).parseAsync(["node", "test", "repair", "queue", subcommand]);
			expect(process.exitCode).toBe(1);
		});

		it(`keeps exit 0 when ${subcommand} dry-run is acknowledged`, async () => {
			await makeProgram(async () => ACKED_DRY_RUN_DATA).parseAsync(["node", "test", "repair", "queue", subcommand]);
			expect(process.exitCode).not.toBe(1);
		});

		it(`keeps exit 0 when ${subcommand} --apply succeeds`, async () => {
			await makeProgram(async () => ({
				ok: true,
				data: {
					action: `${subcommand}DeadJobs`,
					success: true,
					affected: 2,
					message: `applied ${subcommand}`,
				},
			})).parseAsync(["node", "test", "repair", "queue", subcommand, "--apply"]);
			expect(process.exitCode).not.toBe(1);
		});
	}
});
