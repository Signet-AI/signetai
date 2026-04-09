import { afterEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerMemoryCommands } from "./memory";

const prevLog = console.log;

afterEach(() => {
	console.log = prevLog;
});

describe("registerMemoryCommands recall", () => {
	test("prints the full daemon response for --json", async () => {
		const lines: string[] = [];
		console.log = (line?: unknown) => {
			lines.push(String(line ?? ""));
		};

		const program = new Command();
		registerMemoryCommands(program, {
			ensureDaemonForSecrets: async () => true,
			secretApiCall: async () => ({
				ok: true,
				data: {
					query: "deploy checklist",
					method: "hybrid",
					results: [],
					meta: {
						totalReturned: 0,
						hasSupplementary: false,
						noHits: true,
					},
				},
			}),
		});

		await program.parseAsync(["node", "test", "recall", "deploy checklist", "--json"]);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain('"query": "deploy checklist"');
		expect(lines[0]).toContain('"meta"');
	});

	test("forwards expanded recall filters and applies min-score in json mode", async () => {
		const lines: string[] = [];
		console.log = (line?: unknown) => {
			lines.push(String(line ?? ""));
		};

		let capturedBody: unknown;
		const program = new Command();
		registerMemoryCommands(program, {
			ensureDaemonForSecrets: async () => true,
			secretApiCall: async (_method, _path, body) => {
				capturedBody = body;
				return {
					ok: true,
					data: {
						query: "deploy checklist",
						method: "hybrid",
						results: [
							{ content: "low score row", score: 0.2 },
							{ content: "high score row", score: 0.95, supplementary: true },
						],
						meta: {
							totalReturned: 2,
							hasSupplementary: true,
							noHits: false,
						},
					},
				};
			},
		});

		await program.parseAsync([
			"node",
			"test",
			"recall",
			"deploy checklist",
			"--keyword-query",
			"deploy OR rollback",
			"--project",
			"/tmp/proj",
			"--type",
			"decision",
			"--tags",
			"release",
			"--who",
			"claude-code",
			"--pinned",
			"--importance-min",
			"0.7",
			"--since",
			"2026-01-01",
			"--until",
			"2026-04-01",
			"--expand",
			"--min-score",
			"0.8",
			"--json",
		]);

		expect(capturedBody).toEqual({
			query: "deploy checklist",
			keywordQuery: "deploy OR rollback",
			limit: 10,
			project: "/tmp/proj",
			type: "decision",
			tags: "release",
			who: "claude-code",
			pinned: true,
			importance_min: 0.7,
			since: "2026-01-01",
			until: "2026-04-01",
			expand: true,
		});
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain('"high score row"');
		expect(lines[0]).not.toContain('"low score row"');
		expect(lines[0]).toContain('"totalReturned": 1');
	});
});
