import { afterEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerDreamCommands } from "./dream";

const prevLog = console.log;
const prevError = console.error;

afterEach(() => {
	console.log = prevLog;
	console.error = prevError;
});

describe("registerDreamCommands", () => {
	test("promote posts a dry-run request by default", async () => {
		let capturedPath = "";
		let capturedOpts: RequestInit | undefined;
		console.log = () => {};

		const program = new Command();
		registerDreamCommands(program, {
			fetchFromDaemon: async (path, opts) => {
				capturedPath = path;
				capturedOpts = opts;
				return {
					sources: [],
					operations: [],
					count: 0,
					appliedCount: 0,
					skipped: ["No explicit high-confidence attribute promotions found."],
					questions: [],
					warnings: [],
					dryRun: true,
				};
			},
		});

		await program.parseAsync([
			"node",
			"test",
			"dream",
			"promote",
			"--from",
			"memories:recent",
			"--agent",
			"ant",
			"--limit",
			"12",
		]);

		expect(capturedPath).toBe("/api/dream/promote");
		expect(capturedOpts?.method).toBe("POST");
		expect(JSON.parse(String(capturedOpts?.body))).toMatchObject({
			from: "memories:recent",
			apply: false,
			limit: 12,
			agent_id: "ant",
			actor: "dreaming-promote",
			use_provider: false,
		});
	});

	test("promote can apply direct operations and print JSON", async () => {
		let capturedBody: Record<string, unknown> = {};
		const lines: string[] = [];
		console.log = (line?: unknown) => {
			lines.push(String(line ?? ""));
		};

		const program = new Command();
		registerDreamCommands(program, {
			fetchFromDaemon: async (_path, opts) => {
				capturedBody = JSON.parse(String(opts?.body));
				return {
					sources: [{ kind: "memory" }],
					operations: [{ operation: "set_claim_value", payload: { entity: "Nicholai" } }],
					count: 1,
					appliedCount: 1,
					skipped: [],
					questions: [],
					warnings: [],
					dryRun: false,
				};
			},
		});

		await program.parseAsync(["node", "test", "dream", "promote", "--from", "memory:mem-1", "--apply", "--json"]);

		expect(capturedBody).toMatchObject({
			from: "memory:mem-1",
			apply: true,
		});
		expect(JSON.parse(lines.join("\n"))).toMatchObject({
			count: 1,
			appliedCount: 1,
			dryRun: false,
		});
	});
});
