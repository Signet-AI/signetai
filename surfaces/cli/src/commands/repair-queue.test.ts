/**
 * Issue #1051 — command-level tests for `signet repair queue`.
 *
 * A failed daemon request must surface as a non-zero exit so incident
 * recovery scripts using `&&` do not proceed after a repair failure.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command, CommanderError } from "commander";
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

	beforeEach(() => {
		previousExitCode = process.exitCode;
		process.exitCode = 0;
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

describe("repair queue --tables validation", () => {
	let previousExitCode: string | number | undefined;
	let bodies: Record<string, unknown>[];
	let apiCallCount: number;

	beforeEach(() => {
		previousExitCode = process.exitCode;
		process.exitCode = 0;
		bodies = [];
		apiCallCount = 0;
	});

	afterEach(() => {
		if (previousExitCode === undefined) process.exitCode = 0;
		else process.exitCode = previousExitCode;
	});

	function makeProgram(): Command {
		const program = new Command();
		program.exitOverride();
		registerRepairQueueCommands(program, {
			baseUrl: "http://localhost:3850",
			apiCall: async (_method, _path, body) => {
				apiCallCount += 1;
				bodies.push((body as Record<string, unknown>) ?? {});
				return {
					ok: true,
					data: {
						action: "requeueDeadJobs",
						success: true,
						affected: 0,
						message: "dry-run: 0 job(s) match requeue filter",
					},
				};
			},
		});
		return program;
	}

	for (const subcommand of ["requeue", "cancel", "prune"] as const) {
		it(`${subcommand} without --tables sends no selector (both-queue default)`, async () => {
			await makeProgram().parseAsync(["node", "test", "repair", "queue", subcommand]);
			expect(apiCallCount).toBe(1);
			expect(bodies[0]).not.toHaveProperty("tables");
		});

		it(`${subcommand} with --tables memory,summary sends both values`, async () => {
			await makeProgram().parseAsync(["node", "test", "repair", "queue", subcommand, "--tables", "memory,summary"]);
			expect(apiCallCount).toBe(1);
			expect(bodies[0].tables).toEqual(["memory", "summary"]);
		});

		it(`${subcommand} with --tables bogus exits non-zero and never calls the daemon`, async () => {
			const program = makeProgram();
			try {
				await program.parseAsync(["node", "test", "repair", "queue", subcommand, "--tables", "bogus"]);
				expect.unreachable("expected CommanderError");
			} catch (error) {
				expect(error).toBeInstanceOf(CommanderError);
				expect((error as CommanderError).exitCode).toBe(1);
				expect((error as CommanderError).message).toContain(
					'invalid --tables value "bogus"; expected memory or summary',
				);
			}
			expect(apiCallCount).toBe(0);
		});

		it(`${subcommand} with --tables memory,bogus fails atomically and never calls the daemon`, async () => {
			const program = makeProgram();
			try {
				await program.parseAsync(["node", "test", "repair", "queue", subcommand, "--tables", "memory,bogus"]);
				expect.unreachable("expected CommanderError");
			} catch (error) {
				expect(error).toBeInstanceOf(CommanderError);
				expect((error as CommanderError).exitCode).toBe(1);
			}
			expect(apiCallCount).toBe(0);
		});
	}
});
